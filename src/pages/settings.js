// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Tath Sikdar

/**
 * @fileoverview Settings: calibration, preferences, the LDR constants, and the
 * draggable response curve.
 */

import { calibrationOf, defaultYsFor } from '../core.js';
import { CurveGraph } from '../graph.js';
import * as setup from '../setup.js';
import { $, api, curve, editing, note, patch } from '../ui.js';
import { buildCalibrate } from './calibrate.js';

/** @type {!Object} the most recent `state` push */
let state = { cfg: null, displays: [] };

/**
 * The graphs on screen, in display order. One when every display follows the
 * same knob, one each when they are learned separately -- because that is the
 * only mode where they differ, by their gains.
 * @type {!Array<{key: ?string, graph: !CurveGraph}>}
 */
let graphs = [];

/** What `graphs` was last built for, so a `state` push every second does not
 *  tear down and rebuild canvases the user may be dragging. null, not '': the
 *  shared single graph's signature *is* '', and it has to build the first time. */
let builtFor = null;

/** True when each display is learned on its own gain. */
function perDisplay() {
  return !state.cfg.singleKnob && !state.cfg.learnAveraged;
}

/** The displays worth drawing: all the calibrated ones, or [null] for the
 *  single shared curve, which is drawn against the first calibrated panel. */
function graphKeys() {
  const calibrated = state.displays.filter((d) => calibrationOf(state.cfg, d.key));
  if (!perDisplay() || calibrated.length < 2) return [null];
  return calibrated.map((d) => d.key);
}

function onCurveChange() {
  editing.curveDirty = true;
  $('curve-save').disabled = false;
  // The knots are one shared object, so a drag on one graph moves them all.
  for (const { graph } of graphs) graph.draw();
}

/** (Re)creates the canvases. Only when the set of keys has actually changed. */
function buildGraphs() {
  const keys = graphKeys();
  const signature = keys.join('|');
  if (signature === builtFor) return;
  builtFor = signature;

  const box = $('set-graphs');
  box.replaceChildren();
  graphs = keys.map((key) => {
    if (key !== null) {
      const label = document.createElement('p');
      label.className = 'sub';
      label.textContent = state.displays.find((d) => d.key === key)?.name ?? key;
      box.append(label);
    }
    const canvas = document.createElement('canvas');
    canvas.className = 'graph';
    box.append(canvas);
    return {
      key,
      graph: new CurveGraph(canvas, curve, { editable: true, onChange: onCurveChange }),
    };
  });
}

/** What `buildNames` was last built for, so a `state` push does not replace the
 *  box under a half-typed name. Only the set of displays can force a rebuild. */
let namedFor = null;

/**
 * One text box per display. Blanking it drops the override, so the box goes
 * back to whatever the monitor calls itself on the next push.
 */
function buildNames() {
  const signature = state.displays.map((d) => d.key).join('|');
  if (signature === namedFor) return;
  namedFor = signature;

  const box = $('set-displays');
  box.replaceChildren();
  if (!state.displays.length) {
    box.append(note('No DDC/CI displays detected.'));
    return;
  }

  // Straight into the grid, two cells per display -- see #set-displays.
  for (const d of state.displays) {
    // The hardware name labels the box even once it has been renamed: it is the
    // only thing left that says which monitor the row is.
    const label = document.createElement('label');
    label.textContent = d.hwName;

    const input = document.createElement('input');
    input.type = 'text';
    input.id = `name-${d.index}`;
    label.htmlFor = input.id;
    input.value = d.name;
    input.addEventListener('change', () => {
      const names = { ...state.cfg.names };
      const typed = input.value.trim();
      if (typed) {
        names[d.key] = typed;
      } else {
        delete names[d.key];
        input.value = d.hwName; // the box is never left empty
      }
      patch({ names });
    });

    box.append(label, input);
  }
}

/**
 * The calibration a graph is drawn against: its own display's, or the first
 * calibrated one for the shared curve. Panels mostly differ by scale, not
 * shape, so one stand-in is honest for the shared case.
 * @return {?Object}
 */
function calFor(key) {
  if (key !== null) return calibrationOf(state.cfg, key);
  for (const d of state.displays) {
    const cal = calibrationOf(state.cfg, d.key);
    if (cal) return cal;
  }
  return null;
}

/**
 * The top of the y axis, shared by every graph on the page: the *dimmest*
 * panel's maximum. One curve drives them all, so an axis sized to the
 * brightest display would leave the others' reachable range squeezed into the
 * bottom of the plot -- and a target above this ceiling is one that not every
 * display can hit anyway.
 * @return {?number} null until something is calibrated
 */
function ceilingLux() {
  const maxes = state.displays
    .map((d) => calibrationOf(state.cfg, d.key))
    .filter(Boolean)
    .map((cal) => cal.maxLux);
  return maxes.length ? Math.min(...maxes) : null;
}

function refreshGraphs() {
  const ceiling = ceilingLux();
  for (const { key, graph } of graphs) {
    graph.setGain(key === null ? 1.0 : (state.cfg.gains[key] ?? 1.0));

    const cal = calFor(key);
    if (!cal) {
      graph.setLimits(0, 0);
      continue;
    }
    const on = state.cfg.extradim;
    const floor = on ? cal.extradimFloor(state.cfg.minContrast) : cal.minLux;
    graph.setLimits(on ? cal.minLux : 0, floor, ceiling);
  }
}

/**
 * The minimum-contrast slider's top end: a minimum above the contrast the
 * panel was measured at is meaningless. It is the slider's `max` rather than a
 * clamp on the way out, so the useful range fills the whole track.
 */
function contrastCeiling() {
  const cal = calFor(null);
  return cal ? cal.calContrast : state.cfg.calContrast;
}

function refreshExtradim() {
  const min = Number($('xd-min').value);
  $('xd-min-value').textContent = `${min}%`;

  const cal = calFor(null);
  $('xd-floor').textContent = !cal
    ? 'Calibrate a display to see how far ExtraDim reaches.'
    : `Brightness alone bottoms out at ${cal.minLux.toFixed(2)} lux. ` +
      `At ${min}% contrast this display reaches ${cal.extradimFloor(min).toFixed(2)} lux.`;
}

/** Fills the port dropdown. Only worth doing when the page is opened. */
async function loadPorts() {
  const select = $('set-port');
  select.replaceChildren();

  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = 'Auto-detect';
  select.append(auto);

  for (const { device, label } of await api.listPorts()) {
    const option = document.createElement('option');
    option.value = device;
    option.textContent = label;
    select.append(option);
  }
  select.value = state.cfg?.serialPort ?? '';
}

// --- wiring, once ------------------------------------------------------------

$('knob-one').addEventListener('change', () => patch({ singleKnob: true }));
$('knob-each').addEventListener('change', () => patch({ singleKnob: false }));
$('set-theme').addEventListener('change', (e) => patch({ theme: e.target.value }));
$('set-compact').addEventListener('change', (e) => patch({ compact: e.target.checked }));
$('set-autolearn').addEventListener('change', (e) => patch({ autoLearn: e.target.checked }));
$('learn-avg').addEventListener('change', () => patch({ learnAveraged: true }));
$('learn-each').addEventListener('change', () => patch({ learnAveraged: false }));
$('set-tovcc').addEventListener('change', (e) => patch({ ldrToVcc: e.target.checked }));
$('set-minimized').addEventListener('change', (e) => patch({ startMinimized: e.target.checked }));
$('set-port').addEventListener('change', (e) => patch({ serialPort: e.target.value }));
$('set-rerun').addEventListener('click', () => setup.start());

for (const [id, key] of [
  ['set-rfixed', 'rFixed'],
  ['set-r10', 'r10'],
  ['set-gamma', 'gamma'],
]) {
  $(id).addEventListener('change', (e) => {
    const v = Number(e.target.value);
    if (Number.isFinite(v) && v > 0) patch({ [key]: v });
  });
}

$('xd-min').addEventListener('input', refreshExtradim);
$('xd-min').addEventListener('change', () => patch({ minContrast: Number($('xd-min').value) }));

$('curve-save').addEventListener('click', () => {
  editing.curveDirty = false;
  $('curve-save').disabled = true;
  patch({ curveYs: [...curve.ys] });
});

$('curve-reset').addEventListener('click', () => {
  curve.ys = defaultYsFor(state.cfg);
  editing.curveDirty = false;
  $('curve-save').disabled = true;
  api.resetCurve();
});

/** @type {!Object} */
export const settingsPage = {
  id: 'settings',

  build(next) {
    state = next;
    const cfg = state.cfg;

    buildCalibrate(state);
    buildNames();
    $('knob-one').checked = cfg.singleKnob;
    $('knob-each').checked = !cfg.singleKnob;
    $('set-theme').value = cfg.theme;
    $('set-compact').checked = cfg.compact;
    $('set-autolearn').checked = cfg.autoLearn;
    $('learn-avg').checked = cfg.learnAveraged;
    $('learn-each').checked = !cfg.learnAveraged;
    $('set-rfixed').value = cfg.rFixed;
    $('set-r10').value = cfg.r10;
    $('set-gamma').value = cfg.gamma;
    $('set-tovcc').checked = cfg.ldrToVcc;
    $('set-minimized').checked = cfg.startMinimized;

    // Averaging only means something when there is more than one knob.
    const perDisplay = cfg.autoLearn && !cfg.singleKnob;
    const splittable = cfg.autoLearn && !cfg.singleKnob;
    $('learn-avg').disabled = !splittable;
    $('learn-each').disabled = !splittable;

    $('xd-min').max = String(contrastCeiling()); // before the value, or it clamps
    $('xd-min').value = String(cfg.minContrast);
    refreshExtradim();

    buildGraphs();
    refreshGraphs();
  },

  enter() {
    loadPorts();
    for (const { graph } of graphs) graph.draw();
  },

  tick(t) {
    for (const { graph } of graphs) graph.setAmbient(t.ambientLux);
  },
};

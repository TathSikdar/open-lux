// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Tath Sikdar

/**
 * The four screens.
 *
 * The renderer owns no hardware and no truth: main.js pushes `state` when the
 * config or the display list changes and `tick` on every sensor reading, and
 * every control here sends an action back. That is why there is no local copy
 * of the config to keep in sync -- the one exception is the curve being
 * dragged, which is unsaved by definition.
 */

import { Curve, calibrationOf, defaultYs } from './core.js';
import { CurveGraph } from './graph.js';

const api = window.openlux;
const $ = (id) => document.getElementById(id);

let state = { cfg: null, displays: [], status: '' };
let levels = {};
let ambientLux = null;
let curveDirty = false;
let calibrating = false;

const curve = new Curve();

const patch = (p) => api.patchConfig(p);

// --- navigation -------------------------------------------------------------

let page = 'home';

function go(name) {
  page = name;
  for (const b of document.querySelectorAll('.nav')) {
    const on = b.dataset.page === name;
    if (on) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
    $(`page-${b.dataset.page}`).hidden = !on;
  }
  render();
  if (name === 'settings') loadPorts();
}

for (const b of document.querySelectorAll('.nav')) {
  b.addEventListener('click', () => go(b.dataset.page));
}

// --- graphs -----------------------------------------------------------------

const setGraph = new CurveGraph($('set-graph'), curve, {
  editable: true,
  onChange: () => {
    curveDirty = true;
    $('curve-save').disabled = false;
  },
});
const xdGraph = new CurveGraph($('xd-graph'), curve);

/** The calibration the graphs are drawn against -- first calibrated display;
 *  they mostly differ by scale, not shape. */
function referenceCal() {
  for (const d of state.displays) {
    const cal = calibrationOf(state.cfg, d.key);
    if (cal) return cal;
  }
  return null;
}

function refreshSettingsGraph() {
  const cal = referenceCal();
  if (!cal) return setGraph.setLimits(0, 0);
  const floor = state.cfg.extradim ? cal.extradimFloor(state.cfg.minContrast) : cal.minLux;
  setGraph.setLimits(cal.minLux, floor, cal.maxLux * 1.1);
}

// --- Home -------------------------------------------------------------------

const dragging = new Set();

function buildSliders() {
  const box = $('sliders');
  box.replaceChildren();

  const cfg = state.cfg;
  const calibrated = state.displays.filter((d) => d.calibrated);

  if (!state.displays.length) {
    box.append(note('No DDC/CI displays detected.'));
    return;
  }
  if (!calibrated.length) {
    box.append(
      note(
        'No display is calibrated yet - nothing will be changed. Go to Calibrate to measure one.',
      ),
    );
  }

  const targets = cfg.singleKnob
    ? [['all', 'Brightness']]
    : calibrated.map((d) => [d.key, d.name]);
  for (const [key, name] of targets) box.append(slider(key, name));

  for (const d of state.displays) {
    if (!d.calibrated) box.append(note(`${d.name} - not calibrated, left alone`));
  }
  showLevels(); // navigating back should not zero them
}

function note(text) {
  const p = document.createElement('p');
  p.className = 'sub';
  p.textContent = text;
  return p;
}

function slider(key, name) {
  const wrap = document.createElement('div');

  const head = document.createElement('div');
  head.className = 'row';
  const label = document.createElement('label');
  label.textContent = name;
  const value = document.createElement('output');
  value.className = 'value';
  value.textContent = '--';
  value.style.marginLeft = 'auto';
  head.append(label, value);

  const input = document.createElement('input');
  input.type = 'range';
  input.min = 0;
  input.max = 100;
  input.step = 1;
  input.style.width = '100%';
  label.htmlFor = input.id = `slider-${key}`;

  // 'input' fires while dragging and 'change' on release -- exactly the
  // sliderMoved / sliderReleased split the Qt build relied on.
  input.addEventListener('pointerdown', () => dragging.add(key));
  input.addEventListener('input', () => {
    value.textContent = `${input.value}%`;
    api.previewManual(key, Number(input.value));
  });
  input.addEventListener('change', () => {
    dragging.delete(key);
    api.commitManual(key, Number(input.value));
  });

  wrap.append(head, input);
  wrap._value = value;
  wrap._input = input;
  return wrap;
}

/** Updates the sliders the user is not holding. */
function showLevels() {
  for (const wrap of $('sliders').children) {
    if (!wrap._input) continue;
    const key = wrap._input.id.slice('slider-'.length);
    const v =
      key === 'all'
        ? (() => {
            const vals = Object.values(levels);
            return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
          })()
        : levels[key];
    if (v === null || v === undefined) continue;
    wrap._value.textContent = `${v}%`;
    if (!dragging.has(key)) wrap._input.value = v;
  }
}

$('home-extradim').addEventListener('change', (e) => patch({ extradim: e.target.checked }));

// --- Calibrate --------------------------------------------------------------

function buildCalibrate() {
  const sel = $('cal-display');
  const keep = sel.value;
  sel.replaceChildren();
  for (const d of state.displays) {
    const o = document.createElement('option');
    o.value = d.index;
    o.textContent = d.name + (d.calibrated ? '  [calibrated]' : '');
    sel.append(o);
  }
  if (keep) sel.value = keep;
  $('cal-contrast').value = state.cfg.calContrast;
  $('cal-button').disabled = !state.displays.length;
}

$('cal-button').addEventListener('click', () => {
  if (calibrating) return api.cancelCalibration();
  const index = Number($('cal-display').value);
  if (Number.isNaN(index)) return;

  calibrating = true;
  $('cal-button').textContent = 'Cancel';
  $('cal-bar').hidden = false;
  $('cal-bar').value = 0;
  api.startCalibration(index, Number($('cal-contrast').value));
});

function endCalibration() {
  calibrating = false;
  $('cal-button').textContent = 'Ready to calibrate';
  $('cal-bar').hidden = true;
  $('cal-square').classList.remove('white');
}

api.onCalibrationProgress(({ pct, label }) => {
  $('cal-bar').value = pct;
  $('cal-progress').textContent = label;
});
api.onCalibrationSquare((white) => $('cal-square').classList.toggle('white', white));
api.onCalibrationDone(({ minLux, maxLux, floor, hasContrast }) => {
  $('cal-progress').textContent =
    `Calibrated: ${minLux.toFixed(1)} - ${maxLux.toFixed(0)} lux` +
    (hasContrast ? `, down to ${floor.toFixed(1)} with ExtraDim` : '');
  endCalibration();
});
api.onCalibrationFailed((msg) => {
  $('cal-progress').textContent = msg;
  endCalibration();
});

// --- ExtraDim ---------------------------------------------------------------

function buildExtraDim() {
  const sel = $('xd-display');
  const keep = sel.value;
  sel.replaceChildren();
  for (const d of state.displays) {
    if (!d.calibrated) continue;
    const o = document.createElement('option');
    o.value = d.key;
    o.textContent = d.name;
    sel.append(o);
  }
  if (keep) sel.value = keep;

  $('xd-enable').checked = state.cfg.extradim;
  $('xd-min').value = state.cfg.minContrast;
  refreshExtraDim();
}

function refreshExtraDim() {
  const min = Number($('xd-min').value);
  $('xd-min-value').textContent = `${min}%`;

  const cal = calibrationOf(state.cfg, $('xd-display').value);
  xdGraph.setCurve(curve);
  if (!cal) {
    xdGraph.setLimits(0, 0);
    $('xd-floor').textContent = 'Calibrate a display to preview its ExtraDim range.';
    return;
  }
  const floor = state.cfg.extradim ? cal.extradimFloor(state.cfg.minContrast) : cal.minLux;
  // Zoomed to the dim end -- at full scale this whole region is a few pixels
  // tall and the point of the screen is watching it move.
  xdGraph.setLimits(cal.minLux, floor, Math.max(cal.minLux * 4, 20.0));
  $('xd-floor').textContent =
    `Brightness alone bottoms out at ${cal.minLux.toFixed(1)} lux. ` +
    `At ${min}% contrast this display reaches ${cal.extradimFloor(min).toFixed(1)} lux.`;
}

$('xd-enable').addEventListener('change', (e) => patch({ extradim: e.target.checked }));
$('xd-display').addEventListener('change', refreshExtraDim);

$('xd-min').addEventListener('input', () => {
  // A minimum above the contrast the panel was measured at is meaningless.
  const cal = calibrationOf(state.cfg, $('xd-display').value);
  if (cal) $('xd-min').value = Math.min(Number($('xd-min').value), cal.calContrast);
  refreshExtraDim();
});
$('xd-min').addEventListener('change', () => patch({ minContrast: Number($('xd-min').value) }));

// --- Settings ---------------------------------------------------------------

function buildSettings() {
  const cfg = state.cfg;
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

  const perDisplay = cfg.autoLearn && !cfg.singleKnob;
  $('learn-avg').disabled = !perDisplay;
  $('learn-each').disabled = !perDisplay;

  refreshSettingsGraph();
}

async function loadPorts() {
  const sel = $('set-port');
  sel.replaceChildren();
  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = 'Auto-detect';
  sel.append(auto);
  for (const { device, label } of await api.listPorts()) {
    const o = document.createElement('option');
    o.value = device;
    o.textContent = label;
    sel.append(o);
  }
  sel.value = state.cfg?.serialPort ?? '';
}

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

$('curve-save').addEventListener('click', () => {
  curveDirty = false;
  $('curve-save').disabled = true;
  patch({ curveYs: [...curve.ys] });
});

$('curve-reset').addEventListener('click', () => {
  curve.ys = defaultYs();
  curveDirty = false;
  $('curve-save').disabled = true;
  api.resetCurve();
});

// --- rendering --------------------------------------------------------------

function render() {
  if (!state.cfg) return;
  document.body.classList.toggle('compact', state.cfg.compact);
  $('home-extradim').checked = state.cfg.extradim;

  if (page === 'home') buildSliders();
  else if (page === 'calibrate') buildCalibrate();
  else if (page === 'extradim') buildExtraDim();
  else if (page === 'settings') buildSettings();
}

api.onState((s) => {
  state = s;
  // A curve the user is part-way through editing is the one thing the renderer
  // owns; do not stomp it with the saved copy.
  if (!curveDirty) curve.ys = [...s.curveYs];
  render();
  setGraph.draw();
  xdGraph.draw();
});

api.onTick((t) => {
  ambientLux = t.ambientLux;
  levels = t.levels;
  $('status').textContent = t.status;
  $('readout').textContent =
    ambientLux === null ? '--' : `${Math.round(ambientLux).toLocaleString()} lux ambient`;
  if (page === 'home') showLevels();
  setGraph.setAmbient(ambientLux);
  xdGraph.setAmbient(ambientLux);
});

go('home');

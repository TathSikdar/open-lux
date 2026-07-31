// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Tath Sikdar

/**
 * @fileoverview Settings: preferences, the LDR constants, and the draggable
 * response curve.
 */

import { calibrationOf, defaultYs } from '../core.js';
import { CurveGraph } from '../graph.js';
import * as setup from '../setup.js';
import { $, api, curve, editing, patch } from '../ui.js';

const graph = new CurveGraph($('set-graph'), curve, {
  editable: true,
  onChange: () => {
    editing.curveDirty = true;
    $('curve-save').disabled = false;
  },
});

/** @type {!Object} the most recent `state` push */
let state = { cfg: null, displays: [] };

/**
 * The calibration the shared curve is drawn against: the first calibrated
 * display. Panels mostly differ by scale here, not by shape.
 * @return {?Object}
 */
function referenceCal() {
  for (const d of state.displays) {
    const cal = calibrationOf(state.cfg, d.key);
    if (cal) return cal;
  }
  return null;
}

function refreshGraph() {
  const cal = referenceCal();
  if (!cal) return graph.setLimits(0, 0);
  const floor = state.cfg.extradim ? cal.extradimFloor(state.cfg.minContrast) : cal.minLux;
  graph.setLimits(cal.minLux, floor, cal.maxLux * 1.1);
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

$('curve-save').addEventListener('click', () => {
  editing.curveDirty = false;
  $('curve-save').disabled = true;
  patch({ curveYs: [...curve.ys] });
});

$('curve-reset').addEventListener('click', () => {
  curve.ys = defaultYs();
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
    $('learn-avg').disabled = !perDisplay;
    $('learn-each').disabled = !perDisplay;

    refreshGraph();
  },

  enter() {
    loadPorts();
    graph.draw();
  },

  tick(t) {
    graph.setAmbient(t.ambientLux);
  },
};

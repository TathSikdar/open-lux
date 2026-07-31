// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Tath Sikdar

/**
 * @fileoverview ExtraDim: preview of how far below brightness 0 a display can
 * be pushed by dropping contrast.
 *
 * The preview is driven by the slider's live value, not by the saved config.
 * Waiting for the round trip through main.js meant the graph only moved once
 * the pointer was released, which read as a graph that did not work at all.
 */

import { calibrationOf } from '../core.js';
import { CurveGraph } from '../graph.js';
import { $, curve, patch } from '../ui.js';

const graph = new CurveGraph($('xd-graph'), curve);

/** @type {!Object} the most recent `state` push */
let state = { cfg: null, displays: [] };

/**
 * Repaints from the controls as they stand right now.
 *
 * The y-axis is zoomed to the dim end: at the full brightness scale this whole
 * region is a few pixels tall, and watching it move is the point of the page.
 */
function refresh() {
  const enabled = state.cfg.extradim;
  const min = Number($('xd-min').value);

  // Without ExtraDim there is nothing for the minimum to mean, so say so by
  // greying it rather than by letting it move a curve it does not affect.
  $('xd-min').disabled = !enabled;
  $('xd-min-value').textContent = `${min}%`;

  const cal = calibrationOf(state.cfg, $('xd-display').value);
  if (!cal) {
    graph.setLimits(0, 0);
    $('xd-floor').textContent = 'Calibrate a display to preview its ExtraDim range.';
    return;
  }

  const floor = enabled ? cal.extradimFloor(min) : cal.minLux;
  graph.setLimits(cal.minLux, floor, Math.max(cal.minLux * 4, 2));
  $('xd-floor').textContent =
    `Brightness alone bottoms out at ${cal.minLux.toFixed(2)} lux. ` +
    (enabled
      ? `At ${min}% contrast this display reaches ${cal.extradimFloor(min).toFixed(2)} lux.`
      : 'Enable ExtraDim to take it below that.');
}

$('xd-enable').addEventListener('change', (e) => patch({ extradim: e.target.checked }));
$('xd-display').addEventListener('change', refresh);

$('xd-min').addEventListener('input', () => {
  // A minimum above the contrast the panel was measured at is meaningless.
  const cal = calibrationOf(state.cfg, $('xd-display').value);
  if (cal) $('xd-min').value = String(Math.min(Number($('xd-min').value), cal.calContrast));
  refresh();
});

$('xd-min').addEventListener('change', () => patch({ minContrast: Number($('xd-min').value) }));

/** @type {!Object} */
export const extradimPage = {
  id: 'extradim',

  build(next) {
    state = next;

    const select = $('xd-display');
    const keep = select.value;
    select.replaceChildren();
    for (const d of state.displays) {
      if (!d.calibrated) continue;
      const option = document.createElement('option');
      option.value = d.key;
      option.textContent = d.name;
      select.append(option);
    }
    if (keep) select.value = keep;

    $('xd-enable').checked = state.cfg.extradim;
    $('xd-min').value = String(state.cfg.minContrast);
    refresh();
  },

  enter() {
    graph.draw();
  },

  tick(t) {
    graph.setAmbient(t.ambientLux);
  },
};

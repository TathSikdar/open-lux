// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Tath Sikdar

/**
 * @fileoverview Calibrate: drives one display's measurement sweep.
 *
 * The sweep itself runs in main.js; this page only starts it, shows the white
 * square it needs, and reports progress.
 */

import * as calibration from '../calibration.js';
import { $, api } from '../ui.js';

let running = false;

/** Puts the button and the square back however the run ended. */
function finish() {
  running = false;
  $('cal-button').textContent = 'Ready to calibrate';
  $('cal-identify').disabled = false;
  $('cal-bar').hidden = true;
  $('cal-square').classList.remove('white');
}

/** @type {!Object} passed to calibration.js for the runs this page starts. */
const handlers = {
  progress({ pct, label }) {
    $('cal-bar').value = pct;
    $('cal-progress').textContent = label;
  },

  square(white) {
    $('cal-square').classList.toggle('white', white);
  },

  done({ minLux, maxLux, floor, hasContrast }) {
    $('cal-progress').textContent =
      `Calibrated: ${minLux.toFixed(1)} - ${maxLux.toFixed(0)} lux` +
      (hasContrast ? `, down to ${floor.toFixed(1)} with ExtraDim` : '');
    finish();
  },

  failed(message) {
    $('cal-progress').textContent = message;
    finish();
  },
};

$('cal-button').addEventListener('click', () => {
  if (running) return calibration.cancel();

  const index = Number($('cal-display').value);
  if (Number.isNaN(index)) return;

  running = true;
  $('cal-button').textContent = 'Cancel';
  $('cal-identify').disabled = true;
  $('cal-bar').hidden = false;
  $('cal-bar').value = 0;
  calibration.start(index, Number($('cal-contrast').value), handlers);
});

$('cal-identify').addEventListener('click', () => {
  const index = Number($('cal-display').value);
  if (!Number.isNaN(index)) api.identifyDisplay(index);
});

/** @type {!Object} */
export const calibratePage = {
  id: 'calibrate',

  build(state) {
    const select = $('cal-display');
    const keep = select.value;
    select.replaceChildren();
    for (const d of state.displays) {
      const option = document.createElement('option');
      option.value = String(d.index);
      option.textContent = d.name + (d.calibrated ? '  [calibrated]' : '');
      select.append(option);
    }
    if (keep) select.value = keep;

    $('cal-contrast').value = state.cfg.calContrast;
    $('cal-button').disabled = !state.displays.length;
    $('cal-identify').disabled = running || !state.displays.length;
  },
};

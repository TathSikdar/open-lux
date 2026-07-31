// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Tath Sikdar

/**
 * @fileoverview The renderer's half of a calibration sweep, shared by the
 * Calibrate page and the setup wizard.
 *
 * The four IPC channels can only be listened to once usefully, so they are
 * registered here and forwarded to whoever started the run. A single sink is
 * enough because main.js refuses to start a second sweep while one is in
 * flight.
 */

import { api } from './ui.js';

/** @type {?Object} the caller that started the run in flight. */
let sink = null;

api.onCalibrationProgress((p) => sink?.progress?.(p));
api.onCalibrationSquare((white) => sink?.square?.(white));

// Clear the sink *before* calling out, so a handler is free to start the next
// display's sweep from inside its own completion callback.
api.onCalibrationDone((result) => {
  const s = sink;
  sink = null;
  s?.done?.(result);
});

api.onCalibrationFailed((message) => {
  const s = sink;
  sink = null;
  s?.failed?.(message);
});

/**
 * @param {number} index display index
 * @param {number} contrast the contrast the panel is measured at
 * @param {{progress: (function(!Object)|undefined),
 *          square: (function(boolean)|undefined),
 *          done: (function(!Object)|undefined),
 *          failed: (function(string)|undefined)}} handlers
 */
export function start(index, contrast, handlers) {
  sink = handlers;
  api.startCalibration(index, contrast);
}

export function cancel() {
  api.cancelCalibration();
}

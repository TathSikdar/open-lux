// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Tath Sikdar

/**
 * @fileoverview The first-run wizard: build the sensor, then calibrate the
 * displays.
 *
 * It takes the whole window over rather than being a routed page, because a
 * user who has not built the hardware yet has nothing to do on any of the
 * other four screens. It owns no truth either -- the sweep runs in main.js via
 * calibration.js, and "have I finished setup" is one flag in the config.
 *
 * The step list is fixed when the wizard opens. The sensor connecting
 * mid-wizard does not move the user, since they may be part-way through
 * reading the wiring instructions.
 */

import * as calibration from './calibration.js';
import { $, api, formatLux, patch } from './ui.js';

/** No reading for this long means the link is up but nothing is arriving. */
const STALE_MS = 3000;

/** @const {!Array<string>} every step that exists, in order. */
const ALL = ['welcome', 'hardware', 'calibrate', 'done'];

/** @type {!Array<string>} the steps this run is showing, a subset of ALL. */
let steps = [];

/** @type {number} index into `steps`. */
let at = 0;

/** @type {?Object} the most recent `state` push. */
let snapshot = null;

/** Displays the user chose not to measure. Keys, so a replug keeps the choice. */
const skipped = new Set();

/** @type {boolean} a sweep is in flight. */
let running = false;

/** @type {boolean} set once the sensor has ever reported in, this session. */
let sensorSeen = false;

/**
 * A sweep finished and the wizard is waiting to be told the display list agrees.
 *
 * main.js sends 'calibrate:done' before the `state` push that marks the display
 * calibrated, so the moment the sweep ends `pending()` still counts it. Rather
 * than guess, the wizard notes that a sweep landed and lets the next push
 * decide whether anything is left to measure.
 */
let sweptSomething = false;

const open = () => !$('setup').hidden;
const step = () => steps[at] ?? 'done';

/** Displays still worth measuring, neatest first. */
function pending() {
  return (snapshot?.displays ?? []).filter((d) => !d.calibrated && !skipped.has(d.key));
}

// --- rendering ---------------------------------------------------------------

/** The progress pips. Filled up to and including the current step. */
function renderDots() {
  const dots = $('setup-dots');
  dots.replaceChildren();
  steps.forEach((_, i) => {
    const dot = document.createElement('span');
    dot.className = i <= at ? 'pip on' : 'pip';
    dots.append(dot);
  });
}

/** The calibrate step's copy, which depends on what is left to measure. */
function renderCalibrate() {
  const next = pending()[0];

  // Nothing left to measure: the instructions describe a sweep that is not
  // going to happen, so they go with it and only the outcome line is left.
  $('setup-cal-intro').hidden = !next;
  $('setup-cal-card').hidden = !next;
  $('setup-square').hidden = !next;

  if (!next) {
    const none = !snapshot?.displays?.length;
    $('setup-cal-title').textContent = none ? 'No displays to calibrate' : 'Displays calibrated';
    $('setup-cal-status').textContent = none
      ? 'No DDC/CI displays were detected. Most laptop screens cannot be ' +
        'controlled this way; an external monitor on HDMI or DisplayPort can.'
      : 'Every display open-lux can see has been measured or skipped.';
    return;
  }

  const done = (snapshot.displays.length - pending().length) + 1;
  $('setup-cal-title').textContent =
    snapshot.displays.length > 1
      ? `Calibrate ${next.name} (${done} of ${snapshot.displays.length})`
      : `Calibrate ${next.name}`;
  $('setup-cal-name').textContent = next.name;
}

/** Shows the current step and relabels the two buttons for it. */
function render() {
  if (!open()) return;

  // ALL, not `steps`: re-running setup from Settings drops the hardware step,
  // and a step left showing from the previous run would stack under this one.
  const now = step();
  for (const id of ALL) $(`step-${id}`).hidden = id !== now;
  renderDots();
  if (now === 'calibrate') renderCalibrate();

  const last = at === steps.length - 1;
  const next = pending()[0];

  $('setup-skip').hidden = running;
  $('setup-identify').hidden = !(now === 'calibrate' && next);
  $('setup-identify').disabled = running;
  $('setup-skip').textContent =
    now === 'calibrate' && next ? 'Skip this display' : last ? 'Skip' : 'Skip this step';

  if (running) $('setup-next').textContent = 'Cancel';
  else if (now === 'calibrate' && next) $('setup-next').textContent = 'Calibrate';
  else if (now === 'welcome') $('setup-next').textContent = 'Get started';
  else $('setup-next').textContent = last ? 'Finish' : 'Next';

  if (now === 'done') {
    const cal = (snapshot?.displays ?? []).filter((d) => d.calibrated).length;
    $('setup-summary').textContent = cal
      ? `${cal} display${cal > 1 ? 's are' : ' is'} calibrated and open-lux is ` +
        'now matching them to the room.'
      : 'No display was calibrated, so open-lux will report the light level ' +
        'without changing anything yet.';
  }
}

// --- navigation --------------------------------------------------------------

function finish() {
  $('setup').hidden = true;
  patch({ firstRunDone: true });
}

function advance() {
  if (at >= steps.length - 1) return finish();
  at += 1;
  $('setup-body').scrollTop = 0;
  render();
}

/** Skip: on the calibrate step that means this display, not the whole step. */
function skip() {
  const now = step();
  const next = pending()[0];
  if (now === 'calibrate' && next) {
    skipped.add(next.key);
    render();
    if (!pending().length) $('setup-cal-status').textContent = '';
    return;
  }
  advance();
}

/** @type {!Object} handlers for the sweeps this wizard starts. */
const handlers = {
  progress({ pct, label }) {
    $('setup-bar').value = pct;
    $('setup-cal-status').textContent = label;
  },

  square(white) {
    $('setup-square').classList.toggle('white', white);
  },

  done({ minLux, maxLux, floor, hasContrast }) {
    $('setup-cal-status').textContent =
      `Measured ${minLux.toFixed(1)} - ${maxLux.toFixed(0)} lux` +
      (hasContrast ? `, down to ${floor.toFixed(1)} with ExtraDim.` : '.');
    sweptSomething = true;
    stopped();
  },

  failed(message) {
    $('setup-cal-status').textContent = message;
    stopped();
  },
};

/** Puts the step back however the sweep ended. */
function stopped() {
  running = false;
  $('setup-bar').hidden = true;
  $('setup-square').classList.remove('white');
  render();
}

function primary() {
  if (running) return calibration.cancel();

  const next = step() === 'calibrate' ? pending()[0] : null;
  if (!next) return advance();

  running = true;
  $('setup-bar').hidden = false;
  $('setup-bar').value = 0;
  $('setup-cal-status').textContent = 'Starting…';
  render();
  calibration.start(next.index, snapshot.cfg.calContrast, handlers);
}

// --- wiring, once ------------------------------------------------------------

$('setup-next').addEventListener('click', primary);
$('setup-skip').addEventListener('click', skip);
$('setup-identify').addEventListener('click', () => {
  const next = pending()[0];
  if (next) api.identifyDisplay(next.index);
});
$('setup-quit').addEventListener('click', () => {
  if (running) calibration.cancel();
  finish();
});

// --- the shell's three hooks -------------------------------------------------

/** Opens the wizard. Safe to call again later from Settings. */
export function start() {
  // Skip the build instructions for someone whose sensor is already talking.
  steps = ['welcome', ...(sensorSeen ? [] : ['hardware']), 'calibrate', 'done'];
  at = 0;
  running = false;
  sweptSomething = false;
  skipped.clear();
  $('setup').hidden = false;
  $('setup-cal-status').textContent = '';
  $('setup-body').scrollTop = 0;
  render();
}

/** @param {!Object} next */
export function state(next) {
  snapshot = next;

  // The last display just finished, so the step has nothing left to offer.
  // Only after a sweep this run: re-opening the wizard with everything already
  // calibrated must still stop here, or there is no way back in to redo one.
  if (sweptSomething && open() && !running && step() === 'calibrate' && !pending().length) {
    sweptSomething = false;
    return advance();
  }
  render();
}

/** @param {!Object} t */
export function tick(t) {
  if (t.sensor?.connected) sensorSeen = true;
  if (!open() || step() !== 'hardware') return;

  const sensor = t.sensor;
  const live =
    sensor?.connected &&
    sensor.ageMs !== null &&
    sensor.ageMs < STALE_MS &&
    t.ambientLux !== null;

  $('setup-dot').className = `dot ${live ? 'ok' : sensor?.connected ? 'warn' : 'bad'}`;
  $('setup-sensor').textContent = live
    ? `Sensor found on ${sensor.port}.`
    : sensor?.connected
      ? `${sensor.port} is open, but the sensor has sent nothing yet.`
      : 'Waiting for the sensor… plug the Arduino in and this will notice.';
  $('setup-lux').textContent = live
    ? `Reading ${formatLux(t.ambientLux)} lux. Cover the LDR with your hand – ` +
      'the number should drop within a second.'
    : '';
}

// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Tath Sikdar

/**
 * @fileoverview Home: the ambient readout, the sensor's connection state, and
 * one brightness slider per knob.
 */

import { $, api, formatLux, note, patch } from '../ui.js';

/** No reading for this long means the link is up but nothing is arriving. */
const STALE_MS = 3000;

/** Sliders the pointer is currently holding; those must not be moved under it. */
const dragging = new Set();

/**
 * Slider key -> its two elements. A map rather than expando properties on the
 * nodes, so the DOM stays the DOM.
 * @type {!Map<string, {input: !HTMLInputElement, output: !HTMLOutputElement}>}
 */
const rows = new Map();

/** @type {!Object} the most recent `state` push */
let state = { cfg: null, displays: [] };

/** @type {!Object<string, number>} display key -> brightness % */
let levels = {};

/**
 * One labelled 0-100 slider.
 * @param {string} key display key, or 'all' for the single-knob mode
 * @param {string} name
 * @return {!HTMLDivElement}
 */
function buildSlider(key, name) {
  const wrap = document.createElement('div');

  const head = document.createElement('div');
  head.className = 'row';
  const label = document.createElement('label');
  label.textContent = name;
  const output = document.createElement('output');
  output.className = 'value push';
  output.textContent = '--';
  head.append(label, output);

  const input = document.createElement('input');
  input.type = 'range';
  input.min = '0';
  input.max = '100';
  input.step = '1';
  input.className = 'wide';
  label.htmlFor = input.id = `slider-${key}`;

  // 'input' fires while dragging and 'change' on release -- the same
  // preview/commit split the control loop expects.
  input.addEventListener('pointerdown', () => dragging.add(key));
  input.addEventListener('input', () => {
    output.textContent = `${input.value}%`;
    api.previewManual(key, Number(input.value));
  });
  input.addEventListener('change', () => {
    dragging.delete(key);
    api.commitManual(key, Number(input.value));
  });

  rows.set(key, { input, output });
  wrap.append(head, input);
  return wrap;
}

/** Moves the sliders the user is not holding to match the control loop. */
function showLevels() {
  const values = Object.values(levels);
  for (const [key, { input, output }] of rows) {
    const value =
      key === 'all'
        ? values.length
          ? Math.round(values.reduce((a, b) => a + b, 0) / values.length)
          : null
        : levels[key];
    if (value === null || value === undefined) continue;
    output.textContent = `${value}%`;
    if (!dragging.has(key)) input.value = String(value);
  }
}

/**
 * Paints the connection indicator. Three states, because "no port" and "port
 * open but silent" need different fixes from the user.
 * @param {{connected: boolean, port: string, ageMs: ?number}|undefined} sensor
 * @param {string} status main.js's own message, used as the failure detail
 */
function showSensor(sensor, status) {
  let tone;
  let text;
  if (!sensor?.connected) {
    tone = 'bad';
    text = `Sensor not connected – ${status}`;
  } else if (sensor.ageMs === null || sensor.ageMs >= STALE_MS) {
    tone = 'warn';
    text = `${sensor.port} is open, but the sensor has sent nothing`;
  } else {
    tone = 'ok';
    text = `Sensor connected on ${sensor.port}`;
  }

  $('sensor-dot').className = `dot ${tone}`;
  $('sensor-text').textContent = text;
}

/** @type {!Object} */
export const homePage = {
  id: 'home',

  build(next) {
    state = next;
    const box = $('sliders');
    box.replaceChildren();
    rows.clear();

    $('home-extradim').checked = state.cfg.extradim;

    if (!state.displays.length) {
      box.append(note('No DDC/CI displays detected.'));
      return;
    }

    const calibrated = state.displays.filter((d) => d.calibrated);
    if (!calibrated.length) {
      box.append(
        note(
          'No display is calibrated yet - nothing will be changed. ' +
            'Go to Calibrate to measure one.',
        ),
      );
    }

    const targets = state.cfg.singleKnob
      ? [['all', 'Brightness']]
      : calibrated.map((d) => [d.key, d.name]);
    for (const [key, name] of targets) box.append(buildSlider(key, name));

    for (const d of state.displays) {
      if (!d.calibrated) box.append(note(`${d.name} - not calibrated`));
    }
    showLevels(); // navigating back should not zero them
  },

  tick(t) {
    levels = t.levels;
    $('readout').textContent =
      t.ambientLux === null ? '--' : `${formatLux(t.ambientLux)} lux ambient`;
    showSensor(t.sensor, t.status);
    showLevels();
  },
};

$('home-extradim').addEventListener('change', (e) => patch({ extradim: e.target.checked }));

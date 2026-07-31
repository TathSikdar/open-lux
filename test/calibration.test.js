// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Tath Sikdar

/**
 * Checks the calibration sweep and the interactive paths against a simulated
 * panel, so neither hardware nor a three-minute wait is involved.
 *
 *     npm test          (or: node --test test/calibration.test.js)
 *
 * CalibrationRun takes a display handle rather than reaching for one, and the
 * control loop lives in Controller rather than in a window, so both run here
 * under bare node -- no electron, no native modules, no display server.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { N_CONTRAST, calibrationOf, withDefaults } from '../src/core.js';
import { CalibrationRun, identifyDisplay } from '../src/hardware.js';
import { Controller } from '../src/controller.js';

const ROOM = 40.0; // ambient light reaching the sensor around the LDR

/**
 * An LCD that responds to both VCP controls, leaks light through black, and
 * sits in a lit room -- everything the sweep has to see through.
 */
class Panel {
  constructor() {
    this.b = 75;
    this.c = 75;
    this.white = false; // what the calibration square is showing
  }

  lux() {
    const base = 12.0 + 308.0 * (this.b / 100) ** 1.4;
    const emitted = base * (0.15 + (0.85 * this.c) / 100);
    return ROOM + emitted * (this.white ? 1.0 : 0.04);
  }

  handle() {
    return {
      getLuminance: async () => this.b,
      setLuminance: async (v) => {
        this.b = v;
      },
      getContrast: async () => this.c,
      setContrast: async (v) => {
        this.c = v;
      },
    };
  }
}

async function runSweep(panel) {
  let seq = 0;
  const readSeq = () => ++seq; // a fresh sample is always waiting

  const run = new CalibrationRun(panel.handle(), 50, () => panel.lux(), readSeq, 0.001);
  const events = [];
  run.on('progress', (pct) => events.push(['p', pct]));
  run.on('square', (white) => {
    panel.white = white;
    events.push(['sq', white]);
  });

  return [await run.run(), events];
}

// One sweep, shared by both tests -- it is the fixture for everything else.
let cached = null;
async function calibrated() {
  if (!cached) {
    const panel = new Panel();
    const [cal, events] = await runSweep(panel);
    cached = { cal, events, panel };
  }
  return cached;
}

test('calibration sweep measures a simulated panel', async () => {
  const { cal, events, panel } = await calibrated();

  assert.ok(cal.valid, 'the sweep must produce one sample per brightness %');
  assert.equal(cal.contrastLux.length, N_CONTRAST);
  assert.ok(panel.b === 75 && panel.c === 75, "the display's own settings must be restored");
  assert.deepEqual(events[0], ['sq', false]);
  assert.ok(events.some(([k, v]) => k === 'sq' && v === true));
  // The Qt build asserted on events[-1] here, but that only held because Qt
  // delivered progress on a queued cross-thread connection and square on a
  // direct one. Synchronously, restoring the black square is genuinely last.
  assert.equal(events.filter(([k]) => k === 'p').at(-1)[1], 100, 'progress must reach the end');
  assert.deepEqual(events.filter(([k]) => k === 'sq').at(-1), ['sq', false], 'square ends black');

  // The baseline strips the room and the panel's black level, leaving
  // white-minus-black at 50% contrast: 12*0.575 .. 320*0.575.
  assert.ok(Math.abs(cal.ambientOffset - ROOM) < 1.0, `baseline ${cal.ambientOffset}`);
  assert.ok(cal.minLux > 5 && cal.minLux < 9, `minLux ${cal.minLux}`);
  assert.ok(cal.maxLux > 175 && cal.maxLux < 195, `maxLux ${cal.maxLux}`);

  // The measured table has to invert: ask for what 40% emits, get 40% back.
  for (const pct of [0, 17, 40, 88, 100]) {
    const [got] = cal.solve(cal.luxAt(pct));
    assert.ok(Math.abs(got - pct) <= 1, `solve(${pct}) -> ${got}`);
  }

  // Contrast must reach below what brightness alone can do.
  assert.ok(cal.extradimFloor(0) < cal.minLux);
  assert.ok(cal.minLux < cal.extradimFloor(50) + 0.01);
  const [b, c] = cal.solve(cal.minLux * 0.5, true, 10);
  assert.ok(b === 0 && c >= 10 && c < 50, `${b}, ${c}`);
});

test('a cancelled sweep restores the display and rejects', async () => {
  const panel = new Panel();
  const run = new CalibrationRun(panel.handle(), 50, () => panel.lux(), () => 1, 0.001);
  run.on('square', (w) => {
    panel.white = w;
  });
  const promise = run.run();
  run.cancel();
  await assert.rejects(promise, /Cancelled|/);
  assert.ok(panel.b === 75 && panel.c === 75, 'a cancelled sweep must still put it back');
  assert.equal(panel.white, false, 'and must not leave a white square on screen');
});

test('identify blinks the panel and puts the brightness back', async () => {
  const panel = new Panel();
  const handle = panel.handle();
  const seen = [];
  const spy = {
    ...handle,
    setLuminance: async (v) => {
      seen.push(v);
      return handle.setLuminance(v);
    },
  };

  await identifyDisplay(spy, 2, 1);

  // A blink that does not swing the whole range is invisible on a dim panel.
  assert.deepEqual(seen, [0, 100, 0, 100, 75]);
  assert.equal(panel.b, 75, 'identify must leave the display where it found it');
});

// --- the control loop -------------------------------------------------------

function controller(cal) {
  const cfg = withDefaults({ calibrations: { 'SIM#0': cal.toJSON() } });
  const writes = [];
  const ctl = new Controller(cfg, (i, b, c) => writes.push([i, b, c]));
  ctl.displays = [
    { index: 0, key: 'SIM#0', name: 'Sim (1)' },
    { index: 1, key: 'OTHER#1', name: 'Other (2)' },
  ];
  ctl.ambientLux = ctl.rawLux = 200.0;
  return { cfg, ctl, writes };
}

test('an uncalibrated display is left alone', async () => {
  const { cal } = await calibrated();
  const { ctl, writes } = controller(cal);

  const levels = ctl.applyNow();
  assert.deepEqual(Object.keys(levels), ['SIM#0']);
  assert.ok(writes.every(([i]) => i === 0), 'nothing may be written to display 1');
});

test('a manual override holds, then releases', async () => {
  const { cal } = await calibrated();
  const { ctl } = controller(cal);

  ctl.manualCommit('all', 30);
  assert.equal(ctl.overridePct('SIM#0'), 30);

  ctl.ambientLux = 205.0;
  assert.equal(ctl.overridePct('SIM#0'), 30, 'a flicker must not cancel a manual nudge');

  ctl.ambientLux = 600.0;
  assert.equal(ctl.overridePct('SIM#0'), null, 'a real change hands back to automatic');
});

test('auto-learn moves the curve toward what the user picked', async () => {
  const { cal } = await calibrated();
  const { cfg, ctl } = controller(cal);
  cfg.autoLearn = true;
  cfg.singleKnob = true;

  const before = ctl.curve.valueAt(200.0);
  const want = cal.luxAt(90);
  for (let i = 0; i < 30; i++) ctl.manualCommit('all', 90);
  const after = ctl.curve.valueAt(200.0);

  assert.ok(
    Math.abs(after - want) < Math.abs(before - want),
    `${before} -> ${after}, wanted ${want}`,
  );
  assert.deepEqual(cfg.curveYs, ctl.curve.ys, 'the learned curve must be the saved one');
});

test('per-display learning uses a gain, not the shared curve', async () => {
  const { cal } = await calibrated();
  const { cfg, ctl } = controller(cal);
  cfg.singleKnob = false;
  cfg.learnAveraged = false;

  const shape = [...ctl.curve.ys];
  for (let i = 0; i < 20; i++) ctl.manualCommit('SIM#0', 20);

  assert.deepEqual(ctl.curve.ys, shape, 'per-display learning must leave the shared curve alone');
  assert.ok(cfg.gains['SIM#0'] > 0 && cfg.gains['SIM#0'] < 1);
});

test('the override is what applyNow actually drives', async () => {
  const { cal } = await calibrated();
  const { ctl, writes } = controller(cal);

  ctl.manualCommit('all', 30);
  writes.length = 0;
  const levels = ctl.applyNow();
  assert.equal(levels['SIM#0'], 30, 'a held override must survive the next reading');
  assert.deepEqual(writes[0].slice(0, 2), [0, 30]);
});

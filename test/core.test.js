// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Tath Sikdar

/**
 * Checks src/core.js: lux math, the curve, table inversion, learning.
 *
 *     npm test          (or: node --test test/core.test.js)
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONTRAST_STEP,
  Calibration,
  Curve,
  N_BRIGHT,
  N_CONTRAST,
  adcToLux,
  calibrationOf,
  curveOf,
  formatLux,
  invertIndex,
  learn,
  monotonic,
  targetFor,
  withDefaults,
} from '../src/core.js';

/** A well-behaved panel: luminance ramps linearly with brightness, and with
 *  contrast below it. */
export function syntheticCal(floor = 10.0, top = 300.0, calContrast = 50, minCLux = 1.0) {
  return new Calibration({
    brightLux: Array.from({ length: N_BRIGHT }, (_, b) => floor + ((top - floor) * b) / 100.0),
    contrastLux: Array.from(
      { length: N_CONTRAST },
      (_, i) => minCLux + ((floor - minCLux) * (i * CONTRAST_STEP)) / calContrast,
    ),
    calContrast,
  });
}

test('adcToLux', () => {
  const [lo, mid, hi] = [adcToLux(50), adcToLux(500), adcToLux(900)];
  assert.ok(lo < mid && mid < hi, 'brighter scene must read as more lux');
  assert.ok(adcToLux(0) > 0 && Number.isFinite(adcToLux(1023)), 'rails must not blow up');

  // At the divider midpoint R_ldr == rFixed, so lux must land on the value the
  // power law predicts for that resistance.
  const expected = 10.0 * (5100.0 / 5000.0) ** (-1 / 0.7);
  assert.ok(Math.abs(adcToLux(1023 / 2) - expected) < 1e-6);

  // Wiring flag flips the direction.
  const off = (a) => adcToLux(a, 5100, 5000, 0.7, false);
  assert.ok(off(900) < off(100));
});

test('a fractional ADC reading resolves the dark end', () => {
  // The firmware oversamples and sends decimals precisely so a dim room is not
  // three indistinguishable counts. Tenths of a count must be distinct lux.
  const dark = [0.4, 0.5, 0.7, 1.0, 2.0].map((a) => adcToLux(a));
  assert.ok(
    dark.every((v, i) => i === 0 || dark[i - 1] < v),
    `each step must read brighter: ${dark}`,
  );
  assert.ok(dark.every(Number.isFinite), 'and none of them may blow up');

  // Rounding to the nearest count -- what the old int firmware did -- collapses
  // that whole range onto one value.
  assert.equal(adcToLux(0.4), adcToLux(0.4));
  assert.ok(adcToLux(0.5) / adcToLux(1.0) < 0.5, 'half a count is most of a decade down here');

  assert.ok(Number.isFinite(adcToLux(1023)) && adcToLux(0) > 0, 'the rails still hold');
});

test('formatLux keeps decimals where they matter', () => {
  assert.equal(formatLux(0.37), '0.37');
  assert.equal(formatLux(4.5), '4.50');
  assert.equal(formatLux(42.25), '42.3');
  assert.equal(formatLux(1234.6), '1,235');
});

test('curve is exact at the knots and clamped outside', () => {
  const c = new Curve();
  c.ys.forEach((y, i) => {
    assert.ok(Math.abs(c.valueAt(c.luxAtKnot(i)) - y) < 1e-9, 'exact at the knots');
  });

  const mid = c.valueAt(10.0 ** ((c.xs[0] + c.xs[1]) / 2));
  assert.ok(c.ys[0] < mid && mid < c.ys[1], 'interpolates between them');

  assert.equal(c.valueAt(1e-9), c.ys[0]);
  assert.equal(c.valueAt(1e9), c.ys.at(-1));
});

test('monotonic repairs a wobbly sweep', () => {
  assert.deepEqual(monotonic([1, 5, 3, 4, 9, 2]), [1, 5, 5, 5, 9, 9]);

  const noisy = syntheticCal();
  noisy.brightLux[40] = 0.0; // a dropout mid-sweep
  const b = noisy.brightMono();
  assert.ok(b.every((v, i) => i === 0 || b[i - 1] <= v));
});

test('invertIndex', () => {
  const vals = [0.0, 10.0, 20.0, 30.0];
  assert.equal(invertIndex(vals, 15.0), 1.5);
  assert.equal(invertIndex(vals, -5.0), 0.0, 'below range clamps low');
  assert.equal(invertIndex(vals, 99.0), 3.0, 'above range clamps high');
  assert.equal(invertIndex([5.0, 5.0, 5.0], 5.0), 0.0, 'plateau picks the first');
});

test('solve on brightness alone', () => {
  const cal = syntheticCal(10.0, 300.0);
  for (const pct of [0, 37, 100]) {
    assert.deepEqual(cal.solve(cal.brightMono()[pct]), [pct, 50]);
  }
  assert.equal(cal.solve(1e9)[0], 100, 'unreachable target pins at max');
});

test('solve hands over to contrast for ExtraDim', () => {
  const cal = syntheticCal(10.0, 300.0, 50, 1.0);
  const below = 5.0; // dimmer than brightness 0 can manage

  assert.deepEqual(cal.solve(below, false), [0, 50], 'ExtraDim off floors at brightness 0');

  const [b, c] = cal.solve(below, true, 10);
  assert.ok(b === 0 && c >= 10 && c < 50, 'contrast takes over below the floor');

  // The minimum is a hard floor, not a suggestion.
  assert.equal(cal.solve(0.0, true, 30)[1], 30);

  // Raising the floor makes the panel dimmer-capable.
  assert.ok(cal.extradimFloor(0) < cal.extradimFloor(50));
  assert.ok(Math.abs(cal.extradimFloor(50) - cal.minLux) < 1e-9);
});

test('luxAt round-trips through solve', () => {
  const cal = syntheticCal();
  for (const pct of [0, 25, 100]) {
    assert.equal(cal.solve(cal.luxAt(pct))[0], pct);
  }
});

test('learn converges without dragging distant knots', () => {
  const c = new Curve();
  const ambient = 100.0;
  const before = [...c.ys];
  const desired = new Curve(before).valueAt(ambient) * 2;

  learn(c, ambient, desired);
  const start = new Curve(before).valueAt(ambient);
  assert.ok(
    start < c.valueAt(ambient) && c.valueAt(ambient) < desired,
    'moves toward the user, but not the whole way',
  );

  const x = Math.log10(ambient);
  const far = c.xs.reduce((best, xi, i) => (Math.abs(xi - x) > Math.abs(c.xs[best] - x) ? i : best), 0);
  assert.ok(
    Math.abs(c.ys[far] - before[far]) < 0.01 * Math.max(before[far], 1.0),
    'knots a long way off in log-lux stay put',
  );

  // Repeated corrections converge rather than oscillate.
  for (let i = 0; i < 40; i++) learn(c, ambient, desired);
  assert.ok(Math.abs(c.valueAt(ambient) - desired) < 0.01 * desired);

  assert.ok(c.ys.every((y) => y >= 0), 'never negative');
});

test('config round-trips through JSON', () => {
  const cfg = withDefaults({});
  cfg.calibrations['Dell|ABC123'] = syntheticCal().toJSON();
  cfg.gains['Dell|ABC123'] = 1.2;

  const restored = withDefaults(JSON.parse(JSON.stringify(cfg)));
  const cal = calibrationOf(restored, 'Dell|ABC123');
  assert.ok(cal && cal.valid);
  assert.equal(calibrationOf(restored, 'nope'), null, 'uncalibrated display stays untouched');

  const short = withDefaults({ calibrations: { bad: { brightLux: [1.0, 2.0] } } });
  assert.equal(calibrationOf(short, 'bad'), null, 'a truncated sweep is not a calibration');

  assert.ok(
    Math.abs(
      targetFor(restored, curveOf(restored), 100.0, 'Dell|ABC123') -
        curveOf(restored).valueAt(100.0) * 1.2,
    ) < 1e-9,
  );

  // Unknown keys from an older/newer build must not land in the config.
  assert.equal('bogus' in withDefaults({ bogus: 1 }), false);
});

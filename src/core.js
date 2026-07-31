// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Tath Sikdar

/**
 * Pure logic for open-lux: lux math, the response curve, per-display
 * calibration tables and the learning rule.
 *
 * No imports at all -- not electron, not node. That is what lets the main
 * process and the renderer load the same file (one via `import`, one via
 * <script type="module">) and lets test/core.test.js run it under bare node.
 *
 * Everything downstream of the Arduino is expressed in *lux at the sensor*, so
 * ambient readings, calibration tables and the curve all share one unit.
 */

// --- fixed shapes -----------------------------------------------------------

export const CONTRAST_STEP = 5; // contrast sweep granularity; must divide 100
export const N_CONTRAST = 100 / CONTRAST_STEP + 1; // 21 samples
export const N_BRIGHT = 101; // one per brightness %

export const LUX_MIN = 0.1;
export const LUX_MAX = 10000.0; // curve x-axis, in decades
export const N_POINTS = 12; // curve control points

// --- interpolation helpers --------------------------------------------------

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Leftmost index where `x` could be inserted into ascending `arr`. */
export function bisectLeft(arr, x) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Linear interpolation over ascending `xs`, clamped at both ends. */
export function interp(xs, ys, x) {
  if (x <= xs[0]) return ys[0];
  if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
  const i = bisectLeft(xs, x);
  const x0 = xs[i - 1];
  const x1 = xs[i];
  if (x1 === x0) return ys[i];
  return ys[i - 1] + ((x - x0) / (x1 - x0)) * (ys[i] - ys[i - 1]);
}

/** Value of `vals` at a fractional index. */
export function interpAtIndex(vals, idx) {
  idx = clamp(idx, 0.0, vals.length - 1.0);
  const i = Math.floor(idx);
  if (i >= vals.length - 1) return vals[vals.length - 1];
  return vals[i] + (idx - i) * (vals[i + 1] - vals[i]);
}

/** Fractional index where non-decreasing `vals` reaches `target`. */
export function invertIndex(vals, target) {
  if (target <= vals[0]) return 0.0;
  if (target >= vals[vals.length - 1]) return vals.length - 1;
  const i = bisectLeft(vals, target);
  const lo = vals[i - 1];
  const hi = vals[i];
  const frac = hi === lo ? 0.0 : (target - lo) / (hi - lo);
  return i - 1 + frac;
}

/** Cumulative-max pass. Real sweeps wobble, and inversion needs order. */
export function monotonic(vals) {
  const out = [];
  let run = -Infinity;
  for (const v of vals) {
    run = Math.max(run, v);
    out.push(run);
  }
  return out;
}

// --- LDR -> lux -------------------------------------------------------------

/**
 * Raw 10-bit ADC reading to approximate lux.
 *
 * Divider gives the LDR resistance, then the usual LDR power law
 * R = R10 * (lux/10) ** -gamma inverted for lux.
 *
 * The constants are knobs, not truths: a real GL5506 strays a long way from
 * its datasheet, and the absolute scale never has to be right -- calibration
 * tables and the curve are measured in these same units.
 */
export function adcToLux(adc, rFixed = 5100.0, r10 = 5000.0, gamma = 0.7, ldrToVcc = true) {
  adc = clamp(Number(adc), 1.0, 1022.0); // the rails would divide by zero
  const ratio = (1023.0 - adc) / adc;
  let rLdr = ldrToVcc ? rFixed * ratio : rFixed / ratio;
  rLdr = Math.max(rLdr, 1e-6);
  return 10.0 ** ((Math.log10(r10) - Math.log10(rLdr)) / gamma) * 10.0;
}

// --- response curve ---------------------------------------------------------

/** Log-linear ramp from `lo` to `hi` target lux across the ambient range. */
export function defaultYs(lo = 5.0, hi = 250.0) {
  return Array.from({ length: N_POINTS }, (_, i) => lo * (hi / lo) ** (i / (N_POINTS - 1)));
}

/**
 * Ambient lux -> target screen luminance, as N_POINTS draggable knots spaced
 * evenly in log10(lux).
 */
export class Curve {
  constructor(ys = null) {
    const x0 = Math.log10(LUX_MIN);
    const x1 = Math.log10(LUX_MAX);
    this.xs = Array.from({ length: N_POINTS }, (_, i) => x0 + ((x1 - x0) * i) / (N_POINTS - 1));
    this.ys = ys ? [...ys] : defaultYs();
  }

  valueAt(lux) {
    return interp(this.xs, this.ys, Math.log10(Math.max(lux, 1e-6)));
  }

  luxAtKnot(i) {
    return 10.0 ** this.xs[i];
  }
}

/**
 * Nudge the curve toward `desiredLux` at `ambientLux`.
 *
 * Gaussian kernel in log-lux, so a correction made in a dim room does not
 * drag the daylight end with it. sigma is in decades.
 */
export function learn(curve, ambientLux, desiredLux, alpha = 0.25, sigma = 0.35) {
  const x = Math.log10(Math.max(ambientLux, 1e-6));
  const err = desiredLux - curve.valueAt(ambientLux);
  curve.xs.forEach((xi, i) => {
    const w = Math.exp(-(((x - xi) / sigma) ** 2));
    curve.ys[i] = Math.max(0.0, curve.ys[i] + alpha * w * err);
  });
}

// --- per-display calibration ------------------------------------------------

/**
 * What one display actually emits, measured with the LDR against it.
 *
 * brightLux[b]   -- lux at brightness b%, contrast fixed at calContrast
 * contrastLux[i] -- lux at brightness 0, contrast i*CONTRAST_STEP%
 * Both already have the room's baseline subtracted.
 */
export class Calibration {
  constructor({ brightLux = [], contrastLux = [], calContrast = 50, ambientOffset = 0.0 } = {}) {
    this.brightLux = brightLux;
    this.contrastLux = contrastLux;
    this.calContrast = calContrast;
    this.ambientOffset = ambientOffset;
  }

  get valid() {
    return this.brightLux.length === N_BRIGHT;
  }

  brightMono() {
    return monotonic(this.brightLux);
  }

  contrastMono() {
    return monotonic(this.contrastLux);
  }

  /** Dimmest the panel goes on brightness alone. */
  get minLux() {
    return this.brightMono()[0];
  }

  get maxLux() {
    const b = this.brightMono();
    return b[b.length - 1];
  }

  /**
   * Measured output for a given setting -- used to turn a manual slider
   * position back into a target luminance for learning.
   */
  luxAt(brightness, contrast = null) {
    if (brightness > 0 || this.contrastLux.length !== N_CONTRAST) {
      return this.brightMono()[Math.trunc(clamp(brightness, 0, 100))];
    }
    if (contrast === null) contrast = this.calContrast;
    return interpAtIndex(this.contrastMono(), contrast / CONTRAST_STEP);
  }

  /** Target luminance -> [brightness %, contrast %] for this panel. */
  solve(targetLux, extradim = false, minContrast = 50) {
    const b = this.brightMono();
    if (targetLux >= b[0]) {
      return [Math.round(invertIndex(b, targetLux)), this.calContrast];
    }

    // Below what brightness alone can reach.
    if (!extradim || this.contrastLux.length !== N_CONTRAST) {
      return [0, this.calContrast];
    }

    const pct = invertIndex(this.contrastMono(), targetLux) * CONTRAST_STEP;
    return [0, Math.round(clamp(pct, minContrast, this.calContrast))];
  }

  /**
   * Dimmest reachable luminance once contrast is allowed down to
   * `minContrast`. Drives the ExtraDim tail on the graph.
   */
  extradimFloor(minContrast) {
    if (this.contrastLux.length !== N_CONTRAST) return this.minLux;
    return interpAtIndex(this.contrastMono(), minContrast / CONTRAST_STEP);
  }

  toJSON() {
    return {
      brightLux: this.brightLux,
      contrastLux: this.contrastLux,
      calContrast: this.calContrast,
      ambientOffset: this.ambientOffset,
    };
  }

  static from(d) {
    if (!d) return null;
    return new Calibration({
      brightLux: [...(d.brightLux ?? [])],
      contrastLux: [...(d.contrastLux ?? [])],
      calContrast: Number(d.calContrast ?? 50),
      ambientOffset: Number(d.ambientOffset ?? 0.0),
    });
  }
}

// --- config -----------------------------------------------------------------

/** Defaults for every persisted setting. main.js owns reading/writing the file. */
export const DEFAULTS = {
  // response
  curveYs: defaultYs(),
  calibrations: {}, // display key -> plain object
  gains: {}, // display key -> learned scalar

  // LDR constants (see adcToLux)
  rFixed: 5100.0,
  r10: 5000.0,
  gamma: 0.7,
  ldrToVcc: true,
  ema: 0.3, // ambient smoothing, 1.0 = no smoothing

  // learning
  autoLearn: true,
  learnAveraged: true,
  alpha: 0.25,
  sigma: 0.35,

  // behaviour
  singleKnob: true,
  extradim: false,
  minContrast: 30,
  calContrast: 50,
  serialPort: '',
  startMinimized: false,

  // appearance
  theme: 'system', // "system" | "light" | "dark"
  compact: false,
  winW: 880,
  winH: 720,
};

/** Merge a loaded object over the defaults, dropping keys we do not know. */
export function withDefaults(data) {
  const cfg = structuredClone(DEFAULTS);
  for (const [k, v] of Object.entries(data ?? {})) {
    if (k in cfg && v !== null && v !== undefined) cfg[k] = v;
  }
  return cfg;
}

export function curveOf(cfg) {
  const ys = cfg.curveYs?.length === N_POINTS ? cfg.curveYs : defaultYs();
  return new Curve(ys);
}

export function calibrationOf(cfg, key) {
  const cal = Calibration.from(cfg.calibrations[key]);
  return cal && cal.valid ? cal : null;
}

export function targetFor(cfg, curve, ambientLux, key) {
  return curve.valueAt(ambientLux) * (cfg.gains[key] ?? 1.0);
}

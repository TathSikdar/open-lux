// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Tath Sikdar

/**
 * The control loop: ambient reading in, brightness/contrast out.
 *
 * In the Qt build this lived inside MainWindow, which meant the override and
 * learning rules could only be tested by standing up a real window. Here it is
 * a plain object that takes a `submit` callback, so main.js hands it the real
 * DDC writer and test/calibration.test.js hands it an array.
 */

import { adcToLux, calibrationOf, curveOf, learn, targetFor } from './core.js';

// How far the ambient has to move (in decades) before automatic control takes
// back over from a manual slider nudge.
export const OVERRIDE_RELEASE = 0.08;

export class Controller {
  /**
   * @param {object} cfg      the live config object (mutated in place)
   * @param {function} submit (displayIndex, brightness, contrast) => void
   * @param {function} onSave called when cfg has changed and should be persisted
   */
  constructor(cfg, submit, onSave = () => {}) {
    this.cfg = cfg;
    this.submit = submit;
    this.onSave = onSave;

    this.curve = curveOf(cfg);
    this.displays = []; // [{ index, key, name }]
    this.rawLux = 0.0;
    this.ambientLux = null;
    this.readingSeq = 0;
    this.calibrating = false;
    this.autoEnabled = true;
    this.lastLevels = {}; // key -> brightness %
    this.lastContrast = {}; // key -> contrast %; below calContrast means ExtraDim is doing the work
    this.override = new Map(); // key -> { pct, atLux }
  }

  // --- the loop ------------------------------------------------------------

  onReading(adc) {
    const { rFixed, r10, gamma, ldrToVcc, ema } = this.cfg;
    this.rawLux = adcToLux(adc, rFixed, r10, gamma, ldrToVcc);
    this.readingSeq += 1;
    this.ambientLux =
      this.ambientLux === null
        ? this.rawLux
        : this.ambientLux * (1 - ema) + this.rawLux * ema;
    return this.applyNow();
  }

  applyNow() {
    if (this.ambientLux === null || this.calibrating || !this.autoEnabled) return null;
    const levels = {};
    const contrasts = {};
    for (const d of this.displays) {
      const cal = calibrationOf(this.cfg, d.key);
      if (!cal) continue; // never touch a display we have not measured

      const held = this.overrideFor(d.key);
      let pct, contrast;
      if (held === null) {
        const target = targetFor(this.cfg, this.curve, this.ambientLux, d.key);
        [pct, contrast] = cal.solve(target, this.cfg.extradim, this.cfg.minContrast);
      } else {
        pct = held.pct;
        // A contrast set by hand is the whole point of the ExtraDim slider, so
        // it stands; one is only derived when the user did not pick it.
        contrast =
          held.contrast ??
          cal.solve(cal.luxAt(pct), this.cfg.extradim, this.cfg.minContrast)[1];
      }
      levels[d.key] = pct;
      contrasts[d.key] = contrast;
      this.submit(d.index, pct, contrast);
    }
    this.lastLevels = levels;
    this.lastContrast = contrasts;
    return levels;
  }

  /** @return {?number} */
  overridePct(key) {
    return this.overrideFor(key)?.pct ?? null;
  }

  /**
   * A manual nudge holds until the room's light actually changes.
   * @return {?{pct: number, atLux: number, contrast: ?number}}
   */
  overrideFor(key) {
    const entry = this.override.get(key) ?? this.override.get('all');
    if (!entry) return null;
    const moved = Math.abs(
      Math.log10(Math.max(this.ambientLux, 1e-6)) - Math.log10(Math.max(entry.atLux, 1e-6)),
    );
    if (moved > OVERRIDE_RELEASE) {
      this.override.clear();
      return null;
    }
    return entry;
  }

  // --- manual + learning ---------------------------------------------------

  /**
   * @param {string} key
   * @param {number} pct brightness
   * @param {?number=} contrast set by hand, or null to derive one from `pct`
   */
  manualPreview(key, pct, contrast = null) {
    for (const d of this.targets(key)) {
      const cal = calibrationOf(this.cfg, d.key);
      if (!cal) continue;
      const c =
        contrast ?? cal.solve(cal.luxAt(pct), this.cfg.extradim, this.cfg.minContrast)[1];
      this.submit(d.index, pct, c);
    }
  }

  /** @param {?number=} contrast see manualPreview. */
  manualCommit(key, pct, contrast = null) {
    if (this.ambientLux === null) return;
    this.override.set(key, { pct, atLux: this.ambientLux, contrast });

    // luxAt already reads the contrast table when brightness is 0, so a nudge
    // made on the contrast slider teaches the curve exactly as one made on the
    // brightness slider does.
    const wanted = new Map();
    for (const d of this.targets(key)) {
      const cal = calibrationOf(this.cfg, d.key);
      if (cal) wanted.set(d.key, cal.luxAt(pct, contrast));
    }
    if (!wanted.size || !this.cfg.autoLearn) return;

    if (this.cfg.singleKnob || this.cfg.learnAveraged) {
      const mean = [...wanted.values()].reduce((a, b) => a + b, 0) / wanted.size;
      learn(this.curve, this.ambientLux, mean, this.cfg.alpha, this.cfg.sigma);
      this.cfg.curveYs = [...this.curve.ys];
    } else {
      // Per-display: keep one shared curve shape and learn a scale for this
      // panel, so Settings still shows a single graph.
      const base = this.curve.valueAt(this.ambientLux);
      if (base > 0) {
        for (const [dkey, want] of wanted) {
          const old = this.cfg.gains[dkey] ?? 1.0;
          this.cfg.gains[dkey] = old + this.cfg.alpha * (want / base - old);
        }
      }
    }
    this.onSave();
  }

  targets(key) {
    if (key === 'all') return this.displays.filter((d) => calibrationOf(this.cfg, d.key));
    return this.displays.filter((d) => d.key === key);
  }
}

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
    for (const d of this.displays) {
      const cal = calibrationOf(this.cfg, d.key);
      if (!cal) continue; // never touch a display we have not measured

      const held = this.overridePct(d.key);
      let pct, contrast;
      if (held === null) {
        const target = targetFor(this.cfg, this.curve, this.ambientLux, d.key);
        [pct, contrast] = cal.solve(target, this.cfg.extradim, this.cfg.minContrast);
      } else {
        pct = held;
        [, contrast] = cal.solve(cal.luxAt(pct), this.cfg.extradim, this.cfg.minContrast);
      }
      levels[d.key] = pct;
      this.submit(d.index, pct, contrast);
    }
    this.lastLevels = levels;
    return levels;
  }

  /** A manual nudge holds until the room's light actually changes. */
  overridePct(key) {
    const entry = this.override.get(key) ?? this.override.get('all');
    if (!entry) return null;
    const moved = Math.abs(
      Math.log10(Math.max(this.ambientLux, 1e-6)) - Math.log10(Math.max(entry.atLux, 1e-6)),
    );
    if (moved > OVERRIDE_RELEASE) {
      this.override.clear();
      return null;
    }
    return entry.pct;
  }

  // --- manual + learning ---------------------------------------------------

  manualPreview(key, pct) {
    for (const d of this.targets(key)) {
      const cal = calibrationOf(this.cfg, d.key);
      if (!cal) continue;
      const [, contrast] = cal.solve(cal.luxAt(pct), this.cfg.extradim, this.cfg.minContrast);
      this.submit(d.index, pct, contrast);
    }
  }

  manualCommit(key, pct) {
    if (this.ambientLux === null) return;
    this.override.set(key, { pct, atLux: this.ambientLux });

    const wanted = new Map();
    for (const d of this.targets(key)) {
      const cal = calibrationOf(this.cfg, d.key);
      if (cal) wanted.set(d.key, cal.luxAt(pct));
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

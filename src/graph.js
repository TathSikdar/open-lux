// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Tath Sikdar

/**
 * The response graph: ambient lux (log) against target screen luminance.
 *
 * Hand-painted rather than charted, for the same reason as the Qt build: a
 * charting library would still not give drag-to-edit knots or a two-tone
 * curve, so it would be a dependency that bought nothing.
 *
 * Colours are read from CSS custom properties at paint time, so a theme switch
 * is nothing more than a repaint -- and the palette itself lives entirely in
 * style.css rather than in a parallel dict here.
 */

import { LUX_MAX, LUX_MIN } from './core.js';

const MARGIN_L = 46;
const MARGIN_R = 12;
const MARGIN_T = 12;
const MARGIN_B = 26;
const GRAB_PX = 14;

/**
 * Enough decimals to tell one gridline from the next. The axis spans anything
 * from 2 lux (ExtraDim, zoomed) to 300 (the full response curve).
 * @param {number} val
 * @param {number} span the axis maximum
 * @return {string}
 */
function axisLabel(val, span) {
  return val.toFixed(span >= 100 ? 0 : span >= 10 ? 1 : 2);
}

export class CurveGraph {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas, curve, { editable = false, onChange = () => {} } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.curve = curve;
    this.editable = editable;
    this.onChange = onChange;

    this.yMax = 300.0;
    this.floor = 0.0; // dimmest reachable once ExtraDim is allowed in
    this.extradimFrom = 0.0; // below this, contrast has to take over
    this.ambient = null;
    this.drag = null;

    new ResizeObserver(() => this.draw()).observe(canvas);
    if (editable) this._wireDrag();
  }

  // --- inputs --------------------------------------------------------------

  setCurve(curve) {
    this.curve = curve;
    this.draw();
  }

  /** extradimFrom: the display's brightness-0 output. floor: the dimmest it
   *  reaches once contrast is allowed down to the user's minimum. */
  setLimits(extradimFrom, floor, yMax = null) {
    this.extradimFrom = extradimFrom;
    this.floor = floor;
    // No lower bound on the scale: the ExtraDim preview zooms to a handful of
    // lux, and clamping the axis to 50 flattened that whole page into one line.
    if (yMax > 0) this.yMax = yMax;
    this.draw();
  }

  setAmbient(lux) {
    this.ambient = lux;
    this.draw();
  }

  // --- coordinates ---------------------------------------------------------

  get _r() {
    const { width: w, height: h } = this.canvas.getBoundingClientRect();
    return {
      left: MARGIN_L,
      top: MARGIN_T,
      width: Math.max(1, w - MARGIN_L - MARGIN_R),
      height: Math.max(1, h - MARGIN_T - MARGIN_B),
      right: w - MARGIN_R,
      bottom: h - MARGIN_B,
    };
  }

  _px(lux) {
    const r = this._r;
    const lo = Math.log10(LUX_MIN);
    const hi = Math.log10(LUX_MAX);
    return r.left + ((Math.log10(Math.max(lux, LUX_MIN)) - lo) / (hi - lo)) * r.width;
  }

  _py(val) {
    const r = this._r;
    return r.bottom - Math.min(val / this.yMax, 1.0) * r.height;
  }

  _val(y) {
    const r = this._r;
    return Math.max(0, Math.min(1, (r.bottom - y) / r.height)) * this.yMax;
  }

  _c(name) {
    return getComputedStyle(this.canvas).getPropertyValue(`--${name}`).trim();
  }

  // --- painting ------------------------------------------------------------

  draw() {
    const { width: cssW, height: cssH } = this.canvas.getBoundingClientRect();
    if (!cssW || !cssH) return;

    // Back the canvas at device resolution or every 1px line comes out fuzzy.
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);

    const g = this.ctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cssW, cssH);
    g.fillStyle = this._c('graph-bg');
    g.fillRect(0, 0, cssW, cssH);

    const r = this._r;
    this._grid(g, r);
    this._curve(g, r);
    if (this.ambient) this._now(g, r);
    if (this.editable) this._knots(g);
  }

  _grid(g, r) {
    const grid = this._c('grid');
    const axis = this._c('axis');
    g.font = '10px system-ui, sans-serif';

    for (let d = Math.log10(LUX_MIN); d <= Math.log10(LUX_MAX) + 0.5; d++) {
      const decade = Math.round(d);
      const lux = 10 ** decade;
      const x = Math.round(this._px(lux)) + 0.5; // half-pixel: a crisp 1px line
      g.strokeStyle = grid;
      g.lineWidth = 1;
      g.setLineDash([]);
      g.beginPath();
      g.moveTo(x, r.top);
      g.lineTo(x, r.bottom);
      g.stroke();

      g.fillStyle = axis;
      g.textAlign = 'center';
      g.textBaseline = 'top';
      g.fillText(lux < 1000 ? `${lux}` : `${lux / 1000}k`, x, r.bottom + 6);
    }

    for (let i = 0; i < 5; i++) {
      const val = (this.yMax * i) / 4;
      const y = Math.round(this._py(val)) + 0.5;
      g.strokeStyle = grid;
      g.beginPath();
      g.moveTo(r.left, y);
      g.lineTo(r.right, y);
      g.stroke();

      g.fillStyle = axis;
      g.textAlign = 'right';
      g.textBaseline = 'middle';
      g.fillText(axisLabel(val, this.yMax), MARGIN_L - 6, y);
    }

    g.fillStyle = axis;
    g.textBaseline = 'top';
    g.textAlign = 'left';
    g.fillText('target lux', r.left + 6, r.top + 2);
    g.textAlign = 'right';
    g.fillText('ambient lux', r.right - 6, r.top + 2);
  }

  /** Two passes: what the curve asks for (ghosted where unreachable), and what
   *  the panel will actually be driven to. */
  _curve(g, r) {
    const steps = 220;
    const lo = Math.log10(LUX_MIN);
    const hi = Math.log10(LUX_MAX);
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const lux = 10 ** (lo + ((hi - lo) * i) / steps);
      const want = this.curve.valueAt(lux);
      const x = r.left + (r.width * i) / steps;
      pts.push({ x, wanted: this._py(want), driven: this._py(Math.max(want, this.floor)), want });
    }

    g.strokeStyle = this._c('ghost');
    g.lineWidth = 1;
    g.setLineDash([4, 4]);
    g.beginPath();
    pts.forEach((p, i) => (i ? g.lineTo(p.x, p.wanted) : g.moveTo(p.x, p.wanted)));
    g.stroke();
    g.setLineDash([]);

    // Segment by segment, so the ExtraDim stretch is simply a different colour.
    const extra = this._c('extra');
    const line = this._c('accent');
    g.lineWidth = 2.4;
    g.lineJoin = 'round';
    for (let i = 1; i < pts.length; i++) {
      g.strokeStyle = pts[i].want < this.extradimFrom ? extra : line;
      g.beginPath();
      g.moveTo(pts[i - 1].x, pts[i - 1].driven);
      g.lineTo(pts[i].x, pts[i].driven);
      g.stroke();
    }

    if (this.extradimFrom > 0) {
      const y = Math.round(this._py(this.extradimFrom)) + 0.5;
      g.strokeStyle = this._c('extra-dim');
      g.lineWidth = 1;
      g.setLineDash([2, 3]);
      g.beginPath();
      g.moveTo(r.left, y);
      g.lineTo(r.right, y);
      g.stroke();
      g.setLineDash([]);
    }
  }

  _now(g, r) {
    const x = Math.round(this._px(this.ambient)) + 0.5;
    g.strokeStyle = this._c('now-dim');
    g.lineWidth = 1;
    g.setLineDash([4, 4]);
    g.beginPath();
    g.moveTo(x, r.top);
    g.lineTo(x, r.bottom);
    g.stroke();
    g.setLineDash([]);

    g.fillStyle = this._c('now');
    g.beginPath();
    g.arc(x, this._py(Math.max(this.curve.valueAt(this.ambient), this.floor)), 4, 0, Math.PI * 2);
    g.fill();
  }

  _knots(g) {
    g.fillStyle = this._c('knot');
    g.strokeStyle = this._c('graph-bg');
    g.lineWidth = 1.5;
    this.curve.ys.forEach((y, i) => {
      g.beginPath();
      g.arc(this._px(this.curve.luxAtKnot(i)), this._py(y), 4.5, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    });
  }

  // --- dragging ------------------------------------------------------------

  _nearest(x, y) {
    let best = null;
    let bestD = GRAB_PX;
    this.curve.ys.forEach((cy, i) => {
      const d = Math.hypot(x - this._px(this.curve.luxAtKnot(i)), y - this._py(cy));
      if (d < bestD) {
        best = i;
        bestD = d;
      }
    });
    return best;
  }

  _at(e) {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  _wireDrag() {
    const c = this.canvas;

    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const knot = this._nearest(...this._at(e));
      if (knot === null) return;
      this.drag = knot;
      c.setPointerCapture(e.pointerId); // keep tracking outside the canvas
    });

    c.addEventListener('pointermove', (e) => {
      const [x, y] = this._at(e);
      if (this.drag === null) {
        c.style.cursor = this._nearest(x, y) === null ? 'default' : 'pointer';
        return;
      }
      this.curve.ys[this.drag] = this._val(y);
      this.onChange();
      this.draw();
    });

    const release = (e) => {
      if (this.drag === null) return;
      this.drag = null;
      c.releasePointerCapture?.(e.pointerId);
    };
    c.addEventListener('pointerup', release);
    c.addEventListener('pointercancel', release);
  }
}

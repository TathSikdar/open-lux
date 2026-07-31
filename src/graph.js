// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Tath Sikdar

/**
 * The response graph: ambient lux (log) against display lux (linear).
 *
 * Hand-painted rather than charted, for the same reason as the Qt build: a
 * charting library would still not give drag-to-edit knots or a two-tone
 * curve, so it would be a dependency that bought nothing.
 *
 * Colours are read from CSS custom properties at paint time, so a theme switch
 * is nothing more than a repaint -- and the palette itself lives entirely in
 * style.css rather than in a parallel dict here.
 */

import { LUX_MAX, LUX_MIN, clamp, formatLux } from './core.js';

const MARGIN_L = 46;
const MARGIN_R = 12;
const MARGIN_T = 10;
const MARGIN_B = 42; // two rows: the decade labels, then the axis name
const GRAB_PX = 14;

/**
 * Enough decimals to tell one gridline from the next, and no more: the axis
 * top is a measured panel maximum, so quarters of it are rarely round.
 * @param {number} val
 * @param {number} span the axis maximum
 * @return {string}
 */
function axisLabel(val, span) {
  return String(Number(val.toFixed(span >= 100 ? 0 : span >= 10 ? 1 : 2)));
}

export class CurveGraph {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas, curve, { editable = false, onChange = () => {} } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.curve = curve;
    this.editable = editable;
    this.onChange = onChange;

    this.yMax = 300.0; // stand-in scale until a panel has been measured
    this.ceiling = 0.0; // brightest the panels reach; 0 until one is calibrated
    this.floor = 0.0; // dimmest reachable once ExtraDim is allowed in
    this.extradimFrom = 0.0; // below this, contrast has to take over
    this.gain = 1.0; // this display's learned scale on the shared curve
    this.ambient = null;
    this.drag = null;
    this.hover = null; // knot under the pointer, for the coordinate readout

    new ResizeObserver(() => this.draw()).observe(canvas);
    if (editable) this._wireDrag();
  }

  // --- inputs --------------------------------------------------------------

  setCurve(curve) {
    this.curve = curve;
    this.draw();
  }

  /** extradimFrom: the display's brightness-0 output. floor: the dimmest it
   *  reaches once contrast is allowed down to the user's minimum. ceiling: the
   *  brightest, which is also the top of the axis -- the plot then covers
   *  exactly what the panel can do and nothing else. */
  setLimits(extradimFrom, floor, ceiling = null) {
    this.extradimFrom = extradimFrom;
    this.floor = floor;
    this.ceiling = ceiling > 0 ? ceiling : 0;
    if (this.ceiling) this.yMax = this.ceiling;
    this.draw();
  }

  setAmbient(lux) {
    this.ambient = lux;
    this.draw();
  }

  /** Per-display learning scales one shared curve, so each display's graph is
   *  the same knots drawn through its own gain -- and dragging divides it back
   *  out, which is what keeps every graph on the page in agreement. */
  setGain(gain) {
    this.gain = gain || 1.0;
    this.draw();
  }

  /** What this display is actually asked for at `lux`. */
  _want(lux) {
    return this.curve.valueAt(lux) * this.gain;
  }

  /** What it will actually be driven to: the ask, held between the dimmest and
   *  brightest the panel can manage. */
  _drive(want) {
    return clamp(want, this.floor, this.ceiling || Infinity);
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
    return r.bottom - clamp(val / this.yMax, 0, 1) * r.height;
  }

  _val(y) {
    const r = this._r;
    return clamp((r.bottom - y) / r.height, 0, 1) * this.yMax;
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
    this._labels(g, r);
    this._tip(g, r);
  }

  _grid(g, r) {
    const grid = this._c('grid');
    const axis = this._c('axis');
    g.font = '10px system-ui, sans-serif';

    // The decades, plus the axis maximum when it is not one itself: an
    // unlabelled right edge leaves the reader guessing where the axis stops.
    const ticks = [];
    for (let d = Math.log10(LUX_MIN); d <= Math.log10(LUX_MAX) + 1e-9; d++) {
      ticks.push(10 ** Math.round(d));
    }
    if (ticks.at(-1) !== LUX_MAX) ticks.push(LUX_MAX);

    for (const lux of ticks) {
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

    const top = this.yMax;
    for (let i = 0; i <= 4; i++) {
      const val = (top * i) / 4;
      const y = Math.round(this._py(val)) + 0.5;
      g.strokeStyle = grid;
      g.beginPath();
      g.moveTo(r.left, y);
      g.lineTo(r.right, y);
      g.stroke();

      g.fillStyle = axis;
      g.textAlign = 'right';
      g.textBaseline = 'middle';
      g.fillText(axisLabel(val, top), MARGIN_L - 6, y);
    }
  }

  /**
   * The two axis names, each centred on the axis it belongs to and both
   * outside the plot: x under the decade labels, y turned on its side up the
   * left edge. Inside the plot the y label ended up under the ExtraDim band,
   * which is exactly where it was least readable.
   */
  _labels(g, r) {
    g.fillStyle = this._c('axis');
    g.font = '10px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'top';
    g.fillText('ambient lux', r.left + r.width / 2, r.bottom + 20);

    g.save();
    g.translate(8, r.top + r.height / 2);
    g.rotate(-Math.PI / 2);
    g.textBaseline = 'middle';
    g.fillText('display lux', 0, 0);
    g.restore();
  }

  /**
   * The coordinate of the knot under the pointer, or of the one being dragged.
   * Read off the knot rather than off the pointer, so it is the value that was
   * actually stored and not wherever the cursor happened to be.
   */
  _tip(g, r) {
    const i = this.drag ?? this.hover;
    if (i === null) return;

    const lux = this.curve.luxAtKnot(i);
    const val = this.curve.ys[i] * this.gain;
    const text = `${formatLux(lux)} lux → ${formatLux(val)} lux`;

    g.font = '10px system-ui, sans-serif';
    const w = g.measureText(text).width + 10;
    // Kept inside the plot: the first and last knots sit on its edges.
    const x = clamp(this._px(lux) + 8, r.left, Math.max(r.left, r.right - w));
    const y = clamp(this._py(val) - 22, r.top, r.bottom - 16);

    g.fillStyle = this._c('graph-bg');
    g.globalAlpha = 0.92;
    g.fillRect(x, y, w, 16);
    g.globalAlpha = 1;
    g.strokeStyle = this._c('grid');
    g.lineWidth = 1;
    g.strokeRect(x + 0.5, y + 0.5, w - 1, 15);

    g.fillStyle = this._c('knot');
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.fillText(text, x + 5, y + 8);
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
      const want = this._want(lux);
      const x = r.left + (r.width * i) / steps;
      pts.push({ x, lux, wanted: this._py(want), driven: this._py(this._drive(want)), want });
    }

    // Where the curve asks for more or less light than the panel can give:
    // shaded, because *where* it runs out at either end is the question this
    // page exists to answer, and a recoloured line alone was too thin to read.
    const dim = (p) => this.extradimFrom > 0 && p.want < this.extradimFrom;
    const full = (p) => this.ceiling > 0 && p.want > this.ceiling;
    this._band(g, r, pts, dim, 'extra');
    this._band(g, r, pts, full, 'full');

    g.strokeStyle = this._c('ghost');
    g.lineWidth = 1;
    g.setLineDash([4, 4]);
    g.beginPath();
    pts.forEach((p, i) => (i ? g.lineTo(p.x, p.wanted) : g.moveTo(p.x, p.wanted)));
    g.stroke();
    g.setLineDash([]);

    // Segment by segment, so each stretch the panel cannot follow is simply a
    // different colour.
    const extra = this._c('extra');
    const atFull = this._c('full');
    const line = this._c('accent');
    g.lineWidth = 2.4;
    g.lineJoin = 'round';
    for (let i = 1; i < pts.length; i++) {
      g.strokeStyle = dim(pts[i]) ? extra : full(pts[i]) ? atFull : line;
      g.beginPath();
      g.moveTo(pts[i - 1].x, pts[i - 1].driven);
      g.lineTo(pts[i].x, pts[i].driven);
      g.stroke();
    }

    if (this.extradimFrom > 0) {
      this._rule(g, r, this.extradimFrom, 'extra-dim');
      // The last point still under brightness-0: past it, ExtraDim is working.
      this._boundary(g, r, pts, pts.findLastIndex(dim), 'extra', 'ExtraDim below');
    }
    // The ceiling needs no rule of its own -- it *is* the top of the axis.
    if (this.ceiling > 0) {
      this._boundary(g, r, pts, pts.findIndex(full), 'full', 'Max brightness above');
    }
  }

  /** A horizontal dotted line across the plot at one luminance. */
  _rule(g, r, val, colour) {
    const y = Math.round(this._py(val)) + 0.5;
    g.strokeStyle = this._c(colour);
    g.lineWidth = 1;
    g.setLineDash([2, 3]);
    g.beginPath();
    g.moveTo(r.left, y);
    g.lineTo(r.right, y);
    g.stroke();
    g.setLineDash([]);
  }

  /** Shades the ambient range where `test` holds -- the stretch the panel
   *  cannot follow the curve through. */
  _band(g, r, pts, test, colour) {
    g.save();
    g.globalAlpha = 0.16;
    g.fillStyle = this._c(colour);
    for (let i = 1; i < pts.length; i++) {
      // +1: butt the columns together, or the seams show as vertical stripes.
      if (test(pts[i])) g.fillRect(pts[i - 1].x, r.top, pts[i].x - pts[i - 1].x + 1, r.height);
    }
    g.restore();
  }

  /** The vertical line at sampled point `i`, where the curve leaves what the
   *  panel can do: under brightness-0 at the dim end, over full brightness at
   *  the bright end. Read off the sampled points rather than solved for, so a
   *  curve dragged into any shape still gets the line in the right place. */
  _boundary(g, r, pts, i, colour, label) {
    if (i <= 0 || i >= pts.length - 1) return; // never crosses inside the plot

    const x = Math.round(pts[i].x) + 0.5;
    g.strokeStyle = this._c(colour);
    g.lineWidth = 1;
    g.setLineDash([5, 3]);
    g.beginPath();
    g.moveTo(x, r.top);
    g.lineTo(x, r.bottom);
    g.stroke();
    g.setLineDash([]);

    const lux = pts[i].lux;
    g.fillStyle = this._c(colour);
    g.font = '10px system-ui, sans-serif';
    g.textBaseline = 'top';
    // Whichever side of the line has more plot to write on, which puts the dim
    // end's label to its right and the bright end's to its left.
    const left = x - r.left > r.right - x;
    g.textAlign = left ? 'right' : 'left';
    g.fillText(
      `${label} ${lux < 10 ? lux.toFixed(1) : Math.round(lux)} lux`,
      x + (left ? -4 : 4),
      r.top + 2,
    );
  }

  /** Where the room is right now. Takes the colour of whichever stretch it has
   *  landed in, so the live state is visible without reading a number. */
  _now(g, r) {
    const x = Math.round(this._px(this.ambient)) + 0.5;
    const want = this._want(this.ambient);
    const tone =
      this.extradimFrom > 0 && want < this.extradimFrom
        ? 'extra'
        : this.ceiling > 0 && want > this.ceiling
          ? 'full'
          : 'now';

    g.strokeStyle = this._c(`${tone}-dim`);
    g.lineWidth = 1;
    g.setLineDash([4, 4]);
    g.beginPath();
    g.moveTo(x, r.top);
    g.lineTo(x, r.bottom);
    g.stroke();
    g.setLineDash([]);

    g.fillStyle = this._c(tone);
    g.beginPath();
    g.arc(x, this._py(this._drive(want)), 4, 0, Math.PI * 2);
    g.fill();
  }

  _knots(g) {
    g.fillStyle = this._c('knot');
    g.strokeStyle = this._c('graph-bg');
    g.lineWidth = 1.5;
    this.curve.ys.forEach((y, i) => {
      g.beginPath();
      g.arc(this._px(this.curve.luxAtKnot(i)), this._py(y * this.gain), 4.5, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    });
  }

  // --- dragging ------------------------------------------------------------

  _nearest(x, y) {
    let best = null;
    let bestD = GRAB_PX;
    this.curve.ys.forEach((cy, i) => {
      const d = Math.hypot(x - this._px(this.curve.luxAtKnot(i)), y - this._py(cy * this.gain));
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
        const knot = this._nearest(x, y);
        c.style.cursor = knot === null ? 'default' : 'pointer';
        // Only on a change, or every pixel of pointer travel is a repaint.
        if (knot !== this.hover) {
          this.hover = knot;
          this.draw();
        }
        return;
      }
      this.curve.ys[this.drag] = this._val(y) / this.gain;
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

    c.addEventListener('pointerleave', () => {
      if (this.hover === null) return;
      this.hover = null;
      this.draw();
    });
  }
}

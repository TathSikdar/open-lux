# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Tath Sikdar

"""Pure logic for open-lux: lux math, the response curve, per-display
calibration tables and the learning rule.

Deliberately free of Qt imports so test_core.py can exercise every branch
without a display server.

Everything downstream of the Arduino is expressed in *lux at the sensor*, so
ambient readings, calibration tables and the curve all share one unit.
"""

from __future__ import annotations

import json
import math
import os
import sys
from bisect import bisect_left
from dataclasses import dataclass, field
from pathlib import Path

# --- fixed shapes -----------------------------------------------------------

CONTRAST_STEP = 5  # contrast sweep granularity; must divide 100
N_CONTRAST = 100 // CONTRAST_STEP + 1  # 21 samples
N_BRIGHT = 101  # one per brightness %

LUX_MIN, LUX_MAX = 0.1, 10000.0  # curve x-axis, in decades
N_POINTS = 12  # curve control points


# --- interpolation helpers --------------------------------------------------


def clamp(v, lo, hi):
    return lo if v < lo else hi if v > hi else v


def interp(xs, ys, x):
    """Linear interpolation over ascending `xs`, clamped at both ends."""
    if x <= xs[0]:
        return ys[0]
    if x >= xs[-1]:
        return ys[-1]
    i = bisect_left(xs, x)
    x0, x1 = xs[i - 1], xs[i]
    if x1 == x0:
        return ys[i]
    frac = (x - x0) / (x1 - x0)
    return ys[i - 1] + frac * (ys[i] - ys[i - 1])


def interp_at_index(vals, idx):
    """Value of `vals` at a fractional index."""
    idx = clamp(idx, 0.0, len(vals) - 1.0)
    i = int(idx)
    if i >= len(vals) - 1:
        return vals[-1]
    return vals[i] + (idx - i) * (vals[i + 1] - vals[i])


def invert_index(vals, target):
    """Fractional index where non-decreasing `vals` reaches `target`."""
    if target <= vals[0]:
        return 0.0
    if target >= vals[-1]:
        return float(len(vals) - 1)
    i = bisect_left(vals, target)
    lo, hi = vals[i - 1], vals[i]
    frac = 0.0 if hi == lo else (target - lo) / (hi - lo)
    return (i - 1) + frac


def monotonic(vals):
    """Cumulative-max pass. Real sweeps wobble, and inversion needs order."""
    out, run = [], -math.inf
    for v in vals:
        run = max(run, v)
        out.append(run)
    return out


# --- LDR -> lux -------------------------------------------------------------


def adc_to_lux(adc, r_fixed=5100.0, r10=5000.0, gamma=0.7, ldr_to_vcc=True):
    """Raw 10-bit ADC reading to approximate lux.

    Divider gives the LDR resistance, then the usual LDR power law
    R = R10 * (lux/10) ** -gamma inverted for lux.

    The constants are knobs, not truths: a real GL5506 strays a long way from
    its datasheet, and the absolute scale never has to be right -- calibration
    tables and the curve are measured in these same units.
    """
    adc = clamp(float(adc), 1.0, 1022.0)  # the rails would divide by zero
    ratio = (1023.0 - adc) / adc
    r_ldr = r_fixed * ratio if ldr_to_vcc else r_fixed / ratio
    r_ldr = max(r_ldr, 1e-6)
    return 10.0 ** ((math.log10(r10) - math.log10(r_ldr)) / gamma) * 10.0


# --- response curve ---------------------------------------------------------


def default_ys(lo=5.0, hi=250.0):
    """Log-linear ramp from `lo` to `hi` target lux across the ambient range."""
    return [lo * (hi / lo) ** (i / (N_POINTS - 1)) for i in range(N_POINTS)]


class Curve:
    """Ambient lux -> target screen luminance, as N_POINTS draggable knots
    spaced evenly in log10(lux)."""

    def __init__(self, ys=None):
        x0, x1 = math.log10(LUX_MIN), math.log10(LUX_MAX)
        self.xs = [x0 + (x1 - x0) * i / (N_POINTS - 1) for i in range(N_POINTS)]
        self.ys = list(ys) if ys else default_ys()

    def value_at(self, lux):
        return interp(self.xs, self.ys, math.log10(max(lux, 1e-6)))

    def lux_at_knot(self, i):
        return 10.0 ** self.xs[i]


def learn(curve, ambient_lux, desired_lux, alpha=0.25, sigma=0.35):
    """Nudge the curve toward `desired_lux` at `ambient_lux`.

    Gaussian kernel in log-lux, so a correction made in a dim room does not
    drag the daylight end with it. sigma is in decades.
    """
    x = math.log10(max(ambient_lux, 1e-6))
    err = desired_lux - curve.value_at(ambient_lux)
    for i, xi in enumerate(curve.xs):
        w = math.exp(-(((x - xi) / sigma) ** 2))
        curve.ys[i] = max(0.0, curve.ys[i] + alpha * w * err)


# --- per-display calibration ------------------------------------------------


@dataclass
class Calibration:
    """What one display actually emits, measured with the LDR against it.

    bright_lux[b]  -- lux at brightness b%, contrast fixed at cal_contrast
    contrast_lux[i] -- lux at brightness 0, contrast i*CONTRAST_STEP%
    Both already have the room's baseline subtracted.
    """

    bright_lux: list = field(default_factory=list)
    contrast_lux: list = field(default_factory=list)
    cal_contrast: int = 50
    ambient_offset: float = 0.0

    @property
    def valid(self):
        return len(self.bright_lux) == N_BRIGHT

    def bright_mono(self):
        return monotonic(self.bright_lux)

    def contrast_mono(self):
        return monotonic(self.contrast_lux)

    @property
    def min_lux(self):
        """Dimmest the panel goes on brightness alone."""
        return self.bright_mono()[0]

    @property
    def max_lux(self):
        return self.bright_mono()[-1]

    def lux_at(self, brightness, contrast=None):
        """Measured output for a given setting -- used to turn a manual slider
        position back into a target luminance for learning."""
        if brightness > 0 or len(self.contrast_lux) != N_CONTRAST:
            return self.bright_mono()[int(clamp(brightness, 0, 100))]
        if contrast is None:
            contrast = self.cal_contrast
        return interp_at_index(self.contrast_mono(), contrast / CONTRAST_STEP)

    def solve(self, target_lux, extradim=False, min_contrast=50):
        """Target luminance -> (brightness %, contrast %) for this panel."""
        b = self.bright_mono()
        if target_lux >= b[0]:
            return int(round(invert_index(b, target_lux))), self.cal_contrast

        # Below what brightness alone can reach.
        if not extradim or len(self.contrast_lux) != N_CONTRAST:
            return 0, self.cal_contrast

        c = self.contrast_mono()
        pct = invert_index(c, target_lux) * CONTRAST_STEP
        return 0, int(round(clamp(pct, min_contrast, self.cal_contrast)))

    def extradim_floor(self, min_contrast):
        """Dimmest reachable luminance once contrast is allowed down to
        `min_contrast`. Drives the ExtraDim tail on the graph."""
        if len(self.contrast_lux) != N_CONTRAST:
            return self.min_lux
        return interp_at_index(self.contrast_mono(), min_contrast / CONTRAST_STEP)

    def to_dict(self):
        return {
            "bright_lux": self.bright_lux,
            "contrast_lux": self.contrast_lux,
            "cal_contrast": self.cal_contrast,
            "ambient_offset": self.ambient_offset,
        }

    @classmethod
    def from_dict(cls, d):
        return cls(
            bright_lux=list(d.get("bright_lux", [])),
            contrast_lux=list(d.get("contrast_lux", [])),
            cal_contrast=int(d.get("cal_contrast", 50)),
            ambient_offset=float(d.get("ambient_offset", 0.0)),
        )


# --- config -----------------------------------------------------------------


def config_dir():
    if sys.platform == "win32":
        base = os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming"
    else:
        base = os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config"
    return Path(base) / "open-lux"


@dataclass
class Config:
    # response
    curve_ys: list = field(default_factory=default_ys)
    calibrations: dict = field(default_factory=dict)  # display key -> dict
    gains: dict = field(default_factory=dict)  # display key -> learned scalar

    # LDR constants (see adc_to_lux)
    r_fixed: float = 5100.0
    r10: float = 5000.0
    gamma: float = 0.7
    ldr_to_vcc: bool = True
    ema: float = 0.3  # ambient smoothing, 1.0 = no smoothing

    # learning
    auto_learn: bool = True
    learn_averaged: bool = True
    alpha: float = 0.25
    sigma: float = 0.35

    # behaviour
    single_knob: bool = True
    extradim: bool = False
    min_contrast: int = 30
    cal_contrast: int = 50
    serial_port: str = ""
    start_minimized: bool = False

    # appearance
    theme: str = "system"  # "system" | "light" | "dark"
    compact: bool = False
    win_w: int = 880
    win_h: int = 720

    # --- derived -----------------------------------------------------------

    def curve(self):
        ys = self.curve_ys if len(self.curve_ys) == N_POINTS else default_ys()
        return Curve(ys)

    def calibration(self, key):
        d = self.calibrations.get(key)
        if not d:
            return None
        cal = Calibration.from_dict(d)
        return cal if cal.valid else None

    def target_for(self, curve, ambient_lux, key):
        return curve.value_at(ambient_lux) * self.gains.get(key, 1.0)

    # --- persistence -------------------------------------------------------

    @classmethod
    def path(cls):
        return config_dir() / "config.json"

    @classmethod
    def load(cls):
        try:
            data = json.loads(cls.path().read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return cls()
        known = {f for f in cls.__dataclass_fields__}
        return cls(**{k: v for k, v in data.items() if k in known})

    def save(self):
        """Atomic write -- a half-written config would cost the user a 60s
        calibration sweep per display."""
        p = self.path()
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(".tmp")
        payload = {f: getattr(self, f) for f in self.__dataclass_fields__}
        tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        os.replace(tmp, p)

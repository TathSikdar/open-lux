# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Tath Sikdar

"""Checks openlux.core: lux math, the curve, table inversion, learning.

    pytest tests/test_core.py              (or run this file directly)
"""

import math

from openlux.core import (
    N_BRIGHT,
    N_CONTRAST,
    CONTRAST_STEP,
    Calibration,
    Config,
    Curve,
    adc_to_lux,
    invert_index,
    learn,
    monotonic,
)


def synthetic_cal(floor=10.0, top=300.0, cal_contrast=50, min_c_lux=1.0):
    """A well-behaved panel: luminance ramps linearly with brightness, and with
    contrast below it."""
    bright = [floor + (top - floor) * b / 100.0 for b in range(N_BRIGHT)]
    contrast = [
        min_c_lux + (floor - min_c_lux) * (i * CONTRAST_STEP) / cal_contrast
        for i in range(N_CONTRAST)
    ]
    return Calibration(bright, contrast, cal_contrast)


def test_adc_to_lux():
    lo, mid, hi = adc_to_lux(50), adc_to_lux(500), adc_to_lux(900)
    assert lo < mid < hi, "brighter scene must read as more lux"
    assert adc_to_lux(0) > 0 and math.isfinite(adc_to_lux(1023)), "rails must not blow up"

    # At the divider midpoint R_ldr == r_fixed, so lux must land on the value
    # the power law predicts for that resistance.
    adc = 1023 / 2
    expected = 10.0 * (5100.0 / 5000.0) ** (-1 / 0.7)
    assert abs(adc_to_lux(adc) - expected) < 1e-6

    # Wiring flag flips the direction.
    assert adc_to_lux(900, ldr_to_vcc=False) < adc_to_lux(100, ldr_to_vcc=False)


def test_curve():
    c = Curve()
    for i, y in enumerate(c.ys):
        assert abs(c.value_at(c.lux_at_knot(i)) - y) < 1e-9, "exact at the knots"

    mid = c.value_at(10.0 ** ((c.xs[0] + c.xs[1]) / 2))
    assert c.ys[0] < mid < c.ys[1], "interpolates between them"

    assert c.value_at(1e-9) == c.ys[0] and c.value_at(1e9) == c.ys[-1], "clamped"


def test_monotonic_repair():
    assert monotonic([1, 5, 3, 4, 9, 2]) == [1, 5, 5, 5, 9, 9]

    noisy = synthetic_cal()
    noisy.bright_lux[40] = 0.0  # a dropout mid-sweep
    b = noisy.bright_mono()
    assert all(b[i] <= b[i + 1] for i in range(len(b) - 1))


def test_invert_index():
    vals = [0.0, 10.0, 20.0, 30.0]
    assert invert_index(vals, 15.0) == 1.5
    assert invert_index(vals, -5.0) == 0.0, "below range clamps low"
    assert invert_index(vals, 99.0) == 3.0, "above range clamps high"
    assert invert_index([5.0, 5.0, 5.0], 5.0) == 0.0, "plateau picks the first"


def test_solve_brightness():
    cal = synthetic_cal(floor=10.0, top=300.0)
    for pct in (0, 37, 100):
        target = cal.bright_mono()[pct]
        assert cal.solve(target) == (pct, 50)

    assert cal.solve(1e9)[0] == 100, "unreachable target pins at max"


def test_solve_extradim():
    cal = synthetic_cal(floor=10.0, min_c_lux=1.0, cal_contrast=50)
    below = 5.0  # dimmer than brightness 0 can manage

    b, c = cal.solve(below, extradim=False)
    assert (b, c) == (0, 50), "ExtraDim off floors at brightness 0"

    b, c = cal.solve(below, extradim=True, min_contrast=10)
    assert b == 0 and 10 <= c < 50, "contrast takes over below the floor"

    # The minimum is a hard floor, not a suggestion.
    _, c = cal.solve(0.0, extradim=True, min_contrast=30)
    assert c == 30

    # Raising the floor makes the panel dimmer-capable.
    assert cal.extradim_floor(0) < cal.extradim_floor(50)
    assert abs(cal.extradim_floor(50) - cal.min_lux) < 1e-9


def test_lux_at_round_trip():
    cal = synthetic_cal()
    for pct in (0, 25, 100):
        assert cal.solve(cal.lux_at(pct))[0] == pct


def test_learn():
    c = Curve()
    ambient = 100.0
    before = list(c.ys)
    desired = Curve(before).value_at(ambient) * 2

    learn(c, ambient, desired)
    assert Curve(before).value_at(ambient) < c.value_at(ambient) < desired, (
        "moves toward the user, but not the whole way"
    )

    far = max(range(len(c.xs)), key=lambda i: abs(c.xs[i] - math.log10(ambient)))
    assert abs(c.ys[far] - before[far]) < 0.01 * max(before[far], 1.0), (
        "knots a long way off in log-lux stay put"
    )

    # Repeated corrections converge rather than oscillate.
    for _ in range(40):
        learn(c, ambient, desired)
    assert abs(c.value_at(ambient) - desired) < 0.01 * desired

    assert all(y >= 0 for y in c.ys), "never negative"


def test_config_round_trip():
    cfg = Config()
    cfg.calibrations["Dell|ABC123"] = synthetic_cal().to_dict()
    cfg.gains["Dell|ABC123"] = 1.2
    restored = Config(**{f: getattr(cfg, f) for f in Config.__dataclass_fields__})

    cal = restored.calibration("Dell|ABC123")
    assert cal is not None and cal.valid
    assert restored.calibration("nope") is None, "uncalibrated display stays untouched"

    short = Config()
    short.calibrations["bad"] = {"bright_lux": [1.0, 2.0]}
    assert short.calibration("bad") is None, "a truncated sweep is not a calibration"

    assert abs(restored.target_for(restored.curve(), 100.0, "Dell|ABC123")
               - restored.curve().value_at(100.0) * 1.2) < 1e-9


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok  {name}")
    print("\nall core checks passed")

# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Tath Sikdar

"""Checks the calibration sweep and the interactive paths against a simulated
panel, so neither hardware nor a three-minute wait is involved.

    pytest tests/test_calibration.py       (or run this file directly)

On a headless box: QT_QPA_PLATFORM=offscreen
"""

import contextlib
import sys

from PySide6.QtCore import QEventLoop, QPointF, Qt, QTimer
from PySide6.QtGui import QMouseEvent
from PySide6.QtWidgets import QApplication

import openlux.hardware as hw
from openlux.core import N_CONTRAST

ROOM = 40.0  # ambient light reaching the sensor around the LDR


class Panel:
    """An LCD that responds to both VCP controls, leaks light through black,
    and sits in a lit room -- everything the sweep has to see through."""

    def __init__(self):
        self.b, self.c = 75, 75
        self.white = False  # what the calibration square is showing

    def get_luminance(self):
        return self.b

    def set_luminance(self, v):
        self.b = v

    def get_contrast(self):
        return self.c

    def set_contrast(self, v):
        self.c = v

    def lux(self):
        base = 12.0 + 308.0 * (self.b / 100) ** 1.4
        emitted = base * (0.15 + 0.85 * self.c / 100)
        return ROOM + emitted * (1.0 if self.white else 0.04)


def run_sweep(panel):
    @contextlib.contextmanager
    def fake_monitor(_index):
        yield panel

    hw._monitor = fake_monitor

    seq = [0]

    def read_seq():
        seq[0] += 1  # a fresh sample is always waiting
        return seq[0]

    worker = hw.CalibrationWorker(0, 50, panel.lux, read_seq, dwell=0.001)
    out, events = {}, []
    worker.progress.connect(lambda pct, _: events.append(("p", pct)))

    def on_square(white):
        panel.white = white
        events.append(("sq", white))

    worker.square.connect(on_square, Qt.DirectConnection)
    worker.done.connect(lambda cal: out.update(cal=cal))
    worker.failed.connect(lambda m: out.update(err=m))

    loop = QEventLoop()
    worker.finished.connect(loop.quit)
    worker.start()
    QTimer.singleShot(60_000, loop.quit)
    loop.exec()

    assert "err" not in out, out["err"]
    return out["cal"], events


def check_sweep(cal, events, panel):
    assert cal.valid, "the sweep must produce one sample per brightness %"
    assert len(cal.contrast_lux) == N_CONTRAST
    assert panel.b == 75 and panel.c == 75, "the display's own settings must be restored"
    assert events[0] == ("sq", False) and ("sq", True) in events
    assert events[-1] == ("p", 100), "progress must reach the end"

    # The baseline strips the room and the panel's black level, leaving
    # white-minus-black at 50% contrast: 12*0.575 .. 320*0.575.
    assert abs(cal.ambient_offset - ROOM) < 1.0, f"baseline {cal.ambient_offset}"
    assert 5 < cal.min_lux < 9, f"min_lux {cal.min_lux}"
    assert 175 < cal.max_lux < 195, f"max_lux {cal.max_lux}"

    # The measured table has to invert: ask for what 40% emits, get 40% back.
    for pct in (0, 17, 40, 88, 100):
        got, _ = cal.solve(cal.lux_at(pct))
        assert abs(got - pct) <= 1, f"solve({pct}) -> {got}"

    # Contrast must reach below what brightness alone can do.
    assert cal.extradim_floor(0) < cal.min_lux < cal.extradim_floor(50) + 0.01
    b, c = cal.solve(cal.min_lux * 0.5, extradim=True, min_contrast=10)
    assert b == 0 and 10 <= c < 50, (b, c)
    print(
        f"ok  calibration sweep  ({cal.min_lux:.1f}-{cal.max_lux:.0f} lux, "
        f"ExtraDim floor {cal.extradim_floor(0):.1f})"
    )


def drag(widget, knot, dy):
    pos = QPointF(
        widget._px(widget.curve.lux_at_knot(knot)), widget._py(widget.curve.ys[knot])
    )
    kinds = {
        "mousePressEvent": QMouseEvent.Type.MouseButtonPress,
        "mouseMoveEvent": QMouseEvent.Type.MouseMove,
        "mouseReleaseEvent": QMouseEvent.Type.MouseButtonRelease,
    }
    for kind, at in (
        ("mousePressEvent", pos),
        ("mouseMoveEvent", QPointF(pos.x(), pos.y() + dy)),
        ("mouseReleaseEvent", pos),
    ):
        getattr(widget, kind)(
            QMouseEvent(kinds[kind], at, at, Qt.LeftButton, Qt.LeftButton, Qt.NoModifier)
        )


def check_window(cal):
    from openlux.hardware import DisplayInfo
    from openlux.ui import MainWindow

    win = MainWindow(fake=True)
    win.reader.stop()
    win.cfg.save = lambda: None  # never touch the real config file
    win.displays = [
        DisplayInfo(0, "SIM#0", "Sim (1)"),
        DisplayInfo(1, "OTHER#1", "Other (2)"),
    ]
    win.cfg.calibrations = {"SIM#0": cal.to_dict()}
    win.cfg.gains = {}
    win.ambient_lux = win.raw_lux = 200.0
    for page in (win.home, win.calibrate, win.extradim, win.settings):
        page.rebuild()

    win.apply_now()
    assert set(win.last_levels) == {"SIM#0"}, "an uncalibrated display must be left alone"
    print(f"ok  uncalibrated display untouched  (Sim driven to {win.last_levels['SIM#0']}%)")

    win.manual_commit("all", 30)
    assert win._override_pct("SIM#0") == 30
    win.ambient_lux = 205.0
    assert win._override_pct("SIM#0") == 30, "a flicker must not cancel a manual nudge"
    win.ambient_lux = 600.0
    assert win._override_pct("SIM#0") is None, "a real change hands back to automatic"
    print("ok  manual override holds, then releases")

    win.ambient_lux = 200.0
    win.cfg.auto_learn = True
    win.cfg.single_knob = True
    before, want = win.curve.value_at(200.0), cal.lux_at(90)
    for _ in range(30):
        win.manual_commit("all", 90)
    after = win.curve.value_at(200.0)
    assert abs(after - want) < abs(before - want), f"{before} -> {after}, wanted {want}"
    assert win.cfg.curve_ys == win.curve.ys, "the learned curve must be the saved one"
    print(f"ok  auto-learn  ({before:.0f} -> {after:.0f} lux, user asked for {want:.0f})")

    win.cfg.single_knob = False
    win.cfg.learn_averaged = False
    win.home.rebuild()
    shape = list(win.curve.ys)
    for _ in range(20):
        win.manual_commit("SIM#0", 20)
    assert win.curve.ys == shape, "per-display learning must leave the shared curve alone"
    assert 0 < win.cfg.gains["SIM#0"] < 1
    print(f"ok  per-display learning uses a gain  ({win.cfg.gains['SIM#0']:.2f})")

    graph = win.settings.graph
    graph.resize(600, 300)
    graph.set_limits(cal.min_lux, cal.min_lux, y_max=cal.max_lux)
    win.settings.save.setEnabled(False)
    drag(graph, 8, -60)
    assert graph.curve.ys[8] > shape[8], "dragging up must raise the knot"
    assert win.settings.save.isEnabled(), "Save must arm on an edit"
    win.settings._save_curve()
    assert win.cfg.curve_ys[8] == graph.curve.ys[8]
    assert not win.settings.save.isEnabled()
    print(f"ok  curve drag + save  (knot 8: {shape[8]:.0f} -> {graph.curve.ys[8]:.0f})")

    win.set_extradim(True)
    assert win.home.extradim.isChecked() and win.extradim.enable.isChecked()
    assert win.extradim.graph.floor < win.extradim.graph.extradim_from
    win.set_extradim(False)
    assert not win.home.extradim.isChecked() and not win.extradim.enable.isChecked()
    print("ok  ExtraDim toggle stays in sync across screens")

    win._quit()
    assert win.writer.isFinished() and win.reader.isFinished(), "threads left running"
    print("ok  quit stops both worker threads")


_CACHE = {}


def _calibrated():
    """One sweep, shared by both tests -- it is the fixture for everything else."""
    if "cal" not in _CACHE:
        _CACHE["app"] = QApplication.instance() or QApplication(sys.argv)
        panel = Panel()
        cal, events = run_sweep(panel)
        check_sweep(cal, events, panel)
        _CACHE["cal"] = cal
    return _CACHE["cal"]


def test_calibration_sweep():
    _calibrated()


def test_window_paths():
    check_window(_calibrated())


if __name__ == "__main__":
    test_calibration_sweep()
    test_window_paths()
    print("\nall calibration checks passed")

# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Tath Sikdar

"""Render the four screens to docs/ for the README.

    python packaging/make_screenshots.py

Uses simulated displays and a simulated sensor, so it needs no hardware and
never touches a real monitor. Re-run it when the interface changes.
"""

import sys
from pathlib import Path

from PySide6.QtCore import QTimer
from PySide6.QtWidgets import QApplication

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from openlux.core import CONTRAST_STEP, Calibration, N_BRIGHT, N_CONTRAST  # noqa: E402
from openlux.hardware import DisplayInfo  # noqa: E402
from openlux.ui import MainWindow  # noqa: E402

DOCS = ROOT / "docs"


def fake_calibration(floor, top, cal_contrast=50, min_contrast_lux=1.0):
    bright = [floor + (top - floor) * (i / 100) ** 1.4 for i in range(N_BRIGHT)]
    contrast = [
        min_contrast_lux
        + (floor - min_contrast_lux) * (i * CONTRAST_STEP) / cal_contrast
        for i in range(N_CONTRAST)
    ]
    return Calibration(bright, contrast, cal_contrast)


def main():
    app = QApplication(sys.argv)

    win = MainWindow(fake=True)
    win.auto_enabled = False  # never drive the real monitors
    win.reader.stop()
    win.reader.reading.disconnect()  # else in-flight readings relabel everything
    win.reader.status.disconnect()
    win.cfg.save = lambda: None  # never write the real config

    win.displays = [
        DisplayInfo(0, "P2419H#0", "DELL P2419H (1)"),
        DisplayInfo(1, "LG27GL#1", "LG 27GL850 (2)"),
    ]
    win.cfg.calibrations = {
        "P2419H#0": fake_calibration(12.0, 320.0).to_dict(),
        "LG27GL#1": fake_calibration(18.0, 410.0).to_dict(),
    }
    win.cfg.single_knob = False
    win.cfg.extradim = True
    win.cfg.min_contrast = 25
    win.ambient_lux = win.raw_lux = 180.0

    # Pinned, so the README does not change with whatever theme this machine
    # happens to be set to.
    win.cfg.theme, win.cfg.compact = "dark", False
    win.apply_theme()

    for page in win.page_list:
        page.rebuild()

    win.show()

    def dress():
        """Set the displayed values here, not before app.exec().

        The simulated reader is a QThread, so its readings arrive as queued
        signals that are not delivered until the event loop runs -- anything
        set earlier gets overwritten the moment it starts.
        """
        win.home.lux_label.setText("180 lux ambient")
        win.home.status.setText("Connected to COM3")
        win.last_levels = {"P2419H#0": 62, "LG27GL#1": 55}
        win.home.show_levels(win.last_levels)
        for graph in (win.settings.graph, win.extradim.graph):
            graph.set_ambient(180.0)

        win.calibrate.set_square(True)
        win.calibrate.bar.show()
        win.calibrate.bar.setValue(43)
        win.calibrate.progress_label.setText("Brightness sweep 43%")

    def grab():
        dress()
        DOCS.mkdir(exist_ok=True)
        for index, name in enumerate(("home", "calibrate", "extradim", "settings")):
            win.go(index)
            dress()  # rebuild() on page entry resets some of it
            app.processEvents()
            path = DOCS / f"screenshot-{name}.png"
            win.grab().save(str(path))
            print("wrote", path.relative_to(ROOT))
        win.writer.stop()
        app.quit()

    QTimer.singleShot(600, grab)
    app.exec()


if __name__ == "__main__":
    main()

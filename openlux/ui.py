# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Tath Sikdar

"""Window, tray and the four screens."""

from __future__ import annotations

import math
from pathlib import Path
from string import Template

from PySide6.QtCore import Qt, QPointF, QRectF, QSize
from PySide6.QtGui import QAction, QColor, QGuiApplication, QIcon, QPainter, QPixmap
from PySide6.QtWidgets import (
    QApplication,
    QButtonGroup,
    QCheckBox,
    QComboBox,
    QDoubleSpinBox,
    QFrame,
    QHBoxLayout,
    QLabel,
    QMainWindow,
    QMenu,
    QProgressBar,
    QPushButton,
    QRadioButton,
    QScrollArea,
    QSizePolicy,
    QSlider,
    QSpinBox,
    QStackedWidget,
    QSystemTrayIcon,
    QVBoxLayout,
    QWidget,
)

from . import theme
from .core import Config, adc_to_lux, learn
from .curve import CurveWidget
from .desk import DeskWidget
from .hardware import (
    CalibrationWorker,
    DisplayWriter,
    FakeReader,
    SerialReader,
    available_ports,
    enumerate_displays,
)

# How far the ambient has to move (in decades) before automatic control takes
# back over from a manual slider nudge.
OVERRIDE_RELEASE = 0.08


def draw_icon(size=256):
    """A brightness glyph on a dark tile: readable on a light or dark taskbar.

    packaging/make_icons.py renders this to the .png and .ico that the
    installers use, so the drawing stays the single source of truth.
    """
    pm = QPixmap(size, size)
    pm.fill(Qt.transparent)
    p = QPainter(pm)
    p.setRenderHint(QPainter.Antialiasing)
    p.setPen(Qt.NoPen)

    u = size / 256.0
    p.setBrush(QColor("#121213"))
    p.drawRoundedRect(QRectF(0, 0, size, size), 56 * u, 56 * u)

    p.setBrush(QColor("#e8752c"))
    p.drawEllipse(QPointF(size / 2, size / 2), 46 * u, 46 * u)

    p.translate(size / 2, size / 2)
    for _ in range(8):
        p.drawRoundedRect(QRectF(-7 * u, -100 * u, 14 * u, 30 * u), 7 * u, 7 * u)
        p.rotate(45)
    p.end()
    return pm


def app_icon():
    """The packaged PNG, falling back to drawing it in a source checkout."""
    png = Path(__file__).with_name("icon.png")
    return QIcon(str(png)) if png.exists() else QIcon(draw_icon())


def heading(text, sub=None):
    box = QVBoxLayout()
    h = QLabel(text)
    h.setObjectName("heading")
    box.addWidget(h)
    if sub:
        s = QLabel(sub)
        s.setObjectName("sub")
        s.setWordWrap(True)
        box.addWidget(s)
    w = QWidget()
    w.setObjectName("pane")
    w.setLayout(box)
    return w


def card(*widgets):
    frame = QFrame()
    frame.setObjectName("card")
    lay = QVBoxLayout(frame)
    lay.setSpacing(10)
    for w in widgets:
        lay.addWidget(w) if isinstance(w, QWidget) else lay.addLayout(w)
    return frame


def _scrolled(page):
    """A page keeps its natural height and scrolls; the *window* is then free
    to be dragged shorter than its contents."""
    area = QScrollArea()
    area.setWidget(page)
    area.setWidgetResizable(True)
    area.setFrameShape(QFrame.NoFrame)
    area.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
    return area


def row(*widgets, stretch_last=False):
    lay = QHBoxLayout()
    for w in widgets:
        lay.addWidget(w) if isinstance(w, QWidget) else lay.addLayout(w)
    if not stretch_last:
        lay.addStretch(1)
    return lay


# --- Home -------------------------------------------------------------------


class HomePage(QWidget):
    def __init__(self, win):
        super().__init__()
        self.win = win
        self.sliders = {}  # key -> (QSlider, QLabel)

        self.desk = DeskWidget()
        self.lux_label = QLabel("--")
        self.lux_label.setObjectName("readout")
        self.status = QLabel("Waiting for sensor")
        self.status.setObjectName("sub")

        self.extradim = QCheckBox("ExtraDim  -  keep dimming with contrast below 0% brightness")
        self.extradim.toggled.connect(self.win.set_extradim)

        self.sliders_box = QVBoxLayout()
        self.sliders_box.setSpacing(14)

        lay = QVBoxLayout(self)
        lay.setContentsMargins(24, 24, 24, 24)
        lay.setSpacing(16)
        lay.addWidget(heading("Home"))
        lay.addWidget(card(self.desk))
        lay.addWidget(card(self.lux_label, self.status))
        holder = QWidget()
        holder.setObjectName("pane")
        holder.setLayout(self.sliders_box)
        lay.addWidget(card(holder))
        lay.addWidget(card(self.extradim))
        lay.addStretch(1)

    def rebuild(self):
        while self.sliders_box.count():
            item = self.sliders_box.takeAt(0)
            if item.widget():
                item.widget().deleteLater()
        self.sliders.clear()

        cfg = self.win.cfg
        calibrated = [d for d in self.win.displays if cfg.calibration(d.key)]

        self.extradim.blockSignals(True)
        self.extradim.setChecked(cfg.extradim)
        self.extradim.blockSignals(False)

        if not self.win.displays:
            self.sliders_box.addWidget(QLabel("No DDC/CI displays detected."))
            return
        if not calibrated:
            msg = QLabel("No display is calibrated yet - nothing will be changed.\nGo to Calibrate to measure one.")
            msg.setObjectName("sub")
            self.sliders_box.addWidget(msg)

        targets = [("all", "Brightness")] if cfg.single_knob else [
            (d.key, d.name) for d in calibrated
        ]
        for key, name in targets:
            self.sliders_box.addWidget(self._slider(key, name))

        for d in self.win.displays:
            if not cfg.calibration(d.key):
                lbl = QLabel(f"{d.name} - not calibrated, left alone")
                lbl.setObjectName("sub")
                self.sliders_box.addWidget(lbl)

        self.show_levels(self.win.last_levels)  # navigating back should not zero them

    def _slider(self, key, name):
        w = QWidget()
        w.setObjectName("pane")
        lay = QVBoxLayout(w)
        lay.setContentsMargins(0, 0, 0, 0)
        value = QLabel("--")
        value.setObjectName("value")
        head = QHBoxLayout()
        head.addWidget(QLabel(name))
        head.addStretch(1)
        head.addWidget(value)
        lay.addLayout(head)

        s = QSlider(Qt.Horizontal)
        s.setRange(0, 100)
        s.sliderMoved.connect(lambda v, k=key: self.win.manual_preview(k, v))
        s.sliderReleased.connect(lambda k=key, sl=s: self.win.manual_commit(k, sl.value()))
        lay.addWidget(s)
        self.sliders[key] = (s, value)
        return w

    def show_levels(self, levels):
        """levels: key -> brightness %. Updates sliders the user is not holding."""
        for key, (s, label) in self.sliders.items():
            if key == "all":
                vals = list(levels.values())
                v = round(sum(vals) / len(vals)) if vals else None
            else:
                v = levels.get(key)
            if v is None:
                continue
            label.setText(f"{v}%")
            if not s.isSliderDown():
                s.blockSignals(True)
                s.setValue(v)
                s.blockSignals(False)


# --- Calibrate --------------------------------------------------------------


class CalibratePage(QWidget):
    def __init__(self, win):
        super().__init__()
        self.win = win
        self.worker = None

        self.combo = QComboBox()
        self.contrast = QSpinBox()
        self.contrast.setRange(0, 100)
        self.contrast.setSuffix(" %")

        self.square = QFrame()
        self.square.setObjectName("calsquare")
        self.square.setMinimumSize(QSize(260, 260))
        self.square.setSizePolicy(QSizePolicy.Fixed, QSizePolicy.Fixed)
        self.set_square(False)

        self.button = QPushButton("Ready to calibrate")
        self.button.setObjectName("primary")
        self.button.clicked.connect(self.toggle)

        self.bar = QProgressBar()
        self.bar.setTextVisible(False)
        self.bar.hide()
        self.progress_label = QLabel("")
        self.progress_label.setObjectName("sub")

        steps = QLabel(
            "1.  Drag this window onto the display you want to calibrate.\n"
            "2.  Hold the LDR flat against the white square below, covering it.\n"
            "3.  Press Ready. The display sweeps its whole range - leave it alone\n"
            "     and keep the room's lighting steady until it finishes (~3 min)."
        )
        steps.setObjectName("sub")

        lay = QVBoxLayout(self)
        lay.setContentsMargins(24, 24, 24, 24)
        lay.setSpacing(16)
        lay.addWidget(
            heading(
                "Calibrate",
                "Measures what this display actually emits, so ambient light can be matched to it.",
            )
        )
        lay.addWidget(card(row(QLabel("Display"), self.combo, QLabel("Contrast"), self.contrast), steps))
        centre = QHBoxLayout()
        centre.addStretch(1)
        centre.addWidget(self.square)
        centre.addStretch(1)
        lay.addLayout(centre)
        lay.addWidget(self.button)
        lay.addWidget(self.bar)
        lay.addWidget(self.progress_label)
        lay.addStretch(1)

    def rebuild(self):
        self.combo.clear()
        for d in self.win.displays:
            done = "  [calibrated]" if self.win.cfg.calibration(d.key) else ""
            self.combo.addItem(d.name + done, d.index)
        self.contrast.setValue(self.win.cfg.cal_contrast)
        self.button.setEnabled(bool(self.win.displays))

    def set_square(self, white):
        self.square.setStyleSheet(
            f"background: {'#ffffff' if white else '#000000'}; border-radius: 6px;"
        )

    def toggle(self):
        if self.worker:
            self.worker.cancel()
            return

        idx = self.combo.currentData()
        if idx is None:
            return
        self.win.cfg.cal_contrast = self.contrast.value()
        self.win.calibrating = True
        self.button.setText("Cancel")
        self.bar.show()
        self.bar.setValue(0)

        self.worker = CalibrationWorker(
            idx,
            self.contrast.value(),
            lambda: self.win.raw_lux,
            lambda: self.win.reading_seq,
        )
        self.worker.progress.connect(self._progress)
        self.worker.square.connect(self.set_square)
        self.worker.done.connect(self._done)
        self.worker.failed.connect(self._failed)
        self.worker.start()

    def _progress(self, pct, label):
        self.bar.setValue(pct)
        self.progress_label.setText(label)

    def _finish(self):
        self.worker = None
        self.win.calibrating = False
        self.button.setText("Ready to calibrate")
        self.bar.hide()

    def _done(self, cal):
        key = next(
            (d.key for d in self.win.displays if d.index == self.combo.currentData()),
            None,
        )
        if key:
            self.win.cfg.calibrations[key] = cal.to_dict()
            self.win.cfg.save()
        self.progress_label.setText(
            f"Calibrated: {cal.min_lux:.1f} - {cal.max_lux:.0f} lux"
            + (f", down to {cal.extradim_floor(self.win.cfg.min_contrast):.1f} with ExtraDim" if cal.contrast_lux else "")
        )
        self._finish()
        self.win.displays_changed()

    def _failed(self, msg):
        self.progress_label.setText(msg)
        self._finish()


# --- ExtraDim ---------------------------------------------------------------


class ExtraDimPage(QWidget):
    def __init__(self, win):
        super().__init__()
        self.win = win

        self.enable = QCheckBox("Enable ExtraDim")
        self.enable.toggled.connect(self.win.set_extradim)

        self.combo = QComboBox()
        self.combo.currentIndexChanged.connect(lambda _: self.refresh())

        self.slider = QSlider(Qt.Horizontal)
        self.slider.setRange(0, 100)
        self.value = QLabel("--")
        self.value.setObjectName("value")
        self.slider.valueChanged.connect(self._min_changed)

        self.graph = CurveWidget(win.curve, editable=False)
        self.floor_label = QLabel("")
        self.floor_label.setObjectName("sub")

        lay = QVBoxLayout(self)
        lay.setContentsMargins(24, 24, 24, 24)
        lay.setSpacing(16)
        lay.addWidget(
            heading(
                "ExtraDim",
                "Once brightness hits 0% the display can still go darker by dropping contrast. "
                "The purple stretch of the curve is where that happens.",
            )
        )
        lay.addWidget(card(self.enable))
        lay.addWidget(
            card(
                row(QLabel("Preview display"), self.combo),
                row(QLabel("Minimum contrast"), self.slider, self.value, stretch_last=True),
                self.floor_label,
            )
        )
        lay.addWidget(card(self.graph), 1)

    def rebuild(self):
        self.combo.blockSignals(True)
        self.combo.clear()
        for d in self.win.displays:
            if self.win.cfg.calibration(d.key):
                self.combo.addItem(d.name, d.key)
        self.combo.blockSignals(False)

        self.enable.blockSignals(True)
        self.enable.setChecked(self.win.cfg.extradim)
        self.enable.blockSignals(False)

        self.slider.blockSignals(True)
        self.slider.setValue(self.win.cfg.min_contrast)
        self.slider.blockSignals(False)
        self.refresh()

    def _min_changed(self, v):
        cal = self._cal()
        if cal:
            v = min(v, cal.cal_contrast)
            self.slider.blockSignals(True)
            self.slider.setValue(v)
            self.slider.blockSignals(False)
        self.win.cfg.min_contrast = v
        self.win.cfg.save()
        self.refresh()
        self.win.apply_now()

    def _cal(self):
        return self.win.cfg.calibration(self.combo.currentData())

    def refresh(self):
        self.value.setText(f"{self.slider.value()}%")
        cal = self._cal()
        self.graph.set_curve(self.win.curve)
        if not cal:
            self.graph.set_limits(0.0, 0.0)
            self.floor_label.setText("Calibrate a display to preview its ExtraDim range.")
            return
        floor = cal.extradim_floor(self.win.cfg.min_contrast) if self.win.cfg.extradim else cal.min_lux
        # Zoomed to the dim end -- at full scale this whole region is a few
        # pixels tall and the point of the screen is watching it move.
        self.graph.set_limits(cal.min_lux, floor, y_max=max(cal.min_lux * 4, 20.0))
        self.floor_label.setText(
            f"Brightness alone bottoms out at {cal.min_lux:.1f} lux. "
            f"At {self.slider.value()}% contrast this display reaches {cal.extradim_floor(self.slider.value()):.1f} lux."
        )


# --- Settings ---------------------------------------------------------------


class SettingsPage(QWidget):
    def __init__(self, win):
        super().__init__()
        self.win = win

        self.knob_one = QRadioButton("One knob for every display")
        self.knob_each = QRadioButton("A knob per display")
        g = QButtonGroup(self)
        g.addButton(self.knob_one)
        g.addButton(self.knob_each)
        self.knob_one.toggled.connect(self._knob_changed)

        self.theme = QComboBox()
        for label, value in (("Follow system", "system"), ("Light", "light"), ("Dark", "dark")):
            self.theme.addItem(label, value)
        self.theme.currentIndexChanged.connect(self._appearance_changed)
        self.compact = QCheckBox("Compact layout  -  tighter spacing for a short window")
        self.compact.toggled.connect(self._appearance_changed)

        self.auto_learn = QCheckBox("Learn the brightness I pick over time")
        self.auto_learn.toggled.connect(self._learn_changed)
        self.learn_avg = QRadioButton("Learn from the average of both displays")
        self.learn_each = QRadioButton("Learn each display separately")
        g2 = QButtonGroup(self)
        g2.addButton(self.learn_avg)
        g2.addButton(self.learn_each)
        self.learn_avg.toggled.connect(self._learn_changed)

        self.graph = CurveWidget(win.curve, editable=True)
        self.graph.changed.connect(lambda: self.save.setEnabled(True))
        self.save = QPushButton("Save curve")
        self.save.setObjectName("primary")
        self.save.setEnabled(False)
        self.save.clicked.connect(self._save_curve)
        self.reset = QPushButton("Reset curve")
        self.reset.clicked.connect(self._reset_curve)

        self.port = QComboBox()
        self.port.currentIndexChanged.connect(self._port_changed)

        self.r_fixed = QDoubleSpinBox()
        self.r_fixed.setRange(100, 1_000_000)
        self.r_fixed.setSuffix(" ohm")
        self.r10 = QDoubleSpinBox()
        self.r10.setRange(100, 1_000_000)
        self.r10.setSuffix(" ohm @10lx")
        self.gamma = QDoubleSpinBox()
        self.gamma.setRange(0.1, 2.0)
        self.gamma.setSingleStep(0.05)
        self.to_vcc = QCheckBox("LDR on the VCC side of the divider")
        for w in (self.r_fixed, self.r10, self.gamma):
            w.valueChanged.connect(self._ldr_changed)
        self.to_vcc.toggled.connect(self._ldr_changed)

        self.minimized = QCheckBox("Start minimised to the tray")
        self.minimized.toggled.connect(self._misc_changed)

        lay = QVBoxLayout(self)
        lay.setContentsMargins(24, 24, 24, 24)
        lay.setSpacing(16)
        lay.addWidget(heading("Settings"))
        lay.addWidget(card(QLabel("Home screen"), self.knob_one, self.knob_each))
        lay.addWidget(card(QLabel("Appearance"), row(QLabel("Theme"), self.theme), self.compact))
        lay.addWidget(card(QLabel("Learning"), self.auto_learn, self.learn_avg, self.learn_each))
        lay.addWidget(
            card(
                QLabel("Response curve  -  drag a point to change it"),
                self.graph,
                row(self.save, self.reset),
            ),
            1,
        )
        lay.addWidget(
            card(
                QLabel("Sensor"),
                row(QLabel("Serial port"), self.port),
                row(self.r_fixed, self.r10, self.gamma),
                self.to_vcc,
                self.minimized,
            )
        )

    def rebuild(self):
        cfg = self.win.cfg
        for w, v in (
            (self.knob_one, cfg.single_knob),
            (self.knob_each, not cfg.single_knob),
            (self.auto_learn, cfg.auto_learn),
            (self.learn_avg, cfg.learn_averaged),
            (self.learn_each, not cfg.learn_averaged),
            (self.to_vcc, cfg.ldr_to_vcc),
            (self.minimized, cfg.start_minimized),
            (self.compact, cfg.compact),
        ):
            w.blockSignals(True)
            w.setChecked(v)
            w.blockSignals(False)
        for w, v in ((self.r_fixed, cfg.r_fixed), (self.r10, cfg.r10), (self.gamma, cfg.gamma)):
            w.blockSignals(True)
            w.setValue(v)
            w.blockSignals(False)

        self.learn_avg.setEnabled(cfg.auto_learn and not cfg.single_knob)
        self.learn_each.setEnabled(cfg.auto_learn and not cfg.single_knob)

        self.theme.blockSignals(True)
        self.theme.setCurrentIndex(max(0, self.theme.findData(cfg.theme)))
        self.theme.blockSignals(False)

        self.port.blockSignals(True)
        self.port.clear()
        self.port.addItem("Auto-detect", "")
        for dev, label in available_ports():
            self.port.addItem(label, dev)
        i = self.port.findData(cfg.serial_port)
        self.port.setCurrentIndex(max(0, i))
        self.port.blockSignals(False)

        self.refresh_graph()

    def refresh_graph(self):
        self.graph.set_curve(self.win.curve)
        cal = self.win.reference_cal()
        if cal:
            floor = (
                cal.extradim_floor(self.win.cfg.min_contrast)
                if self.win.cfg.extradim
                else cal.min_lux
            )
            self.graph.set_limits(cal.min_lux, floor, y_max=cal.max_lux * 1.1)

    def _knob_changed(self, _):
        self.win.cfg.single_knob = self.knob_one.isChecked()
        self.win.cfg.save()
        self.learn_avg.setEnabled(self.win.cfg.auto_learn and not self.win.cfg.single_knob)
        self.learn_each.setEnabled(self.win.cfg.auto_learn and not self.win.cfg.single_knob)
        self.win.home.rebuild()

    def _learn_changed(self, _):
        self.win.cfg.auto_learn = self.auto_learn.isChecked()
        self.win.cfg.learn_averaged = self.learn_avg.isChecked()
        self.win.cfg.save()
        self.learn_avg.setEnabled(self.win.cfg.auto_learn and not self.win.cfg.single_knob)
        self.learn_each.setEnabled(self.win.cfg.auto_learn and not self.win.cfg.single_knob)

    def _save_curve(self):
        self.win.cfg.curve_ys = list(self.win.curve.ys)
        self.win.cfg.save()
        self.save.setEnabled(False)
        self.win.apply_now()

    def _reset_curve(self):
        from .core import default_ys

        self.win.curve.ys = default_ys()
        self.win.cfg.curve_ys = list(self.win.curve.ys)
        self.win.cfg.gains.clear()
        self.win.cfg.save()
        self.save.setEnabled(False)
        self.refresh_graph()
        self.win.apply_now()

    def _port_changed(self, _):
        self.win.cfg.serial_port = self.port.currentData() or ""
        self.win.cfg.save()
        self.win.restart_reader()

    def _ldr_changed(self, _=None):
        cfg = self.win.cfg
        cfg.r_fixed = self.r_fixed.value()
        cfg.r10 = self.r10.value()
        cfg.gamma = self.gamma.value()
        cfg.ldr_to_vcc = self.to_vcc.isChecked()
        cfg.save()

    def _misc_changed(self, _):
        self.win.cfg.start_minimized = self.minimized.isChecked()
        self.win.cfg.save()

    def _appearance_changed(self, _=None):
        self.win.cfg.theme = self.theme.currentData()
        self.win.cfg.compact = self.compact.isChecked()
        self.win.cfg.save()
        self.win.apply_theme()


# --- window -----------------------------------------------------------------


class MainWindow(QMainWindow):
    def __init__(self, fake=False):
        super().__init__()
        self.setWindowTitle("open-lux")
        self.setWindowIcon(app_icon())

        self.cfg = Config.load()
        self.resize(self.cfg.win_w, self.cfg.win_h)
        self.curve = self.cfg.curve()
        self.displays = []
        self.raw_lux = 0.0
        self.ambient_lux = None
        self.reading_seq = 0
        self.calibrating = False
        self.auto_enabled = True
        self.last_levels = {}
        self.override = {}  # key -> (brightness %, ambient lux when set)

        self.home = HomePage(self)
        self.calibrate = CalibratePage(self)
        self.extradim = ExtraDimPage(self)
        self.settings = SettingsPage(self)
        self.page_list = [self.home, self.calibrate, self.extradim, self.settings]
        self.pages = QStackedWidget()
        for p in self.page_list:
            self.pages.addWidget(_scrolled(p))

        body = QWidget()
        lay = QHBoxLayout(body)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(0)
        lay.addWidget(self._sidebar())
        lay.addWidget(self.pages, 1)
        self.setCentralWidget(body)

        self.writer = DisplayWriter()
        self.writer.status.connect(self._status)
        self.writer.start()
        self.reader = None
        self._fake = fake
        self.restart_reader()

        self._tray()
        self.apply_theme()
        # The OS switching at sunset should switch the app with it.
        hints = QGuiApplication.styleHints()
        if hasattr(hints, "colorSchemeChanged"):
            hints.colorSchemeChanged.connect(lambda _: self.apply_theme())
        self.displays_changed()

    def apply_theme(self):
        """Rebuild the stylesheet and nudge the hand-painted widgets, which read
        the palette themselves rather than being styled by QSS."""
        dark = theme.is_dark(self.cfg.theme)
        QApplication.instance().setStyleSheet(load_style(dark, self.cfg.compact))

        t = theme.current()
        m, s = t["margin"], t["spacing"]
        for p in self.page_list:
            p.layout().setContentsMargins(m, m, m, m)
            p.layout().setSpacing(s)
        for g in (self.settings.graph, self.extradim.graph):
            g.setMinimumHeight(t["graph_min"])
            g.update()
        self.home.desk.apply_theme()

    # --- chrome ------------------------------------------------------------

    def _sidebar(self):
        bar = QFrame()
        bar.setObjectName("sidebar")
        bar.setFixedWidth(168)
        lay = QVBoxLayout(bar)
        lay.setContentsMargins(12, 20, 12, 20)
        lay.setSpacing(6)

        title = QLabel("open-lux")
        title.setObjectName("brand")
        lay.addWidget(title)
        lay.addSpacing(14)

        self.nav = []
        for i, name in enumerate(("Home", "Calibrate", "ExtraDim", "Settings")):
            b = QPushButton(name)
            b.setObjectName("nav")
            b.setCheckable(True)
            b.clicked.connect(lambda _, n=i: self.go(n))
            lay.addWidget(b)
            self.nav.append(b)
        lay.addStretch(1)
        self.nav[0].setChecked(True)
        return bar

    def go(self, index):
        for i, b in enumerate(self.nav):
            b.setChecked(i == index)
        self.pages.setCurrentIndex(index)
        # page_list, not pages.widget() -- the stack holds scroll areas now.
        self.page_list[index].rebuild()

    def _tray(self):
        if not QSystemTrayIcon.isSystemTrayAvailable():
            self.tray = None
            return
        self.tray = QSystemTrayIcon(app_icon(), self)
        self.tray.setToolTip("open-lux")
        menu = QMenu()
        show = QAction("Show", self)
        show.triggered.connect(self._restore)
        self.auto_action = QAction("Automatic brightness", self, checkable=True)
        self.auto_action.setChecked(True)
        self.auto_action.toggled.connect(self._auto_toggled)
        quit_ = QAction("Quit", self)
        quit_.triggered.connect(self._quit)
        menu.addAction(show)
        menu.addAction(self.auto_action)
        menu.addSeparator()
        menu.addAction(quit_)
        self.tray.setContextMenu(menu)
        self.tray.activated.connect(
            lambda r: self._restore() if r == QSystemTrayIcon.Trigger else None
        )
        self.tray.show()

    def _restore(self):
        self.showNormal()
        self.raise_()
        self.activateWindow()

    def _quit(self):
        self._closing = True
        self.close()

    def closeEvent(self, e):
        self.cfg.win_w, self.cfg.win_h = self.width(), self.height()
        self.cfg.save()
        if getattr(self, "_closing", False) or not self.tray:
            for t in (self.reader, self.writer):
                if t:
                    t.stop()
                    t.wait(1500)
            e.accept()
            return
        e.ignore()
        self.hide()  # to tray; Quit from the tray menu really exits

    # --- wiring ------------------------------------------------------------

    def restart_reader(self):
        if self.reader:
            self.reader.stop()
            self.reader.wait(1500)
        self.reader = FakeReader() if self._fake else SerialReader(self.cfg.serial_port)
        self.reader.reading.connect(self.on_reading)
        self.reader.status.connect(self._status)
        self.reader.start()

    def _status(self, text):
        self.home.status.setText(text)

    def displays_changed(self):
        try:
            self.displays = enumerate_displays()
        except Exception as e:
            self.displays = []
            self._status(f"No displays: {e}")
        for p in self.page_list:
            p.rebuild()

    def reference_cal(self):
        """The calibration the graphs are drawn against -- first calibrated
        display; they mostly differ by scale, not shape."""
        for d in self.displays:
            cal = self.cfg.calibration(d.key)
            if cal:
                return cal
        return None

    # --- the loop ----------------------------------------------------------

    def on_reading(self, adc):
        cfg = self.cfg
        self.raw_lux = adc_to_lux(adc, cfg.r_fixed, cfg.r10, cfg.gamma, cfg.ldr_to_vcc)
        self.reading_seq += 1
        a = cfg.ema
        self.ambient_lux = (
            self.raw_lux
            if self.ambient_lux is None
            else self.ambient_lux * (1 - a) + self.raw_lux * a
        )
        self.home.lux_label.setText(f"{self.ambient_lux:,.0f} lux ambient")
        for g in (self.settings.graph, self.extradim.graph):
            g.set_ambient(self.ambient_lux)
        self.apply_now()

    def _auto_toggled(self, on):
        self.auto_enabled = on
        if on:
            self.apply_now()

    def apply_now(self):
        if self.ambient_lux is None or self.calibrating or not self.auto_enabled:
            return
        levels = {}
        for d in self.displays:
            cal = self.cfg.calibration(d.key)
            if not cal:
                continue  # never touch a display we have not measured
            pct = self._override_pct(d.key)
            if pct is None:
                target = self.cfg.target_for(self.curve, self.ambient_lux, d.key)
                pct, contrast = cal.solve(target, self.cfg.extradim, self.cfg.min_contrast)
            else:
                _, contrast = cal.solve(
                    cal.lux_at(pct), self.cfg.extradim, self.cfg.min_contrast
                )
            levels[d.key] = pct
            self.writer.submit(d.index, pct, contrast)
        self.last_levels = levels
        self.home.show_levels(levels)

    def _override_pct(self, key):
        """A manual nudge holds until the room's light actually changes."""
        entry = self.override.get(key) or self.override.get("all")
        if not entry:
            return None
        pct, at_lux = entry
        if abs(math.log10(max(self.ambient_lux, 1e-6)) - math.log10(max(at_lux, 1e-6))) > OVERRIDE_RELEASE:
            self.override.clear()
            return None
        return pct

    # --- manual + learning -------------------------------------------------

    def manual_preview(self, key, pct):
        for d in self._targets(key):
            cal = self.cfg.calibration(d.key)
            if cal:
                _, contrast = cal.solve(cal.lux_at(pct), self.cfg.extradim, self.cfg.min_contrast)
                self.writer.submit(d.index, pct, contrast)

    def manual_commit(self, key, pct):
        if self.ambient_lux is None:
            return
        self.override[key] = (pct, self.ambient_lux)

        wanted = {
            d.key: cal.lux_at(pct)
            for d in self._targets(key)
            if (cal := self.cfg.calibration(d.key))
        }
        if not wanted or not self.cfg.auto_learn:
            return

        if self.cfg.single_knob or self.cfg.learn_averaged:
            learn(
                self.curve,
                self.ambient_lux,
                sum(wanted.values()) / len(wanted),
                self.cfg.alpha,
                self.cfg.sigma,
            )
            self.cfg.curve_ys = list(self.curve.ys)
        else:
            # Per-display: keep one shared curve shape and learn a scale for
            # this panel, so Settings still shows a single graph.
            base = self.curve.value_at(self.ambient_lux)
            if base > 0:
                for dkey, want in wanted.items():
                    old = self.cfg.gains.get(dkey, 1.0)
                    self.cfg.gains[dkey] = old + self.cfg.alpha * (want / base - old)

        self.cfg.save()
        self.settings.refresh_graph()
        self.extradim.refresh()

    def _targets(self, key):
        if key == "all":
            return [d for d in self.displays if self.cfg.calibration(d.key)]
        return [d for d in self.displays if d.key == key]

    def set_extradim(self, on):
        self.cfg.extradim = on
        self.cfg.save()
        for w in (self.home.extradim, self.extradim.enable):
            w.blockSignals(True)
            w.setChecked(on)
            w.blockSignals(False)
        self.extradim.refresh()
        self.settings.refresh_graph()
        self.writer.forget()
        self.apply_now()


def load_style(dark=True, compact=False):
    """The stylesheet with theme.py's tokens substituted in.

    string.Template rather than str.format: QSS is all braces, and `$` appears
    nowhere in it. A token missing from theme.py raises here rather than
    rendering a broken sheet -- tests/test_theme.py checks for that.
    """
    tokens = theme.tokens(dark, compact)
    try:
        qss = (Path(__file__).with_name("style.qss")).read_text(encoding="utf-8")
    except OSError:
        return ""
    return Template(qss).substitute(tokens)

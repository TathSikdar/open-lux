# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Tath Sikdar

"""The Home screen illustration: a desk, front elevation.

Painted rather than loaded from an .svg, for the same reason draw_icon() is:
the colours come from the live palette, so it themes itself, and there is no
asset to add to the PyInstaller spec. Everything is drawn in a fixed 320x180
space and the painter is scaled to the widget, which is what makes it vector.
"""

from __future__ import annotations

from PySide6.QtCore import QPointF, QRectF, QSize, Qt
from PySide6.QtGui import QColor, QPainter, QPen
from PySide6.QtWidgets import QSizePolicy, QWidget

from . import theme

BASE_W, BASE_H = 320.0, 180.0


class DeskWidget(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Preferred)
        self.apply_theme()

    def apply_theme(self):
        self.setMinimumHeight(theme.current()["desk_min"])
        self.updateGeometry()
        self.update()

    def sizeHint(self):
        h = self.minimumHeight()
        return QSize(int(h * BASE_W / BASE_H), h)

    def paintEvent(self, _):
        t = theme.current()
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)

        u = min(self.width() / BASE_W, self.height() / BASE_H)
        p.translate(
            (self.width() - BASE_W * u) / 2, (self.height() - BASE_H * u) / 2
        )
        p.scale(u, u)

        desk, edge = QColor(t["desk"]), QColor(t["desk_edge"])
        case, case_edge = QColor(t["case"]), QColor(t["case_edge"])
        accent = QColor(t["accent"])

        # floor
        p.setPen(QPen(edge, 1.2))
        p.drawLine(QPointF(8, 168), QPointF(312, 168))

        # desk: legs first, then the top slab over them
        self._box(p, 24, 120, 8, 48, edge)
        self._box(p, 288, 120, 8, 48, edge)
        self._box(p, 18, 110, 284, 10, desk, edge, r=3)

        # tower PC, on the floor under the desk
        self._box(p, 36, 122, 34, 46, case, case_edge, r=3)
        p.setPen(QPen(edge, 1.2))
        for i in range(3):
            y = 130 + i * 5
            p.drawLine(QPointF(43, y), QPointF(63, y))
        p.setPen(Qt.NoPen)
        p.setBrush(accent)
        p.drawEllipse(QPointF(53, 160), 2.2, 2.2)

        # bookshelf speakers, flanking the monitor
        for x in (60, 232):
            self._box(p, x, 56, 28, 54, case, case_edge, r=2)
            p.setPen(QPen(case_edge, 1.2))
            p.setBrush(QColor(t["screen"]))
            p.drawEllipse(QPointF(x + 14, 84), 9, 9)  # woofer
            p.drawEllipse(QPointF(x + 14, 66), 4, 4)  # tweeter
            p.setPen(Qt.NoPen)
            p.setBrush(case_edge)
            p.drawEllipse(QPointF(x + 14, 84), 3, 3)  # dust cap

        # monitor: bezel, lit panel, neck, base
        self._box(p, 108, 28, 104, 62, case, case_edge, r=3)
        self._box(p, 112, 32, 96, 54, QColor(t["screen"]), None, r=2)
        glow = QColor(accent)
        glow.setAlpha(52)  # the panel is on -- this app is about how brightly
        self._box(p, 116, 36, 88, 46, glow, None, r=2)
        self._box(p, 153, 90, 14, 12, case_edge)
        self._box(p, 136, 102, 48, 8, case, case_edge, r=2)

        # keyboard and mouse, in front: the overlap is the only depth cue here
        self._box(p, 116, 106, 88, 12, case, case_edge, r=3)
        p.setPen(QPen(case_edge, 1))
        for row in range(2):
            for col in range(13):
                p.drawLine(
                    QPointF(121 + col * 6.4, 110 + row * 4),
                    QPointF(125 + col * 6.4, 110 + row * 4),
                )
        self._box(p, 212, 106, 16, 12, case, case_edge, r=5)
        p.end()

    @staticmethod
    def _box(p, x, y, w, h, fill, edge=None, r=0):
        p.setPen(QPen(edge, 1.2) if edge else Qt.NoPen)
        p.setBrush(fill)
        rect = QRectF(x, y, w, h)
        p.drawRoundedRect(rect, r, r) if r else p.drawRect(rect)

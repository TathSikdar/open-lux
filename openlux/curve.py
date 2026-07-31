# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Tath Sikdar

"""The response graph: ambient lux (log) against target screen luminance.

Hand-painted rather than charted. A charting library would still not give
drag-to-edit knots or a two-tone curve, so it would be a dependency that
bought nothing.
"""

from __future__ import annotations

import math

from PySide6.QtCore import QPointF, QRectF, Qt, Signal
from PySide6.QtGui import QColor, QFont, QPainter, QPainterPath, QPen
from PySide6.QtWidgets import QSizePolicy, QWidget

from . import theme
from .core import LUX_MAX, LUX_MIN, Curve

MARGIN_L, MARGIN_R, MARGIN_T, MARGIN_B = 46, 12, 12, 26
GRAB_PX = 14


def _c(name):
    """A colour from the live palette -- read at paint time, so a theme switch
    is nothing more than a repaint."""
    return QColor(theme.current()[name])


class CurveWidget(QWidget):
    """Set `editable` for the Settings copy; the ExtraDim preview is read-only."""

    changed = Signal()

    def __init__(self, curve=None, editable=False, parent=None):
        super().__init__(parent)
        self.curve = curve or Curve()
        self.editable = editable
        self.y_max = 300.0
        self.floor = 0.0  # dimmest reachable once ExtraDim is allowed in
        self.extradim_from = 0.0  # below this, contrast has to take over
        self.ambient = None
        self._drag = None
        self.setMinimumHeight(theme.current()["graph_min"])
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        self.setMouseTracking(True)

    # --- inputs ------------------------------------------------------------

    def set_curve(self, curve):
        self.curve = curve
        self.update()

    def set_limits(self, extradim_from, floor, y_max=None):
        """extradim_from: the display's brightness-0 output. floor: the dimmest
        it reaches once contrast is allowed down to the user's minimum."""
        self.extradim_from = extradim_from
        self.floor = floor
        if y_max:
            self.y_max = max(50.0, y_max)
        self.update()

    def set_ambient(self, lux):
        self.ambient = lux
        self.update()

    # --- coordinates -------------------------------------------------------

    def _plot(self):
        return QRectF(
            MARGIN_L,
            MARGIN_T,
            max(1, self.width() - MARGIN_L - MARGIN_R),
            max(1, self.height() - MARGIN_T - MARGIN_B),
        )

    def _px(self, lux):
        r = self._plot()
        lo, hi = math.log10(LUX_MIN), math.log10(LUX_MAX)
        f = (math.log10(max(lux, LUX_MIN)) - lo) / (hi - lo)
        return r.left() + f * r.width()

    def _py(self, val):
        r = self._plot()
        return r.bottom() - min(val / self.y_max, 1.0) * r.height()

    def _val(self, y):
        r = self._plot()
        return max(0.0, min(1.0, (r.bottom() - y) / r.height())) * self.y_max

    # --- painting ----------------------------------------------------------

    def paintEvent(self, _):
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)
        r = self._plot()
        p.fillRect(self.rect(), _c("graph_bg"))

        self._grid(p, r)
        self._curve(p, r)
        if self.ambient:
            self._now(p, r)
        if self.editable:
            self._knots(p)

    def _grid(self, p, r):
        f = QFont(self.font())
        f.setPointSizeF(max(7.0, f.pointSizeF() - 1.5))
        p.setFont(f)
        grid, axis = _c("grid"), _c("axis")

        for decade in range(int(math.log10(LUX_MIN)), int(math.log10(LUX_MAX)) + 1):
            lux = 10.0**decade
            x = self._px(lux)
            p.setPen(QPen(grid, 1))
            p.drawLine(QPointF(x, r.top()), QPointF(x, r.bottom()))
            p.setPen(axis)
            label = f"{lux:g}" if lux < 1000 else f"{lux / 1000:g}k"
            p.drawText(QRectF(x - 20, r.bottom() + 4, 40, 16), Qt.AlignHCenter, label)

        for i in range(5):
            val = self.y_max * i / 4
            y = self._py(val)
            p.setPen(QPen(grid, 1))
            p.drawLine(QPointF(r.left(), y), QPointF(r.right(), y))
            p.setPen(axis)
            p.drawText(
                QRectF(0, y - 8, MARGIN_L - 6, 16),
                Qt.AlignRight | Qt.AlignVCenter,
                f"{val:.0f}",
            )

        p.setPen(axis)
        p.drawText(QRectF(r.left() + 6, r.top() + 2, 140, 14), Qt.AlignLeft, "target lux")
        p.drawText(
            QRectF(r.right() - 146, r.top() + 2, 140, 14), Qt.AlignRight, "ambient lux"
        )

    def _curve(self, p, r):
        """Two passes: what the curve asks for (ghosted where unreachable), and
        what the panel will actually be driven to."""
        steps = 220
        lo, hi = math.log10(LUX_MIN), math.log10(LUX_MAX)
        pts = []
        for i in range(steps + 1):
            lux = 10.0 ** (lo + (hi - lo) * i / steps)
            want = self.curve.value_at(lux)
            x = r.left() + r.width() * i / steps
            pts.append((QPointF(x, self._py(want)), QPointF(x, self._py(max(want, self.floor))), want))

        ghost = QPainterPath(pts[0][0])
        for wanted_pt, _, _ in pts[1:]:
            ghost.lineTo(wanted_pt)
        p.setPen(QPen(_c("ghost"), 1, Qt.DashLine))
        p.drawPath(ghost)

        # Segment by segment, so the ExtraDim stretch is simply a different pen.
        extra, line = _c("extra"), _c("accent")
        for (_, a, _), (_, b, want) in zip(pts, pts[1:]):
            p.setPen(QPen(extra if want < self.extradim_from else line, 2.4))
            p.drawLine(a, b)

        if self.extradim_from > 0:
            y = self._py(self.extradim_from)
            p.setPen(QPen(extra.darker(160), 1, Qt.DotLine))
            p.drawLine(QPointF(r.left(), y), QPointF(r.right(), y))

    def _now(self, p, r):
        x = self._px(self.ambient)
        now = _c("now")
        # Dimmed, or a 1px dashed line reads as plain white against the grid.
        p.setPen(QPen(now.darker(160), 1, Qt.DashLine))
        p.drawLine(QPointF(x, r.top()), QPointF(x, r.bottom()))
        p.setBrush(now)
        p.setPen(Qt.NoPen)
        y = self._py(max(self.curve.value_at(self.ambient), self.floor))
        p.drawEllipse(QPointF(x, y), 4, 4)

    def _knots(self, p):
        p.setPen(QPen(_c("graph_bg"), 1.5))
        p.setBrush(_c("knot"))
        for i, y in enumerate(self.curve.ys):
            p.drawEllipse(
                QPointF(self._px(self.curve.lux_at_knot(i)), self._py(y)), 4.5, 4.5
            )

    # --- dragging ----------------------------------------------------------

    def _nearest(self, pos):
        best, best_d = None, GRAB_PX
        for i, y in enumerate(self.curve.ys):
            d = math.hypot(
                pos.x() - self._px(self.curve.lux_at_knot(i)), pos.y() - self._py(y)
            )
            if d < best_d:
                best, best_d = i, d
        return best

    def mousePressEvent(self, e):
        if self.editable and e.button() == Qt.LeftButton:
            self._drag = self._nearest(e.position())

    def mouseMoveEvent(self, e):
        if not self.editable:
            return
        if self._drag is None:
            self.setCursor(
                Qt.PointingHandCursor
                if self._nearest(e.position()) is not None
                else Qt.ArrowCursor
            )
            return
        self.curve.ys[self._drag] = self._val(e.position().y())
        self.changed.emit()
        self.update()

    def mouseReleaseEvent(self, _):
        self._drag = None

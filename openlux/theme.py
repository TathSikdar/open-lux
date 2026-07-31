# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Tath Sikdar

"""The palette, in one place.

style.qss is a $token template rather than literal hex, and the hand-painted
widgets (curve.py, desk.py) read the same dict, so a colour is written once and
the two halves of the UI cannot drift apart.

Colours and metrics are separate dicts: light/dark picks the first, compact
picks the second, and any of the four combinations is valid.
"""

from __future__ import annotations

DARK = {
    "bg": "#0c0c0d",
    "surface": "#131314",
    "sidebar": "#121213",
    "border": "#232325",
    "border_hi": "#3a3a3e",
    "text": "#ece9e4",
    "muted": "#8f8b85",
    "faint": "#56534f",
    "hover": "#1b1b1d",
    "sel": "#1f1e1d",
    "sel_border": "#37332e",
    "field": "#191919",
    "popup": "#161617",
    "button": "#1e1e20",
    "button_border": "#2f2f32",
    "button_hover": "#27272a",
    "button_press": "#171719",
    "button_off": "#141416",
    "accent": "#e8752c",
    "accent_hover": "#f58a45",
    "accent_press": "#d1651f",
    "accent_fg": "#16130f",
    "accent_off": "#2a2521",
    "accent_off_fg": "#6b6259",
    "handle": "#ece9e4",
    "handle_hover": "#ffffff",
    # graph + illustration
    "graph_bg": "#101011",
    "grid": "#232325",
    "axis": "#6b6763",
    "ghost": "#3a3a3d",
    "knot": "#ece9e4",
    "extra": "#a97cf5",  # ExtraDim: contrast has taken over
    "now": "#5ec98f",  # where the room is right now
    "desk": "#2b2521",
    "desk_edge": "#1c1815",
    "case": "#1b1b1d",
    "case_edge": "#37332e",
    "screen": "#0a0a0b",
}

# Warm paper rather than a blue-white, to keep the dark theme's temperature.
# The accent is deepened: #e8752c on white is 2.6:1, which fails as text.
LIGHT = {
    "bg": "#f7f4ef",
    "surface": "#ffffff",
    "sidebar": "#f0ece5",
    "border": "#e0dad1",
    "border_hi": "#c4bcb0",
    "text": "#221f1c",
    "muted": "#6f6862",
    "faint": "#a8a099",
    "hover": "#e7e1d8",
    "sel": "#ffffff",
    "sel_border": "#d8cfc2",
    "field": "#ffffff",
    "popup": "#ffffff",
    "button": "#ffffff",
    "button_border": "#ddd6cc",
    "button_hover": "#f2ede6",
    "button_press": "#e8e2d9",
    "button_off": "#f2efea",
    "accent": "#c25808",
    "accent_hover": "#a84904",
    "accent_press": "#8f3d03",
    "accent_fg": "#ffffff",
    "accent_off": "#eadfd4",
    "accent_off_fg": "#a8a099",
    "handle": "#4a443e",
    "handle_hover": "#221f1c",
    # graph + illustration
    "graph_bg": "#fffdf9",
    "grid": "#e6e0d6",
    "axis": "#8b837b",
    "ghost": "#cfc8bf",
    "knot": "#221f1c",
    "extra": "#7c4fd0",
    "now": "#2f9e63",
    "desk": "#e3d8c8",
    "desk_edge": "#c9bba7",
    "case": "#f0ece5",
    "case_edge": "#c4bcb0",
    "screen": "#2a2622",
}

# Qt does not clamp an oversized border-radius, so the pill radii have to be
# just over half the button's real height -- see the note in style.qss.
ROOMY = {
    "font": "13px",
    "brand_size": "19px",
    "heading_size": "27px",
    "readout_size": "34px",
    "value_size": "15px",
    "btn_pad": "9px 20px",
    "pri_pad": "11px 24px",
    "nav_pad": "9px 16px",
    "field_pad": "7px 14px",
    "radius": "20px",
    "pri_radius": "21px",
    "card_radius": "16px",
    "field_radius": "12px",
    # read by Python, not the stylesheet
    "graph_min": 190,
    "desk_min": 200,
    "margin": 24,
    "spacing": 16,
}

COMPACT = {
    "font": "12px",
    "brand_size": "17px",
    "heading_size": "21px",
    "readout_size": "26px",
    "value_size": "14px",
    "btn_pad": "6px 16px",
    "pri_pad": "7px 18px",
    "nav_pad": "6px 14px",
    "field_pad": "5px 12px",
    "radius": "16px",
    "pri_radius": "17px",
    "card_radius": "12px",
    "field_radius": "10px",
    "graph_min": 130,
    "desk_min": 130,
    "margin": 14,
    "spacing": 9,
}

_current = {**DARK, **ROOMY}


def tokens(dark=True, compact=False):
    """Build a palette and make it the one the painted widgets will read."""
    global _current
    _current = {**(DARK if dark else LIGHT), **(COMPACT if compact else ROOMY)}
    return _current


def current():
    return _current


def is_dark(preference):
    """preference: "system" | "light" | "dark"."""
    if preference in ("light", "dark"):
        return preference == "dark"

    # Qt 6.5+. Older builds have no way to ask, so they keep the dark theme.
    try:
        from PySide6.QtCore import Qt
        from PySide6.QtGui import QGuiApplication

        scheme = QGuiApplication.styleHints().colorScheme()
        return scheme != Qt.ColorScheme.Light
    except (AttributeError, TypeError):
        return True

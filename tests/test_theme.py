# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Tath Sikdar

"""The palette and the stylesheet have to stay in step.

No Qt import: theme.py only touches QtGui inside is_dark(), so this runs
headless like test_core.py does.
"""

import re
from pathlib import Path
from string import Template

from openlux import theme

QSS = Path(theme.__file__).with_name("style.qss").read_text(encoding="utf-8")
USED = set(re.findall(r"\$([a-z_]+)", QSS))


def test_palettes_have_the_same_keys():
    assert set(theme.DARK) == set(theme.LIGHT)
    assert set(theme.ROOMY) == set(theme.COMPACT)


def test_every_stylesheet_token_resolves():
    assert USED, "no $tokens found -- did style.qss stop being a template?"
    for dark in (True, False):
        for compact in (True, False):
            rendered = Template(QSS).substitute(theme.tokens(dark, compact))
            assert "$" not in rendered


def test_current_follows_the_last_build():
    theme.tokens(dark=False, compact=True)
    assert theme.current()["bg"] == theme.LIGHT["bg"]
    assert theme.current()["graph_min"] == theme.COMPACT["graph_min"]
    theme.tokens(dark=True, compact=False)
    assert theme.current()["bg"] == theme.DARK["bg"]


def test_theme_preference():
    assert theme.is_dark("dark") is True
    assert theme.is_dark("light") is False

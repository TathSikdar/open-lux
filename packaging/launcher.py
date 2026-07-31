# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Tath Sikdar

"""Entry point for the frozen build.

PyInstaller cannot use openlux/__main__.py directly: run as a top-level script
it has no package, so its relative imports fail. This imports it properly.
"""

from openlux.__main__ import main

if __name__ == "__main__":
    main()

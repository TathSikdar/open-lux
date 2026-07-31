# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Tath Sikdar

"""python -m openlux [--fake]"""

import sys

from PySide6.QtWidgets import QApplication

from .ui import MainWindow


def main():
    app = QApplication(sys.argv)
    app.setApplicationName("open-lux")
    app.setQuitOnLastWindowClosed(False)  # closing the window goes to the tray

    # The window owns the stylesheet: it knows the theme setting, and has to be
    # able to swap it again when the OS or the user changes their mind.
    win = MainWindow(fake="--fake" in sys.argv)
    if win.cfg.start_minimized and win.tray:
        win.tray.showMessage("open-lux", "Running in the tray.")
    else:
        win.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()

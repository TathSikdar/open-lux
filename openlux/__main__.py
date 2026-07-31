# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Tath Sikdar

"""python -m openlux [--fake]"""

import sys

from PySide6.QtWidgets import QApplication

from .ui import MainWindow, load_style


def main():
    app = QApplication(sys.argv)
    app.setApplicationName("open-lux")
    app.setQuitOnLastWindowClosed(False)  # closing the window goes to the tray
    app.setStyleSheet(load_style())

    win = MainWindow(fake="--fake" in sys.argv)
    if win.cfg.start_minimized and win.tray:
        win.tray.showMessage("open-lux", "Running in the tray.")
    else:
        win.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()

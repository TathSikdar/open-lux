# -*- mode: python ; coding: utf-8 -*-
# SPDX-License-Identifier: GPL-3.0-or-later
#
#   pyinstaller packaging/openlux.spec
#
# Produces dist/openlux/ -- a self-contained folder that needs no Python.
# One-folder rather than one-file: a one-file PySide6 build unpacks ~100MB to a
# temp directory on every launch, which for a tray app you start at login is a
# few seconds of nothing happening.

import sys
from pathlib import Path

ROOT = Path(SPECPATH).resolve().parent

# Qt ships far more than this app uses, and none of it is small.
EXCLUDE_QT = [
    "PySide6.Qt3DAnimation", "PySide6.Qt3DCore", "PySide6.Qt3DExtras",
    "PySide6.Qt3DInput", "PySide6.Qt3DLogic", "PySide6.Qt3DRender",
    "PySide6.QtBluetooth", "PySide6.QtCharts", "PySide6.QtDataVisualization",
    "PySide6.QtDesigner", "PySide6.QtHelp", "PySide6.QtMultimedia",
    "PySide6.QtMultimediaWidgets", "PySide6.QtNfc", "PySide6.QtOpenGL",
    "PySide6.QtOpenGLWidgets", "PySide6.QtPdf", "PySide6.QtPdfWidgets",
    "PySide6.QtPositioning", "PySide6.QtQml", "PySide6.QtQuick",
    "PySide6.QtQuick3D", "PySide6.QtQuickControls2", "PySide6.QtQuickWidgets",
    "PySide6.QtRemoteObjects", "PySide6.QtScxml", "PySide6.QtSensors",
    "PySide6.QtSerialBus", "PySide6.QtSpatialAudio", "PySide6.QtSql",
    "PySide6.QtStateMachine", "PySide6.QtSvgWidgets", "PySide6.QtTest",
    "PySide6.QtTextToSpeech", "PySide6.QtUiTools", "PySide6.QtWebChannel",
    "PySide6.QtWebEngineCore", "PySide6.QtWebEngineQuick",
    "PySide6.QtWebEngineWidgets", "PySide6.QtWebSockets",
]

a = Analysis(
    [str(ROOT / "packaging" / "launcher.py")],
    pathex=[str(ROOT)],
    datas=[
        (str(ROOT / "openlux" / "style.qss"), "openlux"),
        (str(ROOT / "openlux" / "icon.png"), "openlux"),
    ],
    hiddenimports=["monitorcontrol"],
    excludes=EXCLUDE_QT + ["tkinter", "pytest", "unittest", "pydoc_data"],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="openlux",
    console=False,  # a tray app should not drag a terminal along
    icon=str(ROOT / "packaging" / "openlux.ico") if sys.platform == "win32" else None,
)

coll = COLLECT(exe, a.binaries, a.datas, name="openlux")

# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Tath Sikdar

"""Render the app icon to the files the installers need.

    python packaging/make_icons.py

Writes openlux/icon.png (the app and the Linux .desktop entry) and
packaging/openlux.ico (the Windows executable and installer). The drawing
itself lives in openlux.ui.draw_icon, so there is only one of it.
"""

import struct
import sys
from pathlib import Path

from PySide6.QtCore import QBuffer
from PySide6.QtWidgets import QApplication

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from openlux.ui import draw_icon  # noqa: E402  (needs the path above)

ICO_SIZES = (16, 24, 32, 48, 64, 128, 256)


def png_bytes(pixmap):
    # QBuffer owns its storage here on purpose: handing it a QByteArray
    # temporary lets Python collect the buffer out from under it, and Qt
    # segfaults on the write.
    buf = QBuffer()
    buf.open(QBuffer.WriteOnly)
    pixmap.save(buf, "PNG")
    return bytes(buf.data())


def write_ico(path, sizes):
    """Multi-size ICO with PNG payloads.

    Qt's ICO writer only emits a single image, and a lone 256px entry is what
    gives you a blurry 16px taskbar icon. The container is simple enough to
    write directly: a header, one 16-byte directory entry per size, then the
    PNG data. Vista and later read PNG-compressed entries natively.
    """
    images = [png_bytes(draw_icon(s)) for s in sizes]
    offset = 6 + 16 * len(images)
    header = struct.pack("<HHH", 0, 1, len(images))
    directory, payload = b"", b""
    for size, data in zip(sizes, images):
        directory += struct.pack(
            "<BBBBHHII",
            size if size < 256 else 0,  # 0 means 256 in this field
            size if size < 256 else 0,
            0,  # palette colours: none, it is truecolour
            0,  # reserved
            1,  # colour planes
            32,  # bits per pixel
            len(data),
            offset,
        )
        payload += data
        offset += len(data)
    path.write_bytes(header + directory + payload)


if __name__ == "__main__":
    QApplication(sys.argv)  # QPixmap needs one, even offscreen

    png = ROOT / "openlux" / "icon.png"
    draw_icon(256).save(str(png), "PNG")
    print("wrote", png.relative_to(ROOT))

    ico = ROOT / "packaging" / "openlux.ico"
    write_ico(ico, ICO_SIZES)
    print("wrote", ico.relative_to(ROOT), f"({', '.join(map(str, ICO_SIZES))}px)")

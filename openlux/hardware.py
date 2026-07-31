# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Tath Sikdar

"""Everything that talks to physical things: the Arduino over serial, and the
displays over DDC/CI.

DDC writes take 50-200ms and would visibly stall the GUI, so all of it happens
on worker threads that report back by signal.
"""

from __future__ import annotations

import math
import threading
import time
from dataclasses import dataclass

import serial
from serial.tools import list_ports

from PySide6.QtCore import QThread, Signal

from .core import CONTRAST_STEP, Calibration, N_CONTRAST

# USB vendor IDs of the usual Arduino / clone serial bridges.
KNOWN_VIDS = {0x2341, 0x2A03, 0x1A86, 0x0403, 0x10C4, 0x1B4F}


# --- serial -----------------------------------------------------------------


def available_ports():
    return [(p.device, f"{p.device} - {p.description}") for p in list_ports.comports()]


def guess_port():
    ports = list(list_ports.comports())
    for p in ports:
        if p.vid in KNOWN_VIDS:
            return p.device
    for p in ports:
        if "arduino" in (p.description or "").lower():
            return p.device
    return ports[0].device if ports else None


class SerialReader(QThread):
    """Streams raw ADC readings. Reconnects forever instead of dying on the
    first bad line, which is how the old script lost a working port."""

    reading = Signal(int)
    status = Signal(str)

    def __init__(self, port_override="", baud=9600, parent=None):
        super().__init__(parent)
        self.port_override = port_override
        self.baud = baud
        self._running = True

    def run(self):
        backoff = 1.0
        while self._running:
            port = self.port_override or guess_port()
            if not port:
                self.status.emit("No serial ports found")
                self._nap(backoff)
                backoff = min(backoff * 2, 10.0)
                continue
            try:
                with serial.Serial(port, self.baud, timeout=2) as ser:
                    self.status.emit(f"Connected to {port}")
                    backoff = 1.0
                    ser.reset_input_buffer()
                    while self._running:
                        line = ser.readline().strip()
                        if not line:
                            continue
                        try:
                            self.reading.emit(int(line))
                        except ValueError:
                            pass  # boot noise / partial line, keep the port
            except (serial.SerialException, OSError) as e:
                self.status.emit(f"{port}: {e}")
                self._nap(backoff)
                backoff = min(backoff * 2, 10.0)

    def _nap(self, seconds):
        end = time.monotonic() + seconds
        while self._running and time.monotonic() < end:
            time.sleep(0.1)

    def stop(self):
        self._running = False


class FakeReader(QThread):
    """--fake: a synthetic day/night cycle so the GUI, calibration flow and
    graphs can be driven with no hardware attached."""

    reading = Signal(int)
    status = Signal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._running = True

    def run(self):
        self.status.emit("Simulated sensor (--fake)")
        t = 0.0
        while self._running:
            self.reading.emit(int(512 + 480 * math.sin(t)))
            t += 0.05
            time.sleep(0.25)

    def stop(self):
        self._running = False


# --- displays ---------------------------------------------------------------


@dataclass
class DisplayInfo:
    index: int
    key: str
    name: str


def enumerate_displays():
    """Detected DDC/CI monitors. Laptop internal panels have no DDC and will
    not show up -- that is the same scope the project always had."""
    from monitorcontrol import get_monitors

    out = []
    for i, mon in enumerate(get_monitors()):
        model = None
        try:
            with mon:
                model = (mon.get_vcp_capabilities() or {}).get("model")
        except Exception:
            pass
        model = model or "Display"
        # ponytail: model+index as the key. Monitors of the same model swap
        # identity if you replug them in a different order; needs EDID serials
        # to fix properly, and monitorcontrol does not expose them.
        out.append(DisplayInfo(i, f"{model}#{i}", f"{model} ({i + 1})"))
    return out


def _monitor(index):
    from monitorcontrol import get_monitors

    mons = get_monitors()
    if index >= len(mons):
        raise IndexError(f"display {index} is gone")
    return mons[index]


class DisplayWriter(QThread):
    """Applies brightness/contrast, newest target wins.

    ponytail: one worker serialises writes to every monitor. Split per-monitor
    if one slow panel starts holding up the others.
    """

    status = Signal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._pending = {}
        self._last = {}
        self._lock = threading.Lock()
        self._wake = threading.Event()
        self._running = True

    def submit(self, index, brightness, contrast):
        with self._lock:
            self._pending[index] = (int(brightness), int(contrast))
        self._wake.set()

    def forget(self, index=None):
        """Drop the write-skipping cache so the next submit is applied even if
        the value looks unchanged (after a calibration moved things behind us)."""
        with self._lock:
            self._last.pop(index, None) if index is not None else self._last.clear()

    def run(self):
        while self._running:
            self._wake.wait(0.25)
            self._wake.clear()
            with self._lock:
                batch, self._pending = self._pending, {}
            for index, target in batch.items():
                if self._last.get(index) == target:
                    continue
                brightness, contrast = target
                try:
                    with _monitor(index) as mon:
                        mon.set_luminance(brightness)
                        if self._last.get(index, (None, None))[1] != contrast:
                            mon.set_contrast(contrast)
                    self._last[index] = target
                except Exception as e:
                    self.status.emit(f"Display {index + 1}: {e}")

    def stop(self):
        self._running = False
        self._wake.set()


class Cancelled(Exception):
    pass


class CalibrationWorker(QThread):
    """Sweeps one display and measures what it actually emits.

    Brightness 0-100 in steps of 1, then contrast 100-0 in steps of 5, dwelling
    at each step so the panel and the sensor both settle.
    """

    progress = Signal(int, str)  # 0-100, label
    square = Signal(bool)  # True = white, False = black
    done = Signal(object)  # Calibration
    failed = Signal(str)

    def __init__(self, index, cal_contrast, read_lux, read_seq, dwell=0.5, parent=None):
        super().__init__(parent)
        self.index = index
        self.cal_contrast = int(cal_contrast)
        self.read_lux = read_lux
        self.read_seq = read_seq
        self.dwell = dwell
        self._running = True

    def cancel(self):
        self._running = False

    def _wait(self, seconds):
        end = time.monotonic() + seconds
        while self._running and time.monotonic() < end:
            time.sleep(0.02)
        return self._running

    def _sample(self, mult=1.0):
        """Dwell for the panel to settle, then wait for a sensor report that
        actually arrived after the change -- the Arduino only speaks once a
        second, so the value sitting there mid-dwell is the previous step's."""
        seq0 = self.read_seq()
        if not self._wait(self.dwell * mult):
            raise Cancelled
        deadline = time.monotonic() + 3.0
        while (
            self._running
            and self.read_seq() == seq0
            and time.monotonic() < deadline
        ):
            time.sleep(0.02)
        if not self._running:
            raise Cancelled
        return self.read_lux()

    def run(self):
        steps = 101 + N_CONTRAST + 2
        step = 0

        def tick(label):
            nonlocal step
            step += 1
            self.progress.emit(int(100 * step / steps), label)

        try:
            with _monitor(self.index) as mon:
                orig_b, orig_c = mon.get_luminance(), mon.get_contrast()
                try:
                    # Baseline: what the sensor reads with the square black, so
                    # the tables describe the display and not the room.
                    # Baseline with the square black at the dimmest setting:
                    # room light plus the panel's own black level, which is
                    # the floor every later sample sits on top of.
                    self.square.emit(False)
                    mon.set_contrast(self.cal_contrast)
                    mon.set_luminance(0)
                    tick("Measuring baseline")
                    baseline = self._sample(2.0)

                    self.square.emit(True)
                    tick("Settling")
                    self._sample()

                    bright = []
                    for b in range(101):
                        mon.set_luminance(b)
                        bright.append(max(0.0, self._sample() - baseline))
                        tick(f"Brightness sweep {b}%")

                    contrast = [0.0] * N_CONTRAST
                    mon.set_luminance(0)
                    for c in range(100, -1, -CONTRAST_STEP):
                        mon.set_contrast(c)
                        contrast[c // CONTRAST_STEP] = max(
                            0.0, self._sample() - baseline
                        )
                        tick(f"Contrast sweep {c}%")
                finally:
                    self.square.emit(False)
                    mon.set_luminance(orig_b)
                    mon.set_contrast(orig_c)

            self.done.emit(
                Calibration(bright, contrast, self.cal_contrast, baseline)
            )
        except Cancelled:
            self.failed.emit("Calibration cancelled")
        except Exception as e:
            self.failed.emit(str(e))

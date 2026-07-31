# open-lux

[![CI](https://github.com/TathSikdar/open-lux/actions/workflows/ci.yml/badge.svg)](https://github.com/TathSikdar/open-lux/actions/workflows/ci.yml)
[![Licence: GPL-3.0](https://img.shields.io/badge/licence-GPL--3.0-blue.svg)](LICENSE)

Automatic monitor brightness driven by a real light sensor, for DDC/CI displays
(HDMI & DisplayPort) on **Windows and Linux**.

An Arduino reports the ambient light level once a second. A desktop app
**measures** what each of your displays actually emits, then drives every
calibrated display to match the room. Displays you have not calibrated are
never touched.

<img src="docs/schematics.png" width="420" alt="LDR divider wiring">

## Hardware

| Part | Notes |
|---|---|
| Arduino Nano / Uno / ESP8266 / ESP32 | A Nano is plenty; anything bigger is just more to hide |
| LDR | GL5506 (2k-5k). Higher values are overkill unless you drop the resistor |
| Resistor | 5.1k. Higher resistances give finer resolution |

Wire the LDR and the resistor as a divider into an analog pin, per
`docs/schematics.png`.

## Install

```
pip install .
openlux
```

Flash `firmware/firmware.ino` first, setting `SENSOR_PIN` to the pin your
divider feeds.

`openlux --fake` runs the whole app against a simulated sensor, which is handy
for finding your way around before the hardware is built. `python -m openlux`
works too, if you would rather see the console output.

## How it works

```
Arduino --raw ADC, 1 Hz on change--> lux --> smoothing
                                              |
                             response curve: ambient lux -> target luminance
                                              |
                    +-------------------------+-------------------------+
            invert display A's        invert display B's        (uncalibrated)
             measured table            measured table                   |
                    |                         |                      skipped
              brightness 42%            brightness 67%
```

The Arduino sends nothing but the raw sensor reading, so the LDR constants, the
response curve and every per-display table live on the PC and can be changed
without reflashing.

Because each display is inverted through **its own measured table**, two
monitors with different maximum brightness get different percentages and end up
looking the same - which is the whole reason calibration exists.

## The four screens

**Home** - the current ambient reading, a brightness knob (one for everything,
or one per display), and the ExtraDim toggle. Moving a knob takes effect
immediately and holds until the room's light actually changes; with auto-learn
on, it also teaches the curve what you wanted at that light level.

**Calibrate** - per display, and required before open-lux will touch it. Drag
the window onto the display, hold the LDR flat against the white square, and
press Ready. The app sweeps brightness 0-100% one point at a time, then sweeps
contrast, recording what the sensor reads at each step. It measures a baseline
first, so the table describes the *display* and not the room.

Takes about three minutes per display - the sensor only reports once a second,
and each step waits for a reading taken after the change. Once per monitor.

**ExtraDim** - at 0% brightness a display can still get darker by dropping
contrast. Set the minimum contrast you will tolerate and watch the dim end of
the curve extend down to meet it. The purple stretch of the graph is where
contrast has taken over from brightness.

**Settings** - one knob or one per display; auto-learn on/off, and whether it
learns per display or from the average of both; the response curve, which you
can drag point by point and save; the serial port; and the LDR constants.

Auto-learn nudges the curve toward the brightness you chose, weighted by how
close the room's light is to where you chose it - a correction made at night
does not drag your daytime settings with it.

Config lives in `%APPDATA%\open-lux\config.json` (Windows) or
`~/.config/open-lux/config.json` (Linux).

## Tray

Closing the window hides it to the tray; Quit from the tray menu really exits.
The tray menu also has an Automatic brightness switch, for when you want to be
left alone.

On Linux this needs a StatusNotifierItem host - most desktops have one, but
GNOME needs the AppIndicator extension. Without it the window simply stays a
window.

## Development

```
pip install -e ".[dev]"
pytest
```

`tests/test_core.py` covers the lux maths, the curve, table inversion and
learning. `tests/test_calibration.py` drives the real sweep and the real window
against a simulated panel, so the three-minute calibration and the DDC writes
are both exercised without hardware. On a headless machine set
`QT_QPA_PLATFORM=offscreen`.

```
open-lux/
├── firmware/
│   └── firmware.ino            Arduino sketch (the name has to match its folder -
│                               that is the IDE's rule, not ours)
├── openlux/
│   ├── core.py                 lux maths, curve, calibration tables, learning
│   ├── hardware.py             serial reader, DDC writer, calibration sweep
│   ├── curve.py                the drag-editable graph widget
│   ├── ui.py                   window, tray, the four screens
│   └── style.qss               theme
├── tests/
└── docs/
```

`core.py` imports no Qt, which is what lets the maths be tested on its own.

## Notes and limits

- **DDC/CI external displays only.** Laptop internal panels have no DDC and no
  contrast control, so ExtraDim could not work on them anyway.
- **Displays are identified by model + position.** Two identical monitors will
  swap calibrations if you replug them in a different order; recalibrate, or
  swap the entries in the config.
- **The lux figures are approximate.** They come from the LDR's power law with
  tunable constants, and the absolute scale never has to be right - the
  calibration tables and the curve are measured in the same units, so it
  cancels out.

## History

This started as a 43-line project: the Arduino applied a quadratic curve fitted
by hand to one Dell P2419H, and a Python script scanned COM0-COM49 and pushed
the result at every display at once. The old formula is still in the git history
if you want it.

## Licence

GPL-3.0-or-later. See [LICENSE](LICENSE).

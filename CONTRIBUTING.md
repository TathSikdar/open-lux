# Contributing to open-lux

Bug reports, calibration results from monitors I don't own, and patches are all
welcome. The project is small; there is no ceremony.

## Getting set up

```
git clone https://github.com/TathSikdar/open-lux.git
cd open-lux
pip install -e ".[dev]"
pytest
```

You do not need the hardware to work on most of this. `openlux --fake` runs the
whole app against a simulated light sensor, and the test suite drives a
simulated panel, so calibration, learning and the graphs can all be exercised
on a laptop with nothing plugged in.

## Reporting a bug

The useful details are: your OS, your monitor model, and whether the display is
connected over HDMI or DisplayPort. If it's a brightness or contrast problem,
say whether `ddcutil detect` (Linux) or another DDC tool can see and control the
monitor at all — a good half of the failures in this space are the monitor's
DDC/CI implementation, not ours.

If calibration produced a strange curve, the relevant table is in
`config.json` (`%APPDATA%\open-lux\` or `~/.config/open-lux/`). Pasting it into
the issue helps a lot.

## Making a change

- **Run `pytest` before opening a PR.** CI runs it on Windows and Linux, for
  Python 3.9 and 3.13.
- **If you change the maths, add a case to `tests/test_core.py`.** That file
  imports no Qt and has no framework — plain `assert`s, and every function
  starting with `test_` runs. Keep it that way.
- **If you change the calibration sweep or the window wiring, check
  `tests/test_calibration.py` still passes.** It drives the real
  `CalibrationWorker` and the real `MainWindow` against a simulated panel. It
  already caught one genuine bug (a baseline measured at the wrong brightness),
  which is the reason it exists.
- **Match the surrounding style.** Comments explain *why*, not what. There is
  no linter config and no formatter to appease.

## Things worth knowing before you change them

**`core.py` imports no Qt, deliberately.** All the maths — lux conversion, the
curve, table inversion, learning — lives there so it can be tested without a
display server. Please don't reach for `PySide6` in it.

**Calibration tables are measurements, not settings.** If you change what a
sweep records or how it's indexed, existing users' `config.json` files become
wrong rather than merely outdated, and they'll have to recalibrate every
display. Bump the shape constants in `core.py` and handle the old format, or
say so loudly in the PR.

**An uncalibrated display must never be written to.** That's the one rule the
whole design rests on: the app only touches monitors it has actually measured.

**Contrast is only for ExtraDim.** Above the brightness floor, contrast stays
at whatever the display was calibrated at. Using it as a general dimming knob
would wreck the calibration tables' meaning.

## Hardware notes

The Arduino sketch is intentionally almost empty — it reports a raw ADC value
once a second and nothing else. Resist putting logic in it. Anything it decides
is something the user has to reflash to change, which is exactly the problem the
current design exists to fix.

If you're adding support for a different sensor, the conversion belongs in
`adc_to_lux()` in `core.py`, with its constants exposed in Settings.

## Licence

open-lux is GPL-3.0-or-later. By contributing you agree your work ships under
the same licence. New files should carry the SPDX header the existing ones do:

```python
# SPDX-License-Identifier: GPL-3.0-or-later
```

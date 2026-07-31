# Contributing to open-lux

Bug reports, calibration results from monitors I don't own, and patches are all
welcome. The project is small; there is no ceremony.

## Getting set up

```
git clone https://github.com/TathSikdar/open-lux.git
cd open-lux
npm install
npm test
```

You do not need the hardware to work on most of this. `npm run fake` runs the
whole app against a simulated light sensor, and the test suite drives a
simulated panel, so calibration, learning and the graphs can all be exercised
on a laptop with nothing plugged in.

On Windows, `npm install` compiles the DDC/CI binding and so wants the *Desktop
development with C++* workload from Visual Studio. Without it the build is
skipped and the app reports *No DDC/CI displays detected* — which is fine for
working on anything but the DDC layer itself.

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

- **Run `npm test` before opening a PR.** CI runs it on Windows and Linux, for
  Node 22 and 24.
- **If you change the maths, add a case to `test/core.test.js`.** It uses
  `node:test` and `node:assert` — no framework to install, no config. Keep it
  that way.
- **If you change the calibration sweep or the control loop, check
  `test/calibration.test.js` still passes.** It drives the real
  `CalibrationRun` and the real `Controller` against a simulated panel. It
  already caught one genuine bug (a baseline measured at the wrong brightness),
  which is the reason it exists.
- **Match the surrounding style.** Comments explain *why*, not what. There is
  no linter config and no formatter to appease.

## Things worth knowing before you change them

**`core.js` and `controller.js` import nothing at all, deliberately.** Not
electron, not even node. All the maths — lux conversion, the curve, table
inversion, learning — plus the control loop live there so they can be tested
under bare `node --test`, and so the main process and the renderer can load the
same file. Please don't reach for `electron` or `node:` in either.

**Calibration tables are measurements, not settings.** If you change what a
sweep records or how it's indexed, existing users' `config.json` files become
wrong rather than merely outdated, and they'll have to recalibrate every
display. Bump the shape constants in `core.js` and handle the old format, or
say so loudly in the PR.

**An uncalibrated display must never be written to.** That's the one rule the
whole design rests on: the app only touches monitors it has actually measured.

**Contrast is only for ExtraDim.** Above the brightness floor, contrast stays
at whatever the display was calibrated at. Using it as a general dimming knob
would wreck the calibration tables' meaning.

**The renderer owns no truth.** `main.js` pushes `state` when the config or the
display list changes and `tick` on every sensor reading; every control sends an
action back and waits for the next push. No page keeps its own copy of the
config to be kept in sync. The one exception is a curve part-way through being
dragged, which is unsaved by definition and lives in `ui.js`.

**The icons are generated.** `src/icon.png` and `src/icon.ico` come out of
`src/icon.svg` via `npm run icon` — edit the SVG and re-run it, never the
rasters. The same SVG is the window icon, the tray icon, the installer icon and
the page favicon, so it has to stay legible at 16x16.

## Packaging

`electron-builder` builds the distributable app, configured by the `build` key
in `package.json`:

```
npx electron-builder        # -> dist/  (NSIS installer, or an AppImage)
```

Releases are cut by pushing a `v*` tag; the workflow builds both platforms and
attaches them. `version` in `package.json` is the source of truth — the
workflow refuses to build if the tag disagrees with it, because
electron-builder reads the version from there and would otherwise ship a
mislabelled installer.

## Hardware notes

The Arduino sketch is intentionally almost empty — it averages 128 analog reads
and prints the result, with decimals, ten times a second. Nothing else. Resist
putting logic in it: anything it decides is something the user has to reflash to
change, which is exactly the problem the current design exists to fix. The
oversampling is the one exception, and it earns its place — it is where the
extra bits in a dim room come from, and truncating the average back to an int
throws all of them away.

If you're adding support for a different sensor, the conversion belongs in
`adcToLux()` in `core.js`, with its constants exposed in Settings.

## Licence

open-lux is GPL-3.0-or-later. By contributing you agree your work ships under
the same licence. New files should carry the SPDX header the existing ones do:

```js
// SPDX-License-Identifier: GPL-3.0-or-later
```

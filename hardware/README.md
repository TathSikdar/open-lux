<div align="center">

# open-lux hardware

**The printable case for the sensor.**

Loose components on the desk work perfectly well — this is the version that
looks like it was meant to be there.

<img src="images/hero.jpg" width="720" alt="The printed sensor head and enclosure">

</div>

---

> **These files are not here yet.** This page is the shelf they land on. The
> parts below are the plan; the STLs, the photos and the timelapse follow once
> the first set comes off the printer.

## The parts

### Sensor head

<img src="images/sensor-head.jpg" width="420" align="right" alt="The sensor head">

Holds the LDR flat and square against the panel, which is the whole game during
calibration — a sensor at an angle, or one with a gap under it, reads the room
as well as the screen and quietly poisons the display's measured table.

Sized around a GL5506's 5mm body. The face is a shallow shroud that seals
against the glass; the cable exits from the back so nothing props it off the
screen.

<br clear="right">

### Board enclosure

<img src="images/enclosure.jpg" width="420" align="right" alt="The board enclosure">

A box for the Nano and the divider, with a slot for the USB connector and a
strain relief for the sensor lead. Nothing about it is electrically clever — it
exists so the thing you plug in once and forget is not a bare board with legs.

<br clear="right">

## Printing it

| | |
|---|---|
| **Material** | PLA is fine. PETG if it lives somewhere warm |
| **Layer height** | 0.2mm |
| **Infill** | 15% |
| **Supports** | None — the parts are oriented to avoid them |
| **Print time** | ~1h for the head, ~3h for the enclosure |

No part is load-bearing and nothing needs to be dimensionally perfect except
the LDR pocket. If yours prints tight, scale that part by a percent rather than
reslicing everything.

## Assembly

https://github.com/user-attachments/assets/REPLACE-WITH-UPLOADED-VIDEO

Drag the assembly clip into a GitHub issue or release, then paste the URL it
gives you over the line above — GitHub serves the video and the README plays it
inline, which keeps a few megabytes of MP4 out of the repository.

## Files

| File | What it is |
|---|---|
| `sensor-head.stl` | Print-ready |
| `enclosure.stl` | Print-ready |
| `*.step` | Source geometry, for editing in any CAD package |

## Licence

The printable files are released under
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) — remix them,
sell the prints, just keep the attribution and share changes alike. The
software in the rest of this repository stays GPL-3.0-or-later.

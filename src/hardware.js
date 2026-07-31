// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Tath Sikdar

/**
 * Everything that talks to physical things: the Arduino over serial, and the
 * displays over DDC/CI.
 *
 * DDC writes take 50-200ms. In the Qt build that meant worker threads; here it
 * is enough that they are async and serialised behind one queue, because the
 * renderer is a separate process and was never going to block on them.
 *
 * Nothing in this file imports electron, so the sweep can be driven against a
 * simulated panel by test/calibration.test.js.
 */

import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { CONTRAST_STEP, Calibration, N_CONTRAST } from './core.js';

const require = createRequire(import.meta.url);
const run = promisify(execFile);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// USB vendor IDs of the usual Arduino / clone serial bridges.
const KNOWN_VIDS = new Set(['2341', '2a03', '1a86', '0403', '10c4', '1b4f']);

// --- serial -----------------------------------------------------------------

function serialport() {
  return require('serialport');
}

export async function availablePorts() {
  const { SerialPort } = serialport();
  const ports = await SerialPort.list();
  return ports.map((p) => ({
    device: p.path,
    label: `${p.path} - ${p.friendlyName || p.manufacturer || 'serial port'}`,
  }));
}

export async function guessPort() {
  const { SerialPort } = serialport();
  const ports = await SerialPort.list();
  for (const p of ports) {
    if (KNOWN_VIDS.has((p.vendorId || '').toLowerCase())) return p.path;
  }
  for (const p of ports) {
    if ((p.manufacturer || p.friendlyName || '').toLowerCase().includes('arduino')) return p.path;
  }
  return ports.length ? ports[0].path : null;
}

/**
 * Streams raw ADC readings. Reconnects forever instead of dying on the first
 * bad line, which is how the old script lost a working port.
 *
 * Emits:
 *   'reading'   (number)          fractional ADC counts, see firmware.ino
 *   'status'    (string)          human-readable, for the status line
 *   'connected' (?string)         the port on open, null on close/failure
 */
export class SerialReader extends EventEmitter {
  constructor(portOverride = '', baud = 9600) {
    super();
    this.portOverride = portOverride;
    this.baud = baud;
    this.running = true;
    this.port = null;
  }

  async start() {
    let backoff = 1000;
    while (this.running) {
      const path = this.portOverride || (await guessPort().catch(() => null));
      if (!path) {
        this.emit('connected', null);
        this.emit('status', 'No serial ports found');
        await this._nap(backoff);
        backoff = Math.min(backoff * 2, 10000);
        continue;
      }
      try {
        await this._session(path);
        backoff = 1000;
      } catch (e) {
        this.emit('connected', null);
        this.emit('status', `${path}: ${e.message}`);
        await this._nap(backoff);
        backoff = Math.min(backoff * 2, 10000);
      }
    }
  }

  _session(path) {
    const { SerialPort } = serialport();
    const { ReadlineParser } = require('@serialport/parser-readline');

    return new Promise((resolve, reject) => {
      const port = new SerialPort({ path, baudRate: this.baud }, (err) => {
        if (err) return reject(err);
        this.emit('connected', path);
        this.emit('status', `Connected to ${path}`);
      });
      this.port = port;

      port.pipe(new ReadlineParser({ delimiter: '\n' })).on('data', (line) => {
        // parseFloat, not parseInt: the firmware oversamples and sends decimals.
        const n = Number.parseFloat(line.trim());
        if (Number.isFinite(n)) this.emit('reading', n);
        // else: boot noise / partial line, keep the port
      });

      port.on('error', reject);
      port.on('close', () => {
        this.port = null;
        this.emit('connected', null);
        resolve();
      });
    });
  }

  async _nap(ms) {
    const end = Date.now() + ms;
    while (this.running && Date.now() < end) await sleep(100);
  }

  stop() {
    this.running = false;
    this.port?.close(() => {});
  }
}

/**
 * --fake: a synthetic day/night cycle so the GUI, calibration flow and graphs
 * can be driven with no hardware attached.
 */
export class FakeReader extends EventEmitter {
  constructor() {
    super();
    this.running = true;
  }

  async start() {
    this.emit('connected', 'a simulated port');
    this.emit('status', 'Simulated sensor (--fake)');
    let t = 0.0;
    while (this.running) {
      this.emit('reading', 511.5 + 480 * Math.sin(t));
      t += 0.02;
      await sleep(100);
    }
  }

  stop() {
    this.running = false;
    this.emit('connected', null);
  }
}

// --- displays ---------------------------------------------------------------

function ddcci() {
  return require('@hensm/ddcci');
}

/** Two identical panels need telling apart; a lone one does not need a number. */
function dedupe(list) {
  return list.map((d) =>
    list.filter((o) => o.name === d.name).length > 1
      ? { ...d, name: `${d.name} (${d.index + 1})` }
      : d,
  );
}

/**
 * Windows: a raw ddcci monitor-id list, named and numbered.
 *
 * The id is a device path that carries the PnP id (\\?\DISPLAY#SAM7089#...) --
 * the manufacturer code plus product code the panel reports for itself. The
 * marketing name ("S24F350") would need the EDID out of the registry or WMI;
 * this is one regex, and the user can rename it anyway.
 * @param {!Array<string>} ids
 */
export function nameMonitors(ids) {
  return dedupe(
    ids.map((id, i) => ({
      index: i,
      key: id,
      name: id.match(/DISPLAY#([^#]+)#/)?.[1] ?? `Display ${i + 1}`,
      id,
    })),
  );
}

/**
 * Detected DDC/CI monitors. Laptop internal panels have no DDC and will not
 * show up -- that is the same scope the project always had.
 *
 * The name is the monitor's own, off its EDID, not "Display 1": on a desk with
 * two panels the number says nothing about which is which. cfg.names overrides
 * it, and main.js applies that on the way to the renderer.
 */
export async function enumerateDisplays() {
  // ponytail: the ddcci id already carries the monitor's device path, so unlike
  // the Qt build's model+index key this survives a replug in a different order.
  // Kept as the key verbatim.
  if (process.platform === 'win32') return nameMonitors(ddcci().getMonitorList());

  // ddcutil detect prints a stanza per bus; "Display N" then a Model line.
  const { stdout } = await run('ddcutil', ['detect', '--brief']);
  const out = [];
  for (const block of stdout.split(/\n(?=Display )/)) {
    const bus = block.match(/I2C bus:\s+\/dev\/i2c-(\d+)/)?.[1];
    if (!bus) continue;
    const model = block.match(/Monitor:\s+[^:]*:([^:]*):/)?.[1]?.trim() || 'Display';
    out.push({
      index: out.length,
      key: `${model}#${bus}`,
      name: model,
      id: bus,
    });
  }
  return dedupe(out);
}

/**
 * DDC/CI over I2C is not a reliable link, and a marginal monitor is the normal
 * case rather than a broken one -- a long cable, a KVM, or a cheap scaler is
 * enough. Such a panel drops most requests and reports a *different* error each
 * time ("invalid value in its command field", "error transmitting on the I2C
 * bus"), which reads like an unsupported feature but is not: the same code
 * answers fine on the next attempt.
 *
 * Measured on a SAM7089 that failed calibration: 7/15 bare reads succeeded,
 * 24/25 through this. The HP beside it was 15/15 either way, so the cost is
 * paid only by the display that needs it.
 *
 * Retrying a set is safe -- writing the same VCP value twice is idempotent.
 *
 * ponytail: fixed count, no backoff. The drops are not congestion; wider gaps
 * (50-200ms) measured no better than 25ms.
 */
export async function retry(fn, tries = 15, gap = 25) {
  for (let i = 1; ; i++) {
    try {
      return fn();
    } catch (e) {
      if (i >= tries) throw e;
      await sleep(gap);
    }
  }
}

/** A live handle to one display. All four calls are async and may throw. */
export function openDisplay(info) {
  if (process.platform === 'win32') {
    const d = ddcci();
    return {
      getLuminance: () => retry(() => d.getBrightness(info.id)),
      setLuminance: (v) => retry(() => d.setBrightness(info.id, Math.round(v))),
      getContrast: () => retry(() => d.getContrast(info.id)),
      setContrast: (v) => retry(() => d.setContrast(info.id, Math.round(v))),
    };
  }

  const get = async (code) => {
    const { stdout } = await run('ddcutil', ['--bus', info.id, '--brief', 'getvcp', code]);
    return Number(stdout.trim().split(/\s+/)[3]); // VCP <code> C <current> <max>
  };
  const set = (code, v) =>
    run('ddcutil', ['--bus', info.id, 'setvcp', code, String(Math.round(v))]);

  return {
    getLuminance: () => get('10'),
    setLuminance: (v) => set('10', v),
    getContrast: () => get('12'),
    setContrast: (v) => set('12', v),
  };
}

/**
 * Blinks one panel's backlight so the user can see which physical monitor a DDC
 * entry is. A DDC device path cannot be mapped to an OS display -- ddcci gives
 * no geometry and electron's screen gives no device path -- so the panel itself
 * has to answer the question.
 *
 * `display` is an openDisplay() handle. Full 0-100 swing: a blink around the
 * current value is invisible on an already-dim panel, and being missed is the
 * one way this fails.
 */
export async function identifyDisplay(display, times = 3, ms = 300) {
  const orig = await display.getLuminance();
  try {
    for (let i = 0; i < times; i++) {
      await display.setLuminance(0);
      await sleep(ms);
      await display.setLuminance(100);
      await sleep(ms);
    }
  } finally {
    await display.setLuminance(orig).catch(() => {});
  }
}

/**
 * Applies brightness/contrast, newest target wins.
 *
 * ponytail: one queue serialises writes to every monitor. Split per-monitor if
 * one slow panel starts holding up the others.
 */
export class DisplayWriter extends EventEmitter {
  constructor() {
    super();
    this.pending = new Map(); // key -> { info, brightness, contrast }
    this.last = new Map(); // key -> [brightness, contrast]
    this.running = true;
  }

  submit(info, brightness, contrast) {
    this.pending.set(info.key, {
      info,
      brightness: Math.round(brightness),
      contrast: Math.round(contrast),
    });
  }

  /**
   * Drop the write-skipping cache so the next submit is applied even if the
   * value looks unchanged (after a calibration moved things behind us).
   */
  forget(key = null) {
    if (key === null) this.last.clear();
    else this.last.delete(key);
  }

  async start() {
    while (this.running) {
      const batch = this.pending;
      this.pending = new Map();
      for (const [key, { info, brightness, contrast }] of batch) {
        const prev = this.last.get(key);
        if (prev && prev[0] === brightness && prev[1] === contrast) continue;
        try {
          const mon = openDisplay(info);
          await mon.setLuminance(brightness);
          if (!prev || prev[1] !== contrast) await mon.setContrast(contrast);
          this.last.set(key, [brightness, contrast]);
        } catch (e) {
          this.emit('status', `${info.name}: ${e.message}`);
        }
      }
      await sleep(250);
    }
  }

  stop() {
    this.running = false;
  }
}

// --- calibration ------------------------------------------------------------

export class Cancelled extends Error {}

/**
 * Sweeps one display and measures what it actually emits.
 *
 * Brightness 0-100 in steps of 1, then contrast 100-0 in steps of 5, dwelling
 * at each step so the panel and the sensor both settle.
 *
 * `display` is an openDisplay() handle -- the test passes a simulated panel.
 */
export class CalibrationRun extends EventEmitter {
  constructor(display, calContrast, readLux, readSeq, dwell = 0.5) {
    super();
    this.display = display;
    this.calContrast = Math.round(calContrast);
    this.readLux = readLux;
    this.readSeq = readSeq;
    this.dwell = dwell;
    this.running = true;
  }

  cancel() {
    this.running = false;
  }

  async _wait(seconds) {
    const end = Date.now() + seconds * 1000;
    while (this.running && Date.now() < end) await sleep(Math.min(20, end - Date.now()));
    return this.running;
  }

  /**
   * Dwell for the panel to settle, then wait for a sensor report that actually
   * arrived after the change -- the Arduino only speaks once a second, so the
   * value sitting there mid-dwell is the previous step's.
   */
  async _sample(mult = 1.0) {
    const seq0 = this.readSeq();
    if (!(await this._wait(this.dwell * mult))) throw new Cancelled();
    const deadline = Date.now() + 3000;
    while (this.running && this.readSeq() === seq0 && Date.now() < deadline) await sleep(20);
    if (!this.running) throw new Cancelled();
    return this.readLux();
  }

  async run() {
    const steps = 101 + N_CONTRAST + 2;
    let step = 0;
    const tick = (label) => this.emit('progress', Math.round((100 * ++step) / steps), label);

    const mon = this.display;
    const origB = await mon.getLuminance();
    const origC = await mon.getContrast();
    let bright, contrast;

    try {
      // Baseline with the square black at the dimmest setting: room light plus
      // the panel's own black level, which is the floor every later sample
      // sits on top of.
      this.emit('square', false);
      await mon.setContrast(this.calContrast);
      await mon.setLuminance(0);
      tick('Measuring baseline');
      const baseline = await this._sample(2.0);

      this.emit('square', true);
      tick('Settling');
      await this._sample();

      bright = [];
      for (let b = 0; b <= 100; b++) {
        await mon.setLuminance(b);
        bright.push(Math.max(0.0, (await this._sample()) - baseline));
        tick(`Brightness sweep ${b}%`);
      }

      contrast = new Array(N_CONTRAST).fill(0.0);
      await mon.setLuminance(0);
      for (let c = 100; c >= 0; c -= CONTRAST_STEP) {
        await mon.setContrast(c);
        contrast[c / CONTRAST_STEP] = Math.max(0.0, (await this._sample()) - baseline);
        tick(`Contrast sweep ${c}%`);
      }

      return new Calibration({
        brightLux: bright,
        contrastLux: contrast,
        calContrast: this.calContrast,
        ambientOffset: baseline,
      });
    } finally {
      this.emit('square', false);
      await mon.setLuminance(origB).catch(() => {});
      await mon.setContrast(origC).catch(() => {});
    }
  }
}

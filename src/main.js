// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Tath Sikdar

/**
 * The Electron main process: window, tray, config file, and the wiring between
 * the hardware layer and the renderer.
 *
 * The renderer never touches serial or DDC. It sends actions over IPC and gets
 * two things back: `state` when the config or the display list changes, and
 * `tick` on every sensor reading. Splitting those is what keeps the several-kB
 * calibration tables from being serialised once a second.
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BrowserWindow, Menu, Tray, app, ipcMain, nativeTheme, shell } from 'electron';

import { calibrationOf, curveOf, defaultYs, defaultYsFor, withDefaults } from './core.js';
import { Controller } from './controller.js';
import {
  CalibrationRun,
  DisplayWriter,
  FakeReader,
  SerialReader,
  availablePorts,
  enumerateDisplays,
  identifyDisplay,
  openDisplay,
} from './hardware.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = process.argv.includes('--fake');

app.setName('open-lux');

let win = null;
let tray = null;
let reader = null;
let writer = null;
let ctl = null;
let calRun = null;
let identifying = false;
let cfg = null;
let quitting = false;
let status = 'Waiting for sensor';

/**
 * What the Home screen's connection indicator is drawn from. `at` is the last
 * reading's timestamp, because an open port that has gone quiet is a different
 * fault from a port that will not open, and the user needs to tell them apart.
 */
const sensor = { connected: false, port: '', at: 0 };

// --- config -----------------------------------------------------------------

const configPath = () => path.join(app.getPath('userData'), 'config.json');

/** snake_case -> camelCase, for a config written by the Qt build. Display-keyed
 *  maps (calibrations, gains) are left alone: their keys are display identities,
 *  not field names -- and those identities changed, so old calibrations will not
 *  match and the user has to re-measure regardless. The curve and the LDR
 *  constants are the tuning worth carrying over. */
function migrate(data) {
  const out = {};
  for (const [k, v] of Object.entries(data ?? {})) {
    out[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = v;
  }
  return out;
}

async function loadConfig() {
  try {
    return withDefaults(migrate(JSON.parse(await readFile(configPath(), 'utf8'))));
  } catch {
    return withDefaults({});
  }
}

/** Atomic write -- a half-written config would cost the user a 60s calibration
 *  sweep per display. */
let saving = null;
async function saveConfig() {
  const p = configPath();
  await mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  await writeFile(tmp, JSON.stringify(cfg, null, 2), 'utf8');
  await rename(tmp, p);
}

/** Coalesce bursts of saves (a dragged slider fires many). */
function save() {
  clearTimeout(saving);
  saving = setTimeout(() => saveConfig().catch((e) => setStatus(`Config: ${e.message}`)), 300);
}

// --- pushing to the renderer ------------------------------------------------

const send = (channel, payload) => win?.webContents.send(channel, payload);

function pushState() {
  if (!ctl) return;
  send('state', {
    cfg,
    // The user's name wins over the hardware's everywhere downstream: sliders,
    // the calibrate dropdown, the wizard. Renaming is the only reason a display
    // is ever called anything but what it reports.
    displays: ctl.displays.map(({ index, key, name }) => ({
      index,
      key,
      name: cfg.names[key] || name,
      hwName: name, // what it is called with the override cleared
      calibrated: !!calibrationOf(cfg, key),
    })),
    curveYs: ctl.curve.ys,
    status,
  });
}

function pushTick() {
  send('tick', {
    ambientLux: ctl?.ambientLux ?? null,
    levels: ctl?.lastLevels ?? {},
    contrast: ctl?.lastContrast ?? {},
    status,
    sensor: {
      connected: sensor.connected,
      port: sensor.port,
      ageMs: sensor.at ? Date.now() - sensor.at : null,
    },
  });
}

function setStatus(text) {
  status = text;
  pushTick();
}

// --- hardware wiring --------------------------------------------------------

function restartReader() {
  reader?.stop();
  reader = FAKE ? new FakeReader() : new SerialReader(cfg.serialPort);
  sensor.connected = false;
  sensor.at = 0;
  reader.on('status', setStatus);
  reader.on('connected', (port) => {
    sensor.connected = !!port;
    sensor.port = port ?? '';
    if (!port) sensor.at = 0;
    pushTick();
  });
  reader.on('reading', (adc) => {
    sensor.at = Date.now();
    ctl.onReading(adc);
    pushTick();
  });
  reader.start().catch((e) => setStatus(`Sensor: ${e.message}`));
}

async function refreshDisplays() {
  try {
    ctl.displays = await enumerateDisplays();
  } catch (e) {
    ctl.displays = [];
    setStatus(`No displays: ${e.message}`);
  }
  pushState();
}

// --- window and tray --------------------------------------------------------

function applyTheme() {
  nativeTheme.themeSource = cfg.theme; // "system" | "light" | "dark"
}

function createWindow() {
  win = new BrowserWindow({
    width: cfg.winW,
    height: cfg.winH,
    minWidth: 560,
    minHeight: 220,
    show: !cfg.startMinimized,
    title: 'open-lux',
    icon: path.join(here, 'icon.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0c0c0d' : '#f7f4ef',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(here, 'index.html'));
  win.webContents.on('did-finish-load', () => {
    pushState();
    pushTick();
  });

  // External links (the About/repo link) belong in the user's browser, not in
  // a chrome-less Electron window they cannot navigate back out of.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('resize', () => {
    const [w, h] = win.getSize();
    cfg.winW = w;
    cfg.winH = h;
    save();
  });

  win.on('close', (e) => {
    if (quitting || !tray) return;
    e.preventDefault();
    win.hide(); // to tray; Quit from the tray menu really exits
  });
}

function createTray() {
  try {
    tray = new Tray(path.join(here, 'icon.png'));
  } catch {
    tray = null; // no system tray: closing the window then really quits
    return;
  }
  tray.setToolTip('open-lux');

  const menu = Menu.buildFromTemplate([
    { label: 'Show', click: () => showWindow() },
    {
      label: 'Automatic brightness',
      type: 'checkbox',
      checked: true,
      click: (item) => {
        ctl.autoEnabled = item.checked;
        if (item.checked) ctl.applyNow();
        pushTick();
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', showWindow);
}

function showWindow() {
  win.show();
  win.focus();
}

// --- IPC --------------------------------------------------------------------

function submitToDisplay(index, brightness, contrast) {
  const info = ctl.displays.find((d) => d.index === index);
  if (info) writer.submit(info, brightness, contrast);
}

function registerIpc() {
  ipcMain.handle('config:patch', async (_e, patch) => {
    const reader_affecting = 'serialPort' in patch;
    Object.assign(cfg, patch);
    save();

    if ('theme' in patch) applyTheme();
    if ('curveYs' in patch) ctl.curve = curveOf(cfg);
    if ('extradim' in patch || 'minContrast' in patch) writer.forget();
    if (reader_affecting) restartReader();

    ctl.applyNow();
    pushState();
    pushTick();
  });

  ipcMain.handle('curve:reset', async () => {
    cfg.curveYs = defaultYsFor(cfg);
    cfg.gains = {};
    ctl.curve = curveOf(cfg);
    save();
    ctl.applyNow();
    pushState();
  });

  ipcMain.handle('displays:refresh', () => refreshDisplays());
  ipcMain.handle('ports:list', () => availablePorts().catch(() => []));

  // Blinking a panel is the only way to say which physical monitor a DDC entry
  // is; see identifyDisplay(). It drives the panel behind the writer's back, so
  // it takes the same hands-off flag and cache reset the sweep does.
  ipcMain.handle('identify:start', async (_e, index) => {
    if (calRun || identifying) return;
    const info = ctl.displays.find((d) => d.index === index);
    if (!info) return;

    identifying = true;
    ctl.calibrating = true;
    try {
      await identifyDisplay(openDisplay(info));
    } catch (e) {
      setStatus(`${info.name}: ${e.message}`);
    } finally {
      identifying = false;
      ctl.calibrating = false;
      writer.forget(info.key);
      ctl.applyNow();
    }
  });

  ipcMain.handle('manual:preview', (_e, { key, pct, contrast }) =>
    ctl.manualPreview(key, pct, contrast),
  );
  ipcMain.handle('manual:commit', (_e, { key, pct, contrast }) => {
    ctl.manualCommit(key, pct, contrast);
    pushState();
  });

  ipcMain.handle('calibrate:start', async (_e, { index, contrast }) => {
    if (calRun || identifying) return;
    const info = ctl.displays.find((d) => d.index === index);
    if (!info) return;

    cfg.calContrast = contrast;
    ctl.calibrating = true;
    calRun = new CalibrationRun(
      openDisplay(info),
      contrast,
      () => ctl.rawLux,
      () => ctl.readingSeq,
    );
    calRun.on('progress', (pct, label) => send('calibrate:progress', { pct, label }));
    calRun.on('square', (white) => send('calibrate:square', white));

    try {
      const cal = await calRun.run();
      cfg.calibrations[info.key] = cal.toJSON();

      // A curve still at its factory shape was drawn for no panel in
      // particular. Now that one has been measured, redraw it for the range
      // that panel actually has -- but only while it is untouched, or a first
      // calibration would throw away a curve the user had already tuned.
      const generic = defaultYs();
      if (cfg.curveYs.every((y, i) => Math.abs(y - generic[i]) < 1e-9)) {
        cfg.curveYs = defaultYsFor(cfg);
        ctl.curve = curveOf(cfg);
      }
      save();
      writer.forget(info.key);
      send('calibrate:done', {
        minLux: cal.minLux,
        maxLux: cal.maxLux,
        floor: cal.extradimFloor(cfg.minContrast),
        hasContrast: cal.contrastLux.length > 0,
      });
    } catch (e) {
      send('calibrate:failed', e instanceof Error ? e.message : String(e));
    } finally {
      calRun = null;
      ctl.calibrating = false;
      pushState();
      ctl.applyNow();
    }
  });

  ipcMain.handle('calibrate:cancel', () => calRun?.cancel());
}

// --- lifecycle --------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => win && showWindow());

  app.whenReady().then(async () => {
    cfg = await loadConfig();
    applyTheme();

    writer = new DisplayWriter();
    writer.on('status', setStatus);
    writer.start();

    ctl = new Controller(cfg, submitToDisplay, save);

    registerIpc();
    createWindow();
    createTray();
    await refreshDisplays();
    restartReader();

    // A sensor that stops reporting sends nothing, so the indicator has to be
    // driven by a clock rather than by the data it is waiting for.
    setInterval(pushTick, 1000).unref?.();

    // The OS switching at sunset should switch the app with it. CSS already
    // reacts on its own; this is only here to repaint the window chrome.
    nativeTheme.on('updated', () => pushState());
  });

  app.on('before-quit', () => {
    quitting = true;
    reader?.stop();
    writer?.stop();
    calRun?.cancel();
    clearTimeout(saving);
    saveConfig().catch(() => {});
  });

  // A tray app outlives its window; without a tray it should not.
  app.on('window-all-closed', () => {
    if (!tray || process.platform !== 'darwin') app.quit();
  });
}

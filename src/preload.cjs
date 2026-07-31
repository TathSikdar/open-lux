// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Tath Sikdar

// .cjs, not .js: package.json sets "type": "module", and a sandboxed preload
// has to be CommonJS. It is also the only file that needs to be.

const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (fn) => {
  ipcRenderer.on(channel, (_e, payload) => fn(payload));
};

// Deliberately a fixed list of named calls rather than a generic invoke(): the
// renderer gets exactly the actions it needs and nothing else reaches ipcMain.
contextBridge.exposeInMainWorld('openlux', {
  patchConfig: (patch) => ipcRenderer.invoke('config:patch', patch),
  resetCurve: () => ipcRenderer.invoke('curve:reset'),
  refreshDisplays: () => ipcRenderer.invoke('displays:refresh'),
  listPorts: () => ipcRenderer.invoke('ports:list'),
  identifyDisplay: (index) => ipcRenderer.invoke('identify:start', index),
  // contrast: null lets the control loop derive one from the brightness; the
  // ExtraDim slider passes a number, and that one is driven as given.
  previewManual: (key, pct, contrast = null) =>
    ipcRenderer.invoke('manual:preview', { key, pct, contrast }),
  commitManual: (key, pct, contrast = null) =>
    ipcRenderer.invoke('manual:commit', { key, pct, contrast }),
  startCalibration: (index, contrast) =>
    ipcRenderer.invoke('calibrate:start', { index, contrast }),
  cancelCalibration: () => ipcRenderer.invoke('calibrate:cancel'),

  onState: on('state'),
  onTick: on('tick'),
  onCalibrationProgress: on('calibrate:progress'),
  onCalibrationSquare: on('calibrate:square'),
  onCalibrationDone: on('calibrate:done'),
  onCalibrationFailed: on('calibrate:failed'),
});

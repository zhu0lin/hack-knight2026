'use strict';

require('@smartspectra/node-sdk/preload');

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vv', {
  getConfig: () => ipcRenderer.invoke('vv:config'),
  hostGame: () => ipcRenderer.invoke('vv:host'),
  log: (message) => ipcRenderer.send('vv:log', message),
});

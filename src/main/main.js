'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, ipcMain, session, systemPreferences } = require('electron');
const { bindSmartSpectraIpc } = require('@smartspectra/node-sdk/main');
const { createGameServer } = require('../server/game-server');

const ROOT = path.join(__dirname, '..', '..');

function loadDotEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (!match || line.trim().startsWith('#')) continue;
    if (process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
    }
  }
}

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((iface) => iface && iface.family === 'IPv4' && !iface.internal)
    .map((iface) => iface.address);
}

loadDotEnv();

if (process.env.VV_PROFILE) {
  app.setPath('userData', path.join(app.getPath('userData'), `profile-${process.env.VV_PROFILE}`));
}

const port = Number(process.env.VV_PORT) || 7777;
let gameServer = null;

ipcMain.handle('vv:config', () => {
  const apiKey = process.env.PRESAGE_API_KEY || '';
  return {
    apiKey,
    sim: process.env.VV_SIM === '1' || !apiKey,
    missingKey: !apiKey,
    port,
  };
});

ipcMain.on('vv:log', (_event, message) => {
  if (typeof message !== 'string') return;
  console.log(message.slice(0, 500));
});

ipcMain.handle('vv:host', async () => {
  if (!gameServer) {
    console.log(`[vital-verdict] starting game server on port ${port}`);
    gameServer = createGameServer({ port });
    await gameServer.ready;
  }
  const addresses = lanAddresses();
  console.log(`[vital-verdict] host ready; others join at ${addresses.map((addr) => `${addr}:${port}`).join(', ') || `localhost:${port}`}`);
  return { port, addresses };
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#0b0f1a',
    title: 'Vital Verdict',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: false,
    },
  });
  bindSmartSpectraIpc(win);
  win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
}

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    const url = (details && details.requestingUrl) || (wc && wc.getURL()) || '';
    callback(permission === 'media' && url.startsWith('file://'));
  });

  if (process.platform === 'darwin') {
    await systemPreferences.askForMediaAccess('camera').catch(() => false);
  }

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (gameServer) gameServer.close();
  app.quit();
});

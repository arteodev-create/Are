const { app, BrowserWindow, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const apiPort = 8787;
let mainWindow;
let apiHandle;

function resolveAppPath(...parts) {
  return path.join(app.getAppPath(), ...parts);
}

async function startApi() {
  const userData = app.getPath('userData');
  fs.mkdirSync(path.join(userData, 'uploads'), { recursive: true });
  process.chdir(userData);
  process.env.PORT = String(apiPort);
  process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'veritas-desktop-access-secret';
  process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'veritas-desktop-refresh-secret';

  const serverModule = await import(`file://${resolveAppPath('server', 'index.js').replace(/\\/g, '/')}`);
  apiHandle = await serverModule.startVeritasServer({ port: apiPort });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: '#ffffff',
    title: 'Veritas',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.loadFile(resolveAppPath('dist', 'index.html'));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    await startApi();
    createWindow();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    apiHandle?.wss?.close();
    apiHandle?.server?.close();
  });
}

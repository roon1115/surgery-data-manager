const { app, BrowserWindow, Menu, shell, dialog, ipcMain } = require('electron');
const path = require('path');

require('./settings-handler');
require('./history');
require('./ingest-handler');
require('./dicom-handler');
require('./updater');
require('./debug-flow');

const isMac = process.platform === 'darwin';
let mainWindow = null;

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 900,
    minHeight: 640,
    title: 'Surgery Data Manager',
    backgroundColor: '#0f172a',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'www', 'index.html'));

  // デバッグ: レンダラ側の console と uncaught error をメインに転送
  win.webContents.on('console-message', function() {
    // Electron バージョン間で引数形式が異なるので両形式に対応
    const a = arguments;
    let level, msg, ln, src;
    if (a.length >= 4 && typeof a[1] !== 'object') {
      // 旧 API: (event, level:number, message, line, sourceId)
      level = ['LOG','WARN','ERR','DEBUG'][a[1]] || 'LOG';
      msg = a[2]; ln = a[3]; src = a[4];
    } else {
      // 新 API: (event with .level, .message, .lineNumber, .sourceId)
      const ev = a[0] || {};
      level = String(ev.level || 'log').toUpperCase();
      msg = ev.message; ln = ev.lineNumber; src = ev.sourceId;
    }
    console.log(`[renderer ${level}] ${msg}  (${src}:${ln})`);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[renderer GONE]', details);
  });
  win.webContents.on('preload-error', (_e, preloadPath, error) => {
    console.error('[preload ERROR]', preloadPath, error);
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    const current = win.webContents.getURL();
    if (/^https?:\/\//i.test(url) && !url.startsWith(current)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow = win;
  win.on('closed', () => { mainWindow = null; });
}

ipcMain.handle('app:openExternal', async (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
    await shell.openExternal(url);
    return { ok: true };
  }
  return { ok: false, error: 'invalid url' };
});

ipcMain.handle('app:showFolder', async (_e, folderPath) => {
  if (typeof folderPath !== 'string' || !folderPath) return { ok: false };
  shell.showItemInFolder(folderPath);
  return { ok: true };
});

function buildMenu() {
  const updater = require('./updater');
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { label: 'アップデートを確認…', click: () => updater.checkForUpdate({ silent: false }) },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'ファイル',
      submenu: [
        ...(!isMac ? [
          { label: 'アップデートを確認…', click: () => updater.checkForUpdate({ silent: false }) },
          { type: 'separator' },
        ] : []),
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: '編集',
      submenu: [
        { role: 'undo' }, { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: '表示',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'ウィンドウ',
      submenu: [
        { role: 'minimize' }, { role: 'zoom' },
        ...(isMac ? [{ type: 'separator' }, { role: 'front' }] : [{ role: 'close' }]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (!isMac) app.quit();
});

module.exports = { getMainWindow: () => mainWindow };

const { ipcMain, dialog, BrowserWindow } = require('electron');
const Store = require('electron-store');

const store = new Store({
  name: 'config',
  defaults: {
    outputRoot: '',
    dicom: {
      callingAet: 'SURGERY',
      calledAet: 'STELLADICOM',
      host: '',
      port: 104,
      modality: 'OT',
      charset: 'ISO_IR 100',
      transferSyntax: '1.2.840.10008.1.2',
    },
    folderPattern: '{date}_{id}_{name}_{procedure}',
    updateUrl: 'https://github.com/roon1115/surgery-data-manager/releases/latest/download/latest.json',
  },
});

function getAll() {
  return {
    outputRoot: store.get('outputRoot'),
    dicom: store.get('dicom'),
    folderPattern: store.get('folderPattern'),
    updateUrl: store.get('updateUrl'),
  };
}

ipcMain.handle('settings:get', async () => getAll());

ipcMain.handle('settings:save', async (_e, partial = {}) => {
  if (typeof partial.outputRoot === 'string') store.set('outputRoot', partial.outputRoot);
  if (partial.dicom && typeof partial.dicom === 'object') {
    const cur = store.get('dicom');
    store.set('dicom', { ...cur, ...partial.dicom });
  }
  if (typeof partial.folderPattern === 'string') store.set('folderPattern', partial.folderPattern);
  if (typeof partial.updateUrl === 'string') store.set('updateUrl', partial.updateUrl);
  return getAll();
});

ipcMain.handle('settings:chooseOutputRoot', async () => {
  const win = BrowserWindow.getFocusedWindow();
  const result = await dialog.showOpenDialog(win, {
    title: '出力ルートフォルダを選択（ネットワークHDD/NAS推奨）',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: store.get('outputRoot') || '/Volumes',
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false };
  const chosen = result.filePaths[0];
  store.set('outputRoot', chosen);
  return { ok: true, path: chosen };
});

module.exports = { getAll };

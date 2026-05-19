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
    typeFolders: {
      anesthesia: '麻酔記録',
      surgicalPhoto: '手術写真',
      laparoscope: '腹腔鏡',
      bronchoscope: '気管支鏡',
      endoscope: '内視鏡',
    },
  },
});

const DEFAULT_TYPE_FOLDERS = {
  anesthesia: '麻酔記録',
  surgicalPhoto: '手術写真',
  laparoscope: '腹腔鏡',
  bronchoscope: '気管支鏡',
  endoscope: '内視鏡',
};

function getAll() {
  const tf = store.get('typeFolders') || {};
  // 既存設定にキーが欠けていてもデフォルトで補完
  const typeFolders = { ...DEFAULT_TYPE_FOLDERS, ...tf };
  return {
    outputRoot: store.get('outputRoot'),
    dicom: store.get('dicom'),
    folderPattern: store.get('folderPattern'),
    typeFolders,
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
  if (partial.typeFolders && typeof partial.typeFolders === 'object') {
    const cur = store.get('typeFolders') || {};
    store.set('typeFolders', { ...DEFAULT_TYPE_FOLDERS, ...cur, ...partial.typeFolders });
  }
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

const TYPE_LABELS = {
  anesthesia: '麻酔モニター記録',
  surgicalPhoto: '手術写真',
  laparoscope: '腹腔鏡',
  bronchoscope: '気管支鏡',
  endoscope: '内視鏡',
};

ipcMain.handle('settings:chooseTypeFolder', async (_e, args = {}) => {
  const { type } = args;
  if (!type || !TYPE_LABELS[type]) return { ok: false, error: 'invalid type' };
  const win = BrowserWindow.getFocusedWindow();
  const tf = store.get('typeFolders') || {};
  const currentValue = tf[type] || '';
  const outputRoot = store.get('outputRoot') || '';
  // 既存値が絶対パスならその親、なければ outputRoot、それもなければ /Volumes
  let defaultPath = '/Volumes';
  if (currentValue && currentValue.startsWith('/')) defaultPath = currentValue;
  else if (outputRoot) defaultPath = outputRoot;
  const result = await dialog.showOpenDialog(win, {
    title: `「${TYPE_LABELS[type]}」の保存先フォルダを選択`,
    properties: ['openDirectory', 'createDirectory'],
    defaultPath,
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false };
  const chosen = result.filePaths[0];
  const newTf = { ...DEFAULT_TYPE_FOLDERS, ...(store.get('typeFolders') || {}), [type]: chosen };
  store.set('typeFolders', newTf);
  return { ok: true, path: chosen };
});

module.exports = { getAll };

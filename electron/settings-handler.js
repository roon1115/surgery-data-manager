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
    enabledTypes: {
      anesthesia: true,
      surgicalPhoto: true,
      laparoscope: true,
      bronchoscope: true,
      endoscope: true,
    },
    // 取り込み元として一覧から除外するボリュームのパス配列（例: /Volumes/Time Machine）
    excludedVolumes: [],
    // 種別ごとに「コピー成功 + ハッシュ照合OK後、元データ（src）を削除する」フラグ
    // 既定はすべて false（安全側）
    deleteAfterCopy: {
      anesthesia: false,
      surgicalPhoto: false,
      laparoscope: false,
      bronchoscope: false,
      endoscope: false,
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

const DEFAULT_ENABLED_TYPES = {
  anesthesia: true,
  surgicalPhoto: true,
  laparoscope: true,
  bronchoscope: true,
  endoscope: true,
};

const DEFAULT_DELETE_AFTER_COPY = {
  anesthesia: false,
  surgicalPhoto: false,
  laparoscope: false,
  bronchoscope: false,
  endoscope: false,
};

function getAll() {
  const tf = store.get('typeFolders') || {};
  const et = store.get('enabledTypes') || {};
  const dac = store.get('deleteAfterCopy') || {};
  // 既存設定にキーが欠けていてもデフォルトで補完
  const typeFolders = { ...DEFAULT_TYPE_FOLDERS, ...tf };
  const enabledTypes = { ...DEFAULT_ENABLED_TYPES, ...et };
  const deleteAfterCopy = { ...DEFAULT_DELETE_AFTER_COPY, ...dac };
  const excludedVolumes = Array.isArray(store.get('excludedVolumes')) ? store.get('excludedVolumes') : [];
  return {
    outputRoot: store.get('outputRoot'),
    dicom: store.get('dicom'),
    folderPattern: store.get('folderPattern'),
    typeFolders,
    enabledTypes,
    excludedVolumes,
    deleteAfterCopy,
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
  if (partial.enabledTypes && typeof partial.enabledTypes === 'object') {
    const cur = store.get('enabledTypes') || {};
    store.set('enabledTypes', { ...DEFAULT_ENABLED_TYPES, ...cur, ...partial.enabledTypes });
  }
  if (Array.isArray(partial.excludedVolumes)) {
    store.set('excludedVolumes', partial.excludedVolumes.filter(v => typeof v === 'string' && v));
  }
  if (partial.deleteAfterCopy && typeof partial.deleteAfterCopy === 'object') {
    const cur = store.get('deleteAfterCopy') || {};
    store.set('deleteAfterCopy', { ...DEFAULT_DELETE_AFTER_COPY, ...cur, ...partial.deleteAfterCopy });
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

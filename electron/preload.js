const { contextBridge, ipcRenderer } = require('electron');

let toRomaji = null;
try {
  const wk = require('wanakana');
  toRomaji = (s) => wk.toRomaji(String(s || '')).toUpperCase();
} catch (_) {
  toRomaji = null;
}

contextBridge.exposeInMainWorld('App', {
  platform: process.platform,
  toRomaji: (s) => (toRomaji ? toRomaji(s) : null),

  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  showFolder: (path) => ipcRenderer.invoke('app:showFolder', path),
  openManual: () => ipcRenderer.invoke('app:openManual'),

  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    save: (partial) => ipcRenderer.invoke('settings:save', partial),
    chooseOutputRoot: () => ipcRenderer.invoke('settings:chooseOutputRoot'),
    chooseTypeFolder: (type) => ipcRenderer.invoke('settings:chooseTypeFolder', { type }),
  },

  ingest: {
    listVolumes: () => ipcRenderer.invoke('ingest:listVolumes'),
    chooseSource: () => ipcRenderer.invoke('ingest:chooseSource'),
    scanSource: (args) => ipcRenderer.invoke('ingest:scanSource', args),
    prepareTarget: (args) => ipcRenderer.invoke('ingest:prepareTarget', args),
    start: (args) => ipcRenderer.invoke('ingest:start', args),
    cancel: () => ipcRenderer.invoke('ingest:cancel'),
    ejectVolume: (volumePath) => ipcRenderer.invoke('ingest:ejectVolume', { volumePath }),
    checkDuplicates: (files) => ipcRenderer.invoke('ingest:checkDuplicates', { files }),
    cancelCheck: () => ipcRenderer.invoke('ingest:cancelCheck'),
    onProgress: (cb) => {
      const listener = (_e, data) => cb(data);
      ipcRenderer.on('ingest:progress', listener);
      return () => ipcRenderer.removeListener('ingest:progress', listener);
    },
    onCheckProgress: (cb) => {
      const listener = (_e, data) => cb(data);
      ipcRenderer.on('ingest:checkProgress', listener);
      return () => ipcRenderer.removeListener('ingest:checkProgress', listener);
    },
  },

  history: {
    listRecent: (args) => ipcRenderer.invoke('history:listRecent', args || {}),
    remove: (folderName) => ipcRenderer.invoke('history:remove', { folderName }),
  },

  dicom: {
    echo: (args) => ipcRenderer.invoke('dicom:echo', args),
    openLog: () => ipcRenderer.invoke('dicom:openLog'),
    logLine: (text, level) => ipcRenderer.invoke('dicom:logLine', { text, level }),
    sendStudy: (args) => ipcRenderer.invoke('dicom:sendStudy', args),
    // SD の現物をコピー時の SHA-256 と照合して返す（一致時のみ bytes）。{ path, sha256 }
    readVerifiedSource: (args) => ipcRenderer.invoke('dicom:readVerifiedSource', args),
    queueFailure: (args) => ipcRenderer.invoke('dicom:queueFailure', args),
    listPending: () => ipcRenderer.invoke('dicom:listPending'),
    updatePending: (args) => ipcRenderer.invoke('dicom:updatePending', args),
    removePending: (id) => ipcRenderer.invoke('dicom:removePending', { id }),
  },

  updater: {
    check: (args) => ipcRenderer.invoke('updater:check', args || {}),
  },
});

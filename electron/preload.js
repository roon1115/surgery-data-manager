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
    ejectVolume: (volumePath) => ipcRenderer.invoke('ingest:ejectVolume', { volumePath }),
    onProgress: (cb) => {
      const listener = (_e, data) => cb(data);
      ipcRenderer.on('ingest:progress', listener);
      return () => ipcRenderer.removeListener('ingest:progress', listener);
    },
  },

  history: {
    listRecent: (args) => ipcRenderer.invoke('history:listRecent', args || {}),
    remove: (folderName) => ipcRenderer.invoke('history:remove', { folderName }),
  },

  dicom: {
    echo: (args) => ipcRenderer.invoke('dicom:echo', args),
    sendStudy: (args) => ipcRenderer.invoke('dicom:sendStudy', args),
    queueFailure: (args) => ipcRenderer.invoke('dicom:queueFailure', args),
    listPending: () => ipcRenderer.invoke('dicom:listPending'),
  },

  updater: {
    check: (args) => ipcRenderer.invoke('updater:check', args || {}),
  },
});

const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods to renderer process via contextBridge
contextBridge.exposeInMainWorld('electron', {
  // Window controls
  minimize: () => ipcRenderer.invoke('window-minimize'),
  maximize: () => ipcRenderer.invoke('window-maximize'),
  close: () => ipcRenderer.invoke('window-close'),
  isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
  setFullscreen: (flag) => ipcRenderer.invoke('window-set-fullscreen', flag),
  isFullscreen: () => ipcRenderer.invoke('window-is-fullscreen'),

  // File dialogs
  openFileDialog: (options) => ipcRenderer.invoke('open-file-dialog', options),
  openFolderDialog: () => ipcRenderer.invoke('open-folder-dialog'),
  openM3UDialog: () => ipcRenderer.invoke('open-m3u-dialog'),

  // Store (persistent settings)
  storeGet: (key, defaultValue) => ipcRenderer.invoke('store-get', key, defaultValue),
  storeSet: (key, value) => ipcRenderer.invoke('store-set', key, value),
  storeDelete: (key) => ipcRenderer.invoke('store-delete', key),
  storeClear: () => ipcRenderer.invoke('store-clear'),

  // External links
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // File system
  readDirectory: (path) => ipcRenderer.invoke('read-directory', path),
  getFileInfo: (path) => ipcRenderer.invoke('get-file-info', path),
  getFFmpegPath: () => ipcRenderer.invoke('get-ffmpeg-path'),

  // Platform info
  platform: process.platform,
  version: process.env.npm_package_version || '1.0.0'
});

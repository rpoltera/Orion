/**
 * Safe Electron API wrapper
 * Falls back gracefully when running in a browser (dev without Electron)
 */

const isElectron = typeof window !== 'undefined' && !!window.electron;

export const electron = {
  isElectron,

  // Window controls
  minimize:    () => window.electron?.minimize(),
  maximize:    () => window.electron?.maximize(),
  close:       () => window.electron?.close(),
  isMaximized: () => window.electron?.isMaximized() ?? Promise.resolve(false),

  // Dialogs
  openFileDialog:   (opts) => window.electron?.openFileDialog(opts) ?? Promise.resolve({ canceled: true }),
  openFolderDialog: ()     => window.electron?.openFolderDialog()   ?? Promise.resolve({ canceled: true }),
  openM3UDialog:    ()     => window.electron?.openM3UDialog()       ?? Promise.resolve({ canceled: true }),

  // Persistent store
  storeGet:    (key, def)  => window.electron?.storeGet(key, def)  ?? Promise.resolve(def),
  storeSet:    (key, val)  => window.electron?.storeSet(key, val)  ?? Promise.resolve(),
  storeDelete: (key)       => window.electron?.storeDelete(key)    ?? Promise.resolve(),

  // External links
  openExternal: (url) => {
    if (window.electron) return window.electron.openExternal(url);
    window.open(url, '_blank');
  },

  // File system
  readDirectory: (path) => window.electron?.readDirectory(path) ?? Promise.resolve([]),
  getFileInfo:   (path) => window.electron?.getFileInfo(path)   ?? Promise.resolve({ exists: false }),
  getFFmpegPath: ()     => window.electron?.getFFmpegPath()     ?? Promise.resolve(null),

  // Info
  platform: window.electron?.platform ?? 'browser',
  version:  window.electron?.version  ?? '1.0.0',
};

export default electron;

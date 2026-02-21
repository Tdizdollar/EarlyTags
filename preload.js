const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('launcher', {
  // Window
  minimize:   () => ipcRenderer.invoke('window-minimize'),
  maximize:   () => ipcRenderer.invoke('window-maximize'),
  close:      () => ipcRenderer.invoke('window-close'),
  getVersion: () => ipcRenderer.invoke('get-app-version'),

  // Launcher self-update
  downloadLauncherUpdate: () => ipcRenderer.invoke('download-launcher-update'),
  installLauncherUpdate:  () => ipcRenderer.invoke('install-launcher-update'),

  // Game
  fetchGameManifest: ()      => ipcRenderer.invoke('fetch-game-manifest'),
  getGameState:      ()      => ipcRenderer.invoke('get-game-state'),
  installGame:       (opts)  => ipcRenderer.invoke('install-game', opts),
  launchGame:        ()      => ipcRenderer.invoke('launch-game'),
  closeGame:         ()      => ipcRenderer.invoke('close-game'),  // ← kill game process

  // External
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // Events from main process
  on: (channel, callback) => {
    const allowed = [
      'launcher-update-available', 'launcher-update-not-available',
      'launcher-download-progress', 'launcher-update-downloaded',
      'launcher-update-error', 'game-download-progress', 'game-install-complete',
    ];
    if (allowed.includes(channel)) {
      ipcRenderer.on(channel, (_, data) => callback(data));
    }
  },
});

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { exec, spawn } = require('child_process');

// ─── CONFIG — CHANGE THESE ────────────────────────────────────────────────────
const GAME_MANIFEST_URL = 'https://yourdomain.com/game/manifest.json';
const GAME_STEAM_APP_ID = '123456789'; // Your game's Steam App ID
// ─────────────────────────────────────────────────────────────────────────────

const GAMES_DIR = path.join(app.getPath('userData'), 'game');
let mainWindow;
let gameProcess = null; // Track launched game process

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 680,
    minWidth: 860,
    minHeight: 580,
    frame: false,
    backgroundColor: '#000000',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    icon: path.join(__dirname, 'assets', 'icon.png'),
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    checkLauncherUpdate();
  });
}

app.whenReady().then(() => {
  if (!fs.existsSync(GAMES_DIR)) fs.mkdirSync(GAMES_DIR, { recursive: true });
  createWindow();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ─── LAUNCHER AUTO-UPDATE ─────────────────────────────────────────────────────
function checkLauncherUpdate() {
  autoUpdater.checkForUpdates().catch(err => console.log('Update check failed:', err.message));
}
autoUpdater.on('update-available', (info) => {
  mainWindow.webContents.send('launcher-update-available', { version: info.version });
});
autoUpdater.on('update-not-available', () => {
  mainWindow.webContents.send('launcher-update-not-available');
});
autoUpdater.on('download-progress', (p) => {
  mainWindow.webContents.send('launcher-download-progress', {
    percent: Math.round(p.percent),
    transferred: p.transferred,
    total: p.total,
  });
});
autoUpdater.on('update-downloaded', () => {
  mainWindow.webContents.send('launcher-update-downloaded');
});
autoUpdater.on('error', (err) => {
  mainWindow.webContents.send('launcher-update-error', err.message);
});

ipcMain.handle('download-launcher-update', () => autoUpdater.downloadUpdate());
ipcMain.handle('install-launcher-update',  () => autoUpdater.quitAndInstall());

// ─── WINDOW CONTROLS ──────────────────────────────────────────────────────────
ipcMain.handle('window-minimize', () => mainWindow.minimize());
ipcMain.handle('window-maximize', () => {
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.handle('window-close', () => mainWindow.close());

// ─── GAME MANIFEST ────────────────────────────────────────────────────────────
ipcMain.handle('fetch-game-manifest', async () => {
  return new Promise((resolve, reject) => {
    const url = new URL(GAME_MANIFEST_URL);
    const client = url.protocol === 'https:' ? https : http;
    client.get(GAME_MANIFEST_URL, { timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid manifest')); }
      });
    }).on('error', reject);
  });
});

// ─── LOCAL GAME STATE ─────────────────────────────────────────────────────────
ipcMain.handle('get-game-state', async () => {
  const statePath = path.join(GAMES_DIR, 'installed.json');
  if (!fs.existsSync(statePath)) return { installed: false };
  try {
    const d = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return { installed: true, version: d.version, installPath: d.installPath };
  } catch { return { installed: false }; }
});

// ─── INSTALL GAME ─────────────────────────────────────────────────────────────
ipcMain.handle('install-game', async (_, { version, downloadUrl, totalSize }) => {
  const zipPath = path.join(GAMES_DIR, `game-${version}.zip`);

  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(zipPath);
    const url = new URL(downloadUrl);
    const client = url.protocol === 'https:' ? https : http;

    client.get(downloadUrl, (res) => {
      const total = parseInt(res.headers['content-length'] || totalSize || 0);
      let downloaded = 0;

      res.on('data', (chunk) => {
        downloaded += chunk.length;
        file.write(chunk);
        const percent = total > 0 ? Math.round((downloaded / total) * 100) : 0;
        mainWindow.webContents.send('game-download-progress', { percent, downloaded, total });
      });

      res.on('end', () => {
        file.end();
        extractGame(zipPath, GAMES_DIR)
          .then(() => {
            fs.writeFileSync(
              path.join(GAMES_DIR, 'installed.json'),
              JSON.stringify({ version, installPath: GAMES_DIR, installedAt: Date.now() })
            );
            mainWindow.webContents.send('game-install-complete', { version });
            resolve({ success: true });
          })
          .catch(reject);
      });
      res.on('error', reject);
    }).on('error', reject);
  });
});

function extractGame(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    const cmd = process.platform === 'win32'
      ? `powershell -command "Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force"`
      : `unzip -o "${zipPath}" -d "${destDir}"`;
    exec(cmd, (err) => {
      if (err) return reject(err);
      try { fs.unlinkSync(zipPath); } catch (_) {}
      resolve();
    });
  });
}

// ─── LAUNCH GAME VIA STEAMVR ──────────────────────────────────────────────────
ipcMain.handle('launch-game', async () => {
  // Opens the game through Steam — Steam handles SteamVR automatically
  const steamUrl = `steam://rungameid/${GAME_STEAM_APP_ID}`;
  await shell.openExternal(steamUrl);

  // Optional: if you're launching an .exe directly (not via Steam), do this instead:
  // const exePath = path.join(GAMES_DIR, 'YourGame.exe');
  // gameProcess = spawn(exePath, [], { detached: true, stdio: 'ignore' });
  // gameProcess.unref();
  // gameProcess.pid saved so we can kill it later

  return { success: true };
});

// ─── CLOSE GAME ───────────────────────────────────────────────────────────────
// This kills the game process by name (works when launched via Steam too)
ipcMain.handle('close-game', async () => {
  return new Promise((resolve) => {
    // If we have a direct process reference, kill it
    if (gameProcess) {
      try { gameProcess.kill('SIGTERM'); } catch (_) {}
      gameProcess = null;
      return resolve({ success: true });
    }

    // Otherwise kill by process name (change 'YourGame.exe' to your actual exe name)
    const processName = process.platform === 'win32'
      ? 'YourGame.exe'       // ← CHANGE THIS to your game's executable name
      : 'YourGame';          // ← CHANGE THIS for Mac/Linux

    const cmd = process.platform === 'win32'
      ? `taskkill /F /IM "${processName}"`
      : `pkill -f "${processName}"`;

    exec(cmd, (err) => {
      // Error usually means process wasn't found — that's fine
      resolve({ success: !err, message: err?.message });
    });
  });
});

// ─── OPEN EXTERNAL ────────────────────────────────────────────────────────────
ipcMain.handle('open-external', async (_, url) => {
  await shell.openExternal(url);
});

// ─── GET APP VERSION ──────────────────────────────────────────────────────────
ipcMain.handle('get-app-version', () => app.getVersion());

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { exec, spawn, execSync } = require('child_process');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const GAME_MANIFEST_URL = 'https://tdizdollar.github.io/EarlyTags/server/game-manifest.json';
const GAME_EXE_NAME = 'Old Tag.exe';
// ─────────────────────────────────────────────────────────────────────────────

const GAMES_DIR = path.join(app.getPath('userData'), 'game');
let mainWindow;
let gameProcess = null;

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
ipcMain.handle('install-launcher-update', () => autoUpdater.quitAndInstall());

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

// ─── INSTALL GAME (downloads from Mega.nz) ────────────────────────────────────
ipcMain.handle('install-game', async (_, { version, downloadUrl, totalSize }) => {
    const zipPath = path.join(GAMES_DIR, `game-${version}.zip`);

    return new Promise(async (resolve, reject) => {
        try {
            const { File } = require('megajs');

            const file = File.fromURL(downloadUrl);
            await file.loadAttributes();

            const total = file.size || totalSize || 0;
            let downloaded = 0;

            const writeStream = fs.createWriteStream(zipPath);
            const readStream = file.download();

            readStream.on('data', (chunk) => {
                downloaded += chunk.length;
                writeStream.write(chunk);
                const percent = total > 0 ? Math.round((downloaded / total) * 100) : 0;
                mainWindow.webContents.send('game-download-progress', {
                    percent,
                    downloaded,
                    total,
                });
            });

            readStream.on('error', (err) => {
                writeStream.destroy();
                reject(err);
            });

            readStream.on('end', () => {
                writeStream.end();
                writeStream.on('finish', () => {
                    extractGame(zipPath, GAMES_DIR)
                        .then(() => {
                            fs.writeFileSync(
                                path.join(GAMES_DIR, 'installed.json'),
                                JSON.stringify({
                                    version,
                                    installPath: GAMES_DIR,
                                    installedAt: Date.now(),
                                })
                            );
                            mainWindow.webContents.send('game-install-complete', { version });
                            resolve({ success: true });
                        })
                        .catch(reject);
                });
            });

        } catch (err) {
            console.error('Mega download failed:', err);
            reject(err);
        }
    });
});

function extractGame(zipPath, destDir) {
    return new Promise((resolve, reject) => {
        const cmd = `powershell -command "Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force"`;
        exec(cmd, (err) => {
            if (err) return reject(err);
            try { fs.unlinkSync(zipPath); } catch (_) { }
            resolve();
        });
    });
}

// ─── FIND STEAMVR OPENXR RUNTIME ──────────────────────────────────────────────
function findSteamVRRuntime() {
    const runtimeRelPath = 'steamapps\\common\\SteamVR\\tools\\openxr\\runtime\\win64\\openxr_runtime.json';

    const steamPaths = [
        'C:\\Program Files (x86)\\Steam',
        'C:\\Program Files\\Steam',
        'D:\\Steam',
        'D:\\Program Files (x86)\\Steam',
        'E:\\Steam',
    ];

    for (const steamPath of steamPaths) {
        const fullPath = path.join(steamPath, runtimeRelPath);
        if (fs.existsSync(fullPath)) return fullPath;
    }

    try {
        const regOutput = execSync(
            'reg query "HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam" /v InstallPath',
            { encoding: 'utf8' }
        );
        const match = regOutput.match(/InstallPath\s+REG_SZ\s+(.+)/);
        if (match) {
            const fullPath = path.join(match[1].trim(), runtimeRelPath);
            if (fs.existsSync(fullPath)) return fullPath;
        }
    } catch (_) { }

    return null;
}

// ─── LAUNCH GAME (forces SteamVR OpenXR runtime) ─────────────────────────────
ipcMain.handle('launch-game', async () => {
    return new Promise(async (resolve, reject) => {

        const gameExePath = path.join(GAMES_DIR, GAME_EXE_NAME);

        if (!fs.existsSync(gameExePath)) {
            return reject(new Error(`Game exe not found at: ${gameExePath}`));
        }

        // Launch SteamVR first (250820 is SteamVR's permanent App ID)
        await shell.openExternal('steam://run/250820');

        // Wait for SteamVR to initialize
        await new Promise(r => setTimeout(r, 4000));

        // Force SteamVR OpenXR runtime via environment variable
        const steamVRRuntimePath = findSteamVRRuntime();
        const env = { ...process.env };
        if (steamVRRuntimePath) {
            env.XR_RUNTIME_JSON = steamVRRuntimePath;
            console.log('Forcing SteamVR OpenXR runtime:', steamVRRuntimePath);
        } else {
            console.warn('SteamVR runtime not found — launching with system default runtime');
        }

        // Launch Old Tag.exe with forced runtime
        gameProcess = spawn(gameExePath, [], {
            detached: true,
            stdio: 'ignore',
            env: env,
        });

        gameProcess.unref();

        gameProcess.on('error', (err) => {
            gameProcess = null;
            reject(err);
        });

        setTimeout(() => resolve({ success: true }), 1000);
    });
});

// ─── CLOSE GAME ───────────────────────────────────────────────────────────────
ipcMain.handle('close-game', async () => {
    return new Promise((resolve) => {
        if (gameProcess) {
            try { gameProcess.kill('SIGTERM'); } catch (_) { }
            gameProcess = null;
            return resolve({ success: true });
        }
        exec(`taskkill /F /IM "${GAME_EXE_NAME}"`, (err) => {
            resolve({ success: !err });
        });
    });
});

// ─── OPEN EXTERNAL ────────────────────────────────────────────────────────────
ipcMain.handle('open-external', async (_, url) => {
    await shell.openExternal(url);
});

// ─── GET APP VERSION ──────────────────────────────────────────────────────────
ipcMain.handle('get-app-version', () => app.getVersion());
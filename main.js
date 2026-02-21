const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { exec, spawn, execSync } = require('child_process');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const GAME_MANIFEST_URL = 'https://tdizdollar.github.io/EarlyTags/server/game-manifest.json';
// Game extracts into an OldTag subfolder, exe lives inside that
const GAME_SUBFOLDER = 'OldTag';
const GAME_EXE_NAME = 'Old Tag.exe';
// ─────────────────────────────────────────────────────────────────────────────

const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');
const DEFAULT_GAMES_DIR = path.join('C:\\Program Files', 'Early Tags');

let mainWindow;
let gameProcess = null;

// ─── SETTINGS ─────────────────────────────────────────────────────────────────
function loadSettings() {
    try {
        if (fs.existsSync(SETTINGS_PATH)) {
            return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
        }
    } catch (_) { }
    return { installDir: DEFAULT_GAMES_DIR };
}

function saveSettings(settings) {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

function getInstallDir() {
    return loadSettings().installDir || DEFAULT_GAMES_DIR;
}

// Returns the full path to the game exe:
// e.g. D:\vs\EarlyTagGame\OldTag\Old Tag.exe
function getGameExePath() {
    return path.join(getInstallDir(), GAME_SUBFOLDER, GAME_EXE_NAME);
}

// Returns the folder the exe sits in (used as cwd for Unity):
// e.g. D:\vs\EarlyTagGame\OldTag
function getGameDir() {
    return path.join(getInstallDir(), GAME_SUBFOLDER);
}

// ─── WINDOW ───────────────────────────────────────────────────────────────────
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

// ─── SETTINGS IPC ─────────────────────────────────────────────────────────────
ipcMain.handle('get-settings', () => loadSettings());

ipcMain.handle('save-settings', (_, newSettings) => {
    const merged = { ...loadSettings(), ...newSettings };
    saveSettings(merged);
    if (merged.installDir && !fs.existsSync(merged.installDir)) {
        try { fs.mkdirSync(merged.installDir, { recursive: true }); } catch (_) { }
    }
    return merged;
});

ipcMain.handle('pick-install-dir', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Choose Install Location',
        defaultPath: getInstallDir(),
        properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
});

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
    const installDir = getInstallDir();
    const statePath = path.join(installDir, 'installed.json');
    if (!fs.existsSync(statePath)) return { installed: false };
    try {
        const d = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        // Also verify the exe actually exists
        const exeExists = fs.existsSync(getGameExePath());
        if (!exeExists) return { installed: false };
        return { installed: true, version: d.version, installPath: installDir };
    } catch { return { installed: false }; }
});

// ─── INSTALL GAME (Mega.nz) ───────────────────────────────────────────────────
ipcMain.handle('install-game', async (_, { version, downloadUrl, totalSize }) => {
    const installDir = getInstallDir();

    if (!fs.existsSync(installDir)) {
        try {
            fs.mkdirSync(installDir, { recursive: true });
        } catch (err) {
            // Fallback to AppData if no permission (e.g. Program Files without admin)
            const fallback = path.join(app.getPath('userData'), 'game');
            fs.mkdirSync(fallback, { recursive: true });
            saveSettings({ ...loadSettings(), installDir: fallback });
            mainWindow.webContents.send('install-dir-changed', fallback);
        }
    }

    const actualDir = getInstallDir();
    const zipPath = path.join(actualDir, `game-${version}.zip`);

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
                mainWindow.webContents.send('game-download-progress', { percent, downloaded, total });
            });

            readStream.on('error', (err) => {
                writeStream.destroy();
                reject(err);
            });

            readStream.on('end', () => {
                writeStream.end();
                writeStream.on('finish', () => {
                    extractGame(zipPath, actualDir)
                        .then(() => {
                            fs.writeFileSync(
                                path.join(actualDir, 'installed.json'),
                                JSON.stringify({ version, installPath: actualDir, installedAt: Date.now() })
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
        exec(cmd, { maxBuffer: 1024 * 1024 * 50 }, (err) => {
            if (err) return reject(err);
            try { fs.unlinkSync(zipPath); } catch (_) { }
            resolve();
        });
    });
}

// ─── UNINSTALL GAME ───────────────────────────────────────────────────────────
ipcMain.handle('uninstall-game', async () => {
    const installDir = getInstallDir();
    return new Promise((resolve) => {
        try {
            if (fs.existsSync(installDir)) {
                const files = fs.readdirSync(installDir);
                for (const file of files) {
                    const filePath = path.join(installDir, file);
                    try {
                        const stat = fs.statSync(filePath);
                        if (stat.isDirectory()) {
                            fs.rmSync(filePath, { recursive: true, force: true });
                        } else {
                            fs.unlinkSync(filePath);
                        }
                    } catch (_) { }
                }
                try { fs.rmdirSync(installDir); } catch (_) { }
            }
            resolve({ success: true });
        } catch (err) {
            resolve({ success: false, message: err.message });
        }
    });
});

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

// ─── LAUNCH GAME ─────────────────────────────────────────────────────────────
ipcMain.handle('launch-game', async () => {
    return new Promise(async (resolve, reject) => {
        const gameExePath = getGameExePath();
        const gameDir = getGameDir();

        console.log('Launching game from:', gameExePath);
        console.log('Working directory:', gameDir);

        if (!fs.existsSync(gameExePath)) {
            return reject(new Error(
                `Game exe not found at:\n${gameExePath}\n\nMake sure the game is installed correctly.`
            ));
        }

        // Launch SteamVR first (250820 is SteamVR's permanent App ID)
        await shell.openExternal('steam://run/250820');
        await new Promise(r => setTimeout(r, 4000));

        // Force SteamVR OpenXR runtime
        const steamVRRuntimePath = findSteamVRRuntime();
        const env = { ...process.env };
        if (steamVRRuntimePath) {
            env.XR_RUNTIME_JSON = steamVRRuntimePath;
            console.log('Forcing SteamVR OpenXR runtime:', steamVRRuntimePath);
        } else {
            console.warn('SteamVR runtime not found — using system default');
        }

        // Launch the game exe
        // cwd must be the folder containing the exe so Unity can find its _Data folder
        gameProcess = spawn(`"${gameExePath}"`, [], {
            detached: true,
            stdio: 'ignore',
            env: env,
            shell: true,
            cwd: gameDir,
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
        // Fallback: kill by exe name
        exec(`taskkill /F /IM "Old Tag.exe"`, (err) => {
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
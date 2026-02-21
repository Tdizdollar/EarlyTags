// ═══ RENDERER.JS ══════════════════════════════════════════════════════════════

const S = {
    appState: 'loading',
    manifest: null,
    localState: null,
    gameRunning: false,
    closeGameTimer: null,
    launcherUpdateState: 'idle',
    launcherVersion: '1.0.0',
    settings: { installDir: '' },
    pendingInstallDir: null,
};

// ─── NOISE CANVAS ─────────────────────────────────────────────────────────────
const canvas = document.getElementById('bgCanvas');
const ctx = canvas.getContext('2d');
function resizeCanvas() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
function drawNoise() {
    resizeCanvas();
    const idata = ctx.createImageData(canvas.width, canvas.height);
    const buf = idata.data;
    for (let i = 0; i < buf.length; i += 4) {
        const v = Math.random() * 255 | 0;
        buf[i] = buf[i + 1] = buf[i + 2] = v; buf[i + 3] = 255;
    }
    ctx.putImageData(idata, 0, 0);
}
drawNoise();
setInterval(drawNoise, 100);
window.addEventListener('resize', resizeCanvas);

// ─── BOOT ─────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
    const v = await window.launcher.getVersion();
    S.launcherVersion = v;
    document.getElementById('launcherVerDisplay').textContent = `LAUNCHER v${v}`;
    document.getElementById('launcherVerStrip').textContent = `v${v}`;

    S.settings = await window.launcher.getSettings();
    updateInstallDirDisplay();

    setupLauncherUpdateListeners();

    // If install dir was auto-changed due to permissions, update settings
    window.launcher.on('install-dir-changed', (newDir) => {
        S.settings.installDir = newDir;
        updateInstallDirDisplay();
    });

    await loadGameState();
});

// ─── LAUNCHER AUTO-UPDATE ─────────────────────────────────────────────────────
function setupLauncherUpdateListeners() {
    window.launcher.on('launcher-update-available', (info) => {
        S.launcherUpdateState = 'available';
        document.getElementById('updateSubtitle').textContent = `v${S.launcherVersion} → v${info.version} AVAILABLE`;
        document.getElementById('launcherUpdateModal').classList.add('show');
    });
    window.launcher.on('launcher-update-not-available', () => { S.launcherUpdateState = 'idle'; });
    window.launcher.on('launcher-download-progress', (p) => {
        document.getElementById('launcherProgress').style.display = 'block';
        document.getElementById('launcherProgressFill').style.width = p.percent + '%';
        document.getElementById('launcherProgressPct').textContent = p.percent + '%';
        document.getElementById('launcherUpdateBtn').textContent = `DOWNLOADING... ${p.percent}%`;
        document.getElementById('launcherUpdateBtn').disabled = true;
    });
    window.launcher.on('launcher-update-downloaded', () => {
        S.launcherUpdateState = 'ready';
        document.getElementById('launcherProgress').style.display = 'none';
        document.getElementById('launcherReadyMsg').style.display = 'block';
        document.getElementById('launcherUpdateBtn').textContent = 'RESTART & INSTALL';
        document.getElementById('launcherUpdateBtn').disabled = false;
    });
    window.launcher.on('launcher-update-error', () => {
        document.getElementById('launcherUpdateBtn').textContent = 'RETRY UPDATE';
        document.getElementById('launcherUpdateBtn').disabled = false;
        S.launcherUpdateState = 'available';
    });
}

window.handleLauncherUpdate = async function () {
    if (S.launcherUpdateState === 'ready') {
        await window.launcher.installLauncherUpdate();
    } else if (S.launcherUpdateState === 'available') {
        S.launcherUpdateState = 'downloading';
        document.getElementById('launcherUpdateBtn').textContent = 'STARTING...';
        document.getElementById('launcherUpdateBtn').disabled = true;
        await window.launcher.downloadLauncherUpdate();
    }
};

// ─── LOAD GAME STATE ──────────────────────────────────────────────────────────
async function loadGameState() {
    let manifest;
    try {
        manifest = await window.launcher.fetchGameManifest();
        S.manifest = manifest;
    } catch (err) {
        console.error('Manifest fetch failed:', err);
        setStatus('error', 'CANNOT REACH SERVER');
        document.getElementById('btnMain').classList.add('btn-disabled');
        document.getElementById('btnMainText').textContent = 'OFFLINE';
        document.getElementById('stripStatus').textContent = 'OFFLINE';
        return;
    }

    S.localState = await window.launcher.getGameState();

    document.getElementById('stripGameVer').textContent = `v${manifest.latestVersion}`;
    document.getElementById('stripGameVerTag').textContent = `v${manifest.latestVersion} Latest`;

    if (!S.localState.installed) {
        setAppState('install');
    } else if (S.localState.version !== manifest.latestVersion) {
        setAppState('update');
    } else {
        setAppState('play');
    }

    renderChangelog(manifest.changelog);
    updateSettingsPanel();
}

// ─── SET APP STATE ────────────────────────────────────────────────────────────
function setAppState(state) {
    S.appState = state;
    const btn = document.getElementById('btnMain');
    const text = document.getElementById('btnMainText');

    btn.className = 'btn-main';
    document.getElementById('progressZone').classList.add('hidden');
    btn.classList.remove('hidden');
    document.getElementById('btnCloseGame').classList.add('hidden');
    S.gameRunning = false;
    clearTimeout(S.closeGameTimer);

    if (state === 'play') {
        text.textContent = 'LAUNCH';
        setStatus('ready', `INSTALLED  ·  v${S.localState?.version || ''}`);
        document.getElementById('secondaryBtns').style.display = 'flex';
        document.getElementById('stripStatus').textContent = 'INSTALLED';
        document.getElementById('uninstallSection').style.display = 'block';
    } else if (state === 'update') {
        btn.classList.add('btn-update');
        text.textContent = 'UPDATE';
        setStatus('warning', `UPDATE REQUIRED  ·  v${S.manifest?.latestVersion}`);
        document.getElementById('secondaryBtns').style.display = 'none';
        document.getElementById('stripStatus').textContent = 'UPDATE AVAIL';
        document.getElementById('uninstallSection').style.display = 'block';
    } else if (state === 'install') {
        btn.classList.add('btn-install');
        text.textContent = 'INSTALL';
        setStatus('error', 'NOT INSTALLED');
        document.getElementById('secondaryBtns').style.display = 'none';
        document.getElementById('stripStatus').textContent = 'NOT INSTALLED';
        document.getElementById('uninstallSection').style.display = 'none';
    }
}

function setStatus(type, text) {
    const dot = document.getElementById('statusDot');
    dot.className = 'status-dot';
    dot.style.background = '';
    dot.style.boxShadow = '';
    if (type === 'ready') { dot.style.background = 'var(--white)'; dot.style.boxShadow = '0 0 8px rgba(255,255,255,0.6)'; }
    else if (type === 'warning') dot.classList.add('warning');
    else if (type === 'error') dot.classList.add('error');
    else if (type === 'running') dot.classList.add('running');
    document.getElementById('statusText').textContent = text;
}

// ─── MAIN ACTION ──────────────────────────────────────────────────────────────
window.handleMainAction = async function () {
    if (S.appState === 'play') await launchGame();
    else if (S.appState === 'update' || S.appState === 'install') await startInstall();
};

// ─── LAUNCH ───────────────────────────────────────────────────────────────────
async function launchGame() {
    try {
        await window.launcher.launchGame();
        S.gameRunning = true;
        S.appState = 'running';
        document.getElementById('btnMain').classList.add('btn-disabled');
        document.getElementById('btnMainText').textContent = 'RUNNING';
        setStatus('running', 'GAME IS RUNNING');
        document.getElementById('stripStatus').textContent = 'RUNNING';
        S.closeGameTimer = setTimeout(() => {
            if (S.gameRunning) document.getElementById('btnCloseGame').classList.remove('hidden');
        }, 3000);
    } catch (err) {
        console.error('Launch failed:', err);
        setStatus('error', 'LAUNCH FAILED — CHECK INSTALL');
    }
}

window.handleCloseGame = async function () {
    try { await window.launcher.closeGame(); } catch (_) { }
    S.gameRunning = false;
    clearTimeout(S.closeGameTimer);
    document.getElementById('btnCloseGame').classList.add('hidden');
    setAppState('play');
};

// ─── INSTALL ──────────────────────────────────────────────────────────────────
async function startInstall() {
    if (!S.manifest) return;
    S.appState = 'installing';

    document.getElementById('btnMain').classList.add('hidden');
    document.getElementById('progressZone').classList.remove('hidden');
    document.getElementById('secondaryBtns').style.display = 'none';
    setStatus('ready', 'DOWNLOADING...');
    document.getElementById('stripStatus').textContent = 'DOWNLOADING';

    window.launcher.on('game-download-progress', (data) => {
        document.getElementById('dlFill').style.width = data.percent + '%';
        document.getElementById('dlPct').textContent = data.percent + '%';
        const mb = Math.round(data.downloaded / 1024 / 1024);
        const total = Math.round(data.total / 1024 / 1024);
        document.getElementById('dlLabel').textContent = total > 0
            ? `${mb} MB / ${total} MB`
            : `${mb} MB downloaded`;
    });

    window.launcher.on('game-install-complete', async (data) => {
        S.localState = await window.launcher.getGameState();
        document.getElementById('stripGameVer').textContent = `v${data.version}`;
        setAppState('play');
        updateSettingsPanel();
    });

    try {
        await window.launcher.installGame({
            version: S.manifest.latestVersion,
            downloadUrl: S.manifest.downloadUrl,
            totalSize: S.manifest.totalSize,
        });
    } catch (err) {
        console.error('Install failed:', err);
        setStatus('error', 'DOWNLOAD FAILED — RETRY');
        setAppState('install');
    }
}

// ─── UNINSTALL ────────────────────────────────────────────────────────────────
window.promptUninstall = function () {
    document.getElementById('uninstallPath').textContent =
        `Install path: ${S.settings.installDir}`;
    document.getElementById('settingsOverlay').classList.remove('show');
    document.getElementById('uninstallModal').classList.add('show');
};

window.confirmUninstall = async function () {
    document.getElementById('uninstallModal').classList.remove('show');
    setStatus('error', 'UNINSTALLING...');
    document.getElementById('stripStatus').textContent = 'UNINSTALLING';

    try {
        await window.launcher.uninstallGame();
        S.localState = { installed: false };
        setAppState('install');
        updateSettingsPanel();
    } catch (err) {
        console.error('Uninstall failed:', err);
        setStatus('error', 'UNINSTALL FAILED');
    }
};

// ─── SETTINGS ─────────────────────────────────────────────────────────────────
window.openSettings = function () {
    S.pendingInstallDir = null;
    updateSettingsPanel();
    document.getElementById('settingsSaveBtn').textContent = 'SAVE CHANGES';
    document.getElementById('settingsSaveBtn').classList.remove('has-changes');
    document.getElementById('reinstallSection').style.display = 'none';
    document.getElementById('settingsOverlay').classList.add('show');
};

window.closeSettings = function (e) {
    if (!e || e.target === document.getElementById('settingsOverlay')) {
        S.pendingInstallDir = null;
        document.getElementById('settingsOverlay').classList.remove('show');
        document.getElementById('installDirDisplay').textContent = S.settings.installDir;
    }
};

window.browseInstallDir = async function () {
    const chosen = await window.launcher.pickInstallDir();
    if (!chosen) return;
    S.pendingInstallDir = chosen;
    document.getElementById('installDirDisplay').textContent = chosen;
    document.getElementById('settingsSaveBtn').classList.add('has-changes');
    document.getElementById('settingsSaveBtn').textContent = 'SAVE CHANGES ●';
    if (S.localState?.installed && chosen !== S.settings.installDir) {
        document.getElementById('reinstallSection').style.display = 'block';
    }
};

window.saveSettings = async function () {
    if (!S.pendingInstallDir) {
        document.getElementById('settingsOverlay').classList.remove('show');
        return;
    }
    S.settings = await window.launcher.saveSettings({ installDir: S.pendingInstallDir });
    S.pendingInstallDir = null;
    updateInstallDirDisplay();
    updateSettingsPanel();
    document.getElementById('settingsSaveBtn').textContent = 'SAVE CHANGES';
    document.getElementById('settingsSaveBtn').classList.remove('has-changes');
    document.getElementById('settingsOverlay').classList.remove('show');
    document.getElementById('reinstallSection').style.display = 'none';

    // Re-check game state with new path
    S.localState = await window.launcher.getGameState();
    if (!S.localState.installed) setAppState('install');
    else if (S.localState.version !== S.manifest?.latestVersion) setAppState('update');
    else setAppState('play');
};

function updateInstallDirDisplay() {
    const dir = S.settings.installDir || '—';
    document.getElementById('installDirDisplay').textContent = dir;
    const parts = dir.replace(/\\/g, '/').split('/').filter(Boolean);
    const short = parts.slice(-2).join('/');
    document.getElementById('stripInstallDir').textContent = short || dir;
}

function updateSettingsPanel() {
    document.getElementById('settingsLauncherVer').textContent = `v${S.launcherVersion}`;
    document.getElementById('settingsGameVer').textContent =
        S.localState?.installed ? `v${S.localState.version}` : 'Not installed';
    document.getElementById('settingsInstallPath').textContent = S.settings.installDir || '—';
    document.getElementById('installDirDisplay').textContent = S.settings.installDir || '—';
    document.getElementById('uninstallSection').style.display =
        S.localState?.installed ? 'block' : 'none';
}

window.openInstallFolder = function () {
    const dir = S.settings.installDir;
    if (dir) window.launcher.openExternal(`file://${dir}`);
};

// ─── CHANGELOG ────────────────────────────────────────────────────────────────
function renderChangelog(changelog) {
    const container = document.getElementById('changelogContent');
    if (!changelog || changelog.length === 0) {
        container.innerHTML = '<p style="font-family:JetBrains Mono,monospace;font-size:10px;color:rgba(255,255,255,0.3);letter-spacing:2px">NO CHANGELOG</p>';
        return;
    }
    container.innerHTML = changelog.map((entry, i) => `
    <div class="cl-entry">
      <div class="cl-meta">
        <div class="cl-ver">v${entry.version}</div>
        <div class="cl-date">${entry.date}</div>
        ${i === 0 ? '<div class="cl-latest-badge">LATEST</div>' : ''}
      </div>
      <div class="cl-items">
        ${(entry.changes || []).map(c => `
          <div class="cl-item ${c.type || ''}">${c.text}</div>
        `).join('')}
        <div class="cl-divider"></div>
      </div>
    </div>
  `).join('');
}

window.openDrawer = function () { document.getElementById('drawerOverlay').classList.add('open'); };
window.closeDrawer = function (e) {
    if (!e || e.target === document.getElementById('drawerOverlay')) {
        document.getElementById('drawerOverlay').classList.remove('open');
    }
};
// ═══ RENDERER.JS — Single-game launcher ═══════════════════════════════════════
// All Electron APIs accessed through window.launcher (preload.js)

// ─── STATE ────────────────────────────────────────────────────────────────────
const S = {
  appState: 'loading',   // loading | play | update | install | installing | running
  manifest: null,
  localState: null,      // { installed, version, installPath }
  gameRunning: false,
  closeGameTimer: null,
  launcherUpdateState: 'idle', // idle | available | downloading | ready
  launcherVersion: '1.0.0',
};

// ─── DOM REFS ─────────────────────────────────────────────────────────────────
const el = {
  btnMain:        () => document.getElementById('btnMain'),
  btnMainText:    () => document.getElementById('btnMainText'),
  statusDot:      () => document.getElementById('statusDot'),
  statusText:     () => document.getElementById('statusText'),
  progressZone:   () => document.getElementById('progressZone'),
  dlFill:         () => document.getElementById('dlFill'),
  dlPct:          () => document.getElementById('dlPct'),
  dlLabel:        () => document.getElementById('dlLabel'),
  secondaryBtns:  () => document.getElementById('secondaryBtns'),
  btnCloseGame:   () => document.getElementById('btnCloseGame'),
  stripStatus:    () => document.getElementById('stripStatus'),
  stripGameVer:   () => document.getElementById('stripGameVer'),
  launcherVerDisplay: () => document.getElementById('launcherVerDisplay'),
  launcherUpdateModal: () => document.getElementById('launcherUpdateModal'),
  launcherProgress: () => document.getElementById('launcherProgress'),
  launcherProgressFill: () => document.getElementById('launcherProgressFill'),
  launcherProgressPct: () => document.getElementById('launcherProgressPct'),
  launcherUpdateBtn: () => document.getElementById('launcherUpdateBtn'),
  launcherReadyMsg: () => document.getElementById('launcherReadyMsg'),
  drawerOverlay:  () => document.getElementById('drawerOverlay'),
  updateSubtitle: () => document.getElementById('updateSubtitle'),
};

// ─── BOOT ─────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  // Show launcher version
  const v = await window.launcher.getVersion();
  S.launcherVersion = v;
  el.launcherVerDisplay().textContent = `LAUNCHER v${v}`;
  document.querySelector('.tb-version').textContent = `LAUNCHER v${v}`;

  setupLauncherUpdateListeners();
  await loadGameState();
});

// ─── LAUNCHER AUTO-UPDATE ─────────────────────────────────────────────────────
function setupLauncherUpdateListeners() {
  window.launcher.on('launcher-update-available', (info) => {
    S.launcherUpdateState = 'available';
    el.updateSubtitle().textContent = `v${S.launcherVersion} → v${info.version} AVAILABLE`;
    el.launcherUpdateModal().classList.add('show');
  });

  window.launcher.on('launcher-update-not-available', () => {
    S.launcherUpdateState = 'idle';
  });

  window.launcher.on('launcher-download-progress', (p) => {
    el.launcherProgress().style.display = 'block';
    el.launcherProgressFill().style.width = p.percent + '%';
    el.launcherProgressPct().textContent = p.percent + '%';
    el.launcherUpdateBtn().textContent = `DOWNLOADING... ${p.percent}%`;
    el.launcherUpdateBtn().disabled = true;
  });

  window.launcher.on('launcher-update-downloaded', () => {
    S.launcherUpdateState = 'ready';
    el.launcherProgress().style.display = 'none';
    el.launcherReadyMsg().style.display = 'block';
    el.launcherUpdateBtn().textContent = 'RESTART & INSTALL';
    el.launcherUpdateBtn().disabled = false;
  });

  window.launcher.on('launcher-update-error', (msg) => {
    console.error('Launcher update error:', msg);
    el.launcherUpdateBtn().textContent = 'RETRY UPDATE';
    el.launcherUpdateBtn().disabled = false;
    S.launcherUpdateState = 'available';
  });
}

// Called from HTML onclick
window.handleLauncherUpdate = async function () {
  if (S.launcherUpdateState === 'ready') {
    await window.launcher.installLauncherUpdate();
  } else if (S.launcherUpdateState === 'available') {
    S.launcherUpdateState = 'downloading';
    el.launcherUpdateBtn().textContent = 'STARTING DOWNLOAD...';
    el.launcherUpdateBtn().disabled = true;
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
    el.btnMain().classList.add('btn-disabled');
    el.btnMainText().textContent = 'OFFLINE';
    return;
  }

  S.localState = await window.launcher.getGameState();

  // Update strip version
  el.stripGameVer().textContent = `v${manifest.latestVersion}`;

  // Determine state
  if (!S.localState.installed) {
    setAppState('install');
  } else if (S.localState.version !== manifest.latestVersion) {
    setAppState('update');
  } else {
    setAppState('play');
  }

  // Populate changelog
  renderChangelog(manifest.changelog);
}

// ─── SET APP STATE ────────────────────────────────────────────────────────────
function setAppState(state) {
  S.appState = state;
  const btn = el.btnMain();
  const text = el.btnMainText();

  // Reset button
  btn.className = 'btn-main';
  el.progressZone().classList.add('hidden');
  btn.classList.remove('hidden');
  el.btnCloseGame().classList.add('hidden');
  S.gameRunning = false;
  clearTimeout(S.closeGameTimer);

  if (state === 'play') {
    text.textContent = 'LAUNCH';
    setStatus('ready', `INSTALLED  ·  v${S.localState?.version || ''}`);
    el.secondaryBtns().style.display = 'flex';
    el.stripStatus().textContent = 'INSTALLED';
  }
  else if (state === 'update') {
    btn.classList.add('btn-update');
    text.textContent = 'UPDATE';
    setStatus('warning', `UPDATE REQUIRED  ·  v${S.manifest?.latestVersion}`);
    el.secondaryBtns().style.display = 'none';
    el.stripStatus().textContent = 'UPDATE AVAIL';
  }
  else if (state === 'install') {
    btn.classList.add('btn-install');
    text.textContent = 'INSTALL';
    setStatus('error', 'NOT INSTALLED');
    el.secondaryBtns().style.display = 'none';
    el.stripStatus().textContent = 'NOT INSTALLED';
  }
}

function setStatus(type, text) {
  const dot = el.statusDot();
  dot.className = 'status-dot';
  dot.style.background = '';
  dot.style.boxShadow = '';

  if (type === 'ready') {
    dot.style.background = 'var(--white)';
    dot.style.boxShadow = '0 0 8px var(--white)';
  } else if (type === 'warning') {
    dot.classList.add('warning');
  } else if (type === 'error') {
    dot.classList.add('error');
  } else if (type === 'running') {
    dot.classList.add('running');
  }
  el.statusText().textContent = text;
}

// ─── MAIN ACTION BUTTON ───────────────────────────────────────────────────────
window.handleMainAction = async function () {
  if (S.appState === 'play') {
    await launchGame();
  } else if (S.appState === 'update' || S.appState === 'install') {
    await startInstall();
  }
};

// ─── LAUNCH GAME ─────────────────────────────────────────────────────────────
async function launchGame() {
  try {
    await window.launcher.launchGame();
    setRunningState();
  } catch (err) {
    console.error('Launch failed:', err);
  }
}

function setRunningState() {
  S.gameRunning = true;
  S.appState = 'running';

  el.btnMain().classList.add('btn-disabled');
  el.btnMainText().textContent = 'RUNNING';
  setStatus('running', 'GAME IS RUNNING');
  el.stripStatus().textContent = 'RUNNING';

  // Show close button after 3 seconds (safety delay — prevents instant kill)
  S.closeGameTimer = setTimeout(() => {
    if (S.gameRunning) {
      el.btnCloseGame().classList.remove('hidden');
    }
  }, 3000);
}

// ─── CLOSE GAME ───────────────────────────────────────────────────────────────
window.handleCloseGame = async function () {
  try {
    await window.launcher.closeGame();
  } catch (err) {
    console.error('Close game error:', err);
  }
  S.gameRunning = false;
  clearTimeout(S.closeGameTimer);
  el.btnCloseGame().classList.add('hidden');
  setAppState('play');
};

// ─── INSTALL / UPDATE GAME ────────────────────────────────────────────────────
async function startInstall() {
  if (!S.manifest) return;
  S.appState = 'installing';

  el.btnMain().classList.add('hidden');
  el.progressZone().classList.remove('hidden');
  el.secondaryBtns().style.display = 'none';
  setStatus('ready', 'DOWNLOADING...');
  el.stripStatus().textContent = 'DOWNLOADING';

  // Listen for progress
  window.launcher.on('game-download-progress', (data) => {
    el.dlFill().style.width = data.percent + '%';
    el.dlPct().textContent = data.percent + '%';
    const mb = Math.round((data.downloaded / 1024 / 1024));
    const total = Math.round((data.total / 1024 / 1024));
    el.dlLabel().textContent = `${mb} MB / ${total} MB`;
  });

  // Listen for completion
  window.launcher.on('game-install-complete', async (data) => {
    S.localState = await window.launcher.getGameState();
    el.stripGameVer().textContent = `v${data.version}`;
    setAppState('play');
  });

  try {
    await window.launcher.installGame({
      version: S.manifest.latestVersion,
      downloadUrl: S.manifest.downloadUrl,
      totalSize: S.manifest.totalSize,
    });
  } catch (err) {
    console.error('Install failed:', err);
    setAppState('install');
  }
}

// ─── CHANGELOG ────────────────────────────────────────────────────────────────
function renderChangelog(changelog) {
  const container = document.getElementById('changelogContent');
  if (!changelog || changelog.length === 0) return;

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

// ─── CHANGELOG DRAWER ─────────────────────────────────────────────────────────
window.openDrawer = function () {
  el.drawerOverlay().classList.add('open');
};
window.closeDrawer = function (e) {
  if (!e || e.target === el.drawerOverlay()) {
    el.drawerOverlay().classList.remove('open');
  }
};

// ─── OPEN EXTERNAL ────────────────────────────────────────────────────────────
window.openExternal = function (url) {
  window.launcher.openExternal(url);
};

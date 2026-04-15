const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');

// AMD RX 7900 XT + Electron 27 — disable GPU process entirely
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('disable-software-rasterizer');
const path = require('path');
const Store = require('electron-store');
const fs = require('fs');
const { spawn, exec } = require('child_process');

const store = new Store();
let mainWindow;
let serverProcess = null;

const isDev = !app.isPackaged;

function startServer() {
  if (isDev) return;
  try {
    const serverPath = path.join(process.resourcesPath, 'app.asar.unpacked', 'server', 'index.js');
    console.log('[Main] Starting server from:', serverPath);
    console.log('[Main] Server file exists:', fs.existsSync(serverPath));
    console.log('[Main] resourcesPath:', process.resourcesPath);

    // Use bundled node first, then fall back to system node
    const bundledNode = path.join(process.resourcesPath, 'node', 'node.exe');
    const candidates = [
      bundledNode,
      'C:\\Program Files\\nodejs\\node.exe',
      'C:\\Program Files (x86)\\nodejs\\node.exe',
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'nodejs', 'node.exe'),
    ];
    const nodeExe = candidates.find(p => { try { return fs.existsSync(p); } catch { return false; } });
    console.log('[Main] Found node at:', nodeExe || 'NOT FOUND — trying PATH');

    serverProcess = spawn(nodeExe || 'node', [serverPath], {
      env: { 
        ...process.env, 
        APPDATA: app.getPath('userData'),
        NODE_PATH: path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules'),
      },
      stdio: 'pipe',
      detached: false,
      shell: !nodeExe
    });
    serverProcess.stdout?.on('data', d => console.log('[Server]', d.toString().trim()));
    serverProcess.stderr?.on('data', d => console.error('[Server ERR]', d.toString().trim()));
    serverProcess.on('error', e => console.error('[Server spawn error]', e.message));
    serverProcess.on('exit', code => console.log('[Server] exited with code:', code));
    console.log('[Main] Server pid:', serverProcess.pid);
  } catch(e) {
    console.error('[Main] Failed to start server:', e.message);
  }
}

function waitForServer(callback, attempts = 0) {
  const http = require('http');
  const req = http.get('http://localhost:3001/api/config', (res) => {
    callback();
  });
  req.on('error', () => {
    if (attempts < 30) {
      setTimeout(() => waitForServer(callback, attempts + 1), 500);
    } else {
      console.log('[Main] Server never came up after 15s, loading anyway');
      callback();
    }
  });
  req.end();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: '#040714',
    titleBarStyle: 'hidden',
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
      allowRunningInsecureContent: true
    },
    show: false
  });

  Menu.setApplicationMenu(null);

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12') {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  if (isDev) {
    // Dev: load from React dev server
    mainWindow.loadURL('http://localhost:3000');
    mainWindow.webContents.on('did-fail-load', () => {
      setTimeout(() => { if (mainWindow) mainWindow.loadURL('http://localhost:3000'); }, 2000);
    });
  } else {
    // Production: load built React files, wait for server to be ready
    const indexPath = path.join(__dirname, 'build', 'index.html');
    waitForServer(() => {
      mainWindow.loadFile(indexPath);
    });
  }

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  startServer();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (serverProcess) serverProcess.kill();
  if (process.platform !== 'darwin') app.quit();
});

// ── IPC ──────────────────────────────────────────────────────────────────────
ipcMain.handle('window-minimize',   () => mainWindow?.minimize());
ipcMain.handle('window-maximize',   () => { if (mainWindow?.isMaximized()) mainWindow.unmaximize(); else mainWindow?.maximize(); });
ipcMain.handle('window-close',      () => mainWindow?.close());
ipcMain.handle('window-is-maximized', () => mainWindow?.isMaximized());

ipcMain.handle('open-file-dialog', async (_, options) => {
  return await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: options?.filters || [{ name: 'Media Files', extensions: ['mp4','mkv','avi','mov','wmv','flv','m4v','ts','m2ts'] }]
  });
});
ipcMain.handle('open-folder-dialog', async () => {
  return await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'multiSelections'] });
});
ipcMain.handle('open-m3u-dialog', async () => {
  return await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: [{ name: 'IPTV Playlist', extensions: ['m3u','m3u8'] }] });
});

ipcMain.handle('store-get',    (_, key, def) => store.get(key, def));
ipcMain.handle('store-set',    (_, key, val) => store.set(key, val));
ipcMain.handle('store-delete', (_, key)      => store.delete(key));
ipcMain.handle('store-clear',  ()            => store.clear());

ipcMain.handle('open-external', (_, url) => shell.openExternal(url));

ipcMain.handle('read-directory', async (_, dirPath) => {
  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    return entries.map(e => ({ name: e.name, isDirectory: e.isDirectory(), path: path.join(dirPath, e.name) }));
  } catch (err) { return { error: err.message }; }
});
ipcMain.handle('get-file-info', async (_, filePath) => {
  try {
    const stat = await fs.promises.stat(filePath);
    return { size: stat.size, mtime: stat.mtime, exists: true };
  } catch { return { exists: false }; }
});
ipcMain.handle('get-ffmpeg-path', () => path.join(__dirname, 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'));

// ── Ollama auto-installer ────────────────────────────────────────────────────
const https = require('https');
const os = require('os');

ipcMain.handle('ollama-get-platform', () => ({
  platform: process.platform,  // 'win32' | 'darwin' | 'linux'
  arch: process.arch,          // 'x64' | 'arm64'
}));

ipcMain.handle('ollama-install', async (event) => {
  const platform = process.platform;
  const arch = process.arch;
  const tmpDir = os.tmpdir();
  const send = (msg) => {
    try { event.sender.send('ollama-install-progress', msg); } catch {}
  };

  send({ stage: 'detecting', msg: `Detected: ${platform} ${arch}` });

  // ── Windows ──────────────────────────────────────────────────────────────
  if (platform === 'win32') {
    const url = 'https://ollama.com/download/OllamaSetup.exe';
    const dest = path.join(tmpDir, 'OllamaSetup.exe');
    send({ stage: 'downloading', msg: 'Downloading Ollama installer for Windows…', url });

    try {
      let lastPct = -1;
      await downloadFile(url, dest, (pct) => {
        if (pct - lastPct >= 5 || pct === 100) { lastPct = pct; send({ stage: 'downloading', pct, msg: `Downloading… ${pct}%` }); }
      });
      send({ stage: 'installing', msg: 'Launching OllamaSetup.exe…' });
      // Use shell.openPath so Windows launches the exe normally with its UI visible
      const { shell: electronShell } = require('electron');
      const openErr = await electronShell.openPath(dest);
      if (openErr) {
        // Fallback: try exec if openPath failed
        try { exec(`"${dest}"`, { windowsHide: false }); } catch(_) {}
      }
      send({ stage: 'launched', msg: 'Installer is open — complete the setup wizard, then click Test Connection.' });
      return { ok: true, msg: 'Installer launched' };
    } catch (e) {
      send({ stage: 'error', msg: e.message });
      return { ok: false, error: e.message };
    }
  }

  // ── macOS ─────────────────────────────────────────────────────────────────
  if (platform === 'darwin') {
    const url = arch === 'arm64'
      ? 'https://ollama.com/download/Ollama-darwin.zip'
      : 'https://ollama.com/download/Ollama-darwin.zip';
    const dest = path.join(tmpDir, 'Ollama.zip');
    send({ stage: 'downloading', msg: 'Downloading Ollama for macOS…', url });

    try {
      let lastPctMac = -1;
      await downloadFile(url, dest, (pct) => {
        if (pct - lastPctMac >= 5 || pct === 100) { lastPctMac = pct; send({ stage: 'downloading', pct, msg: `Downloading… ${pct}%` }); }
      });
      send({ stage: 'installing', msg: 'Extracting to /Applications…' });
      await runCmd(`unzip -o "${dest}" -d "/Applications/" && xattr -dr com.apple.quarantine "/Applications/Ollama.app"`);
      send({ stage: 'launching', msg: 'Starting Ollama…' });
      await runCmd('open -a Ollama');
      send({ stage: 'done', msg: 'Ollama installed and started. Click "Test Connection" to verify.' });
      return { ok: true };
    } catch (e) {
      send({ stage: 'error', msg: e.message });
      return { ok: false, error: e.message };
    }
  }

  // ── Linux ─────────────────────────────────────────────────────────────────
  if (platform === 'linux') {
    send({ stage: 'installing', msg: 'Running official Ollama install script…' });
    try {
      await runCmd('curl -fsSL https://ollama.com/install.sh | sh', { shell: true, timeout: 120000 });
      send({ stage: 'launching', msg: 'Starting ollama service…' });
      await runCmd('systemctl --user start ollama || ollama serve &', { shell: true });
      send({ stage: 'done', msg: 'Ollama installed. Click "Test Connection" to verify.' });
      return { ok: true };
    } catch (e) {
      send({ stage: 'error', msg: e.message });
      return { ok: false, error: e.message };
    }
  }

  return { ok: false, error: `Unsupported platform: ${platform}` };
});

function downloadFile(url, dest, onProgress) {
  // First resolve all redirects, then stream to file
  return new Promise((resolve, reject) => {
    const http  = require('http');
    const https = require('https');

    function followRedirects(u, redirectCount, cb) {
      if (redirectCount > 10) return cb(new Error('Too many redirects'));
      const mod = u.startsWith('https') ? https : http;
      const req = mod.get(u, { headers: { 'User-Agent': 'Orion/1.0' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // Consume body so socket is released
          res.resume();
          const next = res.headers.location.startsWith('http')
            ? res.headers.location
            : new URL(res.headers.location, u).href;
          return followRedirects(next, redirectCount + 1, cb);
        }
        cb(null, res, u);
      });
      req.on('error', cb);
    }

    followRedirects(url, 0, (err, res, finalUrl) => {
      if (err) return reject(err);
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} at ${finalUrl}`));

      const total = parseInt(res.headers['content-length'] || '0');
      let received = 0;
      const file = fs.createWriteStream(dest);

      res.on('data', chunk => {
        received += chunk.length;
        file.write(chunk);
        if (total > 0 && onProgress) onProgress(Math.round((received / total) * 100));
      });
      res.on('end', () => { file.end(); resolve(); });
      res.on('error', (e) => { file.destroy(); reject(e); });
      file.on('error', reject);
    });
  });
}

function runCmd(cmd, opts = {}) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: opts.timeout || 60000, ...opts }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

// Open streaming services in a real browser window (avoids iframe/X-Frame-Options blocks)
ipcMain.handle('open-streaming-window', (_, { url, title }) => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: title || 'Orion — Streaming',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // Spoof user agent so sites don't block Electron
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  });
  win.loadURL(url);
  win.setMenu(null);
});

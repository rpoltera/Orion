#!/usr/bin/env node
// orion-preseg — standalone preseg service for Orion Media Server
// Runs on localhost:3002. Owns preseg.json + probe-cache.json + preseg_temp/.
// Spawns ffmpeg workers. Independent event loop from orion (3001).

'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// === Paths ===
const CONFIG_PATH = '/var/lib/orion/config.json';
const SF_DIR = '/var/lib/orion/sf';
const PRESEG_JSON = path.join(SF_DIR, 'preseg.json');
const PROBE_CACHE = path.join(SF_DIR, 'probe-cache.json');
const PRESEG_TEMP = path.join(SF_DIR, 'preseg_temp');
const DEFAULT_PORT = 3002;

// === Orion DB (hls_status writes) ===
let _orionDb = null;
function _ensureOrionDb() {
  if (_orionDb) return _orionDb;
  try {
    const Database = require('better-sqlite3');
    const dbPath = process.env.ORION_DB || '/var/lib/orion/orion.db';
    _orionDb = new Database(dbPath);
    _orionDb.exec(`
      CREATE TABLE IF NOT EXISTS hls_status (
        mediaId TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        hlsDir TEXT,
        segCount INTEGER,
        filePath TEXT,
        updatedAt INTEGER,
        source TEXT,
        error TEXT,
        kind TEXT
      )
    `);
    _orionDb.exec('CREATE INDEX IF NOT EXISTS idx_hls_status_status ON hls_status(status)');
    console.log('[DB] orion.db opened for hls_status writes');
    return _orionDb;
  } catch (e) {
    console.error('[DB] cannot open orion.db:', e.message);
    return null;
  }
}
function writeHlsStatus(mediaId, status, opts) {
  const db = _ensureOrionDb();
  if (!db) return;
  opts = opts || {};
  try {
    db.prepare(`
      INSERT INTO hls_status (mediaId, status, hlsDir, segCount, filePath, updatedAt, source, error)
      VALUES (?, ?, ?, ?, ?, ?, 'preseg-service', ?)
      ON CONFLICT(mediaId) DO UPDATE SET
        status=excluded.status,
        hlsDir=COALESCE(excluded.hlsDir, hls_status.hlsDir),
        segCount=COALESCE(excluded.segCount, hls_status.segCount),
        filePath=COALESCE(excluded.filePath, hls_status.filePath),
        updatedAt=excluded.updatedAt,
        source='preseg-service',
        error=excluded.error
    `).run(mediaId, status, opts.hlsDir || null, opts.segCount || null, opts.filePath || null, Date.now(), opts.error || null);
  } catch (e) {
    console.error('[DB] hls_status write failed:', e.message);
  }
}
function closeOrionDb() {
  if (_orionDb) { try { _orionDb.close(); } catch {} _orionDb = null; }
}
process.on('exit', () => closeOrionDb());

// === Config ===
function loadConfig() {
  try {
    const root = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const svc = (root.services && root.services.preseg) || {};
    const inner = svc.config || {};
    return {
      enabled: svc.enabled !== false,
      port: svc.port || DEFAULT_PORT,
      workers: parseInt(inner.workers, 10) || 0,
      skip10Bit: inner.skip10Bit !== false,
      hwAccel: (inner.hwAccel || 'cpu').toLowerCase(),
      gpuCount: Math.max(1, parseInt(inner.gpuCount, 10) || 1),
      maxGpuPreseg: parseInt(inner.maxGpuPreseg, 10) || 4,
      maxCpuPreseg: parseInt(inner.maxCpuPreseg, 10) || 2,
      route10BitToCpu: inner.route10BitToCpu === true,
    };
  } catch (e) {
    console.error('[Config] load failed:', e.message);
    return { enabled: false, port: DEFAULT_PORT, gpuCount: 1, hwAccel: 'cpu' };
  }
}

let cfg = loadConfig();
let MAX_GPU = 0, MAX_CPU = 0;
let gpuWorkerCount = new Array(cfg.gpuCount).fill(0);
let cpuWorkerCount = 0;

function applyLimits() {
  cfg = loadConfig();
  if (gpuWorkerCount.length !== cfg.gpuCount) {
    gpuWorkerCount = new Array(cfg.gpuCount).fill(0);
  }
  const total = cfg.workers;
  if (total > 0) {
    if (cfg.route10BitToCpu) {
      MAX_GPU = Math.max(1, Math.ceil(total * 0.8));
      MAX_CPU = Math.max(0, total - MAX_GPU);
    } else {
      MAX_GPU = total; MAX_CPU = 0;
    }
  } else {
    MAX_GPU = Math.max(0, cfg.maxGpuPreseg);
    MAX_CPU = Math.max(0, cfg.maxCpuPreseg);
  }
}

// === State ===
let presegDb = {};
let presegQueue = [];
let pendingCache = null; // lazy cache of mediaIds with status='pending'

// === DB persistence (debounced async writes) ===
let saveTimer = null;
let saveInflight = false;
function saveDb() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (saveInflight) { saveTimer = setTimeout(saveDb, 500); return; }
    saveInflight = true;
    const tmp = PRESEG_JSON + '.tmp';
    fs.writeFile(tmp, JSON.stringify(presegDb), (err) => {
      if (err) { console.error('[DB] write failed:', err.message); saveInflight = false; return; }
      fs.rename(tmp, PRESEG_JSON, (err2) => {
        saveInflight = false;
        if (err2) console.error('[DB] rename failed:', err2.message);
      });
    });
  }, 2000);
}
function flushDbSync() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try { fs.writeFileSync(PRESEG_JSON, JSON.stringify(presegDb)); }
  catch (e) { console.error('[DB] sync flush:', e.message); }
}
function loadDb() {
  try {
    presegDb = JSON.parse(fs.readFileSync(PRESEG_JSON, 'utf8'));
    console.log(`[DB] Loaded ${Object.keys(presegDb).length} items`);
  } catch (e) {
    presegDb = {};
    console.log('[DB] Starting empty (no preseg.json found)');
  }
  let zombies = 0;
  for (const mid in presegDb) {
    if (presegDb[mid].status === 'processing') {
      presegDb[mid].status = 'queued'; zombies++;
    }
  }
  if (zombies) console.log(`[DB] Reset ${zombies} zombie processing → queued`);
  rebuildQueue();
}
function rebuildQueue() {
  presegQueue = [];
  pendingCache = null;
  for (const mid in presegDb) {
    if (presegDb[mid].status === 'queued' && presegDb[mid].filePath) {
      presegQueue.push({ mediaId: mid, filePath: presegDb[mid].filePath, priority: false });
    }
  }
  console.log(`[Queue] Rebuilt: ${presegQueue.length} queued items`);
}

// === Probe cache ===
let probeCache = {};
let probeCacheTimer = null;
function loadProbeCache() {
  try { probeCache = JSON.parse(fs.readFileSync(PROBE_CACHE, 'utf8')); }
  catch { probeCache = {}; }
}
function saveProbeCache() {
  if (probeCacheTimer) return;
  probeCacheTimer = setTimeout(() => {
    probeCacheTimer = null;
    fs.writeFile(PROBE_CACHE, JSON.stringify(probeCache), () => {});
  }, 5000);
}
function probe10Bit(filePath, callback) {
  let stat;
  try { stat = fs.statSync(filePath); } catch { return callback(false); }
  const key = `${filePath}:${stat.size}:${stat.mtimeMs}`;
  if (key in probeCache) return callback(probeCache[key]);
  const p = spawn('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=pix_fmt,profile',
    '-of', 'csv=p=0', filePath
  ], { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  p.stdout.on('data', d => { out += d.toString(); });
  p.on('exit', () => {
    const is10 = /\b10\b|main 10|p010|yuv420p10/i.test(out);
    probeCache[key] = is10;
    saveProbeCache();
    callback(is10);
  });
  p.on('error', () => callback(false));
}

// === GPU assignment ===
function assignGpu() {
  let min = Infinity, idx = 0;
  for (let i = 0; i < gpuWorkerCount.length; i++) {
    if (gpuWorkerCount[i] < min) { min = gpuWorkerCount[i]; idx = i; }
  }
  return idx;
}

// === ffmpeg arg builder ===
function buildFfmpegArgs(filePath, tempDir, useCpu, gpuId, is10) {
  const args = ['-y'];
  const useNvenc = !useCpu && cfg.hwAccel === 'nvenc';
  if (useNvenc) {
    args.push('-hwaccel', 'cuda', '-hwaccel_device', String(gpuId), '-hwaccel_output_format', 'cuda');
  }
  args.push('-i', filePath, '-map', '0:v:0', '-map', '0:a:0?');
  if (is10) {
    if (useNvenc) args.push('-vf', 'scale_cuda=format=yuv420p');
    else args.push('-pix_fmt', 'yuv420p');
  }
  if (useCpu || cfg.hwAccel === 'cpu') {
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23');
  } else if (cfg.hwAccel === 'nvenc') {
    args.push('-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '23');
  } else {
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23');
  }
  args.push('-c:a', 'aac', '-b:a', '128k', '-ac', '2');
  args.push(
    '-f', 'hls', '-hls_time', '6', '-hls_list_size', '0',
    '-hls_flags', 'independent_segments',
    '-hls_segment_filename', path.join(tempDir, 'seg%05d.ts'),
    path.join(tempDir, 'index.m3u8')
  );
  return args;
}

// === Move temp → NAS (sibling .hls dir of source file) ===
function moveToNas(mediaId, filePath, tempDir, callback) {
  const targetDir = path.join(path.dirname(filePath), '.hls', mediaId);
  fs.mkdir(targetDir, { recursive: true }, (err) => {
    if (err) return callback(err);
    fs.readdir(tempDir, (err2, files) => {
      if (err2) return callback(err2);
      if (files.length === 0) return callback(new Error('no files to move'));
      let pending = files.length;
      let lastErr = null;
      const tryRename = (file, done) => {
        const src = path.join(tempDir, file);
        const dst = path.join(targetDir, file);
        fs.rename(src, dst, (e) => {
          if (!e) return done();
          fs.copyFile(src, dst, (ce) => {
            if (ce) { lastErr = ce; return done(); }
            fs.unlink(src, () => done());
          });
        });
      };
      files.forEach(f => tryRename(f, () => {
        if (--pending === 0) {
          if (lastErr) return callback(lastErr);
          fs.rmdir(tempDir, () => callback(null));
        }
      }));
    });
  });
}

// === Worker ===
function runWorker(item, useCpu) {
  const { mediaId, filePath } = item;
  try { fs.accessSync(filePath); }
  catch {
    presegDb[mediaId] = { ...(presegDb[mediaId] || {}), status: 'error', filePath, error: 'source file not accessible', failedAt: Date.now() };
    writeHlsStatus(mediaId, 'error', { filePath, error: 'source file not accessible' });
    saveDb();
    afterWorker(useCpu, -1);
    return;
  }
  probe10Bit(filePath, (is10) => {
    if (is10 && cfg.skip10Bit) {
      console.log(`[Worker] 10-bit SKIPPED: ${path.basename(filePath)}`);
      presegDb[mediaId] = { ...(presegDb[mediaId] || {}), status: 'skipped-10bit', filePath, skippedAt: Date.now() };
      saveDb();
      afterWorker(useCpu, -1);
      return;
    }
    actuallySpawn(item, useCpu, is10);
  });
}

function actuallySpawn(item, useCpu, is10) {
  const { mediaId, filePath } = item;
  const gpuId = useCpu ? -1 : assignGpu();
  if (gpuId >= 0) gpuWorkerCount[gpuId]++;
  if (useCpu) cpuWorkerCount++;

  presegDb[mediaId] = {
    ...(presegDb[mediaId] || {}),
    status: 'processing', filePath,
    startedAt: Date.now(), gpuId
  };
  saveDb();

  const tempDir = path.join(PRESEG_TEMP, mediaId);
  try { fs.mkdirSync(tempDir, { recursive: true }); } catch {}

  console.log(`[Worker] ${mediaId} → GPU${gpuId} ${path.basename(filePath)}`);
  const args = buildFfmpegArgs(filePath, tempDir, useCpu, gpuId, is10);
  args.unshift('-threads', '2');
  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });

  let stderrTail = '';
  proc.stderr.on('data', d => {
    stderrTail += d.toString();
    if (stderrTail.length > 4096) stderrTail = stderrTail.slice(-4096);
  });

  proc.on('exit', (code) => {
    if (code === 0) {
      moveToNas(mediaId, filePath, tempDir, (moveErr) => {
        if (moveErr) {
          const _moveErr = `code=0 moveToNas: ${moveErr.message}`;
          presegDb[mediaId] = {
            ...(presegDb[mediaId] || {}),
            status: 'error', filePath,
            error: _moveErr,
            failedAt: Date.now()
          };
          writeHlsStatus(mediaId, 'error', { filePath, error: _moveErr });
        } else {
          const _hlsDir = path.join(path.dirname(filePath), '.hls', mediaId);
          presegDb[mediaId] = {
            ...(presegDb[mediaId] || {}),
            status: 'done', filePath,
            doneAt: Date.now(),
            hlsDir: _hlsDir
          };
          delete presegDb[mediaId].error;
          delete presegDb[mediaId].failedAt;
          writeHlsStatus(mediaId, 'done', { filePath, hlsDir: _hlsDir });
        }
        saveDb();
        afterWorker(useCpu, gpuId);
      });
    } else {
      const errSummary = stderrTail.split('\n').filter(s => s.trim()).slice(-8).join(' | ');
      const _errMsg = `code=${code} ${errSummary}`;
      presegDb[mediaId] = {
        ...(presegDb[mediaId] || {}),
        status: 'error', filePath,
        error: _errMsg,
        failedAt: Date.now()
      };
      writeHlsStatus(mediaId, 'error', { filePath, error: _errMsg });
      saveDb();
      fs.rm(tempDir, { recursive: true, force: true }, () => {});
      afterWorker(useCpu, gpuId);
    }
  });

  proc.on('error', (err) => {
    const _spawnErr = `spawn: ${err.message}`;
    presegDb[mediaId] = {
      ...(presegDb[mediaId] || {}),
      status: 'error', filePath,
      error: _spawnErr, failedAt: Date.now()
    };
    writeHlsStatus(mediaId, 'error', { filePath, error: _spawnErr });
    saveDb();
    afterWorker(useCpu, gpuId);
  });
}

function afterWorker(useCpu, gpuId) {
  if (useCpu) cpuWorkerCount = Math.max(0, cpuWorkerCount - 1);
  else if (gpuId >= 0) gpuWorkerCount[gpuId] = Math.max(0, gpuWorkerCount[gpuId] - 1);
  setImmediate(drain);
}

// === Drain ===
let drainTimer = null;
function drain() {
  if (!cfg.enabled) return;
  applyLimits();
  if (MAX_GPU === 0 && MAX_CPU === 0) return;

  if (presegQueue.length < 100) {
    if (pendingCache === null) {
      pendingCache = [];
      for (const mid in presegDb) {
        if (presegDb[mid].status === 'pending') pendingCache.push(mid);
      }
    }
    let promoted = 0;
    while (pendingCache.length && promoted < 200) {
      const mid = pendingCache.shift();
      if (presegDb[mid] && presegDb[mid].status === 'pending' && presegDb[mid].filePath) {
        presegDb[mid].status = 'queued';
        presegQueue.push({ mediaId: mid, filePath: presegDb[mid].filePath, priority: false });
        promoted++;
      }
    }
    if (promoted > 0) { console.log(`[Drain] Promoted ${promoted} pending → queued`); saveDb(); }
  }

  let safety = MAX_GPU + MAX_CPU + 4;
  while (safety-- > 0) {
    const gpuTotal = gpuWorkerCount.reduce((a, b) => a + b, 0);
    let useCpu;
    if (gpuTotal < MAX_GPU) useCpu = false;
    else if (cpuWorkerCount < MAX_CPU) useCpu = true;
    else break;
    const item = presegQueue.shift();
    if (!item) break;
    runWorker(item, useCpu);
  }
}
function startDrainLoop() {
  if (drainTimer) clearInterval(drainTimer);
  drainTimer = setInterval(drain, 5000);
  setImmediate(drain);
  console.log('[Drain] Loop started');
}
function stopDrainLoop() {
  if (drainTimer) { clearInterval(drainTimer); drainTimer = null; }
  console.log('[Drain] Loop stopped');
}

// === HTTP API ===
const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/health', (req, res) => res.json({ ok: true, enabled: cfg.enabled, uptime: process.uptime() }));

app.get('/status', (req, res) => {
  const filterChannelId = req.query.channelId; // optional — count only items for this channel
  let done = 0, processing = 0, queued = 0, error = 0, skipped = 0, pending = 0;
  for (const mid in presegDb) {
    if (filterChannelId && presegDb[mid].channelId !== filterChannelId) continue;
    const s = presegDb[mid].status;
    if (s === 'done') done++;
    else if (s === 'processing') processing++;
    else if (s === 'queued') queued++;
    else if (s === 'error') error++;
    else if (s === 'pending') pending++;
    else if (s && s.indexOf('skipped') === 0) skipped++;
  }
  const gpuTotal = gpuWorkerCount.reduce((a, b) => a + b, 0);
  res.json({
    done, processing, queued, error, skipped, pending,
    workers: gpuTotal + cpuWorkerCount,
    maxWorkers: MAX_GPU + MAX_CPU,
    gpuWorkers: gpuTotal, cpuWorkers: cpuWorkerCount,
    maxGpu: MAX_GPU, maxCpu: MAX_CPU,
    gpuPerGpu: gpuWorkerCount.slice(),
    enabled: cfg.enabled,
    total: Object.keys(presegDb).length,
    queueLen: presegQueue.length
  });
});

app.get('/presegged/:mediaId', (req, res) => {
  const entry = presegDb[req.params.mediaId];
  res.json({
    presegged: !!(entry && entry.status === 'done'),
    status: entry ? entry.status : 'unknown',
    hlsDir: (entry && entry.status === 'done') ? entry.hlsDir : null
  });
});

// Per-channel aggregate counts. Returns: { "channelId1": {done, processing, queued, error, skipped, pending, total}, ... }
// "_none" bucket holds items without a channelId (e.g., from /queue not /queue/bulk).
app.get('/status/by-channel', (req, res) => {
  const counts = {};
  for (const mid in presegDb) {
    const v = presegDb[mid];
    const ch = v.channelId || '_none';
    if (!counts[ch]) counts[ch] = { done: 0, processing: 0, queued: 0, error: 0, skipped: 0, pending: 0, total: 0 };
    counts[ch].total++;
    const s = v.status;
    if (s === 'done') counts[ch].done++;
    else if (s === 'processing') counts[ch].processing++;
    else if (s === 'queued') counts[ch].queued++;
    else if (s === 'error') counts[ch].error++;
    else if (s === 'pending') counts[ch].pending++;
    else if (s && s.indexOf('skipped') === 0) counts[ch].skipped++;
  }
  res.json(counts);
});

app.post('/queue', (req, res) => {
  const { mediaId, filePath, priority, channelId } = req.body || {};
  if (!mediaId || !filePath) return res.status(400).json({ error: 'mediaId and filePath required' });
  const cur = presegDb[mediaId];
  if (cur && cur.status === 'done') return res.json({ queued: false, reason: 'already done' });
  if (cur && cur.status === 'processing') return res.json({ queued: false, reason: 'already processing' });
  if (presegQueue.find(q => q.mediaId === mediaId)) return res.json({ queued: false, reason: 'already queued' });
  presegDb[mediaId] = { ...(cur || {}), status: 'queued', filePath, queuedAt: Date.now(), ...(channelId ? { channelId } : {}) };
  delete presegDb[mediaId].error;
  if (priority) presegQueue.unshift({ mediaId, filePath, priority: true });
  else presegQueue.push({ mediaId, filePath, priority: false });
  saveDb();
  setImmediate(drain);
  res.json({ queued: true });
});

// Bulk queue — one HTTP call for many items. Optional top-level channelId tags every item.
// Body: { items: [{mediaId, filePath, channelId?}, ...], channelId?: "default for all items" }
app.post('/queue/bulk', (req, res) => {
  const items = req.body && req.body.items;
  const defaultChannelId = req.body && req.body.channelId;
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items array required' });
  let queued = 0, skipped = 0, errored = 0;
  for (const item of items) {
    if (!item || !item.mediaId || !item.filePath) { errored++; continue; }
    const cur = presegDb[item.mediaId];
    if (cur && cur.status === 'done') { skipped++; continue; }
    if (cur && cur.status === 'processing') { skipped++; continue; }
    if (presegQueue.find(q => q.mediaId === item.mediaId)) { skipped++; continue; }
    const chId = item.channelId || defaultChannelId;
    presegDb[item.mediaId] = {
      ...(cur || {}),
      status: 'queued',
      filePath: item.filePath,
      queuedAt: Date.now(),
      ...(chId ? { channelId: chId } : {})
    };
    delete presegDb[item.mediaId].error;
    presegQueue.push({ mediaId: item.mediaId, filePath: item.filePath, priority: false });
    queued++;
  }
  saveDb();
  setImmediate(drain);
  res.json({ queued, skipped, errored, total: items.length });
});

app.post('/reset/:mediaId', (req, res) => {
  const mid = req.params.mediaId;
  const entry = presegDb[mid];
  if (!entry) return res.status(404).json({ error: 'not found' });
  if (!entry.filePath) return res.status(400).json({ error: 'no filePath on entry' });
  entry.status = 'queued';
  delete entry.error;
  presegQueue.push({ mediaId: mid, filePath: entry.filePath, priority: false });
  saveDb();
  setImmediate(drain);
  res.json({ reset: true });
});

app.delete('/item/:mediaId', (req, res) => {
  const mid = req.params.mediaId;
  if (!presegDb[mid]) return res.status(404).json({ error: 'not found' });
  delete presegDb[mid];
  presegQueue = presegQueue.filter(q => q.mediaId !== mid);
  saveDb();
  res.json({ deleted: true });
});

app.get('/config', (req, res) => res.json(cfg));

app.put('/config', (req, res) => {
  try {
    const root = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    root.services = root.services || {};
    root.services.preseg = root.services.preseg || {};
    if (typeof req.body.enabled === 'boolean') {
      root.services.preseg.enabled = req.body.enabled;
    }
    root.services.preseg.config = root.services.preseg.config || {};
    for (const k of ['workers', 'skip10Bit', 'hwAccel', 'gpuCount', 'maxGpuPreseg', 'maxCpuPreseg', 'route10BitToCpu']) {
      if (k in req.body) root.services.preseg.config[k] = req.body[k];
    }
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(root, null, 2));
    const wasEnabled = cfg.enabled;
    cfg = loadConfig();
    applyLimits();
    if (cfg.enabled && !wasEnabled) startDrainLoop();
    else if (!cfg.enabled && wasEnabled) stopDrainLoop();
    res.json({ updated: true, config: cfg });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// === Shutdown ===
function gracefulShutdown(signal) {
  console.log(`[Service] ${signal} — flushing and exiting`);
  stopDrainLoop();
  flushDbSync();
  process.exit(0);
}
process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.once('SIGINT', () => gracefulShutdown('SIGINT'));

// === Startup ===
function start() {
  console.log(`[Service] orion-preseg starting (pid=${process.pid})`);
  console.log('[Service] config:', JSON.stringify(cfg));
  try {
    fs.mkdirSync(SF_DIR, { recursive: true });
    fs.mkdirSync(PRESEG_TEMP, { recursive: true });
  } catch (e) { console.error('[Service] mkdir:', e.message); }
  loadDb();
  loadProbeCache();
  applyLimits();
  const port = cfg.port || DEFAULT_PORT;
  app.listen(port, '127.0.0.1', () => {
    console.log(`[Service] HTTP listening on http://127.0.0.1:${port}`);
    if (cfg.enabled) startDrainLoop();
    else console.log('[Service] config disabled — HTTP serving but not draining');
  });
}
start();

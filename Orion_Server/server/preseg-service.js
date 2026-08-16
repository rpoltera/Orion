#!/usr/bin/env node
// orion-preseg — standalone preseg service for Orion Media Server
// Runs on localhost:3002. Owns preseg.json + probe-cache.json + preseg_temp/.
// Spawns ffmpeg workers. Independent event loop from orion (3001).

'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

// === Paths ===
const CONFIG_PATH = '/var/lib/orion/config.json';
// M5: honour ORION_DATA_DIR so this runs somewhere other than /var/lib.
const SF_DIR = process.env.ORION_SF_DIR ||
  path.join(process.env.ORION_DATA_DIR || '/var/lib/orion', 'sf');

const PRESEG_OUT = process.env.ORION_PRESEG_OUT ||
  path.join(SF_DIR, 'presegs');
try { fs.mkdirSync(PRESEG_OUT, { recursive: true }); } catch (_) {}
function presegOutDir(mediaId) { return path.join(PRESEG_OUT, String(mediaId)); }
function presegLegacyDir(filePath, mediaId) {
  return path.join(path.dirname(filePath), '.hls', String(mediaId));
}
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
      daysAhead: Math.max(1, Math.min(30, parseInt(inner.daysAhead, 10) || 1)),
      maxGpuPreseg: parseInt(inner.maxGpuPreseg, 10) || 4,
      maxCpuPreseg: parseInt(inner.maxCpuPreseg, 10) || 2,
      route10BitToCpu: inner.route10BitToCpu === true,

      // Daily scheduled-media preseg
      dailyScheduleEnabled: inner.dailyScheduleEnabled === true,
      dailyScheduleTime: inner.dailyScheduleTime || '00:00',
      purgeUnscheduled: inner.purgeUnscheduled !== false,
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
  // [FAST-PATH] Now returns object {is10, codec} so caller can stream-copy h264
  let stat;
  try { stat = fs.statSync(filePath); } catch { return callback({ is10: false, codec: '' }); }
  const key = `${filePath}:${stat.size}:${stat.mtimeMs}`;
  const cached = probeCache[key];
  if (cached && typeof cached === 'object') return callback(cached);
  if (typeof cached === 'boolean') {
    // legacy boolean entry — re-probe to get codec
  }
  const p = spawn('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,pix_fmt,profile',
    '-of', 'csv=p=0', filePath
  ], { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  p.stdout.on('data', d => { out += d.toString(); });
  p.on('exit', () => {
    const is10 = /\b10\b|main 10|p010|yuv420p10/i.test(out);
    const cm = out.toLowerCase().match(/^(h264|hevc|h265|mpeg2video|vp9|av1|mpeg4|wmv\d|vc1)\b/m);
    const codec = cm ? cm[1] : '';
    const result = { is10, codec };
    probeCache[key] = result;
    saveProbeCache();
    callback(result);
  });
  p.on('error', () => callback({ is10: false, codec: '' }));
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
function buildFfmpegArgs(filePath, tempDir, useCpu, gpuId, is10, srcCodec) {
  const args = ['-y'];
  const useNvenc = !useCpu && cfg.hwAccel === 'nvenc';
  // [FAST-PATH] If source is already h264 8-bit, stream-copy video (no encode at all)
  const canStreamCopy = (srcCodec === 'h264') && !is10;
  if (useNvenc && !canStreamCopy) {
    args.push('-hwaccel', 'cuda', '-hwaccel_device', String(gpuId), '-hwaccel_output_format', 'cuda');
  }
  args.push('-i', filePath, '-map', '0:v:0', '-map', '0:a:0?');
  if (canStreamCopy) {
    args.push('-c:v', 'copy');
  } else {
    if (is10) {
      if (useNvenc) args.push('-vf', 'scale_cuda=format=yuv420p');
      else args.push('-pix_fmt', 'yuv420p');
    }
    if (useCpu || cfg.hwAccel === 'cpu') {
      args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23');
    } else if (cfg.hwAccel === 'nvenc') {
      // p2 is faster than p4 (~2x throughput) with minimal visual diff at cq 23
      args.push('-c:v', 'h264_nvenc', '-preset', 'p2', '-rc', 'vbr', '-cq', '23');
    } else {
      args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23');
    }
  }
  // Audio was ending ~144ms short of video in every segment, so playing
  // hundreds of them in sequence drifted badly — the deep-voice effect.
  // aresample=async=1000 keeps audio locked to the video clock, and a
  // fixed rate stops segments from different sources disagreeing.
  // Re-encoding AAC to AAC adds encoder priming delay to every segment —
  // ~144ms each, which accumulates into serious drift across an episode.
  // Copy the audio when it is already AAC and stereo; only re-encode when
  // a downmix is actually required.
  const _srcAudio = (function () {
    try {
      const o = require('child_process').execSync(
        'ffprobe -v error -select_streams a:0 -show_entries stream=codec_name,channels -of csv=p=0 ' +
        JSON.stringify(filePath), { encoding: 'utf8', timeout: 5000 }).trim().split('\n')[0];
      const [codec, chans] = o.split(',');
      return { codec: (codec || '').trim(), channels: parseInt(chans, 10) || 0 };
    } catch (_) { return { codec: '', channels: 0 }; }
  })();

  if (_srcAudio.codec === 'aac' && _srcAudio.channels <= 2) {
    args.push('-c:a', 'copy');
  } else {
    args.push('-c:a', 'aac', '-b:a', '128k', '-ac', '2');
  }
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

  // Excluded trees never get segmented, however they were queued.
  if (_isExcludedPath(filePath)) {
    presegDb[mediaId] = { ...(presegDb[mediaId] || {}), status: 'skipped',
      filePath, error: 'path excluded', skippedAt: Date.now() };
    saveDb();
    afterWorker(useCpu, -1);
    return;
  }

  // Reserve the slot before the async probe below. drain() decides whether
  // to spawn by reading these counters, so incrementing them only after the
  // probe returns let it launch far past the cap.
  const _gpuId = useCpu ? -1 : assignGpu();
  if (_gpuId >= 0) gpuWorkerCount[_gpuId]++;
  if (useCpu) cpuWorkerCount++;

  try { fs.accessSync(filePath); }
  catch {
    presegDb[mediaId] = { ...(presegDb[mediaId] || {}), status: 'error', filePath, error: 'source file not accessible', failedAt: Date.now() };
    writeHlsStatus(mediaId, 'error', { filePath, error: 'source file not accessible' });
    saveDb();
    afterWorker(useCpu, _gpuId);   // release the slot reserved above
    return;
  }
  probe10Bit(filePath, (probeResult) => {
    const is10 = probeResult && probeResult.is10;
    const codec = (probeResult && probeResult.codec) || '';
    if (is10 && cfg.skip10Bit) {
      console.log(`[Worker] 10-bit → convert: ${path.basename(filePath)}`);
      presegDb[mediaId] = { ...(presegDb[mediaId] || {}), status: 'awaiting-convert', filePath, skippedAt: Date.now() };
      // Hand off to convert-service. autoQueuePreseg=true brings it back here once 8-bit.
      try {
        const convReq = http.request({
          host: '127.0.0.1', port: 3003, path: '/queue', method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        }, (cres) => { cres.resume(); });
        convReq.on('error', (err) => console.log(`[Worker] convert handoff failed for ${mediaId}: ${err.message}`));
        convReq.write(JSON.stringify({ mediaId, filePath }));
        convReq.end();
      } catch (err) {
        console.log(`[Worker] convert handoff exception for ${mediaId}: ${err.message}`);
      }
      saveDb();
      afterWorker(useCpu, _gpuId);   // release the slot reserved above
      return;
    }
    actuallySpawn(item, useCpu, is10, codec, _gpuId);
  });
}

function actuallySpawn(item, useCpu, is10, srcCodec, reservedGpu) {
  const { mediaId, filePath } = item;
  // The slot was already reserved in runWorker; assigning and counting a
  // second one here is what let the worker count run away.
  const gpuId = (reservedGpu === undefined)
    ? (useCpu ? -1 : assignGpu())
    : reservedGpu;
  if (reservedGpu === undefined) {
    if (gpuId >= 0) gpuWorkerCount[gpuId]++;
    if (useCpu) cpuWorkerCount++;
  }

  presegDb[mediaId] = {
    ...(presegDb[mediaId] || {}),
    status: 'processing', filePath,
    startedAt: Date.now(), gpuId
  };
  saveDb();

  const tempDir = path.join(PRESEG_TEMP, mediaId);
  try { fs.mkdirSync(tempDir, { recursive: true }); } catch {}

  console.log(`[Worker] ${mediaId} → GPU${gpuId} ${path.basename(filePath)}`);
  const args = buildFfmpegArgs(filePath, tempDir, useCpu, gpuId, is10, srcCodec);
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


// === Daily Scheduled Media Preseg ============================================
let dailyTimer = null;
let lastDailyRunDate = null;

function getJsonFromOrion(reqPath) {
  return new Promise((resolve, reject) => {
    const http = require('http');
    const r = http.request({
      hostname: '127.0.0.1',
      port: 3001,
      path: reqPath,
      method: 'GET',
      timeout: 120000
    }, resp => {
      let body = '';
      resp.on('data', d => body += d);
      resp.on('end', () => {
        if (resp.statusCode < 200 || resp.statusCode >= 300) {
          return reject(new Error('Orion HTTP ' + resp.statusCode + ': ' + body.slice(0,300)));
        }
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('Invalid Orion JSON: ' + e.message)); }
      });
    });
    r.on('error', reject);
    r.on('timeout', () => r.destroy(new Error('Orion schedule timeout')));
    r.end();
  });
}

function localDayWindow(now = new Date(), days) {
  // Was fixed at one day. Callers can now ask for a longer window; the
  // default stays 1 so existing behaviour is unchanged.
  const n = Math.max(1, Math.min(30,
    parseInt(days !== undefined ? days : cfg.daysAhead, 10) || 1));

  const from = new Date(now);
  from.setHours(0, 0, 0, 0);

  const to = new Date(from);
  to.setDate(to.getDate() + n);

  return { from: from.getTime(), to: to.getTime(), days: n };
}

function clearHlsStatus(mediaId) {
  try {
    const db = _ensureOrionDb();
    if (db) db.prepare('DELETE FROM hls_status WHERE mediaId = ?').run(mediaId);
  } catch (e) {
    console.error('[DailyPreseg] hls_status delete failed:', mediaId, e.message);
  }
}

function removeEntryHls(mediaId, entry) {
  if (!entry) return false;

  const candidates = new Set();

  if (entry.hlsDir) candidates.add(entry.hlsDir);
  if (entry.segDir) candidates.add(entry.segDir);

  if (entry.filePath) {
    // Current external preseg-service layout
    candidates.add(path.join(path.dirname(entry.filePath), '.hls', mediaId));

    // Legacy/in-process Orion layout
    const fileBase = path.basename(entry.filePath, path.extname(entry.filePath));
    candidates.add(path.join(path.dirname(entry.filePath), '.hls', fileBase));
  }

  let removed = false;

  for (const dir of candidates) {
    try {
      if (dir && fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
        console.log('[DailyPreseg] Removed: ' + dir);
        removed = true;
      }
    } catch (e) {
      console.error('[DailyPreseg] Failed removing ' + dir + ': ' + e.message);
    }
  }

  return removed;
}

// Paths that should never be pre-segmented. Matched as substrings, so
// '/MusicVids/' covers the whole tree. Configurable via excludePaths.
function _excludedPaths() {
  const v = cfg.excludePaths;
  if (Array.isArray(v)) return v.filter(Boolean);
  if (typeof v === 'string' && v.trim()) {
    return v.split(',').map(x => x.trim()).filter(Boolean);
  }
  return ['/MusicVids/'];
}

function _isExcludedPath(p) {
  if (!p) return false;
  const list = _excludedPaths();
  for (const frag of list) if (p.includes(frag)) return true;
  return false;
}

async function runDailyScheduledPreseg(opts = {}) {
  const purge = opts.purge !== undefined ? !!opts.purge : cfg.purgeUnscheduled !== false;

  const { from, to, days } = localDayWindow(new Date(), opts.days);
  console.log(
    '[DailyPreseg] Building ' + days + ' day(s): ' +
    new Date(from).toString() + ' -> ' + new Date(to).toString()
  );

  const schedule = await getJsonFromOrion(
    '/api/sf/schedule?from=' + encodeURIComponent(from) +
    '&to=' + encodeURIComponent(to)
  );

  const needed = new Map();

  for (const channel of Array.isArray(schedule) ? schedule : []) {
    const channelId = channel?.channel?.id || null;

    for (const prog of (channel.programs || [])) {
      if (!prog || !prog.mediaId || !prog.filePath) continue;

      // IPTV/remote streams are never presegged
      if (/^https?:\/\//i.test(prog.filePath)) continue;

      // Excluded trees — music videos by default.
      if (_isExcludedPath(prog.filePath)) continue;

      needed.set(prog.mediaId, {
        mediaId: prog.mediaId,
        filePath: prog.filePath,
        channelId
      });
    }
  }

  const neededIds = new Set(needed.keys());

  console.log('[DailyPreseg] Unique local media scheduled today: ' + neededIds.size);

  let purged = 0;
  let dbRemoved = 0;

  if (purge) {
    // Do not remove an item while its ffmpeg worker is actually processing it.
    for (const [mid, entry] of Object.entries(presegDb)) {
      if (neededIds.has(mid)) continue;
      if (entry && entry.status === 'processing') continue;

      if (removeEntryHls(mid, entry)) purged++;

      delete presegDb[mid];
      clearHlsStatus(mid);
      dbRemoved++;
    }

    // Remove yesterday / library-wide items from the waiting queue.
    presegQueue = presegQueue.filter(q => neededIds.has(q.mediaId));
    pendingCache = null;
  }

  let queued = 0;
  let alreadyDone = 0;
  let missing = 0;

  for (const item of needed.values()) {
    if (!fs.existsSync(item.filePath)) {
      console.warn('[DailyPreseg] Scheduled source missing: ' + item.filePath);
      missing++;
      continue;
    }

    const cur = presegDb[item.mediaId];

    if (cur && cur.status === 'done') {
      // Confirm the actual HLS still exists.
      const hlsDir =
        cur.hlsDir ||
        cur.segDir ||
        path.join(path.dirname(item.filePath), '.hls', item.mediaId);

      if (hlsDir && fs.existsSync(path.join(hlsDir, 'index.m3u8'))) {
        alreadyDone++;
        continue;
      }

      // DB says done but files are gone — requeue it.
      delete presegDb[item.mediaId];
      clearHlsStatus(item.mediaId);
    }

    if (presegDb[item.mediaId]?.status === 'processing') continue;
    if (presegQueue.some(q => q.mediaId === item.mediaId)) continue;

    presegDb[item.mediaId] = {
      ...(presegDb[item.mediaId] || {}),
      status: 'queued',
      filePath: item.filePath,
      channelId: item.channelId,
      queuedAt: Date.now(),
      source: 'daily-schedule'
    };

    presegQueue.push({
      mediaId: item.mediaId,
      filePath: item.filePath,
      priority: false
    });

    queued++;
  }

  saveDb();
  pendingCache = null;
  setImmediate(drain);

  const result = {
    ok: true,
    date: new Date(from).toLocaleDateString(),
    scheduled: neededIds.size,
    queued,
    alreadyDone,
    missing,
    purged,
    dbRemoved,
    purge
  };

  console.log('[DailyPreseg] Result: ' + JSON.stringify(result));
  return result;
}

function startDailyScheduler() {
  if (dailyTimer) clearInterval(dailyTimer);

  // Check the clock every 30 seconds. Run only once per local calendar day.
  dailyTimer = setInterval(() => {
    try {
      cfg = loadConfig();
      if (!cfg.dailyScheduleEnabled) return;

      const now = new Date();
      const hhmm =
        String(now.getHours()).padStart(2, '0') + ':' +
        String(now.getMinutes()).padStart(2, '0');

      const dateKey =
        now.getFullYear() + '-' +
        String(now.getMonth() + 1).padStart(2, '0') + '-' +
        String(now.getDate()).padStart(2, '0');

      if (hhmm !== cfg.dailyScheduleTime) return;
      if (lastDailyRunDate === dateKey) return;

      lastDailyRunDate = dateKey;

      runDailyScheduledPreseg().catch(e => {
        console.error('[DailyPreseg] Scheduled run failed:', e.stack || e.message);
      });
    } catch (e) {
      console.error('[DailyPreseg] Scheduler error:', e.message);
    }
  }, 30000);

  console.log(
    '[DailyPreseg] Scheduler active — enabled=' +
    cfg.dailyScheduleEnabled +
    ' time=' + cfg.dailyScheduleTime
  );
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





// === [SCAN-API] Library scan + folder/file add endpoints ===
const SCAN_VIDEO_EXTS = new Set(['.mp4','.mkv','.avi','.mov','.m4v','.ts','.m2ts','.webm','.mpg','.mpeg','.wmv']);

function _scanWalkVideos(dir, results, depth) {
  results = results || []; depth = depth || 0;
  if (depth > 12) return results;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return results; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) _scanWalkVideos(full, results, depth + 1);
    else if (SCAN_VIDEO_EXTS.has(path.extname(e.name).toLowerCase())) results.push(full);
  }
  return results;
}

function _scanDonePaths() {
  const done = new Set();
  for (const [k, v] of Object.entries(presegDb)) {
    if (v && v.status === 'done' && v.filePath) done.add(v.filePath);
  }
  return done;
}

// Resolve a file path to its real mediaId from the Orion library.
// Segments are looked up by mediaId at playback time, so a made-up id
// means the output can never be found and the work is wasted.
let _pathIdCache = null;
let _pathIdCacheAt = 0;

function _mediaIdForPath(filePath) {
  if (!filePath) return null;

  // Cache the whole path->id map; rebuilding per file would be far worse.
  if (!_pathIdCache || Date.now() - _pathIdCacheAt > 300000) {
    _pathIdCache = new Map();
    _pathIdCacheAt = Date.now();
    try {
      const db = _ensureOrionDb();
      if (db) {
        const rows = db.prepare(
          "SELECT key, value FROM kv_arrays WHERE key IN ('tvShows','movies','music','musicVideos')"
        ).all();
        for (const r of rows) {
          let arr;
          try { arr = JSON.parse(r.value); } catch { continue; }
          if (!Array.isArray(arr)) continue;
          for (const m of arr) {
            const p = m && (m.path || m.filePath);
            if (p && m.id) _pathIdCache.set(p, m.id);
          }
        }
      }
    } catch (e) {
      console.warn('[Scan] could not build path->id map: ' + e.message);
    }
    console.log('[Scan] path->id map: ' + _pathIdCache.size + ' entries');
  }

  return _pathIdCache.get(filePath) || null;
}

function _scanEnqueueItems(items) {
  let queued = 0, skipped = 0;
  for (const it of items) {
    if (!it || !it.filePath) { skipped++; continue; }
    // Prefer the library's own id. A synthetic one produces segments that
    // playback can never resolve, so only use it as a last resort and mark
    // it clearly rather than hiding it behind a timestamp.
    const mid = it.mediaId
      || _mediaIdForPath(it.filePath)
      || ('unlinked-' + Buffer.from(String(it.filePath)).toString('base64url').slice(-24));
    const cur = presegDb[mid];
    if (cur && cur.status === 'done') { skipped++; continue; }
    if (cur && cur.status === 'processing') { skipped++; continue; }
    if (presegQueue.find(q => q.mediaId === mid || q.filePath === it.filePath)) { skipped++; continue; }
    presegDb[mid] = { ...(cur || {}), status: 'queued', filePath: it.filePath, queuedAt: Date.now() };
    delete presegDb[mid].error;
    presegQueue.push({ mediaId: mid, filePath: it.filePath, priority: false });
    queued++;
  }
  if (queued > 0) { saveDb(); setImmediate(drain); }
  return { queued, skipped };
}

// POST /scan-library — find all library files not yet presegged, queue them
app.post('/scan-library', (req, res) => {
  try {
    const Database = require('better-sqlite3');
    const db = new Database('/var/lib/orion/orion.db', { readonly: true });
    const tvRow = db.prepare("SELECT value FROM kv_arrays WHERE key='tvShows'").get();
    const mvRow = db.prepare("SELECT value FROM kv_arrays WHERE key='movies'").get();
    db.close();
    const tv = tvRow ? JSON.parse(tvRow.value) : [];
    const mv = mvRow ? JSON.parse(mvRow.value) : [];
    const done = _scanDonePaths();
    const candidates = [];
    for (const it of [...tv, ...mv]) {
      const fp = it.filePath;
      if (!fp || done.has(fp)) continue;
      try { fs.accessSync(fp); } catch { continue; }
      candidates.push({ mediaId: it.id, filePath: fp });
    }
    const result = _scanEnqueueItems(candidates);
    console.log('[ScanAPI] /scan-library: ' + candidates.length + ' candidates → queued=' + result.queued + ' skipped=' + result.skipped);
    res.json({ ok: true, candidates: candidates.length, queued: result.queued, skipped: result.skipped });
  } catch (e) {
    console.error('[ScanAPI] scan-library error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /add-folder { folderPath }
app.post('/add-folder', (req, res) => {
  try {
    const folderPath = (req.body || {}).folderPath;
    if (!folderPath) return res.status(400).json({ error: 'folderPath required' });
    if (!fs.existsSync(folderPath)) return res.status(404).json({ error: 'folder not found' });
    const files = _scanWalkVideos(folderPath);
    const done = _scanDonePaths();
    const items = files.filter(fp => !done.has(fp)).map(fp => ({ filePath: fp }));
    const result = _scanEnqueueItems(items);
    console.log('[ScanAPI] /add-folder ' + folderPath + ': ' + files.length + ' videos → queued=' + result.queued);
    res.json({ ok: true, found: files.length, queued: result.queued, skipped: result.skipped });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /add-file { filePath }
app.post('/add-file', (req, res) => {
  try {
    const filePath = (req.body || {}).filePath;
    if (!filePath) return res.status(400).json({ error: 'filePath required' });
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'file not found' });
    const result = _scanEnqueueItems([{ filePath }]);
    res.json({ ok: true, queued: result.queued, skipped: result.skipped });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/daily-run', async (req, res) => {
  try {
    const result = await runDailyScheduledPreseg(req.body || {});
    res.json(result);
  } catch (e) {
    console.error('[DailyPreseg] Manual run failed:', e.stack || e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
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
    for (const k of ['workers', 'skip10Bit', 'hwAccel', 'gpuCount', 'maxGpuPreseg', 'maxCpuPreseg', 'route10BitToCpu',
                      'dailyScheduleEnabled', 'dailyScheduleTime', 'purgeUnscheduled', 'daysAhead', 'excludePaths']) {
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

    startDailyScheduler();
  });
}
start();

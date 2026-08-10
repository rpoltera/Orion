#!/usr/bin/env node
// orion-convert — standalone 10-bit to 8-bit media conversion service for Orion
// Runs on localhost:3003. Reads media_probe.bitDepth>=10 for candidates.
// Writes convert_status table + updates media_probe on success.

'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');

// === Paths ===
const CONFIG_PATH = '/var/lib/orion/config.json';
const ORION_DB    = '/var/lib/orion/orion.db';
// M5: honour ORION_DATA_DIR so this runs somewhere other than /var/lib.
const SF_DIR      = process.env.ORION_SF_DIR ||
  path.join(process.env.ORION_DATA_DIR || '/var/lib/orion', 'sf');
const _DEFAULT_TEMP_DIR = path.join(SF_DIR, 'convert_temp');
function _getTempDir() {
  try { return (typeof cfg === 'object' && cfg && cfg.tempDir) ? cfg.tempDir : _DEFAULT_TEMP_DIR; }
  catch { return _DEFAULT_TEMP_DIR; }
}
const DEFAULT_PORT = 3003;

// === Config ===
function loadConfig() {
  try {
    const root = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const svc  = (root.services && root.services.convert) || {};
    const i    = svc.config || {};
    return {
      enabled: svc.enabled !== false,
      port: svc.port || DEFAULT_PORT,
      workers: parseInt(i.workers, 10) || 2,
      encoder: i.encoder || 'hevc_nvenc',            // hevc_nvenc | h264_nvenc | libx265 | libx264
      outputMode: i.outputMode || 'replace',          // 'replace' (in-place + backup) or 'alongside' (new file)
      keepOriginalAsBackup: i.keepOriginalAsBackup !== false,
      backupSuffix: i.backupSuffix || '.10bit.bak',
      alongsideSuffix: i.alongsideSuffix || '.8bit',
      qualityCq: parseInt(i.qualityCq, 10) || 22,
      preset: i.preset || 'p4',
      tempDir: i.tempDir || path.join(SF_DIR, 'convert_temp'),
      autoUpdateMediaProbe: i.autoUpdateMediaProbe !== false,
      autoQueuePreseg: i.autoQueuePreseg === true,
      presegPort: i.presegPort || 3002,
      gpuCount: Math.max(1, parseInt(i.gpuCount, 10) ||
        require('./capabilities')().gpuCount || 1)
    };
  } catch (e) {
    console.error('[Config] load error:', e.message);
    return { enabled: false };
  }
}
let cfg = loadConfig();

// Ensure dirs
try { fs.mkdirSync(_getTempDir(), { recursive: true }); } catch {}

// === DB ===
let db = null;
function ensureDb() {
  if (db) return db;
  db = new Database(ORION_DB);
  db.exec(`
    CREATE TABLE IF NOT EXISTS convert_status (
      mediaId TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      originalPath TEXT,
      convertedPath TEXT,
      outputMode TEXT,
      encoder TEXT,
      originalSize INTEGER,
      convertedSize INTEGER,
      originalBitDepth INTEGER,
      queuedAt INTEGER,
      startedAt INTEGER,
      doneAt INTEGER,
      error TEXT
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_convert_status_status ON convert_status(status)");
  console.log('[DB] orion.db ready (convert_status)');
  return db;
}

function safeCloseDb() {
  if (db) { try { db.close(); } catch {} db = null; }
}

// === Queue ===
let queue = [];
let activeWorkers = 0;
let gpuLoad = new Array(Math.max(1, cfg.gpuCount ||
  require('./capabilities')().gpuCount || 1)).fill(0); // workers per GPU
let recentCompletions = []; // completion timestamps
function assignGpu() {
  if (!gpuLoad.length) return 0;
  let min = 0;
  for (let i = 1; i < gpuLoad.length; i++) {
    if (gpuLoad[i] < gpuLoad[min]) min = i;
  }
  return min;
}

function dropQueue(mediaId) {
  queue = queue.filter(q => q.mediaId !== mediaId);
}

function drain() {
  while (cfg.enabled && activeWorkers < cfg.workers && queue.length > 0) {
    const item = queue.shift();
    spawnWorker(item);
  }
}

// === Worker ===
function buildFfmpegArgs(input, output, enc, gpuIdx) {
  const args = ['-y'];
  if (enc === 'hevc_nvenc' || enc === 'h264_nvenc') {
    args.push('-hwaccel', 'cuda', '-hwaccel_device', String(gpuIdx || 0), '-hwaccel_output_format', 'cuda');
  }
  args.push('-i', input, '-map', '0');
  if (enc === 'hevc_nvenc') {
    args.push('-vf', 'scale_cuda=format=yuv420p');
    args.push('-c:v', 'hevc_nvenc', '-gpu', String(gpuIdx || 0), '-preset', cfg.preset, '-tune', 'hq',
              '-rc', 'vbr', '-cq', String(cfg.qualityCq), '-profile:v', 'main');
  } else if (enc === 'h264_nvenc') {
    args.push('-vf', 'scale_cuda=format=yuv420p');
    args.push('-c:v', 'h264_nvenc', '-gpu', String(gpuIdx || 0), '-preset', cfg.preset, '-tune', 'hq',
              '-rc', 'vbr', '-cq', String(cfg.qualityCq), '-profile:v', 'high');
  } else if (enc === 'libx265') {
    args.push('-vf', 'format=yuv420p');
    args.push('-c:v', 'libx265', '-preset', 'medium', '-crf', String(cfg.qualityCq));
  } else {
    // libx264 fallback
    args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', String(cfg.qualityCq),
              '-pix_fmt', 'yuv420p');
  }
  args.push('-c:a', 'copy', '-c:s', 'copy', '-c:d', 'copy', output);
  return args;
}

function moveCrossFs(src, dst, cb) {
  fs.rename(src, dst, (err) => {
    if (!err) return cb(null);
    if (err.code !== 'EXDEV') return cb(err);
    // Cross-filesystem: copy + unlink
    const rd = fs.createReadStream(src);
    const wr = fs.createWriteStream(dst);
    rd.on('error', cb);
    wr.on('error', cb);
    wr.on('finish', () => fs.unlink(src, () => cb(null)));
    rd.pipe(wr);
  });
}

function spawnWorker(item) {
  activeWorkers++;
  const { mediaId, filePath } = item;
  const mode = item.outputMode || cfg.outputMode;
  const enc  = item.encoder    || cfg.encoder;
  const useGpu = (enc === 'hevc_nvenc' || enc === 'h264_nvenc');
  const gpuIdx = useGpu ? assignGpu() : -1;
  if (useGpu) gpuLoad[gpuIdx] = (gpuLoad[gpuIdx] || 0) + 1;
  const ddb  = ensureDb();

  ddb.prepare("UPDATE convert_status SET status='processing', startedAt=?, encoder=? WHERE mediaId=?")
    .run(Date.now(), enc, mediaId);

  // Decide paths
  const dirname = path.dirname(filePath);
  const ext     = path.extname(filePath);
  const baseNE  = path.basename(filePath, ext);
  const tempOut = path.join(_getTempDir(), `${mediaId}${ext}`);

  let finalPath, backupPath = null;
  if (mode === 'alongside') {
    finalPath = path.join(dirname, `${baseNE}${cfg.alongsideSuffix}${ext}`);
  } else {
    finalPath = filePath; // overwrite
    if (cfg.keepOriginalAsBackup) {
      backupPath = path.join(dirname, `${baseNE}${cfg.backupSuffix}${ext}`);
    }
  }

  // Source must exist
  try { fs.accessSync(filePath); }
  catch {
    ddb.prepare("UPDATE convert_status SET status='error', error=?, doneAt=? WHERE mediaId=?")
      .run('source file not accessible', Date.now(), mediaId);
    if (useGpu && gpuIdx >= 0) gpuLoad[gpuIdx] = Math.max(0, (gpuLoad[gpuIdx] || 0) - 1); activeWorkers--; setImmediate(drain); return;
  }

  // [PATCHED] Stage input from NFS to /dev/shm so ffmpeg reads from RAM
  const STAGE_INPUT_DIR = '/dev/shm/convert_input';
const STAGE_SIZE_LIMIT = 2 * 1024 * 1024 * 1024; // 2GB - cap to prevent /dev/shm OOM
  try { fs.mkdirSync(STAGE_INPUT_DIR, { recursive: true }); } catch {}
  const _srcSize = fs.statSync(filePath).size;
  const _useStaging = _srcSize <= STAGE_SIZE_LIMIT;
  const stagedInput = _useStaging ? path.join(STAGE_INPUT_DIR, `${mediaId}${ext}`) : filePath;
  const _stageStart = Date.now();
  try {
    if (_useStaging) fs.copyFileSync(filePath, stagedInput);
    const sizeMB = Math.round(fs.statSync(stagedInput).size / 1024 / 1024);
    console.log(`[Worker] staged ${mediaId} ${sizeMB}MB in ${Date.now()-_stageStart}ms`);
  } catch (e) {
    console.error(`[Worker] stage failed ${mediaId}: ${e.message}`);
    if (_useStaging) { try { fs.unlinkSync(stagedInput); } catch {} }
    ddb.prepare("UPDATE convert_status SET status='error', error=?, doneAt=? WHERE mediaId=?")
      .run('stage failed: ' + e.message, Date.now(), mediaId);
    if (useGpu && gpuIdx >= 0) gpuLoad[gpuIdx] = Math.max(0, (gpuLoad[gpuIdx] || 0) - 1);
    activeWorkers--; setImmediate(drain); return;
  }
  console.log(`[Worker] start ${mediaId} mode=${mode} enc=${enc} gpu=${gpuIdx} → ${path.basename(finalPath)}`);
  const args = buildFfmpegArgs(stagedInput, tempOut, enc, gpuIdx);
  args.unshift('-threads', '2');
  const proc = spawn('ffmpeg', args);
  let stderrTail = '';
  proc.stderr.on('data', d => {
    stderrTail += d.toString();
    if (stderrTail.length > 4096) stderrTail = stderrTail.slice(-4096);
  });

  proc.on('exit', (code) => {
    // [PATCHED] Clean up staged input
    if (_useStaging) { try { fs.unlinkSync(stagedInput); } catch {} }
    if (code === 0) {
      recentCompletions.push(Date.now());
      // Verify output
      let outStat;
      try {
        outStat = fs.statSync(tempOut);
        if (outStat.size < 1024) throw new Error(`output too small (${outStat.size} bytes)`);
      } catch (e) {
        ddb.prepare("UPDATE convert_status SET status='error', error=?, doneAt=? WHERE mediaId=?")
          .run(`output verify: ${e.message}`, Date.now(), mediaId);
        try { fs.unlinkSync(tempOut); } catch {}
        if (useGpu && gpuIdx >= 0) gpuLoad[gpuIdx] = Math.max(0, (gpuLoad[gpuIdx] || 0) - 1); activeWorkers--; setImmediate(drain); return;
      }

      // For replace mode: rename original to backup first (so finalPath is free)
      const beginPlacement = (cb) => {
        if (mode === 'replace' && backupPath) {
          fs.rename(filePath, backupPath, (err) => err ? cb(err) : cb(null));
        } else if (mode === 'replace' && !backupPath) {
          fs.unlink(filePath, (err) => err ? cb(err) : cb(null));
        } else {
          cb(null);
        }
      };

      beginPlacement((bErr) => {
        if (bErr) {
          ddb.prepare("UPDATE convert_status SET status='error', error=?, doneAt=? WHERE mediaId=?")
            .run(`backup/clear original: ${bErr.message}`, Date.now(), mediaId);
          try { fs.unlinkSync(tempOut); } catch {}
          if (useGpu && gpuIdx >= 0) gpuLoad[gpuIdx] = Math.max(0, (gpuLoad[gpuIdx] || 0) - 1); activeWorkers--; setImmediate(drain); return;
        }
        moveCrossFs(tempOut, finalPath, (mErr) => {
          if (mErr) {
            // Try restoring backup
            if (backupPath) { try { fs.renameSync(backupPath, filePath); } catch {} }
            ddb.prepare("UPDATE convert_status SET status='error', error=?, doneAt=? WHERE mediaId=?")
              .run(`move to final: ${mErr.message}`, Date.now(), mediaId);
            if (useGpu && gpuIdx >= 0) gpuLoad[gpuIdx] = Math.max(0, (gpuLoad[gpuIdx] || 0) - 1); activeWorkers--; setImmediate(drain); return;
          }
          // Success — update tables
          let convertedSize = 0;
          try { convertedSize = fs.statSync(finalPath).size; } catch {}
          ddb.prepare(`UPDATE convert_status
                       SET status='done', convertedPath=?, convertedSize=?, doneAt=?, error=NULL
                       WHERE mediaId=?`)
            .run(finalPath, convertedSize, Date.now(), mediaId);

          if (cfg.autoUpdateMediaProbe) {
            try {
              ddb.prepare(`UPDATE media_probe SET bitDepth=8, pixFmt='yuv420p', filePath=? WHERE mediaId=?`)
                .run(finalPath, mediaId);
            } catch (e) { console.error('[DB] media_probe update failed:', e.message); }
          }

          // Invalidate any HLS for this file — the bytes changed
          try {
            ddb.prepare(`DELETE FROM hls_status WHERE mediaId=?`).run(mediaId);
          } catch {}

          console.log(`[Worker] ✓ ${mediaId} ${path.basename(finalPath)} (${(convertedSize/1e6).toFixed(1)}MB)`);

          // Optionally auto-queue to orion-preseg for HLS regen
          if (cfg.autoQueuePreseg) {
            const http = require('http');
            const body = JSON.stringify({ mediaId, filePath: finalPath });
            const req = http.request({
              host: '127.0.0.1', port: cfg.presegPort, path: '/queue',
              method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
            }, () => {});
            req.on('error', () => {});
            req.write(body); req.end();
          }

          if (useGpu && gpuIdx >= 0) gpuLoad[gpuIdx] = Math.max(0, (gpuLoad[gpuIdx] || 0) - 1); activeWorkers--; setImmediate(drain);
        });
      });
    } else {
      const summary = stderrTail.split('\n').filter(s => s.trim()).slice(-6).join(' | ');
      ddb.prepare("UPDATE convert_status SET status='error', error=?, doneAt=? WHERE mediaId=?")
        .run(`code=${code} ${summary}`.slice(0, 1000), Date.now(), mediaId);
      console.error(`[Worker] ✗ ${mediaId} code=${code}`);
      try { fs.unlinkSync(tempOut); } catch {}
      if (useGpu && gpuIdx >= 0) gpuLoad[gpuIdx] = Math.max(0, (gpuLoad[gpuIdx] || 0) - 1); activeWorkers--; setImmediate(drain);
    }
  });

  proc.on('error', (err) => {
    ddb.prepare("UPDATE convert_status SET status='error', error=?, doneAt=? WHERE mediaId=?")
      .run(`spawn: ${err.message}`, Date.now(), mediaId);
    if (useGpu && gpuIdx >= 0) gpuLoad[gpuIdx] = Math.max(0, (gpuLoad[gpuIdx] || 0) - 1); activeWorkers--; setImmediate(drain);
  });
}

// === HTTP API ===
const app = express();
app.use(express.json({ limit: '50mb' }));

app.get('/health', (req, res) => {
  res.json({ ok: true, enabled: cfg.enabled, uptime: process.uptime(), config: cfg });
});

app.get('/config', (req, res) => res.json(cfg));

app.put('/config', (req, res) => {
  const next = req.body || {};
  // Allow runtime changes to a subset
  if (typeof next.workers === 'number')              cfg.workers = next.workers;
  if (next.encoder)                                  cfg.encoder = next.encoder;
  if (next.outputMode === 'replace' || next.outputMode === 'alongside')
                                                     cfg.outputMode = next.outputMode;
  if (typeof next.keepOriginalAsBackup === 'boolean') cfg.keepOriginalAsBackup = next.keepOriginalAsBackup;
  if (typeof next.qualityCq === 'number')             cfg.qualityCq = next.qualityCq;
  if (typeof next.autoQueuePreseg === 'boolean')      cfg.autoQueuePreseg = next.autoQueuePreseg;
  // [PATCHED] Allow preset, tempDir, gpuCount via PUT
  if (typeof next.preset === 'string')                cfg.preset = next.preset;
  if (typeof next.tempDir === 'string' && next.tempDir.length) {
    try { require('fs').mkdirSync(next.tempDir, { recursive: true }); } catch {}
    cfg.tempDir = next.tempDir;
  }
  if (typeof next.gpuCount === 'number')              cfg.gpuCount = next.gpuCount;
  console.log('[Config] runtime update:', { workers: cfg.workers, encoder: cfg.encoder, preset: cfg.preset, tempDir: cfg.tempDir });
  setImmediate(drain);
  res.json(cfg);
});

app.get('/status', (req, res) => {
  const ddb = ensureDb();
  const counts = ddb.prepare("SELECT status, COUNT(*) n FROM convert_status GROUP BY status").all();
  const result = {
    enabled: cfg.enabled, workers: activeWorkers, maxWorkers: cfg.workers,
    queued: queue.length, outputMode: cfg.outputMode, encoder: cfg.encoder,
    gpuLoad: [...gpuLoad], gpuCount: cfg.gpuCount
  };
  for (const r of counts) result[r.status] = r.n;
  const _cutoff = Date.now() - 300000;
  recentCompletions = recentCompletions.filter(t => t > _cutoff);
  const _ratePerMin = recentCompletions.length / 5;
  result.ratePerMin = +_ratePerMin.toFixed(2);
  result.etaSeconds = _ratePerMin > 0 ? Math.round(queue.length / (_ratePerMin / 60)) : null;
  // Candidate count from media_probe
  try {
    const c = ddb.prepare(`SELECT COUNT(*) n FROM media_probe WHERE bitDepth >= 10`).get();
    const remaining = ddb.prepare(`
      SELECT COUNT(*) n FROM media_probe mp
      WHERE mp.bitDepth >= 10
        AND mp.mediaId NOT IN (SELECT mediaId FROM convert_status WHERE status='done')
    `).get();
    result.candidates10bit = c.n;
    result.remaining10bit = remaining.n;
  } catch {}
  res.json(result);
});

function _enqueueOne(mediaId, filePath, outputMode, encoder) {
  if (!mediaId || !filePath) return { queued: false, reason: 'mediaId+filePath required' };
  // [BAK-FILTER] Refuse backup files left by prior convert runs
  if (/\.bak\./.test(filePath) || /\.bak\.mkv$/.test(filePath)) {
    return { queued: false, reason: 'skipped backup file (.bak)' };
  }
  const ddb = ensureDb();
  const existing = ddb.prepare("SELECT status FROM convert_status WHERE mediaId=?").get(mediaId);
  if (existing && existing.status === 'done')       return { queued: false, reason: 'already converted' };
  if (existing && existing.status === 'processing') return { queued: false, reason: 'already processing' };
  if (queue.find(q => q.mediaId === mediaId))       return { queued: false, reason: 'already queued' };

  const probe = ddb.prepare("SELECT bitDepth FROM media_probe WHERE mediaId=?").get(mediaId);
  let originalSize = null;
  try { originalSize = fs.statSync(filePath).size; } catch {}

  ddb.prepare(`
    INSERT INTO convert_status (mediaId, status, originalPath, outputMode, encoder, originalSize, originalBitDepth, queuedAt, error)
    VALUES (?, 'queued', ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(mediaId) DO UPDATE SET
      status='queued', originalPath=excluded.originalPath, outputMode=excluded.outputMode,
      encoder=excluded.encoder, originalSize=excluded.originalSize,
      queuedAt=excluded.queuedAt, startedAt=NULL, doneAt=NULL, error=NULL
  `).run(mediaId, filePath, outputMode || cfg.outputMode, encoder || cfg.encoder,
         originalSize, probe ? probe.bitDepth : null, Date.now());

  queue.push({ mediaId, filePath, outputMode, encoder });
  return { queued: true };
}

app.post('/queue', (req, res) => {
  const { mediaId, filePath, outputMode, encoder } = req.body || {};
  const r = _enqueueOne(mediaId, filePath, outputMode, encoder);
  if (r.queued) setImmediate(drain);
  res.json(r);
});

app.post('/queue/bulk', (req, res) => {
  const items = req.body && req.body.items;
  const defaultMode = req.body && req.body.outputMode;
  const defaultEnc  = req.body && req.body.encoder;
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items array required' });
  let queued = 0, skipped = 0;
  for (const it of items) {
    const r = _enqueueOne(it.mediaId, it.filePath, it.outputMode || defaultMode, it.encoder || defaultEnc);
    if (r.queued) queued++; else skipped++;
  }
  setImmediate(drain);
  res.json({ queued, skipped, total: items.length });
});

app.post('/queue/all-10bit', (req, res) => {
  const outputMode = (req.body && req.body.outputMode) || cfg.outputMode;
  const encoder    = (req.body && req.body.encoder)    || cfg.encoder;
  const ddb = ensureDb();
  const candidates = ddb.prepare(`
    SELECT mediaId, filePath FROM media_probe
    WHERE bitDepth >= 10
      AND mediaId NOT IN (SELECT mediaId FROM convert_status WHERE status IN ('done', 'processing', 'queued'))
  `).all();
  let queued = 0;
  for (const c of candidates) {
    const r = _enqueueOne(c.mediaId, c.filePath, outputMode, encoder);
    if (r.queued) queued++;
  }
  setImmediate(drain);
  res.json({ queued, total: candidates.length, outputMode, encoder });
});

app.get('/items', (req, res) => {
  const wanted = (req.query.status || 'done').split(',');
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const ddb = ensureDb();
  const placeholders = wanted.map(() => '?').join(',');
  const rows = ddb.prepare(
    `SELECT mediaId, originalPath, convertedPath, status, encoder, outputMode, originalSize, convertedSize,
            originalBitDepth, queuedAt, startedAt, doneAt, error
     FROM convert_status
     WHERE status IN (${placeholders})
     ORDER BY COALESCE(doneAt, startedAt, queuedAt) DESC
     LIMIT ?`
  ).all(...wanted, limit);
  res.json(rows);
});

app.get('/converted/:mediaId', (req, res) => {
  const ddb = ensureDb();
  const r = ddb.prepare("SELECT * FROM convert_status WHERE mediaId=?").get(req.params.mediaId);
  res.json(r || { status: 'unknown' });
});

app.delete('/item/:mediaId', (req, res) => {
  const mid = req.params.mediaId;
  dropQueue(mid);
  const ddb = ensureDb();
  ddb.prepare("DELETE FROM convert_status WHERE mediaId=?").run(mid);
  res.json({ ok: true });
});

// === Lifecycle ===
function shutdown(sig) {
  console.log(`[Service] ${sig} — shutting down`);
  safeCloseDb();
  process.exit(0);
}
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT',  () => shutdown('SIGINT'));
process.on('exit', safeCloseDb);

if (!cfg.enabled) {
  console.log('[Service] orion-convert disabled in config — exiting');
  process.exit(0);
}

console.log(`[Service] orion-convert starting (pid=${process.pid})`);
console.log(`[Service] config:`, JSON.stringify(cfg));
ensureDb();

function rebuildQueueFromDb() {
  const ddb = ensureDb();
  try {
    // Zombies: items left 'processing' from previous run (parent died mid-work)
    const z = ddb.prepare("UPDATE convert_status SET status='queued', startedAt=NULL WHERE status='processing'").run();
    if (z.changes) console.log(`[DB] Reset ${z.changes} processing → queued (zombies)`);
    // Pull all queued items into in-memory queue
    const rows = ddb.prepare("SELECT mediaId, originalPath, outputMode, encoder FROM convert_status WHERE status='queued'").all();
    for (const r of rows) {
      queue.push({
        mediaId: r.mediaId,
        filePath: r.originalPath,
        outputMode: r.outputMode || cfg.outputMode,
        encoder: r.encoder || cfg.encoder
      });
    }
    console.log(`[Queue] Rebuilt: ${queue.length} queued items from DB`);
  } catch (e) {
    console.error('[Queue] rebuild failed:', e.message);
  }
}

rebuildQueueFromDb();
setImmediate(drain);

app.listen(cfg.port, '127.0.0.1', () => {
  console.log(`[Service] HTTP listening on http://127.0.0.1:${cfg.port}`);
});

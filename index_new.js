'use strict';
/**
 * Orion Media Server — New Entry Point
 *
 * Route modules:
 *   routes/settings.js    — /api/config, /api/settings, /api/ai/*, /api/hardware
 *   routes/users.js       — /api/users/*, /api/groups/*, /api/auth/*, /api/setup/*
 *   routes/collections.js — /api/collections/*
 *   routes/library.js     — /api/library/* (browse, detail, delete, reset)
 *   routes/scanner.js     — /api/library/scan, probe, dedup, cleanup
 *   routes/scheduler.js   — /api/scheduler/*, /api/custom-libraries/*
 *   routes/stream.js      — /api/stream, /api/hls/*, /api/progress/*
 *   routes/trailers.js    — /api/trailers/*, /api/ytdlp/*, /api/tv-trailers/*
 */
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const path       = require('path');
const fs         = require('fs');
const ffmpeg     = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');

const { loadConfig, getConfig, getSettings, updateConfig, updateSettings, saveConfig, PATHS } = require('./config');
const logger   = require('./logger');
const OrionDB  = require('./database');
const HLS      = require('./hls');
const { db, loadDB, saveDB, rebuildIndex, findById, _idx } = require('./db');
const { scanDirectory, deduplicateMedia, getQualityScore, isTrailerOrExtra } = require('./services/scanner');
const { fetchMovieMeta, fetchTVMeta, decodeHtmlEntities, axiosPool } = require('./services/metadata');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(logger.requestLogger);

// FFmpeg
if (ffmpegStatic) {
  ffmpeg.setFfmpegPath(ffmpegStatic);
  const ffprobePath = path.join(path.dirname(ffmpegStatic), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  if (fs.existsSync(ffprobePath)) ffmpeg.setFfprobePath(ffprobePath);
}

// Shared state
let cachedEncoder = null;
let ytdlpReady = null;
let metadataQueue = [];
let _isProcessingQueue = false;
const _detailCache  = new Map();
const _versionsMap  = new Map();
const _trailerOverrides = {};
const _blockedVideoIds  = new Set();

try { if (fs.existsSync(PATHS.TRAILER_OVERRIDES_FILE)) Object.assign(_trailerOverrides, JSON.parse(fs.readFileSync(PATHS.TRAILER_OVERRIDES_FILE, 'utf8'))); } catch {}
try { if (fs.existsSync(PATHS.BLOCKED_VIDEO_IDS_FILE)) JSON.parse(fs.readFileSync(PATHS.BLOCKED_VIDEO_IDS_FILE, 'utf8')).forEach(id => _blockedVideoIds.add(id)); } catch {}

function saveTrailerOverrides() { try { fs.writeFileSync(PATHS.TRAILER_OVERRIDES_FILE, JSON.stringify(_trailerOverrides, null, 2)); } catch {} }
function saveBlockedVideoIds()  { try { fs.writeFileSync(PATHS.BLOCKED_VIDEO_IDS_FILE, JSON.stringify([..._blockedVideoIds])); } catch {} }

// Hardware detection
async function detectHardwareAccel() {
  if (cachedEncoder) return cachedEncoder;
  return new Promise((resolve) => {
    ffmpeg.getAvailableEncoders((err, encoders) => {
      if (err) { cachedEncoder = 'libx264'; return resolve('libx264'); }
      const config = getConfig();
      const hw = (config.transcoding?.hardware || 'auto').toLowerCase();
      const GPU_ENCODERS = {
        amf:          ['h264_amf',           'hevc_amf'],
        nvenc:        ['h264_nvenc',         'hevc_nvenc'],
        qsv:          ['h264_qsv',           'hevc_qsv'],
        vaapi:        ['h264_vaapi',         'hevc_vaapi'],
        videotoolbox: ['h264_videotoolbox',  'hevc_videotoolbox'],
        v4l2:         ['h264_v4l2m2m'],
      };
      let result = 'libx264';
      if (hw !== 'auto' && hw !== 'cpu' && GPU_ENCODERS[hw]) {
        for (const enc of GPU_ENCODERS[hw]) { if (encoders[enc]) { result = enc; break; } }
      } else {
        const priority = ['amf','nvenc','qsv','videotoolbox','vaapi','v4l2'];
        outer: for (const gpu of priority) {
          for (const enc of GPU_ENCODERS[gpu]) { if (encoders[enc]) { result = enc; break outer; } }
        }
      }
      cachedEncoder = result;
      console.log(`[HW] Detected encoder: ${result}`);
      resolve(result);
    });
  });
}

// yt-dlp
const YTDLP_PATH = path.join(PATHS.DATA_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
if (fs.existsSync(YTDLP_PATH)) ytdlpReady = YTDLP_PATH;

async function ensureYtDlp() {
  if (ytdlpReady) return ytdlpReady;
  try {
    const osMap = { win32: 'yt-dlp.exe', darwin: 'yt-dlp_macos', linux: 'yt-dlp' };
    const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${osMap[process.platform]||'yt-dlp'}`;
    const res = await axiosPool.get(url, { responseType: 'arraybuffer', timeout: 60000 });
    fs.writeFileSync(YTDLP_PATH, res.data);
    if (process.platform !== 'win32') require('child_process').execSync(`chmod +x "${YTDLP_PATH}"`);
    ytdlpReady = YTDLP_PATH;
    return YTDLP_PATH;
  } catch(e) { console.error('[yt-dlp] Download failed:', e.message); return null; }
}

// Metadata queue
function queueMetadata(items, type) {
  const toQueue = (items||[]).filter(i => !i.metadataFetched && (i.title || i.seriesTitle));
  metadataQueue.push(...toQueue.map(item => ({ item, type })));
  if (!_isProcessingQueue) processMetadataQueue();
}

async function processMetadataQueue() {
  if (_isProcessingQueue || !metadataQueue.length) return;
  _isProcessingQueue = true;
  let consecutive404 = 0;
  while (metadataQueue.length) {
    const { item, type } = metadataQueue.shift();
    if (!item || item.metadataFetched) continue;
    try {
      const config = getConfig();
      const meta = (type === 'movies') ? await fetchMovieMeta(item.title, item.year, config)
                 : (type === 'tvShows') ? await fetchTVMeta(item.seriesTitle || item.title, config)
                 : null;
      if (meta) {
        // Normalize: metadata services return 'poster', DB/frontend expect 'thumbnail'
        if (meta.poster && !meta.thumbnail) meta.thumbnail = meta.poster;
        Object.assign(item, { ...meta, metadataFetched: true });
        saveDB(false, type);
        io.emit('metadata:updated', { id: item.id, type });
        if (type === 'tvShows') invalidateGroupedCache();
        consecutive404 = 0;
      } else {
        // Mark as attempted so we don't retry every startup
        item.metadataFetched = true;
        consecutive404++;
        // Back off if hitting lots of 404s
        if (consecutive404 > 20) await new Promise(r => setTimeout(r, 2000));
      }
    } catch(e) {
      if (!e.message?.includes('404')) console.error('[Metadata] Queue error:', e.message);
      item.metadataFetched = true;
    }
    await new Promise(r => setTimeout(r, 100));
  }
  _isProcessingQueue = false;
}

// Versions map builder
function buildVersionsMap(movies) {
  const norm = s => (s||'').toLowerCase().replace(/[^a-z0-9]/g,'');
  const groups = new Map();
  for (const m of movies) {
    if (isTrailerOrExtra(m.fileName)) continue;
    const key = `${norm(m.title)}__${m.year||''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ filePath: m.filePath, fileName: m.fileName, size: m.size, id: m.id, quality: getQualityScore(m.fileName||'') });
  }
  _versionsMap.clear();
  for (const versions of groups.values()) {
    const sorted = versions.sort((a,b)=>(b.size||0)-(a.size||0));
    for (const v of sorted) _versionsMap.set(v.id, sorted);
  }
}

let _libraryRouteRef = null; // set after route mount
const invalidateGroupedCache = () => { if (_libraryRouteRef?.invalidateGroupedCache) _libraryRouteRef.invalidateGroupedCache(); };

// Shared deps passed to route modules
const deps = () => ({
  db, io, saveDB, rebuildIndex, OrionDB, PATHS, findById,
  _detailCache, _versionsMap, _trailerOverrides, saveTrailerOverrides,
  _blockedVideoIds, saveBlockedVideoIds,
  get cachedEncoder() { return cachedEncoder; },
  getEncoder: () => cachedEncoder,
  getConfig, getSettings, updateConfig, updateSettings, saveConfig,
  HLS, ffmpegStatic, ytdlpReady, ensureYtDlp,
  metadataQueue, queueMetadata, scanDirectory, deduplicateMedia,
  buildVersionsMap, invalidateGroupedCache,
  invalidateCache: () => {}, detectHardwareAccel,
});

// Socket
io.on('connection', socket => {
  console.log('[Socket] Connected:', socket.id);
  socket.on('disconnect', () => console.log('[Socket] Disconnected:', socket.id));
});

// Log ALL incoming requests regardless of route
app.use((req, res, next) => {
  console.log(`[REQ] ${req.method} ${req.url}`);
  next();
});

async function start() {
  loadConfig();
  await loadDB();

  // Mount routes AFTER db is loaded
  const api = express.Router();
  api.get('/health', (_, res) => res.json({ ok: true, movies: db.movies.length, tv: db.tvShows.length }));
  try { api.use('/', require('./routes/settings')(deps())); } catch(e) { console.error('[Routes] settings failed:', e.message); }
  try { api.use('/', require('./routes/users')(deps())); } catch(e) { console.error('[Routes] users failed:', e.message); }
  try { api.use('/collections', require('./routes/collections')(deps())); } catch(e) { console.error('[Routes] collections failed:', e.message); }
  try { _libraryRouteRef = require('./routes/library')({ ...deps(), _trailerOverrides }); api.use('/library', _libraryRouteRef); } catch(e) { console.error('[Routes] library failed:', e.message); }
  try { api.use('/library', require('./routes/scanner')(deps())); } catch(e) { console.error('[Routes] scanner failed:', e.message); }
  try { api.use('/', require('./routes/scheduler')({ ...deps(), runTask: null })); } catch(e) { console.error('[Routes] scheduler failed:', e.message); }
  try { api.use('/', require('./routes/stream')(deps())); } catch(e) { console.error('[Routes] stream failed:', e.message); }
  try { api.use('/', require('./routes/trailers')(deps())); } catch(e) { console.error('[Routes] trailers failed:', e.message); }
  try { api.use('/', require('./routes/images')(deps())); } catch(e) { console.error('[Routes] images failed:', e.message); }
  try { api.use('/', require('./routes/thumbnails')(deps())); } catch(e) { console.error('[Routes] thumbnails failed:', e.message); }
  try {
    const sfFile = path.join(__dirname, 'streamforge.js');
    if (fs.existsSync(sfFile)) {
      const ffprobePath = ffmpegStatic
        ? path.join(path.dirname(ffmpegStatic), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
        : 'ffprobe';
      // sfDataDir is configurable — defaults to AppData/Orion/sf if not set
      const cfg = getConfig();
      const sfDataDir = cfg.sfDataDir && cfg.sfDataDir.trim()
        ? cfg.sfDataDir.trim()
        : path.join(PATHS.DATA_DIR, 'sf');
      require('./streamforge')(app, {
        ffmpegPath:  ffmpegStatic || 'ffmpeg',
        ffprobePath: fs.existsSync(ffprobePath) ? ffprobePath : 'ffprobe',
        hwEncoder:   cachedEncoder || 'libx264',
        DATA_DIR:    sfDataDir,
        orionDb:     db,
      });
      console.log(`[StreamForge] Mounted at /api/sf — data dir: ${sfDataDir}`);
    }
  } catch(e) { console.warn('[StreamForge] Failed to mount:', e.message); }

  // ── Inline stubs for endpoints not yet extracted ──────────────────────────

  // Live IPTV proxy — transcodes any stream format to HLS for browser playback
  // Handles MPEG-TS, HLS, RTMP, and any format FFmpeg can read
  const liveSessions = {};
  api.get('/stream/live/proxy', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'url required' });
    try {
      const decodedUrl = decodeURIComponent(url);
      const { spawn } = require('child_process');
      const ffmpegPath = require('ffmpeg-static');
      const encoder = cachedEncoder || 'libx264';
      const args = [
        '-probesize','500000','-analyzeduration','500000',
        '-fflags','+genpts+discardcorrupt+nobuffer',
        '-err_detect','ignore_err',
        '-user_agent','Mozilla/5.0',
        '-i', decodedUrl,
        '-map','0:v:0?','-map','0:a:0?',
        '-vcodec','copy',
        '-acodec','aac','-b:a','192k','-ac','2',
        '-avoid_negative_ts','make_zero',
        '-max_interleave_delta','500000000',
        '-f','mpegts','pipe:1'
      ];
      // Try copy mode first — if stream is already H264 this is instant
      // Browser gets MPEG-TS which HLS.js can handle
      res.setHeader('Content-Type','video/mp2t');
      res.setHeader('Cache-Control','no-cache');
      res.setHeader('Access-Control-Allow-Origin','*');
      const proc = spawn(ffmpegPath, args, { stdio:['ignore','pipe','pipe'] });
      proc.stdout.pipe(res);
      proc.stderr.on('data', d => {
        const l = d.toString().trim().split('\n').pop();
        if (l && !l.startsWith('frame=') && !l.startsWith('size=')) console.log('[LiveProxy]', l.slice(0,100));
      });
      proc.on('error', err => { if (!res.headersSent) res.status(500).end(); });
      proc.on('exit', () => { if (!res.writableEnded) res.end(); });
      req.on('close', () => { setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 3000); });
    } catch(e) { if (!res.headersSent) res.status(500).json({ error: e.message }); }
  });

  // System stats
  api.get('/system/stats', (_, res) => {
    const os = require('os');
    const mem = process.memoryUsage();
    const cpus = os.cpus();
    const totalMem = os.totalmem(), freeMem = os.freemem();
    res.json({
      uptime: Math.round(process.uptime()),
      cpu: { model: cpus[0]?.model||'Unknown', cores: cpus.length, usagePercent: 0 },
      memory: { totalMB: Math.round(totalMem/1024/1024), usedMB: Math.round((totalMem-freeMem)/1024/1024), freeMB: Math.round(freeMem/1024/1024), usedPercent: Math.round(((totalMem-freeMem)/totalMem)*100), heapUsedMB: Math.round(mem.heapUsed/1024/1024) },
      bandwidth: { currentMbps: 0, totalGB: 0, history: [] },
      streams: { active: 0, queued: 0, max: 3 },
      loadTier: 'normal',
    });
  });
  api.get('/system/clients', (_, res) => res.json({ clients: [], count: 0 }));

  let _debugEnabled = false;
  const _debugLog = [];
  api.get('/debug', (_, res) => res.json({ enabled: _debugEnabled, lines: _debugLog.length }));
  api.get('/debug/log', (_, res) => res.json({ log: _debugLog }));
  api.post('/debug/toggle', (req, res) => { _debugEnabled = !_debugEnabled; res.json({ enabled: _debugEnabled }); });
  api.delete('/debug/log', (_, res) => { _debugLog.length = 0; res.json({ ok: true }); });
  api.post('/debug/client', (req, res) => {
    if (_debugEnabled) {
      const { msg, data } = req.body;
      _debugLog.push(`[${new Date().toISOString().slice(11,23)}] ${msg} ${data ? JSON.stringify(data).slice(0,200) : ''}`);
      if (_debugLog.length > 1000) _debugLog.splice(0, _debugLog.length - 1000);
    }
    res.json({ ok: true });
  });

  // Activity log
  const _activityLog = db.activityLog || [];
  api.get('/activity', (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    res.json(_activityLog.slice(-limit).reverse());
  });
  api.post('/activity', (req, res) => {
    const { mediaId, title, type, action, position, duration } = req.body;
    _activityLog.push({ mediaId, title, type, action, position, duration, ts: new Date().toISOString() });
    if (_activityLog.length > 500) _activityLog.splice(0, _activityLog.length - 500);
    res.json({ ok: true });
  });

  // Server load
  api.get('/server/load', (_, res) => res.json({ tier: { label: 'normal', maxConcurrent: 3, queueMax: 10 }, activeSessions: 0 }));

  // Streams info (track probing)
  api.get('/streams', async (req, res) => {
    const { path: filePath } = req.query;
    if (!filePath) return res.json({ audio: [], subtitles: [], chapters: [], duration: 0 });
    try {
      ffmpeg.ffprobe(filePath, (err, meta) => {
        if (err) return res.json({ audio: [], subtitles: [], chapters: [], duration: 0 });
        const duration = meta.format?.duration || 0;
        const audio = (meta.streams || []).filter(s => s.codec_type === 'audio').map((s, i) => ({
          index: i, codec: s.codec_name, language: s.tags?.language || 'und',
          title: s.tags?.title || null, channels: s.channels, default: s.disposition?.default === 1,
        }));
        const subtitles = (meta.streams || []).filter(s => s.codec_type === 'subtitle').map((s, i) => ({
          index: i, codec: s.codec_name, language: s.tags?.language || 'und',
          title: s.tags?.title || null, forced: s.disposition?.forced === 1,
        }));
        const chapters = (meta.chapters || []).map(c => ({
          title: c.tags?.title || `Chapter ${c.id + 1}`,
          start: parseFloat(c.start_time) || 0,
          end: parseFloat(c.end_time) || 0,
        }));
        res.setHeader('X-Content-Duration', String(duration));
        res.json({ duration, audio, subtitles, chapters });
      });
    } catch(e) { res.json({ audio: [], subtitles: [], chapters: [], duration: 0 }); }
  });

  // Continue watching
  api.get('/continue-watching', (req, res) => {
    const userId = req.query.userId || req.headers['x-user-id'] || 'default';
    const history = db.watchHistory?.[userId] || {};
    const items = [...db.movies, ...db.tvShows]
      .filter(i => i.progress > 30 && !i.watched && history[i.id])
      .sort((a, b) => new Date(b.lastWatched||0) - new Date(a.lastWatched||0))
      .slice(0, 20)
      .map(i => ({ ...i, resumePct: i.resumePct || 0 }));
    res.json({ items });
  });

  // Recently released
  api.get('/recently-released/movies', (req, res) => {
    const days = req.query.days ? parseInt(req.query.days) : (req.query.months ? parseInt(req.query.months)*30 : 90);
    const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const items = db.movies
      .filter(m => m.releaseDate && m.releaseDate >= cutoff)
      .sort((a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || ''))
      .slice(0, 40);
    res.json({ items, total: items.length });
  });
  api.get('/recently-released/tv', (req, res) => {
    const days = req.query.days ? parseInt(req.query.days) : (req.query.months ? parseInt(req.query.months)*30 : 90);
    const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const seen = new Set();
    const items = db.tvShows
      .filter(ep => ep.releaseDate && ep.releaseDate >= cutoff)
      .sort((a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || ''))
      .filter(ep => { const k = ep.seriesTitle||ep.showName; if (seen.has(k)) return false; seen.add(k); return true; })
      .slice(0, 40);
    res.json({ items, total: items.length });
  });

  // Recommendations
  const _recCache = { movies: null, tv: null, ts: 0 };
  api.get('/recommendations/:type', (req, res) => {
    const { type } = req.params;
    const now = Date.now();
    if (_recCache[type] && now - _recCache.ts < 300000) return res.json({ items: _recCache[type] });
    const items = type === 'movies'
      ? db.movies.filter(m => m.rating >= 7).sort(() => Math.random() - 0.5).slice(0, 20)
      : db.tvShows.filter((ep, i, arr) => arr.findIndex(e => (e.seriesTitle||e.showName) === (ep.seriesTitle||ep.showName)) === i)
          .filter(ep => ep.rating >= 7).sort(() => Math.random() - 0.5).slice(0, 20);
    _recCache[type] = items;
    _recCache.ts = now;
    res.json({ items });
  });

  // IPTV channels — persisted to a dedicated JSON file (not SQLite, avoids table whitelist issues)
  const IPTV_FILE = require('path').join(PATHS.DATA_DIR, 'iptv_channels.json');
  const saveIPTV = () => {
    try { require('fs').writeFileSync(IPTV_FILE, JSON.stringify(db.iptvChannels || []), 'utf8'); }
    catch(e) { console.error('[IPTV] Save failed:', e.message); }
  };
  // Load saved channels on startup
  try {
    const saved = JSON.parse(require('fs').readFileSync(IPTV_FILE, 'utf8'));
    if (Array.isArray(saved)) { db.iptvChannels = saved; console.log(`[IPTV] Loaded ${saved.length} channels from file`); }
  } catch {}

  api.get('/iptv/channels', (_, res) => res.json({ channels: db.iptvChannels || [] }));

  // Delete a single channel
  api.delete('/iptv/channels/:id', (req, res) => {
    db.iptvChannels = (db.iptvChannels || []).filter(c => c.id !== req.params.id);
    saveIPTV();
    res.json({ ok: true, total: db.iptvChannels.length });
  });

  // Bulk delete — body: { ids: [...] }
  api.post('/iptv/channels/remove-bulk', (req, res) => {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids array required' });
    const idSet = new Set(ids);
    db.iptvChannels = (db.iptvChannels || []).filter(c => !idSet.has(c.id));
    saveIPTV();
    res.json({ ok: true, removed: ids.length, total: db.iptvChannels.length });
  });

  // Clear all channels
  api.delete('/iptv/channels', (req, res) => {
    db.iptvChannels = [];
    saveIPTV();
    res.json({ ok: true });
  });

  // Load IPTV from URL or raw text — merges into existing (no replace)
  // Upload a local M3U file directly
  api.post('/iptv/upload', multer({ storage: multer.memoryStorage(), limits:{fileSize:50*1024*1024} }).single('file'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
      const raw = req.file.buffer.toString('utf8');
      if (!raw.trim().startsWith('#EXTM3U')) return res.status(400).json({ error: 'Not a valid M3U file' });
      // Reuse the load logic by forwarding as text
      req.body = { text: raw };
      // Fall through to /iptv/load handler by calling it inline
      const axios = null; // not needed
      let parsed = [];
      const lines = raw.split('\n');
      let current = null;
      for (const line of lines) {
        const l = line.trim();
        if (l.startsWith('#EXTINF')) {
          current = { id: require('crypto').randomUUID(), name: '', group: '', logo: '', url: '' };
          const nameMatch = l.match(/,(.+)$/); if (nameMatch) current.name = nameMatch[1].trim();
          const groupMatch = l.match(/group-title="([^"]*)"/); if (groupMatch) current.group = groupMatch[1];
          const logoMatch = l.match(/tvg-logo="([^"]*)"/); if (logoMatch) current.logo = logoMatch[1];
        } else if (l && !l.startsWith('#') && current) {
          current.url = l; parsed.push(current); current = null;
        }
      }
      if (!parsed.length) return res.status(400).json({ error: 'No channels found in file' });
      db.iptvChannels = [...(db.iptvChannels||[]), ...parsed];
      saveDB(true);
      res.json({ ok: true, added: parsed.length, total: db.iptvChannels.length });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  api.post('/iptv/load', async (req, res) => {
    try {
      const { url, text } = req.body || {};
      let raw = text || '';
      if (url) {
        const https = require('https'), http = require('http');
        raw = await new Promise((resolve, reject) => {
          const mod = url.startsWith('https') ? https : http;
          const request = mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (r) => {
            if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
              const mod2 = r.headers.location.startsWith('https') ? https : http;
              mod2.get(r.headers.location, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (r2) => {
                let d = ''; r2.on('data', c => d += c); r2.on('end', () => resolve(d));
              }).on('error', reject);
            } else {
              let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(d));
            }
          });
          request.on('error', reject);
          request.setTimeout(15000, () => { request.destroy(); reject(new Error('Timeout')); });
        });
      }
      if (!raw.trim().startsWith('#EXTM3U')) {
        return res.status(400).json({ error: 'Not a valid M3U playlist' });
      }
      const channels = [];
      const lines = raw.split(/\r?\n/);
      let meta = {};
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('#EXTINF')) {
          const nameMatch    = line.match(/,(.+)$/);
          const idMatch      = line.match(/tvg-id="([^"]*)"/);
          const logoMatch    = line.match(/tvg-logo="([^"]*)"/);
          const grpMatch     = line.match(/group-title="([^"]*)"/);
          const numMatch     = line.match(/tvg-chno="([^"]*)"/);
          const countryMatch = line.match(/tvg-country="([^"]*)"/);
          const langMatch    = line.match(/tvg-language="([^"]*)"/);
          meta = {
            name:     nameMatch    ? nameMatch[1].trim() : '',
            tvgId:    idMatch      ? idMatch[1]          : '',
            logo:     logoMatch    ? logoMatch[1]        : '',
            group:    grpMatch     ? grpMatch[1]         : '',
            num:      numMatch     ? numMatch[1]         : '',
            country:  countryMatch ? countryMatch[1].toUpperCase() : '',
            language: langMatch    ? langMatch[1]        : '',
          };
        } else if (line.startsWith('http') || line.startsWith('rtmp') || line.startsWith('rtp') || line.startsWith('udp')) {
          if (meta.name) {
            channels.push({ id: require('crypto').randomUUID(), name: meta.name, url: line, logo: meta.logo, group: meta.group, tvgId: meta.tvgId, num: meta.num, country: meta.country, language: meta.language });
          }
          meta = {};
        }
      }
      db.iptvChannels = db.iptvChannels || [];
      const existingUrls = new Set(db.iptvChannels.map(c => c.url));
      const newChannels = channels.filter(c => !existingUrls.has(c.url));
      db.iptvChannels = [...db.iptvChannels, ...newChannels];
      saveIPTV();
      console.log(`[IPTV] Added ${newChannels.length} channels, total: ${db.iptvChannels.length}`);
      res.json({ channels: db.iptvChannels, added: newChannels.length, total: db.iptvChannels.length });
    } catch (e) {
      res.status(500).json({ error: 'IPTV load failed: ' + e.message });
    }
  });
  api.get('/iptv/list', (req, res) => {
    const channels = db.iptvChannels || [];
    const m3u = '#EXTM3U\n' + channels.map(c => `#EXTINF:-1 tvg-id="${c.id||''}" tvg-name="${c.name||''}" tvg-logo="${c.logo||''}",${c.name||''}\n${c.url||''}`).join('\n');
    res.setHeader('Content-Type', 'application/x-mpegurl');
    res.send(m3u);
  });

  // ── IPTV channel health check ─────────────────────────────────────────────
  // Tests a single URL with a short timeout — run server-side to bypass CORS.
  // Returns { ok, status, ms } where ok=true means we got any HTTP response.
  api.post('/iptv/check', async (req, res) => {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ error: 'url required' });
    const https = require('https'), http = require('http');
    const t0 = Date.now();
    try {
      await new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? https : http;
        const req2 = mod.request(url, {
          method: 'HEAD',
          headers: { 'User-Agent': 'Mozilla/5.0' },
          timeout: 2000,
        }, (r) => {
          r.destroy(); // don't download body
          const ok = r.statusCode < 500;
          resolve({ ok, status: r.statusCode });
        });
        req2.on('timeout', () => { req2.destroy(); reject(new Error('timeout')); });
        req2.on('error', reject);
        req2.end();
      }).then(({ ok, status }) => {
        res.json({ ok, status, ms: Date.now() - t0 });
      });
    } catch (e) {
      res.json({ ok: false, error: e.message, ms: Date.now() - t0 });
    }
  });

  // Chapters
  api.get('/chapters/:mediaId', (req, res) => {
    const item = [...db.movies, ...db.tvShows].find(i => i.id === req.params.mediaId);
    if (!item) return res.json({ chapters: [], introEnd: 0, outroStart: null });
    res.json({ chapters: item.chapters || [], introEnd: item.introEnd || 0, outroStart: item.outroStart || null });
  });
  api.put('/chapters/:mediaId', (req, res) => {
    const item = [...db.movies, ...db.tvShows].find(i => i.id === req.params.mediaId);
    if (!item) return res.status(404).json({ error: 'Not found' });
    const { chapters, introEnd, outroStart } = req.body;
    if (chapters) item.chapters = chapters;
    if (introEnd !== undefined) item.introEnd = introEnd;
    if (outroStart !== undefined) item.outroStart = outroStart;
    saveDB(false, db.movies.includes(item) ? 'movies' : 'tvShows');
    res.json({ ok: true });
  });

  // Intro detection
  api.get('/intro-detect', (req, res) => res.json({ status: 'idle' }));
  api.post('/intro-detect', (req, res) => res.json({ ok: true }));

  // Logs
  api.get('/logs', (_, res) => res.json({ logs: [] }));
  api.delete('/logs', (_, res) => res.json({ ok: true }));

  // Random media
  api.get('/random/:type', (req, res) => {
    const arr = db[req.params.type] || db.movies;
    res.json(arr[Math.floor(Math.random() * arr.length)] || null);
  });

  // Bandwidth
  api.post('/bandwidth', (req, res) => res.json({ ok: true }));
  api.get('/bandwidth', (req, res) => res.json({ history: [] }));

  // Watch party
  api.post('/party/create', (req, res) => res.json({ roomId: require('crypto').randomBytes(4).toString('hex') }));
  api.get('/party/:roomId', (req, res) => res.json({ roomId: req.params.roomId, members: [] }));
  api.put('/party/:roomId/sync', (req, res) => res.json({ ok: true }));
  api.post('/party/:roomId/join', (req, res) => res.json({ ok: true }));

  // Ratings, favorites, queue
  api.get('/ratings/:userId', (req, res) => res.json({}));
  api.put('/ratings/:userId/:mediaId', (req, res) => {
    const item = [...db.movies, ...db.tvShows].find(i => i.id === req.params.mediaId);
    if (item) { item.userRating = req.body.rating; saveDB(false); }
    res.json({ ok: true });
  });
  api.delete('/ratings/:userId/:mediaId', (req, res) => res.json({ ok: true }));
  api.get('/favorites/:userId', (req, res) => res.json({ favorites: [] }));
  api.post('/favorites/:userId/:mediaId', (req, res) => res.json({ ok: true }));
  api.delete('/favorites/:userId/:mediaId', (req, res) => res.json({ ok: true }));
  api.get('/queue/:userId', (req, res) => res.json({ queue: [] }));
  api.put('/queue/:userId', (req, res) => res.json({ ok: true }));
  api.delete('/queue/:userId', (req, res) => res.json({ ok: true }));

  // Device
  api.post('/device/register', (req, res) => res.json({ ok: true }));
  api.get('/device/profiles', (_, res) => res.json({ profiles: [] }));

  // Webhooks
  api.put('/webhooks', (req, res) => res.json({ ok: true }));
  api.post('/webhooks/test', (req, res) => res.json({ ok: true }));

  // Home page
  api.get('/home/:userId', (req, res) => res.json({ sections: [] }));

  // Export
  api.get('/export/watch-history/:userId', (req, res) => res.json({ history: [] }));
  api.get('/export/m3u', (req, res) => { res.setHeader('Content-Type', 'application/x-mpegurl'); res.send('#EXTM3U\n'); });
  api.get('/export/xmltv', (req, res) => { res.setHeader('Content-Type', 'application/xml'); res.send('<?xml version="1.0"?><tv></tv>'); });

  // Search
  api.get('/search', (req, res) => {
    const q = (req.query.q || '').toLowerCase();
    if (!q) return res.json({ results: [] });
    const norm = s => (s||'').toLowerCase();
    const movies = db.movies.filter(m => norm(m.title).includes(q)).slice(0, 10).map(m => ({ ...m, _type: 'movie' }));
    const seen = new Set();
    const shows = db.tvShows.filter(ep => {
      const name = ep.seriesTitle||ep.showName||'';
      if (!norm(name).includes(q) || seen.has(name)) return false;
      seen.add(name); return true;
    }).slice(0, 10).map(ep => ({ ...ep, _type: 'tvShow' }));
    res.json({ results: [...movies, ...shows] });
  });

  // Poster cache
  api.get('/postercache/status', (_, res) => res.json({ status: 'idle', cached: 0 }));
  api.post('/postercache/start', (_, res) => res.json({ ok: true }));

  // Pretranscode
  api.get('/pretranscode/status', (_, res) => res.json({ status: 'idle' }));
  api.post('/pretranscode/start', (_, res) => res.json({ ok: true }));
  api.post('/pretranscode/stop', (_, res) => res.json({ ok: true }));

  // Metadata reset per type
  api.post('/library/:type/metadata/reset', async (req, res) => {
    const { type } = req.params;
    if (!db[type]) return res.status(404).json({ error: 'Not found' });
    db[type] = db[type].map(i => ({ ...i, metadataFetched: false, thumbnail: null, backdrop: null, overview: null, rating: null, tmdbId: null }));
    rebuildIndex(type);
    saveDB(true);
    metadataQueue = metadataQueue.filter(e => e.type !== type);
    if (type === 'tvShows') {
      const seen = new Set();
      const reps = db.tvShows.filter(ep => {
        const name = ep.seriesTitle || ep.showName || '';
        if (!name || seen.has(name)) return false;
        seen.add(name); return true;
      });
      metadataQueue.push(...reps.map(item => ({ item, type })));
      console.log(`[Metadata] Reset and requeued ${reps.length} unique shows`);
      res.json({ ok: true, queued: reps.length });
    } else {
      metadataQueue.push(...db[type].map(item => ({ item, type })));
      console.log(`[Metadata] Reset and requeued ${db[type].length} ${type} items`);
      res.json({ ok: true, queued: db[type].length });
    }
    // Explicitly start processing
    if (!_isProcessingQueue) processMetadataQueue();
  });

  // Metadata reset all
  api.post('/library/metadata/reset-all', async (req, res) => {
    metadataQueue = [];
    let total = 0;
    for (const type of ['movies','tvShows','music','musicVideos']) {
      if (db[type]?.length) {
        db[type] = db[type].map(i => ({ ...i, metadataFetched: false, thumbnail: null, backdrop: null, overview: null, rating: null, tmdbId: null }));
        queueMetadata(db[type], type);
        total += db[type].length;
      }
    }
    saveDB(true);
    res.json({ ok: true, queued: total });
  });

  // Cleanup extras
  api.post('/library/cleanup-extras', async (req, res) => {
    const before = db.movies.length;
    db.movies = db.movies.filter(m => !isTrailerOrExtra(m.fileName||''));
    const removed = before - db.movies.length;
    if (removed > 0) { rebuildIndex('movies'); saveDB(true, 'movies'); }
    res.json({ ok: true, removed });
  });

  // Autocollections stubs
  api.get('/autocollections/config', (_, res) => res.json(getConfig().autocollections || {}));
  api.put('/autocollections/config', (req, res) => { updateConfig({ autocollections: { ...(getConfig().autocollections||{}), ...req.body } }); res.json(getConfig().autocollections); });
  api.post('/autocollections/run', (_, res) => res.json({ ok: true, status: 'started' }));
  api.get('/autocollections/status', (_, res) => res.json({ running: false, phase: 'idle', done: 0, total: 0, current: '' }));
  api.post('/autocollections/franchises', (_, res) => res.json({ ok: true }));
  api.post('/autocollections/refresh-thumbnails', (_, res) => res.json({ ok: true }));
  api.get('/autocollections/streaming/status', (_, res) => res.json({ running: false, done: 0, total: 0 }));
  api.post('/autocollections/streaming/run', (_, res) => res.json({ ok: true }));

  // TMDB search proxy
  api.get('/tmdb/search', async (req, res) => {
    const { q, type } = req.query;
    if (!q) return res.json({ results: [] });
    try {
      const config = getConfig();
      const key = config.tmdbApiKey || 'b6f5b9a45520b77151c75f69af5a95af';
      const endpoint = type === 'tv'
        ? `https://api.themoviedb.org/3/search/tv?api_key=${key}&query=${encodeURIComponent(q)}`
        : `https://api.themoviedb.org/3/search/movie?api_key=${key}&query=${encodeURIComponent(q)}`;
      const r = await axiosPool.get(endpoint, { timeout: 8000 });
      res.json(r.data);
    } catch(e) { res.json({ results: [] }); }
  });

  // Local image serving
  api.get('/localimage', (req, res) => {
    const { path: imgPath } = req.query;
    if (!imgPath) return res.status(400).end();
    try {
      if (!fs.existsSync(imgPath)) return res.status(404).end();
      const ext = require('path').extname(imgPath).toLowerCase();
      const mime = { '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.png':'image/png', '.gif':'image/gif', '.webp':'image/webp' }[ext] || 'image/jpeg';
      res.setHeader('Content-Type', mime);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      fs.createReadStream(imgPath).pipe(res);
    } catch { res.status(404).end(); }
  });

  // Thumb serving
  api.get('/thumb', async (req, res) => {
    const { path: imgPath } = req.query;
    if (!imgPath) return res.status(400).end();
    try {
      if (!fs.existsSync(imgPath)) return res.status(404).end();
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      fs.createReadStream(imgPath).pipe(res);
    } catch { res.status(404).end(); }
  });

  api.get('/metadata/status', (_, res) => {
    const moviesFetched = db.movies.filter(m => m.metadataFetched).length;
    const tvFetched = db.tvShows.filter(ep => ep.metadataFetched).length;
    res.json({
      running: _isProcessingQueue,
      movies:  { total: db.movies.length,  fetched: moviesFetched },
      tvShows: { total: db.tvShows.length, fetched: tvFetched },
    });
  });
  api.get('/metadata/providers/status', (_, res) => res.json({ status: 'idle' }));
  api.post('/metadata/providers/refresh', (_, res) => res.json({ ok: true }));
  api.post('/metadata/providers/stop', (_, res) => res.json({ ok: true }));

  // Streaming services
  api.get('/streaming-services', (_, res) => res.json({ services: db.streamingServices || [] }));

  // Prerolls
  api.get('/prerolls/next', (_, res) => {
    const prerolls = (db.prerolls || []).filter(p => p.enabled !== false);
    if (!prerolls.length) return res.json(null);
    res.json(prerolls[Math.floor(Math.random() * prerolls.length)]);
  });

  // Overlays
  api.get('/overlays/:id', (req, res) => res.json({ overlay: null }));

  // Subtitles
  api.get('/subtitles/:id', async (req, res) => {
    const item = [...db.movies, ...db.tvShows].find(i => i.id === req.params.id);
    if (!item?.filePath) return res.status(404).json({ error: 'Not found' });
    res.json({ tracks: [] });
  });
  api.get('/subtitles/:id/tracks', (req, res) => res.json({ tracks: [] }));

  app.use('/api', api);

  // Serve React build
  const buildPath = path.join(__dirname, '..', 'build');
  if (fs.existsSync(buildPath)) {
    app.use(express.static(buildPath));
    app.get('*', (req, res) => { if (!req.path.startsWith('/api')) res.sendFile(path.join(buildPath, 'index.html')); });
  }

  // Hardware detection (background)
  detectHardwareAccel().then(enc => { cachedEncoder = enc; console.log('[Server] Hardware encoder:', enc); });

  // Queue missing metadata
  setTimeout(async () => {
    // Fast backfill — read each directory once, cache contents, look up in memory
    const dirCache = new Map();
    const readDir = (d) => {
      if (dirCache.has(d)) return dirCache.get(d);
      try { const files = new Set(fs.readdirSync(d).map(f => f.toLowerCase())); dirCache.set(d, files); return files; }
      catch(e) { dirCache.set(d, new Set()); return new Set(); }
    };
    const POSTER_NAMES = ['poster.jpg','poster.png','folder.jpg','folder.png','cover.jpg','cover.png'];
    const FANART_NAMES = ['fanart.jpg','fanart.png','backdrop.jpg','backdrop.png','background.jpg'];
    const findImg = (dirs, names) => {
      for (const dir of dirs) {
        const files = readDir(dir);
        for (const n of names) { if (files.has(n)) return path.join(dir, n); }
      }
      return null;
    };

    let localUpdated = 0;
    for (const type of ['movies','tvShows','music','musicVideos']) {
      for (const item of (db[type]||[])) {
        if ((item.thumbnail && item.backdrop) || !item.filePath) continue;
        try {
          const episodeDir = path.dirname(item.filePath);
          const showDir    = path.dirname(episodeDir);
          const dirs = showDir !== episodeDir ? [showDir, episodeDir] : [episodeDir];
          if (!item.thumbnail) {
            const p = findImg(dirs, POSTER_NAMES);
            if (p) { item.thumbnail = `/api/localimage?path=${encodeURIComponent(p)}`; localUpdated++; }
          }
          if (!item.backdrop) {
            const f = findImg(dirs, FANART_NAMES);
            if (f) item.backdrop = `/api/localimage?path=${encodeURIComponent(f)}`;
          }
        } catch(e) {}
      }
    }
    dirCache.clear();
    if (localUpdated > 0) {
      saveDB(true);
      invalidateGroupedCache();
      console.log(`[Startup] Backfilled local images for ${localUpdated} items`);
    } else {
      console.log(`[Startup] No local images found to backfill`);
    }

    // NFO backfill — read NFO files for items that haven't had metadata fetched yet
    const NFO_TAG  = (xml, n) => { const m = xml.match(new RegExp(`<${n}[^>]*>([\\s\\S]*?)<\\/${n}>`, 'i')); return m ? m[1].trim() : null; };
    const NFO_TAGS = (xml, n) => { const rx = new RegExp(`<${n}[^>]*>([\\s\\S]*?)<\\/${n}>`, 'gi'); const r = []; let m; while ((m = rx.exec(xml))) r.push(m[1].trim()); return r; };
    let nfoUpdated = 0;
    for (const type of ['movies','tvShows','music','musicVideos']) {
      for (const item of (db[type]||[])) {
        if (item.metadataFetched || !item.filePath) continue;
        const base = path.basename(item.filePath, path.extname(item.filePath));
        const dir  = path.dirname(item.filePath);
        const par  = path.dirname(dir);
        const nfoCandidates = [
          path.join(dir, `${base}.nfo`),
          path.join(dir, 'movie.nfo'), path.join(dir, 'tvshow.nfo'),
          path.join(par, 'tvshow.nfo'), path.join(par, 'movie.nfo'),
        ];
        let xml = null;
        for (const c of nfoCandidates) { try { xml = fs.readFileSync(c, 'utf8'); break; } catch {} }
        if (!xml) continue;
        const title = NFO_TAG(xml, 'title');
        if (!title) continue;
        item.title    = item.title || title;
        item.overview = item.overview || NFO_TAG(xml, 'plot') || NFO_TAG(xml, 'outline');
        item.year     = item.year   || parseInt(NFO_TAG(xml, 'year')    || '') || null;
        item.rating   = item.rating || parseFloat(NFO_TAG(xml, 'rating') || '') || null;
        item.runtime  = item.runtime|| parseInt(NFO_TAG(xml, 'runtime') || '') || null;
        if (!item.genres?.length)  item.genres  = NFO_TAGS(xml, 'genre').filter(Boolean);
        // Merge <studio> and <network> — NFO files use both depending on scraper
        const nfoStudios  = NFO_TAGS(xml, 'studio').filter(Boolean);
        const nfoNetworks = NFO_TAGS(xml, 'network').filter(Boolean);
        const nfoTags     = NFO_TAGS(xml, 'tag').filter(Boolean); // Kodi collection tags
        const combined = [...new Set([...(item.studios||[]), ...nfoStudios, ...nfoNetworks])];
        if (combined.length) item.studios = combined;
        if (nfoTags.length && !item.tags?.length) item.tags = nfoTags;
        item.tmdbId   = item.tmdbId || NFO_TAG(xml, 'tmdbid');
        item.metadataFetched = true;
        nfoUpdated++;
      }
    }
    if (nfoUpdated > 0) {
      saveDB(true);
      invalidateGroupedCache();
      console.log(`[Startup] Loaded metadata from NFO files for ${nfoUpdated} items`);
    }

    // Queue metadata for items STILL missing it (no NFO found)
    _isProcessingQueue = false;
    for (const type of ['movies','tvShows','music','musicVideos']) {
      const items = (db[type]||[]).filter(i => !i.metadataFetched && i.title);
      if (items.length) {
        console.log(`[Startup] ${items.length} ${type} items without NFO — queuing API fetch`);
        queueMetadata(items, type);
      }
    }
  }, 5000);

  // TV show name merge by tmdbId
  setTimeout(() => {
    try {
      const byTmdb = new Map();
      for (const ep of db.tvShows) {
        if (!ep.tmdbId) continue;
        const key = String(ep.tmdbId);
        if (!byTmdb.has(key)) byTmdb.set(key, new Map());
        const name = ep.seriesTitle||ep.showName||'';
        if (name) byTmdb.get(key).set(name, (byTmdb.get(key).get(name)||0)+1);
      }
      let merged = 0;
      for (const [, names] of byTmdb) {
        if (names.size < 2) continue;
        const primary = [...names.entries()].sort((a,b)=>b[1]-a[1])[0][0];
        const others = [...names.keys()].filter(n=>n!==primary);
        for (const ep of db.tvShows) {
          const n = ep.seriesTitle||ep.showName||'';
          if (others.includes(n)) { if (ep.seriesTitle) ep.seriesTitle=primary; else ep.showName=primary; merged++; }
        }
      }
      if (merged) { saveDB(true,'tvShows'); console.log(`[Merge] ${merged} episodes re-assigned`); }
      else console.log('[Merge] No duplicate tmdbId shows found');
    } catch(e) { console.error('[Merge] Error:', e.message); }
  }, 5000);

  const PORT = 3001;
  server.listen(PORT, () => {
    console.log(`[Orion] Running on http://localhost:${PORT}`);
    console.log(`[Orion] Movies: ${db.movies.length} | TV: ${db.tvShows.length} | Users: ${db.users.length}`);
  });

  process.on('SIGINT',  () => { saveDB(true); server.close(() => process.exit(0)); });
  process.on('SIGTERM', () => { saveDB(true); server.close(() => process.exit(0)); });
}

process.on('uncaughtException',  err    => console.error('[FATAL]', err.message, err.stack));
process.on('unhandledRejection', reason => console.error('[FATAL] Unhandled rejection:', reason));

start().catch(err => { console.error('[FATAL] Startup failed:', err.message); process.exit(1); });

module.exports = { app, server, io, db };

'use strict';
/**
 * Orion Trailer Routes
 * /api/trailers/*, /api/tv-trailers/*, /api/ytdlp/*, /api/tmdb/tv-videos/*, /api/theme/*
 */

const express        = require('express');
const path           = require('path');
const fs             = require('fs');
const { exec, spawn } = require('child_process');
const { axiosPool }  = require('../services/metadata');

module.exports = function trailerRoutes(deps) {
  const {
    db, io, saveDB, PATHS, findById,
    ytdlpReady, ensureYtDlp, ffmpegStatic,
    _trailerOverrides, saveTrailerOverrides,
    _blockedVideoIds, saveBlockedVideoIds,
    invalidateGroupedCache, getConfig,
  } = deps;

  const router = express.Router();
  const TRAILER_CACHE_DIR = PATHS.TRAILER_CACHE_DIR;
  const _trailerInProgress = new Set();

  // ── Helpers ────────────────────────────────────────────────────────────────

  /** Serve a file with range support. */
  function serveFile(res, req, filePath, cacheControl = 'no-cache') {
    const size = fs.statSync(filePath).size;
    const range = req.headers.range;
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', cacheControl);
    if (range) {
      const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
      const start = parseInt(startStr, 10);
      const end   = endStr ? parseInt(endStr, 10) : size - 1;
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      res.setHeader('Content-Length', end - start + 1);
      const s = fs.createReadStream(filePath, { start, end });
      s.on('error', () => { if (!res.writableEnded) res.end(); });
      s.pipe(res);
      req.on('close', () => s.destroy());
    } else {
      res.setHeader('Content-Length', size);
      const s = fs.createReadStream(filePath);
      s.on('error', () => { if (!res.writableEnded) res.end(); });
      s.pipe(res);
    }
  }

  /** Get the root show folder from any episode filePath. */
  function getShowDir(showName) {
    const ep = db.tvShows.find(e => (e.seriesTitle || e.showName) === showName && e.filePath);
    if (!ep?.filePath) return null;
    const d = path.dirname(ep.filePath);
    return /season|series|disc|^s\d+/i.test(path.basename(d)) ? path.dirname(d) : d;
  }

  /** Find trailer-*.mp4 files in a show folder. Returns array of videoIds. */
  function findLocalTrailers(showDir) {
    if (!showDir) return [];
    try {
      return fs.readdirSync(showDir)
        .filter(f => /^trailer-[A-Za-z0-9_-]+\.mp4$/.test(f))
        .map(f => f.match(/^trailer-([A-Za-z0-9_-]+)\.mp4$/)[1]);
    } catch { return []; }
  }

  /**
   * Use yt-dlp to search YouTube and return the first matching video ID.
   * Fast — only fetches the ID, does not download.
   */
  function searchYouTubeForTrailer(showName) {
    const ytdlp = ytdlpReady;
    if (!ytdlp) return Promise.resolve(null);
    return new Promise((resolve) => {
      const query = `${showName} official trailer`;
      exec(
        `"${ytdlp}" --no-playlist --quiet --get-id "ytsearch1:${query}"`,
        { timeout: 30000, encoding: 'utf8', windowsHide: true },
        (err, stdout) => {
          if (err) { console.warn(`[TV Trailers] YouTube search failed for "${showName}":`, err.message); return resolve(null); }
          resolve(stdout.trim().split('\n')[0] || null);
        }
      );
    });
  }

  /**
   * Download a YouTube video to destPath using yt-dlp + ffmpeg.
   * Returns true on success.
   */
  async function downloadToFile(videoId, destPath) {
    const ytdlp = ytdlpReady || await ensureYtDlp();
    if (!ytdlp) return false;
    const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const node  = process.execPath.replace(/\\/g, '/');
    const lines = await new Promise((resolve, reject) => {
      exec(
        `"${ytdlp}" --js-runtimes "node:${node}" --no-playlist --quiet ` +
        `-f "bestvideo[height<=720][ext=mp4][protocol=https]+bestaudio[ext=m4a][protocol=https]/best[height<=720][ext=mp4][protocol=https]" ` +
        `--get-url "${ytUrl}"`,
        { timeout: 60000, encoding: 'utf8', windowsHide: true },
        (err, stdout) => {
          if (err) return reject(err);
          resolve(stdout.trim().split('\n').map(l => l.trim()).filter(l => l.startsWith('http')));
        }
      );
    });
    if (!lines.length) return false;
    const ffArgs = lines.length >= 2
      ? ['-i', lines[0], '-i', lines[1], '-c:v', 'copy', '-c:a', 'aac']
      : ['-i', lines[0], '-c', 'copy'];
    return new Promise(resolve => {
      const ff = spawn(ffmpegStatic || 'ffmpeg', [...ffArgs, '-y', destPath], { windowsHide: true });
      ff.stderr.on('data', () => {});
      ff.on('close', code => {
        const ok = code === 0 && (() => { try { return fs.statSync(destPath).size > 100000; } catch { return false; } })();
        if (!ok) { try { fs.unlinkSync(destPath); } catch {} }
        resolve(ok);
      });
      ff.on('error', () => resolve(false));
    });
  }

  /**
   * Full pipeline: search → download → update override → return videoId.
   * Returns videoId string or null.
   */
  async function findAndDownloadTrailer(showName) {
    const videoId = searchYouTubeForTrailer(showName);
    if (!videoId) return null;

    const showDir = getShowDir(showName);
    if (showDir) {
      const destPath = path.join(showDir, `trailer-${videoId}.mp4`);
      if (!fs.existsSync(destPath)) {
        console.log(`[TV Trailers] Downloading trailer for "${showName}" → ${videoId}`);
        await downloadToFile(videoId, destPath);
      }
    }

    // Persist override so we don't re-search next time
    if (_trailerOverrides) _trailerOverrides[showName] = videoId;
    saveTrailerOverrides?.();
    for (const ep of db.tvShows) {
      if ((ep.seriesTitle || ep.showName) === showName) ep.trailerOverride = videoId;
    }
    saveDB(false, 'tvShows');

    return videoId;
  }

  // ── yt-dlp status / install ────────────────────────────────────────────────

  router.get('/ytdlp/status', (req, res) => {
    res.json({ ready: !!ytdlpReady, path: ytdlpReady || null });
  });

  router.post('/ytdlp/install', async (req, res) => {
    try {
      const ytdlp = await ensureYtDlp();
      res.json({ ok: !!ytdlp, path: ytdlp });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Stream trailer via yt-dlp (movies + TV) ────────────────────────────────

  router.get('/ytdlp/stream', async (req, res) => {
    const { url, movieId, showName } = req.query;
    if (!url) return res.status(400).end();

    const ytMatch = url.match(/[?&]v=([^&]+)/) || url.match(/youtu\.be\/([^?]+)/);
    if (!ytMatch) return res.status(400).json({ error: 'Not a YouTube URL' });
    const videoId = ytMatch[1];

    if (_blockedVideoIds?.has(videoId)) return res.status(403).json({ error: 'Video blocked' });

    // Local cache
    const localCachePath = path.join(TRAILER_CACHE_DIR, `${videoId}.mp4`);
    const isLocalCached  = (() => { try { return fs.statSync(localCachePath).size > 100000; } catch { return false; } })();
    if (isLocalCached) {
      console.log('[trailer] Serving from local cache:', videoId);
      return serveFile(res, req, localCachePath, 'no-cache');
    }

    // NAS cache
    const getNasDir = () => {
      if (movieId) { const m = findById('movies', movieId); if (m?.filePath) return path.dirname(m.filePath); }
      if (showName) { const sd = getShowDir(decodeURIComponent(showName)); if (sd) return sd; }
      return null;
    };
    const nasDir = getNasDir();
    if (nasDir) {
      const nasCachePath = path.join(nasDir, `trailer-${videoId}.mp4`);
      const isNasCached  = (() => { try { return fs.statSync(nasCachePath).size > 100000; } catch { return false; } })();
      if (isNasCached) {
        if (!fs.existsSync(localCachePath)) fs.copyFile(nasCachePath, localCachePath, () => {});
        console.log('[trailer] Serving from NAS cache:', nasCachePath);
        return serveFile(res, req, nasCachePath, 'public, max-age=86400');
      }
    }

    // Wait for in-progress download
    if (_trailerInProgress.has(videoId)) {
      let waited = 0;
      while (_trailerInProgress.has(videoId) && waited < 60000) { await new Promise(r => setTimeout(r, 500)); waited += 500; }
      if (fs.existsSync(localCachePath)) {
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Cache-Control', 'public, max-age=604800');
        return fs.createReadStream(localCachePath).pipe(res);
      }
      return res.status(503).json({ error: 'Download timeout' });
    }

    const ytdlp = ytdlpReady || await ensureYtDlp();
    if (!ytdlp) return res.status(503).json({ error: 'yt-dlp not ready' });

    _trailerInProgress.add(videoId);
    try {
      const node = process.execPath.replace(/\\/g, '/');
      const cmd  = `"${ytdlp}" --js-runtimes "node:${node}" --no-playlist --no-warnings -f "bestvideo[height<=720][ext=mp4][protocol=https]+bestaudio[ext=m4a][protocol=https]/best[height<=720][ext=mp4][protocol=https]/best[ext=mp4][protocol=https]" --get-url "${url}"`;

      const lines = await new Promise((resolve, reject) => {
        exec(cmd, { timeout: 60000, encoding: 'utf8', windowsHide: true }, (err, stdout) => {
          if (err) return reject(err);
          resolve(stdout.trim().split('\n').map(l => l.trim()).filter(l => l.startsWith('http')));
        });
      });
      if (!lines.length) { _trailerInProgress.delete(videoId); return res.status(404).json({ error: 'No stream URL' }); }

      const ffArgs = lines.length >= 2 ? ['-i', lines[0], '-i', lines[1], '-c:v', 'copy', '-c:a', 'aac'] : ['-i', lines[0], '-c', 'copy'];
      const ffPath = ffmpegStatic || 'ffmpeg';
      const ff     = spawn(ffPath, [...ffArgs, '-y', localCachePath], { windowsHide: true });
      ff.stderr.on('data', () => {});
      ff.on('close', code => {
        _trailerInProgress.delete(videoId);
        if (code === 0) {
          const size = (() => { try { return fs.statSync(localCachePath).size; } catch { return 0; } })();
          if (size > 100000 && !res.writableEnded) {
            res.setHeader('Content-Type', 'video/mp4');
            res.setHeader('Content-Length', size);
            res.setHeader('Cache-Control', 'no-cache');
            fs.createReadStream(localCachePath).pipe(res);
          } else { try { fs.unlinkSync(localCachePath); } catch {} if (!res.writableEnded) res.status(500).json({ error: 'Download too small' }); }
        } else {
          try { fs.unlinkSync(localCachePath); } catch {}
          if (!res.writableEnded) res.status(500).json({ error: 'Download failed' });
        }
      });
      ff.on('error', e => { _trailerInProgress.delete(videoId); if (!res.writableEnded) res.status(500).end(); });
    } catch (e) {
      _trailerInProgress.delete(videoId);
      res.status(500).json({ error: e.message });
    }
  });

  // ── Movie trailer management ───────────────────────────────────────────────

  router.get('/trailers/:movieId', (req, res) => {
    const movie = findById('movies', req.params.movieId);
    if (!movie?.filePath) return res.json({ trailers: [] });
    const movieDir = path.dirname(movie.filePath);
    try {
      const files = fs.readdirSync(movieDir)
        .filter(f => f.match(/^trailer-[A-Za-z0-9_-]+\.mp4$/))
        .map(f => ({ file: f, url: `/api/ytdlp/cached?movieId=${req.params.movieId}&file=${encodeURIComponent(f)}` }));
      res.json({ trailers: files });
    } catch { res.json({ trailers: [] }); }
  });

  router.get('/ytdlp/cached', (req, res) => {
    const { movieId, showName, file } = req.query;
    if (!file || !/^trailer-[A-Za-z0-9_-]+\.mp4$/.test(file)) return res.status(400).json({ error: 'Invalid file' });
    let dir = null;
    if (movieId)  { const m = findById('movies', movieId); if (m?.filePath) dir = path.dirname(m.filePath); }
    if (!dir && showName) dir = getShowDir(decodeURIComponent(showName));
    if (!dir) return res.status(404).json({ error: 'Media not found' });
    const filePath = path.join(dir, file);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
    serveFile(res, req, filePath, 'public, max-age=86400');
  });

  router.get('/ytdlp/cache', (req, res) => {
    try { const files = fs.readdirSync(TRAILER_CACHE_DIR).filter(f => f.endsWith('.mp4')); res.json({ files, dir: TRAILER_CACHE_DIR, total: files.length }); }
    catch { res.json({ files: [], dir: TRAILER_CACHE_DIR, total: 0 }); }
  });

  router.post('/ytdlp/block/:videoId', (req, res) => {
    const { videoId } = req.params;
    if (!videoId || !/^[A-Za-z0-9_-]+$/.test(videoId)) return res.status(400).json({ error: 'Invalid videoId' });
    _blockedVideoIds?.add(videoId);
    saveBlockedVideoIds?.();
    try { fs.unlinkSync(path.join(TRAILER_CACHE_DIR, `${videoId}.mp4`)); } catch {}

    // Clear any trailerOverride pointing to this video so it won't be served again
    if (_trailerOverrides) {
      for (const [show, vid] of Object.entries(_trailerOverrides)) {
        if (vid === videoId) delete _trailerOverrides[show];
      }
      saveTrailerOverrides?.();
    }
    for (const ep of db.tvShows) {
      if (ep.trailerOverride === videoId) ep.trailerOverride = null;
    }
    saveDB(false, 'tvShows');

    res.json({ ok: true, blocked: videoId });
  });

  router.delete('/ytdlp/cache/:videoId', (req, res) => {
    const { videoId } = req.params;
    if (!videoId || !/^[A-Za-z0-9_-]+$/.test(videoId)) return res.status(400).json({ error: 'Invalid videoId' });
    const deleted = [];
    try { fs.unlinkSync(path.join(TRAILER_CACHE_DIR, `${videoId}.mp4`)); deleted.push(path.join(TRAILER_CACHE_DIR, `${videoId}.mp4`)); } catch {}
    for (const movie of db.movies || []) {
      if (!movie.filePath) continue;
      const nasPath = path.join(path.dirname(movie.filePath), `trailer-${videoId}.mp4`);
      try { fs.unlinkSync(nasPath); deleted.push(nasPath); } catch {}
    }
    res.json({ ok: true, deleted, total: deleted.length });
  });

  // ── TV Trailer overrides ───────────────────────────────────────────────────

  router.get('/tv-trailers/override/:showName', (req, res) => {
    const showName = decodeURIComponent(req.params.showName);
    const override = _trailerOverrides?.[showName] || db.tvShows.find(e => (e.seriesTitle || e.showName) === showName)?.trailerOverride || null;
    res.json({ trailerOverride: override });
  });

  router.post('/tv-trailers/set', async (req, res) => {
    const { showName, youtubeUrl } = req.body;
    if (!showName || !youtubeUrl) return res.status(400).json({ error: 'showName and youtubeUrl required' });
    const ytMatch = youtubeUrl.match(/[?&]v=([^&]+)/) || youtubeUrl.match(/youtu\.be\/([^?]+)/);
    if (!ytMatch) return res.status(400).json({ error: 'Invalid YouTube URL' });
    const videoId = ytMatch[1];

    if (_trailerOverrides) _trailerOverrides[showName] = videoId;
    saveTrailerOverrides?.();

    let updated = 0;
    for (const ep of db.tvShows) {
      if ((ep.seriesTitle || ep.showName) === showName) { ep.trailerOverride = videoId; updated++; }
    }
    if (updated > 0) { saveDB(); if (invalidateGroupedCache) invalidateGroupedCache(); }

    // Clear old cached trailer files from NAS show folder
    const showDir = getShowDir(showName);
    if (showDir) {
      try {
        for (const f of fs.readdirSync(showDir).filter(f => f.match(/^trailer-[A-Za-z0-9_-]+\.mp4$/))) {
          try { fs.unlinkSync(path.join(showDir, f)); } catch {}
        }
      } catch {}
    }

    res.json({ ok: true, showName, videoId, updated });
  });

  // ── GET /api/tv-trailers/:showName ────────────────────────────────────────
  // Priority:
  //   1. trailer-*.mp4 files already in the NAS show folder
  //   2. Manual trailerOverride set via /tv-trailers/set
  //   3. Auto-search YouTube via yt-dlp, download to show folder, set override

  router.get('/tv-trailers/:showName', async (req, res) => {
    const showName = decodeURIComponent(req.params.showName);

    // 1. NAS show folder — look for existing trailer-*.mp4
    const showDir    = getShowDir(showName);
    const localIds   = findLocalTrailers(showDir);
    if (localIds.length > 0) {
      const videoId = localIds[0];
      console.log(`[TV Trailers] Serving local file for "${showName}": ${videoId}`);
      return res.json({ trailers: [{ videoId, url: `/api/tv-trailer-file?showName=${encodeURIComponent(showName)}&videoId=${videoId}` }] });
    }

    // 2. Manual override — skip if the video is blocked
    const override = _trailerOverrides?.[showName] || db.tvShows.find(e => (e.seriesTitle || e.showName) === showName)?.trailerOverride;
    if (override && !_blockedVideoIds?.has(override)) {
      return res.json({ trailers: [{ videoId: override, url: `/api/ytdlp/stream?url=${encodeURIComponent('https://www.youtube.com/watch?v=' + override)}&showName=${encodeURIComponent(showName)}` }] });
    }

    // 3. Auto-search + download (yt-dlp required)
    if (!ytdlpReady) return res.json({ trailers: [] });

    try {
      const videoId = await findAndDownloadTrailer(showName);
      if (!videoId) return res.json({ trailers: [] });

      // Check if we got the file on NAS or just the override
      const updatedIds = findLocalTrailers(showDir);
      const url = updatedIds.length > 0
        ? `/api/tv-trailer-file?showName=${encodeURIComponent(showName)}&videoId=${videoId}`
        : `/api/ytdlp/stream?url=${encodeURIComponent('https://www.youtube.com/watch?v=' + videoId)}&showName=${encodeURIComponent(showName)}`;

      return res.json({ trailers: [{ videoId, url }] });
    } catch (e) {
      console.error('[TV Trailers] Auto-search error:', e.message);
      return res.json({ trailers: [] });
    }
  });

  router.get('/tv-trailers-random', (req, res) => {
    const shows = db.tvShows.filter(ep => ep.trailerOverride);
    if (!shows.length) return res.json({ trailer: null });
    const ep       = shows[Math.floor(Math.random() * shows.length)];
    const showName = ep.seriesTitle || ep.showName;
    const videoId  = ep.trailerOverride;
    res.json({ trailer: {
      videoId,
      url: `/api/ytdlp/stream?url=${encodeURIComponent('https://www.youtube.com/watch?v=' + videoId)}&showName=${encodeURIComponent(showName)}`,
      showName,
    }});
  });

  router.get('/tv-trailer-file', (req, res) => {
    const { showName, videoId } = req.query;
    if (!showName || !videoId) return res.status(400).json({ error: 'showName and videoId required' });
    const showDir  = getShowDir(showName);
    if (!showDir) return res.status(404).json({ error: 'Show not found' });
    const filePath = path.join(showDir, `trailer-${videoId}.mp4`);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not cached' });
    serveFile(res, req, filePath, 'public, max-age=86400');
  });

  // ── POST /api/tv-trailers/download-all ────────────────────────────────────
  // Called by the scheduler "Download TV Trailers" task.
  // Goes through every unique show, downloads any missing trailer in background.

  let _downloadAllRunning = false;

  router.post('/tv-trailers/download-all', async (req, res) => {
    if (_downloadAllRunning) return res.json({ ok: true, status: 'already running' });
    res.json({ ok: true, status: 'started' });
    _downloadAllRunning = true;

    const uniqueShows = [...new Set(db.tvShows.map(ep => ep.seriesTitle || ep.showName))].filter(Boolean);
    let downloaded = 0, skipped = 0, failed = 0;

    console.log(`[TV Trailers] Batch download starting — ${uniqueShows.length} shows`);
    io.emit('scan:progress', { status: `Downloading TV trailers — 0/${uniqueShows.length}` });

    for (let i = 0; i < uniqueShows.length; i++) {
      const showName = uniqueShows[i];

      // Skip if already have a local file or override
      const showDir  = getShowDir(showName);
      const localIds = findLocalTrailers(showDir);
      const override = _trailerOverrides?.[showName] || db.tvShows.find(e => (e.seriesTitle || e.showName) === showName)?.trailerOverride;

      if (localIds.length > 0 || override) { skipped++; continue; }
      if (!ytdlpReady) { failed++; continue; }

      try {
        const videoId = await findAndDownloadTrailer(showName);
        if (videoId) downloaded++;
        else failed++;
      } catch { failed++; }

      io.emit('scan:progress', { status: `TV trailers: ${i + 1}/${uniqueShows.length} — ${downloaded} downloaded` });
      await new Promise(r => setTimeout(r, 200)); // breathe between shows
    }

    saveDB(true);
    _downloadAllRunning = false;
    const summary = `TV trailer batch done — ${downloaded} downloaded, ${skipped} skipped, ${failed} failed`;
    console.log(`[TV Trailers] ${summary}`);
    io.emit('scan:complete', { type: 'tvTrailers', added: downloaded, total: uniqueShows.length });
  });

  // ── GET /api/tmdb/tv-videos/:tmdbId ───────────────────────────────────────

  router.get('/tmdb/tv-videos/:tmdbId', async (req, res) => {
    try {
      const key = getConfig().tmdbApiKey;
      if (!key) return res.json({ videos: [], tmdbId: req.params.tmdbId });
      const r = await axiosPool.get(`https://api.themoviedb.org/3/tv/${req.params.tmdbId}/videos?api_key=${key}`);
      const videos = (r.data.results || []).filter(v => ['Trailer', 'Teaser'].includes(v.type));
      res.json({ videos, tmdbId: req.params.tmdbId });
    } catch (_) {
      res.json({ videos: [], tmdbId: req.params.tmdbId });
    }
  });

  // ── GET /api/theme/test ────────────────────────────────────────────────────

  router.get('/theme/test', (req, res) => {
    res.json({ ready: !!ytdlpReady, path: ytdlpReady || null });
  });

  // ── GET /api/theme/:showName ───────────────────────────────────────────────

  router.get('/theme/:showName', async (req, res) => {
    if (!ytdlpReady) return res.status(503).json({ error: 'yt-dlp not installed' });

    const showName  = decodeURIComponent(req.params.showName);
    const safeKey   = showName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const themeDir  = path.join(PATHS.DATA_DIR, 'themes');
    const cachePath = path.join(themeDir, `${safeKey}.mp4`);

    function serveTheme() {
      const stat  = fs.statSync(cachePath);
      const range = req.headers.range;
      res.setHeader('Content-Type', 'audio/mp4');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      if (range) {
        const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
        const start = parseInt(startStr, 10);
        const end   = endStr ? parseInt(endStr, 10) : stat.size - 1;
        res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
        fs.createReadStream(cachePath, { start, end }).pipe(res);
      } else {
        res.setHeader('Content-Length', stat.size);
        fs.createReadStream(cachePath).pipe(res);
      }
    }

    if (fs.existsSync(cachePath)) return serveTheme();

    fs.mkdirSync(themeDir, { recursive: true });
    const tmpPath = cachePath + '.tmp';

    try {
      await new Promise((resolve, reject) => {
        const child = spawn(ytdlpReady, [
          '--no-playlist', '--quiet',
          '-f', 'bestaudio[ext=m4a]/bestaudio',
          '--merge-output-format', 'mp4',
          '--ffmpeg-location', ffmpegStatic,
          '-o', tmpPath,
          `ytsearch1:${showName} theme song official`,
        ]);
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('timeout')); }, 60000);
        child.stderr.on('data', () => {});
        child.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`yt-dlp exit ${code}`)); });
      });
    } catch (e) {
      try { fs.unlinkSync(tmpPath); } catch (_) {}
      console.warn(`[Theme] ${showName}: ${e.message}`);
      return res.status(404).json({ error: 'Could not download theme song' });
    }

    if (!fs.existsSync(tmpPath)) return res.status(404).json({ error: 'Theme download produced no file' });
    fs.renameSync(tmpPath, cachePath);
    return serveTheme();
  });

  return router;
};

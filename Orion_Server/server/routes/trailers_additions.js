// ═══════════════════════════════════════════════════════════════════════════
// ADD THE FOLLOWING BLOCK TO server/routes/trailers.js
// Placement: just before the final  return router;  line
// Assumes: fs, path already imported at top of file (they almost certainly
//          are — the file already handles cached file I/O).
//          axiosPool already imported from services/metadata (same pattern
//          as other TMDB calls in trailers.js).
// ═══════════════════════════════════════════════════════════════════════════

'use strict';
// (these are already at the top of trailers.js — shown here for reference)
// const fs   = require('fs');
// const path = require('path');
// const { spawn } = require('child_process');
// const { axiosPool } = require('../services/metadata');

// ── GET /api/tmdb/tv-videos/:tmdbId ──────────────────────────────────────
// Fetches Trailer + Teaser video keys from TMDB for BGVideo in App.jsx.

router.get('/tmdb/tv-videos/:tmdbId', async (req, res) => {
  try {
    const key = getConfig().tmdbApiKey;
    if (!key) return res.json({ videos: [], tmdbId: req.params.tmdbId });
    const r = await axiosPool.get(
      `https://api.themoviedb.org/3/tv/${req.params.tmdbId}/videos?api_key=${key}`
    );
    const videos = (r.data.results || []).filter(
      v => ['Trailer', 'Teaser'].includes(v.type)
    );
    res.json({ videos, tmdbId: req.params.tmdbId });
  } catch (_) {
    res.json({ videos: [], tmdbId: req.params.tmdbId });
  }
});

// ── GET /api/theme/test ────────────────────────────────────────────────────
// Returns whether yt-dlp is ready (used by settings page / theme player).

router.get('/theme/test', (req, res) => {
  res.json({ ready: !!ytdlpReady, path: ytdlpReady || null });
});

// ── GET /api/theme/:showName ───────────────────────────────────────────────
// Serves (or downloads on first request) a TV show theme song via yt-dlp.
// • If already cached → serves with range support.
// • If not cached → downloads (up to 60 s timeout), then serves.
// • Returns 404 if yt-dlp can't find / download the song.

router.get('/theme/:showName', async (req, res) => {
  if (!ytdlpReady) return res.status(503).json({ error: 'yt-dlp not installed' });

  const showName  = decodeURIComponent(req.params.showName);
  const safeKey   = showName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  const themeDir  = path.join(PATHS.DATA_DIR, 'themes');
  const cachePath = path.join(themeDir, `${safeKey}.mp4`);

  // ── serve from cache ──────────────────────────────────────────────────
  function serveTheme() {
    const stat = fs.statSync(cachePath);
    const range = req.headers.range;
    res.setHeader('Content-Type', 'audio/mp4');
    res.setHeader('Cache-Control', 'public, max-age=86400');

    if (range) {
      const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
      const start = parseInt(startStr, 10);
      const end   = endStr ? parseInt(endStr, 10) : stat.size - 1;
      res.writeHead(206, {
        'Content-Range':  `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges':  'bytes',
        'Content-Length': end - start + 1,
      });
      fs.createReadStream(cachePath, { start, end }).pipe(res);
    } else {
      res.setHeader('Content-Length', stat.size);
      fs.createReadStream(cachePath).pipe(res);
    }
  }

  if (fs.existsSync(cachePath)) return serveTheme();

  // ── download ──────────────────────────────────────────────────────────
  fs.mkdirSync(themeDir, { recursive: true });
  const tmpPath = cachePath + '.tmp';

  const dlArgs = [
    '--no-playlist', '--quiet',
    '-f', 'bestaudio[ext=m4a]/bestaudio',
    '--merge-output-format', 'mp4',
    '--ffmpeg-location', ffmpegStatic,
    '-o', tmpPath,
    `ytsearch1:${showName} theme song official`,
  ];

  try {
    await new Promise((resolve, reject) => {
      const child = spawn(ytdlpReady, dlArgs);
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('timeout'));
      }, 60000);
      child.stderr.on('data', () => {});
      child.on('close', code => {
        clearTimeout(timer);
        code === 0 ? resolve() : reject(new Error(`yt-dlp exit ${code}`));
      });
    });
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    console.warn(`[Theme] ${showName}: ${e.message}`);
    return res.status(404).json({ error: 'Could not download theme song' });
  }

  if (!fs.existsSync(tmpPath)) {
    return res.status(404).json({ error: 'Theme download produced no file' });
  }

  fs.renameSync(tmpPath, cachePath);
  return serveTheme();
});

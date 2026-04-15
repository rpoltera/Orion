'use strict';
const express = require('express');
const fs      = require('fs');
const path    = require('path');
const { spawn } = require('child_process');

// axiosPool lives in services/metadata — not in deps(), so require directly
const { axiosPool } = require('../services/metadata');

module.exports = function (deps) {
  const router = express.Router();
  const { db, PATHS, getConfig, findById, ffmpegStatic } = deps;

  // ── helpers ────────────────────────────────────────────────────────────────

  /** Stream a local image file with 24 h cache headers. */
  function serveFile(res, filePath) {
    const ext  = path.extname(filePath).toLowerCase();
    const mime = ext === '.png' ? 'image/png'
               : ext === '.svg' ? 'image/svg+xml'
               : 'image/jpeg';
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    fs.createReadStream(filePath).pipe(res);
  }

  /** Fetch a URL as binary and write to destPath. Returns destPath. */
  async function downloadBinary(url, destPath) {
    const r = await axiosPool.get(url, { responseType: 'arraybuffer' });
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, r.data);
    return destPath;
  }

  /**
   * Look up the best English clearlogo for a TMDB id via the Images API.
   * Returns the full CDN URL (no key needed on the image CDN), or null.
   */
  async function getTmdbLogoUrl(tmdbId, mediaType) {
    const key = getConfig().tmdbApiKey;
    if (!key || !tmdbId) return null;
    try {
      const r = await axiosPool.get(
        `https://api.themoviedb.org/3/${mediaType}/${tmdbId}/images` +
        `?include_image_language=en,null&api_key=${key}`
      );
      const logos = r.data.logos || [];
      const logo  = logos.find(l => l.iso_639_1 === 'en')
                 || logos.find(l => !l.iso_639_1)
                 || logos[0];
      if (!logo) return null;
      return `https://image.tmdb.org/t/p/original${logo.file_path}`;
    } catch (_) {
      return null;
    }
  }

  // ── GET /api/clearlogo/:id  (movie, by numeric id) ─────────────────────────
  // ── GET /api/clearlogo-movie/:id  (alias) ──────────────────────────────────

  async function handleMovieClearlogo(req, res) {
    const id        = req.params.id;
    const cachePath = path.join(PATHS.IMG_DIR, `clearlogo-movie-${id}.png`);

    if (fs.existsSync(cachePath)) return serveFile(res, cachePath);

    const item = findById('movies', id);
    if (!item) return res.status(404).json({ error: 'Not found' });

    const logoUrl = await getTmdbLogoUrl(item.tmdbId, 'movie');
    if (!logoUrl) return res.status(404).json({ error: 'No clearlogo available' });

    try {
      await downloadBinary(logoUrl, cachePath);
      return serveFile(res, cachePath);
    } catch (e) {
      return res.status(500).json({ error: 'Failed to download clearlogo' });
    }
  }

  router.get('/clearlogo/:id',       handleMovieClearlogo);
  router.get('/clearlogo-movie/:id', handleMovieClearlogo);

  // ── GET /api/clearlogo-show/:showName ──────────────────────────────────────

  router.get('/clearlogo-show/:showName', async (req, res) => {
    const showName  = decodeURIComponent(req.params.showName);
    const safeKey   = showName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const cachePath = path.join(PATHS.IMG_DIR, `clearlogo-show-${safeKey}.png`);

    if (fs.existsSync(cachePath)) return serveFile(res, cachePath);

    // Find any episode that has a tmdbId for this show
    const ep = db.tvShows.find(
      e => (e.seriesTitle || e.showName) === showName && e.tmdbId
    );
    if (!ep) return res.status(404).json({ error: 'Show not found or no TMDB id' });

    const logoUrl = await getTmdbLogoUrl(ep.tmdbId, 'tv');
    if (!logoUrl) return res.status(404).json({ error: 'No clearlogo available' });

    try {
      await downloadBinary(logoUrl, cachePath);
      return serveFile(res, cachePath);
    } catch (e) {
      return res.status(500).json({ error: 'Failed to download clearlogo' });
    }
  });

  // ── GET /api/season-poster/:showName/:seasonNum ────────────────────────────

  router.get('/season-poster/:showName/:seasonNum', async (req, res) => {
    const showName  = decodeURIComponent(req.params.showName);
    const seasonNum = parseInt(req.params.seasonNum, 10);
    const safeKey   = showName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const cachePath = path.join(PATHS.IMG_DIR, `season-${safeKey}-s${seasonNum}.jpg`);

    if (fs.existsSync(cachePath)) return serveFile(res, cachePath);

    const key = getConfig().tmdbApiKey;
    if (!key) return res.status(404).json({ error: 'No TMDB key configured' });

    const ep = db.tvShows.find(
      e => (e.seriesTitle || e.showName) === showName && e.tmdbId
    );
    if (!ep) return res.status(404).json({ error: 'Show not found or no TMDB id' });

    try {
      const r = await axiosPool.get(
        `https://api.themoviedb.org/3/tv/${ep.tmdbId}/season/${seasonNum}/images?api_key=${key}`
      );
      const posters = r.data.posters || [];
      if (!posters.length) return res.status(404).json({ error: 'No season poster on TMDB' });

      const posterUrl = `https://image.tmdb.org/t/p/w500${posters[0].file_path}`;
      await downloadBinary(posterUrl, cachePath);
      return serveFile(res, cachePath);
    } catch (e) {
      return res.status(500).json({ error: 'Failed to fetch season poster' });
    }
  });

  // ── GET /api/library/item/:id/screenshot ──────────────────────────────────
  // Optional ?t=<seconds> (default: 60s into the file)

  router.get('/library/item/:id/screenshot', (req, res) => {
    if (!ffmpegStatic) return res.status(500).json({ error: 'ffmpeg not available' });

    const item = findById('movies', req.params.id) || findById('tvShows', req.params.id);
    if (!item || !item.filePath) return res.status(404).json({ error: 'Not found' });

    const offsetSecs = req.query.t ? parseFloat(req.query.t) : 60;

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=3600');

    const ff = spawn(ffmpegStatic, [
      '-ss', String(offsetSecs),
      '-i',  item.filePath,
      '-vframes', '1',
      '-q:v', '3',
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      'pipe:1',
    ]);

    ff.stdout.pipe(res);
    ff.stderr.on('data', () => {});   // suppress ffmpeg noise
    ff.on('error', () => {
      if (!res.headersSent) res.status(500).end();
    });
    req.on('close', () => ff.kill('SIGKILL'));
  });

  return router;
};

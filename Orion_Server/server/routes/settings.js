'use strict';
/**
 * Orion Settings Routes
 * /api/config, /api/settings, /api/themes, /api/hardware, /api/db/*, /api/ai/*
 */

const express = require('express');

module.exports = function settingsRoutes({ db, io, getConfig, getSettings, updateConfig, updateSettings, saveConfig, OrionDB, PATHS, detectHardwareAccel }) {
  const router = express.Router();

  // ── Config ──────────────────────────────────────────────────────────────────
  router.get('/config', (_, res) => {
    const config = getConfig();
    res.json({
      tmdbApiKey:     config.tmdbApiKey     || '',
      omdbApiKey:     config.omdbApiKey     || '',
      lastfmKey:      config.lastfmKey      || '',
      fanartKey:      config.fanartKey      || '',
      tvdbKey:        config.tvdbKey        || '',
      metadataSource: config.metadataSource || 'auto',
      youtubeApiKey:  config.youtubeApiKey  || '',
      homeLayout:     config.homeLayout     || null,
    });
  });

  router.put('/config', (req, res) => {
    const allowed = ['tmdbApiKey','omdbApiKey','lastfmKey','fanartKey','tvdbKey','metadataSource','youtubeApiKey','homeLayout'];
    const updates = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
    updateConfig(updates);
    res.json({ ok: true });
  });

  // ── Settings ─────────────────────────────────────────────────────────────────
  router.get('/settings', (_, res) => {
    const config = getConfig(), settings = getSettings();
    res.json({
      ...settings,
      tmdbApiKey:     config.tmdbApiKey     || '',
      omdbApiKey:     config.omdbApiKey     || '',
      lastfmKey:      config.lastfmKey      || '',
      fanartKey:      config.fanartKey      || '',
      youtubeApiKey:  config.youtubeApiKey  || '',
      metadataSource: config.metadataSource || settings.metadataSource || 'auto',
    });
  });

  router.put('/settings', (req, res) => {
    // Sync API keys into config
    const configKeys = ['tmdbApiKey','omdbApiKey','lastfmKey','fanartKey','tvdbKey','youtubeApiKey','metadataSource'];
    const configUpdates = {};
    configKeys.forEach(k => { if (req.body[k] !== undefined) configUpdates[k] = req.body[k]; });
    if (Object.keys(configUpdates).length) updateConfig(configUpdates);
    updateSettings(req.body);
    saveConfig(); // explicit flush — guarantees disk write regardless of which path was taken
    res.json(getSettings());
  });

  // ── Themes ───────────────────────────────────────────────────────────────────
  router.get('/themes', (_, res) => {
    try {
      const { themes: builtinThemes } = require('../themes');
      const custom = getConfig().customThemes || [];
      res.json([...Object.values(builtinThemes), ...custom]);
    } catch {
      res.json([]);
    }
  });

  router.put('/themes/custom', (req, res) => {
    const { themes: customThemes } = req.body;
    if (!Array.isArray(customThemes)) return res.status(400).json({ error: 'themes must be array' });
    updateConfig({ customThemes });
    res.json({ ok: true, count: customThemes.length });
  });

  // ── Hardware info ─────────────────────────────────────────────────────────────
  router.post('/hardware/detect', (_, res) => {
    // Force re-detection by clearing cache
    cachedEncoder = null;
    detectHardwareAccel().then(encoder => {
      const typeMap = {
        'h264_nvenc': 'NVIDIA NVENC (H.264)', 'h264_amf': 'AMD AMF (H.264)',
        'h264_qsv': 'Intel Quick Sync (H.264)', 'libx264': 'Software (H.264)',
      };
      res.json({ encoder, encoderName: typeMap[encoder] || encoder, detected: true });
    });
  });

  router.get('/hardware', (_, res) => {
    detectHardwareAccel().then(encoder => {
      const typeMap = {
        'h264_amf':           'AMD AMF (H.264)',
        'hevc_amf':           'AMD AMF (H.265/HEVC)',
        'h264_nvenc':         'NVIDIA NVENC (H.264)',
        'hevc_nvenc':         'NVIDIA NVENC (H.265/HEVC)',
        'h264_qsv':           'Intel Quick Sync (H.264)',
        'hevc_qsv':           'Intel Quick Sync (H.265/HEVC)',
        'h264_vaapi':         'VAAPI (H.264)',
        'hevc_vaapi':         'VAAPI (H.265/HEVC)',
        'h264_videotoolbox':  'Apple VideoToolbox (H.264)',
        'hevc_videotoolbox':  'Apple VideoToolbox (H.265/HEVC)',
        'libx264':            'Software (H.264)',
        'libx265':            'Software (H.265/HEVC)',
      };
      const isHardware = !!(encoder && encoder !== 'libx264' && encoder !== 'libx265');
      res.json({
        encoder,
        encoderName: typeMap[encoder] || encoder || 'Unknown',
        type:        typeMap[encoder] || encoder || 'Unknown',
        isHardware,
        platform:    process.platform,
        nodeVersion: process.version,
        arch:        process.arch,
      });
    }).catch(() => res.json({ encoder: 'libx264', encoderName: 'Software (H.264)' }));
  });

  // ── Database ops ──────────────────────────────────────────────────────────────
  router.post('/db/backup', (_, res) => {
    if (OrionDB.isConnected()) {
      const p = OrionDB.backup(PATHS.DATA_DIR);
      return res.json({ ok: !!p, path: p });
    }
    res.status(503).json({ ok: false, error: 'Database not connected' });
  });

  router.post('/db/optimize', (_, res) => {
    const beforeMovies = db.movies.length;
    const beforeTV     = db.tvShows.length;
    db.movies  = db.movies.filter(m => m.filePath);
    db.tvShows = db.tvShows.filter(m => m.filePath);
    const allIds = new Set([...db.movies.map(m => m.id), ...db.tvShows.map(m => m.id)]);
    db.collections.forEach(col => { col.mediaIds = (col.mediaIds || []).filter(id => allIds.has(id)); });
    if (OrionDB.isConnected()) OrionDB.saveAll(db);
    res.json({
      removedMovies: beforeMovies - db.movies.length,
      removedTV:     beforeTV     - db.tvShows.length,
      ok: true,
    });
  });

  // ── Local AI (Ollama) proxy ───────────────────────────────────────────────────
  router.get('/ai/status', async (req, res) => {
    const url = (req.query.url || 'http://localhost:11434').replace(/\/+$/, '').replace(/\/v1$/, '');
    try {
      const r = await fetch(`${url}/api/version`, { signal: AbortSignal.timeout(4000) });
      const d = await r.json();
      res.json({ ok: true, version: d.version || 'unknown', url });
    } catch (e) {
      res.json({ ok: false, error: e.message, url });
    }
  });

  router.get('/ai/models', async (req, res) => {
    const url = (req.query.url || 'http://localhost:11434').replace(/\/+$/, '').replace(/\/v1(\/.*)?$/, '');
    try {
      const r = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) return res.json({ ok: false, models: [], error: 'HTTP ' + r.status });
      const d = await r.json();
      const models = (d.models || []).map(m => ({ name: m.name, size: m.size, modified: m.modified_at, sizeGb: m.size ? (m.size / 1e9).toFixed(1) + ' GB' : '?' }));
      res.json({ ok: true, models, url });
    } catch (e) {
      res.json({ ok: false, models: [], error: e.message });
    }
  });

  router.post('/ai/pull', async (req, res) => {
    const { model, url: ollamaUrl = 'http://localhost:11434' } = req.body;
    if (!model) return res.status(400).json({ error: 'model required' });
    const base = ollamaUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Transfer-Encoding', 'chunked');
    try {
      const r = await fetch(`${base}/api/pull`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: model, stream: true }) });
      r.body.on('data', chunk => res.write(chunk));
      r.body.on('end', () => res.end());
      r.body.on('error', () => res.end());
    } catch (e) { res.end(JSON.stringify({ error: e.message })); }
  });

  router.get('/ai/search-models', async (req, res) => {
    const { q = '' } = req.query;
    try {
      const r = await fetch(`https://ollama.com/search?q=${encodeURIComponent(q)}&o=popular`, { headers: { 'Accept': 'application/json', 'User-Agent': 'Orion/1.0' }, signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        const ct = r.headers.get('content-type') || '';
        if (ct.includes('json')) {
          const d = await r.json();
          return res.json({ results: (d.models || d.results || []).map(m => ({ name: m.name, description: m.description || m.desc || '', size: '' })) });
        }
      }
      res.json({ results: [] });
    } catch { res.json({ results: [] }); }
  });

  router.delete('/ai/models/:name', async (req, res) => {
    const url = (req.query.url || 'http://localhost:11434').replace(/\/+$/, '').replace(/\/v1$/, '');
    try {
      await fetch(`${url}/api/delete`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: req.params.name }) });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/ai/test', async (req, res) => {
    const { url: ollamaUrl = 'http://localhost:11434', model = 'llama3.2' } = req.body;
    const base = ollamaUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
    try {
      const r = await fetch(`${base}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, prompt: 'Reply with exactly: OK', stream: false }), signal: AbortSignal.timeout(30000) });
      const d = await r.json();
      res.json({ ok: true, response: d.response?.trim() || '(no response)', model });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  return router;
};

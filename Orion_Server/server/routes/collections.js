'use strict';
/**
 * Orion Collections Routes
 * /api/collections/*, /api/overlays/*
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');

// Simple in-module cache
const _cache = new Map();
function getCached(key) { return _cache.get(key); }
function setCached(key, data) {
  const etag = `"${Date.now()}"`;
  _cache.set(key, { data, etag, ts: Date.now() });
  return etag;
}
function invalidateCache(prefix) {
  for (const k of _cache.keys()) if (k.startsWith(prefix)) _cache.delete(k);
}
// Evict old entries every 5min
setInterval(() => {
  if (_cache.size > 500) {
    const entries = [..._cache.entries()].sort((a,b) => a[1].ts - b[1].ts);
    for (const [k] of entries.slice(0, _cache.size - 500)) _cache.delete(k);
  }
}, 5 * 60 * 1000);

module.exports = function collectionsRoutes({ db, io, saveDB }) {
  const router = express.Router();

  // ── Collections CRUD ──────────────────────────────────────────────────────────
  router.get('/', (req, res) => {
    const { mediaType, slim } = req.query;
    let cols = db.collections || [];
    if (mediaType) cols = cols.filter(c => !c.mediaType || c.mediaType === mediaType || c.mediaType === 'mixed');

    if (slim === '1') {
      const epShowMap = {};
      (db.tvShows || []).forEach(ep => { if (ep.id) epShowMap[ep.id] = ep.seriesTitle || ep.showName || ep.title || ''; });
      cols = cols.map(c => {
        const ids = c.mediaIds || [];
        let showCount = null;
        if (c.mediaType === 'tvShows' || c.type === 'network' || c.type === 'streaming') {
          const uniqueShows = new Set(ids.map(id => epShowMap[id]).filter(Boolean));
          showCount = uniqueShows.size;
        }
        return { id: c.id, name: c.name, type: c.type, mediaType: c.mediaType, thumbnail: c.thumbnail, count: ids.length, showCount: showCount !== null ? showCount : ids.length, mediaIds: ids, sortBy: c.sortBy, description: c.description };
      });
    }

    const cacheKey = 'collections:' + (mediaType||'all') + ':' + (slim||'0');
    const cached = getCached(cacheKey);
    if (cached && req.headers['if-none-match'] === cached.etag) return res.status(304).end();
    const etag = setCached(cacheKey, { collections: cols });
    res.set('ETag', etag).set('Cache-Control', 'no-cache').json({ collections: cols });
  });

  router.post('/', (req, res) => {
    const { name, description, mediaIds, type, poster, sortBy } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const collection = {
      id: uuidv4(), name, description: description || '',
      mediaIds: mediaIds || [], type: type || 'manual',
      poster: poster || null, sortBy: sortBy || 'title',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    db.collections.push(collection);
    saveDB();
    invalidateCache('collections:');
    res.json(collection);
  });

  // Smart collections must come before /:id
  router.get('/smart', (req, res) => {
    const allMedia = [...db.movies, ...db.tvShows];
    const slim = (items) => items.slice(0, 50).map(m => ({ id: m.id, title: m.title, thumbnail: m.thumbnail, year: m.year, type: m.type, resumePct: m.resumePct }));
    const mostWatched    = [...allMedia].filter(m => m.watched || m.progress > 0).sort((a,b) => (b.progress||0) - (a.progress||0));
    const neverWatched   = allMedia.filter(m => !m.lastWatched && !m.watched).sort(() => Math.random() - 0.5);
    const inProgress     = allMedia.filter(m => { const p = m.resumePct||0; return p > 5 && p < 90; }).sort((a,b) => (b.lastWatched||'').localeCompare(a.lastWatched||''));
    const thirtyDaysAgo  = new Date(Date.now() - 30*24*60*60*1000).toISOString();
    const recentlyWatched = allMedia.filter(m => m.lastWatched && m.lastWatched > thirtyDaysAgo).sort((a,b) => b.lastWatched.localeCompare(a.lastWatched));
    res.json({ mostWatched: slim(mostWatched), neverWatched: slim(neverWatched), inProgress: slim(inProgress), recentlyWatched: slim(recentlyWatched) });
  });

  router.get('/smart/:userId', (req, res) => {
    const { userId } = req.params;
    const allMedia = [...db.movies, ...db.tvShows];
    const slim = (items) => items.slice(0, 50).map(m => ({ id: m.id, title: m.title, thumbnail: m.thumbnail, year: m.year, type: m.type, resumePct: m.resumePct }));
    const userHistory = (db.watchHistory || {})[userId] || {};
    const continueWatching = allMedia.filter(m => { const p = m.resumePct||0; return p > 5 && p < 90; }).sort((a,b) => (b.lastWatched||'').localeCompare(a.lastWatched||''));
    const watchedIds = new Set([
      ...allMedia.filter(m => m.watched || m.resumePct >= 90).map(m => m.id),
      ...Object.entries(userHistory).filter(([,e]) => (e.playCount||0) > 0).map(([id]) => id),
    ]);
    const neverWatched = allMedia.filter(m => !watchedIds.has(m.id) && !m.lastWatched).sort(() => Math.random() - 0.5);
    const genreCount = {};
    allMedia.filter(m => watchedIds.has(m.id)).forEach(m => { (m.genres||[]).forEach(g => { genreCount[g] = (genreCount[g]||0) + 1; }); });
    const topGenres = Object.entries(genreCount).sort((a,b) => b[1]-a[1]).slice(0,3).map(([g]) => g);
    const recommended = allMedia.filter(m => !watchedIds.has(m.id) && (m.genres||[]).some(g => topGenres.includes(g))).sort((a,b) => (b.rating||0)-(a.rating||0));
    res.json({ continueWatching: slim(continueWatching), neverWatched: slim(neverWatched), recommended: slim(recommended), topGenres, watchedCount: watchedIds.size });
  });

  router.get('/for-user/:userId', (req, res) => {
    const user = db.users.find(u => u.id === req.params.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const profile = user.collectionProfile || {};
    const hide = new Set(profile.hideCollectionTypes || []);
    let collections = db.collections.filter(col => {
      if (hide.has(col.type)) return false;
      if (col.type === 'auto-genre'  && profile.showGenreCollections    === false) return false;
      if (col.type === 'auto-decade' && profile.showDecadeCollections   === false) return false;
      if (col.type === 'franchise'   && profile.showFranchiseCollections === false) return false;
      if (col.type === 'network'     && profile.showNetworkCollections   === false) return false;
      if (col.type === 'holiday'     && profile.showHolidayCollections   === false) return false;
      return true;
    });
    if (profile.preferredGenres?.length > 0) {
      collections = [
        ...collections.filter(c => profile.preferredGenres.includes(c.name)),
        ...collections.filter(c => !profile.preferredGenres.includes(c.name)),
      ];
    }
    res.json(collections);
  });

  router.get('/:id', (req, res) => {
    const col = db.collections.find(c => c.id === req.params.id);
    if (!col) return res.status(404).json({ error: 'Not found' });
    const allMedia = [...db.movies, ...db.tvShows, ...db.music, ...db.musicVideos];
    const items = col.mediaIds.map(id => allMedia.find(m => m.id === id)).filter(Boolean);
    res.json({ ...col, items });
  });

  router.put('/:id', (req, res) => {
    const idx = db.collections.findIndex(c => c.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    db.collections[idx] = { ...db.collections[idx], ...req.body, updatedAt: new Date().toISOString() };
    saveDB();
    invalidateCache('collections:');
    res.json(db.collections[idx]);
  });

  router.delete('/:id', (req, res) => {
    db.collections = db.collections.filter(c => c.id !== req.params.id);
    saveDB();
    invalidateCache('collections:');
    res.json({ ok: true });
  });

  router.post('/:id/items', (req, res) => {
    const { mediaId } = req.body;
    const col = db.collections.find(c => c.id === req.params.id);
    if (!col) return res.status(404).json({ error: 'Not found' });
    if (!col.mediaIds.includes(mediaId)) { col.mediaIds.push(mediaId); saveDB(); }
    invalidateCache('collections:');
    res.json({ ok: true, count: col.mediaIds.length });
  });

  router.delete('/:id/items/:mediaId', (req, res) => {
    const col = db.collections.find(c => c.id === req.params.id);
    if (!col) return res.status(404).json({ error: 'Not found' });
    col.mediaIds = col.mediaIds.filter(id => id !== req.params.mediaId);
    saveDB();
    invalidateCache('collections:');
    res.json({ ok: true });
  });

  return router;
};

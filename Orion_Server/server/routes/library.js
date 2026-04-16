'use strict';
/**
 * Orion Library Routes
 * /api/library/*
 * 
 * Handles: browsing, details, versions, deletion, metadata reset,
 * deduplication, folder cleanup, TV show grouping, scan paths
 */

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const { v4: uuidv4 } = require('uuid');

const RATING_ORDER = ['G','TV-G','TV-Y','TV-Y7','PG','TV-PG','PG-13','TV-14','R','TV-MA','NC-17','NR','UNRATED'];
function getRatingRank(r) { const i = RATING_ORDER.indexOf((r||'').toUpperCase().trim()); return i === -1 ? 99 : i; }
function isAllowedRating(contentRating, maxRating) {
  if (!maxRating) return true;
  return getRatingRank(contentRating) <= getRatingRank(maxRating);
}

const CARD_FIELDS = ['id','title','year','thumbnail','backdrop','rating','ext','size',
  'genres','resolution','hdr','audioCodec','videoCodec','contentRating','watchProviders',
  'type','filePath','fileName','season','episode','seriesTitle','showName','network','runtime',
  'artist','album','addedAt','overview','cast','director','studios','networks',
  'tvStatus','tmdbId','versions','resumePct','watched','lastWatched'];

// Strip quality/encoding suffixes from folder names so "American Dad S04 1080p WEBRip x265" → "American Dad"
const QUALITY_STRIP_RE = /[\s.]+(?:(?:S\d{1,2}[\s.]+)?(?:\d{3,4}[pi]\b|UHD|SDR|HDR(?:10\+?)?|REMUX|PROPER|REPACK|EXTENDED|UNRATED|REMASTERED|DC)[\s\S]*|(?:WEB(?:Rip|DL|-DL)|BluRay|BDRip|DVDRip|HDTV|HDRip|AMZN|DSNP|NF|HMAX|MAX|ATVP|PCOK|iT)[\s\S]*)$/i;
function normalizeShowName(name) {
  if (!name) return name;
  const n = name.replace(QUALITY_STRIP_RE, '').trim();
  return n || name; // never return empty
}
const _cache = new Map();
function getCached(key) { return _cache.get(key); }
function setCached(key, data) { const etag = `"${Date.now()}"`; _cache.set(key, { data, etag, ts: Date.now() }); return etag; }
function invalidateCache(prefix) { for (const k of _cache.keys()) if (k.startsWith(prefix)) _cache.delete(k); }
setInterval(() => { if (_cache.size > 500) { const entries = [..._cache.entries()].sort((a,b) => a[1].ts - b[1].ts); for (const [k] of entries.slice(0, _cache.size - 500)) _cache.delete(k); } }, 5 * 60 * 1000);

// Grouped shows cache
let _groupedShowsCache = null;
let _groupedShowsDirty = true;
function invalidateGroupedCache() { _groupedShowsDirty = true; _groupedShowsCache = null; invalidateCache('grouped:'); }

module.exports = function libraryRoutes({ db, io, saveDB, rebuildIndex, OrionDB, _detailCache, _versionsMap, _trailerOverrides, metadataQueue, queueMetadata }) {
  const router = express.Router();

  // ── GET /api/library/tvShows/grouped ─────────────────────────────────────────
  router.get('/tvShows/grouped', (req, res) => {
    const { page, limit, search, userId } = req.query;
    let maxRating = null;
    if (userId) { const user = db.users.find(u => u.id === userId); if (user?.maxRating) maxRating = user.maxRating; }

    if (_groupedShowsDirty || !_groupedShowsCache) {
      const episodes = db.tvShows || [];
      const getSeasonNum = (ep) => {
        if (ep.seasonNum) return ep.seasonNum;
        if (!ep.filePath) return 1;
        const parts = ep.filePath.replace(/\\/g, '/').split('/');
        const parent = parts.length >= 2 ? parts[parts.length - 2] : '';
        const m = parent.match(/^[Ss]eason\s*(\d{1,3})$/) || parent.match(/^[Ss](\d{1,3})$/);
        if (m) return parseInt(m[1]);
        const fm = ep.filePath.replace(/\\/g, '/').match(/[Ss](\d{1,3})[Ee]\d/);
        return fm ? parseInt(fm[1]) : 1;
      };

      const showMap = {};
      for (const ep of episodes) {
        let rawName = ep.seriesTitle || ep.showName || null;
        if (!rawName && ep.filePath) {
          try {
            const parts = ep.filePath.replace(/\\/g, '/').split('/');
            for (let i = parts.length - 3; i >= 0; i--) {
              const part = parts[i];
              if (part && !/^S\d+$/i.test(part) && !/Season/i.test(part)) {
                rawName = part.replace(/[._]/g, ' ').replace(/\s*\(?(19|20)\d{2}\)?\s*$/, '').replace(/\s+/g, ' ').trim();
                break;
              }
            }
          } catch {}
        }
        if (!rawName) rawName = ep.title || 'Unknown Show';

        // Normalize away quality tags so "American Dad S04 1080p WEBRip..." groups with "American Dad"
        const showName = normalizeShowName(rawName);

        if (!showMap[showName]) {
          showMap[showName] = {
            id: 'show_' + showName.replace(/[^a-zA-Z0-9]/g, '_'),
            showName, title: showName, type: 'tvShows',
            thumbnail: null, backdrop: null, overview: null,
            rating: null, year: null, genres: ep.genres || [],
            network: ep.network || null, episodeCount: 0,
            seasonMap: {}, addedAt: ep.addedAt || null,
            contentRating: ep.contentRating || null,
          };
        }
        const s = showMap[showName];
        s.episodeCount++;
        const sNum = getSeasonNum(ep);
        if (!s.seasonMap[sNum]) s.seasonMap[sNum] = { num: sNum, episodeCount: 0, thumbnail: null };
        s.seasonMap[sNum].episodeCount++;
        if (!s.seasonMap[sNum].thumbnail && ep.thumbnail) s.seasonMap[sNum].thumbnail = ep.thumbnail;
        if (!s.thumbnail && ep.thumbnail) {
          let thumb = ep.thumbnail;
          if (thumb && !thumb.startsWith('http') && !thumb.startsWith('/api/')) thumb = `/api/localimage?path=${encodeURIComponent(thumb)}`;
          s.thumbnail = thumb;
          s.backdrop = ep.backdrop;
        }
        if (!s.overview && ep.overview) s.overview = ep.overview;
        if (!s.year && ep.year) s.year = ep.year;
        if (!s.network && ep.network) s.network = ep.network;
        if (!s.contentRating && ep.contentRating) s.contentRating = ep.contentRating;
        if (!s.genres?.length && ep.genres?.length) s.genres = ep.genres;
        if (ep.rating && parseFloat(ep.rating) > parseFloat(s.rating || 0)) s.rating = ep.rating;
        if (ep.addedAt && (!s.addedAt || ep.addedAt > s.addedAt)) s.addedAt = ep.addedAt;
        if (_trailerOverrides?.[showName]) s.trailerOverride = _trailerOverrides[showName];
        if (ep.tmdbId) {
          if (!s._tmdbIdCounts) s._tmdbIdCounts = {};
          s._tmdbIdCounts[ep.tmdbId] = (s._tmdbIdCounts[ep.tmdbId] || 0) + 1;
        }
      }

      Object.values(showMap).forEach(s => {
        s.seasons = Object.values(s.seasonMap).sort((a,b) => a.num - b.num);
        delete s.seasonMap;
        if (s._tmdbIdCounts) {
          const best = Object.entries(s._tmdbIdCounts).sort((a,b) => b[1]-a[1])[0]?.[0];
          s.tmdbId = best ? parseInt(best) : null;
          delete s._tmdbIdCounts;
        }
      });

      // ── Merge shows that share the same TMDB ID ────────────────────────────
      // Handles cases where the same show exists in multiple differently-named
      // folders (e.g. "Adventures of the Gummi Bears" vs "Disney's Adventures...").
      const tmdbMergeMap = {};  // tmdbId → canonical show entry
      const mergedOut    = new Set();
      for (const s of Object.values(showMap)) {
        if (!s.tmdbId) continue;
        const key = s.tmdbId;
        if (!tmdbMergeMap[key]) {
          tmdbMergeMap[key] = s;
        } else {
          const canonical = tmdbMergeMap[key];
          // Merge seasons — combine seasonMaps by season number, keeping higher episode count
          for (const season of s.seasons) {
            const existing = canonical.seasons.find(cs => cs.num === season.num);
            if (!existing) {
              canonical.seasons.push(season);
            } else {
              existing.episodeCount += season.episodeCount;
              if (!existing.thumbnail && season.thumbnail) existing.thumbnail = season.thumbnail;
            }
          }
          canonical.seasons.sort((a,b) => a.num - b.num);
          canonical.episodeCount += s.episodeCount;
          // Prefer the entry with better metadata (poster, backdrop, overview)
          if (!canonical.thumbnail && s.thumbnail) canonical.thumbnail = s.thumbnail;
          if (!canonical.backdrop  && s.backdrop)  canonical.backdrop  = s.backdrop;
          if (!canonical.overview  && s.overview)  canonical.overview  = s.overview;
          if (!canonical.rating    && s.rating)    canonical.rating    = s.rating;
          if (!canonical.year      && s.year)      canonical.year      = s.year;
          if (s.addedAt && (!canonical.addedAt || s.addedAt > canonical.addedAt)) canonical.addedAt = s.addedAt;
          // Prefer the name that has a poster (has metadata) or is shorter/cleaner
          if (s.thumbnail && (!canonical.thumbnail || s.showName.length < canonical.showName.length)) {
            canonical.showName = s.showName;
            canonical.title    = s.showName;
          }
          // Track all folder names this merged show covers for byShow lookups
          if (!canonical._altNames) canonical._altNames = [];
          canonical._altNames.push(s.showName);
          mergedOut.add(s.showName);
        }
      }
      // Remove shows that were merged into a canonical entry
      for (const name of mergedOut) delete showMap[name];

      // ── Secondary: fuzzy name merge for shows without matching TMDB IDs ──
      // Strips articles/punctuation and checks if one name is contained in another.
      // e.g. "Adventures of the Gummi Bears" ≈ "Disney's Adventures of the Gummi Bears"
      //      "Alvin and the Chipmunks" ≈ "Alvin!!!! And The Chipmunks"
      const strip = s => s.toLowerCase().replace(/^(a|an|the|disney'?s?)\s+/i, '').replace(/[^a-z0-9]/g, '');
      const remaining = Object.values(showMap);
      const fuzzyMerged = new Set();
      for (let i = 0; i < remaining.length; i++) {
        if (fuzzyMerged.has(remaining[i].showName)) continue;
        const a = strip(remaining[i].showName);
        for (let j = i + 1; j < remaining.length; j++) {
          if (fuzzyMerged.has(remaining[j].showName)) continue;
          const b = strip(remaining[j].showName);
          // Determine if these two shows should be merged
          let shouldMerge = false;
          if (a === b) {
            shouldMerge = true; // identical after stripping articles/punctuation
          }
          // Substring check intentionally removed — too many false positives with
          // year-disambiguated shows (e.g. "Avatar" matching "Avatar (2025)")
          if (!shouldMerge) continue;
          // Keep the one with a poster; absorb the other
          const [keep, absorb] = remaining[i].thumbnail ? [remaining[i], remaining[j]] : [remaining[j], remaining[i]];
          for (const season of absorb.seasons) {
            const existing = keep.seasons.find(cs => cs.num === season.num);
            if (!existing) keep.seasons.push(season);
            else { existing.episodeCount += season.episodeCount; if (!existing.thumbnail && season.thumbnail) existing.thumbnail = season.thumbnail; }
          }
          keep.seasons.sort((a,b) => a.num - b.num);
          keep.episodeCount += absorb.episodeCount;
          if (!keep.thumbnail && absorb.thumbnail) keep.thumbnail = absorb.thumbnail;
          if (!keep.backdrop  && absorb.backdrop)  keep.backdrop  = absorb.backdrop;
          if (!keep.overview  && absorb.overview)  keep.overview  = absorb.overview;
          if (!keep.tmdbId    && absorb.tmdbId)    keep.tmdbId    = absorb.tmdbId;
          if (!keep._altNames) keep._altNames = [];
          keep._altNames.push(absorb.showName);
          if (absorb._altNames) keep._altNames.push(...absorb._altNames);
          fuzzyMerged.add(absorb.showName);
        }
      }
      for (const name of fuzzyMerged) delete showMap[name];

      _groupedShowsCache = Object.values(showMap).sort((a,b) => a.showName.localeCompare(b.showName));
      _groupedShowsDirty = false;
      console.log(`[Cache] Grouped shows built: ${_groupedShowsCache.length} shows (${mergedOut.size} merged by TMDB ID)`);
    }

    let shows = _groupedShowsCache;
    if (maxRating) shows = shows.filter(s => isAllowedRating(s.contentRating, maxRating));
    if (search) { const q = search.toLowerCase(); shows = shows.filter(s => s.showName.toLowerCase().includes(q)); }

    const total = shows.length;
    if (page !== undefined && limit !== undefined) {
      const p = parseInt(page)||0, l = Math.min(parseInt(limit)||200, 500);
      shows = shows.slice(p*l, (p+1)*l);
    }

    const cacheKey = `grouped:${search||''}:${page||0}:${limit||0}`;
    const cached = getCached(cacheKey);
    if (cached && req.headers['if-none-match'] === cached.etag) return res.status(304).end();
    const totalEpisodes = (_groupedShowsCache || []).reduce((s, sh) => s + (sh.episodeCount || 0), 0);
    const etag = setCached(cacheKey, { items: shows, total, totalEpisodes });
    res.set('ETag', etag).set('Cache-Control', 'no-cache').json({ items: shows, total, totalEpisodes });
  });

  // ── GET /api/library/:type ────────────────────────────────────────────────────
  router.get('/:type', (req, res) => {
    const { type } = req.params;
    const { page, limit, fields, search, userId } = req.query;
    const raw = db[type] || [];

    let maxRating = null;
    if (userId) { const user = db.users.find(u => u.id === userId); if (user?.maxRating) maxRating = user.maxRating; }

    let items = raw;
    if (maxRating) items = items.filter(i => isAllowedRating(i.contentRating, maxRating));
    if (search) {
      const q = search.toLowerCase();
      items = items.filter(i => (i.title||'').toLowerCase().includes(q) || (i.seriesTitle||'').toLowerCase().includes(q) || (i.showName||'').toLowerCase().includes(q));
    }

    const total = items.length;
    if (page !== undefined && limit !== undefined) {
      const p = parseInt(page)||0, l = Math.min(parseInt(limit)||200, 500);
      items = items.slice(p*l, (p+1)*l);
    }

    if (fields !== 'all') {
      const keep = new Set(CARD_FIELDS);
      items = items.map(item => { const out = {}; for (const k of keep) if (item[k] !== undefined) out[k] = item[k]; return out; });
    }

    const cacheKey = `library:${type}:${search||''}:${page||0}:${limit||0}:${fields||''}`;
    const cached = getCached(cacheKey);
    if (cached && req.headers['if-none-match'] === cached.etag) return res.status(304).end();
    const etag = setCached(cacheKey, { items, total });
    res.set('ETag', etag).set('Cache-Control', 'no-cache').set('X-Total-Count', String(total)).json({ items, total });
  });

  // ── GET detail ────────────────────────────────────────────────────────────────
  router.get('/:type/:id/detail', (req, res) => {
    const { type, id } = req.params;
    if (!db[type]) return res.status(404).json({ error: 'Unknown type' });
    const item = db[type].find(i => i.id === id);
    if (!item) return res.status(404).json({ error: 'Not found' });

    const memCached = _detailCache?.get(id);
    if (memCached) return res.json({ ...item, ...memCached });

    const stored = OrionDB.getDetail(id);
    if (stored) { _detailCache?.set(id, stored); return res.json({ ...item, ...stored }); }

    if (OrionDB.isConnected()) {
      try {
        const row = OrionDB._db().prepare(`SELECT value FROM kv_arrays WHERE key=?`).get(type);
        if (row?.value) {
          const full = JSON.parse(row.value).find(i => i.id === id);
          if (full) {
            const HEAVY = ['overview','cast','backdrop','director','studios','watchProviders','tmdbCollection','collection','chapters','customChapters','networks','extras'];
            const heavy = {};
            for (const f of HEAVY) if (full[f] !== undefined) heavy[f] = full[f];
            if (Object.keys(heavy).length) { _detailCache?.set(id, heavy); OrionDB.setDetail(id, heavy); }
            return res.json(full);
          }
        }
      } catch (e) { console.error('[Detail] SQLite read error:', e.message); }
    }
    res.json(item);
  });

  // ── GET versions ──────────────────────────────────────────────────────────────
  router.get('/:type/:id/versions', (req, res) => {
    const { type, id } = req.params;
    const item = db[type]?.find(i => i.id === id);
    if (!item) return res.status(404).json({ error: 'Not found' });
    const versions = _versionsMap?.get(id) || item.versions || [{ filePath: item.filePath, fileName: item.fileName, size: item.size }];
    res.json({ versions });
  });

  router.put('/:type/:id/version', (req, res) => {
    const { type, id } = req.params;
    const item = db[type]?.find(i => i.id === id);
    if (!item) return res.status(404).json({ error: 'Not found' });
    const version = (item.versions||[]).find(v => v.filePath === req.body.filePath);
    if (!version) return res.status(404).json({ error: 'Version not found' });
    item.filePath = version.filePath; item.fileName = version.fileName; item.size = version.size;
    saveDB();
    res.json({ ok: true });
  });

  // ── Library paths ─────────────────────────────────────────────────────────────
  router.get('/paths/:type', (req, res) => {
    const paths = db.libraryPaths?.[req.params.type] || [];
    res.json({ paths });
  });

  // ── DELETE endpoints ──────────────────────────────────────────────────────────
  router.delete('/:type/all', (req, res) => {
    const { type } = req.params;
    if (!db[type]) return res.status(404).json({ error: 'Unknown type' });
    const count = db[type].length;
    db[type] = [];
    db.libraryPaths[type] = [];
    saveDB(true);
    invalidateCache('library:');
    invalidateGroupedCache();
    io.emit('library:updated', { type, count: 0 });
    res.json({ ok: true, removed: count });
  });

  router.delete('/:type/folder', (req, res) => {
    const { type } = req.params;
    const { folderPath } = req.body;
    if (!db.libraryPaths[type]) return res.status(404).json({ error: 'Unknown type' });
    db.libraryPaths[type] = db.libraryPaths[type].filter(p => p !== folderPath);
    const norm = p => p.replace(/[\\/]+/g, '/').toLowerCase().replace(/\/+$/, '');
    const before = (db[type]||[]).length;
    db[type] = (db[type]||[]).filter(item => !item.filePath || !norm(item.filePath).startsWith(norm(folderPath)));
    const removed = before - db[type].length;
    console.log(`[Library] Removed "${folderPath}" — ${removed} items deleted`);
    saveDB(true);
    invalidateCache('library:');
    invalidateGroupedCache();
    io.emit('library:updated', { type, count: db[type].length });
    res.json({ ok: true, removed });
  });

  router.delete('/tvShows/show/:showName', (req, res) => {
    const showName = decodeURIComponent(req.params.showName);
    const episodes = db.tvShows.filter(ep => (ep.seriesTitle || ep.showName || '') === showName);
    let filesDeleted = 0, filesFailed = 0;
    const dirs = new Set();
    for (const ep of episodes) {
      if (!ep.filePath) continue;
      try { fs.unlinkSync(ep.filePath); filesDeleted++; dirs.add(path.dirname(ep.filePath)); }
      catch(e) { filesFailed++; console.warn(`[Library] Could not delete: ${ep.filePath} — ${e.message}`); }
    }
    for (const dir of dirs) {
      try { if (fs.readdirSync(dir).filter(f=>!f.startsWith('.')).length === 0) { fs.rmdirSync(dir); } } catch {}
    }
    const before = db.tvShows.length;
    db.tvShows = db.tvShows.filter(ep => (ep.seriesTitle || ep.showName || '') !== showName);
    saveDB();
    invalidateGroupedCache();
    res.json({ ok: true, removed: before - db.tvShows.length, filesDeleted, filesFailed });
  });

  router.delete('/:type/:id', (req, res) => {
    const { type, id } = req.params;
    if (!db[type]) return res.status(404).json({ error: 'Not found' });
    const item = db[type].find(i => i.id === id);
    if (item?.filePath) {
      try {
        fs.unlinkSync(item.filePath);
        const dir = path.dirname(item.filePath);
        if (fs.readdirSync(dir).filter(f=>!f.startsWith('.')).length === 0) fs.rmdirSync(dir);
      } catch(e) { console.warn(`[Library] Could not delete file: ${e.message}`); }
    }
    db[type] = db[type].filter(i => i.id !== id);
    saveDB();
    res.json({ ok: true });
  });

  // ── Metadata reset ────────────────────────────────────────────────────────────
  router.post('/:type/metadata/reset', (req, res) => {
    const { type } = req.params;
    if (!db[type]) return res.status(404).json({ error: 'Not found' });
    db[type] = db[type].map(i => ({ ...i, metadataFetched: false, thumbnail: null, backdrop: null, overview: null, rating: null, tmdbId: null }));
    rebuildIndex(type);
    saveDB(true);
    if (metadataQueue && queueMetadata) { metadataQueue = metadataQueue.filter(e => e.type !== type); queueMetadata(db[type], type); }
    res.json({ ok: true, queued: db[type].length });
  });

  router.post('/metadata/reset-all', (req, res) => {
    const types = ['movies','tvShows','music','musicVideos'];
    let total = 0;
    for (const type of types) {
      if (db[type]?.length) {
        db[type] = db[type].map(i => ({ ...i, metadataFetched: false, thumbnail: null, backdrop: null, overview: null, rating: null, tmdbId: null }));
        if (queueMetadata) queueMetadata(db[type], type);
        total += db[type].length;
      }
    }
    saveDB();
    res.json({ ok: true, queued: total });
  });

  // ── findOrphans ───────────────────────────────────────────────────────────────
  router.post('/findOrphans', async (req, res) => {
    const { folders } = req.body;
    if (!folders?.length) return res.status(400).json({ error: 'folders required' });
    const dbPaths = new Set(db.movies.map(m => m.filePath?.toLowerCase()));
    const orphans = [];
    const VIDEO_EXTS = ['.mp4','.mkv','.avi','.mov','.wmv','.flv','.m4v','.ts','.m2ts','.webm','.3gp','.mpg','.mpeg'];
    for (const folder of folders) {
      try {
        const walk = (dir) => {
          if (!fs.existsSync(dir)) return;
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (VIDEO_EXTS.includes(path.extname(entry.name).toLowerCase()) && !dbPaths.has(full.toLowerCase())) orphans.push(full);
          }
        };
        walk(folder);
      } catch(e) { console.error('[Orphans] Error scanning:', e.message); }
    }
    res.json({ orphans, count: orphans.length });
  });

  // ── TV show byShow ────────────────────────────────────────────────────────────
  router.get('/tvShows/byShow/:showName', (req, res) => {
    const showName  = decodeURIComponent(req.params.showName);
    const seasonNum = req.query.season ? parseInt(req.query.season) : null;
    const norm      = p => (p || '').replace(/\\/g, '/');
    const clean     = n => n.toLowerCase().replace(/[^a-z0-9]/g, '');

    const getShowRoot = (filePath) => {
      const parts = norm(filePath).split('/');
      const dirs  = parts.slice(0, -1);
      const last  = dirs[dirs.length - 1] || '';
      return /season|series|disc|^s\d+/i.test(last) ? dirs.slice(0, -1).join('/') : dirs.join('/');
    };
    const getShowFolder = (filePath) => {
      const root = getShowRoot(filePath);
      const parts = root.split('/');
      return parts[parts.length - 1] || '';
    };

    // Match by NAS folder name — immune to corrupt seriesTitle metadata
    // Also try normalized name so quality-tagged folders ("Show S04 1080p...") match the base show name
    // Also check _altNames from TMDB-merged shows so all folders of a merged show are included
    const cleanShow = clean(showName);
    const cleanShowNorm = clean(normalizeShowName(showName));
    // Collect all name variants for this show (including TMDB-merged alt names)
    const mergedShow = _groupedShowsCache?.find(s => clean(s.showName) === cleanShow || clean(normalizeShowName(s.showName)) === cleanShowNorm);
    const altNames = new Set([cleanShow, cleanShowNorm]);
    if (mergedShow?._altNames) mergedShow._altNames.forEach(n => { altNames.add(clean(n)); altNames.add(clean(normalizeShowName(n))); });

    const folderMatched = db.tvShows.filter(ep => {
      if (!ep.filePath) return false;
      const folderRaw = getShowFolder(ep.filePath);
      const fc = clean(folderRaw);
      const fcn = clean(normalizeShowName(folderRaw));
      return altNames.has(fc) || altNames.has(fcn);
    });

    console.log('[byShow] "' + showName + '" season=' + seasonNum + ' folderMatched=' + folderMatched.length);

    let episodes;
    if (folderMatched.length > 0) {
      // Majority vote on show root — robust against stray files
      const rootCounts = {};
      for (const ep of folderMatched) {
        const r = getShowRoot(ep.filePath);
        rootCounts[r] = (rootCounts[r] || 0) + 1;
      }
      const showRoot = Object.entries(rootCounts).sort((a, b) => b[1] - a[1])[0][0];
      const allUnderRoot = db.tvShows.filter(ep => ep.filePath && norm(ep.filePath).startsWith(showRoot + '/'));
      console.log('[byShow] showRoot="' + showRoot + '" total=' + allUnderRoot.length);
      episodes = allUnderRoot;
    } else {
      // Fallback: exact metadata match
      episodes = db.tvShows.filter(ep => (ep.seriesTitle || ep.showName || '') === showName);
    }

    if (seasonNum !== null) {
      episodes = episodes.filter(ep => {
        const sn = ep.seasonNum || (() => {
          const fp     = norm(ep.filePath || '');
          const parent = fp.split('/').slice(-2)[0] || '';
          const m = parent.match(/^[Ss]eason\s*(\d{1,3})$/) || parent.match(/^[Ss](\d{1,3})$/);
          if (m) return parseInt(m[1]);
          const fm = fp.match(/[Ss](\d{1,3})[Ee]\d/);
          return fm ? parseInt(fm[1]) : 1;
        })();
        return sn === seasonNum;
      });
    }

    res.json({ items: episodes });
  });

  // ── POST /api/library/tvShows/refreshShow ─────────────────────────────────
  router.post('/tvShows/refreshShow', (req, res) => {
    const { showName, tmdbId } = req.body || {};
    if (!showName) return res.status(400).json({ error: 'showName required' });
    const episodes = db.tvShows.filter(ep => (ep.seriesTitle || ep.showName) === showName);
    if (!episodes.length) return res.status(404).json({ error: 'Show not found' });
    episodes.forEach(ep => {
      ep.metadataFetched = false;
      if (tmdbId) ep.tmdbId = String(tmdbId);
    });
    queueMetadata([episodes[0]], 'tvShows');
    saveDB(false);
    res.json({ ok: true, showName, episodes: episodes.length, queued: 1 });
  });

  // ── POST /api/library/tvShows/scanFolder ──────────────────────────────────
  router.post('/tvShows/scanFolder', async (req, res) => {
    const { showName, folderPath: explicitPath } = req.body || {};
    if (!showName && !explicitPath) return res.status(400).json({ error: 'showName or folderPath required' });

    let folderPath = explicitPath;
    if (!folderPath && showName) {
      const ep = db.tvShows.find(e => (e.seriesTitle || e.showName) === showName && e.filePath);
      if (!ep) return res.status(404).json({ error: 'Show not found in library' });
      const d = path.dirname(ep.filePath);
      folderPath = /season|series|disc|^s\d+/i.test(path.basename(d)) ? path.dirname(d) : d;
    }

    try {
      const { scanDirectory } = require('../services/scanner');
      const found = await scanDirectory(folderPath, 'tvShows', { onProgress: msg => io.emit('scan:progress', { status: typeof msg === 'string' ? msg : String(msg?.status || msg || '') }) });
      const existingPaths = new Set(db.tvShows.map(ep => ep.filePath));
      const TRAILER_PAT = /^trailer-[A-Za-z0-9_-]+\.(mp4|mkv|avi)$/i;
      const added = found.filter(item =>
        !existingPaths.has(item.filePath) &&
        !TRAILER_PAT.test(path.basename(item.filePath || ''))
      );
      if (added.length) {
        db.tvShows.push(...added);
        rebuildIndex('tvShows');
        invalidateGroupedCache();
        saveDB(true, 'tvShows');
      }
      // Emit library:updated instead of scan:complete so AppContext debounces the reload
      io.emit('library:updated', { type: 'tvShows', count: db.tvShows.length });
      res.json({ ok: true, added: added.length, total: db.tvShows.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── POST /api/library/tvShows/deleteShow ──────────────────────────────────
  router.post('/tvShows/deleteShow', (req, res) => {
    const { showName } = req.body || {};
    if (!showName) return res.status(400).json({ error: 'showName required' });
    const before = db.tvShows.length;
    db.tvShows = db.tvShows.filter(ep => (ep.seriesTitle || ep.showName) !== showName);
    rebuildIndex('tvShows');
    saveDB(true, 'tvShows');
    invalidateGroupedCache();
    res.json({ ok: true, showName, removed: before - db.tvShows.length });
  });

  // ── POST /api/library/tvShows/cleanup-trailers ───────────────────────────
  // Removes any db.tvShows entry whose filename matches the trailer pattern.
  router.post('/tvShows/cleanup-trailers', (req, res) => {
    const TRAILER_PAT = /^trailer-[A-Za-z0-9_-]+\.(mp4|mkv|avi)$/i;
    const before = db.tvShows.length;
    db.tvShows = db.tvShows.filter(ep => !TRAILER_PAT.test(path.basename(ep.filePath || '')));
    const removed = before - db.tvShows.length;
    if (removed > 0) { rebuildIndex('tvShows'); invalidateGroupedCache(); saveDB(true, 'tvShows'); }
    res.json({ ok: true, removed });
  });

  // ── POST /api/library/tvShows/fix-seriestitle ─────────────────────────────
  // For every episode where seriesTitle doesn't match the NAS folder name,
  // corrects seriesTitle (and showName) to the normalized folder name.
  // Uses normalizeShowName so quality-tagged folders ("Show S04 1080p WEBRip...")
  // are written as their base name ("Show"), preventing a conflict with fix-quality-folders.
  router.post('/tvShows/fix-seriestitle', (req, res) => {
    const norm  = p => (p || '').replace(/\\/g, '/');
    const clean = n => n.toLowerCase().replace(/[^a-z0-9]/g, '');

    const getShowFolder = (filePath) => {
      const parts = norm(filePath).split('/');
      const dirs  = parts.slice(0, -1);
      const last  = dirs[dirs.length - 1] || '';
      const showDirs = /season|series|disc|^s\d+/i.test(last) ? dirs.slice(0, -1) : dirs;
      return showDirs[showDirs.length - 1] || '';
    };

    let fixed = 0;
    for (const ep of db.tvShows) {
      if (!ep.filePath) continue;
      const folder = getShowFolder(ep.filePath);
      if (!folder) continue;
      // Normalize the folder name — strips quality tags so the two endpoints don't conflict
      const target = normalizeShowName(folder);
      const current = ep.seriesTitle || ep.showName || '';
      if (clean(current) !== clean(target)) {
        ep.seriesTitle = target;
        ep.showName    = target;
        if (clean(ep.title || '') !== clean(target)) ep.title = target;
        fixed++;
      }
    }

    if (fixed > 0) {
      invalidateGroupedCache();
      saveDB(true, 'tvShows');
    }

    res.json({ ok: true, fixed, total: db.tvShows.length });
  });

  // ── POST /api/library/tvShows/fix-quality-folders ────────────────────────
  // Finds episodes stored in quality-tagged folders (e.g. "Show S04 1080p WEBRip...")
  // and corrects their seriesTitle/showName to the normalized base show name.
  router.post('/tvShows/fix-quality-folders', (req, res) => {
    const norm  = p => (p || '').replace(/\\/g, '/');
    const getShowFolder = (filePath) => {
      const parts = norm(filePath).split('/');
      const dirs  = parts.slice(0, -1);
      const last  = dirs[dirs.length - 1] || '';
      const showDirs = /season|series|disc|^s\d+/i.test(last) ? dirs.slice(0, -1) : dirs;
      return showDirs[showDirs.length - 1] || '';
    };

    let fixed = 0;
    for (const ep of db.tvShows) {
      if (!ep.filePath) continue;
      const folder = getShowFolder(ep.filePath);
      if (!folder) continue;
      const normalized = normalizeShowName(folder);
      // Only update if the folder name differs from its normalized version
      if (normalized === folder) continue;
      const current = ep.seriesTitle || ep.showName || '';
      if (current !== normalized) {
        ep.seriesTitle = normalized;
        ep.showName    = normalized;
        fixed++;
      }
    }

    if (fixed > 0) {
      invalidateGroupedCache();
      saveDB(true, 'tvShows');
    }

    res.json({ ok: true, fixed, total: db.tvShows.length });
  });

  // ── POST /api/library/tvShows/repair-metadata ─────────────────────────────
  // Deduplicates db.tvShows by filePath. For each set of duplicates, keeps the
  // entry whose seriesTitle matches the NAS folder name. Fixes the metadata
  // corruption caused by repeated scans receiving wrong TMDB matches.
  router.post('/tvShows/repair-metadata', (req, res) => {
    const norm  = p => (p || '').replace(/\\/g, '/');
    const clean = n => n.toLowerCase().replace(/[^a-z0-9]/g, '');

    const getShowFolder = (filePath) => {
      const parts = norm(filePath).split('/');
      const dirs  = parts.slice(0, -1);
      const last  = dirs[dirs.length - 1] || '';
      const showDirs = /season|series|disc|^s\d+/i.test(last) ? dirs.slice(0, -1) : dirs;
      return showDirs[showDirs.length - 1] || '';
    };

    // Group by filePath (normalized, lowercase) to find duplicates
    const groups = {};
    for (const ep of db.tvShows) {
      if (!ep.filePath) continue;
      const key = norm(ep.filePath).toLowerCase();
      if (!groups[key]) groups[key] = [];
      groups[key].push(ep);
    }

    const toRemove = new Set();
    let fixed = 0;

    for (const [, group] of Object.entries(groups)) {
      if (group.length <= 1) continue;

      const folder = getShowFolder(group[0].filePath);
      const folderClean = clean(folder);

      // Score each entry: higher = better match
      const scored = group.map(ep => {
        const title = clean(ep.seriesTitle || ep.showName || '');
        const folderMatch = title === folderClean ? 2 : 0;
        const hasGoodMeta = ep.metadataFetched && ep.tmdbId ? 1 : 0;
        const recency = new Date(ep.addedAt || 0).getTime();
        return { ep, score: folderMatch * 1000 + hasGoodMeta * 100 + recency / 1e12 };
      });

      scored.sort((a, b) => b.score - a.score);
      // Keep the best; mark the rest for removal
      for (let i = 1; i < scored.length; i++) {
        toRemove.add(scored[i].ep.id);
        fixed++;
      }
    }

    if (toRemove.size > 0) {
      db.tvShows = db.tvShows.filter(ep => !toRemove.has(ep.id));
      rebuildIndex('tvShows');
      invalidateGroupedCache();
      saveDB(true, 'tvShows');
    }

    res.json({ ok: true, duplicatesRemoved: fixed, remaining: db.tvShows.length });
  });

  // ── Invalidate grouped cache helper (exported) ────────────────────────────────
  router.invalidateGroupedCache = invalidateGroupedCache;
  router.invalidateCache = invalidateCache;

  return router;
};

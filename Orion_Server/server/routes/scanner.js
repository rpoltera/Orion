'use strict';
/**
 * Orion Scanner Routes
 * /api/library/scan, /api/library/probe/*, /api/library/batch
 * /api/library/movies/smart-dedup, /api/library/movies/cleanup-folders
 * /api/library/tvShows/smart-dedup, /api/library/tvShows/mergedupes
 * /api/library/:type/deduplicate
 */

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const ffmpeg  = require('fluent-ffmpeg');

const RATING_ORDER = ['G','TV-G','TV-Y','TV-Y7','PG','TV-PG','PG-13','TV-14','R','TV-MA','NC-17','NR','UNRATED'];
function getRatingRank(r) { const i = RATING_ORDER.indexOf((r||'').toUpperCase().trim()); return i === -1 ? 99 : i; }

// Find local poster/fanart/clearlogo files — uses a directory cache for speed on NAS
const _imgDirCache = new Map();
function findLocalImages(filePath) {
  const episodeDir = path.dirname(filePath);
  const showDir    = path.dirname(episodeDir);
  const results    = { poster: null, fanart: null, clearlogo: null };
  const POSTER_NAMES    = ['poster.jpg','poster.png','folder.jpg','folder.png','cover.jpg','cover.png'];
  const FANART_NAMES    = ['fanart.jpg','fanart.png','backdrop.jpg','backdrop.png','background.jpg'];
  const CLEARLOGO_NAMES = ['clearlogo.png','clearlogo.jpg','logo.png','logo.jpg'];
  const readDir = (d) => {
    if (_imgDirCache.has(d)) return _imgDirCache.get(d);
    try { const s = new Set(fs.readdirSync(d).map(f => f.toLowerCase())); _imgDirCache.set(d, s); return s; }
    catch(e) { _imgDirCache.set(d, new Set()); return new Set(); }
  };
  for (const dir of [showDir, episodeDir]) {
    const files = readDir(dir);
    if (!results.poster)    { for (const n of POSTER_NAMES)    { if (files.has(n)) { results.poster    = path.join(dir, n); break; } } }
    if (!results.fanart)    { for (const n of FANART_NAMES)    { if (files.has(n)) { results.fanart    = path.join(dir, n); break; } } }
    if (!results.clearlogo) { for (const n of CLEARLOGO_NAMES) { if (files.has(n)) { results.clearlogo = path.join(dir, n); break; } } }
    if (results.poster && results.fanart && results.clearlogo) break;
  }
  return results;
}
// NFO metadata parser — reads Kodi/Plex/Jellyfin NFO XML files
function findLocalMetadata(filePath) {
  const base       = path.basename(filePath, path.extname(filePath));
  const episodeDir = path.dirname(filePath);
  const showDir    = path.dirname(episodeDir);
  const candidates = [
    path.join(episodeDir, `${base}.nfo`),
    path.join(episodeDir, 'movie.nfo'),
    path.join(episodeDir, 'tvshow.nfo'),
    path.join(showDir,    'tvshow.nfo'),
    path.join(showDir,    'movie.nfo'),
  ];
  let nfoContent = null;
  for (const c of candidates) { try { nfoContent = fs.readFileSync(c, 'utf8'); break; } catch {} }
  if (!nfoContent) return null;
  const tag  = (n) => { const m = nfoContent.match(new RegExp(`<${n}[^>]*>([\\s\\S]*?)<\\/${n}>`, 'i')); return m ? m[1].trim() : null; };
  const tags = (n) => { const rx = new RegExp(`<${n}[^>]*>([\\s\\S]*?)<\\/${n}>`, 'gi'); const r = []; let m; while ((m = rx.exec(nfoContent))) r.push(m[1].trim()); return r; };
  const result = {
    title:    tag('title') || tag('originaltitle') || null,
    overview: tag('plot') || tag('outline') || null,
    year:     parseInt(tag('year') || '') || null,
    rating:   parseFloat(tag('rating') || '') || null,
    runtime:  parseInt(tag('runtime') || '') || null,
    genres:   tags('genre').filter(Boolean),
    studios:  tags('studio').filter(Boolean),
    cast:     tags('name').filter(Boolean),
    tmdbId:   tag('tmdbid') || null,
    imdbId:   tag('imdbid') || null,
    mpaa:     tag('mpaa') || tag('contentrating') || null,
  };
  return (result.title || result.overview) ? result : null;
}

// Rate limiter — max N requests per minute per IP
const _rateLimits = new Map();
function rateLimit(req, res, next, max = 10) {
  const key = `${req.ip}:${req.path}`;
  const now = Date.now();
  const entry = _rateLimits.get(key) || { count: 0, resetAt: now + 60000 };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + 60000; }
  entry.count++;
  _rateLimits.set(key, entry);
  if (entry.count > max) return res.status(429).json({ error: 'Too many requests' });
  next();
}

module.exports = function scannerRoutes({ db, io, saveDB, rebuildIndex, scanDirectory, deduplicateMedia, buildVersionsMap, invalidateGroupedCache, invalidateCache, queueMetadata, getConfig }) {

  const router = express.Router();

  // ── Scan ──────────────────────────────────────────────────────────────────────
  router.post('/scan', (req, res, next) => rateLimit(req, res, next, 5), async (req, res) => {
    try {
      const { paths, type } = req.body;
      if (!paths || !Array.isArray(paths)) return res.status(400).json({ error: 'paths required' });
      if (!type) return res.status(400).json({ error: 'type required' });

      const validPaths = paths.filter(p => { try { return fs.existsSync(p); } catch { return false; } });
      if (validPaths.length === 0) return res.status(400).json({ error: `Path not found: ${paths[0]}` });

      res.json({ scanning: true, message: 'Scan started in background...' });

      setImmediate(async () => {
        try {
          const newItems = [];
          for (const p of validPaths) {
            try {
              io.emit('scan:progress', { status: `Scanning "${path.basename(p)}"...`, count: 0 });
              await new Promise(r => setImmediate(r));
              const scanned = await scanDirectory(p, type, {
                onProgress: (data) => io.emit('scan:progress', data),
                findLocalImages,
                findLocalMetadata,
              });
              const existing = new Set((db[type] || []).map(i => i.filePath));
              const fresh = scanned.filter(i => !existing.has(i.filePath));
              const now = new Date().toISOString();
              fresh.forEach(i => { if (!i.addedAt) i.addedAt = now; });
              newItems.push(...fresh);
              console.log(`[Scan] ${p} → ${fresh.length} new ${type} files`);
              io.emit('scan:progress', { status: `Processing ${fresh.length} new files...`, count: fresh.length });
            } catch (e) { console.error(`[Scan] Error scanning ${p}:`, e.message); }
          }

          if (!db[type]) db[type] = [];
          db[type] = deduplicateMedia([...db[type], ...newItems]);
          if (type === 'movies' && buildVersionsMap) buildVersionsMap(db.movies);

          if (!db.libraryPaths[type]) db.libraryPaths[type] = [];
          for (const p of validPaths) { if (!db.libraryPaths[type].includes(p)) db.libraryPaths[type].push(p); }

          saveDB();
          if (invalidateCache) invalidateCache('library:' + type);
          if (invalidateGroupedCache) invalidateGroupedCache();
          rebuildIndex(type);
          io.emit('library:updated', { type, count: newItems.length });
          io.emit('scan:complete', { type, added: newItems.length, total: db[type].length });
          if (queueMetadata) queueMetadata(newItems, type);
        } catch (err) {
          console.error('[Scan] Fatal error:', err.message);
          io.emit('scan:error', { error: err.message });
        }
      });
    } catch (err) {
      console.error('[Scan] Fatal error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Batch fetch ───────────────────────────────────────────────────────────────
  router.post('/batch', (req, res) => {
    const { ids, fields } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids array required' });
    if (ids.length > 100) return res.status(400).json({ error: 'max 100 ids per batch' });
    const allMedia = [...db.movies, ...db.tvShows, ...(db.music||[]), ...(db.musicVideos||[])];
    const FIELDS = new Set(fields || ['id','title','year','thumbnail','rating','type','filePath','genres','overview','runtime']);
    const idSet = new Set(ids);
    const items = allMedia.filter(m => idSet.has(m.id)).map(m => { const out = {}; for (const k of FIELDS) if (m[k] !== undefined) out[k] = m[k]; return out; });
    res.set('X-Total-Count', String(items.length)).json({ items });
  });

  // ── Probe ─────────────────────────────────────────────────────────────────────
  let probeState = { running: false, total: 0, done: 0, errors: 0, startedAt: null };

  router.get('/probe/status', (req, res) => {
    res.set('Cache-Control', 'no-store').json({ ...probeState, done: !probeState.running });
  });

  router.post('/probe/stop', (req, res) => { probeState.running = false; res.json({ ok: true }); });

  router.post('/probe/start', async (req, res) => {
    if (probeState.running) return res.json({ ok: false, message: 'Probe already running' });
    const types = ['movies', 'tvShows', 'musicVideos'];
    const allItems = types.flatMap(t => (db[t]||[]).filter(i => !i.resolution && i.filePath));
    probeState = { running: true, total: allItems.length, done: 0, errors: 0, startedAt: new Date().toISOString() };
    res.json({ ok: true, total: allItems.length });

    const getResolution = (w, h) => { if (!w||!h) return null; const p = Math.max(w,h); if (p>=3840) return '4K'; if (p>=1920) return '1080p'; if (p>=1280) return '720p'; if (p>=720) return '480p'; return 'SD'; };
    const getHDR = (streams) => { const v = streams.find(s => s.codec_type==='video'); if (!v) return false; return /smpte2084|arib-std-b67|smpte428/.test(v.color_transfer||'') || /bt2020/.test(v.color_primaries||''); };
    const getAudioCodec = (streams) => {
      const audio = streams.filter(s => s.codec_type==='audio');
      if (!audio.length) return null;
      for (const pref of ['truehd','dts','eac3','ac3','aac','mp3']) {
        const m = audio.find(s => s.codec_name?.toLowerCase().includes(pref));
        if (m) { if (pref==='truehd') return m.profile?.toLowerCase().includes('atmos') ? 'Atmos' : 'TrueHD'; if (pref==='dts') return m.profile?.toLowerCase().includes('ma') ? 'DTS-MA' : 'DTS'; if (pref==='eac3') return 'E-AC3'; if (pref==='ac3') return 'AC3'; return m.codec_name.toUpperCase(); }
      }
      return audio[0]?.codec_name?.toUpperCase() || null;
    };

    const typeMap = {};
    types.forEach(t => (db[t]||[]).forEach(i => { typeMap[i.id] = t; }));

    const probeOne = (item, type) => new Promise(resolve => {
      const config = getConfig();
      const resolved = (() => {
        for (const m of (config.pathMappings||[])) {
          if (m.unc && m.local && item.filePath.toLowerCase().startsWith(m.unc.toLowerCase())) return m.local + item.filePath.slice(m.unc.length);
        }
        return item.filePath;
      })();

      ffmpeg.ffprobe(resolved, (err, meta) => {
        if (err) { probeState.errors++; probeState.done++; return resolve(); }
        try {
          const streams = meta.streams || [];
          const video = streams.find(s => s.codec_type === 'video');
          const list = db[type];
          const idx = list?.findIndex(i => i.id === item.id);
          if (idx >= 0) {
            const res = getResolution(video?.width, video?.height);
            if (res) list[idx].resolution = res;
            if (getHDR(streams)) list[idx].hdr = true;
            const ac = getAudioCodec(streams);
            if (ac) list[idx].audioCodec = ac;
            if (video?.codec_name) list[idx].videoCodec = video.codec_name.toLowerCase();
          }
        } catch {}
        probeState.done++;
        resolve();
      });
    });

    (async () => {
      const queue = [...allItems];
      const workers = Array.from({ length: 4 }, async () => {
        while (queue.length > 0 && probeState.running) {
          const item = queue.shift();
          if (!item) break;
          await probeOne(item, typeMap[item.id]);
        }
      });
      await Promise.all(workers);
      saveDB();
      probeState.running = false;
      console.log(`[Probe] Complete: ${probeState.done} files, ${probeState.errors} errors`);
      io.emit('probe:complete', { done: probeState.done, errors: probeState.errors });
    })();
  });

  // ── Movie smart dedup ─────────────────────────────────────────────────────────
  const normTitle = (t) => (t||'').toLowerCase().replace(/\(?(19|20)\d{2}\)?/g,'').replace(/[^a-z0-9]/g,'').trim();

  function buildMovieGroups() {
    const byKey = new Map();
    for (const m of db.movies) {
      const key = m.tmdbId ? `tmdb:${m.tmdbId}` : (normTitle(m.title).length > 1 ? `title:${normTitle(m.title)}${m.year?':'+m.year:''}` : null);
      if (!key) continue;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(m);
    }
    // Merge year-less title keys into year keys
    for (const yk of [...byKey.keys()].filter(k => k.startsWith('title:') && k.split(':').length === 2)) {
      const tp = yk.split(':')[1];
      const withYear = [...byKey.keys()].find(k => k.startsWith(`title:${tp}:`) && k !== yk);
      if (withYear) { byKey.set(withYear, [...(byKey.get(withYear)||[]), ...(byKey.get(yk)||[])]); byKey.delete(yk); }
    }
    return byKey;
  }

  router.get('/movies/smart-dedup', async (req, res) => {
    try {
      const byKey = buildMovieGroups();
      const toRemove = [], toMerge = [];
      for (const [, group] of byKey) {
        if (group.length < 2) continue;
        const bySizeKey = new Map();
        for (const m of group) { const k = String(m.size||0); if (!bySizeKey.has(k)) bySizeKey.set(k,[]); bySizeKey.get(k).push(m); }
        for (const [, sameSize] of bySizeKey) {
          if (sameSize.length < 2) continue;
          const sorted = sameSize.sort((a,b) => (b.filePath?.split(/[/\\]/).length||0)-(a.filePath?.split(/[/\\]/).length||0));
          for (let i=1;i<sorted.length;i++) toRemove.push({ id: sorted[i].id, title: sorted[i].title, filePath: sorted[i].filePath, size: sorted[i].size });
        }
        const uniqueSizes = [...new Set(group.map(m=>m.size))];
        if (uniqueSizes.length > 1) toMerge.push({ title: group[0].title, year: group[0].year, files: group.map(m=>path.basename(m.filePath||'')), paths: group.map(m=>m.filePath) });
      }
      res.json({ toRemove, toMerge });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/movies/smart-dedup', async (req, res) => {
    res.json({ ok: true, message: 'Dedup started...' });
    const explicitChoices = req.body;

    setImmediate(async () => {
      try {
        if (explicitChoices?.toRemove || explicitChoices?.toMerge) {
          let removed = 0, merged = 0;
          if (explicitChoices.toRemove?.length) {
            const removeSet = new Set(explicitChoices.toRemove);
            db.movies = db.movies.filter(m => !removeSet.has(m.id));
            removed = explicitChoices.toRemove.length;
            io.emit('dedup:progress', { status: `Removed ${removed} duplicates from library`, done: false });
          }
          if (explicitChoices.toMerge?.length) {
            for (const group of explicitChoices.toMerge) {
              const paths = group.paths?.filter(Boolean);
              if (!paths?.length) continue;
              const primary = paths.sort((a,b) => { try { return fs.statSync(b).size-fs.statSync(a).size; } catch { return 0; } })[0];
              const primaryDir = path.dirname(primary);
              for (const p of paths) {
                if (p === primary) continue;
                const srcDir = path.dirname(p);
                if (srcDir === primaryDir) continue;
                try {
                  io.emit('dedup:progress', { status: `Merging: ${path.basename(srcDir)} → ${path.basename(primaryDir)}`, done: false });
                  for (const f of fs.readdirSync(srcDir)) { const src = path.join(srcDir,f); const dest = path.join(primaryDir,f); if (!fs.existsSync(dest)) fs.renameSync(src,dest); }
                  const dbMovie = db.movies.find(m => m.filePath === p);
                  if (dbMovie) dbMovie.filePath = path.join(primaryDir, path.basename(p));
                  try { fs.rmdirSync(srcDir); } catch {}
                  merged++;
                } catch(e) { console.error('[SmartDedup] Merge error:', e.message); }
              }
            }
          }
          saveDB(true, 'movies');
          const summary = `✅ Done — removed ${removed} from library, merged ${merged} folders`;
          io.emit('dedup:progress', { status: summary, done: true, removed, merged });
          io.emit('library:updated', { type: 'movies' });
          return;
        }

        // Auto dedup
        io.emit('dedup:progress', { status: 'Scanning library for duplicates...', done: false });
        const byKey = buildMovieGroups();
        let removed = 0, merged = 0;
        const toRemoveIds = new Set();
        let processed = 0;
        const total = [...byKey.values()].filter(g=>g.length>1).length;

        for (const [, group] of byKey) {
          if (group.length < 2) continue;
          processed++;
          io.emit('dedup:progress', { status: `Processing ${group[0].title}...`, current: processed, total, done: false });
          const bySizeKey = new Map();
          for (const m of group) { const k = String(m.size||0); if (!bySizeKey.has(k)) bySizeKey.set(k,[]); bySizeKey.get(k).push(m); }
          for (const [, sameSize] of bySizeKey) {
            if (sameSize.length < 2) continue;
            const sorted = sameSize.sort((a,b)=>(b.filePath?.split(/[/\\]/).length||0)-(a.filePath?.split(/[/\\]/).length||0));
            for (let i=1;i<sorted.length;i++) { toRemoveIds.add(sorted[i].id); removed++; io.emit('dedup:progress', { status: `Removing duplicate: ${sorted[i].title}`, current: processed, total, done: false }); }
          }
          const uniqueSizes = [...new Set(group.map(m=>m.size))];
          if (uniqueSizes.length > 1) {
            const primary = group.sort((a,b)=>(b.size||0)-(a.size||0))[0];
            const primaryDir = path.dirname(primary.filePath);
            for (const m of group) {
              if (m.id === primary.id || toRemoveIds.has(m.id)) continue;
              try {
                const srcDir = path.dirname(m.filePath);
                if (srcDir === primaryDir) continue;
                io.emit('dedup:progress', { status: `Merging: ${path.basename(srcDir)} → ${path.basename(primaryDir)}`, current: processed, total, done: false });
                for (const f of fs.readdirSync(srcDir)) { const src = path.join(srcDir,f); const dest = path.join(primaryDir,f); if (!fs.existsSync(dest)) fs.renameSync(src,dest); }
                m.filePath = path.join(primaryDir, path.basename(m.filePath));
                try { fs.rmdirSync(srcDir); } catch {}
                merged++;
              } catch(e) { console.error('[SmartDedup] Merge error:', e.message); }
            }
          }
        }
        db.movies = db.movies.filter(m => !toRemoveIds.has(m.id));
        saveDB(true, 'movies');
        const summary = `✅ Done — removed ${removed} duplicates, merged ${merged} folders`;
        io.emit('dedup:progress', { status: summary, done: true, removed, merged });
        io.emit('library:updated', { type: 'movies' });
        console.log(`[SmartDedup] ${summary}`);
      } catch(e) { console.error('[SmartDedup] Error:', e.message); io.emit('dedup:progress', { status: `❌ Error: ${e.message}`, done: true }); }
    });
  });

  // ── Movie folder cleanup ──────────────────────────────────────────────────────
  router.get('/movies/cleanup-folders', async (req, res) => {
    try {
      const dirCounts = new Map();
      for (const m of db.movies) { if (!m.filePath) continue; const gp = path.dirname(path.dirname(m.filePath)); dirCounts.set(gp, (dirCounts.get(gp)||0)+1); }
      const moviesRoot = [...dirCounts.entries()].sort((a,b)=>b[1]-a[1])[0]?.[0];
      if (!moviesRoot) return res.json({ items: [] });
      const rootMovies = db.movies.filter(m => m.filePath && path.dirname(m.filePath) === moviesRoot);
      res.json({ items: rootMovies.map(m => `${m.title || path.basename(m.filePath)} — ${path.basename(m.filePath)}`), moviesRoot });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/movies/cleanup-folders', async (req, res) => {
    res.json({ ok: true, message: 'Cleanup started...' });
    setImmediate(async () => {
      let moved = 0;
      const dirCounts = new Map();
      for (const m of db.movies) { if (!m.filePath) continue; const gp = path.dirname(path.dirname(m.filePath)); dirCounts.set(gp, (dirCounts.get(gp)||0)+1); }
      const moviesRoot = [...dirCounts.entries()].sort((a,b)=>b[1]-a[1])[0]?.[0];
      if (!moviesRoot) return;
      const metaExts = ['.nfo','.jpg','.png','.srt','.sub','.ass','.ssa','.xml'];
      for (const movie of db.movies) {
        if (!movie.filePath || path.dirname(movie.filePath) !== moviesRoot) continue;
        try {
          const folderName = (movie.year ? `${movie.title} (${movie.year})` : movie.title).replace(/[<>:"/\\|?*]/g,'').trim();
          const newDir = path.join(moviesRoot, folderName);
          if (!fs.existsSync(newDir)) fs.mkdirSync(newDir);
          const newFilePath = path.join(newDir, path.basename(movie.filePath));
          fs.renameSync(movie.filePath, newFilePath);
          movie.filePath = newFilePath;
          const base = path.join(moviesRoot, path.parse(movie.filePath).name);
          for (const ext of metaExts) { const src = base+ext; if (fs.existsSync(src)) try { fs.renameSync(src, path.join(newDir, path.basename(src))); } catch {} }
          for (const name of ['poster.jpg','backdrop.jpg','folder.jpg','fanart.jpg']) { const src = path.join(moviesRoot,name); if (fs.existsSync(src)) try { fs.renameSync(src, path.join(newDir,name)); } catch {} }
          moved++;
          console.log(`[Cleanup] Moved: ${path.basename(movie.filePath)} → ${folderName}/`);
        } catch(e) { console.error(`[Cleanup] Error moving ${movie.filePath}:`, e.message); }
      }
      if (moved > 0) { saveDB(true,'movies'); console.log(`[Cleanup] Done — moved ${moved} movies`); io.emit('library:updated', { type: 'movies', moved }); }
    });
  });

  // ── TV Show smart dedup ───────────────────────────────────────────────────────
  router.get('/tvShows/smart-dedup', (req, res) => {
    try {
      const norm = (t) => (t||'').toLowerCase().replace(/\(?(19|20)\d{2}\)?/g,'').replace(/[^a-z0-9]/g,'').trim();
      const showCounts = new Map();
      for (const ep of db.tvShows) { const name = ep.seriesTitle||ep.showName||''; if (name) showCounts.set(name,(showCounts.get(name)||0)+1); }
      const byKey = new Map();
      for (const [showName, count] of showCounts) {
        const ep = db.tvShows.find(e => (e.seriesTitle||e.showName) === showName);
        const key = ep?.tmdbId ? `tmdb:${ep.tmdbId}` : `title:${norm(showName)}`;
        if (!byKey.has(key)) byKey.set(key,[]);
        byKey.get(key).push({ name: showName, count });
      }
      const groups = [];
      for (const [, names] of byKey) {
        if (names.length < 2) continue;
        const sorted = names.sort((a,b)=>b.count-a.count);
        groups.push({ primaryName: sorted[0].name, names: sorted });
      }
      res.json({ groups });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/tvShows/smart-dedup', (req, res) => {
    const { toMerge } = req.body || {};
    if (!toMerge?.length) return res.json({ merged: 0 });
    res.json({ ok: true, merged: toMerge.length });
    setImmediate(() => {
      let merged = 0;
      for (const group of toMerge) {
        const primaryName = group.primaryName;
        const otherNames = group.names.filter(n=>n.name!==primaryName).map(n=>n.name);
        let changed = 0;
        for (const ep of db.tvShows) {
          const epName = ep.seriesTitle||ep.showName||'';
          if (otherNames.includes(epName)) { if (ep.seriesTitle) ep.seriesTitle=primaryName; else ep.showName=primaryName; changed++; }
        }
        if (changed > 0) { console.log(`[TVSmartDedup] Merged ${otherNames.join(', ')} → "${primaryName}" (${changed} episodes)`); merged++; }
      }
      if (merged > 0) { saveDB(true,'tvShows'); if (invalidateGroupedCache) invalidateGroupedCache(); io.emit('library:updated', { type: 'tvShows' }); }
    });
  });

  router.post('/tvShows/mergedupes', (req, res) => {
    const norm = s => (s||'').toLowerCase().replace(/[^a-z0-9]/g,'');
    const shows = new Map();
    for (const ep of db.tvShows) {
      const name = ep.seriesTitle||ep.showName||'';
      const key = norm(name);
      if (!shows.has(key)) shows.set(key, { canonical: name, count: 0 });
      else { const e = shows.get(key); if (name.length < e.canonical.length) e.canonical = name; }
      shows.get(key).count++;
    }
    let merged = 0;
    const details = [];
    for (const [key, { canonical }] of shows) {
      const alts = db.tvShows.filter(ep => { const n = ep.seriesTitle||ep.showName||''; return norm(n) === key && n !== canonical; });
      if (alts.length > 0) {
        for (const ep of alts) { if (ep.seriesTitle) ep.seriesTitle=canonical; else ep.showName=canonical; }
        details.push(`"${alts[0].seriesTitle||alts[0].showName}" → "${canonical}"`);
        merged++;
      }
    }
    if (merged > 0) { saveDB(true,'tvShows'); if (invalidateGroupedCache) invalidateGroupedCache(); }
    res.json({ ok: true, merged, episodes: merged, details });
  });

  // ── Basic dedup ───────────────────────────────────────────────────────────────
  router.post('/:type/deduplicate', (req, res) => {
    const { type } = req.params;
    if (!db[type]) return res.status(404).json({ error: 'Unknown type' });
    const before = db[type].length;
    db[type] = deduplicateMedia(db[type]);
    const after = db[type].length;
    saveDB();
    res.json({ ok: true, removed: before-after, after });
  });

  // ── Backfill local images for existing items without thumbnails ───────────────
  router.post('/backfill-local-images', async (req, res) => {
    res.json({ ok: true, message: 'Backfill started' });
    let updated = 0;
    for (const type of ['movies', 'tvShows', 'music', 'musicVideos']) {
      for (const item of (db[type] || [])) {
        if (item.thumbnail || !item.filePath) continue;
        const imgs = findLocalImages(item.filePath);
        if (imgs.poster) {
          item.thumbnail = `/api/localimage?path=${encodeURIComponent(imgs.poster)}`;
          if (imgs.fanart) item.backdrop = `/api/localimage?path=${encodeURIComponent(imgs.fanart)}`;
          updated++;
        }
      }
    }
    if (updated > 0) {
      saveDB(true);
      if (invalidateGroupedCache) invalidateGroupedCache();
    }
    console.log(`[Scanner] Backfilled local images for ${updated} items`);
    io.emit('scan:complete', { updated });
  });

  return router;
};

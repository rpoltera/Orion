'use strict';
/**
 * StreamForge — integrated IPTV playout engine for Orion
 * Mounted into Orion's Express app at /api/sf/* and /sf/*
 * Shares Orion's ffmpeg binary, hardware encoder, and data directory.
 *
 * Usage in server/index.js (just before server.listen):
 *   require('./streamforge')(app, { ffmpegPath, ffprobePath, cachedEncoder, DATA_DIR });
 */

const path    = require('path');
const fs      = require('fs');
const fsp     = require('fs').promises;
const { v4: uuidv4 }          = require('uuid');
const { spawn, execSync }      = require('child_process');
const express = require('express');
const multer  = require('multer');
const crypto  = require('crypto');
const playoutEngine = require('./playout-engine');

// ── Data files — stored alongside Orion's library.json ───────────────────────
let SF_DIR, SF_CFG, SF_CHANNELS, SF_LIBRARIES, SF_MEDIA, SF_EPG, SF_STREAMS, SF_EPG_DISABLED;

// ── State ─────────────────────────────────────────────────────────────────────
let _procCache = null;   // H2: short-lived /proc read cache
let _presegDownWarned = false;
let sfDb = {};
let sfConfig = {};
let ffmpegExe = '', ffprobeExe = '', hwEncoder = 'libx264';
let orionDb = null; // set on mount — live reference to Orion's db


// ── Cached media combined — rebuilt only when Orion DB changes ───────────────
let _mediaCombinedCache = null;
let _mediaCombinedDirty = true;
let _showsCache = null; // pre-built show index, rebuilt when media cache rebuilds
const _mediaById = new Map(); // id -> item for O(1) lookups

let _networkIndex = new Map();

// === [PRESEG-FILTER] Skipped items tracking for hideUnsegmented mode ===
let _skippedItems = [];
let _presegDoneSet = null;
let _presegDoneSetTime = 0;
function _loadPresegDoneSet() {
  const now = Date.now();
  if (_presegDoneSet && (now - _presegDoneSetTime) < 30000) return _presegDoneSet;
  const set = new Set();
  try {
    const p = path.join(SF_DIR, 'preseg.json');
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      for (const v of Object.values(data)) {
        if (v && v.status === 'done' && v.filePath) set.add(v.filePath);
      }
    }
  } catch (e) { console.error('[PRESEG-FILTER] load failed:', e.message); }
  _presegDoneSet = set;
  _presegDoneSetTime = now;
  return set;
}
function _invalidatePresegDoneSet() {
  _presegDoneSet = null;
  _mediaCombinedDirty = true;
  _mediaCombinedCache = null;
}
 // network -> [items]

function invalidateMediaCache() {
  _mediaCombinedDirty = true;
  _mediaCombinedCache = null;
  _showsCache = null;
  _mediaById.clear();
  _networkIndex.clear();
}

function getNetworkIndex() {
  if (_networkIndex.size > 0) return _networkIndex;
  if (!orionDb) return _networkIndex;
  _networkIndex.clear();
  // Build directly from orionDb mapped to SF media format — same as getMediaCombined() but indexed by network
  for (const ep of (orionDb.tvShows||[])) {
    if (!ep.network || !ep.filePath) continue;
    const key = ep.network.toLowerCase();
    if (!_networkIndex.has(key)) _networkIndex.set(key, []);
    _networkIndex.get(key).push({
      id: ep.id, path: ep.filePath, filePath: ep.filePath, filename: ep.fileName||'',
      title: ep.title||'', seriesTitle: ep.seriesTitle||'',
      season: ep.seasonNum||null, episode: ep.episode||null,
      type: 'episode', duration: ep.runtime ? ep.runtime*60 : 1800,
      thumb: ep.thumbnail||null, summary: ep.overview||'',
      genres: ep.genres||[], libraryId: 'orion-tvShows', sourceType: 'orion',
    });
  }
  console.log(`[SF] Network index built: ${_networkIndex.size} networks, e.g. HGTV=${(_networkIndex.get('hgtv')||[]).length} items`);
  return _networkIndex;
}

function getMediaById(id) {
  if (_mediaCombinedDirty) getMediaCombined(); // ensure built
  return _mediaById.get(id) || null;
}

// Returns Orion library items mapped to SF media format + any SF-specific items
function getMediaCombined() {
  if (!_mediaCombinedDirty && _mediaCombinedCache) return _mediaCombinedCache;
  const sfOwn = sfDb.media || [];
  if (!orionDb) return sfOwn;

  const mapped = [];

  // Movies
  for (const m of (orionDb.movies || [])) {
    mapped.push({
      id:       m.id,
      libraryId: 'orion-movies',
      path:     m.filePath || '',
      filename: m.fileName || '',
      title:    m.title || '',
      year:     m.year  || null,
      season:   null,
      episode:  null,
      type:     'movie',
      duration: m.runtime ? m.runtime * 60 : 0, // Orion stores minutes, SF needs seconds
      thumb:    m.thumbnail || null,
      summary:  m.overview  || '',
      genres:   m.genres || [],
      studios:  [...new Set([
        ...(m.studios||[]),
        ...(() => {
          let wp = m.watchProviders;
          if (typeof wp === 'string') { try { wp = JSON.parse(wp); } catch { wp = []; } }
          return Array.isArray(wp) ? wp.map(p=>typeof p==='object'?p.name||p:String(p)) : [];
        })(),
      ].flat())].filter(Boolean),
      tags:     m.tags || [],
      sourceType: 'orion',
    });
  }

  // TV episodes — extract SERIES title from folder path, not episode filename
  function extractSeriesTitle(filePath, fallbackTitle) {
    if (!filePath) return fallbackTitle || '';
    const parts = filePath.replace(/\\/g, '/').split('/');
    // Walk up: skip the filename, skip season folders, use the show folder
    for (let i = parts.length - 2; i >= 0; i--) {
      const part = parts[i];
      if (!part) continue;
      if (/^(season|s\d|disc|disk|extras?|specials?|bonus)/i.test(part)) continue;
      // Strip year, resolution, quality tags from folder name
      const clean = part
        .replace(/[\.\-\_]/g, ' ')
        .replace(/\b(\d{4})\b.*$/, '')   // strip year and everything after
        .replace(/\b(1080p|720p|4k|uhd|bluray|webrip|hdtv|x264|x265|hevc).*$/i, '')
        .replace(/\s+/g, ' ').trim();
      if (clean.length > 1) return clean;
    }
    return fallbackTitle || '';
  }

  for (const ep of (orionDb.tvShows || [])) {
    const seMatch = (ep.fileName || ep.filePath || '').match(/[Ss](\d+)[Ee](\d+)/);
    const seriesTitle = extractSeriesTitle(ep.filePath, ep.title);
    mapped.push({
      id:          ep.id,
      libraryId:   'orion-tvshows',
      path:        ep.filePath || '',
      filename:    ep.fileName || '',
      title:       seriesTitle,          // SERIES name — not episode title
      episodeTitle: ep.title || '',      // Keep episode title separately
      year:        ep.year  || null,
      season:      seMatch ? parseInt(seMatch[1]) : null,
      episode:     seMatch ? parseInt(seMatch[2]) : null,
      type:        'episode',
      duration:    ep.runtime ? ep.runtime * 60 : 0,
      thumb:       ep.thumbnail || null,
      summary:     ep.overview  || '',
      genres:      ep.genres || [],
      // ep.networks[] is the reliable TMDB field — may be JSON string from SQLite
      studios:     [...new Set([
        ...(ep.studios||[]),
        ...(() => {
          let nets = ep.networks;
          if (typeof nets === 'string') { try { nets = JSON.parse(nets); } catch { nets = []; } }
          return Array.isArray(nets) ? nets.map(n=>typeof n==='object'?n.name||n:String(n)) : [];
        })(),
      ].flat())].filter(Boolean),
      tags:        ep.tags || [],
      sourceType:  'orion',
    });
  }

  // Music Videos
  for (const mv of (orionDb.musicVideos || [])) {
    mapped.push({
      id:        mv.id,
      libraryId: 'orion-musicvideos',
      path:      mv.filePath || '',
      filename:  mv.fileName || '',
      title:     mv.title || '',
      year:      mv.year  || null,
      season:    null,
      episode:   null,
      type:      'musicvideo',
      duration:  mv.runtime ? mv.runtime * 60 : 0,
      thumb:     mv.thumbnail || null,
      summary:   mv.overview  || '',
      artist:    mv.artist || '',
      sourceType: 'orion',
    });
  }

  // Music / Audio
  for (const tr of (orionDb.music || [])) {
    mapped.push({
      id:        tr.id,
      libraryId: 'orion-music',
      path:      tr.filePath || '',
      filename:  tr.fileName || '',
      title:     tr.title || '',
      year:      tr.year  || null,
      season:    null,
      episode:   null,
      type:      'music',
      duration:  tr.runtime ? tr.runtime * 60 : 0,
      thumb:     tr.thumbnail || null,
      summary:   '',
      artist:    tr.artist || '',
      album:     tr.album  || '',
      sourceType: 'orion',
    });
  }

  // Merge: SF-specific items first (they may override), then Orion items not already present
  const ids = new Set(sfOwn.map(m => m.id));
  const orionNew = mapped.filter(m => !ids.has(m.id));
  const combined = [...sfOwn, ...orionNew];
  // === [PRESEG-FILTER] Always compute skipped list; filter only when flag is on ===
  _skippedItems = [];
  const _doneSet = _loadPresegDoneSet();
  for (const item of combined) {
    if (item.path && _doneSet.has(item.path)) continue;
    _skippedItems.push({
      id: item.id,
      title: item.title || '',
      episodeTitle: item.episodeTitle || null,
      path: item.path || '',
      type: item.type,
      season: item.season,
      episode: item.episode,
      reason: !item.path ? 'no file path in DB' : 'not preseg-segmented',
    });
  }
  if (sfConfig && sfConfig.hideUnsegmented) {
    const kept = combined.filter(item => item.path && _doneSet.has(item.path));
    combined.length = 0;
    combined.push(...kept);
    console.log('[PRESEG-FILTER] active: kept=' + kept.length + ' skipped=' + _skippedItems.length);
  } else if (_skippedItems.length > 0) {
    console.log('[PRESEG-FILTER] tracking ' + _skippedItems.length + ' unsegmented items (filter OFF)');
  }

  // Build id index
  _mediaById.clear();
  for (const item of combined) _mediaById.set(item.id, item);
  _mediaCombinedCache = combined;
  _mediaCombinedDirty = false;

  // Pre-build show index so search is instant (no re-scan of 25k episodes per query)
  const _showMap = {};
  for (const ep of combined) {
    if (ep.type !== 'episode' && ep.season == null) continue;
    const t = ep.title || 'Unknown';
    if (!_showMap[t]) _showMap[t] = {};
    const s = ep.season || 1;
    if (!_showMap[t][s]) _showMap[t][s] = [];
    _showMap[t][s].push({ mediaId:ep.id, season:s, episode:ep.episode||0, title:ep.episodeTitle||'', duration:ep.duration||1800 });
  }
  _showsCache = Object.entries(_showMap).map(([title, seasons]) => {
    Object.values(seasons).forEach(arr => arr.sort((a,b) => a.episode - b.episode));
    return { title, titleLower:title.toLowerCase(), seasons, totalEpisodes:Object.values(seasons).reduce((s,a)=>s+a.length,0), seasonCount:Object.keys(seasons).length };
  }).sort((a,b) => a.title.localeCompare(b.title));
  console.log(`[SF] Show index built: ${_showsCache.length} shows from ${combined.filter(e=>e.type==='episode').length} episodes`);

  return combined;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function loadJson(f, def) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return JSON.parse(JSON.stringify(def)); }
}
function saveJson(f, d) {
  fs.writeFile(f, JSON.stringify(d, null, 2), err => { if (err) console.error('[SF] save:', err.message); });
}
let _sfSaveTimer = null;
function saveAll() {
  // Debounced async save — coalesces rapid writes
  if (_sfSaveTimer) return;
  _sfSaveTimer = setTimeout(() => {
    _sfSaveTimer = null;
    fs.writeFile(SF_CHANNELS,     JSON.stringify(sfDb.channels, null, 2),    () => {});
    fs.writeFile(SF_LIBRARIES,    JSON.stringify(sfDb.libraries, null, 2),   () => {});
    fs.writeFile(SF_MEDIA,        JSON.stringify(sfDb.media, null, 2),        () => {});
    fs.writeFile(SF_EPG,          JSON.stringify(sfDb.epg, null, 2),          () => {});
    fs.writeFile(SF_STREAMS,      JSON.stringify(sfDb.streams, null, 2),      () => {});
    fs.writeFile(SF_EPG_DISABLED, JSON.stringify(sfDb.epgDisabled || [], null, 2), () => {});
  }, 1000); // batch all writes within 1 second
}

function saveAllImmediate() {
  if (_sfSaveTimer) { clearTimeout(_sfSaveTimer); _sfSaveTimer = null; }
  fs.writeFile(SF_CHANNELS,     JSON.stringify(sfDb.channels, null, 2),         () => {});
  fs.writeFile(SF_LIBRARIES,    JSON.stringify(sfDb.libraries, null, 2),        () => {});
  fs.writeFile(SF_MEDIA,        JSON.stringify(sfDb.media, null, 2),             () => {});
  fs.writeFile(SF_EPG,          JSON.stringify(sfDb.epg, null, 2),               () => {});
  fs.writeFile(SF_STREAMS,      JSON.stringify(sfDb.streams, null, 2),           () => {});
  fs.writeFile(SF_EPG_DISABLED, JSON.stringify(sfDb.epgDisabled || [], null, 2), () => {});
}
function fmtDate(ts) {
  const d = new Date(ts), p = n => String(n).padStart(2,'0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth()+1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())} +0000`;
}


// ── SF stream/channel indexes for O(1) lookups ───────────────────────────────
const _sfStreamsById = new Map();
const _sfChannelsById = new Map();

function rebuildSfIndexes() {
  _sfStreamsById.clear();
  _sfChannelsById.clear();
  (sfDb.streams || []).forEach(s => _sfStreamsById.set(s.id, s));
  (sfDb.channels || []).forEach(c => _sfChannelsById.set(c.id, c));
}

function getSfStream(id) { return _sfStreamsById.get(id) || (sfDb.streams||[]).find(s=>s.id===id); }
function getSfChannel(id) { return _sfChannelsById.get(id) || (sfDb.channels||[]).find(c=>c.id===id); }

// ── Media scanning ────────────────────────────────────────────────────────────
const VIDEO_EXTS = new Set(['.mkv','.mp4','.avi','.mov','.wmv','.m4v','.ts','.m2ts','.flv','.webm']);

function parseFilename(name) {
  const base = path.basename(name, path.extname(name));
  let title = base, year = null, season = null, episode = null;
  const seMatch = base.match(/[Ss](\d+)[Ee](\d+)/);
  if (seMatch) { season = parseInt(seMatch[1]); episode = parseInt(seMatch[2]); title = base.slice(0, seMatch.index).replace(/[._\-]+$/,'').replace(/[._]/g,' ').trim(); }
  const yrMatch = base.match(/[\.(]((?:19|20)\d{2})[\.)]/) ;
  if (yrMatch) { year = parseInt(yrMatch[1]); if (!seMatch) title = base.slice(0, yrMatch.index).replace(/[._]/g,' ').trim(); }
  if (!seMatch && !yrMatch) title = base.replace(/[._]/g,' ').trim();
  return { title: title||base, year, season, episode, type: season !== null ? 'episode' : 'movie' };
}

function getDuration(filePath) {
  try {
    const out = execSync(`"${ffprobeExe}" -v quiet -show_entries format=duration -of csv=p=0 "${filePath}"`, { timeout: 10000 }).toString().trim();
    const d = parseFloat(out); return isNaN(d) ? 0 : Math.floor(d);
  } catch { return 0; }
}

async function scanLocalDir(libId, dirPath, existingPaths) {
  const items = [];
  async function walk(dir) {
    let entries; try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { await walk(full); }
      else if (e.isFile() && VIDEO_EXTS.has(path.extname(e.name).toLowerCase()) && !existingPaths.has(full)) {
        const meta = parseFilename(e.name);
        items.push({ id: uuidv4(), libraryId: libId, path: full, filename: e.name, title: meta.title, year: meta.year, season: meta.season, episode: meta.episode, type: meta.type, duration: getDuration(full), addedAt: new Date().toISOString() });
      }
    }
  }
  await walk(dirPath); return items;
}

async function fetchPlex(lib) {
  const base = lib.url.replace(/\/+$/, '');
  const headers = { 'X-Plex-Token': lib.token, 'Accept': 'application/json' };
  const items = [];
  const sectRes = await fetchUrl(`${base}/library/sections`, { headers });
  const sectData = await sectRes.json();
  let sections = sectData.MediaContainer.Directory || [];
  if (lib.sectionKey) sections = sections.filter(s => String(s.key) === String(lib.sectionKey));
  else sections = sections.filter(s => ['movie','show'].includes(s.type));
  for (const sect of sections) {
    const ep = sect.type === 'show' ? 'allLeaves' : 'all';
    const cntRes = await fetchUrl(`${base}/library/sections/${sect.key}/${ep}?X-Plex-Container-Start=0&X-Plex-Container-Size=0`, { headers });
    const cntData = await cntRes.json();
    const total = parseInt(cntData.MediaContainer.totalSize || cntData.MediaContainer.size || 0);
    for (let start = 0; start < total; start += 100) {
      const pRes = await fetchUrl(`${base}/library/sections/${sect.key}/${ep}?X-Plex-Container-Start=${start}&X-Plex-Container-Size=100`, { headers });
      const pData = await pRes.json();
      for (const m of (pData.MediaContainer.Metadata || [])) {
        const filePath = m.Media?.[0]?.Part?.[0]?.file || '';
        const partKey  = m.Media?.[0]?.Part?.[0]?.key  || '';
        const streamUrl = partKey ? `${base}${partKey}?X-Plex-Token=${lib.token}` : null;
        const base_ = { id: uuidv4(), libraryId: lib.id, path: streamUrl||filePath, localPath: filePath, filename: path.basename(filePath), year: m.year||null, duration: Math.floor((m.duration||0)/1000), thumb: m.thumb?`${base}${m.thumb}?X-Plex-Token=${lib.token}`:null, summary: m.summary||'', plexKey: m.ratingKey, sourceType: 'plex', addedAt: new Date().toISOString() };
        if (m.type==='movie') items.push({ ...base_, title: m.title, season: null, episode: null, type: 'movie' });
        else if (m.type==='episode') items.push({ ...base_, title: m.grandparentTitle||m.title, season: m.parentIndex||null, episode: m.index||null, type: 'episode' });
      }
    }
  }
  return items;
}

async function fetchJellyfin(lib) {
  const base = lib.url.replace(/\/+$/, '');
  const headers = { 'X-Emby-Token': lib.token, 'Accept': 'application/json' };
  const parentFilter = lib.parentId ? `&ParentId=${lib.parentId}` : '';
  const res = await fetchUrl(`${base}/Items?IncludeItemTypes=Movie,Episode&Recursive=true${parentFilter}&Fields=Path,RunTimeTicks,Overview,ParentIndexNumber,IndexNumber,ProductionYear,SeriesName&api_key=${lib.token}`, { headers });
  const data = await res.json();
  return (data.Items||[]).map(m => ({
    id: uuidv4(), libraryId: lib.id, path: m.Path||'', filename: path.basename(m.Path||''),
    title: m.Type==='Episode' ? (m.SeriesName||m.Name) : m.Name,
    year: m.ProductionYear||null, season: m.ParentIndexNumber||null, episode: m.IndexNumber||null,
    type: m.Type==='Episode' ? 'episode' : 'movie',
    duration: m.RunTimeTicks ? Math.floor(m.RunTimeTicks/10000000) : 0,
    thumb: m.ImageTags?.Primary ? `${base}/Items/${m.Id}/Images/Primary?api_key=${lib.token}` : null,
    summary: m.Overview||'', jellyfinId: m.Id, addedAt: new Date().toISOString(),
  }));
}

// ── Playout engine ────────────────────────────────────────────────────────────
function resolveSource(item) {
  if (!item) return null;
  if (item.path && (item.path.startsWith('http://') || item.path.startsWith('https://'))) return { type: 'http', value: item.path };
  const lib = sfDb.libraries.find(l => l.id === item.libraryId);
  if (item.jellyfinId && lib?.type==='jellyfin') return { type: 'http', value: `${lib.url.replace(/\/+$/,'')}/Videos/${item.jellyfinId}/stream?Static=true&api_key=${lib.token}` };
  if (item.plexKey && lib?.type==='plex') return { type: 'http', value: `${lib.url.replace(/\/+$/,'')}/library/metadata/${item.plexKey}/file?download=0&X-Plex-Token=${lib.token}` };
  if (item.path) return { type: 'file', value: item.path };
  return null;
}

function getPlayoutNow(ch, nowMs) {
  if (!ch.liveStreamId) {
    try { const r = playoutEngine.getNowPlaying(ch.id); if (r) return r; } catch (e) {}
  }
  return _getPlayoutNowOld(ch, nowMs);
}
function _getPlayoutNowOld(ch, nowMs) {
  if (ch.liveStreamId) {
    const stream = getSfStream(ch.liveStreamId);
    if (stream) return { item: null, stream, block: { streamId: ch.liveStreamId }, offsetSeconds: 0, startTime: nowMs, endTime: nowMs + 86400000, isLive: true };
  }
  // Series rotation — season-per-day cycling through a show in order
  if (ch.seriesSchedule?.episodes?.length) {
    const { episodes } = ch.seriesSchedule;
    // Group by season, sorted
    const bySeasonMap = {};
    episodes.forEach(ep => {
      const s = ep.season || 1;
      if (!bySeasonMap[s]) bySeasonMap[s] = [];
      bySeasonMap[s].push(ep);
    });
    const seasonNums = Object.keys(bySeasonMap).map(Number).sort((a,b)=>a-b);
    seasonNums.forEach(s => bySeasonMap[s].sort((a,b)=>(a.episode||0)-(b.episode||0)));

    const anchor = ch.playoutStart
      ? (new Date(ch.playoutStart).getTime() || 0)
      : new Date(new Date().toISOString().slice(0,10)+'T00:00:00Z').getTime();

    const DAY_MS = 86400000;
    const dayOffset = Math.floor((nowMs - anchor) / DAY_MS);
    const seasonIndex = dayOffset % seasonNums.length;
    const currentSeasonNum = seasonNums[seasonIndex];
    const seasonEps = bySeasonMap[currentSeasonNum];
    if (!seasonEps?.length) return null;

    const dayStart = anchor + dayOffset * DAY_MS;
    const timeInDay = nowMs - dayStart;

    // Total duration of this season (loop within the day)
    const seasonDurMs = seasonEps.reduce((s, ep) => {
      let item = getMediaById(ep.mediaId);
      if (!item && ep.season != null && ep.episode != null) {
        const showTitle = (ch.seriesSchedule?.showTitle || ch.name || '').toLowerCase().replace(/[^a-z0-9]/g,' ').trim();
        item = getMediaCombined().find(m =>
          m.season === ep.season && m.episode === ep.episode &&
          (m.seriesTitle||m.showName||m.title||m.filename||'').toLowerCase().includes(showTitle.split(' ')[0])
        );
      }
      return s + ((ep.duration || item?.duration || 1800) * 1000);
    }, 0);
    if (!seasonDurMs) return null;

    const timeInCycle = timeInDay % seasonDurMs;
    let cursor = 0;
    for (const ep of seasonEps) {
      let item = getMediaById(ep.mediaId);
      // Fallback: find by show title + season + episode if ID changed after DB rebuild
      if (!item && ep.season != null && ep.episode != null) {
        const showTitle = (ch.seriesSchedule?.showTitle || ch.name || '').toLowerCase().replace(/[^a-z0-9]/g,' ').trim();
        item = getMediaCombined().find(m =>
          m.season === ep.season && m.episode === ep.episode &&
          (m.seriesTitle||m.showName||m.title||m.filename||'').toLowerCase().includes(showTitle.split(' ')[0])
        );
      }
      // Use ep.duration from schedule as source of truth — item.duration from DB may be wrong
      const dur = (ep.duration || item?.duration || 1800) * 1000;
      if (timeInCycle < cursor + dur) {
        const loopStart = dayStart + Math.floor(timeInDay / seasonDurMs) * seasonDurMs;
        const rawOffset = Math.floor((timeInCycle - cursor) / 1000);
        const maxOffset = Math.max(0, Math.floor(dur/1000) - 60); // cap 60s before end
        const offsetSeconds = Math.min(rawOffset, maxOffset);
        return { item, block: ep, offsetSeconds, startTime: loopStart + cursor, endTime: loopStart + cursor + dur };
      }
      cursor += dur;
    }
  }

  // Library loop — play all items from a library in order, looping continuously
  if (ch.libraryLoop?.libraryId) {
    const { libraryId, shuffle } = ch.libraryLoop;
    let items = getMediaCombined().filter(m => m.libraryId === libraryId);
    console.log(`[SF/LibraryLoop] ch="${ch.name}" libraryId=${libraryId} items=${items.length}`);
    if (!items.length) { console.warn(`[SF/LibraryLoop] No items found for libraryId="${libraryId}"`); return null; }
    // Sort: movies/music by title, episodes by season+episode
    if (!shuffle) {
      items = items.slice().sort((a,b) => {
        if (a.season != null && b.season != null) return a.season !== b.season ? a.season-b.season : (a.episode||0)-(b.episode||0);
        return (a.title||'').localeCompare(b.title||'');
      });
    }
    const totalDurMs = items.reduce((s,m) => s+(m.duration||180)*1000, 0);
    if (!totalDurMs) return null;
    const anchor = ch.playoutStart ? new Date(ch.playoutStart).getTime() : new Date(new Date().toISOString().slice(0,10)+'T00:00:00Z').getTime();
    const elapsed = (nowMs - anchor) % totalDurMs;
    let cursor = 0;
    for (const item of items) {
      const dur = (item.duration||180)*1000;
      if (elapsed < cursor+dur) {
        const offsetSeconds = Math.floor((elapsed-cursor)/1000);
        const loopStart = anchor + Math.floor((nowMs-anchor)/totalDurMs)*totalDurMs;
        return { item, block:{mediaId:item.id}, offsetSeconds, startTime:loopStart+cursor, endTime:loopStart+cursor+dur };
      }
      cursor += dur;
    }
  }

  // Genre/Network/Collection loop — play all items matching a tag
  // Support both single genreLoop and array genreLoops
  const genreLoopList = ch.genreLoops?.length ? ch.genreLoops : (ch.genreLoop?.genre ? [ch.genreLoop] : []);
  if (genreLoopList.length > 0) {
    const getItemsForLoop = (loop) => {
      const { genre, mediaType, matchType } = loop;
      const g = genre.toLowerCase();
      let items;
      if (matchType === 'network') {
        const idx = getNetworkIndex();
        items = idx.get(g) || [];
        if (!items.length) {
          const arr = [];
          for (const [k,v] of idx.entries()) { if (k.includes(g) || g.includes(k)) arr.push(...v); }
          items = arr;
        }
        if (mediaType === 'movie') items = items.filter(m => m.type === 'movie');
        if (mediaType === 'episode') items = items.filter(m => m.type === 'episode' || m.season != null);
      } else {
        items = getMediaCombined().filter(m => {
          if (m.libraryId === 'orion-music') return false;
          if (mediaType === 'movie' && m.type !== 'movie') return false;
          if (mediaType === 'episode' && m.type !== 'episode') return false;
          if (m.path === '' && !m.jellyfinId && !m.plexKey) return false;
          const genres = (m.genres||[]).map(x=>x.toLowerCase());
          return genres.some(gn => gn.includes(g) || g.includes(gn)) ||
                 m.title?.toLowerCase().includes(g) || m.summary?.toLowerCase().includes(g);
        });
      }
      return items;
    };
    // Merge items from all loops, deduplicate by id
    const seenIds = new Set();
    let items = [];
    for (const loop of genreLoopList) {
      for (const item of getItemsForLoop(loop)) {
        if (!seenIds.has(item.id)) { seenIds.add(item.id); items.push(item); }
      }
    }
    console.log('[SF/GenreLoop] ch="'+ch.name+'" loops='+genreLoopList.length+' items='+items.length);
    if (!items.length) return null;
    // Sort episodes by season/episode, movies by year/title
    items = items.sort((a,b) => {
      if (a.season != null && b.season != null) return ((a.season*1000)+(a.episode||0))-((b.season*1000)+(b.episode||0));
      return (a.title||'').localeCompare(b.title||'');
    });
    const totalDurMs = items.reduce((s,m) => s+(m.duration||1800)*1000, 0);
    if (!totalDurMs) return null;
    const anchor = ch.playoutStart ? new Date(ch.playoutStart).getTime() : new Date(new Date().toISOString().slice(0,10)+'T00:00:00Z').getTime();
    const elapsed = (nowMs-anchor) % totalDurMs;
    let cursor = 0;
    for (const item of items) {
      // Use 90% of stored duration as effective duration — guards against DB runtime being longer than actual file
      const storedDur = (item.duration||1800)*1000;
      const effectiveDur = Math.floor(storedDur * 0.90); // assume file may be 10% shorter than DB says
      if (elapsed < cursor+effectiveDur) {
        const loopStart = anchor+Math.floor((nowMs-anchor)/totalDurMs)*totalDurMs;
        const rawOfs = Math.floor((elapsed-cursor)/1000);
        const offsetSeconds = Math.min(rawOfs, Math.floor(effectiveDur/1000) - 30);
        return { item, block:{mediaId:item.id}, offsetSeconds, startTime:loopStart+cursor, endTime:loopStart+cursor+storedDur };
      }
      cursor += effectiveDur;
    }
  }

  // Time blocks
  const blocks = ch.timeBlocks || [];
  if (blocks.length) {
    const now = new Date(nowMs); const dayOfWeek = now.getDay(); const todayMins = now.getHours()*60+now.getMinutes();
    for (const tb of blocks) {
      const days = tb.days || [0,1,2,3,4,5,6];
      if (!days.includes(dayOfWeek)) continue;
      const [sh,sm] = (tb.startTime||'00:00').split(':').map(Number);
      const startMins = sh*60+sm, endMins = startMins+(tb.duration||60);
      if (todayMins >= startMins && todayMins < endMins) {
        const stream = getSfStream(tb.streamId);
        if (stream) { const midnight = new Date(now).setHours(0,0,0,0); return { item: null, stream, block: tb, offsetSeconds: 0, startTime: midnight+startMins*60000, endTime: midnight+endMins*60000, isLive: true }; }
      }
    }
  }
  const playout = ch.playout || []; if (!playout.length) return null;
  const totalDuration = playout.reduce((s, b) => { if (b.streamId) return s+(b.duration||3600); const item = getMediaById(b.mediaId); return s+(item?(item.duration||1800):1800); }, 0);
  if (!totalDuration) return null;
  let anchor = ch.playoutStart ? (new Date(ch.playoutStart).getTime()||0) : new Date(new Date().toISOString().slice(0,10)+'T00:00:00Z').getTime();
  const elapsed = (nowMs-anchor) % (totalDuration*1000);
  let cursor = 0;
  for (const block of playout) {
    if (block.streamId) { const stream = getSfStream(block.streamId); const dur=(block.duration||3600)*1000; if (elapsed < cursor+dur) { const st = anchor+Math.floor((nowMs-anchor)/(totalDuration*1000))*totalDuration*1000+cursor; return { item:null, stream, block, offsetSeconds:0, startTime:st, endTime:st+dur, isLive:true }; } cursor+=dur; continue; }
    let item = getMediaById(block.mediaId);
    // Fallback: search by title if ID lookup fails (IDs can change after DB rebuild)
    if (!item && block.title) {
      const bt = block.title.toLowerCase();
      // Try exact episode/movie title match first
      item = getMediaCombined().find(m => (m.episodeTitle||m.title||'').toLowerCase() === bt);
      // Then try series title match — picks first episode of matching show
      if (!item) item = getMediaCombined().find(m => (m.seriesTitle||m.showName||m.series||'').toLowerCase() === bt);
      // Then try partial match
      if (!item) item = getMediaCombined().find(m =>
        (m.title||'').toLowerCase().includes(bt) ||
        (m.seriesTitle||m.showName||'').toLowerCase().includes(bt)
      );
    }
    if (!item) { cursor += 1800*1000; continue; }
    const dur = (item.duration||1800)*1000;
    if (elapsed < cursor+dur) { const ofs=Math.floor((elapsed-cursor)/1000); const st=anchor+Math.floor((nowMs-anchor)/(totalDuration*1000))*totalDuration*1000+cursor; return { item, block, offsetSeconds:ofs, startTime:st, endTime:st+dur }; }
    cursor += dur;
  }
  return null;
}

function buildSchedule(ch, fromMs, toMs) {
  if (ch.liveStreamId) return _buildScheduleOld(ch, fromMs, toMs);
  try {
    const progs = ensureChannelSchedule(ch, false);
    if (progs && progs.length) {
      return progs.filter(p => p.end > fromMs && p.start < toMs);
    }
  } catch (e) { console.warn('[SF] ensureChannelSchedule failed: ' + e.message); }
  try { const r = playoutEngine.getSchedule(ch.id, fromMs, toMs); if (r && r.length) return r; } catch (e) {}
  return _buildScheduleOld(ch, fromMs, toMs);
}

// [PATCHED] Rotation+TimeBlock schedule builder for custom channels.
// Walks 30-min slots. TimeBlocks take precedence; rotation pool fills the rest.
// Looks up real episodes from orionDb.tvShows so EPG has full episode info.

// [PATCHED PERSISTSCHED] Single source of truth: generate schedule with GUID references,
// persist to channel, and both EPG + playout read from it. No more drift.

// [PATCHED ALLFORMATS] Format-specific schedule builders

function _ps_getAllMedia() {
  try {
    if (typeof getMediaCombined === 'function') return getMediaCombined();
  } catch {}
  const a = [];
  if (orionDb) {
    if (Array.isArray(orionDb.tvShows)) for (const x of orionDb.tvShows) a.push(x);
    if (Array.isArray(orionDb.movies)) for (const x of orionDb.movies) a.push(x);
    if (Array.isArray(orionDb.musicVideos)) for (const x of orionDb.musicVideos) a.push(x);
    if (Array.isArray(orionDb.music)) for (const x of orionDb.music) a.push(x);
  }
  return a;
}

function _ps_seededShuffle(arr, seedStr) {
  const out = arr.slice();
  let s = String(seedStr||'').split('').reduce((a,c)=>a + c.charCodeAt(0), 1);
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 9301 + 49297) % 233280;
    const j = Math.floor((s / 233280) * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function _ps_makeProgram(t, end, item, fallbackTitle) {
  if (!item) return null;
  const fp = item.path || item.filePath;
  if (!fp) return null;
  const titleStr = item.seriesTitle && item.season != null
    ? `${item.seriesTitle} S${String(item.season).padStart(2,'0')}E${String(item.episode||0).padStart(2,'0')}${item.episodeTitle ? ' — ' + item.episodeTitle : ''}`
    : (item.title || fallbackTitle || '');
  return {
    start: t,
    end,
    mediaId: item.id || null,
    filePath: fp,
    duration: item.duration || Math.floor((end-t)/1000),
    title: titleStr,
    desc: item.summary || '',
    icon: item.thumb || '',
    season: item.season,
    episode: item.episode,
    seriesTitle: item.seriesTitle,
    episodeTitle: item.episodeTitle || '',
  };
}

// Format: seriesSchedule.episodes (pre-computed single-show schedule list)
function _ps_buildEpisodeListSchedule(ch, fromMs, toMs) {
  const eps = (ch.seriesSchedule || {}).episodes || [];
  if (!eps.length) return [];
  const allMedia = _ps_getAllMedia();
  const _norm = v => String(v||'').toLowerCase().replace(/[^a-z0-9]/g,'');
  const byId = new Map();
  const bySeriesEp = new Map();
  const showTitle = (ch.seriesSchedule || {}).showTitle || '';
  for (const m of allMedia) {
    if (m.id) byId.set(m.id, m);
    // Media records store the show name in title; seriesTitle is not
    // populated by the scanner. Indexing only on seriesTitle left this
    // map empty, so the stale-id fallback below never matched anything.
    const _st = m.seriesTitle || m.title;
    if (_st && m.season != null && m.episode != null) {
      const k = _norm(_st) + '|' + m.season + '|' + m.episode;
      if (!bySeriesEp.has(k)) bySeriesEp.set(k, m);
    }
  }
  const programs = [];
  let t = fromMs, idx = 0, safety = 0;
  let primaryHits = 0, secondaryHits = 0, missed = 0;
  while (t < toMs && safety++ < 20000) {
    const ref = eps[idx % eps.length]; idx++;
    // [STALE-FIX] Primary lookup by mediaId. If stale (library rescanned, new IDs), recover by (showTitle, season, episode).
    let full = ref.mediaId && byId.get(ref.mediaId);
    if (full) primaryHits++;
    if (!full && ref.season != null && ref.episode != null && showTitle) {
      const k = _norm(showTitle) + '|' + ref.season + '|' + ref.episode;
      full = bySeriesEp.get(k);
      if (full) secondaryHits++;
    }
    if (!full) { missed++; t += 1800000; continue; }
    const dur = (full.duration || ref.duration || 1800) * 1000;
    const end = Math.min(t + dur, toMs);
    const p = _ps_makeProgram(t, end, full, ch.name);
    if (p) programs.push(p);
    t = end;
  }
  if (secondaryHits || missed) console.log('[SF] ' + ch.name + ' episode-list: primary=' + primaryHits + ' secondary=' + secondaryHits + ' missed=' + missed);
  return programs;
}

// Format: playout array (manual playlist of mediaIds and/or streamIds)
// [PATCHED] Secondary-key fallback: if mediaId is stale (re-import), parse title for S/E and look up by (series, season, episode)
function _ps_buildPlayoutSchedule(ch, fromMs, toMs) {
  const playout = ch.playout || [];
  if (!playout.length) return [];
  const allMedia = _ps_getAllMedia();
  const _norm = v => String(v||'').toLowerCase().replace(/[^a-z0-9]/g,'');
  const byId = new Map();
  for (const m of allMedia) {
    if (m.id) byId.set(m.id, m);
  }
  // [PATCHED RAWTV] Secondary-key index from raw orionDb.tvShows.
  // getMediaCombined() strips seriesTitle/season/episode for some entries,
  // so we MUST use raw data here. byId still uses combined to allow stale-id matching.
  const bySeriesEp = new Map();
  const _rawTV = (orionDb && Array.isArray(orionDb.tvShows)) ? orionDb.tvShows : [];
  for (const m of _rawTV) {
    const _st2 = m.seriesTitle || m.title;
    if (_st2 && m.season != null && m.episode != null) {
      if (!(m.path || m.filePath)) continue;
      const k = _norm(m.seriesTitle || m.title) + '|' + m.season + '|' + m.episode;
      if (!bySeriesEp.has(k)) bySeriesEp.set(k, m);
      // Also index raw items by id so byId can resolve them too (in case getMediaCombined lacks them)
      if (m.id && !byId.has(m.id)) byId.set(m.id, m);
    }
  }
  const SE_RE = /(.+?)\s+[Ss](\d{1,2})[Ee](\d{1,2})\s*$/;

  // [PATCHED FALLBACK] Build per-show episode lists for round-robin fallback
  // when a specific S/E doesn't exist (e.g., E00 placeholders, missing imports).
  const byShow = new Map();
  for (const m of _rawTV) {
    if (!m.seriesTitle) continue;
    if (!(m.path || m.filePath)) continue;
    if (m.season == null || m.episode == null) continue;
    const k = _norm(m.seriesTitle);
    if (!byShow.has(k)) byShow.set(k, []);
    byShow.get(k).push(m);
  }
  for (const arr of byShow.values()) {
    arr.sort((a,b)=> (a.season-b.season) || (a.episode-b.episode));
  }
  const showCursor = {};
  function pickAnyForShow(showNorm) {
    const arr = byShow.get(showNorm);
    if (!arr || !arr.length) return null;
    const idx = (showCursor[showNorm] || 0) % arr.length;
    showCursor[showNorm] = idx + 1;
    return arr[idx];
  }
  let fallback = 0;

  function resolveBlock(block) {
    if (block.mediaId && byId.has(block.mediaId)) return byId.get(block.mediaId);
    const title = block.title || '';
    const m = title.match(SE_RE);
    if (m) {
      const show = m[1].trim();
      const season = parseInt(m[2], 10);
      const episode = parseInt(m[3], 10);
      const showNorm = _norm(show);
      const k = showNorm + '|' + season + '|' + episode;
      if (bySeriesEp.has(k)) return bySeriesEp.get(k);
      // [PATCHED FALLBACK] Exact S/E not found — round-robin from this show's episodes.
      const any = pickAnyForShow(showNorm);
      if (any) { fallback++; return any; }
    }
    return null;
  }
  const programs = [];
  let t = fromMs, idx = 0, safety = 0;
  let primary = 0, secondary = 0, missed = 0;
  while (t < toMs && safety++ < 20000) {
    const block = playout[idx % playout.length]; idx++;
    if (block.streamId) {
      const dur = (block.duration || 3600) * 1000;
      const end = Math.min(t + dur, toMs);
      programs.push({ start: t, end, mediaId: null, filePath: null,
        duration: block.duration||3600, title: '🔴 Live', desc: '', icon: '' });
      t = end; continue;
    }
    let item = null;
    if (block.mediaId && byId.has(block.mediaId)) { item = byId.get(block.mediaId); primary++; }
    else { item = resolveBlock(block); if (item) secondary++; else missed++; }
    if (!item) { t += 1800000; continue; }
    const dur = (item.duration || block.duration || 1800) * 1000;
    const end = Math.min(t + dur, toMs);
    const p = _ps_makeProgram(t, end, item, block.title || ch.name);
    if (p) programs.push(p);
    t = end;
  }
  if (programs.length) console.log('[SF] playout schedule "' + ch.name + '": ' + programs.length + ' programs (primary=' + primary + ', secondary=' + secondary + ', fallback=' + fallback + ', missed=' + missed + ')');
  return programs;
}

// Format: libraryLoop (entire library, optional shuffle)
function _ps_buildLibraryLoopSchedule(ch, fromMs, toMs) {
  const ll = ch.libraryLoop || {};
  if (!ll.libraryId) return [];
  let items = _ps_getAllMedia().filter(m => m.libraryId === ll.libraryId);
  if (!items.length) return [];
  if (ll.shuffle) items = _ps_seededShuffle(items, ch.id);
  const programs = [];
  let t = fromMs, idx = 0, safety = 0;
  while (t < toMs && safety++ < 20000) {
    const item = items[idx % items.length]; idx++;
    if (!(item.path || item.filePath)) { t += 1800000; continue; }
    const dur = (item.duration || 1800) * 1000;
    const end = Math.min(t + dur, toMs);
    const p = _ps_makeProgram(t, end, item, ch.name);
    if (p) programs.push(p);
    t = end;
  }
  return programs;
}

// Format: genreLoop (filter library by genre + mediaType)
function _ps_buildGenreLoopSchedule(ch, fromMs, toMs) {
  const gl = ch.genreLoop || {};
  if (!gl.genre) return [];
  const targetGenre = String(gl.genre).toLowerCase();
  const targetType = gl.mediaType ? String(gl.mediaType).toLowerCase() : null;
  let items = _ps_getAllMedia().filter(m => {
    if (targetType && String(m.type||'').toLowerCase() !== targetType) return false;
    const genres = m.genres || [];
    return Array.isArray(genres) && genres.some(g => String(g).toLowerCase().includes(targetGenre));
  });
  if (!items.length) return [];
  items = _ps_seededShuffle(items, ch.id);
  const programs = [];
  let t = fromMs, idx = 0, safety = 0;
  while (t < toMs && safety++ < 20000) {
    const item = items[idx % items.length]; idx++;
    if (!(item.path || item.filePath)) { t += 1800000; continue; }
    const dur = (item.duration || 1800) * 1000;
    const end = Math.min(t + dur, toMs);
    const p = _ps_makeProgram(t, end, item, ch.name);
    if (p) programs.push(p);
    t = end;
  }
  return programs;
}

function generateChannelSchedule(ch, fromMs, toMs) {
  const tbs = Array.isArray(ch.timeBlocks) ? ch.timeBlocks : [];
  const rotation = (ch.seriesSchedule && Array.isArray(ch.seriesSchedule.showTitles))
                   ? ch.seriesSchedule.showTitles.slice() : [];
  // [PATCHED ALLFORMATS] Dispatch to format-specific builders when not rotation/timeBlock
  if (!tbs.length && !rotation.length) {
    if (ch.seriesSchedule && Array.isArray(ch.seriesSchedule.episodes) && ch.seriesSchedule.episodes.length > 1) {
      return _ps_buildEpisodeListSchedule(ch, fromMs, toMs);
    }
    if (Array.isArray(ch.playout) && ch.playout.length) {
      return _ps_buildPlayoutSchedule(ch, fromMs, toMs);
    }
    if (ch.libraryLoop && ch.libraryLoop.libraryId) {
      return _ps_buildLibraryLoopSchedule(ch, fromMs, toMs);
    }
    if (ch.genreLoop && ch.genreLoop.genre) {
      return _ps_buildGenreLoopSchedule(ch, fromMs, toMs);
    }
    return [];
  }

  const norm = v => String(v||'').toLowerCase().replace(/[^a-z0-9]/g,'');
  const tvShows = (orionDb && Array.isArray(orionDb.tvShows)) ? orionDb.tvShows : [];

  const showIndex = new Map();
  for (const it of tvShows) {
    const st = it.seriesTitle || it.showName || '';
    if (!st) continue;
    const p = it.path || it.filePath || '';
    if (!p) continue;
    // [ROTFIX] Tolerate missing season/episode by falling back to seasonNum + filename parse
    let _season = it.season;
    if (_season == null) _season = it.seasonNum;
    let _episode = it.episode;
    if (_episode == null) {
      const m = (it.fileName || it.filePath || '').match(/[Ss]\d{1,3}[Ee](\d{1,3})/);
      if (m) _episode = parseInt(m[1]);
    }
    if (_season == null && _episode == null) {
      // also try filename for both
      const m = (it.fileName || it.filePath || '').match(/[Ss](\d{1,3})[Ee](\d{1,3})/);
      if (m) { _season = parseInt(m[1]); _episode = parseInt(m[2]); }
    }
    if (_season == null || _episode == null) continue;
    // Annotate item with resolved values so downstream code (sort, lookup) works
    it.season = _season;
    it.episode = _episode;
    const k = norm(st);
    if (!showIndex.has(k)) showIndex.set(k, []);
    showIndex.get(k).push(it);
  }
  console.log("[DEBUG-ROT] ch=" + ch.name + " showIdxSize=" + showIndex.size + " animaniacs=" + ((showIndex.get("animaniacs")||[]).length) + " teentitansgo=" + ((showIndex.get("teentitansgo")||[]).length) + " phineasandferb=" + ((showIndex.get("phineasandferb")||[]).length));
  for (const arr of showIndex.values()) {
    arr.sort((a,b)=> (a.season-b.season) || (a.episode-b.episode));
  }

  function getEpisodes(seriesTitle) {
    const target = norm(seriesTitle);
    if (showIndex.has(target)) return showIndex.get(target);
    for (const [k, v] of showIndex.entries()) {
      if (k.startsWith(target) || target.startsWith(k)) return v;
    }
    return [];
  }

  function tbApplies(tb, date) {
    const dow = date.getDay();
    const days = String(tb.daysOfWeek || 'daily').toLowerCase();
    if (days === 'daily') return true;
    if (days === 'weekdays') return dow >= 1 && dow <= 5;
    if (days === 'weekends') return dow === 0 || dow === 6;
    const dayMap = { sun:0,mon:1,tue:2,wed:3,thu:4,fri:5,sat:6,
                     sunday:0,monday:1,tuesday:2,wednesday:3,thursday:4,friday:5,saturday:6 };
    return days.split(',').map(x => x.trim()).some(d => dayMap[d] === dow);
  }

  function timeStr(date) {
    return String(date.getHours()).padStart(2,'0') + ':' + String(date.getMinutes()).padStart(2,'0');
  }

  const programs = [];
  const slotMs = 30 * 60 * 1000;
  let rotIdx = 0;
  const epCursor = {};
  let lastShowKey = null;
  let lastResyncDay = null;  // [3AMRESYNC] tracks last day we re-synced

  let t = fromMs;
  let safety = 0;
  while (t < toMs && safety++ < 10000) {
    const date = new Date(t);
    const cur = timeStr(date);

    let pickedShow = null;
    for (const tb of tbs) {
      if (!tbApplies(tb, date)) continue;
      if (tb.start && tb.end && tb.start <= cur && cur < tb.end) {
        pickedShow = tb.showTitle; break;
      }
    }
    if (!pickedShow && rotation.length) {
      let tries = 0;
      do {
        pickedShow = rotation[rotIdx % rotation.length];
        rotIdx++;
        tries++;
      } while (norm(pickedShow) === lastShowKey && tries < rotation.length);
    }
    if (!pickedShow) { t += slotMs; continue; }

    const eps = getEpisodes(pickedShow);
    let ep = null;
    if (eps.length) {
      const k = norm(pickedShow);
      epCursor[k] = (epCursor[k] || 0);
      ep = eps[epCursor[k] % eps.length];
      epCursor[k]++;
    }

    const durSec = (ep && ep.duration) ? ep.duration : 1800;
    // [PATCHED 3AMRESYNC] Use ACTUAL duration. No minimum slot. Continuous back-to-back.
    const durMs = durSec * 1000;
    const end = Math.min(t + durMs, toMs);

    const titleStr = ep
      ? (ep.seriesTitle
          ? `${ep.seriesTitle} S${String(ep.season||0).padStart(2,'0')}E${String(ep.episode||0).padStart(2,'0')}${ep.episodeTitle ? ' — ' + ep.episodeTitle : ''}`
          : (ep.title || pickedShow))
      : pickedShow;

    programs.push({
      start: t,
      end,
      mediaId: ep ? ep.id : null,
      filePath: ep ? (ep.path || ep.filePath) : null,
      duration: durSec,
      title: titleStr,
      desc: (ep && ep.summary) || '',
      icon: (ep && ep.thumb) || '',
      season: ep ? ep.season : null,
      episode: ep ? ep.episode : null,
      seriesTitle: ep ? ep.seriesTitle : pickedShow,
      episodeTitle: ep ? ep.episodeTitle : '',
      showTitle: pickedShow,
    });

    lastShowKey = norm(pickedShow);
    t = end;

    // [3AMRESYNC] Once per day at 3am, if drifted off slot boundary, pad with dead air to next slot
    const _d = new Date(t);
    const _dayKey = _d.getFullYear() + '-' + (_d.getMonth()+1) + '-' + _d.getDate();
    if (lastResyncDay !== _dayKey && _d.getHours() === 3) {
      const aligned = Math.ceil(t / slotMs) * slotMs;
      if (aligned > t) {
        programs.push({
          start: t,
          end: aligned,
          mediaId: null,
          filePath: null,
          duration: Math.floor((aligned - t) / 1000),
          title: '— Programming Adjustment —',
          desc: 'Schedule re-syncs at ' + new Date(aligned).toLocaleTimeString('en-US', {hour:'2-digit',minute:'2-digit'}),
          icon: '',
          season: null,
          episode: null,
          seriesTitle: '',
          episodeTitle: '',
          showTitle: '',
        });
        t = aligned;
      }
      lastResyncDay = _dayKey;
    }
  }
  return programs;
}

function ensureChannelSchedule(ch, force) {
  const now = Date.now();
  const horizonDays = 7;
  const horizonMs = horizonDays * 86400 * 1000;
  const stale = !ch.scheduledPrograms
              || !Array.isArray(ch.scheduledPrograms)
              || !ch.scheduledPrograms.length
              || !ch.scheduledProgramsGeneratedAt
              || (now - (ch.scheduledProgramsGeneratedAt||0) > 12 * 3600 * 1000)
              || (ch.scheduledPrograms[ch.scheduledPrograms.length-1].end < now + 24 * 3600 * 1000);
  // Respect the back-off from a previous empty build.
  if (!force && ch._emptyScheduleAt && (now - ch._emptyScheduleAt) < 600000) {
    return ch.scheduledPrograms || [];
  }

  if (!force && !stale) return ch.scheduledPrograms;
  const fromMs = now;
  const toMs = now + horizonMs;
  const progs = generateChannelSchedule(ch, fromMs, toMs);

  // A build that produces nothing leaves scheduledPrograms empty, which
  // the staleness check above treats as stale — so the next request
  // regenerates, gets nothing again, and calls saveAll() on a 2 MB file
  // each time. That loop is what stalled segment delivery. Record the
  // attempt so an empty result backs off instead of retrying immediately.
  if (!progs.length) {
    ch.scheduledProgramsGeneratedAt = now;
    ch._emptyScheduleAt = now;
    console.warn('[SF] "' + ch.name + '" generated 0 programs — ' +
      'not retrying for 10 minutes. Check the episode list and media ids.');
    return ch.scheduledPrograms || [];
  }

  ch.scheduledPrograms = progs;
  ch.scheduledProgramsGeneratedAt = now;
  ch._emptyScheduleAt = 0;
  saveAll();
  console.log('[SF] regenerated schedule for "' + ch.name + '": ' + progs.length + ' programs over ' + horizonDays + ' days');
  return progs;
}

function _buildScheduleRotation(ch, fromMs, toMs) {
  const tbs = Array.isArray(ch.timeBlocks) ? ch.timeBlocks : [];
  const rotation = (ch.seriesSchedule && Array.isArray(ch.seriesSchedule.showTitles))
                   ? ch.seriesSchedule.showTitles.slice() : [];
  if (!tbs.length && !rotation.length) return [];

  // Normalize for matching
  const norm = v => String(v||'').toLowerCase().replace(/[^a-z0-9]/g,'');
  const tvShows = (orionDb && Array.isArray(orionDb.tvShows)) ? orionDb.tvShows : [];

  // Build show->episodes index once
  // [ROTFIX2] Tolerate missing season/episode by falling back to seasonNum + filename parse
  const showIndex = new Map();
  for (const it of tvShows) {
    const st = it.seriesTitle || it.showName || '';
    if (!st) continue;
    let _season = it.season;
    if (_season == null) _season = it.seasonNum;
    let _episode = it.episode;
    // [REPEAT-FIX] Parse season AND episode from filename whenever EITHER is missing.
    // Previous logic required BOTH null, so an episode whose DB record had episode set but season null
    // would be skipped — collapsing shows to whatever single episode had full metadata, looping forever.
    if (_season == null || _episode == null) {
      const m = (it.fileName || it.filePath || '').match(/[Ss](\d{1,3})[Ee](\d{1,3})/);
      if (m) {
        if (_season == null) _season = parseInt(m[1]);
        if (_episode == null) _episode = parseInt(m[2]);
      }
    }
    if (_season == null || _episode == null) continue;
    it.season = _season;
    it.episode = _episode;
    const k = norm(st);
    if (!showIndex.has(k)) showIndex.set(k, []);
    showIndex.get(k).push(it);
  }
  console.log("[DEBUG-ROT] ch=" + ch.name + " showIdxSize=" + showIndex.size + " animaniacs=" + ((showIndex.get("animaniacs")||[]).length) + " teentitansgo=" + ((showIndex.get("teentitansgo")||[]).length) + " phineasandferb=" + ((showIndex.get("phineasandferb")||[]).length));
  for (const arr of showIndex.values()) {
    arr.sort((a,b)=> (a.season-b.season) || (a.episode-b.episode));
  }

  function getEpisodes(seriesTitle) {
    const target = norm(seriesTitle);
    if (showIndex.has(target)) return showIndex.get(target);
    // Try prefix match (handles year suffixes like "Will & Grace (1998)")
    for (const [k, v] of showIndex.entries()) {
      if (k.startsWith(target) || target.startsWith(k)) return v;
    }
    return [];
  }

  function tbApplies(tb, date) {
    const dow = date.getDay(); // 0=Sun, 6=Sat
    const days = String(tb.daysOfWeek || 'daily').toLowerCase();
    if (days === 'daily') return true;
    if (days === 'weekdays') return dow >= 1 && dow <= 5;
    if (days === 'weekends') return dow === 0 || dow === 6;
    const dayMap = { sun:0,mon:1,tue:2,wed:3,thu:4,fri:5,sat:6,
                     sunday:0,monday:1,tuesday:2,wednesday:3,thursday:4,friday:5,saturday:6 };
    const list = days.split(',').map(x => x.trim());
    return list.some(d => dayMap[d] === dow);
  }

  function timeStr(date) {
    return String(date.getHours()).padStart(2,'0') + ':' + String(date.getMinutes()).padStart(2,'0');
  }

  const programs = [];
  const slotMs = 30 * 60 * 1000;
  let rotIdx = 0;
  const epCursor = {}; // per-show round-robin cursor

  let t = fromMs;
  let safety = 0;
  while (t < toMs && safety++ < 5000) {
    const date = new Date(t);
    const cur = timeStr(date);

    // 1) timeBlock match wins
    let pickedShow = null;
    for (const tb of tbs) {
      if (!tbApplies(tb, date)) continue;
      if (tb.start && tb.end && tb.start <= cur && cur < tb.end) {
        pickedShow = tb.showTitle; break;
      }
    }
    // 2) fall back to rotation pool
    if (!pickedShow && rotation.length) {
      pickedShow = rotation[rotIdx % rotation.length];
      rotIdx++;
    }
    if (!pickedShow) { t += slotMs; continue; }

    const eps = getEpisodes(pickedShow);
    let ep = null;
    if (eps.length) {
      const k = norm(pickedShow);
      epCursor[k] = (epCursor[k] || 0);
      ep = eps[epCursor[k] % eps.length];
      epCursor[k]++;
    }

    // Episode duration — default 30 min if unknown
    const durSec = (ep && ep.duration) ? ep.duration : 1800;
    const durMs = Math.max(slotMs, durSec * 1000);
    const end = Math.min(t + durMs, toMs);

    const titleStr = ep
      ? (ep.seriesTitle
          ? `${ep.seriesTitle} S${String(ep.season||0).padStart(2,'0')}E${String(ep.episode||0).padStart(2,'0')}${ep.episodeTitle ? ' — ' + ep.episodeTitle : ''}`
          : (ep.title || pickedShow))
      : pickedShow;

    programs.push({
      start: t,
      end,
      title: titleStr,
      desc: (ep && ep.summary) || '',
      icon: (ep && ep.thumb) || '',
      season: ep ? ep.season : undefined,
      episode: ep ? ep.episode : undefined,
      seriesTitle: ep ? ep.seriesTitle : pickedShow,
    });

    t = end;
  }
  return programs;
}

function _buildScheduleOld(ch, fromMs, toMs) {
  if (ch.liveStreamId) { const s=getSfStream(ch.liveStreamId); return [{start:fromMs,end:toMs,title:s?`🔴 ${s.name}`:'🔴 Live',isLive:true}]; }
  // [PATCHED] Rotation+timeBlock channels — compute EPG from config (don't need running stream)
  if ((ch.seriesSchedule?.showTitles?.length || ch.timeBlocks?.length) && !(ch.playout||[]).length) {
    const r = _buildScheduleRotation(ch, fromMs, toMs);
    if (r && r.length) return r;
  }
  // GenreLoop/collection and series channels — walk through time slots and get what's playing
  if (ch.genreLoops?.length || ch.genreLoop || ch.seriesSchedule?.episodes?.length) {
    const programs = [];
    let t = fromMs;
    let safety = 0;
    while (t < toMs && safety++ < 200) {
      const now = getPlayoutNow(ch, t);
      if (!now || !now.item) { t += 3600000; continue; }
      const start = now.startTime || t;
      const end = now.endTime || (t + (now.item.duration||1800)*1000);
      const title = now.item.seriesTitle
        ? `${now.item.seriesTitle} S${String(now.item.season||0).padStart(2,'0')}E${String(now.item.episode||0).padStart(2,'0')}${now.item.episodeTitle?' — '+now.item.episodeTitle:''}`
        : now.item.title || ch.name;
      programs.push({ start, end, title, desc: now.item.summary||'', icon: now.item.thumb||'', season: now.item.season, episode: now.item.episode, seriesTitle: now.item.seriesTitle });
      t = end + 1000; // move to next slot
    }
    return programs;
  }
  const playout=ch.playout||[]; if (!playout.length) return [];
  const totalDuration = playout.reduce((s,b)=>{if(b.streamId)return s+(b.duration||3600);const item=getMediaById(b.mediaId);return s+(item?(item.duration||1800):1800);},0);
  if (!totalDuration) return [];
  let anchor = ch.playoutStart ? (new Date(ch.playoutStart).getTime()||0) : new Date(new Date().toISOString().slice(0,10)+'T00:00:00Z').getTime();
  const programs=[], loopDurMs=totalDuration*1000;
  let loopStart = anchor+Math.floor((fromMs-anchor)/loopDurMs)*loopDurMs;
  if (loopStart>fromMs) loopStart-=loopDurMs;
  while (loopStart<toMs) {
    let cursor=loopStart;
    for (const block of playout) {
      if (block.streamId) { const s=getSfStream(block.streamId); const durMs=(block.duration||3600)*1000; const st=cursor,en=cursor+durMs; if(en>fromMs&&st<toMs) programs.push({start:st,end:en,title:s?`🔴 ${s.name}`:'🔴 Live',isLive:true}); cursor+=durMs; continue; }
      const item=getMediaById(block.mediaId); if(!item) continue;
      const durMs=(item.duration||1800)*1000; const st=cursor,en=cursor+durMs;
      if(en>fromMs&&st<toMs) programs.push({start:st,end:en,title:item.season?`${item.title} S${String(item.season).padStart(2,'0')}E${String(item.episode||0).padStart(2,'0')}`:item.title,desc:item.summary||'',icon:item.thumb||''});
      cursor+=durMs; if(cursor>=toMs+loopDurMs)break;
    }
    loopStart+=loopDurMs; if(loopStart>toMs)break;
  }
  return programs;
}

// ── GPU allocation ───────────────────────────────────────────────────────────
// Split the cards between background work and live playback so a viewer
// never queues behind a batch job. Derived from detected hardware, so a
// single-GPU machine shares one card rather than reserving its only one.
function _gpuAllocation() {
  let total = 1;
  try { total = require('./capabilities')().gpuCount || 1; } catch (_) {}
  if (sfConfig && parseInt(sfConfig.gpuCount)) {
    total = Math.min(total, parseInt(sfConfig.gpuCount));
  }
  total = Math.max(1, total);

  // Explicit override wins: reservedLiveGpu = -1 disables the reservation.
  const override = sfConfig && sfConfig.reservedLiveGpu;
  if (override !== undefined && override !== null && override !== '') {
    const n = parseInt(override, 10);
    if (n === -1) return { total, live: null, normalizer: [0], preseg: total };
    if (Number.isFinite(n) && n >= 0 && n < total) {
      return {
        total,
        live: n,
        normalizer: [Math.max(0, n - 1)],
        preseg: Math.max(1, n - 1)
      };
    }
  }

  if (total >= 4) {
    // Normalizer gets everything except the live standby card. Preseg
    // shares 0-1 when it is running; the two coexist because each job is
    // pinned to a specific device rather than competing for a pool.
    // Override with sfConfig.normalizerGpus (a count).
    const n = Math.max(1, Math.min(total - 1,
      parseInt(sfConfig && sfConfig.normalizerGpus, 10) || (total - 1)));
    const ids = [];
    for (let i = 0; i < n; i++) ids.push(i);
    return { total, live: total - 1, normalizer: ids, preseg: Math.max(1, total - 2) };
  }
  if (total === 3) {
    return { total, live: 2, normalizer: [1], preseg: 1 };
  }
  if (total === 2) {
    return { total, live: 1, normalizer: [0], preseg: 1 };
  }
  // Single GPU: nothing to reserve.
  return { total, live: null, normalizer: [0], preseg: 1 };
}

// ── Multi-GPU round-robin (for Proxmox + multiple P40s) ──────────────────────
let _nextGpuIdx = 0;
const _gpuWorkerCount = {};
function assignGpu() {
  const _caps = require('./capabilities')();
  const count = Math.max(1, Math.min(
    parseInt(sfConfig.gpuCount) || _caps.gpuCount || 1,
    _caps.gpuCount || 1
  ));
  // Prefer the standby card so a viewer starting a channel lands on an
  // idle GPU instead of queueing behind preseg or normalization. If it is
  // already serving someone, fall through to least-loaded.
  const _alloc = _gpuAllocation();
  if (_alloc.live !== null && (_gpuWorkerCount[_alloc.live] || 0) === 0) {
    _gpuWorkerCount[_alloc.live] = 1;
    return _alloc.live;
  }

  let minLoad = Infinity, bestGpu = 0;
  for (let i = 0; i < count; i++) {
    const load = _gpuWorkerCount[i] || 0;
    if (load < minLoad) { minLoad = load; bestGpu = i; }
  }
  _gpuWorkerCount[bestGpu] = ((_gpuWorkerCount[bestGpu]||0) + 1);
  return bestGpu;
}
function releaseGpu(gpuId) {
  if (_gpuWorkerCount[gpuId] > 0) _gpuWorkerCount[gpuId]--;
}

// ── FFmpeg args builder ───────────────────────────────────────────────────────
function buildFfArgs(src, offsetSeconds, opts={}) {
  const { outputFormat='hls', hlsDir, gpuId=0, quickStart=false, liveSource=false, swFallback=false } = opts;
  // Derive hw from hwEncoder if hwAccel not explicitly set in config
  const hw = sfConfig.hwAccel || (hwEncoder.includes('nvenc') ? 'nvenc' : hwEncoder.includes('amf') ? 'amf' : hwEncoder.includes('qsv') ? 'qsv' : 'cpu');
  const isLiveSrc = src.type === 'http';
  // For file sources: ALWAYS transcode — copy mode breaks HLS timestamps and causes playback issues.
  // For live HTTP sources: copy is handled by the live proxy endpoint; here we still transcode.
  // Only honour 'copy' if the user explicitly wants it for live sources.
  const cfgCodec = sfConfig.videoCodec || 'h264';
  // swFallback: AMF crashed, force libx264
  const vCodec = swFallback ? 'libx264' : ((cfgCodec === 'copy' && !isLiveSrc) ? 'h264' : cfgCodec);
  if (swFallback) console.log('[SF/HLS] Using libx264 software fallback');
  if (cfgCodec === 'copy' && !isLiveSrc) {
    console.log(`[SF/HLS] Overriding copy→h264 for file source (copy breaks HLS timestamps)`);
  }
  const vProfile = sfConfig.videoProfile || 'h264'; // h264 or hevc
  const segSeconds = sfConfig.hlsSegmentSeconds || 1;
  const args = [];

  if (isLiveSrc) {
    args.push('-probesize', '100000', '-analyzeduration', '100000');
    args.push('-re');
  } else {
    args.push('-probesize', '200000', '-analyzeduration', '200000');
    args.push('-re'); // Limit to 1x real-time speed — prevents 2-3x CPU burn on file sources
  }

  // Hardware decode (optional, off by default)
  // Disable hw decode for file sources — filter reinit errors when episodes change resolution
  const isNvenc = hw === 'nvenc' || hwEncoder.includes('nvenc');
  const useHwDecode = (sfConfig.hwDecode === true && isNvenc) && vCodec !== 'copy';
  if (useHwDecode) {
    if (hw === 'nvenc' || hwEncoder.includes('nvenc')) {
      args.push('-hwaccel', 'cuda', '-hwaccel_device', String(gpuId), '-hwaccel_output_format', 'cuda');
    } else if (hw === 'amf' || hwEncoder.includes('amf')) {
      const isLinux = process.platform === 'linux';
      if (isLinux) args.push('-hwaccel', 'vaapi', '-vaapi_device', '/dev/dri/renderD128');
      else args.push('-hwaccel', 'd3d11va');
    } else if (hw === 'qsv' || hwEncoder.includes('qsv')) {
      args.push('-hwaccel', 'qsv');
    } else {
      args.push('-hwaccel', 'auto');
    }
  }

  // Single -fflags combining all needed flags — duplicate -fflags causes FFmpeg to crash
  const fflags = isLiveSrc ? '+genpts+discardcorrupt+nobuffer+fastseek' : '+genpts+discardcorrupt+fastseek';
  args.push('-fflags', fflags, '-err_detect', 'ignore_err');

  // Cap seek offset to actual file duration — prevents FFmpeg exiting with 0 frames
  // when stored duration in DB is longer than the actual file
  if (!isLiveSrc && offsetSeconds > 0 && src.value) {
    try {
      const probeResult = require('child_process').spawnSync(ffprobeExe, [
        '-v', 'error', '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1', src.value
      ], { timeout: 5000, encoding: 'utf8' });
      const fileDuration = parseFloat(probeResult.stdout);
      if (fileDuration > 0 && offsetSeconds >= fileDuration - 30) {
        const actualDur = Math.floor(fileDuration);
        console.warn(`[SF/HLS] Offset ${offsetSeconds}s >= file duration ${actualDur}s for "${src.value.split('/').pop()}" — updating duration cache`);
        // Update media cache with actual duration
        const cachedItem = _mediaById.get(now?.item?.id);
        if (cachedItem) cachedItem.duration = actualDur;
        // Update seriesSchedule episode duration in DB so future calculations are correct
        if (ch?.seriesSchedule?.episodes && now?.item?.id) {
          const ep = ch.seriesSchedule.episodes.find(e => e.mediaId === now.item.id);
          if (ep && ep.duration > actualDur) {
            ep.duration = actualDur;
            // Persist to DB
            const chIdx = sfDb.channels.findIndex(c => c.id === ch.id);
            if (chIdx >= 0) { sfDb.channels[chIdx] = ch; saveAll(); }
          }
        }
        // Calculate corrected offset within actual file duration
        offsetSeconds = offsetSeconds % actualDur;
      }
    } catch {}
  }

  if (!isLiveSrc && offsetSeconds > 10) {
    // Two-pass seek: fast keyframe seek to near target, then short decode-seek
    // Minimizes NAS I/O — only reads a few seconds to find the keyframe
    const preSeek = Math.max(0, offsetSeconds - 10);
    args.push('-ss', String(preSeek));
    args.push('-i', src.value);
    args.push('-ss', '10'); // precise 10s forward from keyframe (CPU only, no NAS I/O)
  } else {
    if (offsetSeconds > 0) args.push('-ss', String(offsetSeconds));
    if (isLiveSrc) args.push('-user_agent', 'Orion/StreamForge FFmpeg');
    args.push('-i', src.value);
  }

  if (sfConfig.audioLanguage && sfConfig.audioLanguage !== 'any') {
    args.push('-map', '0:v:0?', '-map', `0:a:m:language:${sfConfig.audioLanguage}?`, '-map', '0:a:0?');
  } else {
    // Always map video (optional) + first audio — prevents crash on audio-only files
    args.push('-map', '0:v:0?', '-map', '0:a:0?');
  }

  // Live sources: copy mode — no GPU init, starts in <1s
  if (liveSource && outputFormat === 'hls') {
    return [
      '-probesize','500000','-analyzeduration','500000',
      '-fflags','+genpts+discardcorrupt+nobuffer',
      '-err_detect','ignore_err',
      '-re', '-i', src.value,
      '-map','0:v:0','-map','0:a:0?',
      '-vcodec','copy',
      '-acodec','aac','-b:a','192k','-ac','2',
      '-avoid_negative_ts','make_zero',
      '-f','hls',
      '-hls_time','2','-hls_list_size','10',
      '-hls_flags','delete_segments+omit_endlist',
      '-hls_allow_cache','0',
      '-hls_segment_filename',path.join(hlsDir,'seg%05d.ts'),
      path.join(hlsDir,'index.m3u8'),
    ];
  }
  const bitrate    = sfConfig.videoBitrate || '4M';
  const maxBitrate = sfConfig.videoMaxBitrate || '8M';
  const bufSize    = sfConfig.videoBufferSize || '8M';
  const crf = String(sfConfig.videoCrf || 23);
  const res = quickStart ? '854x480' : getAdaptiveResolution();
  const scaleFilter = res && res !== 'source'
    ? (() => { const [w, h] = res.split('x'); return `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`; })()
    : null;
  const cudaScaleFilter = (useHwDecode && (hw === 'nvenc' || hwEncoder.includes('nvenc')) && scaleFilter)
    ? scaleFilter.replace('scale=', 'scale_cuda=') : null;

  const gopSize = segSeconds * 25;
  const forceKf = `expr:gte(t,n_forced*${segSeconds})`;

  if (vCodec === 'copy') {
    args.push('-vcodec', 'copy', '-bsf:v', 'h264_mp4toannexb');
  } else if (vCodec === 'libx264') {
    // Software fallback — ultrafast preset for minimal startup delay
    args.push('-vcodec', 'libx264', '-crf', '26', '-preset', 'ultrafast', '-tune', 'zerolatency',
      '-maxrate', maxBitrate, '-bufsize', bufSize, '-threads', '0');
    if (scaleFilter) args.push('-vf', scaleFilter);
    args.push('-g', '48', '-keyint_min', '48');
  } else if (hw === 'amf' || hwEncoder.includes('amf')) {
    const enc = vProfile === 'hevc' ? 'hevc_amf' : 'h264_amf';
    if (scaleFilter) args.push('-vf', `${scaleFilter},format=yuv420p`); else args.push('-pix_fmt', 'yuv420p');
    // Absolute minimum AMF args — strip everything that varies by FFmpeg version
    args.push('-vcodec', enc, '-b:v', bitrate);
  } else if (hw === 'nvenc' || hwEncoder.includes('nvenc')) {
    const enc = vProfile === 'hevc' ? 'hevc_nvenc' : 'h264_nvenc';
    // P40 optimal: p2 preset (fastest with good quality), constrained VBR
    if (useHwDecode && cudaScaleFilter) {
      args.push('-vf', `${cudaScaleFilter},hwdownload,format=yuv420p`);
    } else if (scaleFilter) {
      args.push('-vf', `${scaleFilter},format=yuv420p`);
    } else {
      args.push('-pix_fmt', 'yuv420p');
    }
    args.push('-vcodec', enc,
      '-gpu', String(gpuId),              // which P40 to use
      '-preset', 'p1',                    // p1=absolute fastest NVENC preset
      '-tune', 'ull',                     // ultra low latency tuning
      '-rc:v', 'vbr',
      '-cq:v', crf,
      '-b:v', bitrate, '-maxrate:v', maxBitrate, '-bufsize:v', bufSize,
      '-g', '60', '-keyint_min', '60', '-sc_threshold', '0',
      '-zerolatency', '1',               // reduce encoder buffer delay
      '-threads', '0',                   // auto-thread
      '-force_key_frames', forceKf);
    if (vProfile === 'hevc') args.push('-tag:v', 'hvc1'); // Apple/Plex compat
  } else {
    if (scaleFilter) args.push('-vf', `${scaleFilter},format=yuv420p`); else args.push('-pix_fmt', 'yuv420p');
    args.push('-vcodec', 'libx264', '-crf', crf, '-preset', 'fast',
      '-b:v', bitrate, '-maxrate', maxBitrate, '-bufsize', bufSize,
      '-g', String(gopSize), '-keyint_min', String(gopSize), '-sc_threshold', '0',
      '-force_key_frames', forceKf);
  }

  const aCodec = sfConfig.audioCodec || 'aac', aBitrate = sfConfig.audioBitrate || '192k', aCh = String(sfConfig.audioChannels || 2);
  args.push('-acodec', aCodec, '-b:a', aBitrate, '-ac', aCh,
    '-avoid_negative_ts', 'make_zero',
    '-max_interleave_delta', '500000000');

  if (outputFormat === 'hls') {
    const segTime = String(isLiveSrc ? Math.min(segSeconds, 2) : segSeconds);
    const listSz = String(sfConfig.hlsListSize || 30);
    args.push('-f', 'hls',
      '-hls_time', segTime,
      '-hls_list_size', listSz,
      '-hls_flags', 'delete_segments+append_list+independent_segments',
      '-hls_segment_type', 'mpegts',
      '-hls_allow_cache', '0',
      '-flush_packets', '1',
      '-hls_init_time', '0',
      '-hls_segment_filename', path.join(hlsDir, 'seg%05d.ts'),
      path.join(hlsDir, 'index.m3u8'));
  } else {
    args.push('-f', 'mpegts', '-mpegts_flags', 'resend_headers', 'pipe:1');
  }
  return args;
}
const hlsSessions = {};
const swFallbackChannels = new Set(); // channels where AMF crashed — use libx264
const SF_HLS_DIR = () => path.join(SF_DIR, 'hls');
const SF_PRESEG_DIR = () => sfConfig.presegDir ? sfConfig.presegDir : path.join(SF_DIR, 'presegs');

// ── Pre-segmentation Engine ──────────────────────────────────────────────────
// Transcodes media files ONCE to permanent HLS segments on disk.
// At playback time: zero FFmpeg, just serve pre-made segments. Near-zero CPU.
let presegDb = {};    // mediaId -> { status:'pending'|'processing'|'done'|'error', segCount, segLength, segDir, duration }
let presegQueue = []; // { mediaId, filePath, priority }
let pendingShows = []; // [{ showTitle, episodes: [{mediaId,filePath}, ...] }] — shows waiting to be queued, one loads at a time

function loadPendingShows() {
  try {
    const fp = path.join(SF_DIR, 'preseg-pending-shows.json');
    if (fs.existsSync(fp)) pendingShows = JSON.parse(fs.readFileSync(fp,'utf8')) || [];
  } catch { pendingShows = []; }
}
function savePendingShows() {
  try { fs.writeFileSync(path.join(SF_DIR, 'preseg-pending-shows.json'), JSON.stringify(pendingShows)); } catch {}
}
// When presegQueue is empty, pop the next show off pendingShows and queue all its episodes.
function refillFromPendingShows() {
  if (presegQueue.length > 0) return false;
  // Keep popping shows until we ACTUALLY queue something — queuePreseg silently drops items
  // whose .hls folder already exists on the NAS (checkFileAlreadyPresegged), so a show may
  // look "remaining" by DB status yet produce zero queued items.
  while (pendingShows.length) {
    const show = pendingShows.shift();
    savePendingShows();
    const before = presegQueue.length;
    for (const ep of (show.episodes||[])) {
      if (isPresegged(ep.mediaId)) continue;
      if (presegDb[ep.mediaId]?.status === 'processing') continue;
      queuePreseg(ep.mediaId, ep.filePath);
    }
    const added = presegQueue.length - before;
    if (added > 0) {
      console.log(`[SF/Preseg] Loaded show: "${show.showTitle}" (${added} eps queued, ${pendingShows.length} shows remaining)`);
      return true;
    }
    console.log(`[SF/Preseg] Skipped already-done show: "${show.showTitle}"`);
  }
  console.log('[SF/Preseg] pendingShows exhausted');
  return false;
}

let presegWorkers = 0;  // legacy total (kept for status API)
let gpuPresegWorkers = 0;  // 8-bit files - fast NVENC pipeline
let cpuPresegWorkers = 0;  // 10-bit files - SW decode, CPU-bound
// [CONFIGURABLE_v2] Worker limits driven by sfConfig.presegWorkers (UI) with fallback to maxGpuPreseg/maxCpuPreseg
let MAX_GPU_PRESEG = 4;
let MAX_CPU_PRESEG = 2;
function refreshPresegLimits() {
  const total = parseInt(sfConfig.presegWorkers) || 0;
  const route10b = sfConfig.route10BitToCpu === true;
  if (total > 0) {
    if (route10b) {
      MAX_GPU_PRESEG = Math.max(1, Math.ceil(total * 0.8));
      MAX_CPU_PRESEG = Math.max(0, total - MAX_GPU_PRESEG);
    } else {
      MAX_GPU_PRESEG = total;
      MAX_CPU_PRESEG = 0;
    }
  } else {
    MAX_GPU_PRESEG = Math.max(1, parseInt(sfConfig.maxGpuPreseg) || 4);
    MAX_CPU_PRESEG = Math.max(0, parseInt(sfConfig.maxCpuPreseg) || 2);
  }
}
refreshPresegLimits();
const MAX_PRESEG_WORKERS = () => MAX_GPU_PRESEG + MAX_CPU_PRESEG;

function loadPresegDb() {
  // [SINGLE_SOURCE_v1] queue rebuilt from preseg.json every startup. No queue-file drift. Zombies auto-reset.
  try {
    const p = path.join(SF_DIR, 'preseg.json');
    if (fs.existsSync(p)) presegDb = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {}
  presegQueue = [];
  let zombiesReset = 0;
  for (const mid of Object.keys(presegDb || {})) {
    const v = presegDb[mid];
    if (!v || !v.filePath) continue;
    if (v.status === 'processing') {
      v.status = 'queued';
      zombiesReset++;
    }
    if (v.status === 'queued') {
      presegQueue.push({ mediaId: mid, filePath: v.filePath, displayName: v.displayName || '' });
    }
  }
  if (zombiesReset > 0) {
    try { fs.writeFileSync(path.join(SF_DIR, 'preseg.json'), JSON.stringify(presegDb, null, 2)); } catch {}
  }
  console.log(`[SF/Preseg] Loaded ${presegQueue.length} queued items from preseg.json (${zombiesReset} zombies reset)`);
}

function savePresegQueue() {
  try { fs.writeFileSync(path.join(SF_DIR, 'preseg-queue.json'), JSON.stringify(presegQueue)); } catch {}
}

// Check if a file has already been pre-segmented by looking for .hls folder on NAS
// This survives container rebuilds since it checks the actual filesystem
function checkFileAlreadyPresegged(mediaId, filePath) {
  if (presegDb[mediaId]?.status === 'done') return true;
  if (!filePath) return false;
  const fileBase = path.basename(filePath, path.extname(filePath));
  const fileDir = path.dirname(filePath);
  const segDir = path.join(fileDir, '.hls', fileBase);
  const indexFile = path.join(segDir, 'index.m3u8');
  if (fs.existsSync(indexFile)) {
    // Verify all segments are present by reading the index.m3u8 and counting expected segments
    try {
      const indexContent = fs.readFileSync(indexFile, 'utf8');
      const isComplete = indexContent.includes('#EXT-X-ENDLIST');
      const expectedSegs = (indexContent.match(/#EXTINF/g)||[]).length;
      const segFiles = fs.readdirSync(segDir).filter(f=>f.endsWith('.ts'));
      const segs = segFiles.length;
      const emptySegs = segFiles.filter(f => fs.statSync(path.join(segDir,f)).size === 0).length;
      if (!isComplete || (expectedSegs > 0 && segs < expectedSegs) || emptySegs > 0) {
        console.warn(`[SF/Preseg] Incomplete preseg for ${mediaId} — ${segs}/${expectedSegs} segs, complete=${isComplete}, empty=${emptySegs} — will re-transcode`);
        try { fs.rmSync(segDir, { recursive:true }); } catch {}
        delete presegDb[mediaId];
        return false;
      }
      // Restore to presegDb so future calls are faster
      presegDb[mediaId] = { status:'done', segDir, segCount:segs, segLen: sfConfig.hlsSegmentSeconds||12, doneAt: Date.now() };
      savePresegDb();
      return true;
    } catch { return false; }
  }
  return false;
}

// [DEBOUNCE_v1] Debounced async save — coalesces bursts to max 1 write per 2s.
// 250 calls in a 1s burst become 1 write at the end. Event loop never blocks.
let _presegSaveTimer = null;
let _presegSaveInflight = false;
function savePresegDb() {
  if (_presegSaveTimer) return;
  _presegSaveTimer = setTimeout(() => {
    _presegSaveTimer = null;
    if (_presegSaveInflight) { _presegSaveTimer = setTimeout(savePresegDb, 500); return; }
    _presegSaveInflight = true;
    const tmpPath = path.join(SF_DIR, 'preseg.json.tmp');
    const finalPath = path.join(SF_DIR, 'preseg.json');
    fs.writeFile(tmpPath, JSON.stringify(presegDb), (err) => {
      if (err) { console.error('[SF/Preseg] save failed:', err.message); _presegSaveInflight = false; return; }
      fs.rename(tmpPath, finalPath, (err2) => {
        _presegSaveInflight = false;
        if (err2) console.error('[SF/Preseg] rename failed:', err2.message);
      });
    });
  }, 2000);
}
// Sync flush — call on SIGTERM/SIGINT to persist final state before exit
function flushPresegDbSync() {
  if (_presegSaveTimer) { clearTimeout(_presegSaveTimer); _presegSaveTimer = null; }
  try { fs.writeFileSync(path.join(SF_DIR, 'preseg.json'), JSON.stringify(presegDb)); } catch {}
}
process.once('SIGTERM', flushPresegDbSync);
process.once('SIGINT', flushPresegDbSync);

function isPresegged(mediaId) {
  return presegDb[mediaId]?.status === 'done';
}

function queuePreseg(mediaId, filePath, priority=false) {
  if (!mediaId || !filePath) return;
  if (presegDb[mediaId]?.status === 'processing') return;
  if (presegQueue.find(q=>q.mediaId===mediaId)) return;
  if (checkFileAlreadyPresegged(mediaId, filePath)) return; // check NAS filesystem
  const m = getMediaById(mediaId);
  // Build display name — use media object if available, else parse from filename
  let displayName;
  if (m && m.season != null) {
    displayName = `${m.title} S${String(m.season).padStart(2,'0')}E${String(m.episode||0).padStart(2,'0')}${m.episodeTitle?' — '+m.episodeTitle:''}`;
  } else if (filePath) {
    // Parse from filename e.g. "Doc Martin_S01E03_Shit Happens.mp4"
    const base = path.basename(filePath, path.extname(filePath));
    const seMatch = base.match(/[Ss](\d+)[Ee](\d+)/);
    if (seMatch) {
      const showName = base.split(/[_\s-]*[Ss]\d+[Ee]\d+/)[0].replace(/[_]/g,' ').trim();
      displayName = `${showName} S${seMatch[1].padStart(2,'0')}E${seMatch[2].padStart(2,'0')}`;
    } else {
      displayName = base;
    }
  } else {
    displayName = m?.title || mediaId;
  }
  if (priority) presegQueue.unshift({ mediaId, filePath, displayName });
  else presegQueue.push({ mediaId, filePath, displayName });
  savePresegQueue();
  drainPresegQueue();
}

// Independent completion checker — runs every 5s and marks done items regardless of FFmpeg exit
function startPresegCompletionChecker() {
  setInterval(() => {
    Object.entries(presegDb).forEach(([mediaId, info]) => {
      if (info.status !== 'processing') return;
      const localTempDir = path.join(SF_DIR, 'preseg_temp', mediaId);
      const indexFile = path.join(localTempDir, 'index.m3u8');
      try {
        if (!fs.existsSync(indexFile)) return;
        const content = fs.readFileSync(indexFile, 'utf8');
        if (!content.includes('#EXT-X-ENDLIST')) return;
        const segs = fs.readdirSync(localTempDir).filter(f=>f.endsWith('.ts')).length;
        if (segs === 0) return;
        console.log(`[SF/Preseg/Checker] Detected completion: ${mediaId} — ${segs} segs`);
        // Get NAS path from filePath
        const fp = info.filePath;
        if (!fp) return;
        const fileBase = path.basename(fp, path.extname(fp));
        const nasSegDir = path.join(path.dirname(fp), '.hls', fileBase);
        // Move to NAS
        try {
          fs.mkdirSync(path.dirname(nasSegDir), { recursive: true });
          if (fs.existsSync(nasSegDir)) fs.rmSync(nasSegDir, { recursive: true });
          fs.renameSync(localTempDir, nasSegDir);
          console.log(`[SF/Preseg/Checker] Moved to NAS: ${nasSegDir}`);
        } catch(me) {
          fs.mkdirSync(nasSegDir, { recursive: true });
          for (const f of fs.readdirSync(localTempDir)) {
            fs.copyFileSync(path.join(localTempDir,f), path.join(nasSegDir,f));
          }
          fs.rmSync(localTempDir, { recursive:true });
          console.log(`[SF/Preseg/Checker] Copied to NAS: ${nasSegDir}`);
        }
        const was10b = info.is10Bit === true;
        presegDb[mediaId] = { status:'done', segDir:nasSegDir, segCount:segs, segLen:info.segLen||6, doneAt:Date.now(), filePath:fp, displayName:info.displayName||path.basename(fp), is10Bit: was10b };
        savePresegDb();
        if (was10b) cpuPresegWorkers = Math.max(0, cpuPresegWorkers - 1);
        else gpuPresegWorkers = Math.max(0, gpuPresegWorkers - 1);
        presegWorkers = gpuPresegWorkers + cpuPresegWorkers;
        drainPresegQueue();
      } catch(e) {
        console.error(`[SF/Preseg/Checker] Error for ${mediaId}:`, e.message);
      }
    });
  }, 5000);
}

// [EXTERNALIZE_v1] Yield in-process preseg to orion-preseg service when enabled
function _externalPresegEnabled() {
  try {
    const c = JSON.parse(require('fs').readFileSync('/var/lib/orion/config.json', 'utf8'));
    return !!(c.services && c.services.preseg && c.services.preseg.enabled === true);
  } catch { return false; }
}

// [FORWARD_v2] Generic HTTP helper to orion-preseg service on localhost:3002
function _httpToPreseg(method, reqPath, payload) {
  const http = require('http');
  return new Promise((resolve, reject) => {
    const data = (payload != null) ? JSON.stringify(payload) : null;
    const headers = data
      ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
      : {};
    const r = http.request({
      hostname: '127.0.0.1', port: 3002, path: reqPath, method, headers, timeout: 30000
    }, (resp) => {
      let body = '';
      resp.on('data', d => body += d);
      resp.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({ raw: body }); } });
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(new Error('timeout')); });
    if (data) r.write(data);
    r.end();
  });
}
function _postToPreseg(reqPath, payload) { return _httpToPreseg('POST', reqPath, payload); }
function _getFromPreseg(reqPath) { return _httpToPreseg('GET', reqPath, null); }

function drainPresegQueue() {
  if (_externalPresegEnabled()) return;  // [EXTERNALIZE_v1] orion-preseg owns this
  if (presegQueue.length === 0 && pendingShows.length > 0) refillFromPendingShows();
  // [PATCHED v2] Dual-worker: 2 GPU (8-bit) + 1 CPU (10-bit), dispatched by type
  const proc = Object.values(presegDb).filter(v => v && v.status === 'processing');
  const cpuCount = proc.filter(v => v.is10Bit === true).length;
  const gpuCount = proc.length - cpuCount;
  if (gpuCount !== gpuPresegWorkers || cpuCount !== cpuPresegWorkers) {
    console.log('[SF/Preseg] resync: gpu ' + gpuPresegWorkers + '->' + gpuCount + ', cpu ' + cpuPresegWorkers + '->' + cpuCount);
    gpuPresegWorkers = gpuCount;
    cpuPresegWorkers = cpuCount;
  }
  presegWorkers = gpuPresegWorkers + cpuPresegWorkers;
  refreshPresegLimits();
  // PROMOTE_PENDING_v1: top up queue from 'pending' entries when running low
  if (presegQueue.length < 100) {
    const PROMOTE_BATCH = 200;
    let _promoted = 0;
    for (const _mid of Object.keys(presegDb)) {
      if (_promoted >= PROMOTE_BATCH) break;
      const _v = presegDb[_mid];
      if (_v && _v.status === 'pending') {
        _v.status = 'queued';
        presegQueue.push({ mediaId: _mid, filePath: _v.filePath, displayName: _v.displayName || '' });
        _promoted++;
      }
    }
    if (_promoted > 0) {
      try { fs.writeFileSync(path.join(SF_DIR, 'preseg.json'), JSON.stringify(presegDb)); } catch {}
      console.log(`[SF/Preseg] Promoted ${_promoted} pending -> queued (queue now ${presegQueue.length})`);
    }
  }
  const _route10b = sfConfig.route10BitToCpu === true;
  let safety = presegQueue.length + 4;
  while (safety-- > 0 && (gpuPresegWorkers < MAX_GPU_PRESEG || cpuPresegWorkers < MAX_CPU_PRESEG) && presegQueue.length > 0) {
    let pickIdx = -1, pickIs10b = null;
    if (_route10b) {
      for (let i = 0; i < presegQueue.length; i++) {
        const it = presegQueue[i];
        if (it._is10Bit === undefined) {
          try { it._is10Bit = is10BitSource(it.filePath); } catch { it._is10Bit = false; }
        }
        if (it._is10Bit && cpuPresegWorkers < MAX_CPU_PRESEG) { pickIdx = i; pickIs10b = true; break; }
        if (!it._is10Bit && gpuPresegWorkers < MAX_GPU_PRESEG) { pickIdx = i; pickIs10b = false; break; }
      }
    } else {
      if (gpuPresegWorkers < MAX_GPU_PRESEG) { pickIdx = 0; pickIs10b = false; }
      else if (cpuPresegWorkers < MAX_CPU_PRESEG) { pickIdx = 0; pickIs10b = true; }
    }
    if (pickIdx === -1) break;
    const item = presegQueue.splice(pickIdx, 1)[0];
    savePresegQueue();
    if (pickIs10b) cpuPresegWorkers++; else gpuPresegWorkers++;
    presegWorkers = gpuPresegWorkers + cpuPresegWorkers;
    presegDb[item.mediaId] = { status:'processing', filePath: item.filePath, displayName: item.displayName, is10Bit: pickIs10b, startedAt: Date.now() };
    savePresegDb();
    runPreseg(item).finally(() => {
      if (pickIs10b) cpuPresegWorkers = Math.max(0, cpuPresegWorkers - 1);
      else gpuPresegWorkers = Math.max(0, gpuPresegWorkers - 1);
      presegWorkers = gpuPresegWorkers + cpuPresegWorkers;
      drainPresegQueue();
    });
  }
}

// Probe if source is 10-bit (P40 NVDEC doesn't support it — fall back to software decode)
// PROBE_CACHE_v1: persistent disk cache keyed by filePath:size:mtimeMs
const _probeCachePath = '/var/lib/orion/sf/probe-cache.json';
let _probeCache = (function(){
  try { return JSON.parse(fs.readFileSync(_probeCachePath,'utf8')); } catch { return {}; }
})();
let _probeCacheDirty = 0;
function _saveProbeCacheIfDirty(force) {
  if (!force && _probeCacheDirty < 50) return;
  try { fs.writeFileSync(_probeCachePath, JSON.stringify(_probeCache)); _probeCacheDirty = 0; } catch {}
}
function is10BitSource(filePath) {
  let key = filePath;
  try {
    const st = fs.statSync(filePath);
    key = filePath + ':' + st.size + ':' + Math.floor(st.mtimeMs);
  } catch { return false; }
  if (_probeCache[key] !== undefined) return _probeCache[key];
  try {
    const r = require('child_process').execFileSync(
      ffprobeExe,
      ['-v','error','-select_streams','v:0','-show_entries','stream=pix_fmt','-of','csv=p=0', filePath],
      { encoding: 'utf8', timeout: 5000 }
    ).trim();
    const result = r.includes('10le') || r.includes('p10') || r.includes('10be');
    _probeCache[key] = result;
    _probeCacheDirty++;
    _saveProbeCacheIfDirty(false);
    return result;
  } catch {
    _probeCache[key] = false;
    return false;
  }
}

async function runPreseg({ mediaId, filePath }) {
  const fileBase = path.basename(filePath, path.extname(filePath));
  const fileDir = path.dirname(filePath);
  const nasSegDir = path.join(fileDir, '.hls', fileBase); // final NAS location
  const presegTempBase = sfConfig.presegTempDir || path.join(SF_DIR, 'preseg_temp');
  const localTempDir = path.join(presegTempBase, mediaId); // fast local write
  const segDir = localTempDir; // FFmpeg writes here first
  const segLen = sfConfig.hlsSegmentSeconds || 12;
  presegDb[mediaId] = { status: 'processing', segDir: nasSegDir, filePath };

  const moveToNas = () => {
    try {
      fs.mkdirSync(path.dirname(nasSegDir), { recursive: true });
      if (fs.existsSync(nasSegDir)) fs.rmSync(nasSegDir, { recursive: true });
      fs.renameSync(localTempDir, nasSegDir);
      console.log('[SF/Preseg] Moved to NAS: ' + nasSegDir);
    } catch(me) {
      console.log('[SF/Preseg] rename failed, copying: ' + me.message);
      fs.mkdirSync(nasSegDir, { recursive: true });
      for (const f of fs.readdirSync(localTempDir)) {
        fs.copyFileSync(path.join(localTempDir, f), path.join(nasSegDir, f));
      }
      fs.rmSync(localTempDir, { recursive: true });
      console.log('[SF/Preseg] Copied to NAS: ' + nasSegDir);
    }
  };

  try {
    fs.mkdirSync(localTempDir, { recursive: true });
    const gpuId = assignGpu();
    // [CONFIGURABLE_v1] Encoder selection driven by sfConfig.hwAccel: nvenc/amf/qsv/cpu
    const _hwAccel = (sfConfig.hwAccel || 'cpu').toLowerCase();
    const isNvenc = _hwAccel === 'nvenc';
    const isAmf = _hwAccel === 'amf';
    const isQsv = _hwAccel === 'qsv';
    const enc = isNvenc ? 'h264_nvenc' : isAmf ? 'h264_amf' : isQsv ? 'h264_qsv' : 'libx264';
    const useNvenc = isNvenc;

    // Build encode args — same quality as live but no seek offset
    const args = [
      '-fflags', '+genpts+igndts',
      '-err_detect', 'ignore_err',
      '-threads', '2',         // [PATCHED] hard cap on decoder threads
      '-thread_type', 'frame', // [PATCHED] frame-only, no slice-level multiply
    ];
    const sourceIs10Bit = is10BitSource(filePath);
    if (sfConfig.skip10BitPreseg === true && sourceIs10Bit) {
      console.log(`[SF/Preseg] 10-bit source SKIPPED (config): ${path.basename(filePath)}`);
      presegDb[mediaId] = { status: 'skipped-10bit', filePath, displayName: (presegDb[mediaId] && presegDb[mediaId].displayName) || path.basename(filePath), skippedAt: Date.now() };
      savePresegDb();
      throw new Error('SKIP_10BIT');
    }
    if (isNvenc) {
      args.push('-hwaccel', 'cuda', '-hwaccel_device', String(gpuId), '-hwaccel_output_format', 'cuda');
    }
    args.push(
      '-i', filePath,
      '-map', '0:v:0', '-map', '0:a:0?',
    );

    // [CONFIGURABLE_v1] Per-encoder video args
    if (sourceIs10Bit && (isNvenc || isAmf || isQsv)) args.push('-pix_fmt', 'yuv420p');
    if (isNvenc) {
      args.push('-vcodec', 'h264_nvenc', '-gpu', String(gpuId),
        '-preset', 'p1', '-rc:v', 'vbr', '-cq:v', '23',
        '-b:v', '4M', '-maxrate:v', '8M', '-bufsize:v', '8M',
        '-g', '60', '-keyint_min', '60', '-sc_threshold', '0');
    } else if (isAmf) {
      args.push('-vcodec', 'h264_amf',
        '-quality', 'speed', '-rc', 'vbr_peak', '-qp_i', '23', '-qp_p', '23',
        '-b:v', '4M', '-maxrate:v', '8M', '-bufsize:v', '8M',
        '-g', '60');
    } else if (isQsv) {
      args.push('-vcodec', 'h264_qsv',
        '-preset', 'veryfast', '-global_quality', '23',
        '-b:v', '4M', '-maxrate:v', '8M', '-bufsize:v', '8M',
        '-g', '60');
    } else {
      args.push('-vcodec', 'libx264',
        '-preset', 'veryfast', '-crf', '23',
        '-b:v', '4M', '-maxrate:v', '8M', '-bufsize:v', '8M',
        '-g', '60', '-keyint_min', '60', '-sc_threshold', '0');
    }

    args.push('-acodec', 'aac', '-b:a', '192k', '-ac', '2',
      '-avoid_negative_ts', 'make_zero',
      '-f', 'hls',
      '-hls_time', String(segLen),
      '-hls_list_size', '0',           // keep ALL segments
      '-hls_flags', 'independent_segments',
      '-hls_segment_type', 'mpegts',
      '-hls_allow_cache', '1',
      '-hls_segment_filename', path.join(segDir, 'seg%05d.ts'),
      path.join(segDir, 'index.m3u8'));

    console.log(`[SF/Preseg] Transcoding ${mediaId} → ${segDir}`);

    // Simple poll every 5s — no exit event needed
    await new Promise((resolve, reject) => {
      const proc = spawn(ffmpegExe, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: false });
      let stderrTail = '';
      proc.stderr.on('data', chunk => {
        stderrTail = (stderrTail + chunk.toString()).slice(-2000); // keep last 2KB
      });
      let done = false;

      let lastMoveErr = null;
      const moveToNas = () => {
        try {
          const segs = fs.readdirSync(localTempDir).filter(f=>f.endsWith('.ts')).length;
          fs.mkdirSync(path.dirname(nasSegDir), { recursive: true });
          if (fs.existsSync(nasSegDir)) fs.rmSync(nasSegDir, { recursive: true });
          try {
            fs.renameSync(localTempDir, nasSegDir);
          } catch {
            fs.mkdirSync(nasSegDir, { recursive: true });
            for (const f of fs.readdirSync(localTempDir)) fs.copyFileSync(path.join(localTempDir,f), path.join(nasSegDir,f));
            fs.rmSync(localTempDir, { recursive:true });
          }
          console.log('[SF/Preseg] Done ' + mediaId + ' — ' + segs + ' segs');
          presegDb[mediaId] = { status:'done', segDir:nasSegDir, segCount:segs, segLen, doneAt:Date.now(), filePath,
            displayName: presegQueue.find(q=>q.mediaId===mediaId)?.displayName || path.basename(filePath||'') };
          savePresegDb();
          return true;
        } catch(me) {
          console.error('[SF/Preseg] moveToNas failed:', me.message);
          lastMoveErr = me;
          return false;
        }
      };

      const finish = (err) => {
        if (done) return;
        done = true;
        clearInterval(poll);
        clearTimeout(timeout);
        if (err) {
          if (err && err.message === 'SKIP_10BIT') {} else { presegDb[mediaId] = { status:'error', error: err.message, filePath, failedAt: Date.now() }; }
          savePresegDb();
          try { if (fs.existsSync(localTempDir)) fs.rmSync(localTempDir, { recursive:true }); } catch {}
          reject(err);
        } else {
          resolve();
        }
      };

      const poll = setInterval(() => {
        try {
          const idx = path.join(localTempDir, 'index.m3u8');
          if (fs.existsSync(idx) && fs.readFileSync(idx,'utf8').includes('#EXT-X-ENDLIST')) {
            if (moveToNas()) { finish(null); proc.kill('SIGKILL'); }
          }
        } catch {}
      }, 5000);

      const timeout = setTimeout(() => finish(new Error('preseg timeout')), 7200000);

      proc.on('exit', (code) => {
        if (done) return;
        try {
          const idx = path.join(localTempDir, 'index.m3u8');
          if (fs.existsSync(idx) && fs.readFileSync(idx,'utf8').includes('#EXT-X-ENDLIST')) {
            if (moveToNas()) { finish(null); return; }
            // [VISIBILITY_v1] moveToNas failed — surface its actual error, not the generic ffmpeg msg
            if (lastMoveErr) return finish(new Error('moveToNas: ' + lastMoveErr.message));
          }
        } catch {}
        finish(new Error('preseg failed code=' + code + ' | ffmpeg stderr: ' + (stderrTail||'').split('\n').slice(-10).join(' | ')));
      });
    });
  } catch(e) {
    if (e && e.message === 'SKIP_10BIT') {} else { presegDb[mediaId] = { status:'error', error: e.message, filePath, failedAt: Date.now() }; }
    savePresegDb();
    // Cleanup local temp on error
    try { if (fs.existsSync(localTempDir)) fs.rmSync(localTempDir, { recursive:true }); } catch {}
  }
}

// Generate dynamic HLS playlist from pre-segmented files at a given time offset
function getPresegPlaylist(mediaId, offsetSeconds, channelId) {
  const info = presegDb[mediaId];
  if (!info || info.status !== 'done') return null;
  const segLen = info.segLen || 12;
  const startSeg = Math.max(0, Math.floor(offsetSeconds / segLen));
  const listSize = sfConfig.hlsListSize || 60;

  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-TARGETDURATION:${segLen}`,
    `#EXT-X-MEDIA-SEQUENCE:${startSeg}`,
    '#EXT-X-INDEPENDENT-SEGMENTS',
  ];

  let count = 0;
  for (let i = startSeg; count < listSize && i < info.segCount; i++) {
    const segName = 'seg' + String(i).padStart(5,'0') + '.ts';
    const segPath = path.join(info.segDir, segName);
    if (fs.existsSync(segPath)) {
      lines.push(`#EXTINF:${segLen}.000000,`);
      // Encode the full path as base64 so the serve endpoint can find it
    lines.push(`/sf/preseg-file/${Buffer.from(path.join(info.segDir, segName)).toString('base64url')}`);
      count++;
    } else break;
  }

  // If we've reached end of file, append EXT-X-ENDLIST so player knows
  if (startSeg + count >= info.segCount) {
    lines.push('#EXT-X-ENDLIST');
  }

  return lines.join('\n');
}

function startHlsSession(ch, opts={}) {
  if (ch.liveStreamId) return _startHlsSessionOld(ch, opts);
  if (hlsSessions[ch.id]) {
    try { process.kill(hlsSessions[ch.id].proc.pid, 0); return hlsSessions[ch.id]; }
    catch (e) { delete hlsSessions[ch.id]; }
  }
  try {
    const stream = playoutEngine.startChannelStream(ch);
    if (stream && stream.proc) {
      const wrapped = {
        proc: {
          pid: stream.proc.pid,
          // Was an empty function, so the idle reaper never actually
          // stopped anything — it only removed the bookkeeping while the
          // ffmpeg kept writing segments.
          kill: function (sig) {
            try { playoutEngine.stopChannelStream(ch.id); } catch (_) {}
            try { stream.proc.kill(sig || 'SIGKILL'); } catch (_) {}
            this.killed = true;
          },
          killed: false,
          on: function(){}, once: function(){}
        },
        _realProc: stream.proc,
        dir: '/var/lib/orion/sf/hls/' + ch.id,
        startedAt: new Date(stream.startedAt || Date.now()).toISOString(),
        _startedAt: stream.startedAt || Date.now(),
        lastRequest: Date.now(),
        gpuId: 0, mode: 'concat',
        // Only genuinely always-on for live IPTV sources. Scheduled
        // channels are started on tune-in and reaped when idle.
        keepAlive: true,
      };
      hlsSessions[ch.id] = wrapped;
      stream.proc.on('exit', () => { if (hlsSessions[ch.id] === wrapped) delete hlsSessions[ch.id]; });
      return wrapped;
    }
  } catch (e) {
    console.warn('[SF/HLS] playoutEngine failed for', ch.name, '-', e.message);
  }
  return _startHlsSessionOld(ch, opts);
}
function _startHlsSessionOld(ch, opts={}) {
  const channelId = ch.id;
  if (hlsSessions[channelId]) { try { hlsSessions[channelId].proc.kill('SIGKILL'); } catch {} delete hlsSessions[channelId]; }
  const hlsDir = path.join(SF_HLS_DIR(), channelId);
  try { fs.mkdirSync(hlsDir, { recursive: true }); } catch {}
  try { fs.readdirSync(hlsDir).filter(f=>['ts','m3u8','m4s'].includes(f.split('.').pop())).forEach(f=>{ try{fs.unlinkSync(path.join(hlsDir,f));}catch{} }); } catch {}

  const now = getPlayoutNow(ch, Date.now());
  if (!now) {
    if (ch.liveStreamId) console.warn(`[SF/HLS] liveStreamId ${ch.liveStreamId} not found for channel "${ch.name}"`);
    return null;
  }
  let src;
  if (now.isLive && now.stream) { src = { type:'http', value:now.stream.url }; }
  else {
    if (!now.item) { console.warn(`[SF/HLS] no item for "${ch.name}"`); return null; }
    // Skip audio-only library items (music FLAC files have no video stream)
    if (now.item.libraryId === 'orion-music' || now.item.type === 'music') {
      console.warn(`[SF/HLS] Skipping audio-only item "${now.item.title}" on channel "${ch.name}"`);
      return null;
    }
    src = resolveSource(now.item);
    if (!src) { console.warn(`[SF/HLS] resolveSource null for item id=${now.item.id} path="${now.item.path}"`); return null; }
    // Pre-check file exists on NAS before starting FFmpeg (avoids crash loop on missing files)
    if (src.type === 'file' && now.item.path) {
      try { require('fs').accessSync(now.item.path); } catch {
        console.warn(`[SF/HLS] File not accessible, skipping: ${now.item.path}`);
        return null;
      }
    }
  }

  // Assign next GPU via round-robin across all configured GPUs
  const keepAlive = opts.keepAlive || false;
  const quickStart = opts.quickStart || false;
  const liveSource = opts.liveSource || false;
  const swFallback = opts._swFallback || false; // software fallback after AMF crash
  const gpuId = assignGpu();
  const startOffset = now.isLive ? 0 : (now.offsetSeconds || 0);
  const useSw = swFallback || swFallbackChannels.has(channelId);
  const ffArgs = buildFfArgs(src, startOffset, { outputFormat:'hls', hlsDir, gpuId, quickStart, liveSource: src.type==='http', swFallback: useSw });
  if (!fs.existsSync(ffmpegExe)) { console.error(`[SF/HLS] ffmpeg not found: ${ffmpegExe}`); return null; }

  const encoderUsed = ffArgs[ffArgs.indexOf('-vcodec')+1] || 'unknown';
  console.log(`[SF/HLS] Starting "${ch.name}" | encoder=${encoderUsed} | gpu=${gpuId} | src=${src.type} | offset=${startOffset}s`);
  const proc = spawn(ffmpegExe, ffArgs, { stdio:['ignore','ignore','pipe'] });
  const session = { proc, dir:hlsDir, lastRequest:Date.now(), startedAt:new Date().toISOString(), _startedAt:Date.now(), gpuId, _lastError:null, keepAlive, quickStart };
  hlsSessions[channelId] = session;
  let buf = '';
  proc.stderr.on('data', d => {
    const line = d.toString().trim(); if(!line)return; buf+=line+'\n';
    if(line.match(/[Ee]rror|Invalid|No such|fail|Unknown/)) { session._lastError=line.slice(0,200); console.error(`[SF/ffmpeg] stderr: ${line.slice(0,200)}`); }
  });
  proc.on('exit', (code) => {
    const lastLines = buf.trim().split('\n').filter(Boolean).slice(-5).join(' | ');
    console.log(`[SF/ffmpeg] exit code=${code} ch=${channelId} gpu=${gpuId}${lastLines?' | '+lastLines.slice(0,300):''}`);
    if(code && code!==0) {
      // AMF crash (Windows 0xC0000005) — switch channel to libx264 permanently
      const isAmfCrash = (code === 3221225477 || code === -1073741819);
      if (isAmfCrash && !swFallbackChannels.has(channelId)) {
        console.warn(`[SF/HLS] AMF crash on "${ch.name}" — switching permanently to libx264`);
        swFallbackChannels.add(channelId);
        delete hlsSessions[channelId];
        setTimeout(() => { if (!hlsSessions[channelId]) startHlsSession(ch, opts); }, 500);
        return;
      }
    }
    delete hlsSessions[channelId];
    // Auto-restart keepAlive channels with crash backoff — NEVER gives up permanently
    if (keepAlive) {
      const isError = code && code !== 0;
      const uptime = Date.now() - session._startedAt;
      // Track consecutive fast failures (crashed within 10s of starting)
      if (isError && uptime < 10000) {
        session._crashCount = (session._crashCount || 0) + 1;
      } else {
        session._crashCount = 0; // ran for >10s = healthy, reset crash count
      }
      const crashes = session._crashCount || 0;
      // Exponential backoff: 2s, 5s, 15s, 60s, 5min — but always retry, never give up
      const restartDelay = isError
        ? Math.min(2000 * Math.pow(3, Math.min(crashes, 5)), 300000)
        : 2000;
      // H3: give up after repeated fast failures instead of retrying forever.
      const MAX_FAST_CRASHES = parseInt(process.env.ORION_MAX_CRASHES, 10) || 8;
      if (crashes >= MAX_FAST_CRASHES) {
        const deadCh = sfDb.channels.find(c=>c.id===channelId);
        console.error('[SF/HLS] Giving up on "' + (deadCh ? deadCh.name : channelId) +
          '" after ' + crashes + ' consecutive fast failures. ' +
          'Marked unavailable — fix the source and restart the channel.');
        if (deadCh) { deadCh._unavailable = true; deadCh._unavailableAt = Date.now(); }
        return;
      }
      setTimeout(() => {
        const stillCh = sfDb.channels.find(c=>c.id===channelId);
        if (stillCh && !hlsSessions[channelId]) {
          if (crashes > 0) console.log(`[SF/HLS] Auto-restarting keepAlive channel "${stillCh.name}" (delay=${restartDelay}ms, crash #${crashes})`);
          const s = startHlsSession(stillCh, { keepAlive: true });
          if (s) s._crashCount = crashes; // keep counting; do not reset
        }
      }, restartDelay);
    }
  });
  return session;
}

// Stuck-ffmpeg watchdog — checks every 15 sec, kills any ffmpeg whose segments are >30s old
setInterval(() => {
  const now = Date.now();
  for (const id of Object.keys(hlsSessions)) {
    const s = hlsSessions[id];
    if (!s || !s.dir) continue;
    try {
      const files = fs.readdirSync(s.dir).filter(f => f.endsWith('.ts'));
      if (!files.length) continue; // not producing yet, give it time
      const newest = Math.max(...files.map(f => {
        try { return fs.statSync(path.join(s.dir, f)).mtimeMs; } catch { return 0; }
      }));
      // PlayoutEngine streams write segments in bursts when copying from
      // presegs, so a minute without a new file is normal rather than
      // frozen. This was killing healthy channels with 25 minutes uptime.
      if (s._realProc) continue;

      if (now - newest > 60000) {
        const ch = sfDb.channels.find(c => c.id === id);
        console.log(`[SF/StuckGuard] Killing frozen "${ch?.name || id}" — last seg ${Math.round((now-newest)/1000)}s old`);
        const realProc = s._realProc || s.proc;
        try { realProc && realProc.pid && process.kill(realProc.pid, 'SIGKILL'); } catch {}
        delete hlsSessions[id];

        // Killing alone leaves the channel off. The prebuffer watchdog is
        // the only thing that would bring it back, and it runs every five
        // minutes and skips everything when memory is above 60% — so a
        // stalled channel could sit dead until someone changed channel and
        // back. Start it again here instead.
        if (ch && !ch.liveStreamId) {
          setTimeout(() => {
            try {
              if (hlsSessions[id]) return;   // something already restarted it
              console.log('[SF/StuckGuard] Restarting "' + ch.name + '" after stall');
              if (typeof playoutEngine !== 'undefined' && playoutEngine.startChannelStream) {
                playoutEngine.startChannelStream(ch);
              } else {
                startHlsSession(ch, { keepAlive: true });
              }
            } catch (e) {
              console.error('[SF/StuckGuard] restart failed for "' + ch.name + '": ' + e.message);
            }
          }, 2000);
        }
      }
    } catch {}
  }
}, 15000);

// Pre-buffer watchdog — checks every 5 minutes and restarts any channel that should be running
setInterval(() => {
  const mode = sfConfig.prebufferMode || 'library';
  if (mode === 'none') return;
  const _osMem = require('os');
  const _usedPct = (_osMem.totalmem() - _osMem.freemem()) / _osMem.totalmem() * 100;
  if (_usedPct >= 60) { return; }
  (sfDb.channels || []).forEach(ch => {
    if (hlsSessions[ch.id]) return; // already running
    const isLive = !!ch.liveStreamId;
    const shouldRun =
      mode === 'all' ? true :
      mode === 'library' ? !isLive :
      mode === 'live' ? isLive : false;
    if (shouldRun) {
      console.log(`[SF/Watchdog] Restarting dead channel "${ch.name}"`);
      startHlsSession(ch, { keepAlive: true });
    }
  });
}, 5 * 60 * 1000); // every 5 minutes

// Adaptive quality monitor — runs every 30s, drops resolution if too many sessions are crashing
let _adaptiveLevel = 0; // 0=max, 1=720p, 2=480p
const RESOLUTION_TIERS = ['', '1280x720', '854x480'];
setInterval(() => {
  if (!sfConfig.adaptiveQuality) { _adaptiveLevel = 0; return; }
  const activeSessions = Object.keys(hlsSessions).length;
  const gpuCount = Math.max(1, parseInt(sfConfig.gpuCount) || 1);
  const load = activeSessions / (gpuCount * 3); // load factor
  if (load > 0.9 && _adaptiveLevel < 2) {
    _adaptiveLevel++;
    const res = RESOLUTION_TIERS[_adaptiveLevel];
    console.log(`[SF/Adaptive] High load (${activeSessions} sessions) — dropping to ${res || 'source'}`);
  } else if (load < 0.5 && _adaptiveLevel > 0) {
    _adaptiveLevel--;
    const res = RESOLUTION_TIERS[_adaptiveLevel] || sfConfig.maxResolution || 'source';
    console.log(`[SF/Adaptive] Load normal — restoring to ${res}`);
  }
}, 30000);

function getAdaptiveResolution() {
  if (!sfConfig.adaptiveQuality) return sfConfig.videoResolution || null;
  const override = RESOLUTION_TIERS[_adaptiveLevel];
  if (override) return override;
  return sfConfig.maxResolution || sfConfig.videoResolution || null;
}

setInterval(() => {
  const now = Date.now(), idleMs = (sfConfig.hlsIdleTimeoutSecs||60)*1000;
  const caps = require('./capabilities')();
  const keepAliveIdleMs = idleMs * 10; // generous, but not infinite

  const entries = Object.entries(hlsSessions);
  const keepAlives = entries.filter(([,s]) => s.keepAlive);

  // H4: if more always-on sessions than this machine can sustain, retire the
  // least recently requested ones. They restart on demand when tuned.
  // Retirement disabled. With on-demand playout a channel only runs when
  // someone is watching, so capping keep-alives just killed live channels
  // every few minutes — and each restart rebuilt its playlist (1384 items
  // for Bluey) synchronously, blocking the event loop for minutes.
  if (false && keepAlives.length > caps.maxKeepAlive) {
    keepAlives
      .sort((a,b) => a[1].lastRequest - b[1].lastRequest)
      .slice(0, keepAlives.length - caps.maxKeepAlive)
      .forEach(([id,sess]) => {
        console.log('[SF/HLS] Retiring keepAlive session over capacity:', id);
        try{sess.proc.kill('SIGKILL');}catch{}
        delete hlsSessions[id];
      });
  }

  entries.forEach(([id,sess]) => {
    if (!hlsSessions[id]) return;

    // PlayoutEngine owns the lifecycle of its own streams. They are wrapped
    // into hlsSessions for bookkeeping, but lastRequest only advances on a
    // direct /sf/hls fetch — a channel playing out to a TV does not always
    // hit that path, so this reaper was killing healthy streams every few
    // minutes. Each restart then rebuilt the playlist synchronously and
    // blocked the event loop.
    // PlayoutEngine sessions do get lastRequest updates from
    // /sf/hls/:channelId/:segment, so they can be reaped — they just need
    // a longer window than a browser session, because a player can pause
    // between segment fetches. Exempting them entirely left 16 channels
    // running for one viewer.
    const limitMs = sess._realProc ? 600000 : (sess.keepAlive ? keepAliveIdleMs : idleMs);
    if (now - sess.lastRequest > limitMs) {
      console.log('[SF/HLS] Reaping "' + (sfDb.channels.find(c=>c.id===id)||{}).name +
        '" — no segment request in ' + Math.round((now - sess.lastRequest)/1000) + 's');
      try { sess.proc.kill('SIGKILL'); } catch {}
      delete hlsSessions[id];
    }
    return;

    const limit = sess.keepAlive ? keepAliveIdleMs : idleMs;
    if(now-sess.lastRequest>limit) {
      console.log('[SF/HLS] Idle reap: ' + id + ' (' +
        Math.round((now - sess.lastRequest)/1000) + 's since last request)');
      try{sess.proc.kill('SIGKILL');}catch{}
      delete hlsSessions[id];
    }
  });
}, 5000);

// ── Fetch helper (uses built-in https/http since node-fetch may not be present) ─
function fetchUrl(url, opts={}) {
  // Try native fetch first (Node 18+), fall back to https module
  if (typeof fetch !== 'undefined') return fetch(url, opts);
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? require('https') : require('http');
    const headers = opts.headers || {};
    const req = mod.get(url, { headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json: () => Promise.resolve(JSON.parse(body)), text: () => Promise.resolve(body) });
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ── AI helper ─────────────────────────────────────────────────────────────────
async function callAI(systemPrompt, userMessage, { retries = 2 } = {}) {
  const provider = sfConfig.aiProvider || 'anthropic';
  const isLocal = provider === 'ollama' || provider === 'openwebui' || provider === 'custom';

  async function attempt() {
    async function callOpenAICompat(baseUrl, apiKey, model) {
    // Always strip /v1 from base then add it back cleanly
    const url = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
    const r = await fetchUrl(`${url}/v1/chat/completions`, {
      method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${apiKey||'none'}`},
      body: JSON.stringify({
        model,
        messages:[{role:'system',content:systemPrompt},{role:'user',content:userMessage}],
        temperature:0.3,
        max_tokens:2048,
        stream: false,  // CRITICAL: prevent Ollama returning streaming NDJSON
      }),
    });
    // Read body as text first to handle any encoding issues
    const text = await r.text();
    let d;
    try { d = JSON.parse(text); }
    catch(e) {
      // Try to extract first complete JSON object in case of partial streaming response
      const firstObj = text.match(/\{[\s\S]*?\}(?=\n|$)/);
      if (firstObj) { try { d = JSON.parse(firstObj[0]); } catch { throw new Error('AI returned invalid response: ' + text.slice(0,100)); } }
      else throw new Error('AI returned invalid response: ' + text.slice(0,100));
    }
    if(!r.ok) throw new Error(d.error?.message||`HTTP ${r.status}`);
    return d.choices?.[0]?.message?.content||'';
  }
  if (provider==='anthropic') {
    const key = sfConfig.anthropicApiKey||process.env.ANTHROPIC_API_KEY||'';
    if (!key) throw new Error('No Anthropic API key set. Go to Live TV → Settings → AI.');
    const r = await fetchUrl('https://api.anthropic.com/v1/messages', {
      method:'POST', headers:{'Content-Type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01'},
      body: JSON.stringify({ model:'claude-sonnet-4-20250514', max_tokens:4096, system:systemPrompt, messages:[{role:'user',content:userMessage}] }),
    });
    const d = await r.json(); if(!r.ok) throw new Error(d.error?.message||'Anthropic error');
    return d.content?.[0]?.text||'';
  }
  if (provider==='openai') return callOpenAICompat('https://api.openai.com/v1', sfConfig.openaiApiKey||'', sfConfig.openaiModel||'gpt-4o');
  if (provider==='ollama') return callOpenAICompat(sfConfig.ollamaUrl||'http://localhost:11434/v1','ollama',sfConfig.ollamaModel||'llama3.2');
  if (provider==='openwebui') return callOpenAICompat(sfConfig.openwebUIUrl||'',sfConfig.openwebUIKey||'',sfConfig.openwebUIModel||'');
  if (provider==='custom') return callOpenAICompat(sfConfig.customAiUrl||'',sfConfig.customAiKey||'',sfConfig.customAiModel||'default');
  throw new Error(`Unknown provider: ${provider}`);
  } // end attempt()

  // Retry loop — local models (Ollama) can crash transiently under load
  let lastErr;
  for (let i = 0; i <= (isLocal ? retries : 0); i++) {
    if (i > 0) {
      const delay = i * 8000; // 8s, 16s between retries — gives Ollama time to recover
      console.log(`[SF/AI] Retry ${i}/${retries} after ${delay}ms — ${lastErr?.message}`);
      await new Promise(r => setTimeout(r, delay));
    }
    try { return await attempt(); }
    catch(e) { lastErr = e; }
  }
  throw lastErr;
}

// ── Schedules Direct ─────────────────────────────────────────────────────────
const SD_BASE = 'https://json.schedulesdirect.org/20141201';

function sdHeaders(token) { return { 'Content-Type': 'application/json', token }; }

async function sdGetToken(username, password) {
  const sha1pwd = crypto.createHash('sha1').update(password).digest('hex');
  const r = await fetchUrl(`${SD_BASE}/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: sha1pwd }),
  });
  const d = await r.json();
  if (d.code !== 0) throw new Error(d.message || 'Schedules Direct login failed');
  return d.token;
}

async function sdBuildAndImportEPG(token, lineupId, daysAhead = 7) {
  const lineupRes = await fetchUrl(`${SD_BASE}/lineups/${lineupId}`, { headers: sdHeaders(token) });
  const lineupData = await lineupRes.json();
  const stations = lineupData.stations || [];
  const stationIds = stations.map(s => s.stationID);

  const dates = Array.from({ length: daysAhead }, (_, i) => {
    const d = new Date(); d.setDate(d.getDate() + i);
    return d.toISOString().split('T')[0];
  });

  const schedRes = await fetchUrl(`${SD_BASE}/schedules`, {
    method: 'POST', headers: sdHeaders(token),
    body: JSON.stringify(stationIds.map(id => ({ stationID: id, date: dates }))),
  });
  const schedules = await schedRes.json();

  // Fetch program details in batches of 500
  const programIds = [...new Set(schedules.flatMap(s => (s.programs||[]).map(p => p.programID)))];
  const progMap = {};
  for (let i = 0; i < programIds.length; i += 500) {
    const bRes = await fetchUrl(`${SD_BASE}/programs`, {
      method: 'POST', headers: sdHeaders(token),
      body: JSON.stringify(programIds.slice(i, i + 500)),
    });
    const batch = await bRes.json();
    batch.forEach(p => { progMap[p.programID] = p; });
  }

  // Build channels and programs
  const channels = stations.map(st => ({
    id: st.stationID,
    name: st.name || st.callsign || st.stationID,
    logo: st.logo?.URL || '',
  }));

  const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const parseDate = s => { if (!s) return 0; const d = new Date(s); return isNaN(d) ? 0 : d.getTime(); };

  const programs = [];
  for (const sched of schedules) {
    for (const p of (sched.programs || [])) {
      const prog = progMap[p.programID] || {};
      const title = (prog.titles||[])[0]?.title120 || p.programID;
      const desc  = (prog.descriptions?.description1000||[{}])[0]?.description || '';
      const start = parseDate(p.airDateTime);
      const stop  = start + (p.duration || 0) * 1000;
      if (start > 0) programs.push({ channel: sched.stationID, start, stop, title, desc });
    }
  }

  sfDb.epg = { channels, programs, importedAt: new Date().toISOString(), sourceName: `Schedules Direct: ${lineupId}` };
  saveAll();
  return { channels: channels.length, programs: programs.length };
}

async function sdAutoRefresh() {
  const { sdUsername, sdPassword, sdLineupId, sdAutoUpdate } = sfConfig;
  if (!sdAutoUpdate || !sdUsername || !sdPassword || !sdLineupId) return;
  try {
    const token = await sdGetToken(sdUsername, sdPassword);
    const result = await sdBuildAndImportEPG(token, sdLineupId, sfConfig.epgDaysAhead || 7);
    console.log(`[SF/SD] Auto-refresh complete: ${result.programs} programs`);
  } catch (e) {
    console.error('[SF/SD] Auto-refresh failed:', e.message);
  }
}

// ── Shared prompt builder ─────────────────────────────────────────────────────
// Strategy: do heavy lifting server-side, send AI only what fits in ~2000 tokens

function normTitle(t) { return (t||'').toLowerCase().replace(/^(the|a|an) /,'').replace(/[^a-z0-9 ]/g,'').replace(/\s+/g,' ').trim(); }

function fuzzyScore(a, b) {
  const na=normTitle(a),nb=normTitle(b); if(!na||!nb) return 0; if(na===nb) return 100;
  if(na.includes(nb)||nb.includes(na)) return 90;
  const wa=new Set(na.split(' ').filter(w=>w.length>2)),wb=new Set(nb.split(' ').filter(w=>w.length>2));
  if(!wa.size||!wb.size) return 0;
  return Math.round([...wa].filter(w=>wb.has(w)).length/Math.max(wa.size,wb.size)*75);
}

function getChannelGenre(name) {
  const n=(name||'').toLowerCase();
  if (/news|cnn|fox news|msnbc|bbc|ktvl|kdrv|kfbi|koti|kmvu|kfts|koin|katu|kgw|komo|kiro|king|abc|nbc|cbs/.test(n)) return 'news';
  if (/espn|nfl|nba|mlb|nhl|fox sports|cbs sports|sport|bein/.test(n)) return 'sports';
  if (/disney|nickelodeon|cartoon|nick|toon|kid|children|family/.test(n)) return 'kids';
  if (/discovery|history|national geo|natgeo|science|tlc|hgtv|food|cooking/.test(n)) return 'documentary';
  if (/comedy central|tbs|fx|adult swim|comedy/.test(n)) return 'comedy';
  if (/syfy|horror|chiller|fright/.test(n)) return 'horror';
  if (/amc|tnt|usa network|action/.test(n)) return 'action';
  if (/hallmark|lifetime|we tv|own|romance/.test(n)) return 'drama';
  if (/univision|telemundo|hispanic|latin|spanish/.test(n)) return 'spanish';
  if (/investigation|true crime|id /.test(n)) return 'crime';
  if (/weather/.test(n)) return 'weather';
  if (/cspan|pbs|public/.test(n)) return 'documentary';
  return 'general';
}

function buildAIPrompt(epgChannelName, programs, showMap, movieList, userPrompt, date, maxCandidates = 40) {
  const genre = getChannelGenre(epgChannelName);
  const epgTitles = [...new Set(programs.map(p=>p.title))];

  // ── Step 1: Score every show and movie against EPG titles ──────────────────
  const scored = [];
  showMap.forEach((show, title) => {
    const best = epgTitles.reduce((max,et)=>Math.max(max,fuzzyScore(title,et)),0);
    // Also boost by genre match
    const titleLower = title.toLowerCase();
    let genreBoost = 0;
    if (genre==='crime' && /crime|murder|detective|investigation|law|police|csi|ncis|criminal/.test(titleLower)) genreBoost=20;
    if (genre==='comedy' && /comedy|seinfeld|friends|office|parks|arrested|community|30 rock/.test(titleLower)) genreBoost=20;
    if (genre==='drama' && /drama|grey|scandal|suits|desperate|good wife|this is us/.test(titleLower)) genreBoost=15;
    if (genre==='kids' && /cartoon|sponge|adventure time|steven|gravity|amphibia|owl house/.test(titleLower)) genreBoost=20;
    if (genre==='horror' && /walking dead|stranger|supernatural|x.files|buffy|american horror/.test(titleLower)) genreBoost=20;
    if (genre==='action' && /breaking bad|better call|wire|sopranos|shield|24|alias|alias/.test(titleLower)) genreBoost=15;
    if (genre==='documentary' && /documentary|planet|earth|nature|history|ancient|universe|cosmos/.test(titleLower)) genreBoost=20;
    scored.push({ show, title, score: Math.min(100, best + genreBoost), type: 'show' });
  });
  movieList.forEach(m => {
    const best = epgTitles.reduce((max,et)=>Math.max(max,fuzzyScore(m.title,et)),0);
    scored.push({ movie: m, title: m.title, score: best, type: 'movie' });
  });
  scored.sort((a,b)=>b.score-a.score);

  // ── Step 2: Pre-assign slots server-side for high-confidence matches ────────
  const assignments = []; // { slot, mediaId, title, confidence }
  const usedEpisodes = new Set();
  const slotAssigned = new Set();

  // First pass: exact/near-exact matches (score >= 70)
  programs.forEach(prog => {
    const match = scored.find(s => s.score >= 70 && normTitle(s.title) && fuzzyScore(prog.title, s.title) >= 70);
    if (!match) return;
    if (match.type === 'show') {
      const ep = match.show.episodes.find(e => !usedEpisodes.has(e.id));
      if (ep) { assignments.push({ slot: prog.title, mediaId: ep.id, title: match.title, confidence: 'exact' }); usedEpisodes.add(ep.id); slotAssigned.add(prog.title); }
    } else {
      if (!usedEpisodes.has(match.movie.id)) { assignments.push({ slot: prog.title, mediaId: match.movie.id, title: match.title, confidence: 'exact' }); usedEpisodes.add(match.movie.id); slotAssigned.add(prog.title); }
    }
  });

  // ── Step 3: Build compact candidate list for AI to fill remaining slots ────
  // Take top 30 shows/movies by score for the AI to work with
  const topCandidates = scored.slice(0, 100);
  const candidateLines = topCandidates.map(c => {
    if (c.type === 'show') {
      const ep = c.show.episodes.find(e => !usedEpisodes.has(e.id));
      if (!ep) return null;
      return `SHOW [${ep.id}] "${c.title}" S${String(ep.season||1).padStart(2,'0')}E${String(ep.episode||1).padStart(2,'0')} score:${c.score}`;
    } else {
      if (usedEpisodes.has(c.movie.id)) return null;
      return `MOVIE [${c.movie.id}] "${c.title}" ${c.movie.year||''} score:${c.score}`;
    }
  }).filter(Boolean);

  // Remaining unassigned slots
  const unassigned = programs.filter(p => !slotAssigned.has(p.title));
  const slotLines = unassigned.slice(0, 15).map(p => {
    const t=new Date(p.start).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:true});
    const dur=p.stop&&p.start?Math.round((p.stop-p.start)/60000)+'min':'';
    return `  ${t} [${dur}] "${p.title}"`;
  });

  // Keep prompts SHORT — Ollama local models have small context windows
  const systemPrompt = 'You fill TV schedules. Return ONLY JSON: {"assignments":[{"slot":"epg title","mediaId":"id","title":"title"}]}. Copy mediaId EXACTLY from CANDIDATES. Never invent IDs.';

  const userMessage = [
    'CHANNEL: ' + epgChannelName + ' (' + genre + ')',
    'FILL THESE SLOTS:',
    slotLines.join('\n'),
    '',
    'USE ONLY THESE (copy mediaId exactly):',
    candidateLines.slice(0, maxCandidates).join('\n'),
    userPrompt ? 'EXTRA: ' + userPrompt : '',
    'JSON only.',
  ].filter(Boolean).join('\n');

  return { systemPrompt, userMessage, preAssigned: assignments };
}


// ── Module export — call with (app, { ffmpegPath, ffprobePath, hwEncoder, DATA_DIR }) ──
// Export invalidateMediaCache so index.js can call it after library scans
let _externalInvalidate = null;
module.exports.invalidateMediaCache = () => { if (_externalInvalidate) _externalInvalidate(); };
module.exports.getSkippedItems = () => _skippedItems.slice();
module.exports.invalidatePresegDoneSet = _invalidatePresegDoneSet;


module.exports = function mountStreamForge(app, orion) {
  _externalInvalidate = invalidateMediaCache;
  // Use system ffmpeg on Linux for NVENC/GPU support; ffmpeg-static on Windows
  if (process.platform !== 'win32') {
    try {
      const { execSync: es } = require('child_process');
      ffmpegExe  = es('which ffmpeg').toString().trim()  || orion.ffmpegPath  || 'ffmpeg';
      ffprobeExe = es('which ffprobe').toString().trim() || orion.ffprobePath || 'ffprobe';
    } catch { ffmpegExe = orion.ffmpegPath || 'ffmpeg'; ffprobeExe = orion.ffprobePath || 'ffprobe'; }
  } else {
    ffmpegExe  = orion.ffmpegPath  || 'ffmpeg';
    ffprobeExe = orion.ffprobePath || 'ffprobe';
  }
  hwEncoder  = orion.hwEncoder   || 'libx264';
  orionDb    = orion.orionDb     || null;

  // Data dirs
  SF_DIR      = orion.DATA_DIR; // full path already resolved in index.js (configurable via sfDataDir in config.json)
  SF_CFG      = path.join(SF_DIR, 'config.json');
  SF_CHANNELS  = path.join(SF_DIR, 'channels.json');
  SF_LIBRARIES = path.join(SF_DIR, 'libraries.json');
  SF_MEDIA     = path.join(SF_DIR, 'media.json');
  SF_EPG          = path.join(SF_DIR, 'epg.json');
  SF_STREAMS      = path.join(SF_DIR, 'streams.json');
  SF_EPG_DISABLED = path.join(SF_DIR, 'epg_disabled.json');

  [SF_DIR, path.join(SF_DIR,'hls'), path.join(SF_DIR,'uploads')].forEach(d => { try { fs.mkdirSync(d,{recursive:true}); } catch {} });
  // Init preseg state from disk (was previously orphaned — functions defined but never called)
  try { loadPresegDb(); } catch (e) { console.error('[SF/Preseg] loadPresegDb failed:', e.message); }
  try { loadPendingShows(); } catch (e) { console.error('[SF/Preseg] loadPendingShows failed:', e.message); }
  try { startPresegCompletionChecker(); } catch (e) { console.error('[SF/Preseg] startPresegCompletionChecker failed:', e.message); }
  console.log(`[SF/Preseg] Init: ${Object.keys(presegDb).length} items in DB, ${presegQueue.length} queued, ${pendingShows.length} pending shows`);
  // Kick the drain loop: handles items restored from disk AND refills from pendingShows if queue is empty
  try { drainPresegQueue(); } catch (e) { console.error('[SF/Preseg] initial drain failed:', e.message); }

  // Defaults
  sfConfig = Object.assign({
    baseUrl: 'http://localhost:3001',
    epgDaysAhead: 7, xcUser:'streamforge', xcPass:'streamforge',
    videoCodec:'h264', videoProfile:'h264', videoBitrate:'4M', videoMaxBitrate:'8M', videoBufferSize:'8M',
    videoCrf:'23', audioCodec:'aac', audioBitrate:'192k', audioChannels:2, audioLanguage:'eng',
    hlsSegmentSeconds:6, hlsListSize:20, gpuCount:1, hwDecode:false, hlsIdleTimeoutSecs:60, prebufferMode:'library', adaptiveQuality:false, maxResolution:'1920x1080',
    aiProvider:'anthropic', anthropicApiKey:'', openaiApiKey:'', openaiModel:'gpt-4o',
    ollamaUrl:'http://localhost:11434/v1', ollamaModel:'llama3.2',
    openwebUIUrl:'', openwebUIKey:'', openwebUIModel:'',
    customAiUrl:'', customAiKey:'', customAiModel:'',
  }, loadJson(SF_CFG, {}));

  // Auto-fill hardware from Orion's detection — also re-check after 5s in case detection wasn't done yet
  function applyHwEncoder() {
    if (hwEncoder && hwEncoder !== 'libx264') {
      // [PATCHED] Stop overwriting user-set hwAccel on every startup.
      // Also: check /dev/nvidia0 before trusting hwEncoder string (ffmpeg lists h264_amf
      // even on NVIDIA-only boxes, which used to cause silent reverts to amf).
      if (sfConfig.hwAccel && sfConfig.hwAccel !== 'auto') {
        console.log(`[SF] hwAccel preserved from config: ${sfConfig.hwAccel} (encoder probe: ${hwEncoder})`);
      } else {
        let _hasNvidia = false;
        try { _hasNvidia = require('fs').existsSync('/dev/nvidia0'); } catch {}
        if (_hasNvidia || hwEncoder.includes('nvenc'))  sfConfig.hwAccel = 'nvenc';
        else if (hwEncoder.includes('qsv'))             sfConfig.hwAccel = 'qsv';
        else if (hwEncoder.includes('amf'))             sfConfig.hwAccel = 'amf';
        else                                            sfConfig.hwAccel = 'cpu';
        console.log(`[SF] hwAccel auto-set to: ${sfConfig.hwAccel} (NVIDIA dev: ${_hasNvidia}, encoder: ${hwEncoder})`);
      }
    }
  }
  applyHwEncoder();
  setTimeout(() => {
    hwEncoder = orion.getEncoder ? orion.getEncoder() : hwEncoder;
    applyHwEncoder();
  }, 5000);

  rebuildSfIndexes();
  sfDb = {
    channels:  loadJson(SF_CHANNELS,  []),
    libraries: loadJson(SF_LIBRARIES, []),
    media:     loadJson(SF_MEDIA,     []),
    epg:          loadJson(SF_EPG,          { channels:[], programs:[], importedAt:null, sourceName:'' }),
    streams:      loadJson(SF_STREAMS,      []),
    epgDisabled:  loadJson(SF_EPG_DISABLED, []),
  };

  console.log(`[SF] Mounted StreamForge engine — ${sfDb.channels.length} channels, ${orionDb ? (orionDb.movies||[]).length + (orionDb.tvShows||[]).length : 0} Orion items bridged`);
  console.log(`[SF] Using ffmpeg: ${ffmpegExe}`);
  console.log(`[SF] Hardware encoder: ${hwEncoder}`);

  // Pre-buffer all channels on startup so playback is instant (like Plex)
  // Delay 12s to let Orion DB and library fully load first
  setTimeout(async () => {
    const channels = sfDb.channels || [];
    if (!channels.length) return;
    const gpuCount = Math.max(1, parseInt(sfConfig.gpuCount) || 1);
    // [PATCHED] Prebuffer always uses 4-way batching regardless of gpuCount (which controls preseg only).
    // 4 P40s have plenty of NVENC headroom for parallel channel startup.
    const BATCH = 4;
    console.log(`[SF/Prebuffer] Pre-buffering ${channels.length} channels in batches of ${BATCH}...`);
    for (let i = 0; i < channels.length; i += BATCH) {
      // Memory throttle — stop prebuffering if RAM usage >= 60%
      const _osMem = require('os');
      const _usedPct = (_osMem.totalmem() - _osMem.freemem()) / _osMem.totalmem() * 100;
      if (_usedPct >= 60) {
        console.log(`[SF/Prebuffer] Memory at ${_usedPct.toFixed(1)}% (>=60%) — stopping after ${i}/${channels.length} channels`);
        break;
      }
      const batch = channels.slice(i, i + BATCH);
      batch.forEach(ch => {
        const mode = sfConfig.prebufferMode || 'library';
        const isLive = !!ch.liveStreamId;
        const shouldPreBuffer =
          mode === 'all' ? true :
          mode === 'library' ? !isLive :
          mode === 'live' ? isLive :
          false; // 'none'
        if (!hlsSessions[ch.id] && shouldPreBuffer) {
          // keepAlive for all pre-buffered channels so they stay running
          startHlsSession(ch, { keepAlive: true });
        }
      });
      // 2s between batches — lets GPU settle before starting next batch
      if (i + BATCH < channels.length) await new Promise(r => setTimeout(r, 2000));
    }
    console.log(`[SF/Prebuffer] All ${channels.length} channels pre-buffered`);
  }, 12000);

  const multerUpload = multer({ dest: path.join(SF_DIR,'uploads'), limits:{fileSize:Infinity} });

  // ── Pre-segmented content serving ───────────────────────────────────────────
  // Serve pre-segmented TS files — path encoded as base64url
  app.get('/sf/preseg-file/:encodedPath', (req, res) => {
    try {
      const filePath = Buffer.from(req.params.encodedPath, 'base64url').toString('utf8');
      // Security: must be under known media mounts
      const allowed = ['/mnt/', '/var/lib/orion/'];
      if (!allowed.some(p => filePath.startsWith(p))) return res.status(403).end();
      if (!fs.existsSync(filePath)) return res.status(404).end();
      const isM3u8 = filePath.endsWith('.m3u8');
      res.setHeader('Content-Type', isM3u8 ? 'application/vnd.apple.mpegurl' : 'video/mp2t');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      fs.createReadStream(filePath).pipe(res);
    } catch { res.status(400).end(); }
  });

  // Legacy preseg endpoint for backward compat
  app.get('/sf/presegs/:mediaId/:seg', (req, res) => {
    const { mediaId, seg } = req.params;
    const info = presegDb[mediaId];
    if (!info?.segDir) return res.status(404).end();
    const filePath = path.join(info.segDir, seg);
    if (!fs.existsSync(filePath)) return res.status(404).end();
    res.setHeader('Content-Type', seg.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    fs.createReadStream(filePath).pipe(res);
  });

  // Virtual channel HLS for pre-segmented content — zero FFmpeg serving
  app.get('/sf/preseg-channel/:channelId/index.m3u8', (req, res) => {
    _noteViewer(req, req.params.channelId);
    const ch = sfDb.channels.find(c=>c.id===req.params.channelId);
    if (!ch) return res.status(404).end();
    const now = getPlayoutNow(ch);
    if (!now?.item) return res.status(404).json({ error:'nothing scheduled' });
    const playlist = getPresegPlaylist(now.item.id, now.offsetSeconds || 0, ch.id);
    if (!playlist) {
      return res.status(404).json({ error:'not pre-segmented', fallback:true });
    }
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(playlist);
  });

  // Pre-seg management endpoints
  app.get('/api/sf/preseg/status', async (req, res) => {
    if (_externalPresegEnabled()) {
      try {
        const qs = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
        const result = await _getFromPreseg('/status' + qs);
        return res.json(result);
      } catch (e) {
        return res.status(502).json({ error: 'orion-preseg unreachable: ' + e.message });
      }
    }
    const done = Object.values(presegDb).filter(v=>v.status==='done').length;
    const processing = Object.values(presegDb).filter(v=>v.status==='processing').length;
    const error = Object.values(presegDb).filter(v=>v.status==='error').length;
    const queued = presegQueue.length;
    const totalMedia = getMediaCombined().filter(m=>m.path||m.filePath).length;
    const currentFiles = Object.entries(presegDb).filter(([,v])=>v.status==="processing").map(([id,v])=>v.displayName||id);
    const allItems = Object.entries(presegDb).map(([id,v])=>({ id, status:v.status, name:v.displayName||(v.filePath?require("path").basename(v.filePath,require("path").extname(v.filePath)):id), error:v.error||null, segCount:v.segCount||null }));










    res.json({ done, processing, error, queued, totalMedia, workers: presegWorkers, maxWorkers: MAX_PRESEG_WORKERS(), items: allItems, currentFiles });
  });

  // Reset presegDb entries so they get re-validated on next queue
  // Daily scheduled-media preseg — handled by the external preseg service.
  app.post('/api/sf/preseg/daily-run', async (req, res) => {
    if (!_externalPresegEnabled()) {
      return res.status(409).json({ error: 'external preseg service is not enabled' });
    }
    try {
      const result = await _postToPreseg('/daily-run', req.body || {});
      res.json(result);
    } catch (e) {
      res.status(502).json({ error: 'orion-preseg daily-run failed: ' + e.message });
    }
  });

  app.post('/api/sf/preseg/reset', (req, res) => {
    const { mediaId } = req.body;
    if (mediaId) {
      delete presegDb[mediaId];
    } else {
      // Reset all done/error entries
      Object.keys(presegDb).forEach(id => {
        if (presegDb[id].status === 'done' || presegDb[id].status === 'error') {
          delete presegDb[id];
        }
      });
    }
    savePresegDb();
    res.json({ ok:true });
  });

  // ─── Proxy: forward /api/sf/preseg/* and /api/sf/convert/* to service ports ─
  function proxyService_orion(targetPort) {
    return (req, res) => {
      const http = require('http');
      const targetPath = req.originalUrl.replace(/^\/api\/sf\/(preseg|convert)/, '') || '/';
      const opts = {
        host: '127.0.0.1', port: targetPort, path: targetPath, method: req.method,
        timeout: 2000,
        headers: { ...req.headers, host: '127.0.0.1:' + targetPort }
      };
      const pr = http.request(opts, (pres) => {
        res.status(pres.statusCode);
        Object.entries(pres.headers).forEach(([k,v]) => { try { res.setHeader(k,v); } catch(e){} });
        pres.pipe(res);
      });
      pr.on('timeout', () => { pr.destroy(new Error('upstream timeout')); });
      pr.on('error', err => _presegFallback(req, res, targetPort, err));

      // express.json() has already consumed the request stream, so piping
      // req forwards an empty body — the upstream waits for content that
      // never arrives and the socket hangs up after the timeout. Send the
      // parsed body instead. GETs were unaffected, which is why only
      // saving config appeared broken.
      if (req.body && Object.keys(req.body).length) {
        const payload = JSON.stringify(req.body);
        pr.setHeader('content-type', 'application/json');
        pr.setHeader('content-length', Buffer.byteLength(payload));
        pr.end(payload);
      } else {
        pr.end();
      }
    };
  }

  // [PRESEG-FALLBACK] When preseg-service (3002) is stopped, synth status/config from disk
  function _presegFallback(req, res, targetPort, err) {
    try {
      if (targetPort === 3002 && req.method === 'GET') {
        const path = require('path');
        if (req.originalUrl.includes('/preseg/status')) {
          const presegPath = path.join(SF_DIR, 'preseg.json');
          const db = JSON.parse(fs.readFileSync(presegPath, 'utf8'));
          const counts = { done: 0, queued: 0, processing: 0, error: 0, skipped: 0, pending: 0 };
          for (const v of Object.values(db)) {
            if (!v || typeof v !== 'object') continue;
            const st = v.status || 'unknown';
            if (st === 'done') counts.done++;
            else if (st === 'queued') counts.queued++;
            else if (st === 'processing') counts.processing++;
            else if (st === 'error') counts.error++;
            else if (st === 'pending') counts.pending++;
            else if (st.startsWith('skipped')) counts.skipped++;
          }
          let maxW = 8, maxG = 8, gc = 4;
          try {
            const cfgRoot = JSON.parse(fs.readFileSync('/var/lib/orion/config.json', 'utf8'));
            const pc = (cfgRoot.services && cfgRoot.services.preseg && cfgRoot.services.preseg.config) || {};
            maxW = pc.workers || 8; gc = pc.gpuCount || 4; maxG = (pc.maxGpuPreseg || 2) * gc;
          } catch {}
          return res.json({
            ...counts,
            workers: 0, maxWorkers: maxW,
            gpuWorkers: 0, cpuWorkers: 0, maxGpu: maxG, maxCpu: 0,
            gpuPerGpu: Array(gc).fill(0),
            enabled: true, serviceRunning: false,
            total: Object.keys(db).length,
            queueLen: counts.queued,
          });
        }
        if (req.originalUrl.includes('/preseg/config')) {
          const cfgRoot = JSON.parse(fs.readFileSync('/var/lib/orion/config.json', 'utf8'));
          const pc = (cfgRoot.services && cfgRoot.services.preseg && cfgRoot.services.preseg.config) || {};
          return res.json({ enabled: true, port: 3002, ...pc, serviceRunning: false });
        }
      }
    } catch (e) {
      console.error('[PRESEG-FALLBACK]', e.message);
    }
    res.status(502).json({ error: 'proxy', detail: err.message, serviceRunning: false });
  }
  app.get('/api/sf/preseg/status', proxyService_orion(3002));
  app.get('/api/sf/preseg/config', proxyService_orion(3002));
  app.put('/api/sf/preseg/config', proxyService_orion(3002));
  app.get('/api/sf/convert/status', proxyService_orion(3003));
  app.get('/api/sf/convert/config', proxyService_orion(3003));
  app.put('/api/sf/convert/config', proxyService_orion(3003));

  app.post('/api/sf/preseg/queue-channel', async (req, res) => {
    const { channelId } = req.body;
    if (!channelId) return res.status(400).json({ error:'channelId required' });
    const ch = sfDb.channels.find(c=>c.id===channelId);
    if (!ch) return res.status(404).json({ error:'channel not found' });

    // [FORWARD_v1] Collect items first, then dispatch to either orion-preseg or in-process
    const items = [];
    const collectItem = (item) => {
      if (!item) return;
      const filePath = item.path || item.filePath;
      if (filePath) items.push({ mediaId: item.id, filePath });
    };

    if (ch.genreLoops?.length || ch.genreLoop) {
      const idx = getNetworkIndex();
      const loops = ch.genreLoops?.length ? ch.genreLoops : [ch.genreLoop];
      loops.forEach(l => {
        const inner = idx.get((l.genre||'').toLowerCase()) || [];
        inner.forEach(collectItem);
      });
    } else if (ch.seriesSchedule) {
      const showTitlesArr = Array.isArray(ch.seriesSchedule.showTitles)
        ? ch.seriesSchedule.showTitles
        : (ch.seriesSchedule.showTitle ? [ch.seriesSchedule.showTitle] : []);
      const _norm = (x) => (x||'').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (showTitlesArr.length > 0) {
        const targets = showTitlesArr.map(_norm);
        const allEps = getMediaCombined().filter(m => {
          if (m.season == null || m.episode == null) return false;
          const t = _norm(m.seriesTitle || m.showName || m.title || m.filename);
          return targets.some(target => t === target || t.startsWith(target));
        });
        console.log('[SF/Preseg] queue-channel ' + (ch.name||'?') + ': found ' + allEps.length + ' eps from ' + showTitlesArr.length + ' shows');
        allEps.forEach(collectItem);
      } else if (ch.seriesSchedule.episodes?.length) {
        ch.seriesSchedule.episodes.forEach(ep => {
          const item = getMediaById(ep.mediaId);
          collectItem(item);
        });
      }
    } else if (ch.playout?.length) {
      ch.playout.forEach(b => {
        const item = getMediaById(b.mediaId);
        collectItem(item);
      });
    }

    // Dispatch
    if (_externalPresegEnabled()) {
      try {
        const result = await _postToPreseg('/queue/bulk', { items, channelId });
        console.log('[SF/Preseg] forwarded to orion-preseg: ' + JSON.stringify(result));
        return res.json({ ok: true, delegated: 'orion-preseg', ...result });
      } catch (e) {
        console.error('[SF/Preseg] forward to orion-preseg failed:', e.message);
        return res.status(502).json({ error: 'orion-preseg unreachable: ' + e.message });
      }
    } else {
      // In-process fallback (legacy path)
      let queued = 0;
      for (const it of items) {
        if (!isPresegged(it.mediaId)) {
          queuePreseg(it.mediaId, it.filePath);
          queued++;
        }
      }
      return res.json({ ok: true, queued });
    }
  });

  app.post('/api/sf/preseg/queue-all', (req, res) => {
    const includeMovies = req.body?.includeMovies === true;  // default: TV only
    const all = getMediaCombined().filter(m => (m.path||m.filePath) && !isPresegged(m.id) && (includeMovies || m.type !== 'movie'));
    // Group by show (TV) or singleton (movies)
    const showMap = new Map();
    for (const m of all) {
      const key = (m.type === 'movie')
        ? `__MOVIE__${m.id}`
        : (m.title || 'Unknown').trim();
      if (!showMap.has(key)) showMap.set(key, { showTitle: key.startsWith('__MOVIE__') ? (m.title||'Movie') : key, episodes: [] });
      showMap.get(key).episodes.push({
        mediaId: m.id,
        filePath: m.path || m.filePath,
        season: m.season ?? 0,
        episode: m.episode ?? 0,
      });
    }
    // Sort shows alphabetically (case-insensitive), movies at end by title
    const shows = [...showMap.values()].sort((a,b) => {
      const am = a.showTitle.startsWith('__MOVIE__') ? 1 : 0;
      const bm = b.showTitle.startsWith('__MOVIE__') ? 1 : 0;
      if (am !== bm) return am - bm;
      return a.showTitle.toLowerCase().localeCompare(b.showTitle.toLowerCase());
    });
    // Sort episodes within each show by season then episode
    shows.forEach(sh => sh.episodes.sort((a,b) => (a.season - b.season) || (a.episode - b.episode)));
    pendingShows = shows;
    savePendingShows();
    const totalEps = shows.reduce((n,s) => n + s.episodes.length, 0);
    console.log(`[SF/Preseg] queue-all: ${shows.length} shows / ${totalEps} items queued in show-at-a-time mode`);
    // Kick off the first show immediately
    refillFromPendingShows();
    res.json({ ok: true, shows: shows.length, totalItems: totalEps, mode: 'show-at-a-time' });
  });

  app.delete('/api/sf/preseg/:mediaId', (req, res) => {
    const { mediaId } = req.params;
    const info = presegDb[mediaId];
    if (info?.segDir) {
      try { require('fs').rmSync(info.segDir, { recursive:true }); } catch {}
    }
    delete presegDb[mediaId];
    savePresegDb();
    res.json({ ok:true });
  });

  // ── Status ──────────────────────────────────────────────────────────────────
  app.get('/api/sf/status', (req, res) => res.json({
    ok: true, version: '2.0.0-orion',
    channelCount:  sfDb.channels.length,
    mediaCount:    getMediaCombined().length,
    streamCount:   sfDb.streams.length,
    epgChannelCount: sfDb.epg.channels.length,
    ffmpegPath: ffmpegExe, hwEncoder, hwAccel: sfConfig.hwAccel,
    gpuCount: sfConfig.gpuCount || 1,
    activeStreams: Object.entries(hlsSessions).map(([id, s]) => ({ channelId: id, gpuId: s.gpuId, startedAt: s.startedAt })),
    uptime: Math.floor(process.uptime()),
  }));

  // ── AI test ──────────────────────────────────────────────────────────────────
  // === [ai_suggestions] AI-powered platform optimization advisor ===

  async function _buildOrionSnapshot() {
    const snap = { ts: new Date().toISOString() };
    const _fs = require('fs');
    const { execSync } = require('child_process');

    // System: /proc reads
    try {
      // H2: this endpoint is polled every 2s per open tab. Re-reading
      // /proc on each call is wasted syscalls; the numbers do not move
      // meaningfully inside a 2s window.
      if (_procCache && Date.now() - _procCache.at < 2000) {
        return _procCache.value;
      }
      const loadavg = _fs.readFileSync('/proc/loadavg', 'utf8').trim().split(' ').slice(0,3);
      const mem = {};
      _fs.readFileSync('/proc/meminfo', 'utf8').split('\n').forEach(l => {
        const [k,v] = l.split(':'); if (v) mem[k.trim()] = parseInt(v.trim().split(/\s+/)[0]);
      });
      snap.system = {
        loadAvg1m: parseFloat(loadavg[0]),
        loadAvg5m: parseFloat(loadavg[1]),
        loadAvg15m: parseFloat(loadavg[2]),
        memUsedGb: +(((mem.MemTotal - mem.MemAvailable) / 1048576).toFixed(1)),
        memTotalGb: +((mem.MemTotal / 1048576).toFixed(0)),
        memPctUsed: +(((mem.MemTotal - mem.MemAvailable) / mem.MemTotal * 100).toFixed(0))
      };
    } catch (e) { snap.system = { error: e.message }; }

    // GPUs
    try {
      const out = execSync(
        'nvidia-smi --query-gpu=index,name,utilization.gpu,utilization.encoder,utilization.decoder,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits',
        { timeout: 3000 }
      ).toString();
      snap.gpus = out.trim().split('\n').filter(Boolean).map(line => {
        const p = line.split(',').map(s => s.trim());
        return {
          idx: parseInt(p[0]), name: p[1],
          util: parseInt(p[2])||0, enc: parseInt(p[3])||0, dec: parseInt(p[4])||0,
          memUsedMb: parseInt(p[5])||0, memTotalMb: parseInt(p[6])||0, tempC: parseInt(p[7])||0
        };
      });
    } catch (e) { snap.gpus = []; }

    // Services
    try {
      snap.services = {};
      for (const svc of ['orion','orion-preseg','orion-convert']) {
        try {
          const a = execSync(`systemctl is-active ${svc}`, { timeout: 1500 }).toString().trim();
          snap.services[svc] = a;
        } catch (e) {
          snap.services[svc] = e.stdout ? e.stdout.toString().trim() : 'unknown';
        }
      }
    } catch (e) {}

    // Convert + preseg service status (HTTP to local services)
    try {
      const r = await fetch('http://127.0.0.1:3003/status', { signal: AbortSignal.timeout(2000) });
      const d = await r.json();
      snap.convertService = {
        workers: d.workers, maxWorkers: d.maxWorkers, gpuLoad: d.gpuLoad,
        done: d.done, processing: d.processing, queued: d.queued, error: d.error,
        encoder: d.encoder, outputMode: d.outputMode, remaining10bit: d.remaining10bit
      };
    } catch (e) { snap.convertService = { error: 'unreachable' }; }

    try {
      const r = await fetch('http://127.0.0.1:3002/status', { signal: AbortSignal.timeout(2000) });
      const d = await r.json();
      snap.presegService = d;
    } catch (e) { snap.presegService = { error: 'unreachable' }; }

    // DB: hls_status, media_probe, convert_status
    const db = _getOrionDbReadonly();
    if (db) {
      try {
        const rows = db.prepare("SELECT status, kind, COUNT(*) as cnt FROM hls_status GROUP BY status, kind").all();
        snap.hlsByStatusKind = {};
        for (const r of rows) {
          snap.hlsByStatusKind[r.status] = snap.hlsByStatusKind[r.status] || {};
          snap.hlsByStatusKind[r.status][r.kind || 'unknown'] = r.cnt;
        }
      } catch (e) {}
      try {
        const rows = db.prepare("SELECT bitDepth, COUNT(*) as cnt FROM media_probe GROUP BY bitDepth").all();
        snap.bitDepthCounts = {};
        for (const r of rows) snap.bitDepthCounts[r.bitDepth || 'unknown'] = r.cnt;
      } catch (e) {}
      try {
        const rows = db.prepare("SELECT status, COUNT(*) as cnt FROM convert_status GROUP BY status").all();
        snap.convertByStatus = {};
        for (const r of rows) snap.convertByStatus[r.status] = r.cnt;
      } catch (e) {}
      try {
        const errs = db.prepare("SELECT mediaId, originalPath, error, doneAt FROM convert_status WHERE status='error' ORDER BY doneAt DESC LIMIT 5").all();
        snap.recentConvertErrors = errs.map(e => ({
          file: (e.originalPath || '').split('/').pop(),
          err: (e.error || '').slice(0, 240)
        }));
      } catch (e) {}
    }

    // Library counts
    try {
      const all = getMediaCombined();
      snap.library = {
        total: all.length,
        movies: all.filter(m => m.type === 'movie').length,
        tvEpisodes: all.filter(m => m.season != null).length,
        music: all.filter(m => m.type === 'music').length,
        musicVideos: all.filter(m => m.type === 'musicVideo').length
      };
    } catch (e) {}

    // Config: FULL sfConfig (so the AI can cross-reference hardware against settings)
    // Redact secrets before sending
    const _redactedConfig = JSON.parse(JSON.stringify(sfConfig || {}));
    const _secretKeys = ['anthropicApiKey','openaiApiKey','openwebUIKey','customAiKey','xcPass','sdPassword'];
    for (const k of _secretKeys) {
      if (_redactedConfig[k]) _redactedConfig[k] = _redactedConfig[k].length > 0 ? '<set>' : '<empty>';
    }
    snap.config = _redactedConfig;

    // Convert service full config
    try {
      const r = await fetch('http://127.0.0.1:3003/config', { signal: AbortSignal.timeout(2000) });
      snap.convertServiceConfig = await r.json();
    } catch (e) {}

    // Preseg service full config
    try {
      const r = await fetch('http://127.0.0.1:3002/config', { signal: AbortSignal.timeout(2000) });
      snap.presegServiceConfig = await r.json();
    } catch (e) {}

    // Recent journalctl per service (last 20 lines each, prioritizing errors)
    try {
      const { execSync } = require('child_process');
      snap.recentLogs = {};
      for (const svc of ['orion','orion-preseg','orion-convert']) {
        try {
          const log = execSync(
            `journalctl -u ${svc} --no-pager -n 25 -o cat 2>/dev/null | grep -iE 'error|fail|warn|exception|crash' | tail -10`,
            { timeout: 2500, shell: '/bin/bash' }
          ).toString().trim();
          snap.recentLogs[svc] = log ? log.split('\n').slice(-10) : [];
        } catch (e) { snap.recentLogs[svc] = []; }
      }
    } catch (e) {}

    // Disk usage for key mounts
    try {
      const { execSync } = require('child_process');
      const df = execSync('df -h --output=source,size,used,avail,pcent,target 2>/dev/null | tail -n +2', { timeout: 2000 }).toString();
      snap.disk = df.trim().split('\n').map(line => {
        const p = line.trim().split(/\s+/);
        return { source: p[0], size: p[1], used: p[2], avail: p[3], usedPct: p[4], target: p[5] };
      }).filter(d => d.target && !d.target.startsWith('/run/') && !d.target.startsWith('/snap'));
    } catch (e) {}

    // HLS error sample (specific files that failed presegmentation)
    if (db) {
      try {
        const errs = db.prepare("SELECT mediaId, filePath, error FROM hls_status WHERE status='error' ORDER BY updatedAt DESC LIMIT 5").all();
        snap.recentHlsErrors = errs.map(e => ({
          file: (e.filePath || '').split('/').pop(),
          err: (e.error || '').slice(0, 240)
        }));
      } catch (e) {}
    }

    // Channel count (if accessible)
    try {
      if (sfDb && sfDb.channels) snap.channelCount = sfDb.channels.length;
    } catch (e) {}

    return snap;
  }

  const _AI_SUGGEST_SYSTEM_PROMPT = [
    'You are a thorough SRE auditor for Orion, a self-hosted media server. Your job is to find EVERY noteworthy issue, misconfiguration, error, or optimization opportunity in the platform snapshot.',
    '',
    'ARCHITECTURE:',
    '- Runs in LXC container on Proxmox',
    '- Hardware: 48 CPU cores, 32 GB RAM, 4× NVIDIA Tesla P40 GPUs (Pascal NVENC)',
    '- Storage: NFS mount of media library (eth0 network)',
    '- Three services:',
    '  * orion (port 3001): UI, library, channels, playout, EPG, transcode for playout',
    '  * orion-preseg (port 3002): pre-segments media into HLS using NVDEC + NVENC',
    '  * orion-convert (port 3003): 10-bit → 8-bit video conversion using NVDEC + scale_cuda + NVENC',
    '- Worker count is intentionally constrained (typically 4) because NFS I/O coordination becomes the CPU bottleneck above that, not encoding.',
    '',
    'IMPORTANT MISREADINGS TO AVOID:',
    '- nvidia-smi `utilization.gpu` (the `util` field) measures CUDA core usage, which video encoding does NOT use. It will look low (3-20%) even when GPUs are working hard. The real video work shows in `enc` (NVENC engine) and `dec` (NVDEC engine) — 30-60% there is healthy. Do NOT flag low `util` as a problem if `enc`/`dec` are active.',
    '- A high conversion queue is not automatically a problem; this is a one-time library-wide conversion. The work just takes time.',
    '- Idle preseg workers (workers: 0) is fine if the preseg queue is empty.',
    '',
    'YOUR AUDIT — be exhaustive, do NOT artificially limit count. Look at EVERY part of the snapshot:',
    '',
    '1. ERRORS — surface every error pattern. Look at recentConvertErrors, recentHlsErrors, recentLogs.{service}, services map. Note: ffmpeg errors with `code=null` typically mean the process was killed externally (SIGKILL), not a real bug — flag the pattern but note it.',
    '',
    '2. HARDWARE-CONFIG MISMATCHES — critically important. Cross-reference `gpus` (which lists NVIDIA Tesla P40s) against `config` and `convertServiceConfig`/`presegServiceConfig`. Examples to flag:',
    '   - `config.hwAccel`: must be a NVIDIA-compatible value (cuda, nvenc) — AMD ("amf") or Intel ("qsv") is wrong on these GPUs',
    '   - `config.gpuCount`: must equal the actual number of GPUs in the `gpus` array (probably 4)',
    '   - `config.videoCodec`: should pair with the correct encoder (h264 → h264_nvenc; hevc → hevc_nvenc)',
    '   - Encoder names: hevc_amf / h264_amf will fail on NVIDIA; flag them',
    '',
    '3. CONFIG ANOMALIES — flag any value that looks wrong, deprecated, placeholder, or contradictory:',
    '   - Empty/missing required fields (e.g. baseUrl, xcUser if intended)',
    '   - Default/placeholder values that should have been set',
    '   - Counts that don\'t match (e.g. presegService.maxWorkers vs config.preseg.workers)',
    '   - Suspicious values (e.g. maxResolution: "854x480" if the user expects HD)',
    '',
    '4. RESOURCE ISSUES — flag genuine resource problems:',
    '   - GPU `tempC` ≥ 75°C (hot)',
    '   - Memory usage above 85%',
    '   - Disk mount above 90% used',
    '   - Asymmetric GPU load (one GPU at 0% while others are working) — possible round-robin bug',
    '',
    '5. SERVICE HEALTH — flag any non-active service that should be running',
    '',
    '6. DATA CONSISTENCY — note things like:',
    '   - bitDepthCounts.unknown > 0 (files without probe data)',
    '   - hlsByStatusKind errors',
    '   - convertByStatus error count',
    '',
    'OUTPUT FORMAT: Strict JSON only. No markdown code fences. No preamble. Schema:',
    '{',
    '  "summary": "1-2 sentence high-level state (mention concerning things)",',
    '  "suggestions": [',
    '    {',
    '      "severity": "critical" | "warning" | "info",',
    '      "title": "Short, specific title under 70 chars",',
    '      "description": "What is wrong, why it matters, and the recommended fix (1-4 sentences)",',
    '      "evidence": "Exact field paths and values from the snapshot — e.g. \\"config.hwAccel = amf, but gpus[0].name = Tesla P40\\"",',
    '      "category": "errors" | "config" | "hardware" | "resources" | "performance" | "data"',
    '    }',
    '  ]',
    '}',
    '',
    'SEVERITY GUIDE:',
    '- critical: actively blocking work, will fail when triggered, data loss possible, or fundamental misconfig',
    '- warning: degraded performance, errors not yet blocking, sub-optimal',
    '- info: noted but not urgent — could be improved, minor inefficiency',
    '',
    'Be exhaustive. Cite specific snapshot field paths in evidence. If you find 12 issues, return 12. Do not summarize multiple distinct issues into one item.'
  ].join('\n');

  app.post('/api/ai/suggestions/analyze', async (req, res) => {
    try {
      const snapshot = await _buildOrionSnapshot();
      const userMsg = 'Here is the current Orion snapshot:\n\n' + JSON.stringify(snapshot, null, 2);
      const text = await callAI(_AI_SUGGEST_SYSTEM_PROMPT, userMsg);
      let raw = text.replace(/```json|```/g, '').trim();
      const ji = raw.indexOf('{');
      if (ji > 0) raw = raw.slice(ji);
      const lastBrace = raw.lastIndexOf('}');
      if (lastBrace > 0 && lastBrace < raw.length - 1) raw = raw.slice(0, lastBrace + 1);
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        return res.json({
          ok: false,
          error: 'AI returned malformed JSON',
          rawSample: text.slice(0, 400),
          snapshot
        });
      }
      res.json({
        ok: true,
        summary: parsed.summary || '',
        suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
        snapshot,
        ts: Date.now()
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Lets the UI inspect the raw snapshot too (for debugging / "what does the AI see")
  app.get('/api/ai/suggestions/snapshot', async (req, res) => {
    try {
      const snap = await _buildOrionSnapshot();
      res.json(snap);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

    app.post('/api/sf/ai/test', async (req, res) => {
    try {
      const result = await callAI('You are a test assistant.', 'Reply with exactly: "AI connection OK"');
      res.json({ ok: true, message: `${sfConfig.aiProvider||'ai'} responded: "${result.slice(0,80)}"` });
    } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // ── Config ──────────────────────────────────────────────────────────────────
  app.get('/api/sf/config', (req, res) => res.json(sfConfig));
  app.put('/api/sf/config', async (req, res) => {
    const allowed = ['baseUrl','epgDaysAhead','xcUser','xcPass','videoCodec','videoProfile','hwAccel','hwAccelEnabled','hwDecode','gpuCount','videoBitrate','videoMaxBitrate','videoBufferSize','videoCrf','audioCodec','audioBitrate','audioChannels','audioLanguage','hlsSegmentSeconds','hlsListSize','hlsIdleTimeoutSecs','prebufferMode','adaptiveQuality','maxResolution','presegWorkers','outputProtocol','srtPort','rtspPort','rtmpPort','udpBase','udpPort','presegDir','presegTempDir','aiProvider','anthropicApiKey','openaiApiKey','openaiModel','ollamaUrl','ollamaModel','openwebUIUrl','openwebUIKey','openwebUIModel','customAiUrl','customAiKey','customAiModel','videoResolution','sdUsername','sdPassword','sdLineupId','sdAutoUpdate'];
    allowed.forEach(k => { if (req.body[k] !== undefined) sfConfig[k] = req.body[k]; });
    saveJson(SF_CFG, sfConfig);

    // [FORWARD_v3] Mirror preseg-relevant fields to orion-preseg when externalized
    if (_externalPresegEnabled()) {
      const payload = {};
      if (req.body.presegWorkers !== undefined) payload.workers = parseInt(req.body.presegWorkers, 10);
      if (req.body.hwAccel !== undefined) payload.hwAccel = String(req.body.hwAccel).toLowerCase();
      if (req.body.gpuCount !== undefined) payload.gpuCount = parseInt(req.body.gpuCount, 10);
      if (Object.keys(payload).length > 0) {
        try {
          await _httpToPreseg('PUT', '/config', payload);
          console.log('[SF/Preseg] mirrored config to orion-preseg:', JSON.stringify(payload));
        } catch (e) {
          console.error('[SF/Preseg] mirror config to orion-preseg failed:', e.message);
        }
      }
    }
    res.json({ ok:true });
  });

  // ── Channels ─────────────────────────────────────────────────────────────────
  // [ENRICH_v2] /api/sf/channels — done from orion.db hls_status (the truth), transient state from orion-preseg
  let _orionDbCache = null;
  function _getOrionDbReadonly() {
    if (_orionDbCache) return _orionDbCache;
    try {
      const Database = require('better-sqlite3');
      const dbPath = process.env.ORION_DB || '/var/lib/orion/orion.db';
      _orionDbCache = new Database(dbPath, { readonly: true, fileMustExist: true });
      return _orionDbCache;
    } catch (e) {
      console.error('[SF/Channels] cannot open orion.db:', e.message);
      return null;
    }
  }
  app.get('/api/sf/channels', async (req, res) => {
    // The channel list only needs display fields. Resolving media
    // membership scans the whole library per channel and the preseg call
    // waits on a busy service — together that was taking 11+ seconds,
    // past the client's timeout, so the page rendered empty.
    if (req.query.light === '1' || req.query.light === 'true') {
      return res.json((sfDb.channels || []).map(ch => ({
        id: ch.id,
        name: ch.name,
        num: ch.num,
        group: ch.group,
        logo: ch.logo,
        active: ch.active,
        liveStreamId: ch.liveStreamId || null,
        epgChannelId: ch.epgChannelId || null,
        splashUrl: ch.splashUrl || null,
        hasSchedule: !!(ch.scheduledPrograms && ch.scheduledPrograms.length),
        // playout is empty for series and loop channels, so reporting only
        // that made a working channel look like it had nothing in it.
        itemCount: (ch.playout || []).length
          || ((ch.seriesSchedule || {}).episodes || []).length
          || (ch.scheduledPrograms || []).length
          || 0,
        running: !!hlsSessions[ch.id],
        viewers: _activeViewers(ch.id)
      })));
    }

    const _norm = (x) => (x||'').toLowerCase().replace(/[^a-z0-9]/g, '');
    // Resolve the list of mediaIds belonging to a channel (same logic as queue-channel)
    const _channelMediaIds = (ch) => {
      try {
        if (ch.genreLoops?.length || ch.genreLoop) {
          const idx = getNetworkIndex();
          const loops = ch.genreLoops?.length ? ch.genreLoops : [ch.genreLoop];
          const out = [];
          for (const l of loops) {
            const list = idx.get((l.genre||'').toLowerCase()) || [];
            for (const m of list) if (m.id) out.push(m.id);
          }
          return out;
        }
        if (ch.seriesSchedule) {
          const showTitlesArr = Array.isArray(ch.seriesSchedule.showTitles)
            ? ch.seriesSchedule.showTitles
            : (ch.seriesSchedule.showTitle ? [ch.seriesSchedule.showTitle] : []);
          if (showTitlesArr.length > 0) {
            const targets = showTitlesArr.map(_norm);
            // _epIndex is built once per request below; without it this
            // filtered all 41k media records once per channel.
            const out = [];
            for (const [t, ids] of _epIndex) {
              if (targets.some(target => t === target || t.startsWith(target))) {
                for (const id of ids) out.push(id);
              }
            }
            return out;
          }
          if (ch.seriesSchedule.episodes?.length) {
            return ch.seriesSchedule.episodes.map(e => e.id || e.mediaId).filter(Boolean);
          }
        }
        if (ch.playout?.length) return ch.playout.map(p => p.mediaId).filter(Boolean);
      } catch {}
      return [];
    };

    // Normalised show title -> media ids, built once. Previously each
    // series channel re-scanned the entire library.
    const _epIndex = new Map();
    try {
      for (const m of getMediaCombined()) {
        if (m.season == null || m.episode == null || !m.id) continue;
        const t = _norm(m.seriesTitle || m.showName || m.title || m.filename);
        if (!t) continue;
        let arr = _epIndex.get(t);
        if (!arr) { arr = []; _epIndex.set(t, arr); }
        arr.push(m.id);
      }
    } catch (e) {
      console.error('[SF/Channels] index build failed:', e.message);
    }

    // Load ALL done mediaIds from orion.db hls_status (1 query, hashmap lookup per channel)
    let doneMids = new Set();
    const odb = _getOrionDbReadonly();
    if (odb) {
      try {
        const rows = odb.prepare("SELECT mediaId FROM hls_status WHERE status = 'done'").all();
        for (const r of rows) doneMids.add(r.mediaId);
      } catch (e) {
        console.error('[SF/Channels] hls_status query failed:', e.message);
      }
    }

    // Transient state (processing/queued/error) still comes from orion-preseg
    let byChannel = {};
    if (_externalPresegEnabled()) {
      try { byChannel = await _getFromPreseg('/status/by-channel'); }
      catch (e) { console.error('[SF/Channels] failed to fetch by-channel transient counts:', e.message); }
    } else {
      for (const mid in presegDb) {
        const v = presegDb[mid];
        const ch = v.channelId || '_none';
        if (!byChannel[ch]) byChannel[ch] = { processing: 0, queued: 0, error: 0, skipped: 0 };
        const s = v.status;
        if (s === 'processing') byChannel[ch].processing++;
        else if (s === 'queued') byChannel[ch].queued++;
        else if (s === 'error') byChannel[ch].error++;
        else if (s && s.indexOf('skipped') === 0) byChannel[ch].skipped++;
      }
    }

    const enriched = sfDb.channels.map(ch => {
      const mediaIds = _channelMediaIds(ch);
      const total = mediaIds.length;
      let done = 0;
      for (const mid of mediaIds) if (doneMids.has(mid)) done++;
      const counts = byChannel[ch.id] || {};
      return {
        ...ch,
        presegStats: {
          total,
          done,
          processing: counts.processing || 0,
          queued:     counts.queued     || 0,
          error:      counts.error      || 0,
          skipped:    counts.skipped    || 0
        }
      };
    });
    res.json(enriched);
  });
  // === [services_v1] Service management — list, start, stop, restart ===
  // === [convert_fwd] orion-convert HTTP forwarders ===
  function _httpToConvert(method, urlPath, body) {
    return new Promise((resolve, reject) => {
      const http = require('http');
      const data = body ? JSON.stringify(body) : null;
      const req = http.request({
        host: '127.0.0.1', port: 3003, path: urlPath, method,
        headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}
      }, (res) => {
        let chunks = '';
        res.on('data', (c) => chunks += c);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : null }); }
          catch { resolve({ status: res.statusCode, body: chunks }); }
        });
      });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }
  app.get('/api/sf/convert/status', async (req, res) => {
    try { const r = await _httpToConvert('GET', '/status'); res.status(r.status).json(r.body); }
    catch (e) { res.status(502).json({ error: e.message }); }
  });
  app.get('/api/sf/convert/items', async (req, res) => {
    const q = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
    try { const r = await _httpToConvert('GET', '/items' + q); res.status(r.status).json(r.body); }
    catch (e) { res.status(502).json({ error: e.message }); }
  });
  app.post('/api/sf/convert/queue', async (req, res) => {
    try { const r = await _httpToConvert('POST', '/queue', req.body); res.status(r.status).json(r.body); }
    catch (e) { res.status(502).json({ error: e.message }); }
  });
  app.post('/api/sf/convert/queue/all-10bit', async (req, res) => {
    try { const r = await _httpToConvert('POST', '/queue/all-10bit', req.body || {}); res.status(r.status).json(r.body); }
    catch (e) { res.status(502).json({ error: e.message }); }
  });
  app.put('/api/sf/convert/config', async (req, res) => {
    try { const r = await _httpToConvert('PUT', '/config', req.body); res.status(r.status).json(r.body); }
    catch (e) { res.status(502).json({ error: e.message }); }
  });
  app.get('/api/sf/convert/config', async (req, res) => {
    try { const r = await _httpToConvert('GET', '/config'); res.status(r.status).json(r.body); }
    catch (e) { res.status(502).json({ error: e.message }); }
  });
  app.delete('/api/sf/convert/item/:mediaId', async (req, res) => {
    try { const r = await _httpToConvert('DELETE', '/item/' + req.params.mediaId); res.status(r.status).json(r.body); }
    catch (e) { res.status(502).json({ error: e.message }); }
  });



  // =====================================================================
  // ORION_LIBRARY_NORMALIZER_V1
  // Gradually normalize TV episodes for fast HLS remux:
  //   H.264 / yuv420p / AAC
  // =====================================================================

  const NORMALIZER_STATE_FILE = '/var/lib/orion/sf/library-normalizer.json';
  const NORMALIZER_ROOTS = [
    '/mnt/jbod1/media/tv_shows'
  ];

  let normalizerState = {
    enabled: false,
    scanning: false,

    // ── Safety (fix-07) ──────────────────────────────────────────
    // 'alongside' writes a new file and never modifies the source.
    // 'replace' overwrites the original — opt-in only.
    outputMode: 'alongside',
    // When replacing, keep the .orion-backup copy rather than deleting it.
    keepBackup: true,
    // Report what would happen without encoding anything.
    dryRun: false,

    // What to do while someone is actually watching:
    //   'pause'  stop entirely  (safest, default)
    //   'reduce' one worker only
    //   'ignore' run at full rate (sensible for a 3am window)
    playbackPolicy: 'pause',

    // How many days of schedule to normalise ahead. Today only would be
    // too late — an episode airing in an hour will not finish converting
    // in time — so look ahead by default.
    scheduledDays: 3,

    files: {},
    current: {},
    stats: {
      discovered: 0,
      compatible: 0,
      queued: 0,
      converted: 0,
      errors: 0
    }
  };

  function _normalizerLoad() {
    try {
      if (fs.existsSync(NORMALIZER_STATE_FILE)) {
        const d = JSON.parse(fs.readFileSync(NORMALIZER_STATE_FILE, 'utf8'));
        if (d && typeof d === 'object') {
          normalizerState = Object.assign(normalizerState, d);
          normalizerState.files = normalizerState.files || {};
          normalizerState.current = {};
          normalizerState.scanning = false;
        }
      }
    } catch (e) {
      console.error('[Normalizer] state load:', e.message);
    }
  }

  function _normalizerSave() {
    try {
      fs.mkdirSync(path.dirname(NORMALIZER_STATE_FILE), { recursive: true });

      const tmp = NORMALIZER_STATE_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(normalizerState, null, 2));
      fs.renameSync(tmp, NORMALIZER_STATE_FILE);
    } catch (e) {
      console.error('[Normalizer] state save:', e.message);
    }
  }

  function _normalizerExtensions(name) {
    return /\.(mkv|mp4|m4v)$/i.test(name || '');
  }

  function _normalizerWalk(dir, out) {
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }

    for (const ent of ents) {
      if (ent.name === '.hls') continue;
      if (ent.name.includes('.orion-normalizing')) continue;
      if (ent.name.includes('.orion-backup')) continue;

      const full = path.join(dir, ent.name);

      if (ent.isDirectory()) {
        _normalizerWalk(full, out);
      } else if (ent.isFile() && _normalizerExtensions(ent.name)) {
        out.push(full);
      }
    }
  }

  function _normalizerProbe(filePath) {
    try {
      const cp = require('child_process');

      const r = cp.spawnSync(
        'ffprobe',
        [
          '-v', 'error',
          '-show_streams',
          '-show_format',
          '-of', 'json',
          filePath
        ],
        {
          encoding: 'utf8',
          maxBuffer: 16 * 1024 * 1024,
          timeout: 15000        // M4: never let one file wedge the queue
        }
      );

      if (r.error && r.error.code === 'ETIMEDOUT') {
        throw new Error('ffprobe timed out after 15s');
      }

      if (r.status !== 0) {
        throw new Error((r.stderr || 'ffprobe failed').trim());
      }

      const d = JSON.parse(r.stdout || '{}');
      const streams = Array.isArray(d.streams) ? d.streams : [];

      const video = streams.find(x => x.codec_type === 'video');
      const audio = streams.filter(x => x.codec_type === 'audio');

      if (!video) throw new Error('no video stream');

      const duration = Number(
        (d.format && d.format.duration) ||
        video.duration ||
        0
      );

      return {
        videoCodec: String(video.codec_name || '').toLowerCase(),
        pixFmt: String(video.pix_fmt || '').toLowerCase(),
        audioCodecs: audio.map(x =>
          String(x.codec_name || '').toLowerCase()
        ),
        // Codec alone is not enough: a 5.1 AAC file and a stereo AAC file
        // both pass a codec check, then break when concatenated together.
        audioChannels: audio.map(x => parseInt(x.channels, 10) || 0),
        audioRates: audio.map(x => parseInt(x.sample_rate, 10) || 0),
        duration
      };

    } catch (e) {
      throw new Error('probe: ' + e.message);
    }
  }

  function _normalizerCompatible(probe) {
    const videoOK =
      probe.videoCodec === 'h264' &&
      probe.pixFmt === 'yuv420p';

    // A file only counts as normalised when every audio stream is AAC
    // stereo. Anything multichannel gets queued for downmix, so the whole
    // library ends up with one layout and concat joins cleanly.
    const chans = probe.audioChannels || [];
    const audioOK =
      probe.audioCodecs.length === 0 ||
      (probe.audioCodecs.every(c => c === 'aac') &&
       chans.every(n => !n || n <= 2));

    return videoOK && audioOK;
  }

  function _normalizerNeedVideo(probe) {
    return !(
      probe.videoCodec === 'h264' &&
      probe.pixFmt === 'yuv420p'
    );
  }

  function _normalizerNeedAudio(probe) {
    const chans = probe.audioChannels || [];
    return !(
      probe.audioCodecs.length === 0 ||
      (probe.audioCodecs.every(c => c === 'aac') &&
       chans.every(n => !n || n <= 2))
    );
  }

  function _normalizerGpuIds() {
    const caps = require('./capabilities')();

    // No GPU: single CPU worker. Never oversubscribe a small box.
    if (!caps.hasNvenc || caps.gpuCount === 0) return [0];

    // Fixed allocation rather than a time-of-day split: the card set is
    // chosen so preseg and live playback each keep their own, and the
    // playbackPolicy check in the dispatcher handles backing off further
    // when someone is actually watching.
    return _gpuAllocation().normalizer;
  }

  async function _normalizerPresegBusy() {
    try {
      if (!_externalPresegEnabled()) return false;

      const st = await _getFromPreseg('/status');

      return (
        Number(st.processing || 0) > 0 ||
        Number(st.queued || 0) > 0 ||
        Number(st.queueLen || 0) > 0 ||
        Number(st.gpuWorkers || 0) > 0 ||
        Number(st.cpuWorkers || 0) > 0
      );
    } catch (_) {
      // Preseg unreachable. It was previously treated as "busy", which
      // blocked the Normalizer indefinitely whenever the preseg service
      // was stopped or disabled — a service that is not running cannot
      // be doing work, so there is nothing to yield to.
      if (!_presegDownWarned) {
        _presegDownWarned = true;
        console.log('[Normalizer] preseg not reachable — proceeding without yielding');
      }
      return false;
    }
  }

  async function _normalizerScan() {
    if (normalizerState.scanning) return;

    normalizerState.scanning = true;
    normalizerState.scanAbort = false;
    _normalizerSave();

    console.log('[Normalizer] scanning TV library');

    const found = [];

    try {
      for (const root of NORMALIZER_ROOTS) {
        if (fs.existsSync(root)) {
          _normalizerWalk(root, found);
        }
      }

      const seen = new Set();
      let processed = 0;
      normalizerState.scanTotal = found.length;
      normalizerState.scanDone = 0;
      console.log('[Normalizer] walking', found.length, 'files');

      for (const filePath of found) {
        seen.add(filePath);

        await new Promise(r => setImmediate(r));

        // Cancellation point. What has been probed so far is kept —
        // stopping is a pause, not a rollback.
        if (normalizerState.scanAbort) {
          console.log('[Normalizer] scan stopped by request at ' +
            processed + '/' + found.length);
          break;
        }

        normalizerState.scanDone = ++processed;
        if (processed % 25 === 0) _normalizerRecount();
        if (processed % 250 === 0) {
          _normalizerSave();
          console.log('[Normalizer] scan', processed + '/' + found.length);
        }

        let st;
        try {
          st = fs.statSync(filePath);
        } catch (_) {
          continue;
        }

        const old = normalizerState.files[filePath];

        // File unchanged and already successfully classified/converted.
        if (
          old &&
          old.size === st.size &&
          old.mtimeMs === st.mtimeMs &&
          ['compatible', 'converted'].includes(old.status)
        ) {
          continue;
        }

        try {
          const probe = _normalizerProbe(filePath);

          normalizerState.files[filePath] = {
            size: st.size,
            mtimeMs: st.mtimeMs,
            status: _normalizerCompatible(probe)
              ? 'compatible'
              : 'queued',
            videoCodec: probe.videoCodec,
            pixFmt: probe.pixFmt,
            audioCodecs: probe.audioCodecs,
            duration: probe.duration,
            error: null,
            updatedAt: Date.now()
          };

        } catch (e) {
          normalizerState.files[filePath] = {
            size: st.size,
            mtimeMs: st.mtimeMs,
            status: 'error',
            error: e.message,
            updatedAt: Date.now()
          };
        }
      }

      // Remove files no longer present from state.
      for (const filePath of Object.keys(normalizerState.files)) {
        if (!seen.has(filePath) && !fs.existsSync(filePath)) {
          delete normalizerState.files[filePath];
        }
      }

    } finally {
      normalizerState.scanning = false;
      _normalizerRecount();
      _normalizerSave();
      console.log(
        '[Normalizer] scan complete:',
        normalizerState.stats
      );
    }
  }

  // M3: recount is O(n) over every known file and runs on every status
  // poll (every 2s, per open tab). Memoise for a short window.
  let _recountAt = 0;
  let _recountDirty = true;

  function _normalizerRecount(force) {
    if (!force && !_recountDirty && Date.now() - _recountAt < 2000) return;
    _recountAt = Date.now();
    _recountDirty = false;

    const vals = Object.values(normalizerState.files || {});

    // Files queued by queue-scheduled carry scheduled:true, so the batch
    // the user actually asked for can be reported on its own rather than
    // disappearing into the library total.
    const sched = vals.filter(x => x && x.scheduled);
    normalizerState.scheduledStats = {
      total: sched.length,
      converted: sched.filter(x => x.status === 'converted').length,
      queued: sched.filter(x => x.status === 'queued').length,
      compatible: sched.filter(x => x.status === 'compatible').length,
      errors: sched.filter(x => x.status === 'error').length
    };

    normalizerState.stats = {
      discovered: vals.length,
      compatible: vals.filter(x =>
        x.status === 'compatible'
      ).length,
      queued: vals.filter(x =>
        x.status === 'queued'
      ).length,
      converted: vals.filter(x =>
        x.status === 'converted'
      ).length,
      errors: vals.filter(x =>
        x.status === 'error'
      ).length
    };
  }

  // M2: serialising a 30k-entry object on every file completion is
  // expensive and repeated. Coalesce writes into one per interval.
  let _saveTimer = null;
  function _normalizerSaveDebounced() {
    _recountDirty = true;
    if (_saveTimer) return;
    _saveTimer = setTimeout(() => {
      _saveTimer = null;
      try { _normalizerSave(); } catch (e) {
        console.error('[Normalizer] save:', e.message);
      }
    }, 5000);
    _saveTimer.unref?.();
  }

  function _normalizerNextQueued() {
    // Two passes. Anything the scheduler queued for an upcoming slot goes
    // first — object order is effectively alphabetical, so without this a
    // nightly run converts whatever sorts earliest rather than what is
    // about to play, and with a 24k backlog it may never reach it.
    let fallback = null;

    for (const [filePath, item] of
      Object.entries(normalizerState.files || {})) {

      if (item.status !== 'queued') continue;
      if (normalizerState.current[filePath]) continue;

      if (item.scheduled) return filePath;
      if (!fallback) fallback = filePath;
    }

    // Never touch the general backlog. Only files the scheduler queued
    // for an upcoming slot get converted; everything else waits until it
    // is actually scheduled. Set normalizerState.allowBacklog = true to
    // opt back in.
    if (!normalizerState.allowBacklog) return null;

    return fallback;
  }

  function _normalizerTempPath(inputPath) {
    const ext = path.extname(inputPath);
    const base = inputPath.slice(0, -ext.length);

    return base + '.orion-normalizing' + ext;
  }

  /**
   * Where the converted file should end up.
   * alongside → <dir>/<name>.h264.mkv   (original untouched)
   * replace   → the original path        (original overwritten)
   */
  function _normalizerOutputPath(inputPath) {
    if (normalizerState.outputMode === 'replace') return inputPath;
    const ext  = path.extname(inputPath);
    const base = inputPath.slice(0, -ext.length);
    return base + '.h264' + ext;
  }

  /**
   * Where the converted file should end up.
   * alongside → <dir>/<name>.h264.mkv   (original untouched)
   * replace   → the original path        (original overwritten)
   */
  function _normalizerOutputPath(inputPath) {
    if (normalizerState.outputMode === 'replace') return inputPath;
    const ext  = path.extname(inputPath);
    const base = inputPath.slice(0, -ext.length);
    return base + '.h264' + ext;
  }

  function _normalizerBackupPath(inputPath) {
    const ext = path.extname(inputPath);
    const base = inputPath.slice(0, -ext.length);

    return base + '.orion-backup' + ext;
  }

  function _normalizerBuildArgs(inputPath, outputPath, gpu, probe) {
    const needVideo = _normalizerNeedVideo(probe);
    const needAudio = _normalizerNeedAudio(probe);

    const args = ['-hide_banner', '-y'];

    if (needVideo) {
      args.push(
        '-hwaccel', 'cuda',
        '-hwaccel_device', String(gpu),
        '-hwaccel_output_format', 'cuda'
      );
    }

    args.push('-i', inputPath);

    // Preserve every mapped stream where the container permits it.
    args.push('-map', '0');

    if (needVideo) {
      args.push(
        '-vf', 'scale_cuda=format=yuv420p',
        '-c:v', 'h264_nvenc',
        '-gpu', String(gpu),
        // p1 is the fastest NVENC preset, p7 the highest quality. This
        // output is an intermediate for segmentation rather than an
        // archival master, so speed is usually the better trade.
        '-preset', String(normalizerState.preset || 'p4'),
        '-cq', String(normalizerState.cq || 21)
      );
    } else {
      args.push('-c:v', 'copy');
    }

    if (needAudio) {
      // Pin the layout, otherwise a 5.1 source stays 5.1 and the mismatch
      // this whole change exists to remove comes straight back.
      args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-ar', '48000');
    } else {
      args.push('-c:a', 'copy');
    }

    args.push('-c:s', 'copy');
    args.push('-c:d', 'copy');

    args.push(outputPath);

    return args;
  }

  function _normalizerVerify(originalProbe, outputPath) {
    if (!fs.existsSync(outputPath)) {
      throw new Error('temporary output missing');
    }

    const st = fs.statSync(outputPath);

    if (st.size < 1024 * 1024) {
      throw new Error('temporary output unexpectedly small');
    }

    const out = _normalizerProbe(outputPath);

    if (!_normalizerCompatible(out)) {
      throw new Error(
        'verification codec failure: ' +
        out.videoCodec + '/' + out.pixFmt +
        ' audio=' + out.audioCodecs.join(',')
      );
    }

    if (originalProbe.duration > 0 && out.duration > 0) {
      const diff = Math.abs(originalProbe.duration - out.duration);
      const allowed = Math.max(2, originalProbe.duration * 0.01);

      if (diff > allowed) {
        throw new Error(
          'duration mismatch original=' +
          originalProbe.duration.toFixed(2) +
          ' output=' +
          out.duration.toFixed(2)
        );
      }
    }

    return out;
  }

  function _normalizerReplaceOriginal(inputPath, tempPath) {
    // ── alongside: never touch the source ──────────────────────────
    if (normalizerState.outputMode !== 'replace') {
      const outPath = _normalizerOutputPath(inputPath);
      try {
        if (fs.existsSync(outPath)) fs.rmSync(outPath, { force: true });
        fs.renameSync(tempPath, outPath);
        if (!fs.existsSync(outPath)) {
          throw new Error('output file missing after move');
        }
        return outPath;
      } catch (e) {
        try { fs.rmSync(tempPath, { force: true }); } catch (_) {}
        throw new Error('write alongside: ' + e.message);
      }
    }

    // ── replace: opt-in, backup retained unless explicitly disabled ─
    const backup = _normalizerBackupPath(inputPath);

    try {
      if (fs.existsSync(backup)) fs.rmSync(backup, { force: true });

      fs.renameSync(inputPath, backup);

      try {
        fs.renameSync(tempPath, inputPath);
      } catch (e) {
        // Restore original immediately.
        if (!fs.existsSync(inputPath) &&
            fs.existsSync(backup)) {
          fs.renameSync(backup, inputPath);
        }

        throw e;
      }

      // Verify replacement exists before touching the backup.
      if (!fs.existsSync(inputPath)) {
        throw new Error('replacement file disappeared');
      }

      // H1: keep the original by default. Verification is good but not
      // proof — the user can reclaim the space deliberately.
      if (normalizerState.keepBackup === false) {
        fs.rmSync(backup, { force: true });
      }

      return inputPath;

    } catch (e) {
      throw new Error('replace: ' + e.message);
    }
  }

  function _normalizerStartFile(inputPath, gpu) {
    const item = normalizerState.files[inputPath];
    if (!item) return;

    // H1: dry run — mark and report, encode nothing.
    if (normalizerState.dryRun) {
      item.status = 'would-convert';
      item.updatedAt = Date.now();
      _normalizerRecount();
      return;
    }

    // H1: dry run — mark and report, encode nothing.
    if (normalizerState.dryRun) {
      item.status = 'would-convert';
      item.updatedAt = Date.now();
      _normalizerRecount();
      return;
    }

    let probe;

    try {
      probe = _normalizerProbe(inputPath);

      if (_normalizerCompatible(probe)) {
        item.status = 'compatible';
        item.error = null;
        item.updatedAt = Date.now();

        _normalizerRecount();
        _normalizerSave();
        return;
      }

    } catch (e) {
      item.status = 'error';
      item.error = e.message;
      item.updatedAt = Date.now();

      _normalizerRecount();
      _normalizerSave();
      return;
    }

    const tempPath = _normalizerTempPath(inputPath);

    try {
      if (fs.existsSync(tempPath)) {
        fs.rmSync(tempPath, { force: true });
      }
    } catch (_) {}

    const args = _normalizerBuildArgs(
      inputPath,
      tempPath,
      gpu,
      probe
    );

    console.log(
      '[Normalizer] GPU', gpu,
      path.basename(inputPath),
      _normalizerNeedVideo(probe)
        ? 'video->h264'
        : 'video-copy',
      _normalizerNeedAudio(probe)
        ? 'audio->aac'
        : 'audio-copy'
    );

    const ffmpeg =
      (typeof ffmpegPath === 'string' && ffmpegPath)
        ? ffmpegPath
        : 'ffmpeg';

    const proc = spawn(ffmpeg, args);

    normalizerState.current[inputPath] = {
      gpu,
      pid: proc.pid,
      startedAt: Date.now(),
      progress: 0,
      timeSeconds: 0,
      durationSeconds: (item && item.duration) || null,
      name: inputPath.split('/').pop()
    };

    item.status = 'processing';
    item.error = null;

    _normalizerSave();

    let stderr = '';

    proc.stderr.on('data', d => {
      const text = d.toString();
      stderr = (stderr + text).slice(-16384);

      // Same time= parse the encode-jobs feature uses. The probe already
      // gave us the duration, so this turns into a real percentage.
      const cur = normalizerState.current[inputPath];
      if (cur) {
        const tms = text.match(/time=(\d+):(\d+):(\d+\.\d+)/g);
        if (tms && tms.length) {
          const last = tms[tms.length - 1].match(/time=(\d+):(\d+):(\d+\.\d+)/);
          if (last) {
            const secs = (+last[1] * 3600) + (+last[2] * 60) + parseFloat(last[3]);
            cur.timeSeconds = secs;
            const dur = (item && item.duration) || 0;
            if (dur > 0) cur.progress = Math.min(100, (secs / dur) * 100);
          }
        }
      }
    });

    proc.on('error', err => {
      delete normalizerState.current[inputPath];

      item.status = 'error';
      item.error = err.message;
      item.updatedAt = Date.now();

      try {
        fs.rmSync(tempPath, { force: true });
      } catch (_) {}

      _normalizerRecount();
      _normalizerSave();
    });

    proc.on('exit', code => {
      delete normalizerState.current[inputPath];

      if (code !== 0) {
        item.status = 'error';
        item.error =
          'ffmpeg exit ' + code + ': ' +
          stderr.split('\n')
            .filter(Boolean)
            .slice(-5)
            .join(' | ')
            .slice(0, 800);

        try {
          fs.rmSync(tempPath, { force: true });
        } catch (_) {}

        _normalizerRecount();
        _normalizerSave();
        return;
      }

      try {
        const verified =
          _normalizerVerify(probe, tempPath);

        _normalizerReplaceOriginal(
          inputPath,
          tempPath
        );

        const st = fs.statSync(inputPath);

        item.status = 'converted';
        // Keep scheduled:true — the batch counter reads it, and clearing
        // it here removed the file from both numerator and denominator,
        // so the bar could never advance.
        item.size = st.size;
        item.mtimeMs = st.mtimeMs;
        item.videoCodec = verified.videoCodec;
        item.pixFmt = verified.pixFmt;
        item.audioCodecs = verified.audioCodecs;
        item.duration = verified.duration;
        item.error = null;
        item.updatedAt = Date.now();

        console.log(
          '[Normalizer] DONE:',
          inputPath
        );

      } catch (e) {
        item.status = 'error';
        item.error = e.message;
        item.updatedAt = Date.now();

        try {
          if (fs.existsSync(tempPath)) {
            fs.rmSync(tempPath, { force: true });
          }
        } catch (_) {}

        console.error(
          '[Normalizer] VERIFY/REPLACE FAILED:',
          inputPath,
          e.message
        );
      }

      _normalizerRecount();
      _normalizerSave();
    });
  }

  let normalizerDispatchBusy = false;

  async function _normalizerDispatch() {
    if (normalizerDispatchBusy) return;

    // Two independent reasons to be converting: the user pressed Start,
    // or the nightly task is working through its batch. Pausing the
    // former must not cancel the latter.
    const nightlyActive = !!normalizerState.nightlyRunUntil &&
                          Date.now() < normalizerState.nightlyRunUntil;
    if (!normalizerState.enabled && !nightlyActive) return;

    if (normalizerState.scanning) return;

    normalizerDispatchBusy = true;

    try {
      // Scheduled HLS preparation always wins.
      if (await _normalizerPresegBusy()) {
        normalizerState.blockedBy = 'preseg';
        return;
      }

      // Back off while someone is actually watching.
      const policy = normalizerState.playbackPolicy || 'pause';
      let gpuIds = _normalizerGpuIds();

      if (policy !== 'ignore') {
        const _now = Date.now();
        const watching = Object.values(hlsSessions || {})
          .some(x => x && (_now - (x.lastRequest || 0)) < 90000);
        if (watching) {
          if (policy === 'pause') { normalizerState.blockedBy = 'playback'; return; }
          normalizerState.blockedBy = 'playback-reduced';
          if (policy === 'reduce') gpuIds = gpuIds.slice(0, 1);
        }
      }

      const inUse = new Set(
        Object.values(normalizerState.current || {})
          .map(x => Number(x.gpu))
      );

      // Encoders sit around 45% with one job each, so allow a second per
      // card. If the real limit is NFS read throughput this changes
      // nothing; if it is per-job latency, throughput roughly doubles.
      const perGpu = Math.max(1, parseInt(normalizerState.jobsPerGpu, 10) || 2);
      const gpuLoad = {};
      for (const x of Object.values(normalizerState.current || {})) {
        gpuLoad[x.gpu] = (gpuLoad[x.gpu] || 0) + 1;
      }
      for (const gpu of gpuIds) {
        if ((gpuLoad[gpu] || 0) >= perGpu) continue;

        const next = _normalizerNextQueued();
        // Claim it before spawning. _normalizerStartFile registers the
        // entry a tick later, so without this the next iteration of this
        // loop picks the same path and two workers take the same file.
        if (next) normalizerState.current[next] = { claiming: true, gpu, progress: 0 };
        if (!next && nightlyActive && !normalizerState.enabled) {
          // Batch finished. Close the window rather than leaving a
          // background grind running until it times out.
          normalizerState.nightlyRunUntil = 0;
          console.log('[Normalizer] nightly batch complete');
          _normalizerSave();
        }
        if (!next) {
          if (!Object.keys(normalizerState.current || {}).length) {
            normalizerState.blockedBy = 'queue-empty';
          }
          break;
        }
        normalizerState.blockedBy = null;

        _normalizerStartFile(next, gpu);
        inUse.add(gpu);
      }

    } finally {
      normalizerDispatchBusy = false;
    }
  }

  app.get('/api/sf/normalizer/status', (req, res) => {
    _normalizerRecount();

    res.json({
      enabled: normalizerState.enabled,
      scanning: normalizerState.scanning,
      scanAbort: !!normalizerState.scanAbort,
      outputMode: normalizerState.outputMode,
      keepBackup: normalizerState.keepBackup !== false,
      dryRun: !!normalizerState.dryRun,
      scheduledDays: normalizerState.scheduledDays || 3,
      blockedBy: normalizerState.blockedBy || null,
      nightlyActive: !!normalizerState.nightlyRunUntil &&
                     Date.now() < normalizerState.nightlyRunUntil,
      nightlyRunUntil: normalizerState.nightlyRunUntil || 0,
      scheduledStats: normalizerState.scheduledStats || null,
      playbackPolicy: normalizerState.playbackPolicy || 'pause',
      outputMode: normalizerState.outputMode,
      keepBackup: normalizerState.keepBackup !== false,
      dryRun: !!normalizerState.dryRun,
      scheduledDays: normalizerState.scheduledDays || 3,
      blockedBy: normalizerState.blockedBy || null,
      nightlyActive: !!normalizerState.nightlyRunUntil &&
                     Date.now() < normalizerState.nightlyRunUntil,
      nightlyRunUntil: normalizerState.nightlyRunUntil || 0,
      scheduledStats: normalizerState.scheduledStats || null,
      scanDone: normalizerState.scanDone || 0,
      scanTotal: normalizerState.scanTotal || 0,
      roots: NORMALIZER_ROOTS,
      gpuIds: _normalizerGpuIds(),
      gpuAllocation: _gpuAllocation(),
      current: normalizerState.current,
      stats: normalizerState.stats
    });
  });

  app.post('/api/sf/normalizer/start', (req, res) => {
    normalizerState.enabled = true;
    _normalizerSave();

    // No scan here. Walking 33k files takes minutes and start should be
    // instant — the queue already holds whatever the last scan found.
    // Use /rescan (or the Rescan button) to discover new files.

    res.json({
      ok: true,
      enabled: true,
      stats: normalizerState.stats
    });
  });

  // Pause stops the continuous background conversion only. A nightly
  // batch in progress keeps running — use /nightly-stop for that.
  app.post('/api/sf/normalizer/nightly-stop', (req, res) => {
    normalizerState.nightlyRunUntil = 0;
    _normalizerSave();
    console.log('[Normalizer] nightly window closed by request');
    res.json({ ok: true, nightlyActive: false });
  });

  app.post('/api/sf/normalizer/pause', (req, res) => {
    // Does NOT kill active FFmpeg jobs.
    // They finish cleanly; no new jobs are dispatched.
    normalizerState.enabled = false;
    _normalizerSave();

    res.json({
      ok: true,
      enabled: false
    });
  });

  app.post('/api/sf/normalizer/rescan', (req, res) => {
    if (normalizerState.scanning) {
      return res.json({ ok: true, alreadyScanning: true, stats: normalizerState.stats });
    }
    _normalizerScan().catch(e => console.error('[Normalizer] rescan:', e.message));
    res.json({ ok: true, scanning: true, stats: normalizerState.stats });
  });

  // H1: change safety settings. Switching to 'replace' is deliberate and
  // must be sent explicitly — it is never the default.
  app.post('/api/sf/normalizer/settings', (req, res) => {
    const { outputMode, keepBackup, dryRun } = req.body || {};

    if (outputMode !== undefined) {
      if (!['alongside', 'replace'].includes(outputMode)) {
        return res.status(400).json({ error: "outputMode must be 'alongside' or 'replace'" });
      }
      normalizerState.outputMode = outputMode;
      if (outputMode === 'replace') {
        console.warn('[Normalizer] outputMode=replace — source files WILL be overwritten' +
          (normalizerState.keepBackup === false ? ' with NO backup retained' : ' (backups retained)'));
      }
    }

    if (keepBackup !== undefined) normalizerState.keepBackup = !!keepBackup;
    if (dryRun !== undefined)     normalizerState.dryRun     = !!dryRun;

    const { playbackPolicy } = req.body || {};
    if (playbackPolicy !== undefined) {
      if (!['pause', 'reduce', 'ignore'].includes(playbackPolicy)) {
        return res.status(400).json({ error: "playbackPolicy must be pause, reduce or ignore" });
      }
      normalizerState.playbackPolicy = playbackPolicy;
    }

    const { scheduledDays } = req.body || {};
    if (scheduledDays !== undefined) {
      normalizerState.scheduledDays =
        Math.max(1, Math.min(14, parseInt(scheduledDays, 10) || 3));
    }

    _normalizerSave();

    res.json({
      ok: true,
      outputMode: normalizerState.outputMode,
      keepBackup: normalizerState.keepBackup !== false,
      dryRun: !!normalizerState.dryRun
    });
  });

  // H1: change safety settings. Switching to 'replace' is deliberate and
  // must be sent explicitly — it is never the default.
  app.post('/api/sf/normalizer/settings', (req, res) => {
    const { outputMode, keepBackup, dryRun } = req.body || {};

    if (outputMode !== undefined) {
      if (!['alongside', 'replace'].includes(outputMode)) {
        return res.status(400).json({ error: "outputMode must be 'alongside' or 'replace'" });
      }
      normalizerState.outputMode = outputMode;
      if (outputMode === 'replace') {
        console.warn('[Normalizer] outputMode=replace — source files WILL be overwritten' +
          (normalizerState.keepBackup === false ? ' with NO backup retained' : ' (backups retained)'));
      }
    }

    if (keepBackup !== undefined) normalizerState.keepBackup = !!keepBackup;
    if (dryRun !== undefined)     normalizerState.dryRun     = !!dryRun;

    const { playbackPolicy } = req.body || {};
    if (playbackPolicy !== undefined) {
      if (!['pause', 'reduce', 'ignore'].includes(playbackPolicy)) {
        return res.status(400).json({ error: "playbackPolicy must be pause, reduce or ignore" });
      }
      normalizerState.playbackPolicy = playbackPolicy;
    }

    const { scheduledDays } = req.body || {};
    if (scheduledDays !== undefined) {
      normalizerState.scheduledDays =
        Math.max(1, Math.min(14, parseInt(scheduledDays, 10) || 3));
    }

    _normalizerSave();

    res.json({
      ok: true,
      outputMode: normalizerState.outputMode,
      keepBackup: normalizerState.keepBackup !== false,
      dryRun: !!normalizerState.dryRun
    });
  });

  /**
   * Queue only media scheduled in the next N days.
   *
   * Mirrors runDailyScheduledPreseg(): reads /api/sf/schedule for the
   * window, collects unique local file paths, and queues the ones that
   * fail the compatibility check. Remote/IPTV sources are skipped —
   * there is no local file to convert.
   */
  app.post('/api/sf/normalizer/queue-scheduled', async (req, res) => {
    if (normalizerState.scanning) {
      return res.status(409).json({ error: 'a scan is already running' });
    }

    const days = Math.max(1, Math.min(14,
      parseInt(req.body && req.body.days, 10) ||
      normalizerState.scheduledDays || 3));

    const from = new Date();
    from.setHours(0, 0, 0, 0);
    const to = new Date(from);
    to.setDate(to.getDate() + days);

    try {
      const schedule = await new Promise((resolve, reject) => {
        const mod = require('http');
        const port = (sfConfig && sfConfig.port) || 3001;
        const url = '/api/sf/schedule?from=' + from.getTime() +
                    '&to=' + to.getTime();
        const rq = mod.get({ host: '127.0.0.1', port, path: url,
                             timeout: 30000 }, r => {
          let body = '';
          r.on('data', c => body += c);
          r.on('end', () => {
            try { resolve(JSON.parse(body)); }
            catch (e) { reject(new Error('bad schedule response')); }
          });
        });
        rq.on('error', reject);
        rq.on('timeout', () => { rq.destroy(); reject(new Error('schedule timeout')); });
      });

      const seen = new Set();
      let considered = 0, queued = 0, alreadyOk = 0, missing = 0, failed = 0;
      let alreadyQueued = 0;
      const missingPaths = [];

      for (const channel of (Array.isArray(schedule) ? schedule : [])) {
        for (const prog of (channel.programs || [])) {
          if (!prog || !prog.filePath) continue;
          if (/^https?:\/\//i.test(prog.filePath)) continue;   // remote source
          if (seen.has(prog.filePath)) continue;
          seen.add(prog.filePath);
          considered++;

          if (!fs.existsSync(prog.filePath)) {
            missing++;
            if (missingPaths.length < 200) missingPaths.push(prog.filePath);
            continue;
          }

          const existing = normalizerState.files[prog.filePath];
          if (existing && ['compatible', 'converted'].includes(existing.status)) {
            alreadyOk++;
            continue;
          }
          if (existing && ['queued', 'processing'].includes(existing.status)) {
            alreadyQueued++;
            // Flag it even though it was already queued, otherwise it
            // converts without counting toward the batch and the progress
            // bar stalls while work is plainly happening.
            existing.scheduled = true;
            continue;
          }

          let st;
          try { st = fs.statSync(prog.filePath); } catch (_) {
            missing++;
            if (missingPaths.length < 200) missingPaths.push(prog.filePath);
            continue;
          }

          try {
            const probe = _normalizerProbe(prog.filePath);
            const ok = _normalizerCompatible(probe);

            normalizerState.files[prog.filePath] = {
              size: st.size,
              mtimeMs: st.mtimeMs,
              status: ok ? 'compatible' : 'queued',
              videoCodec: probe.videoCodec,
              pixFmt: probe.pixFmt,
              audioCodecs: probe.audioCodecs,
              duration: probe.duration,
              error: null,
              scheduled: true,
              updatedAt: Date.now()
            };

            if (ok) alreadyOk++; else queued++;

          } catch (e) {
            failed++;
            normalizerState.files[prog.filePath] = {
              size: st.size,
              mtimeMs: st.mtimeMs,
              status: 'error',
              error: e.message,
              scheduled: true,
              updatedAt: Date.now()
            };
          }
        }
      }

      // Open a conversion window so this batch runs even when the
      // Normalizer is paused. Capped so a stuck batch cannot grind on
      // for days; the next nightly run reopens it.
      if (queued > 0 || alreadyQueued > 0) {
        const hours = Math.max(1, Math.min(24,
          parseInt(normalizerState.nightlyMaxHours, 10) || 8));
        normalizerState.nightlyRunUntil = Date.now() + hours * 3600 * 1000;
        console.log('[Normalizer] nightly window open for ' + hours + 'h (' +
          queued + ' file(s) queued)');
      }

      _normalizerRecount();
      _normalizerSave();

      console.log('[Normalizer] scheduled scope: ' + considered + ' scheduled, ' +
        queued + ' newly queued, ' + alreadyQueued + ' already queued, ' +
        alreadyOk + ' already fine, ' + missing + ' missing, ' +
        failed + ' probe errors');

      if (missingPaths.length) {
        console.warn('[Normalizer] scheduled media missing from disk (' +
          missing + '). First few:');
        for (const p of missingPaths.slice(0, 10)) console.warn('    ' + p);
      }

      res.json({
        ok: true, days, considered, queued, alreadyQueued,
        alreadyOk, missing, failed,
        missingPaths
      });

    } catch (e) {
      console.error('[Normalizer] queue-scheduled failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // Ask a running scan to stop. It finishes the current file and exits.
  app.post('/api/sf/normalizer/scan-stop', (req, res) => {
    if (!normalizerState.scanning) {
      return res.json({ ok: true, scanning: false, message: 'no scan running' });
    }
    normalizerState.scanAbort = true;
    console.log('[Normalizer] stop requested');
    res.json({ ok: true, stopping: true });
  });

  /**
   * Remove schedule entries whose media is gone.
   *
   * Checks every channel's scheduledPrograms, playout list and series
   * schedule against the media table and the filesystem, and drops what
   * cannot be played. Safe to run at any time: it only removes entries
   * that would already fail.
   */
  app.post('/api/sf/schedule/clean', (req, res) => {
    // DISABLED: this removed 783 valid entries twice, wiping restored
    // series schedules. The validity check compares against the media
    // table, but schedule entries reference media by ids that no longer
    // line up after a reorganisation, so almost everything fails it.
    // Needs rewriting to check the filesystem, and to be dry-run first.
    return res.status(503).json({
      error: 'schedule clean is disabled — it over-prunes valid entries'
    });
    // eslint-disable-next-line no-unreachable
    try {
      const validIds = new Set();
      const validPaths = new Set();
      try {
        for (const m of getMediaCombined()) {
          if (m.id) validIds.add(m.id);
          const p = m.path || m.filePath;
          if (p) validPaths.add(p);
        }
      } catch (_) {}

      const _ok = (mediaId, filePath) => {
        if (mediaId && validIds.has(mediaId)) return true;
        if (filePath && validPaths.has(filePath)) return true;
        if (filePath && /^https?:\/\//i.test(filePath)) return true;
        if (filePath) { try { return fs.existsSync(filePath); } catch (_) { return false; } }
        return false;
      };

      let removedProgs = 0, removedPlayout = 0, removedEpisodes = 0;
      const perChannel = [];

      for (const ch of (sfDb.channels || [])) {
        let n = 0;

        if (Array.isArray(ch.scheduledPrograms)) {
          const before = ch.scheduledPrograms.length;
          ch.scheduledPrograms = ch.scheduledPrograms
            .filter(p => _ok(p.mediaId, p.filePath));
          n += before - ch.scheduledPrograms.length;
          removedProgs += before - ch.scheduledPrograms.length;
        }

        if (Array.isArray(ch.playout)) {
          const before = ch.playout.length;
          ch.playout = ch.playout.filter(p => _ok(p.mediaId, p.filePath));
          n += before - ch.playout.length;
          removedPlayout += before - ch.playout.length;
        }

        if (ch.seriesSchedule && Array.isArray(ch.seriesSchedule.episodes)) {
          const before = ch.seriesSchedule.episodes.length;
          ch.seriesSchedule.episodes = ch.seriesSchedule.episodes
            .filter(e => _ok(e.mediaId, e.filePath));
          n += before - ch.seriesSchedule.episodes.length;
          removedEpisodes += before - ch.seriesSchedule.episodes.length;
        }

        if (n) {
          perChannel.push({ channel: ch.name, removed: n });
          // force a fresh schedule next time it is asked for
          ch.scheduledProgramsGeneratedAt = 0;
        }
      }

      const total = removedProgs + removedPlayout + removedEpisodes;
      if (total) saveAll();

      console.log('[Schedule] clean removed ' + total + ' broken entries across ' +
        perChannel.length + ' channel(s)');

      res.json({
        ok: true, total,
        scheduledPrograms: removedProgs,
        playout: removedPlayout,
        seriesEpisodes: removedEpisodes,
        channels: perChannel
      });
    } catch (e) {
      console.error('[Schedule] clean failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * Force every channel to regenerate its schedule from current media.
   * Heavier than clean — a channel's position in its programme changes.
   */
  app.post('/api/sf/schedule/rebuild', (req, res) => {
    try {
      let n = 0;
      for (const ch of (sfDb.channels || [])) {
        if (ch.liveStreamId) continue;
        ch.scheduledProgramsGeneratedAt = 0;
        ch.scheduledPrograms = [];
        n++;
      }
      saveAll();
      console.log('[Schedule] rebuild queued for ' + n + ' channel(s)');
      res.json({ ok: true, channels: n,
        message: 'Schedules will regenerate on next request' });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/sf/normalizer/retry-errors', (req, res) => {
    for (const item of Object.values(normalizerState.files || {})) {
      if (item.status === 'error') {
        item.status = 'queued';
        item.error = null;
      }
    }

    _normalizerRecount();
    _normalizerSave();

    res.json({
      ok: true,
      stats: normalizerState.stats
    });
  });

  _normalizerLoad();

  // Small periodic dispatcher.
  setInterval(() => {
    _normalizerDispatch().catch(e =>
      console.error('[Normalizer] dispatch:', e.message)
    );
  }, 5000);

  // Rescan once every six hours while enabled.
  setInterval(() => {
    if (normalizerState.enabled &&
        !normalizerState.scanning) {
      _normalizerScan().catch(e =>
        console.error('[Normalizer] rescan:', e.message)
      );
    }
  }, 6 * 60 * 60 * 1000);


  // ─── Encode Jobs (Video + Audio) ─────────────────────────────────
  const encodeJobs = new Map(); // jobId -> job object
  let encodeJobCounter = 0;
  const ENCODE_MAX_JOBS_KEPT = 50;

  function _cleanupEncodeJobs() {
    if (encodeJobs.size <= ENCODE_MAX_JOBS_KEPT) return;
    const arr = Array.from(encodeJobs.values()).sort((a, b) => b.startedAt - a.startedAt);
    for (let i = ENCODE_MAX_JOBS_KEPT; i < arr.length; i++) {
      if (arr[i].status !== 'running') encodeJobs.delete(arr[i].id);
    }
  }

  function _buildVideoArgs(body) {
    const { inputPath, encoder, preset, qualityCq, gpu, resolution, audio } = body;
    const validEncoders = ['h264_nvenc', 'hevc_nvenc', 'libx264', 'libx265'];
    if (!validEncoders.includes(encoder)) throw new Error('invalid video encoder');

    const isNvenc = encoder.endsWith('_nvenc');
    const validPresets = isNvenc
      ? ['p1','p2','p3','p4','p5','p6','p7']
      : ['ultrafast','superfast','veryfast','faster','fast','medium','slow','slower','veryslow'];
    const usePreset = validPresets.includes(preset) ? preset : (isNvenc ? 'p4' : 'medium');
    const useQuality = Math.max(15, Math.min(35, Number(qualityCq) || 21));
    const useGpu = isNvenc ? Math.max(0, Math.min(7, Number(gpu) || 0)) : null;
    const validResolutions = ['original', '3840x2160', '1920x1080', '1280x720', '854x480'];
    const useResolution = validResolutions.includes(resolution) ? resolution : 'original';
    const validAudio = ['copy', 'aac_128k', 'ac3_640k'];
    const useAudio = validAudio.includes(audio) ? audio : 'copy';

    const args = [];
    if (isNvenc) {
      args.push('-hwaccel', 'cuda', '-hwaccel_device', String(useGpu));
      args.push('-hwaccel_output_format', 'cuda');
    }
    args.push('-i', inputPath);

    // NVENC h264/hevc on Pascal needs 8-bit output (yuv420p); use scale_cuda even when no resize
    const filters = [];
    if (isNvenc) {
      if (useResolution !== 'original') {
        const parts = useResolution.split('x');
        filters.push('scale_cuda=' + parts[0] + ':' + parts[1] + ':format=yuv420p');
      } else {
        filters.push('scale_cuda=format=yuv420p');
      }
    } else if (useResolution !== 'original') {
      const parts = useResolution.split('x');
      filters.push('scale=' + parts[0] + ':' + parts[1]);
    }
    if (filters.length > 0) args.push('-vf', filters.join(','));

    args.push('-c:v', encoder);
    args.push('-preset', usePreset);
    if (isNvenc) args.push('-cq', String(useQuality));
    else args.push('-crf', String(useQuality));

    if (useAudio === 'copy') args.push('-c:a', 'copy');
    else if (useAudio === 'aac_128k') args.push('-c:a', 'aac', '-b:a', '128k');
    else if (useAudio === 'ac3_640k') args.push('-c:a', 'ac3', '-b:a', '640k');

    return {
      args,
      outputExt: '.mp4',
      meta: { mediaType: 'video', encoder, preset: usePreset, qualityCq: useQuality, gpu: useGpu, resolution: useResolution, audio: useAudio },
    };
  }

  function _buildAudioArgs(body) {
    const { inputPath, encoder, bitrate, sampleRate, channels, compressionLevel } = body;
    const validEncoders = ['aac', 'libmp3lame', 'flac', 'libopus', 'ac3'];
    if (!validEncoders.includes(encoder)) throw new Error('invalid audio encoder');

    const extByCodec = { aac: '.m4a', libmp3lame: '.mp3', flac: '.flac', libopus: '.opus', ac3: '.ac3' };
    const outputExt = extByCodec[encoder];

    const validBitrates = ['64k','96k','128k','160k','192k','256k','320k','640k'];
    const useBitrate = validBitrates.includes(bitrate) ? bitrate : '192k';
    const useSampleRate = (sampleRate && sampleRate !== 'source') ? String(sampleRate) : null;
    const chMap = { mono: '1', stereo: '2', '5.1': '6' };
    const useChannels = (channels && channels !== 'source' && chMap[channels]) ? chMap[channels] : null;
    const useCompression = Math.max(0, Math.min(12, Number(compressionLevel) || 8));

    const args = ['-i', inputPath, '-vn', '-c:a', encoder];

    if (encoder === 'flac') {
      args.push('-compression_level', String(useCompression));
    } else {
      args.push('-b:a', useBitrate);
    }

    if (useSampleRate) args.push('-ar', useSampleRate);
    if (useChannels) args.push('-ac', useChannels);

    return {
      args,
      outputExt,
      meta: {
        mediaType: 'audio', encoder,
        bitrate: encoder === 'flac' ? null : useBitrate,
        sampleRate: useSampleRate, channels: channels,
        compressionLevel: encoder === 'flac' ? useCompression : null,
      },
    };
  }

  app.post('/api/sf/encode/start', async (req, res) => {
    try {
      const body = req.body || {};
      const { inputPath, outputPath } = body;
      const mediaType = body.mediaType === 'audio' ? 'audio' : 'video';

      if (!inputPath) return res.status(400).json({ error: 'inputPath is required' });
      if (!fs.existsSync(inputPath)) return res.status(404).json({ error: 'input file not found: ' + inputPath });

      let built;
      try {
        built = (mediaType === 'audio') ? _buildAudioArgs(body) : _buildVideoArgs(body);
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }

      const ext = path.extname(inputPath);
      const base = ext ? inputPath.slice(0, -ext.length) : inputPath;
      const useOutput = outputPath || (base + '.encoded' + built.outputExt);

      try { fs.mkdirSync(path.dirname(useOutput), { recursive: true }); } catch (e) {}

      const finalArgs = built.args.slice();
      finalArgs.push('-y', useOutput);

      const ffmpeg = (typeof ffmpegPath === 'string' && ffmpegPath) ? ffmpegPath : 'ffmpeg';
      const proc = spawn(ffmpeg, finalArgs);

      const jobId = 'enc_' + Date.now() + '_' + (++encodeJobCounter);
      const job = Object.assign({
        id: jobId, inputPath, outputPath: useOutput,
        pid: proc.pid, status: 'running',
        progress: 0, timeSeconds: 0, durationSeconds: null,
        stderr: '', startedAt: Date.now(), finishedAt: null,
        exitCode: null, error: null,
      }, built.meta);
      encodeJobs.set(jobId, job);
      _cleanupEncodeJobs();

      proc.stderr.on('data', d => {
        const text = d.toString();
        job.stderr = (job.stderr + text).slice(-8192);
        if (job.durationSeconds === null) {
          const dm = text.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
          if (dm) job.durationSeconds = (+dm[1] * 3600) + (+dm[2] * 60) + parseFloat(dm[3]);
        }
        const tms = text.match(/time=(\d+):(\d+):(\d+\.\d+)/g);
        if (tms && tms.length) {
          const last = tms[tms.length - 1].match(/time=(\d+):(\d+):(\d+\.\d+)/);
          if (last) {
            job.timeSeconds = (+last[1] * 3600) + (+last[2] * 60) + parseFloat(last[3]);
            if (job.durationSeconds) job.progress = Math.min(100, (job.timeSeconds / job.durationSeconds) * 100);
          }
        }
      });
      proc.on('error', err => { job.status = 'error'; job.error = err.message; job.finishedAt = Date.now(); });
      proc.on('exit', (code, signal) => {
        job.finishedAt = Date.now();
        job.exitCode = code;
        if (job.status === 'cancelled') return;
        if (code === 0) { job.status = 'done'; job.progress = 100; }
        else {
          job.status = 'error';
          const lastLines = job.stderr.split('\n').filter(l => l.trim()).slice(-6).join(' | ');
          job.error = signal ? ('Killed by ' + signal) : ('Exit ' + code + ': ' + lastLines.slice(0, 400));
        }
      });

      res.json({ jobId, status: 'started', outputPath: useOutput, pid: proc.pid });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/sf/encode/jobs', (req, res) => {
    const out = Array.from(encodeJobs.values())
      .sort((a, b) => b.startedAt - a.startedAt)
      .map(j => {
        const base = {
          id: j.id, inputPath: j.inputPath, outputPath: j.outputPath,
          mediaType: j.mediaType || 'video', encoder: j.encoder,
          status: j.status, progress: j.progress,
          timeSeconds: j.timeSeconds, durationSeconds: j.durationSeconds,
          startedAt: j.startedAt, finishedAt: j.finishedAt,
          error: j.error,
        };
        if ((j.mediaType || 'video') === 'video') {
          return Object.assign(base, { preset: j.preset, qualityCq: j.qualityCq, gpu: j.gpu, resolution: j.resolution, audio: j.audio });
        } else {
          return Object.assign(base, { bitrate: j.bitrate, sampleRate: j.sampleRate, channels: j.channels, compressionLevel: j.compressionLevel });
        }
      });
    res.json({ jobs: out });
  });

  app.delete('/api/sf/encode/jobs/:id', (req, res) => {
    const job = encodeJobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'not found' });
    if (job.status === 'running' && job.pid) {
      try {
        process.kill(job.pid, 'SIGTERM');
        setTimeout(() => { try { process.kill(job.pid, 'SIGKILL'); } catch (_) {} }, 5000);
      } catch (e) {}
      job.status = 'cancelled';
      job.finishedAt = Date.now();
    } else if (job.status !== 'running') {
      encodeJobs.delete(req.params.id);
    }
    res.json({ ok: true });
  });

  app.get('/api/services', (req, res) => {
    try {
      const { execSync } = require('child_process');
      const cfgRoot = JSON.parse(fs.readFileSync('/var/lib/orion/config.json', 'utf8'));
      const svcs = cfgRoot.services || {};
      const out = [];
      for (const name of Object.keys(svcs)) {
        const svc = svcs[name] || {};
        let active = false, enabled = false;
        if (svc.systemdUnit) {
          try { active = execSync(`systemctl is-active ${svc.systemdUnit}`, { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }).trim() === 'active'; } catch {}
          try { enabled = execSync(`systemctl is-enabled ${svc.systemdUnit}`, { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }).trim() === 'enabled'; } catch {}
        }
        out.push({
          name,
          description: svc.description || name,
          port: svc.port || null,
          systemdUnit: svc.systemdUnit || null,
          configEnabled: svc.enabled !== false,
          active,
          enabledOnBoot: enabled
        });
      }
      res.json(out);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // === [system_gpus] live per-GPU stats from nvidia-smi (cached 2s) ===
  let _gpuStatsCache = null;
  let _gpuStatsCacheAt = 0;
  app.get('/api/system/gpus', (req, res) => {
    const now = Date.now();
    if (_gpuStatsCache && (now - _gpuStatsCacheAt) < 2000) return res.json(_gpuStatsCache);
    const { exec } = require('child_process');
    exec(
      'nvidia-smi --query-gpu=index,name,utilization.gpu,utilization.encoder,utilization.decoder,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits',
      { timeout: 3000 },
      (err, stdout) => {
        if (err) return res.json([]); // no GPUs / nvidia-smi missing — empty array, UI handles
        try {
          const gpus = stdout.trim().split('\n').filter(Boolean).map(line => {
            const parts = line.split(',').map(s => s.trim());
            return {
              index: parseInt(parts[0], 10),
              name: parts[1],
              utilization: parseInt(parts[2], 10) || 0,
              encoder: parseInt(parts[3], 10) || 0,
              decoder: parseInt(parts[4], 10) || 0,
              memoryUsedMb: parseInt(parts[5], 10) || 0,
              memoryTotalMb: parseInt(parts[6], 10) || 0,
              temperature: parseInt(parts[7], 10) || 0
            };
          });
          _gpuStatsCache = gpus;
          _gpuStatsCacheAt = now;
          res.json(gpus);
        } catch (e) {
          res.json([]);
        }
      }
    );
  });

    // === [system_stats] /proc-based CPU/memory/disk/network stats (cached 1s) ===
  const _fs = require('fs');
  let _statsCache = null, _statsCacheAt = 0;
  let _lastCpuSample = null, _lastDiskSample = null, _lastNetSample = null;

  function _readCpuStat() {
    const out = {};
    try {
      _fs.readFileSync('/proc/stat', 'utf8').split('\n').forEach(line => {
        const m = line.match(/^(cpu\d*)\s+(.+)$/);
        if (!m) return;
        const f = m[2].trim().split(/\s+/).map(Number);
        const total = f.slice(0, 8).reduce((a, b) => a + (b || 0), 0);
        const idle = (f[3] || 0) + (f[4] || 0);
        out[m[1]] = { total, idle };
      });
    } catch (e) {}
    return out;
  }

  function _readMemInfo() {
    const m = {};
    try {
      _fs.readFileSync('/proc/meminfo', 'utf8').split('\n').forEach(line => {
        const [k, v] = line.split(':');
        if (!v) return;
        m[k.trim()] = parseInt(v.trim().split(/\s+/)[0], 10) * 1024;
      });
    } catch (e) {}
    return {
      total:      m.MemTotal || 0,
      available:  m.MemAvailable || 0,
      free:       m.MemFree || 0,
      cached:    (m.Cached || 0) + (m.Buffers || 0),
      swapTotal:  m.SwapTotal || 0,
      swapFree:   m.SwapFree || 0
    };
  }

  function _readDiskStats() {
    const out = {};
    try {
      _fs.readFileSync('/proc/diskstats', 'utf8').split('\n').forEach(line => {
        const f = line.trim().split(/\s+/);
        if (f.length < 14) return;
        const name = f[2];
        // Real block devices only
        if (!/^(sd[a-z]+|nvme\d+n\d+|hd[a-z]+|vd[a-z]+|mmcblk\d+|xvd[a-z]+)$/.test(name)) return;
        out[name] = {
          readSectors:  parseInt(f[5], 10) || 0,
          writeSectors: parseInt(f[9], 10) || 0
        };
      });
    } catch (e) {}
    return out;
  }

  function _readNetStats() {
    const out = {};
    try {
      const lines = _fs.readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2);
      lines.forEach(line => {
        const m = line.match(/^\s*(\S+):\s*(.+)$/);
        if (!m) return;
        const name = m[1];
        if (name === 'lo') return;
        const f = m[2].trim().split(/\s+/).map(Number);
        out[name] = { rxBytes: f[0] || 0, txBytes: f[8] || 0 };
      });
    } catch (e) {}
    return out;
  }

  app.get('/api/system/stats', (req, res) => {
    const now = Date.now();
    if (_statsCache && (now - _statsCacheAt) < 1000) return res.json(_statsCache);

    const cpuSample  = _readCpuStat();
    const diskSample = _readDiskStats();
    const netSample  = _readNetStats();
    const mem        = _readMemInfo();

    // CPU delta
    let cpuOverall = 0;
    const cores = [];
    if (_lastCpuSample) {
      for (const key of Object.keys(cpuSample)) {
        const cur = cpuSample[key];
        const prev = _lastCpuSample[key];
        if (!prev) continue;
        const td = cur.total - prev.total;
        const id = cur.idle - prev.idle;
        const usage = td > 0 ? Math.max(0, Math.min(100, (1 - id / td) * 100)) : 0;
        if (key === 'cpu') cpuOverall = usage;
        else cores.push({ index: parseInt(key.slice(3), 10), usage });
      }
    }
    cores.sort((a, b) => a.index - b.index);
    _lastCpuSample = cpuSample;

    // Disk delta
    const disks = [];
    if (_lastDiskSample) {
      const dt = (now - _lastDiskSample.t) / 1000;
      for (const name of Object.keys(diskSample)) {
        const cur = diskSample[name], prev = _lastDiskSample.data[name];
        if (!prev || dt <= 0) continue;
        disks.push({
          name,
          readMbS:  ((cur.readSectors  - prev.readSectors)  * 512) / dt / 1e6,
          writeMbS: ((cur.writeSectors - prev.writeSectors) * 512) / dt / 1e6
        });
      }
    }
    _lastDiskSample = { t: now, data: diskSample };

    // Network delta
    const nets = [];
    if (_lastNetSample) {
      const ndt = (now - _lastNetSample.t) / 1000;
      for (const name of Object.keys(netSample)) {
        const cur = netSample[name], prev = _lastNetSample.data[name];
        if (!prev || ndt <= 0) continue;
        nets.push({
          name,
          rxMbS: (cur.rxBytes - prev.rxBytes) / ndt / 1e6,
          txMbS: (cur.txBytes - prev.txBytes) / ndt / 1e6
        });
      }
    }
    _lastNetSample = { t: now, data: netSample };

    _statsCache = { cpu: { overall: cpuOverall, cores }, memory: mem, disk: disks, network: nets };
    _statsCacheAt = now;
    res.json(_statsCache);
  });

    app.post('/api/services/:name/:action', (req, res) => {
    const { name, action } = req.params;
    if (!['start', 'stop', 'restart', 'enable', 'disable'].includes(action)) {
      return res.status(400).json({ error: 'action must be start|stop|restart|enable|disable' });
    }
    try {
      const cfgRoot = JSON.parse(fs.readFileSync('/var/lib/orion/config.json', 'utf8'));
      const svc = ((cfgRoot.services || {})[name]) || null;
      if (!svc || !svc.systemdUnit) return res.status(404).json({ error: 'service not found or no systemd unit' });
      // Safety: only allow orion-* units
      if (!/^orion-[a-z0-9_-]+\.service$/.test(svc.systemdUnit)) {
        return res.status(403).json({ error: 'unit not whitelisted' });
      }
      const { exec } = require('child_process');
      exec(`sudo systemctl ${action} ${svc.systemdUnit}`, { timeout: 30000 }, (err, stdout, stderr) => {
        if (err) {
          console.error(`[services] systemctl ${action} ${svc.systemdUnit} failed:`, stderr || err.message);
          return res.status(500).json({ error: stderr || err.message });
        }
        // Also reflect in config.json for "enable" / "disable"
        if (action === 'enable' || action === 'disable') {
          try {
            cfgRoot.services[name].enabled = (action === 'enable');
            fs.writeFileSync('/var/lib/orion/config.json', JSON.stringify(cfgRoot, null, 2));
          } catch (e) { console.error('[services] config write failed:', e.message); }
        }
        res.json({ ok: true, action, service: name, unit: svc.systemdUnit });
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/services/:name/logs', (req, res) => {
    const { name } = req.params;
    const lines = parseInt(req.query.lines, 10) || 50;
    try {
      const cfgRoot = JSON.parse(fs.readFileSync('/var/lib/orion/config.json', 'utf8'));
      const svc = ((cfgRoot.services || {})[name]) || null;
      if (!svc || !svc.systemdUnit) return res.status(404).json({ error: 'service not found' });
      if (!/^orion-[a-z0-9_-]+\.service$/.test(svc.systemdUnit)) {
        return res.status(403).json({ error: 'unit not whitelisted' });
      }
      const { exec } = require('child_process');
      exec(`sudo journalctl -u ${svc.systemdUnit} --no-pager -n ${lines} -o cat`, { timeout: 5000 }, (err, stdout) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ unit: svc.systemdUnit, lines: stdout.split('\n') });
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/sf/channels/:id', (req, res) => {
    const ch = sfDb.channels.find(c=>c.id===req.params.id);
    if (!ch) return res.status(404).json({ error:'not found' });
    res.json(ch);
  });
  app.post('/api/sf/channels', (req, res) => {
    const { name, num, group, logo, epgChannelId, liveStreamId } = req.body;
    if (!name) return res.status(400).json({ error:'name required' });
    const maxNum = sfDb.channels.length ? Math.max(...sfDb.channels.map(c=>c.num||0)) : 0;
    const ch = { id:uuidv4(), name, num:num||maxNum+1, group:group||'', logo:logo||'', epgChannelId:epgChannelId||'', liveStreamId:liveStreamId||null, playout:[], timeBlocks:[], active:true, createdAt:new Date().toISOString() };
    sfDb.channels.push(ch); _sfChannelsById.set(ch.id, ch); saveAll(); res.status(201).json(ch);
  });
  app.put('/api/sf/channels/:id', (req, res) => {
    const idx = sfDb.channels.findIndex(c=>c.id===req.params.id);
    if (idx===-1) return res.status(404).json({ error:'not found' });
    Object.assign(sfDb.channels[idx], req.body, { id:req.params.id });
    saveAll(); res.json(sfDb.channels[idx]);
  });
  app.delete('/api/sf/channels/:id', (req, res) => {
    sfDb.channels = sfDb.channels.filter(c=>c.id!==req.params.id);
    if (hlsSessions[req.params.id]) { try{hlsSessions[req.params.id].proc.kill('SIGKILL');}catch{} delete hlsSessions[req.params.id]; }
    saveAll(); res.json({ ok:true });
  });

  // Playout queue
  app.get('/api/sf/channels/:id/playout', (req, res) => {
    const ch = sfDb.channels.find(c=>c.id===req.params.id);
    if (!ch) return res.status(404).json({ error:'not found' });
    const queue = (ch.playout||[]).map(b => {
      if (b.streamId) { const stream=getSfStream(b.streamId); return {...b,stream}; }
      return { ...b, item: getMediaById(b.mediaId)||null };
    });
    res.json(queue);
  });
  app.put('/api/sf/channels/:id/playout', (req, res) => {
    const ch = sfDb.channels.find(c=>c.id===req.params.id);
    if (!ch) return res.status(404).json({ error:'not found' });
    ch.playout = (req.body||[]).map(b => b.streamId ? { streamId:b.streamId, duration:b.duration||3600 } : { mediaId:b.mediaId, title:b.title||'' });
    if (req.body.playoutStart) ch.playoutStart = req.body.playoutStart;
    saveAll(); res.json({ ok:true });
  });

  // Clear playout for all (or specific) channels
  app.post('/api/sf/channels/clear-all-playout', (req, res) => {
    const { channelIds } = req.body || {};
    let cleared = 0;
    for (const ch of sfDb.channels) {
      if (channelIds && !channelIds.includes(ch.id)) continue;
      if (ch.playout?.length) { ch.playout = []; cleared++; }
    }
    saveAll();
    console.log(`[SF] Cleared playout for ${cleared} channels`);
    res.json({ ok: true, cleared });
  });

  // Now playing
  // Returns all items in a channel's genreLoop collection — used to show queue count/preview
  app.get('/api/sf/channels/:id/collection-items', (req, res) => {
    const ch = sfDb.channels.find(c=>c.id===req.params.id);
    if (!ch) return res.status(404).json({ error:'not found' });
    const genreLoopList = ch.genreLoops?.length ? ch.genreLoops : (ch.genreLoop?.genre ? [ch.genreLoop] : []);
    if (!genreLoopList.length) return res.json({ count:0, items:[] });
    let allItems = [];
    const seen = new Set();
    for (const loop of genreLoopList) {
      const { genre, mediaType, matchType } = loop;
      const g = genre.toLowerCase();
      let items = [];
      if (matchType === 'network') {
        const idx = getNetworkIndex();
        items = idx.get(g) || [];
        if (!items.length) {
          const arr = [];
          for (const [k,v] of idx.entries()) { if (k.includes(g) || g.includes(k)) arr.push(...v); }
          items = arr;
        }
        if (mediaType === 'movie') items = items.filter(m => m.type === 'movie');
        if (mediaType === 'episode') items = items.filter(m => m.type === 'episode' || m.season != null);
      } else {
        items = getMediaCombined().filter(m => {
          if (mediaType === 'movie' && m.type !== 'movie') return false;
          if (mediaType === 'episode' && m.type !== 'episode') return false;
          const genres = (m.genres||[]).map(x=>x.toLowerCase());
          return genres.some(gn=>gn.includes(g)||g.includes(gn)) || m.title?.toLowerCase().includes(g);
        });
      }
      for (const item of items) {
        if (!seen.has(item.id)) { seen.add(item.id); allItems.push(item); }
      }
    }
    allItems.sort((a,b)=>((a.season||0)*1000+(a.episode||0))-((b.season||0)*1000+(b.episode||0)));
    res.json({
      count: allItems.length,
      items: allItems.map(m=>({ id:m.id, title:m.seriesTitle||m.title, season:m.season, episode:m.episode, episodeTitle:m.title!==m.seriesTitle?m.title:null }))
    });
  });

  app.get('/api/sf/channels/:id/now-playing', (req, res) => {
    const ch = sfDb.channels.find(c=>c.id===req.params.id);
    if (!ch) return res.status(404).json({ error:'not found' });
    const now = getPlayoutNow(ch, Date.now());
    if (!now) return res.json({ title:'Nothing scheduled', next:null });
    const title = now.isLive ? (now.stream?.name||'Live Stream') : (now.item?.title||'Unknown');
    res.json({ title, isLive:!!now.isLive, startTime:now.startTime, endTime:now.endTime });
  });

  // Debug: show fields available on orionDb items
  app.get('/api/sf/debug/playout-now', (req, res) => {
    const results = {};
    sfDb.channels.filter(c=>!c.liveStreamId).forEach(ch => {
      const now = getPlayoutNow(ch, Date.now());
      results[ch.name] = now ? {
        title: now.item?.title || now.stream?.name || 'live',
        offsetSeconds: now.offsetSeconds,
        offsetFormatted: now.offsetSeconds ? `${Math.floor(now.offsetSeconds/60)}m ${now.offsetSeconds%60}s` : '0s',
        duration: now.item?.duration,
        sessionRunning: !!hlsSessions[ch.id],
        sessionOffset: hlsSessions[ch.id] ? 'running' : 'not started',
      } : { error: 'null — no content scheduled' };
    });
    res.json(results);
  });

  app.get('/api/sf/debug/network-values', (req, res) => {
    // Show all non-null network values across all episodes
    const shows = (orionDb?.tvShows||[]);
    const withNetwork = shows.filter(ep=>ep.network).slice(0,10).map(ep=>({title:ep.seriesTitle||ep.title,network:ep.network}));
    const withNetworks = shows.filter(ep=>ep.networks?.length).slice(0,5).map(ep=>({title:ep.seriesTitle||ep.title,networks:ep.networks?.slice?.(0,3)||ep.networks?.substring?.(0,80),typeofNetworks:typeof ep.networks}));
    const withWatchProviders = shows.filter(ep=>ep.watchProviders?.length).slice(0,5).map(ep=>({title:ep.seriesTitle||ep.title,wp:ep.watchProviders?.slice(0,3)}));
    // Find Celebrity IOU specifically
    const celeb = shows.find(ep=>(ep.seriesTitle||ep.title||'').toLowerCase().includes('celebrity iou'));
    res.json({
      totalShows: shows.length,
      withNetworkCount: shows.filter(ep=>ep.network).length,
      withNetworksCount: shows.filter(ep=>ep.networks?.length).length,
      withWatchProvidersCount: shows.filter(ep=>ep.watchProviders?.length).length,
      sampleNetwork: withNetwork,
      sampleNetworks: withNetworks,
      sampleWatchProviders: withWatchProviders,
      celebrityIOU: celeb ? {network:celeb.network, networks:celeb.networks, watchProviders:celeb.watchProviders, studios:celeb.studios} : 'not found',
    });
  });

  app.get('/api/sf/debug/media-fields', (req, res) => {
    const all = getMediaCombined();
    const ep = all.find(m => m.type === 'episode');
    const mv = all.find(m => m.type === 'movie');
    const raw = orionDb?.tvShows?.[0];
    res.json({
      mappedEpisodeKeys: ep ? Object.keys(ep) : [],
      mappedMovieKeys: mv ? Object.keys(mv) : [],
      rawTvShowKeys: raw ? Object.keys(raw) : [],
      rawTvShowSample: raw ? Object.fromEntries(Object.entries(raw).filter(([k,v]) => typeof v !== 'object' || v === null).slice(0, 30)) : {},
      studios_sample: all.filter(m=>m.studios?.length).slice(0,3).map(m=>({title:m.title, studios:m.studios})),
    });
  });

  // Debug: show raw fields on first TV show item to find network field
  app.get('/api/sf/debug/playout-now', (req, res) => {
    const results = {};
    sfDb.channels.filter(c=>!c.liveStreamId).forEach(ch => {
      const now = getPlayoutNow(ch, Date.now());
      results[ch.name] = now ? {
        title: now.item?.title || now.stream?.name || 'live',
        offsetSeconds: now.offsetSeconds,
        offsetFormatted: now.offsetSeconds ? `${Math.floor(now.offsetSeconds/60)}m ${now.offsetSeconds%60}s` : '0s',
        duration: now.item?.duration,
        sessionRunning: !!hlsSessions[ch.id],
        sessionOffset: hlsSessions[ch.id] ? 'running' : 'not started',
      } : { error: 'null — no content scheduled' };
    });
    res.json(results);
  });

  app.get('/api/sf/debug/network-values', (req, res) => {
    // Show all non-null network values across all episodes
    const shows = (orionDb?.tvShows||[]);
    const withNetwork = shows.filter(ep=>ep.network).slice(0,10).map(ep=>({title:ep.seriesTitle||ep.title,network:ep.network}));
    const withNetworks = shows.filter(ep=>ep.networks?.length).slice(0,5).map(ep=>({title:ep.seriesTitle||ep.title,networks:ep.networks?.slice(0,3)}));
    const withWatchProviders = shows.filter(ep=>ep.watchProviders?.length).slice(0,5).map(ep=>({title:ep.seriesTitle||ep.title,wp:ep.watchProviders?.slice(0,3)}));
    // Find Celebrity IOU specifically
    const celeb = shows.find(ep=>(ep.seriesTitle||ep.title||'').toLowerCase().includes('celebrity iou'));
    res.json({
      totalShows: shows.length,
      withNetworkCount: shows.filter(ep=>ep.network).length,
      withNetworksCount: shows.filter(ep=>ep.networks?.length).length,
      withWatchProvidersCount: shows.filter(ep=>ep.watchProviders?.length).length,
      sampleNetwork: withNetwork,
      sampleNetworks: withNetworks,
      sampleWatchProviders: withWatchProviders,
      celebrityIOU: celeb ? {network:celeb.network, networks:celeb.networks, watchProviders:celeb.watchProviders, studios:celeb.studios} : 'not found',
    });
  });

  app.get('/api/sf/debug/media-fields', (req, res) => {
    const all = getMediaCombined();
    // Show unique networks found after fix
    const networkSet = new Set();
    all.forEach(m => (m.studios||[]).forEach(s => networkSet.add(s)));
    const rawSample = (orionDb?.tvShows||[]).slice(0,3).map(ep=>({
      title:ep.seriesTitle||ep.title, network:ep.network, networks:ep.networks,
    }));
    res.json({
      mappedEpisodeKeys: all.find(m=>m.type==='episode') ? Object.keys(all.find(m=>m.type==='episode')) : [],
      mappedMovieKeys: all.find(m=>m.type==='movie') ? Object.keys(all.find(m=>m.type==='movie')) : [],
      rawTvShowKeys: (orionDb?.tvShows||[])[0] ? Object.keys((orionDb.tvShows)[0]) : [],
      rawTvShowSample: (orionDb?.tvShows||[])[0],
      studios_sample: all.filter(m=>m.studios?.length).slice(0,3).map(m=>({title:m.title,studios:m.studios})),
      networksSample: rawSample,
      totalUniqueNetworks: networkSet.size,
      firstNetworks: [...networkSet].sort().slice(0,30),
    });
  });

  // Debug: inspect what getPlayoutNow returns for a channel
  app.get('/api/sf/channels/:id/debug', (req, res) => {
    const ch = sfDb.channels.find(c=>c.id===req.params.id);
    if (!ch) return res.status(404).json({ error:'not found' });
    const now = getPlayoutNow(ch, Date.now());
    const mediaCount = getMediaCombined().length;
    const libItems = ch.libraryLoop?.libraryId ? getMediaCombined().filter(m=>m.libraryId===ch.libraryLoop.libraryId).length : 0;
    res.json({
      channel: { id:ch.id, name:ch.name, liveStreamId:ch.liveStreamId||null, libraryLoop:ch.libraryLoop||null, seriesSchedule:ch.seriesSchedule?`${ch.seriesSchedule.showTitle} (${ch.seriesSchedule.episodes?.length} eps)`:null, playoutLen:(ch.playout||[]).length },
      getPlayoutNow: now ? { hasItem:!!now.item, itemId:now.item?.id, itemPath:now.item?.path, isLive:!!now.isLive, offsetSeconds:now.offsetSeconds } : null,
      mediaStats: { total:mediaCount, libItems },
    });
  });

  // Bulk now-playing — single request for all channels (avoids N×requests from Watch tab)
  app.get('/api/sf/now-playing-all', (req, res) => {
    const nowMs = Date.now();
    const result = {};
    (sfDb.channels || []).forEach(ch => {
      const now = getPlayoutNow(ch, nowMs);
      if (!now) { result[ch.id] = null; return; }
      const title = now.isLive ? (now.stream?.name || 'Live Stream') : (now.item?.title || 'Unknown');
      result[ch.id] = { title, isLive: !!now.isLive, startTime: now.startTime, endTime: now.endTime };
    });
    res.json(result);
  });

  // ── Direct fMP4 live proxy for IPTV channels ────────────────────────────────
  // For channels with liveStreamId, pipe through FFmpeg as fMP4 directly to the client.
  // Starts in <1s vs HLS which needs 5-20s to generate first segment on disk.
  app.get('/api/sf/channels/:id/live-proxy', (req, res) => {
    const ch = sfDb.channels.find(c => c.id === req.params.id);
    if (!ch) return res.status(404).json({ error: 'not found' });
    if (!ch.liveStreamId) return res.status(400).json({ error: 'channel has no live stream' });
    const stream = getSfStream(ch.liveStreamId);
    if (!stream?.url) return res.status(404).json({ error: 'stream not found' });

    const { spawn } = require('child_process');
    // For live IPTV: copy video (already H.264 in 99% of streams), just remux MPEG-TS→fMP4.
    // This starts in <500ms vs 3-5s for GPU init. GPU encoding is only needed for HEVC sources.
    // The h264_mp4toannexb bitstream filter handles the TS→MP4 container conversion.
    console.log(`[SF/LiveProxy] "${ch.name}" — copy mode (fast remux)`);

    const args = [
      '-probesize', '500000', '-analyzeduration', '500000',
      '-fflags', '+genpts+discardcorrupt+nobuffer',
      '-err_detect', 'ignore_err',
      '-user_agent', 'Orion/StreamForge',
      '-re',
      '-i', stream.url,
      '-map', '0:v:0', '-map', '0:a:0?',
      '-vcodec', 'copy',
      '-acodec', 'aac', '-b:a', '192k', '-ac', '2',
      '-avoid_negative_ts', 'make_zero',
      '-max_interleave_delta', '500000000',
      '-f', 'mpegts',  // MPEG-TS: universal IPTV player compatibility
      'pipe:1'
    ];

    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const proc = spawn(ffmpegExe, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stdout.pipe(res);
    proc.stderr.on('data', d => {
      const line = d.toString().trim().split('\n').pop();
      if (line && !line.startsWith('frame=')) console.log(`[SF/LiveProxy] ${ch.name}:`, line.slice(0, 100));
    });
    proc.on('error', err => { console.error('[SF/LiveProxy] spawn error:', err.message); if (!res.writableEnded) res.end(); });
    proc.on('exit', (code) => { if (!res.writableEnded) res.end(); if (code && code !== 255) console.warn(`[SF/LiveProxy] exit ${code} for ${ch.name}`); });
    // Grace period before killing — external players (MAG, Onn) briefly disconnect between segments
    req.on('close', () => { setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 8000); });
  });

  // Watch session — waits until the m3u8 is actually on disk before responding
  // so HLS.js only gets the URL once the stream is ready (avoids 503 race)
  // channelId -> Map(key -> { ip, agent, device, lastSeen })
  const _viewers = new Map();
  const VIEWER_TTL = 90000;   // survives a paused player, clears a closed tab

  function _describeAgent(ua) {
    ua = String(ua || '');
    if (/TiviMate/i.test(ua))            return 'TiviMate';
    if (/VLC/i.test(ua))                 return 'VLC';
    if (/Kodi|XBMC/i.test(ua))           return 'Kodi';
    if (/Roku/i.test(ua))                return 'Roku';
    if (/AppleTV|tvOS/i.test(ua))        return 'Apple TV';
    if (/AFT|Fire ?TV/i.test(ua))        return 'Fire TV';
    if (/Android/i.test(ua))             return 'Android';
    if (/iPhone|iPad|iOS/i.test(ua))     return 'iOS';
    if (/Edg\//i.test(ua))               return 'Edge';
    if (/Chrome/i.test(ua))              return 'Chrome';
    if (/Firefox/i.test(ua))             return 'Firefox';
    if (/Safari/i.test(ua))              return 'Safari';
    if (/ffmpeg|Lavf/i.test(ua))         return 'ffmpeg';
    if (!ua) return 'unknown';
    return ua.split('/')[0].slice(0, 24);
  }

  function _noteViewer(req, channelId) {
    try {
      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
        .split(',')[0].trim().replace(/^::ffff:/, '');
      const agent = _describeAgent(req.headers['user-agent']);
      const key = ip + '|' + agent;
      let m = _viewers.get(channelId);
      if (!m) { m = new Map(); _viewers.set(channelId, m); }
      const prev = m.get(key);
      m.set(key, {
        ip, agent,
        since: prev ? prev.since : Date.now(),
        lastSeen: Date.now()
      });
    } catch (_) {}
  }

  function _activeViewers(channelId) {
    const m = _viewers.get(channelId);
    if (!m) return [];
    const now = Date.now();
    for (const [k, v] of m) if (now - v.lastSeen > VIEWER_TTL) m.delete(k);
    return [...m.values()].map(v => ({
      ip: v.ip,
      device: v.agent,
      forSeconds: Math.round((now - v.since) / 1000)
    }));
  }

  // Everyone currently watching, across all channels.
  app.get('/api/sf/viewers', (req, res) => {
    const out = [];
    for (const ch of (sfDb.channels || [])) {
      const vs = _activeViewers(ch.id);
      if (vs.length) out.push({ channelId: ch.id, name: ch.name, num: ch.num, viewers: vs });
    }
    res.json({ total: out.reduce((n, c) => n + c.viewers.length, 0), channels: out });
  });

  app.post('/api/sf/channels/:id/watch', (req, res) => {
    const ch = sfDb.channels.find(c=>c.id===req.params.id);
    if (!ch) return res.status(404).json({ error:'not found' });
    // Reuse existing session if already running — avoids restart delay
    const existing = hlsSessions[req.params.id];
    if (existing) {
      existing.lastRequest = Date.now();
      return res.json({ ok:true, hlsUrl:`/sf/hls/${ch.id}/index.m3u8`, reused:true });
    }
    // If pre-buffered session already running, reuse it immediately — instant start
    if (hlsSessions[ch.id]) {
      hlsSessions[ch.id].lastRequest = Date.now();
      return res.json({ ok:true, hlsUrl:`/sf/hls/${ch.id}/index.m3u8`, reused:true });
    }
    // Use keepAlive for live channels if prebufferMode is 'all'
    const liveKeepAlive = ch.liveStreamId && (sfConfig.prebufferMode === 'all' || sfConfig.prebufferMode === 'live');

    // If item is pre-segmented, use virtual HLS instead of live FFmpeg
    if (!ch.liveStreamId) {
      const now = getPlayoutNow(ch);
      if (now?.item && isPresegged(now.item.id)) {
        const hlsUrl = `/sf/preseg-channel/${ch.id}/index.m3u8`;
        return res.json({ ok:true, hlsUrl, channelId:ch.id, presegged:true });
      }
    }

    const session = startHlsSession(ch, { keepAlive: !ch.liveStreamId || liveKeepAlive });
    if (!session) return res.status(404).json({ error:'Nothing scheduled on this channel' });
    res.json({ ok:true, hlsUrl:`/sf/hls/${ch.id}/index.m3u8` });
  });
  app.delete('/api/sf/channels/:id/watch', (req, res) => {
    // [PATCHED] No SIGKILL on DELETE /watch
    res.json({ ok:true });
  });

  // ── HLS serving ─────────────────────────────────────────────────────────────
  // [PATCHED] /sf/stream/:id — IPTV M3U URL pattern; redirect to working HLS endpoint
  app.get('/sf/stream/:channelId', (req, res) => {
    res.redirect(302, '/sf/hls/' + req.params.channelId + '/index.m3u8');
  });

  app.get('/sf/hls/:channelId/index.m3u8', (req, res) => {
    // Auto-start session if not running (e.g. server just restarted, channel not yet pre-buffered)
    const chk = sfDb.channels.find(c=>c.id===req.params.channelId);
    if (chk && !hlsSessions[req.params.channelId]) {
      console.log(`[SF/HLS] Lazy-starting "${chk.name}" on first request`);
      startHlsSession(chk, { keepAlive: !!chk.liveStreamId }); // keepAlive for live so it restarts
    }
    const ch = sfDb.channels.find(c=>c.id===req.params.channelId);
    if (!ch) return res.status(404).send('Channel not found');
    const session = hlsSessions[req.params.channelId] || startHlsSession(ch);
    if (!session) return res.status(503).send('Nothing playing on this channel');
    session.lastRequest = Date.now();
    const m3u8 = path.join(session.dir, 'index.m3u8');
    let waited = 0;
    const tryServe = () => {
      if (fs.existsSync(m3u8)) { res.setHeader('Content-Type','application/vnd.apple.mpegurl'); res.setHeader('Cache-Control','no-cache'); res.setHeader('Access-Control-Allow-Origin','*'); return res.sendFile(m3u8); }
      waited+=50; if(waited>60000) return res.status(503).send('HLS not ready — startup timeout');
      setTimeout(tryServe, 50);
    };
    tryServe();
  });
  app.get('/sf/hls/:channelId/:segment', (req, res) => {
    const session = hlsSessions[req.params.channelId];
    if (!session) return res.status(404).send('No session');
    session.lastRequest = Date.now();
    _noteViewer(req, req.params.channelId);
    const segPath = path.join(session.dir, req.params.segment);
    if (!fs.existsSync(segPath)) return res.status(404).send('Segment not found');
    const seg = req.params.segment;
    const isMp4 = seg.endsWith('.mp4') || seg.endsWith('.m4s');
    const contentType = isMp4 ? 'video/mp4' : 'video/mp2t';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control','no-cache');
    res.setHeader('Access-Control-Allow-Origin','*');
    res.sendFile(segPath);
  });

  // Direct MPEG-TS stream
  app.get('/sf/stream/:channelId', (req, res) => {
    const ch = sfDb.channels.find(c=>c.id===req.params.channelId);
    if (!ch) return res.status(404).send('Channel not found');
    // Live IPTV channels: redirect to live proxy (fast fMP4 pipe)
    if (ch.liveStreamId) {
      const base = sfConfig.baseUrl && !sfConfig.baseUrl.includes('localhost')
        ? sfConfig.baseUrl
        : `http://${(req.socket.localAddress||'localhost').replace(/^::ffff:/,'')}:${req.socket.localPort||3001}`;
      return res.redirect(302, `${base}/api/sf/channels/${ch.id}/live-proxy`);
    }
    const now = getPlayoutNow(ch, Date.now()); if (!now) return res.status(404).send('Nothing scheduled');
    let src;
    if (now.isLive && now.stream) { src = { type:'http', value:now.stream.url }; }
    else { if(!now.item) return res.status(404).send('Nothing scheduled'); src=resolveSource(now.item); if(!src) return res.status(404).send('Media source not found'); }
    res.setHeader('Content-Type','video/mp2t'); res.setHeader('Transfer-Encoding','chunked'); res.setHeader('Cache-Control','no-cache');
    const args = buildFfArgs(src, now.isLive?0:now.offsetSeconds, { outputFormat:'mpegts' });
    const ff = spawn(ffmpegExe, args, { stdio:['ignore','pipe','pipe'] });
    ff.stdout.pipe(res);
    ff.stderr.on('data', d => { const l=d.toString().trim(); if(l.match(/[Ee]rror|Invalid/)) console.error('[SF/stream]',l.slice(0,100)); });
    req.on('close',()=>{ setTimeout(()=>{ try{ff.kill('SIGKILL');}catch{} }, 8000); });
    ff.on('error',err=>{if(!res.headersSent) res.status(500).send('FFmpeg error: '+err.message);});
  });

  // ── M3U / XMLTV output ───────────────────────────────────────────────────────
  app.get('/sf/iptv.m3u', (req, res) => {
    const rawIp = req.socket.localAddress || req.headers.host?.split(':')[0] || 'localhost';
    const cleanIp = rawIp.replace(/^::ffff:/,'');
    const base = sfConfig.baseUrl && !sfConfig.baseUrl.includes('localhost')
      ? sfConfig.baseUrl
      : `http://${cleanIp}:${req.socket.localPort||3001}`;
    const protocol = sfConfig.outputProtocol || 'hls';
    const serverIp = cleanIp === '127.0.0.1' ? 'localhost' : cleanIp;

    res.setHeader('Content-Type','audio/x-mpegurl; charset=utf-8');
    let m3u = `#EXTM3U x-tvg-url="${base}/sf/xmltv.xml"\n\n`;
    sfDb.channels.filter(c=>c.active).sort((a,b)=>(a.num||0)-(b.num||0)).forEach((ch, idx) => {
      m3u += `#EXTINF:-1 tvg-id="${ch.id}" tvg-name="${ch.name}" tvg-chno="${ch.num||''}" group-title="${ch.group||''}" tvg-logo="${ch.logo||''}",${ch.name}\n`;
      let streamUrl;
      switch(protocol) {
        case 'srt': {
          const port = (sfConfig.srtPort||9000) + (ch.num||idx+1);
          streamUrl = `srt://${serverIp}:${port}`;
          break;
        }
        case 'rtsp': {
          const port = sfConfig.rtspPort||8554;
          streamUrl = `rtsp://${serverIp}:${port}/${ch.id}`;
          break;
        }
        case 'rtmp': {
          const port = sfConfig.rtmpPort||1935;
          streamUrl = `rtmp://${serverIp}:${port}/live/${ch.id}`;
          break;
        }
        case 'udp': {
          const base_addr = sfConfig.udpBase||'239.0.0';
          const octet = (ch.num||idx+1) % 255;
          const port = sfConfig.udpPort||1234;
          streamUrl = `udp://@${base_addr}.${octet}:${port}`;
          break;
        }
        default:
          streamUrl = `${base}/sf/stream/${ch.id}`;
      }
      m3u += `${streamUrl}\n\n`;
    });
    res.send(m3u);
  });

  // ── Alternative protocol stream endpoints ──────────────────────────────────
  // SRT output — FFmpeg sends SRT stream on per-channel port
  app.post('/api/sf/channels/:id/start-srt', async (req, res) => {
    const ch = sfDb.channels.find(c=>c.id===req.params.id);
    if (!ch) return res.status(404).json({ error:'not found' });
    const port = (sfConfig.srtPort||9000) + (ch.num||1);
    const now = getPlayoutNow(ch);
    if (!now?.item && !ch.liveStreamId) return res.status(404).json({ error:'nothing scheduled' });
    const src = ch.liveStreamId ? getSfStream(ch.liveStreamId)?.url : now.item.path;
    if (!src) return res.status(404).json({ error:'no source' });
    const args = ['-re', '-ss', String(now?.offsetSeconds||0), '-i', src,
      '-vcodec', 'copy', '-acodec', 'aac', '-b:a', '192k',
      '-f', 'mpegts', `srt://0.0.0.0:${port}?mode=listener`];
    const proc = spawn(ffmpegExe, args, { stdio:'ignore' });
    res.json({ ok:true, port, url:`srt://SERVER_IP:${port}` });
  });

  // ── Stalker Middleware — MAG device support ──────────────────────────────────
  // Portal URL to enter on MAG: http://192.168.0.228:3001/stalker_portal/c/
  const getBase = req => {
    const raw = req.socket.localAddress || req.headers.host?.split(':')[0] || 'localhost';
    return `http://${raw.replace(/^::ffff:/,'')}:${req.socket.localPort||3001}`;
  };
  const getMac = req => {
    // MAG sends MAC in Cookie header: mac=XX:XX:XX:XX:XX:XX
    const cookie = req.headers.cookie || '';
    const m = cookie.match(/mac=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : (req.query.mac || 'unknown');
  };
  const stalkerTokens = new Map();

  app.use('/stalker_portal', require('express').urlencoded({ extended:true }));
  app.use('/stalker_portal', require('express').json());

  // Portal bootstrap — MAG loads this URL first
  app.get(['/stalker_portal/c/', '/stalker_portal/c'], (req, res) => {
    const base = getBase(req);
    res.setHeader('Content-Type','application/javascript');
    res.send(`var portal_url="${base}/stalker_portal/";var api_url="${base}/stalker_portal/server/load.php";`);
  });

  app.all('/stalker_portal/server/load.php', (req, res) => {
    res.setHeader('Content-Type','application/json');
    res.setHeader('Access-Control-Allow-Origin','*');
    const q = { ...req.query, ...req.body };
    const action = q.action || q.type || 'handshake';
    const mac = getMac(req);
    const base = getBase(req);

    const chList = () => sfDb.channels
      .filter(c=>c.active!==false)
      .sort((a,b)=>(a.num||0)-(b.num||0))
      .map((ch,i) => ({
        id: String(ch.num||i+1),
        name: ch.name,
        number: String(ch.num||i+1),
        cmd: `ffrt ${base}/sf/stream/${ch.id}`,
        mc_cmd: `ffrt ${base}/sf/stream/${ch.id}`,
        logo: ch.logo||'',
        epg_id: ch.id,
        tv_genre_id: '1',
        group_id: '1',
        xmltv_id: ch.id,
        service_id: String(ch.num||i+1),
        is_protected: '0',
        use_http_tmp_link: '0',
        archive: '0',
        protected_code: '0',
        tv_archive_duration: '0',
      }));

    if (action === 'handshake') {
      const token = 'sf' + Date.now().toString(36);
      stalkerTokens.set(mac, token);
      return res.json({ js:{ token, load:'/stalker_portal/server/load.php', random:String(Math.random()) }});
    }

    if (action === 'get_profile') {
      const token = stalkerTokens.get(mac) || 'sftoken';
      return res.json({ js:{
        id:'1', name:'StreamForge User', login:'user', password:'',
        status:'1', stb_type:'MAG250', image_version:'218',
        version:'2.18.11-r1', mac, token,
        ip: base.split('//')[1]?.split(':')[0]||'',
        ts_enabled:'1', hls_extension:'m3u8', rtsp_port:'554',
        tv_archive_continued:'0',
        ver:'ImageDescription: 0.2.18-r14-pub-254',
        num_banks:'2', multi_mac:'0', hw_version:'2A',
        not_detect_ac3:'0', b_count:'2', correct_time:'0',
        kinopoisk_rating:'1', exch_currency:'USD',
        play_verification_code:'', cc_label:'',
        rtsp_type:'4', hls_last_seg_duration:'6',
        timezone:'America/New_York', guide_type:'2',
        show_adult:'0', tz_offset:'0',
      }});
    }

    if (action === 'get_tv_genres') {
      return res.json({ js:[{ id:'1', title:'All Channels', alias:'all', censored:'0' }] });
    }

    if (action === 'get_all_channels' || action === 'get_ordered_list') {
      const list = chList();
      return res.json({ js:{ data:list, total_items:list.length, selected_item:0, max_page_items:list.length }});
    }

    if (action === 'create_link') {
      const cmd = q.cmd || '';
      const match = cmd.match(/sf\/stream\/([\w-]+)/);
      const chId = match ? match[1] : null;
      const url = chId ? `${base}/sf/stream/${chId}` : cmd.replace(/^ffrt\s*/,'');
      return res.json({ js:{ id:'1', cmd:url, link:url }});
    }

    if (action === 'get_epg_info' || action === 'get_short_epg') {
      const chId = q.ch_id || q.id;
      const ch = sfDb.channels.find(c=>String(c.num)===String(chId)||c.id===chId);
      const now = Date.now();
      const progs = ch ? buildSchedule(ch, now-3600000, now+7200000).slice(0,3) : [];
      return res.json({ js: progs.map(p=>({
        id: String(p.start), name: p.title, desc: p.desc||'',
        time: Math.floor(p.start/1000), time_to: Math.floor(p.end/1000),
        duration: Math.floor((p.end-p.start)/1000), stop_time: Math.floor(p.end/1000),
      }))});
    }

    if (action === 'set_last_id') { return res.json({ js:true }); }
    if (action === 'get_locales') { return res.json({ js:[] }); }
    if (action === 'get_countries') { return res.json({ js:[] }); }
    if (action === 'get_genres') { return res.json({ js:[] }); }

    res.json({ js:true });
  });

  app.get('/sf/xmltv.xml', (req, res) => {
    res.setHeader('Content-Type','application/xml; charset=utf-8');
    const now=Date.now(), to=now+(sfConfig.epgDaysAhead||7)*86400000;
    // [PATCHED] proper XML escape + enriched programme fields for Tivimate
    const esc = v => String(v==null?'':v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="Orion/StreamForge">\n`;
    sfDb.channels.filter(c=>c.active).forEach(ch => {
      xml += `  <channel id="${esc(ch.id)}"><display-name>${esc(ch.name)}</display-name>${ch.logo?`<icon src="${esc(ch.logo)}"/>`:''}${ch.num?`<lcn>${esc(ch.num)}</lcn>`:''}</channel>\n`;
    });
    sfDb.channels.filter(c=>c.active).forEach(ch => {
      const progs = buildSchedule(ch, now, to);
      progs.forEach(p => {
        let pgm = `  <programme channel="${esc(ch.id)}" start="${fmtDate(p.start)}" stop="${fmtDate(p.end)}">`;
        pgm += `<title>${esc(p.title)}</title>`;
        if (p.desc) pgm += `<desc>${esc(p.desc)}</desc>`;
        if (p.season != null && p.episode != null) {
          pgm += `<episode-num system="onscreen">S${String(p.season).padStart(2,'0')}E${String(p.episode).padStart(2,'0')}</episode-num>`;
          pgm += `<episode-num system="xmltv_ns">${(p.season||1)-1}.${(p.episode||1)-1}.0/1</episode-num>`;
        }
        if (p.icon) pgm += `<icon src="${esc(p.icon)}"/>`;
        pgm += `</programme>\n`;
        xml += pgm;
      });
    });
    xml += '</tv>'; res.send(xml);
  });

  // ── Libraries ────────────────────────────────────────────────────────────────
  app.get('/api/sf/libraries', (req, res) => {
    // Prepend virtual Orion library entries so the UI shows them
    const orionLibs = [];
    if (orionDb) {
      const movieCount = (orionDb.movies       || []).length;
      const tvCount    = (orionDb.tvShows      || []).length;
      if (movieCount > 0) orionLibs.push({
        id: 'orion-movies', name: 'Orion — Movies', type: 'orion',
        path: '', itemCount: movieCount, scannedAt: new Date().toISOString(),
        readonly: true, note: 'Shared from Orion media library',
      });
      if (tvCount > 0) orionLibs.push({
        id: 'orion-tvshows', name: 'Orion — TV Shows', type: 'orion',
        path: '', itemCount: tvCount, scannedAt: new Date().toISOString(),
        readonly: true, note: 'Shared from Orion media library',
      });
      const mvCount    = (orionDb.musicVideos || []).length;
      const musicCount = (orionDb.music       || []).length;
      if (mvCount > 0) orionLibs.push({
        id: 'orion-musicvideos', name: 'Orion — Music Videos', type: 'orion',
        path: '', itemCount: mvCount, scannedAt: new Date().toISOString(),
        readonly: true, note: 'Shared from Orion media library',
      });
      if (musicCount > 0) orionLibs.push({
        id: 'orion-music', name: 'Orion — Music', type: 'orion',
        path: '', itemCount: musicCount, scannedAt: new Date().toISOString(),
        readonly: true, note: 'Shared from Orion media library',
      });
    }
    res.json([...orionLibs, ...sfDb.libraries]);
  });
  app.post('/api/sf/libraries', (req, res) => {
    const { name, type, path: dirPath, url, token, sectionKey, parentId } = req.body;
    if (!name || !type) return res.status(400).json({ error:'name and type required' });
    const lib = { id:uuidv4(), name, type, path:dirPath||'', url:url||'', token:token||'', sectionKey:sectionKey||null, parentId:parentId||null, itemCount:0, scannedAt:null, createdAt:new Date().toISOString() };
    sfDb.libraries.push(lib); saveAll(); res.status(201).json(lib);
  });
  app.delete('/api/sf/libraries/:id', (req, res) => {
    sfDb.libraries = sfDb.libraries.filter(l=>l.id!==req.params.id);
    sfDb.media = sfDb.media.filter(m=>m.libraryId!==req.params.id);
    saveAll(); res.json({ ok:true });
  });

  const scanStatus = {};
  app.post('/api/sf/libraries/:id/scan', async (req, res) => {
    const lib = sfDb.libraries.find(l=>l.id===req.params.id);
    if (!lib) return res.status(404).json({ error:'not found' });
    res.json({ ok:true, message:'Scan started' });
    scanStatus[lib.id] = { running:true, added:0, startedAt:new Date().toISOString() };
    try {
      const existingPaths = new Set(sfDb.media.filter(m=>m.libraryId===lib.id).map(m=>m.path));
      let newItems = [];
      if (lib.type==='local') newItems = await scanLocalDir(lib.id, lib.path, existingPaths);
      else if (lib.type==='plex') newItems = await fetchPlex(lib);
      else if (lib.type==='jellyfin') newItems = await fetchJellyfin(lib);
      sfDb.media.push(...newItems);
      lib.itemCount = sfDb.media.filter(m=>m.libraryId===lib.id).length;
      lib.scannedAt = new Date().toISOString();
      saveAll();
      scanStatus[lib.id] = { running:false, added:newItems.length, completedAt:new Date().toISOString() };
      console.log(`[SF] Library scan complete: ${newItems.length} new items`);
    } catch(e) { scanStatus[lib.id] = { running:false, error:e.message }; console.error('[SF] Scan error:', e.message); }
  });
  app.get('/api/sf/libraries/:id/scan-status', (req, res) => res.json(scanStatus[req.params.id] || { running:false }));

  // ── Media ────────────────────────────────────────────────────────────────────
  app.get('/api/sf/media', (req, res) => {
    let items = getMediaCombined();
    if (req.query.type)  items = items.filter(m=>m.type===req.query.type);
    if (req.query.q)     {
      const q = req.query.q.toLowerCase();
      items = items.filter(m =>
        m.title?.toLowerCase().includes(q) ||
        m.episodeTitle?.toLowerCase().includes(q) ||
        m.seriesTitle?.toLowerCase().includes(q)
      );
    }
    if (req.query.lib)   items = items.filter(m=>m.libraryId===req.query.lib);
    // M1: cap page size. Returning 50k rows serialises for seconds and
    // can exhaust memory on a small box. Clients should paginate.
    const MAX_LIMIT = 500;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit) || 100));
    res.json({ items: items.slice((page-1)*limit, page*limit), total:items.length, page, pages:Math.ceil(items.length/limit) });
  });

  // All genres and networks in the library (for collection picker)
  app.get('/api/sf/media/genres', (req, res) => {
    const genreSet = new Set();
    const networkSet = new Set();
    // Read genres from mapped media
    getMediaCombined().forEach(m => (m.genres||[]).forEach(g => { if(g) genreSet.add(g); }));
    // Read networks DIRECTLY from orionDb — bypasses any mapping issues
    const parseArr = v => {
      if (Array.isArray(v)) return v;
      if (typeof v === 'string') { try { return JSON.parse(v); } catch { return []; } }
      return [];
    };
    (orionDb?.tvShows||[]).forEach(ep => {
      // 'network' is a single string field in Orion's TV show schema
      if (ep.network) networkSet.add(ep.network);
      parseArr(ep.watchProviders).forEach(p => { const s=typeof p==='object'?p.name||p:String(p); if(s) networkSet.add(s); });
    });
    (orionDb?.movies||[]).forEach(m => {
      parseArr(m.watchProviders).forEach(p => { const s=typeof p==='object'?p.name||p:String(p); if(s) networkSet.add(s); });
    });
    res.json({ genres: [...genreSet].sort(), networks: [...networkSet].sort() });
  });

  // Networks endpoint — returns all networks with show counts from Orion library
  app.get('/api/sf/networks', (req, res) => {
    const parseArr = v => { if (Array.isArray(v)) return v; if (typeof v==='string') { try { return JSON.parse(v); } catch { return []; } } return []; };
    const networkMap = new Map(); // network -> Set of showNames
    const getNetworks = ep => {
      const nets = [];
      if (ep.network) nets.push(ep.network);
      parseArr(ep.watchProviders).forEach(p => { const s=typeof p==='object'?p.name||p:String(p); if(s) nets.push(s); });
      return nets;
    };
    // Group TV episodes by show name per network
    const showsByNetwork = new Map();
    (orionDb?.tvShows||[]).forEach(ep => {
      const show = ep.seriesTitle || ep.title || '';
      if (ep.network) {
        if (!showsByNetwork.has(ep.network)) showsByNetwork.set(ep.network, new Set());
        showsByNetwork.get(ep.network).add(show);
      }
    });
    const networks = [...showsByNetwork.entries()]
      .map(([name, shows]) => ({ name, showCount: shows.size, shows: [...shows].sort() }))
      .sort((a,b) => b.showCount - a.showCount);
    res.json(networks);
  });

  // Media by network — returns all episodes/movies for a given network
  app.get('/api/sf/media/by-network', (req, res) => {
    const network = (req.query.network || '').toLowerCase();
    if (!network) return res.status(400).json({ error: 'network required' });
    const parseArr = v => { if (Array.isArray(v)) return v; if (typeof v==='string') { try { return JSON.parse(v); } catch { return []; } } return []; };
    const items = getMediaCombined().filter(m => {
      const raw = (orionDb?.tvShows||[]).find(ep=>ep.id===m.id) || (orionDb?.movies||[]).find(mv=>mv.id===m.id);
      if (!raw) return false;
      const nets = [
        ...parseArr(raw.networks),
        ...parseArr(raw.watchProviders),
      ].map(n=>typeof n==='object'?n.name||n:String(n)).map(s=>s.toLowerCase());
      return nets.some(n => n.includes(network) || network.includes(n));
    });
    res.json(items);
  });

  // Shows search — instant filter of pre-built cache (no per-request 25k scan)

  app.get('/api/sf/media/skipped', (req, res) => {
    try {
      getMediaCombined(); // ensure latest filter pass
      const q = (req.query.q || '').toString().toLowerCase().trim();
      let items = _skippedItems;
      if (q) {
        items = items.filter(it => {
          const hay = ((it.title||'') + ' ' + (it.episodeTitle||'') + ' ' + (it.path||'') + ' ' + (it.reason||'')).toLowerCase();
          return hay.includes(q);
        });
      }
      res.json({ total: _skippedItems.length, matched: items.length, items: items.slice(0, 500) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Quick toggle endpoint for hideUnsegmented + cache invalidation
  app.post('/api/sf/media/hide-unsegmented', express.json(), (req, res) => {
    try {
      const enabled = req.body && req.body.enabled === true;
      sfConfig.hideUnsegmented = enabled;
      try {
        const cfgPath = path.join(SF_DIR, 'config.json');
        const root = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        root.hideUnsegmented = enabled;
        fs.writeFileSync(cfgPath, JSON.stringify(root, null, 2));
      } catch (e) { console.error('[PRESEG-FILTER] config write:', e.message); }
      _invalidatePresegDoneSet();
      res.json({ ok: true, hideUnsegmented: enabled });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/sf/media/shows', (req, res) => {
    const q = (req.query.q || '').toLowerCase().trim();
    if (!_showsCache) getMediaCombined(); // ensure cache is built
    const cache = _showsCache || [];
    if (q.length < 2) return res.json([]);
    const results = cache.filter(s => s.titleLower.includes(q));
    // Strip titleLower from response
    res.json(results.map(({titleLower, ...rest}) => rest));
  });

  // ── Streams ──────────────────────────────────────────────────────────────────
  app.get('/api/sf/streams', (req, res) => res.json(sfDb.streams));
  app.post('/api/sf/streams', (req, res) => {
    const { name, url, group, logo } = req.body;
    if (!name || !url) return res.status(400).json({ error:'name and url required' });
    const stream = { id:uuidv4(), name, url, group:group||'', logo:logo||'', addedAt:new Date().toISOString() };
    sfDb.streams.push(stream); _sfStreamsById.set(stream.id, stream); saveAll(); res.status(201).json(stream);
  });
  app.put('/api/sf/streams/:id', (req, res) => {
    const idx = sfDb.streams.findIndex(s=>s.id===req.params.id);
    if (idx===-1) return res.status(404).json({ error:'not found' });
    Object.assign(sfDb.streams[idx], req.body, { id:req.params.id }); saveAll(); res.json(sfDb.streams[idx]);
  });
  app.delete('/api/sf/streams/:id', (req, res) => {
    sfDb.streams = sfDb.streams.filter(s=>s.id!==req.params.id); saveAll(); res.json({ ok:true });
  });
  app.post('/api/sf/streams/resolve', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error:'url required' });
    try {
      // Try yt-dlp first
      const ytdlp = execSync(`yt-dlp -g --no-playlist "${url}" 2>/dev/null`, { timeout:15000 }).toString().trim().split('\n')[0];
      if (ytdlp && ytdlp.startsWith('http')) return res.json({ streamUrl:ytdlp });
    } catch {}
    res.json({ streamUrl:null, error:'Could not extract stream URL. Try the direct .m3u8 URL.' });
  });

  // Stream preview (HLS proxy for testing)
  const previewSessions = {};
  // ── Import from Orion IPTV ───────────────────────────────────────────────────
  // Preview: returns all Orion IPTV channels with already-imported status and SF IDs
  app.get('/api/sf/import/orion-iptv/preview', (req, res) => {
    if (!orionDb) return res.status(500).json({ error: 'Orion DB not connected' });
    const iptvChannels = orionDb.iptvChannels || [];
    const urlToStream = new Map((sfDb.streams || []).map(s => [s.url, s]));
    const streamToChannel = new Map();
    (sfDb.channels || []).forEach(ch => { if (ch.liveStreamId) streamToChannel.set(ch.liveStreamId, ch); });
    const list = iptvChannels.map(ch => {
      const sfStream = urlToStream.get(ch.url);
      const sfChannel = sfStream ? streamToChannel.get(sfStream.id) : null;
      return {
        id: ch.id || ch.tvgId || ch.name,
        name: ch.name || '',
        url: ch.url || '',
        logo: ch.logo || ch.tvgLogo || '',
        group: ch.group || ch.category || '',
        alreadyImported: !!sfStream,
        sfStreamId: sfStream?.id || null,
        sfChannelId: sfChannel?.id || null,
      };
    });
    res.json({ channels: list, total: list.length });
  });

  // Sync: add selected channels, remove deselected ones
  app.post('/api/sf/import/orion-iptv/sync', (req, res) => {
    if (!orionDb) return res.status(500).json({ error: 'Orion DB not connected' });
    const { removeStreamIds = [], removeChannelIds = [], selectedIds = [] } = req.body;
    const iptvChannels = orionDb.iptvChannels || [];

    // Remove deselected streams and their channels
    let removed = 0;
    if (removeStreamIds.length || removeChannelIds.length) {
      sfDb.streams = sfDb.streams.filter(s => !removeStreamIds.includes(s.id));
      sfDb.channels = sfDb.channels.filter(c => !removeChannelIds.includes(c.id) && !removeStreamIds.includes(c.liveStreamId));
      rebuildSfIndexes();
      removed = removeStreamIds.length;
    }

    // Import newly selected channels
    const existingUrls = new Set((sfDb.streams || []).map(s => s.url));
    const existingChNames = new Set((sfDb.channels || []).map(c => c.name.toLowerCase()));
    let nextNum = Math.max(0, ...(sfDb.channels || []).map(c => c.num || 0)) + 1;
    let added = 0;

    const toAdd = iptvChannels.filter(ch => selectedIds.includes(ch.id || ch.tvgId || ch.name) && !existingUrls.has(ch.url));
    for (const ch of toAdd) {
      if (!ch.url || !ch.name) continue;
      const stream = { id: uuidv4(), name: ch.name, url: ch.url, group: ch.group || ch.category || '', logo: ch.logo || ch.tvgLogo || '', addedAt: new Date().toISOString() };
      sfDb.streams.push(stream);
      _sfStreamsById.set(stream.id, stream);
      if (!existingChNames.has(ch.name.toLowerCase())) {
        const channel = { id: uuidv4(), name: ch.name, num: nextNum++, group: ch.group || ch.category || 'IPTV', logo: ch.logo || ch.tvgLogo || '', epgChannelId: ch.tvgId || ch.id || '', liveStreamId: stream.id, playout: [], timeBlocks: [], active: true, createdAt: new Date().toISOString() };
        sfDb.channels.push(channel);
        _sfChannelsById.set(channel.id, channel);
        existingChNames.add(ch.name.toLowerCase());
      }
      added++;
    }

    rebuildSfIndexes(); // ensure new streams/channels are findable immediately
    saveAll();
    console.log(`[SF/Import] Sync: +${added} added, -${removed} removed`);
    res.json({ ok: true, added, removed });
  });

  app.post('/api/sf/streams/:id/warm', async (req, res) => {
    const stream = getSfStream(req.params.id);
    if (!stream) return res.status(404).json({ error:'not found' });
    const prevDir = path.join(SF_DIR, 'hls', `preview_${stream.id}`);
    try { fs.mkdirSync(prevDir,{recursive:true}); } catch {}
    const existing = previewSessions[stream.id];
    if (existing && !existing.proc.killed) { existing.lastRequest=Date.now(); return res.json({ ok:true }); }
    const args = ['-re','-i',stream.url,'-vcodec','copy','-acodec','copy','-f','hls','-hls_time','4','-hls_list_size','6','-hls_flags','delete_segments+append_list','-hls_segment_filename',path.join(prevDir,'seg%05d.ts'),path.join(prevDir,'index.m3u8')];
    const proc = spawn(ffmpegExe, args, { stdio:['ignore','ignore','pipe'] });
    previewSessions[stream.id] = { proc, dir:prevDir, lastRequest:Date.now() };
    proc.on('exit',()=>delete previewSessions[stream.id]);
    res.json({ ok:true });
  });
  app.post('/api/sf/streams/:id/stop', (req, res) => {
    const s = previewSessions[req.params.id]; if(s){try{s.proc.kill('SIGKILL');}catch{} delete previewSessions[req.params.id];}
    res.json({ ok:true });
  });
  app.get('/api/sf/streams/:id/preview.m3u8', (req, res) => {
    const s = previewSessions[req.params.id]; if(!s) return res.status(404).send('No preview session');
    s.lastRequest=Date.now();
    const m3u8=path.join(s.dir,'index.m3u8');
    if(!fs.existsSync(m3u8)) return res.status(503).send('Not ready');
    res.setHeader('Content-Type','application/vnd.apple.mpegurl'); res.setHeader('Cache-Control','no-cache'); res.sendFile(m3u8);
  });

  // ── EPG ──────────────────────────────────────────────────────────────────────
  app.get('/api/sf/epg', (req, res) => {
    const disabledSet = new Set(sfDb.epgDisabled || []);
    const channels = req.query.enabledOnly === '1'
      ? (sfDb.epg.channels || []).filter(c => !disabledSet.has(c.id))
      : sfDb.epg.channels || [];
    res.json({
      ...sfDb.epg,
      channels,
      disabledChannels: sfDb.epgDisabled || [],
    });
  });
  app.post('/api/sf/epg/disabled', (req, res) => {
    // Toggle or set the disabled EPG channel list
    const { channelId, disabled } = req.body;
    if (!sfDb.epgDisabled) sfDb.epgDisabled = [];
    if (disabled) {
      if (!sfDb.epgDisabled.includes(channelId)) sfDb.epgDisabled.push(channelId);
    } else {
      sfDb.epgDisabled = sfDb.epgDisabled.filter(id => id !== channelId);
    }
    saveAll();
    res.json({ ok: true, disabledCount: sfDb.epgDisabled.length });
  });

  // Bulk update — set multiple channels enabled/disabled in one call
  app.post('/api/sf/epg/disabled/bulk', (req, res) => {
    const { channelIds = [], disabled } = req.body;
    if (!sfDb.epgDisabled) sfDb.epgDisabled = [];
    if (disabled) {
      channelIds.forEach(id => { if (!sfDb.epgDisabled.includes(id)) sfDb.epgDisabled.push(id); });
    } else {
      const removeSet = new Set(channelIds);
      sfDb.epgDisabled = sfDb.epgDisabled.filter(id => !removeSet.has(id));
    }
    saveAll();
    res.json({ ok: true, disabledCount: sfDb.epgDisabled.length });
  });
  app.get('/api/sf/epg/programs', (req, res) => {
    let progs = sfDb.epg.programs;
    if (req.query.channel) progs = progs.filter(p=>p.channel===req.query.channel);
    if (req.query.from) progs = progs.filter(p=>p.stop > parseInt(req.query.from));
    if (req.query.to)   progs = progs.filter(p=>p.start < parseInt(req.query.to));
    res.json(progs); // no cap
  });
  app.delete('/api/sf/epg', (req, res) => {
    sfDb.epg = { channels:[], programs:[], importedAt:null, sourceName:'' }; saveAll(); res.json({ ok:true });
  });
  app.post('/api/sf/epg/import', multerUpload.single('file'), async (req, res) => {
    const { url: epgUrl } = req.body;
    let xmlText = '';
    try {
      if (req.file) {
        xmlText = fs.readFileSync(req.file.path, 'utf8');
      } else if (epgUrl) {
        const r = await fetchUrl(epgUrl); xmlText = await r.text();
      } else {
        return res.status(400).json({ error:'url or file required' });
      }
      // Simple XML parser for XMLTV format (no dependency on xml2js)
      const channels = [], programs = [];
      // Parse channels
      const chRe = /<channel\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/channel>/g;
      let m;
      while ((m = chRe.exec(xmlText)) !== null) {
        const id = m[1];
        const nameMatch = m[2].match(/<display-name[^>]*>([^<]+)<\/display-name>/);
        const logoMatch = m[2].match(/<icon\s+src="([^"]+)"/);
        channels.push({ id, name:nameMatch?nameMatch[1].trim():id, logo:logoMatch?logoMatch[1]:'' });
      }
      // Parse programs
      const pgRe = /<programme\s[^>]*>/g;
      const fullPgRe = /<programme([\s\S]*?)<\/programme>/g;
      let pm;
      while ((pm = fullPgRe.exec(xmlText)) !== null) {
        const block = pm[0];
        const startM = block.match(/start="([^"]+)"/), stopM = block.match(/stop="([^"]+)"/), chM = block.match(/channel="([^"]+)"/);
        const titleM = block.match(/<title[^>]*>([^<]+)<\/title>/), descM = block.match(/<desc[^>]*>([^<]+)<\/desc>/);
        if (!startM || !chM || !titleM) continue;
        const parseXmltvDate = s => { const r=s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/); return r?new Date(`${r[1]}-${r[2]}-${r[3]}T${r[4]}:${r[5]}:${r[6]}Z`).getTime():0; };
        programs.push({ channel:chM[1], start:parseXmltvDate(startM[1]), stop:stopM?parseXmltvDate(stopM[1]):0, title:titleM[1].trim(), desc:descM?descM[1].trim():'' });
      }
      sfDb.epg = { channels, programs, importedAt:new Date().toISOString(), sourceName:epgUrl||req.file?.originalname||'upload' };
      saveAll();
      res.json({ ok:true, channels:channels.length, programs:programs.length });
    } catch(e) { res.status(500).json({ error:e.message }); }
    if (req.file) { try{fs.unlinkSync(req.file.path);}catch{} }
  });

  // ── Schedules Direct API ────────────────────────────────────────────────────
  // Login and get token
  app.post('/api/sf/sd/token', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'username and password required' });
    try {
      const token = await sdGetToken(username, password);
      // Save credentials if requested
      if (req.body.save) {
        sfConfig.sdUsername = username;
        sfConfig.sdPassword = password;
        saveJson(SF_CFG, sfConfig);
      }
      res.json({ ok: true, token });
    } catch (e) { res.status(401).json({ error: e.message }); }
  });

  // Get user's subscribed lineups
  app.get('/api/sf/sd/lineups', async (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'token required' });
    try {
      const r = await fetchUrl(`${SD_BASE}/lineups`, { headers: sdHeaders(token) });
      res.json(await r.json());
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Search lineups by country + postal code
  app.get('/api/sf/sd/headends', async (req, res) => {
    const { token, country = 'USA', postalcode } = req.query;
    if (!token || !postalcode) return res.status(400).json({ error: 'token and postalcode required' });
    try {
      const r = await fetchUrl(`${SD_BASE}/headends?country=${country}&postalcode=${postalcode}`, { headers: sdHeaders(token) });
      res.json(await r.json());
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Add a lineup to account
  app.put('/api/sf/sd/lineups/:id', async (req, res) => {
    const { token } = req.query;
    try {
      const r = await fetchUrl(`${SD_BASE}/lineups/${req.params.id}`, { method: 'PUT', headers: sdHeaders(token) });
      res.json(await r.json());
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Full import: login → fetch lineup → fetch schedules → build EPG → save
  app.post('/api/sf/sd/import', async (req, res) => {
    const { username, password, lineupId, daysAhead = 7, save = true } = req.body;
    if (!username || !password || !lineupId) return res.status(400).json({ error: 'username, password and lineupId required' });
    try {
      const token = await sdGetToken(username, password);
      const result = await sdBuildAndImportEPG(token, lineupId, daysAhead);
      if (save) {
        sfConfig.sdUsername  = username;
        sfConfig.sdPassword  = password;
        sfConfig.sdLineupId  = lineupId;
        sfConfig.sdAutoUpdate = true;
        saveJson(SF_CFG, sfConfig);
      }
      res.json({ ok: true, ...result });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Manual refresh with saved credentials
  app.post('/api/sf/sd/refresh', async (req, res) => {
    try {
      await sdAutoRefresh();
      res.json({ ok: true, channels: sfDb.epg.channels.length, programs: sfDb.epg.programs.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Get saved SD config (without password)
  app.get('/api/sf/sd/config', (req, res) => {
    res.json({
      username:   sfConfig.sdUsername   || '',
      lineupId:   sfConfig.sdLineupId   || '',
      autoUpdate: sfConfig.sdAutoUpdate || false,
      hasPassword: !!(sfConfig.sdPassword),
    });
  });

  // ── Schedule grid ────────────────────────────────────────────────────────────
  app.get('/api/sf/schedule', (req, res) => {
    const fromMs = parseInt(req.query.from)||Date.now();
    const toMs   = parseInt(req.query.to)||(fromMs+86400000);
    const schedule = sfDb.channels.filter(c=>c.active).map(ch => ({
      channel: { id:ch.id, num:ch.num, name:ch.name, logo:ch.logo },
      programs: buildSchedule(ch, fromMs, toMs),
    }));
    res.json(schedule);
  });

  // ── AI Scheduler ─────────────────────────────────────────────────────────────
  app.post('/api/sf/ai/build-schedule', async (req, res) => {
    const { channelId, epgChannelId, date, userPrompt } = req.body;
    if (!channelId || !epgChannelId) return res.status(400).json({ error:'channelId and epgChannelId required' });

    let programs = sfDb.epg.programs.filter(p=>p.channel===epgChannelId);
    if (date) { const from=new Date(date+'T00:00:00Z').getTime(),to=from+86400000; programs=programs.filter(p=>p.stop>from&&p.start<to); }
    programs.sort((a,b)=>a.start-b.start);
    const epgCh = sfDb.epg.channels.find(c=>c.id===epgChannelId);
    if (!programs.length) return res.status(400).json({ error:'No EPG programs found for this channel/date' });

    // Build library index
    const showMap = new Map(), movieList = [];
    getMediaCombined().forEach(m => {
      if (m.type==='movie') movieList.push({id:m.id,title:m.title,year:m.year,duration:m.duration});
      else { const k=m.title||'Unknown'; if(!showMap.has(k)) showMap.set(k,{title:k,episodes:[],ids:[]}); showMap.get(k).episodes.push(m); }
    });

    function normTitle(t) { return (t||'').toLowerCase().replace(/^(the|a|an) /,'').replace(/[^a-z0-9 ]/g,'').replace(/\s+/g,' ').trim(); }
    function fuzzyScore(a, b) {
      const na=normTitle(a),nb=normTitle(b); if(!na||!nb) return 0; if(na===nb) return 100; if(na.includes(nb)||nb.includes(na)) return 90;
      const wa=new Set(na.split(' ').filter(w=>w.length>2)),wb=new Set(nb.split(' ').filter(w=>w.length>2));
      if(!wa.size||!wb.size) return 0; const shared=[...wa].filter(w=>wb.has(w)).length; return Math.round(shared/Math.max(wa.size,wb.size)*75);
    }
    const epgTitles = [...new Set(programs.map(p=>p.title))];
    const matchedShows = new Set();
    showMap.forEach((show,title) => { if(epgTitles.reduce((max,et)=>Math.max(max,fuzzyScore(title,et)),0)>=55) matchedShows.add(title); });

    const showLines = [...showMap.values()].sort((a,b)=>a.title.localeCompare(b.title)).map(show => {
      const seasons=[...new Set(show.episodes.map(e=>e.season).filter(Boolean))].sort((a,b)=>a-b);
      return `- SHOW: "${show.title}" | ${show.episodes.length} eps${seasons.length?` | S${seasons.join(',')}`:''}${matchedShows.has(show.title)?' ✓MATCH':''}`;
    });
    const relevantEps = [];
    showMap.forEach((show,title) => {
      if(!matchedShows.has(title)) return;
      show.episodes.sort((a,b)=>((a.season||0)*1000+(a.episode||0))-((b.season||0)*1000+(b.episode||0))).forEach(ep => relevantEps.push(`  - [${ep.id}] S${String(ep.season||0).padStart(2,'0')}E${String(ep.episode||0).padStart(2,'0')} ${ep.duration?Math.round(ep.duration/60)+'min':''}`));
    });
    const movieLines = movieList.map(m=>`- MOVIE: [${m.id}] "${m.title}" ${m.year||''} ${m.duration?Math.round(m.duration/60)+'min':''}`);
    const schedule = programs.map(p=>{const t=new Date(p.start).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:true});const dur=p.stop&&p.start?Math.round((p.stop-p.start)/60000)+'min':'';return `  ${t} [${dur}] "${p.title}"`;}).join('\n');

    const { systemPrompt, userMessage, preAssigned } = buildAIPrompt(epgCh?.name||epgChannelId, programs, showMap, movieList, userPrompt, date);

    try {
      const text = await callAI(systemPrompt, userMessage);
      const allMedia = getMediaCombined();
      // Merge server-side pre-matches + AI assignments
      const preItems = (preAssigned||[]).map(s=>({ mediaId:s.mediaId, title:s.title, item:allMedia.find(m=>m.id===s.mediaId) })).filter(s=>s.item);
      const aiAssigned = [];
      try {
        let raw = text.replace(/```json|```/g,'').trim();
        const ji = raw.indexOf('{'); if (ji>0) raw=raw.slice(ji);
        const aiResult = JSON.parse(raw);
        const aiList = aiResult.assignments || aiResult.suggestions || [];
        aiList.forEach(s => { const item=allMedia.find(m=>m.id===s.mediaId); if(item) aiAssigned.push({...s,item}); });
      } catch(e) { console.log('[SF] Single AI parse error:', e.message); }
      const suggestions = [...preItems, ...aiAssigned];
      res.json({ ok:true, suggestions, unmatchedSlots:[], epgChannel:epgCh?.name, programCount:programs.length, preMatched:preItems.length, aiMatched:aiAssigned.length });
    } catch(e) { res.status(500).json({ error:e.message }); }
  });

  // Apply AI schedule to channel playout
  // Build schedule from network description or by fetching the network's own schedule URL
  app.post('/api/sf/ai/build-from-network', async (req, res) => {
    const { targetChannelId, channelDescription, guideUrl, date } = req.body;
    if (!channelDescription && !guideUrl) return res.status(400).json({ error:'channelDescription or guideUrl required' });
    const ch = sfDb.channels.find(c=>c.id===targetChannelId);
    if (!ch) return res.status(404).json({ error:'Channel not found' });
    try {
      const allMedia = getMediaCombined().filter(m=>m.path||m.jellyfinId||m.plexKey);
      if (!allMedia.length) return res.status(400).json({ error:'No media in library' });

      // Build candidate list grouped by show title for efficiency
      const showTitles = {};
      allMedia.forEach(m => {
        const t = m.title||'Unknown';
        if (!showTitles[t]) showTitles[t] = { id:m.id, title:t, type:m.type, seasons: new Set(), count:0 };
        if (m.season) showTitles[t].seasons.add(m.season);
        showTitles[t].count++;
      });
      const candidates = Object.values(showTitles).slice(0,500).map(s=>({
        id: s.id, title: s.title, type: s.type,
        seasons: s.seasons.size||null, episodes: s.count,
      }));

      // Fetch schedule page if URL provided
      let scheduleContext = '';
      if (guideUrl) {
        try {
          console.log(`[SF/AI/Network] Fetching guide URL: ${guideUrl}`);
          const html = await fetchUrl(guideUrl, { headers:{ 'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }});
          // Strip HTML tags, collapse whitespace — keep it short for the AI
          const text = (await html.text ? await html.text() : html)
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi,'')
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi,'')
            .replace(/<[^>]+>/g,' ')
            .replace(/&amp;/g,'&').replace(/&nbsp;/g,' ').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
            .replace(/\s+/g,' ').trim()
            .slice(0, 8000); // keep first 8k chars
          scheduleContext = `
SCHEDULE PAGE CONTENT:
${text}`;
          console.log(`[SF/AI/Network] Fetched ${text.length} chars from guide URL`);
        } catch(fetchErr) {
          console.warn('[SF/AI/Network] Could not fetch guide URL:', fetchErr.message);
          scheduleContext = `
(Could not fetch ${guideUrl}: ${fetchErr.message})`;
        }
      }

      const systemPrompt = `You select TV shows and movies from a library to match a channel's programming.
Return ONLY JSON: {"suggestions":[{"mediaId":"id","title":"title","reason":"show name or time slot it matches"}]}
Rules:
- Copy mediaId EXACTLY from CANDIDATES — never invent IDs
- If a schedule page is provided, match show titles from the schedule to CANDIDATES
- If no schedule, pick content that fits the channel description
- Aim for 20-40 items with variety
- Return ONLY the JSON`;

      const userMsg = `Channel: "${ch.name}"
Description: "${channelDescription||'match the schedule'}"
Date: ${date||new Date().toISOString().slice(0,10)}
${scheduleContext}

CANDIDATES (${candidates.length} shows in library):
${JSON.stringify(candidates)}

${guideUrl ? 'Match schedule show titles to the closest CANDIDATES.' : `Select ${Math.min(40,candidates.length)} items that fit this channel type.`}`;

      const aiResult = await callAI(systemPrompt, userMsg);
      const list = aiResult.suggestions || aiResult.assignments || [];

      // Expand show-level matches to actual episode items
      const suggestions = [];
      const usedShows = new Set();
      for (const s of list) {
        // Find item by ID first, then by title match
        let item = allMedia.find(m=>m.id===s.mediaId);
        if (!item && s.title) {
          const t = s.title.toLowerCase();
          item = allMedia.find(m=>m.title?.toLowerCase()===t && !usedShows.has(m.title));
        }
        if (item) {
          // For series, find the lowest unwatched episode
          const showEps = allMedia
            .filter(m=>m.title===item.title && m.type==='episode')
            .sort((a,b)=>((a.season||0)*1000+(a.episode||0))-((b.season||0)*1000+(b.episode||0)));
          const ep = showEps[0] || item;
          suggestions.push({...s, mediaId:ep.id, title:ep.title, item:ep});
          usedShows.add(item.title);
        }
      }

      res.json({ ok:true, suggestions, channelName:ch.name, channelDescription, guideUrl: guideUrl||null, totalMatched:suggestions.length });
    } catch(e) {
      console.error('[SF/AI/Network]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // Build ErsatzTV-style channel template: AI assigns shows to time slots, episodes play in order
  app.post('/api/sf/ai/build-channel-template', async (req, res) => {
    const { targetChannelId, networks, epgChannelId, date, userPrompt } = req.body;
    if (!targetChannelId) return res.status(400).json({ error:'targetChannelId required' });
    const ch = sfDb.channels.find(c=>c.id===targetChannelId);
    if (!ch) return res.status(404).json({ error:'Channel not found' });

    try {
      // Get all media from specified networks
      const parseArr = v => { if(Array.isArray(v))return v; if(typeof v==='string'){try{return JSON.parse(v);}catch{return [];}}return []; };
      let allMedia = getMediaCombined().filter(m=>m.path||m.jellyfinId||m.plexKey);

      if (networks?.length) {
        const netLower = networks.map(n=>n.toLowerCase());
        allMedia = allMedia.filter(m => {
          const raw = (orionDb?.tvShows||[]).find(ep=>ep.id===m.id) || (orionDb?.movies||[]).find(mv=>mv.id===m.id);
          if (!raw) return false;
          const net = (raw.network||'').toLowerCase();
          return netLower.some(n => net.includes(n) || n.includes(net));
        });
      }

      // Group by show title
      const showMap = {};
      allMedia.forEach(m => {
        const key = m.seriesTitle || m.title || 'Unknown';
        if (!showMap[key]) showMap[key] = { title:key, type:m.type||'episode', episodeCount:0, seasons:new Set(), firstId:m.id };
        if (m.season) showMap[key].seasons.add(m.season);
        showMap[key].episodeCount++;
      });
      const movies = Object.values(showMap).filter(s=>s.type==='movie').map(s=>s.title);
      const shows = Object.values(showMap).filter(s=>s.type!=='movie').map(s=>s.title);

      // Get EPG time slots if provided
      let epgSlots = '';
      if (epgChannelId) {
        const dateStr = date || new Date().toISOString().slice(0,10);
        const from = new Date(dateStr+'T00:00:00Z').getTime();
        const to = from + 86400000;
        const progs = sfDb.epg.programs.filter(p=>p.channel===epgChannelId&&p.stop>from&&p.start<to)
          .sort((a,b)=>a.start-b.start)
          .map(p => {
            const t = new Date(p.start).toISOString().slice(11,16);
            const dur = Math.round((p.stop-p.start)/60000);
            return `${t} [${dur}min] "${p.title}"`;
          });
        epgSlots = progs.length ? ('\nEPG TIME SLOTS FOR REFERENCE:\n' + progs.join('\n')) : '';
      }

      const systemPrompt = `You are building a weekly TV channel template. 
Assign ONE show from the SHOWS list to each time slot.
Movies go ONLY in prime time (7PM-10PM).
Return ONLY JSON: {"slots":[{"time":"HH:MM","showTitle":"exact title from list","mediaType":"episode|movie","daysOfWeek":"all"}]}
Rules:
- Use EXACT titles from SHOWS and MOVIES lists
- Each show gets exactly ONE permanent time slot
- Different show for every slot — no repeats
- Movies in 7PM-10PM slots only
- Slots run Monday-Sunday (daysOfWeek: "all")`;

      const userMsg = `Channel: "${ch.name}"
${userPrompt||'Disney Channel schedule: morning cartoons, afternoon live action, prime time movies'}
${epgSlots}

SHOWS AVAILABLE (${shows.length}):
${shows.join(', ')}

MOVIES AVAILABLE (${movies.length}):
${movies.join(', ')}

Create time slots from 6:00 AM to midnight. Assign a DIFFERENT show to each slot.
Do not repeat any show. Use all available shows spread across the week.`;

      const aiResult = await callAI(systemPrompt, userMsg);
      const slots = aiResult.slots || [];

      // Save template to channel
      const template = { slots, networks: networks||[], builtAt: new Date().toISOString() };
      const idx = sfDb.channels.findIndex(c=>c.id===targetChannelId);
      sfDb.channels[idx].channelTemplate = template;
      // Clear genreLoops and playout so template takes over
      sfDb.channels[idx].genreLoops = null;
      sfDb.channels[idx].genreLoop = null;
      sfDb.channels[idx].playout = [];
      saveAll();

      // Invalidate session so it restarts with new template
      if (hlsSessions[targetChannelId]) {
        try { hlsSessions[targetChannelId].proc.kill('SIGTERM'); } catch {}
        delete hlsSessions[targetChannelId];
      }

      res.json({ ok:true, slots, showCount:shows.length, movieCount:movies.length });
    } catch(e) {
      console.error('[SF/AI/Template]', e.message);
      res.status(500).json({ error:e.message });
    }
  });

  app.post('/api/sf/ai/apply-schedule', (req, res) => {
    const { channelId, suggestions } = req.body;
    const ch = sfDb.channels.find(c=>c.id===channelId);
    if (!ch) return res.status(404).json({ error:'channel not found' });
    const newQueue = (suggestions||[]).filter(s=>s.item).map(s=>({
      mediaId: s.item.id,
      title: s.title || s.item.episodeTitle || s.item.title || '',
    }));
    if (!newQueue.length) return res.status(400).json({ error:'No valid suggestions to apply' });
    ch.playout = [...(ch.playout||[]), ...newQueue];
    saveAll(); res.json({ ok:true, added:newQueue.length });
  });

  // ── Channel programming editor [PATCHED] ────────────────────────────────────
  app.get('/api/sf/channels/:id/programming', (req, res) => {
    const ch = sfDb.channels.find(c => c.id === req.params.id);
    if (!ch) return res.status(404).json({ error: 'Channel not found' });
    res.json({
      id: ch.id, name: ch.name,
      showTitles: ch.seriesSchedule?.showTitles || (ch.seriesSchedule?.showTitle ? [ch.seriesSchedule.showTitle] : []),
      timeBlocks: ch.timeBlocks || [],
      libraryLoop: ch.libraryLoop || null,
      genreLoop: ch.genreLoop || null,
      playoutCount: (ch.playout || []).length,
    });
  });
  app.post('/api/sf/channels/:id/programming/show', (req, res) => {
    const { showTitle } = req.body || {};
    if (!showTitle) return res.status(400).json({ error: 'showTitle required' });
    const idx = sfDb.channels.findIndex(c => c.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'Channel not found' });
    const ch = sfDb.channels[idx];
    const norm = x => (x||'').toLowerCase().replace(/[^a-z0-9]/g,'');
    const target = norm(showTitle);
    const found = (orionDb?.tvShows || []).some(s => norm(s.seriesTitle || '') === target);
    if (!found) return res.status(404).json({ error: 'Show "' + showTitle + '" not found in library' });
    if (!ch.seriesSchedule) ch.seriesSchedule = { showTitles: [], episodes: [{ mediaId:'placeholder', season:1, episode:1, duration:1800, title:'placeholder' }], rotationMode: 'mixed' };
    if (!Array.isArray(ch.seriesSchedule.showTitles)) ch.seriesSchedule.showTitles = ch.seriesSchedule.showTitle ? [ch.seriesSchedule.showTitle] : [];
    if (!ch.seriesSchedule.showTitles.includes(showTitle)) ch.seriesSchedule.showTitles.push(showTitle);
    saveAll();
    try { ensureChannelSchedule(ch, true); } catch(e) { console.warn('[SF] regen on show-add failed:', e.message); }
    if (hlsSessions[req.params.id]) { try { hlsSessions[req.params.id].proc.kill('SIGTERM'); } catch {}; delete hlsSessions[req.params.id]; }
    res.json({ ok: true, showTitles: ch.seriesSchedule.showTitles });
  });
  app.post('/api/sf/channels/:id/programming/timeblock', (req, res) => {
    const { start, end, showTitle, daysOfWeek } = req.body || {};
    if (!start || !end || !showTitle) return res.status(400).json({ error: 'start, end, showTitle required' });
    if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) return res.status(400).json({ error: 'start/end must be HH:MM' });
    const idx = sfDb.channels.findIndex(c => c.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'Channel not found' });
    const ch = sfDb.channels[idx];
    const norm = x => (x||'').toLowerCase().replace(/[^a-z0-9]/g,'');
    const target = norm(showTitle);
    const found = (orionDb?.tvShows || []).some(s => norm(s.seriesTitle || '') === target);
    if (!found) return res.status(404).json({ error: 'Show "' + showTitle + '" not found in library' });
    if (!Array.isArray(ch.timeBlocks)) ch.timeBlocks = [];
    ch.timeBlocks.push({ start, end, showTitle, daysOfWeek: daysOfWeek || 'daily' });
    saveAll();
    try { ensureChannelSchedule(ch, true); } catch(e) { console.warn('[SF] regen on tb-add failed:', e.message); }
    if (hlsSessions[req.params.id]) { try { hlsSessions[req.params.id].proc.kill('SIGTERM'); } catch {}; delete hlsSessions[req.params.id]; }
    res.json({ ok: true, timeBlocks: ch.timeBlocks });
  });
  app.delete('/api/sf/channels/:id/programming/show/:title', (req, res) => {
    const idx = sfDb.channels.findIndex(c => c.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'Channel not found' });
    const ch = sfDb.channels[idx];
    const t = decodeURIComponent(req.params.title);
    if (ch.seriesSchedule?.showTitles) ch.seriesSchedule.showTitles = ch.seriesSchedule.showTitles.filter(s => s !== t);
    if (Array.isArray(ch.timeBlocks)) ch.timeBlocks = ch.timeBlocks.filter(tb => tb.showTitle !== t);
    saveAll();
    try { ensureChannelSchedule(ch, true); } catch(e) { console.warn('[SF] regen on show-del failed:', e.message); }
    if (hlsSessions[req.params.id]) { try { hlsSessions[req.params.id].proc.kill('SIGTERM'); } catch {}; delete hlsSessions[req.params.id]; }
    res.json({ ok: true, showTitles: ch.seriesSchedule?.showTitles || [], timeBlocks: ch.timeBlocks || [] });
  });
  app.delete('/api/sf/channels/:id/programming/timeblock/:idx', (req, res) => {
    const cIdx = sfDb.channels.findIndex(c => c.id === req.params.id);
    if (cIdx < 0) return res.status(404).json({ error: 'Channel not found' });
    const ch = sfDb.channels[cIdx];
    const tbIdx = parseInt(req.params.idx, 10);
    if (!Array.isArray(ch.timeBlocks) || isNaN(tbIdx) || tbIdx < 0 || tbIdx >= ch.timeBlocks.length) return res.status(404).json({ error: 'Time block index out of range' });
    ch.timeBlocks.splice(tbIdx, 1);
    saveAll();
    try { ensureChannelSchedule(ch, true); } catch(e) { console.warn('[SF] regen on tb-del failed:', e.message); }
    if (hlsSessions[req.params.id]) { try { hlsSessions[req.params.id].proc.kill('SIGTERM'); } catch {}; delete hlsSessions[req.params.id]; }
    res.json({ ok: true, timeBlocks: ch.timeBlocks });
  });

  // ── Create channels from EPG ─────────────────────────────────────────────────
  app.post('/api/sf/channels/create-from-epg', async (req, res) => {
    const { epgChannelIds } = req.body;
    if (!epgChannelIds?.length) return res.status(400).json({ error: 'epgChannelIds required' });
    const epgChannels = sfDb.epg.channels || [];
    const existing = sfDb.channels;
    const existingNames = new Set(existing.map(c => (c.name||'').toLowerCase()));
    const existingEpgIds = new Set(existing.map(c => c.epgChannelId).filter(Boolean));
    let nextNum = existing.length ? Math.max(...existing.map(c => c.num||0)) + 1 : 1;
    const created = [];
    for (const epgId of epgChannelIds) {
      const epgCh = epgChannels.find(c => c.id === epgId);
      if (!epgCh) continue;
      if (existingEpgIds.has(epgId) || existingNames.has((epgCh.name||epgId).toLowerCase())) continue;
      const ch = {
        id: uuidv4(), name: epgCh.name || epgId,
        num: nextNum++, group: epgCh.group || '',
        logo: epgCh.logo || '', epgChannelId: epgId,
        playout: [], timeBlocks: [], active: true,
        createdAt: new Date().toISOString(),
      };
      sfDb.channels.push(ch);
      created.push(ch);
      existingNames.add(ch.name.toLowerCase());
      existingEpgIds.add(epgId);
    }
    saveAll();
    res.json({ ok: true, created: created.length, channels: created });
  });

  // ── Build All Channels (batch AI scheduler) ───────────────────────────────
  // This SSE endpoint streams progress back to the client
  app.post('/api/sf/ai/build-all', async (req, res) => {
    const { date, userPrompt, batchSize = 50, forceAll = false } = req.body;

    // Set up SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = (data) => {
      try {
        res.write('data: ' + JSON.stringify(data) + '\n\n');
        if (res.flush) res.flush();
      } catch (_) {}
    };

    try {
      const epgChannels = sfDb.epg.channels || [];
      if (!epgChannels.length) { send({ error: 'No EPG imported yet — go to EPG tab first.' }); return res.end(); }

      // Verify AI is configured before starting the batch
      const provider = sfConfig.aiProvider || 'anthropic';
      if (provider === 'anthropic' && !sfConfig.anthropicApiKey && !process.env.ANTHROPIC_API_KEY) {
        send({ error: 'No AI API key configured. Go to StreamForge Settings → AI Provider and add your key, or use Ollama (local).' }); return res.end();
      }
      if (provider === 'ollama') {
        try {
          const testR = await fetchUrl(`${(sfConfig.ollamaUrl||'http://localhost:11434').replace(/\/v1\/?$/,'')}/api/version`, {});
          if (!testR.ok) throw new Error('not reachable');
        } catch {
          send({ error: `Ollama is not reachable at ${sfConfig.ollamaUrl||'http://localhost:11434'}. Make sure Ollama is running.` }); return res.end();
        }
      }

      const channels = sfDb.channels;
      const norm = s => (s||'').toLowerCase().replace(/[^a-z0-9]/g, '');
      const bestEpgMatch = (chName) => {
        const n = norm(chName);
        const m = epgChannels.find(e => norm(e.name) === n) || epgChannels.find(e => norm(e.name).includes(n) || n.includes(norm(e.name)));
        return m?.id || null;
      };

      const disabledEpg = new Set(sfDb.epgDisabled || []);
      // Find channels needing schedules — skip disabled EPG channels
      const pairs = channels
        .filter(ch => !ch.liveStreamId)
        .map(ch => ({ ch, epgId: ch.epgChannelId || bestEpgMatch(ch.name) }))
        .filter(p => p.epgId && !disabledEpg.has(p.epgId) && (forceAll || !p.ch.playout || p.ch.playout.length === 0));

      const batch = pairs.slice(0, batchSize);
      const remaining = pairs.length - batch.length;
      send({ stage: 'start', total: batch.length, remaining, totalEpg: epgChannels.length });

      let done = 0, errors = [];
      const isLocalAI = ['ollama','openwebui','custom'].includes(sfConfig.aiProvider||'anthropic');
      const maxCandidates = isLocalAI ? 20 : 40; // local models have smaller context windows
      for (const { ch, epgId } of batch) {
        send({ stage: 'building', channel: ch.name, done, total: batch.length });
        // Small delay between channels to let local models breathe
        if (done > 0 && isLocalAI) await new Promise(r => setTimeout(r, 3000));
        try {
          const buildReq = { channelId: epgId, epgChannelId: epgId, targetChannelId: ch.id, date: date || new Date().toISOString().slice(0,10), userPrompt: userPrompt || 'Match my library to this channel as closely as possible' };
          // Re-use the existing AI build logic by calling it internally
          let programs = sfDb.epg.programs.filter(p => p.channel === epgId);
          if (date) { const from = new Date(date+'T00:00:00Z').getTime(), to = from+86400000; programs = programs.filter(p => p.stop > from && p.start < to); }
          programs.sort((a,b) => a.start - b.start);
          if (!programs.length) { send({ stage: 'skip', channel: ch.name, reason: 'No EPG programs for this channel/date' }); done++; continue; }

          const showMap = new Map(), movieList = [];
          getMediaCombined().forEach(m => {
            if (m.type === 'movie') movieList.push({ id: m.id, title: m.title, year: m.year });
            else { const k = m.title||'Unknown'; if (!showMap.has(k)) showMap.set(k, { title: k, episodes: [] }); showMap.get(k).episodes.push(m); }
          });
          function normTitle(t) { return (t||'').toLowerCase().replace(/^(the|a|an) /,'').replace(/[^a-z0-9 ]/g,'').replace(/\s+/g,' ').trim(); }
          function fuzzyScore(a, b) { const na=normTitle(a),nb=normTitle(b); if(!na||!nb) return 0; if(na===nb) return 100; if(na.includes(nb)||nb.includes(na)) return 90; const wa=new Set(na.split(' ').filter(w=>w.length>2)),wb=new Set(nb.split(' ').filter(w=>w.length>2)); if(!wa.size||!wb.size) return 0; const shared=[...wa].filter(w=>wb.has(w)).length; return Math.round(shared/Math.max(wa.size,wb.size)*75); }
          const epgTitles = [...new Set(programs.map(p => p.title))];
          const matchedShows = new Set();
          showMap.forEach((_,title) => { if (epgTitles.reduce((max,et) => Math.max(max, fuzzyScore(title,et)), 0) >= 55) matchedShows.add(title); });
          const showLines = [...showMap.values()].sort((a,b)=>a.title.localeCompare(b.title)).map(show => `- SHOW: "${show.title}" | ${show.episodes.length} eps${matchedShows.has(show.title)?' ✓MATCH':''}`);
          const relevantEps = []; showMap.forEach((show,title) => { if (!matchedShows.has(title)) return; show.episodes.sort((a,b)=>((a.season||0)*1000+(a.episode||0))-((b.season||0)*1000+(b.episode||0))).forEach(ep => relevantEps.push(`  - [${ep.id}] S${String(ep.season||0).padStart(2,'0')}E${String(ep.episode||0).padStart(2,'0')}`)); });
          const movieLines = movieList.map(m=>`- MOVIE: [${m.id}] "${m.title}" ${m.year||''}`);
          const schedule = programs.map(p=>{ const t=new Date(p.start).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:true}); const dur=p.stop&&p.start?Math.round((p.stop-p.start)/60000)+'min':''; return '  '+t+' ['+dur+'] "'+p.title+'"'; }).join('\n');
          const epgChName = sfDb.epg.channels.find(c=>c.id===epgId)?.name||epgId;
          const { systemPrompt, userMessage, preAssigned } = buildAIPrompt(epgChName, programs, showMap, movieList, userPrompt, date, maxCandidates);

          const text = await callAI(systemPrompt, userMessage);
          const allMedia = getMediaCombined();

          // Merge pre-assigned server-side + AI assignments
          const aiAssigned = [];
          try {
            let rawText = text.replace(/```json|```/g,'').trim();
            const ji = rawText.indexOf('{');
            if (ji > 0) rawText = rawText.slice(ji);
            const aiResult = JSON.parse(rawText);
            const aiList = aiResult.assignments || aiResult.suggestions || [];
            aiList.forEach(s => {
              const item = allMedia.find(m => m.id === s.mediaId);
              if (item) aiAssigned.push({ ...s, item });
            });
          } catch(e) {
            console.log('[SF/build-all] AI parse error for', ch.name, ':', e.message, '| raw:', text.slice(0,100));
          }

          // preAssigned comes from buildAIPrompt's server-side fuzzy matching
          const preItems = (preAssigned||[]).map(s => ({ mediaId: s.mediaId, title: s.title, item: allMedia.find(m => m.id === s.mediaId) })).filter(s => s.item);
          const suggestions = [...preItems, ...aiAssigned];
          console.log('[SF/build-all]', ch.name, '— pre-matched:', preItems.length, '+ AI:', aiAssigned.length, '= total:', suggestions.length);

          if (suggestions.length) {
            const targetCh = sfDb.channels.find(c => c.id === ch.id);
            if (targetCh) { targetCh.playout = [...(targetCh.playout||[]), ...suggestions.map(s => ({ mediaId: s.item.id }))]; }
          }
          send({ stage: 'built', channel: ch.name, matched: suggestions.length });
        } catch(e) {
          errors.push(`${ch.name}: ${e.message}`);
          send({ stage: 'error', channel: ch.name, error: e.message });
        }
        done++;
      }
      saveAll();
      send({ stage: 'done', done, errors, remaining });
    } catch (e) {
      send({ error: e.message });
    }
    res.end();
  });

  // ── Plex/Jellyfin section discovery ─────────────────────────────────────────
  app.post('/api/sf/libraries/plex-sections', async (req, res) => {
    const { url, token } = req.body;
    try {
      const r = await fetchUrl(`${url.replace(/\/+$/,'')}/library/sections`, { headers:{'X-Plex-Token':token,'Accept':'application/json'} });
      const d = await r.json();
      res.json((d.MediaContainer.Directory||[]).map(s=>({ key:s.key, title:s.title, type:s.type, count:s.size })));
    } catch(e) { res.status(500).json({ error:e.message }); }
  });

  // ── Reset ─────────────────────────────────────────────────────────────────────
  app.post('/api/sf/reset/channels', (req, res) => { sfDb.channels=[]; saveAll(); res.json({ok:true}); });
  app.post('/api/sf/reset/playout',  (req, res) => { sfDb.channels.forEach(ch=>{ch.playout=[];ch.liveStreamId=null;}); saveAll(); res.json({ok:true}); });
  app.post('/api/sf/reset/factory',  (req, res) => { sfDb.channels=[];sfDb.libraries=[];sfDb.media=[];sfDb.epg={channels:[],programs:[],importedAt:null,sourceName:''};saveAll(); res.json({ok:true}); });

  console.log('[SF] All routes mounted at /api/sf/* and /sf/*');
};

// ── PlayoutEngine boot ────────────────────────────────────────────────────────
setTimeout(() => {
  try {
    if (typeof playoutEngine !== 'undefined' && playoutEngine.init && !playoutEngine._inited) {
      const channels = (typeof sfDb !== 'undefined' && sfDb && sfDb.channels) ? sfDb.channels : [];
      playoutEngine.init({
        channels: channels,
        getChannels: () => channels,
        getMediaById: (id) => {
          try {
            if (typeof _mediaById !== 'undefined' && _mediaById && _mediaById.get) return _mediaById.get(id);
            if (typeof getMediaCombined === 'function') return getMediaCombined().find(m => m.id === id);
          } catch (e) {}
          return null;
        },
        getMediaCombined: typeof getMediaCombined === 'function' ? getMediaCombined : () => [],
        pickNextEpisode: typeof pickNextEpisode === 'function' ? pickNextEpisode : null,
      });
      playoutEngine._inited = true;
      if (playoutEngine.start) playoutEngine.start();
      console.log('[PlayoutEngine] booted (' + channels.length + ' channels)');
    }
  } catch (e) {
    console.error('[PlayoutEngine] init failed:', e && e.message ? e.message : e);
  }
}, 10000);

// === [DBOPT_v1] cleanupPresegOrphans ===
;(function attachCleanup(){
  if (!module.exports || typeof module.exports !== 'object') return;
  module.exports.cleanupPresegOrphans = function cleanupPresegOrphans() {
    const fsL = require('fs');
    const pathL = require('path');
    let dropped = 0;
    if (typeof presegDb !== 'object' || !presegDb) return 0;
    for (const mid of Object.keys(presegDb)) {
      const fp = presegDb[mid] && presegDb[mid].filePath;
      if (fp && !fsL.existsSync(fp)) { delete presegDb[mid]; dropped++; }
    }
    if (dropped > 0) {
      try {
        const dir = (typeof SF_DIR !== 'undefined') ? SF_DIR : '/var/lib/orion/sf';
        fsL.writeFileSync(pathL.join(dir, 'preseg.json'), JSON.stringify(presegDb));
      } catch(e) {}
    }
    console.log('[StreamForge] cleanupPresegOrphans dropped ' + dropped);
    return dropped;
  };
})();

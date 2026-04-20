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
const multer  = require('multer');
const crypto  = require('crypto');

// ── Data files — stored alongside Orion's library.json ───────────────────────
let SF_DIR, SF_CFG, SF_CHANNELS, SF_LIBRARIES, SF_MEDIA, SF_EPG, SF_STREAMS, SF_EPG_DISABLED;

// ── State ─────────────────────────────────────────────────────────────────────
let sfDb = {};
let sfConfig = {};
let ffmpegExe = '', ffprobeExe = '', hwEncoder = 'libx264';
let orionDb = null; // set on mount — live reference to Orion's db


// ── Cached media combined — rebuilt only when Orion DB changes ───────────────
let _mediaCombinedCache = null;
let _mediaCombinedDirty = true;
let _showsCache = null; // pre-built show index, rebuilt when media cache rebuilds
const _mediaById = new Map(); // id -> item for O(1) lookups

let _networkIndex = new Map(); // network -> [items]

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
  if (ch.liveStreamId) { const s=getSfStream(ch.liveStreamId); return [{start:fromMs,end:toMs,title:s?`🔴 ${s.name}`:'🔴 Live',isLive:true}]; }
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
      programs.push({ start, end, title, desc: now.item.summary||'', icon: now.item.thumb||'' });
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

// ── Multi-GPU round-robin (for Proxmox + multiple P40s) ──────────────────────
let _nextGpuIdx = 0;
function assignGpu() {
  const count = Math.max(1, parseInt(sfConfig.gpuCount) || 1);
  const gpu = _nextGpuIdx % count;
  _nextGpuIdx++;
  return gpu;
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
  const useHwDecode = (sfConfig.hwDecode === true && isLiveSrc && isNvenc) && vCodec !== 'copy';
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
let presegWorkers = 0;
const MAX_PRESEG_WORKERS = () => Math.max(1, parseInt(sfConfig.presegWorkers) || 4);

function loadPresegDb() {
  try {
    const p = path.join(SF_DIR, 'preseg.json');
    if (fs.existsSync(p)) presegDb = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {}
  // Restore pending queue from disk
  try {
    const qp = path.join(SF_DIR, 'preseg-queue.json');
    if (fs.existsSync(qp)) {
      const saved = JSON.parse(fs.readFileSync(qp, 'utf8'));
      // Only restore items not already done
      presegQueue = saved.filter(q => presegDb[q.mediaId]?.status !== 'done' && presegDb[q.mediaId]?.status !== 'processing');
      console.log(`[SF/Preseg] Restored ${presegQueue.length} queued items from disk`);
    }
  } catch {}
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

function savePresegDb() {
  try { fs.writeFileSync(path.join(SF_DIR, 'preseg.json'), JSON.stringify(presegDb)); } catch {}
}

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

function drainPresegQueue() {
  while (presegWorkers < MAX_PRESEG_WORKERS() && presegQueue.length > 0) {
    const item = presegQueue.shift();
    savePresegQueue();
    presegWorkers++;
    runPreseg(item).finally(() => { presegWorkers--; drainPresegQueue(); });
  }
}

async function runPreseg({ mediaId, filePath }) {
  // Store segments alongside the original file on NAS — e.g. /mnt/nas/show/.hls/episodeName/
  const fileBase = path.basename(filePath, path.extname(filePath));
  const fileDir = path.dirname(filePath);
  const segDir = path.join(fileDir, '.hls', fileBase);
  const segLen = sfConfig.hlsSegmentSeconds || 12;
  presegDb[mediaId] = { status: 'processing', segDir, filePath };

  try {
    // Create directory using shell as root to handle NFS UID mapping
    const { execSync } = require('child_process');
    try {
      execSync(`mkdir -p "${segDir.replace(/"/g, '\"')}" && chmod 777 "${segDir.replace(/"/g, '\"')}"`, { uid:0, gid:0 });
    } catch(mkErr) {
      console.error('[SF/Preseg] mkdir failed:', mkErr.message);
      throw mkErr;
    }
    const gpuId = assignGpu();
    // Use config to determine encoder — hwEncoder may not be set yet at startup
    const useNvenc = sfConfig.hwAccel === 'nvenc' || hwEncoder.includes('nvenc');
    const enc = useNvenc ? 'h264_nvenc' : 'libx264';
    const isNvenc = useNvenc;

    // Build encode args — same quality as live but no seek offset
    const args = [
      '-fflags', '+genpts+igndts',
      '-err_detect', 'ignore_err',
      '-i', filePath,
      '-map', '0:v:0', '-map', '0:a:0?',
    ];

    if (isNvenc) {
      args.push('-pix_fmt', 'yuv420p',
        '-vcodec', 'h264_nvenc', '-gpu', String(gpuId),
        '-preset', 'p2', '-rc:v', 'vbr', '-cq:v', '23',
        '-b:v', '4M', '-maxrate:v', '8M', '-bufsize:v', '8M',
        '-g', '60', '-keyint_min', '60', '-sc_threshold', '0');
    } else {
      args.push('-pix_fmt', 'yuv420p',
        '-vcodec', 'libx264', '-crf', '23', '-preset', 'fast',
        '-b:v', '4M', '-maxrate', '8M', '-bufsize', '8M',
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

    await new Promise((resolve, reject) => {
      const proc = spawn(ffmpegExe, args, { stdio: ['ignore','ignore','pipe'] });
      let errBuf = '';
      proc.stderr.on('data', d => { errBuf += d.toString(); });
      proc.on('exit', code => {
        if (code === 0 || code === null) {
          // Validate completion — check index.m3u8 has EXT-X-ENDLIST and seg count matches
          try {
            const indexFile = path.join(segDir, 'index.m3u8');
            const indexContent = fs.existsSync(indexFile) ? fs.readFileSync(indexFile, 'utf8') : '';
            const isComplete = indexContent.includes('#EXT-X-ENDLIST');
            const expectedSegs = (indexContent.match(/#EXTINF/g)||[]).length;
            const segFiles = fs.readdirSync(segDir).filter(f=>f.endsWith('.ts'));
            const actualSegs = segFiles.length;
            // Check every segment is non-zero bytes
            const emptySegs = segFiles.filter(f => fs.statSync(path.join(segDir,f)).size === 0).length;
            if (!isComplete || actualSegs < expectedSegs || emptySegs > 0) {
              const err = `Incomplete: ${actualSegs}/${expectedSegs} segments, endlist=${isComplete}, emptySegs=${emptySegs}`;
              console.error(`[SF/Preseg] ${err} for ${mediaId}`);
              presegDb[mediaId] = { status:'error', error: err };
              savePresegDb();
              reject(new Error(err));
              return;
            }
            console.log(`[SF/Preseg] Done ${mediaId} — ${actualSegs} segments`);
            presegDb[mediaId] = { status:'done', segDir, segCount:actualSegs, segLen, doneAt: Date.now(), filePath, displayName: presegQueue.find(q=>q.mediaId===mediaId)?.displayName || path.basename(filePath||'') };
            savePresegDb();
            resolve();
          } catch(ve) {
            presegDb[mediaId] = { status:'error', error: ve.message };
            savePresegDb();
            reject(ve);
          }
        } else {
          const err = errBuf.slice(-300);
          console.error(`[SF/Preseg] Error ${mediaId}: ${err}`);
          presegDb[mediaId] = { status:'error', error: err.slice(0,200) };
          savePresegDb();
          reject(new Error('preseg failed'));
        }
      });
    });
  } catch(e) {
    presegDb[mediaId] = { status:'error', error: e.message };
    savePresegDb();
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
      setTimeout(() => {
        const stillCh = sfDb.channels.find(c=>c.id===channelId);
        if (stillCh && !hlsSessions[channelId]) {
          if (crashes > 0) console.log(`[SF/HLS] Auto-restarting keepAlive channel "${stillCh.name}" (delay=${restartDelay}ms, crash #${crashes})`);
          const s = startHlsSession(stillCh, { keepAlive: true });
          if (s) s._crashCount = crashes > 5 ? 0 : crashes; // reset after long backoff
        }
      }, restartDelay);
    }
  });
  return session;
}

// Pre-buffer watchdog — checks every 5 minutes and restarts any channel that should be running
setInterval(() => {
  const mode = sfConfig.prebufferMode || 'library';
  if (mode === 'none') return;
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
  Object.entries(hlsSessions).forEach(([id,sess]) => {
    if (sess.keepAlive) return; // never idle-kill always-on channels
    if(now-sess.lastRequest>idleMs) { try{sess.proc.kill('SIGKILL');}catch{} delete hlsSessions[id]; }
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
      if (hwEncoder.includes('amf'))        sfConfig.hwAccel = 'amf';
      else if (hwEncoder.includes('nvenc')) sfConfig.hwAccel = 'nvenc';
      else if (hwEncoder.includes('qsv'))   sfConfig.hwAccel = 'qsv';
      console.log(`[SF] hwAccel set to: ${sfConfig.hwAccel} from encoder: ${hwEncoder}`);
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
    const BATCH = gpuCount; // 1 channel per GPU — prevents CPU overload during pre-buffer
    console.log(`[SF/Prebuffer] Pre-buffering ${channels.length} channels in batches of ${BATCH}...`);
    for (let i = 0; i < channels.length; i += BATCH) {
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
  app.get('/api/sf/preseg/status', (req, res) => {
    const done = Object.values(presegDb).filter(v=>v.status==='done').length;
    const processing = Object.values(presegDb).filter(v=>v.status==='processing').length;
    const error = Object.values(presegDb).filter(v=>v.status==='error').length;
    const queued = presegQueue.length;
    const totalMedia = getMediaCombined().filter(m=>m.path||m.filePath).length;
    const currentFiles = Object.entries(presegDb).filter(([,v])=>v.status==='processing').map(([id])=>{
      const m = getMediaById(id); return m ? (m.seriesTitle||m.title||id) : id;
    });
    const allItems = Object.entries(presegDb).map(([id,v]) => {
      const m = getMediaById(id);
      const name = m
        ? (m.seriesTitle
            ? `${m.seriesTitle} S${String(m.season||0).padStart(2,'0')}E${String(m.episode||0).padStart(2,'0')}${m.episodeTitle?' — '+m.episodeTitle:''}`
            : m.title||id)
        : (v.filePath ? path.basename(v.filePath, path.extname(v.filePath)) : id);
      return { id, status:v.status, name, error:v.error||null, segCount:v.segCount||null };
    });
    res.json({ done, processing, error, queued, totalMedia, workers: presegWorkers, maxWorkers: MAX_PRESEG_WORKERS(), items: allItems, currentFiles });
  });

  // Reset presegDb entries so they get re-validated on next queue
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

  app.post('/api/sf/preseg/queue-channel', (req, res) => {
    const { channelId } = req.body;
    if (!channelId) return res.status(400).json({ error:'channelId required' });
    const ch = sfDb.channels.find(c=>c.id===channelId);
    if (!ch) return res.status(404).json({ error:'channel not found' });

    let queued = 0;
    // Queue all items for this channel's content
    const queueItem = (item) => {
      if (!item) return;
      const filePath = item.path || item.filePath;
      if (filePath && !isPresegged(item.id)) {
        queuePreseg(item.id, filePath);
        queued++;
      }
    };

    if (ch.genreLoops?.length || ch.genreLoop) {
      const idx = getNetworkIndex();
      const loops = ch.genreLoops?.length ? ch.genreLoops : [ch.genreLoop];
      loops.forEach(l => {
        const items = idx.get((l.genre||'').toLowerCase()) || [];
        items.forEach(queueItem);
      });
    } else if (ch.seriesSchedule?.episodes?.length) {
      // Try by mediaId first, fall back to title search
      const showTitle = (ch.seriesSchedule.showTitle || ch.name || '').toLowerCase();
      const allEps = getMediaCombined().filter(m =>
        (m.seriesTitle||m.title||'').toLowerCase().includes(showTitle) ||
        showTitle.includes((m.seriesTitle||m.title||'').toLowerCase())
      );
      if (allEps.length) {
        allEps.forEach(queueItem);
      } else {
        ch.seriesSchedule.episodes.forEach(ep => {
          const item = getMediaById(ep.mediaId);
          queueItem(item);
        });
      }
    } else if (ch.playout?.length) {
      ch.playout.forEach(b => {
        const item = getMediaById(b.mediaId);
        queueItem(item);
      });
    }

    res.json({ ok:true, queued });
  });

  app.post('/api/sf/preseg/queue-all', (req, res) => {
    const allMedia = getMediaCombined().filter(m=>(m.path||m.filePath)&&!isPresegged(m.id));
    allMedia.forEach(m => queuePreseg(m.id, m.path||m.filePath));
    res.json({ ok:true, queued: allMedia.length });
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
  app.post('/api/sf/ai/test', async (req, res) => {
    try {
      const result = await callAI('You are a test assistant.', 'Reply with exactly: "AI connection OK"');
      res.json({ ok: true, message: `${sfConfig.aiProvider||'ai'} responded: "${result.slice(0,80)}"` });
    } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // ── Config ──────────────────────────────────────────────────────────────────
  app.get('/api/sf/config', (req, res) => res.json(sfConfig));
  app.put('/api/sf/config', (req, res) => {
    const allowed = ['baseUrl','epgDaysAhead','xcUser','xcPass','videoCodec','videoProfile','hwAccel','hwDecode','gpuCount','videoBitrate','videoMaxBitrate','videoBufferSize','videoCrf','audioCodec','audioBitrate','audioChannels','audioLanguage','hlsSegmentSeconds','hlsListSize','hlsIdleTimeoutSecs','prebufferMode','adaptiveQuality','maxResolution','presegWorkers','outputProtocol','srtPort','rtspPort','rtmpPort','udpBase','udpPort','presegDir','aiProvider','anthropicApiKey','openaiApiKey','openaiModel','ollamaUrl','ollamaModel','openwebUIUrl','openwebUIKey','openwebUIModel','customAiUrl','customAiKey','customAiModel','videoResolution','sdUsername','sdPassword','sdLineupId','sdAutoUpdate'];
    allowed.forEach(k => { if (req.body[k] !== undefined) sfConfig[k] = req.body[k]; });
    saveJson(SF_CFG, sfConfig); res.json({ ok:true });
  });

  // ── Channels ─────────────────────────────────────────────────────────────────
  app.get('/api/sf/channels', (req, res) => res.json(sfDb.channels));
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
    const s = hlsSessions[req.params.id]; if (s) { try{s.proc.kill('SIGKILL');}catch{} delete hlsSessions[req.params.id]; }
    res.json({ ok:true });
  });

  // ── HLS serving ─────────────────────────────────────────────────────────────
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
      waited+=50; if(waited>5000) return res.status(503).send('HLS not ready — startup timeout');
      setTimeout(tryServe, 50);
    };
    tryServe();
  });
  app.get('/sf/hls/:channelId/:segment', (req, res) => {
    const session = hlsSessions[req.params.channelId];
    if (!session) return res.status(404).send('No session');
    session.lastRequest = Date.now();
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
    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="Orion/StreamForge">\n`;
    sfDb.channels.filter(c=>c.active).forEach(ch => {
      xml += `  <channel id="${ch.id}"><display-name>${ch.name}</display-name>${ch.logo?`<icon src="${ch.logo}"/>`:''}${ch.num?`<lcn>${ch.num}</lcn>`:''}</channel>\n`;
    });
    sfDb.channels.filter(c=>c.active).forEach(ch => {
      const progs = buildSchedule(ch, now, to);
      progs.forEach(p => {
        xml += `  <programme channel="${ch.id}" start="${fmtDate(p.start)}" stop="${fmtDate(p.end)}"><title>${p.title}</title>${p.desc?`<desc>${p.desc}</desc>`:''}</programme>\n`;
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
    if (req.query.q)     { const q=req.query.q.toLowerCase(); items=items.filter(m=>m.title?.toLowerCase().includes(q)); }
    if (req.query.lib)   items = items.filter(m=>m.libraryId===req.query.lib);
    const page = parseInt(req.query.page)||1, limit = parseInt(req.query.limit)||10000;
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

// [PATCHED] Multi-GPU spread - deterministic GPU per channel (hash-based, stable across restarts)
// [PATCHED] Live-load-balanced GPU picker — replaces sticky channel-id hash.
// Tracks active stream count per GPU; picks the least-loaded GPU at spawn time.
// Tie-break uses the original channel-id hash so a single channel restarting tends
// to land on the same GPU (preserves cache locality when load is even).
const _playoutGpuLoad = [0, 0, 0, 0];
function _gpuForChannel(id) {
  let min = _playoutGpuLoad[0];
  for (let i = 1; i < _playoutGpuLoad.length; i++) if (_playoutGpuLoad[i] < min) min = _playoutGpuLoad[i];
  const candidates = [];
  for (let i = 0; i < _playoutGpuLoad.length; i++) if (_playoutGpuLoad[i] === min) candidates.push(i);
  if (candidates.length === 1) return candidates[0];
  let h = 0;
  for (let i = 0; i < id.length; i++) { h = ((h << 5) - h) + id.charCodeAt(i); h = h | 0; }
  return candidates[Math.abs(h) % candidates.length];
}
// [PATCHED] Daily-seeded shuffle - playlist re-orders each day so the same show rotates across time slots
function _dailyShuffleItems(items, channelId) {
  const dayOfEpoch = Math.floor(Date.now() / 86400000);
  let seed = dayOfEpoch;
  for (let i = 0; i < channelId.length; i++) {
    seed = ((seed << 5) - seed + channelId.charCodeAt(i)) | 0;
  }
  let st = seed >>> 0;
  const rand = () => {
    st += 0x6D2B79F5;
    let t = st;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// [PATCHED] Codec detection for selective hwaccel (HEVC uses CPU decode - NVDEC filter chain incompatibility)
function _detectCodecSync(filePath) {
  try {
    const cp = require('child_process');
    const out = cp.execSync(`ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 "${filePath.replace(/"/g, '\\"')}"`, { encoding: 'utf8', timeout: 3000 });
    return out.trim();
  } catch { return 'unknown'; }
}


// ============================================================================
// playout-engine.js — Clean StreamForge playout engine
// ============================================================================
//
// REPLACES the broken playout/schedule/HLS code in streamforge.js with a clean
// architecture inspired by ErsatzTV:
//
//   1. PRE-COMPUTED PLAYLISTS — Each channel has its next 24h of content
//      computed once and cached in memory + written to a concat playlist file.
//      Schedule and "now playing" queries are flat lookups, NOT computations.
//
//   2. ONE FFMPEG PER CHANNEL — Each non-live channel runs a single persistent
//      ffmpeg using `-f concat` demuxer. Episodes transition INSIDE ffmpeg.
//      No exit-handler restart, no spawn race, no kill loop.
//
//   3. LIVE IPTV UNCHANGED — Channels with `liveStreamId` are not touched by
//      this engine. streamforge.js continues to handle those exactly as before.
//
//   4. AI PROGRAMMING UNCHANGED — This engine consumes whatever
//      seriesSchedule.episodes / libraryLoop / playout / genreLoops the rest
//      of streamforge.js produces, including AI-generated programming.
//
// ============================================================================
// INTEGRATION (in streamforge.js):
//
//   const playoutEngine = require('./playout-engine');
//
//   playoutEngine.init({
//     getMediaById,           // function(id) -> media item or null
//     getMediaCombined,       // function() -> array of all media items
//     getSfStream,            // function(streamId) -> IPTV stream config
//     getChannels,            // function() -> array of channels (sfDb.channels)
//     ffmpegPath: ffmpegExe,  // path to ffmpeg binary
//   });
//
//   // Replace existing startHlsSession with this dispatcher:
//   function startHlsSession(ch, opts = {}) {
//     if (ch.liveStreamId) return _startLiveIptvSession(ch, opts); // keep IPTV path
//     return playoutEngine.startChannelStream(ch);
//   }
//
//   // Replace getPlayoutNow:
//   function getPlayoutNow(ch, nowMs) {
//     return playoutEngine.getNowPlaying(ch.id);
//   }
//
//   // Replace buildSchedule:
//   function buildSchedule(ch, fromMs, toMs) {
//     return playoutEngine.getSchedule(ch, fromMs, toMs);
//   }
//
//   // On orion startup (after channels load):
//   playoutEngine.start();
//
// ============================================================================

const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const HLS_BASE = '/var/lib/orion/sf/hls';
const PLAYLIST_BASE = '/var/lib/orion/sf/concat';
const PLAYLIST_HOURS = 24; // generate 24h of playlist per channel
const REFRESH_INTERVAL_MS = 10 * 60 * 1000; // re-check playlists every 10 min

// State
const playlists = new Map(); // channelId -> { items, generatedAt, durationMs, file }
const streams = new Map();   // channelId -> { proc, startedAt, channelId, restarts }
let deps = null;             // injected by init()
let started = false;

// ──────────────────────────────────────────────────────────────────────────────
// INIT
// ──────────────────────────────────────────────────────────────────────────────

function init(injectedDeps) {
  deps = {
    getMediaById: injectedDeps.getMediaById,
    getMediaCombined: injectedDeps.getMediaCombined,
    getSfStream: injectedDeps.getSfStream,
    getChannels: injectedDeps.getChannels,
    ffmpegPath: injectedDeps.ffmpegPath || '/usr/bin/ffmpeg',
    outputWidth: injectedDeps.outputWidth || 854,
    outputHeight: injectedDeps.outputHeight || 480,
  };
  try { fs.mkdirSync(PLAYLIST_BASE, { recursive: true }); } catch {}
  try { fs.mkdirSync(HLS_BASE, { recursive: true }); } catch {}
}

function start() {
  if (started) return;
  started = true;
  const channels = deps.getChannels() || [];
  console.log(`[PlayoutEngine] Starting — ${channels.length} channels`);

  // Build playlists so each channel knows where it is in its schedule,
  // but do not spawn ffmpeg. A channel is started when someone actually
  // requests it (streamforge.js lazy-start on /sf/hls/:id/index.m3u8),
  // and wall-clock anchoring means tuning in mid-programme still lands
  // at the right offset.
  //
  // Set ORION_PLAYOUT_EAGER=1 to restore the old always-running behaviour.
  const EAGER = process.env.ORION_PLAYOUT_EAGER === '1';

  channels.forEach((ch, i) => {
    if (ch.liveStreamId) return; // skip live IPTV — handled elsewhere
    setTimeout(() => {
      try {
        regeneratePlaylist(ch);
        if (EAGER) startChannelStream(ch);
      } catch (err) {
        console.error(`[PlayoutEngine] Failed to prepare "${ch.name}":`, err.message);
      }
    }, 500 + i * 50);
  });

  console.log('[PlayoutEngine] ' +
    (EAGER ? 'eager mode — starting all channels'
           : 'on-demand mode — channels start when tuned in'));

  // Periodic playlist refresh
  setInterval(() => {
    for (const ch of (deps.getChannels() || [])) {
      if (ch.liveStreamId) continue;
      const playlist = playlists.get(ch.id);
      const stream = streams.get(ch.id);
      if (!playlist) {
        regeneratePlaylist(ch);
        continue;
      }
      // If stream is running and consumed > half the playlist, regenerate ahead
      if (stream) {
        const elapsedMs = Date.now() - stream.startedAt;
        if (elapsedMs > playlist.durationMs / 2) {
          regeneratePlaylist(ch);
        }
      }
    }
  }, REFRESH_INTERVAL_MS);
}

// ──────────────────────────────────────────────────────────────────────────────
// PLAYLIST GENERATION
// ──────────────────────────────────────────────────────────────────────────────

function buildPlaylistItems(ch) {
  if (!deps) throw new Error('PlayoutEngine not initialized — call init() first');
  let items = [];
  const targetSeconds = PLAYLIST_HOURS * 3600;
  let totalSeconds = 0;

  const tryPush = (mediaId, fallbackItem, durationOverride) => {
    let item = mediaId ? deps.getMediaById(mediaId) : fallbackItem;
    if (!item) item = fallbackItem;
    if (!item || !item.path) return false;
    try { fs.accessSync(item.path); } catch { return false; }
    const duration = durationOverride || item.duration || 1800;
    items.push({
      mediaId: item.id || mediaId,
      filePath: item.path,
      title: item.title || item.seriesTitle || path.basename(item.path),
      duration,
      season: item.season,
      episode: item.episode,
      seriesTitle: item.seriesTitle,
      thumb: item.thumb,
      summary: item.summary,
    });
    totalSeconds += duration;
    return true;
  };

  // ── timeBlocks (chained shift-scheduling) [PATCHED v3] ──
  let _tbHandled = false;
  if (Array.isArray(ch.timeBlocks) && ch.timeBlocks.length) {
    const _now = new Date();
    const _hhmm = String(_now.getHours()).padStart(2,'0') + ':' + String(_now.getMinutes()).padStart(2,'0');
    const _today = ['sun','mon','tue','wed','thu','fri','sat'][_now.getDay()];
    const _todayKey = _now.getFullYear() + '-' + String(_now.getMonth()+1).padStart(2,'0') + '-' + String(_now.getDate()).padStart(2,'0');
    const _shiftMin = Number(ch.shiftWindowMin) || 30;

    if (!globalThis._orionFiredBlocks) globalThis._orionFiredBlocks = new Map();
    const _firedKey = (idx) => ch.id + '|' + idx;
    const _notFired = (idx) => globalThis._orionFiredBlocks.get(_firedKey(idx)) !== _todayKey;
    const _markFired = (idx) => globalThis._orionFiredBlocks.set(_firedKey(idx), _todayKey);

    const _dayValid = (tb) => {
      if (!tb || !tb.start || !tb.showTitle) return false;
      const days = String(tb.daysOfWeek || 'daily').toLowerCase();
      if (days === 'weekdays' && (_today === 'sat' || _today === 'sun')) return false;
      if (days === 'weekends' && !(_today === 'sat' || _today === 'sun')) return false;
      if (days !== 'daily' && days !== 'weekdays' && days !== 'weekends') {
        const allowed = days.split(/[,\s]+/).map(d => d.trim());
        if (!allowed.includes(_today)) return false;
      }
      return true;
    };

    const _todayBlocks = ch.timeBlocks
      .map((tb, idx) => Object.assign({}, tb, { _idx: idx }))
      .filter(_dayValid);

    // 1) Active block: now within [start,end) and not fired today
    let _selected = _todayBlocks.find(tb =>
      tb.start <= _hhmm && _hhmm < (tb.end || '23:59') && _notFired(tb._idx)
    );

    // 2) Shift-left: no active block, but next upcoming is within shiftWindowMin
    if (!_selected) {
      const _lookAhead = new Date(_now.getTime() + _shiftMin * 60000);
      const _crossesMidnight = _lookAhead.getDate() !== _now.getDate();
      if (!_crossesMidnight) {
        const _lookHHMM = String(_lookAhead.getHours()).padStart(2,'0') + ':' + String(_lookAhead.getMinutes()).padStart(2,'0');
        const _upcoming = _todayBlocks
          .filter(tb => tb.start > _hhmm && tb.start <= _lookHHMM && _notFired(tb._idx))
          .sort((a, b) => a.start.localeCompare(b.start));
        if (_upcoming.length) {
          _selected = _upcoming[0];
          console.log('[PlayoutEngine] timeBlock shift-left: starting "' + _selected.showTitle + '" at ' + _hhmm + ' (scheduled ' + _selected.start + ')');
        }
      }
    }

    if (_selected) {
      const _showNorm = (_selected.showTitle || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const _eps = deps.getMediaCombined()
        .filter(m => m.type !== 'movie' && m.season != null && m.episode != null)
        .filter(m => {
          const t = (m.seriesTitle || m.showName || m.title || m.filename || '').toLowerCase().replace(/[^a-z0-9]/g, '');
          return t === _showNorm || t.startsWith(_showNorm);
        })
        .sort((a, b) => (a.season - b.season) || (a.episode - b.episode));

      if (_eps.length) {
        // Pick episode by day-of-year so it advances daily
        const _yearStart = new Date(_now.getFullYear(), 0, 0);
        const _dayOfYear = Math.floor((_now - _yearStart) / 86400000);
        const _epIdx = _dayOfYear % _eps.length;
        const _ep = _eps[_epIdx];
        console.log('[PlayoutEngine] timeBlock fire: "' + _selected.showTitle + '" S' + _ep.season + 'E' + _ep.episode + ' (single ep, ' + Math.round(_ep.duration || 1800) + 's)');
        tryPush(_ep.id, _ep, _ep.duration || 1800);
        _markFired(_selected._idx);
        _tbHandled = true;
      } else {
        console.warn('[PlayoutEngine] timeBlock show "' + _selected.showTitle + '" has no episodes in library');
      }
    }
  }
  // ── seriesSchedule (interleaved show-rotation) [PATCHED v4] ──
  if (!_tbHandled && ch.seriesSchedule?.episodes?.length) {
    let eps = ch.seriesSchedule.episodes.slice();
    const _showTitlesArr = Array.isArray(ch.seriesSchedule.showTitles)
      ? ch.seriesSchedule.showTitles
      : (ch.seriesSchedule.showTitle ? [ch.seriesSchedule.showTitle] : []);
    const _norm = (x) => (x||'').toLowerCase().replace(/[^a-z0-9]/g, '');

    if (_showTitlesArr.length > 0) {
      const targets = _showTitlesArr.map(_norm);
      const all = deps.getMediaCombined().filter(m => {
        if (m.season == null || m.episode == null) return false;
        const t = _norm(m.seriesTitle || m.showName || m.title || m.filename);
        return targets.some(target => t === target || t.startsWith(target));
      });
      // [PATCHED v10] Try every possible filePath field name
      if (all.length > 0) {
        eps = all.map(m => ({
          mediaId: m.id, season: m.season, episode: m.episode,
          duration: m.duration || 1800, title: 'S'+m.season+'E'+m.episode,
          _show: _norm(m.seriesTitle || m.showName || m.title || m.filename),
          _filePath: m.filePath || m.file_path || m.path || m.fullPath || m.file || m.location || null
        }));
        console.log('[PlayoutEngine] seriesSchedule v10 rebuilt [' + _showTitlesArr.join(', ') + '] -> ' + eps.length + ' episodes; first item keys: ' + (all[0] ? Object.keys(all[0]).slice(0,30).join(',') : 'none'));
      }
    }

    // [PATCHED v4] Interleaved seeded shuffle prevents S01E01 clustering.
    // Each show's eps shuffled with day-of-year seed (stable within day, varies daily).
    // Then round-robin across shows. Single-show channels stay sequential.
    if (eps.length > 1) {
      for (const ep of eps) {
        if (!ep._show) {
          const m = deps.getMediaById(ep.mediaId);
          ep._show = m ? _norm(m.seriesTitle || m.showName || m.title || m.filename) : 'unknown';
        }
      }
      const _byShow = new Map();
      for (const ep of eps) {
        const k = ep._show || 'unknown';
        if (!_byShow.has(k)) _byShow.set(k, []);
        _byShow.get(k).push(ep);
      }
      if (_byShow.size === 1) {
        eps = Array.from(_byShow.values())[0].sort((a,b) => (a.season - b.season) || (a.episode - b.episode));
      } else {
        // Use timestamp-based seed so each rebuild gets a different order
        const _chHash = String(ch.id || '').split('').reduce((a,c) => ((a*31 + c.charCodeAt(0)) | 0), 0);
        const _baseSeed = (((Date.now() / 1000) | 0) ^ _chHash) >>> 0;

        const _seedShuffle = (arr, seed) => {
          const a = arr.slice();
          let t = seed >>> 0;
          const rng = () => {
            t = (t + 0x6D2B79F5) | 0;
            let r = Math.imul(t ^ (t >>> 15), 1 | t);
            r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
            return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
          };
          for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(rng() * (i + 1));
            const tmp = a[i]; a[i] = a[j]; a[j] = tmp;
          }
          return a;
        };

        let _si = 0;
        const _shows = [];
        for (const list of _byShow.values()) {
          _shows.push(_seedShuffle(list, _baseSeed + (_si++ * 7919)));
        }
        const _shows2 = _seedShuffle(_shows, _baseSeed + 31337);
        const _maxLen = _shows2.reduce((m, s) => Math.max(m, s.length), 0);
        const _result = [];
        for (let i = 0; i < _maxLen; i++) {
          for (const showEps of _shows2) {
            if (i < showEps.length) _result.push(showEps[i]);
          }
        }
        eps = _result;
        console.log('[PlayoutEngine] seriesSchedule interleaved: ' + _shows2.length + ' shows, ' + eps.length + ' eps, seed=' + _baseSeed);
      }
    }

    // [PATCHED v8] STRICT one-ep-per-show: dedup by file parent folder, uses ep._filePath directly
    const _seenFolders = new Set();
    const _onePerShow = [];
    const _getShowFolder = (path) => {
      if (!path) return null;
      const m = path.match(/\/tv_shows\/([^/]+)/);
      if (m) return m[1].toLowerCase();
      const mv = path.match(/\/movies\/([^/]+)/);
      if (mv) return mv[1].toLowerCase();
      return null;
    };
    for (const ep of eps) {
      const path = ep._filePath;
      if (!path) continue;
      const folder = _getShowFolder(path);
      if (!folder) continue;
      if (_seenFolders.has(folder)) continue;
      _seenFolders.add(folder);
      _onePerShow.push(ep);
    }
    console.log('[PlayoutEngine] v8 one-ep-per-show (by folder): ' + _onePerShow.length + ' unique folders');
    for (const ep of _onePerShow) {
      // Synthesize a minimal item object so tryPush works without DB lookup
      const item = { id: ep.mediaId, filePath: ep._filePath, duration: ep.duration };
      tryPush(ep.mediaId, item, ep.duration);
    }
  }
    // ── libraryLoop (everything in a library, sorted or shuffled) ──
  else if (!_tbHandled && ch.libraryLoop?.libraryId && !ch.playout?.length && !(ch.genreLoops?.length || ch.genreLoop)) {
    let libItems = deps.getMediaCombined().filter(m => m.libraryId === ch.libraryLoop.libraryId);
    if (!libItems.length) {
      console.warn(`[PlayoutEngine] libraryLoop empty for "${ch.name}"`);
      return items;
    }
    if (ch.libraryLoop.shuffle) {
      libItems = libItems.slice().sort(() => Math.random() - 0.5);
    } else {
      libItems = libItems.slice().sort((a, b) => {
        if (a.season != null && b.season != null) {
          if (a.season !== b.season) return a.season - b.season;
          return (a.episode || 0) - (b.episode || 0);
        }
        return (a.title || '').localeCompare(b.title || '');
      });
    }
    let i = 0;
    const safety = libItems.length * 50;
    while (totalSeconds < targetSeconds && i < safety) {
      tryPush(libItems[i % libItems.length].id, libItems[i % libItems.length]);
      i++;
    }
  }
  // ── playout (explicit ordered list) ──
  else if (!_tbHandled && ch.playout?.length) {
    let i = 0;
    const safety = ch.playout.length * 50;
    while (totalSeconds < targetSeconds && i < safety) {
      const block = ch.playout[i % ch.playout.length];
      if (block.streamId) { i++; continue; }
      let item = deps.getMediaById(block.mediaId);
      if (!item && block.title) {
        const _t = String(block.title);
        const _sem = _t.match(/[Ss](\d+)[Ee](\d+)/);
        const showName = _t.toLowerCase().replace(/\s*s\d+e\d+.*$/i, '').trim();
        if (showName) {
          // First try matching by show + specific season/episode
          if (_sem) {
            const _s = parseInt(_sem[1]), _e = parseInt(_sem[2]);
            item = deps.getMediaCombined().find(m => {
              if ((m.season || m.seasonNum) !== _s) return false;
              if ((m.episode || m.episodeNum) !== _e) return false;
              const mt = String(m.title || m.seriesTitle || m.showName || m.filename || '').toLowerCase();
              return mt.includes(showName);
            });
          }
          // Fallback to first show match (legacy)
          if (!item) {
            item = deps.getMediaCombined().find(m => {
              const mt = String(m.title || m.seriesTitle || m.filename || '').toLowerCase();
              return mt.includes(showName);
            });
          }
        }
      }
      if (item) tryPush(item.id, item, block.duration);
      i++;
    }
  }
  // ── genreLoops (shuffle within genres) ──
  else if (!_tbHandled && (ch.genreLoops?.length || ch.genreLoop)) {
    const wantedGenres = (ch.genreLoops || [ch.genreLoop]).map(g => String(g && g.genre ? g.genre : g).toLowerCase());
    const matched = deps.getMediaCombined().filter(m => {
      const itemGenres = (m.genres || []).map(g => String(g).toLowerCase());
      return wantedGenres.some(g => itemGenres.includes(g));
    });
    if (!matched.length) {
      console.warn(`[PlayoutEngine] genreLoops matched nothing for "${ch.name}"`);
      return items;
    }
    const sorted = matched.slice().sort(() => Math.random() - 0.5);
    let i = 0;
    const safety = sorted.length * 50;
    while (totalSeconds < targetSeconds && i < safety) {
      tryPush(sorted[i % sorted.length].id, sorted[i % sorted.length]);
      i++;
    }
  }

  return items;
}

// Playlists regenerate frequently and these paths are on NFS, so cache
// the answer briefly rather than stat-ing the same file repeatedly. Short
// TTL means a file that comes back is picked up on the next cycle.
const _existsCache = new Map();
const _missingWarned = new Set();   // log each missing path once, not every cycle
const _EXISTS_TTL = 60000;

function _fileUsable(p) {
  if (!p) return false;
  if (/^https?:\/\//i.test(p)) return true;   // remote source, nothing to stat
  const hit = _existsCache.get(p);
  const now = Date.now();
  if (hit && now - hit.at < _EXISTS_TTL) return hit.ok;
  let ok = false;
  try { ok = fs.existsSync(p); } catch (_) { ok = false; }
  _existsCache.set(p, { ok, at: now });
  if (_existsCache.size > 50000) _existsCache.clear();
  return ok;
}

function regeneratePlaylist(ch) {
  if (ch.liveStreamId) return;
  let items;
  let fromSchedule = false;  // [LOCKSTEP] track if items came from persistent schedule
  if (ch.scheduledPrograms && Array.isArray(ch.scheduledPrograms) && ch.scheduledPrograms.length) {
    const now = Date.now();
    const future = ch.scheduledPrograms.filter(p => p.end > now);
    items = [];
    // [PATCHED] Dual-key lookup:
    //   Primary: mediaId (UUID) — exact file
    //   Secondary: (seriesTitle, season, episode) — logical episode, survives re-imports
    const _norm = v => String(v||'').toLowerCase().replace(/[^a-z0-9]/g,'');
    const mediaById = new Map();
    const mediaBySeriesEp = new Map();
    try {
      const allMedia = deps.getMediaCombined ? deps.getMediaCombined() : [];
      for (const m of allMedia) {
        if (m.id) mediaById.set(m.id, m);
        if (m.seriesTitle && m.season != null && m.episode != null) {
          const k = _norm(m.seriesTitle) + '|' + m.season + '|' + m.episode;
          if (!mediaBySeriesEp.has(k)) mediaBySeriesEp.set(k, m);
        }
      }
    } catch {}
    let primaryHits = 0, secondaryHits = 0, fallbackHits = 0, missed = 0;
    for (const p of future) {
      let m = null;
      if (p.mediaId && mediaById.has(p.mediaId)) { m = mediaById.get(p.mediaId); primaryHits++; }
      if (!m && p.seriesTitle && p.season != null && p.episode != null) {
        const k = _norm(p.seriesTitle) + '|' + p.season + '|' + p.episode;
        if (mediaBySeriesEp.has(k)) { m = mediaBySeriesEp.get(k); secondaryHits++; }
      }
      const fp = (m && (m.path || m.filePath)) || p.filePath;
      if (!m && fp) fallbackHits++;
      if (!fp) { missed++; continue; }

      // The fallback above can hand back a path from whenever this
      // schedule was built. If the file is not there, skip the item —
      // putting it in the playlist only produces an ffmpeg exit 254 and
      // a channel that restarts forever.
      if (!_fileUsable(fp)) {
        missed++;
        if (!_missingWarned.has(fp)) {
          _missingWarned.add(fp);
          console.warn('[PlayoutEngine] skipping missing file for "' +
            ch.name + '": ' + fp);
        }
        continue;
      }
      items.push({
        id: p.mediaId,
        filePath: fp,
        _filePath: fp,
        duration: p.duration || 1800,
        seriesTitle: p.seriesTitle,
        season: p.season,
        episode: p.episode,
        title: p.title,
        episodeTitle: p.episodeTitle,
        summary: p.desc,
        thumb: p.icon,
        _scheduledStart: p.start,
        _scheduledEnd: p.end,
      });
    }
    if (items.length) {
      fromSchedule = true;  // [LOCKSTEP] items came from scheduledPrograms — DO NOT reorder
      console.log('[PlayoutEngine] ' + ch.name + ': loaded ' + items.length + ' items (primary=' + primaryHits + ', secondary=' + secondaryHits + ', fallback=' + fallbackHits + ', missed=' + missed + ') [LOCKSTEP]');
    } else {
      items = buildPlaylistItems(ch);
    }
  } else {
    items = buildPlaylistItems(ch);
  }
  // [PATCHED] Daily shuffle - rotates show times day-to-day to prevent same-time repetition
  // [LOCKSTEP] Skip when items came from scheduledPrograms — EPG would drift
  if (!fromSchedule && ch.dailyShuffle) items = _dailyShuffleItems(items, ch.id);
  if (!items.length) { console.warn('[PlayoutEngine] No items'); return null; }
  // [PATCHED no-backback] Defensive: kill any back-to-back same-show pairs across the entire playlist.
  // Works by file path — independent of metadata bugs / dedup logic upstream.
  // [LOCKSTEP] Skip when items came from scheduledPrograms — schedule generator already deduped
  if (!fromSchedule) (function killBackToBack() {
    const _showOf = (it) => {
      if (!it || !it.filePath) return null;
      const m = String(it.filePath).match(/\/tv_shows\/([^/]+)/i);
      return m ? m[1].toLowerCase() : null;
    };
    let swaps = 0, passes = 0;
    while (passes < 3) {  // up to 3 passes for stubborn pairs
      let madeSwap = false;
      for (let i = 1; i < items.length; i++) {
        const a = _showOf(items[i-1]);
        const b = _showOf(items[i]);
        if (!a || !b || a !== b) continue;
        // find a swap partner further in the list that doesn't create a new conflict
        let swapIdx = -1;
        for (let j = i + 1; j < items.length; j++) {
          const sj = _showOf(items[j]);
          if (!sj || sj === a) continue;
          const prevJ = _showOf(items[j-1]);
          const nextJ = j+1 < items.length ? _showOf(items[j+1]) : null;
          // moving items[j] into position i: check it doesn't equal items[i-1] (a) — already does
          // also check that items[i+1] won't equal sj
          const nextI = i+1 < items.length ? _showOf(items[i+1]) : null;
          if (nextI === sj) continue;
          // and check that the gap left at j won't create back-to-back (prevJ vs nextJ)
          if (prevJ && nextJ && prevJ === nextJ) continue;
          // and that items[i] (currently same as a) moved to j doesn't equal prevJ or nextJ
          if (a === prevJ || a === nextJ) continue;
          swapIdx = j; break;
        }
        // backward swap if forward failed
        if (swapIdx < 0) {
          for (let j = i - 2; j >= 0; j--) {
            const sj = _showOf(items[j]);
            if (!sj || sj === a) continue;
            const prevJ = j > 0 ? _showOf(items[j-1]) : null;
            const nextJ = _showOf(items[j+1]);
            if (prevJ === sj) continue;
            if (a === prevJ || a === nextJ) continue;
            swapIdx = j; break;
          }
        }
        if (swapIdx >= 0) {
          const tmp = items[i]; items[i] = items[swapIdx]; items[swapIdx] = tmp;
          swaps++; madeSwap = true;
        }
      }
      // wrap-around: last vs first
      if (items.length >= 3) {
        const last = _showOf(items[items.length-1]);
        const first = _showOf(items[0]);
        if (last && first && last === first) {
          for (let j = items.length - 2; j > 0; j--) {
            const sj = _showOf(items[j]);
            if (!sj || sj === last) continue;
            const tmp = items[items.length-1]; items[items.length-1] = items[j]; items[j] = tmp;
            swaps++; madeSwap = true;
            break;
          }
        }
      }
      if (!madeSwap) break;
      passes++;
    }
    if (swaps > 0) console.log('[PlayoutEngine] ' + ch.name + ': back-to-back killed (' + swaps + ' swaps, ' + (passes+1) + ' passes)');
  })();
  // [RESUME-FIX] First try absolute wall-clock lookup against items' scheduledStart/End windows.
  // This survives orion restarts because scheduledPrograms persists in channels.json with the
  // original start times — we just need to find which item's window contains "now".
  let idx = 0, ip = 0;
  const _now = Date.now();
  let _foundByTime = false;
  if (items[0] && items[0]._scheduledStart && items[0]._scheduledEnd) {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it._scheduledStart && it._scheduledEnd && _now >= it._scheduledStart && _now < it._scheduledEnd) {
        idx = i;
        ip = Math.max(0, Math.floor((_now - it._scheduledStart) / 1000));
        _foundByTime = true;
        console.log('[PlayoutEngine] ' + ch.name + ': [RESUME] idx=' + idx + ' ip=' + ip + 's into "' + (it.title || '?').slice(0,40) + '"');
        break;
      }
    }
  }
  // Fallback: legacy loop-based math (when items lack scheduledStart, or schedule has aged out)
  if (!_foundByTime) {
    const anchor = (items[0] && items[0]._scheduledStart) ? items[0]._scheduledStart : (ch.playoutStart ? new Date(ch.playoutStart).getTime() : new Date(new Date().toISOString().slice(0,10)+'T00:00:00Z').getTime());
    const total = items.reduce(function(a,b){return a+b.duration;}, 0);
    const elapsed = Math.floor((Date.now()-anchor)/1000);
    const inLoop = ((elapsed%total)+total)%total;
    let cur=0;
    for (let i=0;i<items.length;i++) { if(cur+items[i].duration>inLoop){idx=i;ip=inLoop-cur;break;} cur+=items[i].duration; }
    console.log('[PlayoutEngine] ' + ch.name + ': [RESUME-FALLBACK] idx=' + idx + ' ip=' + ip + 's (loop math)');
  }
  // libraryLoop: metadata duration unreliable, skip wallclock seek and start at top
  // [PATCHED] wallclock seek RE-ENABLED — keep idx/ip from calculation above
  // [PATCHED] Probe first file: clamp ip if it exceeds actual duration OR if source is HEVC (NVDEC seek artifacts)
  try {
    const _probe = require('child_process').execSync(
      'ffprobe -v error -select_streams v:0 -show_entries stream=codec_name:format=duration -of default=nw=1:nk=1 ' + JSON.stringify(items[idx].filePath),
      { timeout: 3000 }
    ).toString().trim().split('\n');
    const _codec = (_probe[0] || '').trim();
    const _realDur = parseFloat((_probe[1] || '0').trim());
    if (_realDur > 0 && ip > _realDur - 30) {
      console.log('[PlayoutEngine] ' + ch.name + ': ip=' + ip + 's exceeds actual ' + _realDur + 's — using 0');
      ip = 0;
    }
    // [RESUME-FIX3] HEVC inpoint-zeroing removed entirely.
    // Trade-off: HEVC seek may show 1-2s of visual artifacts; in return channels actually resume.
  } catch (e) {}
  const ord=[Object.assign({},items[idx],{inpoint:ip})].concat(items.slice(idx+1)).concat(items.slice(0,idx));
  const file=path.join(PLAYLIST_BASE, ch.id+'.txt');
  const out=[];

  // [LOCKSTEP-PRESEG] Load preseg registry, build mediaId/filePath -> hlsDir index
  let _presegIdx = {};
  try {
    const _presegData = JSON.parse(fs.readFileSync('/var/lib/orion/sf/preseg.json', 'utf8'));
    for (const [pk, pv] of Object.entries(_presegData)) {
      if (pv && pv.status === 'done' && pv.hlsDir && pv.filePath) {
        try { fs.accessSync(pv.hlsDir); _presegIdx[pk] = pv.hlsDir; _presegIdx[pv.filePath] = pv.hlsDir; } catch {}
      }
    }
  } catch {}

  let _presegHits = 0, _presegMisses = 0;
  let _allPreseg = true;
  for (const it of ord) {
    const _hlsDir = _presegIdx[it.mediaId] || _presegIdx[it.filePath] || _presegIdx[it._filePath];
    if (_hlsDir) {
      try {
        const _m3u8 = fs.readFileSync(path.join(_hlsDir, 'index.m3u8'), 'utf8');
        // Parse #EXTINF durations so we can skip segments to honor inpoint
        const _lines = _m3u8.split('\n').map(l => l.trim());
        const _tsList = [];  // [{file, duration}]
        let _pendingDur = 0;
        for (const _l of _lines) {
          if (_l.startsWith('#EXTINF:')) {
            const _m = _l.match(/#EXTINF:([\d.]+)/);
            _pendingDur = _m ? parseFloat(_m[1]) : 2;
          } else if (_l && !_l.startsWith('#')) {
            _tsList.push({file: _l, duration: _pendingDur || 2});
            _pendingDur = 0;
          }
        }
        // [RESUME-FIX2] If this is the FIRST item (current playback position), skip segments to honor inpoint
        let _skipped = 0;
        const _wantSkip = (it.inpoint || 0);
        let _accumulated = 0;
        let _startIdx = 0;
        if (_wantSkip > 0) {
          for (let i = 0; i < _tsList.length; i++) {
            if (_accumulated + _tsList[i].duration > _wantSkip) { _startIdx = i; break; }
            _accumulated += _tsList[i].duration;
          }
          _skipped = _startIdx;
        }
        for (let i = _startIdx; i < _tsList.length; i++) {
          const _full = path.join(_hlsDir, _tsList[i].file);
          out.push("file '" + _full.replace(/'/g, "'\\''") + "'");
        }
        if (_skipped > 0) console.log('[PlayoutEngine] ' + ch.name + ': preseg resumed at segment ' + _skipped + ' (skipped ' + Math.round(_accumulated) + 's)');
        _presegHits++;
        continue;
      } catch (e) {}
    }
    // Fallback: source file (no preseg) — needs GPU encode
    _allPreseg = false;
    _presegMisses++;
    out.push("file '" + it.filePath.replace(/'/g, "'\\''") + "'");
    if (it.inpoint > 0) out.push('inpoint ' + it.inpoint);
  }
  fs.writeFileSync(file, out.join('\n')+'\n');
  console.log('[PlayoutEngine] ' + ch.name + ': preseg ' + _presegHits + '/' + ord.length + ' items (allPreseg=' + _allPreseg + ')');

  ord[0]._effectiveDuration=Math.max(1,ord[0].duration-(ord[0].inpoint||0));
  for (let i=1;i<ord.length;i++) ord[i]._effectiveDuration=ord[i].duration;
  const durationMs=ord.reduce(function(a,b){return a+(b._effectiveDuration||b.duration)*1000;},0);
  playlists.set(ch.id, {items:ord, generatedAt:Date.now(), durationMs, file, useCopyMode: _allPreseg});
  console.log('[PlayoutEngine] '+ch.name+' wall-clock anchored');
  return items;
}

// ──────────────────────────────────────────────────────────────────────────────
// STREAM MANAGEMENT
// ──────────────────────────────────────────────────────────────────────────────

function startChannelStream(ch) {
  if (ch.liveStreamId) return null; // live IPTV handled by streamforge.js

  // Aliveness check: if existing stream is still running, reuse it
  const existing = streams.get(ch.id);
  if (existing && existing.proc && existing.proc.pid) {
    try {
      process.kill(existing.proc.pid, 0); // signal 0 = liveness probe
      return existing;
    } catch { streams.delete(ch.id); }
  }

  // Orphan cleanup: kill any zombie ffmpegs still writing to this channel's hls dir
  try {
    execSync(`pkill -9 -f "/var/lib/orion/sf/hls/${ch.id}/" 2>/dev/null || true`, { timeout: 1000 });
  } catch {}

  // Ensure we have a playlist
  if (!playlists.has(ch.id)) regeneratePlaylist(ch);
  const playlist = playlists.get(ch.id);
  if (!playlist || !playlist.items.length) {
    console.warn(`[PlayoutEngine] Cannot start "${ch.name}" — no playable items`);
    return null;
  }

  // [PRESEG-DIRECT] zero-ffmpeg serve when channel is opted-in and fully pre-segmented
  if (ch.presegDirect) {
    try {
      const _pd = require('./preseg-direct');
      const _vs = _pd.startVirtual({
        ch, playlist,
        hlsDir: path.join(HLS_BASE, ch.id),
        regenerate: () => { try { regeneratePlaylist(ch); } catch {} return playlists.get(ch.id); },
      });
      if (_vs) {
        streams.set(ch.id, _vs);
        console.log(`[PlayoutEngine] Starting "${ch.name}" [PRESEG-DIRECT zero-ffmpeg] — ${playlist.items.length} items queued`);
        return _vs;
      }
      console.warn(`[PlayoutEngine] "${ch.name}" presegDirect set but not fully pre-segmented — using ffmpeg`);
    } catch (e) {
      console.error(`[PlayoutEngine] preseg-direct error for "${ch.name}": ${e.message} — using ffmpeg`);
    }
  }

  // Prepare HLS directory
  const hlsDir = path.join(HLS_BASE, ch.id);
  try { fs.mkdirSync(hlsDir, { recursive: true }); } catch {}
  try {
    fs.readdirSync(hlsDir)
      .filter(f => ['ts', 'm3u8', 'm4s'].includes(f.split('.').pop()))
      .forEach(f => { try { fs.unlinkSync(path.join(hlsDir, f)); } catch {} });
  } catch {}

  const _gpuId = _gpuForChannel(ch.id);
  let _firstFile = null;
  try { const fc = fs.readFileSync(playlist.file, 'utf8'); const m = fc.match(/^file '(.+)'$/m); _firstFile = m && m[1]; } catch {}
  const _codec = _firstFile ? _detectCodecSync(_firstFile) : 'unknown';
  // [LOCKSTEP-PRESEG-H264] Stream-copy when: all items pre-segmented OR source is h264 (TS-compatible, no GPU needed)
  const _useCopyMode = (playlist.useCopyMode === true) || (_codec === 'h264');
  const _useHwaccel = !_useCopyMode && ['hevc','mpeg2video','mpeg4','vc1','vp8','unknown'].includes(_codec);
  const W = deps.outputWidth;
  const H = deps.outputHeight;
  const args = _useCopyMode ? [
    '-hide_banner', '-loglevel', 'warning',
    '-fflags', '+genpts+discardcorrupt',
    '-err_detect', 'ignore_err',
    '-re',
    '-f', 'concat', '-safe', '0',
    '-i', playlist.file,
    '-map', '0:v:0?', '-map', '0:a:0?',
    '-c', 'copy',
    '-avoid_negative_ts', 'make_zero',
    '-f', 'hls',
    '-hls_time', '1',
    '-hls_list_size', '30',
    '-hls_flags', 'delete_segments+append_list+independent_segments+omit_endlist',
    '-hls_segment_type', 'mpegts',
    '-hls_allow_cache', '0',
    '-flush_packets', '1',
    '-hls_segment_filename', path.join(hlsDir, 'seg%05d.ts'),
    path.join(hlsDir, 'index.m3u8'),
  ] : [
    '-hide_banner', '-loglevel', 'warning',
    '-threads', '2',  // [PATCHED cpufix] cap per-process threads
    '-fflags', '+genpts+discardcorrupt',
    '-err_detect', 'ignore_err',
    // GPU decode; frames auto-download for CPU filter
    ...(_useHwaccel ? ['-hwaccel', 'cuda', '-hwaccel_device', String(_gpuId), '-hwaccel_output_format', 'cuda'] : []),
    '-re',                        // read input at native frame rate
    '-f', 'concat', '-safe', '0', // concat demuxer accepts any path
    '-i', playlist.file,
    '-map', '0:v:0?',
    '-map', '0:a:0?', '-af', 'aresample=async=1000',
    '-vf', _useHwaccel ? `scale_cuda='min(${W},iw)':'min(${H},ih)':force_original_aspect_ratio=decrease:format=yuv420p` : `scale='min(${W},iw)':'min(${H},ih)':force_original_aspect_ratio=decrease,format=yuv420p`,
    '-vcodec', 'h264_nvenc', '-gpu', String(_gpuId),
    '-preset', 'p1', '-rc:v', 'vbr', '-cq:v', '23',
    '-b:v', '4M', '-maxrate:v', '8M', '-bufsize:v', '8M',
    '-g', '30', '-keyint_min', '30', '-sc_threshold', '0',
    '-force_key_frames', 'expr:gte(t,n_forced*1)',
    '-acodec', 'aac', '-b:a', '192k', '-ac', '2', '-ar', '48000',
    '-avoid_negative_ts', 'make_zero',
    '-f', 'hls',
    '-hls_time', '1',
    '-hls_list_size', '30',
    '-hls_flags', 'delete_segments+append_list+independent_segments+omit_endlist',
    '-hls_segment_type', 'mpegts',
    '-hls_allow_cache', '0',
    '-flush_packets', '1',
    '-hls_segment_filename', path.join(hlsDir, 'seg%05d.ts'),
    path.join(hlsDir, 'index.m3u8'),
  ];

  console.log(`[PlayoutEngine] Starting "${ch.name}" ${_useCopyMode ? '[STREAM-COPY no GPU]' : `on GPU ${_gpuId} [${_codec}/${_useHwaccel ? "nvdec" : "cpu"}]`} — ${playlist.items.length} items queued`);
  const proc = spawn(deps.ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  const stream = { proc, startedAt: Date.now(), channelId: ch.id, restarts: 0, gpuId: _gpuId };
  // [PATCHED] Reserve GPU slot for load balancer
  _playoutGpuLoad[_gpuId] = (_playoutGpuLoad[_gpuId] || 0) + 1;
  streams.set(ch.id, stream);

  // Capture stderr for diagnostics; only log lines that look like errors
  let buf = '';
  proc.stderr.on('data', d => {
    const line = d.toString();
    buf += line;
    if (buf.length > 10000) buf = buf.slice(-5000);
    for (const part of line.split('\n')) {
      if (part.match(/error|invalid|no such|failed|cannot/i)) {
        console.error(`[PlayoutEngine/${ch.name}] ${part.trim().slice(0, 250)}`);
      }
    }
  });

  proc.on('exit', (code, signal) => {
    const uptime = Date.now() - stream.startedAt;
    console.log(`[PlayoutEngine] "${ch.name}" exited code=${code} signal=${signal} uptime=${Math.round(uptime/1000)}s gpu=${stream.gpuId}`);
    streams.delete(ch.id);
    // [PATCHED] Release GPU slot
    if (typeof stream.gpuId === 'number' && _playoutGpuLoad[stream.gpuId] > 0) _playoutGpuLoad[stream.gpuId]--;

    // Backoff: if it crashed within 5 seconds, wait longer; otherwise short delay
    let delay;
    if (uptime < 5000) {
      stream.restarts++;
      delay = Math.min(2000 * Math.pow(3, Math.min(stream.restarts, 5)), 300000);
      // Quick crashes — regenerate playlist in case content changed
      try { regeneratePlaylist(ch); } catch {}
    } else {
      stream.restarts = 0;
      delay = 2000;
      // Natural end of playlist — extend it
      try { regeneratePlaylist(ch); } catch {}
    }
    setTimeout(() => {
      // Re-fetch fresh channel state in case config changed
      const stillCh = (deps.getChannels() || []).find(c => c.id === ch.id);
      if (stillCh && !streams.has(ch.id)) startChannelStream(stillCh);
    }, delay);
  });

  return stream;
}

function stopChannelStream(channelId) {
  const stream = streams.get(channelId);
  if (stream) {
    try { stream.proc.kill('SIGTERM'); } catch {}
    streams.delete(channelId);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// QUERIES (fast — read from cache, NEVER computes)
// ──────────────────────────────────────────────────────────────────────────────

function getNowPlaying(channelId) {
  if (!deps) return null;
  const ch = (deps.getChannels() || []).find(c => c.id === channelId);
  if (!ch) return null;

  // Live IPTV
  if (ch.liveStreamId) {
    const s = deps.getSfStream(ch.liveStreamId);
    if (!s) return null;
    return {
      item: null,
      stream: s,
      block: { streamId: ch.liveStreamId },
      offsetSeconds: 0,
      startTime: Date.now(),
      endTime: Date.now() + 86400000,
      isLive: true,
      title: s.name,
    };
  }

  const stream = streams.get(channelId);
  const playlist = playlists.get(channelId);
  if (!stream || !playlist) return null;

  // Compute current position by elapsed time since stream start
  const elapsedMs = Date.now() - stream.startedAt;
  let cursor = 0;
  for (const item of playlist.items) {
    const durMs = item.duration * 1000;
    if (cursor + durMs > elapsedMs) {
      const mediaItem = deps.getMediaById(item.mediaId) || {
        id: item.mediaId,
        title: item.title,
        path: item.filePath,
        duration: item.duration,
        thumb: item.thumb,
        season: item.season,
        episode: item.episode,
        seriesTitle: item.seriesTitle,
        summary: item.summary,
      };
      return {
        item: mediaItem,
        offsetSeconds: Math.floor((elapsedMs - cursor) / 1000),
        startTime: stream.startedAt + cursor,
        endTime: stream.startedAt + cursor + durMs,
        isLive: false,
      };
    }
    cursor += durMs;
  }
  // Past the end of the cached playlist; ffmpeg's exit handler will regenerate
  return null;
}

function getSchedule(ch, fromMs, toMs) {
  if (!deps) return [];
  if (ch.liveStreamId) {
    const s = deps.getSfStream(ch.liveStreamId);
    return [{ start: fromMs, end: toMs, title: s ? `🔴 ${s.name}` : '🔴 Live', isLive: true }];
  }
  const playlist = playlists.get(ch.id);
  if (!playlist) return [];
  const stream = streams.get(ch.id);
  const anchor = stream ? stream.startedAt : Date.now();

  const programs = [];
  let cursor = anchor;
  for (const item of playlist.items) {
    const durMs = item.duration * 1000;
    const start = cursor;
    const end = cursor + durMs;
    if (end > fromMs && start < toMs) {
      const titleStr = item.seriesTitle && item.season != null
        ? `${item.seriesTitle} S${String(item.season).padStart(2, '0')}E${String(item.episode || 0).padStart(2, '0')}${item.title && item.title !== item.seriesTitle ? ' — ' + item.title : ''}`
        : item.title;
      programs.push({
        start, end,
        title: titleStr,
        desc: item.summary || '',
        icon: item.thumb || '',
        season: item.season,
        episode: item.episode,
        seriesTitle: item.seriesTitle,
      });
    }
    cursor = end;
    if (cursor >= toMs) break;
  }
  return programs;
}

// ──────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ──────────────────────────────────────────────────────────────────────────────

module.exports = {
  init,
  start,
  startChannelStream,
  stopChannelStream,
  regeneratePlaylist,
  buildPlaylistItems,
  getNowPlaying,
  getSchedule,
  // For diagnostics
  _state: { playlists, streams },
};

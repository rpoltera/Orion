// ============================================================================
// preseg-direct.js — zero-ffmpeg HLS serving for fully pre-segmented channels
// ============================================================================
//
// When every item on a channel already has a preseg "done" rendition on disk
// (built by preseg-service.js into <dir>/.hls/<mediaId>/seg*.ts + index.m3u8),
// this module serves those segments DIRECTLY as a rolling live HLS window —
// no decode, no scale, no encode, no ffmpeg process at all.
//
// It is OPT-IN per channel via `ch.presegDirect === true`. If a channel is not
// flagged, or any of its items lack a usable preseg rendition, startVirtual()
// returns null and the caller falls back to the existing ffmpeg path. Nothing
// changes for any channel until you set the flag. Test on ONE channel first.
//
// Segments are referenced through the existing /sf/preseg-file/<base64url>
// route (in streamforge.js), so no new HTTP route is required. The channel's
// index.m3u8 is written to the same /var/lib/orion/sf/hls/<id>/ path the
// player already polls, so no client change is required either.
// ============================================================================

const fs = require('fs');
const path = require('path');

const PRESEG_JSON = '/var/lib/orion/sf/preseg.json';
const WINDOW_SEGMENTS = 8;       // segments advertised in the live window (~48s at 6s)
const REWRITE_MS = 1000;         // how often the rolling manifest is rewritten

// ── preseg.json loader with mtime cache, indexed by source filePath ──────────
let _dbCache = { mtimeMs: 0, byPath: new Map() };
function getDb() {
  let st;
  try { st = fs.statSync(PRESEG_JSON); } catch { return _dbCache.byPath; }
  if (st.mtimeMs === _dbCache.mtimeMs) return _dbCache.byPath;
  const byPath = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(PRESEG_JSON, 'utf8'));
    for (const mid of Object.keys(raw)) {
      const rec = raw[mid];
      if (!rec || rec.status !== 'done' || !rec.filePath || !rec.hlsDir) continue;
      const prev = byPath.get(rec.filePath);
      // keep the most recently completed rendition for a given source file
      if (!prev || (rec.doneAt || 0) > (prev.doneAt || 0)) byPath.set(rec.filePath, rec);
    }
  } catch { /* leave previous cache on parse error */ return _dbCache.byPath; }
  _dbCache = { mtimeMs: st.mtimeMs, byPath };
  return byPath;
}

// ── parse an episode's preseg index.m3u8 into [{dur, file(abs)}] ──────────────
function loadEpisodeSegments(hlsDir) {
  const manifest = path.join(hlsDir, 'index.m3u8');
  let text;
  try { text = fs.readFileSync(manifest, 'utf8'); } catch { return []; }
  const out = [];
  const lines = text.split('\n');
  let pendingDur = null;
  for (let raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF:')) {
      const m = line.match(/#EXTINF:\s*([0-9.]+)/);
      pendingDur = m ? parseFloat(m[1]) : null;
    } else if (line.startsWith('#')) {
      continue; // other tags ignored
    } else {
      // segment URI (relative to hlsDir)
      const abs = path.isAbsolute(line) ? line : path.join(hlsDir, line);
      out.push({ dur: (pendingDur && pendingDur > 0) ? pendingDur : 6.0, file: abs });
      pendingDur = null;
    }
  }
  return out;
}

const _itemFile = (it) => it && (it.filePath || it._filePath || (it.path));

// ── build a flat channel timeline across all items, end to end ───────────────
// Returns { segs:[{file,dur,t0,episodeStart,itemIdx}], total, maxDur } or null
// if ANY item is not usable as preseg-direct (→ caller uses ffmpeg fallback).
function buildTimeline(items, byPath) {
  if (!Array.isArray(items) || !items.length) return null;
  const segs = [];
  let absT = 0, maxDur = 0;
  for (let idx = 0; idx < items.length; idx++) {
    const fp = _itemFile(items[idx]);
    if (!fp) return null;
    const rec = byPath.get(fp);
    if (!rec || !rec.hlsDir) return null;
    const eps = loadEpisodeSegments(rec.hlsDir);
    if (!eps.length) return null;
    for (let j = 0; j < eps.length; j++) {
      const dur = eps[j].dur;
      segs.push({ file: eps[j].file, dur, t0: absT, episodeStart: j === 0, itemIdx: idx });
      absT += dur;
      if (dur > maxDur) maxDur = dur;
    }
  }
  if (!segs.length) return null;
  return { segs, total: absT, maxDur };
}

// ── absolute timeline offset corresponding to item0's inpoint (ip seconds) ───
function startOffsetAbs(tl, ip) {
  if (!ip || ip <= 0) return 0;
  let acc = 0;
  for (const s of tl.segs) {
    if (s.itemIdx !== 0) break;
    if (acc + s.dur > ip) return s.t0;
    acc += s.dur;
  }
  return 0; // ip beyond item0 → start at top
}

// ── build the rolling live-window manifest at playback position playbackAbs ──
// Returns m3u8 string, or null if playbackAbs is past the end (→ regenerate).
function buildWindowManifest(tl, playbackAbs, listSize) {
  const segs = tl.segs;
  let i0 = -1;
  for (let i = 0; i < segs.length; i++) {
    if (segs[i].t0 + segs[i].dur > playbackAbs) { i0 = i; break; }
  }
  if (i0 < 0) return null; // exhausted

  // discontinuity-sequence = episode *transitions* strictly before the window.
  // The timeline's very first segment (index 0) has no preceding content, so its
  // episodeStart is not a transition and must not be counted.
  let discSeq = 0;
  for (let i = 1; i < i0; i++) if (segs[i].episodeStart) discSeq++;

  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:6',
    `#EXT-X-TARGETDURATION:${Math.max(1, Math.ceil(tl.maxDur))}`,
    `#EXT-X-MEDIA-SEQUENCE:${i0}`,
    `#EXT-X-DISCONTINUITY-SEQUENCE:${discSeq}`,
    '#EXT-X-INDEPENDENT-SEGMENTS',
  ];
  const end = Math.min(segs.length, i0 + listSize);
  for (let i = i0; i < end; i++) {
    // emit DISCONTINUITY before an episode-start seg, except the very first
    // seg of the window (its discontinuity is carried by DISCONTINUITY-SEQUENCE)
    if (segs[i].episodeStart && i > i0) lines.push('#EXT-X-DISCONTINUITY');
    lines.push(`#EXTINF:${segs[i].dur.toFixed(6)},`);
    lines.push('/sf/preseg-file/' + Buffer.from(segs[i].file).toString('base64url'));
  }
  return lines.join('\n') + '\n';
}

// ── eligibility probe (used for logging / pre-check) ─────────────────────────
function eligible(items) {
  return !!buildTimeline(items, getDb());
}

// ── start a virtual (zero-ffmpeg) channel stream ─────────────────────────────
// opts: { ch, playlist, hlsDir, regenerate() -> freshPlaylist|undefined }
// Returns a stream object compatible with the engine's `streams` map, or null
// if the channel is not eligible (caller should fall back to ffmpeg).
function startVirtual(opts) {
  const { ch, playlist, hlsDir, regenerate } = opts;
  const byPath = getDb();
  const tl = buildTimeline(playlist.items, byPath);
  if (!tl) return null;

  try { fs.mkdirSync(hlsDir, { recursive: true }); } catch {}
  // clear any stale ffmpeg segments/manifest from a previous transcoding run
  try {
    fs.readdirSync(hlsDir)
      .filter(f => /\.(ts|m3u8|m4s)$/.test(f))
      .forEach(f => { try { fs.unlinkSync(path.join(hlsDir, f)); } catch {} });
  } catch {}

  const manFile = path.join(hlsDir, 'index.m3u8');
  const ip0 = (playlist.items[0] && playlist.items[0].inpoint) || 0;

  const vstream = {
    channelId: ch.id,
    startedAt: Date.now(),
    restarts: 0,
    gpuId: null,
    virtual: true,
    _tl: tl,
    _startAbs: startOffsetAbs(tl, ip0),
    // proc shim must satisfy streamforge's startHlsSession wrapper, which calls
    // stream.proc.on('exit', cb) and reads pid/kill/killed. A virtual stream never
    // exits, so on/once register no-ops. pid = our own pid so the engine's liveness
    // probe (process.kill(pid,0)) treats the virtual stream as alive and reuses it.
    proc: {
      pid: process.pid,
      killed: false,
      kill: () => { try { clearInterval(vstream._timer); } catch {} },
      on: () => {},
      once: () => {},
    },
  };

  const tick = () => {
    const playbackAbs = vstream._startAbs + (Date.now() - vstream.startedAt) / 1000;
    const man = buildWindowManifest(vstream._tl, playbackAbs, WINDOW_SEGMENTS);
    if (man === null) {
      // reached end of timeline — regenerate playlist and rebuild
      let fresh;
      try { fresh = regenerate && regenerate(); } catch {}
      const ntl = fresh ? buildTimeline(fresh.items, getDb()) : null;
      if (ntl) {
        vstream._tl = ntl;
        vstream._startAbs = startOffsetAbs(ntl, (fresh.items[0] && fresh.items[0].inpoint) || 0);
        vstream.startedAt = Date.now();
      } else {
        // can't rebuild as preseg-direct (content changed to non-preseg);
        // stop ticking so the engine's normal restart path can take over
        try { clearInterval(vstream._timer); } catch {}
        try { fs.unlinkSync(manFile); } catch {}
      }
      return;
    }
    try { fs.writeFileSync(manFile, man); } catch {}
  };

  tick(); // write first manifest immediately so the player has something to read
  vstream._timer = setInterval(tick, REWRITE_MS);
  if (vstream._timer.unref) vstream._timer.unref();
  return vstream;
}

module.exports = {
  getDb,
  buildTimeline,
  startOffsetAbs,
  buildWindowManifest,
  loadEpisodeSegments,
  eligible,
  startVirtual,
};

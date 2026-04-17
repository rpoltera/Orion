'use strict';
/**
 * Orion Stream Routes
 * /api/stream, /api/hls/*, /api/progress/*, /api/subtitles/*
 */

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const ffmpeg  = require('fluent-ffmpeg');
const { PassThrough } = require('stream');

const AUDIO_MIME = {
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.flac': 'audio/flac',
};
const COPY_VIDEO_CODECS = new Set(['h264', 'avc', 'avc1', 'x264', 'vp8', 'vp9', 'av1']);
const NATIVE_EXTS = ['.mp4', '.m4v', '.webm'];
const QUALITY_TIERS = {
  '4k':    { scale: null,       bitrate: '12000k', crf: 18 },
  '1080p': { scale: '1920:-2',  bitrate: '8000k',  crf: 20 },
  '720p':  { scale: '1280:-2',  bitrate: '4000k',  crf: 22 },
  '480p':  { scale: '854:-2',   bitrate: '2000k',  crf: 24 },
  '360p':  { scale: '640:-2',   bitrate: '1000k',  crf: 26 },
};

// Session management
const _activeSessions  = new Map();
const _pendingStreams   = new Map();
const _transcodeQueue  = [];
const _sessionGraveyard = new Map();
const MAX_CONCURRENT_TRANSCODES = 6; // P40 GPUs can handle many concurrent encodes
const GRAVEYARD_TTL = 15000; // free GPU resources faster

// Fast codec probe cache — avoids re-probing the same file
const _probeCache = new Map();
const PROBE_CACHE_TTL = 60 * 60 * 1000; // 60 minutes — files don't change codec mid-session

function probeFileCodecs(filePath) {
  const cached = _probeCache.get(filePath);
  if (cached && Date.now() - cached.ts < PROBE_CACHE_TTL) return Promise.resolve(cached.result);
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve({ video: null, audio: null, channels: 0 }), 3000);
    ffmpeg.ffprobe(filePath, (err, meta) => {
      clearTimeout(timer);
      if (err) return resolve({ video: null, audio: null, channels: 0 });
      const v = meta.streams?.find(s => s.codec_type === 'video');
      const a = meta.streams?.find(s => s.codec_type === 'audio');
      const result = {
        video:    v?.codec_name?.toLowerCase() || null,
        audio:    a?.codec_name?.toLowerCase() || null,
        channels: a?.channels || 0,
        bits:     v?.bits_per_raw_sample ? parseInt(v.bits_per_raw_sample) : (v?.pix_fmt?.includes('10') ? 10 : 8),
      };
      _probeCache.set(filePath, { result, ts: Date.now() });
      resolve(result);
    });
  });
}

function pruneGraveyard() {
  const now = Date.now();
  for (const [id, s] of _sessionGraveyard) {
    if (now > s.expiresAt) { try { s.ffmpegCmd?.kill('SIGKILL'); } catch {} _sessionGraveyard.delete(id); }
  }
}

function processTranscodeQueue() {
  if (_transcodeQueue.length > 0 && _activeSessions.size < MAX_CONCURRENT_TRANSCODES) {
    const next = _transcodeQueue.shift();
    if (next?.resolve) next.resolve();
  }
}

// NAS pool tracking
const _poolReads = {};
const MAX_READS_PER_POOL = 8; // allow more concurrent NAS reads
function acquirePoolSlot(filePath) {
  const pool = filePath.includes('jbod1') ? 'jbod1' : filePath.includes('media') ? 'media' : 'default';
  _poolReads[pool] = (_poolReads[pool] || 0) + 1;
  return pool;
}
function releasePoolSlot(pool) { if (pool && _poolReads[pool] > 0) _poolReads[pool]--; }

module.exports = function streamRoutes({ db, io, saveDB, HLS, OrionDB, getConfig, getEncoder }) {

  const router = express.Router();

  // ── Progress tracking ─────────────────────────────────────────────────────────
  router.post('/progress/:mediaId', (req, res) => {
    const { position, duration, watched } = req.body;
    const allItems = [...db.movies, ...db.tvShows, ...(db.musicVideos||[])];
    const item = allItems.find(i => i.id === req.params.mediaId);
    if (!item) return res.status(404).json({ error: 'Not found' });

    item.progress = position || 0;
    item.progressDuration = duration || 0;
    item.lastWatched = new Date().toISOString();
    if (duration > 0) item.resumePct = Math.round((position / duration) * 100);

    if (!db.watchHistory) db.watchHistory = {};
    const userId = req.headers['x-user-id'] || req.query.userId || 'default';
    if (!db.watchHistory[userId]) db.watchHistory[userId] = {};
    const histEntry = db.watchHistory[userId][item.id] || { playCount: 0 };
    histEntry.lastWatched = item.lastWatched;
    histEntry.position = position;
    histEntry.duration = duration;
    histEntry.resumePct = item.resumePct;

    if (watched || (duration > 0 && position / duration >= 0.9)) {
      item.watched = true;
      item.watchedAt = new Date().toISOString();
      histEntry.playCount = (histEntry.playCount || 0) + 1;
      histEntry.resumePct = 100;
    }
    db.watchHistory[userId][item.id] = histEntry;
    const type = db.movies.includes(item) ? 'movies' : 'tvShows';
    OrionDB.markDirty(type);
    saveDB(false, type);
    res.json({ ok: true });
  });

  router.get('/progress/:mediaId', (req, res) => {
    const allItems = [...db.movies, ...db.tvShows, ...(db.musicVideos||[])];
    const item = allItems.find(i => i.id === req.params.mediaId);
    if (!item) return res.status(404).json({ error: 'Not found' });
    res.json({ position: item.progress||0, duration: item.progressDuration||0, watched: item.watched||false, lastWatched: item.lastWatched||null });
  });

  // Next unwatched episode — returns full episode object with filePath
  const _tvNextCache = new Map();
  router.get('/tv/next/:showName', (req, res) => {
    const showName = decodeURIComponent(req.params.showName);
    const cached = _tvNextCache.get(showName);
    if (cached && Date.now() - cached.ts < 120000) return res.json(cached.episode);
    const episodes = db.tvShows.filter(ep => (ep.seriesTitle||ep.showName||'') === showName)
      .sort((a,b) => {
        const sa = a.seasonNum||1, sb = b.seasonNum||1;
        if (sa !== sb) return sa-sb;
        const ea = parseInt((a.fileName||'').match(/E(\d+)/i)?.[1]||0);
        const eb = parseInt((b.fileName||'').match(/E(\d+)/i)?.[1]||0);
        return ea-eb;
      });
    const next = episodes.find(ep => !ep.watched && !(ep.resumePct >= 90)) || episodes[0] || null;
    if (next) console.log(`[tv/next] ${showName} → ${next.title} filePath=${next.filePath||'MISSING'}`);
    _tvNextCache.set(showName, { episode: next, ts: Date.now() });
    res.json({ episode: next });
  });

  // ── HLS ───────────────────────────────────────────────────────────────────────
  router.post('/hls/start', async (req, res) => {
    const { filePath, quality='source', audioTrack=0, seekTime=0, videoCodec=null, audioCodec=null } = req.body;
    if (!filePath) return res.status(400).json({ error: 'filePath required' });
    try {
      let vCodec = videoCodec, aCodec = audioCodec;
      if (!vCodec || !aCodec) {
        const item = [...db.movies, ...db.tvShows].find(m => m.filePath === filePath);
        if (item) { vCodec = vCodec||item.videoCodec||null; aCodec = aCodec||item.audioCodec||null; }
      }
      const sessionId = HLS.beginSession(filePath, quality, audioTrack, seekTime, vCodec, aCodec);
      res.json({ ok: true, sessionId, playlistUrl: `/api/hls/${sessionId}/index.m3u8`, ready: false, qualities: Object.keys(HLS.QUALITY_TIERS||QUALITY_TIERS) });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/hls/status', (_, res) => res.json(HLS.getStatus()));

  router.get('/hls/:sessionId/index.m3u8', (req, res) => {
    const playlist = HLS.getPlaylist(req.params.sessionId);
    if (!playlist) return res.status(404).send('Session not found');
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(playlist);
  });

  router.get('/hls/:sessionId/:segment', (req, res) => {
    const { sessionId, segment } = req.params;
    if (!segment.endsWith('.ts') && !segment.endsWith('.m3u8')) return res.status(400).end();
    if (segment.endsWith('.m3u8')) {
      const playlist = HLS.getPlaylist(sessionId);
      if (!playlist) return res.status(404).end();
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-cache');
      return res.send(playlist);
    }
    const segPath = HLS.getSegment(sessionId, segment);
    if (!segPath) return res.status(404).end();
    const stat = fs.statSync(segPath);
    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('Access-Control-Allow-Origin', '*');
    const stream = fs.createReadStream(segPath, { highWaterMark: 2*1024*1024 });
    stream.on('data', chunk => { if (res.write(chunk) === false) stream.pause(); });
    res.on('drain', () => stream.resume());
    stream.on('end', () => res.end());
    stream.on('error', () => res.end());
    req.on('close', () => stream.destroy());
  });

  router.delete('/hls/:sessionId', (req, res) => { HLS.stopSession(req.params.sessionId); res.json({ ok: true }); });

  // ── Main stream endpoint ──────────────────────────────────────────────────────
  router.get('/stream', async (req, res) => {
    const { path: filePath, transcode, quality, subtitle } = req.query;
    if (!filePath) return res.status(400).json({ error: 'No path provided' });

    const streamStart = Date.now();
    const clientKey   = `${req.ip}_${filePath}`;
    const sessionId   = `${req.ip}_${Date.now()}`;

    // Kill duplicate streams from same client
    const existingId = _pendingStreams.get(clientKey);
    if (existingId) {
      const existing = _activeSessions.get(existingId);
      if (existing?.ffmpegCmd) { try { existing.ffmpegCmd.kill('SIGKILL'); } catch {} }
      _activeSessions.delete(existingId);
      _pendingStreams.delete(clientKey);
    }
    _pendingStreams.set(clientKey, sessionId);
    pruneGraveyard();

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Range');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range');

    const isUNC = filePath.startsWith('\\\\') || filePath.startsWith('//');
    if (!isUNC) {
      try { if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found: ' + filePath }); }
      catch(err) { return res.status(404).json({ error: 'Cannot access file: ' + err.message }); }
    }

    const ext = path.extname(filePath).toLowerCase();

    // Audio files — direct serve with range support
    if (AUDIO_MIME[ext]) {
      const mime = AUDIO_MIME[ext];
      try {
        const stat = fs.statSync(filePath);
        const total = stat.size;
        const range = req.headers.range;
        if (range) {
          const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
          const start = parseInt(startStr, 10);
          const end = endStr ? parseInt(endStr, 10) : total - 1;
          res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${total}`, 'Accept-Ranges': 'bytes', 'Content-Length': end-start+1, 'Content-Type': mime });
          fs.createReadStream(filePath, { start, end }).pipe(res);
        } else {
          res.writeHead(200, { 'Content-Length': total, 'Content-Type': mime, 'Accept-Ranges': 'bytes' });
          fs.createReadStream(filePath).pipe(res);
        }
      } catch(e) { res.status(500).json({ error: e.message }); }
      return;
    }

    const config = getConfig();
    const mediaItem = [...db.movies, ...db.tvShows].find(m => m.filePath === filePath);

    // Always probe the actual file for codec info — DB values can be stale or wrong
    // after metadata corruption / rescans. ffprobe result is cached per file.
    const probed = await probeFileCodecs(filePath);
    const probeVideoCodec  = probed.video    || mediaItem?.videoCodec?.toLowerCase() || null;
    const probeAudioCodec  = probed.audio    || mediaItem?.audioCodec?.toLowerCase() || null;
    const probeChannels    = probed.channels || 0;
    const probeBits        = probed.bits     || 8;

    const videoNeedsDecode = probeVideoCodec && !COPY_VIDEO_CODECS.has(probeVideoCodec);
    const isNativeContainer = NATIVE_EXTS.includes(ext);
    const needsTranscode = transcode === '1' || videoNeedsDecode || (!probeVideoCodec && !isNativeContainer);

    console.log(`[Stream] ${path.basename(filePath)} | video=${probeVideoCodec||'unknown'} audio=${probeAudioCodec||'unknown'} | transcode=${needsTranscode} forceEncode=${videoNeedsDecode}`);

    if (needsTranscode) {
      if (_activeSessions.size >= MAX_CONCURRENT_TRANSCODES) {
        if (_transcodeQueue.length >= 10) return res.status(503).set('Retry-After','15').json({ error: 'Queue full' });
        await new Promise(resolve => {
          _transcodeQueue.push({ res, filePath, resolve });
          req.once('close', () => { const idx = _transcodeQueue.findIndex(q => q.resolve === resolve); if (idx >= 0) _transcodeQueue.splice(idx, 1); });
        });
        if (res.writableEnded) return;
      }

      const seekTime   = parseFloat(req.query.seek) || 0;
      const audioTrack = parseInt(req.query.audio) || 0;
      const qualityTier = QUALITY_TIERS[quality] || null;

      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Transfer-Encoding', 'chunked');
      res.setHeader('Cache-Control', 'no-cache, no-store');
      res.setHeader('X-Accel-Buffering', 'no');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Playback-Session-Id', sessionId);
      if (mediaItem?.runtime > 0) res.setHeader('X-Content-Duration', String(mediaItem.runtime * 60));

      let ffmpegCmd, clientClosed = false, firstChunk = true, retryCount = 0;
      let softwareFallback = false; // set true when GPU encoder fails → forces libx264 on retry
      const encoder = getEncoder ? getEncoder() : 'libx264';

      const cleanup = (toGraveyard = false) => {
        _activeSessions.delete(sessionId);
        if (_pendingStreams.get(clientKey) === sessionId) _pendingStreams.delete(clientKey);
        processTranscodeQueue();
        if (ffmpegCmd) {
          if (toGraveyard && !firstChunk) { _sessionGraveyard.set(sessionId, { ffmpegCmd, filePath, seekTime, expiresAt: Date.now() + GRAVEYARD_TTL }); }
          else { try { ffmpegCmd.kill('SIGKILL'); } catch {} }
        }
      };

      req.on('close', () => { clientClosed = true; cleanup(true); });

      const tryTranscode = (forceEncode = false) => {
        if (clientClosed) return;

        const inputOptions = ['-probesize','200000','-analyzeduration','200000','-fflags', '+genpts+discardcorrupt+igndts+fastseek', '-err_detect', 'ignore_err'];
        if (seekTime > 10) {
          // Fast keyframe seek before input, then precise seek after
          inputOptions.push('-ss', String(Math.max(0, seekTime - 5)));
        } else if (seekTime > 0) {
          inputOptions.push('-ss', String(seekTime));
        }

        const outputSeek = seekTime > 10 ? 5 : 0;
        let videoCodec = 'copy', videoOptions = [], scaleFilter = null;
        if (forceEncode || qualityTier) {
          if (!softwareFallback && encoder.includes('amf')) {
            videoCodec = encoder;
            videoOptions = ['-usage','transcoding','-quality','balanced','-rc','cqp','-qp_i','22','-qp_p','24'];
            if (qualityTier) scaleFilter = qualityTier.scale;
          } else if (!softwareFallback && encoder.includes('nvenc')) {
            videoCodec = encoder; videoOptions = ['-preset','p1','-tune','ull','-rc','vbr','-cq','23','-b:v','0','-zerolatency','1'];
            if (qualityTier) scaleFilter = qualityTier.scale;
          } else if (!softwareFallback && encoder.includes('qsv')) {
            videoCodec = encoder; videoOptions = ['-preset','veryfast','-global_quality','23','-look_ahead','0'];
            if (qualityTier) scaleFilter = qualityTier.scale;
          } else if (!softwareFallback && encoder.includes('videotoolbox')) {
            videoCodec = encoder; videoOptions = ['-q:v','65'];
            if (qualityTier) scaleFilter = qualityTier.scale;
          } else {
            videoCodec = 'libx264';
            videoOptions = ['-preset','ultrafast','-tune','zerolatency','-crf', String(qualityTier?.crf || 23)];
            if (qualityTier) scaleFilter = qualityTier.scale;
          }
        }

        // Multichannel downmix: triggered by known codec OR channel count > 2
        const isMultichannel = probeChannels > 2 ||
          (probeAudioCodec && ['ac3','dts','truehd','eac3','dts-hd','dts-x','atmos'].some(c => probeAudioCodec.toLowerCase().includes(c)));
        const audioFilter = isMultichannel
          ? 'pan=stereo|c0=0.5*c0+0.707*c2+0.707*c4|c1=0.5*c1+0.707*c2+0.707*c5'
          : null;

        // For 10-bit source with software encode, add proper pixel format conversion
        const pixFmt = (probeBits >= 10 && videoCodec === 'libx264') ? 'yuv420p' : 'yuv420p';

        const outputOptions = [
          '-f mp4', '-movflags frag_keyframe+delay_moov+default_base_moof',
          '-max_muxing_queue_size 9999', '-map 0:v:0', `-map 0:a:${audioTrack}?`,
          '-avoid_negative_ts make_zero', '-max_interleave_delta', '500000000',
          ...(audioFilter ? ['-af', audioFilter] : []),
          '-ac', '2', '-ar', '48000', '-b:a', '192k',
        ];
        if (videoCodec !== 'copy') outputOptions.push('-pix_fmt', pixFmt, '-threads', '0', '-fps_mode', 'cfr');
        if (scaleFilter) outputOptions.push(`-vf scale=${scaleFilter}`);
        if (subtitle && subtitle !== '0') {
          const subIdx = parseInt(subtitle)||0;
          if (scaleFilter) { const idx = outputOptions.findIndex(o=>o.startsWith('-vf')); if (idx>=0) outputOptions[idx] = `-vf scale=${scaleFilter},subtitles='${filePath}':si=${subIdx}`; }
          else outputOptions.push(`-vf subtitles='${filePath}':si=${subIdx}`);
        }

        try {
          const workAheadMB    = parseInt(config.transcoding?.workAheadMB || '8', 10) || 8;
          const workAheadBytes = workAheadMB * 1024 * 1024;

          const chunkQueue = [];
          let queuedBytes  = 0;
          let ffmpegDone   = false;
          let ffmpegPaused = false;

          // Stall watchdog — if no data flows for 30s, end response so player can retry
          let lastDataAt = Date.now();
          const stallTimer = setInterval(() => {
            if (clientClosed || res.writableEnded) { clearInterval(stallTimer); return; }
            if (!ffmpegDone && Date.now() - lastDataAt > 15000) {
              clearInterval(stallTimer);
              console.warn(`[Transcode] Stall detected (30s no data) — ending stream for retry: ${path.basename(filePath)}`);
              try { ffmpegCmd?.kill('SIGKILL'); } catch {}
              if (!res.writableEnded) res.end();
            }
          }, 5000);

          function pumpToRes() {
            while (chunkQueue.length > 0) {
              if (clientClosed || res.writableEnded) { clearInterval(stallTimer); return; }
              const chunk = chunkQueue.shift();
              queuedBytes -= chunk.length;
              lastDataAt = Date.now();
              if (ffmpegPaused && queuedBytes < workAheadBytes / 2) {
                outStream.resume();
                ffmpegPaused = false;
              }
              if (!res.write(chunk)) return;
            }
            if (ffmpegDone && !res.writableEnded) { clearInterval(stallTimer); res.end(); }
          }

          ffmpegCmd = ffmpeg(filePath)
            .inputOptions(inputOptions)
            .videoCodec(videoCodec)
            .audioCodec('aac')
            .outputOptions([...outputOptions, ...videoOptions])
            .on('start', cmd => {
              _activeSessions.set(sessionId, { ffmpegCmd, filePath, startTime: Date.now(), bufferedSeconds: 0 });
              console.log(`[FFmpeg] ${path.basename(filePath)} cmd: ${cmd.slice(0, 200)}`);
            })
            .on('progress', prog => {
              if (prog.timemark) {
                const p = prog.timemark.split(':');
                const secs = parseFloat(p[0]||0)*3600 + parseFloat(p[1]||0)*60 + parseFloat(p[2]||0);
                const sess = _activeSessions.get(sessionId);
                if (sess) sess.bufferedSeconds = secs + seekTime;
                lastDataAt = Date.now();
              }
            })
            .on('error', (err) => {
              clearInterval(stallTimer);
              if (clientClosed) return;
              const errMsg = err.message || '';
              if (!forceEncode && retryCount === 0 && /codec|muxer|copy|Invalid/i.test(errMsg)) {
                retryCount++; ffmpegCmd = null;
                console.log(`[Transcode] Copy failed, retrying with encode`);
                return tryTranscode(true);
              }
              if (forceEncode && retryCount === 0 && !softwareFallback &&
                  /amf|nvenc|qsv|encode|encoder/i.test(errMsg)) {
                retryCount++; ffmpegCmd = null; softwareFallback = true;
                console.log(`[Transcode] GPU encoder failed, retrying with libx264: ${errMsg.slice(0,80)}`);
                return tryTranscode(true);
              }
              console.error('[Transcode] Error:', errMsg.slice(0,200));
              if (!res.writableEnded) res.end();
            })
            .on('end', () => {
              clearInterval(stallTimer);
              _activeSessions.delete(sessionId);
              processTranscodeQueue();
              ffmpegDone = true;
              pumpToRes();
            });

          const bufferStream = new PassThrough({ highWaterMark: workAheadBytes });
          const outStream    = ffmpegCmd.pipe(bufferStream);

          outStream.on('data', chunk => {
            if (firstChunk) { firstChunk = false; console.log(`[Transcode] First chunk in ${Date.now()-streamStart}ms: ${path.basename(filePath)}`); }
            if (clientClosed || res.writableEnded) return;
            lastDataAt = Date.now();
            chunkQueue.push(chunk);
            queuedBytes += chunk.length;
            if (!ffmpegPaused && queuedBytes >= workAheadBytes) {
              outStream.pause();
              ffmpegPaused = true;
            }
            pumpToRes();
          });

          res.on('drain', pumpToRes);
          outStream.on('end',   () => { ffmpegDone = true; pumpToRes(); });
          outStream.on('error', () => { clearInterval(stallTimer); if (!res.writableEnded) res.end(); });
        } catch(err) { console.error('[Transcode] Setup error:', err.message); if (!res.writableEnded) res.end(); }
      };

      tryTranscode(videoNeedsDecode); // force encode only if video codec needs decoding (e.g. hevc → h264_amf)

    } else {
      // Direct file streaming
      const isJbod1 = filePath.includes('jbod1');
      const HDD_BUFFER = isJbod1 ? 8*1024*1024 : 16*1024*1024; // larger buffers for NAS reads
      let fileSize = 0;
      try { fileSize = fs.statSync(filePath).size; } catch {}

      const mimeType = ext === '.webm' ? 'video/webm' : ext === '.mkv' ? 'video/x-matroska' : ext === '.avi' ? 'video/x-msvideo' : ext === '.mov' ? 'video/quicktime' : 'video/mp4';

      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Type', mimeType);
      res.setHeader('Cache-Control', 'no-cache');

      const pool = acquirePoolSlot(filePath);
      res.on('close', () => releasePoolSlot(pool));
      res.on('finish', () => releasePoolSlot(pool));

      const range = req.headers.range;
      if (range && fileSize > 0) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10) || 0;
        const requestedEnd = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const end = Math.min(requestedEnd, fileSize - 1);
        res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${fileSize}`, 'Content-Length': end-start+1 });
        const stream = fs.createReadStream(filePath, { start, end, highWaterMark: HDD_BUFFER });
        stream.on('data', chunk => { if (res.write(chunk) === false) stream.pause(); });
        res.on('drain', () => stream.resume());
        stream.on('end', () => res.end());
        stream.on('error', err => { console.error('[Stream] Read error:', err.message); if (!res.writableEnded) res.end(); });
        req.on('close', () => stream.destroy());
      } else {
        if (fileSize > 0) res.setHeader('Content-Length', fileSize);
        const stream = fs.createReadStream(filePath, { highWaterMark: HDD_BUFFER });
        stream.on('data', chunk => { if (res.write(chunk) === false) stream.pause(); });
        res.on('drain', () => stream.resume());
        stream.on('end', () => res.end());
        stream.on('error', () => { if (!res.writableEnded) res.end(); });
        req.on('close', () => stream.destroy());
      }
    }
  });

  // Active streams status
  router.get('/streams', async (req, res) => {
    const filterPath = req.query.path || null;
    const sessions = [..._activeSessions.entries()]
      .filter(([, s]) => !filterPath || s.filePath === filterPath)
      .map(([id, s]) => ({
        sessionId: id,
        filePath: s.filePath,
        fileName: path.basename(s.filePath||''),
        durationMs: Date.now() - s.startTime,
        bufferedSeconds: s.bufferedSeconds || 0,
      }));
    res.json({ active: sessions.length, sessions });
  });

  // ── Live stream HLS buffer ────────────────────────────────────────────────
  // IPTV streams need a buffer to absorb network jitter from providers.
  // We transcode to HLS segments so the client always has 10 × 4s = 40s pre-buffered.
  // ── Live stream proxy (fMP4 pipe — no HLS.js needed) ─────────────────────
  const _liveProxies = new Map(); // sessionId → { proc, clients, url }

  router.delete('/stream/live/:sessionId', (req, res) => {
    const sess = _liveProxies.get(req.params.sessionId);
    if (sess) {
      try { sess.proc.kill('SIGKILL'); } catch {}
      _liveProxies.delete(req.params.sessionId);
      console.log('[LiveProxy] Killed:', req.params.sessionId);
    }
    res.json({ ok: true });
  });

  // Streaming fMP4 proxy — one FFmpeg process per client connection
  router.get('/stream/live/proxy', (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'url required' });

    const { spawn } = require('child_process');
    const ffmpegBin = require('ffmpeg-static');
    const encoder = getEncoder ? getEncoder() : 'libx264';
    const sessionId = require('crypto').randomBytes(8).toString('hex');

    const vcodec = encoder.includes('amf')   ? 'h264_amf'
                 : encoder.includes('nvenc') ? 'h264_nvenc'
                 : 'libx264';

    const args = [
      // Fast stream open — don't waste time analyzing the live source
      '-probesize', '500000',
      '-analyzeduration', '500000',
      '-user_agent', 'Mozilla/5.0',
      '-fflags', '+genpts+discardcorrupt+nobuffer',
      '-flags', 'low_delay',
      '-err_detect', 'ignore_err',
      '-rtbufsize', '8M',
      '-i', url,
      '-map', '0:v:0', '-map', '0:a:0?',
      '-vcodec', vcodec,
    ];
    if (encoder.includes('amf'))        args.push('-quality', 'speed', '-rc', 'cbr', '-b:v', '4M');
    else if (encoder.includes('nvenc')) args.push('-preset', 'p2', '-b:v', '4M');
    else                                args.push('-preset', 'ultrafast', '-crf', '23');

    args.push(
      '-g', '60', '-keyint_min', '60', '-sc_threshold', '0',
      '-acodec', 'aac', '-b:a', '192k', '-ac', '2',
      '-avoid_negative_ts', 'make_zero',
      '-max_interleave_delta', '0',
      '-f', 'mp4',
      // delay_moov writes the moov atom once upfront — fixes Chromium stalling every fragment
      // empty_moov was the root cause of 1-3 second buffering cycles
      '-movflags', 'frag_keyframe+delay_moov+default_base_moof',
      '-frag_duration', '2000000',  // 2-second fragments — smooth without adding lag
      'pipe:1'
    );

    const proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    _liveProxies.set(sessionId, { proc, url });

    proc.stderr.on('data', d => {
      const line = d.toString().trim().split('\n').pop();
      if (line && !line.startsWith('frame=')) console.log('[LiveProxy]', line.slice(0, 120));
    });
    proc.on('error', err => console.error('[LiveProxy] spawn error:', err.message));

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Live-Session', sessionId);
    proc.stdout.pipe(res);

    req.on('close', () => {
      try { proc.kill('SIGKILL'); } catch {}
      _liveProxies.delete(sessionId);
      console.log('[LiveProxy] Client disconnected:', sessionId);
    });
    proc.on('exit', (code) => {
      _liveProxies.delete(sessionId);
      if (!res.writableEnded) res.end();
      if (code && code !== 255) console.warn('[LiveProxy] FFmpeg exit', code, url.slice(0, 60));
    });
  });

  return router;
};

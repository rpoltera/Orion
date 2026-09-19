'use strict';
/**
 * Orion HLS Streaming Engine
 * Optimized for Windows UNC paths (\\server\share) on spinning rust ZFS
 */

const path   = require('path');
const fs     = require('fs');
const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');

// Two-second segments give Roku and other HLS clients a quick first frame
// without the long startup pause caused by the old ten-second segments.
const SEGMENT_DURATION = 2;
const MAX_SESSIONS     = 20;
const SESSION_IDLE_MS  = 5 * 60 * 1000;

let HLS_DIR    = null;
let ffmpegExe  = 'ffmpeg';
let encoderRef = null;
let playbackCoordinator = null;

const sessions = new Map();
const codecProbeCache = new Map();

const QUALITY_TIERS = {
  '4k':    { scale: null,       videoBitrate: '15000k', audioBitrate: '320k', crf: 18 },
  '1080p': { scale: '1920:-2',  videoBitrate: '8000k',  audioBitrate: '192k', crf: 20 },
  '720p':  { scale: '1280:-2',  videoBitrate: '4000k',  audioBitrate: '128k', crf: 22 },
  '480p':  { scale: '854:-2',   videoBitrate: '2000k',  audioBitrate: '128k', crf: 24 },
  '360p':  { scale: '640:-2',   videoBitrate: '800k',   audioBitrate: '96k',  crf: 26 },
  'source':{ scale: null,       videoBitrate: null,     audioBitrate: '192k', crf: 20 },
};

function init(dataDir, ffmpegPath, encRef, coordinator = null) {
  HLS_DIR    = path.join(dataDir, 'hls_cache');
  ffmpegExe  = ffmpegPath || 'ffmpeg';
  encoderRef = encRef;
  playbackCoordinator = coordinator;
  if (!fs.existsSync(HLS_DIR)) fs.mkdirSync(HLS_DIR, { recursive: true });
  cleanOldSegments();
  setInterval(cleanIdleSessions, 60000);
  setInterval(cleanOldSegments, 10 * 60 * 1000);
  console.log(`[HLS] Engine initialized. Cache: ${HLS_DIR}`);
}

function getSessionId(filePath, quality, audioTrack = 0, seekTime = 0) {
  // Audio changes and resume playback are separate FFmpeg jobs.  Keeping
  // them in the same session caused an audio switch to reuse the old stream.
  return crypto.createHash('md5')
    .update(`${filePath}\0${quality}\0${audioTrack}\0${Math.floor(seekTime || 0)}`)
    .digest('hex').slice(0, 12);
}

function getPool(filePath) {
  if (!filePath) return 'other';
  if (filePath.includes('jbod1')) return 'jbod1';
  if (filePath.toLowerCase().includes('\\media\\') || filePath.toLowerCase().includes('/media/')) return 'media';
  return 'other';
}

// Browser-compatible video codecs that don't need re-encoding for HLS
const COPY_VIDEO = new Set(['h264', 'avc', 'avc1', 'x264']);
// Browser-compatible audio codecs
const COPY_AUDIO = new Set(['aac', 'mp4a', 'mp4a-40-2']);
// These formats can be decoded by the Tesla P4's NVDEC engine.  Keep this
// allow-list deliberately small: sending an unsupported format to CUDA makes
// FFmpeg fail instead of falling back to the CPU decoder.
const NVDEC_VIDEO = new Set(['h264', 'avc', 'avc1', 'x264', 'hevc', 'h265', 'hev1', 'hvc1']);

function needsEncoder(tier, videoCodecHint, audioCodecHint) {
  const video = String(videoCodecHint || '').toLowerCase();
  // This coordinator owns scarce video encoder/GPU slots.  AAC conversion is
  // inexpensive CPU work and must not consume a GPU reservation by itself.
  return Boolean(tier.scale) || !COPY_VIDEO.has(video);
}

function getNvdecArgs(encoder, videoCodecHint, gpuId = null) {
  const video = String(videoCodecHint || '').trim().toLowerCase();
  if (!String(encoder || '').includes('nvenc') || !NVDEC_VIDEO.has(video)) return [];

  const selectedGpu = Number.isInteger(gpuId) ? gpuId : 0;
  console.log(`[HLS] Decode: CUDA/NVDEC (${video}) on GPU ${selectedGpu}`);
  return [
    '-hwaccel', 'cuda',
    '-hwaccel_device', String(selectedGpu),
    '-hwaccel_output_format', 'cuda',
  ];
}

function probeInputCodecs(filePath, videoHint = null, audioHint = null) {
  const hintedVideo = String(videoHint || '').trim().toLowerCase();
  const hintedAudio = String(audioHint || '').trim().toLowerCase();
  if (hintedVideo && hintedAudio) return { video: hintedVideo, audio: hintedAudio };

  const cached = codecProbeCache.get(filePath);
  if (cached) {
    return {
      video: hintedVideo || cached.video,
      audio: hintedAudio || cached.audio,
    };
  }

  try {
    const probePath = process.platform === 'win32'
      ? 'ffprobe'
      : path.join(path.dirname(ffmpegExe), 'ffprobe');
    const output = execFileSync(probePath, [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,codec_name',
      '-of', 'json',
      filePath,
    ], { encoding: 'utf8', timeout: 8000, windowsHide: true });
    const streams = JSON.parse(output).streams || [];
    const result = {
      video: String(streams.find(s => s.codec_type === 'video')?.codec_name || '').toLowerCase(),
      audio: String(streams.find(s => s.codec_type === 'audio')?.codec_name || '').toLowerCase(),
    };
    codecProbeCache.set(filePath, result);
    console.log(`[HLS] Probe: video=${result.video || 'unknown'} audio=${result.audio || 'unknown'}`);
    return { video: hintedVideo || result.video, audio: hintedAudio || result.audio };
  } catch (error) {
    console.warn(`[HLS] Probe failed; using library metadata: ${String(error.message || error).slice(0, 120)}`);
    return { video: hintedVideo, audio: hintedAudio };
  }
}

function getEncoderArgs(encoder, tier, videoCodecHint, audioCodecHint, gpuId = null) {
  const { scale, videoBitrate, crf } = tier;
  const args = [];

  // Smart copy: if video is already H.264 and no scaling needed — copy it
  const canCopyVideo = !scale && videoCodecHint && COPY_VIDEO.has(videoCodecHint.toLowerCase());
  const canCopyAudio = audioCodecHint && COPY_AUDIO.has(audioCodecHint.toLowerCase());

  if (canCopyVideo) {
    args.push('-c:v', 'copy');
    console.log('[HLS] Video: stream copy (already H.264)');
  } else {
    if (scale) {
      // CUDA frames stay on the GPU all the way into NVENC.  The CPU scale
      // filter would otherwise download every frame and waste several cores.
      if (encoder.includes('nvenc')) {
        const [width, height] = scale.split(':');
        args.push('-vf', `scale_cuda=w=${width}:h=${height}:format=yuv420p`);
      } else {
        args.push('-vf', `scale=${scale}`);
      }
    }
    if (encoder.includes('amf')) {
      args.push('-c:v', encoder, '-quality', 'speed', '-rc', 'cqp', '-qp_i', String(crf), '-qp_p', String(crf + 2));
    } else if (encoder.includes('nvenc')) {
      args.push('-c:v', encoder, '-preset', 'p1', '-rc', 'vbr', '-cq', String(crf));
      if (Number.isInteger(gpuId)) args.push('-gpu', String(gpuId));
      if (videoBitrate) args.push('-b:v', videoBitrate);
    } else if (encoder.includes('qsv')) {
      args.push('-c:v', encoder, '-preset', 'veryfast', '-global_quality', String(crf));
    } else if (encoder.includes('videotoolbox')) {
      args.push('-c:v', encoder, '-q:v', '65');
    } else {
      args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf));
      if (videoBitrate) args.push('-maxrate', videoBitrate, '-bufsize', videoBitrate);
    }
    console.log(`[HLS] Video: encoding with ${encoder}`);
    // Make a key frame every two seconds so the first HLS segment is playable
    // immediately instead of waiting for FFmpeg's default ~10-second GOP.
    args.push('-g', '60', '-sc_threshold', '0', '-force_key_frames', 'expr:gte(t,n_forced*2)');
  }

  return args;
}

function reservePlayback(sessionId, tier, videoCodec, audioCodec) {
  if (!playbackCoordinator) return null;
  const claim = playbackCoordinator.acquire({
    key: `hls:${sessionId}`,
    kind: 'library-hls',
    priority: 'interactive',
    requiresEncoder: needsEncoder(tier, videoCodec, audioCodec),
  });
  if (!claim.ok) {
    const error = new Error(claim.reason || 'No encoder slot is available');
    error.code = claim.code || 'PLAYBACK_CAPACITY';
    error.status = 503;
    throw error;
  }
  return claim;
}

function releasePlayback(session) {
  if (session?.playbackKey && playbackCoordinator) {
    playbackCoordinator.release(session.playbackKey);
    session.playbackKey = null;
  }
}

// Poll for segments — fs.watch unreliable on UNC paths in Windows
function waitForSegments(segDir, count, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = setInterval(() => {
      try {
        const files = fs.readdirSync(segDir).filter(f => f.endsWith('.ts'));
        if (files.length >= count) { clearInterval(check); return resolve(true); }
      } catch {}
      if (Date.now() - start > timeoutMs) { clearInterval(check); resolve(false); }
    }, 500);
  });
}

// A browser HLS client may not retry an initial 404 promptly.  Do not hand it
// a playlist until FFmpeg has produced both the manifest and its first media
// segment.  This avoids a needless retry/back-off on slower source files.
function waitForPlaylist(sessionId, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      const session = sessions.get(sessionId);
      if (!session) return resolve({ ready: false, error: 'Playback session stopped' });

      const playlistPath = path.join(session.segDir, 'index.m3u8');
      try {
        if (fs.existsSync(playlistPath)) {
          const playlist = fs.readFileSync(playlistPath, 'utf8');
          const firstSegment = playlist.match(/^([^#][^\r\n]*\.ts)$/m)?.[1];
          if (firstSegment && fs.existsSync(path.join(session.segDir, firstSegment))) {
            return resolve({ ready: true });
          }
        }
      } catch (_) {}

      if (Date.now() >= deadline) {
        return resolve({ ready: false, error: session.error || null });
      }
      setTimeout(check, 100);
    };
    check();
  });
}


// Start session without waiting — returns sessionId immediately
function beginSession(filePath, quality = 'source', audioTrack = 0, seekTime = 0, videoCodec = null, audioCodec = null) {
  if (!HLS_DIR) throw new Error('HLS engine is not initialized');
  const sessionId = getSessionId(filePath, quality, audioTrack, seekTime);

  // Return existing if running
  const existing = sessions.get(sessionId);
  if (existing && existing.proc && existing.proc.exitCode === null && !existing.proc.killed) {
    existing.lastRequest = Date.now();
    console.log(`[HLS] Reusing active session: ${sessionId} (${path.basename(filePath)})`);
    return sessionId;
  }

  // Kill oldest if at limit
  if (sessions.size >= MAX_SESSIONS) {
    let oldest = null, oldestTime = Infinity;
    for (const [id, s] of sessions) {
      if (s.lastRequest < oldestTime) { oldestTime = s.lastRequest; oldest = id; }
    }
    if (oldest) stopSession(oldest);
  }

  const tier = QUALITY_TIERS[quality] || QUALITY_TIERS['source'];
  const encoder = encoderRef?.value || 'libx264';
  // Older Orion scans did not persist videoCodec/audioCodec.  Probe the file
  // here so those entries still get NVDEC rather than silently CPU-decoding.
  const codecs = probeInputCodecs(filePath, videoCodec, audioCodec);
  const effectiveVideoCodec = codecs.video;
  const effectiveAudioCodec = codecs.audio;
  const playbackClaim = reservePlayback(sessionId, tier, effectiveVideoCodec, effectiveAudioCodec);
  const segDir = path.join(HLS_DIR, sessionId);
  if (!fs.existsSync(segDir)) fs.mkdirSync(segDir, { recursive: true });

  // Log the full FFmpeg command for debugging
  const args = ['-hide_banner', '-loglevel', 'error'];
  if (seekTime > 0) args.push('-ss', String(seekTime));
  // H.264 stream-copy sessions do not decode video at all.  Avoid creating a
  // CUDA context for those sessions; that reduces their startup work and
  // leaves the GPU immediately available for HEVC/AV1 transcodes.
  if (needsEncoder(tier, effectiveVideoCodec, effectiveAudioCodec)) {
    args.push(...getNvdecArgs(encoder, effectiveVideoCodec, playbackClaim?.gpuId));
  }
  args.push('-i', filePath);

  const encArgs = getEncoderArgs(encoder, tier, effectiveVideoCodec, effectiveAudioCodec, playbackClaim?.gpuId);
  args.push(...encArgs);

  // Smart audio: copy if already AAC, else re-encode
  const canCopyAudio = effectiveAudioCodec && COPY_AUDIO.has(effectiveAudioCodec.toLowerCase());
  const audioArgs = canCopyAudio
    ? ['-c:a', 'copy']
    : ['-c:a', 'aac', '-b:a', tier.audioBitrate, '-ac', '2', '-ar', '48000'];
  if (canCopyAudio) console.log('[HLS] Audio: stream copy (already AAC)');

  args.push(
    '-map', '0:v:0',
    `-map`, `0:a:${audioTrack}?`,
    ...audioArgs,
    '-f', 'hls',
    '-hls_time', String(SEGMENT_DURATION),
    '-hls_list_size', '0',
    '-hls_flags', 'independent_segments',
    '-hls_segment_type', 'mpegts',
    '-hls_playlist_type', 'event',
    '-hls_segment_filename', path.join(segDir, 'seg%05d.ts'),
    path.join(segDir, 'index.m3u8'),
  );

  console.log(`[HLS] Starting: ${path.basename(filePath)} @ ${quality} encoder=${encoder}`);
  console.log(`[HLS] FFmpeg cmd: ${ffmpegExe} ${args.slice(0, 8).join(' ')}...`);
  console.log(`[HLS] Seg dir: ${segDir}`);
  console.log(`[HLS] FFmpeg exists: ${require('fs').existsSync(ffmpegExe)}`);

  let proc;
  try {
    proc = spawn(ffmpegExe, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (error) {
    if (playbackClaim) playbackCoordinator?.release(playbackClaim.key);
    throw error;
  }
  const session = {
    sessionId, filePath, quality, audioTrack, seekTime,
    videoCodec: effectiveVideoCodec, audioCodec: effectiveAudioCodec,
    proc, segDir, lastRequest: Date.now(),
    pool: getPool(filePath), startedAt: Date.now(), error: null,
    playbackKey: playbackClaim?.key || null,
    gpuId: playbackClaim?.gpuId ?? null,
  };

  let stderrBuf = '';
  proc.stderr.on('data', d => {
    const msg = d.toString().trim();
    stderrBuf += msg;
    if (msg) console.log(`[HLS/ffmpeg] ${msg.slice(0, 300)}`);
    session.error = msg.slice(0, 300);
  });

  proc.on('error', e => {
    releasePlayback(session);
    console.error(`[HLS] Spawn error: ${e.message}`);
  });

  proc.on('exit', (code) => {
    console.log(`[HLS] FFmpeg exited code=${code} stderr=${stderrBuf.slice(-200)}`);
    releasePlayback(session);
    if (sessions.get(sessionId) === session) session.proc = null;
  });

  sessions.set(sessionId, session);
  return sessionId;
}

async function startSession(filePath, quality = 'source', audioTrack = 0, seekTime = 0) {
  const sessionId = beginSession(filePath, quality, audioTrack, seekTime);
  const session = sessions.get(sessionId);
  const ready = await waitForSegments(session.segDir, 2, 30000);
  if (!ready) console.warn(`[HLS] Timeout waiting for segments: ${path.basename(filePath)}`);
  return { sessionId, ready };
}

function stopSession(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return;
  if (s.proc && !s.proc.killed) { try { s.proc.kill('SIGKILL'); } catch {} }
  releasePlayback(s);
  sessions.delete(sessionId);
  setTimeout(() => { try { fs.rmSync(s.segDir, { recursive: true, force: true }); } catch {} }, 3000);
}

function getPlaylist(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return null;
  s.lastRequest = Date.now();
  if (s.playbackKey) playbackCoordinator?.touch(s.playbackKey);
  const p = path.join(s.segDir, 'index.m3u8');
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf-8');
}

function getSegment(sessionId, segmentFile) {
  const s = sessions.get(sessionId);
  if (!s) return null;
  s.lastRequest = Date.now();
  if (s.playbackKey) playbackCoordinator?.touch(s.playbackKey);
  const p = path.join(s.segDir, segmentFile);
  return fs.existsSync(p) ? p : null;
}

function getStatus() {
  const active = Array.from(sessions.values()).map(s => ({
    id: s.sessionId,
    file: path.basename(s.filePath),
    quality: s.quality,
    segments: fs.existsSync(s.segDir) ? fs.readdirSync(s.segDir).filter(f=>f.endsWith('.ts')).length : 0,
    pool: s.pool,
    idleSecs: Math.round((Date.now() - s.lastRequest) / 1000),
    running: !!(s.proc && !s.proc.killed),
    error: s.error,
  }));
  return {
    sessions: active,
    count: active.length,
    max: MAX_SESSIONS,
    cacheDir: HLS_DIR,
    playback: playbackCoordinator?.status?.() || null,
  };
}

function cleanIdleSessions() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastRequest > SESSION_IDLE_MS) {
      console.log(`[HLS] Idle cleanup: ${path.basename(s.filePath)}`);
      stopSession(id);
    }
  }
}

function cleanOldSegments() {
  try {
    if (!HLS_DIR || !fs.existsSync(HLS_DIR)) return;
    const now = Date.now();
    for (const dir of fs.readdirSync(HLS_DIR)) {
      const full = path.join(HLS_DIR, dir);
      try {
        const stat = fs.statSync(full);
        if (stat.isDirectory() && !sessions.has(dir) && now - stat.mtime.getTime() > 3600000) {
          fs.rmSync(full, { recursive: true, force: true });
        }
      } catch {}
    }
  } catch {}
}

module.exports = { init, beginSession, startSession, stopSession, getPlaylist, getSegment, getStatus, waitForPlaylist, QUALITY_TIERS };

'use strict';
/**
 * Orion HLS Streaming Engine
 * Optimized for Windows UNC paths (\\server\share) on spinning rust ZFS
 */

const path   = require('path');
const fs     = require('fs');
const { spawn } = require('child_process');
const crypto = require('crypto');

const SEGMENT_DURATION = 10;
const MAX_SESSIONS     = 20;
const SESSION_IDLE_MS  = 5 * 60 * 1000;

let HLS_DIR    = null;
let ffmpegExe  = 'ffmpeg';
let encoderRef = null;

const sessions = new Map();

const QUALITY_TIERS = {
  '4k':    { scale: null,       videoBitrate: '15000k', audioBitrate: '320k', crf: 18 },
  '1080p': { scale: '1920:-2',  videoBitrate: '8000k',  audioBitrate: '192k', crf: 20 },
  '720p':  { scale: '1280:-2',  videoBitrate: '4000k',  audioBitrate: '128k', crf: 22 },
  '480p':  { scale: '854:-2',   videoBitrate: '2000k',  audioBitrate: '128k', crf: 24 },
  '360p':  { scale: '640:-2',   videoBitrate: '800k',   audioBitrate: '96k',  crf: 26 },
  'source':{ scale: null,       videoBitrate: null,     audioBitrate: '192k', crf: 20 },
};

function init(dataDir, ffmpegPath, encRef) {
  HLS_DIR    = path.join(dataDir, 'hls_cache');
  ffmpegExe  = ffmpegPath || 'ffmpeg';
  encoderRef = encRef;
  if (!fs.existsSync(HLS_DIR)) fs.mkdirSync(HLS_DIR, { recursive: true });
  cleanOldSegments();
  setInterval(cleanIdleSessions, 60000);
  setInterval(cleanOldSegments, 10 * 60 * 1000);
  console.log(`[HLS] Engine initialized. Cache: ${HLS_DIR}`);
}

function getSessionId(filePath, quality) {
  return crypto.createHash('md5').update(filePath + quality).digest('hex').slice(0, 12);
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

function getEncoderArgs(encoder, tier, videoCodecHint, audioCodecHint) {
  const { scale, videoBitrate, crf } = tier;
  const args = [];

  // Smart copy: if video is already H.264 and no scaling needed — copy it
  const canCopyVideo = !scale && videoCodecHint && COPY_VIDEO.has(videoCodecHint.toLowerCase());
  const canCopyAudio = audioCodecHint && COPY_AUDIO.has(audioCodecHint.toLowerCase());

  if (canCopyVideo) {
    args.push('-c:v', 'copy');
    console.log('[HLS] Video: stream copy (already H.264)');
  } else {
    if (scale) args.push('-vf', `scale=${scale}`);
    if (encoder.includes('amf')) {
      args.push('-c:v', encoder, '-quality', 'speed', '-rc', 'cqp', '-qp_i', String(crf), '-qp_p', String(crf + 2));
    } else if (encoder.includes('nvenc')) {
      args.push('-c:v', encoder, '-preset', 'p1', '-rc', 'vbr', '-cq', String(crf));
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
  }

  return args;
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


// Start session without waiting — returns sessionId immediately
function beginSession(filePath, quality = 'source', audioTrack = 0, seekTime = 0, videoCodec = null, audioCodec = null) {
  const sessionId = getSessionId(filePath, quality);

  // Return existing if running
  const existing = sessions.get(sessionId);
  if (existing && existing.proc && !existing.proc.killed) {
    existing.lastRequest = Date.now();
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
  const segDir = path.join(HLS_DIR, sessionId);
  if (!fs.existsSync(segDir)) fs.mkdirSync(segDir, { recursive: true });

  // Log the full FFmpeg command for debugging
  const args = ['-hide_banner', '-loglevel', 'error'];
  if (seekTime > 0) args.push('-ss', String(seekTime));
  args.push('-i', filePath);

  const encArgs = getEncoderArgs(encoder, tier, videoCodec, audioCodec);
  args.push(...encArgs);

  // Smart audio: copy if already AAC, else re-encode
  const canCopyAudio = audioCodec && COPY_AUDIO.has(audioCodec.toLowerCase());
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

  const proc = spawn(ffmpegExe, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  const session = {
    sessionId, filePath, quality, audioTrack, seekTime, videoCodec, audioCodec,
    proc, segDir, lastRequest: Date.now(),
    pool: getPool(filePath), startedAt: Date.now(), error: null,
  };

  let stderrBuf = '';
  proc.stderr.on('data', d => {
    const msg = d.toString().trim();
    stderrBuf += msg;
    if (msg) console.log(`[HLS/ffmpeg] ${msg.slice(0, 300)}`);
    session.error = msg.slice(0, 300);
  });

  proc.on('error', e => console.error(`[HLS] Spawn error: ${e.message}`));

  proc.on('exit', (code) => {
    console.log(`[HLS] FFmpeg exited code=${code} stderr=${stderrBuf.slice(-200)}`);
    if (sessions.get(sessionId) === session) session.proc = null;
  });

  sessions.set(sessionId, session);
  return sessionId;
}

async function startSession(filePath, quality = 'source', audioTrack = 0, seekTime = 0) {
  const sessionId = getSessionId(filePath, quality);

  // Return existing session if still running
  const existing = sessions.get(sessionId);
  if (existing && existing.proc && !existing.proc.killed) {
    existing.lastRequest = Date.now();
    const files = fs.existsSync(existing.segDir) ? fs.readdirSync(existing.segDir).filter(f => f.endsWith('.ts')) : [];
    return { sessionId, ready: files.length >= 2 };
  }

  // Kill oldest idle if at limit
  if (sessions.size >= MAX_SESSIONS) {
    let oldest = null, oldestTime = Infinity;
    for (const [id, s] of sessions) {
      if (s.lastRequest < oldestTime) { oldestTime = s.lastRequest; oldest = id; }
    }
    if (oldest) stopSession(oldest);
  }

  const tier = QUALITY_TIERS[quality] || QUALITY_TIERS['source'];
  const encoder = encoderRef?.value || 'libx264';
  const segDir = path.join(HLS_DIR, sessionId);
  if (!fs.existsSync(segDir)) fs.mkdirSync(segDir, { recursive: true });

  // Build FFmpeg args - try stream copy first, fallback handled by caller
  const args = ['-hide_banner', '-loglevel', 'warning'];

  if (seekTime > 0) args.push('-ss', String(seekTime));
  args.push('-i', filePath);

  // Try codec copy for compatible files — fastest for HDD
  // Will use proper encoding for incompatible containers
  const encArgs = getEncoderArgs(encoder, tier);
  args.push(...encArgs);

  args.push(
    '-map', '0:v:0',
    `-map`, `0:a:${audioTrack}?`,
    '-c:a', 'aac',
    '-b:a', tier.audioBitrate,
    '-ac', '2',
    '-ar', '48000',
    '-f', 'hls',
    '-hls_time', String(SEGMENT_DURATION),
    '-hls_list_size', '0',
    '-hls_flags', 'independent_segments+append_list+discont_start',
    '-hls_segment_type', 'mpegts',
    '-hls_playlist_type', 'event', // 'event' = growing stream, not complete VOD
    '-hls_segment_filename', path.join(segDir, 'seg%05d.ts'),
    path.join(segDir, 'index.m3u8'),
  );

  console.log(`[HLS] Starting: ${path.basename(filePath)} @ ${quality} encoder=${encoder}`);
  console.log(`[HLS] FFmpeg cmd: ${ffmpegExe} ${args.slice(0, 8).join(' ')}...`);
  console.log(`[HLS] Seg dir: ${segDir}`);
  console.log(`[HLS] FFmpeg exists: ${require('fs').existsSync(ffmpegExe)}`);

  const proc = spawn(ffmpegExe, args, { stdio: ['ignore', 'ignore', 'pipe'] });

  const session = {
    sessionId, filePath, quality, audioTrack, seekTime,
    proc, segDir,
    lastRequest: Date.now(),
    pool: getPool(filePath),
    startedAt: Date.now(),
    error: null,
  };

  let stderrBuf = '';
  proc.stderr.on('data', d => {
    const msg = d.toString();
    stderrBuf += msg;
    // Only log actual errors, not progress
    if (msg.includes('Error') || msg.includes('error') || msg.includes('Invalid') || msg.includes('No such')) {
      session.error = msg.trim().slice(0, 200);
      console.error(`[HLS/${sessionId}] ${msg.trim().slice(0, 150)}`);
    }
  });

  proc.on('exit', (code) => {
    if (code && code !== 0 && stderrBuf) {
      console.error(`[HLS] Session ${sessionId} failed (code ${code}): ${stderrBuf.slice(-200)}`);
    } else {
      console.log(`[HLS] Session ${sessionId} complete (code ${code})`);
    }
    if (sessions.get(sessionId) === session) session.proc = null;
  });

  sessions.set(sessionId, session);

  // Wait for first 2 segments using polling (works on UNC paths)
  const ready = await waitForSegments(segDir, 2, 30000);
  if (!ready) console.warn(`[HLS] Timeout waiting for segments: ${path.basename(filePath)}`);
  else console.log(`[HLS] Session ${sessionId} ready (${fs.readdirSync(segDir).filter(f=>f.endsWith('.ts')).length} segs)`);

  return { sessionId, ready };
}

function stopSession(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return;
  if (s.proc && !s.proc.killed) { try { s.proc.kill('SIGKILL'); } catch {} }
  sessions.delete(sessionId);
  setTimeout(() => { try { fs.rmSync(s.segDir, { recursive: true, force: true }); } catch {} }, 3000);
}

function getPlaylist(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return null;
  s.lastRequest = Date.now();
  const p = path.join(s.segDir, 'index.m3u8');
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf-8');
}

function getSegment(sessionId, segmentFile) {
  const s = sessions.get(sessionId);
  if (!s) return null;
  s.lastRequest = Date.now();
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
  return { sessions: active, count: active.length, max: MAX_SESSIONS, cacheDir: HLS_DIR };
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

module.exports = { init, beginSession, startSession, stopSession, getPlaylist, getSegment, getStatus, QUALITY_TIERS };

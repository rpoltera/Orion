'use strict';
/**
 * Orion hardware capability probe.
 *
 * Detects what the machine can actually do, once, at startup, and exposes
 * conservative derived defaults. Everything floors at "works on a potato":
 * 1 worker, CPU encoding, no GPU.
 *
 *   const caps = require('./capabilities');
 *   caps.gpuCount        // 0 on a machine with no NVIDIA card
 *   caps.gpuIds          // [] or [0,1,...]
 *   caps.hasNvenc        // boolean — ffmpeg actually has h264_nvenc
 *   caps.videoEncoder    // 'h264_nvenc' | 'h264_qsv' | 'h264_amf' | 'libx264'
 *   caps.hwaccelArgs(id) // [] or ['-hwaccel','cuda','-hwaccel_device','0',...]
 *   caps.cpuCount
 *   caps.totalMemMB
 *   caps.maxWorkers      // derived, >= 1
 *   caps.maxKeepAlive    // how many always-on channels this box can sustain
 */

const os = require('os');
const { execFileSync } = require('child_process');

function safe(cmd, args, timeout = 4000) {
  try {
    return execFileSync(cmd, args, {
      timeout,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).toString();
  } catch (_) {
    return '';
  }
}

// ── GPU detection ────────────────────────────────────────────────
function detectGpus() {
  const out = safe('nvidia-smi', ['-L']);
  if (!out) return { count: 0, names: [] };
  const names = out.split('\n')
    .map(l => l.trim())
    .filter(l => /^GPU \d+:/.test(l));
  return { count: names.length, names };
}

// ── Encoder detection ────────────────────────────────────────────
function detectEncoders(ffmpegPath) {
  const out = safe(ffmpegPath || 'ffmpeg', ['-hide_banner', '-encoders'], 8000);
  const has = name => out.includes(name);
  return {
    nvenc: has('h264_nvenc'),
    hevcNvenc: has('hevc_nvenc'),
    qsv: has('h264_qsv'),
    amf: has('h264_amf'),
    vaapi: has('h264_vaapi'),
    videotoolbox: has('h264_videotoolbox'),
    x264: has('libx264')
  };
}

function build(ffmpegPath) {
  const gpus = detectGpus();
  const enc = detectEncoders(ffmpegPath);
  const cpuCount = os.cpus().length || 1;
  const totalMemMB = Math.round(os.totalmem() / 1024 / 1024);

  // NVENC is only real if BOTH a card and the encoder are present.
  const hasNvenc = gpus.count > 0 && enc.nvenc;

  let videoEncoder = 'libx264';
  let accel = 'cpu';
  if (hasNvenc)         { videoEncoder = 'h264_nvenc';        accel = 'nvenc'; }
  else if (enc.qsv)     { videoEncoder = 'h264_qsv';          accel = 'qsv'; }
  else if (enc.amf)     { videoEncoder = 'h264_amf';          accel = 'amf'; }
  else if (enc.vaapi)   { videoEncoder = 'h264_vaapi';        accel = 'vaapi'; }
  else if (enc.videotoolbox) { videoEncoder = 'h264_videotoolbox'; accel = 'videotoolbox'; }

  // Worker budget. GPU boxes scale on encoder sessions; CPU boxes on cores.
  // Consumer NVIDIA cards historically cap concurrent NVENC sessions, so
  // stay conservative rather than assuming a datacenter card.
  const gpuWorkers = hasNvenc ? gpus.count * 2 : 0;
  const cpuWorkers = Math.max(1, Math.floor(cpuCount / 4));
  const memWorkers = Math.max(1, Math.floor(totalMemMB / 1024)); // ~1GB/worker
  const maxWorkers = Math.max(1, Math.min(
    hasNvenc ? gpuWorkers : cpuWorkers,
    memWorkers
  ));

  // Always-on channels are far more expensive than batch jobs.
  const maxKeepAlive = hasNvenc
    ? Math.max(1, gpus.count * 2)
    : Math.max(1, Math.floor(cpuCount / 8));

  const caps = {
    gpuCount: gpus.count,
    gpuIds: Array.from({ length: gpus.count }, (_, i) => i),
    gpuNames: gpus.names,
    hasNvenc,
    encoders: enc,
    videoEncoder,
    hwAccel: accel,
    cpuCount,
    totalMemMB,
    maxWorkers,
    maxKeepAlive,

    /** ffmpeg input args for hardware decode, or [] when unavailable. */
    hwaccelArgs(gpuId) {
      if (!hasNvenc) return [];
      const id = Number.isInteger(gpuId) ? gpuId : 0;
      return [
        '-hwaccel', 'cuda',
        '-hwaccel_device', String(id % Math.max(1, gpus.count)),
        '-hwaccel_output_format', 'cuda'
      ];
    },

    /** Clamp any configured GPU id into a range this machine actually has. */
    clampGpu(id) {
      if (gpus.count === 0) return 0;
      const n = parseInt(id, 10);
      return Number.isFinite(n) ? Math.abs(n) % gpus.count : 0;
    },

    summary() {
      return [
        `GPUs: ${gpus.count}${gpus.count ? ' (' + gpus.names.length + ' detected)' : ''}`,
        `encoder: ${videoEncoder}`,
        `accel: ${accel}`,
        `CPU: ${cpuCount} cores`,
        `RAM: ${totalMemMB} MB`,
        `workers: ${maxWorkers}`,
        `keepAlive cap: ${maxKeepAlive}`
      ].join(' | ');
    }
  };

  return caps;
}

let _cached = null;

module.exports = function capabilities(ffmpegPath) {
  if (!_cached) {
    _cached = build(ffmpegPath);
    console.log('[Capabilities]', _cached.summary());
    if (!_cached.hasNvenc && _cached.gpuCount === 0) {
      console.log('[Capabilities] No GPU detected — using CPU encoding. ' +
                  'Expect slower transcodes; worker count reduced accordingly.');
    }
  }
  return _cached;
};

module.exports.rebuild = function (ffmpegPath) {
  _cached = null;
  return module.exports(ffmpegPath);
};

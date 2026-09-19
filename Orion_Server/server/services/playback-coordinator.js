'use strict';

/**
 * In-process playback admission controller.
 *
 * Orion has several FFmpeg entry points (library HLS, direct streaming and
 * StreamForge).  This module is deliberately small: it owns the GPU slot
 * accounting and leaves process lifetime to the caller.  That makes it safe
 * to introduce without changing the existing FFmpeg process model.
 */

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function validGpu(value, count) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 && parsed < count ? parsed : null;
}

class PlaybackCoordinator {
  constructor({ getGpuCount = () => 1, getConfig = () => ({}) } = {}) {
    this.getGpuCount = getGpuCount;
    this.getConfig = getConfig;
    this.claims = new Map();
    this.reservedLiveGpu = null;
    this.gpuLimit = null;
  }

  setGpuLimit(value) {
    const parsed = Number.parseInt(value, 10);
    this.gpuLimit = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    const count = this.limits().gpuCount;
    if (this.reservedLiveGpu !== null && this.reservedLiveGpu >= count) {
      this.reservedLiveGpu = null;
    }
    return this.gpuLimit;
  }

  setReservedLiveGpu(gpuId) {
    const count = this.limits().gpuCount;
    this.reservedLiveGpu = validGpu(gpuId, count);
    return this.reservedLiveGpu;
  }

  limits() {
    let detected = 1;
    try { detected = positiveInt(this.getGpuCount(), 1); } catch (_) {}

    const cfg = this.getConfig?.() || {};
    const transcoding = cfg.transcoding || {};
    const gpuCount = positiveInt(this.gpuLimit ?? transcoding.gpuCount, detected);
    const clampedGpuCount = Math.max(1, Math.min(gpuCount, detected));
    const maxPerGpu = positiveInt(
      transcoding.maxTranscodesPerGpu ?? transcoding.maxPerGpu,
      2,
    );
    const maxConcurrent = positiveInt(
      transcoding.maxConcurrentTranscodes ?? transcoding.maxConcurrentJobs,
      clampedGpuCount * maxPerGpu,
    );

    return { gpuCount: clampedGpuCount, maxPerGpu, maxConcurrent };
  }

  _gpuLoad(gpuId) {
    let count = 0;
    for (const claim of this.claims.values()) {
      if (claim.requiresEncoder && claim.gpuId === gpuId) count++;
    }
    return count;
  }

  acquire({
    key,
    kind = 'playback',
    priority = 'interactive',
    requiresEncoder = true,
    isLive = false,
    preferredGpu = null,
  } = {}) {
    if (!key) throw new Error('Playback claim key is required');

    const existing = this.claims.get(key);
    if (existing) {
      existing.lastSeen = Date.now();
      return { ok: true, reused: true, ...existing };
    }

    const limits = this.limits();
    if (!requiresEncoder) {
      const claim = {
        key, kind, priority, requiresEncoder: false, isLive,
        gpuId: null, startedAt: Date.now(), lastSeen: Date.now(),
      };
      this.claims.set(key, claim);
      return { ok: true, ...claim };
    }

    const activeEncodes = [...this.claims.values()]
      .filter(claim => claim.requiresEncoder).length;
    if (activeEncodes >= limits.maxConcurrent) {
      return {
        ok: false,
        code: 'PLAYBACK_CAPACITY',
        reason: `All ${limits.maxConcurrent} encoder slots are busy`,
        limits,
      };
    }

    const preferred = validGpu(preferredGpu, limits.gpuCount);
    const reserved = validGpu(this.reservedLiveGpu, limits.gpuCount);
    let candidates = Array.from({ length: limits.gpuCount }, (_, id) => id);

    // Preserve a standby GPU for live TV whenever another GPU exists.  Live
    // sessions still prefer that GPU, while VOD is balanced over the rest.
    if (!isLive && reserved !== null && candidates.length > 1) {
      candidates = candidates.filter(id => id !== reserved);
    }
    if (isLive && reserved !== null) {
      candidates = [reserved, ...candidates.filter(id => id !== reserved)];
    }
    if (preferred !== null && candidates.includes(preferred)) {
      candidates = [preferred, ...candidates.filter(id => id !== preferred)];
    }

    candidates.sort((a, b) => this._gpuLoad(a) - this._gpuLoad(b));
    const gpuId = candidates.find(id => this._gpuLoad(id) < limits.maxPerGpu);
    if (gpuId === undefined) {
      return {
        ok: false,
        code: 'PLAYBACK_CAPACITY',
        reason: 'Every compatible GPU encoder slot is busy',
        limits,
      };
    }

    const claim = {
      key, kind, priority, requiresEncoder: true, isLive,
      gpuId, startedAt: Date.now(), lastSeen: Date.now(),
    };
    this.claims.set(key, claim);
    return { ok: true, ...claim };
  }

  touch(key) {
    const claim = this.claims.get(key);
    if (claim) claim.lastSeen = Date.now();
    return Boolean(claim);
  }

  release(key) {
    return this.claims.delete(key);
  }

  status() {
    const limits = this.limits();
    const claims = [...this.claims.values()].map(claim => ({ ...claim }));
    return {
      ...limits,
      reservedLiveGpu: validGpu(this.reservedLiveGpu, limits.gpuCount),
      activeEncodes: claims.filter(claim => claim.requiresEncoder).length,
      gpuLoad: Array.from({ length: limits.gpuCount }, (_, gpuId) => ({
        gpuId,
        encodes: this._gpuLoad(gpuId),
      })),
      claims,
    };
  }
}

module.exports = { PlaybackCoordinator };

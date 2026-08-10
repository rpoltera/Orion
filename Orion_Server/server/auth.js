'use strict';
/**
 * Orion API authentication.
 *
 * Protects the control plane (/api/*) with a bearer token issued at login.
 *
 * NOT protected, by design:
 *   /sf/*  — HLS segments, preseg files, iptv.m3u, xmltv.xml.
 *            Browsers' <video> elements and external players (TiviMate,
 *            VLC) cannot send an Authorization header, so media delivery
 *            stays open. Document this in the README: anyone who can reach
 *            the port can watch streams if they know the URL. Auth stops
 *            configuration changes, not playback.
 *
 * Escape hatch: set ORION_DISABLE_AUTH=1 to bypass everything. Use this if
 * a UI build ships without token support and you lock yourself out.
 */

const crypto = require('crypto');

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// token -> { userId, name, role, expires }
const _tokens = new Map();

// Endpoints reachable without a token. Paths are relative to /api.
const PUBLIC_PATHS = [
  '/health',
  '/setup/status',
  '/setup/init',
  '/auth/login',
  '/library/probe/status',
  '/users'           // GET only — login screen needs names + avatars
];

function isPublic(pathname, method) {
  for (const p of PUBLIC_PATHS) {
    if (pathname === p || pathname.startsWith(p + '?')) {
      // /users is public for GET only; POST/PUT/DELETE require auth
      if (p === '/users' && method !== 'GET') return false;
      return true;
    }
  }
  return false;
}

function issueToken(user) {
  const token = crypto.randomBytes(32).toString('hex');
  _tokens.set(token, {
    userId: user.id,
    name: user.name,
    role: user.role,
    expires: Date.now() + TOKEN_TTL_MS
  });
  persist();   // fix-10: save immediately, not just on the timer
  return token;
}

function revokeToken(token) {
  return _tokens.delete(token);
}

function revokeAllForUser(userId) {
  for (const [t, v] of _tokens) if (v.userId === userId) _tokens.delete(t);
}

function lookup(token) {
  const rec = _tokens.get(token);
  if (!rec) return null;
  if (Date.now() > rec.expires) { _tokens.delete(token); return null; }
  return rec;
}

/** Persist tokens across restarts via the caller's saveDB mechanism. */
function serialize() {
  return Array.from(_tokens.entries())
    .filter(([, v]) => Date.now() < v.expires);
}
function restore(entries) {
  if (!Array.isArray(entries)) return 0;
  let n = 0;
  for (const [t, v] of entries) {
    if (v && Date.now() < v.expires) { _tokens.set(t, v); n++; }
  }
  return n;
}

function middleware(req, res, next) {
  if (process.env.ORION_DISABLE_AUTH === '1') return next();

  // req.path here is relative to the /api mount point.
  if (isPublic(req.path, req.method)) return next();

  // Reads are open; mutations require a token. This closes the real
  // risk (a hostile page silently reconfiguring the server) without
  // breaking the many GETs the UI performs before login.
  // Set ORION_STRICT_AUTH=1 to require a token for reads as well.
  if (process.env.ORION_STRICT_AUTH !== '1' &&
      (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS')) {
    return next();
  }

  // Internal scheduler calls: loopback only, never proxied from outside.
  if (req.headers['x-orion-internal'] === '1') {
    const ip = req.ip || req.connection?.remoteAddress || '';
    if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') {
      return next();
    }
  }

  const hdr = req.headers.authorization || '';
  const token = hdr.startsWith('Bearer ')
    ? hdr.slice(7).trim()
    : (req.query.token || '');

  const rec = token ? lookup(token) : null;
  if (!rec) {
    return res.status(401).json({ error: 'Authentication required', code: 'NO_AUTH' });
  }

  req.orionUser = rec;
  next();
}

/** Drop expired tokens hourly. */
setInterval(() => {
  const now = Date.now();
  for (const [t, v] of _tokens) if (now > v.expires) _tokens.delete(t);
}, 60 * 60 * 1000).unref?.();

// ── Persistence (fix-10) ─────────────────────────────────────────
// Without this every restart invalidates all sessions, which during
// active development means being logged out constantly.
const _fsMod = require('fs');
const _pathMod = require('path');

function _tokenStorePath() {
  const dir = process.env.ORION_DATA_DIR || '/var/lib/orion';
  return _pathMod.join(dir, 'auth-tokens.json');
}

function persist() {
  try {
    const file = _tokenStorePath();
    _fsMod.mkdirSync(_pathMod.dirname(file), { recursive: true });
    _fsMod.writeFileSync(file, JSON.stringify(serialize()), { mode: 0o600 });
  } catch (e) {
    console.error('[Auth] could not persist tokens:', e.message);
  }
}

function loadPersisted() {
  try {
    const file = _tokenStorePath();
    if (!_fsMod.existsSync(file)) return 0;
    const n = restore(JSON.parse(_fsMod.readFileSync(file, 'utf8')));
    if (n) console.log('[Auth] restored ' + n + ' active session(s)');
    return n;
  } catch (e) {
    console.error('[Auth] could not load tokens:', e.message);
    return 0;
  }
}

// Restore at module load, and flush periodically so a hard kill loses
// at most a few minutes of newly-issued tokens.
loadPersisted();
const _flush = setInterval(persist, 5 * 60 * 1000);
_flush.unref?.();
process.on('SIGTERM', persist);
process.on('SIGINT', persist);

module.exports = {
  middleware,
  persist,
  loadPersisted,
  issueToken,
  revokeToken,
  revokeAllForUser,
  lookup,
  serialize,
  restore,
  PUBLIC_PATHS,
  TOKEN_TTL_MS
};

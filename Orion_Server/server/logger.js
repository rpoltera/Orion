'use strict';
/**
 * Orion Logger
 * Centralized logging with levels and slow-request tracking
 */

let debugEnabled = false;
const SLOW_THRESHOLD_MS = 1000;

function setDebug(enabled) { debugEnabled = !!enabled; }
function isDebug()         { return debugEnabled; }

function log(level, ...args) {
  const ts = new Date().toISOString().slice(11, 23);
  if (level === 'DEBUG' && !debugEnabled) return;
  const prefix = {
    INFO:  '',
    DEBUG: '[DEBUG]',
    WARN:  '[WARN]',
    ERROR: '[ERROR]',
    SLOW:  '[Slow]',
  }[level] || '';
  console.log(prefix, ...args);
}

const info  = (...a) => log('INFO',  ...a);
const debug = (...a) => log('DEBUG', ...a);
const warn  = (...a) => log('WARN',  ...a);
const error = (...a) => log('ERROR', ...a);

// Express middleware — logs every request in debug mode, slow requests always
function requestLogger(req, res, next) {
  const start = Date.now();
  if (debugEnabled) {
    const body = req.method !== 'GET' ? {} : undefined;
    console.log('[DEBUG]', req.method, req.path, body || req.query);
  }
  res.on('finish', () => {
    const ms = Date.now() - start;
    if (ms >= SLOW_THRESHOLD_MS) {
      console.log(`[Slow] ${req.method} ${req.path} took ${ms}ms`);
    }
  });
  next();
}

module.exports = { info, debug, warn, error, requestLogger, setDebug, isDebug };

'use strict';
/**
 * Orion Users Routes
 * /api/auth/*, /api/users/*, /api/groups/*, /api/setup/*
 */

const express = require('express');
const crypto  = require('crypto');
const { v4: uuidv4 } = require('uuid');

const RATING_ORDER = ['G','TV-G','TV-Y','TV-Y7','PG','TV-PG','PG-13','TV-14','R','TV-MA','NC-17','NR','UNRATED'];

function hashPin(pin) {
  return crypto.createHash('sha256').update(pin + 'orion_salt_2024').digest('hex');
}

// Brute force protection
const _loginAttempts = new Map();
function checkBruteForce(ip) {
  const a = _loginAttempts.get(ip) || { count: 0, lockedUntil: 0 };
  if (Date.now() < a.lockedUntil) return { locked: true, remaining: Math.ceil((a.lockedUntil - Date.now()) / 1000) };
  return { locked: false };
}
function recordLoginFailure(ip) {
  const a = _loginAttempts.get(ip) || { count: 0, lockedUntil: 0 };
  a.count++;
  if (a.count >= 10) a.lockedUntil = Date.now() + 15 * 60 * 1000;
  else if (a.count >= 5) a.lockedUntil = Date.now() + 60 * 1000;
  _loginAttempts.set(ip, a);
}
function recordLoginSuccess(ip) { _loginAttempts.delete(ip); }
setInterval(() => { const now = Date.now(); for (const [k,v] of _loginAttempts) if (now > v.lockedUntil + 60000 && v.count < 5) _loginAttempts.delete(k); }, 60 * 60 * 1000);

module.exports = function usersRoutes({ db, io, saveDB }) {
  const router = express.Router();

  // ── Setup ────────────────────────────────────────────────────────────────────
  router.get('/setup/status', (_, res) => res.json({ needsSetup: db.users.length === 0 }));

  router.post('/setup/init', (req, res) => {
    if (db.users.length > 0) return res.status(403).json({ error: 'Setup already completed' });
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    if (username.length < 2) return res.status(400).json({ error: 'Username must be at least 2 characters' });
    if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
    const admin = {
      id: uuidv4(), name: username, password: hashPin(password),
      role: 'admin', avatar: '👑', groupIds: [],
      mediaAccess: { all: true, movies: [], tvShows: [], collections: [] },
      createdAt: new Date().toISOString(),
    };
    db.users.push(admin);
    saveDB();
    console.log(`[Setup] Admin account created for: ${username}`);
    res.json({ ok: true, user: { ...admin, password: undefined } });
  });

  // ── Auth ──────────────────────────────────────────────────────────────────────
  router.post('/auth/login', (req, res) => {
    const ip = req.ip;
    const bf = checkBruteForce(ip);
    if (bf.locked) return res.status(429).json({ error: `Too many failed attempts. Try again in ${bf.remaining}s` });
    const { name, password, pin } = req.body;
    const credential = password || pin;
    if (!name || !credential) return res.status(400).json({ error: 'Username and password required' });
    const user = db.users.find(u => u.name.toLowerCase() === name.toLowerCase());
    if (!user) { recordLoginFailure(ip); return res.status(401).json({ error: 'Invalid username or password' }); }
    const storedHash = user.password || user.pin;
    if (storedHash !== hashPin(String(credential))) { recordLoginFailure(ip); return res.status(401).json({ error: 'Invalid username or password' }); }
    recordLoginSuccess(ip);
    res.json({ ok: true, user: { ...user, password: undefined, pin: undefined } });
  });

  // ── Content ratings ───────────────────────────────────────────────────────────
  router.get('/content-ratings', (_, res) => res.json({ ratings: RATING_ORDER }));

  // ── Users ─────────────────────────────────────────────────────────────────────
  router.get('/users', (_, res) => res.json({ users: db.users.map(u => ({ ...u, pin: undefined, password: undefined })) }));

  router.get('/users/:id', (req, res) => {
    const user = db.users.find(u => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: 'Not found' });
    res.json({ ...user, pin: undefined, password: undefined });
  });

  router.post('/users', (req, res) => {
    const { name, password, pin, role, avatar, groupIds, mediaAccess, maxRating } = req.body;
    const credential = password || pin;
    if (!name || !credential) return res.status(400).json({ error: 'name and password required' });
    if (db.users.find(u => u.name.toLowerCase() === name.toLowerCase())) return res.status(409).json({ error: 'User already exists' });
    const user = {
      id: uuidv4(), name, password: hashPin(String(credential)),
      role: role || 'user', avatar: avatar || '👤',
      groupIds: groupIds || [],
      mediaAccess: mediaAccess || { all: false, movies: [], tvShows: [], collections: [] },
      maxRating: maxRating || null,
      createdAt: new Date().toISOString(),
    };
    db.users.push(user);
    saveDB();
    res.json({ ...user, password: undefined });
  });

  router.put('/users/:id', (req, res) => {
    const idx = db.users.findIndex(u => u.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    const { password, pin, ...updates } = req.body;
    const credential = password || pin;
    if (credential) updates.password = hashPin(String(credential));
    db.users[idx] = { ...db.users[idx], ...updates };
    saveDB();
    res.json({ ...db.users[idx], password: undefined, pin: undefined });
  });

  router.delete('/users/:id', (req, res) => {
    if (req.params.id === 'admin') return res.status(403).json({ error: 'Cannot delete admin' });
    db.users = db.users.filter(u => u.id !== req.params.id);
    saveDB();
    res.json({ ok: true });
  });

  router.put('/users/:id/access', (req, res) => {
    const user = db.users.find(u => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: 'Not found' });
    user.mediaAccess = { ...user.mediaAccess, ...req.body };
    saveDB();
    res.json({ ok: true, mediaAccess: user.mediaAccess });
  });

  router.get('/users/:id/library', (req, res) => {
    const user = db.users.find(u => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: 'Not found' });
    if (user.role === 'admin' || user.mediaAccess?.all) {
      return res.json({ movies: db.movies, tvShows: db.tvShows, music: db.music, musicVideos: db.musicVideos, collections: db.collections });
    }
    const groupAccess = (db.groups || [])
      .filter(g => (user.groupIds || []).includes(g.id))
      .reduce((acc, g) => {
        acc.movies      = [...acc.movies,      ...(g.mediaAccess?.movies      || [])];
        acc.tvShows     = [...acc.tvShows,     ...(g.mediaAccess?.tvShows     || [])];
        acc.collections = [...acc.collections, ...(g.mediaAccess?.collections || [])];
        acc.music       = [...acc.music,       ...(g.mediaAccess?.music       || [])];
        if (g.mediaAccess?.all) acc.all = true;
        return acc;
      }, { all: false, movies: [], tvShows: [], collections: [], music: [] });

    if (groupAccess.all) return res.json({ movies: db.movies, tvShows: db.tvShows, music: db.music, musicVideos: db.musicVideos, collections: db.collections });

    const allowed = {
      movies:      [...new Set([...(user.mediaAccess?.movies      || []), ...groupAccess.movies])],
      tvShows:     [...new Set([...(user.mediaAccess?.tvShows     || []), ...groupAccess.tvShows])],
      music:       [...new Set([...(user.mediaAccess?.music       || []), ...groupAccess.music])],
      collections: [...new Set([...(user.mediaAccess?.collections || []), ...groupAccess.collections])],
    };
    res.json({
      movies:      db.movies.filter(m => allowed.movies.includes(m.id)),
      tvShows:     db.tvShows.filter(m => allowed.tvShows.includes(m.id)),
      music:       db.music.filter(m => allowed.music.includes(m.id)),
      musicVideos: db.musicVideos.filter(m => allowed.music.includes(m.id)),
      collections: db.collections.filter(c => allowed.collections.includes(c.id)),
    });
  });

  // ── Groups ────────────────────────────────────────────────────────────────────
  router.get('/groups', (_, res) => res.json({ groups: db.groups || [] }));

  router.post('/groups', (req, res) => {
    const { name, color, mediaAccess } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const group = {
      id: uuidv4(), name, color: color || '#0063e5',
      mediaAccess: mediaAccess || { all: false, movies: [], tvShows: [], collections: [], music: [] },
      createdAt: new Date().toISOString(),
    };
    if (!db.groups) db.groups = [];
    db.groups.push(group);
    saveDB();
    res.json(group);
  });

  router.put('/groups/:id', (req, res) => {
    const idx = (db.groups || []).findIndex(g => g.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    db.groups[idx] = { ...db.groups[idx], ...req.body };
    saveDB();
    res.json(db.groups[idx]);
  });

  router.put('/groups/:id/access', (req, res) => {
    const group = (db.groups || []).find(g => g.id === req.params.id);
    if (!group) return res.status(404).json({ error: 'Not found' });
    group.mediaAccess = { ...group.mediaAccess, ...req.body };
    saveDB();
    res.json({ ok: true, mediaAccess: group.mediaAccess });
  });

  router.delete('/groups/:id', (req, res) => {
    db.groups = (db.groups || []).filter(g => g.id !== req.params.id);
    db.users.forEach(u => { u.groupIds = (u.groupIds || []).filter(id => id !== req.params.id); });
    saveDB();
    res.json({ ok: true });
  });

  return router;
};

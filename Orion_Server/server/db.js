'use strict';
/**
 * Orion DB Module
 * Wraps OrionDB (better-sqlite3) with the in-memory db object
 * Single source of truth — no more library.json
 */

const OrionDB = require('./database');
const { PATHS } = require('./config');
const logger   = require('./logger');

// ── In-memory database object ─────────────────────────────────────────────────
const db = {
  movies:         [],
  tvShows:        [],
  music:          [],
  musicVideos:    [],
  iptvChannels:   [],
  collections:    [],
  categories:     [],
  prerolls:       [],
  prerollEnabled: false,
  lastUpdated:    null,
  users:          [],
  groups:         [],
  scheduledTasks: [],
  activityLog:    [],
  libraryPaths:   { movies: [], tvShows: [], music: [], musicVideos: [] },
  customLibraries:[],
};

// ── Indexes for fast lookups ──────────────────────────────────────────────────
const _idx = { movies: new Map(), tvShows: new Map(), music: new Map(), musicVideos: new Map() };
const _showNameIndex = new Map(); // showName -> [indices into db.tvShows]

function rebuildShowIndex() {
  _showNameIndex.clear();
  db.tvShows.forEach((ep, i) => {
    const name = ep.seriesTitle || ep.showName || '';
    if (!name) return;
    if (!_showNameIndex.has(name)) _showNameIndex.set(name, []);
    _showNameIndex.get(name).push(i);
  });
}

function rebuildIndex(type) {
  if (!db[type]) return;
  _idx[type] = new Map();
  db[type].forEach((item, i) => _idx[type].set(item.id, i));
  if (type === 'tvShows') rebuildShowIndex();
}

function buildAllIndexes() {
  for (const type of ['movies', 'tvShows', 'music', 'musicVideos']) rebuildIndex(type);
}

// ── Save ──────────────────────────────────────────────────────────────────────
let _saveTimer = null;

function saveDB(immediate = false, dirtyTable = null) {
  if (dirtyTable) OrionDB.markDirty(dirtyTable);
  else OrionDB.markAllDirty();

  if (immediate) {
    if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
    if (OrionDB.isConnected()) OrionDB.saveDirtyTables(db);
    return;
  }
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    if (OrionDB.isConnected()) OrionDB.saveDirtyTables(db);
  }, 2000);
}

// ── Load ──────────────────────────────────────────────────────────────────────
async function loadDB() {
  const ok = OrionDB.initSQLite(PATHS.DATA_DIR);
  if (ok) {
    OrionDB.migrateFromJSON(PATHS.DB_FILE, db);
    const loaded = OrionDB.loadFromSQLite();
    if (loaded) {
      Object.assign(db, loaded);
      // Ensure required arrays exist
      for (const k of ['movies','tvShows','music','musicVideos','collections','users','groups','scheduledTasks','activityLog','categories','prerolls']) {
        if (!Array.isArray(db[k])) db[k] = [];
      }
      if (!db.libraryPaths) db.libraryPaths = { movies:[], tvShows:[], music:[], musicVideos:[] };
      if (!db.customLibraries) db.customLibraries = [];
    }
  }
  buildAllIndexes();
  logger.info(`[DB] Loaded — Movies: ${db.movies.length}, TV: ${db.tvShows.length}`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function findById(type, id)    { const i = _idx[type]?.get(id); return i !== undefined ? db[type][i] : null; }
function findIdxById(type, id) { const i = _idx[type]?.get(id); return i !== undefined ? i : -1; }

function getEpisodesByShow(showName) {
  const idxs = _showNameIndex.get(showName);
  if (idxs) return idxs.map(i => db.tvShows[i]);
  return db.tvShows.filter(ep => (ep.seriesTitle || ep.showName) === showName);
}

function invalidateAllCaches() {
  OrionDB.markAllDirty();
}

module.exports = {
  db,
  loadDB,
  saveDB,
  rebuildIndex,
  rebuildShowIndex,
  buildAllIndexes,
  findById,
  findIdxById,
  getEpisodesByShow,
  invalidateAllCaches,
  _idx,
  _showNameIndex,
};

'use strict';
/**
 * Orion Database Layer — better-sqlite3
 * Keeps data on disk, WAL mode, synchronous API — much lower RAM than sql.js
 */

const path = require('path');
const fs   = require('fs');

let db_conn = null;
let _dirty  = {};
let _dbPath = null;
let _stmts  = null;

const ARRAY_TABLES = [
  'movies', 'tvShows', 'music', 'musicVideos',
  'iptvChannels', 'collections', 'categories',
  'prerolls', 'users', 'groups', 'scheduledTasks', 'activityLog',
];

const OBJECT_TABLES = ['libraryPaths'];

function initSQLite(dataDir) {
  let Database;
  try {
    Database = require('better-sqlite3');
  } catch (e) {
    console.warn('[DB] better-sqlite3 not found — run: npm install better-sqlite3');
    return false;
  }

  _dbPath = path.join(dataDir, 'orion.db');

  try {
    db_conn = new Database(_dbPath);

    // WAL mode for concurrent reads + writes, data always on disk
    db_conn.pragma('journal_mode = WAL');
    db_conn.pragma('synchronous = NORMAL');   // safe with WAL, faster than FULL
    db_conn.pragma('cache_size = -32000');    // 32MB page cache
    db_conn.pragma('temp_store = MEMORY');
    db_conn.pragma('mmap_size = 268435456'); // 256MB memory-mapped I/O

    db_conn.exec(`
      CREATE TABLE IF NOT EXISTS kv_arrays  (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '[]');
      CREATE TABLE IF NOT EXISTS kv_objects (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '{}');
      CREATE TABLE IF NOT EXISTS meta       (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS item_details (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_item_details_id ON item_details(id);
    `);

    const insertArr = db_conn.prepare(`INSERT OR IGNORE INTO kv_arrays  (key,value) VALUES (?,'[]')`);
    const insertObj = db_conn.prepare(`INSERT OR IGNORE INTO kv_objects (key,value) VALUES (?,'{}')`);
    for (const t of ARRAY_TABLES)  insertArr.run(t);
    for (const t of OBJECT_TABLES) insertObj.run(t);

    console.log(`[DB] better-sqlite3 opened: ${_dbPath}`);
    return true;
  } catch (e) {
    console.error('[DB] open error:', e.message);
    db_conn = null;
    return false;
  }
}

function loadFromSQLite() {
  if (!db_conn) return null;
  try {
    const result = {};
    for (const { key, value } of db_conn.prepare('SELECT key, value FROM kv_arrays').all()) {
      try { result[key] = JSON.parse(value) || []; } catch { result[key] = []; }
    }
    for (const { key, value } of db_conn.prepare('SELECT key, value FROM kv_objects').all()) {
      try { result[key] = JSON.parse(value) || {}; } catch { result[key] = {}; }
    }
    const meta = db_conn.prepare(`SELECT value FROM meta WHERE key='lastUpdated'`).get();
    if (meta) result.lastUpdated = meta.value;
    console.log(`[DB] Loaded — Movies: ${result.movies?.length||0}, TV: ${result.tvShows?.length||0}`);
    return result;
  } catch (e) {
    console.error('[DB] load error:', e.message);
    return null;
  }
}

function markDirty(table) { _dirty[table] = true; }
function hasDirty()       { return Object.values(_dirty).some(Boolean); }
function markAllDirty()   { for (const t of [...ARRAY_TABLES, ...OBJECT_TABLES]) _dirty[t] = true; }

function getStmts() {
  if (!_stmts && db_conn) {
    _stmts = {
      upsertArr:    db_conn.prepare(`INSERT OR REPLACE INTO kv_arrays    (key,value) VALUES (?,?)`),
      upsertObj:    db_conn.prepare(`INSERT OR REPLACE INTO kv_objects   (key,value) VALUES (?,?)`),
      upsertMeta:   db_conn.prepare(`INSERT OR REPLACE INTO meta         (key,value) VALUES (?,?)`),
      getArr:       db_conn.prepare(`SELECT value FROM kv_arrays WHERE key=?`),
      getDetail:    db_conn.prepare(`SELECT value FROM item_details WHERE id=?`),
      upsertDetail: db_conn.prepare(`INSERT OR REPLACE INTO item_details (id,value)  VALUES (?,?)`),
    };
  }
  return _stmts;
}

function saveDirtyTables(db) {
  if (!db_conn) return;
  const tables = Object.keys(_dirty).filter(k => _dirty[k]);
  if (!tables.length) return;
  const stmts = getStmts();
  const run = db_conn.transaction(() => {
    for (const t of tables) {
      if (ARRAY_TABLES.includes(t))       stmts.upsertArr.run(t, JSON.stringify(db[t] || []));
      else if (OBJECT_TABLES.includes(t)) stmts.upsertObj.run(t, JSON.stringify(db[t] || {}));
    }
    stmts.upsertMeta.run('lastUpdated', new Date().toISOString());
  });
  try { run(); _dirty = {}; }
  catch (e) { console.error('[DB] save error:', e.message); }
}

function saveAll(db) {
  if (!db_conn) return;
  markAllDirty();
  saveDirtyTables(db);
}

function migrateFromJSON(jsonPath, db) {
  if (!db_conn || !fs.existsSync(jsonPath)) return;
  const done = db_conn.prepare(`SELECT value FROM meta WHERE key='migrated_from_json'`).get();
  if (done) return;
  try {
    console.log('[DB] Migrating from JSON to SQLite...');
    const json = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    for (const k of Object.keys(json)) if (db[k] !== undefined) db[k] = json[k];
    markAllDirty();
    saveDirtyTables(db);
    db_conn.prepare(`INSERT OR REPLACE INTO meta (key,value) VALUES ('migrated_from_json',?)`).run(new Date().toISOString());
    const bak = jsonPath.replace('.json', '.json.bak');
    fs.renameSync(jsonPath, bak);
    console.log(`[DB] Migration complete. Backed up to: ${bak}`);
  } catch (e) {
    console.error('[DB] migration error:', e.message);
  }
}

function backup(dataDir) {
  if (!db_conn) return null;
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const p  = path.join(dataDir, `orion-backup-${ts}.db`);
    db_conn.backup(p)
      .then(() => console.log(`[DB] Backup complete: ${p}`))
      .catch(e => console.error('[DB] backup error:', e.message));
    return p;
  } catch (e) {
    console.error('[DB] backup error:', e.message);
    return null;
  }
}

function optimize() {
  if (!db_conn) return false;
  try {
    db_conn.pragma('optimize');
    db_conn.exec('VACUUM');
    db_conn.exec('ANALYZE');
    console.log('[DB] Optimized (VACUUM + ANALYZE)');
    return true;
  } catch (e) {
    console.error('[DB] optimize error:', e.message);
    return false;
  }
}

function getDetail(id) {
  if (!db_conn) return null;
  try {
    const row = getStmts().getDetail.get(id);
    return row ? JSON.parse(row.value) : null;
  } catch { return null; }
}

function setDetail(id, data) {
  if (!db_conn) return;
  try { getStmts().upsertDetail.run(id, JSON.stringify(data)); } catch {}
}

function close() {
  if (db_conn) {
    try { db_conn.close(); } catch {}
    db_conn = null;
    _stmts  = null;
  }
}

function isConnected() { return !!db_conn; }
function _db()         { return db_conn; }

module.exports = {
  initSQLite, loadFromSQLite, migrateFromJSON,
  markDirty, markAllDirty, hasDirty,
  saveDirtyTables, saveAll,
  backup, optimize, close, isConnected, _db,
  getDetail, setDetail,
  ARRAY_TABLES, OBJECT_TABLES,
};

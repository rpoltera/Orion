# Orion Server — Refactor Migration Plan

## Current State
- `server/index.js` — 9,700 lines, everything in one file
- `server/database.js` — SQLite layer (good, keep as-is)
- `server/hls.js` — HLS engine (keep as-is)
- Data stored as JSON blobs in SQLite `kv_arrays`/`kv_objects` tables

## Target State
```
server/
  index.js              ← entry point only (~60 lines) ✅ DONE
  config.js             ← config load/save/paths      ✅ DONE
  logger.js             ← centralized logging          ✅ DONE
  db.js                 ← in-memory db + SQLite        ✅ DONE
  database.js           ← SQLite driver (unchanged)
  hls.js                ← HLS engine (unchanged)
  services/
    scanner.js          ← file scanning, dedup         ✅ DONE
    metadata.js         ← TMDB/OMDb/TVMaze             🔲 TODO
    trailers.js         ← trailer download/serve       🔲 TODO
    images.js           ← poster/backdrop caching      🔲 TODO
    autoScan.js         ← folder watcher               🔲 TODO
  routes/
    library.js          ← /api/library/*               🔲 TODO
    metadata.js         ← /api/tmdb/*, /api/omdb/*     🔲 TODO
    stream.js           ← /api/stream/*, HLS           🔲 TODO
    users.js            ← /api/users/*, auth           🔲 TODO
    scanner.js          ← /api/library/scan            🔲 TODO
    collections.js      ← /api/collections/*           🔲 TODO
    scheduler.js        ← /api/scheduler/*             🔲 TODO
    settings.js         ← /api/config, /api/settings   🔲 TODO
    trailers.js         ← /api/ytdlp/*, trailer routes 🔲 TODO
```

## Migration Strategy
**DO NOT break the running server during migration.**

Each route module follows this pattern:
```js
// routes/library.js
module.exports = function(db, io, config) {
  const router = require('express').Router();
  // ... routes ...
  return router;
};
```

The current `index.js` stays running until all routes are extracted.
Then swap `server/index.js` with `server/index_new.js`.

## Route Extraction Order (by complexity, lowest first)
1. `routes/settings.js`    — /api/config, /api/settings (simple CRUD)
2. `routes/users.js`       — /api/users/*, auth
3. `routes/collections.js` — /api/collections/*
4. `routes/scanner.js`     — /api/library/scan, /api/library/:type/scan
5. `routes/library.js`     — /api/library/:type (largest, most complex)
6. `routes/metadata.js`    — /api/tmdb/*, /api/omdb/*
7. `routes/trailers.js`    — /api/ytdlp/*, /api/tv-trailer-file
8. `routes/stream.js`      — /api/stream/*, HLS

## Database Future (Phase 2)
Currently: JSON blobs in SQLite kv_arrays/kv_objects
Future: Proper relational tables with real columns

Benefits of proper tables:
- Real SQL queries (WHERE, ORDER BY, JOIN)
- Proper indexes on filePath, title, year, tmdbId
- Much faster search and filtering
- No JSON parsing on every read

Schema will be designed AFTER route extraction is complete.

## Session Log
- Session 1: Created config.js, logger.js, db.js, services/scanner.js, index.js skeleton
- Session 2: TODO — services/metadata.js, routes/settings.js, routes/users.js

// ═══════════════════════════════════════════════════════════════════════════
// ADD THE FOLLOWING BLOCK TO server/routes/library.js
// Placement: just before the final  return router;  line.
// All three routes use:  db, rebuildIndex, saveDB, queueMetadata,
//   scanDirectory, io  — which are already in deps for library.js.
// ═══════════════════════════════════════════════════════════════════════════

// ── POST /api/library/tvShows/refreshShow ─────────────────────────────────
// Re-queues metadata for every episode in a show.
// Body: { showName: string, tmdbId?: number }
// The metadata service fetches per-show (not per-episode), so queueing one
// representative episode is enough — same pattern as the metadata reset.

router.post('/tvShows/refreshShow', (req, res) => {
  const { showName, tmdbId } = req.body || {};
  if (!showName) return res.status(400).json({ error: 'showName required' });

  const episodes = db.tvShows.filter(
    ep => (ep.seriesTitle || ep.showName) === showName
  );
  if (!episodes.length) return res.status(404).json({ error: 'Show not found' });

  // Clear metadataFetched so queue picks them up; optionally pin a new tmdbId
  episodes.forEach(ep => {
    ep.metadataFetched = false;
    if (tmdbId) ep.tmdbId = String(tmdbId);
  });

  // Queue ONE representative episode (fetchTVMeta enriches all by show name)
  queueMetadata([episodes[0]], 'tvShows');
  saveDB(false);

  res.json({ ok: true, showName, episodes: episodes.length, queued: 1 });
});

// ── POST /api/library/tvShows/scanFolder ──────────────────────────────────
// Scans a single folder and adds new episodes found to the library.
// Body: { folderPath: string }   ← must be a UNC path

router.post('/tvShows/scanFolder', async (req, res) => {
  const { folderPath } = req.body || {};
  if (!folderPath) return res.status(400).json({ error: 'folderPath required' });
  if (/^[A-Za-z]:[\\\/]/.test(folderPath)) {
    return res.status(400).json({ error: 'Use UNC paths only (\\\\server\\share\\...)' });
  }

  try {
    const found = await scanDirectory(folderPath, 'tvShows', {
      onProgress: msg => io.emit('scan:progress', { status: msg }),
    });

    const existingPaths = new Set(db.tvShows.map(ep => ep.filePath));
    const added = found.filter(item => !existingPaths.has(item.filePath));

    if (added.length) {
      db.tvShows.push(...added);
      rebuildIndex('tvShows');
      saveDB(true, 'tvShows');
    }

    io.emit('scan:complete', { type: 'tvShows', added: added.length, total: db.tvShows.length });
    res.json({ ok: true, added: added.length, total: db.tvShows.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/library/tvShows/deleteShow ──────────────────────────────────
// Removes all DB records for a show (does NOT delete files from disk).
// Body: { showName: string }
// NOTE: TVShowsPage calls this as POST with a JSON body. The existing
//   DELETE /api/library/tvShows/show/:showName route also deletes disk files.
//   This POST endpoint is DB-removal only — safer for the UI call path.

router.post('/tvShows/deleteShow', (req, res) => {
  const { showName } = req.body || {};
  if (!showName) return res.status(400).json({ error: 'showName required' });

  const before = db.tvShows.length;
  db.tvShows = db.tvShows.filter(
    ep => (ep.seriesTitle || ep.showName) !== showName
  );
  const removed = before - db.tvShows.length;

  rebuildIndex('tvShows');
  saveDB(true, 'tvShows');
  if (typeof invalidateGroupedCache === 'function') invalidateGroupedCache();

  res.json({ ok: true, showName, removed });
});

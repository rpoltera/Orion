// ═══════════════════════════════════════════════════════════════════════════
// ADD TO server/index_new.js  — inside start(), after the existing route
// mounts (after the  api.use('/', require('./routes/trailers')(deps()));  line)
// ═══════════════════════════════════════════════════════════════════════════

// ── Images / clearlogos / season posters / screenshots ─────────────────────
api.use('/', require('./routes/images')(deps()));

// ── StreamForge IPTV engine (/api/sf/*) ────────────────────────────────────
// streamforge.js exists on disk but was never mounted. This mounts it
// conditionally so a missing/broken streamforge.js won't crash startup.
try {
  const sfFile = path.join(__dirname, 'streamforge.js');
  if (require('fs').existsSync(sfFile)) {
    api.use('/sf', require('./streamforge')(deps()));
    console.log('[StreamForge] Mounted at /api/sf');
  } else {
    console.log('[StreamForge] streamforge.js not found — skipping mount');
  }
} catch (e) {
  console.warn('[StreamForge] Failed to mount:', e.message);
}

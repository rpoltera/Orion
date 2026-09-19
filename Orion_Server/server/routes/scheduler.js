'use strict';
/**
 * Orion Scheduler Routes
 * /api/scheduler/*, /api/custom-libraries/*
 */

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const { v4: uuidv4 } = require('uuid');

module.exports = function schedulerRoutes({ db, io, saveDB, runTask, PATHS }) {
  const router = express.Router();

  // ── Scheduler ─────────────────────────────────────────────────────────────────
  router.get('/scheduler', (_, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ tasks: db.scheduledTasks || [] });
  });

  router.post('/scheduler', (req, res) => {
    const tasks = Array.isArray(req.body) ? req.body : [req.body];
    if (!db.scheduledTasks) db.scheduledTasks = [];
    for (const task of tasks) {
      if (!task.name) continue;
      // Don't add duplicates
      if (db.scheduledTasks.find(t => t.name === task.name)) continue;
      db.scheduledTasks.push({ id: uuidv4(), ...task });
    }
    saveDB(true, 'scheduledTasks');
    res.json({ tasks: db.scheduledTasks });
  });

  router.delete('/scheduler/:id', (req, res) => {
    const idx = (db.scheduledTasks||[]).findIndex(t => t.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Task not found' });
    db.scheduledTasks.splice(idx, 1);
    saveDB(true, 'scheduledTasks');
    res.json({ ok: true });
  });

  router.put('/scheduler/:id', (req, res) => {
    const task = (db.scheduledTasks||[]).find(t => t.id === req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const { enabled, frequency, hour, minute, scheduleTime, schedule } = req.body;
    // Tasks store their time as scheduleTime ("HH:MM"), but this handler
    // only understood hour/minute — so time edits silently did nothing.
    if (scheduleTime !== undefined && /^\d{1,2}:\d{2}$/.test(String(scheduleTime))) {
      task.scheduleTime = scheduleTime;
      const [h, m] = String(scheduleTime).split(':');
      task.hour = parseInt(h, 10);
      task.minute = parseInt(m, 10);
    }
    if (schedule  !== undefined) task.schedule  = schedule;
    if (enabled   !== undefined) task.enabled   = enabled;
    if (frequency !== undefined) task.frequency = frequency;
    if (hour      !== undefined) task.hour      = parseInt(hour);
    if (minute    !== undefined) task.minute    = parseInt(minute);
    if ((hour !== undefined || minute !== undefined) && scheduleTime === undefined) {
      const hh = String(task.hour ?? 0).padStart(2, '0');
      const mm = String(task.minute ?? 0).padStart(2, '0');
      task.scheduleTime = hh + ':' + mm;
    }
    saveDB(true, 'scheduledTasks');
    res.json({ task });
  });

  router.post('/scheduler/:id/run', async (req, res) => {
    const task = (db.scheduledTasks||[]).find(t => t.id === req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (!runTask) return res.status(503).json({ error: 'Scheduler worker is unavailable' });
    if (task.lastStatus === 'running') return res.status(409).json({ error: `${task.name} is already running` });

    // runTask records the running state synchronously before its first await.
    // Do not wait for a long scan before replying to the browser.
    Promise.resolve(runTask(task)).catch(error => {
      console.error(`[Scheduler] Background task failed: ${task.name}:`, error?.message || error);
    });
    res.status(202).json({ ok: true, message: `${task.name} started`, task });
  });

  // ── Custom Libraries ──────────────────────────────────────────────────────────
  const VIDEO_EX    = new Set(['.mp4','.mkv','.avi','.mov','.wmv','.flv','.m4v','.ts','.m2ts','.webm','.mpg','.mpeg']);
  const IMAGE_EX    = new Set(['.jpg','.jpeg','.png','.gif','.webp','.bmp','.tiff']);
  const AUDIO_EX    = new Set(['.mp3','.flac','.aac','.wav','.ogg','.m4a','.wma','.opus']);
  const DOC_EX      = new Set(['.pdf','.epub','.mobi','.cbr','.cbz','.doc','.docx','.txt']);
  const ALL_EX      = new Set([...VIDEO_EX, ...IMAGE_EX, ...AUDIO_EX, ...DOC_EX]);

  async function scanCustomLibrary(lib) {
    const allowed = lib.fileTypes === 'video' ? VIDEO_EX : lib.fileTypes === 'image' ? IMAGE_EX : lib.fileTypes === 'audio' ? AUDIO_EX : lib.fileTypes === 'document' ? DOC_EX : ALL_EX;
    const newItems = [];
    const existingPaths = new Set(lib.items.map(i => i.filePath));

    for (const folderPath of lib.paths) {
      const walk = (dir, depth = 0) => {
        if (depth > 8) return;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) { walk(full, depth+1); continue; }
          const ext = path.extname(entry.name).toLowerCase();
          if (!allowed.has(ext)) continue;
          if (existingPaths.has(full)) continue;
          let size = 0;
          try { size = fs.statSync(full).size; } catch {}
          newItems.push({
            id: uuidv4(), fileName: entry.name, filePath: full, ext, size,
            title: entry.name.replace(/\.[^.]+$/, '').replace(/[_.-]/g, ' ').trim(),
            addedAt: new Date().toISOString(), type: lib.fileTypes || 'video',
          });
        }
      };
      walk(folderPath);
    }
    lib.items = [...(lib.items||[]), ...newItems];
    return newItems.length;
  }

  router.get('/custom-libraries', (_, res) => res.json(db.customLibraries || []));

  router.post('/custom-libraries', (req, res) => {
    const { name, icon, color, fileTypes } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const lib = { id: uuidv4(), name, icon: icon||'📁', color: color||'#6366f1', fileTypes: fileTypes||'video', paths: [], items: [], createdAt: new Date().toISOString() };
    if (!db.customLibraries) db.customLibraries = [];
    db.customLibraries.push(lib);
    saveDB(true);
    res.json(lib);
  });

  router.put('/custom-libraries/:id', (req, res) => {
    const lib = (db.customLibraries||[]).find(l => l.id === req.params.id);
    if (!lib) return res.status(404).json({ error: 'Not found' });
    const { name, icon, color, fileTypes } = req.body;
    if (name) lib.name=name; if (icon) lib.icon=icon; if (color) lib.color=color; if (fileTypes) lib.fileTypes=fileTypes;
    saveDB();
    res.json(lib);
  });

  router.delete('/custom-libraries/:id', (req, res) => {
    const idx = (db.customLibraries||[]).findIndex(l => l.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    db.customLibraries.splice(idx, 1);
    saveDB(true);
    res.json({ ok: true });
  });

  router.post('/custom-libraries/:id/folders', async (req, res) => {
    const lib = (db.customLibraries||[]).find(l => l.id === req.params.id);
    if (!lib) return res.status(404).json({ error: 'Not found' });
    const { path: folderPath } = req.body;
    if (!lib.paths.includes(folderPath)) lib.paths.push(folderPath);
    saveDB();
    await scanCustomLibrary(lib);
    io.emit('customLibrary:updated', { id: lib.id });
    res.json(lib);
  });

  router.delete('/custom-libraries/:id/folders', (req, res) => {
    const lib = (db.customLibraries||[]).find(l => l.id === req.params.id);
    if (!lib) return res.status(404).json({ error: 'Not found' });
    const { path: folderPath } = req.body;
    lib.paths = lib.paths.filter(p => p !== folderPath);
    lib.items = (lib.items||[]).filter(i => !i.filePath.startsWith(folderPath));
    saveDB(true);
    io.emit('customLibrary:updated', { id: lib.id });
    res.json(lib);
  });

  router.post('/custom-libraries/:id/scan', async (req, res) => {
    const lib = (db.customLibraries||[]).find(l => l.id === req.params.id);
    if (!lib) return res.status(404).json({ error: 'Not found' });
    lib.items = [];
    const count = await scanCustomLibrary(lib);
    saveDB();
    io.emit('customLibrary:updated', { id: lib.id });
    res.json({ ok: true, count });
  });

  router.get('/custom-libraries/:id/items', (req, res) => {
    const lib = (db.customLibraries||[]).find(l => l.id === req.params.id);
    if (!lib) return res.status(404).json({ error: 'Not found' });
    res.json(lib.items || []);
  });

  return router;
};

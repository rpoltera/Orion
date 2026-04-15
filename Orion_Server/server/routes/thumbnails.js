'use strict';
const express   = require('express');
const fs        = require('fs');
const path      = require('path');
const { spawn } = require('child_process');
const ffmpegLib = require('fluent-ffmpeg');

module.exports = function (deps) {
  const router = express.Router();
  const { db, io, PATHS, getConfig, getSettings, saveDB, findById, ffmpegStatic } = deps;

  function thumbUrl(absPath) {
    return `http://localhost:3001/api/thumb?path=${encodeURIComponent(absPath)}`;
  }

  function probeFile(filePath) {
    return new Promise((resolve) => {
      ffmpegLib.ffprobe(filePath, (err, meta) => {
        if (err || !meta) return resolve({ durationSecs: 60, chapters: [] });
        const durationSecs = parseFloat(meta.format?.duration || 60);
        const chapters = (meta.chapters || []).map((ch, i) => ({
          title:     ch.tags?.title || `Chapter ${i + 1}`,
          start:     parseFloat(ch.start_time),
          end:       parseFloat(ch.end_time),
          thumbnail: null,
        }));
        resolve({ durationSecs, chapters });
      });
    });
  }

  function extractFrame(filePath, offsetSecs, destPath) {
    return new Promise((resolve, reject) => {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      const ff = spawn(ffmpegStatic, [
        '-y',
        '-ss', String(Math.max(0, offsetSecs)),
        '-i',  filePath,
        '-vframes', '1',
        '-q:v', '4',
        '-vf',  'scale=640:-2',
        destPath,
      ]);
      ff.stderr.on('data', () => {});
      ff.on('error', reject);
      ff.on('close', code => {
        if (code === 0 && fs.existsSync(destPath)) resolve(destPath);
        else reject(new Error(`ffmpeg exit ${code}`));
      });
    });
  }

  let _running = false;

  router.post('/generate-thumbnails', async (req, res) => {
    if (_running) return res.json({ ok: true, status: 'already running' });
    res.json({ ok: true, status: 'started' });
    _running = true;

    const settings   = getSettings();
    const doChapters = !!settings.generateChapterThumbs;
    const thumbDir   = PATHS.THUMB_DIR;
    fs.mkdirSync(thumbDir, { recursive: true });

    const movieWork = db.movies
      .filter(i => !i.thumbnail && i.filePath)
      .map(i => ({ ...i, _type: 'movies' }));

    const mvWork = (db.musicVideos || [])
      .filter(i => !i.thumbnail && i.filePath)
      .map(i => ({ ...i, _type: 'musicVideos' }));

    const seenShows = new Set();
    const tvWork = db.tvShows
      .filter(ep => {
        const key = ep.seriesTitle || ep.showName;
        if (!ep.filePath || seenShows.has(key)) return false;
        seenShows.add(key);
        return !ep.thumbnail;
      })
      .map(ep => ({ ...ep, _type: 'tvShows' }));

    const allWork = [...movieWork, ...tvWork, ...mvWork];
    const total   = allWork.length;
    let done = 0, failed = 0, current = 0;

    const emit = (status, complete = false) => {
      io.emit('thumbnail:progress', { current, total, done, failed, status, complete });
    };

    if (total === 0) {
      _running = false;
      io.emit('thumbnail:progress', { current: 0, total: 0, done: 0, failed: 0, status: 'All items already have artwork', complete: true });
      return;
    }

    emit('Starting...');
    console.log(`[Thumbnails] Generating for ${total} items (chapters: ${doChapters})`);

    for (const item of allWork) {
      current++;
      const label = item.title || item.seriesTitle || item.showName || item.id;
      emit(`${current}/${total} - ${label}`);

      try {
        const { durationSecs, chapters } = await probeFile(item.filePath);
        const offsetSecs = Math.max(10, durationSecs * 0.10);
        const destPath   = path.join(thumbDir, `${item.id}.jpg`);
        await extractFrame(item.filePath, offsetSecs, destPath);

        const dbItem = findById(item._type, item.id);
        if (dbItem) {
          dbItem.thumbnail = thumbUrl(destPath);
          saveDB(false, item._type);
        }
        done++;

        if (doChapters && chapters.length > 0 && dbItem) {
          const enriched = [];
          for (const ch of chapters) {
            const chDest = path.join(thumbDir, `${item.id}_ch${Math.round(ch.start)}.jpg`);
            try {
              await extractFrame(item.filePath, ch.start + 2, chDest);
              enriched.push({ ...ch, thumbnail: thumbUrl(chDest) });
            } catch (_) {
              enriched.push(ch);
            }
          }
          dbItem.chapters   = enriched;
          dbItem.introEnd   = dbItem.introEnd   || 0;
          dbItem.outroStart = dbItem.outroStart || null;
          saveDB(false, item._type);
        }
      } catch (e) {
        console.warn(`[Thumbnails] Failed: ${label} -`, e.message);
        failed++;
      }

      await new Promise(r => setTimeout(r, 80));
    }

    saveDB(true);
    _running = false;
    const summary = `Done - ${done} generated${failed > 0 ? `, ${failed} failed` : ''}`;
    console.log(`[Thumbnails] ${summary}`);
    emit(summary, true);
  });

  return router;
};

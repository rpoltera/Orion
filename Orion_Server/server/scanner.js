'use strict';
/**
 * Orion Scanner Service
 * File system scanning, deduplication, media detection
 */

const path   = require('path');
const fs     = require('fs');
const { v4: uuidv4 } = require('uuid');

const VIDEO_EXTS = ['.mp4','.mkv','.avi','.mov','.wmv','.flv','.m4v','.ts','.m2ts','.webm','.3gp','.mpg','.mpeg'];
const AUDIO_EXTS = ['.mp3','.flac','.aac','.wav','.ogg','.m4a','.wma','.opus','.aiff','.alac'];

const EXTRAS_FOLDERS = /^(featurettes?|extras?|trailers?|interviews?|scenes?|shorts?|behind.the.scenes?|deleted.scenes?|specials?|samples?|subtitles?|subs?|bonus|behindthescenes|featurette)$/i;

const QUALITY_RANK = {
  '4k': 10, '2160p': 10, 'uhd': 10,
  '1080p': 8, 'bluray': 8, 'remux': 9,
  '720p': 6, 'webrip': 5, 'web-dl': 5, 'webdl': 5,
  '480p': 3, 'dvdrip': 3,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function getQualityScore(fileName) {
  const lower = (fileName || '').toLowerCase();
  let score = 0;
  for (const [tag, val] of Object.entries(QUALITY_RANK)) {
    if (lower.includes(tag)) score = Math.max(score, val);
  }
  return score;
}

function cleanTitle(filename) {
  const cleaned = filename
    .replace(/\.(mkv|mp4|avi|mov|wmv|flv|m4v|ts|m2ts|webm|mpeg|mpg|3gp)$/i, '')
    .replace(/\b(1080p|720p|480p|4k|2160p|uhd|bluray|blu-ray|bdrip|brrip|webrip|web-dl|webdl|hdtv|x264|x265|h264|h265|hevc|avc|dvdrip|hdrip|remux|hdr|hdr10|dts|aac|ac3|eac3|truehd|atmos|repack|proper|extended|theatrical|directors\.cut|unrated)\b.*/gi, '')
    .replace(/^(.+?)\s*\(\s*(19|20)\d{2}\s*\)\s*$/, '$1')
    .replace(/^(.+?)\s+(19|20)\d{2}\s*$/, '$1')
    .replace(/[\(\)]+\s*$/, '')
    .replace(/^\s*[\(\)]+/, '')
    .replace(/[_]/g, ' ')
    .replace(/\./g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) {
    return filename
      .replace(/\.(mkv|mp4|avi|mov|wmv|flv|m4v|ts|m2ts|webm|mpeg|mpg|3gp)$/i, '')
      .replace(/[_]/g, ' ').replace(/\./g, ' ').replace(/\s+/g, ' ').trim();
  }
  return cleaned;
}

function extractShowName(filePath) {
  const parts = filePath.split(/[/\\]/);
  for (let i = parts.length - 2; i >= 0; i--) {
    const part = parts[i];
    if (!part.match(/^(season|s\d|episode|e\d)/i) && part.length > 2) {
      return part.replace(/[\.\-\_]/g, ' ').replace(/\s+/g, ' ').trim();
    }
  }
  return cleanTitle(parts[parts.length - 1]);
}

function extractYear(str) {
  if (!str) return null;
  const s = str.replace(/\.[^.]+$/, '');
  const parenMatch = s.match(/\(\s*((19|20)\d{2})\s*\)/);
  if (parenMatch) return parseInt(parenMatch[1]);
  const match = s.match(/\b(19|20)\d{2}\b/);
  if (!match) return null;
  const withoutYear = s.replace(match[0], '').replace(/[\s\(\)\._-]/g, '');
  if (!withoutYear) return null;
  return parseInt(match[0]);
}

function isTrailerOrExtra(fileName) {
  if (!fileName) return false;
  const lower = fileName.toLowerCase();
  return lower.startsWith('trailer') ||
    lower.startsWith('featurette') ||
    lower.startsWith('interview') ||
    lower.startsWith('scene') ||
    lower.startsWith('short') ||
    lower.startsWith('behind') ||
    lower.startsWith('deleted') ||
    lower.startsWith('sample') ||
    lower.startsWith('extra') ||
    lower.includes('-trailer') ||
    lower.includes('.trailer.');
}

function getItemMediaDir(filePath, type) {
  if (!filePath) return null;
  try {
    let dir = path.dirname(filePath);
    if (type === 'tvShows') {
      let depth = 0;
      while (depth++ < 5 && /^(season|series|disc|specials|extras|featurettes|s\d+|e\d+|\d{4})$/i.test(path.basename(dir))) {
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
    return dir;
  } catch { return null; }
}

// ── Deduplication ─────────────────────────────────────────────────────────────

function deduplicateMedia(items) {
  const groups = new Map();
  const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const item of items) {
    if (isTrailerOrExtra(item.fileName)) continue;
    const key = `${norm(item.title)}__${item.year || 'unknown'}`;
    if (!groups.has(key)) {
      groups.set(key, { primary: item, versions: [{ filePath: item.filePath, fileName: item.fileName, size: item.size, id: item.id, quality: getQualityScore(item.fileName) }] });
    } else {
      const entry = groups.get(key);
      entry.versions.push({ filePath: item.filePath, fileName: item.fileName, size: item.size, id: item.id, quality: getQualityScore(item.fileName) });
      const best = entry.versions.reduce((a, b) => (b.quality > a.quality || (b.quality === a.quality && b.size > a.size)) ? b : a);
      if (best.id !== entry.primary.id) {
        const bestItem = items.find(i => i.id === best.id);
        if (bestItem) entry.primary = bestItem;
      }
    }
  }
  return Array.from(groups.values()).map(({ primary, versions }) => ({
    ...primary,
    versions: versions.sort((a, b) => (b.size || 0) - (a.size || 0)),
  }));
}

// ── Directory Scanner ─────────────────────────────────────────────────────────

async function scanDirectory(dirPath, type = 'movies', { onProgress, findLocalImages, findLocalMetadata, decodeHtmlEntities } = {}) {
  const results = [];
  let fileCount = 0;

  const walk = async (currentPath, depth = 0) => {
    if (depth > 8) return;
    let entries;
    try { entries = fs.readdirSync(currentPath, { withFileTypes: true }); }
    catch (err) { console.error(`[Scan] Cannot read: ${currentPath} — ${err.message}`); return; }

    const currentFolderName = path.basename(currentPath);
    const isExtrasFolder = type === 'movies' && EXTRAS_FOLDERS.test(currentFolderName);

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      let fullPath;
      try { fullPath = path.join(currentPath, entry.name); } catch { continue; }

      if (entry.isDirectory()) {
        if (type === 'movies' && EXTRAS_FOLDERS.test(entry.name)) continue;
        await walk(fullPath, depth + 1);
      } else {
        if (isExtrasFolder) continue;
        if (type === 'movies' && isTrailerOrExtra(entry.name)) continue;
        const ext = path.extname(entry.name).toLowerCase();
        const isVideo = VIDEO_EXTS.includes(ext);
        const isAudio = AUDIO_EXTS.includes(ext);
        if ((type === 'music' && isAudio) || (type !== 'music' && isVideo)) {
          let size = 0;
          try { size = fs.statSync(fullPath).size; } catch {}

          const localImgs = findLocalImages ? findLocalImages(fullPath) : null;
          const localMeta = findLocalMetadata ? findLocalMetadata(fullPath) : null;
          const quickPoster  = localImgs?.poster  ? `/api/localimage?path=${encodeURIComponent(localImgs.poster)}`  : null;
          const quickBackdrop = localImgs?.fanart ? `/api/localimage?path=${encodeURIComponent(localImgs.fanart)}` : null;

          const dec = decodeHtmlEntities || (s => s);

          results.push({
            id:         uuidv4(),
            title:      dec(localMeta?.title || cleanTitle(entry.name)),
            seriesTitle: type === 'tvShows' ? extractShowName(fullPath) : undefined,
            seasonNum: (() => {
              if (type !== 'tvShows') return undefined;
              const parent = path.basename(path.dirname(fullPath));
              const m = parent.match(/^[Ss]eason\s*(\d{1,3})$/) || parent.match(/^[Ss](\d{1,3})$/);
              if (m) return parseInt(m[1]);
              const fm = fullPath.replace(/\\/g,'/').match(/[Ss](\d{1,3})[Ee]\d/);
              return fm ? parseInt(fm[1]) : 1;
            })(),
            fileName:   entry.name,
            filePath:   fullPath,
            ext, size,
            addedAt:    new Date().toISOString(),
            type,
            thumbnail:  quickPoster,
            backdrop:   quickBackdrop,
            overview:   localMeta?.overview || null,
            year:       localMeta?.year || extractYear(entry.name),
            rating:     localMeta?.rating || null,
            runtime:    localMeta?.runtime || null,
            genres:     localMeta?.genres || [],
            cast:       localMeta?.cast   || [],
            studios:    localMeta?.studios || [],
            tmdbId:     localMeta?.tmdbId  || null,
            imdbId:     localMeta?.imdbId  || null,
            contentRating: localMeta?.mpaa || null,
            metadataFetched: !!(localMeta?.title),
          });

          fileCount++;
          if (fileCount % 50 === 0) {
            await new Promise(r => setImmediate(r));
            if (onProgress) onProgress({ status: `Scanning... ${fileCount} files found`, count: fileCount });
          }
        }
      }
    }
  };

  await walk(dirPath);
  return results;
}

// ── Auto-scan (folder mtime watcher) ─────────────────────────────────────────

function getFolderMtime(folderPath) {
  try {
    let latest = fs.statSync(folderPath).mtimeMs;
    const entries = fs.readdirSync(folderPath, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) {
        try {
          const m = fs.statSync(path.join(folderPath, e.name)).mtimeMs;
          if (m > latest) latest = m;
        } catch {}
      }
    }
    return latest;
  } catch { return -1; }
}

module.exports = {
  VIDEO_EXTS,
  AUDIO_EXTS,
  QUALITY_RANK,
  getQualityScore,
  cleanTitle,
  extractShowName,
  extractYear,
  isTrailerOrExtra,
  getItemMediaDir,
  deduplicateMedia,
  scanDirectory,
  getFolderMtime,
};

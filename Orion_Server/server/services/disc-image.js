'use strict';

const { execFile } = require('child_process');
const fs = require('fs/promises');
const path = require('path');
const { promisify } = require('util');

const run = promisify(execFile);
const probeCache = new Map();
const MAX_CACHED_IMAGES = 128;

function isDiscImage(filePath) {
  return typeof filePath === 'string' && path.extname(filePath).toLowerCase() === '.iso';
}

async function readDiscImage(filePath, ffprobePath) {
  const inputs = [
    // The DVD demuxer reads sequentially, so FFmpeg must seek on output.
    { source: filePath, options: ['-f', 'dvdvideo'], seekAfterInput: true },
    { source: `bluray:${filePath}`, options: [], seekAfterInput: false },
  ];

  for (const input of inputs) {
    try {
      const { stdout } = await run(ffprobePath, [
        '-v', 'error', '-show_streams', '-show_format', '-show_chapters',
        '-of', 'json', ...input.options, '-i', input.source,
      ], { timeout: 8000, windowsHide: true });
      const metadata = JSON.parse(stdout);
      if (metadata.streams?.some(stream => stream.codec_type === 'video')) {
        return { ...input, metadata };
      }
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'EACCES') throw error;
    }
  }

  throw Object.assign(new Error(
    'Could not open this ISO as a DVD or Blu-ray video disc. Check the image and the server FFmpeg build for dvdvideo and bluray support.',
  ), { status: 422, code: 'DISC_IMAGE_UNREADABLE' });
}

async function probeDiscImage(filePath, ffprobePath = 'ffprobe') {
  const localPath = path.resolve(filePath);
  const stat = await fs.stat(localPath).catch(error => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  });
  if (!stat?.isFile()) {
    throw Object.assign(new Error('Disc image is unavailable'), { status: 404, code: 'DISC_IMAGE_MISSING' });
  }

  const key = `${ffprobePath}\0${localPath}`;
  const signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  const cached = probeCache.get(key);
  if (cached?.signature === signature) return cached.probe;

  const probe = readDiscImage(localPath, ffprobePath);
  probeCache.delete(key);
  probeCache.set(key, { signature, probe });
  if (probeCache.size > MAX_CACHED_IMAGES) probeCache.delete(probeCache.keys().next().value);
  try {
    return await probe;
  } catch (error) {
    if (probeCache.get(key)?.probe === probe) probeCache.delete(key);
    throw error;
  }
}

module.exports = { isDiscImage, probeDiscImage };

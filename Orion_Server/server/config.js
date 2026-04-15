'use strict';
/**
 * Orion Config Module
 * Handles all application configuration — load, save, defaults
 */

const path = require('path');
const fs   = require('fs');

// ── Paths ─────────────────────────────────────────────────────────────────────
const DATA_DIR = process.env.ORION_DATA_DIR || process.env.APPDATA || path.join(process.env.HOME || __dirname, 'orion-data');
const CFG_FILE = path.join(DATA_DIR, 'config.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── Defaults ──────────────────────────────────────────────────────────────────
const CONFIG_DEFAULTS = {
  tmdbApiKey:     '',
  omdbApiKey:     '',
  lastfmKey:      '',
  fanartKey:      '',
  tvdbKey:        '',
  youtubeApiKey:  '',
  metadataSource: 'auto',
  homeLayout:     null,
  sfDataDir:      '',   // StreamForge data directory — empty = defaults to AppData/Orion/sf
  transcoding: {
    hardware: 'auto',
    quality:  '720p',
  },
  pathMappings: [],
};

const SETTINGS_DEFAULTS = {
  showContinueWatching:      true,
  showRecentMovies:          true,
  showTVSeries:              true,
  showCollections:           true,
  showMusic:                 true,
  showMusicVideos:           true,
  showRecentlyReleasedMovies:true,
  showRecentlyReleasedTV:    true,
  showRecommendations:       true,
  watchedThreshold:          85,
  recentlyReleasedDays:      90,
  scanOnStartup:             false,
  emptyTrashAfterScan:       false,
  continueWatchingWindow:    8,
  showFullPageBackground:    true,
  showThemeSongs:            true,
  libAutoScanInterval:       5,
};

// ── State ─────────────────────────────────────────────────────────────────────
let config   = { ...CONFIG_DEFAULTS };
let settings = { ...SETTINGS_DEFAULTS };

// ── Load ──────────────────────────────────────────────────────────────────────
function loadConfig() {
  try {
    console.log('[Config] Loading from:', CFG_FILE);
    if (fs.existsSync(CFG_FILE)) {
      const saved = JSON.parse(fs.readFileSync(CFG_FILE, 'utf-8'));
      config = { ...CONFIG_DEFAULTS, ...saved };
      if (saved.settings) {
        settings = { ...SETTINGS_DEFAULTS, ...saved.settings };
      }
      const keyStatus = [
        config.tmdbApiKey    ? 'TMDB'    : null,
        config.omdbApiKey    ? 'OMDb'    : null,
        config.fanartKey     ? 'FanArt'  : null,
        config.youtubeApiKey ? 'YouTube' : null,
      ].filter(Boolean);
      console.log('[Config] Loaded —', keyStatus.length ? `API keys present: ${keyStatus.join(', ')}` : 'no API keys set');
    } else {
      console.log('[Config] No config file found — using defaults');
    }
  } catch (e) {
    console.error('[Config] Load error:', e.message);
  }
}

// ── Save ──────────────────────────────────────────────────────────────────────
function saveConfig() {
  try {
    const toSave = { ...config, settings };
    fs.writeFileSync(CFG_FILE, JSON.stringify(toSave, null, 2));
    const keyStatus = [
      config.tmdbApiKey    ? 'TMDB'    : null,
      config.omdbApiKey    ? 'OMDb'    : null,
      config.fanartKey     ? 'FanArt'  : null,
      config.youtubeApiKey ? 'YouTube' : null,
    ].filter(Boolean);
    if (keyStatus.length) console.log('[Config] Saved — API keys present:', keyStatus.join(', '));
  } catch (e) {
    console.error('[Config] Save error:', e.message);
  }
}

// ── Accessors ─────────────────────────────────────────────────────────────────
function getConfig()   { return config;   }
function getSettings() { return settings; }

function updateConfig(updates) {
  config = { ...config, ...updates };
  saveConfig();
}

function updateSettings(updates) {
  settings = { ...settings, ...updates };
  saveConfig();
}

// ── Paths (shared constants) ──────────────────────────────────────────────────
const PATHS = {
  DATA_DIR,
  CFG_FILE,
  DB_FILE:                path.join(DATA_DIR, 'library.json'),
  IMG_DIR:                path.join(DATA_DIR, 'images'),
  THUMB_DIR:              path.join(DATA_DIR, 'thumbs'),
  TRAILER_CACHE_DIR:      path.join(DATA_DIR, 'trailers'),
  TRAILER_OVERRIDES_FILE: path.join(DATA_DIR, 'trailer_overrides.json'),
  BLOCKED_VIDEO_IDS_FILE: path.join(DATA_DIR, 'blocked_trailers.json'),
  SUBS_DIR:               path.join(DATA_DIR, 'subs'),
};

// Ensure all required dirs exist
for (const dir of [PATHS.IMG_DIR, PATHS.THUMB_DIR, PATHS.TRAILER_CACHE_DIR, PATHS.SUBS_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

module.exports = {
  loadConfig,
  saveConfig,
  getConfig,
  getSettings,
  updateConfig,
  updateSettings,
  PATHS,
  CONFIG_DEFAULTS,
  SETTINGS_DEFAULTS,
};

// ─── Time Formatting ──────────────────────────────────────────────────────────
export function formatDuration(seconds) {
  if (!seconds || isNaN(seconds)) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return h > 0 ? `${h}:${m.toString().padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export function formatFileSize(bytes) {
  if (!bytes) return '—';
  const gb = bytes / 1024 / 1024 / 1024;
  const mb = bytes / 1024 / 1024;
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  return `${mb.toFixed(1)} MB`;
}

export function formatDate(isoString) {
  if (!isoString) return '';
  return new Date(isoString).toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric'
  });
}

// ─── String Helpers ───────────────────────────────────────────────────────────
export function truncate(str, max = 40) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max) + '…' : str;
}

export function slugify(str) {
  return str.toLowerCase().replace(/\s+/g, '-').replace(/[^\w-]/g, '');
}

export function extractYear(filename) {
  const match = filename?.match(/\b(19|20)\d{2}\b/);
  return match ? parseInt(match[0]) : null;
}

// ─── Media Helpers ────────────────────────────────────────────────────────────
export const VIDEO_EXTENSIONS = [
  '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv',
  '.m4v', '.ts', '.m2ts', '.webm', '.3gp', '.mpg', '.mpeg'
];

export const AUDIO_EXTENSIONS = [
  '.mp3', '.flac', '.aac', '.wav', '.ogg',
  '.m4a', '.wma', '.opus', '.aiff', '.alac'
];

export const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];

export function isVideo(filename) {
  return VIDEO_EXTENSIONS.includes(getExt(filename));
}

export function isAudio(filename) {
  return AUDIO_EXTENSIONS.includes(getExt(filename));
}

export function getExt(filename) {
  return filename ? '.' + filename.split('.').pop().toLowerCase() : '';
}

export function getMimeType(filename) {
  const ext = getExt(filename);
  const map = {
    '.mp4': 'video/mp4', '.mkv': 'video/x-matroska',
    '.avi': 'video/x-msvideo', '.mov': 'video/quicktime',
    '.webm': 'video/webm', '.ts': 'video/mp2t',
    '.mp3': 'audio/mpeg', '.flac': 'audio/flac',
    '.aac': 'audio/aac', '.wav': 'audio/wav',
    '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
  };
  return map[ext] || 'video/mp4';
}

// ─── Stream URL Builder ───────────────────────────────────────────────────────
const API_BASE = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') ? `http://${window.location.hostname}:3001/api` : `http://${window.location.hostname}:3001/api`;

export function buildStreamUrl(filePath) {
  return `${API_BASE}/stream?path=${encodeURIComponent(filePath)}`;
}

export function buildHLSUrl(sessionId) {
  return `http://${window.location.hostname}:3001/hls/${sessionId}/playlist.m3u8`;
}

// ─── Sort Helpers ─────────────────────────────────────────────────────────────
export function sortMedia(items, sortBy) {
  const arr = [...items];
  switch (sortBy) {
    case 'a-z':      return arr.sort((a, b) => a.title.localeCompare(b.title));
    case 'z-a':      return arr.sort((a, b) => b.title.localeCompare(a.title));
    case 'year':     return arr.sort((a, b) => (b.year || 0) - (a.year || 0));
    case 'rating':   return arr.sort((a, b) => (b.rating || 0) - (a.rating || 0));
    case 'size':     return arr.sort((a, b) => (b.size || 0) - (a.size || 0));
    case 'newest':
    default:         return arr.sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt));
  }
}

// ─── Local Storage Helpers ────────────────────────────────────────────────────
export function localGet(key, fallback = null) {
  try {
    const val = localStorage.getItem(key);
    return val ? JSON.parse(val) : fallback;
  } catch { return fallback; }
}

export function localSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

// ─── TV Show Grouping ─────────────────────────────────────────────────────────
// Groups raw episode items into show objects for display in grids/carousels
export function groupEpisodesToShows(episodes) {
  const shows = {};
  for (const ep of (episodes || [])) {
    let showName = null;
    if (ep.filePath) {
      const parts = ep.filePath.replace(/\\/g, '/').split('/');
      for (let i = parts.length - 2; i >= 0; i--) {
        const part = parts[i];
        if (!part.match(/^(season|s\d|disc|disk|extras?|specials?|bonus)/i) && part.length > 2) {
          showName = part
            .replace(/[._]/g, ' ')
            .replace(/\s*\(?(19|20)\d{2}\)?\s*$/, '')
            .replace(/\s+/g, ' ')
            .trim();
          break;
        }
      }
    }
    if (!showName) showName = ep.title || 'Unknown Show';
    if (!shows[showName]) {
      shows[showName] = {
        id: `show_${showName}`,
        showName,
        title: showName,
        episodes: [],
        thumbnail: null, backdrop: null,
        overview: null, rating: null, year: null,
        type: 'tvShows',
        isShow: true,
      };
    }
    shows[showName].episodes.push(ep);
    if (!shows[showName].thumbnail && ep.thumbnail) {
      shows[showName].thumbnail = ep.thumbnail;
      shows[showName].backdrop  = ep.backdrop;
      shows[showName].overview  = ep.overview;
      shows[showName].year      = ep.year;
    }
    if (ep.rating && parseFloat(ep.rating) > parseFloat(shows[showName].rating || 0)) {
      shows[showName].rating = ep.rating;
    }
  }
  return Object.values(shows).sort((a, b) => a.showName.localeCompare(b.showName));
}

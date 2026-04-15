export const APP_NAME = 'Orion';
export const APP_VERSION = '1.0.0';
export const API_BASE = 'http://localhost:3001/api';
export const SERVER_PORT = 3001;
export const GITHUB_URL = 'https://github.com/rpoltera/Orion';

export const MEDIA_TYPES = {
  MOVIES:       'movies',
  TV_SHOWS:     'tvShows',
  MUSIC:        'music',
  MUSIC_VIDEOS: 'musicVideos',
};

export const VIDEO_EXTS = ['.mp4','.mkv','.avi','.mov','.wmv','.flv','.m4v','.ts','.m2ts','.webm','.3gp','.mpg','.mpeg'];
export const AUDIO_EXTS = ['.mp3','.flac','.aac','.wav','.ogg','.m4a','.wma','.opus','.aiff','.alac'];

export const QUALITY_OPTIONS = [
  { value: '480p',  label: '480p',  bitrate: '2000k' },
  { value: '720p',  label: '720p',  bitrate: '4000k' },
  { value: '1080p', label: '1080p', bitrate: '8000k' },
  { value: '4k',    label: '4K',    bitrate: '20000k' },
];

export const ENCODER_OPTIONS = [
  { value: 'auto',     label: 'Auto-detect' },
  { value: 'nvenc',    label: 'NVIDIA NVENC' },
  { value: 'qsv',      label: 'Intel Quick Sync' },
  { value: 'amf',      label: 'AMD AMF' },
  { value: 'software', label: 'Software (CPU)' },
];

export const STREAMING_SERVICES = {
  pluto: {
    id: 'pluto',
    name: 'Pluto TV',
    url: 'https://pluto.tv',
    color: '#f5c518',
    bg: 'linear-gradient(135deg, #1a1200 0%, #2d2000 100%)',
    free: true,
  },
  roku: {
    id: 'roku',
    name: 'The Roku Channel',
    url: 'https://therokuchannel.roku.com',
    color: '#6c2bd9',
    bg: 'linear-gradient(135deg, #0d0520 0%, #1a0840 100%)',
    free: true,
  },
};

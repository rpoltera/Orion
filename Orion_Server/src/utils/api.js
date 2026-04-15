const BASE = 'http://localhost:3001/api';

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options
  });
  if (!res.ok) throw new Error(`API error ${res.status}: ${res.statusText}`);
  return res.json();
}

export const api = {
  // Health
  health: () => request('/health'),

  // Library
  getLibrary: (type) => request(`/library/${type}`),
  scanFolders: (paths, type) => request('/library/scan', {
    method: 'POST', body: JSON.stringify({ paths, type })
  }),
  deleteItem: (type, id) => request(`/library/${type}/${id}`, { method: 'DELETE' }),

  // Metadata
  getMetadata: (filePath) => request(`/metadata?path=${encodeURIComponent(filePath)}`),

  // Transcoding
  startTranscode: (filePath, quality) => request('/transcode/start', {
    method: 'POST', body: JSON.stringify({ filePath, quality })
  }),
  stopTranscode: (sessionId) => request(`/transcode/stop/${sessionId}`, { method: 'POST' }),
  getTranscodeStatus: (sessionId) => request(`/transcode/status/${sessionId}`),

  // Hardware
  getHardwareInfo: () => request('/hardware'),

  // IPTV
  getIPTVChannels: () => request('/iptv/channels'),
  loadIPTV: (source) => request('/iptv/load', {
    method: 'POST', body: JSON.stringify(source)
  }),

  // Settings
  getSettings: () => request('/settings'),
  saveSettings: (settings) => request('/settings', {
    method: 'PUT', body: JSON.stringify(settings)
  }),

  // Stream URL (not a fetch — just builds the URL)
  streamUrl: (filePath) => `${BASE}/stream?path=${encodeURIComponent(filePath)}`,
};

export default api;

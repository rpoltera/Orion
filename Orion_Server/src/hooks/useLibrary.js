import { useState, useCallback } from 'react';

const API = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') ? `http://${window.location.hostname}:3001/api` : `http://${window.location.hostname}:3001/api`;

export function useLibrary() {
  const [library, setLibrary] = useState({
    movies: [], tvShows: [], music: [], musicVideos: []
  });
  const [loading, setLoading] = useState({});

  const fetchLibrary = useCallback(async (type) => {
    try {
      const res = await fetch(`${API}/library/${type}`);
      const data = await res.json();
      setLibrary(prev => ({ ...prev, [type]: data.items || [] }));
    } catch (err) {
      console.error(`[useLibrary] fetchLibrary(${type}) error:`, err);
    }
  }, []);

  const scanFolders = useCallback(async (paths, type, onNotify) => {
    setLoading(prev => ({ ...prev, [type]: true }));
    try {
      const res = await fetch(`${API}/library/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths, type })
      });
      const data = await res.json();
      await fetchLibrary(type);
      onNotify?.(`Scanned ${data.added} ${type} files`, 'success');
      return data;
    } catch (err) {
      onNotify?.('Scan failed: ' + err.message, 'error');
    } finally {
      setLoading(prev => ({ ...prev, [type]: false }));
    }
  }, [fetchLibrary]);

  const removeItem = useCallback(async (type, id) => {
    try {
      await fetch(`${API}/library/${type}/${id}`, { method: 'DELETE' });
      setLibrary(prev => ({
        ...prev,
        [type]: prev[type].filter(i => i.id !== id)
      }));
    } catch (err) {
      console.error('[useLibrary] removeItem error:', err);
    }
  }, []);

  return { library, setLibrary, loading, fetchLibrary, scanFolders, removeItem };
}

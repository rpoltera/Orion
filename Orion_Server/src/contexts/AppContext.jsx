import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { applyTheme } from '../themes/themes';

const AppContext = createContext(null);
// Dynamic API URL — works on any host/IP, not just localhost
const API = process.env.REACT_APP_API_URL
  ? process.env.REACT_APP_API_URL
  : (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
    ? 'http://localhost:3001/api'
    : `http://${window.location.hostname}:3001/api`;
const PAGE_SIZE = 250;

export function AppProvider({ children }) {
  const [theme, setTheme]               = useState('disney');
  const [activeSection, setActiveSection] = useState('home');
  const [currentUser, setCurrentUser]   = useState(() => {
    try { const s = localStorage.getItem('orion_current_user'); return s ? JSON.parse(s) : null; } catch { return null; }
  });
  const setCurrentUserPersist = (user) => {
    user ? localStorage.setItem('orion_current_user', JSON.stringify(user)) : localStorage.removeItem('orion_current_user');
    setCurrentUser(user);
  };

  // Library holds only card-fields (thumbnail, title, year, rating etc.)
  const [library, setLibrary]           = useState({ movies: [], tvShows: [], music: [], musicVideos: [] });
  const [libraryCounts, setLibraryCounts] = useState({ movies: 0, tvShows: 0, music: 0, musicVideos: 0 });
  const [libraryPaths, setLibraryPaths] = useState({ movies: [], tvShows: [], music: [], musicVideos: [] });
  const [iptvChannels, setIptvChannels] = useState([]);
  const [nowPlaying, setNowPlaying]     = useState(null);
  const [playerOpen, setPlayerOpen]     = useState(false);
  const [mediaQueue, setMediaQueue]     = useState([]);
  const [queueIndex, setQueueIndex]     = useState(-1);
  const [customLibraries, setCustomLibraries] = useState([]);
  const [settings, setSettings]         = useState({ transcoding: { hardware: 'auto', quality: '720p' } });
  const [hardwareInfo, setHardwareInfo] = useState(null);
  const [loading, setLoading]           = useState({});
  const [notifications, setNotifications] = useState([]);
  const [searchQuery, setSearchQuery]   = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [metadataStatus, setMetadataStatus] = useState(null);
  const [scanStatus, setScanStatus] = useState(null); // { type, message, count }
  const [probeStatus, setProbeStatus] = useState(null); // { done, total, errors, running }

  // ── Theme ───────────────────────────────────────────────────────────────────
  useEffect(() => {
    const saved = localStorage.getItem('orion_theme') || 'disney';
    setTheme(saved); applyTheme(saved);
  }, []);

  const changeTheme = useCallback((id) => {
    setTheme(id); applyTheme(id); localStorage.setItem('orion_theme', id);
  }, []);

  // ── Notifications ───────────────────────────────────────────────────────────
  const notify = useCallback((message, type = 'info') => {
    const id = Date.now();
    setNotifications(prev => [...prev, { id, message, type }]);
    setTimeout(() => setNotifications(prev => prev.filter(n => n.id !== id)), 4000);
  }, []);

  // ── Fetch Library — tvShows uses grouped endpoint (shows not episodes) ───────
  const fetchLibrary = useCallback(async (type) => {
    try {
      // TV Shows: fetch grouped shows from server (one entry per show)
      const userParam = currentUser?.maxRating ? `&userId=${currentUser.id}` : '';
      const endpoint = type === 'tvShows'
        ? `${API}/library/tvShows/grouped`
        : `${API}/library/${type}`;

      const BATCH = 5;
      const first = await fetch(`${endpoint}?page=0&limit=${PAGE_SIZE}${userParam}`).then(r=>r.json());
      const total = first.total || 0;
      let items = first.items || [];

      // Update UI immediately with first page
      setLibrary(prev => ({ ...prev, [type]: items }));
      setLibraryCounts(prev => ({ ...prev, [type]: total }));

      if (total > PAGE_SIZE) {
        const pages = Math.ceil(total / PAGE_SIZE);
        for (let b = 1; b < pages; b += BATCH) {
          const batchNums = Array.from({ length: Math.min(BATCH, pages - b) }, (_, i) => b + i);
          const batchResults = await Promise.all(
            batchNums.map(p =>
              fetch(`${endpoint}?page=${p}&limit=${PAGE_SIZE}${userParam}`).then(r=>r.json()).then(d=>d.items||[])
            )
          );
          items = items.concat(...batchResults);
          setLibrary(prev => ({ ...prev, [type]: items }));
        }
        setLibraryCounts(prev => ({ ...prev, [type]: total }));
      }

      return items;
    } catch (err) {
      console.error('fetchLibrary error:', err);
      return [];
    }
  }, [currentUser]);

  // ── Fetch item with full fields (for detail modal) ──────────────────────────
  const fetchItemFull = useCallback(async (id, type) => {
    try {
      const r = await fetch(`${API}/library/${type}?fields=all`).then(r=>r.json());
      return (r.items || []).find(i => i.id === id) || null;
    } catch { return null; }
  }, []);

  // ── Fetch Saved Library Paths ───────────────────────────────────────────────
  const fetchLibraryPaths = useCallback(async () => {
    const types = ['movies', 'tvShows', 'music', 'musicVideos'];
    const paths = {};
    await Promise.all(types.map(async type => {
      try {
        const res = await fetch(`${API}/library/paths/${type}`);
        paths[type] = (await res.json()).paths || [];
      } catch { paths[type] = []; }
    }));
    setLibraryPaths(paths);
  }, []);

  const fetchCustomLibraries = useCallback(async () => {
    try {
      const data = await fetch(`${API}/custom-libraries`).then(r => r.json());
      setCustomLibraries(Array.isArray(data) ? data : []);
    } catch {}
  }, []);

  // ── Scan Folders ────────────────────────────────────────────────────────────
  const scanFolders = useCallback(async (paths, type) => {
    setLoading(prev => ({ ...prev, [type]: true }));
    try {
      const res = await fetch(`${API}/library/scan`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths, type })
      });
      const data = await res.json();
      if (data.scanning) {
        notify(`Scanning ${type} library in background — library will update automatically`, 'info');
        // library:updated socket event will trigger fetchLibrary when done
      } else {
        await fetchLibrary(type);
        await fetchLibraryPaths();
        notify(`Added ${data.added} new ${type} files (${data.total} total)`, 'success');
      }
    } catch (err) {
      notify('Scan failed: ' + err.message, 'error');
    } finally {
      setLoading(prev => ({ ...prev, [type]: false }));
    }
  }, [fetchLibrary, fetchLibraryPaths, notify]);

  // ── Player ──────────────────────────────────────────────────────────────────
  const playMedia = useCallback((item, queue = []) => {
    setNowPlaying(item);
    setPlayerOpen(true);
    if (queue.length > 0) {
      setMediaQueue(queue);
      setQueueIndex(queue.findIndex(t => t.id === item.id));
    } else {
      setMediaQueue([item]);
      setQueueIndex(0);
    }
  }, []);

  const mediaQueueRef  = React.useRef([]);
  const queueIndexRef  = React.useRef(-1);

  // Keep refs in sync with state
  React.useEffect(() => { mediaQueueRef.current = mediaQueue; }, [mediaQueue]);
  React.useEffect(() => { queueIndexRef.current = queueIndex; }, [queueIndex]);

  const playNext = useCallback(() => {
    const q = mediaQueueRef.current;
    const i = queueIndexRef.current;
    const next = i + 1;
    if (next < q.length) {
      setQueueIndex(next);
      setNowPlaying(q[next]);
    }
  }, []);

  const playPrev = useCallback(() => {
    const q = mediaQueueRef.current;
    const i = queueIndexRef.current;
    const prev = i - 1;
    if (prev >= 0) {
      setQueueIndex(prev);
      setNowPlaying(q[prev]);
    }
  }, []);
  const closePlayer = useCallback(() => {
    if (window.electron?.setFullscreen) {
      window.electron.setFullscreen(false);
    } else if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
    setPlayerOpen(false);
    setNowPlaying(null);
  }, []);

  // ── IPTV ────────────────────────────────────────────────────────────────────
  const loadIPTV = useCallback(async (source) => {
    setLoading(prev => ({ ...prev, iptv: true }));
    try {
      const res = await fetch(`${API}/iptv/load`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(source)
      });
      const data = await res.json();
      // SAFE: only update if server returned a valid array — never wipe on error
      if (Array.isArray(data.channels)) {
        setIptvChannels(data.channels);
        notify(`Loaded ${data.added ?? data.channels.length} new channels (${data.total ?? data.channels.length} total)`, 'success');
      } else {
        notify('IPTV load failed: ' + (data.error || 'Unknown error'), 'error');
      }
    } catch (err) { notify('IPTV load failed: ' + err.message, 'error'); }
    finally { setLoading(prev => ({ ...prev, iptv: false })); }
  }, [notify]);

  const uploadIPTVFile = useCallback(async (file) => {
    setLoading(prev => ({ ...prev, iptv: true }));
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(`${API}/iptv/upload`, { method: 'POST', body: form });
      const data = await res.json();
      if (data.ok) {
        const res2 = await fetch(`${API}/iptv/channels`);
        const d2 = await res2.json();
        setIptvChannels(d2.channels || []);
        notify(`Loaded ${data.added} channels from file (${data.total} total)`, 'success');
      } else {
        notify('Upload failed: ' + (data.error || 'Unknown error'), 'error');
      }
    } catch(err) { notify('Upload failed: ' + err.message, 'error'); }
    finally { setLoading(prev => ({ ...prev, iptv: false })); }
  }, [notify]);

  const removeIPTVChannel = useCallback(async (id) => {
    try {
      await fetch(`${API}/iptv/channels/${id}`, { method: 'DELETE' });
      setIptvChannels(prev => prev.filter(c => c.id !== id));
    } catch {}
  }, []);

  // Bulk remove — single request, no race conditions
  const removeIPTVChannels = useCallback(async (ids) => {
    if (!ids || !ids.length) return;
    try {
      await fetch(`${API}/iptv/channels/remove-bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      const idSet = new Set(ids);
      setIptvChannels(prev => prev.filter(c => !idSet.has(c.id)));
    } catch {}
  }, []);

  const clearIPTVChannels = useCallback(async () => {
    try {
      await fetch(`${API}/iptv/channels`, { method: 'DELETE' });
      setIptvChannels([]);
    } catch {}
  }, []);

  // ── Hardware Info ───────────────────────────────────────────────────────────
  const fetchHardwareInfo = useCallback(async () => {
    try { setHardwareInfo(await fetch(`${API}/hardware`).then(r=>r.json())); } catch {}
  }, []);

  // ── Search (client-side on loaded items) ────────────────────────────────────
  const search = useCallback((query) => {
    setSearchQuery(query);
    if (!query.trim()) { setSearchResults([]); return; }
    const q = query.toLowerCase();
    const results = [];

    // Movies, music, musicVideos — match by title directly
    ['movies', 'music', 'musicVideos'].forEach(type => {
      (library[type] || [])
        .filter(item => item.title?.toLowerCase().includes(q))
        .forEach(item => results.push({ ...item, type, mediaType: type }));
    });

    // TV Shows — group into shows first, then match on show name
    const showMap = {};
    (library.tvShows || []).forEach(ep => {
      const showName = ep.seriesTitle || ep.showName || ep.title || 'Unknown Show';
      if (!showMap[showName]) {
        showMap[showName] = {
          id: 'show_' + showName,
          showName,
          title: showName,
          type: 'tvShows',
          mediaType: 'tvShows',
          thumbnail: ep.thumbnail || null,
          backdrop: ep.backdrop || null,
          overview: ep.overview || null,
          rating: ep.rating || null,
          year: ep.year || null,
          episodes: [],
        };
      }
      showMap[showName].episodes.push(ep);
      if (!showMap[showName].thumbnail && ep.thumbnail) showMap[showName].thumbnail = ep.thumbnail;
      if (ep.rating && parseFloat(ep.rating) > parseFloat(showMap[showName].rating || 0)) showMap[showName].rating = ep.rating;
    });
    Object.values(showMap)
      .filter(show => show.showName.toLowerCase().includes(q))
      .forEach(show => results.push(show));

    setSearchResults(results);
  }, [library]);

  // ── Socket.io for live updates ──────────────────────────────────────────────
  useEffect(() => {
    let socket;
    (async () => {
      try {
        const { io } = await import('socket.io-client');
        socket = io(`http://${window.location.hostname}:3001`);
        socket.on('metadata:updated', ({ id, type, item }) => {
          setLibrary(prev => ({
            ...prev,
            [type]: prev[type].map(i => i.id === id ? { ...i, ...item } : i)
          }));
        });
        // Batch handler — server sends multiple updates at once
        socket.on('metadata:updated:batch', ({ items }) => {
          setLibrary(prev => {
            const next = { ...prev };
            for (const { id, type, item } of items) {
              if (next[type]) {
                next[type] = next[type].map(i => i.id === id ? { ...i, ...item } : i);
              }
            }
            return next;
          });
        });
        socket.on('item:updated:batch', ({ items }) => {
          setLibrary(prev => {
            const next = { ...prev };
            for (const { id, item } of items) {
              for (const type of Object.keys(next)) {
                const idx = next[type].findIndex(i => i.id === id);
                if (idx >= 0) { next[type] = [...next[type]]; next[type][idx] = { ...next[type][idx], ...item }; break; }
              }
            }
            return next;
          });
        });
        // Debounce library:updated to avoid multiple rapid full fetches
        const _pendingFetch = {};
        socket.on('library:updated', ({ type }) => {
          if (_pendingFetch[type]) clearTimeout(_pendingFetch[type]);
          _pendingFetch[type] = setTimeout(() => { fetchLibrary(type); delete _pendingFetch[type]; }, 500);
        });
        socket.on('customLibrary:updated', () => fetchCustomLibraries());
        socket.on('scan:progress', (data) => {
          const status = typeof data.status === 'string' ? data.status : String(data.status || '');
          setScanStatus({ message: status, count: data.count });
        });
        socket.on('server:load', ({ tier, cpu, mem }) => {
          if (tier === 'high' || tier === 'critical' || tier === 'overload') {
            notify(`Server under load (${tier}) — quality may be reduced. CPU: ${cpu}% MEM: ${mem}%`, 'warning');
          }
        });
        socket.on('scan:complete', ({ type, added, total }) => {
          fetchLibrary(type);
          fetchLibraryPaths();
          notify(`Scan complete — added ${added} new ${type} files (${total} total)`, 'success');
          setLoading(prev => ({ ...prev, [type]: false }));
          setScanStatus(null);
        });
        socket.on('scan:error', ({ error }) => {
          notify('Scan error: ' + error, 'error');
          setScanStatus(null);
        });
        socket.on('item:updated', ({ id, item }) => {
          setLibrary(prev => {
            const out = { ...prev };
            for (const type of Object.keys(out)) {
              const idx = out[type].findIndex(i => i.id === id);
              if (idx >= 0) { out[type] = [...out[type]]; out[type][idx] = { ...out[type][idx], ...item }; break; }
            }
            return out;
          });
        });

      } catch { console.log('[Socket] Not available'); }
    })();
    return () => { if (socket) socket.disconnect(); };
  }, [fetchLibrary]);

  // ── Probe status polling — stops automatically when probe finishes ───────
  useEffect(() => {
    let stopped = false;
    const poll = setInterval(async () => {
      if (stopped) return;
      try {
        const r = await fetch(`http://${window.location.hostname}:3001/api/library/probe/status`);
        const data = await r.json();
        if (data.running) {
          setProbeStatus(data);
        } else {
          setProbeStatus(prev => {
            if (prev && prev.running) {
              setTimeout(() => setProbeStatus(null), 5000);
              return { ...data, justFinished: true };
            }
            return null;
          });
          // Stop polling once probe is done — no need to keep checking
          stopped = true;
          clearInterval(poll);
        }
      } catch {}
    }, 5000); // Reduced from 3s to 5s
    return () => { stopped = true; clearInterval(poll); };
  }, []);


  // ── Init ────────────────────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      // Load libraries in parallel
      await Promise.all(['movies','tvShows','music','musicVideos'].map(t => fetchLibrary(t)));
      await Promise.all([fetchLibraryPaths(), fetchHardwareInfo(), fetchCustomLibraries()]);
      try {
        const data = await fetch(`${API}/iptv/channels`).then(r=>r.json());
        setIptvChannels(data.channels || []);
      } catch {}
    })();
  }, [fetchLibrary, fetchLibraryPaths, fetchHardwareInfo]);

  return (
    <AppContext.Provider value={{
      theme, changeTheme,
      activeSection, setActiveSection,
      currentUser, setCurrentUser: setCurrentUserPersist,
      library, libraryCounts, fetchLibrary, fetchItemFull, scanFolders,
      libraryPaths, fetchLibraryPaths,
      customLibraries, fetchCustomLibraries,
      iptvChannels, loadIPTV, removeIPTVChannel, removeIPTVChannels, clearIPTVChannels,
      nowPlaying, playerOpen, playMedia, closePlayer,
      mediaQueue, queueIndex, playNext, playPrev,
      settings, setSettings,
      hardwareInfo,
      loading,
      notifications, notify,
      searchQuery, searchResults, search,
      metadataStatus,
      scanStatus,
      probeStatus,
      API
    }}>
      {children}
    </AppContext.Provider>
  );
}

export const useApp = () => {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
};

export default AppContext;

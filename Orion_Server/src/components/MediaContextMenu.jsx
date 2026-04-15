import React, { useState, useEffect, useRef, useCallback } from 'react';
import ReactDOM from 'react-dom';
import { useApp } from '../contexts/AppContext';

const API = 'http://localhost:3001/api';

// Global context menu state — only one open at a time
let _closeCurrentMenu = null;

export function MediaContextMenu({ item, x, y, onClose, onPlay, onInfo }) {
  const { playMedia, library } = useApp();
  const menuRef = useRef(null);
  const [submenu, setSubmenu] = useState(null); // 'collection' | 'playlist'
  const [collections, setCollections] = useState([]);
  const [playlists, setPlaylists] = useState([]);
  const [optimizeStatus, setOptimizeStatus] = useState(null);
  const [history, setHistory] = useState(null);
  const [showFixMatch, setShowFixMatch] = useState(false);
  const [searchQ, setSearchQ] = useState(item?.title || '');
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [queue, setQueue] = useState(() => {
    try { return JSON.parse(localStorage.getItem('orion_queue') || '[]'); } catch { return []; }
  });

  const isMusicType = item?.type === 'music' || item?.type === 'musicVideos';

  const refreshMetadata = async () => {
    onClose();
    try {
      await fetch(`${API}/library/item/${item.id}/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: item.type }) });
    } catch {}
  };

  const handleSearch = async () => {
    if (!searchQ.trim()) return;
    setSearching(true);
    try {
      // For music/musicVideo use MusicBrainz-style search via a TMDB search fallback
      const d = await fetch(`${API}/tmdb/search?q=${encodeURIComponent(searchQ)}&type=music`).then(r => r.json());
      setSearchResults(d.results || []);
    } catch {}
    setSearching(false);
  };

  const handleFixMatchSelect = async (tmdbId) => {
    setShowFixMatch(false);
    onClose();
    try {
      await fetch(`${API}/library/item/${item.id}/refresh`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tmdbId, type: item.type })
      });
    } catch {}
  };

  // Adjust position so menu doesn't go off screen
  const [pos, setPos] = useState({ x, y });
  useEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const nx = Math.min(x, window.innerWidth - rect.width - 8);
    const ny = Math.min(y, window.innerHeight - rect.height - 8);
    setPos({ x: nx, y: ny });
  }, [x, y]);

  // Close on outside click or Escape
  useEffect(() => {
    const handler = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) onClose();
    };
    const key = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', handler); document.removeEventListener('keydown', key); };
  }, [onClose]);

  // Fetch collections for submenu
  const openCollections = () => {
    setSubmenu('collection');
    fetch(`${API}/collections?slim=1`)
      .then(r => r.json())
      .then(d => setCollections((d.collections || []).filter(c => c.type === 'manual')))
      .catch(() => {});
  };

  // Fetch playlists (manual collections tagged as playlist)
  const openPlaylists = () => {
    setSubmenu('playlist');
    fetch(`${API}/collections?slim=1`)
      .then(r => r.json())
      .then(d => setPlaylists((d.collections || []).filter(c => c.type === 'playlist')))
      .catch(() => {});
  };

  const addToCollection = (colId) => {
    fetch(`${API}/collections/${colId}/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mediaId: item.id }),
    }).then(() => onClose());
  };

  const createPlaylist = () => {
    const name = prompt('Playlist name:');
    if (!name) return;
    fetch(`${API}/collections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, type: 'playlist', mediaIds: [item.id] }),
    }).then(() => onClose());
  };

  const addToQueue = () => {
    const newQueue = [...queue.filter(q => q.id !== item.id), item];
    localStorage.setItem('orion_queue', JSON.stringify(newQueue));
    setQueue(newQueue);
    // Notify
    window.dispatchEvent(new CustomEvent('orion:queue:updated', { detail: newQueue }));
    onClose();
  };

  const share = () => {
    const url = `${API}/stream?path=${encodeURIComponent(item.filePath)}&transcode=1`;
    if (navigator.clipboard) navigator.clipboard.writeText(url);
    alert(`Stream URL copied:\n${url}`);
    onClose();
  };

  const viewHistory = () => {
    if (!item.id) return;
    fetch(`${API}/activity?limit=50`)
      .then(r => r.json())
      .then(d => {
        const itemHistory = (d.activity || []).filter(a => a.mediaId === item.id);
        setHistory(itemHistory);
        setSubmenu('history');
      });
  };

  const optimize = () => {
    if (!item.filePath) return;
    const outDir = prompt('Output directory for optimized file:', '\\\\192.168.0.245\\media\\transcoded');
    if (!outDir) return;
    setOptimizeStatus('starting');
    fetch(`${API}/pretranscode/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outputDir: outDir, concurrency: 1 }),
    }).then(() => {
      setOptimizeStatus('running');
      setTimeout(() => { setOptimizeStatus(null); onClose(); }, 3000);
    }).catch(() => setOptimizeStatus('error'));
  };

  const fmtTime = (iso) => {
    if (!iso) return '';
    const d = new Date(iso), diff = Math.floor((Date.now() - d) / 60000);
    if (diff < 60) return `${diff}m ago`;
    if (diff < 1440) return `${Math.floor(diff/60)}h ago`;
    return d.toLocaleDateString();
  };

  const menuStyle = {
    position: 'fixed', zIndex: 99999,
    left: pos.x, top: pos.y,
    background: 'var(--bg-card, #1a1a2e)',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: 10,
    boxShadow: '0 20px 60px rgba(0,0,0,0.8)',
    minWidth: 220,
    overflow: 'hidden',
    userSelect: 'none',
  };

  const itemStyle = (danger) => ({
    display: 'flex', alignItems: 'center', gap: 10,
    padding: '9px 14px', cursor: 'pointer', fontSize: 13,
    color: danger ? '#ef4444' : 'var(--text-primary, #f0f0f0)',
    transition: 'background 0.1s',
  });

  const sep = <div style={{ height: 1, background: 'rgba(255,255,255,0.07)', margin: '3px 0' }} />;

  const videoCodec = item?.videoCodec?.toLowerCase();
  const isH264 = videoCodec === 'h264' || videoCodec === 'avc';
  const canOptimize = item?.filePath && !isH264;

  return (
    <>
    <div ref={menuRef} style={menuStyle} onClick={e => e.stopPropagation()}>
      {/* Header */}
      <div style={{ padding: '10px 14px 8px', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
        <div style={{ fontSize: 13, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 192 }}>
          {item?.title || 'Unknown'}
        </div>
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginTop: 2 }}>
          {item?.year && `${item.year} · `}{item?.type === 'movies' ? 'Movie' : 'TV Episode'}
          {item?.videoCodec && ` · ${item.videoCodec.toUpperCase()}`}
        </div>
      </div>

      {/* Main menu */}
      {!submenu && (
        <>
          <div style={itemStyle()} onMouseEnter={e=>e.currentTarget.style.background='rgba(255,255,255,0.07)'}
            onMouseLeave={e=>e.currentTarget.style.background='transparent'}
            onClick={() => { playMedia(item); onClose(); }}>
            <span>▶</span> Play Now
          </div>

          {sep}

          <div style={itemStyle()} onMouseEnter={e=>e.currentTarget.style.background='rgba(255,255,255,0.07)'}
            onMouseLeave={e=>e.currentTarget.style.background='transparent'}
            onClick={addToQueue}>
            <span>⊕</span> Add to Queue
          </div>

          <div style={{...itemStyle(), justifyContent:'space-between'}}
            onMouseEnter={e=>e.currentTarget.style.background='rgba(255,255,255,0.07)'}
            onMouseLeave={e=>e.currentTarget.style.background='transparent'}
            onClick={openCollections}>
            <span style={{display:'flex',alignItems:'center',gap:10}}><span>🗂</span> Add to Collection</span>
            <span style={{color:'rgba(255,255,255,0.35)',fontSize:11}}>›</span>
          </div>

          <div style={{...itemStyle(), justifyContent:'space-between'}}
            onMouseEnter={e=>e.currentTarget.style.background='rgba(255,255,255,0.07)'}
            onMouseLeave={e=>e.currentTarget.style.background='transparent'}
            onClick={openPlaylists}>
            <span style={{display:'flex',alignItems:'center',gap:10}}><span>📋</span> Add to Playlist</span>
            <span style={{color:'rgba(255,255,255,0.35)',fontSize:11}}>›</span>
          </div>

          {sep}

          <div style={itemStyle()} onMouseEnter={e=>e.currentTarget.style.background='rgba(255,255,255,0.07)'}
            onMouseLeave={e=>e.currentTarget.style.background='transparent'}
            onClick={() => { onInfo?.(item); onClose(); }}>
            <span>ℹ</span> Get Info
          </div>

          <div style={itemStyle()} onMouseEnter={e=>e.currentTarget.style.background='rgba(255,255,255,0.07)'}
            onMouseLeave={e=>e.currentTarget.style.background='transparent'}
            onClick={viewHistory}>
            <span>🕐</span> Play History
          </div>

          <div style={itemStyle()} onMouseEnter={e=>e.currentTarget.style.background='rgba(255,255,255,0.07)'}
            onMouseLeave={e=>e.currentTarget.style.background='transparent'}
            onClick={share}>
            <span>🔗</span> Share Stream URL
          </div>

          {sep}

          <div style={itemStyle()} onMouseEnter={e=>e.currentTarget.style.background='rgba(255,255,255,0.07)'}
            onMouseLeave={e=>e.currentTarget.style.background='transparent'}
            onClick={refreshMetadata}>
            <span>⟳</span> Refresh Metadata
          </div>

          <div style={itemStyle()} onMouseEnter={e=>e.currentTarget.style.background='rgba(255,255,255,0.07)'}
            onMouseLeave={e=>e.currentTarget.style.background='transparent'}
            onClick={() => { setShowFixMatch(true); setSearchQ(item?.title || ''); setSearchResults([]); }}>
            <span>🔍</span> Fix Match
          </div>

          {sep}

          <div style={{...itemStyle(!isH264 ? false : true), opacity: canOptimize ? 1 : 0.4}}
            onMouseEnter={e=>{ if(canOptimize) e.currentTarget.style.background='rgba(255,255,255,0.07)'; }}
            onMouseLeave={e=>e.currentTarget.style.background='transparent'}
            onClick={canOptimize ? optimize : undefined}>
            <span>⚡</span>
            {optimizeStatus === 'starting' ? 'Starting...' :
             optimizeStatus === 'running' ? 'Optimizing...' :
             optimizeStatus === 'error' ? 'Failed' :
             isH264 ? 'Already Optimized (H.264)' : 'Optimize (Convert to H.264)'}
          </div>
        </>
      )}

      {/* Collection submenu */}
      {submenu === 'collection' && (
        <>
          <div style={{padding:'8px 14px', fontSize:11, color:'rgba(255,255,255,0.4)', display:'flex', alignItems:'center', gap:8, cursor:'pointer'}}
            onClick={() => setSubmenu(null)}>‹ Add to Collection</div>
          {collections.length === 0 ? (
            <div style={{padding:'8px 14px', fontSize:12, color:'rgba(255,255,255,0.4)'}}>No collections yet</div>
          ) : collections.map(col => (
            <div key={col.id} style={itemStyle()}
              onMouseEnter={e=>e.currentTarget.style.background='rgba(255,255,255,0.07)'}
              onMouseLeave={e=>e.currentTarget.style.background='transparent'}
              onClick={() => addToCollection(col.id)}>
              🗂 {col.name} <span style={{fontSize:10,color:'rgba(255,255,255,0.35)',marginLeft:'auto'}}>{col.count}</span>
            </div>
          ))}
          <div style={{...itemStyle(), color:'var(--accent,#6366f1)'}}
            onMouseEnter={e=>e.currentTarget.style.background='rgba(255,255,255,0.07)'}
            onMouseLeave={e=>e.currentTarget.style.background='transparent'}
            onClick={() => { const n=prompt('Collection name:'); if(n) fetch(`${API}/collections`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:n,type:'manual',mediaIds:[item.id]})}).then(()=>onClose()); }}>
            + New Collection
          </div>
        </>
      )}

      {/* Playlist submenu */}
      {submenu === 'playlist' && (
        <>
          <div style={{padding:'8px 14px', fontSize:11, color:'rgba(255,255,255,0.4)', display:'flex', alignItems:'center', gap:8, cursor:'pointer'}}
            onClick={() => setSubmenu(null)}>‹ Add to Playlist</div>
          {playlists.length === 0 ? (
            <div style={{padding:'8px 14px', fontSize:12, color:'rgba(255,255,255,0.4)'}}>No playlists yet</div>
          ) : playlists.map(pl => (
            <div key={pl.id} style={itemStyle()}
              onMouseEnter={e=>e.currentTarget.style.background='rgba(255,255,255,0.07)'}
              onMouseLeave={e=>e.currentTarget.style.background='transparent'}
              onClick={() => addToCollection(pl.id)}>
              📋 {pl.name}
            </div>
          ))}
          <div style={{...itemStyle(), color:'var(--accent,#6366f1)'}}
            onMouseEnter={e=>e.currentTarget.style.background='rgba(255,255,255,0.07)'}
            onMouseLeave={e=>e.currentTarget.style.background='transparent'}
            onClick={createPlaylist}>
            + New Playlist
          </div>
        </>
      )}

      {/* History submenu */}
      {submenu === 'history' && (
        <>
          <div style={{padding:'8px 14px', fontSize:11, color:'rgba(255,255,255,0.4)', cursor:'pointer'}}
            onClick={() => setSubmenu(null)}>‹ Play History</div>
          {!history || history.length === 0 ? (
            <div style={{padding:'8px 14px', fontSize:12, color:'rgba(255,255,255,0.4)'}}>No history yet</div>
          ) : history.slice(0, 10).map((h, i) => (
            <div key={i} style={{padding:'8px 14px', fontSize:12, display:'flex', justifyContent:'space-between', borderBottom:'1px solid rgba(255,255,255,0.05)'}}>
              <span style={{color: h.action==='completed' ? '#10b981' : 'rgba(255,255,255,0.6)'}}>
                {h.action==='completed'?'✓ Completed':h.action==='paused'?'⏸ Paused':h.action==='started'?'▶ Started':'•'}
                {h.position > 0 && ` at ${Math.floor(h.position/60)}m`}
              </span>
              <span style={{color:'rgba(255,255,255,0.35)'}}>{fmtTime(h.timestamp)}</span>
            </div>
          ))}
        </>
      )}
    </div>

    {/* Fix Match Modal — portal to escape z-index issues */}
    {showFixMatch && ReactDOM.createPortal(
      <div style={{ position:'fixed', inset:0, zIndex:99999, display:'flex', alignItems:'center', justifyContent:'center', background:'rgba(0,0,0,0.8)', backdropFilter:'blur(8px)' }}
        onClick={e => { if (e.target === e.currentTarget) setShowFixMatch(false); }}>
        <div style={{ background:'#1a1a2e', border:'1px solid rgba(99,102,241,0.4)', borderRadius:14, padding:28, width:520, maxWidth:'90vw', maxHeight:'80vh', display:'flex', flexDirection:'column', boxShadow:'0 24px 64px rgba(0,0,0,0.9)' }}
          onClick={e => e.stopPropagation()}>
          <div style={{ fontSize:16, fontWeight:700, color:'white', marginBottom:6 }}>Fix Match</div>
          <div style={{ fontSize:13, color:'rgba(255,255,255,0.4)', marginBottom:18 }}>
            Search for correct metadata for <strong style={{ color:'rgba(255,255,255,0.7)' }}>{item?.title}</strong>
          </div>
          <div style={{ display:'flex', gap:8, marginBottom:16 }}>
            <input value={searchQ} onChange={e => setSearchQ(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSearch()}
              placeholder="Search..." autoFocus
              style={{ flex:1, padding:'9px 13px', background:'rgba(255,255,255,0.07)', border:'1px solid rgba(255,255,255,0.15)', borderRadius:8, color:'white', fontSize:14, outline:'none' }} />
            <button onClick={handleSearch} disabled={searching}
              style={{ padding:'9px 20px', background:'var(--accent)', color:'white', border:'none', borderRadius:8, cursor:'pointer', fontSize:14, fontWeight:600, opacity: searching ? 0.7 : 1 }}>
              {searching ? '…' : 'Search'}
            </button>
            <button onClick={() => setShowFixMatch(false)}
              style={{ padding:'9px 14px', background:'rgba(255,255,255,0.06)', color:'rgba(255,255,255,0.6)', border:'1px solid rgba(255,255,255,0.1)', borderRadius:8, cursor:'pointer', fontSize:14 }}>✕</button>
          </div>
          <div style={{ overflowY:'auto', flex:1 }}>
            {searching && <div style={{ color:'rgba(255,255,255,0.4)', textAlign:'center', padding:'20px 0' }}>Searching…</div>}
            {!searching && searchResults.length === 0 && searchQ && (
              <div style={{ color:'rgba(255,255,255,0.4)', textAlign:'center', padding:'20px 0' }}>No results. Try a different title.</div>
            )}
            {searchResults.map(r => (
              <div key={r.id} onClick={() => handleFixMatchSelect(r.id)}
                style={{ display:'flex', gap:14, padding:'10px 12px', borderRadius:8, cursor:'pointer', background:'rgba(255,255,255,0.03)', border:'1px solid rgba(255,255,255,0.07)', marginBottom:8 }}
                onMouseEnter={e => e.currentTarget.style.background='rgba(99,102,241,0.15)'}
                onMouseLeave={e => e.currentTarget.style.background='rgba(255,255,255,0.03)'}>
                {r.poster
                  ? <img src={r.poster} alt={r.title} style={{ width:42, height:62, borderRadius:5, objectFit:'cover', flexShrink:0 }} />
                  : <div style={{ width:42, height:62, borderRadius:5, background:'#2a2a3e', flexShrink:0, display:'flex', alignItems:'center', justifyContent:'center', fontSize:20 }}>🎵</div>}
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:14, fontWeight:700, color:'white' }}>{r.title} {r.year ? `(${r.year})` : ''}</div>
                  {r.rating && <div style={{ fontSize:12, color:'#fbbf24', marginTop:2 }}>★ {r.rating}</div>}
                  {r.overview && <div style={{ fontSize:12, color:'rgba(255,255,255,0.35)', marginTop:4, overflow:'hidden', display:'-webkit-box', WebkitLineClamp:2, WebkitBoxOrient:'vertical' }}>{r.overview}</div>}
                </div>
                <div style={{ flexShrink:0, alignSelf:'center', fontSize:12, color:'var(--accent)', fontWeight:700, padding:'4px 10px', border:'1px solid var(--accent)', borderRadius:5 }}>Select</div>
              </div>
            ))}
          </div>
        </div>
      </div>,
      document.body
    )}
    </>
  );
}

// Hook to use context menu on any element
export function useContextMenu() {
  const [menu, setMenu] = useState(null); // { item, x, y }

  const open = useCallback((e, item) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ item, x: e.clientX, y: e.clientY });
  }, []);

  const close = useCallback(() => setMenu(null), []);

  return { menu, open, close };
}

export default MediaContextMenu;

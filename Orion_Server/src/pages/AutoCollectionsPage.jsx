import React, { useState, useEffect } from 'react';
import { useApp } from '../contexts/AppContext';
import {
  Zap, Plus, Trash2, RefreshCw, Film, Tv, Star,
  Calendar, Tag, Clock, ChevronDown,
  ChevronRight, FolderOpen, ToggleLeft, ToggleRight, LayoutGrid
} from 'lucide-react';

const API = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') ? `http://${window.location.hostname}:3001/api` : `http://${window.location.hostname}:3001/api`;

const Toggle = ({ value, onChange }) => (
  <button onClick={() => onChange(!value)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: value ? 'var(--accent)' : 'var(--text-muted)' }}>
    {value ? <ToggleRight size={28} /> : <ToggleLeft size={28} />}
  </button>
);

const Section = ({ title, children }) => (
  <div style={{ marginBottom: 28 }}>
    <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 14, paddingBottom: 8, borderBottom: '1px solid var(--border)' }}>{title}</div>
    {children}
  </div>
);

const Row = ({ label, desc, children }) => (
  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
    <div>
      <div style={{ fontSize: 14, fontWeight: 500 }}>{label}</div>
      {desc && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{desc}</div>}
    </div>
    <div style={{ flexShrink: 0, marginLeft: 16 }}>{children}</div>
  </div>
);

// ── Progress Bar component ────────────────────────────────────────────────────
function ProgressBar({ progress, color = 'var(--accent)' }) {
  if (!progress) return (
    <div style={{ height: 7, background: 'var(--bg-tertiary)', borderRadius: 4 }}>
      <div style={{ height: '100%', width: '0%', background: color, borderRadius: 4 }} />
    </div>
  );

  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  const isComplete = progress.phase === 'complete';
  const isError    = progress.phase === 'error';
  const isRunning  = progress.running;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6 }}>
        <span style={{ color: isComplete ? '#10b981' : isError ? '#ef4444' : 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '75%' }}>
          {isComplete ? '✅ ' : isError ? '❌ ' : isRunning ? '⚙️ ' : ''}
          {progress.current || (isRunning ? 'Processing...' : 'Ready')}
        </span>
        <span style={{ color: 'var(--text-muted)', flexShrink: 0, marginLeft: 8 }}>
          {progress.total > 0 ? `${progress.done} / ${progress.total} (${pct}%)` : progress.done > 0 ? `${progress.done} processed` : ''}
        </span>
      </div>
      <div style={{ height: 7, background: 'var(--bg-tertiary)', borderRadius: 4, overflow: 'hidden' }}>
        {isComplete ? (
          <div style={{ height: '100%', width: '100%', background: '#10b981', borderRadius: 4 }} />
        ) : isError ? (
          <div style={{ height: '100%', width: '100%', background: '#ef4444', borderRadius: 4 }} />
        ) : progress.total > 0 ? (
          <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 4, transition: 'width 0.4s ease' }} />
        ) : isRunning ? (
          <div style={{ height: '100%', width: '35%', background: color, borderRadius: 4, animation: 'progressPulse 1.2s ease-in-out infinite' }} />
        ) : (
          <div style={{ height: '100%', width: '0%', background: color, borderRadius: 4 }} />
        )}
      </div>
    </div>
  );
}

export default function AutoCollectionsPage() {
  const { library } = useApp();
  const [tab,          setTab]          = useState('auto');
  const [collections,  setCollections]  = useState([]);
  const [config,       setConfig]       = useState(null);
  const [running,      setRunning]      = useState(false);
  const [lastRun,      setLastRun]      = useState(null);
  const [runLog,       setRunLog]       = useState([]);
  const [newColName,   setNewColName]   = useState('');
  const [newColType,   setNewColType]   = useState('manual');
  const [showNewCol,   setShowNewCol]   = useState(false);
  const [expandedCol,  setExpandedCol]  = useState(null);
  const [categories,   setCategories]   = useState([]);
  const [buildProgress, setBuildProgress] = useState(null);
  const [streamProgress, setStreamProgress] = useState(null);
  const [streamPolling,  setStreamPolling]  = useState(false);

  const TABS = [
    { id: 'collections', label: '📚 Collections' },
    { id: 'auto',        label: '⚡ Auto-Build'  },
    { id: 'overlays',    label: '🏷 Overlays'    },
    { id: 'schedule',    label: '🕐 Schedule'    },
  ];

  const [apiKeys, setApiKeys] = useState({ tmdb: '', omdbApiKey: '', lastfm: '', fanart: '', tvdb: '' });
  const [apiSaved, setApiSaved] = useState(false);

  useEffect(() => {
    fetch(`${API}/config`).then(r => r.json()).then(d => {
      if (d.tmdbApiKey)  setApiKeys(k => ({ ...k, tmdb: d.tmdbApiKey }));
      if (d.omdbApiKey)  setApiKeys(k => ({ ...k, omdbApiKey: d.omdbApiKey }));
      if (d.lastfmKey)   setApiKeys(k => ({ ...k, lastfm: d.lastfmKey }));
      if (d.fanartKey)   setApiKeys(k => ({ ...k, fanart: d.fanartKey }));
      if (d.tvdbKey)     setApiKeys(k => ({ ...k, tvdb: d.tvdbKey }));
    }).catch(() => {});
  }, []);

  const saveApiKeys = async () => {
    await fetch(`${API}/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tmdbApiKey: apiKeys.tmdb || '', omdbApiKey: apiKeys.omdbApiKey || '', lastfmKey: apiKeys.lastfm || '', fanartKey: apiKeys.fanart || '', tvdbKey: apiKeys.tvdb || '' }) });
    setApiSaved(true);
    setTimeout(() => setApiSaved(false), 2500);
  };

  useEffect(() => { fetchCollections(); fetchConfig(); fetchCategories(); }, []);

  const fetchCollections = async () => {
    try { const d = await fetch(`${API}/collections?slim=1`).then(r => r.json()); setCollections(d.collections || []); } catch {}
  };

  const fetchConfig = async () => {
    try {
      const d = await fetch(`${API}/autocollections/config`).then(r => r.json());
      setConfig(d);
      if (d.overlays) { try { localStorage.setItem('orion_overlay_config', JSON.stringify(d.overlays)); } catch {} }
      if (d.lastRun) setLastRun(new Date(d.lastRun));
    } catch {}
  };

  const fetchCategories = async () => {
    try { const d = await fetch(`${API}/categories`).then(r => r.json()); setCategories(d.categories || []); } catch {}
  };

  // ── Streaming status polling ──────────────────────────────────────────────
  useEffect(() => {
    fetch(`${API}/autocollections/streaming/status`).then(r => r.json())
      .then(d => { setStreamProgress(d); if (d.running) setStreamPolling(true); }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!streamPolling) return;
    const t = setInterval(() => {
      fetch(`${API}/autocollections/streaming/status`).then(r => r.json()).then(d => {
        setStreamProgress(d);
        if (!d.running) { setStreamPolling(false); fetchCollections(); }
      }).catch(() => {});
    }, 800);
    return () => clearInterval(t);
  }, [streamPolling]);

  const runStreaming = async (mediaType) => {
    if (streamProgress?.running) return;
    setStreamProgress({ running: true, phase: mediaType, done: 0, total: 0, current: 'Starting...' });
    setStreamPolling(true);
    try {
      await fetch(`${API}/autocollections/streaming/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mediaType }) });
    } catch(e) {
      setStreamProgress({ running: false, phase: 'error', current: e.message });
      setStreamPolling(false);
    }
  };

  // ── Main build ────────────────────────────────────────────────────────────
  const runBuilder = async () => {
    setRunning(true);
    setRunLog(['⚡ Starting auto-collection builder...']);
    setBuildProgress({ running: true, phase: 'starting', current: 'Initializing...', done: 0, total: 0 });
    try {
      await fetch(`${API}/autocollections/run`, { method: 'POST' });
      const poll = setInterval(async () => {
        try {
          const s = await fetch(`${API}/autocollections/status`).then(r => r.json());
          setBuildProgress(s);
          if (s.current) {
            const icon = s.phase === 'genres' ? '🎭' : s.phase === 'franchises' ? '🎬' : s.phase === 'networks' ? '📡' : s.phase === 'actors' ? '🎭' : s.phase === 'directors' ? '🎬' : s.phase === 'complete' ? '✅' : '⚙️';
            const line = `${icon} ${s.current}`;
            setRunLog(prev => prev[prev.length - 1] === line ? prev : [...prev.slice(-8), line]);
          }
          if (!s.running) {
            clearInterval(poll);
            setRunning(false);
            setLastRun(new Date());
            const colData = await fetch(`${API}/collections?slim=1`).then(r => r.json());
            setCollections(colData.collections || []);
            setRunLog(prev => [...prev, `✅ Done! ${s.done || colData.collections?.length} collections built`]);
          }
        } catch {}
      }, 800);
      setTimeout(() => { clearInterval(poll); setRunning(false); }, 300000);
    } catch(e) {
      setRunLog(prev => [...prev, '❌ Error: ' + e.message]);
      setRunning(false);
    }
  };

  const saveConfig = async (updates) => {
    const newConfig = { ...config, ...updates };
    setConfig(newConfig);
    if (newConfig.overlays) { try { localStorage.setItem('orion_overlay_config', JSON.stringify(newConfig.overlays)); } catch {} }
    try {
      await fetch(`${API}/autocollections/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(newConfig) });
    } catch {}
    if (updates.metadataSource !== undefined) {
      try { await fetch(`${API}/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ metadataSource: updates.metadataSource }) }); } catch {}
    }
  };

  const createCollection = async () => {
    if (!newColName.trim()) return;
    try {
      const col = await fetch(`${API}/collections`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: newColName, type: newColType }) }).then(r => r.json());
      setCollections(prev => [...prev, col]);
      setNewColName(''); setShowNewCol(false);
    } catch {}
  };

  const deleteCollection = async (id) => {
    if (!window.confirm('Delete this collection?')) return;
    await fetch(`${API}/collections/${id}`, { method: 'DELETE' });
    setCollections(prev => prev.filter(c => c.id !== id));
  };

  const autoColTypes = [
    { key: 'byGenre',    label: 'By Genre',     desc: 'Action, Comedy, Drama, etc.', icon: '🎭' },
    { key: 'byDecade',   label: 'By Decade',    desc: '80s Decade, 90s Decade, etc.', icon: '📅' },
    { key: 'byYear',     label: 'By Year',      desc: 'One collection per release year', icon: '🗓' },
    { key: 'byRating',   label: 'Top Rated',    desc: 'Top 100, Top 250, etc.', icon: '⭐' },
    { key: 'byDirector', label: 'By Director',  desc: 'Group by director name', icon: '🎬' },
    { key: 'byActor',    label: 'By Actor',     desc: 'Group by main cast member', icon: '🎭' },
    { key: 'byHoliday',  label: 'Holiday Collections', desc: "Christmas, Halloween, Valentine's Day etc.", icon: '🎄' },
    { key: 'byBirthday', label: 'Celebrity Birthdays', desc: 'Titles starring actors born this month', icon: '🎂' },
  ];

  const overlayTypes = [
    { key: 'showStreaming',     label: 'Streaming Service',  desc: 'Netflix, Disney+, HBO Max, Hulu, Prime, etc.', icon: '📡' },
    { key: 'showRating',        label: 'IMDb/TMDB Rating',   desc: 'Star rating badge', icon: '⭐' },
    { key: 'showResolution',    label: 'Resolution',         desc: '4K, 1080p, 720p — detected from file', icon: '📺' },
    { key: 'showHDR',           label: 'HDR Format',         desc: 'HDR10, Dolby Vision, HLG', icon: '✨' },
    { key: 'showAudioCodec',    label: 'Audio Codec',        desc: 'Atmos, DTS-X, TrueHD, DTS', icon: '🔊' },
    { key: 'showVideoCodec',    label: 'Video Codec',        desc: 'H.265/HEVC, H.264, AV1', icon: '🎞' },
    { key: 'showContentRating', label: 'Content Rating',     desc: 'G, PG, PG-13, R, TV-MA etc.', icon: '🔞' },
    { key: 'showEdition',       label: 'Edition',            desc: "Director's Cut, Extended, Unrated", icon: '🎬' },
    { key: 'showNew',           label: 'New Badge',          desc: 'NEW badge on items added in last 30 days', icon: '🆕' },
    { key: 'showFranchise',     label: 'Franchise Ribbon',   desc: 'Franchise name ribbon on poster', icon: '🎖' },
    { key: 'showTVStatus',      label: 'TV Show Status',     desc: 'RETURNING, ENDED, CANCELED badge', icon: '📡' },
  ];

  const collectionTypeColors = { 'manual': 'var(--accent)', 'auto-genre': '#10b981', 'auto-decade': '#8b5cf6', 'auto-year': '#f59e0b', 'auto-rating': '#ef4444', 'streaming': '#06b6d4', 'network': '#f59e0b', 'franchise': '#6366f1' };

  return (
    <div className="page">
      <div className="page-header">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div className="page-title">⚡ Collections Builder</div>
            <div className="page-subtitle">Auto-build collections, overlays and smart filters</div>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            {lastRun && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Last run: {lastRun.toLocaleTimeString()}</span>}
            <button className="btn btn-secondary" disabled={running} onClick={async () => {
              setRunning(true);
              setRunLog(['🎬 Building franchise collections...']);
              try {
                await fetch(`${API}/autocollections/franchises`, { method: 'POST' });
                const poll = setInterval(async () => {
                  try {
                    const s = await fetch(`${API}/autocollections/status`).then(r => r.json());
                    if (!s.running) {
                      clearInterval(poll); setRunning(false); setLastRun(new Date());
                      const colData = await fetch(`${API}/collections?slim=1`).then(r => r.json());
                      setCollections(colData.collections || []);
                      setRunLog(prev => [...prev, `✅ Done!`]);
                    }
                  } catch {}
                }, 1000);
                setTimeout(() => { clearInterval(poll); setRunning(false); }, 300000);
              } catch(e) { setRunLog(prev => [...prev, '❌ Error: ' + e.message]); setRunning(false); }
            }} style={{ gap: 8 }}>
              {running ? <><RefreshCw size={14} style={{ animation: 'spin 1s linear infinite' }} /> Building...</> : <>🎬 Build Franchise Collections</>}
            </button>
            <button className="btn btn-primary" onClick={runBuilder} disabled={running} style={{ gap: 8 }}>
              {running ? <><RefreshCw size={14} style={{ animation: 'spin 1s linear infinite' }} /> Building...</> : <>🎬 Build Franchise Collections</>}
            </button>
          </div>
        </div>
      </div>

      {/* Run Log + Progress Bar — always visible when active */}
      {(runLog.length > 0 || buildProgress?.running) && (
        <div style={{ margin: '0 48px 20px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '12px 16px' }}>
          {buildProgress && <div style={{ marginBottom: runLog.length > 0 ? 12 : 0 }}><ProgressBar progress={buildProgress} /></div>}
          {runLog.map((line, i) => (
            <div key={i} style={{ fontFamily: 'monospace', fontSize: 12, color: line.startsWith('❌') ? '#ef4444' : line.startsWith('✅') ? '#10b981' : 'var(--text-secondary)', marginBottom: 2 }}>{line}</div>
          ))}
          {running && <div style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--accent)', animation: 'pulse 1s infinite' }}>...</div>}
        </div>
      )}

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 4, padding: '0 48px 24px', borderBottom: '1px solid var(--border)', marginBottom: 28 }}>
        {TABS.map(({ id, label }) => (
          <button key={id} onClick={() => setTab(id)} style={{
            padding: '9px 18px', borderRadius: 'var(--radius)', border: 'none', cursor: 'pointer',
            fontSize: 13, fontWeight: 600,
            background: tab === id ? 'var(--tag-bg)' : 'transparent',
            color: tab === id ? 'var(--accent)' : 'var(--text-secondary)',
            transition: 'all 0.15s'
          }}>{label}</button>
        ))}
      </div>

      <div style={{ padding: '0 48px 48px' }}>

        {/* ── Collections Tab ────────────────────────────────────────────── */}
        {tab === 'collections' && (
          <div>
            <div style={{ display: 'flex', gap: 12, marginBottom: 24 }}>
              {[
                { label: 'Total Collections', value: collections.length, icon: '📚' },
                { label: 'Auto-generated', value: collections.filter(c => c.type?.startsWith('auto')).length, icon: '⚡' },
                { label: 'Streaming', value: collections.filter(c => c.type === 'streaming').length, icon: '📡' },
                { label: 'Manual', value: collections.filter(c => c.type === 'manual').length, icon: '✋' },
              ].map(({ label, value, icon }) => (
                <div key={label} style={{ flex: 1, background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '14px 16px' }}>
                  <div style={{ fontSize: 22, marginBottom: 4 }}>{icon}</div>
                  <div style={{ fontSize: 20, fontWeight: 700 }}>{value}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{label}</div>
                </div>
              ))}
            </div>

            {showNewCol ? (
              <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-accent)', borderRadius: 'var(--radius-lg)', padding: 16, marginBottom: 20 }}>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12 }}>New Collection</div>
                <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
                  <input value={newColName} onChange={e => setNewColName(e.target.value)} onKeyDown={e => e.key === 'Enter' && createCollection()}
                    placeholder="Collection name..." style={{ flex: 1, padding: '8px 12px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', color: 'var(--text-primary)', fontSize: 13, outline: 'none' }} />
                  <select value={newColType} onChange={e => setNewColType(e.target.value)} className="select-input">
                    <option value="manual">Manual</option>
                    <option value="smart">Smart Filter</option>
                  </select>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-primary btn-sm" onClick={createCollection}>Create</button>
                  <button className="btn btn-secondary btn-sm" onClick={() => setShowNewCol(false)}>Cancel</button>
                </div>
              </div>
            ) : (
              <button className="btn btn-secondary btn-sm" onClick={() => setShowNewCol(true)} style={{ marginBottom: 20 }}>
                <Plus size={14} /> New Collection
              </button>
            )}

            {collections.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state-icon">📚</div>
                <h3>No collections yet</h3>
                <p>Run the auto-builder to generate collections from your library.</p>
                <button className="btn btn-primary" onClick={runBuilder}><Zap size={14} /> Run Auto-Builder</button>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {collections.map(col => (
                  <div key={col.id}>
                    <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', overflow: 'hidden' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', cursor: 'pointer' }}
                        onClick={() => setExpandedCol(expandedCol === col.id ? null : col.id)}>
                        <div style={{ width: 8, height: 8, borderRadius: '50%', background: collectionTypeColors[col.type] || 'var(--accent)', flexShrink: 0 }} />
                        <div style={{ flex: 1 }}>
                          <div style={{ fontWeight: 600, fontSize: 14 }}>{col.name}</div>
                          <div style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', gap: 10, marginTop: 2 }}>
                            <span>{col.mediaIds?.length || 0} items</span>
                            <span style={{ textTransform: 'capitalize' }}>{col.type?.replace('auto-', 'Auto: ') || 'Manual'}</span>
                            {col.updatedAt && <span>Updated {new Date(col.updatedAt).toLocaleDateString()}</span>}
                          </div>
                        </div>
                        {expandedCol === col.id ? <ChevronDown size={16} color="var(--text-muted)" /> : <ChevronRight size={16} color="var(--text-muted)" />}
                        <button onClick={(e) => { e.stopPropagation(); deleteCollection(col.id); }}
                          style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 4 }}>
                          <Trash2 size={14} />
                        </button>
                      </div>
                      {expandedCol === col.id && (
                        <div style={{ borderTop: '1px solid var(--border)', padding: '12px 16px', background: 'var(--bg-tertiary)' }}>
                          {col.description && <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12 }}>{col.description}</p>}
                          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                            Sort by: <strong>{col.sortBy || 'title'}</strong> &nbsp;•&nbsp; Created: {col.createdAt ? new Date(col.createdAt).toLocaleDateString() : 'Unknown'}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Auto-Build Tab ─────────────────────────────────────────────── */}
        {tab === 'auto' && config && (
          <div>

            {/* ── Main Auto Builder ── */}
            <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: 20, marginBottom: 24 }}>
              <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>⚡ Auto-Collection Builder</div>
              <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>
                Builds genre, decade, network, franchise, actor, and director collections from your library.
                Analyzes {(library.movies?.length || 0).toLocaleString()} movies and {(library.tvShows?.length || 0).toLocaleString()} TV episodes.
              </div>
              <button className="btn btn-primary" onClick={runBuilder} disabled={running} style={{ gap: 8, marginBottom: 16 }}>
                {running
                  ? <><RefreshCw size={14} style={{ animation: 'spin 1s linear infinite' }} /> Building...</>
                  : <><Zap size={14} /> Build Collections Now</>}
              </button>
              <ProgressBar progress={buildProgress} />
            </div>

            {/* ── Streaming Collections ── */}
            <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: 20, marginBottom: 24 }}>
              <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>📡 Streaming Service Collections</div>
              <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>
                Groups your library by streaming service (Netflix, Disney+, Hulu, etc.) using watchProvider data from TMDB.
                Run separately for Movies and TV Shows.
              </div>
              <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
                {[
                  { label: '🎬 Build Movie Collections', mediaType: 'movies' },
                  { label: '📺 Build TV Collections',    mediaType: 'tvShows' },
                  { label: '🔄 Build Both',              mediaType: 'both' },
                ].map(({ label, mediaType }) => (
                  <button key={mediaType} className="btn btn-secondary"
                    onClick={() => runStreaming(mediaType)}
                    disabled={streamProgress?.running}
                    style={{ opacity: streamProgress?.running ? 0.5 : 1 }}>
                    {streamProgress?.running ? <><RefreshCw size={14} style={{ animation: 'spin 1s linear infinite' }} /> Running...</> : label}
                  </button>
                ))}
              </div>
              <ProgressBar progress={streamProgress} color="#06b6d4" />
              {!streamProgress?.running && streamProgress?.phase === 'complete' && (
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
                  {collections.filter(c => c.type === 'streaming' && c.mediaType === 'movies').length} movie collections · {collections.filter(c => c.type === 'streaming' && c.mediaType === 'tvShows').length} TV collections built
                </div>
              )}
            </div>

            <Section title="Auto-Collection Types">
              {autoColTypes.map(({ key, label, desc, icon }) => (
                <Row key={key} label={`${icon} ${label}`} desc={desc}>
                  <Toggle value={config.autoCollections?.[key] ?? false} onChange={val => saveConfig({ autoCollections: { ...config.autoCollections, [key]: val } })} />
                </Row>
              ))}
            </Section>

            <Section title="Collection Settings">
              <Row label="Minimum items per collection" desc="Skip collections with fewer items than this">
                <select className="select-input" value={config.minItems || 3} onChange={e => saveConfig({ minItems: parseInt(e.target.value) })}>
                  {[2,3,5,10,20].map(n => <option key={n} value={n}>{n} items</option>)}
                </select>
              </Row>
              <Row label="Sort collections by" desc="Default sort order within each collection">
                <select className="select-input" value={config.defaultSort || 'rating'} onChange={e => saveConfig({ defaultSort: e.target.value })}>
                  <option value="rating">Rating (High to Low)</option>
                  <option value="year">Year (Newest First)</option>
                  <option value="title">Title (A-Z)</option>
                  <option value="added">Recently Added</option>
                </select>
              </Row>
              <Row label="Include TV Shows in genre collections" desc="Mix movies and shows in the same collection">
                <Toggle value={config.includeTVInGenres ?? true} onChange={val => saveConfig({ includeTVInGenres: val })} />
              </Row>
            </Section>

            {categories.filter(c => c.type === 'genre').length > 0 && (
              <Section title={`Genre Collections Preview (${categories.filter(c => c.type === 'genre').length} genres)`}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {categories.filter(c => c.type === 'genre').slice(0, 30).map(cat => (
                    <div key={cat.name} style={{ padding: '4px 10px', background: 'var(--tag-bg)', border: '1px solid var(--border-accent)', borderRadius: 20, fontSize: 12, color: 'var(--tag-color)' }}>
                      {cat.name} <span style={{ opacity: 0.6 }}>({cat.count})</span>
                    </div>
                  ))}
                </div>
              </Section>
            )}
          </div>
        )}

        {/* ── Overlays Tab ───────────────────────────────────────────────── */}
        {tab === 'overlays' && config && (
          <div>
            <div style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)', borderRadius: 'var(--radius-lg)', padding: '14px 18px', marginBottom: 24, display: 'flex', gap: 12, alignItems: 'center' }}>
              <span style={{ fontSize: 20 }}>🏷</span>
              <div>
                <div style={{ fontWeight: 700, fontSize: 13, color: '#fbbf24' }}>Poster Overlays</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>Badges displayed on poster images in the library. Toggle each type on or off. Changes apply immediately.</div>
              </div>
            </div>
            <Section title="Overlay Badges">
              {overlayTypes.map(({ key, label, desc, icon }) => (
                <Row key={key} label={`${icon} ${label}`} desc={desc}>
                  <Toggle value={config.overlays?.[key] ?? false} onChange={val => saveConfig({ overlays: { ...config.overlays, [key]: val } })} />
                </Row>
              ))}
            </Section>
            <Section title="Overlay Style">
              <Row label="Badge position" desc="Where badges appear on the poster">
                <select className="select-input" value={config.overlayPosition || 'top-left'} onChange={e => saveConfig({ overlayPosition: e.target.value })}>
                  <option value="top-left">Top Left</option>
                  <option value="top-right">Top Right</option>
                  <option value="bottom-left">Bottom Left</option>
                  <option value="bottom-right">Bottom Right</option>
                </select>
              </Row>
              <Row label="Badge style" desc="Visual style of the overlay badges">
                <select className="select-input" value={config.overlayStyle || 'rounded'} onChange={e => saveConfig({ overlayStyle: e.target.value })}>
                  <option value="rounded">Rounded</option>
                  <option value="square">Square</option>
                  <option value="ribbon">Ribbon</option>
                </select>
              </Row>
            </Section>
          </div>
        )}

        {/* ── Schedule Tab ───────────────────────────────────────────────── */}
        {tab === 'schedule' && config && (
          <div>
            <Section title="Auto-Run Schedule">
              <Row label="Enable scheduled runs" desc="Automatically rebuild collections on a schedule">
                <Toggle value={config.scheduleEnabled ?? false} onChange={val => saveConfig({ scheduleEnabled: val })} />
              </Row>
              <Row label="Run frequency" desc="How often to auto-rebuild collections">
                <select className="select-input" value={config.schedule || 'daily'} onChange={e => saveConfig({ schedule: e.target.value })} disabled={!config.scheduleEnabled}>
                  <option value="hourly">Every Hour</option>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                </select>
              </Row>
              <Row label="Run on library scan" desc="Auto-rebuild after adding new media">
                <Toggle value={config.runOnScan ?? true} onChange={val => saveConfig({ runOnScan: val })} />
              </Row>
              <Row label="Run on startup" desc="Auto-rebuild when Orion starts">
                <Toggle value={config.runOnStartup ?? false} onChange={val => saveConfig({ runOnStartup: val })} />
              </Row>
            </Section>
            <Section title="Status">
              <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: 16 }}>
                {[
                  { label: 'Schedule', value: config.scheduleEnabled ? `Runs ${config.schedule || 'daily'}` : 'Disabled' },
                  { label: 'Last Run', value: lastRun ? lastRun.toLocaleString() : 'Never' },
                  { label: 'Total Collections', value: collections.length },
                  { label: 'Streaming Collections', value: collections.filter(c => c.type === 'streaming').length },
                ].map(({ label, value }) => (
                  <div key={label} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border)', fontSize: 13 }}>
                    <span style={{ color: 'var(--text-muted)' }}>{label}</span>
                    <span style={{ fontWeight: 600 }}>{value}</span>
                  </div>
                ))}
              </div>
              <button className="btn btn-primary" onClick={runBuilder} disabled={running} style={{ marginTop: 16, gap: 8 }}>
                {running ? <><RefreshCw size={14} style={{ animation: 'spin 1s linear infinite' }} /> Running...</> : <><Zap size={14} /> Run Now</>}
              </button>
            </Section>
          </div>
        )}

      </div>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
        @keyframes progressPulse { 0%{transform:translateX(-100%)} 100%{transform:translateX(350%)} }
      `}</style>
    </div>
  );
}

import React, { useState, useMemo, useCallback, useRef } from 'react';
import { useApp } from '../contexts/AppContext';
import { Link, FolderOpen, Search, Play, Tv, ArrowUpDown, Trash2, X, Wifi, Loader, Globe } from 'lucide-react';

const SORT_OPTIONS = [
  { value: 'name-asc',   label: 'Name A–Z' },
  { value: 'name-desc',  label: 'Name Z–A' },
  { value: 'group-asc',  label: 'Group A–Z' },
  { value: 'group-desc', label: 'Group Z–A' },
];

const CONCURRENCY = 3; // Reduced to avoid CPU spikes during playback

const ENGLISH_COUNTRIES = new Set([
  'US','GB','CA','AU','NZ','IE','ZA','JM','TT','BB','GH','NG','KE','SG','PH','IN','PK','MY'
]);

function isNonEnglish(ch) {
  if (ch.country && !ENGLISH_COUNTRIES.has(ch.country)) return true;
  if (ch.language && !/^en(g(lish)?)?$/i.test(ch.language)) return true;
  if (/[\u0600-\u06FF\u0400-\u04FF\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF\u0900-\u097F]/.test(ch.name)) return true;
  return false;
}

function normalizeName(name) {
  return name.toLowerCase()
    .replace(/\b(4k|uhd|fhd|hd|sd|hevc|h265|h264|avc|hdr|sdr)\b/gi, '')
    .replace(/\b(2160p?|1080p?|720p?|480p?|360p?)\b/gi, '')
    .replace(/[|\-_.[\]()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Basic cable channel names — fuzzy matched against channel name
const BASIC_CABLE = [
  // Broadcast networks
  'abc','nbc','cbs','fox','pbs','cw','the cw','ion','telemundo','univision',
  // News
  'cnn','fox news','msnbc','cnbc','headline news','hln','bbc','bbc news',
  'bbc world','abc news','nbc news','cbs news','fox business','bloomberg',
  'c-span','cspan',
  // Sports
  'espn','espn2','espn3','espnu','espnews','fox sports','fs1','fs2','nfl network',
  'nba tv','mlb network','nhl network','golf channel','tennis channel','olympic',
  'big ten','sec network','acc network','pac 12',
  // Entertainment
  'tnt','tbs','usa','usa network','fx','fxx','amc','amc+','ifc','sundance',
  'bravo','oxygen','we tv','lifetime','hallmark','hallmark movies',
  'syfy','sci fi','e!','e entertainment','mtv','vh1','bet','comedy central',
  'cartoon network','adult swim','nickelodeon','nick jr','nick at nite',
  'disney','disney channel','disney xd','disney junior','freeform','abc family',
  'a&e','history','history channel','military','crime','investigation discovery',
  'id','true crime','court tv',
  // Lifestyle
  'hgtv','food network','cooking channel','travel channel','tlc','discovery',
  'animal planet','national geographic','nat geo','nat geo wild','bbc earth',
  'diy','diy network','magnolia','magnolia network',
  // Music / Other
  'mtv2','mtv classic','bet her','bmt','cmt','great american country','gac',
  'fuse','vh1 classic','palladia',
  // Kids
  'boomerang','baby tv','sprout','universal kids','pbs kids','treehouse',
  // Premium basic
  'amc','amc+','tmc','max','hbo','showtime','starz','epix',
  // Weather / Info
  'weather','weather channel','the weather','local now','newsy',
];

function isBasicCable(ch) {
  const n = normalizeName(ch.name);
  // Exact or starts-with match on any basic cable name
  return BASIC_CABLE.some(b => n === b || n.startsWith(b + ' ') || n.endsWith(' ' + b));
}

export default function IPTVPage() {
  const { iptvChannels, loadIPTV, uploadIPTVFile, playMedia, loading, clearIPTVChannels, removeIPTVChannel, removeIPTVChannels, API } = useApp();

  const [m3uUrl, setM3uUrl]                = useState('');
  const [search, setSearch]                = useState('');
  const [activeGroup, setActiveGroup]      = useState('All');
  const [sort, setSort]                    = useState('name-asc');
  const [showSortMenu, setShowSortMenu]    = useState(false);
  const [scanning, setScanning]            = useState(false);
  const [scanStatus, setScanStatus]        = useState({});
  const [scanMs, setScanMs]                = useState({});
  const [scanProgress, setScanProgress]    = useState({ done: 0, total: 0 });
  const [showDeadOnly, setShowDeadOnly]    = useState(false);
  const [showGeoOnly, setShowGeoOnly]      = useState(false);
  const [showDupeOnly, setShowDupeOnly]    = useState(false);
  const [showNonEnglish, setShowNonEnglish]= useState(false);
  const [showBasicCable, setShowBasicCable]  = useState(false);
  const [showGroupManager, setShowGroupManager] = useState(false);
  const [groupSearch, setGroupSearch]      = useState('');
  const scanAbortRef = useRef(false);

  const basicCableIds = useMemo(() =>
    new Set(iptvChannels.filter(isBasicCable).map(c => c.id)),
    [iptvChannels]
  );

  const nonEnglishIds = useMemo(() =>
    new Set(iptvChannels.filter(isNonEnglish).map(c => c.id)),
    [iptvChannels]
  );

  // Group duplicates by normalized name; rank by scan speed if available
  const { dupeIds, dupeCount } = useMemo(() => {
    const grouped = {};
    for (const ch of iptvChannels) {
      const key = normalizeName(ch.name);
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(ch);
    }
    const toRemove = new Set();
    let count = 0;
    for (const group of Object.values(grouped)) {
      if (group.length < 2) continue;
      count += group.length - 1;
      const sorted = [...group].sort((a, b) => {
        const sa = scanStatus[a.id], sb = scanStatus[b.id];
        const ma = scanMs[a.id] ?? Infinity, mb = scanMs[b.id] ?? Infinity;
        if (sa === 'ok' && sb !== 'ok') return -1;
        if (sb === 'ok' && sa !== 'ok') return 1;
        return ma - mb;
      });
      for (let i = 1; i < sorted.length; i++) toRemove.add(sorted[i].id);
    }
    return { dupeIds: toRemove, dupeCount: count };
  }, [iptvChannels, scanStatus, scanMs]);

  const groups = useMemo(() =>
    ['All', ...new Set(iptvChannels.map(c => c.group).filter(Boolean)).values()].sort(),
    [iptvChannels]
  );

  const filtered = useMemo(() => {
    let list = iptvChannels.filter(ch => {
      const matchesSearch = ch.name.toLowerCase().includes(search.toLowerCase());
      const matchesGroup  = activeGroup === 'All' || ch.group === activeGroup;
      const matchesDead   = !showDeadOnly   || scanStatus[ch.id] === 'dead';
      const matchesGeo    = !showGeoOnly    || scanStatus[ch.id] === 'geo';
      const matchesDupe   = !showDupeOnly   || dupeIds.has(ch.id);
      const matchesNonEng   = !showNonEnglish || nonEnglishIds.has(ch.id);
      const matchesBasicCable = !showBasicCable  || basicCableIds.has(ch.id);
      return matchesSearch && matchesGroup && matchesDead && matchesGeo && matchesDupe && matchesNonEng && matchesBasicCable;
    });
    const [field, dir] = sort.split('-');
    list = [...list].sort((a, b) => {
      const av = (a[field] || '').toLowerCase();
      const bv = (b[field] || '').toLowerCase();
      return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
    });
    return list;
  }, [iptvChannels, search, activeGroup, sort, showDeadOnly, showGeoOnly, showDupeOnly, showNonEnglish, showBasicCable, scanStatus, dupeIds, nonEnglishIds, basicCableIds]);

  const handleLoadUrl = async () => {
    if (!m3uUrl.trim()) return;
    await loadIPTV({ url: m3uUrl.trim() });
    setM3uUrl('');
  };

  const fileInputRef = React.useRef();
  const handleLoadFile = () => fileInputRef.current?.click();
  const handleFileChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    if (uploadIPTVFile) {
      await uploadIPTVFile(file);
    } else {
      // fallback: read as text
      const text = await file.text();
      await loadIPTV({ text });
    }
  };

  const handlePlayChannel = (channel) => {
    playMedia({ ...channel, title: channel.name, filePath: null, url: channel.url });
  };

  const handleClearAll = () => {
    if (window.confirm(`Remove all ${iptvChannels.length} channels?`)) clearIPTVChannels?.();
  };

  const checkOne = useCallback(async (ch) => {
    setScanStatus(prev => ({ ...prev, [ch.id]: 'checking' }));
    try {
      const r = await fetch(`${API}/iptv/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: ch.url }),
      });
      const d = await r.json();
      const st = d.status;
      const state = d.ok ? 'ok' : (st === 403 || st === 451) ? 'geo' : 'dead';
      setScanStatus(prev => ({ ...prev, [ch.id]: state }));
      if (d.ms != null) setScanMs(prev => ({ ...prev, [ch.id]: d.ms }));
    } catch {
      setScanStatus(prev => ({ ...prev, [ch.id]: 'dead' }));
    }
    setScanProgress(prev => ({ ...prev, done: prev.done + 1 }));
  }, [API]);

  const startScan = useCallback(async () => {
    if (scanning) { scanAbortRef.current = true; setScanning(false); return; }
    scanAbortRef.current = false;
    setScanStatus({});
    setScanMs({});
    setScanning(true);
    setScanProgress({ done: 0, total: iptvChannels.length });
    setShowDeadOnly(false);
    setShowGeoOnly(false);
    setShowDupeOnly(false);
    const queue = [...iptvChannels];
    const workers = Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length > 0 && !scanAbortRef.current) {
        const ch = queue.shift();
        if (ch) { await checkOne(ch); await new Promise(r => setTimeout(r, 50)); } // 50ms pause between checks
      }
    });
    await Promise.all(workers);
    setScanning(false);
  }, [scanning, iptvChannels, checkOne]);

  const removeDeadChannels = async () => {
    const ids = Object.entries(scanStatus).filter(([, v]) => v === 'dead').map(([id]) => id);
    if (!ids.length) return;
    if (window.confirm(`Remove ${ids.length} dead channel${ids.length !== 1 ? 's' : ''}?`)) {
      await removeIPTVChannels?.(ids);
      setScanStatus(prev => { const n = { ...prev }; ids.forEach(id => delete n[id]); return n; });
      setShowDeadOnly(false);
    }
  };

  const removeGeoChannels = async () => {
    const ids = Object.entries(scanStatus).filter(([, v]) => v === 'geo').map(([id]) => id);
    if (!ids.length) return;
    if (window.confirm(`Remove ${ids.length} geo-blocked channel${ids.length !== 1 ? 's' : ''}?`)) {
      await removeIPTVChannels?.(ids);
      setScanStatus(prev => { const n = { ...prev }; ids.forEach(id => delete n[id]); return n; });
      setShowGeoOnly(false);
    }
  };

  const removeDupeChannels = async () => {
    const ids = [...dupeIds];
    if (!ids.length) return;
    if (window.confirm(`Keep the fastest version of each channel and remove ${ids.length} slower duplicate${ids.length !== 1 ? 's' : ''}?`)) {
      await removeIPTVChannels?.(ids);
      setShowDupeOnly(false);
    }
  };

  const removeNonEnglishChannels = async () => {
    const ids = [...nonEnglishIds];
    if (!ids.length) return;
    if (window.confirm(`Remove ${ids.length} non-English channel${ids.length !== 1 ? 's' : ''}?`)) {
      await removeIPTVChannels?.(ids);
      setShowNonEnglish(false);
    }
  };

  const removeGroup = async (group) => {
    const ids = iptvChannels.filter(c => c.group === group).map(c => c.id);
    if (!ids.length) return;
    if (window.confirm(`Remove all ${ids.length} channels in "${group}"?`)) {
      await removeIPTVChannels?.(ids);
      if (activeGroup === group) setActiveGroup('All');
    }
  };

  const scanDone  = !scanning && scanProgress.total > 0 && scanProgress.done === scanProgress.total;
  const deadCount = Object.values(scanStatus).filter(v => v === 'dead').length;
  const geoCount  = Object.values(scanStatus).filter(v => v === 'geo').length;
  const okCount   = Object.values(scanStatus).filter(v => v === 'ok').length;
  const sortLabel = SORT_OPTIONS.find(o => o.value === sort)?.label || 'Sort';
  const pct       = scanProgress.total > 0 ? Math.round((scanProgress.done / scanProgress.total) * 100) : 0;

  const btnStyle = (color, active) => ({
    padding: '3px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer', borderRadius: 'var(--radius)',
    color, border: `1px solid ${color}44`, background: active ? `${color}33` : `${color}11`,
  });

  return (
    <div className="page" onClick={() => setShowSortMenu(false)}>
      <div className="page-header">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div className="page-title">📡 Live TV — IPTV</div>
            <div className="page-subtitle">
              {iptvChannels.length > 0
                ? `${iptvChannels.length} channels loaded${dupeCount > 0 ? ` · ${dupeCount} duplicates detected` : ''}`
                : 'Load an M3U playlist to get started'}
            </div>
          </div>
          {iptvChannels.length > 0 && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              <button onClick={startScan} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 12px', background: scanning ? 'rgba(251,191,36,0.12)' : 'rgba(99,102,241,0.12)', border: `1px solid ${scanning ? 'rgba(251,191,36,0.3)' : 'rgba(99,102,241,0.3)'}`, borderRadius: 'var(--radius)', color: scanning ? '#fbbf24' : '#818cf8', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                {scanning ? <><Loader size={13} style={{ animation: 'spin 1s linear infinite' }} /> Stop Scan</> : <><Wifi size={13} /> Scan Channels</>}
              </button>
              {nonEnglishIds.size > 0 && (
                <button onClick={() => setShowNonEnglish(v => !v)} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 12px', background: showNonEnglish ? 'rgba(251,191,36,0.2)' : 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.3)', borderRadius: 'var(--radius)', color: '#fbbf24', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                  <Globe size={13} /> Non-English ({nonEnglishIds.size})
                </button>
              )}
              {basicCableIds.size > 0 && (
                <button onClick={() => setShowBasicCable(v => !v)}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 12px', background: showBasicCable ? 'rgba(16,185,129,0.2)' : 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.3)', borderRadius: 'var(--radius)', color: '#10b981', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                  📺 Basic Cable ({basicCableIds.size})
                </button>
              )}
              <button onClick={handleClearAll} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 12px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: 'var(--radius)', color: '#ef4444', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                <Trash2 size={13} /> Clear All
              </button>
            </div>
          )}
        </div>

        {/* Scan progress bar */}
        {(scanning || scanDone) && (
          <div style={{ marginTop: 12 }}>
            <div style={{ height: 4, background: 'var(--bg-card)', borderRadius: 2, overflow: 'hidden', marginBottom: 8 }}>
              <div style={{ height: '100%', width: `${pct}%`, background: 'var(--accent)', borderRadius: 2, transition: 'width 0.3s' }} />
            </div>
            <div style={{ display: 'flex', gap: 10, fontSize: 12, color: 'var(--text-muted)', alignItems: 'center', flexWrap: 'wrap' }}>
              <span>{scanning ? `Scanning… ${scanProgress.done} / ${scanProgress.total}` : `Scan complete — ${scanProgress.done} tested`}</span>
              {okCount > 0   && <span style={{ color: '#22c55e' }}>● {okCount} live</span>}
              {geoCount > 0  && <span style={{ color: '#f97316' }}>● {geoCount} geo-blocked</span>}
              {deadCount > 0 && <span style={{ color: '#ef4444' }}>● {deadCount} dead</span>}
              {dupeCount > 0 && <span style={{ color: '#a78bfa' }}>● {dupeCount} duplicates</span>}
              {scanDone && dupeCount > 0 && (
                <>
                  <button onClick={() => setShowDupeOnly(v => !v)} style={btnStyle('#a78bfa', showDupeOnly)}>{showDupeOnly ? 'Show All' : 'Show Dupes'}</button>
                  <button onClick={removeDupeChannels} style={btnStyle('#a78bfa', false)}>Keep Fastest, Remove {dupeCount}</button>
                </>
              )}
              {scanDone && geoCount > 0 && (
                <>
                  <button onClick={() => setShowGeoOnly(v => !v)} style={btnStyle('#f97316', showGeoOnly)}>{showGeoOnly ? 'Show All' : 'Show Geo-Blocked'}</button>
                  <button onClick={removeGeoChannels} style={btnStyle('#f97316', false)}>Remove {geoCount} Geo-Blocked</button>
                </>
              )}
              {scanDone && deadCount > 0 && (
                <>
                  <button onClick={() => setShowDeadOnly(v => !v)} style={btnStyle('#ef4444', showDeadOnly)}>{showDeadOnly ? 'Show All' : 'Show Dead'}</button>
                  <button onClick={removeDeadChannels} style={btnStyle('#ef4444', false)}>Remove {deadCount} Dead</button>
                </>
              )}
            </div>
          </div>
        )}

        {/* Non-English bar */}
        {showNonEnglish && nonEnglishIds.size > 0 && (
          <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 12, fontSize: 12, color: '#fbbf24', flexWrap: 'wrap' }}>
            <Globe size={13} />
            <span>Showing {filtered.length} non-English channels</span>
            <button onClick={removeNonEnglishChannels} style={btnStyle('#fbbf24', false)}>Remove All {nonEnglishIds.size} Non-English</button>
            <button onClick={() => setShowNonEnglish(false)} style={{ ...btnStyle('#888', false), color: 'var(--text-muted)' }}>Show All</button>
          </div>
        )}
      </div>

        {/* Basic Cable info bar */}
        {showBasicCable && basicCableIds.size > 0 && (
          <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 12, fontSize: 12, color: '#10b981', flexWrap: 'wrap' }}>
            <span>📺</span>
            <span>Showing {filtered.length} basic cable channels — click any channel to play, or use the remove button to discard ones you don't want</span>
            <button onClick={() => setShowBasicCable(false)}
              style={{ padding: '3px 10px', background: 'transparent', border: '1px solid rgba(16,185,129,0.3)', borderRadius: 'var(--radius)', color: 'var(--text-muted)', fontSize: 11, cursor: 'pointer' }}>
              Show All
            </button>
          </div>
        )}
      {/* Load Section */}
      <div style={{ padding: '0 48px 24px', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 280, display: 'flex', gap: 8 }}>
          <div style={{ position: 'relative', flex: 1 }}>
            <Link size={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
            <input type="text" placeholder="Paste M3U URL here..." value={m3uUrl}
              onChange={e => setM3uUrl(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleLoadUrl()}
              style={{ width: '100%', padding: '9px 12px 9px 34px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', color: 'var(--text-primary)', fontSize: 13, fontFamily: 'var(--font-body)', outline: 'none' }} />
          </div>
          <button className="btn btn-primary btn-sm" onClick={handleLoadUrl} disabled={loading.iptv || !m3uUrl.trim()}>
            {loading.iptv ? 'Loading...' : 'Load URL'}
          </button>
        </div>
        <label style={{ display:'flex',alignItems:'center',gap:6,padding:'7px 14px',background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:'var(--radius)',cursor:'pointer',fontSize:13,fontWeight:600,color:'var(--text-primary)',opacity:loading.iptv?0.5:1,pointerEvents:loading.iptv?'none':'auto' }}>
          <FolderOpen size={14}/> {loading.iptv?'Loading...':'Load M3U File'}
          <input type="file" accept=".m3u,.m3u8,.txt" style={{ display:'none' }} onChange={handleFileChange}/>
        </label>
        {iptvChannels.length > 0 && (
          <button onClick={() => {
            const lines = ['#EXTM3U'];
            iptvChannels.forEach(ch => {
              const attrs = [`tvg-id="${ch.tvgId||''}"`, `tvg-name="${ch.name}"`, `tvg-logo="${ch.logo||''}"`, `group-title="${ch.group||''}"`].join(' ');
              lines.push(`#EXTINF:-1 ${attrs},${ch.name}`);
              lines.push(ch.url);
            });
            const blob = new Blob([lines.join('\n')], { type: 'audio/x-mpegurl' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'orion-iptv.m3u';
            a.click();
          }} style={{ display:'flex',alignItems:'center',gap:6,padding:'7px 14px',background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:'var(--radius)',cursor:'pointer',fontSize:13,fontWeight:600,color:'var(--text-primary)' }}>
            ⬇️ Export M3U ({iptvChannels.length})
          </button>
        )}
      </div>

      {iptvChannels.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">📡</div>
          <h3>No channels loaded</h3>
          <p>Paste an M3U playlist URL above or load a local .m3u file to start watching live TV.</p>
          <div style={{ marginTop: 16, padding: 16, background: 'var(--bg-card)', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border)', maxWidth: 400, textAlign: 'left' }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 8, letterSpacing: 1 }}>FREE M3U SOURCES</div>
            {['https://iptv-org.github.io/iptv/index.m3u','https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8'].map(url => (
              <div key={url} onClick={() => setM3uUrl(url)} style={{ fontSize: 12, color: 'var(--accent)', cursor: 'pointer', padding: '4px 0', wordBreak: 'break-all' }}>{url}</div>
            ))}
          </div>
        </div>
      ) : (
        <>
          {/* Search + Sort */}
          <div style={{ padding: '0 48px 16px', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ position: 'relative' }}>
              <Search size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
              <input type="text" placeholder="Search channels..." value={search} onChange={e => setSearch(e.target.value)}
                style={{ padding: '7px 12px 7px 30px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', color: 'var(--text-primary)', fontSize: 13, outline: 'none', width: 220 }} />
              {search && <X size={13} onClick={() => setSearch('')} style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', cursor: 'pointer' }} />}
            </div>
            <div style={{ position: 'relative' }} onClick={e => e.stopPropagation()}>
              <button onClick={() => setShowSortMenu(v => !v)} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 12px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', color: 'var(--text-primary)', fontSize: 13, cursor: 'pointer' }}>
                <ArrowUpDown size={13} color="var(--text-muted)" /> {sortLabel}
              </button>
              {showSortMenu && (
                <div style={{ position: 'absolute', top: '110%', left: 0, zIndex: 100, background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden', minWidth: 140, boxShadow: '0 8px 24px rgba(0,0,0,0.3)' }}>
                  {SORT_OPTIONS.map(o => (
                    <div key={o.value} onClick={() => { setSort(o.value); setShowSortMenu(false); }}
                      style={{ padding: '9px 14px', fontSize: 13, cursor: 'pointer', color: sort === o.value ? 'var(--accent)' : 'var(--text-primary)', background: sort === o.value ? 'rgba(var(--accent-rgb),0.08)' : 'transparent' }}>
                      {sort === o.value ? '✓ ' : ''}{o.label}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 'auto' }}>{filtered.length} of {iptvChannels.length} channels</div>
          </div>

          {/* Group filter */}
          <div style={{ padding: '0 48px 16px', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className={`filter-chip ${activeGroup === 'All' ? 'active' : ''}`} onClick={() => setActiveGroup('All')} style={{ fontSize: 12 }}>All</button>
            {activeGroup !== 'All' && (
              <div style={{ display: 'flex', alignItems: 'center' }}>
                <button className="filter-chip active" style={{ fontSize: 12, borderRadius: 'var(--radius) 0 0 var(--radius)', borderRight: 'none' }}>{activeGroup}</button>
                <button onClick={() => setActiveGroup('All')} style={{ height: '100%', padding: '0 7px', background: 'rgba(99,102,241,0.15)', border: '1px solid var(--border)', borderLeft: 'none', borderRadius: '0 var(--radius) var(--radius) 0', cursor: 'pointer', color: 'var(--accent)', display: 'flex', alignItems: 'center' }}><X size={11} /></button>
              </div>
            )}
            <button onClick={() => setShowGroupManager(true)} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 12px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', color: 'var(--text-secondary)', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
              ☰ All Groups ({groups.length - 1})
            </button>
          </div>

          {/* Channel Grid */}
          <div className="channel-grid">
            {filtered.map(ch => {
              const status = scanStatus[ch.id];
              const ms = scanMs[ch.id];
              const isDupe = dupeIds.has(ch.id);
              const isNonEng = nonEnglishIds.has(ch.id);
              const dotColor = status === 'ok' ? '#22c55e' : status === 'geo' ? '#f97316' : status === 'dead' ? '#ef4444' : '#fbbf24';
              return (
                <div key={ch.id} className="channel-card"
                  style={{ position: 'relative', opacity: (status === 'dead' || status === 'geo') ? 0.5 : 1, transition: 'opacity 0.2s' }}
                  onClick={() => handlePlayChannel(ch)}>
                  {status && (
                    <div style={{ position: 'absolute', top: 8, left: 8, width: 8, height: 8, borderRadius: '50%', background: dotColor, boxShadow: `0 0 6px ${dotColor}`, animation: status === 'checking' ? 'pulse 1s ease-in-out infinite' : 'none' }} />
                  )}
                  <button onClick={e => { e.stopPropagation(); removeIPTVChannel?.(ch.id); }}
                    style={{ position: 'absolute', top: 6, right: 6, background: 'rgba(239,68,68,0.12)', border: 'none', borderRadius: 4, padding: '2px 5px', cursor: 'pointer', opacity: 0, transition: 'opacity 0.15s' }}
                    className="channel-remove-btn"><X size={11} color="#ef4444" /></button>
                  <div className="channel-logo">
                    {ch.logo
                      ? <img src={ch.logo} alt={ch.name} style={{ width: 48, height: 48, objectFit: 'contain', borderRadius: 'var(--radius)' }} onError={e => { e.target.style.display = 'none'; }} />
                      : <Tv size={22} color="var(--text-muted)" />}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="channel-name">{ch.name}</div>
                    <div className="channel-group" style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
                      <span>{ch.group || 'General'}</span>
                      {status === 'ok'   && ms != null && <span style={{ fontSize: 10, color: '#22c55e' }}>{ms}ms</span>}
                      {status === 'dead' && <span style={{ fontSize: 10, color: '#ef4444', fontWeight: 700 }}>OFFLINE</span>}
                      {status === 'geo'  && <span style={{ fontSize: 10, color: '#f97316', fontWeight: 700 }}>GEO-BLOCKED</span>}
                      {isDupe && status !== 'dead' && <span style={{ fontSize: 10, color: '#a78bfa', fontWeight: 700 }}>SLOWER DUPE</span>}
                      {isNonEng && ch.country && <span style={{ fontSize: 10, color: '#fbbf24' }}>{ch.country}</span>}
                    </div>
                  </div>
                  <Play size={16} color="var(--accent)" style={{ flexShrink: 0, opacity: 0.7 }} />
                </div>
              );
            })}
          </div>

          {filtered.length === 0 && (
            <div className="empty-state">
              <div className="empty-state-icon">🔍</div>
              <h3>No channels match</h3>
              <p>Try a different search or group filter.</p>
            </div>
          )}
        </>
      )}

      {/* Group Manager Modal */}
      {showGroupManager && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => setShowGroupManager(false)}>
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }} />
          <div style={{ position: 'relative', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', width: 480, maxHeight: '80vh', display: 'flex', flexDirection: 'column', boxShadow: '0 24px 64px rgba(0,0,0,0.5)' }} onClick={e => e.stopPropagation()}>
            <div style={{ padding: '18px 20px 14px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 15 }}>Manage Groups</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{groups.length - 1} groups — click to filter, Remove to delete all channels in that group</div>
              </div>
              <button onClick={() => setShowGroupManager(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 4 }}><X size={18} /></button>
            </div>
            <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--border)' }}>
              <div style={{ position: 'relative' }}>
                <Search size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
                <input type="text" placeholder="Search groups..." value={groupSearch} onChange={e => setGroupSearch(e.target.value)}
                  style={{ width: '100%', padding: '7px 12px 7px 30px', background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', color: 'var(--text-primary)', fontSize: 13, outline: 'none', boxSizing: 'border-box' }} />
              </div>
            </div>
            <div style={{ overflowY: 'auto', flex: 1 }}>
              {groups.filter(g => g !== 'All' && g.toLowerCase().includes(groupSearch.toLowerCase())).map(g => {
                const count = iptvChannels.filter(c => c.group === g).length;
                const isActive = activeGroup === g;
                return (
                  <div key={g} style={{ display: 'flex', alignItems: 'center', padding: '10px 20px', borderBottom: '1px solid rgba(255,255,255,0.04)', background: isActive ? 'rgba(99,102,241,0.08)' : 'transparent' }}>
                    <button onClick={() => { setActiveGroup(g); setShowGroupManager(false); }}
                      style={{ flex: 1, background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', padding: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ fontSize: 13, color: isActive ? 'var(--accent)' : 'var(--text-primary)', fontWeight: isActive ? 600 : 400 }}>{g}</span>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 'auto', paddingRight: 12 }}>{count} ch</span>
                    </button>
                    <button onClick={() => removeGroup(g)}
                      style={{ padding: '4px 10px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 'var(--radius)', cursor: 'pointer', color: '#ef4444', fontSize: 11, fontWeight: 600 }}
                      onMouseEnter={e => e.currentTarget.style.background = 'rgba(239,68,68,0.25)'}
                      onMouseLeave={e => e.currentTarget.style.background = 'rgba(239,68,68,0.08)'}>
                      Remove {count}
                    </button>
                  </div>
                );
              })}
              {groups.filter(g => g !== 'All' && g.toLowerCase().includes(groupSearch.toLowerCase())).length === 0 && (
                <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>No groups match</div>
              )}
            </div>
          </div>
        </div>
      )}

      <style>{`
        .channel-card:hover .channel-remove-btn { opacity: 1 !important; }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
      `}</style>
    </div>
  );
}

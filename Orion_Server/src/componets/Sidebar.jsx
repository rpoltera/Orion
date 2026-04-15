import React, { useMemo } from 'react';
import { useApp } from '../contexts/AppContext';
import { groupEpisodesToShows } from '../utils/helpers';
import {
  Home, Film, Tv, Music, Video, Radio, Tv2, Settings,
  Search, Zap, HardDrive, Plus, Grid, Users } from 'lucide-react';

export default function Sidebar() {
  const { activeSection, setActiveSection, library, iptvChannels, search, searchQuery, hardwareInfo, currentUser, setCurrentUser, scanStatus } = useApp();

  const hasMovies      = (library.movies?.length      || 0) > 0;
  const hasTVShows     = (library.tvShows?.length     || 0) > 0;
  const hasMusic       = (library.music?.length       || 0) > 0;
  const hasMusicVideos = (library.musicVideos?.length || 0) > 0;
  const hasAnyLibrary  = hasMovies || hasTVShows || hasMusic || hasMusicVideos;

  const enabledServices = useMemo(() => {
    try {
      const saved = localStorage.getItem('orion_enabled_services');
      return saved ? JSON.parse(saved) : ['pluto', 'roku', 'tubi'];
    } catch { return ['pluto', 'roku', 'tubi']; }
  }, []);

  // Show series count not episode count
  const tvSeriesCount = useMemo(() =>
    groupEpisodesToShows(library.tvShows || []).length,
  [library.tvShows]);

  const navItem = (id, Icon, label, badge) => (
    <div key={id}
      className={`sidebar-item ${activeSection === id ? 'active' : ''}`}
      onClick={() => { setActiveSection(id); search(""); }}>
      <Icon size={16} />
      <span>{label}</span>
      {badge != null && badge > 0 && (
        <span className="badge">{badge.toLocaleString()}</span>
      )}
    </div>
  );

  return (
    <nav className="sidebar">
      {/* Logo */}
      <div className="sidebar-logo" style={{ padding: '12px 14px' }}>
        <img src={process.env.PUBLIC_URL + '/logo.png'} alt="Orion" style={{ width: 170, maxWidth: '100%', display: 'block', mixBlendMode: 'screen' }} />
      </div>

      {/* Search */}
      <div className="search-container">
        <Search size={14} className="search-icon" />
        <input className="search-input" type="text" placeholder="Search library..."
          value={searchQuery} onChange={e => search(e.target.value)} />
        {searchQuery && (
          <div onClick={() => search('')}
            style={{ position:'absolute', right:8, top:'50%', transform:'translateY(-50%)',
              cursor:'pointer', color:'var(--text-muted)', fontSize:14, lineHeight:1,
              padding:'2px 4px' }}>×</div>
        )}
      </div>

      <div className="sidebar-nav">

        {/* ── BROWSE ─────────────────────────────────────────────────────── */}
        <div className="sidebar-section">BROWSE</div>
        {navItem('home', Home, 'Home', null)}

        {/* Library — only show when content exists */}
        {hasMovies      && navItem('movies',      Film,  'Movies',       library.movies?.length)}
        {hasTVShows     && navItem('tvshows',      Tv,    'TV Shows',     tvSeriesCount)}
        {hasMusic       && navItem('music',        Music, 'Music',        library.music?.length)}
        {hasMusicVideos && navItem('musicvideos',  Video, 'Music Videos', library.musicVideos?.length)}

        {/* Add Library shortcut */}
        {!hasAnyLibrary && (
          <div className="sidebar-item" onClick={() => { setActiveSection('settings'); search(''); }}
            style={{ color: 'var(--text-muted)', border: '1px dashed var(--border)', marginTop: 4 }}>
            <Plus size={16} />
            <span style={{ fontSize: 13 }}>Add Library</span>
          </div>
        )}

        {/* ── LIVE & STREAMING ───────────────────────────────────────────── */}
        <div className="sidebar-section" style={{ marginTop: 8 }}>LIVE & STREAMING</div>
        {navItem('livetv', Radio, 'Live TV (IPTV)', iptvChannels?.length || null)}
        {/* StreamForge — custom logo entry */}
        <div
          className={`sidebar-item ${activeSection === 'streamforge' ? 'active' : ''}`}
          onClick={() => { setActiveSection('streamforge'); search(''); }}
          style={{ gap: 8 }}
        >
          <img
            src="https://raw.githubusercontent.com/rpoltera/streamforge/main/public/logo.png"
            alt="StreamForge"
            style={{ width: 56, height: 56, objectFit: 'contain', flexShrink: 0, borderRadius: 4 }}
            onError={e => { e.target.style.display = 'none'; e.target.nextSibling.style.display = 'inline'; }}
          />
          <Tv2 size={16} style={{ display: 'none', flexShrink: 0 }} />
          <span>StreamForge</span>
        </div>
        {navItem('streaming', Grid, 'Streaming Services', null)}
        {[
          { id:'pluto',     label:'Pluto TV',          icon:'📺', free:true  },
          { id:'roku',      label:'The Roku Channel',  icon:'🎬', free:true  },
          { id:'tubi',      label:'Tubi',              icon:'🎥', free:true  },
          { id:'crackle',   label:'Crackle',           icon:'🎞', free:true  },
          { id:'plex',      label:'Plex',              icon:'🟡', free:true  },
          { id:'peacock',   label:'Peacock',           icon:'🦚', free:false },
          { id:'paramount', label:'Paramount+',        icon:'⭐', free:false },
          { id:'netflix',   label:'Netflix',           icon:'🔴', free:false },
          { id:'hulu',      label:'Hulu',              icon:'💚', free:false },
          { id:'disney',    label:'Disney+',           icon:'🏰', free:false },
          { id:'max',       label:'Max',               icon:'🔵', free:false },
          { id:'prime',     label:'Prime Video',       icon:'📦', free:false },
          { id:'youtube',   label:'YouTube',           icon:'▶️', free:true  },
        ].filter(s => enabledServices.includes(s.id)).map(s => (
          <div key={s.id} className={`sidebar-item ${activeSection === s.id ? 'active' : ''}`} onClick={() => { setActiveSection(s.id); search(''); }}>
            <span style={{ fontSize:14 }}>{s.icon}</span>
            <span>{s.label}</span>
            {s.free && <span className="badge" style={{ background:'var(--tag-bg)', color:'var(--tag-color)', fontSize:'9px' }}>FREE</span>}
          </div>
        ))}
        {/* ── SYSTEM ─────────────────────────────────────────────────────── */}
        <div className="sidebar-section" style={{ marginTop: 8 }}>SYSTEM</div>
        {currentUser?.role === 'admin' && navItem('users', Users, 'Users', null)}
        {navItem('settings', Settings, 'Settings', null)}

      </div>

      {/* Current user */}
      <div style={{ padding:'8px 14px', borderTop:'1px solid var(--border)', marginTop:'auto' }}>
        <div style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 0' }}>
          <div style={{ width:32, height:32, borderRadius:'50%', background:'linear-gradient(135deg,#1a1a3e,#2d1b69)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:16, flexShrink:0 }}>
            {currentUser?.avatar || '👤'}
          </div>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ fontSize:13, fontWeight:600, color:'var(--text-primary)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{currentUser?.name}</div>
            <div style={{ fontSize:10, color:'var(--text-muted)', textTransform:'uppercase', letterSpacing:1 }}>{currentUser?.role}</div>
          </div>
          <button onClick={() => setCurrentUser(null)} style={{ background:'none', border:'none', color:'var(--text-muted)', cursor:'pointer', fontSize:11, padding:'4px 6px', borderRadius:'var(--radius)', flexShrink:0 }} title="Switch user">⇄</button>
        </div>
      </div>

      {/* Hardware badge */}
      <div className="sidebar-bottom">
        {hardwareInfo && (
          <div style={{ padding: '8px 14px', borderRadius: 'var(--radius)', background: 'var(--bg-tertiary)', border: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <HardDrive size={12} color="var(--text-muted)" />
              <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, letterSpacing: '0.5px' }}>TRANSCODING</span>
            </div>
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 8px',
              borderRadius: 12, fontSize: 11, fontWeight: 700,
              background: hardwareInfo.isHardware ? 'rgba(16,185,129,0.15)' : 'rgba(245,158,11,0.15)',
              color: hardwareInfo.isHardware ? '#34d399' : '#fbbf24',
              border: `1px solid ${hardwareInfo.isHardware ? 'rgba(16,185,129,0.3)' : 'rgba(245,158,11,0.3)'}`
            }}>
              {hardwareInfo.isHardware ? '⚡' : '🖥'} {hardwareInfo.type}
            </div>
          </div>
        )}
      </div>

      {/* Scan Status Bar */}
      {scanStatus && (
        <div style={{ padding:'10px 12px', borderTop:'1px solid var(--border)',
          background:'rgba(99,102,241,0.12)' }}>
          <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:4 }}>
            <div style={{ width:12, height:12, border:'2px solid var(--accent)',
              borderTopColor:'transparent', borderRadius:'50%', flexShrink:0,
              animation:'spin 0.8s linear infinite' }} />
            <span style={{ fontSize:11, fontWeight:600, color:'var(--accent)', textTransform:'uppercase', letterSpacing:0.5 }}>
              Scanning Library
            </span>
          </div>
          <div style={{ fontSize:11, color:'rgba(255,255,255,0.6)', lineHeight:1.4 }}>
            {scanStatus.message}
          </div>
          {scanStatus.count > 0 && (
            <div style={{ fontSize:10, color:'rgba(255,255,255,0.4)', marginTop:2 }}>
              {scanStatus.count.toLocaleString()} files found
            </div>
          )}
        </div>
      )}
    </nav>
  );
}

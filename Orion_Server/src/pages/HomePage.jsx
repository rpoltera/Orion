import React, { useState, useEffect } from 'react';
import { useApp } from '../contexts/AppContext';
import MediaCard from '../components/MediaCard';
import { groupEpisodesToShows } from '../utils/helpers';
const API = 'http://localhost:3001/api';
import { Play, Info, ChevronLeft, ChevronRight, Tv } from 'lucide-react';

// Netflix-style hero — picks a random movie with a cached trailer

// Show card for TV shows grid — with smart play button
function ShowCard({ show, onSelect }) {
  const { playMedia } = useApp();
  const [imgError, setImgError] = useState(false);
  const [nextEp, setNextEp] = useState(null);
  const cardRef = React.useRef(null);
  const BASE = 'http://localhost:3001';

  const resolveImg = (url) => {
    if (!url) return null;
    if (url.startsWith('http')) return url;
    if (url.startsWith('/api')) return BASE + url;
    return null;
  };
  const posterUrl = !imgError ? resolveImg(show.thumbnail) : null;

  // Fetch next episode when card scrolls into view
  React.useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        observer.disconnect();
        fetch(`${BASE}/api/tv/next/${encodeURIComponent(show.showName)}`)
          .then(r => r.json())
          .then(d => setNextEp(d.episode || null))
          .catch(() => setNextEp(null));
      }
    }, { rootMargin: '200px' });
    observer.observe(el);
    return () => observer.disconnect();
  }, [show.showName]);

  const handlePlay = (e) => {
    e.stopPropagation();
    const playEp = (ep) => { if (ep?.filePath) playMedia({ ...ep, type: 'tvShows' }); };
    if (nextEp?.filePath) { playEp(nextEp); return; }
    fetch(`${BASE}/api/tv/next/${encodeURIComponent(show.showName)}`)
      .then(r => r.json())
      .then(d => {
        if (d.episode?.filePath) playEp(d.episode);
        else fetch(`${BASE}/api/library/tvShows/byShow/${encodeURIComponent(show.showName)}`)
          .then(r => r.json()).then(d2 => playEp(d2.items?.[0]));
      }).catch(console.error);
  };

  const epLabel = nextEp
    ? `S${nextEp.seasonNum || 1}E${(nextEp.fileName||'').match(/[Ee](\d+)/)?.[1] || '1'}`
    : null;

  return (
    <div ref={cardRef} className="media-card" style={{ cursor: 'pointer' }}>
      <div className="media-card-poster" onClick={() => onSelect?.(show)}>
        {posterUrl ? (
          <img src={posterUrl} alt={show.showName} loading="lazy" onError={() => setImgError(true)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : (
          <div className="poster-placeholder">
            <Tv size={28} color="var(--text-muted)" />
            <span style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'center', padding: '0 8px', lineHeight: 1.3 }}>{show.showName}</span>
          </div>
        )}
        <div className="media-card-overlay">
          <div className="play-btn" onClick={e => { e.stopPropagation(); handlePlay(e); }}
            onMouseEnter={e => { e.currentTarget.style.background = '#f59e0b'; e.currentTarget.style.transform = 'scale(1.15)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = ''; e.currentTarget.style.transform = ''; }}
            style={{ transition: 'background 0.15s, transform 0.15s' }}>
            <Play size={20} fill="white" color="white" />
          </div>
        </div>
      </div>
      <div className="media-card-info" onClick={() => onSelect?.(show)}>
        <div className="media-card-title" title={show.showName}>{show.showName}</div>
        <div className="media-card-meta">
          {show.year && <span>{show.year}</span>}
          {show.rating && <span style={{ color: '#f59e0b', display: 'flex', alignItems: 'center', gap: 2 }}>★ {show.rating}</span>}
        </div>
      </div>
    </div>
  );
}

export default function HomePage({ onSelect }) {
  const { library, setActiveSection, playMedia, API } = useApp();
  const [collections, setCollections] = useState([]);
  const [heroMovie, setHeroMovie]     = useState(null);
  const [continueWatching, setContinueWatching] = useState([]);
  const [recentMovies2, setRecentMovies2] = useState([]);
  const [recentTV, setRecentTV] = useState([]);
  const [recommendations, setRecommendations] = useState({ movies: [], tv: [] });
  const { settings } = useApp();
  const libSettings = settings?.libSettings || {};

  const DEFAULT_SECTIONS = [
    { id: 'continueWatching',       label: '⏯ Continue Watching',        visible: true },
    { id: 'recentMovies',           label: '🎬 Recent Movies',            visible: true },
    { id: 'tvSeries',               label: '📺 TV Series',                visible: true },
    { id: 'collections',            label: '📚 Collections',              visible: true },
    { id: 'music',                  label: '🎵 Music',                    visible: true },
    { id: 'musicVideos',            label: '🎞 Music Videos',             visible: true },
    { id: 'recentlyReleasedMovies', label: '🆕 Recently Released Movies', visible: true },
    { id: 'newEpisodes',            label: '📡 Recently Added Episodes',  visible: true },
    { id: 'recommendedMovies',      label: '⭐ Recommended Movies',       visible: true },
    { id: 'recommendedShows',       label: '📺 Recommended Shows',        visible: true },
  ];

  const [homeLayout, setHomeLayout] = React.useState(DEFAULT_SECTIONS);

  React.useEffect(() => {
    fetch(`${API}/config`).then(r => r.json()).then(d => {
      if (d.homeLayout?.length) setHomeLayout(d.homeLayout);
    }).catch(() => {});
  }, []);

  const recentMovies      = library.movies?.slice(0, 14) || [];
  const recentMusic       = library.music?.slice(0, 14) || [];
  const recentMusicVideos = library.musicVideos?.slice(0, 14) || [];

  // Group TV episodes into shows for display
  const allShows = groupEpisodesToShows(library.tvShows || []);
  const recentShows = allShows.slice(0, 12);

  // Fetch continue watching — only when page is visible
  useEffect(() => {
    const fetchCW = () => {
      if (document.hidden) return;
      fetch(`${API}/continue-watching`)
        .then(r => r.json())
        .then(d => setContinueWatching(d.items || []))
        .catch(() => {});
    };
    fetchCW();
    const interval = setInterval(fetchCW, 60000); // 30s -> 60s
    return () => clearInterval(interval);
  }, [API]);

  // Refresh New Episodes when library updates (auto-scan)
  useEffect(() => {
    const handler = () => {
      fetch(`${API}/recently-released/tv?days=90`)
        .then(r => r.json()).then(d => setRecentTV(d.items || [])).catch(() => {});
    };
    window.addEventListener('orion:library:updated', handler);
    return () => window.removeEventListener('orion:library:updated', handler);
  }, [API]);

  // Fetch recently released and recommendations
  useEffect(() => {
    const days = libSettings.recentlyReleasedDays || 90;
    if (libSettings.showRecentlyReleasedMovies !== false) {
      fetch(`${API}/recently-released/movies?months=${libSettings.recentlyReleasedDays === 30 ? 1 : libSettings.recentlyReleasedDays === 60 ? 2 : libSettings.recentlyReleasedDays === 90 ? 3 : libSettings.recentlyReleasedDays === 180 ? 6 : libSettings.recentlyReleasedDays === 365 ? 12 : 6}`)
        .then(r => r.json()).then(d => setRecentMovies2(d.items || [])).catch(() => {});
    }
    if (libSettings.showRecentlyReleasedTV !== false) {
      fetch(`${API}/recently-released/tv?days=90`)
        .then(r => r.json()).then(d => setRecentTV(d.items || [])).catch(() => {});
    }
    if (libSettings.showRecommendations !== false) {
      Promise.all([
        fetch(`${API}/recommendations/movies`).then(r => r.json()),
        fetch(`${API}/recommendations/tv`).then(r => r.json()),
      ]).then(([movies, tv]) => setRecommendations({ movies: movies.items || [], tv: tv.items || [] }))
        .catch(() => {});
    }
  }, [API, libSettings.showRecentlyReleasedMovies, libSettings.showRecentlyReleasedTV, libSettings.showRecommendations]);

  // Handler: shows open the TVShows page with that show selected
  // We pass the show object up — App.jsx will route to TV Shows page
  const handleShowSelect = (show) => {
    // Store selected show in sessionStorage so TVShowsPage can pick it up
    sessionStorage.setItem('orion_selected_show', JSON.stringify(show.showName));
    setActiveSection('tvshows');
  };

  return (
    <div style={{ paddingTop: 0, position:'relative', zIndex:0 }}>
      {/* Hero content overlay — sits in the spacer area over the fixed video */}
      <div style={{ height:520, position:'relative', display:'flex', alignItems:'flex-end', paddingBottom:60, paddingLeft:48 }}>
        {heroMovie && (
          <div style={{ maxWidth:540 }}>
            <div style={{ fontSize:11, fontWeight:700, letterSpacing:2, textTransform:'uppercase',
              color:'var(--accent)', marginBottom:10 }}>✦ NOW PLAYING</div>
            <h1 style={{ fontSize:46, fontWeight:900, lineHeight:1.05, margin:'0 0 12px',
              color:'white', textShadow:'0 2px 24px rgba(0,0,0,0.9)', letterSpacing:-0.5 }}>
              {heroMovie.title}
            </h1>
            {heroMovie.overview && (
              <p style={{ fontSize:13, color:'rgba(255,255,255,0.8)', lineHeight:1.65, margin:'0 0 20px',
                textShadow:'0 1px 6px rgba(0,0,0,0.9)',
                display:'-webkit-box', WebkitLineClamp:2, WebkitBoxOrient:'vertical', overflow:'hidden' }}>
                {heroMovie.overview}
              </p>
            )}
            <div style={{ display:'flex', gap:10 }}>
              <button className="btn btn-primary" onClick={() => onSelect?.(heroMovie)}>
                <Play size={16} fill="white" /> Play
              </button>
              <button className="btn btn-secondary" onClick={() => setActiveSection('movies')}>
                Browse Library
              </button>
            </div>
          </div>
        )}
        {/* Bottom fade — transitions hero into content below */}
        <div style={{ position:'absolute', bottom:0, left:0, right:0, height:180,
          background:'linear-gradient(to bottom, transparent 0%, rgba(10,10,18,0.97) 100%)',
          pointerEvents:'none' }} />
      </div>
      {/* Background video — portalled to body so fixed positioning is never broken by overflow */}

      {/* Stats */}
      <div style={{ display: 'flex', gap: 12, padding: '20px 48px', borderBottom: '1px solid var(--border)', background:'var(--bg-primary)' }}>
        {[
          { label: 'Movies',    count: library.movies?.length || 0, icon: '🎬' },
          { label: 'TV Series', count: allShows.length,              icon: '📺' },
          { label: 'Music',     count: library.music?.length || 0,   icon: '🎵' },
          { label: 'Music Videos', count: library.musicVideos?.length || 0, icon: '🎞' },
        ].map(({ label, count, icon }) => (
          <div key={label} style={{ flex: 1, background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ fontSize: 24 }}>{icon}</span>
            <div>
              <div style={{ fontSize: 22, fontWeight: 700, lineHeight: 1 }}>{count.toLocaleString()}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{label}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Dynamic ordered sections */}
      {homeLayout.filter(s => s.visible !== false).map(section => {
        switch(section.id) {
          case 'continueWatching':
            return libSettings.showContinueWatching !== false && continueWatching.length > 0 ? (
              <div key={section.id} className="section-row">
                <div className="section-header"><div className="section-title">⏯ Continue Watching</div></div>
                <div className="cards-scroll">
                  {continueWatching.map(item => (
                    <div key={item.id} style={{ position: 'relative', flexShrink: 0, width: 160, cursor: 'pointer' }}
                      onClick={() => { if (item.type === 'movie') onSelect?.(item); else playMedia({ ...item, type: 'tvShows' }); }}>
                      <div style={{ width: 160, height: 240, borderRadius: 8, overflow: 'hidden', background: 'var(--bg-card)', border: '1px solid var(--border)', position: 'relative' }}>
                        {item.thumbnail ? (
                          <img src={item.thumbnail.startsWith('/api') ? `http://localhost:3001${item.thumbnail}` : item.thumbnail} alt={item.title} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        ) : (
                          <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 32 }}>{item.type === 'movie' ? '🎬' : '📺'}</div>
                        )}
                        <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 3, background: 'rgba(255,255,255,0.2)' }}>
                          <div style={{ height: '100%', background: 'var(--accent)', width: `${item.progressPct}%` }} />
                        </div>
                        <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0)', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background 0.2s' }}
                          onMouseEnter={e => e.currentTarget.style.background = 'rgba(0,0,0,0.4)'}
                          onMouseLeave={e => e.currentTarget.style.background = 'rgba(0,0,0,0)'}>
                          <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'rgba(255,255,255,0.9)', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0, transition: 'opacity 0.2s, background 0.15s, transform 0.15s' }}
                            className="cw-play-icon"
                            onMouseEnter={e => { e.currentTarget.style.background = '#f59e0b'; e.currentTarget.style.transform = 'scale(1.15)'; }}
                            onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.9)'; e.currentTarget.style.transform = 'scale(1)'; }}>
                            <Play size={16} fill="black" color="black" />
                          </div>
                        </div>
                      </div>
                      <div style={{ marginTop: 6 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.title}</div>
                        {item.type === 'tvShow' && item.seasonNum && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>S{item.seasonNum}{item.episodeNum ? `E${item.episodeNum}` : ''} · {item.progressPct}% watched</div>}
                        {item.type === 'movie' && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{item.progressPct}% watched</div>}
                      </div>
                      <style>{`.cw-play-icon { opacity: 0 } div:hover > div > .cw-play-icon { opacity: 1 !important }`}</style>
                    </div>
                  ))}
                </div>
              </div>
            ) : null;

          case 'recentMovies':
            return libSettings.showRecentMovies !== false && recentMovies.length > 0 ? (
              <div key={section.id} className="section-row">
                <div className="section-header"><div className="section-title">🎬 Recent Movies</div><span className="section-link" onClick={() => setActiveSection('movies')}>See All →</span></div>
                <div className="cards-scroll">{recentMovies.map(item => <MediaCard key={item.id} item={item} onClick={onSelect} />)}</div>
              </div>
            ) : null;

          case 'tvSeries':
            return libSettings.showTVSeries !== false && recentShows.length > 0 ? (
              <div key={section.id} className="section-row">
                <div className="section-header"><div className="section-title">📺 TV Series</div><span className="section-link" onClick={() => setActiveSection('tvshows')}>See All ({allShows.length} series) →</span></div>
                <div className="cards-scroll">{recentShows.map(show => <ShowCard key={show.id} show={show} onSelect={handleShowSelect} />)}</div>
              </div>
            ) : null;

          case 'collections':
            return libSettings.showCollections !== false && collections.length > 0 ? (
              <div key={section.id} className="section-row">
                <div className="section-header"><div className="section-title">📚 Collections</div><span className="section-link" onClick={() => setActiveSection('collections')}>See All ({collections.length}) →</span></div>
                <div className="cards-scroll">
                  {collections.slice(0, 12).map(col => {
                    const typeColors = { 'auto-genre': '#10b981', 'auto-decade': '#8b5cf6', 'auto-year': '#f59e0b', 'manual': 'var(--accent)' };
                    const color = typeColors[col.type] || 'var(--accent)';
                    return (
                      <div key={col.id} onClick={() => setActiveSection('collections')} style={{ flexShrink: 0, width: 180, borderRadius: 'var(--radius-lg)', overflow: 'hidden', cursor: 'pointer', background: 'var(--bg-card)', border: '1px solid var(--border)', transition: 'all 0.2s', scrollSnapAlign: 'start' }}
                        onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-4px)'; e.currentTarget.style.borderColor = color; }}
                        onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.borderColor = 'var(--border)'; }}>
                        <div style={{ height: 100, background: `linear-gradient(135deg, ${color}22, var(--bg-tertiary))`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 32 }}>
                          {col.type === 'auto-genre' ? '🎭' : col.type === 'auto-decade' ? '📅' : col.type === 'auto-rating' ? '⭐' : '📚'}
                        </div>
                        <div style={{ padding: '10px 12px' }}>
                          <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{col.name}</div>
                          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{col.mediaIds?.length || 0} titles</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null;

          case 'music':
            return libSettings.showMusic !== false && recentMusic.length > 0 ? (
              <div key={section.id} className="section-row">
                <div className="section-header"><div className="section-title">🎵 Music</div><span className="section-link" onClick={() => setActiveSection('music')}>See All →</span></div>
                <div className="cards-scroll">{recentMusic.map(item => <MediaCard key={item.id} item={item} onClick={onSelect} />)}</div>
              </div>
            ) : null;

          case 'musicVideos':
            return libSettings.showMusicVideos !== false && recentMusicVideos.length > 0 ? (
              <div key={section.id} className="section-row">
                <div className="section-header"><div className="section-title">🎞 Music Videos</div><span className="section-link" onClick={() => setActiveSection('musicvideos')}>See All →</span></div>
                <div className="cards-scroll">{recentMusicVideos.map(item => <MediaCard key={item.id} item={item} onClick={onSelect} />)}</div>
              </div>
            ) : null;

          case 'recentlyReleasedMovies':
            return libSettings.showRecentlyReleasedMovies !== false && recentMovies2.length > 0 ? (
              <div key={section.id} className="section-row">
                <div className="section-header"><div className="section-title">🆕 Recently Released Movies</div><span className="section-link" onClick={() => setActiveSection('discover')}>Discover →</span></div>
                <div className="cards-scroll">{recentMovies2.map(item => <MediaCard key={item.id} item={item} onClick={onSelect} />)}</div>
              </div>
            ) : null;

          case 'newEpisodes':
            return libSettings.showRecentlyReleasedTV !== false && recentTV.length > 0 ? (
              <div key={section.id} className="section-row">
                <div className="section-header"><div className="section-title">📡 Recently Added Episodes</div><span className="section-link" onClick={() => setActiveSection('discover')}>Discover →</span></div>
                <div className="cards-scroll">
                  {recentTV.map(ep => <ShowCard key={ep.id} show={{ showName: ep.seriesTitle || ep.showName, thumbnail: ep.thumbnail, year: ep.year, rating: ep.rating, episodes: [] }} onSelect={onSelect} />)}
                </div>
              </div>
            ) : null;

          case 'recommendedMovies':
            return libSettings.showRecommendations !== false && recommendations.movies.length > 0 ? (
              <div key={section.id} className="section-row">
                <div className="section-header"><div className="section-title">⭐ Recommended Movies</div><span className="section-link" onClick={() => setActiveSection('discover')}>Discover →</span></div>
                <div className="cards-scroll">{recommendations.movies.slice(0, 14).map(item => <MediaCard key={item.id} item={item} onClick={onSelect} />)}</div>
              </div>
            ) : null;

          case 'recommendedShows':
            return libSettings.showRecommendations !== false && recommendations.tv.length > 0 ? (
              <div key={section.id} className="section-row">
                <div className="section-header"><div className="section-title">📺 Recommended Shows</div><span className="section-link" onClick={() => setActiveSection('discover')}>Discover →</span></div>
                <div className="cards-scroll">
                  {recommendations.tv.slice(0, 14).map(ep => {
                    const showName = ep.seriesTitle || ep.showName;
                    return <ShowCard key={ep.id} show={{ showName, thumbnail: ep.thumbnail, year: ep.year, rating: ep.rating, episodes: [] }} onSelect={onSelect} />;
                  })}
                </div>
              </div>
            ) : null;

          default: return null;
        }
      })}
        <div className="section-row">
          <div className="section-header">
            <div className="section-title">⏯ Continue Watching</div>
          </div>
          <div className="cards-scroll">
            {continueWatching.map(item => (
              <div key={item.id} style={{ position: 'relative', flexShrink: 0, width: 160, cursor: 'pointer' }}
                onClick={() => {
                  if (item.type === 'movie') onSelect?.(item);
                  else {
                    // Play from where they left off
                    playMedia({ ...item, type: 'tvShows' });
                  }
                }}>
                {/* Thumbnail */}
                <div style={{ width: 160, height: 240, borderRadius: 8, overflow: 'hidden',
                  background: 'var(--bg-card)', border: '1px solid var(--border)', position: 'relative' }}>
                  {item.thumbnail ? (
                    <img src={item.thumbnail.startsWith('/api') ? `http://localhost:3001${item.thumbnail}` : item.thumbnail}
                      alt={item.title} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  ) : (
                    <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center',
                      justifyContent: 'center', fontSize: 32 }}>
                      {item.type === 'movie' ? '🎬' : '📺'}
                    </div>
                  )}
                  {/* Progress bar */}
                  <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 3,
                    background: 'rgba(255,255,255,0.2)' }}>
                    <div style={{ height: '100%', background: 'var(--accent)',
                      width: `${item.progressPct}%` }} />
                  </div>
                  {/* Play overlay */}
                  <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    transition: 'background 0.2s' }}
                    onMouseEnter={e => e.currentTarget.style.background = 'rgba(0,0,0,0.4)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'rgba(0,0,0,0)'}>
                    <div style={{ width: 36, height: 36, borderRadius: '50%',
                      background: 'rgba(255,255,255,0.9)', display: 'flex',
                      alignItems: 'center', justifyContent: 'center', opacity: 0,
                      transition: 'opacity 0.2s, background 0.15s, transform 0.15s' }}
                      className="cw-play-icon"
                      onMouseEnter={e => { e.currentTarget.style.background = '#f59e0b'; e.currentTarget.style.transform = 'scale(1.15)'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.9)'; e.currentTarget.style.transform = 'scale(1)'; }}>
                      <Play size={16} fill="black" color="black" />
                    </div>
                  </div>
                </div>
                {/* Info */}
                <div style={{ marginTop: 6 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {item.title}
                  </div>
                  {item.type === 'tvShow' && item.seasonNum && (
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                      S{item.seasonNum}{item.episodeNum ? `E${item.episodeNum}` : ''} · {item.progressPct}% watched
                    </div>
                  )}
                  {item.type === 'movie' && (
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                      {item.progressPct}% watched
                    </div>
                  )}
                </div>
                <style>{`.cw-play-icon { opacity: 0 } div:hover > div > .cw-play-icon { opacity: 1 !important }`}</style>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Empty state */}
      {recentMovies.length === 0 && recentShows.length === 0 && recentMusic.length === 0 && (
        <div className="empty-state" style={{ minHeight: 300 }}>
          <div className="empty-state-icon">🎬</div>
          <h3>Your library is empty</h3>
          <p>Go to <strong>Settings → Library</strong> to add your media folders.</p>
          <button className="btn btn-primary" style={{ marginTop: 8 }} onClick={() => setActiveSection('settings')}>Set Up Library</button>
        </div>
      )}
      <div style={{ height: 48 }} />
    </div>
  );
}


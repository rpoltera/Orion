import React, { useState, useEffect } from 'react';
import ReactDOM from 'react-dom';
import { useApp } from '../contexts/AppContext';
import { Play, ChevronLeft, Plus, RotateCcw } from 'lucide-react';

const BASE = 'http://localhost:3001';
const API  = BASE + '/api';

function resolveImg(url) {
  if (!url) return null;
  if (url.startsWith('http')) return url;
  if (url.startsWith('/api')) return BASE + url;
  return null;
}
function fmtRuntime(min) {
  if (!min) return null;
  const h = Math.floor(min/60), m = min%60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
function fmtSize(bytes) {
  if (!bytes) return null;
  const gb = bytes/1024/1024/1024;
  return gb >= 1 ? `${gb.toFixed(2)} GB` : `${(bytes/1024/1024).toFixed(0)} MB`;
}

const PROVIDER_COLORS = {
  'Netflix':'#E50914','Disney+':'#113CCF','Max':'#002BE7','HBO Max':'#002BE7',
  'Hulu':'#1CE783','Amazon Prime Video':'#00A8E1','Prime Video':'#00A8E1',
  'Apple TV+':'#1c1c1e','Peacock':'#000','Paramount+':'#0064FF',
  'Tubi TV':'#FA5714','Crunchyroll':'#F47521','Plex':'#E5A00D',
};

export default function MovieDetailPage({ item, list = [], prev, next, onNavigate, onClose }) {
  const { playMedia, fetchLibrary, playerOpen, library } = useApp();
  const [fullItem, setFullItem] = React.useState(item);
  const [versions, setVersions] = useState([]);
  const [versionsFetched, setVersionsFetched] = useState(false);

  // Fetch full details (overview, cast, backdrop may be stripped from RAM)
  React.useEffect(() => {
    if (!item.id || !item.type) return;
    fetch(`http://localhost:3001/api/library/${item.type}/${item.id}/detail`)
      .then(r => r.json())
      .then(d => {
        if (d.id) {
          setFullItem(prev => ({ ...prev, ...d }));
          if (d.cast?.length) setCast(d.cast);
        }
        // If overview is missing or very short, fetch from TMDB directly
        if ((!d.overview || d.overview.length < 50) && (d.tmdbId || item.tmdbId)) {
          const tmdbId = d.tmdbId || item.tmdbId;
          const endpoint = item.type === 'tvShows' ? 'tv' : 'movie';
          fetch(`http://localhost:3001/api/tmdb/detail/${endpoint}/${tmdbId}`)
            .then(r => r.json())
            .then(t => {
              if (t.overview || t.tagline || t.writer) {
                setFullItem(prev => ({
                  ...prev,
                  overview: t.overview || prev.overview,
                  tagline: t.tagline || prev.tagline,
                  writer: t.writer || prev.writer,
                }));
              }
            })
            .catch(() => {});
        }
      })
      .catch(() => {});
    // Always fetch versions
    fetch(`http://localhost:3001/api/library/${item.type}/${item.id}/versions`)
      .then(r => r.json())
      .then(d => {
        const vers = d.versions || [];
        setVersions(vers);
        setVersionsFetched(true);
      })
      .catch(() => { setVersionsFetched(true); });
  }, [item.id]);

  // Pause background trailer when player opens
  React.useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (playerOpen) v.pause();
    else v.play().catch(() => {});
  }, [playerOpen]);
  const [cast, setCast]               = useState(item.cast || []);

  // Update cast when fullItem loads
  React.useEffect(() => {
    if (fullItem.cast?.length) setCast(fullItem.cast);
  }, [fullItem.cast]);
  const [extras, setExtras]           = useState([]);
  const [refreshing, setRefreshing]   = useState(false);
  const [showEdit, setShowEdit]       = useState(false);
  const [showFixMatch, setShowFixMatch] = useState(false);
  const [showArtwork, setShowArtwork]   = useState(false);
  const [artworkTab, setArtworkTab]     = useState('posters');
  const [artworkData, setArtworkData]   = useState({ posters: [], backdrops: [] });
  const [artworkLoading, setArtworkLoading] = useState(false);
  const [artworkApplying, setArtworkApplying] = useState(false);
  const [searchQ, setSearchQ]         = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching]     = useState(false);
  const [activeTab, setActiveTab]     = useState(null);
  const [trailers, setTrailers]         = useState([]);
  const [trailerLoaded, setTrailerLoaded] = useState(false);

  // Auto-close tab panel after 8 seconds of inactivity
  React.useEffect(() => {
    if (!activeTab) return;
    const t = setTimeout(() => setActiveTab(null), 8000);
    return () => clearTimeout(t);
  }, [activeTab]);

  // Fetch trailers from TMDB when extras tab opens
  React.useEffect(() => {
    if (activeTab !== 'extras' || trailerLoaded) return;
    setTrailerLoaded(true);

    const fetchVideos = (tmdbId) => {
      console.log('[Trailers] Fetching videos for tmdbId:', tmdbId);
      fetch(`http://localhost:3001/api/tmdb/videos/${tmdbId}`)
        .then(r => r.json())
        .then(d => {
          console.log('[Trailers] Got', d.videos?.length, 'videos');
          setTrailers(d.videos || []);
        })
        .catch(e => console.error('[Trailers] fetch error:', e));
    };

    if (item.tmdbId) {
      console.log('[Trailers] Using stored tmdbId:', item.tmdbId);
      fetchVideos(item.tmdbId);
    } else {
      // No tmdbId stored — search TMDB by title to get one
      const q = encodeURIComponent(item.title || '');
      console.log('[Trailers] No tmdbId, searching by title:', item.title);
      fetch(`http://localhost:3001/api/tmdb/search?q=${q}&type=movie`)
        .then(r => r.json())
        .then(d => {
          console.log('[Trailers] Search results:', d.results?.length, 'first:', d.results?.[0]?.id, d.results?.[0]?.title);
          const first = d.results?.[0];
          if (first?.id) fetchVideos(first.id);
          else console.warn('[Trailers] No search results found for:', item.title);
        })
        .catch(e => console.error('[Trailers] search error:', e));
    }
  }, [activeTab, item.tmdbId, item.title]);

  const posterUrl   = resolveImg(item.thumbnail);
  const backdropUrl = resolveImg(item.backdrop);
  const fullBg = localStorage.getItem('orion_full_background') === 'true';

  useEffect(() => {
    if (!item?.id) return;
    fetch(`${API}/library/movies/${item.id}/extras`)
      .then(r=>r.json()).then(d=>setExtras(d.extras||[])).catch(()=>{});
  }, [item?.id]);

  const [showVersionPicker, setShowVersionPicker] = useState(false);

  const handlePlay = () => {
    if (versions.length > 1) {
      setShowVersionPicker(true);
    } else {
      onClose();
      playMedia(item);
    }
  };

  const playVersion = (version) => {
    setShowVersionPicker(false);
    onClose();
    playMedia({ ...item, filePath: version.filePath, fileName: version.fileName });
  };

  const handleRefresh = async () => {
    setShowEdit(false); setRefreshing(true);
    try {
      await fetch(`${API}/library/item/${item.id}/refresh`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ type: item.type })
      });
      setTimeout(() => setRefreshing(false), 2000);
    } catch { setRefreshing(false); }
  };

  const handleDelete = async () => {
    if (!window.confirm(`Permanently delete "${item.title}" from your library?\n\n⚠️ This will delete the file from disk and cannot be undone.`)) return;
    setShowEdit(false);
    try {
      await fetch(`${API}/library/${item.type}/${item.id}`, { method: 'DELETE' });
      await fetchLibrary('movies');
      onClose();
    } catch(e) { alert('Failed to delete: ' + e.message); }
  };

  const handleSearch = async () => {
    if (!searchQ.trim()) return;
    setSearching(true);
    try {
      const d = await fetch(`${API}/tmdb/search?q=${encodeURIComponent(searchQ)}&type=movie`).then(r=>r.json());
      setSearchResults(d.results||[]);
    } catch {}
    setSearching(false);
  };

  const handleFixMatch = async (tmdbId) => {
    setShowFixMatch(false); setRefreshing(true);
    try {
      await fetch(`${API}/library/item/${item.id}/refresh`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ tmdbId, type: item.type })
      });
      // Wait for server to finish then re-fetch full item
      setTimeout(async () => {
        try {
          const d = await fetch(`${API}/library/${item.type}/${item.id}/detail`).then(r=>r.json());
          if (d.id) setFullItem(prev => ({ ...prev, ...d }));
        } catch {}
        setRefreshing(false);
      }, 2500);
    } catch { setRefreshing(false); }
  };

  const fetchArtwork = async () => {
    const tmdbId = fullItem.tmdbId || item.tmdbId;
    if (!tmdbId) return;
    setArtworkLoading(true);
    setArtworkData({ posters: [], backdrops: [] });
    try {
      const mediaType = item.type === 'tvShows' ? 'tv' : 'movie';
      const d = await fetch(`${API}/tmdb/artwork/${mediaType}/${tmdbId}`).then(r=>r.json());
      setArtworkData({ posters: d.posters || [], backdrops: d.backdrops || [] });
    } catch {}
    setArtworkLoading(false);
  };

  const applyArtwork = async (imageUrl, kind) => {
    setArtworkApplying(true);
    try {
      const body = kind === 'poster'
        ? { posterUrl: imageUrl, type: item.type }
        : { backdropUrl: imageUrl, type: item.type };
      const d = await fetch(`${API}/library/item/${item.id}/artwork`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }).then(r=>r.json());
      if (d.ok) setFullItem(prev => ({ ...prev, thumbnail: d.thumbnail || prev.thumbnail, backdrop: d.backdrop || prev.backdrop }));
    } catch {}
    setArtworkApplying(false);
  };

  const openArtworkPicker = () => {
    setShowEdit(false);
    setShowArtwork(true);
    setArtworkTab('posters');
    fetchArtwork();
  };

  const extrasByLabel = extras.reduce((acc,e)=>{ (acc[e.label]=acc[e.label]||[]).push(e); return acc; }, {});
  const tabs = [
    { id:'suggested', label:'SUGGESTED' },
    { id:'extras', label:'EXTRAS' },
  ];

  const [videoActive, setVideoActive] = useState(false);
  const [videoFaded, setVideoFaded] = useState(false);
  const [clearLogoOk, setClearLogoOk] = useState(true);
  const [trailerUrls, setTrailerUrls] = useState([]);  // all trailer stream URLs
  const [trailerIdx, setTrailerIdx] = useState(0);     // current playing index
  const clearLogoUrl = `http://localhost:3001/api/clearlogo-movie/${item.id}`;

  const videoRef = React.useRef(null);

  // Fetch ALL trailers from TMDB, kick off downloads for each, shuffle order
  React.useEffect(() => {
    setTrailerUrls([]);
    setTrailerIdx(0);
    setVideoActive(false);
    setVideoFaded(false);

    const downloadAll = (videos) => {
      if (!videos.length) return;
      // Shuffle order
      const shuffled = [...videos].sort(() => Math.random() - 0.5);
      // Build stream URLs — server will cache each one
      const urls = shuffled.map(v =>
        `http://localhost:3001/api/ytdlp/stream?url=${encodeURIComponent('https://www.youtube.com/watch?v=' + v.key)}&movieId=${item.id}`
      );
      console.log('[trailers] Queued', urls.length, 'trailers, pre-fetching first...');
      setTrailerUrls(urls);
      // Pre-fetch first trailer immediately so it's cached by the time the timer fires
      fetch(urls[0]).catch(() => {});
    };

    const getTrailers = (tmdbId) => {
      fetch(`http://localhost:3001/api/tmdb/videos/${tmdbId}`)
        .then(r => r.json())
        .then(d => {
          const videos = (d.videos || []).filter(v => ['Trailer','Teaser'].includes(v.type));
          console.log('[trailers] Found', videos.length, 'trailers for tmdbId:', tmdbId);
          if (videos.length) downloadAll(videos);
        })
        .catch(() => {});
    };

    if (item.tmdbId) {
      getTrailers(item.tmdbId);
    } else if (item.title) {
      fetch(`http://localhost:3001/api/tmdb/search?q=${encodeURIComponent(item.title)}&type=movie`)
        .then(r => r.json())
        .then(d => { const id = d.results?.[0]?.id; if (id) getTrailers(id); })
        .catch(() => {});
    }
  }, [item.id]);

  // Start playing as soon as URLs are ready
  React.useEffect(() => {
    setVideoActive(false);
    setVideoFaded(false);
    if (!trailerUrls.length) return;
    setVideoActive(true);
  }, [item.id, trailerUrls.length]);

  // Advance to next trailer when current one ends
  const handleTrailerEnd = () => {
    setVideoFaded(false);
    setTimeout(() => {
      setTrailerIdx(i => (i + 1) % trailerUrls.length);
      setTimeout(() => setVideoFaded(true), 800);
    }, 500);
  };

  const currentTrailerUrl = trailerUrls[trailerIdx] || null;


  const metaBadges = [
    item.contentRating,
    item.resolution === '4k' ? '4K' : item.resolution === '1080p' ? 'HD' : null,
    item.hdr ? (typeof item.hdr === 'string' ? item.hdr : 'HDR') : null,
  ].filter(Boolean);

  return (
    <div style={{ height:'100vh', position:'relative', overflow:'hidden' }}
      onClick={() => setShowEdit(false)}>

      {/* ── HERO — absolutely positioned, never moves ── */}
      <div style={{ position:'absolute', inset:0, zIndex:0, overflow:'hidden' }}>

          {/* Static backdrop — fades out when video starts */}
          {(backdropUrl || posterUrl) && (
            <img src={backdropUrl || posterUrl} alt=""
              style={{ position:'absolute', inset:0, width:'100%', height:'100%',
                objectFit:'cover', objectPosition:'center top',
                opacity: videoFaded ? 0 : 0.75,
                transition:'opacity 2s ease' }} />
          )}

          {/* Hero trailer — cycles through all trailers shuffled */}
          {videoActive && currentTrailerUrl && (
            <video
              ref={videoRef}
              key={currentTrailerUrl}
              autoPlay playsInline
              style={{ position:'absolute', inset:0, width:'100%', height:'100%',
                objectFit:'cover', objectPosition:'center',
                opacity: videoFaded ? 1 : 0,
                transition:'opacity 3s ease' }}
              onCanPlay={() => setTimeout(() => setVideoFaded(true), 800)}
              onEnded={handleTrailerEnd}
              onError={() => handleTrailerEnd()}>
              <source src={currentTrailerUrl} type="video/mp4" />
            </video>
          )}


          {/* Gradients */}
          <div style={{ position:'absolute', inset:0,
            background:'linear-gradient(to right, rgba(10,10,20,0.65) 0%, rgba(10,10,20,0.4) 40%, rgba(0,0,0,0.05) 70%, transparent 100%)' }} />
          <div style={{ position:'absolute', inset:0,
            background:'linear-gradient(to bottom, rgba(0,0,0,0.1) 0%, transparent 40%, rgba(10,10,20,0.7) 100%)' }} />

          {/* Back button */}
          <button onClick={onClose}
            style={{ position:'absolute', top:24, left:24, zIndex:10,
              background:'rgba(0,0,0,0.55)', border:'1px solid rgba(255,255,255,0.2)',
              color:'white', padding:'7px 14px', borderRadius:20, cursor:'pointer',
              fontSize:13, display:'flex', alignItems:'center', gap:6, backdropFilter:'blur(8px)' }}>
            <ChevronLeft size={15} /> Movies
          </button>

          {/* Hero content — TMDB-style two-column layout */}
          <div style={{ position:'absolute', top:72, left:0, right:0, bottom:0, padding:'16px 48px 16px 24px',
            display:'flex', gap:32, alignItems:'flex-start', overflowY:'auto' }}>

            {/* LEFT — Poster sticky */}
            {posterUrl && (
              <div style={{ flexShrink:0, width:200, position:'sticky', top:0 }}>
                <img src={posterUrl} alt={item.title}
                  style={{ width:'100%', borderRadius:12, boxShadow:'0 8px 32px rgba(0,0,0,0.8)',
                    display:'block', border:'1px solid rgba(255,255,255,0.1)' }} />
              </div>
            )}

            {/* RIGHT — All info, no background */}
            <div style={{ flex:1, minWidth:0, paddingBottom:60 }}>

            {/* Meta badges */}
            {metaBadges.length > 0 && (
              <div style={{ display:'flex', gap:6, marginBottom:10 }}>
                {metaBadges.map(b => (
                  <span key={b} style={{ padding:'2px 8px', borderRadius:4, fontSize:11, fontWeight:700,
                    background:'rgba(255,255,255,0.15)', border:'1px solid rgba(255,255,255,0.3)',
                    color:'rgba(255,255,255,0.9)', letterSpacing:0.5 }}>{b}</span>
                ))}
              </div>
            )}

            {/* Title — clearlogo if available, else text */}
            {clearLogoOk ? (
              <img
                src={clearLogoUrl}
                alt={item.title}
                onError={() => setClearLogoOk(false)}
                style={{ maxWidth:380, maxHeight:130, objectFit:'contain',
                  display:'block', marginBottom:10,
                  filter:'drop-shadow(0 3px 12px rgba(0,0,0,0.95))' }}
              />
            ) : (
              <h1 style={{ fontSize:44, fontWeight:900, lineHeight:1.0, margin:'0 0 8px',
                color:'white', textShadow:'0 2px 20px rgba(0,0,0,0.9), 0 4px 40px rgba(0,0,0,0.5)',
                fontFamily:'var(--font-display)', maxWidth:640, letterSpacing:-0.5 }}>
                {item.title}
              </h1>
            )}

            {/* Metadata row */}
            <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:14, flexWrap:'wrap',
              fontSize:12, color:'rgba(255,255,255,0.7)' }}>
              {item.year && <span>{item.year}</span>}
              {item.year && (item.runtime || item.rating) && <span style={{ opacity:0.4 }}>•</span>}
              {item.runtime && <span>{fmtRuntime(item.runtime)}</span>}
              {item.rating && parseFloat(item.rating) > 0 && (
                <>
                  <span style={{ opacity:0.4 }}>•</span>
                  <span style={{ color:'#f59e0b', fontWeight:700 }}>★ {parseFloat(item.rating).toFixed(1)}</span>
                </>
              )}
              {(item.genres||[]).length > 0 && (
                <>
                  <span style={{ opacity:0.4 }}>•</span>
                  <span>{item.genres.slice(0,3).join(', ')}</span>
                </>
              )}
            </div>

            {/* Tagline */}
            {fullItem.tagline && (
              <p style={{ fontSize:14, color:'rgba(255,255,255,0.5)', fontStyle:'italic',
                margin:'0 0 10px' }}>{fullItem.tagline}</p>
            )}

            {/* Overview */}
            {(fullItem.overview || item.overview) && (
              <p style={{ fontSize:13, color:'rgba(255,255,255,0.85)', lineHeight:1.7,
                maxWidth:560, margin:'0 0 16px', textShadow:'0 1px 6px rgba(0,0,0,0.9)' }}>
                {fullItem.overview || item.overview}
              </p>
            )}

            {/* Director + Writer */}
            <div style={{ display:'flex', gap:32, marginBottom:14, flexWrap:'wrap' }}>
              {(fullItem.director || item.director) && (
                <div>
                  <div style={{ fontSize:11, fontWeight:700, color:'rgba(255,255,255,0.4)',
                    letterSpacing:1.2, textTransform:'uppercase', marginBottom:2 }}>Director</div>
                  <div style={{ fontSize:13, color:'rgba(255,255,255,0.9)', fontWeight:600 }}>
                    {fullItem.director || item.director}
                  </div>
                </div>
              )}
              {fullItem.writer && (
                <div>
                  <div style={{ fontSize:11, fontWeight:700, color:'rgba(255,255,255,0.4)',
                    letterSpacing:1.2, textTransform:'uppercase', marginBottom:2 }}>Writer</div>
                  <div style={{ fontSize:13, color:'rgba(255,255,255,0.9)', fontWeight:600 }}>
                    {fullItem.writer}
                  </div>
                </div>
              )}
            </div>

            {/* User Score + Streaming row */}
            <div style={{ display:'flex', alignItems:'center', gap:16, marginBottom:14, flexWrap:'wrap' }}>
              {item.rating && parseFloat(item.rating) > 0 && (
                <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                  <div style={{ width:52, height:52, borderRadius:'50%', position:'relative',
                    background:`conic-gradient(#21d07a ${Math.round(parseFloat(item.rating)*10)}%, rgba(255,255,255,0.15) 0)`,
                    display:'flex', alignItems:'center', justifyContent:'center' }}>
                    <div style={{ width:40, height:40, borderRadius:'50%', background:'rgba(0,0,0,0.85)',
                      display:'flex', alignItems:'center', justifyContent:'center',
                      fontSize:11, fontWeight:900, color:'white' }}>
                      {Math.round(parseFloat(item.rating)*10)}%
                    </div>
                  </div>
                  <div style={{ fontSize:11, fontWeight:700, color:'rgba(255,255,255,0.7)', lineHeight:1.3 }}>
                    User<br/>Score
                  </div>
                </div>
              )}
              {(fullItem.watchProviders || []).length > 0 && (
                <div style={{ display:'flex', alignItems:'center', gap:6, flexWrap:'wrap' }}>
                  <span style={{ fontSize:11, fontWeight:700, color:'rgba(255,255,255,0.4)',
                    letterSpacing:1, textTransform:'uppercase' }}>Also on</span>
                  {(fullItem.watchProviders || []).slice(0,5).map(p => (
                    <span key={p} style={{ padding:'3px 12px', borderRadius:20, fontSize:11, fontWeight:700,
                      background: PROVIDER_COLORS[p] || 'rgba(255,255,255,0.15)',
                      color:'#fff', border:'1px solid rgba(255,255,255,0.15)' }}>{p}</span>
                  ))}
                </div>
              )}
            </div>

            {/* Cast */}
            {cast.length > 0 && (
              <div style={{ marginBottom:16 }}>
                <div style={{ fontSize:11, fontWeight:700, color:'rgba(255,255,255,0.4)',
                  letterSpacing:1.2, textTransform:'uppercase', marginBottom:10 }}>Cast</div>
                <div style={{ display:'flex', gap:12, maxWidth:'45vw', overflowX:'auto',
                  paddingBottom:6, overflowY:'visible' }}>
                  {cast.slice(0,8).map((c, i) => (
                    <div key={i} style={{ display:'flex', flexDirection:'column', alignItems:'center',
                      gap:4, flexShrink:0, width:52 }}>
                      {(c.image || c.photo)
                        ? <img src={c.image || c.photo} alt={c.name}
                            style={{ width:46, height:46, borderRadius:'50%', objectFit:'cover',
                              border:'2px solid rgba(255,255,255,0.2)' }} />
                        : <div style={{ width:46, height:46, borderRadius:'50%',
                            background:'rgba(255,255,255,0.1)', border:'2px solid rgba(255,255,255,0.2)',
                            display:'flex', alignItems:'center', justifyContent:'center', fontSize:18 }}>👤</div>
                      }
                      <div style={{ textAlign:'center' }}>
                        <div style={{ fontSize:9, fontWeight:700, color:'rgba(255,255,255,0.9)',
                          lineHeight:1.2, wordBreak:'break-word' }}>{c.name}</div>
                        {c.character && (
                          <div style={{ fontSize:8, color:'rgba(255,255,255,0.4)', marginTop:1,
                            lineHeight:1.2, fontStyle:'italic' }}>{c.character}</div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Action buttons */}
            <div style={{ display:'flex', gap:10, alignItems:'center' }}>
              <button onClick={handlePlay}
                style={{ display:'flex', alignItems:'center', gap:8, padding:'11px 28px',
                  background:'white', border:'none', borderRadius:6, cursor:'pointer',
                  fontSize:15, fontWeight:700, color:'#000' }}>
                <Play size={18} fill="black" /> {versions.length > 1 ? 'PLAY...' : 'PLAY'}
              </button>
              <button onClick={handlePlay}
                style={{ display:'flex', alignItems:'center', gap:8, padding:'11px 22px',
                  background:'rgba(255,255,255,0.15)', border:'1px solid rgba(255,255,255,0.3)',
                  backdropFilter:'blur(8px)', borderRadius:6, cursor:'pointer',
                  fontSize:14, fontWeight:600, color:'white' }}>
                <RotateCcw size={15} /> RESTART
              </button>
              {versionsFetched && versions.length > 1 && (
                <button onClick={() => setShowVersionPicker(true)}
                  style={{ display:'flex', alignItems:'center', gap:6, padding:'11px 16px',
                    background:'rgba(99,102,241,0.25)', border:'1px solid rgba(99,102,241,0.5)',
                    borderRadius:6, cursor:'pointer', fontSize:13, fontWeight:700, color:'#a5b4fc' }}>
                  ⊞ {versions.length} VERSIONS
                </button>
              )}

              {/* Pencil/edit menu */}
              <div style={{ position:'relative' }}>
                <button onClick={e => { e.stopPropagation(); setShowEdit(v => !v); }}
                  style={{ width:42, height:42, borderRadius:'50%', display:'flex', alignItems:'center', justifyContent:'center',
                    background: showEdit ? 'rgba(99,102,241,0.5)' : 'rgba(255,255,255,0.15)',
                    border:`1px solid ${showEdit ? 'rgba(99,102,241,0.8)' : 'rgba(255,255,255,0.3)'}`,
                    color:'white', cursor:'pointer', backdropFilter:'blur(8px)', fontSize:15 }}>
                  ✏️
                </button>
                {showEdit && (
                  <div style={{ position:'absolute', bottom:48, left:0, background:'#1a1a2e',
                    border:'1px solid rgba(255,255,255,0.12)', borderRadius:10, padding:6,
                    zIndex:20, minWidth:175, boxShadow:'0 8px 32px rgba(0,0,0,0.8)' }}>
                    <button onClick={handleRefresh} disabled={refreshing}
                      style={{ display:'flex', alignItems:'center', gap:8, width:'100%', padding:'9px 12px',
                        background:'none', border:'none', color: refreshing ? '#10b981' : 'rgba(255,255,255,0.85)',
                        cursor:'pointer', fontSize:13, borderRadius:6 }}
                      onMouseEnter={e=>e.currentTarget.style.background='rgba(255,255,255,0.08)'}
                      onMouseLeave={e=>e.currentTarget.style.background='none'}>
                      ⟳ {refreshing ? 'Refreshing…' : 'Refresh Metadata'}
                    </button>
                    <button onClick={() => { setShowEdit(false); setShowFixMatch(true); setSearchQ(fullItem.title||item.title||''); setSearchResults([]); }}
                      style={{ display:'flex', alignItems:'center', gap:8, width:'100%', padding:'9px 12px',
                        background:'none', border:'none', color:'rgba(255,255,255,0.85)',
                        cursor:'pointer', fontSize:13, borderRadius:6 }}
                      onMouseEnter={e=>e.currentTarget.style.background='rgba(255,255,255,0.08)'}
                      onMouseLeave={e=>e.currentTarget.style.background='none'}>
                      🔍 Fix Match
                    </button>
                    <button onClick={openArtworkPicker}
                      style={{ display:'flex', alignItems:'center', gap:8, width:'100%', padding:'9px 12px',
                        background:'none', border:'none', color:'rgba(255,255,255,0.85)',
                        cursor:'pointer', fontSize:13, borderRadius:6 }}
                      onMouseEnter={e=>e.currentTarget.style.background='rgba(255,255,255,0.08)'}
                      onMouseLeave={e=>e.currentTarget.style.background='none'}>
                      🖼️ Change Artwork
                    </button>
                    <div style={{ height:1, background:'rgba(255,255,255,0.08)', margin:'4px 8px' }} />
                    <button onClick={handleDelete}
                      style={{ display:'flex', alignItems:'center', gap:8, width:'100%', padding:'9px 12px',
                        background:'none', border:'none', color:'#f87171',
                        cursor:'pointer', fontSize:13, borderRadius:6 }}
                      onMouseEnter={e=>e.currentTarget.style.background='rgba(248,113,113,0.1)'}
                      onMouseLeave={e=>e.currentTarget.style.background='none'}>
                      🗑️ Remove from Library
                    </button>
                  </div>
                )}
              </div>
            </div>
            </div>{/* end right column */}
          </div>
        </div>

      {/* Arrows — 225px from bottom */}
      {prev && (
        <button onClick={() => onNavigate(prev)}
          style={{ position:'fixed', bottom:'38%', left:16, zIndex:1000,
            width:44, height:44, borderRadius:'50%', background:'rgba(0,0,0,0.6)',
            border:'1px solid rgba(255,255,255,0.2)', color:'white', cursor:'pointer',
            fontSize:24, display:'flex', alignItems:'center', justifyContent:'center',
            backdropFilter:'blur(8px)' }}
          onMouseEnter={e=>e.currentTarget.style.background='rgba(99,102,241,0.8)'}
          onMouseLeave={e=>e.currentTarget.style.background='rgba(0,0,0,0.6)'}>
          ‹
        </button>
      )}
      {next && (
        <button onClick={() => onNavigate(next)}
          style={{ position:'fixed', bottom:'38%', right:16, zIndex:1000,
            width:44, height:44, borderRadius:'50%', background:'rgba(0,0,0,0.6)',
            border:'1px solid rgba(255,255,255,0.2)', color:'white', cursor:'pointer',
            fontSize:24, display:'flex', alignItems:'center', justifyContent:'center',
            backdropFilter:'blur(8px)' }}
          onMouseEnter={e=>e.currentTarget.style.background='rgba(99,102,241,0.8)'}
          onMouseLeave={e=>e.currentTarget.style.background='rgba(0,0,0,0.6)'}>
          ›
        </button>
      )}

      {/* Trailer progress dots */}
      {videoActive && trailerUrls.length > 1 && (
        <div style={{ position:'absolute', bottom:56, left:0, right:0, zIndex:15,
          display:'flex', justifyContent:'center', gap:8, pointerEvents:'none' }}>
          {trailerUrls.map((_, i) => (
            <div key={i} style={{
              width: i === trailerIdx ? 20 : 8,
              height: 8, borderRadius: 4,
              background: i === trailerIdx ? 'white' : 'rgba(255,255,255,0.35)',
              transition: 'all 0.3s ease',
              boxShadow: i === trailerIdx ? '0 0 6px rgba(255,255,255,0.6)' : 'none',
            }} />
          ))}
        </div>
      )}

      {/* ── BOTTOM TAB BAR — pinned to bottom ── */}
      <div style={{ position:'absolute', bottom:0, left:0, right:0, zIndex:10 }}>

        {/* Suggested panel — slides up from LEFT half, under Suggested tab */}
        {activeTab === 'suggested' && (
          <div style={{ position:'absolute', bottom:'100%', left:0, width:'50%',
            height:'30vh', overflowY:'auto', padding:'20px 24px 16px',
            background:'rgba(10,10,20,0.95)', backdropFilter:'blur(12px)',
            borderTop:'1px solid rgba(255,255,255,0.08)',
            borderRight:'1px solid rgba(255,255,255,0.08)',
            borderRadius:'0 12px 0 0' }}
            onClick={() => setShowEdit(false)}>
            {(() => {
              const genres = new Set(fullItem.genres || item.genres || []);
              const allMovies = library.movies || [];
              const scored = allMovies
                .filter(m => m.id !== item.id && m.thumbnail)
                .map(m => {
                  const mGenres = m.genres || [];
                  const overlap = mGenres.filter(g => genres.has(g)).length;
                  return { ...m, _score: overlap };
                })
                .filter(m => m._score > 0)
                .sort((a, b) => b._score - a._score || Math.random() - 0.5)
                .slice(0, 6);

              if (scored.length === 0) return (
                <div style={{ color:'rgba(255,255,255,0.4)', fontSize:13, padding:'10px 0' }}>
                  No genre matches found.
                </div>
              );

              const displayGenres = [...genres].slice(0, 3).join(', ');
              return (
                <div>
                  <div style={{ fontSize:10, color:'rgba(255,255,255,0.35)', letterSpacing:1, textTransform:'uppercase', marginBottom:12 }}>
                    More like this · {displayGenres}
                  </div>
                  <div style={{ display:'grid', gridTemplateColumns:'repeat(6, 1fr)', gap:'10px 8px' }}>
                    {scored.map(m => (
                      <div key={m.id} onClick={() => onNavigate && onNavigate(m)} style={{ cursor:'pointer' }}>
                        <div style={{ aspectRatio:'2/3', borderRadius:5, overflow:'hidden', background:'#1a1a2e',
                          border:'1px solid rgba(255,255,255,0.08)', marginBottom:4, position:'relative' }}
                          onMouseEnter={e => e.currentTarget.style.border='1px solid rgba(99,102,241,0.6)'}
                          onMouseLeave={e => e.currentTarget.style.border='1px solid rgba(255,255,255,0.08)'}>
                          {m.thumbnail
                            ? <img src={resolveImg(m.thumbnail)} alt={m.title} loading="lazy"
                                style={{ width:'100%', height:'100%', objectFit:'cover' }} />
                            : <div style={{ width:'100%', height:'100%', display:'flex', alignItems:'center', justifyContent:'center', fontSize:20 }}>🎬</div>
                          }
                          {m.rating && (
                            <div style={{ position:'absolute', bottom:3, right:3, background:'rgba(0,0,0,0.75)',
                              borderRadius:3, padding:'1px 4px', fontSize:9, color:'#fbbf24', fontWeight:700 }}>
                              ★ {parseFloat(m.rating).toFixed(1)}
                            </div>
                          )}
                        </div>
                        <div style={{ fontSize:10, fontWeight:600, color:'rgba(255,255,255,0.75)',
                          overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{m.title}</div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}
          </div>
        )}

        {/* Extras panel — slides up from RIGHT half, under Extras tab */}
        {activeTab === 'extras' && (
          <div style={{ position:'absolute', bottom:'100%', right:0, width:'50%',
            height:'30vh', overflowY:'auto', padding:'20px 24px 16px',
            background:'rgba(10,10,20,0.95)', backdropFilter:'blur(12px)',
            borderTop:'1px solid rgba(255,255,255,0.08)',
            borderLeft:'1px solid rgba(255,255,255,0.08)',
            borderRadius:'12px 0 0 0' }}
            onClick={() => setShowEdit(false)}>
            <div>
              {trailers.length > 0 && (
                <div style={{ marginBottom:16 }}>
                  <div style={{ fontSize:10, fontWeight:700, color:'rgba(255,255,255,0.4)', letterSpacing:1.2, textTransform:'uppercase', marginBottom:10 }}>Trailers & Clips</div>
                  <div style={{ display:'flex', gap:10, overflowX:'auto', paddingBottom:4 }}>
                    {trailers.map((v) => (
                      <div key={v.key} style={{ flexShrink:0, width:280, cursor:'pointer' }}
                        onClick={() => {
                          const ytUrl = `https://www.youtube.com/watch?v=${v.key}`;
                          fetch(`http://localhost:3001/api/ytdlp/stream?url=${encodeURIComponent(ytUrl)}`)
                            .then(r => r.json())
                            .then(d => { if (d.url) playMedia({ ...item, filePath: d.url, fileName: v.name, title: v.name }); else window.open(ytUrl, '_blank'); })
                            .catch(() => window.open(ytUrl, '_blank'));
                        }}>
                        <div style={{ position:'relative', height:155, borderRadius:6, overflow:'hidden', marginBottom:6, border:'1px solid rgba(255,255,255,0.1)' }}>
                          <img src={`https://img.youtube.com/vi/${v.key}/mqdefault.jpg`} alt={v.name} style={{ width:'100%', height:'100%', objectFit:'cover' }} />
                          <div style={{ position:'absolute', inset:0, background:'rgba(0,0,0,0.3)', display:'flex', alignItems:'center', justifyContent:'center' }}>
                            <div style={{ width:36, height:36, borderRadius:'50%', background:'rgba(255,255,255,0.9)', display:'flex', alignItems:'center', justifyContent:'center' }}>
                              <Play size={16} fill="#000" color="#000" style={{ marginLeft:2 }} />
                            </div>
                          </div>
                          <div style={{ position:'absolute', top:6, left:6, padding:'1px 6px', borderRadius:3, fontSize:9, fontWeight:700, background:'rgba(0,0,0,0.7)', color:'rgba(255,255,255,0.8)', textTransform:'uppercase' }}>{v.type}</div>
                        </div>
                        <div style={{ fontSize:11, fontWeight:600, color:'rgba(255,255,255,0.8)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{v.name}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {Object.entries(extrasByLabel).map(([label, items]) => (
                <div key={label} style={{ marginBottom:16 }}>
                  <div style={{ fontSize:10, fontWeight:700, color:'rgba(255,255,255,0.4)', letterSpacing:1.2, textTransform:'uppercase', marginBottom:10 }}>{label}</div>
                  <div style={{ display:'flex', gap:10, overflowX:'auto', paddingBottom:4 }}>
                    {items.map((ex, i) => (
                      <div key={i} style={{ flexShrink:0, width:260, cursor:'pointer' }}
                        onClick={() => playMedia({...item, filePath:ex.filePath, fileName:ex.fileName, title:ex.title})}>
                        <div style={{ height:145, background:'rgba(255,255,255,0.05)', borderRadius:6, border:'1px solid rgba(255,255,255,0.08)', display:'flex', alignItems:'center', justifyContent:'center', marginBottom:6 }}>
                          <Play size={18} fill="white" color="white" />
                        </div>
                        <div style={{ fontSize:11, fontWeight:600, color:'rgba(255,255,255,0.8)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{ex.title}</div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              {trailers.length === 0 && Object.keys(extrasByLabel).length === 0 && (
                <div style={{ color:'rgba(255,255,255,0.4)', fontSize:13, padding:'10px 0' }}>No trailers or extras found.</div>
              )}
            </div>
          </div>
        )}

        {/* Tab buttons bar */}
        <div style={{ display:'flex', justifyContent:'space-around',
          background:'rgba(10,10,20,0.92)', backdropFilter:'blur(12px)',
          borderTop:'1px solid rgba(255,255,255,0.08)' }}>
          {tabs.map(t => (
            <button key={t.id} onClick={() => setActiveTab(activeTab === t.id ? null : t.id)}
              style={{ flex:1, padding:'14px 0', background:'none', border:'none',
                cursor:'pointer', fontSize:11, fontWeight:700, letterSpacing:1.2,
                color: activeTab === t.id ? 'white' : 'rgba(255,255,255,0.4)',
                borderTop: activeTab === t.id ? '2px solid white' : '2px solid transparent',
                transition:'color 0.15s, border-color 0.15s', textTransform:'uppercase' }}>
              {t.label}
            </button>
          ))}
        </div>
      </div>{/* end bottom tab bar */}

      {/* ── Version Picker Modal ── */}
      {showVersionPicker && ReactDOM.createPortal(
        <div style={{ position:'fixed', inset:0, zIndex:99999, display:'flex', alignItems:'center', justifyContent:'center',
          background:'rgba(0,0,0,0.85)', backdropFilter:'blur(8px)' }}
          onClick={e => { if (e.target === e.currentTarget) setShowVersionPicker(false); }}>
          <div style={{ background:'#1a1a2e', border:'1px solid rgba(99,102,241,0.4)', borderRadius:14,
            padding:28, width:480, maxWidth:'90vw', boxShadow:'0 24px 64px rgba(0,0,0,0.9)' }}
            onClick={e => e.stopPropagation()}>
            <div style={{ fontSize:16, fontWeight:700, color:'white', marginBottom:6 }}>Choose Version</div>
            <div style={{ fontSize:13, color:'rgba(255,255,255,0.4)', marginBottom:20 }}>
              {item.title} — {versions.length} versions available
            </div>
            <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
              {versions.map((v, i) => {
                const sizeMb = v.size ? (v.size / 1024 / 1024 / 1024).toFixed(2) + ' GB' : null;
                const name = v.fileName || v.filePath?.split(/[\\/]/).pop() || `Version ${i+1}`;
                return (
                  <div key={i} onClick={() => playVersion(v)}
                    style={{ display:'flex', alignItems:'center', gap:14, padding:'12px 16px',
                      background:'rgba(255,255,255,0.04)', border:'1px solid rgba(255,255,255,0.08)',
                      borderRadius:10, cursor:'pointer', transition:'all 0.15s' }}
                    onMouseEnter={e => { e.currentTarget.style.background='rgba(99,102,241,0.2)'; e.currentTarget.style.borderColor='rgba(99,102,241,0.5)'; }}
                    onMouseLeave={e => { e.currentTarget.style.background='rgba(255,255,255,0.04)'; e.currentTarget.style.borderColor='rgba(255,255,255,0.08)'; }}>
                    <div style={{ width:36, height:36, borderRadius:8, background:'rgba(99,102,241,0.2)',
                      display:'flex', alignItems:'center', justifyContent:'center', fontSize:18, flexShrink:0 }}>▶</div>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontSize:13, fontWeight:600, color:'white', overflow:'hidden',
                        textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{name}</div>
                      {sizeMb && <div style={{ fontSize:11, color:'rgba(255,255,255,0.4)', marginTop:2 }}>{sizeMb}</div>}
                    </div>
                    {i === 0 && <div style={{ fontSize:10, fontWeight:700, padding:'2px 8px',
                      background:'rgba(16,185,129,0.2)', color:'#10b981', borderRadius:4 }}>BEST</div>}
                  </div>
                );
              })}
            </div>
            <button onClick={() => setShowVersionPicker(false)}
              style={{ marginTop:16, width:'100%', padding:'9px', background:'rgba(255,255,255,0.06)',
                border:'1px solid rgba(255,255,255,0.1)', borderRadius:8, color:'rgba(255,255,255,0.5)',
                cursor:'pointer', fontSize:13 }}>Cancel</button>
          </div>
        </div>,
        document.body
      )}

      {/* ── Fix Match Modal — rendered via portal to escape root onClick ── */}
      {showFixMatch && ReactDOM.createPortal(
        <div style={{ position:'fixed', inset:0, zIndex:99999, display:'flex', alignItems:'center', justifyContent:'center',
          background:'rgba(0,0,0,0.8)', backdropFilter:'blur(8px)' }}
          onClick={e => { if (e.target === e.currentTarget) setShowFixMatch(false); }}>
          <div style={{ background:'#1a1a2e', border:'1px solid rgba(99,102,241,0.4)', borderRadius:14,
            padding:28, width:520, maxWidth:'90vw', maxHeight:'80vh', display:'flex', flexDirection:'column',
            boxShadow:'0 24px 64px rgba(0,0,0,0.9)' }}
            onClick={e => e.stopPropagation()}>
            <div style={{ fontSize:16, fontWeight:700, color:'white', marginBottom:6 }}>Fix Match</div>
            <div style={{ fontSize:13, color:'rgba(255,255,255,0.4)', marginBottom:18 }}>
              Search TMDB for the correct metadata for <strong style={{ color:'rgba(255,255,255,0.7)' }}>{item.title}</strong>
            </div>
            <div style={{ display:'flex', gap:8, marginBottom:16 }}>
              <input value={searchQ} onChange={e => setSearchQ(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSearch()}
                placeholder="Search TMDB..." autoFocus
                style={{ flex:1, padding:'9px 13px', background:'rgba(255,255,255,0.07)',
                  border:'1px solid rgba(255,255,255,0.15)', borderRadius:8, color:'white', fontSize:14, outline:'none' }} />
              <button onClick={handleSearch} disabled={searching}
                style={{ padding:'9px 20px', background:'var(--accent)', color:'white',
                  border:'none', borderRadius:8, cursor:'pointer', fontSize:14, fontWeight:600, opacity: searching ? 0.7 : 1 }}>
                {searching ? '…' : 'Search'}
              </button>
              <button onClick={() => setShowFixMatch(false)}
                style={{ padding:'9px 14px', background:'rgba(255,255,255,0.06)', color:'rgba(255,255,255,0.6)',
                  border:'1px solid rgba(255,255,255,0.1)', borderRadius:8, cursor:'pointer', fontSize:14 }}>✕</button>
            </div>
            <div style={{ overflowY:'auto', flex:1 }}>
              {searching && <div style={{ color:'rgba(255,255,255,0.4)', fontSize:13, textAlign:'center', padding:'20px 0' }}>Searching…</div>}
              {!searching && searchResults.length === 0 && searchQ && (
                <div style={{ color:'rgba(255,255,255,0.4)', fontSize:13, textAlign:'center', padding:'20px 0' }}>No results found.</div>
              )}
              {searchResults.map(r => (
                <div key={r.id} onClick={() => handleFixMatch(r.id)}
                  style={{ display:'flex', gap:14, padding:'10px 12px', borderRadius:8, cursor:'pointer',
                    background:'rgba(255,255,255,0.03)', border:'1px solid rgba(255,255,255,0.07)', marginBottom:8 }}
                  onMouseEnter={e => e.currentTarget.style.background='rgba(99,102,241,0.15)'}
                  onMouseLeave={e => e.currentTarget.style.background='rgba(255,255,255,0.03)'}>
                  {r.poster
                    ? <img src={r.poster} alt={r.title} style={{ width:42, height:62, borderRadius:5, objectFit:'cover', flexShrink:0 }} />
                    : <div style={{ width:42, height:62, borderRadius:5, background:'#2a2a3e', flexShrink:0, display:'flex', alignItems:'center', justifyContent:'center', fontSize:20 }}>🎬</div>}
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:14, fontWeight:700, color:'white' }}>{r.title} {r.year ? `(${r.year})` : ''}</div>
                    {r.rating && <div style={{ fontSize:12, color:'#fbbf24', marginTop:2 }}>★ {r.rating}</div>}
                    {r.overview && <div style={{ fontSize:12, color:'rgba(255,255,255,0.35)', marginTop:4,
                      overflow:'hidden', display:'-webkit-box', WebkitLineClamp:2, WebkitBoxOrient:'vertical' }}>{r.overview}</div>}
                  </div>
                  <div style={{ flexShrink:0, alignSelf:'center', fontSize:12, color:'var(--accent)',
                    fontWeight:700, padding:'4px 10px', border:'1px solid var(--accent)', borderRadius:5 }}>Select</div>
                </div>
              ))}
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* ── Artwork Picker Modal ── */}
      {showArtwork && ReactDOM.createPortal(
        <div style={{ position:'fixed', inset:0, zIndex:99999, display:'flex', alignItems:'center', justifyContent:'center',
          background:'rgba(0,0,0,0.85)', backdropFilter:'blur(8px)' }}
          onClick={e => { if (e.target === e.currentTarget) setShowArtwork(false); }}>
          <div style={{ background:'#1a1a2e', border:'1px solid rgba(99,102,241,0.4)', borderRadius:14,
            padding:24, width:860, maxWidth:'92vw', maxHeight:'88vh', display:'flex', flexDirection:'column',
            boxShadow:'0 24px 64px rgba(0,0,0,0.9)' }}
            onClick={e => e.stopPropagation()}>

            {/* Header */}
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:16 }}>
              <div>
                <div style={{ fontSize:16, fontWeight:700, color:'white' }}>🖼️ Change Artwork</div>
                <div style={{ fontSize:12, color:'rgba(255,255,255,0.4)', marginTop:2 }}>{fullItem.title || item.title}</div>
              </div>
              <button onClick={() => setShowArtwork(false)}
                style={{ background:'rgba(255,255,255,0.08)', border:'1px solid rgba(255,255,255,0.12)',
                  color:'rgba(255,255,255,0.6)', borderRadius:8, padding:'6px 12px', cursor:'pointer', fontSize:13 }}>✕ Close</button>
            </div>

            {/* Tabs */}
            <div style={{ display:'flex', gap:2, borderBottom:'1px solid rgba(255,255,255,0.08)', marginBottom:16 }}>
              {['posters','backdrops'].map(t => (
                <button key={t} onClick={() => setArtworkTab(t)}
                  style={{ padding:'8px 18px', border:'none', background:'none', cursor:'pointer', fontSize:13, fontWeight:600, textTransform:'capitalize',
                    color: artworkTab===t ? 'var(--accent)' : 'rgba(255,255,255,0.4)',
                    borderBottom: artworkTab===t ? '2px solid var(--accent)' : '2px solid transparent',
                    marginBottom:-1 }}>
                  {t} ({artworkData[t]?.length || 0})
                </button>
              ))}
            </div>

            {/* Content */}
            <div style={{ overflowY:'auto', flex:1 }}>
              {artworkLoading ? (
                <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:200, gap:12, color:'rgba(255,255,255,0.4)' }}>
                  <div style={{ width:24, height:24, border:'2px solid rgba(255,255,255,0.1)', borderTop:'2px solid var(--accent)', borderRadius:'50%', animation:'spin 0.8s linear infinite' }} />
                  Loading artwork from TMDB...
                </div>
              ) : artworkData[artworkTab]?.length === 0 ? (
                <div style={{ textAlign:'center', padding:'40px 0', color:'rgba(255,255,255,0.3)', fontSize:13 }}>
                  No {artworkTab} found.{!fullItem.tmdbId && ' Add a TMDB API key and run Fix Match first.'}
                </div>
              ) : (
                <div style={{ display:'grid', gridTemplateColumns: artworkTab==='posters' ? 'repeat(auto-fill, minmax(130px,1fr))' : 'repeat(auto-fill, minmax(220px,1fr))', gap:10 }}>
                  {artworkData[artworkTab].map((img, i) => (
                    <div key={i} style={{ position:'relative', cursor:'pointer', borderRadius:8, overflow:'hidden',
                      border:'2px solid rgba(255,255,255,0.06)', transition:'all 0.15s' }}
                      onMouseEnter={e => { e.currentTarget.style.borderColor='var(--accent)'; e.currentTarget.querySelector('.apply-btn').style.opacity='1'; }}
                      onMouseLeave={e => { e.currentTarget.style.borderColor='rgba(255,255,255,0.06)'; e.currentTarget.querySelector('.apply-btn').style.opacity='0'; }}>
                      <img src={img.path} alt="" style={{ width:'100%', display:'block', objectFit:'cover' }}
                        loading="lazy" onError={e => e.target.parentNode.style.display='none'} />
                      {img.lang && <div style={{ position:'absolute', top:4, left:4, background:'rgba(0,0,0,0.7)',
                        color:'#fff', fontSize:9, fontWeight:700, padding:'2px 5px', borderRadius:3, textTransform:'uppercase' }}>{img.lang||'?'}</div>}
                      {img.votes > 0 && <div style={{ position:'absolute', top:4, right:4, background:'rgba(0,0,0,0.7)',
                        color:'#fbbf24', fontSize:9, fontWeight:700, padding:'2px 5px', borderRadius:3 }}>★{img.rating?.toFixed(1)}</div>}
                      <button className="apply-btn" disabled={artworkApplying}
                        onClick={() => applyArtwork(img.fullPath, artworkTab==='posters' ? 'poster' : 'backdrop')}
                        style={{ position:'absolute', bottom:6, left:'50%', transform:'translateX(-50%)',
                          opacity:0, transition:'opacity 0.15s', background:'var(--accent)', color:'white',
                          border:'none', borderRadius:6, padding:'5px 14px', cursor:'pointer',
                          fontSize:11, fontWeight:700, whiteSpace:'nowrap',
                          boxShadow:'0 2px 8px rgba(0,0,0,0.6)' }}>
                        {artworkApplying ? '…' : '✓ Apply'}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

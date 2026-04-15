import React, { useState, useEffect, useMemo, useRef } from 'react';
import ReactDOM from 'react-dom';
import { useApp } from '../contexts/AppContext';
import GenreCategoryGrid from '../components/GenreCategoryGrid';
import { FolderOpen, Play, ChevronLeft, Star, Tv } from 'lucide-react';
import MediaCard from '../components/MediaCard';
import ScrollableGrid from '../components/ScrollableGrid';

const BASE = 'http://localhost:3001';
const resolveImg = (url) => {
  if (!url) return null;
  if (url.startsWith('http')) return url;
  if (url.startsWith('/api')) return BASE + url;
  return null;
};

// ── Group raw episodes into show objects ──────────────────────────────────────
function groupByShow(episodes) {
  const shows = {};
  for (const ep of (episodes || [])) {
    // Fast path: use pre-computed seriesTitle if available
    let showName = ep.seriesTitle || null;
    if (!showName && ep.filePath) {
      const parts = ep.filePath.replace(/\\/g, '/').split('/');
      for (let i = parts.length - 2; i >= 0; i--) {
        const part = parts[i];
        if (!part.match(/^(season|s\d|disc|disk|extras?|specials?|bonus)/i) && part.length > 2) {
          showName = part.replace(/[._]/g, ' ').replace(/\s*\(?(19|20)\d{2}\)?\s*$/, '').replace(/\s+/g, ' ').trim();
          break;
        }
      }
    }
    if (!showName) showName = ep.title || 'Unknown Show';
    if (!shows[showName]) {
      shows[showName] = { id: `show_${showName}`, showName, episodes: [], thumbnail: null, backdrop: null, overview: null, rating: null, year: null, cast: [], genres: [] };
    }
    shows[showName].episodes.push(ep);
    if (!shows[showName].thumbnail && ep.thumbnail) {
      shows[showName].thumbnail = ep.thumbnail;
      shows[showName].backdrop  = ep.backdrop;
      shows[showName].overview  = ep.overview;
      shows[showName].year      = ep.year;
      shows[showName].cast      = ep.cast || [];
      shows[showName].genres    = ep.genres || [];
    }
    if (ep.rating && parseFloat(ep.rating) > parseFloat(shows[showName].rating || 0)) {
      shows[showName].rating = ep.rating;
    }
  }
  return Object.values(shows).sort((a, b) => a.showName.localeCompare(b.showName));
}

// Group episodes by season number
function groupBySeasons(episodes) {
  const seasons = {};
  for (const ep of episodes) {
    // Use server-parsed seasonNum if available (most reliable)
    let num = ep.seasonNum;
    if (!num) {
      const fp = (ep.filePath || ep.fileName || '').replace(/\\/g, '/');
      const parts = fp.split('/');
      const parentFolder = parts.length >= 2 ? parts[parts.length - 2] : '';
      const seasonFolderMatch =
        parentFolder.match(/^[Ss]eason\s*(\d{1,3})$/) ||
        parentFolder.match(/^[Ss](\d{1,3})$/);
      const fileMatch = fp.match(/[Ss](\d{1,3})[Ee]\d/);
      num = seasonFolderMatch ? parseInt(seasonFolderMatch[1]) : fileMatch ? parseInt(fileMatch[1]) : 1;
    }
    const key = num;
    if (!seasons[key]) seasons[key] = [];
    seasons[key].push(ep);
  }
  return Object.entries(seasons)
    .sort(([a], [b]) => parseInt(a) - parseInt(b))
    .map(([num, eps]) => ({
      num: parseInt(num),
      label: `Season ${num}`,
      episodes: eps.sort((a, b) => {
        const ea = parseInt((a.filePath || a.fileName || '').match(/[Ee](\d+)/)?.[1] || 99);
        const eb = parseInt((b.filePath || b.fileName || '').match(/[Ee](\d+)/)?.[1] || 99);
        return ea - eb;
      }),
      thumbnail: eps.find(e => e.thumbnail)?.thumbnail || null,
    }));
}

// ── Episode row component ─────────────────────────────────────────────────────
function EpisodeRow({ ep, index, onSelect }) {
  const [screenshotErr, setScreenshotErr] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const epNum = (ep.filePath || ep.fileName || '').match(/[Ee](\d+)/)?.[1];
  const BASE = 'http://localhost:3001';
  const screenshotUrl = !screenshotErr ? `${BASE}/api/library/item/${ep.id}/screenshot` : null;

  return (
    <div onClick={() => onSelect?.(ep)}
      style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '10px 12px', borderRadius: 10, cursor: 'pointer', transition: 'background 0.15s', marginBottom: 4 }}
      onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.06)'}
      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
    >
      {/* Episode number */}
      <div style={{ width: 28, textAlign: 'right', fontSize: 16, fontWeight: 700, color: 'var(--text-muted)', flexShrink: 0 }}>
        {epNum || index + 1}
      </div>

      {/* Screenshot thumbnail */}
      <div style={{ width: 160, height: 90, borderRadius: 8, overflow: 'hidden', flexShrink: 0, background: 'var(--bg-tertiary)', position: 'relative' }}>
        {screenshotUrl && !screenshotErr
          ? <img src={screenshotUrl} alt="" onError={() => setScreenshotErr(true)} onLoad={() => setLoaded(true)}
              style={{ width: '100%', height: '100%', objectFit: 'cover', opacity: loaded ? 1 : 0, transition: 'opacity 0.3s' }} />
          : <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Tv size={24} color="var(--text-muted)" /></div>
        }
        {!loaded && screenshotUrl && !screenshotErr && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Tv size={20} color="var(--text-muted)" style={{ opacity: 0.4 }} />
          </div>
        )}
        {/* Play overlay on hover */}
        <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0)', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background 0.2s' }}
          onMouseEnter={e => { e.currentTarget.style.background = 'rgba(0,0,0,0.5)'; e.currentTarget.querySelector('svg').style.opacity = '1'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'rgba(0,0,0,0)'; e.currentTarget.querySelector('svg').style.opacity = '0'; }}>
          <Play size={24} fill="white" color="white" style={{ opacity: 0, transition: 'opacity 0.2s', pointerEvents: 'none' }} />
        </div>
      </div>

      {/* Info */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>
          {ep.displayTitle || ep.title}
        </div>
        {(ep.displayOverview || ep.overview) && (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
            {ep.displayOverview || ep.overview}
          </div>
        )}
        <div style={{ display: 'flex', gap: 10, marginTop: 6, fontSize: 11, color: 'var(--text-muted)' }}>
          {ep.year && <span>{ep.year}</span>}
          {ep.ext && <span style={{ textTransform: 'uppercase' }}>{ep.ext.replace('.','')}</span>}
          {ep.size > 0 && <span>{(ep.size/1024/1024/1024).toFixed(2)} GB</span>}
        </div>
      </div>

      {/* Duration placeholder */}
      <div style={{ flexShrink: 0, fontSize: 13, color: 'var(--text-muted)', minWidth: 40, textAlign: 'right' }}>
        <Play size={14} color="var(--accent)" />
      </div>
    </div>
  );
}

// ── Show Detail view ──────────────────────────────────────────────────────────
function ShowDetail({ show, onBack, onSelect, prevShow, nextShow, onPrev, onNext, activeVideoRef }) {
  const { fetchLibrary, playerOpen } = useApp();
  const [showData, setShowData] = React.useState(show);

  React.useEffect(() => {
    if (!showData.seasons || showData.seasons.length === 0) {
      fetch(`http://localhost:3001/api/library/tvShows/byShow/${encodeURIComponent(show.showName)}`)
        .then(r => r.json())
        .then(d => {
          const eps = d.items || [];
          if (!eps.length) return;
          const seasonMap = {};
          eps.forEach(ep => {
            const sNum = ep.seasonNum || 1;
            if (!seasonMap[sNum]) seasonMap[sNum] = { num: sNum, episodeCount: 0, thumbnail: null };
            seasonMap[sNum].episodeCount++;
            if (!seasonMap[sNum].thumbnail && ep.thumbnail) seasonMap[sNum].thumbnail = ep.thumbnail;
          });
          const seasons = Object.values(seasonMap).sort((a, b) => a.num - b.num);
          setShowData(prev => ({ ...prev, seasons, episodeCount: eps.length }));
        }).catch(() => {});
    }
  }, [show.showName]);

  const seasons = React.useMemo(() => {
    if (showData.seasons?.length > 0) return showData.seasons.map(s => ({ num: s.num, label: `Season ${s.num}`, episodeCount: s.episodeCount, thumbnail: s.thumbnail || null }));
    return [];
  }, [showData.seasons]);

  const [seasonEpisodes, setSeasonEpisodes] = React.useState({});
  const [activeSeason, setActiveSeason] = useState(null);
  const [activeTab, setActiveTab] = useState(null);
  const [tvData, setTvData] = useState(null);
  const [cast, setCast] = useState(showData.cast || []);
  const [showEdit, setShowEdit] = useState(false);
  const [editMenuPos, setEditMenuPos] = useState({ top: 0, left: 0 });
  const [showFixMatch, setShowFixMatch] = useState(false);
  const [searchQ, setSearchQ] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const API = 'http://localhost:3001/api';

  const loadSeasonEpisodes = (seasonNum) => {
    if (seasonEpisodes[seasonNum]) return;
    fetch(`http://localhost:3001/api/library/tvShows/byShow/${encodeURIComponent(show.showName)}?season=${seasonNum}`)
      .then(r => r.json())
      .then(d => {
        const eps = (d.items || []).filter(ep => (ep.seasonNum || 1) === seasonNum);
        setSeasonEpisodes(prev => ({ ...prev, [seasonNum]: eps }));
      }).catch(() => {});
  };

  // TVmaze cast
  React.useEffect(() => {
    const name = encodeURIComponent(show.showName || '');
    fetch(`https://api.tvmaze.com/singlesearch/shows?q=${name}&embed[]=cast`)
      .then(r => r.json()).then(d => {
        setTvData(d);
        if (d._embedded?.cast?.length > 0) {
          setCast(d._embedded.cast.slice(0, 16).map(c => ({
            name: c.person?.name,
            character: c.character?.name,
            image: c.person?.image?.medium || null,
          })).filter(c => c.name));
        }
      }).catch(() => {});
  }, [show.showName]);

  // Trailers — identical to MovieDetailPage
  const [videoActive, setVideoActive] = React.useState(false);
  const [videoFaded, setVideoFaded] = React.useState(false);
  const [trailerUrls, setTrailerUrls] = React.useState([]);
  const [trailerIdx, setTrailerIdx] = React.useState(0);
  const videoRef = React.useRef(null);
  const blurVideoRef = React.useRef(null);

  React.useEffect(() => {
    setTrailerUrls([]);
    setTrailerIdx(0);
    setVideoActive(false);
    setVideoFaded(false);
    setBlackout(false);

    let cancelled = false;

    const load = async () => {
      const overrideId = show.trailerOverride || showData.trailerOverride;

      if (overrideId) {
        if (cancelled) return;
        const url = `http://localhost:3001/api/ytdlp/stream?url=${encodeURIComponent('https://www.youtube.com/watch?v=' + overrideId)}&showName=${encodeURIComponent(show.showName)}&t=${Date.now()}`;
        setTrailerUrls([url]);
        return;
      }

      const getTrailers = (tmdbId) => {
        fetch(`http://localhost:3001/api/tmdb/tv-videos/${tmdbId}`)
          .then(r => r.json())
          .then(d => {
            if (cancelled) return;
            const videos = (d.videos || []).filter(v => ['Trailer', 'Teaser'].includes(v.type));
            if (!videos.length) return;
            const shuffled = [...videos].sort(() => Math.random() - 0.5);
            const urls = shuffled.map(v =>
              `http://localhost:3001/api/ytdlp/stream?url=${encodeURIComponent('https://www.youtube.com/watch?v=' + v.key)}&showName=${encodeURIComponent(show.showName)}&t=${Date.now()}`
            );
            setTrailerUrls(urls);
          }).catch(() => {});
      };

      if (show.tmdbId) {
        getTrailers(show.tmdbId);
      } else {
        fetch(`http://localhost:3001/api/tmdb/search?q=${encodeURIComponent(show.showName)}&type=tv`)
          .then(r => r.json())
          .then(d => { if (cancelled) return; const id = d.results?.[0]?.id; if (id) getTrailers(id); })
          .catch(() => {});
      }
    };

    load();
    return () => { cancelled = true; };
  }, [show.showName]);

  const [blackout, setBlackout] = React.useState(false);

  React.useEffect(() => {
    if (!trailerUrls[0]) return;
    const t = setTimeout(() => setVideoActive(true), 5000);
    return () => clearTimeout(t);
  }, [trailerUrls[0]]);

  const handleTrailerEnd = () => {
    setVideoFaded(false);
    setTimeout(() => {
      setTrailerIdx(i => (i + 1) % trailerUrls.length);
      setTimeout(() => setVideoFaded(true), 800);
    }, 500);
  };

  const currentTrailerUrl = trailerUrls[trailerIdx] || null;

  React.useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (playerOpen) { v.pause(); v.muted = true; }
    else { v.muted = false; if (videoActive) v.play().catch(() => {}); }
  }, [playerOpen, videoActive]);

  // Set src imperatively when both URL and active state are ready, then play
  React.useEffect(() => {
    if (!currentTrailerUrl || !videoActive) return;
    if (videoRef.current) {
      videoRef.current.src = currentTrailerUrl;
      videoRef.current.play().catch(() => {});
    }
    if (blurVideoRef.current) {
      blurVideoRef.current.src = currentTrailerUrl;
      blurVideoRef.current.play().catch(() => {});
    }
  }, [currentTrailerUrl, videoActive]);

  const posterUrl = resolveImg(showData.thumbnail);
  const backdropUrl = resolveImg(showData.backdrop);
  const [clearLogoOk, setClearLogoOk] = React.useState(true);
  const clearLogoUrl = `http://localhost:3001/api/clearlogo-show/${encodeURIComponent(showData.showName)}`;
  const metaBadges = [show.contentRating, 'HD'].filter(Boolean);

  const handleRefresh = async () => {
    setRefreshing(true); setShowEdit(false);
    try {
      await fetch(`${API}/library/tvShows/refreshShow`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ showName: show.showName }) });
      await fetchLibrary();
    } finally { setRefreshing(false); }
  };

  const [scanning, setScanning] = useState(false);
  const handleScanFolder = async () => {
    setScanning(true); setShowEdit(false);
    try {
      await fetch(`${API}/library/tvShows/scanFolder`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ showName: show.showName }) });
      await fetchLibrary('tvShows');
    } finally { setScanning(false); }
  };

  const handleSearch = async () => {
    if (!searchQ.trim()) return;
    setSearching(true);
    try {
      const r = await fetch(`${API}/tmdb/search?q=${encodeURIComponent(searchQ)}&type=tv`);
      const d = await r.json();
      const mapped = (d.results || []).map(item => ({
        id: item.id,
        name: item.name || item.title,
        year: (item.first_air_date || item.release_date || '').slice(0, 4),
        poster: item.poster_path ? `https://image.tmdb.org/t/p/w92${item.poster_path}` : null,
        overview: item.overview || '',
      }));
      setSearchResults(mapped);
    } finally { setSearching(false); }
  };

  const handleFixMatch = async (tmdbId) => {
    setShowFixMatch(false); setSearchResults([]);
    await fetch(`${API}/library/tvShows/refreshShow`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ showName: show.showName, tmdbId }) });
    await fetchLibrary();
  };

  const [showFixTrailer, setShowFixTrailer] = useState(false);
  const [trailerUrl, setTrailerUrl] = useState('');
  const [fixingTrailer, setFixingTrailer] = useState(false);

  const handleFixTrailer = async () => {
    if (!trailerUrl.trim()) return;
    setFixingTrailer(true);
    try {
      const ytMatch = trailerUrl.match(/[?&]v=([^&]+)/) || trailerUrl.match(/youtu\.be\/([^?]+)/);
      if (!ytMatch) { alert('Invalid YouTube URL'); setFixingTrailer(false); return; }
      const newVideoId = ytMatch[1];

      // Tell server to clear ALL old trailer files for this show and record the new correct ID
      await fetch(`${API}/tv-trailers/set`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ showName: show.showName, youtubeUrl: trailerUrl })
      });

      // Delete ALL mp4 files from AppData trailer cache that aren't the new one
      // We don't know which old IDs exist so delete everything via the list endpoint
      const cacheData = await fetch(`${API}/ytdlp/cache`).then(r => r.json()).catch(() => ({ files: [] }));
      for (const f of (cacheData.files || [])) {
        const id = f.replace('.mp4', '');
        if (id !== newVideoId) {
          await fetch(`${API}/ytdlp/cache/${id}`, { method: 'DELETE' }).catch(() => {});
        }
      }

      // Force reload trailer in UI with new URL
      const newUrl = `http://localhost:3001/api/ytdlp/stream?url=${encodeURIComponent('https://www.youtube.com/watch?v=' + newVideoId)}&showName=${encodeURIComponent(show.showName)}&t=${Date.now()}`;
      setTrailerUrls([newUrl]);
      setTrailerIdx(0);
      setVideoActive(false);
      setVideoFaded(false);
      setBlackout(false);
      setTimeout(() => setVideoActive(true), 500);

      // Update local state so next remount uses override without server
      setShowData(prev => ({ ...prev, trailerOverride: newVideoId }));
    } finally { setFixingTrailer(false); }
  };

  const handleDeleteShow = async () => {
    if (!window.confirm(`Remove "${show.showName}" from library?`)) return;
    setShowEdit(false);
    await fetch(`${API}/library/tvShows/deleteShow`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ showName: show.showName }) });
    await fetchLibrary();
    onBack();
  };

  return (
    <div style={{ height: '100vh', position: 'relative', overflow: 'hidden' }}>

      {/* HERO */}
      <div style={{ position: 'absolute', inset: 0, zIndex: 0 }}>
        {/* Backdrop — blurred fill behind + clean centered image on top */}
        {(backdropUrl || posterUrl) && (
          <>
            {/* Blurred fill for sides */}
            <img src={backdropUrl || posterUrl} alt=""
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%',
                objectFit: 'cover', objectPosition: 'center',
                filter: 'blur(24px) brightness(0.5)', transform: 'scale(1.1)',
                opacity: blackout ? 0 : 1, transition: 'opacity 1.5s ease' }} />
            {/* Clean image centered, no stretch */}
            <img src={backdropUrl || posterUrl} alt=""
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%',
                objectFit: 'contain', objectPosition: 'center',
                opacity: blackout ? 0 : 0.85, transition: 'opacity 1.5s ease' }} />
          </>
        )}

        {/* Black overlay — fades in before video, fades out as video appears */}
        <div style={{ position: 'absolute', inset: 0, background: 'black',
          opacity: blackout && !videoFaded ? 1 : 0,
          transition: 'opacity 1.5s ease', pointerEvents: 'none', zIndex: 1 }} />

        {/* Trailer — blur layer fills edges, sharp layer on top at correct aspect ratio */}
        {videoActive && currentTrailerUrl && (
          <>
            {/* Blurred fill — covers letterbox/pillarbox bars */}
            <video
              ref={blurVideoRef}
              autoPlay playsInline muted
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%',
                objectFit: 'cover', filter: 'blur(22px) brightness(0.35)',
                transform: 'scale(1.08)',
                opacity: videoFaded ? 1 : 0, transition: 'opacity 1.5s ease', zIndex: 0 }}
            />
            {/* Sharp foreground — no stretch, correct aspect ratio */}
            <video
              ref={el => { videoRef.current = el; if (activeVideoRef) activeVideoRef.current = el; }}
              autoPlay playsInline
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%',
                objectFit: 'contain',
                opacity: videoFaded ? 1 : 0, transition: 'opacity 1.5s ease', zIndex: 1 }}
              onCanPlay={() => setVideoFaded(true)}
              onEnded={handleTrailerEnd}
              onError={handleTrailerEnd}
            />
          </>
        )}

        {/* Gradient */}
        <div style={{ position: 'absolute', inset: 0,
          background: 'linear-gradient(to bottom, rgba(0,0,0,0.15) 0%, transparent 30%, rgba(0,0,0,0.5) 80%, rgba(0,0,0,0.9) 100%)' }} />

        {/* Back */}
        <button onClick={onBack}
          style={{ position: 'absolute', top: 24, left: 24, zIndex: 10,
            background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.2)',
            color: 'white', padding: '7px 14px', borderRadius: 20, cursor: 'pointer',
            fontSize: 13, display: 'flex', alignItems: 'center', gap: 6, backdropFilter: 'blur(8px)' }}>
          <ChevronLeft size={15} /> All Shows
        </button>

        {/* Two-column content */}
        <div style={{ position: 'absolute', top: 72, left: 0, right: 0,
          padding: '16px 48px 60px 24px', display: 'flex', gap: 32,
          alignItems: 'flex-start', overflowY: 'auto',
          maxHeight: 'calc(100vh - 116px)', zIndex: 5 }}>

          {/* Poster */}
          {posterUrl && (
            <div style={{ flexShrink: 0, width: 200, position: 'sticky', top: 0 }}>
              <img src={posterUrl} alt={showData.showName}
                style={{ width: '100%', borderRadius: 12, boxShadow: '0 8px 32px rgba(0,0,0,0.8)',
                  display: 'block', border: '1px solid rgba(255,255,255,0.1)' }} />
            </div>
          )}

          {/* Info */}
          <div style={{ flex: 1, minWidth: 0, paddingBottom: 60 }}>

            <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
              {metaBadges.map(b => (
                <span key={b} style={{ padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 700,
                  background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.3)',
                  color: 'rgba(255,255,255,0.9)', letterSpacing: 0.5 }}>{b}</span>
              ))}
            </div>

            {clearLogoOk ? (
              <img src={clearLogoUrl} alt={showData.showName} onError={() => setClearLogoOk(false)}
                style={{ maxWidth: 320, maxHeight: 100, objectFit: 'contain', display: 'block',
                  marginBottom: 10, filter: 'drop-shadow(0 2px 8px rgba(0,0,0,0.9))' }} />
            ) : (
              <h1 style={{ fontSize: 40, fontWeight: 900, lineHeight: 1.0, margin: '0 0 8px',
                color: 'white', textShadow: '0 2px 20px rgba(0,0,0,0.9)',
                fontFamily: 'var(--font-display)', letterSpacing: -0.5 }}>
                {showData.showName}
              </h1>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12, flexWrap: 'wrap',
              fontSize: 12, color: 'rgba(255,255,255,0.7)' }}>
              {showData.year && <span>{showData.year}</span>}
              {seasons.length > 0 && <><span style={{ opacity: 0.4 }}>•</span><span>{seasons.length} Season{seasons.length !== 1 ? 's' : ''}</span></>}
              {(showData.genres || []).length > 0 && <><span style={{ opacity: 0.4 }}>•</span><span>{showData.genres.slice(0, 3).join(', ')}</span></>}
              {showData.tvStatus && <><span style={{ opacity: 0.4 }}>•</span><span style={{ color: showData.tvStatus === 'Ended' ? '#f87171' : '#34d399' }}>{showData.tvStatus}</span></>}
            </div>

            {showData.tagline && (
              <p style={{ fontSize: 14, color: 'rgba(255,255,255,0.5)', fontStyle: 'italic', margin: '0 0 10px' }}>
                {showData.tagline}
              </p>
            )}

            {showData.overview && (
              <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.85)', lineHeight: 1.7,
                maxWidth: 560, margin: '0 0 16px', textShadow: '0 1px 6px rgba(0,0,0,0.9)' }}>
                {showData.overview}
              </p>
            )}

            {(showData.network || tvData?.network?.name) && (
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,0.4)',
                  letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 2 }}>Network</div>
                <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.9)', fontWeight: 600 }}>
                  {showData.network || tvData?.network?.name}
                </div>
              </div>
            )}

            {showData.rating && parseFloat(showData.rating) > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
                <div style={{ width: 52, height: 52, borderRadius: '50%', position: 'relative',
                  background: `conic-gradient(#21d07a ${Math.round(parseFloat(showData.rating) * 10)}%, rgba(255,255,255,0.15) 0)`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <div style={{ width: 40, height: 40, borderRadius: '50%', background: 'rgba(0,0,0,0.85)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 11, fontWeight: 900, color: 'white' }}>
                    {Math.round(parseFloat(showData.rating) * 10)}%
                  </div>
                </div>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,0.7)', lineHeight: 1.3 }}>
                  User<br />Score
                </div>
              </div>
            )}

            {cast.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,0.4)',
                  letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 10 }}>Cast</div>
                <div style={{ display: 'flex', gap: 12, maxWidth: '45vw', overflowX: 'auto', paddingBottom: 6 }}>
                  {cast.slice(0, 8).map((c, i) => (
                    <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center',
                      gap: 4, flexShrink: 0, width: 52 }}>
                      {c.image
                        ? <img src={c.image} alt={c.name} style={{ width: 46, height: 46, borderRadius: '50%',
                            objectFit: 'cover', border: '2px solid rgba(255,255,255,0.2)' }} />
                        : <div style={{ width: 46, height: 46, borderRadius: '50%',
                            background: 'rgba(255,255,255,0.1)', border: '2px solid rgba(255,255,255,0.2)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18 }}>👤</div>
                      }
                      <div style={{ textAlign: 'center' }}>
                        <div style={{ fontSize: 9, fontWeight: 700, color: 'rgba(255,255,255,0.9)', lineHeight: 1.2, wordBreak: 'break-word' }}>{c.name}</div>
                        {c.character && <div style={{ fontSize: 8, color: 'rgba(255,255,255,0.4)', marginTop: 1, lineHeight: 1.2, fontStyle: 'italic' }}>{c.character}</div>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Action buttons */}
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <button onClick={async () => {
                  const firstSeason = [...seasons].sort((a, b) => a.num - b.num)[0];
                  if (!firstSeason) return;
                  const sNum = firstSeason.num;
                  if (seasonEpisodes[sNum]?.length) {
                    const ep = [...seasonEpisodes[sNum]].sort((a, b) => (a.episode || 0) - (b.episode || 0))[0];
                    if (ep) onSelect(ep);
                  } else {
                    const d = await fetch(`http://localhost:3001/api/library/tvShows/byShow/${encodeURIComponent(show.showName)}?season=${sNum}`).then(r => r.json());
                    const eps = (d.items || []).sort((a, b) => (a.episode || 0) - (b.episode || 0));
                    if (eps[0]) onSelect(eps[0]);
                  }
                }}
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '11px 28px',
                  background: 'white', border: 'none', borderRadius: 6, cursor: 'pointer',
                  fontSize: 15, fontWeight: 700, color: '#000' }}>
                <Play size={18} fill="black" /> PLAY
              </button>

              <div style={{ position: 'relative' }}>
                <button onClick={e => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); setEditMenuPos({ top: r.bottom + 4, left: r.left }); setShowEdit(v => !v); }}
                  style={{ width: 42, height: 42, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: showEdit ? 'rgba(99,102,241,0.5)' : 'rgba(255,255,255,0.15)',
                    border: `1px solid ${showEdit ? 'rgba(99,102,241,0.8)' : 'rgba(255,255,255,0.3)'}`,
                    color: 'white', cursor: 'pointer', backdropFilter: 'blur(8px)', fontSize: 15 }}>✏️</button>
                {showEdit && (
                  <div style={{ position: 'fixed', top: editMenuPos.top, left: editMenuPos.left, background: '#1a1a2e',
                    border: '1px solid rgba(255,255,255,0.12)', borderRadius: 10, padding: 6,
                    zIndex: 20, minWidth: 175, boxShadow: '0 8px 32px rgba(0,0,0,0.8)' }}>
                    <button onClick={handleRefresh} disabled={refreshing}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '9px 12px',
                        background: 'none', border: 'none', color: refreshing ? '#10b981' : 'rgba(255,255,255,0.85)',
                        cursor: 'pointer', fontSize: 13, borderRadius: 6 }}
                      onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.08)'}
                      onMouseLeave={e => e.currentTarget.style.background = 'none'}>
                      ⟳ {refreshing ? 'Refreshing…' : 'Refresh Metadata'}
                    </button>
                    <button onClick={handleScanFolder} disabled={scanning}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '9px 12px',
                        background: 'none', border: 'none', color: scanning ? '#10b981' : 'rgba(255,255,255,0.85)',
                        cursor: 'pointer', fontSize: 13, borderRadius: 6 }}
                      onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.08)'}
                      onMouseLeave={e => e.currentTarget.style.background = 'none'}>
                      📂 {scanning ? 'Scanning…' : 'Scan Folder'}
                    </button>
                    <button onClick={() => { setShowEdit(false); setShowFixMatch(true); setSearchQ(showData.showName || ''); setSearchResults([]); }}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '9px 12px',
                        background: 'none', border: 'none', color: 'rgba(255,255,255,0.85)',
                        cursor: 'pointer', fontSize: 13, borderRadius: 6 }}
                      onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.08)'}
                      onMouseLeave={e => e.currentTarget.style.background = 'none'}>
                      🔍 Fix Match
                    </button>
                    <button onClick={() => { setShowEdit(false); setShowFixTrailer(true); setTrailerUrl(''); }}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '9px 12px',
                        background: 'none', border: 'none', color: 'rgba(255,255,255,0.85)',
                        cursor: 'pointer', fontSize: 13, borderRadius: 6 }}
                      onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.08)'}
                      onMouseLeave={e => e.currentTarget.style.background = 'none'}>
                      🎬 Fix Trailer
                    </button>
                    <div style={{ height: 1, background: 'rgba(255,255,255,0.08)', margin: '4px 8px' }} />
                    <button onClick={handleDeleteShow}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '9px 12px',
                        background: 'none', border: 'none', color: '#f87171',
                        cursor: 'pointer', fontSize: 13, borderRadius: 6 }}
                      onMouseEnter={e => e.currentTarget.style.background = 'rgba(248,113,113,0.1)'}
                      onMouseLeave={e => e.currentTarget.style.background = 'none'}>
                      🗑️ Remove from Library
                    </button>
                  </div>
                )}
              </div>
            </div>

            {showFixMatch && (
              <div style={{ marginTop: 16, background: 'rgba(0,0,0,0.4)', borderRadius: 10,
                border: '1px solid rgba(99,102,241,0.3)', padding: 18 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,0.45)', letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 12 }}>
                  Fix Match — Search TMDB
                </div>
                <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                  <input value={searchQ} onChange={e => setSearchQ(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleSearch()}
                    placeholder="Search TMDB..."
                    style={{ flex: 1, padding: '8px 12px', background: 'rgba(255,255,255,0.07)',
                      border: '1px solid rgba(255,255,255,0.15)', borderRadius: 6, color: 'white', fontSize: 13, outline: 'none' }} />
                  <button onClick={handleSearch} disabled={searching}
                    style={{ padding: '8px 16px', background: 'var(--accent)', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                    {searching ? '…' : 'Search'}
                  </button>
                  <button onClick={() => setShowFixMatch(false)}
                    style={{ padding: '8px 12px', background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.5)',
                      border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, cursor: 'pointer', fontSize: 13 }}>
                    Cancel
                  </button>
                </div>
                {searchResults.map(r => (
                  <div key={r.id} onClick={() => handleFixMatch(r.id)}
                    style={{ display: 'flex', gap: 12, padding: '8px 10px', borderRadius: 8, cursor: 'pointer',
                      marginBottom: 6, background: 'rgba(255,255,255,0.05)', alignItems: 'flex-start' }}
                    onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.1)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'rgba(255,255,255,0.05)'}>
                    {r.poster
                      ? <img src={r.poster} alt="" style={{ width: 46, height: 69, objectFit: 'cover', borderRadius: 4, flexShrink: 0 }} />
                      : <div style={{ width: 46, height: 69, background: 'rgba(255,255,255,0.08)', borderRadius: 4, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18 }}>📺</div>
                    }
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: 13, color: 'white' }}>{r.name || r.title}</div>
                      <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginBottom: 4 }}>{r.year} · TMDB #{r.id}</div>
                      {r.overview && <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{r.overview}</div>}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {showFixTrailer && (
              <div style={{ marginTop: 16, background: 'rgba(0,0,0,0.4)', borderRadius: 10,
                border: '1px solid rgba(245,158,11,0.3)', padding: 18 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,0.45)', letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 12 }}>
                  Fix Trailer — Paste YouTube URL
                </div>
                <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                  <input value={trailerUrl} onChange={e => setTrailerUrl(e.target.value)}
                    placeholder="https://www.youtube.com/watch?v=..."
                    style={{ flex: 1, padding: '8px 12px', background: 'rgba(255,255,255,0.07)',
                      border: '1px solid rgba(255,255,255,0.15)', borderRadius: 6, color: 'white', fontSize: 13, outline: 'none' }} />
                  <button onClick={handleFixTrailer} disabled={fixingTrailer}
                    style={{ padding: '8px 16px', background: '#f59e0b', color: 'black', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 700 }}>
                    {fixingTrailer ? '…' : 'Set'}
                  </button>
                  <button onClick={() => setShowFixTrailer(false)}
                    style={{ padding: '8px 12px', background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.5)',
                      border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, cursor: 'pointer', fontSize: 13 }}>
                    Cancel
                  </button>
                </div>
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)' }}>
                  This will clear the wrong cached trailer and play your chosen YouTube video instead.
                </div>
              </div>
            )}

          </div>{/* end right column */}
        </div>{/* end two-column */}
      </div>{/* end hero */}

      {/* Arrows */}
      {prevShow && (
        <button onClick={() => { const v = activeVideoRef?.current; if (v) { v.pause(); v.src = ''; } onPrev(); }}
          style={{ position: 'absolute', top: '40%', left: 8, transform: 'translateY(-50%)', zIndex: 20,
            width: 44, height: 44, borderRadius: '50%', background: 'rgba(0,0,0,0.7)',
            border: '1px solid rgba(255,255,255,0.15)', color: 'white', cursor: 'pointer',
            fontSize: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(8px)' }}
          onMouseEnter={e => e.currentTarget.style.background = 'rgba(99,102,241,0.8)'}
          onMouseLeave={e => e.currentTarget.style.background = 'rgba(0,0,0,0.7)'}>‹</button>
      )}
      {nextShow && (
        <button onClick={() => { const v = activeVideoRef?.current; if (v) { v.pause(); v.src = ''; } onNext(); }}
          style={{ position: 'absolute', top: '40%', right: 8, transform: 'translateY(-50%)', zIndex: 20,
            width: 44, height: 44, borderRadius: '50%', background: 'rgba(0,0,0,0.7)',
            border: '1px solid rgba(255,255,255,0.15)', color: 'white', cursor: 'pointer',
            fontSize: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(8px)' }}
          onMouseEnter={e => e.currentTarget.style.background = 'rgba(99,102,241,0.8)'}
          onMouseLeave={e => e.currentTarget.style.background = 'rgba(0,0,0,0.7)'}>›</button>
      )}

      {/* Bottom tab bar */}
      <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 10,
        background: activeTab ? 'rgba(10,10,20,0.92)' : 'transparent',
        backdropFilter: activeTab ? 'blur(12px)' : 'none',
        borderTop: activeTab ? '1px solid rgba(255,255,255,0.08)' : '1px solid transparent' }}>
        <div style={{ display: 'flex', justifyContent: 'space-around' }}>
          {[{ id: 'episodes', label: 'SEASONS' }, { id: 'suggested', label: 'SUGGESTED' }].map(t => (
            <button key={t.id} onClick={() => setActiveTab(activeTab === t.id ? null : t.id)}
              style={{ flex: 1, padding: '14px 0', background: 'none', border: 'none',
                cursor: 'pointer', fontSize: 11, fontWeight: 700, letterSpacing: 1.2,
                color: activeTab === t.id ? 'white' : 'rgba(255,255,255,0.25)',
                borderTop: activeTab === t.id ? '2px solid white' : '2px solid transparent',
                transition: 'color 0.15s, border-color 0.15s', textTransform: 'uppercase' }}>
              {t.label}
            </button>
          ))}
        </div>
        {activeTab && (
          <div style={{ maxHeight: '55vh', overflowY: 'auto', padding: '20px 48px 24px' }}
            onClick={() => setShowEdit(false)}>
            {activeTab === 'episodes' && (
              <div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px,1fr))', gap: 16 }}>
                  {seasons.map(s => (
                    <div key={s.num}
                      onClick={() => { setActiveSeason(activeSeason === s.num ? null : s.num); loadSeasonEpisodes(s.num); }}
                      style={{ cursor: 'pointer', borderRadius: 10, overflow: 'hidden',
                        border: activeSeason === s.num ? '2px solid var(--accent)' : '2px solid transparent',
                        background: 'rgba(255,255,255,0.05)' }}>
                      {s.thumbnail && <img src={resolveImg(s.thumbnail)} alt="" style={{ width: '100%', aspectRatio: '16/9', objectFit: 'cover' }} />}
                      <div style={{ padding: '8px 10px' }}>
                        <div style={{ fontWeight: 700, fontSize: 13, color: 'white' }}>Season {s.num}</div>
                        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>{s.episodeCount} ep</div>
                      </div>
                    </div>
                  ))}
                </div>
                {activeSeason !== null && (
                  <div style={{ marginTop: 20 }}>
                    {(seasonEpisodes[activeSeason] || []).sort((a, b) => (a.episode || 0) - (b.episode || 0)).map(ep => (
                      <div key={ep.id} onClick={() => onSelect(ep)}
                        style={{ display: 'flex', gap: 12, padding: '10px 0',
                          borderBottom: '1px solid rgba(255,255,255,0.06)',
                          cursor: 'pointer', alignItems: 'center' }}
                        onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.05)'}
                        onMouseLeave={e => e.currentTarget.style.background = ''}>
                        {ep.thumbnail && <img src={resolveImg(ep.thumbnail)} alt="" style={{ width: 120, height: 68, objectFit: 'cover', borderRadius: 6, flexShrink: 0 }} />}
                        <div>
                          <div style={{ fontWeight: 600, fontSize: 13, color: 'white' }}>
                            {ep.episode ? `E${ep.episode} · ` : ''}{ep.title || ep.fileName}
                          </div>
                          {ep.overview && <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginTop: 4, lineHeight: 1.4 }}>{ep.overview}</div>}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Shows Grid ────────────────────────────────────────────────────────────────
function ShowCard({ show, onClick }) {
  const { playMedia } = useApp();
  const [nextEp, setNextEp] = React.useState(null);
  const cardRef = React.useRef(null);

  // Only fetch next episode when card scrolls into view
  React.useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        observer.disconnect();
        fetch(`http://localhost:3001/api/tv/next/${encodeURIComponent(show.showName)}`)
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
    const playEp = (ep) => {
      if (ep?.filePath) playMedia({ ...ep, type: 'tvShows' });
    };

    if (nextEp?.filePath) {
      playEp(nextEp);
      return;
    }

    // nextEp not loaded yet — fetch directly and play
    fetch(`http://localhost:3001/api/tv/next/${encodeURIComponent(show.showName)}`)
      .then(r => r.json())
      .then(d => {
        if (d.episode?.filePath) {
          playEp(d.episode);
        } else {
          // Last resort — get any episode from byShow
          return fetch(`http://localhost:3001/api/library/tvShows/byShow/${encodeURIComponent(show.showName)}`)
            .then(r => r.json())
            .then(d2 => playEp(d2.items?.[0]));
        }
      })
      .catch(console.error);
  };

  const epLabel = nextEp
    ? `S${nextEp.seasonNum || 1}E${(nextEp.fileName||'').match(/[Ee](\d+)/)?.[1] || '1'}`
    : null;

  const item = {
    ...show, type: 'tvShows', title: show.showName,
    thumbnail: show.thumbnail, rating: show.rating, year: show.year,
    watchProviders: show.watchProviders, networks: show.networks,
    network: show.network, tvStatus: show.tvStatus,
    contentRating: show.contentRating, genres: show.genres,
  };

  return (
    <div ref={cardRef} data-alpha={show.showName}>
      <MediaCard item={item} onClick={() => onClick(show)} onPlay={handlePlay} />
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

// ── Alpha Grouped Grid ────────────────────────────────────────────────────────
function AlphaGroupedGrid({ items, getKey, renderItem }) {
  const firstOfLetter = React.useMemo(() => {
    const map = {};
    items.forEach((item, i) => {
      const k = (getKey(item) || '').toUpperCase().replace(/^(THE |A |AN )/, '');
      const letter = k[0] && /[A-Z]/.test(k[0]) ? k[0] : '#';
      if (!(letter in map)) map[letter] = i;
    });
    return map;
  }, [items, getKey]);

  return (
    <div style={{ paddingRight: 36 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
        gap: '32px 20px', padding: '8px 4px' }}>
        {items.map((item, i) => {
          const k = (getKey(item) || '').toUpperCase().replace(/^(THE |A |AN )/, '');
          const letter = k[0] && /[A-Z]/.test(k[0]) ? k[0] : '#';
          const isFirst = firstOfLetter[letter] === i;
          return (
            <div key={i} id={isFirst ? `alpha-${letter}` : undefined}>
              {renderItem(item)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Alphabet Quick-Nav ────────────────────────────────────────────────────────
function AlphaNav({ items, getKey }) {
  const chars = ['#', ...Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ')];

  const available = new Set(items.map(i => {
    const k = (getKey(i) || '').toUpperCase().replace(/^(THE |A |AN )/, '');
    return k[0] && /[A-Z]/.test(k[0]) ? k[0] : '#';
  }));

  const scrollTo = (char) => {
    const el = document.getElementById(`alpha-${char}`);
    const scroller = document.querySelector('.main-content');
    if (!el || !scroller) return;
    const rect = el.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    scroller.scrollTo({ top: scroller.scrollTop + rect.top - scrollerRect.top - 20, behavior: 'smooth' });
  };

  return ReactDOM.createPortal(
    <div style={{ position:'fixed', right:0, top:170, bottom:0, width:30,
      display:'flex', flexDirection:'column', justifyContent:'space-evenly',
      background:'rgba(0,0,0,0.7)', backdropFilter:'blur(8px)',
      zIndex:9999, userSelect:'none' }}>
      {chars.map(c => (
        <div key={c} onClick={() => available.has(c) && scrollTo(c)}
          style={{ textAlign:'center', fontSize:11, fontWeight:800, lineHeight:1,
            color: available.has(c) ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.15)',
            cursor: available.has(c) ? 'pointer' : 'default', padding:'1px 0' }}
          onMouseEnter={e => { if (available.has(c)) { e.currentTarget.style.color='#f59e0b'; e.currentTarget.style.fontSize='14px'; }}}
          onMouseLeave={e => { e.currentTarget.style.color=available.has(c)?'rgba(255,255,255,0.9)':'rgba(255,255,255,0.15)'; e.currentTarget.style.fontSize='11px'; }}>
          {c}
        </div>
      ))}
    </div>,
    document.body
  );
}

export function TVShowsPage({ onSelect, initialShow = null, onInitialShowConsumed }) {
  const { library, scanFolders, loading, API, fetchLibrary, scanStatus } = useApp();
  const [selectedShow, setSelectedShow] = useState(null);

  // When navigated here from search, open the show immediately
  useEffect(() => {
    if (initialShow) {
      setSelectedShow(initialShow);
      onInitialShowConsumed?.();
    }
  }, [initialShow]);
  const [tab, setTab]     = useState('library');
  const [genre, setGenre] = useState(null);
  const [genres, setGenres] = useState([]);
  const [selectedCollection, setSelectedCollection] = useState(null);
  const [streamingService, setStreamingService] = useState(null);
  const [selectedNetworkGroup, setSelectedNetworkGroup] = useState(null);
  const [networkShows, setNetworkShows] = useState([]);
  const [networkLoading, setNetworkLoading] = useState(false);

  const openNetwork = async (group) => {
    setStreamingService(group.label);
    setSelectedNetworkGroup(group);
    if (group.fromDB && (group.colIds?.length || group.colId)) {
      setNetworkLoading(true);
      setNetworkShows([]);
      try {
        const ids = group.colIds?.length ? group.colIds : [group.colId];
        const allItems = [];
        for (const colId of ids) {
          const d = await fetch(`${API}/collections/${colId}`).then(r => r.json());
          allItems.push(...(d.items || []));
        }
        // Items are representative episodes — resolve to show objects and deduplicate
        const seen = new Set();
        const deduped = allItems.filter(ep => {
          const key = ep.seriesTitle || ep.showName || ep.title;
          if (seen.has(key)) return false;
          seen.add(key); return true;
        }).map(ep => ({
          ...ep,
          // Ensure it renders as a show card
          showName: ep.seriesTitle || ep.showName || ep.title,
          title: ep.seriesTitle || ep.showName || ep.title,
        }));
        setNetworkShows(deduped);
      } catch { setNetworkShows([]); }
      setNetworkLoading(false);
    } else {
      setNetworkShows(group.shows || []);
    }
  };

  // Each entry: names = keywords to match anywhere in the network/provider string
  // partial:true means match as substring (e.g. "Disney" catches "Disney Channel", "Disney XD", "Disney Jr")
  const STREAMING_SVCS = [
    { names:['netflix'],                               label:'Netflix',        bg:'#141414', color:'#fff', logo:'https://upload.wikimedia.org/wikipedia/commons/0/08/Netflix_2015_logo.svg' },
    { names:['disney'],                                label:'Disney+',        bg:'#0d2f7e', color:'#fff', logo:'https://upload.wikimedia.org/wikipedia/commons/3/3e/Disney%2B_logo.svg' },
    { names:['max','hbo'],                             label:'Max',            bg:'#002BE7', color:'#fff', logo:'https://upload.wikimedia.org/wikipedia/commons/a/a3/Max_logo_2023.svg' },
    { names:['hulu'],                                  label:'Hulu',           bg:'#1CE783', color:'#000', logo:'https://upload.wikimedia.org/wikipedia/commons/e/e4/Hulu_Logo.svg' },
    { names:['prime video','amazon prime','amazon'],   label:'Prime Video',    bg:'#00A8E1', color:'#fff', logo:'https://upload.wikimedia.org/wikipedia/commons/1/11/Amazon_Prime_Video_logo.svg' },
    { names:['apple tv'],                              label:'Apple TV+',      bg:'#1c1c1e', color:'#fff', logo:'https://upload.wikimedia.org/wikipedia/commons/2/28/Apple_TV_Plus_Logo.svg' },
    { names:['peacock'],                               label:'Peacock',        bg:'#000',    color:'#fff', logo:'https://upload.wikimedia.org/wikipedia/commons/d/d3/NBCUniversal_Peacock_Logo.svg' },
    { names:['paramount'],                             label:'Paramount+',     bg:'#0064FF', color:'#fff', logo:'https://upload.wikimedia.org/wikipedia/commons/a/a5/Paramount_Plus.svg' },
    { names:['tubi'],                                  label:'Tubi',           bg:'#FA5714', color:'#fff', logo:'https://upload.wikimedia.org/wikipedia/commons/7/7e/Tubi_TV_logo.svg' },
    { names:['crunchyroll'],                           label:'Crunchyroll',    bg:'#F47521', color:'#fff', logo:'https://upload.wikimedia.org/wikipedia/commons/0/08/Crunchyroll_logo_2023.svg' },
    { names:['shudder'],                               label:'Shudder',        bg:'#0F0F0F', color:'#00FF94',logo:'https://upload.wikimedia.org/wikipedia/commons/a/a9/Shudder_logo.svg' },
    { names:['mubi'],                                  label:'MUBI',           bg:'#1F2936', color:'#fff', logo:'https://upload.wikimedia.org/wikipedia/commons/1/12/Mubi_logo_2020.svg' },
    { names:['starz'],                                 label:'Starz',          bg:'#000',    color:'#fff', logo:'https://upload.wikimedia.org/wikipedia/commons/6/6d/Starz_logo.svg' },
    { names:['showtime'],                              label:'Showtime',       bg:'#CC0000', color:'#fff', logo:'https://upload.wikimedia.org/wikipedia/commons/2/22/Showtime.svg' },
    { names:['amc'],                                   label:'AMC',            bg:'#000',    color:'#fff', logo:'https://upload.wikimedia.org/wikipedia/commons/a/a9/AMC_logo_%282016%29.svg' },
    { names:['plex'],                                  label:'Plex',           bg:'#E5A00D', color:'#000', logo:'https://upload.wikimedia.org/wikipedia/commons/7/7b/Plex_logo_2022.svg' },
    { names:['pluto'],                                 label:'Pluto TV',       bg:'#000099', color:'#fff', logo:'https://upload.wikimedia.org/wikipedia/commons/5/5e/Pluto_TV_logo.svg' },
    { names:['roku'],                                  label:'Roku',           bg:'#6C1D45', color:'#fff', logo:'https://upload.wikimedia.org/wikipedia/commons/4/4c/Roku_logo.svg' },
    { names:['fubo'],                                  label:'fuboTV',         bg:'#FA4616', color:'#fff', logo:null },
    { names:['espn'],                                  label:'ESPN+',          bg:'#CC0000', color:'#fff', logo:'https://upload.wikimedia.org/wikipedia/commons/2/2f/ESPN_wordmark.svg' },
    { names:[' abc','abc ','abc,','(abc)'],             label:'ABC',            bg:'#000',    color:'#fff', logo:'https://upload.wikimedia.org/wikipedia/commons/a/a4/ABC_Family_2009.svg' },
    { names:['nbc'],                                   label:'NBC',            bg:'#fff',    color:'#000', logo:'https://upload.wikimedia.org/wikipedia/commons/3/3f/NBC_logo.svg' },
    { names:['cbs'],                                   label:'CBS',            bg:'#fff',    color:'#000', logo:'https://upload.wikimedia.org/wikipedia/commons/4/4e/CBS_logo.svg' },
    { names:['fox'],                                   label:'Fox',            bg:'#000',    color:'#fff', logo:'https://upload.wikimedia.org/wikipedia/commons/4/4c/Fox_Corporation_logo.svg' },
    { names:['the cw','cw network'],                   label:'The CW',         bg:'#228B22', color:'#fff', logo:null },
    { names:[' fx','fx ','fx,','fxx'],                 label:'FX',             bg:'#000',    color:'#fff', logo:null },
    { names:['usa network'],                           label:'USA Network',    bg:'#001489', color:'#fff', logo:null },
    { names:['syfy'],                                  label:'Syfy',           bg:'#1b1b3a', color:'#fff', logo:'https://upload.wikimedia.org/wikipedia/commons/9/96/Syfy_logo_2017.svg' },
    { names:['adult swim'],                            label:'Adult Swim',     bg:'#000',    color:'#fff', logo:null },
    { names:['comedy central'],                        label:'Comedy Central', bg:'#fff',    color:'#000', logo:'https://upload.wikimedia.org/wikipedia/commons/7/79/Comedy_Central_logo.svg' },
    { names:['cartoon network'],                       label:'Cartoon Network',bg:'#fff',    color:'#000', logo:'https://upload.wikimedia.org/wikipedia/commons/8/80/Cartoon_Network_2010_logo.svg' },
    { names:['nickelodeon','nick jr','nick at nite'],  label:'Nickelodeon',    bg:'#FF6D00', color:'#fff', logo:'https://upload.wikimedia.org/wikipedia/commons/0/0b/Nickelodeon_2009_logo.svg' },
    { names:['lifetime'],                              label:'Lifetime',       bg:'#8B0000', color:'#fff', logo:null },
    { names:['hallmark'],                              label:'Hallmark',       bg:'#4a1c5c', color:'#fff', logo:null },
    { names:['discovery'],                             label:'Discovery',      bg:'#005A9C', color:'#fff', logo:'https://upload.wikimedia.org/wikipedia/commons/2/21/Discovery_Channel_logo_2019.svg' },
    { names:['history'],                               label:'History',        bg:'#333',    color:'#fff', logo:null },
    { names:['national geographic','nat geo'],         label:'Nat Geo',        bg:'#FFCC00', color:'#000', logo:'https://upload.wikimedia.org/wikipedia/commons/f/fc/Natgeologo.svg' },
    { names:['food network'],                          label:'Food Network',   bg:'#FF6600', color:'#fff', logo:null },
    { names:['hgtv'],                                  label:'HGTV',           bg:'#006400', color:'#fff', logo:null },
    { names:['tlc'],                                   label:'TLC',            bg:'#1E90FF', color:'#fff', logo:null },
    { names:['bravo'],                                 label:'Bravo',          bg:'#8B008B', color:'#fff', logo:null },
    { names:['vh1'],                                   label:'VH1',            bg:'#FF69B4', color:'#fff', logo:null },
    { names:['mtv'],                                   label:'MTV',            bg:'#000',    color:'#fff', logo:'https://upload.wikimedia.org/wikipedia/commons/d/de/MTV_2021.svg' },
    { names:['tnt'],                                   label:'TNT',            bg:'#003F7F', color:'#fff', logo:null },
    { names:['tbs'],                                   label:'TBS',            bg:'#003F7F', color:'#fff', logo:null },
    { names:['truetv','trutv'],                        label:'truTV',          bg:'#FF4500', color:'#fff', logo:null },
    { names:['bbc'],                                   label:'BBC',            bg:'#BB1919', color:'#fff', logo:'https://upload.wikimedia.org/wikipedia/commons/4/41/BBC_Logo_2021.svg' },
    { names:['itv'],                                   label:'ITV',            bg:'#005F8F', color:'#fff', logo:null },
    { names:['channel 4'],                             label:'Channel 4',      bg:'#2E1A47', color:'#fff', logo:null },
    { names:['sky'],                                   label:'Sky',            bg:'#0072CE', color:'#fff', logo:null },
    { names:['funimation'],                            label:'Funimation',     bg:'#400080', color:'#fff', logo:null },
  ];



  const getServiceForShow = (item) => {
    // Collect all network/provider strings for this item
    const all = [
      ...(item?.watchProviders || []),
      ...(item?.networks || []),
      item?.network,
      item?.studio,
    ].filter(Boolean).map(s => s.toLowerCase());

    for (const svc of STREAMING_SVCS) {
      for (const keyword of svc.names) {
        const kw = keyword.toLowerCase().trim();
        if (all.some(s => s.includes(kw))) return svc.label;
      }
    }
    return null;
  };

  const streamingGroups = useMemo(() => {
    const groups = {};
    (library.tvShows||[]).forEach(show => {
      const svc = getServiceForShow(show);
      if (!svc) return;
      if (!groups[svc]) groups[svc] = { label: svc, shows: [], svc: STREAMING_SVCS.find(s=>s.label===svc) };
      if (!groups[svc].shows.find(s => s.showName === show.showName)) groups[svc].shows.push(show);
    });
    return Object.values(groups).sort((a,b) => b.shows.length - a.shows.length);
  }, [library.tvShows]);
  const [tvCollections, setTvCollections] = useState([]);

  useEffect(() => {
    if (!API) return;
    fetch(`${API}/collections?mediaType=tvShows&slim=1`)
      .then(r => r.json())
      .then(d => {
        const cols = d.collections || [];
        const genreFiltered = cols.filter(c => c.type === 'auto-genre' && !c.name.includes('/') && !c.name.includes('|') && c.mediaIds.length >= 3);
        const genreDeduped = Object.values(genreFiltered.reduce((acc, c) => {
          if (!acc[c.name] || c.mediaIds.length > acc[c.name].mediaIds.length) acc[c.name] = c;
          return acc;
        }, {}));
        setGenres(genreDeduped.sort((a,b) => b.mediaIds.length - a.mediaIds.length));
        const TV_COLLECTION_TYPES = ['franchise','manual','network','holiday','birthday','streaming'];
        const allTvCols = cols.filter(c => TV_COLLECTION_TYPES.includes(c.type) && (c.mediaType === 'tvShows' || c.mediaType === 'mixed' || !c.mediaType));
        setTvCollections(allTvCols.length > 0 ? allTvCols : cols.filter(c => c.type === 'auto-genre' && (c.mediaType === 'tvShows' || !c.mediaType)));
      }).catch(() => {});
  }, [API]);
  // Provider normalization — merge variants into canonical names
  const CANONICAL = { 'Plex Channel':'Plex','Amazon Prime Video':'Prime Video','Amazon Prime Video with Ads':'Prime Video','Amazon Prime Video Free with Ads':'Prime Video','Disney Plus':'Disney+','DisneyNOW':'Disney+','Disney Channel':'Disney+','HBO Max':'Max','HBO':'Max','Peacock Premium':'Peacock','Peacock Premium Plus':'Peacock','Tubi TV':'Tubi','Paramount Plus':'Paramount+','Paramount+ with Showtime':'Paramount+','Discovery Plus':'Discovery+','Discovery +':'Discovery+','Discovery+ Amazon Channel':'Discovery+','Netflix basic with Ads':'Netflix','Britbox Apple TV Channel':'BritBox','AMC+':'AMC','Midnight Pulp Amazon Channel':'Prime Video','Dove Amazon Channel':'Prime Video','HBO Max Amazon Channel':'Max','Shout! Factory Amazon Channel':'Shout! Factory TV','Best tv ever Amazon Channel':'Prime Video' };
  const normProv = (n) => {
    if (!n) return n;
    const exact = CANONICAL[n]; if (exact) return exact;
    const lower = n.toLowerCase();
    if (lower.includes(' amazon channel')) return normProv(n.replace(/ amazon channel/i,'').trim());
    if (lower.includes(' apple tv channel')) return normProv(n.replace(/ apple tv channel/i,'').trim());
    if (lower.includes(' roku premium channel')) return normProv(n.replace(/ roku premium channel/i,'').trim());
    if (lower.includes(' roku channel') && n !== 'The Roku Channel') return normProv(n.replace(/ roku channel/i,'').trim());
    return n;
  };

  // Combine streamingGroups (from watchProviders) + network AND streaming DB collections with normalization
  const allNetworkGroups = useMemo(() => {
    const combined = {};
    streamingGroups.forEach(g => {
      const key = normProv(g.label);
      if (!combined[key]) combined[key] = { label: key, shows: [], svc: g.svc, allMediaIds: new Set(), colIds: [], fromDB: false };
      combined[key].shows.push(...g.shows);
    });
    tvCollections.filter(c => c.type === 'network' || c.type === 'streaming').forEach(col => {
      const key = normProv(col.name);
      if (!combined[key]) {
        const svc = STREAMING_SVCS.find(s => s.names.some(n => key.toLowerCase().includes(n.toLowerCase())));
        combined[key] = { label: key, shows: [], svc, allMediaIds: new Set(), colIds: [], fromDB: true };
      }
      if (normProv(col.name) === key) {
        combined[key].colIds.push(col.id);
        (col.mediaIds || []).forEach(id => combined[key].allMediaIds.add(id));
        // Track per-collection showCounts to pick the right one
        combined[key]._showCounts = combined[key]._showCounts || [];
        combined[key]._showCounts.push(col.showCount || 0);
        combined[key].fromDB = true;
      }
    });
    return Object.values(combined).map(g => ({
      ...g,
      colIds: [...new Set(g.colIds)],
      // For TV: use max showCount across merged collections (avoids double-counting)
      count: g.shows.length || (g._showCounts?.length ? Math.max(...g._showCounts) : g.allMediaIds.size),
    })).sort((a, b) => b.count - a.count);
  }, [streamingGroups, tvCollections]);
  const [filter, setFilter] = useState('All');
  const [search, setSearch] = useState('');

  // Server now returns pre-grouped shows directly — no client-side grouping needed
  const allShowsRaw = useMemo(() => library.tvShows || [], [library.tvShows]);
  const shows = allShowsRaw;

  // Auto-open a show navigated from home page
  useEffect(() => {
    const stored = sessionStorage.getItem('orion_selected_show');
    if (stored) {
      sessionStorage.removeItem('orion_selected_show');
      const name = JSON.parse(stored);
      const found = shows.find(s => s.showName === name);
      if (found) setSelectedShow(found);
    }
  }, [shows]);

  const handleAddFolder = async () => {
    const result = await window.electron?.openFolderDialog();
    if (!result?.canceled && result?.filePaths?.length) {
      await scanFolders(result.filePaths, 'tvShows');
    }
  };

  const FILTERS = ['All', 'A-Z', 'By Rating'];
  const filtered = useMemo(() => [...shows]
    .filter(s => !search || s.showName.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => {
      if (filter === 'A-Z')       return a.showName.localeCompare(b.showName);
      if (filter === 'By Rating') return (parseFloat(b.rating) || 0) - (parseFloat(a.rating) || 0);
      return 0;
    }), [shows, search, filter]);

  const [tvVisible, setTvVisible] = React.useState(200);
  const gridRef = React.useRef(null);
  const visibleFiltered = useMemo(() => filtered.slice(0, tvVisible), [filtered, tvVisible]);
  React.useEffect(() => { setTvVisible(200); }, [filtered]);

  const activeVideoRef = React.useRef(null);

  if (selectedShow) {
    const currentIdx = filtered.findIndex(s => s.id === selectedShow.id);
    const prevShow = currentIdx > 0 ? filtered[currentIdx - 1] : null;
    const nextShow = currentIdx < filtered.length - 1 ? filtered[currentIdx + 1] : null;
    return (
      <ShowDetail
        key={selectedShow.showName}
        show={selectedShow}
        onBack={() => setSelectedShow(null)}
        onSelect={onSelect}
        prevShow={prevShow}
        nextShow={nextShow}
        onPrev={() => { const v = activeVideoRef?.current; if (v) { v.pause(); v.src = ''; v.load(); } setSelectedShow(prevShow); }}
        onNext={() => { const v = activeVideoRef?.current; if (v) { v.pause(); v.src = ''; v.load(); } setSelectedShow(nextShow); }}
        activeVideoRef={activeVideoRef}
      />
    );
  }

  return (
    <>
    <div className="page" style={{ position:'relative', zIndex:0 }}>
      <div style={{ height: 360 }} />
      <div className="page-header">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <div className="page-title">📺 TV Shows</div>
            <div className="page-subtitle">{shows.length.toLocaleString()} series · {(library.tvShows?.length || 0).toLocaleString()} episodes</div>
          </div>
        </div>
      </div>

      {/* Main tabs */}
      <div style={{ display:'flex', gap:2, borderBottom:'1px solid var(--border)', marginBottom:20 }}>
        {[{id:'library',label:'Library'},{id:'collections',label:'Collections'},{id:'networks',label:'Networks'},{id:'categories',label:'Categories'}].map(t => (
          <button key={t.id} onClick={() => { setTab(t.id); setGenre(null); setSelectedCollection(null); setStreamingService(null); }} style={{
            padding:'10px 22px', border:'none', cursor:'pointer', fontSize:14, fontWeight:600,
            background:'transparent',
            color: tab===t.id ? 'var(--accent)' : 'var(--text-muted)',
            borderBottom: tab===t.id ? '2px solid var(--accent)' : '2px solid transparent',
            transition:'all 0.15s', marginBottom:-1,
          }}>{t.label}</button>
        ))}
      </div>

      {/* LIBRARY */}
      {tab === 'library' && (<>
        {scanStatus && (
          <div style={{ display:'flex', alignItems:'center', gap:12, padding:'10px 16px',
            background:'rgba(99,102,241,0.15)', border:'1px solid rgba(99,102,241,0.3)',
            borderRadius:8, marginBottom:12, fontSize:13, color:'rgba(255,255,255,0.85)' }}>
            <div style={{ width:16, height:16, border:'2px solid var(--accent)',
              borderTopColor:'transparent', borderRadius:'50%',
              animation:'spin 0.8s linear infinite', flexShrink:0 }} />
            <span>{scanStatus.message}</span>
          </div>
        )}
        <div className="filter-bar">
          {FILTERS.map(f => <button key={f} className={`filter-chip ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)}>{f}</button>)}
        </div>

        {shows.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">📺</div>
            <h3>No TV shows yet</h3>
            <p>Add folders containing your TV show files.</p>
            <button className="btn btn-primary" onClick={handleAddFolder}><FolderOpen size={16} /> Add TV Folder</button>
          </div>
        ) : (
          <AlphaGroupedGrid items={filtered} getKey={s => s.showName}
            renderItem={show => <ShowCard show={show} onClick={setSelectedShow} />} />
        )}
      </>)}

      {/* COLLECTIONS */}
      {tab === 'collections' && (<>
        {tvCollections.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">📁</div>
            <h3>No TV collections yet</h3>
            <p>TV collections group shows by network (ABC, Netflix, HBO, etc.).<br/><br/>
            To build them:<br/>
            1. Run <strong>Settings → Library → Fetch Metadata</strong> so shows have network info<br/>
            2. Go to <strong>Auto Collections → Run Now</strong></p>
          </div>
        ) : (
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(200px,1fr))', gap:16 }}>
            {tvCollections.map(col => {
              const img = col.thumbnail || col.poster;
              const imgUrl = img ? (img.startsWith('http') ? img : `http://localhost:3001${img}`) : null;
              return (
                <div key={col.id} style={{ borderRadius:'var(--radius-lg)', overflow:'hidden', cursor:'pointer', background:'var(--bg-card)', border:'1px solid var(--border)', transition:'transform 0.2s' }}
                  onMouseEnter={e => e.currentTarget.style.transform='translateY(-4px)'}
                  onMouseLeave={e => e.currentTarget.style.transform=''}
                >
                  <div style={{ height:280, background: imgUrl ? `url(${imgUrl}) center/cover` : 'var(--bg-tertiary)', position:'relative', display:'flex', alignItems:'center', justifyContent:'center', fontSize:48 }}>
                    {!imgUrl && '📺'}
                    <div style={{ position:'absolute', bottom:0, left:0, right:0, padding:'40px 12px 12px', background:'linear-gradient(transparent,rgba(0,0,0,0.85))' }}>
                      <div style={{ fontWeight:700, fontSize:14 }}>{col.name}</div>
                      <div style={{ fontSize:12, color:'rgba(255,255,255,0.5)', marginTop:3 }}>{col.mediaIds?.length||0} shows</div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </>)}

      {/* ── STREAMING TAB ── */}
      {tab === 'networks' && (
        <>
          {streamingService ? (
            <>
              <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:24 }}>
                <button onClick={() => { setStreamingService(null); setSelectedNetworkGroup(null); setNetworkShows([]); }} className="btn btn-secondary btn-sm">← Back</button>
                <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                  <div style={{ padding:'4px 12px', borderRadius:6, background: selectedNetworkGroup?.svc?.bg||'#333', color: selectedNetworkGroup?.svc?.color||'#fff', fontWeight:800, fontSize:14 }}>{streamingService}</div>
                  <div style={{ fontSize:13, color:'var(--text-muted)' }}>{networkLoading ? 'Loading...' : `${networkShows.length} shows`}</div>
                </div>
              </div>
              {networkLoading ? (
                <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:200 }}>
                  <div style={{ width:32, height:32, border:'3px solid var(--bg-tertiary)', borderTop:'3px solid var(--accent)', borderRadius:'50%', animation:'spin 0.8s linear infinite' }} />
                </div>
              ) : (
                <div className="tv-grid">
                  {networkShows.map(show => <MediaCard key={show.id || show.title} item={show} onClick={() => onSelect?.(show)} />)}
                </div>
              )}
            </>
          ) : (
            streamingGroups.length === 0 && tvCollections.filter(c=>c.type==='network').length === 0 ? (
              <div className="empty-state">
                <div className="empty-state-icon">📡</div>
                <h3>No network data yet</h3>
                <p>Add a <strong>TMDB API key</strong> in Settings → Library, then run <strong>Refresh Metadata</strong> and <strong>Refresh Provider Data</strong> in Auto Collections.</p>
              </div>
            ) : (
              <div style={{ display:'flex', flexWrap:'wrap', gap:16 }}>
                {allNetworkGroups.map(({ label, shows, svc, count, fromDB, colIds }) => (
                  <div key={label} onClick={() => openNetwork({ label, shows, svc, count, fromDB, colIds })}
                    style={{ width:160, borderRadius:12, overflow:'hidden', cursor:'pointer', flexShrink:0,
                      background:'var(--bg-card)', border:'1px solid rgba(255,255,255,0.08)',
                      boxShadow:'0 4px 16px rgba(0,0,0,0.5)', transition:'transform 0.18s, box-shadow 0.18s' }}
                    onMouseEnter={e=>{ e.currentTarget.style.transform='translateY(-6px)'; e.currentTarget.style.boxShadow='0 16px 40px rgba(0,0,0,0.7)'; }}
                    onMouseLeave={e=>{ e.currentTarget.style.transform=''; e.currentTarget.style.boxShadow='0 4px 16px rgba(0,0,0,0.5)'; }}>
                    {/* Brand color accent bar */}
                    <div style={{ height:5, background: svc?.bg||'#444' }}/>
                    {/* White logo area */}
                    <div style={{ background:'#fff', height:160, display:'flex', alignItems:'center', justifyContent:'center', padding:'20px 18px', position:'relative' }}>
                      {svc?.logo
                        ? <img src={svc.logo} alt={label}
                            style={{ maxWidth:'100%', maxHeight:100, objectFit:'contain', display:'block' }}
                            onError={e=>{ e.target.style.display='none'; e.target.parentNode.querySelector('.svc-fallback').style.display='flex'; }}/>
                        : null}
                      <div className="svc-fallback" style={{ display:svc?.logo?'none':'flex', position:'absolute', inset:0,
                        background: svc?.bg||'#1a1a1a',
                        alignItems:'center', justifyContent:'center',
                        fontSize:20, fontWeight:900, color:svc?.color||'#fff', letterSpacing:1, textAlign:'center', padding:'0 14px', lineHeight:1.2 }}>
                        {label}
                      </div>
                    </div>
                    {/* Info bar */}
                    <div style={{ padding:'10px 12px' }}>
                      <div style={{ fontSize:12, fontWeight:700, color:'var(--text-primary)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{label}</div>
                      <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:2 }}>
                        {shows.length > 0 ? `${shows.length} shows` : count > 0 ? `${count} shows` : '0 shows'}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )
          )}
        </>
      )}

      {/* CATEGORIES */}
      {tab === 'categories' && (<>
        {genres.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">🏷</div>
            <h3>No categories yet</h3>
            <p>Go to <strong>Auto Collections</strong> and click <strong>Run Now</strong>.</p>
          </div>
        ) : (
          <GenreCategoryGrid
            genres={genres}
            mediaType="tvShows"
            itemLabel="shows"
            onSelect={(g) => { setGenre(g); setTab('library'); }}
          />
        )}
      </>)}
    </div>
    <AlphaNav items={filtered} getKey={s => s.showName} />
    </>
  );
}

export default TVShowsPage;

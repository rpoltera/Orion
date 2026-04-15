import React, { useState, useEffect } from 'react';
import { AppProvider, useApp } from './contexts/AppContext';
import Sidebar from './components/Sidebar';
import TitleBar from './components/TitleBar';
import ToastStack from './components/ToastStack';
import PlayerOverlay from './components/PlayerOverlay';
import SearchResults from './components/SearchResults';
import MediaDetailModal from './components/MediaDetailModal';
import MovieDetailPage from './pages/MovieDetailPage';
import HomePage from './pages/HomePage';
import MoviesPage from './pages/MoviesPage';
import TVShowsPage from './pages/TVShowsPage';
import DiscoverPage from './pages/DiscoverPage';
import { MusicPage, MusicVideosPage } from './pages/MediaPages';
import CustomLibraryPage from './pages/CustomLibraryPage';
import IPTVPage from './pages/IPTVPage';
import StreamingPage from './pages/StreamingPage';
import StreamingServicesPage from './pages/StreamingServicesPage';
import SettingsPage from './pages/SettingsPage';
import AutoCollectionsPage from './pages/AutoCollectionsPage';
import SchedulerPage from './pages/SchedulerPage';
import CollectionsPage from './pages/CollectionsPage';
import UsersPage from './pages/UsersPage';
import StreamForgePage from './pages/StreamForgePage';
import LoginScreen from './components/LoginScreen';
import './index.css';

function ClearlogoTitle({ title, section }) {
  const [imgOk, setImgOk] = React.useState(true);
  const [id, setId] = React.useState(null);

  React.useEffect(() => {
    setImgOk(true); setId(null);
    if (!title) return;
    // Find the item id to get clearlogo
    fetch(`http://localhost:3001/api/tmdb/search?q=${encodeURIComponent(title)}&type=${section === 'home' ? 'movie' : 'tv'}`)
      .then(r => r.json())
      .then(d => { if (d.results?.[0]?.id) setId(d.results[0].id); })
      .catch(() => {});
  }, [title, section]);

  const logoUrl = section === 'home'
    ? `http://localhost:3001/api/clearlogo-movie/${id}`
    : `http://localhost:3001/api/clearlogo-show/${encodeURIComponent(title)}`;

  if (imgOk && (id || section === 'tvshows')) {
    return (
      <img
        src={section === 'tvshows' ? logoUrl : `http://localhost:3001/api/clearlogo-movie/${id}`}
        alt={title}
        onError={() => setImgOk(false)}
        style={{ maxWidth:320, maxHeight:110, objectFit:'contain', display:'block',
          filter:'drop-shadow(0 2px 12px rgba(0,0,0,0.99))' }}
      />
    );
  }
  return (
    <div style={{ fontSize:28, fontWeight:900, color:'white',
      textShadow:'0 2px 16px rgba(0,0,0,0.99), 0 0 40px rgba(0,0,0,0.8)',
      maxWidth:400, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
      {title}
    </div>
  );
}

function GlobalBackground() {
  const { activeSection, library, playerOpen } = useApp();
  const [videoUrl, setVideoUrl] = React.useState(null);
  const [faded, setFaded] = React.useState(false);
  const [title, setTitle] = React.useState(null);
  const videoRef = React.useRef(null);

  React.useEffect(() => {
    setVideoUrl(null); setFaded(false); setTitle(null);

    if (activeSection === 'home') {
      const movies = library.movies || [];
      if (!movies.length) return;
      const shuffled = [...movies].sort(() => Math.random() - 0.5).slice(0, 30);
      (async () => {
        for (const m of shuffled) {
          try {
            const r = await fetch(`http://localhost:3001/api/trailers/${m.id}`);
            const d = await r.json();
            if (d.trailers?.length) {
              setVideoUrl(`http://localhost:3001${d.trailers[0].url}`);
              setTitle(m.title);
              return;
            }
          } catch {}
        }
      })();
    } else if (activeSection === 'tvshows') {
      fetch('http://localhost:3001/api/tv-trailers-random')
        .then(r => r.json())
        .then(d => {
          if (d.trailer) {
            setVideoUrl(`http://localhost:3001${d.trailer.url}`);
            setTitle(d.trailer.showName);
          }
        })
        .catch(() => {});
    }
  }, [activeSection, library.movies?.length, library.tvShows?.length]);

  // Pause background video when player is open — prevents audio bleed
  React.useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (playerOpen) {
      v.pause();
    } else {
      v.play().catch(() => {});
    }
  }, [playerOpen]);

  const active = activeSection === 'home' || activeSection === 'tvshows';
  if (!active) return null;

  return (
    <div style={{ position:'fixed', inset:0, zIndex:0, pointerEvents:'none' }}>
      {videoUrl && (
        <video
          ref={videoRef}
          key={videoUrl}
          src={videoUrl}
          autoPlay muted loop playsInline
          style={{ position:'absolute', top:0, left:100, right:0, bottom:0,
            width:'calc(100% - 100px)', height:'100%', objectFit:'cover',
            opacity: faded ? 0.55 : 0, transition:'opacity 2s ease' }}
          onCanPlay={() => setFaded(true)}
          onLoadedData={() => setFaded(true)}
          onError={e => console.warn('[BGVideo] error', e.nativeEvent)}
        />
      )}
      {/* Now Playing badge — positioned below titlebar, after sidebar */}
      {faded && title && (
        <div style={{ position:'absolute', top:44, left:240, zIndex:2,
          pointerEvents:'none', userSelect:'none' }}>
          <div style={{ fontSize:10, fontWeight:700, letterSpacing:2, textTransform:'uppercase',
            color:'var(--accent)', marginBottom:8, textShadow:'0 1px 4px rgba(0,0,0,0.9)' }}>
            ▶ NOW PLAYING
          </div>
          <ClearlogoTitle title={title} section={activeSection} />
        </div>
      )}
      {/* Bottom overlay */}
      {activeSection === 'tvshows' && (
        <>
          <div style={{ position:'absolute', top:'35%', left:0, right:0, bottom:0, background:'rgba(10,10,18,0.75)' }} />
          <div style={{ position:'absolute', top:'20%', left:0, right:0, height:'20%', background:'linear-gradient(to bottom,transparent,rgba(10,10,18,0.75))' }} />
        </>
      )}
      {activeSection === 'home' && (
        <>
          <div style={{ position:'absolute', top:'40%', left:0, right:0, bottom:0, background:'rgba(10,10,18,0.75)' }} />
          <div style={{ position:'absolute', top:'25%', left:0, right:0, height:'20%', background:'linear-gradient(to bottom,transparent,rgba(10,10,18,0.75))' }} />
        </>
      )}
    </div>
  );
}

class ErrorBoundary extends React.Component {
  state = { error: null };
  static getDerivedStateFromError(e) { return { error: e }; }
  render() {
    if (this.state.error) return (
      <div style={{ padding: 40, color: 'white', fontFamily: 'monospace', background: '#040714', minHeight: '100vh' }}>
        <div style={{ color: '#f87171', fontSize: 20, marginBottom: 16 }}>⚠️ Orion crashed on startup</div>
        <pre style={{ color: '#fca5a5', whiteSpace: 'pre-wrap', fontSize: 13 }}>{this.state.error?.toString()}</pre>
        <pre style={{ color: '#6b7280', whiteSpace: 'pre-wrap', fontSize: 11, marginTop: 12 }}>{this.state.error?.stack}</pre>
      </div>
    );
    return this.props.children;
  }
}

function AppContent() {
  const { activeSection, setActiveSection, playerOpen, searchQuery, search, currentUser, setCurrentUser, playMedia, customLibraries } = useApp();
  const [detailItem, setDetailItem] = useState(null);
  const [detailList, setDetailList] = useState([]);
  const [selectedTVShow, setSelectedTVShow] = useState(null);

  // Clear detail state when navigating away via sidebar
  useEffect(() => {
    setDetailItem(null);
    setDetailList([]);
    setSelectedTVShow(null);
  }, [activeSection]);

  // Show login screen if not logged in
  if (!currentUser) {
    return <LoginScreen onLogin={(user) => setCurrentUser(user)} />;
  }

  // All media cards call this — routes by type
  const handleMediaSelect = (item, actionOrList = null) => {
    const type = item?.type || item?.mediaType;
    const action = actionOrList === 'play' ? 'play' : null;
    const list = Array.isArray(actionOrList) ? actionOrList : [];

    // Play button clicked — always play directly
    if (action === 'play') {
      if (item?.filePath || item?.url) playMedia(item);
      return;
    }
    // Show-level card — navigate into show detail
    if (type === 'tvShows' && item?.showName && !item?.filePath) {
      setSelectedTVShow(item);
      setActiveSection('tvshows');
      if (searchQuery) search('');
    // TV episode with filePath — play directly
    } else if (type === 'tvShows' && item?.filePath) {
      playMedia(item);
    // Movie — open detail page
    } else if (type === 'movies' && item?.filePath) {
      setDetailItem(item);
      setDetailList(list);
    } else if (item?.filePath) {
      playMedia(item);
    } else {
      setDetailItem(item);
      setDetailList(list);
    }
  };

  const renderPage = () => {
    if (searchQuery) return <SearchResults onSelect={handleMediaSelect} />;
    switch (activeSection) {
      case 'home':         return <HomePage onSelect={handleMediaSelect} />;
      case 'movies':       return <MoviesPage onSelect={handleMediaSelect} />;
      case 'tvshows':      return <TVShowsPage onSelect={handleMediaSelect} initialShow={selectedTVShow} onInitialShowConsumed={() => setSelectedTVShow(null)} />;
      case 'discover':     return <DiscoverPage onSelect={handleMediaSelect} />;
      case 'music':        return <MusicPage onSelect={handleMediaSelect} />;
      case 'musicvideos':  return <MusicVideosPage onSelect={handleMediaSelect} />;
      case 'livetv':       return <IPTVPage />;
      case 'streamforge':  return <StreamForgePage />;
      case 'streaming':   return <StreamingServicesPage />;
      case 'pluto':       return <StreamingPage service="pluto" />;
      case 'roku':        return <StreamingPage service="roku" />;
      case 'tubi':        return <StreamingPage service="tubi" />;
      case 'crackle':     return <StreamingPage service="crackle" />;
      case 'plex':        return <StreamingPage service="plex" />;
      case 'freevee':     return <StreamingPage service="freevee" />;
      case 'peacock':     return <StreamingPage service="peacock" />;
      case 'popcornflix': return <StreamingPage service="popcornflix" />;
      case 'stirr':       return <StreamingPage service="stirr" />;
      case 'youtube':     return <StreamingPage service="youtube" />;
      case 'paramount':   return <StreamingPage service="paramount" />;
      case 'netflix':     return <StreamingPage service="netflix" />;
      case 'hulu':        return <StreamingPage service="hulu" />;
      case 'disney':      return <StreamingPage service="disney" />;
      case 'max':         return <StreamingPage service="max" />;
      case 'prime':       return <StreamingPage service="prime" />;
      case 'appletv':     return <StreamingPage service="appletv" />;
      case 'settings':     return <SettingsPage />;
      case 'users':        return <UsersPage />;
      case 'autocollections':       return <AutoCollectionsPage />;
      case 'collections':   return <CollectionsPage onSelect={handleMediaSelect} />;
      default:
        if (activeSection?.startsWith('custom:')) {
          const libId = activeSection.replace('custom:', '');
          const lib = customLibraries?.find(l => l.id === libId);
          return <CustomLibraryPage library={lib} />;
        }
        return <HomePage onSelect={handleMediaSelect} />;
    }
  };

  return (
    <div className="app-layout">
      <GlobalBackground />
      <Sidebar />
      <div className="main-content">
        <TitleBar />
        <div className="fade-in" key={activeSection + (detailItem ? 'detail' : '')}>
          {detailItem && (detailItem.type === 'movies' || (!detailItem.type && detailItem.filePath)) ? (() => {
            const idx = detailList.findIndex(m => m.id === detailItem.id);
            const prev = idx > 0 ? detailList[idx-1] : null;
            const next = idx < detailList.length-1 ? detailList[idx+1] : null;
            return (
              <div style={{ height:'100%' }}>
                <MovieDetailPage
                  key={detailItem.id}
                  item={detailItem}
                  list={detailList}
                  prev={prev}
                  next={next}
                  onNavigate={setDetailItem}
                  onClose={() => setDetailItem(null)}
                />
              </div>
            );
          })() : renderPage()}
        </div>
      </div>

      {playerOpen && <PlayerOverlay />}
      <ToastStack />
    </div>
  );
}

function ServerGate({ children }) {
  const [ready, setReady] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const r = await fetch('http://localhost:3001/api/library/probe/status', { signal: AbortSignal.timeout(2000) });
        if (r.ok && !cancelled) { setReady(true); return; }
      } catch {}
      if (!cancelled) setTimeout(() => setAttempt(a => a + 1), 500);
    };
    check();
    return () => { cancelled = true; };
  }, [attempt]);

  if (!ready) return (
    <div style={{ position:'fixed', inset:0, background:'#0a0a12', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:16 }}>
      <img src={`${process.env.PUBLIC_URL}/logo.png`} alt="Orion" style={{ width:80, height:80, objectFit:'contain', opacity:0.9 }} />
      <div style={{ width:180, height:3, background:'rgba(255,255,255,0.1)', borderRadius:2, overflow:'hidden' }}>
        <div style={{ height:'100%', background:'var(--accent,#6366f1)', borderRadius:2, animation:'orion-load 1.2s ease-in-out infinite' }} />
      </div>
      <div style={{ fontSize:12, color:'rgba(255,255,255,0.35)', letterSpacing:1 }}>Starting server...</div>
      <style>{`@keyframes orion-load { 0%{width:0%;margin-left:0} 50%{width:60%;margin-left:20%} 100%{width:0%;margin-left:100%} }`}</style>
    </div>
  );

  return children;
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppProvider>
        <ServerGate>
          <AppContent />
        </ServerGate>
      </AppProvider>
    </ErrorBoundary>
  );
}

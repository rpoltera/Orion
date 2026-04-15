import React, { useState, useEffect, useMemo } from 'react';
import { useApp } from '../contexts/AppContext';
import MediaCard from '../components/MediaCard';
import { FolderOpen, Grid } from 'lucide-react';

const API = 'http://localhost:3001/api';
const resolveImg = (url) => {
  if (!url) return null;
  if (url.startsWith('http')) return url;
  if (url.startsWith('/api')) return `http://localhost:3001${url}`;
  return null;
};

// Shared streaming service definitions (networks + streaming combined)
const NETWORK_SVCS = [
  { names:['netflix'],                               label:'Netflix',         bg:'#141414', color:'#e50914', logo:'https://upload.wikimedia.org/wikipedia/commons/0/08/Netflix_2015_logo.svg' },
  { names:['disney'],                                label:'Disney+',         bg:'#0d2f7e', color:'#fff',    logo:'https://upload.wikimedia.org/wikipedia/commons/3/3e/Disney%2B_logo.svg' },
  { names:['max','hbo'],                             label:'Max',             bg:'#002BE7', color:'#fff',    logo:'https://upload.wikimedia.org/wikipedia/commons/a/a3/Max_logo_2023.svg' },
  { names:['hulu'],                                  label:'Hulu',            bg:'#1CE783', color:'#000',    logo:'https://upload.wikimedia.org/wikipedia/commons/e/e4/Hulu_Logo.svg' },
  { names:['prime video','amazon prime','amazon'],   label:'Prime Video',     bg:'#00A8E1', color:'#fff',    logo:'https://upload.wikimedia.org/wikipedia/commons/1/11/Amazon_Prime_Video_logo.svg' },
  { names:['apple tv'],                              label:'Apple TV+',       bg:'#1c1c1e', color:'#fff',    logo:'https://upload.wikimedia.org/wikipedia/commons/2/28/Apple_TV_Plus_Logo.svg' },
  { names:['peacock'],                               label:'Peacock',         bg:'#000',    color:'#fff',    logo:'https://upload.wikimedia.org/wikipedia/commons/d/d3/NBCUniversal_Peacock_Logo.svg' },
  { names:['paramount'],                             label:'Paramount+',      bg:'#0064FF', color:'#fff',    logo:'https://upload.wikimedia.org/wikipedia/commons/a/a5/Paramount_Plus.svg' },
  { names:['tubi'],                                  label:'Tubi',            bg:'#FA5714', color:'#fff',    logo:'https://upload.wikimedia.org/wikipedia/commons/7/7e/Tubi_TV_logo.svg' },
  { names:['plex'],                                  label:'Plex',            bg:'#E5A00D', color:'#000',    logo:'https://upload.wikimedia.org/wikipedia/commons/7/7b/Plex_logo_2022.svg' },
  { names:['pluto'],                                 label:'Pluto TV',        bg:'#000099', color:'#fff',    logo:'https://upload.wikimedia.org/wikipedia/commons/5/5e/Pluto_TV_logo.svg' },
  { names:['roku'],                                  label:'Roku Channel',    bg:'#6C1D45', color:'#fff',    logo:'https://upload.wikimedia.org/wikipedia/commons/4/4c/Roku_logo.svg' },
  { names:['shudder'],                               label:'Shudder',         bg:'#0F0F0F', color:'#00FF94', logo:'https://upload.wikimedia.org/wikipedia/commons/a/a9/Shudder_logo.svg' },
  { names:['starz'],                                 label:'Starz',           bg:'#000',    color:'#fff',    logo:'https://upload.wikimedia.org/wikipedia/commons/6/6d/Starz_logo.svg' },
  { names:['showtime'],                              label:'Showtime',        bg:'#CC0000', color:'#fff',    logo:'https://upload.wikimedia.org/wikipedia/commons/2/22/Showtime.svg' },
  { names:[' abc','abc ','abc,'],                    label:'ABC',             bg:'#000',    color:'#fff',    logo:null },
  { names:['nbc'],                                   label:'NBC',             bg:'#fff',    color:'#000',    logo:'https://upload.wikimedia.org/wikipedia/commons/3/3f/NBC_logo.svg' },
  { names:['cbs'],                                   label:'CBS',             bg:'#fff',    color:'#000',    logo:'https://upload.wikimedia.org/wikipedia/commons/4/4e/CBS_logo.svg' },
  { names:['fox'],                                   label:'Fox',             bg:'#000',    color:'#fff',    logo:null },
  { names:['the cw','cw network'],                   label:'The CW',          bg:'#228B22', color:'#fff',    logo:null },
  { names:[' fx','fx ','fxx'],                       label:'FX',              bg:'#000',    color:'#fff',    logo:null },
  { names:['amc'],                                   label:'AMC',             bg:'#000',    color:'#fff',    logo:null },
  { names:['syfy'],                                  label:'Syfy',            bg:'#1b1b3a', color:'#fff',    logo:null },
  { names:['adult swim'],                            label:'Adult Swim',      bg:'#000',    color:'#fff',    logo:null },
  { names:['cartoon network'],                       label:'Cartoon Network', bg:'#fff',    color:'#000',    logo:'https://upload.wikimedia.org/wikipedia/commons/8/80/Cartoon_Network_2010_logo.svg' },
  { names:['nickelodeon','nick jr'],                 label:'Nickelodeon',     bg:'#FF6D00', color:'#fff',    logo:'https://upload.wikimedia.org/wikipedia/commons/0/0b/Nickelodeon_2009_logo.svg' },
  { names:['comedy central'],                        label:'Comedy Central',  bg:'#fff',    color:'#000',    logo:null },
  { names:['discovery'],                             label:'Discovery',       bg:'#005A9C', color:'#fff',    logo:'https://upload.wikimedia.org/wikipedia/commons/2/21/Discovery_Channel_logo_2019.svg' },
  { names:['history'],                               label:'History',         bg:'#333',    color:'#fff',    logo:null },
  { names:['national geographic','nat geo'],         label:'Nat Geo',         bg:'#FFCC00', color:'#000',    logo:null },
  { names:['bbc'],                                   label:'BBC',             bg:'#BB1919', color:'#fff',    logo:'https://upload.wikimedia.org/wikipedia/commons/4/41/BBC_Logo_2021.svg' },
  { names:['itv'],                                   label:'ITV',             bg:'#005F8F', color:'#fff',    logo:null },
  { names:['hallmark'],                              label:'Hallmark',        bg:'#4a1c5c', color:'#fff',    logo:null },
  { names:['lifetime'],                              label:'Lifetime',        bg:'#8B0000', color:'#fff',    logo:null },
  { names:['bravo'],                                 label:'Bravo',           bg:'#8B008B', color:'#fff',    logo:null },
  { names:['mtv'],                                   label:'MTV',             bg:'#000',    color:'#fff',    logo:null },
  { names:['crunchyroll'],                           label:'Crunchyroll',     bg:'#F47521', color:'#fff',    logo:null },
  { names:['funimation'],                            label:'Funimation',      bg:'#400080', color:'#fff',    logo:null },
];

const getSvcForItem = (item) => {
  const all = [...(item?.watchProviders||[]), ...(item?.network ? [item.network] : []), ...(item?.networks||[])].filter(Boolean);
  for (const svc of NETWORK_SVCS) {
    for (const name of svc.names) {
      if (all.some(s => s?.toLowerCase().includes(name.toLowerCase()))) return svc;
    }
  }
  return null;
};

// ─── Network/Service Card ─────────────────────────────────────────────────────
function NetworkServiceCard({ label, count, svc, onClick }) {
  const [hovered, setHovered] = useState(false);
  return (
    <div onClick={onClick} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      style={{ width: 160, borderRadius: 12, overflow: 'hidden', cursor: 'pointer', flexShrink: 0,
        background: 'var(--bg-card)', border: `1px solid ${hovered ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.08)'}`,
        boxShadow: hovered ? '0 16px 40px rgba(0,0,0,0.7)' : '0 4px 16px rgba(0,0,0,0.5)',
        transform: hovered ? 'translateY(-6px)' : 'none', transition: 'all 0.18s' }}>
      <div style={{ height: 5, background: svc?.bg || '#444' }} />
      <div style={{ background: svc?.logo ? '#fff' : (svc?.bg || 'var(--bg-tertiary)'), height: 120,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px 14px', position: 'relative' }}>
        {svc?.logo
          ? <img src={svc.logo} alt={label} style={{ maxWidth: '100%', maxHeight: 80, objectFit: 'contain' }}
              onError={e => { e.target.style.display = 'none'; }} />
          : <div style={{ fontSize: 16, fontWeight: 900, color: svc?.color || '#fff', textAlign: 'center', lineHeight: 1.2 }}>{label}</div>
        }
        {svc?.logo && (
          <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, fontSize: 16, fontWeight: 900,
            color: svc.color || '#fff', textAlign: 'center', lineHeight: 1.2, padding: '0 8px 8px',
            display: 'none' }}>{label}</div>
        )}
      </div>
      <div style={{ padding: '10px 12px' }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{count} shows</div>
      </div>
    </div>
  );
}

// ─── TV Shows Page ────────────────────────────────────────────────────────────
export function TVShowsPage({ onSelect }) {
  const { library, scanFolders, loading, API: appAPI } = useApp();
  const [tab, setTab] = useState('library');
  const [selectedNetwork, setSelectedNetwork] = useState(null);
  const [selectedCollection, setSelectedCollection] = useState(null);
  const [selectedGenre, setSelectedGenre] = useState(null);
  const [collectionShows, setCollectionShows] = useState([]);
  const [allCols, setAllCols] = useState([]);
  const [sortFilter, setSortFilter] = useState('All');

  const apiBase = appAPI || API;

  // Fetch collections
  useEffect(() => {
    if (!apiBase) return;
    fetch(`${apiBase}/collections?mediaType=tvShows&slim=1`)
      .then(r => r.json()).then(d => setAllCols(d.collections || [])).catch(() => {});
  }, [apiBase]);

  // Deduplicate episodes → unique shows
  const shows = useMemo(() => {
    const seen = new Set();
    return (library.tvShows || []).filter(ep => {
      const key = ep.seriesTitle || ep.showName || ep.title;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
  }, [library.tvShows]);

  // Network/streaming groups from show data
  const networkGroups = useMemo(() => {
    const groups = {};
    shows.forEach(show => {
      const svc = getSvcForItem(show);
      if (!svc) return;
      if (!groups[svc.label]) groups[svc.label] = { label: svc.label, shows: [], svc };
      groups[svc.label].shows.push(show);
    });
    return Object.values(groups).sort((a, b) => b.shows.length - a.shows.length);
  }, [shows]);

  // Genre collections
  const genreCols = useMemo(() =>
    allCols.filter(c => c.type === 'auto-genre' && (c.mediaType === 'tvShows' || c.mediaType === 'mixed')),
  [allCols]);

  // Franchise/network DB collections
  const dbCollections = useMemo(() =>
    allCols.filter(c => ['franchise','manual','network','holiday'].includes(c.type) && (c.mediaType === 'tvShows' || c.mediaType === 'mixed')),
  [allCols]);

  // Sorted shows for library tab
  const sortedShows = useMemo(() => {
    let list = [...shows];
    if (selectedGenre) {
      const ids = new Set(selectedGenre.mediaIds || []);
      list = list.filter(s => ids.has(s.id));
    }
    if (sortFilter === 'A-Z') list.sort((a,b) => (a.seriesTitle||a.title||'').localeCompare(b.seriesTitle||b.title||''));
    else if (sortFilter === 'By Rating') list.sort((a,b) => parseFloat(b.rating||0) - parseFloat(a.rating||0));
    else if (sortFilter === 'Recently Added') list.sort((a,b) => new Date(b.addedAt||0) - new Date(a.addedAt||0));
    return list;
  }, [shows, selectedGenre, sortFilter]);

  const handleAddFolder = async () => {
    const result = await window.electron?.openFolderDialog();
    if (!result?.canceled && result?.filePaths?.length) await scanFolders(result.filePaths, 'tvShows');
  };

  const openCollection = async (col) => {
    setSelectedCollection(col);
    try {
      const d = await fetch(`${apiBase}/collections/${col.id}`).then(r => r.json());
      setCollectionShows(d.items || []);
    } catch { setCollectionShows([]); }
  };

  const TABS = [
    { id: 'library',     label: 'Library' },
    ...(dbCollections.length > 0  ? [{ id: 'collections', label: 'Collections' }] : []),
    ...(networkGroups.length > 0  ? [{ id: 'networks',    label: 'Networks'    }] : []),
    ...(genreCols.length > 0      ? [{ id: 'categories',  label: 'Categories'  }] : []),
  ];

  return (
    <div className="page">
      <div className="page-header">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div className="page-title">📺 TV Shows</div>
            <div className="page-subtitle">{shows.length} series · {(library.tvShows||[]).length} episodes</div>
          </div>
          <button className="btn btn-secondary btn-sm" onClick={handleAddFolder} disabled={loading.tvShows}>
            <FolderOpen size={14} /> Add Folder
          </button>
        </div>
      </div>

      {shows.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">📺</div>
          <h3>No TV shows yet</h3>
          <p>Add folders containing your TV show files.</p>
          <button className="btn btn-primary" onClick={handleAddFolder}><FolderOpen size={16} /> Add TV Folder</button>
        </div>
      ) : (
        <>
          {/* Tabs */}
          <div style={{ display: 'flex', gap: 2, borderBottom: '1px solid var(--border)', marginBottom: 20 }}>
            {TABS.map(t => (
              <button key={t.id} onClick={() => { setTab(t.id); setSelectedNetwork(null); setSelectedCollection(null); setSelectedGenre(null); }}
                style={{ padding: '10px 22px', border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 600,
                  background: 'transparent', color: tab === t.id ? 'var(--accent)' : 'var(--text-muted)',
                  borderBottom: tab === t.id ? '2px solid var(--accent)' : '2px solid transparent',
                  transition: 'all 0.15s', marginBottom: -1 }}>{t.label}</button>
            ))}
          </div>

          {/* ── LIBRARY TAB ── */}
          {tab === 'library' && (
            <>
              <div className="filter-bar">
                {['All','Recently Added','A-Z','By Rating'].map(f => (
                  <button key={f} className={`filter-chip ${sortFilter===f?'active':''}`} onClick={() => setSortFilter(f)}>{f}</button>
                ))}
              </div>
              <div className="media-grid">
                {sortedShows.map(show => <MediaCard key={show.id} item={show} onClick={onSelect} />)}
              </div>
            </>
          )}

          {/* ── COLLECTIONS TAB ── */}
          {tab === 'collections' && (
            selectedCollection ? (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
                  <button onClick={() => setSelectedCollection(null)} className="btn btn-secondary btn-sm">← Back</button>
                  <div>
                    <div style={{ fontSize: 20, fontWeight: 700 }}>{selectedCollection.name}</div>
                    <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>{collectionShows.length} shows</div>
                  </div>
                </div>
                <div className="media-grid">
                  {collectionShows.map(s => <MediaCard key={s.id} item={s} onClick={onSelect} />)}
                </div>
              </>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(200px,1fr))', gap: 16 }}>
                {dbCollections.sort((a,b) => (b.mediaIds?.length||0)-(a.mediaIds?.length||0)).map(col => {
                  const img = resolveImg(col.thumbnail || col.poster);
                  return (
                    <div key={col.id} onClick={() => openCollection(col)} style={{
                      borderRadius: 'var(--radius-lg)', overflow: 'hidden', cursor: 'pointer',
                      background: 'var(--bg-card)', border: '1px solid var(--border)', transition: 'transform 0.2s' }}
                      onMouseEnter={e => e.currentTarget.style.transform='translateY(-4px)'}
                      onMouseLeave={e => e.currentTarget.style.transform=''}>
                      <div style={{ height: 200, background: img ? `url(${img}) center/cover` : 'linear-gradient(135deg,var(--bg-tertiary),var(--bg-card))', position: 'relative' }}>
                        {!img && <div style={{ position:'absolute',inset:0,display:'flex',alignItems:'center',justifyContent:'center',fontSize:48 }}>📺</div>}
                        <div style={{ position:'absolute',bottom:0,left:0,right:0,padding:'30px 12px 12px',background:'linear-gradient(transparent,rgba(0,0,0,0.85))' }}>
                          <div style={{ fontWeight:700,fontSize:14,lineHeight:1.3 }}>{col.name}</div>
                          <div style={{ fontSize:12,color:'rgba(255,255,255,0.5)',marginTop:3 }}>{col.mediaIds?.length||0} items</div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )
          )}

          {/* ── NETWORKS TAB ── */}
          {tab === 'networks' && (
            selectedNetwork ? (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
                  <button onClick={() => setSelectedNetwork(null)} className="btn btn-secondary btn-sm">← Back</button>
                  <div style={{ fontSize: 20, fontWeight: 700 }}>{selectedNetwork.label}</div>
                  <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>{selectedNetwork.shows.length} shows</div>
                </div>
                <div className="media-grid">
                  {selectedNetwork.shows.map(s => <MediaCard key={s.id} item={s} onClick={onSelect} />)}
                </div>
              </>
            ) : (
              networkGroups.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-state-icon">📡</div>
                  <h3>No network data yet</h3>
                  <p>Add a TMDB API key in Settings → Library, then run <strong>Refresh Metadata</strong> and <strong>Refresh Provider Data</strong> in Auto Collections.</p>
                </div>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
                  {networkGroups.map(group => (
                    <NetworkServiceCard key={group.label} label={group.label} count={group.shows.length} svc={group.svc} onClick={() => setSelectedNetwork(group)} />
                  ))}
                </div>
              )
            )
          )}

          {/* ── CATEGORIES TAB ── */}
          {tab === 'categories' && (
            selectedGenre ? (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
                  <button onClick={() => { setSelectedGenre(null); setTab('categories'); }} className="btn btn-secondary btn-sm">← Categories</button>
                  <div style={{ fontSize: 20, fontWeight: 700 }}>{selectedGenre.name}</div>
                </div>
                <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
                  {['All','Recently Added','A-Z','By Rating'].map(f => (
                    <button key={f} className={`filter-chip ${sortFilter===f?'active':''}`} onClick={() => setSortFilter(f)}>{f}</button>
                  ))}
                </div>
                <div className="media-grid">
                  {sortedShows.map(s => <MediaCard key={s.id} item={s} onClick={onSelect} />)}
                </div>
              </>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                {genreCols.map(cat => (
                  <div key={cat.id} onClick={() => setSelectedGenre(cat)}
                    style={{ padding: '12px 20px', borderRadius: 8, cursor: 'pointer', background: 'var(--bg-card)', border: '1px solid var(--border)',
                      transition: 'all 0.15s', minWidth: 120, textAlign: 'center' }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor='var(--accent)'; e.currentTarget.style.background='var(--bg-hover)'; }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor='var(--border)'; e.currentTarget.style.background='var(--bg-card)'; }}>
                    <div style={{ fontSize: 14, fontWeight: 700 }}>{cat.name}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>{cat.mediaIds?.length||0} shows</div>
                  </div>
                ))}
              </div>
            )
          )}
        </>
      )}
    </div>
  );
}

// ─── Music Page ───────────────────────────────────────────────────────────────
export function MusicPage({ onSelect }) {
  const { library, scanFolders, loading, playMedia } = useApp();
  const tracks = library.music || [];
  const [selectedGenre, setSelectedGenre] = useState('All');
  const [sortBy, setSortBy] = useState('title');

  const handleAddFolder = async () => {
    const result = await window.electron?.openFolderDialog();
    if (!result?.canceled && result?.filePaths?.length) {
      await scanFolders(result.filePaths, 'music');
    }
  };

  // Build genre list
  const genres = React.useMemo(() => {
    const set = new Set();
    tracks.forEach(t => (t.genres || []).forEach(g => set.add(g)));
    return ['All', ...Array.from(set).sort()];
  }, [tracks]);

  const filtered = React.useMemo(() => {
    let items = selectedGenre === 'All' ? tracks : tracks.filter(t => (t.genres || []).includes(selectedGenre));
    return [...items].sort((a, b) => {
      if (sortBy === 'artist') return (a.artist || '').localeCompare(b.artist || '') || (a.title || '').localeCompare(b.title || '');
      if (sortBy === 'album')  return (a.album  || '').localeCompare(b.album  || '') || (a.title || '').localeCompare(b.title || '');
      if (sortBy === 'genre')  return ((a.genres||[])[0]||'').localeCompare((b.genres||[])[0]||'');
      if (sortBy === 'year')   return (b.year||0) - (a.year||0);
      return (a.title || '').replace(/^(the |a |an )/i,'').localeCompare((b.title || '').replace(/^(the |a |an )/i,''));
    });
  }, [tracks, selectedGenre, sortBy]);

  return (
    <div className="page">
      <div className="page-header">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div className="page-title">🎵 Music</div>
            <div className="page-subtitle">{filtered.length} tracks{selectedGenre !== 'All' ? ` · ${selectedGenre}` : ''}</div>
          </div>
          <button className="btn btn-secondary btn-sm" onClick={handleAddFolder} disabled={loading.music}>
            <FolderOpen size={14} /> Add Folder
          </button>
        </div>

        {/* Sort + Genre row */}
        <div style={{ display:'flex', alignItems:'center', gap:16, marginTop:16, flexWrap:'wrap' }}>
          <div style={{ display:'flex', gap:6 }}>
            {[['title','Title'],['artist','Artist'],['album','Album'],['genre','Genre'],['year','Year']].map(([val,label]) => (
              <button key={val} onClick={() => setSortBy(val)}
                style={{ padding:'4px 12px', borderRadius:16, border:'none', cursor:'pointer', fontSize:12, fontWeight:600,
                  background: sortBy === val ? 'var(--accent)' : 'var(--bg-tertiary)',
                  color: sortBy === val ? 'white' : 'var(--text-muted)' }}>
                {label}
              </button>
            ))}
          </div>
          {genres.length > 1 && <>
            <div style={{ width:1, height:20, background:'var(--border)' }} />
            <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
              {genres.map(g => (
                <button key={g} onClick={() => setSelectedGenre(g)}
                  style={{ padding:'4px 12px', borderRadius:16, border:'none', cursor:'pointer', fontSize:12, fontWeight:600,
                    background: selectedGenre === g ? 'rgba(99,102,241,0.3)' : 'var(--bg-card)',
                    color: selectedGenre === g ? 'white' : 'var(--text-muted)',
                    border: `1px solid ${selectedGenre === g ? 'var(--accent)' : 'var(--border)'}` }}>
                  {g}
                </button>
              ))}
            </div>
          </>}
        </div>
      </div>

      {tracks.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">🎵</div>
          <h3>No music yet</h3>
          <p>Add folders containing your music files.</p>
          <button className="btn btn-primary" onClick={handleAddFolder}><FolderOpen size={16} /> Add Music Folder</button>
        </div>
      ) : sortBy === 'album' ? (
        // ── Album grouped view ──────────────────────────────────────────────
        (() => {
          const albumMap = new Map();
          filtered.forEach(t => {
            const key = `${t.album || '(No Album)'}__${t.artist || ''}`;
            if (!albumMap.has(key)) albumMap.set(key, { album: t.album || '(No Album)', artist: t.artist, thumbnail: t.thumbnail, tracks: [] });
            albumMap.get(key).tracks.push({ ...t, type: 'music' });
          });
          const albums = [...albumMap.values()].sort((a,b) => (a.album||'').localeCompare(b.album||''));
          return (
            <div className="media-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))' }}>
              {albums.map(alb => {
                const art = alb.tracks.find(t => t.thumbnail)?.thumbnail;
                const artUrl = art ? (art.startsWith('http') ? art : `http://localhost:3001${art}`) : null;
                return (
                  <div key={alb.album + alb.artist}
                    onClick={() => playMedia(alb.tracks[0], alb.tracks)}
                    style={{ cursor:'pointer', borderRadius:10, overflow:'hidden', background:'var(--bg-card)', border:'1px solid var(--border)', transition:'transform 0.15s, border-color 0.15s' }}
                    onMouseEnter={e => { e.currentTarget.style.transform='translateY(-4px)'; e.currentTarget.style.borderColor='var(--accent)'; }}
                    onMouseLeave={e => { e.currentTarget.style.transform='translateY(0)'; e.currentTarget.style.borderColor='var(--border)'; }}>
                    <div style={{ aspectRatio:'1', background:'#111', position:'relative', overflow:'hidden' }}>
                      {artUrl
                        ? <img src={artUrl} alt={alb.album} style={{ width:'100%', height:'100%', objectFit:'cover' }} loading="lazy" />
                        : <div style={{ width:'100%', height:'100%', display:'flex', alignItems:'center', justifyContent:'center', fontSize:36, color:'rgba(255,255,255,0.15)' }}>💿</div>
                      }
                      <div style={{ position:'absolute', bottom:6, right:6, background:'rgba(0,0,0,0.7)', borderRadius:10, padding:'2px 7px', fontSize:10, color:'rgba(255,255,255,0.7)', fontWeight:600 }}>
                        {alb.tracks.length} {alb.tracks.length === 1 ? 'track' : 'tracks'}
                      </div>
                    </div>
                    <div style={{ padding:'8px 10px' }}>
                      <div style={{ fontWeight:700, fontSize:12, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{alb.album}</div>
                      {alb.artist && <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:2, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{alb.artist}</div>}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })()
      ) : (
        // ── Regular track grid ──────────────────────────────────────────────
        <div className="media-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))' }}>
          {filtered.map(track => (
            <div key={track.id} onClick={() => playMedia({ ...track, type: 'music' }, filtered.map(t => ({ ...t, type: 'music' })))}
              style={{ cursor: 'pointer', borderRadius: 10, overflow: 'hidden',
                background: 'var(--bg-card)', border: '1px solid var(--border)',
                transition: 'transform 0.15s, border-color 0.15s' }}
              onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-4px)'; e.currentTarget.style.borderColor = 'var(--accent)'; }}
              onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.borderColor = 'var(--border)'; }}>
              <div style={{ aspectRatio: '1', background: '#111', position: 'relative', overflow: 'hidden' }}>
                {track.thumbnail
                  ? <img src={track.thumbnail.startsWith('http') ? track.thumbnail : `http://localhost:3001${track.thumbnail}`}
                      alt={track.title} style={{ width: '100%', height: '100%', objectFit: 'cover' }} loading="lazy" />
                  : <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 36, color: 'rgba(255,255,255,0.15)' }}>🎵</div>
                }
                <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0)', display: 'flex',
                  alignItems: 'center', justifyContent: 'center', transition: 'background 0.2s' }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'rgba(0,0,0,0.45)'; e.currentTarget.querySelector('div').style.opacity = '1'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'rgba(0,0,0,0)'; e.currentTarget.querySelector('div').style.opacity = '0'; }}>
                  <div style={{ width: 40, height: 40, borderRadius: '50%', background: 'rgba(255,255,255,0.9)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0, transition: 'opacity 0.2s',
                    fontSize: 16, paddingLeft: 3 }}>▶</div>
                </div>
              </div>
              <div style={{ padding: '8px 10px' }}>
                <div style={{ fontWeight: 700, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{track.title}</div>
                {track.artist && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{track.artist}</div>}
                {track.album && <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: 0.7 }}>{track.album}</div>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Music Videos Page ────────────────────────────────────────────────────────
export function MusicVideosPage({ onSelect }) {
  const { library, scanFolders, loading, playMedia } = useApp();
  const videos = library.musicVideos || [];
  const [selectedGenre, setSelectedGenre] = useState('All');
  const [sortMV, setSortMV] = useState('title');

  const handleAddFolder = async () => {
    const result = await window.electron?.openFolderDialog();
    if (!result?.canceled && result?.filePaths?.length) {
      await scanFolders(result.filePaths, 'musicVideos');
    }
  };

  // Build genre list
  const genres = React.useMemo(() => {
    const set = new Set();
    videos.forEach(v => (v.genres || []).forEach(g => set.add(g)));
    return ['All', ...Array.from(set).sort()];
  }, [videos]);

  const filtered = React.useMemo(() => {
    let items = selectedGenre === 'All' ? videos : videos.filter(v => (v.genres || []).includes(selectedGenre));
    return [...items].sort((a, b) => {
      if (sortMV === 'artist') return (a.artist || '').localeCompare(b.artist || '') || (a.title || '').localeCompare(b.title || '');
      if (sortMV === 'album')  return (a.album  || '').localeCompare(b.album  || '') || (a.title || '').localeCompare(b.title || '');
      if (sortMV === 'genre')  return ((a.genres||[])[0]||'').localeCompare((b.genres||[])[0]||'');
      if (sortMV === 'year')   return (b.year||0) - (a.year||0);
      return (a.title || '').replace(/^(the |a |an )/i,'').localeCompare((b.title || '').replace(/^(the |a |an )/i,''));
    });
  }, [videos, selectedGenre, sortMV]);

  return (
    <div className="page">
      <div className="page-header">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div className="page-title">🎞 Music Videos</div>
            <div className="page-subtitle">{filtered.length} videos{selectedGenre !== 'All' ? ` · ${selectedGenre}` : ''}</div>
          </div>
          <button className="btn btn-secondary btn-sm" onClick={handleAddFolder} disabled={loading.musicVideos}>
            <FolderOpen size={14} /> Add Folder
          </button>
        </div>

        {/* Sort + Genre row */}
        <div style={{ display:'flex', alignItems:'center', gap:16, marginTop:16, flexWrap:'wrap' }}>
          <div style={{ display:'flex', gap:6 }}>
            {[['title','Title'],['artist','Artist'],['album','Album'],['genre','Genre'],['year','Year']].map(([val,label]) => (
              <button key={val} onClick={() => setSortMV(val)}
                style={{ padding:'4px 12px', borderRadius:16, border:'none', cursor:'pointer', fontSize:12, fontWeight:600,
                  background: sortMV === val ? 'var(--accent)' : 'var(--bg-tertiary)',
                  color: sortMV === val ? 'white' : 'var(--text-muted)' }}>
                {label}
              </button>
            ))}
          </div>
          {genres.length > 1 && <>
            <div style={{ width:1, height:20, background:'var(--border)' }} />
            <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
              {genres.map(g => (
                <button key={g} onClick={() => setSelectedGenre(g)}
                  style={{ padding:'4px 12px', borderRadius:16, border:'none', cursor:'pointer', fontSize:12, fontWeight:600,
                    background: selectedGenre === g ? 'rgba(99,102,241,0.3)' : 'var(--bg-card)',
                    color: selectedGenre === g ? 'white' : 'var(--text-muted)',
                    border: `1px solid ${selectedGenre === g ? 'var(--accent)' : 'var(--border)'}` }}>
                  {g}
                </button>
              ))}
            </div>
          </>}
        </div>
      </div>

      {videos.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">🎞</div>
          <h3>No music videos yet</h3>
          <p>Add folders with your music video files.</p>
          <button className="btn btn-primary" onClick={handleAddFolder}><FolderOpen size={16} /> Add Folder</button>
        </div>
      ) : (
        <div className="media-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
          {filtered.map(item => (
            <MediaCard key={item.id} item={item} wide
              onClick={() => playMedia({ ...item, type: 'musicVideos' }, filtered.map(v => ({ ...v, type: 'musicVideos' })))} />
          ))}
        </div>
      )}
    </div>
  );
}


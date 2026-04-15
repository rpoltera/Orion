import React, { useState, useEffect, useMemo } from 'react';
import ReactDOM from 'react-dom';
import { useApp } from '../contexts/AppContext';
import MediaCard from '../components/MediaCard';
import ScrollableGrid from '../components/ScrollableGrid';
import GenreCategoryGrid from '../components/GenreCategoryGrid';
import { FolderOpen, Grid, List } from 'lucide-react';


// ── Flat Grid (Plex-style) — all movies in one continuous grid ────────────────
function FlatGrid({ items, renderItem, getKey }) {
  // Build a ref map so AlphaNav can scroll to first item of each letter
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
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
        gap: '32px 20px',
        padding: '8px 4px',
      }}>
        {items.map((item, i) => {
          const k = (getKey(item) || '').toUpperCase().replace(/^(THE |A |AN )/, '');
          const letter = k[0] && /[A-Z]/.test(k[0]) ? k[0] : '#';
          const isFirst = firstOfLetter[letter] === i;
          return (
            <div key={item.id || i} id={isFirst ? `alpha-${letter}` : undefined}>
              {renderItem(item)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Alphabet Quick-Nav ────────────────────────────────────────────────────────
function AlphaNav({ items, allItems, getKey, onJump }) {
  const chars = ['#', ...Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ')];

  // Availability based on full list
  const available = new Set((allItems || items).map(i => {
    const k = (getKey(i) || '').toUpperCase().replace(/^(THE |A |AN )/, '');
    return k[0] && /[A-Z]/.test(k[0]) ? k[0] : '#';
  }));

  // Index of first item per letter in full list
  const firstIndexOf = React.useMemo(() => {
    const map = {};
    (allItems || items).forEach((item, i) => {
      const k = (getKey(item) || '').toUpperCase().replace(/^(THE |A |AN )/, '');
      const letter = k[0] && /[A-Z]/.test(k[0]) ? k[0] : '#';
      if (!(letter in map)) map[letter] = i;
    });
    return map;
  }, [allItems, items, getKey]);

  const scrollTo = (char) => {
    const idx = firstIndexOf[char];
    if (idx === undefined) return;
    // Load all items so the target element exists in DOM
    onJump && onJump(idx);
    // Wait for React to render then scroll
    const doScroll = () => {
      const el = document.getElementById(`alpha-${char}`);
      const scroller = document.querySelector('.main-content');
      if (el && scroller) {
        const rect = el.getBoundingClientRect();
        const scrollerRect = scroller.getBoundingClientRect();
        scroller.scrollTo({ top: scroller.scrollTop + rect.top - scrollerRect.top - 20, behavior: 'smooth' });
      }
    };
    // Two attempts — one fast, one after longer render time
    setTimeout(doScroll, 80);
    setTimeout(doScroll, 300);
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

const SORT_FILTERS = ['All', 'Recently Added', 'A-Z', 'By Year', 'By Rating'];

export default function MoviesPage({ onSelect }) {
  const { library, scanFolders, loading, API, scanStatus } = useApp();
  const [tab, setTab]           = useState('library');
  const [streamingService, setStreamingService] = useState(null);
  const [selectedNetworkGroup, setSelectedNetworkGroup] = useState(null);
  const [networkMovies, setNetworkMovies] = useState([]);
  const [networkLoading, setNetworkLoading] = useState(false);

  const openNetwork = async (group) => {
    setStreamingService(group.label);
    setSelectedNetworkGroup(group);
    if (group.fromDB && (group.colIds?.length || group.colId)) {
      setNetworkLoading(true);
      setNetworkMovies([]);
      try {
        const ids = group.colIds?.length ? group.colIds : [group.colId];
        const allItems = [];
        for (const colId of ids) {
          const d = await fetch(`${API}/collections/${colId}`).then(r => r.json());
          allItems.push(...(d.items || []));
        }
        // Deduplicate by id for movies
        const seen = new Set();
        setNetworkMovies(allItems.filter(m => { if (seen.has(m.id)) return false; seen.add(m.id); return true; }));
      } catch { setNetworkMovies([]); }
      setNetworkLoading(false);
    } else {
      setNetworkMovies(group.movies || []);
    }
  };

  // Detect streaming service for a movie item
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



  const getServicesForItem = (item) => {
    const all = [...(item?.watchProviders||[]), ...(item?.studios||[])].filter(Boolean);
    const matched = [];
    for (const svc of STREAMING_SVCS) {
      for (const name of svc.names) {
        if (all.some(s => s?.toLowerCase().includes(name.toLowerCase()))) {
          matched.push(svc.label);
          break;
        }
      }
    }
    return matched;
  };

  // Build streaming groups from movies — a movie can appear in multiple groups
  const streamingGroups = useMemo(() => {
    const groups = {};
    (library.movies||[]).forEach(m => {
      const svcs = getServicesForItem(m);
      svcs.forEach(svcLabel => {
        if (!groups[svcLabel]) groups[svcLabel] = { label: svcLabel, movies: [], svc: STREAMING_SVCS.find(s=>s.label===svcLabel) };
        groups[svcLabel].movies.push(m);
      });
    });
    return Object.values(groups).sort((a,b) => b.movies.length - a.movies.length);
  }, [library.movies]);
  const [sortFilter, setSortFilter] = useState('All');
  const [viewMode, setViewMode] = useState('grid');
  const [selectedGenre, setSelectedGenre] = useState(null);
  const [selectedRating, setSelectedRating] = useState(null);
  const [selectedCollection, setSelectedCollection] = useState(null);
  const [collections, setCollections] = useState([]);
  const [genres, setGenres]           = useState([]);

  const [allCols, setAllCols] = useState([]);

  useEffect(() => {
    if (!API) return;
    fetch(`${API}/collections?mediaType=movies&slim=1`)
      .then(r => r.json())
      .then(d => { setAllCols(d.collections || []); })
      .catch(() => {});
  }, [API]);

  useEffect(() => {
    if (!allCols.length || !library.movies?.length) return;
    const movieIdSet = new Set(library.movies.map(m => m.id));
    const hasMovies = c => (c.mediaIds || []).some(id => movieIdSet.has(id));
    const COLLECTION_TYPES = ['franchise','manual','network','holiday','birthday'];
    const franchiseCols = allCols.filter(c => COLLECTION_TYPES.includes(c.type) && (c.mediaType === 'movies' || c.mediaType === 'mixed' || !c.mediaType) && hasMovies(c));
    const genreCols = allCols.filter(c => c.type === 'auto-genre' && c.mediaType === 'movies' && hasMovies(c));
    setCollections(franchiseCols.length > 0 ? franchiseCols : genreCols);
    const genreFiltered = genreCols.filter(c => !c.name.includes('/') && !c.name.includes('|') && (c.mediaIds||[]).length >= 5);
    const genreDeduped = Object.values(genreFiltered.reduce((acc, c) => {
      if (!acc[c.name] || c.mediaIds.length > acc[c.name].mediaIds.length) acc[c.name] = c;
      return acc;
    }, {}));
    setGenres(genreDeduped.sort((a,b) => b.mediaIds.length - a.mediaIds.length));
  }, [allCols, library.movies]);

  // Provider normalization map
  const CANONICAL = { 'Plex Channel':'Plex','Amazon Prime Video':'Prime Video','Amazon Prime Video with Ads':'Prime Video','Amazon Prime Video Free with Ads':'Prime Video','Disney Plus':'Disney+','DisneyNOW':'Disney+','Disney Channel':'Disney+','HBO Max':'Max','HBO':'Max','Peacock Premium':'Peacock','Peacock Premium Plus':'Peacock','Tubi TV':'Tubi','Paramount Plus':'Paramount+','Discovery Plus':'Discovery+','Discovery +':'Discovery+','Netflix basic with Ads':'Netflix','Britbox Apple TV Channel':'BritBox','AMC+':'AMC','Midnight Pulp Amazon Channel':'Prime Video','Dove Amazon Channel':'Prime Video','HBO Max Amazon Channel':'Max','Best tv ever Amazon Channel':'Prime Video' };
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

  // Combine streamingGroups (watchProviders) + network DB collections with normalization
  const allNetworkGroups = useMemo(() => {
    const combined = {};
    streamingGroups.forEach(g => {
      const key = normProv(g.label);
      if (!combined[key]) combined[key] = { label: key, movies: [], svc: g.svc, colIds: [], fromDB: false, mediaIdSet: new Set() };
      combined[key].movies.push(...(g.movies || []));
    });
    const networkCols = allCols.filter(c => (c.type === 'network' || c.type === 'streaming') && (c.mediaType === 'movies' || c.mediaType === 'mixed' || !c.mediaType));
    networkCols.forEach(col => {
      const key = normProv(col.name);
      if (!combined[key]) {
        const svc = STREAMING_SVCS.find(s => s.names.some(n => key.toLowerCase().includes(n.toLowerCase())));
        combined[key] = { label: key, movies: [], svc, colIds: [], fromDB: true, mediaIdSet: new Set() };
      }
      combined[key].colIds.push({ id: col.id, count: col.count || 0 });
      combined[key].fromDB = true;
    });
    return Object.values(combined).map(g => {
      const sortedColIds = g.colIds.sort((a,b)=>(b.count||0)-(a.count||0));
      return {
        ...g,
        colIds: sortedColIds.map(c=>c.id),
        count: Math.max(g.movies.length, sortedColIds[0]?.count || 0),
      };
    }).sort((a, b) => b.count - a.count);
  }, [streamingGroups, allCols]);

  const handleAddFolder = async () => {
    if (window.electron?.openFolderDialog) {
      const result = await window.electron.openFolderDialog();
      if (!result?.canceled && result?.filePaths?.length) {
        await scanFolders(result.filePaths, 'movies');
      }
    } else {
      const path = window.prompt('Enter folder path:');
      if (path) await scanFolders([path], 'movies');
    }
  };

  // Filtered movie list for Library tab
  const filteredMovies = useMemo(() => {
    let list = [...(library.movies || [])];
    if (selectedGenre) {
      const ids = new Set(selectedGenre.mediaIds || []);
      list = list.filter(m => ids.has(m.id));
    }
    if (selectedRating) {
      list = list.filter(m => (m.contentRating || '').toUpperCase() === selectedRating);
    }
    switch (sortFilter) {
      case 'A-Z':            return list.sort((a,b) => (a.title||'').localeCompare(b.title||''));
      case 'By Year':        return list.sort((a,b) => (b.year||0)-(a.year||0));
      case 'By Rating':      return list.sort((a,b) => parseFloat(b.rating||0)-parseFloat(a.rating||0));
      case 'Recently Added': return list.reverse();
      default:               return list;
    }
  }, [library.movies, selectedGenre, selectedRating, sortFilter]);

  // Movies in a selected collection
  const collectionMovies = useMemo(() => {
    if (!selectedCollection) return [];
    const ids = new Set(selectedCollection.mediaIds || []);
    return (library.movies || []).filter(m => ids.has(m.id)).sort((a,b) => (a.year||0)-(b.year||0));
  }, [selectedCollection, library.movies]);

  const [visibleCount, setVisibleCount] = React.useState(200);

  // Always alphabetically sorted — used for both FlatGrid and AlphaNav
  const allMoviesSorted = useMemo(() => {
    return [...filteredMovies].sort((a, b) => {
      const ka = (a.title || '').replace(/^(the |a |an )/i, '').toLowerCase();
      const kb = (b.title || '').replace(/^(the |a |an )/i, '').toLowerCase();
      return ka.localeCompare(kb);
    });
  }, [filteredMovies]);

  const visibleMovies = useMemo(() => {
    return allMoviesSorted.slice(0, visibleCount);
  }, [allMoviesSorted, visibleCount]);

  React.useEffect(() => { setVisibleCount(200); }, [filteredMovies]);

  // Infinite scroll — load 100 more movies when user nears bottom
  React.useEffect(() => {
    const scroller = document.querySelector('.main-content');
    if (!scroller) return;
    const onScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = scroller;
      if (scrollTop + clientHeight >= scrollHeight - 800) {
        setVisibleCount(c => Math.min(c + 100, filteredMovies.length));
      }
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [filteredMovies.length]);

  const gridRef = React.useRef(null);

  const resolveImg = (url) => {
    if (!url) return null;
    if (url.startsWith('http')) return url;
    if (url.startsWith('/api')) return `http://localhost:3001${url}`;
    return null;
  };

  return (
    <>
    <div className="page">
      <div className="page-header">
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
          <div>
            <div className="page-title">🎬 Movies</div>
            <div className="page-subtitle">{(library.movies||[]).length} titles in your library</div>
          </div>
          <div style={{ display:'flex', gap:8 }}>
            <button className="btn btn-secondary btn-sm" onClick={handleAddFolder} disabled={loading.movies}>
              <FolderOpen size={14} /> Add Folder
            </button>
            <button className="btn btn-secondary btn-sm" onClick={() => setViewMode(v => v==='grid'?'list':'grid')}>
              {viewMode==='grid'?<List size={14}/>:<Grid size={14}/>}
            </button>
          </div>
        </div>
      </div>

      {/* Main tabs */}
      <div style={{ display:'flex', gap:2, padding:'0 0 0 0', borderBottom:'1px solid var(--border)', marginBottom:20 }}>
        {[
          { id:'library',     label:'Library' },
          { id:'collections', label:'Collections' },
          { id:'networks',    label:'Networks' },
          { id:'categories',  label:'Categories' },
        ].map(t => (
          <button key={t.id} onClick={() => { setTab(t.id); setSelectedCollection(null); setSelectedGenre(null); setStreamingService(null); }} style={{
            padding:'10px 22px', border:'none', cursor:'pointer', fontSize:14, fontWeight:600,
            background:'transparent',
            color: tab===t.id ? 'var(--accent)' : 'var(--text-muted)',
            borderBottom: tab===t.id ? '2px solid var(--accent)' : '2px solid transparent',
            transition:'all 0.15s', marginBottom:-1,
          }}>{t.label}</button>
        ))}
      </div>

      {/* ── LIBRARY TAB ── */}
      {tab === 'library' && (
        <>
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
            {SORT_FILTERS.map(f => (
              <button key={f} className={`filter-chip ${sortFilter===f?'active':''}`} onClick={() => setSortFilter(f)}>{f}</button>
            ))}
          </div>

          {/* Content Rating Filter */}
          <div className="filter-bar" style={{ marginTop: 4 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1, textTransform: 'uppercase', alignSelf: 'center', marginRight: 4 }}>Rating:</span>
            {[null, 'G', 'PG', 'PG-13', 'R', 'NC-17', 'TV-G', 'TV-PG', 'TV-14', 'TV-MA'].map(r => {
              const ratingColors = { 'G': '#10b981', 'PG': '#3b82f6', 'PG-13': '#f59e0b', 'R': '#ef4444', 'NC-17': '#7c3aed', 'TV-G': '#10b981', 'TV-PG': '#3b82f6', 'TV-14': '#f59e0b', 'TV-MA': '#ef4444' };
              const color = r ? ratingColors[r] || 'var(--accent)' : null;
              const active = selectedRating === r;
              return (
                <button key={r||'all'} onClick={() => setSelectedRating(r)}
                  style={{ padding: '3px 10px', borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: 'pointer',
                    border: `1px solid ${active ? (color||'var(--accent)') : 'var(--border)'}`,
                    background: active ? (color ? color+'22' : 'var(--accent)22') : 'transparent',
                    color: active ? (color||'var(--accent)') : 'var(--text-muted)' }}>
                  {r || 'All'}
                </button>
              );
            })}
          </div>



          {filteredMovies.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">🎬</div>
              <h3>No movies yet</h3>
              <p>Click "Add Folder" to scan a directory for movie files.</p>
              <button className="btn btn-primary" onClick={handleAddFolder}><FolderOpen size={16} /> Add Movie Folder</button>
            </div>
          ) : (
            <>
              <FlatGrid items={visibleMovies} getKey={m => m.title}
                renderItem={movie => <MediaCard item={movie} onClick={() => onSelect?.(movie, filteredMovies)} />} />
              {visibleCount < filteredMovies.length && (
                <div style={{ textAlign:'center', padding:'24px 0', color:'var(--text-muted)', fontSize:13 }}>
                  Showing {visibleMovies.length} of {filteredMovies.length} movies — scroll down to load more
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* ── COLLECTIONS TAB ── */}
      {tab === 'collections' && (
        <>
          {selectedCollection ? (
            <>
              <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:24 }}>
                <button onClick={() => setSelectedCollection(null)} className="btn btn-secondary btn-sm">← Back</button>
                <div>
                  <div style={{ fontSize:20, fontWeight:700 }}>{selectedCollection.name}</div>
                  <div style={{ fontSize:13, color:'var(--text-muted)' }}>{collectionMovies.length} movies</div>
                </div>
              </div>
              <div className="media-grid">
                {collectionMovies.map(movie => (
                  <MediaCard key={movie.id} item={movie} onClick={() => onSelect?.(movie, filteredMovies)} />
                ))}
              </div>
            </>
          ) : (
            <>
              {collections.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-state-icon">📁</div>
                  <h3>No collections yet</h3>
                  <p>Collections are franchise groups like MCU, Batman, Star Wars, etc.<br/><br/>
                  To build them:<br/>
                  1. Add a <strong>TMDB API key</strong> in Settings → Library<br/>
                  2. Run <strong>Settings → Library → Fetch Metadata</strong> on your library<br/>
                  3. Go to <strong>Auto Collections → Build Franchise Collections</strong></p>
                </div>
              ) : (
                <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(200px,1fr))', gap:16 }}>
                  {collections.sort((a,b) => (b.mediaIds?.length||0)-(a.mediaIds?.length||0)).map(col => {
                    const img = resolveImg(col.thumbnail || col.poster);
                    return (
                      <div key={col.id} onClick={() => setSelectedCollection(col)} style={{
                        borderRadius:'var(--radius-lg)', overflow:'hidden', cursor:'pointer',
                        background:'var(--bg-card)', border:'1px solid var(--border)',
                        transition:'transform 0.2s, box-shadow 0.2s',
                      }}
                        onMouseEnter={e => { e.currentTarget.style.transform='translateY(-4px)'; e.currentTarget.style.boxShadow='0 12px 40px rgba(0,0,0,0.4)'; }}
                        onMouseLeave={e => { e.currentTarget.style.transform=''; e.currentTarget.style.boxShadow=''; }}
                      >
                        <div style={{ height:280, background: img ? `url(${img}) center/cover` : 'linear-gradient(135deg,var(--bg-tertiary),var(--bg-card))', position:'relative' }}>
                          {!img && <div style={{ position:'absolute', inset:0, display:'flex', alignItems:'center', justifyContent:'center', fontSize:48 }}>🎬</div>}
                          <div style={{ position:'absolute', bottom:0, left:0, right:0, padding:'40px 12px 12px', background:'linear-gradient(transparent,rgba(0,0,0,0.85))' }}>
                            <div style={{ fontWeight:700, fontSize:14, lineHeight:1.3 }}>{col.name}</div>
                            <div style={{ fontSize:12, color:'rgba(255,255,255,0.5)', marginTop:3 }}>{col.mediaIds?.length||0} movies</div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* ── NETWORKS TAB ── */}
      {tab === 'networks' && (
        <>
          {streamingService ? (
            <>
              <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:24 }}>
                <button onClick={() => { setStreamingService(null); setSelectedNetworkGroup(null); setNetworkMovies([]); }} className="btn btn-secondary btn-sm">← Back</button>
                <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                  <div style={{ padding:'4px 12px', borderRadius:6, background: selectedNetworkGroup?.svc?.bg||'#333', color: selectedNetworkGroup?.svc?.color||'#fff', fontWeight:800, fontSize:14 }}>{streamingService}</div>
                  <div style={{ fontSize:13, color:'var(--text-muted)' }}>{networkLoading ? 'Loading...' : `${networkMovies.length} movies`}</div>
                </div>
              </div>
              {networkLoading ? (
                <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:200 }}>
                  <div style={{ width:32, height:32, border:'3px solid var(--bg-tertiary)', borderTop:'3px solid var(--accent)', borderRadius:'50%', animation:'spin 0.8s linear infinite' }} />
                </div>
              ) : (
                <div className="media-grid">
                  {networkMovies.map(movie => <MediaCard key={movie.id} item={movie} onClick={() => onSelect?.(movie, filteredMovies)} />)}
                </div>
              )}
            </>
          ) : (
            allNetworkGroups.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state-icon">📡</div>
                <h3>No network data yet</h3>
                <p>Add a <strong>TMDB API key</strong> in Settings → Library, then run <strong>Refresh Metadata</strong> and <strong>Refresh Provider Data</strong> in Auto Collections to fetch streaming service and network info.</p>
              </div>
            ) : (
              <div style={{ display:'flex', flexWrap:'wrap', gap:16 }}>
                {allNetworkGroups.map(({ label, movies, svc, count, fromDB, colIds }) => (
                  <div key={label} onClick={() => openNetwork({ label, movies, svc, count, fromDB, colIds })}
                    style={{ width:160, borderRadius:12, overflow:'hidden', cursor:'pointer', flexShrink:0,
                      background:'var(--bg-card)', border:'1px solid rgba(255,255,255,0.08)',
                      boxShadow:'0 4px 16px rgba(0,0,0,0.5)', transition:'transform 0.18s, box-shadow 0.18s' }}
                    onMouseEnter={e=>{ e.currentTarget.style.transform='translateY(-6px)'; e.currentTarget.style.boxShadow='0 16px 40px rgba(0,0,0,0.7)'; }}
                    onMouseLeave={e=>{ e.currentTarget.style.transform=''; e.currentTarget.style.boxShadow='0 4px 16px rgba(0,0,0,0.5)'; }}>
                    <div style={{ height:5, background: svc?.bg||'#444' }}/>
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
                    <div style={{ padding:'10px 12px' }}>
                      <div style={{ fontSize:12, fontWeight:700, color:'var(--text-primary)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{label}</div>
                      <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:2 }}>
                        {`${count} movies`}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )
          )}
        </>
      )}

      {/* ── CATEGORIES TAB ── */}
      {tab === 'categories' && (
        <>
          {selectedGenre ? (
            <>
              <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:24 }}>
                <button onClick={() => setSelectedGenre(null)} className="btn btn-secondary btn-sm">← Back</button>
                <div>
                  <div style={{ fontSize:20, fontWeight:700 }}>{selectedGenre.name}</div>
                  <div style={{ fontSize:13, color:'var(--text-muted)' }}>{selectedGenre.mediaIds?.length||0} movies</div>
                </div>
              </div>
              <div className="media-grid">
                {(library.movies||[])
                  .filter(m => new Set(selectedGenre.mediaIds).has(m.id))
                  .sort((a,b) => (b.rating||0)-(a.rating||0))
                  .map(movie => <MediaCard key={movie.id} item={movie} onClick={() => onSelect?.(movie, filteredMovies)} />)
                }
              </div>
            </>
          ) : (
            <>
              {genres.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-state-icon">🏷</div>
                  <h3>No categories yet</h3>
                  <p>Go to <strong>Auto Collections</strong> and click <strong>Run Now</strong> to build genre categories from your library.</p>
                </div>
              ) : (
                <GenreCategoryGrid
                  genres={genres}
                  mediaType="movies"
                  itemLabel="movies"
                  onSelect={setSelectedGenre}
                />
              )}
            </>
          )}
        </>
      )}
    </div>
    <AlphaNav items={visibleMovies} allItems={allMoviesSorted} getKey={m => m.title}
      onJump={idx => setVisibleCount(prev => Math.max(prev, idx + 200))} />
    </>
  );
}

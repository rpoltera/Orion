import React, { useState, useEffect, useRef } from 'react';
import { useApp } from '../contexts/AppContext';
import { Play, X, Star } from 'lucide-react';

const BASE = 'http://localhost:3001';
const API  = BASE + '/api';

function decodeEntities(s) {
  if (!s) return s;
  return s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'");
}
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

export default function MediaDetailModal({ item, onClose }) {
  const { playMedia } = useApp();
  const [imgError, setImgError]             = useState(false);
  const [posterError, setPosterError]       = useState(false);
  const [versions, setVersions]             = useState([]);
  const [activeVersion, setActiveVersion]   = useState(null);
  const [extras, setExtras]                 = useState([]);
  const [cast, setCast]                     = useState([]);
  const [refreshing, setRefreshing]         = useState(false);
  const [showEdit, setShowEdit]             = useState(false);
  const [showFixMatch, setShowFixMatch]     = useState(false);
  const [searchQ, setSearchQ]               = useState('');
  const [searchResults, setSearchResults]   = useState([]);
  const [searching, setSearching]           = useState(false);
  const audioRef = useRef(null);

  useEffect(() => {
    if (!item) return;
    setActiveVersion(item.filePath);
    setExtras([]); setCast([]);
    setPosterError(false); setImgError(false);
    setRefreshing(false); setShowEdit(false); setShowFixMatch(false); setSearchResults([]);
    if (item.versions?.length > 1) setVersions(item.versions);

    if (item.type === 'movies' || !item.type) {
      fetch(`${API}/library/movies/${item.id}/extras`)
        .then(r=>r.json()).then(d=>setExtras(d.extras||[])).catch(()=>{});
    }

    if (item.cast?.length > 0) {
      setCast(item.cast.slice(0,16).map(c=>({
        name: c.name||c.person?.name,
        character: c.character||c.character?.name,
        image: c.image||c.person?.image?.medium||null,
      })).filter(c=>c.name));
    } else {
      const showName = encodeURIComponent(item.seriesTitle||item.title||'');
      fetch(`https://api.tvmaze.com/singlesearch/shows?q=${showName}&embed=cast`)
        .then(r=>r.json()).then(d=>{
          setCast((d._embedded?.cast||[]).slice(0,16).map(c=>({
            name: c.person?.name, character: c.character?.name,
            image: c.person?.image?.medium||null,
          })).filter(c=>c.name));
        }).catch(()=>{});
    }
  }, [item]);

  const handlePlay = () => {
    onClose();
    const itemToPlay = activeVersion && activeVersion !== item.filePath
      ? { ...item, filePath: activeVersion, fileName: versions.find(v=>v.filePath===activeVersion)?.fileName||item.fileName }
      : item;
    playMedia(itemToPlay);
  };

  const handleRefresh = async () => {
    setShowEdit(false);
    setRefreshing(true);
    try {
      await fetch(`${API}/library/item/${item.id}/refresh`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ type: item.type })
      });
      setTimeout(() => setRefreshing(false), 2000);
    } catch { setRefreshing(false); }
  };

  const handleSearch = async () => {
    if (!searchQ.trim()) return;
    setSearching(true);
    try {
      const type = item.type === 'tvShows' ? 'tv' : 'movie';
      const d = await fetch(`${API}/tmdb/search?q=${encodeURIComponent(searchQ)}&type=${type}`).then(r=>r.json());
      setSearchResults(d.results||[]);
    } catch {}
    setSearching(false);
  };

  const handleFixMatch = async (tmdbId) => {
    setShowFixMatch(false);
    setRefreshing(true);
    try {
      await fetch(`${API}/library/item/${item.id}/refresh`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ tmdbId, type: item.type })
      });
      setTimeout(() => setRefreshing(false), 2000);
    } catch { setRefreshing(false); }
  };

  if (!item) return null;

  const posterUrl   = !posterError ? resolveImg(item.thumbnail) : null;
  const backdropUrl = !imgError    ? resolveImg(item.backdrop)  : null;
  const genres = item.genres||[];
  const extrasByLabel = extras.reduce((acc,e)=>{ (acc[e.label]=acc[e.label]||[]).push(e); return acc; }, {});

  return (
    <div style={{ position:'fixed', inset:0, zIndex:8000, background:'rgba(0,0,0,0.92)',
        backdropFilter:'blur(12px)', display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}
      onClick={onClose}>
      <div style={{ width:'100%', maxWidth:720, maxHeight:'96vh', display:'flex', flexDirection:'column',
          background:'#1a1a2e', borderRadius:14, overflow:'hidden',
          boxShadow:'0 40px 100px rgba(0,0,0,0.9)', border:'1px solid rgba(255,255,255,0.08)' }}
        onClick={e=>e.stopPropagation()}>

        {/* ── Backdrop ── */}
        <div style={{ position:'relative', height:340, flexShrink:0, overflow:'hidden', background:'#111' }}>
          {backdropUrl
            ? <img src={backdropUrl} alt="" onError={()=>setImgError(true)} style={{ width:'100%', height:'100%', objectFit:'cover', objectPosition:'top center', opacity:0.5 }}/>
            : posterUrl && <img src={posterUrl} alt="" style={{ width:'100%', height:'100%', objectFit:'cover', filter:'blur(30px)', transform:'scale(1.15)', opacity:0.25 }}/>
          }
          <div style={{ position:'absolute', inset:0, background:'linear-gradient(to bottom, rgba(0,0,0,0.2), #1a1a2e)' }}/>
          <button onClick={onClose} style={{ position:'absolute', top:14, right:14,
            background:'rgba(0,0,0,0.6)', border:'1px solid rgba(255,255,255,0.2)',
            color:'white', width:34, height:34, borderRadius:'50%', cursor:'pointer',
            display:'flex', alignItems:'center', justifyContent:'center' }}>
            <X size={16}/>
          </button>
        </div>

        {/* ── Header: poster + info ── */}
        <div style={{ display:'flex', gap:0, marginTop:-80, position:'relative', zIndex:1, padding:'0 28px', flexShrink:0 }}>
          <div style={{ flexShrink:0, width:130, marginRight:24 }}>
            {posterUrl
              ? <img src={posterUrl} alt={item.title} onError={()=>setPosterError(true)}
                  style={{ width:130, borderRadius:8, display:'block',
                    boxShadow:'0 16px 40px rgba(0,0,0,0.8)', border:'2px solid rgba(255,255,255,0.1)' }}/>
              : <div style={{ width:130, height:195, borderRadius:8, background:'#2a2a3e',
                  display:'flex', alignItems:'center', justifyContent:'center', fontSize:32 }}>🎬</div>
            }
          </div>
          <div style={{ flex:1, paddingTop:72, minWidth:0 }}>
            {item.director && <div style={{ fontSize:11, color:'rgba(255,255,255,0.4)', marginBottom:4 }}>Directed by {item.director}</div>}
            <h2 style={{ fontSize:22, fontWeight:800, lineHeight:1.15, marginBottom:8, color:'#fff' }}>
              {decodeEntities(item.title)}
            </h2>
            <div style={{ display:'flex', alignItems:'center', gap:12, flexWrap:'wrap', marginBottom:14 }}>
              {item.year && <span style={{ fontSize:13, color:'rgba(255,255,255,0.55)' }}>{item.year}</span>}
              {item.runtime && <span style={{ fontSize:13, color:'rgba(255,255,255,0.55)' }}>{fmtRuntime(item.runtime)}</span>}
              {item.contentRating && (
                <span style={{ fontSize:10, fontWeight:700, padding:'1px 6px',
                  border:'1px solid rgba(255,255,255,0.35)', borderRadius:3, color:'rgba(255,255,255,0.55)' }}>
                  {item.contentRating}
                </span>
              )}
              {item.rating && (
                <span style={{ display:'flex', alignItems:'center', gap:3, fontSize:13, color:'#f59e0b', fontWeight:700 }}>
                  <Star size={12} fill="currentColor"/> {parseFloat(item.rating).toFixed(1)}
                </span>
              )}
              {item.resolution && (
                <span style={{ fontSize:10, fontWeight:700, padding:'1px 6px',
                  background:'rgba(99,102,241,0.3)', borderRadius:3, color:'#a5b4fc' }}>{item.resolution}</span>
              )}
              {genres.slice(0,3).map(g => (
                <span key={g} style={{ fontSize:11, color:'rgba(255,255,255,0.45)' }}>{g}</span>
              ))}
            </div>

            {/* Action buttons */}
            <div style={{ display:'flex', gap:10, alignItems:'center' }}>
              <button onClick={handlePlay}
                style={{ display:'flex', alignItems:'center', gap:8, padding:'9px 22px',
                  background:'var(--accent)', color:'white', border:'none', borderRadius:6,
                  cursor:'pointer', fontSize:14, fontWeight:700 }}>
                <Play size={16} fill="white"/> Play
              </button>
              <button onClick={onClose}
                style={{ padding:'9px 18px', background:'rgba(255,255,255,0.1)',
                  color:'rgba(255,255,255,0.8)', border:'1px solid rgba(255,255,255,0.15)',
                  borderRadius:6, cursor:'pointer', fontSize:14 }}>
                Close
              </button>
              {/* Pencil / edit dropdown */}
              <div style={{ position:'relative', marginLeft:'auto' }}>
                <button onClick={()=>setShowEdit(e=>!e)} title="Edit"
                  style={{ width:34, height:34, borderRadius:'50%', display:'flex', alignItems:'center', justifyContent:'center',
                    background: showEdit ? 'rgba(99,102,241,0.3)' : 'rgba(255,255,255,0.08)',
                    border:`1px solid ${showEdit ? 'rgba(99,102,241,0.6)' : 'rgba(255,255,255,0.15)'}`,
                    color:'rgba(255,255,255,0.7)', cursor:'pointer', fontSize:15 }}>
                  ✏️
                </button>
                {showEdit && (
                  <div style={{ position:'absolute', top:42, right:0, background:'#1a1a2e',
                    border:'1px solid rgba(255,255,255,0.12)', borderRadius:8, padding:6,
                    zIndex:20, minWidth:170, boxShadow:'0 8px 24px rgba(0,0,0,0.6)' }}>
                    <button onClick={handleRefresh} disabled={refreshing}
                      style={{ display:'flex', alignItems:'center', gap:8, width:'100%', padding:'8px 12px',
                        background:'none', border:'none', color: refreshing ? '#10b981' : 'rgba(255,255,255,0.8)',
                        cursor:'pointer', fontSize:13, borderRadius:6, textAlign:'left' }}
                      onMouseEnter={e=>e.currentTarget.style.background='rgba(255,255,255,0.08)'}
                      onMouseLeave={e=>e.currentTarget.style.background='none'}>
                      ⟳ {refreshing ? 'Refreshing…' : 'Refresh Metadata'}
                    </button>
                    <button onClick={()=>{ setShowEdit(false); setShowFixMatch(true); setSearchQ(item.title||''); setSearchResults([]); }}
                      style={{ display:'flex', alignItems:'center', gap:8, width:'100%', padding:'8px 12px',
                        background:'none', border:'none', color:'rgba(255,255,255,0.8)',
                        cursor:'pointer', fontSize:13, borderRadius:6, textAlign:'left' }}
                      onMouseEnter={e=>e.currentTarget.style.background='rgba(255,255,255,0.08)'}
                      onMouseLeave={e=>e.currentTarget.style.background='none'}>
                      🔍 Fix Match
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* ── Scrollable body ── */}
        <div style={{ overflowY:'auto', padding:'16px 22px 24px', flex:1 }} onClick={()=>setShowEdit(false)}>

          {/* Fix Match Search */}
          {showFixMatch && (
            <div style={{ marginBottom:20, background:'rgba(0,0,0,0.35)', borderRadius:8,
              border:'1px solid rgba(99,102,241,0.3)', padding:16 }}>
              <div style={{ fontSize:11, fontWeight:700, color:'rgba(255,255,255,0.4)', letterSpacing:1.2, textTransform:'uppercase', marginBottom:12 }}>
                Fix Match — Search TMDB
              </div>
              <div style={{ display:'flex', gap:8, marginBottom:12 }}>
                <input value={searchQ} onChange={e=>setSearchQ(e.target.value)}
                  onKeyDown={e=>e.key==='Enter'&&handleSearch()}
                  placeholder="Search TMDB..."
                  style={{ flex:1, padding:'8px 12px', background:'rgba(255,255,255,0.07)',
                    border:'1px solid rgba(255,255,255,0.15)', borderRadius:6,
                    color:'white', fontSize:13, outline:'none' }}/>
                <button onClick={handleSearch} disabled={searching}
                  style={{ padding:'8px 16px', background:'var(--accent)', color:'white',
                    border:'none', borderRadius:6, cursor:'pointer', fontSize:13, fontWeight:600 }}>
                  {searching ? '…' : 'Search'}
                </button>
                <button onClick={()=>setShowFixMatch(false)}
                  style={{ padding:'8px 12px', background:'rgba(255,255,255,0.06)', color:'rgba(255,255,255,0.5)',
                    border:'1px solid rgba(255,255,255,0.1)', borderRadius:6, cursor:'pointer', fontSize:13 }}>
                  Cancel
                </button>
              </div>
              {searchResults.map(r => (
                <div key={r.id} onClick={()=>handleFixMatch(r.id)}
                  style={{ display:'flex', gap:12, padding:'8px 10px', borderRadius:6, cursor:'pointer',
                    background:'rgba(255,255,255,0.04)', border:'1px solid rgba(255,255,255,0.07)', marginBottom:6 }}
                  onMouseEnter={e=>e.currentTarget.style.background='rgba(255,255,255,0.1)'}
                  onMouseLeave={e=>e.currentTarget.style.background='rgba(255,255,255,0.04)'}>
                  {r.poster
                    ? <img src={r.poster} alt={r.title} style={{ width:36, borderRadius:4, flexShrink:0, objectFit:'cover' }}/>
                    : <div style={{ width:36, height:52, borderRadius:4, background:'#2a2a3e', flexShrink:0, display:'flex', alignItems:'center', justifyContent:'center' }}>🎬</div>
                  }
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:13, fontWeight:700, color:'white' }}>{r.title} {r.year ? `(${r.year})` : ''}</div>
                    {r.rating && <div style={{ fontSize:11, color:'rgba(255,255,255,0.4)' }}>★ {r.rating}</div>}
                    {r.overview && <div style={{ fontSize:11, color:'rgba(255,255,255,0.35)', marginTop:3, overflow:'hidden', display:'-webkit-box', WebkitLineClamp:2, WebkitBoxOrient:'vertical' }}>{r.overview}</div>}
                  </div>
                  <div style={{ flexShrink:0, alignSelf:'center', fontSize:11, color:'var(--accent)', fontWeight:600, paddingLeft:8 }}>Select</div>
                </div>
              ))}
            </div>
          )}

          {/* Overview */}
          {item.overview && (
            <p style={{ fontSize:13, color:'rgba(255,255,255,0.6)', lineHeight:1.8, marginBottom:20, maxWidth:700 }}>
              {item.overview}
            </p>
          )}

          {/* Where to Watch */}
          {(item.watchProviders||[]).length > 0 && (
            <div style={{ marginBottom:20 }}>
              <div style={{ fontSize:11, fontWeight:700, color:'rgba(255,255,255,0.35)', letterSpacing:1.5, textTransform:'uppercase', marginBottom:10 }}>Also Available On</div>
              <div style={{ display:'flex', gap:10, flexWrap:'wrap' }}>
                {(item.watchProviders||[]).slice(0,8).map(provider => {
                  const COLORS = { 'Netflix':'#E50914','Disney+':'#113CCF','Max':'#002BE7','HBO Max':'#002BE7','Hulu':'#1CE783','Amazon Prime Video':'#00A8E1','Prime Video':'#00A8E1','Apple TV+':'#1c1c1e','Peacock':'#000','Paramount+':'#0064FF','Tubi TV':'#FA5714','Crunchyroll':'#F47521','Plex':'#E5A00D' };
                  const bg = COLORS[provider]||'#2a2a3e';
                  const light = bg==='#1CE783'||bg==='#E5A00D';
                  return (
                    <span key={provider} style={{ padding:'4px 12px', borderRadius:5, fontSize:11, fontWeight:700,
                      background:bg, color:light?'#000':'#fff', border:'1px solid rgba(255,255,255,0.1)' }}>
                      {provider}
                    </span>
                  );
                })}
              </div>
            </div>
          )}

          {/* Technical info */}
          <div style={{ display:'flex', gap:20, marginBottom:20, flexWrap:'wrap' }}>
            {[
              item.ext       && { label:'Format', val: item.ext.replace('.','').toUpperCase() },
              item.audioCodec && { label:'Audio',  val: item.audioCodec },
              item.videoCodec && { label:'Video',  val: item.videoCodec.toUpperCase() },
              item.size       && { label:'Size',   val: fmtSize(item.size) },
            ].filter(Boolean).map(({label,val}) => (
              <div key={label}>
                <div style={{ fontSize:9, fontWeight:700, color:'rgba(255,255,255,0.3)', letterSpacing:1.2, textTransform:'uppercase', marginBottom:2 }}>{label}</div>
                <div style={{ fontSize:12, color:'rgba(255,255,255,0.6)' }}>{val}</div>
              </div>
            ))}
          </div>

          {/* Cast & Crew */}
          {cast.length > 0 && (
            <div style={{ marginBottom:28 }}>
              <div style={{ fontSize:11, fontWeight:700, color:'rgba(255,255,255,0.35)', letterSpacing:1.5, textTransform:'uppercase', marginBottom:14 }}>Cast &amp; Crew</div>
              <div style={{ display:'flex', gap:14, overflowX:'scroll', overflowY:'visible', paddingBottom:10, paddingTop:4, scrollbarWidth:'thin', scrollbarColor:'rgba(255,255,255,0.2) transparent', WebkitOverflowScrolling:'touch' }}>
                {cast.map((c,i) => (
                  <div key={i} style={{ flexShrink:0, textAlign:'center', width:76 }}>
                    <div style={{ width:76, height:76, borderRadius:'50%', overflow:'hidden',
                      background:'#2a2a3e', border:'2px solid rgba(255,255,255,0.1)', marginBottom:6 }}>
                      {c.image
                        ? <img src={c.image} alt={c.name} style={{ width:'100%', height:'100%', objectFit:'cover' }}/>
                        : <div style={{ width:'100%', height:'100%', display:'flex', alignItems:'center', justifyContent:'center',
                            fontSize:18, fontWeight:700, color:'rgba(255,255,255,0.4)' }}>
                            {c.name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase()}
                          </div>
                      }
                    </div>
                    <div style={{ fontSize:10, fontWeight:600, color:'rgba(255,255,255,0.75)', lineHeight:1.3, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', maxWidth:76 }}>{c.name}</div>
                    {c.character && <div style={{ fontSize:9, color:'rgba(255,255,255,0.35)', marginTop:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', maxWidth:76 }}>{c.character}</div>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Extras */}
          {extras.length > 0 && (
            <div style={{ marginBottom:28 }}>
              <div style={{ fontSize:11, fontWeight:700, color:'rgba(255,255,255,0.35)', letterSpacing:1.5, textTransform:'uppercase', marginBottom:14 }}>Extras</div>
              {Object.entries(extrasByLabel).map(([label,items]) => (
                <div key={label} style={{ marginBottom:18 }}>
                  <div style={{ fontSize:11, color:'rgba(255,255,255,0.4)', marginBottom:10 }}>{label}</div>
                  <div style={{ display:'flex', gap:12, overflowX:'auto', paddingBottom:6 }}>
                    {items.map((ex,i) => (
                      <div key={i} onClick={()=>{ playMedia({...item, filePath:ex.filePath, fileName:ex.fileName, title:ex.title}); onClose(); }}
                        style={{ flexShrink:0, width:180, cursor:'pointer' }}>
                        <div style={{ height:102, background:'#111', borderRadius:6, border:'1px solid rgba(255,255,255,0.08)',
                          display:'flex', alignItems:'center', justifyContent:'center', marginBottom:7 }}>
                          <div style={{ width:38, height:38, borderRadius:'50%', background:'rgba(255,255,255,0.12)',
                            display:'flex', alignItems:'center', justifyContent:'center' }}>
                            <Play size={16} fill="white" color="white"/>
                          </div>
                        </div>
                        <div style={{ fontSize:12, fontWeight:600, color:'rgba(255,255,255,0.75)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{ex.title}</div>
                        <div style={{ fontSize:10, color:'rgba(255,255,255,0.35)', marginTop:2 }}>{label}</div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Versions */}
          {versions.length > 1 && (
            <div style={{ marginBottom:20 }}>
              <div style={{ fontSize:11, fontWeight:700, color:'rgba(255,255,255,0.35)', letterSpacing:1.5, textTransform:'uppercase', marginBottom:10 }}>Versions</div>
              {versions.map((v,i) => (
                <div key={i} onClick={()=>setActiveVersion(v.filePath)}
                  style={{ padding:'8px 12px', borderRadius:6, cursor:'pointer', marginBottom:4,
                    background: activeVersion===v.filePath ? 'rgba(99,102,241,0.2)' : 'rgba(255,255,255,0.04)',
                    border:`1px solid ${activeVersion===v.filePath ? 'rgba(99,102,241,0.5)' : 'rgba(255,255,255,0.08)'}`,
                    display:'flex', alignItems:'center', justifyContent:'space-between' }}>
                  <span style={{ fontFamily:'monospace', fontSize:11, color:'rgba(255,255,255,0.6)' }}>{v.fileName}</span>
                  <div style={{ display:'flex', gap:8, alignItems:'center' }}>
                    {v.size > 0 && <span style={{ fontSize:11, color:'rgba(255,255,255,0.3)' }}>{fmtSize(v.size)}</span>}
                    {activeVersion===v.filePath && <span style={{ color:'#818cf8' }}>✓</span>}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* File info */}
          <div style={{ background:'rgba(0,0,0,0.3)', borderRadius:6, padding:'10px 14px',
            border:'1px solid rgba(255,255,255,0.06)', fontSize:11, display:'flex', gap:20, flexWrap:'wrap' }}>
            {[
              { label:'File', val: item.fileName },
              { label:'Location', val: item.filePath?.length>55 ? '...'+item.filePath.slice(-55) : item.filePath },
              item.album && { label:'Album', val: item.album },
            ].filter(Boolean).map(({label,val}) => (
              <div key={label}>
                <div style={{ fontSize:9, fontWeight:700, color:'rgba(255,255,255,0.25)', letterSpacing:1, textTransform:'uppercase', marginBottom:2 }}>{label}</div>
                <div style={{ color:'rgba(255,255,255,0.45)', fontFamily:'monospace', fontSize:10 }}>{val}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <audio ref={audioRef}/>
    </div>
  );
}

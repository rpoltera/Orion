import React, { useState, useEffect, useMemo } from 'react';
import { useApp } from '../contexts/AppContext';
import { FolderOpen, Search, RefreshCw } from 'lucide-react';

const API = 'http://localhost:3001/api';

const MIME_TYPES = {
  '.mp4':'video/mp4', '.mkv':'video/x-matroska', '.avi':'video/x-msvideo',
  '.mov':'video/quicktime', '.wmv':'video/x-ms-wmv', '.webm':'video/webm',
  '.m4v':'video/mp4', '.ts':'video/mp2t', '.m2ts':'video/mp2t',
  '.mp3':'audio/mpeg', '.flac':'audio/flac', '.m4a':'audio/mp4',
  '.aac':'audio/aac', '.ogg':'audio/ogg', '.wav':'audio/wav',
  '.jpg':'image', '.jpeg':'image', '.png':'image', '.gif':'image',
  '.webp':'image', '.bmp':'image',
  '.pdf':'document', '.epub':'document', '.mobi':'document',
  '.cbr':'document', '.cbz':'document', '.txt':'document', '.docx':'document',
};

function isVideo(ext) { return ['.mp4','.mkv','.avi','.mov','.wmv','.webm','.m4v','.ts','.m2ts','.mpg','.mpeg','.flv'].includes(ext); }
function isImage(ext) { return ['.jpg','.jpeg','.png','.gif','.webp','.bmp'].includes(ext); }
function isAudio(ext) { return ['.mp3','.flac','.m4a','.aac','.ogg','.wav','.opus','.wma'].includes(ext); }
function isDoc(ext)   { return ['.pdf','.epub','.mobi','.cbr','.cbz','.txt','.docx'].includes(ext); }

export default function CustomLibraryPage({ library: lib }) {
  const { playMedia } = useApp();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('title');
  const [scanning, setScanning] = useState(false);
  const [lightboxItem, setLightboxItem] = useState(null);

  useEffect(() => {
    if (!lib) return;
    setLoading(true);
    fetch(`${API}/custom-libraries/${lib.id}/items`)
      .then(r => r.json())
      .then(data => { setItems(Array.isArray(data) ? data : []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [lib?.id]);

  const filtered = useMemo(() => {
    let list = search ? items.filter(i => i.title.toLowerCase().includes(search.toLowerCase()) || i.fileName.toLowerCase().includes(search.toLowerCase())) : items;
    return [...list].sort((a, b) => {
      if (sortBy === 'name')  return (a.title||'').localeCompare(b.title||'');
      if (sortBy === 'size')  return (b.size||0) - (a.size||0);
      if (sortBy === 'added') return new Date(b.addedAt) - new Date(a.addedAt);
      return (a.title||'').localeCompare(b.title||'');
    });
  }, [items, search, sortBy]);

  const handleScan = async () => {
    setScanning(true);
    const res = await fetch(`${API}/custom-libraries/${lib.id}/scan`, { method: 'POST' });
    const data = await res.json();
    // Reload items
    const itemsRes = await fetch(`${API}/custom-libraries/${lib.id}/items`).then(r => r.json());
    setItems(Array.isArray(itemsRes) ? itemsRes : []);
    setScanning(false);
  };

  const handleItemClick = (item) => {
    if (isVideo(item.ext) || isAudio(item.ext)) {
      playMedia({ ...item, title: item.title || item.fileName });
    } else if (isImage(item.ext)) {
      setLightboxItem(item);
    } else {
      // For docs, open via Electron shell or show info
      window.electron?.shell?.openPath?.(item.filePath);
    }
  };

  if (!lib) return null;

  return (
    <div className="page">
      <div className="page-header">
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
          <div style={{ display:'flex', alignItems:'center', gap:12 }}>
            <span style={{ fontSize:28 }}>{lib.icon}</span>
            <div>
              <div className="page-title">{lib.name}</div>
              <div className="page-subtitle">{filtered.length} items</div>
            </div>
          </div>
          <button className="btn btn-secondary btn-sm" onClick={handleScan} disabled={scanning}>
            <RefreshCw size={13} style={{ animation: scanning ? 'spin 1s linear infinite' : 'none' }} /> {scanning ? 'Scanning…' : 'Rescan'}
          </button>
        </div>

        {/* Controls */}
        <div style={{ display:'flex', alignItems:'center', gap:12, marginTop:16, flexWrap:'wrap' }}>
          <div style={{ position:'relative', flex:'0 0 220px' }}>
            <Search size={13} style={{ position:'absolute', left:10, top:'50%', transform:'translateY(-50%)', color:'var(--text-muted)' }} />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search..."
              style={{ width:'100%', padding:'6px 10px 6px 30px', background:'var(--bg-tertiary)', border:'1px solid var(--border)', borderRadius:'var(--radius)', color:'var(--text-primary)', fontSize:13, boxSizing:'border-box', outline:'none' }} />
          </div>
          <div style={{ display:'flex', gap:6 }}>
            {[['title','Name'],['size','Size'],['added','Date Added']].map(([val,label]) => (
              <button key={val} onClick={() => setSortBy(val)}
                style={{ padding:'4px 12px', borderRadius:16, border:'none', cursor:'pointer', fontSize:12, fontWeight:600,
                  background: sortBy === val ? 'var(--accent)' : 'var(--bg-tertiary)',
                  color: sortBy === val ? 'white' : 'var(--text-muted)' }}>
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {loading ? (
        <div style={{ padding:'48px', textAlign:'center', color:'var(--text-muted)' }}>Loading…</div>
      ) : items.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">{lib.icon}</div>
          <h3>No items in {lib.name}</h3>
          <p>Add folders in Settings → Custom Libraries, then click Rescan.</p>
          <button className="btn btn-primary" onClick={handleScan}><RefreshCw size={14}/> Scan Now</button>
        </div>
      ) : (
        <div style={{ padding:'0 48px 48px' }}>
          <div className="media-grid" style={{ gridTemplateColumns:'repeat(auto-fill, minmax(160px, 1fr))' }}>
            {filtered.map(item => {
              const ext = item.ext?.toLowerCase();
              const isImg = isImage(ext);
              const isVid = isVideo(ext);
              const isAud = isAudio(ext);
              const thumbUrl = item.thumbnail ? (item.thumbnail.startsWith('http') ? item.thumbnail : `http://localhost:3001${item.thumbnail}`) : null;
              const imgUrl = isImg ? `http://localhost:3001/api/localimage?path=${encodeURIComponent(item.filePath)}` : null;
              const displayUrl = thumbUrl || imgUrl;
              const icon = isVid ? '🎬' : isAud ? '🎵' : isImg ? '🖼️' : isDoc(ext) ? '📄' : '📁';

              return (
                <div key={item.id} onClick={() => handleItemClick(item)}
                  style={{ cursor:'pointer', borderRadius:10, overflow:'hidden', background:'var(--bg-card)', border:'1px solid var(--border)', transition:'transform 0.15s, border-color 0.15s' }}
                  onMouseEnter={e => { e.currentTarget.style.transform='translateY(-4px)'; e.currentTarget.style.borderColor=lib.color||'var(--accent)'; }}
                  onMouseLeave={e => { e.currentTarget.style.transform='translateY(0)'; e.currentTarget.style.borderColor='var(--border)'; }}>
                  <div style={{ aspectRatio: isImg ? '4/3' : '2/3', background:'#111', overflow:'hidden', display:'flex', alignItems:'center', justifyContent:'center' }}>
                    {displayUrl
                      ? <img src={displayUrl} alt={item.title} style={{ width:'100%', height:'100%', objectFit:'cover' }} loading="lazy" />
                      : <span style={{ fontSize:40, opacity:0.4 }}>{icon}</span>
                    }
                  </div>
                  <div style={{ padding:'8px 10px' }}>
                    <div style={{ fontWeight:700, fontSize:12, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{item.title}</div>
                    <div style={{ fontSize:10, color:'var(--text-muted)', marginTop:2 }}>
                      {ext?.replace('.','').toUpperCase()} {item.size ? `· ${(item.size/1024/1024).toFixed(0)}MB` : ''}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Image lightbox */}
      {lightboxItem && (
        <div onClick={() => setLightboxItem(null)}
          style={{ position:'fixed', inset:0, zIndex:99999, background:'rgba(0,0,0,0.92)', display:'flex', alignItems:'center', justifyContent:'center', cursor:'pointer' }}>
          <img src={`http://localhost:3001/api/localimage?path=${encodeURIComponent(lightboxItem.filePath)}`}
            alt={lightboxItem.title}
            style={{ maxWidth:'90vw', maxHeight:'90vh', objectFit:'contain', borderRadius:8 }} />
          <button onClick={() => setLightboxItem(null)}
            style={{ position:'absolute', top:20, right:20, background:'rgba(255,255,255,0.1)', border:'none', color:'white', width:40, height:40, borderRadius:'50%', fontSize:20, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center' }}>✕</button>
        </div>
      )}
    </div>
  );
}

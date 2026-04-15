import React, { useState, useEffect } from 'react';
import { useApp } from '../contexts/AppContext';
import MediaCard from '../components/MediaCard';
import { Grid, ChevronLeft, Zap, Plus, Trash2 } from 'lucide-react';

const BASE = 'http://localhost:3001/api';
const resolveImg = (url) => {
  if (!url) return null;
  if (url.startsWith('http')) return url;
  if (url.startsWith('/api')) return `http://localhost:3001${url}`;
  return null;
};

const TYPE_COLORS = {
  'manual':       { bg: 'rgba(0,99,229,0.15)',   color: '#4da3ff',  label: 'Manual' },
  'franchise':    { bg: 'rgba(0,99,229,0.15)',   color: '#60a5fa',  label: 'Collection' },
  'auto-genre':   { bg: 'rgba(16,185,129,0.15)', color: '#34d399',  label: 'Genre' },
  'auto-decade':  { bg: 'rgba(139,92,246,0.15)', color: '#a78bfa',  label: 'Decade' },
  'auto-year':    { bg: 'rgba(245,158,11,0.15)', color: '#fbbf24',  label: 'Year' },
  'auto-rating':  { bg: 'rgba(239,68,68,0.15)',  color: '#f87171',  label: 'Top Rated' },
};

export default function CollectionsPage({ onSelect }) {
  const [collections, setCollections] = useState([]);
  const [selected, setSelected] = useState(null);
  const [items, setItems] = useState([]);
  const [loadingItems, setLoadingItems] = useState(false);
  const [running, setRunning] = useState(false);
  const [filter, setFilter] = useState('All');

  useEffect(() => { fetchCollections(); }, []);

  const fetchCollections = async () => {
    try {
      const res = await fetch(`${BASE}/collections`);
      const data = await res.json();
      setCollections(data.collections || []);
    } catch (e) {}
  };

  const openCollection = async (col) => {
    setSelected(col);
    setLoadingItems(true);
    try {
      const res = await fetch(`${BASE}/collections/${col.id}`);
      const data = await res.json();
      setItems(data.items || []);
    } catch (e) { setItems([]); }
    finally { setLoadingItems(false); }
  };

  const deleteCollection = async (id, e) => {
    e.stopPropagation();
    if (!window.confirm('Delete this collection?')) return;
    await fetch(`${BASE}/collections/${id}`, { method: 'DELETE' });
    setCollections(prev => prev.filter(c => c.id !== id));
    if (selected?.id === id) setSelected(null);
  };

  const runAutoBuilder = async () => {
    setRunning(true);
    try {
      await fetch(`${BASE}/autocollections/run`, { method: 'POST' });
      // Poll until done
      let tries = 0;
      const poll = setInterval(async () => {
        tries++;
        await fetchCollections();
        if (tries >= 8) { clearInterval(poll); setRunning(false); }
      }, 1500);
    } catch (e) { setRunning(false); }
  };

  const types = ['All', 'franchise', 'auto-genre', 'auto-decade', 'manual'];
  const typeLabels = { 'franchise': '🎬 Collections', 'auto-genre': '🏷 Genre', 'auto-decade': '📅 Decade', 'manual': '📁 Manual', 'All': 'All' };
  const availableTypes = types.filter(t => t === 'All' || collections.some(c => c.type === t));
  const filtered = collections
    .filter(c => filter === 'All' || c.type === filter)
    .sort((a, b) => {
      // Franchise collections first
      if (a.type === 'franchise' && b.type !== 'franchise') return -1;
      if (b.type === 'franchise' && a.type !== 'franchise') return 1;
      return (b.mediaIds?.length || 0) - (a.mediaIds?.length || 0);
    });

  // ── Collection detail view ───────────────────────────────────────────────
  if (selected) {
    const typeStyle = TYPE_COLORS[selected.type] || TYPE_COLORS['manual'];
    return (
      <div className="page">
        <div style={{ padding: '32px 48px 0' }}>
          <button onClick={() => setSelected(null)} style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 13, display: 'flex', alignItems: 'center', gap: 4, marginBottom: 20, padding: 0 }}>
            <ChevronLeft size={16} /> All Collections
          </button>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 20, marginBottom: 28 }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 32, fontWeight: 800 }}>{selected.name}</h1>
                <span style={{ padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700, background: typeStyle.bg, color: typeStyle.color }}>{typeStyle.label}</span>
              </div>
              {selected.description && <p style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 8 }}>{selected.description}</p>}
              <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>{items.length} titles</div>
            </div>
          </div>
        </div>

        {loadingItems ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200 }}>
            <div style={{ width: 36, height: 36, border: '3px solid var(--bg-tertiary)', borderTop: '3px solid var(--accent)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
            <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
          </div>
        ) : items.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">📭</div>
            <h3>No items in this collection</h3>
            <p>Run the auto-builder or add items manually.</p>
          </div>
        ) : (
          <div className="media-grid">
            {items.map(item => <MediaCard key={item.id} item={item} onClick={onSelect} />)}
          </div>
        )}
      </div>
    );
  }

  // ── Collections grid ─────────────────────────────────────────────────────
  return (
    <div className="page">
      <div className="page-header">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div className="page-title">📚 Collections</div>
            <div className="page-subtitle">{collections.length} collections</div>
          </div>
          <button className="btn btn-primary" onClick={runAutoBuilder} disabled={running} style={{ gap: 8 }}>
            {running
              ? <><span style={{ display: 'inline-block', width: 14, height: 14, border: '2px solid rgba(255,255,255,0.3)', borderTop: '2px solid white', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} /> Building...</>
              : <><Zap size={14} /> Build Auto Collections</>}
          </button>
        </div>
      </div>

      {/* Type filter chips */}
      <div className="filter-bar">
        {availableTypes.map(t => (
          <button key={t} className={`filter-chip ${filter === t ? 'active' : ''}`} onClick={() => setFilter(t)}>
            {t === 'All' ? 'All' : TYPE_COLORS[t]?.label || t}
          </button>
        ))}
      </div>

      {collections.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">📚</div>
          <h3>No collections yet</h3>
          <p>Click "Build Auto Collections" to automatically generate genre, decade, and rating collections from your library.</p>
          <button className="btn btn-primary" onClick={runAutoBuilder} disabled={running}><Zap size={16} /> Build Now</button>
        </div>
      ) : (
        <div style={{ padding: '0 48px 48px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 16 }}>
          {filtered.map(col => {
            const typeStyle = TYPE_COLORS[col.type] || TYPE_COLORS['manual'];
            const posterUrl = resolveImg(col.thumbnail || col.poster);
            return (
              <div key={col.id} onClick={() => openCollection(col)}
                style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', overflow: 'hidden', cursor: 'pointer', transition: 'all 0.2s', position: 'relative' }}
                onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-4px)'; e.currentTarget.style.borderColor = 'var(--accent)'; }}
                onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.borderColor = 'var(--border)'; }}>

                {/* Collection art / gradient */}
                <div style={{ height: 120, background: posterUrl ? `url(${posterUrl}) center/cover` : `linear-gradient(135deg, ${typeStyle.bg}, var(--bg-tertiary))`, position: 'relative' }}>
                  <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to bottom, transparent 40%, rgba(0,0,0,0.7) 100%)' }} />
                  {/* Type badge */}
                  <div style={{ position: 'absolute', top: 10, left: 10, padding: '3px 8px', borderRadius: 12, fontSize: 10, fontWeight: 700, background: typeStyle.bg, color: typeStyle.color, border: `1px solid ${typeStyle.color}40` }}>
                    {typeStyle.label}
                  </div>
                  {/* Delete button */}
                  <button onClick={(e) => deleteCollection(col.id, e)}
                    style={{ position: 'absolute', top: 8, right: 8, background: 'rgba(0,0,0,0.6)', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', width: 28, height: 28, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0, transition: 'opacity 0.2s' }}
                    onMouseEnter={e => e.currentTarget.style.opacity = '1'}
                    onMouseLeave={e => e.currentTarget.style.opacity = '0'}>
                    <Trash2 size={13} />
                  </button>
                  {/* Item count */}
                  <div style={{ position: 'absolute', bottom: 8, right: 10, fontSize: 12, color: 'rgba(255,255,255,0.8)', fontWeight: 600 }}>
                    {col.mediaIds?.length || 0} titles
                  </div>
                </div>

                <div style={{ padding: '12px 14px' }}>
                  <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{col.name}</div>
                  {col.description && <div style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{col.description}</div>}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

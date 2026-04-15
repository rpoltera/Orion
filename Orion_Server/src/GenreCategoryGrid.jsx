import React, { useState, useRef, useCallback } from 'react';
import { Camera, X, Pencil, Check } from 'lucide-react';

// Default emoji map shared across Movies + TV
const GENRE_EMOJI = {
  'Action':       '💥', 'Comedy':      '😂', 'Drama':         '🎭',
  'Animation':    '🎨', 'Adventure':   '🗺', 'Crime':         '🔍',
  'Mystery':      '🕵️', 'Horror':      '👻', 'Romance':       '❤️',
  'Documentary':  '🎬', 'Fantasy':     '🧙', 'Sci-Fi':        '🚀',
  'Thriller':     '😱', 'Family':      '👨‍👩‍👧', 'History':       '📜',
  'Biography':    '📖', 'Reality-TV':  '📺', 'Talk-Show':     '🎙',
  'Music':        '🎵', 'Sport':       '⚽', 'Western':       '🤠',
  'Children':     '🧸', 'News':        '📰', 'Musical':       '🎼',
  'Science Fiction': '🚀', 'Game Show': '🎮', 'Game-Show':   '🎮',
  'Home and Garden': '🏡', 'Suspense':  '🔦', 'Short':        '⏱',
};

const STORAGE_KEY = (mediaType, name) =>
  `orion_cat_art_${mediaType}_${name.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '')}`;

function useArt(mediaType) {
  const [, forceUpdate] = useState(0);

  const getArt = useCallback((name) => {
    try { return localStorage.getItem(STORAGE_KEY(mediaType, name)) || null; }
    catch { return null; }
  }, [mediaType]);

  const setArt = useCallback((name, dataUrl) => {
    try {
      if (dataUrl) localStorage.setItem(STORAGE_KEY(mediaType, name), dataUrl);
      else         localStorage.removeItem(STORAGE_KEY(mediaType, name));
      forceUpdate(n => n + 1);
    } catch (e) {
      alert('Image too large for localStorage. Try a smaller/compressed image.');
    }
  }, [mediaType]);

  return { getArt, setArt };
}

// Individual genre tile
function GenreTile({ genre, mediaType, label, editMode, onClick, getArt, setArt }) {
  const fileRef    = useRef(null);
  const [hover, setHover] = useState(false);
  const art = getArt(genre.name);
  const emoji = GENRE_EMOJI[genre.name] || (mediaType === 'tvShows' ? '📺' : '🎬');

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) { alert('Please select an image file.'); return; }
    const reader = new FileReader();
    reader.onload = (ev) => setArt(genre.name, ev.target.result);
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const handleClick = () => {
    if (editMode) { fileRef.current?.click(); return; }
    onClick(genre);
  };

  const handleRemove = (e) => {
    e.stopPropagation();
    setArt(genre.name, null);
  };

  return (
    <div
      onClick={handleClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: 'relative',
        borderRadius: 'var(--radius-lg)',
        overflow: 'hidden',
        cursor: 'pointer',
        border: `1px solid ${hover ? 'var(--border-accent)' : 'var(--border)'}`,
        transition: 'all 0.2s',
        transform: hover ? 'translateY(-3px)' : 'none',
        boxShadow: hover ? '0 8px 24px rgba(0,0,0,0.4)' : 'none',
        background: 'var(--bg-card)',
        // Fixed height for consistent grid
        height: 140,
      }}
    >
      {/* Art or emoji background */}
      {art ? (
        <>
          <img
            src={art}
            alt={genre.name}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'center' }}
          />
          {/* Dark gradient overlay for text legibility */}
          <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to top, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0.3) 50%, rgba(0,0,0,0.15) 100%)' }} />
        </>
      ) : (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 40, opacity: hover ? 0.9 : 0.65, transition: 'opacity 0.2s' }}>
          {emoji}
        </div>
      )}

      {/* Text */}
      <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, padding: '10px 14px' }}>
        <div style={{ fontWeight: 700, fontSize: 14, color: 'white', textShadow: '0 1px 4px rgba(0,0,0,0.8)', marginBottom: 2 }}>{genre.name}</div>
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', textShadow: '0 1px 3px rgba(0,0,0,0.8)' }}>
          {(genre.mediaIds?.length || 0).toLocaleString()} {label}
        </div>
      </div>

      {/* Edit mode overlay */}
      {editMode && (
        <div style={{
          position: 'absolute', inset: 0,
          background: hover ? 'rgba(0,0,0,0.55)' : 'rgba(0,0,0,0.3)',
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          gap: 6, transition: 'background 0.2s',
          border: '2px dashed rgba(255,255,255,0.3)',
          borderRadius: 'var(--radius-lg)',
        }}>
          <Camera size={20} color="white" style={{ opacity: hover ? 1 : 0.7 }} />
          <span style={{ fontSize: 11, color: 'white', fontWeight: 600, opacity: hover ? 1 : 0.7 }}>
            {art ? 'Replace Image' : 'Upload Image'}
          </span>
        </div>
      )}

      {/* Remove button (shows on hover when art exists and in edit mode) */}
      {editMode && art && hover && (
        <button
          onClick={handleRemove}
          title="Remove custom art"
          style={{
            position: 'absolute', top: 6, right: 6, zIndex: 10,
            width: 24, height: 24, borderRadius: '50%',
            background: 'rgba(239,68,68,0.9)', border: 'none',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer', color: 'white',
          }}
        >
          <X size={12} />
        </button>
      )}

      {/* Has art indicator (non-edit mode) */}
      {!editMode && art && (
        <div style={{ position: 'absolute', top: 8, right: 8, width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)', boxShadow: '0 0 6px var(--accent)' }} />
      )}

      <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleFileChange} />
    </div>
  );
}

// ── Main exported component ───────────────────────────────────────────────────
export default function GenreCategoryGrid({ genres, mediaType, itemLabel = 'items', onSelect }) {
  const [editMode, setEditMode] = useState(false);
  const { getArt, setArt } = useArt(mediaType);

  const customCount = genres.filter(g => getArt(g.name)).length;

  return (
    <div>
      {/* Header bar */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          {genres.length} categories
          {customCount > 0 && <span style={{ marginLeft: 8, color: 'var(--accent)', fontSize: 11 }}>· {customCount} customized</span>}
        </div>
        <button
          onClick={() => setEditMode(m => !m)}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '6px 14px', borderRadius: 'var(--radius)',
            border: `1px solid ${editMode ? 'var(--accent)' : 'var(--border)'}`,
            background: editMode ? 'rgba(var(--accent-rgb, 99,102,241), 0.15)' : 'var(--bg-card)',
            color: editMode ? 'var(--accent)' : 'var(--text-secondary)',
            cursor: 'pointer', fontSize: 12, fontWeight: 600, transition: 'all 0.2s',
          }}
        >
          {editMode ? <><Check size={13} /> Done Editing</> : <><Pencil size={13} /> Customize Art</>}
        </button>
      </div>

      {/* Edit mode hint */}
      {editMode && (
        <div style={{
          marginBottom: 16, padding: '10px 14px',
          background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)',
          borderRadius: 'var(--radius)', fontSize: 12, color: 'var(--text-muted)',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <Camera size={14} />
          Click any tile to upload a custom image · Click the red ✕ to remove · JPG, PNG, or WebP recommended
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12 }}>
        {genres.map(g => (
          <GenreTile
            key={g.id}
            genre={g}
            mediaType={mediaType}
            label={itemLabel}
            editMode={editMode}
            onClick={onSelect}
            getArt={getArt}
            setArt={setArt}
          />
        ))}
      </div>
    </div>
  );
}

import React, { useState } from 'react';
import { useApp } from '../contexts/AppContext';
import { Film, Tv, Music, Video } from 'lucide-react';

const BASE = 'http://localhost:3001';

const resolveImg = (url) => {
  if (!url) return null;
  if (url.startsWith('http')) return url;
  if (url.startsWith('/api')) return `${BASE}${url}`;
  if (url.startsWith('\\\\') || url.startsWith('//')) return `${BASE}/api/localimage?path=${encodeURIComponent(url)}`;
  return null;
};

const RATING_COLORS = {
  'G':'#22c55e','PG':'#84cc16','PG-13':'#f59e0b','R':'#ef4444','NC-17':'#7c3aed',
  'TV-Y':'#22c55e','TV-Y7':'#84cc16','TV-G':'#22c55e','TV-PG':'#84cc16',
  'TV-14':'#f59e0b','TV-MA':'#ef4444',
};

const STREAMING_COLORS = {
  'Netflix':'#e50914','Disney+':'#113ccf','Hulu':'#1ce783','Max':'#002be7',
  'HBO Max':'#002be7','Prime Video':'#00a8e1','Amazon Prime Video':'#00a8e1',
  'Apple TV+':'#555','Peacock':'#000','Paramount+':'#0064ff',
  'Tubi':'#fa5714','Tubi TV':'#fa5714','Plex':'#e5a00d','Pluto TV':'#000099',
  'The Roku Channel':'#6c1d45','Shudder':'#0f0f0f','Starz':'#000',
  'Showtime':'#cc0000','Discovery+':'#0071eb','Crunchyroll':'#f47521',
  'YouTube TV':'#ff0000','fuboTV':'#fa4616','Hoopla':'#1a1a2e',
  'Fawesome':'#e63946','Philo':'#5c4ee5','Bravo':'#8b008b',
  'MTV':'#000','VH1':'#ff69b4','Hallmark':'#4a1c5c','Lifetime':'#8b0000',
  'ABC':'#000','NBC':'#fff','CBS':'#fff','Fox':'#000','FX':'#000',
  'AMC':'#000','Syfy':'#1b1b3a','Adult Swim':'#000',
  'Cartoon Network':'#fff','Nickelodeon':'#ff6d00','BBC':'#bb1919',
  'Discovery':'#005a9c',
};

// Overlay config from localStorage
const getOverlayConfig = () => {
  try { return JSON.parse(localStorage.getItem('orion_overlay_config') || '{}'); } catch { return {}; }
};

function OverlayBadge({ label, color, position, style: badgeStyle }) {
  const pos = position || 'top-left';
  const posStyle = {
    'top-left':     { top: 6, left: 6 },
    'top-right':    { top: 6, right: 6 },
    'bottom-left':  { bottom: 6, left: 6 },
    'bottom-right': { bottom: 6, right: 6 },
  }[pos] || { top: 6, left: 6 };

  const baseStyle = {
    position: 'absolute', ...posStyle,
    background: color || '#6366f1',
    color: ['#fff','#fff','#1ce783','#fff'].includes(color) && color === '#1ce783' ? '#000' : '#fff',
    fontSize: 9, fontWeight: 800, letterSpacing: 0.5,
    padding: badgeStyle === 'pill' ? '2px 7px' : '2px 5px',
    borderRadius: badgeStyle === 'pill' ? 10 : badgeStyle === 'square' ? 2 : 4,
    textTransform: 'uppercase', whiteSpace: 'nowrap',
    boxShadow: '0 1px 4px rgba(0,0,0,0.6)', zIndex: 2, pointerEvents: 'none',
  };
  return <div style={baseStyle}>{label}</div>;
}

export default function MediaCard({ item, onClick, wide }) {
  const { playMedia } = useApp();
  const [imgErr, setImgErr] = useState(false);
  if (!item) return null;

  const thumbUrl = resolveImg(item.thumbnail);
  const isVideo  = ['movies','tvShows','musicVideos'].includes(item.type);
  const isSquare = item.type === 'music';
  const posterUrl = imgErr ? null : thumbUrl;

  const cfg = getOverlayConfig();
  const overlayPos   = cfg.overlayPosition || 'top-left';
  const overlayStyle = cfg.overlayStyle    || 'rounded';
  const overlays = [];

  // Resolution — server stores as string ('1080p','4K','720p','SD')
  if (cfg.showResolution && item.resolution) {
    const res = item.resolution;
    let label = null;
    if      (res === '4K' || res === '2160p') label = '4K';
    else if (res === '1080p')                 label = 'HD';
    else if (res === '720p')                  label = '720p';
    else if (res === 'SD')                    label = 'SD';
    if (label) overlays.push({ label, color: label === '4K' ? '#a855f7' : label === 'SD' ? '#6b7280' : '#3b82f6' });
  } else if (cfg.showResolution && item.videoWidth) {
    if      (item.videoWidth >= 3840) overlays.push({ label: '4K',   color: '#a855f7' });
    else if (item.videoWidth >= 1920) overlays.push({ label: 'HD',   color: '#3b82f6' });
    else if (item.videoWidth >= 1280) overlays.push({ label: '720p', color: '#0ea5e9' });
  }

  // HDR
  if (cfg.showHDR && (item.isHDR || item.hdr)) {
    overlays.push({ label: typeof item.hdr === 'string' ? item.hdr : 'HDR', color: '#f59e0b' });
  }

  // Audio
  if (cfg.showAudioCodec && item.audioCodec) {
    const a = item.audioCodec.toLowerCase();
    if      (a.includes('atmos'))            overlays.push({ label: 'Atmos',  color: '#06b6d4' });
    else if (a.includes('truehd'))           overlays.push({ label: 'TrueHD', color: '#06b6d4' });
    else if (a.includes('dts-x'))            overlays.push({ label: 'DTS-X',  color: '#0ea5e9' });
    else if (a.includes('dts-ma')||a.includes('dtsma')) overlays.push({ label: 'DTS-MA', color: '#0ea5e9' });
    else if (a.includes('dts'))              overlays.push({ label: 'DTS',    color: '#0ea5e9' });
    else if (a.includes('eac3')||a.includes('e-ac3'))   overlays.push({ label: 'E-AC3',  color: '#8b5cf6' });
  }

  // Content rating
  if (cfg.showContentRating && item.contentRating) {
    overlays.push({ label: item.contentRating, color: RATING_COLORS[item.contentRating] || '#6b7280' });
  }

  // NEW badge
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  if (cfg.showNew && item.addedAt && new Date(item.addedAt).getTime() > thirtyDaysAgo) {
    overlays.push({ label: 'NEW', color: '#10b981' });
  }

  // Video codec
  if (cfg.showVideoCodec && item.videoCodec) {
    const v = item.videoCodec.toLowerCase();
    if      (v.includes('hevc')||v.includes('h265')||v.includes('x265')) overlays.push({ label: 'HEVC', color: '#8b5cf6' });
    else if (v.includes('av1'))   overlays.push({ label: 'AV1',  color: '#10b981' });
    else if (v.includes('h264')||v.includes('avc'))                       overlays.push({ label: 'H264', color: '#64748b' });
  }

  // TV status
  if (cfg.showTVStatus && item.type === 'tvShows' && item.tvStatus) {
    const st = item.tvStatus;
    if (st === 'Ended')    overlays.push({ label: 'ENDED',    color: '#6b7280' });
    if (st === 'Canceled') overlays.push({ label: 'CANCELED', color: '#ef4444' });
  }

  // Edition
  if (cfg.showEdition && item.edition) {
    overlays.push({ label: item.edition, color: '#6366f1' });
  }

  // Non-streaming overlays capped at 2
  const visibleOverlays = overlays.slice(0, 2);

  // Streaming service badges — up to 5 stacked on right
  // Use watchProviders if available (detail view), else fall back to studios (library view)
  const providerSources = item.watchProviders?.length ? item.watchProviders
    : (item.studios || []).filter(s => STREAMING_COLORS[s]);
  const streamingBadges = cfg.showStreaming && providerSources.length
    ? providerSources.slice(0, 5).map(svc => ({
        label: svc.length > 8 ? svc.split(' ')[0] : svc,
        color: STREAMING_COLORS[svc] || '#6366f1',
      }))
    : [];

  const PlaceholderIcon = item.type === 'tvShows' ? Tv : item.type === 'music' ? Music : item.type === 'musicVideos' ? Video : Film;

  const handleClick = () => {
    if (onClick) onClick(item);
    else if (playMedia) playMedia(item);
  };

  return (
    <div className="media-card" onClick={handleClick}
      style={{ width: wide ? '100%' : undefined }}>
      <div className="media-card-poster"
        style={{ aspectRatio: isSquare ? '1' : wide ? '16/9' : '2/3', position: 'relative' }}>
        {posterUrl
          ? <img src={posterUrl} alt={item.title} loading="lazy" onError={() => setImgErr(true)}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          : <div className="poster-placeholder">
              <PlaceholderIcon size={28} />
              <span style={{ fontSize: 10, textAlign: 'center', padding: '0 6px', lineHeight: 1.3 }}>
                {item.seriesTitle || item.showName || item.title}
              </span>
            </div>
        }

        {/* Non-streaming overlays */}
        {visibleOverlays.map((ov, i) => (
          <OverlayBadge key={i} label={ov.label} color={ov.color}
            position={i === 0 ? overlayPos : overlayPos.includes('top') ? 'bottom-left' : 'top-left'}
            style={overlayStyle} />
        ))}

        {/* Streaming badges stacked on left under other overlays */}
        {streamingBadges.length > 0 && (
          <div style={{ position: 'absolute', top: visibleOverlays.length > 0 ? 26 : 4, left: 4, display: 'flex', flexDirection: 'column', gap: 2, zIndex: 2 }}>
            {streamingBadges.map((b, i) => (
              <div key={i} style={{
                background: b.color, color: '#fff', fontSize: 8, fontWeight: 800,
                padding: '2px 5px', borderRadius: 3, letterSpacing: 0.3,
                textTransform: 'uppercase', whiteSpace: 'nowrap',
                boxShadow: '0 1px 3px rgba(0,0,0,0.5)',
              }}>{b.label}</div>
            ))}
          </div>
        )}

        {/* Hover overlay */}
        <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0)', display: 'flex',
          alignItems: 'center', justifyContent: 'center', transition: 'background 0.2s' }}
          onMouseEnter={e => { e.currentTarget.style.background = 'rgba(0,0,0,0.45)'; const pb = e.currentTarget.querySelector('.pb'); if (pb) pb.style.opacity = '1'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'rgba(0,0,0,0)';    const pb = e.currentTarget.querySelector('.pb'); if (pb) pb.style.opacity = '0'; }}>
          <div className="pb" onClick={e => { e.stopPropagation(); if (playMedia) playMedia(item); }}
            onMouseEnter={e => { e.currentTarget.style.background = '#f59e0b'; e.currentTarget.style.transform = 'scale(1.15)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.9)'; e.currentTarget.style.transform = 'scale(1)'; }}
            style={{ width: 40, height: 40, borderRadius: '50%', background: 'rgba(255,255,255,0.9)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            opacity: 0, transition: 'opacity 0.2s, background 0.15s, transform 0.15s', fontSize: 16, paddingLeft: 3, cursor: 'pointer' }}>▶</div>
        </div>

        {/* Resume progress */}
        {item.resumePct > 0 && item.resumePct < 95 && (
          <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 3, background: 'rgba(0,0,0,0.5)' }}>
            <div style={{ height: '100%', width: `${item.resumePct}%`, background: 'var(--accent)' }} />
          </div>
        )}

        {/* Episode count badge for TV shows */}
        {item.episodeCount > 0 && (
          <div style={{ position: 'absolute', bottom: 6, right: 6, background: 'rgba(0,0,0,0.75)',
            color: '#fff', fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 4 }}>
            {item.episodeCount} ep
          </div>
        )}
      </div>

      <div className="media-card-info">
        <div style={{ fontWeight: 700, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis',
          whiteSpace: 'nowrap', color: 'var(--text-primary)' }}>
          {item.seriesTitle || item.showName || item.title}
        </div>
        {(item.year || item.artist) && (
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {item.artist || item.year}
          </div>
        )}
        {item.rating && (
          <div style={{ fontSize: 10, color: '#fbbf24', marginTop: 1 }}>★ {item.rating}</div>
        )}
      </div>
    </div>
  );
}

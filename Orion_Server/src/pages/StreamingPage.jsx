import React, { useState } from 'react';
import { ExternalLink, Play, Tv2, Zap, RefreshCw } from 'lucide-react';

const SERVICES = {
  pluto: {
    name: 'Pluto TV',
    icon: '🌐',
    color: '#f5c518',
    bg: 'linear-gradient(135deg, #1a1200 0%, #2d2000 100%)',
    url: 'https://pluto.tv',
    embedUrl: 'https://pluto.tv',
    description: 'Free live TV and on-demand movies & shows. No sign-up required.',
    features: ['250+ Live Channels', 'Movies & TV Shows', 'No Subscription', 'News & Sports'],
    windowMode: false,
  },
  roku: {
    name: 'The Roku Channel',
    icon: '📺',
    color: '#6c2bd9',
    bg: 'linear-gradient(135deg, #0d0520 0%, #1a0840 100%)',
    url: 'https://therokuchannel.roku.com',
    description: 'Free movies, live TV, and premium content from The Roku Channel.',
    features: ['Free Movies', 'Live TV', 'News Channels', 'Premium Add-ons'],
    windowMode: true,
  },
  tubi: {
    name: 'Tubi',
    icon: '🎬',
    color: '#fa3c1e',
    bg: 'linear-gradient(135deg, #1a0500 0%, #2d0a00 100%)',
    url: 'https://tubitv.com',
    description: 'The largest free streaming service — thousands of movies and TV shows.',
    features: ['50,000+ Titles', 'Movies & TV', 'No Subscription', 'New Content Weekly'],
    windowMode: true,
  },
  crackle: {
    name: 'Crackle',
    icon: '🎥',
    color: '#e8002d',
    bg: 'linear-gradient(135deg, #1a0008 0%, #2d0010 100%)',
    url: 'https://www.crackle.com',
    description: "Sony's free streaming service with movies and original shows.",
    features: ['Sony Pictures', 'Original Content', 'Free Movies', 'TV Shows'],
    windowMode: true,
  },
  plex: {
    name: 'Plex',
    icon: '🟡',
    color: '#e5a00d',
    bg: 'linear-gradient(135deg, #1a1200 0%, #2a1e00 100%)',
    url: 'https://app.plex.tv/desktop/#!/',
    description: 'Free movies, live TV and podcasts — no subscription needed.',
    features: ['Free Movies & TV', 'Live TV', 'Podcasts', 'No Sign-up Needed'],
    windowMode: true,
  },
  freevee: {
    name: 'Amazon Freevee',
    icon: '🔵',
    color: '#00a8e0',
    bg: 'linear-gradient(135deg, #00090f 0%, #001520 100%)',
    url: 'https://www.amazon.com/Amazon-Video/b?node=2858778011',
    description: 'Free movies and TV shows from Amazon — no Prime needed.',
    features: ['Free with Ads', 'Amazon Originals', 'Movies & TV', 'No Subscription'],
    windowMode: true,
  },
  paramount: { name: 'Paramount+', icon: '⭐', color: '#0064ff', bg: 'linear-gradient(135deg, #000820, #001440)', url: 'https://www.paramountplus.com', description: 'CBS, MTV, Nickelodeon and more.', features: ['CBS Content', 'MTV Shows', 'Live News', 'Sports'], note: '' },
  netflix:   { name: 'Netflix',    icon: '🔴', color: '#e50914', bg: 'linear-gradient(135deg, #1a0000, #2d0000)', url: 'https://www.netflix.com',       description: "The world's most popular streaming service.", features: ['Originals', 'Movies', 'TV Shows', '4K HDR'], note: '' },
  hulu:      { name: 'Hulu',       icon: '💚', color: '#1ce783', bg: 'linear-gradient(135deg, #001a0a, #002d12)', url: 'https://www.hulu.com',           description: 'TV, movies, live TV and Hulu Originals.', features: ['Live TV', 'Originals', 'Next-Day TV', 'Sports'], note: '' },
  disney:    { name: 'Disney+',    icon: '🏰', color: '#113ccf', bg: 'linear-gradient(135deg, #000d30, #001a60)', url: 'https://www.disneyplus.com',     description: 'Disney, Marvel, Star Wars, Pixar.', features: ['Marvel', 'Star Wars', 'Pixar', 'National Geo'], note: '' },
  max:       { name: 'Max',        icon: '🔵', color: '#002be7', bg: 'linear-gradient(135deg, #000820, #000f40)', url: 'https://www.max.com',            description: 'HBO, Warner Bros, and Max Originals.', features: ['HBO Content', 'Warner Bros', 'DC', 'Originals'], note: '' },
  prime:     { name: 'Prime Video',icon: '📦', color: '#00a8e0', bg: 'linear-gradient(135deg, #001a25, #002d40)', url: 'https://www.primevideo.com',     description: 'Amazon Prime Video — movies, TV and originals.', features: ['Amazon Originals', 'Movies', 'Live Sports', '4K'], note: '' },
  appletv:   { name: 'Apple TV+',  icon: '🍎', color: '#555',    bg: 'linear-gradient(135deg, #0a0a0a, #1a1a1a)', url: 'https://tv.apple.com',          description: 'Apple Originals — award-winning content.', features: ['Apple Originals', 'Ted Lasso', 'Severance', '4K HDR'], note: '' },
  peacock: {
    name: 'Peacock',
    icon: '🦚',
    color: '#0057ff',
    bg: 'linear-gradient(135deg, #000820 0%, #001040 100%)',
    url: 'https://www.peacocktv.com',
    description: "NBCUniversal's streaming service — free tier with thousands of hours.",
    features: ['NBC Classics', 'Movies', 'Live Sports', 'News'],
    windowMode: true,
  },
  popcornflix: {
    name: 'Popcornflix',
    icon: '🍿',
    color: '#ff6b35',
    bg: 'linear-gradient(135deg, #1a0800 0%, #2d1200 100%)',
    url: 'https://www.popcornflix.com',
    description: 'Free full-length movies — no sign-up, no subscription.',
    features: ['Free Movies', 'No Sign-up', 'Action & Comedy', 'Horror'],
    windowMode: true,
  },
  stirr: {
    name: 'STIRR',
    icon: '📡',
    color: '#ff4d00',
    bg: 'linear-gradient(135deg, #1a0800 0%, #2d0e00 100%)',
    url: 'https://stirr.com',
    description: 'Free live local TV and national news channels.',
    features: ['Local News', 'Live Channels', 'Sports', 'Entertainment'],
    windowMode: true,
  },
  youtube: {
    name: 'YouTube',
    icon: '▶️',
    color: '#ff0000',
    bg: 'linear-gradient(135deg, #1a0000 0%, #2d0000 100%)',
    url: 'https://www.youtube.com',
    description: 'Free movies, TV episodes and live streams on YouTube.',
    features: ['Free Movies', 'Live Streams', 'TV Episodes', 'No Subscription'],
    windowMode: true,
  },
};

export default function StreamingPage({ service }) {
  const svc = SERVICES[service];
  const [mode, setMode] = useState('info'); // 'info' | 'embed'

  if (!svc) return null;

  const openInBrowser = () => {
    if (svc.windowMode && window.electron?.openStreamingWindow) {
      window.electron.openStreamingWindow(svc.url, svc.name);
    } else {
      window.electron?.openExternal(svc.url);
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div className="page-title">{svc.name}</div>
            <div className="page-subtitle">{svc.description}</div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-secondary btn-sm" onClick={() => setMode(mode === 'embed' ? 'info' : 'embed')}>
              {mode === 'embed' ? <RefreshCw size={14} /> : <Play size={14} />}
              {mode === 'embed' ? 'Back' : 'Open ' + svc.name}
            </button>
            <button className="btn btn-primary btn-sm" onClick={openInBrowser}>
              <ExternalLink size={14} /> Open in Browser
            </button>
          </div>
        </div>
      </div>

      {mode === 'info' ? (
        <div style={{ padding: '0 48px' }}>
          {/* Banner */}
          <div style={{
            height: 200, borderRadius: 'var(--radius-lg)', marginBottom: 28,
            background: svc.bg, display: 'flex', alignItems: 'center', justifyContent: 'center',
            border: '1px solid var(--border)', position: 'relative', overflow: 'hidden'
          }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 56, marginBottom: 8 }}>{svc.icon}</div>
              <div style={{ fontSize: 28, fontWeight: 800, color: svc.color, fontFamily: 'var(--font-display)' }}>
                {svc.name}
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>Free Streaming</div>
            </div>
            {/* Decorative dots */}
            {[...Array(20)].map((_, i) => (
              <div key={i} style={{
                position: 'absolute', width: 3, height: 3, borderRadius: '50%',
                background: svc.color, opacity: 0.15,
                left: `${Math.random() * 100}%`, top: `${Math.random() * 100}%`
              }} />
            ))}
          </div>

          {/* Features */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12, marginBottom: 28 }}>
            {svc.features.map(f => (
              <div key={f} style={{
                background: 'var(--bg-card)', border: '1px solid var(--border)',
                borderRadius: 'var(--radius)', padding: '14px 16px',
                display: 'flex', alignItems: 'center', gap: 10
              }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: svc.color, flexShrink: 0 }} />
                <span style={{ fontSize: 14, fontWeight: 500 }}>{f}</span>
              </div>
            ))}
          </div>

          {/* Actions */}
          <div style={{
            background: 'var(--bg-card)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius-lg)', padding: 24,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 24
          }}>
            <div>
              <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>Ready to watch?</div>
              <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>{svc.note}</div>
            </div>
            <div style={{ display: 'flex', gap: 10, flexShrink: 0 }}>
              <button className="btn btn-secondary" onClick={() => setMode('embed')}>
                <Tv2 size={16} /> Embed View
              </button>
              <button className="btn btn-primary" onClick={openInBrowser}>
                <ExternalLink size={16} /> Launch {svc.name}
              </button>
            </div>
          </div>
        </div>
      ) : (
        /* Embed mode */
        <div style={{ padding: '0 48px 48px' }}>
          <div style={{
            width: '100%', height: 'calc(100vh - 200px)',
            borderRadius: 'var(--radius-lg)', overflow: 'hidden',
            border: '1px solid var(--border)', background: '#000', position: 'relative'
          }}>
            <iframe
              src={svc.embedUrl}
              title={svc.name}
              style={{ width: '100%', height: '100%', border: 'none' }}
              allow="autoplay; fullscreen"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            />
            <div style={{
              position: 'absolute', bottom: 0, left: 0, right: 0,
              padding: '10px 16px', background: 'rgba(0,0,0,0.7)',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              fontSize: 12, color: 'var(--text-muted)'
            }}>
              <span>Viewing: {svc.url}</span>
              <button onClick={openInBrowser}
                style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
                <ExternalLink size={12} /> Open in Browser
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

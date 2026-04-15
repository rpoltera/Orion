import React, { useState, useEffect } from 'react';
import { useApp } from '../contexts/AppContext';
import { ExternalLink } from 'lucide-react';

const ALL_SERVICES = [
  { id: 'pluto',     name: 'Pluto TV',          icon: '📺', color: '#f5c518', desc: '250+ live channels, movies & TV. No sign-up needed.',       url: 'https://pluto.tv',                       free: true,  embedable: true  },
  { id: 'roku',      name: 'The Roku Channel',   icon: '🎬', color: '#6c2bd9', desc: 'Free movies, live TV, and news channels.',                   url: 'https://therokuchannel.roku.com',         free: true,  embedable: false },
  { id: 'tubi',      name: 'Tubi',               icon: '🎥', color: '#fa4e37', desc: 'The largest free streaming service — 50,000+ titles.',       url: 'https://tubitv.com',                      free: true,  embedable: true  },
  { id: 'crackle',   name: 'Crackle',            icon: '🎞', color: '#f90',    desc: "Sony's free streaming service with originals.",              url: 'https://www.crackle.com',                 free: true,  embedable: true  },
  { id: 'plex',      name: 'Plex',               icon: '🟡', color: '#e5a00d', desc: 'Free movies & TV from Plex. No subscription required.',      url: 'https://app.plex.tv/desktop/#!/',         free: true,  embedable: true  },
  { id: 'peacock',   name: 'Peacock',            icon: '🦚', color: '#000',    desc: 'NBCUniversal streaming — free tier with thousands of hours.', url: 'https://www.peacocktv.com',               free: false, embedable: false },
  { id: 'paramount', name: 'Paramount+',         icon: '⭐', color: '#0064ff', desc: 'CBS, MTV, Nickelodeon and more. Subscription required.',      url: 'https://www.paramountplus.com',           free: false, embedable: false },
  { id: 'netflix',   name: 'Netflix',            icon: '🔴', color: '#e50914', desc: 'The world\'s most popular streaming service.',                url: 'https://www.netflix.com',                 free: false, embedable: false },
  { id: 'hulu',      name: 'Hulu',               icon: '💚', color: '#1ce783', desc: 'TV, movies, live TV and Hulu Originals.',                    url: 'https://www.hulu.com',                    free: false, embedable: false },
  { id: 'disney',    name: 'Disney+',            icon: '🏰', color: '#113ccf', desc: 'Disney, Marvel, Star Wars, Pixar and National Geographic.',  url: 'https://www.disneyplus.com',              free: false, embedable: false },
  { id: 'max',       name: 'Max',                icon: '🔵', color: '#002be7', desc: 'HBO, Warner Bros, and Max Originals.',                        url: 'https://www.max.com',                     free: false, embedable: false },
  { id: 'prime',     name: 'Prime Video',        icon: '📦', color: '#00a8e0', desc: 'Amazon Prime Video — movies, TV and Amazon Originals.',       url: 'https://www.primevideo.com',              free: false, embedable: false },
  { id: 'appletv',   name: 'Apple TV+',          icon: '🍎', color: '#555',    desc: 'Apple Originals — award-winning series and films.',           url: 'https://tv.apple.com',                    free: false, embedable: false },
  { id: 'youtube',   name: 'YouTube',            icon: '▶️', color: '#ff0000', desc: 'Free movies, TV and endless video content.',                  url: 'https://www.youtube.com',                 free: true,  embedable: false },
];

const STORAGE_KEY = 'orion_enabled_services';

export default function StreamingServicesPage({ onNavigate }) {
  const { API } = useApp();

  const [enabled, setEnabled] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved ? JSON.parse(saved) : ['pluto', 'roku', 'tubi'];
    } catch { return ['pluto', 'roku', 'tubi']; }
  });

  const toggle = (id) => {
    setEnabled(prev => {
      const next = prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  };

  const openService = (svc) => {
    if (svc.id === 'roku' && window.electron?.openStreamingWindow) {
      window.electron.openStreamingWindow(svc.url, svc.name);
    } else if (window.electron?.openStreamingWindow) {
      window.electron.openStreamingWindow(svc.url, svc.name);
    } else {
      window.open(svc.url, '_blank');
    }
  };

  const free    = ALL_SERVICES.filter(s => s.free);
  const premium = ALL_SERVICES.filter(s => !s.free);

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-title">📡 Streaming Services</div>
        <div className="page-subtitle">Choose which services appear in your sidebar</div>
      </div>

      {/* Free Services */}
      <div style={{ marginBottom: 40 }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 2, textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 16 }}>
          Free Services
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
          {free.map(svc => (
            <ServiceCard key={svc.id} svc={svc} enabled={enabled.includes(svc.id)} onToggle={() => toggle(svc.id)} onOpen={() => openService(svc)} />
          ))}
        </div>
      </div>

      {/* Premium Services */}
      <div>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 2, textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 16 }}>
          Subscription Services
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
          {premium.map(svc => (
            <ServiceCard key={svc.id} svc={svc} enabled={enabled.includes(svc.id)} onToggle={() => toggle(svc.id)} onOpen={() => openService(svc)} />
          ))}
        </div>
      </div>

      <div style={{ marginTop: 32, padding: '16px 20px', background: 'rgba(0,99,229,0.08)', border: '1px solid rgba(0,99,229,0.2)', borderRadius: 'var(--radius-lg)', fontSize: 13, color: 'var(--text-muted)' }}>
        💡 Enabled services appear in your sidebar. Click <strong style={{ color: 'var(--text-primary)' }}>Open</strong> to launch any service in a dedicated window.
      </div>
    </div>
  );
}

function ServiceCard({ svc, enabled, onToggle, onOpen }) {
  return (
    <div style={{
      background: 'var(--bg-card)', border: `1px solid ${enabled ? 'rgba(0,99,229,0.4)' : 'var(--border)'}`,
      borderRadius: 'var(--radius-lg)', padding: '18px 20px',
      display: 'flex', alignItems: 'center', gap: 14,
      transition: 'all 0.15s',
      boxShadow: enabled ? '0 0 0 1px rgba(0,99,229,0.15) inset' : 'none',
    }}>
      {/* Icon */}
      <div style={{
        width: 48, height: 48, borderRadius: 12, flexShrink: 0,
        background: `${svc.color}22`,
        border: `1px solid ${svc.color}44`,
        display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22,
      }}>
        {svc.icon}
      </div>

      {/* Info */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
          <span style={{ fontWeight: 700, fontSize: 14 }}>{svc.name}</span>
          {svc.free && <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 20, background: 'rgba(16,185,129,0.15)', color: '#34d399' }}>FREE</span>}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{svc.desc}</div>
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
        <button onClick={onOpen} style={{
          background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
          borderRadius: 8, padding: '6px 10px', cursor: 'pointer',
          color: 'var(--text-muted)', fontSize: 12, display: 'flex', alignItems: 'center', gap: 5,
          transition: 'all 0.15s',
        }}
          onMouseEnter={e => { e.currentTarget.style.color = 'var(--text-primary)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.2)'; }}
          onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.borderColor = 'var(--border)'; }}
        >
          <ExternalLink size={12} /> Open
        </button>

        {/* Toggle */}
        <div onClick={onToggle} style={{
          width: 42, height: 24, borderRadius: 12,
          background: enabled ? 'var(--accent)' : 'rgba(255,255,255,0.1)',
          position: 'relative', cursor: 'pointer', transition: 'background 0.2s', flexShrink: 0,
        }}>
          <div style={{
            position: 'absolute', top: 2, left: enabled ? 20 : 2,
            width: 20, height: 20, borderRadius: '50%', background: 'white',
            transition: 'left 0.2s', boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
          }} />
        </div>
      </div>
    </div>
  );
}

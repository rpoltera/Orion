import React, { useState, useEffect } from 'react';
import { useApp } from '../contexts/AppContext';
import MediaCard from '../components/MediaCard';
const API = 'http://localhost:3001/api';

export default function DiscoverPage({ onSelect }) {
  const { setActiveSection } = useApp();
  const [data, setData] = useState(null);
  const [recommendations, setRecommendations] = useState({ movies: [], tv: [] });
  const [activeTab, setActiveTab] = useState('trending');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch(`${API}/discover`).then(r => r.json()),
      fetch(`${API}/recommendations/movies`).then(r => r.json()),
      fetch(`${API}/recommendations/tv`).then(r => r.json()),
    ]).then(([discover, recMovies, recTV]) => {
      setData(discover);
      setRecommendations({ movies: recMovies.items || [], tv: recTV.items || [] });
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const tabs = [
    { id: 'trending',  label: '🔥 Trending' },
    { id: 'toprated',  label: '⭐ Top Rated' },
    { id: 'recommended', label: '✨ For You' },
    { id: 'genres',    label: '🎭 By Genre' },
  ];

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 400, color: 'var(--text-muted)' }}>
      Loading Discover...
    </div>
  );

  return (
    <div style={{ padding: '0 0 48px' }}>
      <div className="page-header">
        <div className="page-title">🔭 Discover</div>
        <div className="page-subtitle">Explore your library in new ways</div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 2, padding: '0 48px', borderBottom: '1px solid var(--border)', marginBottom: 28 }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setActiveTab(t.id)} style={{
            padding: '10px 20px', border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 600,
            background: 'transparent',
            color: activeTab === t.id ? 'var(--accent)' : 'var(--text-muted)',
            borderBottom: activeTab === t.id ? '2px solid var(--accent)' : '2px solid transparent',
            transition: 'all 0.15s', marginBottom: -1,
          }}>{t.label}</button>
        ))}
      </div>

      <div style={{ padding: '0 48px' }}>
        {/* Trending */}
        {activeTab === 'trending' && (
          <div>
            <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 20 }}>
              Recently added to your library
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: '20px 14px' }}>
              {(data?.trending || []).map(item => (
                <MediaCard key={item.id} item={item} onClick={onSelect} />
              ))}
            </div>
          </div>
        )}

        {/* Top Rated */}
        {activeTab === 'toprated' && (
          <div>
            <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 20 }}>
              Highest rated movies in your library
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: '20px 14px' }}>
              {(data?.topRated || []).map(item => (
                <MediaCard key={item.id} item={item} onClick={onSelect} />
              ))}
            </div>
          </div>
        )}

        {/* Recommended */}
        {activeTab === 'recommended' && (
          <div>
            {recommendations.movies.length === 0 && recommendations.tv.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-muted)' }}>
                <div style={{ fontSize: 40, marginBottom: 16 }}>🎬</div>
                <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>Watch something first</div>
                <div style={{ fontSize: 13 }}>Recommendations are based on your watch history. Start watching to get personalized picks.</div>
              </div>
            ) : (
              <>
                {recommendations.movies.length > 0 && (
                  <div style={{ marginBottom: 40 }}>
                    <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>Movies You'll Love</div>
                    <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 20 }}>Based on genres and cast from movies you've watched</div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: '20px 14px' }}>
                      {recommendations.movies.map(item => <MediaCard key={item.id} item={item} onClick={onSelect} />)}
                    </div>
                  </div>
                )}
                {recommendations.tv.length > 0 && (
                  <div>
                    <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>Shows You'll Love</div>
                    <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 20 }}>Based on genres and networks from shows you've watched</div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: '20px 14px' }}>
                      {recommendations.tv.map(item => <MediaCard key={item.id} item={item} onClick={onSelect} />)}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* By Genre */}
        {activeTab === 'genres' && (
          <div>
            {(data?.genres || []).map(({ genre, items }) => (
              <div key={genre} style={{ marginBottom: 36 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
                  <div style={{ fontSize: 18, fontWeight: 700 }}>{genre}</div>
                  <span style={{ fontSize: 13, color: 'var(--accent)', cursor: 'pointer', fontWeight: 600 }}
                    onClick={() => setActiveSection('movies')}>See all in {genre} →</span>
                </div>
                <div style={{ display: 'flex', gap: 14, overflowX: 'auto', scrollbarWidth: 'none', paddingBottom: 4 }}>
                  {items.map(item => (
                    <div key={item.id} style={{ flexShrink: 0 }}>
                      <MediaCard item={item} onClick={onSelect} />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

import React, { useState, useEffect } from 'react';
import { FolderOpen, Tag } from 'lucide-react';
import { CustomLibrariesSettings, AutoCollectionsEmbedded } from './SettingsPage';

const API = 'http://localhost:3001/api';

/**
 * MediaSettingsPage
 * Top-level "Media" hub. Wraps Library + Metadata settings as tabs.
 * Receives an optional `initialTab` prop from App.jsx routing
 * (e.g. clicking "Library Settings" in the sidebar opens with tab='library').
 */
export default function MediaSettingsPage({ initialTab = 'library' }) {
  const [activeTab, setActiveTab] = useState(initialTab);

  // Keep tab in sync with prop (when sidebar navigates between media-library / media-metadata)
  useEffect(() => { setActiveTab(initialTab); }, [initialTab]);

  const TABS = [
    { id: 'library',  label: 'Library Settings',  icon: FolderOpen, desc: 'Custom libraries — books, photos, home movies, workouts, and more.' },
    { id: 'metadata', label: 'Metadata Settings', icon: Tag,        desc: 'Auto-collections, overlays, ratings, and metadata providers.' },
  ];

  const current = TABS.find(t => t.id === activeTab) || TABS[0];

  return (
    <div className="page-content" style={{ padding: '24px 32px' }}>
      {/* Page header */}
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 4 }}>Media</h1>
        <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          Manage how Orion organizes, indexes, and enriches your media library.
        </p>
      </div>

      {/* Tab bar */}
      <div style={{
        display: 'flex', gap: 4, marginBottom: 24,
        borderBottom: '1px solid var(--border)'
      }}>
        {TABS.map(t => {
          const Icon = t.icon;
          const active = activeTab === t.id;
          return (
            <button key={t.id} onClick={() => setActiveTab(t.id)} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '10px 18px', background: 'none', border: 'none',
              borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
              color: active ? 'var(--accent)' : 'var(--text-muted)',
              fontWeight: active ? 700 : 500,
              fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
              marginBottom: -1
            }}>
              <Icon size={14} />
              {t.label}
            </button>
          );
        })}
      </div>

      {/* Active tab content */}
      <div>
        {activeTab === 'library'  && <CustomLibrariesSettings API={API} />}
        {activeTab === 'metadata' && <AutoCollectionsEmbedded />}
      </div>
    </div>
  );
}

import React from 'react';
import { useApp } from '../contexts/AppContext';
import MediaCard from './MediaCard';

export default function SearchResults({ onSelect }) {
  const { searchQuery, searchResults } = useApp();
  return (
    <div className="page">
      <div className="page-header">
        <div className="page-title">Search Results</div>
        <div className="page-subtitle">
          {searchResults.length} results for "{searchQuery}"
        </div>
      </div>
      {searchResults.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">🔍</div>
          <h3>No results found</h3>
          <p>Try a different search term or add more media to your library.</p>
        </div>
      ) : (
        <div className="media-grid">
          {searchResults.map(item => (
            <MediaCard key={item.id} item={item} onClick={onSelect} />
          ))}
        </div>
      )}
    </div>
  );
}

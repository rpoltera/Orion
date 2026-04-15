import React, { useRef, useState, useCallback } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

/**
 * ScrollableGrid — wraps any grid of cards with left/right scroll arrows.
 * The arrows scroll by one "page" (the visible width) at a time.
 */
export default function ScrollableGrid({ children, className = 'media-grid', style = {} }) {
  const containerRef = useRef(null);
  const [canLeft, setCanLeft]   = useState(false);
  const [canRight, setCanRight] = useState(true);

  const updateArrows = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    setCanLeft(el.scrollLeft > 10);
    setCanRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 10);
  }, []);

  const scroll = (dir) => {
    const el = containerRef.current;
    if (!el) return;
    const amount = el.clientWidth * 0.85;
    el.scrollBy({ left: dir * amount, behavior: 'smooth' });
    setTimeout(updateArrows, 400);
  };

  return (
    <div style={{ position: 'relative', ...style }}>
      {/* Left arrow */}
      <button
        onClick={() => scroll(-1)}
        disabled={!canLeft}
        style={{
          position: 'absolute', left: 4, top: '40%', transform: 'translateY(-50%)',
          zIndex: 10, width: 36, height: 36, borderRadius: '50%',
          background: canLeft ? 'rgba(0,0,0,0.75)' : 'rgba(0,0,0,0.2)',
          border: '1px solid rgba(255,255,255,0.15)', color: 'white',
          cursor: canLeft ? 'pointer' : 'default', display: 'flex',
          alignItems: 'center', justifyContent: 'center',
          backdropFilter: 'blur(8px)', transition: 'all 0.2s',
          opacity: canLeft ? 1 : 0.25,
        }}
        onMouseEnter={e => { if (canLeft) e.currentTarget.style.background = 'rgba(99,102,241,0.8)'; }}
        onMouseLeave={e => { e.currentTarget.style.background = canLeft ? 'rgba(0,0,0,0.75)' : 'rgba(0,0,0,0.2)'; }}
      >
        <ChevronLeft size={20} />
      </button>

      {/* Scrollable container */}
      <div
        ref={containerRef}
        onScroll={updateArrows}
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
          gap: 16,
          overflowX: 'auto',
          overflowY: 'visible',
          scrollbarWidth: 'none',
          msOverflowStyle: 'none',
          paddingLeft: 48,
          paddingRight: 48,
          paddingBottom: 48,
          ...style,
        }}
      >
        {children}
      </div>

      {/* Right arrow */}
      <button
        onClick={() => scroll(1)}
        disabled={!canRight}
        style={{
          position: 'absolute', right: 4, top: '40%', transform: 'translateY(-50%)',
          zIndex: 10, width: 36, height: 36, borderRadius: '50%',
          background: canRight ? 'rgba(0,0,0,0.75)' : 'rgba(0,0,0,0.2)',
          border: '1px solid rgba(255,255,255,0.15)', color: 'white',
          cursor: canRight ? 'pointer' : 'default', display: 'flex',
          alignItems: 'center', justifyContent: 'center',
          backdropFilter: 'blur(8px)', transition: 'all 0.2s',
          opacity: canRight ? 1 : 0.25,
        }}
        onMouseEnter={e => { if (canRight) e.currentTarget.style.background = 'rgba(99,102,241,0.8)'; }}
        onMouseLeave={e => { e.currentTarget.style.background = canRight ? 'rgba(0,0,0,0.75)' : 'rgba(0,0,0,0.2)'; }}
      >
        <ChevronRight size={20} />
      </button>
    </div>
  );
}

// ─── TitleBar.jsx ─────────────────────────────────────────────────────────
import React from 'react';
import { Minus, Square, X } from 'lucide-react';

export default function TitleBar() {
  const el = window.electron;
  return (
    <div className="titlebar">
      <div className="titlebar-controls">
        <button className="titlebar-btn" onClick={() => el?.minimize()} title="Minimize">
          <Minus size={14} />
        </button>
        <button className="titlebar-btn" onClick={() => el?.maximize()} title="Maximize">
          <Square size={12} />
        </button>
        <button className="titlebar-btn close" onClick={() => el?.close()} title="Close">
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

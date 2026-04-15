// Orion Theme Definitions
// Each theme defines CSS variables applied to :root

export const themes = {
  disney: {
    id: 'disney',
    name: 'Disney+',
    preview: ['#040714', '#0063e5', '#ffffff'],
    vars: {
      '--bg-primary': '#040714',
      '--bg-secondary': '#0b0d17',
      '--bg-tertiary': '#12152a',
      '--bg-card': '#1a1d33',
      '--bg-hover': '#252848',
      '--accent': '#0063e5',
      '--accent-hover': '#147fcd',
      '--accent-glow': 'rgba(0,99,229,0.35)',
      '--text-primary': '#ffffff',
      '--text-secondary': '#a8acb3',
      '--text-muted': '#6b7180',
      '--border': 'rgba(255,255,255,0.08)',
      '--border-accent': 'rgba(0,99,229,0.5)',
      '--gradient-hero': 'linear-gradient(180deg, transparent 0%, rgba(4,7,20,0.8) 60%, #040714 100%)',
      '--gradient-card': 'linear-gradient(180deg, transparent 50%, rgba(4,7,20,0.95) 100%)',
      '--sidebar-bg': 'rgba(4,7,20,0.95)',
      '--tag-bg': 'rgba(0,99,229,0.2)',
      '--tag-color': '#4da3ff',
      '--scrollbar': '#1a1d33',
      '--font-display': '"Avenir Next", "Century Gothic", sans-serif',
      '--font-body': '"Source Sans Pro", "Segoe UI", sans-serif',
      '--radius': '6px',
      '--radius-lg': '12px',
    }
  },

  plex: {
    id: 'plex',
    name: 'Plex Classic',
    preview: ['#1f2326', '#e5a00d', '#ffffff'],
    vars: {
      '--bg-primary': '#1f2326',
      '--bg-secondary': '#282c30',
      '--bg-tertiary': '#333940',
      '--bg-card': '#2f3439',
      '--bg-hover': '#3d4550',
      '--accent': '#e5a00d',
      '--accent-hover': '#cc8c00',
      '--accent-glow': 'rgba(229,160,13,0.3)',
      '--text-primary': '#ffffff',
      '--text-secondary': '#a0a6ad',
      '--text-muted': '#6b7280',
      '--border': 'rgba(255,255,255,0.07)',
      '--border-accent': 'rgba(229,160,13,0.4)',
      '--gradient-hero': 'linear-gradient(180deg, transparent 0%, rgba(31,35,38,0.8) 60%, #1f2326 100%)',
      '--gradient-card': 'linear-gradient(180deg, transparent 50%, rgba(31,35,38,0.95) 100%)',
      '--sidebar-bg': 'rgba(20,23,26,0.97)',
      '--tag-bg': 'rgba(229,160,13,0.15)',
      '--tag-color': '#e5a00d',
      '--scrollbar': '#333940',
      '--font-display': '"Roboto", "Segoe UI", sans-serif',
      '--font-body': '"Roboto", "Segoe UI", sans-serif',
      '--radius': '4px',
      '--radius-lg': '8px',
    }
  },

  netflix: {
    id: 'netflix',
    name: 'Netflix Dark',
    preview: ['#141414', '#e50914', '#ffffff'],
    vars: {
      '--bg-primary': '#141414',
      '--bg-secondary': '#1a1a1a',
      '--bg-tertiary': '#222222',
      '--bg-card': '#2a2a2a',
      '--bg-hover': '#383838',
      '--accent': '#e50914',
      '--accent-hover': '#c40812',
      '--accent-glow': 'rgba(229,9,20,0.35)',
      '--text-primary': '#ffffff',
      '--text-secondary': '#b3b3b3',
      '--text-muted': '#737373',
      '--border': 'rgba(255,255,255,0.1)',
      '--border-accent': 'rgba(229,9,20,0.5)',
      '--gradient-hero': 'linear-gradient(180deg, transparent 0%, rgba(20,20,20,0.7) 60%, #141414 100%)',
      '--gradient-card': 'linear-gradient(180deg, transparent 50%, rgba(20,20,20,0.95) 100%)',
      '--sidebar-bg': 'rgba(10,10,10,0.97)',
      '--tag-bg': 'rgba(229,9,20,0.15)',
      '--tag-color': '#ff4d57',
      '--scrollbar': '#222222',
      '--font-display': '"Netflix Sans", "Bebas Neue", sans-serif',
      '--font-body': '"Netflix Sans", "Helvetica Neue", sans-serif',
      '--radius': '4px',
      '--radius-lg': '6px',
    }
  },

  midnight: {
    id: 'midnight',
    name: 'Midnight Purple',
    preview: ['#0a0a12', '#8b5cf6', '#ffffff'],
    vars: {
      '--bg-primary': '#0a0a12',
      '--bg-secondary': '#0f0f1a',
      '--bg-tertiary': '#16162a',
      '--bg-card': '#1e1e35',
      '--bg-hover': '#28284a',
      '--accent': '#8b5cf6',
      '--accent-hover': '#7c3aed',
      '--accent-glow': 'rgba(139,92,246,0.35)',
      '--text-primary': '#f1f0ff',
      '--text-secondary': '#a79bc7',
      '--text-muted': '#6b5e8a',
      '--border': 'rgba(139,92,246,0.12)',
      '--border-accent': 'rgba(139,92,246,0.4)',
      '--gradient-hero': 'linear-gradient(180deg, transparent 0%, rgba(10,10,18,0.8) 60%, #0a0a12 100%)',
      '--gradient-card': 'linear-gradient(180deg, transparent 50%, rgba(10,10,18,0.95) 100%)',
      '--sidebar-bg': 'rgba(5,5,12,0.97)',
      '--tag-bg': 'rgba(139,92,246,0.2)',
      '--tag-color': '#a78bfa',
      '--scrollbar': '#16162a',
      '--font-display': '"Cinzel", "Georgia", serif',
      '--font-body': '"Inter", "Segoe UI", sans-serif',
      '--radius': '8px',
      '--radius-lg': '16px',
    }
  },

  emerald: {
    id: 'emerald',
    name: 'Emerald Night',
    preview: ['#071a0f', '#10b981', '#ffffff'],
    vars: {
      '--bg-primary': '#071a0f',
      '--bg-secondary': '#0a2218',
      '--bg-tertiary': '#0f2d20',
      '--bg-card': '#163d2c',
      '--bg-hover': '#1d4f39',
      '--accent': '#10b981',
      '--accent-hover': '#059669',
      '--accent-glow': 'rgba(16,185,129,0.3)',
      '--text-primary': '#ecfdf5',
      '--text-secondary': '#86c9aa',
      '--text-muted': '#52896d',
      '--border': 'rgba(16,185,129,0.1)',
      '--border-accent': 'rgba(16,185,129,0.4)',
      '--gradient-hero': 'linear-gradient(180deg, transparent 0%, rgba(7,26,15,0.8) 60%, #071a0f 100%)',
      '--gradient-card': 'linear-gradient(180deg, transparent 50%, rgba(7,26,15,0.95) 100%)',
      '--sidebar-bg': 'rgba(4,14,9,0.97)',
      '--tag-bg': 'rgba(16,185,129,0.15)',
      '--tag-color': '#34d399',
      '--scrollbar': '#0f2d20',
      '--font-display': '"Playfair Display", "Georgia", serif',
      '--font-body': '"Nunito", "Segoe UI", sans-serif',
      '--radius': '8px',
      '--radius-lg': '14px',
    }
  }
};

export const applyTheme = (themeId) => {
  // Check built-in themes first
  if (themes[themeId]) {
    const theme = themes[themeId];
    const root = document.documentElement;
    Object.entries(theme.vars).forEach(([key, value]) => root.style.setProperty(key, value));
    return theme;
  }
  // Check custom themes in localStorage
  try {
    const custom = JSON.parse(localStorage.getItem('orion_custom_themes') || '[]');
    const ct = custom.find(t => t.id === themeId);
    if (ct) {
      const root = document.documentElement;
      Object.entries(ct.vars).forEach(([key, value]) => root.style.setProperty(key, value));
      return ct;
    }
  } catch {}
  // Fallback to disney
  const theme = themes.disney;
  const root = document.documentElement;
  Object.entries(theme.vars).forEach(([key, value]) => root.style.setProperty(key, value));
  return theme;
};

export default themes;

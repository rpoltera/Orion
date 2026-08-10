// ── Orion API auth (fix-05) ──────────────────────────────────────
// Installed before the app mounts so every fetch() in the codebase
// carries the bearer token without touching individual call sites.
(function installAuthFetch() {
  const KEY = 'orion_auth_token';
  const nativeFetch = window.fetch.bind(window);

  window.orionSetToken = t => {
    if (t) localStorage.setItem(KEY, t);
    else localStorage.removeItem(KEY);
  };
  window.orionGetToken = () => localStorage.getItem(KEY);

  window.fetch = function (input, init) {
    init = init || {};
    let url = '';
    try { url = typeof input === 'string' ? input : (input && input.url) || ''; }
    catch (_) {}

    // Only attach to Orion API calls, never to third-party requests
    // (TMDB, Last.fm) or to /sf/ media paths.
    // Match on the PATH, not the whole URL: '/api/sf/...' contains
    // '/sf/' and was wrongly excluded, so StreamForge endpoints never
    // received the token.
    let pathname = '';
    try { pathname = new URL(url, window.location.origin).pathname; }
    catch (_) { pathname = url; }
    const isApi = pathname.startsWith('/api/') || pathname === '/api';
    const token = localStorage.getItem(KEY);

    if (isApi && token) {
      const h = new Headers(init.headers || (typeof input !== 'string' && input.headers) || {});
      if (!h.has('Authorization')) h.set('Authorization', 'Bearer ' + token);
      init = Object.assign({}, init, { headers: h });
    }

    return nativeFetch(input, init).then(res => {
      // Only force re-login when we actually had a token and the server
      // rejected it. A 401 on a request sent without one just means that
      // endpoint needs auth — surface it, do not destroy the session.
      if (res.status === 401 && isApi && localStorage.getItem(KEY)) {
        localStorage.removeItem(KEY);
        localStorage.removeItem('orion_current_user');
        if (!window.__orionReloading) {
          window.__orionReloading = true;
          window.location.reload();
        }
      }
      return res;
    });
  };
})();

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);

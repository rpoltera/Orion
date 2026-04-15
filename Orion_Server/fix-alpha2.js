const fs = require('fs');

['src/pages/MoviesPage.jsx', 'src/pages/TVShowsPage.jsx'].forEach(file => {
  let c = fs.readFileSync(file, 'utf8');
  c = c.replace('function AlphaNav({ items, getKey }) {', 'function AlphaNav({ items, getKey, loadAll }) {');
  c = c.replace(
    `  const scrollTo = (char) => {
    const scroller = document.querySelector('.main-content');
    if (!scroller) return;
    const all = scroller.querySelectorAll('[data-alpha]');
    for (const el of all) {
      const k = (el.getAttribute('data-alpha') || '').toUpperCase().replace(/^(THE |A |AN )/, '');
      const first = k[0];
      const match = char === '#' ? (first && /[^A-Z]/.test(first)) : first === char;
      if (match) { scroller.scrollTo({ top: el.offsetTop - 100, behavior: 'smooth' }); return; }
    }
  };`,
    `  const scrollTo = (char) => {
    const doScroll = () => {
      const scroller = document.querySelector('.main-content');
      if (!scroller) return;
      const all = scroller.querySelectorAll('[data-alpha]');
      for (const el of all) {
        const k = (el.getAttribute('data-alpha') || '').toUpperCase().replace(/^(THE |A |AN )/, '');
        const first = k[0];
        const match = char === '#' ? (first && /[^A-Z]/.test(first)) : first === char;
        if (match) { scroller.scrollTo({ top: el.offsetTop - 100, behavior: 'smooth' }); return; }
      }
    };
    if (loadAll) { loadAll(); setTimeout(doScroll, 150); }
    else doScroll();
  };`
  );
  if (file.includes('Movies')) {
    c = c.replace('<AlphaNav items={filteredMovies} getKey={m => m.title} />', '<AlphaNav items={filteredMovies} getKey={m => m.title} loadAll={() => setVisibleCount(filteredMovies.length)} />');
  } else {
    c = c.replace('<AlphaNav items={filtered} getKey={s => s.showName} />', '<AlphaNav items={filtered} getKey={s => s.showName} loadAll={() => setTvVisible(filtered.length)} />');
  }
  fs.writeFileSync(file, c);
  console.log(file, 'done');
});
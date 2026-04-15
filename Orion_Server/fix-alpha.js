const fs = require('fs');

const newAlpha = `// ── Alphabet Quick-Nav ────────────────────────────────────────────────────────
function AlphaNav({ items, getKey }) {
  const chars = ['#', ...Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ')];
  const available = new Set(items.map(i => {
    const k = (getKey(i) || '').toUpperCase().replace(/^(THE |A |AN )/, '');
    return k[0] && /[^A-Z]/.test(k[0]) ? '#' : k[0];
  }));
  const scrollTo = (char) => {
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
  return ReactDOM.createPortal(
    <div style={{ position:'fixed', right:0, top:0, bottom:0, width:30,
      display:'flex', flexDirection:'column', justifyContent:'space-evenly',
      background:'rgba(0,0,0,0.7)', backdropFilter:'blur(8px)',
      zIndex:9999, userSelect:'none' }}>
      {chars.map(c => (
        <div key={c} onClick={() => available.has(c) && scrollTo(c)}
          style={{ textAlign:'center', fontSize:11, fontWeight:800, lineHeight:1,
            color: available.has(c) ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.15)',
            cursor: available.has(c) ? 'pointer' : 'default', padding:'1px 0' }}
          onMouseEnter={e => { if (available.has(c)) { e.currentTarget.style.color='#f59e0b'; e.currentTarget.style.fontSize='14px'; }}}
          onMouseLeave={e => { e.currentTarget.style.color=available.has(c)?'rgba(255,255,255,0.9)':'rgba(255,255,255,0.15)'; e.currentTarget.style.fontSize='11px'; }}>
          {c}
        </div>
      ))}
    </div>,
    document.body
  );
}

`;

['src/pages/MoviesPage.jsx', 'src/pages/TVShowsPage.jsx'].forEach(file => {
  let content = fs.readFileSync(file, 'utf8');
  content = content.replace(
    /\/\/ ── Alphabet Quick-Nav[\s\S]*?(?=(?:const SORT_FILTERS|export function TVShowsPage|export default function))/,
    newAlpha
  );
  fs.writeFileSync(file, content);
  console.log(file, 'done');
});
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Orion — Self-Hosted Media Server</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');
  :root{--bg:#04070f;--bg2:#080d1a;--bg3:#0d1425;--accent:#0063e5;--accent2:#4d9fff;--glow:rgba(0,99,229,0.35);--text:#f0f4ff;--muted:#7a8aaa;--border:rgba(255,255,255,0.06);--radius:14px}
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'Space Grotesk',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;overflow-x:hidden}
  #stars{position:fixed;inset:0;pointer-events:none;z-index:0;overflow:hidden}
  .star{position:absolute;border-radius:50%;background:white;animation:twinkle var(--d) infinite ease-in-out;opacity:0}
  @keyframes twinkle{0%,100%{opacity:0}50%{opacity:var(--o)}}
  nav{position:fixed;top:0;left:0;right:0;z-index:100;display:flex;align-items:center;justify-content:space-between;padding:20px 60px;background:rgba(4,7,15,0.85);backdrop-filter:blur(20px);border-bottom:1px solid var(--border)}
  .nav-logo{font-size:22px;font-weight:700;letter-spacing:-0.5px;display:flex;align-items:center;gap:10px}
  .nav-links{display:flex;gap:36px}
  .nav-links a{color:var(--muted);text-decoration:none;font-size:14px;font-weight:500;transition:color 0.2s}
  .nav-links a:hover{color:var(--text)}
  .hero{position:relative;z-index:1;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:120px 40px 80px}
  .hero-badge{display:inline-flex;align-items:center;gap:8px;background:rgba(0,99,229,0.12);border:1px solid rgba(0,99,229,0.3);color:var(--accent2);font-size:12px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;padding:7px 16px;border-radius:100px;margin-bottom:32px}
  .hero h1{font-size:clamp(52px,8vw,96px);font-weight:700;letter-spacing:-3px;line-height:1;margin-bottom:28px;background:linear-gradient(135deg,#fff 0%,#a8c4ff 50%,#4d9fff 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
  .hero p{font-size:clamp(16px,2vw,20px);color:var(--muted);max-width:600px;line-height:1.7;margin-bottom:48px}
  .hero-buttons{display:flex;gap:16px;flex-wrap:wrap;justify-content:center}
  .btn-primary{background:var(--accent);color:white;padding:15px 32px;border-radius:10px;font-size:15px;font-weight:600;text-decoration:none;transition:all 0.2s;box-shadow:0 0 30px var(--glow)}
  .btn-primary:hover{background:#1a7aff;transform:translateY(-2px)}
  .btn-ghost{background:transparent;color:var(--text);padding:15px 32px;border-radius:10px;font-size:15px;font-weight:600;text-decoration:none;border:1px solid var(--border);transition:all 0.2s}
  .btn-ghost:hover{border-color:rgba(255,255,255,0.2);background:rgba(255,255,255,0.04)}
  .mockup-wrap{margin-top:80px;width:min(900px,90vw)}
  .mockup-frame{background:var(--bg2);border:1px solid rgba(255,255,255,0.08);border-radius:16px;overflow:hidden;box-shadow:0 40px 120px rgba(0,0,0,0.8),0 0 80px rgba(0,99,229,0.15)}
  .mockup-bar{background:var(--bg3);padding:12px 18px;display:flex;align-items:center;gap:8px;border-bottom:1px solid var(--border)}
  .dot{width:12px;height:12px;border-radius:50%}
  .mockup-inner{display:flex;height:380px}
  .m-sidebar{width:170px;background:rgba(0,0,0,0.3);border-right:1px solid var(--border);padding:16px 0;flex-shrink:0}
  .m-logo{padding:0 16px 16px;font-weight:700;font-size:17px}
  .m-section{padding:12px 16px 6px;font-size:10px;font-weight:700;letter-spacing:1.5px;color:rgba(255,255,255,0.2);text-transform:uppercase}
  .m-item{padding:8px 16px;font-size:12px;color:var(--muted);display:flex;align-items:center;gap:8px}
  .m-item.active{color:white;background:rgba(0,99,229,0.15);border-right:2px solid var(--accent)}
  .m-main{flex:1;padding:22px;overflow:hidden}
  .m-title{font-size:20px;font-weight:700;margin-bottom:14px}
  .m-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:8px}
  .m-card{border-radius:7px;overflow:hidden;background:var(--bg3);aspect-ratio:2/3;display:flex;align-items:center;justify-content:center;font-size:22px}
  section{position:relative;z-index:1;padding:100px 60px;max-width:1200px;margin:0 auto}
  .s-label{font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--accent2);margin-bottom:16px}
  .s-title{font-size:clamp(32px,5vw,52px);font-weight:700;letter-spacing:-1.5px;line-height:1.1;margin-bottom:20px}
  .s-sub{font-size:17px;color:var(--muted);line-height:1.7;max-width:560px}
  .features-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:2px;margin-top:60px;border:1px solid var(--border);border-radius:var(--radius);overflow:hidden}
  .f-card{background:var(--bg2);padding:36px 32px;border-right:1px solid var(--border);border-bottom:1px solid var(--border);transition:background 0.2s}
  .f-card:hover{background:var(--bg3)}
  .f-icon{font-size:32px;margin-bottom:16px}
  .f-title{font-size:16px;font-weight:600;margin-bottom:10px}
  .f-desc{font-size:14px;color:var(--muted);line-height:1.6}
  .specs-layout{display:grid;grid-template-columns:1fr 1fr;gap:60px;margin-top:60px}
  .sg-title{font-size:12px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--accent2);margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid var(--border)}
  .spec-row{display:flex;justify-content:space-between;align-items:center;padding:11px 0;border-bottom:1px solid rgba(255,255,255,0.03);font-size:14px}
  .spec-label{color:var(--muted)}
  .spec-val{font-weight:500;font-family:'JetBrains Mono',monospace;font-size:13px}
  .tag{background:rgba(0,99,229,0.15);color:var(--accent2);padding:3px 10px;border-radius:6px;font-size:12px;font-weight:600}
  .tag.green{background:rgba(16,185,129,0.15);color:#34d399}
  .tag.yellow{background:rgba(245,158,11,0.15);color:#fbbf24}
  .spec-group{margin-bottom:40px}
  .ports-row{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:48px}
  .port-card{background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius);padding:28px 24px;display:flex;align-items:center;gap:16px}
  .port-num{font-family:'JetBrains Mono',monospace;font-size:22px;font-weight:700;color:var(--accent2);min-width:64px}
  .port-label{font-size:14px;font-weight:500}
  .port-sub{font-size:12px;color:var(--muted);margin-top:3px}
  .install-box{background:var(--bg2);border:1px solid var(--border);border-radius:20px;padding:60px}
  .steps{display:grid;grid-template-columns:repeat(3,1fr);gap:40px;margin-top:48px}
  .step-num{font-size:48px;font-weight:700;color:rgba(0,99,229,0.3);line-height:1;margin-bottom:12px;font-family:'JetBrains Mono',monospace}
  .step-title{font-size:16px;font-weight:600;margin-bottom:8px}
  .step-desc{font-size:14px;color:var(--muted);line-height:1.6}
  .code-block{background:rgba(0,0,0,0.5);border:1px solid rgba(255,255,255,0.07);border-radius:10px;padding:20px 24px;font-family:'JetBrains Mono',monospace;font-size:13px;color:#a8d4ff;margin-top:12px;line-height:1.8}
  .code-comment{color:rgba(255,255,255,0.25)}
  .divider{width:100%;height:1px;background:var(--border)}
  footer{position:relative;z-index:1;text-align:center;padding:60px;border-top:1px solid var(--border);color:var(--muted);font-size:14px}
  footer a{color:var(--accent2);text-decoration:none}
  @media(max-width:768px){nav{padding:16px 24px}.nav-links{display:none}section{padding:60px 24px}.features-grid,.specs-layout,.steps,.ports-row{grid-template-columns:1fr}.install-box{padding:36px 24px}}
</style>
</head>
<body>
<div id="stars"></div>

<nav>
  <div class="nav-logo">✦ Orion</div>
  <div class="nav-links">
    <a href="#features">Features</a>
    <a href="#specs">Specs</a>
    <a href="#install">Install</a>
    <a href="https://github.com/rpoltera">GitHub</a>
  </div>
</nav>

<div class="hero">
  <div style="position:absolute;top:15%;left:50%;transform:translateX(-50%);width:600px;height:600px;background:radial-gradient(circle,rgba(0,99,229,0.18) 0%,transparent 70%);pointer-events:none"></div>
  <div class="hero-badge">⚡ Hardware Transcoding · Self-Hosted · Windows</div>
  <h1>Orion</h1>
  <p>A self-hosted media server and player built for your home. Stream any format to any device with real-time hardware transcoding.</p>
  <div class="hero-buttons">
    <a href="#install" class="btn-primary">▶ Get Started</a>
    <a href="#features" class="btn-ghost">Explore Features →</a>
  </div>
  <div class="mockup-wrap">
    <div class="mockup-frame">
      <div class="mockup-bar">
        <div class="dot" style="background:#ff5f57"></div>
        <div class="dot" style="background:#febc2e"></div>
        <div class="dot" style="background:#28c840"></div>
        <span style="margin-left:12px;font-size:12px;color:rgba(255,255,255,0.2);font-family:monospace">Orion — Media Server</span>
      </div>
      <div class="mockup-inner">
        <div class="m-sidebar">
          <div class="m-logo">✦ Orion</div>
          <div class="m-section">Browse</div>
          <div class="m-item active">🏠 Home</div>
          <div class="m-item">📁 Collections</div>
          <div class="m-item">🎬 Movies</div>
          <div class="m-item">📺 TV Shows</div>
          <div class="m-section">Live</div>
          <div class="m-item">📡 Live TV</div>
          <div class="m-item">▶ Pluto TV</div>
          <div class="m-section">System</div>
          <div class="m-item">⚙️ Settings</div>
        </div>
        <div class="m-main">
          <div class="m-title">🎬 Recent Movies</div>
          <div class="m-grid">
            <div class="m-card" style="background:linear-gradient(135deg,#1a2240,#0d1530)">🎬</div>
            <div class="m-card" style="background:linear-gradient(135deg,#1a1030,#0d0a20)">🎭</div>
            <div class="m-card" style="background:linear-gradient(135deg,#0a1a12,#051a0d)">🚀</div>
            <div class="m-card" style="background:linear-gradient(135deg,#1a0a0a,#200505)">💥</div>
            <div class="m-card" style="background:linear-gradient(135deg,#0a0a1a,#050520)">⚔️</div>
          </div>
          <div style="margin-top:20px;font-size:12px;color:rgba(255,255,255,0.25);font-weight:600;letter-spacing:1px;text-transform:uppercase">7,612 Movies · 779 TV Shows</div>
          <div style="display:flex;gap:4px;margin-top:12px">
            <div style="height:3px;border-radius:2px;background:#0063e5;flex:3"></div>
            <div style="height:3px;border-radius:2px;background:#34d399;flex:2"></div>
            <div style="height:3px;border-radius:2px;background:#a78bfa;flex:1.5"></div>
            <div style="height:3px;border-radius:2px;background:#fbbf24;flex:1"></div>
            <div style="height:3px;border-radius:2px;background:rgba(255,255,255,0.1);flex:4"></div>
          </div>
          <div style="margin-top:24px;display:flex;gap:8px;flex-wrap:wrap">
            <span style="background:rgba(0,99,229,0.15);color:#60a5fa;padding:4px 12px;border-radius:20px;font-size:11px;font-weight:600">Action (1,204)</span>
            <span style="background:rgba(16,185,129,0.15);color:#34d399;padding:4px 12px;border-radius:20px;font-size:11px;font-weight:600">Drama (987)</span>
            <span style="background:rgba(139,92,246,0.15);color:#a78bfa;padding:4px 12px;border-radius:20px;font-size:11px;font-weight:600">Comedy (742)</span>
            <span style="background:rgba(245,158,11,0.15);color:#fbbf24;padding:4px 12px;border-radius:20px;font-size:11px;font-weight:600">Animation (418)</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>

<div class="divider"></div>

<section id="features">
  <div class="s-label">What it does</div>
  <div class="s-title">Everything your<br>media library needs</div>
  <div class="s-sub">Orion handles your entire media workflow — from scanning folders to streaming anywhere — without subscriptions or cloud dependencies.</div>
  <div class="features-grid">
    <div class="f-card"><div class="f-icon">⚡</div><div class="f-title">Hardware Transcoding</div><div class="f-desc">Real-time AMD AMF, NVIDIA NVENC, and Intel Quick Sync. Any format → MP4 in milliseconds.</div></div>
    <div class="f-card"><div class="f-icon">🎬</div><div class="f-title">Universal Formats</div><div class="f-desc">MKV, AVI, WMV, MOV, FLV and more. Plays anything your library throws at it.</div></div>
    <div class="f-card"><div class="f-icon">🌐</div><div class="f-title">Remote Access</div><div class="f-desc">Cloudflare Tunnel support. Access your library from anywhere — phone, tablet, smart TV.</div></div>
    <div class="f-card"><div class="f-icon">👥</div><div class="f-title">Multi-User Accounts</div><div class="f-desc">Create users and groups with per-user media access control. Admin and standard roles.</div></div>
    <div class="f-card"><div class="f-icon">🎭</div><div class="f-title">Rich Metadata</div><div class="f-desc">TMDB, OMDb, TVMaze. Posters, ratings, overviews, and cast fetched automatically.</div></div>
    <div class="f-card"><div class="f-icon">📁</div><div class="f-title">Franchise Collections</div><div class="f-desc">Auto-build franchise collections from TMDB (Batman, MCU, etc.) with poster art.</div></div>
    <div class="f-card"><div class="f-icon">📺</div><div class="f-title">Live TV & IPTV</div><div class="f-desc">M3U playlist support with channel management. Pluto TV and Roku Channel built-in.</div></div>
    <div class="f-card"><div class="f-icon">📖</div><div class="f-title">Chapters & Skip Intro</div><div class="f-desc">Full chapter support with seek bar markers. Set custom intro/outro skip points per episode.</div></div>
    <div class="f-card"><div class="f-icon">🔧</div><div class="f-title">Debug Tools</div><div class="f-desc">Built-in debug logging with downloadable logs. Diagnose any playback issue in seconds.</div></div>
  </div>
</section>

<div class="divider"></div>

<section id="specs">
  <div class="s-label">Technical Details</div>
  <div class="s-title">Built for performance<br>and reliability</div>
  <div class="specs-layout">
    <div>
      <div class="spec-group">
        <div class="sg-title">System Requirements</div>
        <div class="spec-row"><span class="spec-label">OS</span><span class="spec-val">Windows 10/11 (64-bit)</span></div>
        <div class="spec-row"><span class="spec-label">Node.js</span><span class="spec-val">v18 or later</span></div>
        <div class="spec-row"><span class="spec-label">RAM</span><span class="spec-val">4GB min / 8GB recommended</span></div>
        <div class="spec-row"><span class="spec-label">Network</span><span class="spec-val">Gigabit LAN recommended</span></div>
      </div>
      <div class="spec-group">
        <div class="sg-title">Hardware Encoders</div>
        <div class="spec-row"><span class="spec-label">AMD</span><span class="spec-val"><span class="tag green">h264_amf</span></span></div>
        <div class="spec-row"><span class="spec-label">NVIDIA</span><span class="spec-val"><span class="tag green">h264_nvenc</span></span></div>
        <div class="spec-row"><span class="spec-label">Intel</span><span class="spec-val"><span class="tag green">h264_qsv</span></span></div>
        <div class="spec-row"><span class="spec-label">Fallback</span><span class="spec-val"><span class="tag yellow">libx264 CPU</span></span></div>
      </div>
    </div>
    <div>
      <div class="spec-group">
        <div class="sg-title">Tech Stack</div>
        <div class="spec-row"><span class="spec-label">Shell</span><span class="spec-val">Electron 27</span></div>
        <div class="spec-row"><span class="spec-label">Frontend</span><span class="spec-val">React 18 + Socket.io</span></div>
        <div class="spec-row"><span class="spec-label">Backend</span><span class="spec-val">Express + Socket.io</span></div>
        <div class="spec-row"><span class="spec-label">Video</span><span class="spec-val">fluent-ffmpeg + ffmpeg-static</span></div>
        <div class="spec-row"><span class="spec-label">Database</span><span class="spec-val">JSON flat-file</span></div>
        <div class="spec-row"><span class="spec-label">Metadata</span><span class="spec-val">TMDB · OMDb · TVMaze</span></div>
      </div>
      <div class="spec-group">
        <div class="sg-title">Metadata Sources</div>
        <div class="spec-row"><span class="spec-label">TVMaze</span><span class="spec-val"><span class="tag green">Free — No key needed</span></span></div>
        <div class="spec-row"><span class="spec-label">OMDb</span><span class="spec-val"><span class="tag green">Free — 1,000/day</span></span></div>
        <div class="spec-row"><span class="spec-label">TMDB</span><span class="spec-val"><span class="tag green">Free — API key required</span></span></div>
      </div>
    </div>
  </div>
  <div class="ports-row">
    <div class="port-card"><div class="port-num">3000</div><div><div class="port-label">React Frontend</div><div class="port-sub">Development server</div></div></div>
    <div class="port-card"><div class="port-num">3001</div><div><div class="port-label">API + Socket.io</div><div class="port-sub">Media server & streaming</div></div></div>
    <div class="port-card"><div class="port-num">/tv</div><div><div class="port-label">TV Web Client</div><div class="port-sub">Browser-based TV interface</div></div></div>
  </div>
</section>

<div class="divider"></div>

<section id="install">
  <div class="install-box">
    <div class="s-label">Get Started</div>
    <div class="s-title" style="font-size:clamp(28px,4vw,42px)">Up and running<br>in minutes</div>
    <div class="steps">
      <div>
        <div class="step-num">01</div>
        <div class="step-title">Install dependencies</div>
        <div class="step-desc">Clone the repo and install Node packages.</div>
        <div class="code-block"><span class="code-comment"># In PowerShell</span><br>npm install</div>
      </div>
      <div>
        <div class="step-num">02</div>
        <div class="step-title">Start the services</div>
        <div class="step-desc">Open 3 PowerShell windows and run each command.</div>
        <div class="code-block">
          <span class="code-comment"># Window 1</span><br>npm run react-start<br><br>
          <span class="code-comment"># Window 2</span><br>npm run server<br><br>
          <span class="code-comment"># Window 3</span><br>npx electron .
        </div>
      </div>
      <div>
        <div class="step-num">03</div>
        <div class="step-title">Add your library</div>
        <div class="step-desc">Create your admin account, then add your media folders in Settings.</div>
        <div class="code-block">
          <span class="code-comment"># Supported paths</span><br>
          C:\Movies\<br>D:\TV Shows\<br>\\server\media\
        </div>
      </div>
    </div>
  </div>
</section>

<footer>
  <div style="font-size:28px;margin-bottom:12px">✦</div>
  <div style="font-size:18px;font-weight:700;margin-bottom:8px">Orion</div>
  <div>Built by <a href="https://github.com/rpoltera">Raymond Poltera</a> · Private Project</div>
  <div style="margin-top:16px;font-size:12px;opacity:0.4">© 2026 Orion Media Server. All rights reserved.</div>
</footer>

<script>
const c=document.getElementById('stars');
for(let i=0;i<200;i++){const s=document.createElement('div');s.className='star';const sz=Math.random()*2+0.5;s.style.cssText=`left:${Math.random()*100}%;top:${Math.random()*100}%;width:${sz}px;height:${sz}px;--d:${2+Math.random()*4}s;--o:${0.2+Math.random()*0.7};animation-delay:${Math.random()*4}s`;c.appendChild(s)}
document.querySelectorAll('a[href^="#"]').forEach(a=>{a.addEventListener('click',e=>{e.preventDefault();document.querySelector(a.getAttribute('href'))?.scrollIntoView({behavior:'smooth'})})});
</script>
</body>
</html>

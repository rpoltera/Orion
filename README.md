install for orion server lxc is bash <(curl -fsSL https://raw.githubusercontent.com/rpoltera/Orion/main/Orion_Server/create_lxc.sh)

<p align="center">
  <img src="/Orion_Server/assets/logo.png" width="180" alt="Orion Logo" />
</p>
<p align="center">A powerful personal media server for Proxmox — with IPTV, hardware transcoding, and streaming service integration.</p>

<p align="center">
  <img src="https://img.shields.io/badge/status-alpha-orange?style=flat-square" alt="Status: Alpha" />
  <img src="https://img.shields.io/badge/license-Custom_Attribution-green?style=flat-square" alt="License: Custom Attribution" />
</p>

<hr />

<h2>👤 Creator</h2>
<p>Created by <strong>Raymond Poltera</strong></p>

<h2>✨ Features</h2>
<ul>
  <li>🎬 <strong>Movies, TV Shows, Music &amp; Music Videos</strong> — scan local folders</li>
  <li>📡 <strong>IPTV / M3U</strong> — load any M3U playlist for live TV</li>
  <li>⚡ <strong>Hardware Transcoding</strong> — NVIDIA NVENC, Intel QSV, AMD AMF auto-detected</li>
  <li>🎨 <strong>Themes</strong> — Disney+, Plex, Netflix, Midnight Purple, Emerald Night</li>
  <li>📺 <strong>Streaming Integration</strong> — Pluto TV, The Roku Channel</li>
  <li>🔍 <strong>Global Search</strong> — search across your entire library</li>
  <li>💾 <strong>Persistent Settings</strong> — library paths, transcode preferences saved locally</li>
</ul>

<h2>🚀 Getting Started</h2>
<h3>Prerequisites</h3>
<ul>
  <li>Node.js v18+</li>
  <li>FFmpeg in system PATH (for transcoding)</li>
</ul>

<h2>⚠️ Platform Support</h2>
<ul>
  <li>Linux (Primary / Proxmox environments)</li>
  <li>Windows support — in development (not yet available)</li>
</ul>

<h2>🎨 Default Theme</h2>
<p>Orion launches with a Disney+ inspired dark blue theme. Switch themes in Settings.</p>

<h2>🛠 Hardware Transcoding</h2>
<p>Orion auto-detects your GPU encoder on first launch:</p>

<table align="center">
  <thead>
    <tr>
      <th>GPU</th>
      <th>Encoder</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>NVIDIA</td>
      <td><code>h264_nvenc</code></td>
    </tr>
    <tr>
      <td>Intel</td>
      <td><code>h264_qsv</code></td>
    </tr>
    <tr>
      <td>AMD</td>
      <td><code>h264_amf</code></td>
    </tr>
    <tr>
      <td>Fallback</td>
      <td><code>libx264</code> (CPU)</td>
    </tr>
  </tbody>
</table>

<h2>📄 License</h2>
<p>This project is open source under a <strong>Custom Attribution License</strong>.</p>

<ul>
  <li>✔ You may use and modify the software</li>
  <li>✔ You may distribute your own versions</li>
  <li>❗ You may not claim this project as your original work</li>
  <li>❗ You must acknowledge <strong>Raymond Poltera</strong> as the original creator in a visible way, such as in documentation, UI, or repository</li>
</ul>

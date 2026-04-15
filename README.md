install for orion server lxc is bash <(curl -fsSL https://raw.githubusercontent.com/rpoltera/Orion/main/Orion_Server/create_lxc.sh)

<p align="center">
  <img src="/Orion_Server/assets/logo.png" width="180" alt="Orion Logo" />
</p>
<h1 align="center">Orion</h1>
<p align="center">A powerful personal media server for Windows — with IPTV, hardware transcoding, and streaming service integration.</p>
<p align="center">
  <img src="https://img.shields.io/badge/platform-Windows-blue?style=flat-square" />
  <img src="https://img.shields.io/badge/status-alpha-orange?style=flat-square" />
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" />
</p>
---
✨ Features
🎬 Movies, TV Shows, Music & Music Videos — scan local folders
📡 IPTV / M3U — load any M3U playlist for live TV
⚡ Hardware Transcoding — NVIDIA NVENC, Intel QSV, AMD AMF auto-detected
🎨 Themes — Disney+, Plex, Netflix, Midnight Purple, Emerald Night
📺 Streaming Integration — Pluto TV, The Roku Channel
🔍 Global Search — search across your entire library
💾 Persistent Settings — library paths, transcode preferences saved locally
🚀 Getting Started
Prerequisites
Node.js v18+
FFmpeg in system PATH (for transcoding)
Development
```bash
git clone https://github.com/YOUR_USERNAME/orion.git
cd orion
npm install
npm start
```
Build Windows Installer
```bash
npm run dist
```
Output will be in `/dist/` as a `.exe` NSIS installer.
🎨 Default Theme
Orion launches with a Disney+ inspired dark blue theme. Switch themes in Settings.
🛠 Hardware Transcoding
Orion auto-detects your GPU encoder on first launch:
GPU	Encoder
NVIDIA	h264_nvenc
Intel	h264_qsv
AMD	h264_amf
Fallback	libx264 (CPU)
📄 License
MIT — free to use, modify, and distribute.

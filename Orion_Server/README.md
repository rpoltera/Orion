# Orion

> A self-hosted **IPTV and 24/7 streaming platform** for Proxmox — not a traditional media server. Orion turns your library and IPTV sources into **live broadcast channels** with multi-GPU hardware transcoding and HLS distribution.

**One-line install on Proxmox host:**
```bash
bash <(curl -fsSL https://raw.githubusercontent.com/rpoltera/Orion/main/Orion_Server/create_lxc.sh)
```

![Orion Logo]()

**Status:** Alpha &nbsp;·&nbsp; **License:** Custom Attribution

---

## What Orion is (and isn't)

**Is:**
- A **24/7 broadcasting platform** — your library becomes scheduled live channels
- An **IPTV aggregator** — import M3U/M3U8 sources, rebroadcast as HLS
- A **multi-GPU transcoding system** with real-time load balancing
- A **real-time HLS streaming server** with per-channel ffmpeg playout

**Isn't:**
- A Plex/Jellyfin-style "browse and click play" media server
- A DVR
- A simple file streamer or VOD service

Think of it as **your own cable TV station** — you decide what plays on each channel, when, and from what sources. Channels run continuously whether anyone is watching or not.

---

## 👤 Creator

Created by **Raymond Poltera**

---

## ✨ Features

### 📡 Channel Engine
- **24/7 custom channels** — Build channels from your library with rotating playlists, time-blocked schedules (kids in morning, sitcoms at night, etc.)
- **Concat-based playout** — Each channel runs as a continuous ffmpeg process reading a curated playlist file
- **Live IPTV passthrough** — Import any M3U/M3U8 source, rebroadcast as HLS to your local network
- **EPG (Electronic Program Guide)** — Schedule view showing what's playing now and next
- **Per-channel transcoding** — Independent resolution/bitrate/encoder settings per channel

### ⚡ Hardware Transcoding
- **Multi-GPU NVIDIA NVENC** with live load balancing — Orion tracks per-GPU encoder load and assigns new streams to the least-loaded GPU
- **Intel QSV** and **AMD AMF** support (auto-detected on first launch)
- **CUDA-accelerated scaling** (`scale_cuda`) — full GPU pipeline, no CPU bottleneck
- **10-bit HEVC detection** — Pascal GPUs (P40, GTX 10xx) can't NVENC-encode 10-bit. Orion auto-detects these sources and routes them to the convert service for re-encoding
- Configurable bitrate, max resolution, audio channels, audio language preference

### 🔄 Three-Service Architecture

| Service | Port | Purpose |
|---|---|---|
| `orion` | 3001 | API · web UI · live playout engine · channel scheduling |
| `orion-preseg` | 3002 | Pre-segmentation worker — converts library files to HLS-ready chunks |
| `orion-convert` | 3003 | Format conversion queue — re-encodes incompatible files (10-bit HEVC, weird codecs) to a uniform target |

Each service has its own systemd unit, its own config, its own port, and can be restarted independently without disrupting the others.

### 🗄️ Storage Layer

**SQLite database** (`/var/lib/orion/orion.db`):

| Table | Contents |
|---|---|
| `media_probe` | ffprobe results per file — codec, resolution, bit depth, audio language, duration |
| `item_details` | Per-item metadata (titles, descriptions, tags) |
| `hls_status` | Pre-segmentation state per file (queued / running / done / error) |
| `convert_status` | Convert queue state per file (with progress, ETA, GPU assignment) |
| `meta` | System-level metadata and migration state |
| `kv_objects` / `kv_arrays` | Generic key/value stores for config |

**JSON configuration files** (`/var/lib/orion/`):

| File | Purpose |
|---|---|
| `config.json` | Service map (which services run on which ports) |
| `iptv_channels.json` | Master IPTV channel catalog with source URLs |
| `sf/config.json` | StreamForge runtime — transcoding settings, GPU count, encoder, audio prefs |
| `sf/channels.json` | Custom channel definitions (id, name, content rules) |
| `sf/streams.json` | Active stream state |
| `sf/preseg.json` | Pre-segmentation worker config |
| `sf/preseg-queue.json` | Pending pre-segmentation jobs |
| `sf/probe-cache.json` | Cached ffprobe results |
| `sf/concat/{uuid}.txt` | Per-channel concat playlist (the file list each channel cycles through) |
| `sf/hls/{uuid}/` | Per-stream HLS segments and manifests served to clients |

All of this is editable via the **Settings** page in the web UI.

### 🎬 Library Scanner
- Scans local folders or NFS mounts for movies, TV shows, music, music videos
- **Automatic probing** — duration, codec, resolution, bit depth, audio language, audio channels
- **Global search** across the entire library in milliseconds
- SQLite-backed — fast even with 40,000+ items
- Re-scan on demand or on schedule

### 🤖 AI Suggestions
Built-in system auditor pluggable to **OpenAI**, **Anthropic**, or local **Ollama**:
- Ranked findings (🔴 critical / 🟡 warning / 🔵 info) with expandable evidence
- **Copy for AI** — one-click full snapshot ready to paste into ChatGPT/Claude/Gemini
- **JSON snapshot download** for offline analysis
- Snapshot includes: system stats, GPU telemetry, service health, recent journalctl errors per service, library counts, redacted sfConfig

### 📊 System Status
Live monitoring dashboard:
- CPU per-core utilization with rolling history
- Memory + swap usage
- Disk usage with per-mount breakdown
- Network throughput (RX/TX) with rate calculation
- GPU panels per device — utilization, encoder load, memory, temperature
- Service health indicators with recent error feed per service

### 🎨 Themes
Disney+ · Plex · Netflix · Midnight Purple · Emerald Night — switch in Settings → Appearance

### 🌐 External Service Integration
Pluto TV · The Roku Channel · (more in development)

---

## 🚀 Getting Started

### Recommended: One-line install on Proxmox host

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/rpoltera/Orion/main/Orion_Server/create_lxc.sh)
```

Creates an LXC container with:
- Ubuntu 22.04 LTS
- Node.js v18+
- FFmpeg with NVENC support
- NVIDIA driver hooks (for GPU passthrough)
- systemd units for the three services

### Manual install (any Linux)

**Prerequisites:**
- Node.js v18+
- FFmpeg in `$PATH` (with NVENC for NVIDIA hardware acceleration)
- SQLite

```bash
git clone https://github.com/rpoltera/Orion.git
cd Orion/Orion_Server
npm install
npm run react-build
node server/index.js
```

Open `http://<host>:3001` in your browser.

---

## ⚠️ Platform Support

| Platform | Status |
|---|---|
| **Linux — Proxmox LXC** | ✅ Primary supported target |
| **Linux — bare metal / VM** | ✅ Should work |
| **Windows** | 🚧 In development |
| **macOS** | ❓ Untested |

---

## 🛠 Hardware Transcoding Matrix

| GPU Family | Video Encoder | Notes |
|---|---|---|
| NVIDIA Pascal (P40, GTX 10xx) | `h264_nvenc` / `hevc_nvenc` | 8-bit encode only |
| NVIDIA Turing+ (RTX 20xx and newer) | `h264_nvenc` / `hevc_nvenc` | 10-bit encode supported |
| Intel (QuickSync) | `h264_qsv` / `hevc_qsv` | |
| AMD | `h264_amf` / `hevc_amf` | |
| **Fallback** | `libx264` (CPU) | When no GPU detected |

NVENC concurrent session limits are respected. The convert service auto-queues 10-bit HEVC sources for re-encoding when the live encoder can't handle them.

---

## 📡 Managing Services

Inside the LXC:

```bash
systemctl status orion orion-preseg orion-convert
systemctl restart orion-convert    # restart one without disturbing the others
journalctl -u orion -f             # live log
```

Or use the **Services** tab in the web UI for one-click start/stop/restart and log inspection.

---

## 🛡️ Production Hardening

For deployments doing serious transcoding work, run the included `orion-host-hardening.sh` on the Proxmox host. It configures:

- Coredumps disabled (prevents NFS deadlock chains)
- Per-service `MemoryMax` cgroup limits with `OOMPolicy=continue`
- NFS soft-mount semantics (kernel sync can't wedge)
- Hardware watchdog (softdog) — auto-reboot in 3 minutes if anything hangs
- LXC memory + swap rebalancing
- Optional 4am nightly reboot as defense-in-depth

The typical failure mode goes from "host wedged, manual reboot required" to "service auto-respawns in 5 seconds, you don't notice."

---

## 📄 License

Open source under a **Custom Attribution License**.

✔ You may use and modify the software  
✔ You may distribute your own versions  
❗ You **may not** claim this project as your original work  
❗ You **must** acknowledge **Raymond Poltera** as the original creator in a visible way — in documentation, UI, or repository

---

## 🙏 Built With

Node.js · Express · React · Tailwind CSS · SQLite · FFmpeg · NVIDIA Video Codec SDK · hls.js

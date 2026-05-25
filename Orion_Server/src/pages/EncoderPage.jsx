import React, { useState, useEffect, useCallback } from 'react';
import { Film, RefreshCw, Layers, Play, Save, Activity } from 'lucide-react';

const API = `http://${window.location.hostname}:3001/api`;
const CONVERT_API = '/api/sf/convert';
const PRESEG_API  = '/api/sf/preseg';

export default function EncoderPage({ initialTab = 'video' }) {
  const [tab, setTab] = useState(initialTab);
  useEffect(() => { setTab(initialTab); }, [initialTab]);

  const TABS = [
    { id: 'video',   icon: Film,    label: 'Video Encoder',   desc: 'Encode individual videos to h.264 or h.265' },
    { id: 'convert', icon: RefreshCw, label: '10-bit Converter', desc: 'Bulk convert 10-bit HEVC → 8-bit' },
    { id: 'preseg',  icon: Layers,  label: 'Pre-segmenter',  desc: 'Pre-generate HLS segments for instant playback' },
  ];

  return (
    <div className="page-content" style={{ padding: '24px 32px' }}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 4 }}>Encoder</h1>
        <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          Video conversion, transcoding, and HLS pre-segmentation tools.
        </p>
      </div>

      <div style={{ display: 'flex', gap: 4, marginBottom: 24, borderBottom: '1px solid var(--border)' }}>
        {TABS.map(t => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '10px 18px', background: 'none', border: 'none',
              borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
              color: active ? 'var(--accent)' : 'var(--text-muted)',
              fontWeight: active ? 700 : 500,
              fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', marginBottom: -1
            }}>
              <Icon size={14} /> {t.label}
            </button>
          );
        })}
      </div>

      {tab === 'video'   && <VideoEncoderTab />}
      {tab === 'convert' && <ServiceTab serviceName="Convert" baseUrl={CONVERT_API} description="Bulk converts 10-bit HEVC sources to 8-bit so they play on Pascal NVENC and older clients. Outputs go to /dev/shm during encode, then move atomically back to NFS." configKeys={CONVERT_CONFIG_KEYS} />}
      {tab === 'preseg'  && <ServiceTab serviceName="Preseg"  baseUrl={PRESEG_API}  description="Pre-segments media into HLS chunks so playback starts instantly when a channel is tuned." configKeys={PRESEG_CONFIG_KEYS} />}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
 * Video Encoder (placeholder — new feature, will build out)
 * ────────────────────────────────────────────────────────────────────────── */
function VideoEncoderTab() {
  const [params, setParams] = useState({
    inputPath: '',
    outputPath: '',
    // Video
    videoMode: 'encode',
    videoEncoder: 'h264_nvenc',
    videoPreset: 'p4',
    videoQualityCq: 21,
    gpu: 0,
    resolution: 'original',
    // Audio
    audioMode: 'copy',
    audioEncoder: 'aac',
    audioBitrate: '192k',
    audioSampleRate: 'source',
    audioChannels: 'source',
    audioCompressionLevel: 8,
  });
  const [jobs, setJobs] = useState([]);
  const [starting, setStarting] = useState(false);
  const [formError, setFormError] = useState(null);

  const videoEncoding = params.videoMode === 'encode';
  const audioEncoding = params.audioMode === 'encode';
  const isVideoNvenc = videoEncoding && params.videoEncoder.endsWith('_nvenc');
  const isFlac = audioEncoding && params.audioEncoder === 'flac';

  const videoPresetOptions = isVideoNvenc
    ? ['p1','p2','p3','p4','p5','p6','p7']
    : ['ultrafast','superfast','veryfast','faster','fast','medium','slow','slower','veryslow'];

  useEffect(function() {
    if (videoEncoding && !videoPresetOptions.includes(params.videoPreset)) {
      setParams(function(p) { return Object.assign({}, p, { videoPreset: isVideoNvenc ? 'p4' : 'medium' }); });
    }
  }, [params.videoEncoder, params.videoMode]); // eslint-disable-line

  const loadJobs = useCallback(async function() {
    try {
      const r = await fetch('/api/sf/encode/jobs');
      if (r.ok) { const d = await r.json(); setJobs(d.jobs || []); }
    } catch (e) {}
  }, []);

  useEffect(function() {
    loadJobs();
    const t = setInterval(loadJobs, 2000);
    return function() { clearInterval(t); };
  }, [loadJobs]);

  async function start() {
    if (!params.inputPath.trim()) { setFormError('Input path is required'); return; }
    if (params.videoMode === 'strip' && params.audioMode === 'strip') {
      setFormError('Cannot strip both video and audio'); return;
    }
    setStarting(true); setFormError(null);
    try {
      const r = await fetch('/api/sf/encode/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      if (!r.ok) {
        const d = await r.json().catch(function() { return {}; });
        setFormError(d.error || ('HTTP ' + r.status));
      } else { loadJobs(); }
    } catch (e) { setFormError(e.message); }
    setStarting(false);
  }

  async function cancel(jobId) {
    try { await fetch('/api/sf/encode/jobs/' + jobId, { method: 'DELETE' }); } catch (e) {}
    loadJobs();
  }

  function setField(k, v) { setParams(function(p) { return Object.assign({}, p, { [k]: v }); }); }

  const inputStyle = {
    width: '100%', padding: '8px 12px',
    background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
    borderRadius: 'var(--radius)', color: 'var(--text-primary)',
    fontSize: 13, fontFamily: 'inherit',
  };
  const sectionStyle = {
    background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
    borderRadius: 'var(--radius)', padding: 16,
  };
  const modeBtnStyle = function(active) { return {
    padding: '6px 12px',
    background: active ? 'var(--accent)' : 'transparent',
    border: '1px solid ' + (active ? 'var(--accent)' : 'var(--border)'),
    color: active ? '#fff' : 'var(--text-muted)',
    borderRadius: 'var(--radius)', fontSize: 12, fontWeight: active ? 700 : 500,
    cursor: 'pointer', fontFamily: 'inherit',
  }; };

  const runningJobs = jobs.filter(function(j) { return j.status === 'running'; });
  const recentJobs = jobs.filter(function(j) { return j.status !== 'running'; }).slice(0, 10);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Encode form */}
      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: 20 }}>
        <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 16 }}>New Encode Job</h3>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 12, marginBottom: 16 }}>
          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Input File Path *</label>
            <input type="text" value={params.inputPath} onChange={function(e) { setField('inputPath', e.target.value); }}
              placeholder="/mnt/jbod1/media/Movies/Title/file.mkv" style={inputStyle} />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
              Output Path <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional)</span>
            </label>
            <input type="text" value={params.outputPath} onChange={function(e) { setField('outputPath', e.target.value); }}
              placeholder={params.videoMode === 'strip' ? 'auto: .encoded.<audio ext>' : 'auto: same dir, .encoded.mp4'}
              style={inputStyle} />
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 14 }}>
          {/* ── VIDEO SECTION ── */}
          <div style={sectionStyle}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <h4 style={{ fontSize: 13, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-muted)' }}>Video</h4>
              <div style={{ display: 'flex', gap: 4 }}>
                <button style={modeBtnStyle(params.videoMode === 'encode')} onClick={function() { setField('videoMode', 'encode'); }}>Encode</button>
                <button style={modeBtnStyle(params.videoMode === 'copy')} onClick={function() { setField('videoMode', 'copy'); }}>Copy</button>
                <button style={modeBtnStyle(params.videoMode === 'strip')} onClick={function() { setField('videoMode', 'strip'); }}>Strip</button>
              </div>
            </div>

            {params.videoMode === 'encode' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Codec</label>
                  <select value={params.videoEncoder} onChange={function(e) { setField('videoEncoder', e.target.value); }} style={inputStyle}>
                    <option value="h264_nvenc">h264_nvenc (GPU)</option>
                    <option value="hevc_nvenc">hevc_nvenc (GPU, smaller)</option>
                    <option value="libx264">libx264 (CPU)</option>
                    <option value="libx265">libx265 (CPU, smallest)</option>
                  </select>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <div>
                    <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Preset</label>
                    <select value={params.videoPreset} onChange={function(e) { setField('videoPreset', e.target.value); }} style={inputStyle}>
                      {videoPresetOptions.map(function(p) { return <option key={p} value={p}>{p}</option>; })}
                    </select>
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                      {isVideoNvenc ? 'CQ' : 'CRF'}: {params.videoQualityCq}
                    </label>
                    <input type="range" min={15} max={35} value={params.videoQualityCq}
                      onChange={function(e) { setField('videoQualityCq', Number(e.target.value)); }} style={{ width: '100%' }} />
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <div>
                    <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>GPU</label>
                    <select value={params.gpu} onChange={function(e) { setField('gpu', Number(e.target.value)); }}
                      disabled={!isVideoNvenc} style={Object.assign({}, inputStyle, { opacity: isVideoNvenc ? 1 : 0.4 })}>
                      <option value={0}>GPU 0</option>
                      <option value={1}>GPU 1</option>
                      <option value={2}>GPU 2</option>
                      <option value={3}>GPU 3</option>
                    </select>
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Resolution</label>
                    <select value={params.resolution} onChange={function(e) { setField('resolution', e.target.value); }} style={inputStyle}>
                      <option value="original">Original</option>
                      <option value="3840x2160">4K</option>
                      <option value="1920x1080">1080p</option>
                      <option value="1280x720">720p</option>
                      <option value="854x480">480p</option>
                    </select>
                  </div>
                </div>
              </div>
            )}
            {params.videoMode === 'copy' && (
              <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: 8 }}>Video stream passed through unchanged (fastest).</div>
            )}
            {params.videoMode === 'strip' && (
              <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: 8 }}>Video removed — output will be audio-only.</div>
            )}
          </div>

          {/* ── AUDIO SECTION ── */}
          <div style={sectionStyle}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <h4 style={{ fontSize: 13, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-muted)' }}>Audio</h4>
              <div style={{ display: 'flex', gap: 4 }}>
                <button style={modeBtnStyle(params.audioMode === 'encode')} onClick={function() { setField('audioMode', 'encode'); }}>Encode</button>
                <button style={modeBtnStyle(params.audioMode === 'copy')} onClick={function() { setField('audioMode', 'copy'); }}>Copy</button>
                <button style={modeBtnStyle(params.audioMode === 'strip')} onClick={function() { setField('audioMode', 'strip'); }}>Strip</button>
              </div>
            </div>

            {params.audioMode === 'encode' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Codec</label>
                  <select value={params.audioEncoder} onChange={function(e) { setField('audioEncoder', e.target.value); }} style={inputStyle}>
                    <option value="aac">AAC (compatibility)</option>
                    <option value="libmp3lame">MP3 (universal)</option>
                    <option value="libopus">Opus (efficient)</option>
                    <option value="flac">FLAC (lossless)</option>
                    <option value="ac3">AC-3 (surround)</option>
                  </select>
                </div>
                {!isFlac && (
                  <div>
                    <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Bitrate</label>
                    <select value={params.audioBitrate} onChange={function(e) { setField('audioBitrate', e.target.value); }} style={inputStyle}>
                      <option value="64k">64 kbps</option>
                      <option value="96k">96 kbps</option>
                      <option value="128k">128 kbps</option>
                      <option value="160k">160 kbps</option>
                      <option value="192k">192 kbps (good)</option>
                      <option value="256k">256 kbps (excellent)</option>
                      <option value="320k">320 kbps (max VBR)</option>
                      <option value="640k">640 kbps (AC-3 surround)</option>
                    </select>
                  </div>
                )}
                {isFlac && (
                  <div>
                    <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>FLAC Compression: {params.audioCompressionLevel}</label>
                    <input type="range" min={0} max={12} value={params.audioCompressionLevel}
                      onChange={function(e) { setField('audioCompressionLevel', Number(e.target.value)); }} style={{ width: '100%' }} />
                  </div>
                )}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <div>
                    <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Sample Rate</label>
                    <select value={params.audioSampleRate} onChange={function(e) { setField('audioSampleRate', e.target.value); }} style={inputStyle}>
                      <option value="source">Source</option>
                      <option value="44100">44.1 kHz</option>
                      <option value="48000">48 kHz</option>
                      <option value="96000">96 kHz</option>
                    </select>
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Channels</label>
                    <select value={params.audioChannels} onChange={function(e) { setField('audioChannels', e.target.value); }} style={inputStyle}>
                      <option value="source">Source</option>
                      <option value="mono">Mono</option>
                      <option value="stereo">Stereo</option>
                      <option value="5.1">5.1 surround</option>
                    </select>
                  </div>
                </div>
              </div>
            )}
            {params.audioMode === 'copy' && (
              <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: 8 }}>Audio stream passed through unchanged (fastest).</div>
            )}
            {params.audioMode === 'strip' && (
              <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: 8 }}>Audio removed — output will be video-only.</div>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 18 }}>
          {formError ? <span style={{ fontSize: 12, color: '#ef4444' }}>{formError}</span> : <span/>}
          <button className="btn btn-primary" disabled={starting || !params.inputPath.trim()} onClick={start}
            style={{ opacity: (starting || !params.inputPath.trim()) ? 0.5 : 1, padding: '10px 22px' }}>
            <Film size={14} />
            <span style={{ marginLeft: 8 }}>{starting ? 'Starting...' : 'Start Encode'}</span>
          </button>
        </div>
      </div>

      {runningJobs.length > 0 && (
        <div>
          <h3 style={{ fontSize: 13, fontWeight: 700, marginBottom: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Running ({runningJobs.length})
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {runningJobs.map(function(j) { return <JobCard key={j.id} job={j} onCancel={cancel} />; })}
          </div>
        </div>
      )}

      {recentJobs.length > 0 && (
        <div>
          <h3 style={{ fontSize: 13, fontWeight: 700, marginBottom: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Recent ({recentJobs.length})
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {recentJobs.map(function(j) { return <JobCard key={j.id} job={j} onCancel={cancel} />; })}
          </div>
        </div>
      )}

      {jobs.length === 0 && (
        <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, padding: 20 }}>
          No encode jobs yet. Submit one above.
        </div>
      )}
    </div>
  );
}

function JobCard(props) {
  const j = props.job;
  const onCancel = props.onCancel;
  const isRunning = j.status === 'running';
  const isDone = j.status === 'done';
  const isError = j.status === 'error';
  const isCancelled = j.status === 'cancelled';

  const statusColor = isRunning ? '#6366f1' : isDone ? '#34d399' : isError ? '#ef4444' : '#9ca3af';
  const elapsedSec = (j.finishedAt || Date.now()) - j.startedAt;
  const elapsed = formatDuration(elapsedSec / 1000);
  const filename = j.inputPath.split('/').pop();

  let eta = null;
  if (isRunning && j.progress > 1 && j.progress < 100) {
    const totalSec = (elapsedSec / 1000) / (j.progress / 100);
    const remainingSec = totalSec - (elapsedSec / 1000);
    eta = formatDuration(remainingSec);
  }

  // Track summaries
  const vMode = j.videoMode || 'encode';
  const aMode = j.audioMode || 'copy';
  function videoSummary() {
    if (vMode === 'strip') return 'no video';
    if (vMode === 'copy')  return 'V: copy';
    let s = 'V: ' + j.videoEncoder + ' ' + (j.videoPreset || '') + ' ' + (j.videoEncoder && j.videoEncoder.endsWith('_nvenc') ? 'CQ' : 'CRF') + j.videoQualityCq;
    if (j.resolution && j.resolution !== 'original') s += ' ' + j.resolution;
    return s;
  }
  function audioSummary() {
    if (aMode === 'strip') return 'no audio';
    if (aMode === 'copy')  return 'A: copy';
    let s = 'A: ' + j.audioEncoder;
    if (j.audioEncoder === 'flac' && j.audioCompressionLevel != null) s += ' lvl' + j.audioCompressionLevel;
    else if (j.audioBitrate) s += ' ' + j.audioBitrate;
    if (j.audioSampleRate) s += ' ' + j.audioSampleRate + 'Hz';
    if (j.audioChannels) s += ' ' + j.audioChannels;
    return s;
  }

  return (
    <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '12px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: 1 }}>
          <span style={{
            fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 4,
            background: statusColor + '22', color: statusColor, textTransform: 'uppercase', letterSpacing: 0.5,
          }}>{j.status}</span>
          <span style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{filename}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 11, color: 'var(--text-muted)' }}>
          <span>{videoSummary()}</span>
          <span>·</span>
          <span>{audioSummary()}</span>
          {isRunning && <button onClick={function() { onCancel(j.id); }}
            style={{ marginLeft: 8, padding: '2px 8px', background: 'transparent', border: '1px solid #ef4444', color: '#ef4444', borderRadius: 4, fontSize: 11, cursor: 'pointer' }}>Cancel</button>}
        </div>
      </div>

      {isRunning && (
        <div style={{ marginTop: 6 }}>
          <div style={{ height: 5, background: 'var(--bg-tertiary)', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: (j.progress || 0) + '%', background: statusColor, transition: 'width 0.5s' }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
            <span>{(j.progress || 0).toFixed(1)}%</span>
            <span>elapsed {elapsed}{eta ? (' · ETA ' + eta) : ''}</span>
          </div>
        </div>
      )}

      {!isRunning && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          <span>took {elapsed}</span>
          {isDone && <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>output: {j.outputPath.split('/').pop()}</span>}
          {(isError || isCancelled) && j.error && <span style={{ color: '#ef4444' }}>{j.error}</span>}
        </div>
      )}
    </div>
  );
}

function formatDuration(sec) {
  if (!sec || sec < 0) return '0s';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h) return h + 'h ' + m + 'm';
  if (m) return m + 'm ' + s + 's';
  return s + 's';
}

/* ──────────────────────────────────────────────────────────────────────────
 * Generic service control panel (10-bit Convert + Pre-seg share the layout)
 * ────────────────────────────────────────────────────────────────────────── */
const CONVERT_CONFIG_KEYS = [
  { key: 'enabled',          label: 'Service Enabled',       type: 'bool' },
  { key: 'workers',          label: 'Workers',               type: 'number', min: 1, max: 16 },
  { key: 'encoder',          label: 'Output Encoder',        type: 'select', options: ['h264_nvenc','hevc_nvenc','libx264','libx265'] },
  { key: 'preset',           label: 'NVENC Preset',          type: 'select', options: ['p1','p2','p3','p4','p5','p6','p7'], hint: 'p1=fastest, p7=highest quality' },
  { key: 'qualityCq',        label: 'Quality (CQ)',          type: 'number', min: 15, max: 35, hint: 'Lower = higher quality, larger files' },
  { key: 'gpuCount',         label: 'GPU Count',             type: 'number', min: 1, max: 8 },
  { key: 'tempDir',          label: 'Temp Directory',        type: 'text',   hint: '/dev/shm for tmpfs (fast), or local disk path' },
  { key: 'outputMode',       label: 'Output Mode',           type: 'select', options: ['replace','alongside'] },
  { key: 'autoQueuePreseg',  label: 'Auto-queue to Preseg',  type: 'bool',   hint: 'After convert finishes, automatically queue for HLS pre-segmentation' },
];

const PRESEG_CONFIG_KEYS = [
  { key: 'enabled',         label: 'Service Enabled',     type: 'bool' },
  { key: 'workers',         label: 'Workers',             type: 'number', min: 1, max: 16 },
  { key: 'hwAccel',         label: 'Hardware Accel',      type: 'select', options: ['nvenc','qsv','amf','cpu'] },
  { key: 'gpuCount',        label: 'GPU Count',           type: 'number', min: 1, max: 8 },
  { key: 'maxGpuPreseg',    label: 'Max GPU Workers',     type: 'number', min: 0, max: 16 },
  { key: 'maxCpuPreseg',    label: 'Max CPU Workers',     type: 'number', min: 0, max: 16 },
  { key: 'skip10Bit',       label: 'Skip 10-bit Sources', type: 'bool',   hint: 'Lets convert handle 10-bit content first' },
  { key: 'route10BitToCpu', label: 'Route 10-bit to CPU', type: 'bool',   hint: 'Use CPU for 10-bit decode (rare hardware fallback)' },
];

function ServiceTab({ serviceName, baseUrl, description, configKeys }) {
  const [status, setStatus] = useState(null);
  const [config, setConfig] = useState(null);
  const [edits,  setEdits]  = useState({});
  const [saving, setSaving] = useState(false);
  const [saved,  setSaved]  = useState(false);
  const [error,  setError]  = useState(null);

  const loadStatus = useCallback(async () => {
    try { const r = await fetch(`${baseUrl}/status`); if (r.ok) setStatus(await r.json()); }
    catch (e) { /* unreachable — service may be slow under load */ }
  }, [baseUrl]);

  const loadConfig = useCallback(async () => {
    try { const r = await fetch(`${baseUrl}/config`); if (r.ok) setConfig(await r.json()); }
    catch (e) { setError(e.message); }
  }, [baseUrl]);

  useEffect(() => { loadStatus(); loadConfig(); }, [loadStatus, loadConfig]);
  useEffect(() => {
    const t = setInterval(loadStatus, 5000);
    return () => clearInterval(t);
  }, [loadStatus]);

  const save = async () => {
    if (Object.keys(edits).length === 0) return;
    setSaving(true); setError(null);
    try {
      const r = await fetch(`${baseUrl}/config`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(edits),
      });
      if (!r.ok) throw new Error(await r.text());
      const updated = await r.json();
      // Some services wrap the config under `config` key, some don't
      setConfig(updated.config || updated);
      setEdits({});
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) { setError(e.message); }
    setSaving(false);
  };

  const valueOf = (k) => (k in edits ? edits[k] : (config ? config[k] : ''));
  const setVal  = (k, v) => setEdits(p => ({ ...p, [k]: v }));

  if (!config) {
    return <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)' }}>Loading {serviceName} config…</div>;
  }

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', maxWidth: 720 }}>{description}</p>
      </div>

      {/* Status cards */}
      {status && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12, marginBottom: 24 }}>
          {[
            { label: 'Workers',    value: `${status.workers ?? '–'}/${status.maxWorkers ?? '–'}` },
            { label: 'Processing', value: status.processing ?? '–' },
            { label: 'Queued',     value: (status.queued ?? '–').toLocaleString?.() ?? status.queued ?? '–' },
            { label: 'Done',       value: (status.done ?? '–').toLocaleString?.() ?? status.done ?? '–' },
            { label: 'Errors',     value: status.error ?? '–', warn: (status.error ?? 0) > 0 },
            { label: 'ETA',        value: status.etaSeconds == null ? '–' : status.etaSeconds < 60 ? '<1m' : status.etaSeconds < 3600 ? Math.round(status.etaSeconds/60)+'m' : status.etaSeconds < 86400 ? Math.floor(status.etaSeconds/3600)+'h '+Math.round((status.etaSeconds%3600)/60)+'m' : Math.floor(status.etaSeconds/86400)+'d '+Math.round((status.etaSeconds%86400)/3600)+'h' },
          ].map(c => (
            <div key={c.label} style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '12px 16px' }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>{c.label}</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: c.warn ? '#fbbf24' : 'var(--text-primary)' }}>{c.value}</div>
            </div>
          ))}
          {status.gpuLoad && (
            <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '12px 16px' }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>GPU Load</div>
              <div style={{ fontSize: 14, fontWeight: 700, fontFamily: 'monospace' }}>[{status.gpuLoad.join(', ')}]</div>
            </div>
          )}
        </div>
      )}

      {/* Configuration */}
      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
          <h3 style={{ fontSize: 15, fontWeight: 700 }}>Configuration</h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {saved && <span style={{ fontSize: 12, color: '#34d399' }}>Saved ✓</span>}
            {error && <span style={{ fontSize: 12, color: '#ef4444' }}>{error}</span>}
            <button
              className="btn btn-primary btn-sm"
              disabled={saving || Object.keys(edits).length === 0}
              onClick={save}
              style={{ opacity: (saving || Object.keys(edits).length === 0) ? 0.5 : 1 }}
            ><Save size={13} /> Save Changes</button>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
          {configKeys.map(field => (
            <ConfigField key={field.key} field={field} value={valueOf(field.key)} onChange={v => setVal(field.key, v)} dirty={field.key in edits} />
          ))}
        </div>
      </div>
    </div>
  );
}

function ConfigField({ field, value, onChange, dirty }) {
  const baseInputStyle = {
    width: '100%', padding: '8px 12px',
    background: 'var(--bg-tertiary)', border: `1px solid ${dirty ? 'var(--accent)' : 'var(--border)'}`,
    borderRadius: 'var(--radius)', color: 'var(--text-primary)', fontSize: 13, fontFamily: 'inherit',
  };
  return (
    <div>
      <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
        {field.label}
        {dirty && <span style={{ color: 'var(--accent)', marginLeft: 6 }}>•</span>}
      </label>
      {field.type === 'bool' && (
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input type="checkbox" checked={!!value} onChange={e => onChange(e.target.checked)} />
          <span style={{ fontSize: 13 }}>{value ? 'Enabled' : 'Disabled'}</span>
        </label>
      )}
      {field.type === 'number' && (
        <input type="number" value={value ?? ''} min={field.min} max={field.max}
          onChange={e => onChange(e.target.value === '' ? '' : Number(e.target.value))} style={baseInputStyle} />
      )}
      {field.type === 'text' && (
        <input type="text" value={value ?? ''} onChange={e => onChange(e.target.value)} style={baseInputStyle} />
      )}
      {field.type === 'select' && (
        <select value={value ?? ''} onChange={e => onChange(e.target.value)} style={baseInputStyle}>
          {field.options.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      )}
      {field.hint && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>{field.hint}</div>}
    </div>
  );
}

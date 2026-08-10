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
      {tab === 'preseg'  && <PresegActions baseUrl={PRESEG_API} />}
      {tab === 'preseg'  && <HideUnsegmentedPanel />}
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
  const [normalizer, setNormalizer] = useState(null);
  const [normalizerBusy, setNormalizerBusy] = useState(false);

  const loadNormalizer = useCallback(async function() {
    try {
      const r = await fetch('/api/sf/normalizer/status');
      if (r.ok) setNormalizer(await r.json());
    } catch (e) {}
  }, []);

  // fix-08: persist Normalizer safety settings
  // fix-12: nightly normalize task, read from the real scheduler list
  const [normTask, setNormTask] = React.useState(null);
  const [normBusy2, setNormBusy2] = React.useState(false);
  const [normMsg, setNormMsg] = React.useState('');

  const loadNormTask = React.useCallback(async function () {
    try {
      const r = await fetch('/api/scheduler');
      if (!r.ok) return;
      const d = await r.json();
      const t = (d.tasks || []).find(function (x) {
        return (x.type || '').toLowerCase().indexOf('normalize') !== -1;
      });
      setNormTask(t || null);
    } catch (e) { /* non-fatal */ }
  }, []);

  React.useEffect(function () { loadNormTask(); }, [loadNormTask]);

  async function runScheduledNormalize() {
    setNormBusy2(true);
    setNormMsg('');
    try {
      const r = await fetch('/api/sf/normalizer/queue-scheduled', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      const d = await r.json().catch(function () { return {}; });
      if (!r.ok) {
        setNormMsg('Failed: ' + (d.error || ('HTTP ' + r.status)));
      } else {
        setNormMsg(
          d.considered + ' scheduled \u2022 ' +
          d.queued + ' queued for conversion \u2022 ' +
          d.alreadyOk + ' already fine' +
          (d.missing ? ' \u2022 ' + d.missing + ' missing' : '')
        );
      }
    } catch (e) {
      setNormMsg('Failed: ' + e.message);
    }
    setNormBusy2(false);
  }

  async function toggleNightly(on, time) {
    setNormBusy2(true);
    try {
      if (on) {
        await fetch('/api/scheduler', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tasks: [{
              name: 'Normalize Scheduled Media',
              description: 'Convert upcoming scheduled episodes to H.264 8-bit + AAC',
              icon: '\u2699\ufe0f',
              type: 'normalize',
              schedule: 'daily',
              scheduleTime: time || '02:00',
              enabled: true
            }]
          })
        });
      } else if (normTask && normTask.id) {
        await fetch('/api/scheduler/' + normTask.id, { method: 'DELETE' });
      }
      await loadNormTask();
    } catch (e) {
      setNormMsg('Failed: ' + e.message);
    }
    setNormBusy2(false);
  }

  async function normalizerSettings(patch) {
    try {
      const r = await fetch('/api/sf/normalizer/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch)
      });
      if (r.status === 401) {
        alert('Not authorised. Please log in again.');
        return;
      }
      if (!r.ok) {
        const d = await r.json().catch(function() { return {}; });
        alert('Could not save: ' + (d.error || ('HTTP ' + r.status)));
        return;
      }
      // status refreshes on the next poll
    } catch (err) {
      alert('Could not save: ' + err.message);
    }
  }

  async function normalizerAction(action) {
    setNormalizerBusy(true);

    try {
      await fetch('/api/sf/normalizer/' + action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });

      await loadNormalizer();
    } catch (e) {
      setFormError(e.message);
    }

    setNormalizerBusy(false);
  }


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
    loadNormalizer();
    const t = setInterval(function() {
      loadJobs();
      loadNormalizer();
    }, 2000);
    return function() { clearInterval(t); };
  }, [loadJobs, loadNormalizer]);

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

      {/* Library Normalizer */}
      <div style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)',
        padding: 20
      }}>
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 16,
          marginBottom: 16
        }}>
          <div>
            <h3 style={{
              fontSize: 15,
              fontWeight: 700,
              marginBottom: 4
            }}>
              Library Normalizer
            </h3>

            <div style={{
              fontSize: 12,
              color: 'var(--text-muted)'
            }}>
              Gradually converts TV episodes to H.264 8-bit + AAC
              so Pre-segmenter can use the fast REMUX path.
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="btn btn-secondary"
              disabled={normalizerBusy}
              onClick={function() {
                normalizerAction('rescan');
              }}
            >
              Rescan
            </button>

            {normalizer && normalizer.enabled ? (
              <button
                className="btn btn-secondary"
                disabled={normalizerBusy}
                onClick={function() {
                  normalizerAction('pause');
                }}
              >
                Pause
              </button>
            ) : (
              <button
                className="btn btn-primary"
                disabled={normalizerBusy}
                onClick={function() {
                  normalizerAction('start');
                }}
              >
                Start Normalizer
              </button>
            )}
          </div>
        </div>

        {normalizer && (
          <>
            {normalizer.scanning && (
              <div style={{ marginBottom: 14 }}>
                <div style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  fontSize: 12,
                  marginBottom: 6
                }}>
                  <span style={{ color: 'var(--text-muted)' }}>
                    Scanning library&hellip;
                  </span>
                  <span style={{ color: 'var(--accent)', fontWeight: 700 }}>
                    {(normalizer.scanDone || 0).toLocaleString()}
                    {' / '}
                    {(normalizer.scanTotal || 0).toLocaleString()}
                    {normalizer.scanTotal
                      ? '  (' + Math.round(
                          (normalizer.scanDone || 0) /
                          normalizer.scanTotal * 100
                        ) + '%)'
                      : ''}
                  </span>
                </div>
                <div style={{
                  height: 6,
                  background: 'var(--bg-tertiary)',
                  borderRadius: 3,
                  overflow: 'hidden'
                }}>
                  <div style={{
                    height: '100%',
                    width: (normalizer.scanTotal
                      ? Math.min(100,
                          (normalizer.scanDone || 0) /
                          normalizer.scanTotal * 100)
                      : 0) + '%',
                    background: 'var(--accent)',
                    borderRadius: 3,
                    transition: 'width 0.4s ease'
                  }} />
                </div>
              </div>
            )}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              flexWrap: 'wrap',
              padding: '12px 14px',
              marginBottom: 14,
              background: 'var(--bg-tertiary)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <label style={{ fontSize: 12, fontWeight: 600 }}>
                  When converting:
                </label>
                <select
                  value={normalizer.outputMode || 'alongside'}
                  onChange={function(e) {
                    var mode = e.target.value;
                    if (mode === 'replace') {
                      var ok = window.confirm(
                        'Replace original files?\n\n' +
                        'Each converted episode will overwrite its source file. ' +
                        'This cannot be undone unless "keep backup" is enabled.\n\n' +
                        'Choose OK only if you are sure.'
                      );
                      if (!ok) return;
                    }
                    normalizerSettings({ outputMode: mode });
                  }}
                  style={{
                    padding: '6px 10px',
                    background: 'var(--bg-card)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius)',
                    color: 'var(--text-primary)',
                    fontSize: 12,
                    fontFamily: 'inherit'
                  }}
                >
                  <option value="alongside">
                    Keep original — write a new .h264 file
                  </option>
                  <option value="replace">
                    Replace original — saves disk space
                  </option>
                </select>
              </div>

              {normalizer.outputMode === 'replace' && (
                <label style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 12,
                  cursor: 'pointer'
                }}>
                  <input
                    type="checkbox"
                    checked={normalizer.keepBackup !== false}
                    onChange={function(e) {
                      normalizerSettings({ keepBackup: e.target.checked });
                    }}
                  />
                  Keep backup of each original until conversion is verified
                </label>
              )}

              <label style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 12,
                cursor: 'pointer',
                marginLeft: 'auto'
              }}>
                <input
                  type="checkbox"
                  checked={!!normalizer.dryRun}
                  onChange={function(e) {
                    normalizerSettings({ dryRun: e.target.checked });
                  }}
                />
                Dry run (report only, convert nothing)
              </label>

              {/* fix-12: scheduled-scope + nightly run */}
              <div style={{
                width: '100%',
                borderTop: '1px solid var(--border)',
                marginTop: 10,
                paddingTop: 10,
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                flexWrap: 'wrap'
              }}>
                <button
                  className="btn btn-secondary btn-sm"
                  disabled={normBusy2}
                  onClick={runScheduledNormalize}
                  title="Queue only episodes scheduled in the next few days"
                >
                  {normBusy2 ? 'Working\u2026' : 'Normalize Scheduled'}
                </button>

                <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                  Look ahead
                  <select
                    value={normalizer.scheduledDays || 3}
                    onChange={function (e) {
                      normalizerSettings({ scheduledDays: Number(e.target.value) });
                    }}
                    style={{
                      padding: '4px 8px',
                      background: 'var(--bg-card)',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius)',
                      color: 'var(--text-primary)',
                      fontSize: 12
                    }}
                  >
                    <option value={1}>1 day</option>
                    <option value={3}>3 days</option>
                    <option value={7}>7 days</option>
                    <option value={14}>14 days</option>
                  </select>
                </label>

                <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                  While watching
                  <select
                    value={normalizer.playbackPolicy || 'pause'}
                    onChange={function (e) {
                      normalizerSettings({ playbackPolicy: e.target.value });
                    }}
                    style={{
                      padding: '4px 8px',
                      background: 'var(--bg-card)',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius)',
                      color: 'var(--text-primary)',
                      fontSize: 12
                    }}
                  >
                    <option value="pause">Pause</option>
                    <option value="reduce">Reduce to one worker</option>
                    <option value="ignore">Keep running</option>
                  </select>
                </label>

                <label style={{
                  fontSize: 12,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  cursor: 'pointer',
                  marginLeft: 'auto'
                }}>
                  <input
                    type="checkbox"
                    checked={!!normTask}
                    disabled={normBusy2}
                    onChange={function (e) {
                      toggleNightly(e.target.checked, (normTask && normTask.scheduleTime) || '02:00');
                    }}
                  />
                  Run nightly at
                  <input
                    type="time"
                    value={(normTask && normTask.scheduleTime) || '02:00'}
                    disabled={!normTask || normBusy2}
                    onChange={function (e) {
                      toggleNightly(true, e.target.value);
                    }}
                    style={{
                      padding: '3px 6px',
                      background: 'var(--bg-card)',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius)',
                      color: 'var(--text-primary)',
                      fontSize: 12
                    }}
                  />
                </label>

                {normMsg && (
                  <div style={{
                    width: '100%',
                    fontSize: 11,
                    color: normMsg.indexOf('Failed') === 0 ? '#ef4444' : 'var(--text-muted)'
                  }}>
                    {normMsg}
                  </div>
                )}

                {normTask && normTask.lastRun && (
                  <div style={{ width: '100%', fontSize: 11, color: 'var(--text-muted)' }}>
                    Last nightly run: {new Date(normTask.lastRun).toLocaleString()}
                  </div>
                )}
              </div>

              {normalizer.outputMode === 'replace' &&
               normalizer.keepBackup === false && (
                <div style={{
                  width: '100%',
                  fontSize: 11,
                  color: '#fbbf24'
                }}>
                  Originals will be permanently replaced with no backup.
                </div>
              )}
            </div>
            <div style={{
              display: 'grid',
              gridTemplateColumns:
                'repeat(auto-fit, minmax(120px, 1fr))',
              gap: 10
            }}>
              {[
                ['Found', normalizer.stats?.discovered || 0],
                ['Ready', normalizer.stats?.compatible || 0],
                ['Queued', normalizer.stats?.queued || 0],
                ['Converted', normalizer.stats?.converted || 0],
                ['Errors', normalizer.stats?.errors || 0],
                ['Running',
                  Object.keys(normalizer.current || {}).length]
              ].map(function(x) {
                return (
                  <div
                    key={x[0]}
                    style={{
                      background: 'var(--bg-tertiary)',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius)',
                      padding: 12
                    }}
                  >
                    <div style={{
                      fontSize: 11,
                      color: 'var(--text-muted)'
                    }}>
                      {x[0]}
                    </div>

                    <div style={{
                      fontSize: 20,
                      fontWeight: 700,
                      marginTop: 3
                    }}>
                      {x[1]}
                    </div>
                  </div>
                );
              })}
            </div>

            <div style={{
              marginTop: 12,
              fontSize: 12,
              color: 'var(--text-muted)'
            }}>
              Status: <b>
                {normalizer.scanning
                  ? 'Scanning'
                  : normalizer.enabled
                    ? 'Running'
                    : 'Paused'}
              </b>
              {' • '}
              Normalizer GPUs available now:
              {' '}
              {(normalizer.gpuIds || []).join(', ')}
              {' • '}
              Preseg has priority
            </div>

            {(normalizer.stats?.errors || 0) > 0 && (
              <button
                className="btn btn-secondary btn-sm"
                style={{ marginTop: 10 }}
                onClick={function() {
                  normalizerAction('retry-errors');
                }}
              >
                Retry Errors
              </button>
            )}
          </>
        )}
      </div>

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

  { key: 'dailyScheduleEnabled', label: 'Daily Scheduled Media Only', type: 'bool', hint: 'Pre-segment only media scheduled on today’s channels' },
  { key: 'dailyScheduleTime', label: 'Daily Run Time', type: 'text', hint: '00:00 = midnight' },
  { key: 'purgeUnscheduled', label: 'Purge Unscheduled HLS', type: 'bool', hint: 'Delete Orion HLS not required by today’s schedule' },
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

  const runDailyNow = async () => {
    setError(null);

    try {
      const r = await fetch(`${baseUrl}/daily-run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });

      const d = await r.json();

      if (!r.ok) {
        throw new Error(d.error || ('HTTP ' + r.status));
      }

      alert(
        "Today's scheduled preseg started\n\n" +
        'Scheduled: ' + (d.scheduled ?? 0) + '\n' +
        'Queued: ' + (d.queued ?? 0) + '\n' +
        'Existing: ' + (d.existing ?? d.alreadyDone ?? 0) + '\n' +
        'Purged: ' + (d.purged ?? 0) + '\n' +
        'Missing: ' + (d.missing ?? 0)
      );

      loadStatus();
      loadConfig();

    } catch (e) {
      setError(e.message);
    }
  };


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

            {serviceName === 'Preseg' && (
              <button
                className="btn btn-primary btn-sm"
                onClick={runDailyNow}
              >
                <Play size={13} />
                <span style={{ marginLeft: 6 }}>
                  Run Today's Schedule Now
                </span>
              </button>
            )}
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

/* ──────────────────────────────────────────────────────────────────────────
 * Preseg Actions — Scan Library / Add Folder / Add File buttons
 * ────────────────────────────────────────────────────────────────────────── */
function PresegActions({ baseUrl }) {
  const [folderPath, setFolderPath] = useState('');
  const [filePath, setFilePath] = useState('');
  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState(null);

  const call = useCallback(async (endpoint, body, label) => {
    setBusy(label); setMsg(null);
    try {
      const r = await fetch(`${baseUrl}/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      const data = await r.json();
      if (!r.ok || data.error) {
        setMsg({ type: 'error', text: data.error || `HTTP ${r.status}` });
      } else {
        const parts = [];
        if (data.candidates != null) parts.push(`${data.candidates} found`);
        if (data.found != null)      parts.push(`${data.found} found`);
        if (data.queued != null)     parts.push(`${data.queued} queued`);
        if (data.skipped != null)    parts.push(`${data.skipped} skipped`);
        setMsg({ type: 'ok', text: parts.join(', ') || 'done' });
      }
    } catch (e) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setBusy(null);
    }
  }, [baseUrl]);

  const btnStyle = (active) => ({
    padding: '8px 14px',
    background: active ? 'var(--accent)' : 'var(--bg-elevated)',
    color: active ? 'white' : 'var(--text)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 600,
    opacity: busy && busy !== active ? 0.5 : 1,
  });
  const inputStyle = {
    flex: 1,
    padding: '8px 10px',
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    color: 'var(--text)',
    fontSize: 13,
  };

  return (
    <div style={{
      marginTop: 16,
      padding: 16,
      background: 'var(--bg-card)',
      border: '1px solid var(--border)',
      borderRadius: 8,
    }}>
      <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 12 }}>Library Actions</h3>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16 }}>
        Scan the entire library for unsegmented files, or manually queue a folder/file by absolute path.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

        {/* Scan Library */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            onClick={() => call('scan-library', {}, 'scan')}
            disabled={!!busy}
            style={btnStyle('scan')}
          >
            {busy === 'scan' ? 'Scanning…' : 'Scan Library'}
          </button>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Walks every TV show + movie, queues files not yet presegged.
          </span>
        </div>

        {/* Add Folder */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="text"
            placeholder="/mnt/jbod1/media/tv_shows/Some Show"
            value={folderPath}
            onChange={e => setFolderPath(e.target.value)}
            style={inputStyle}
          />
          <button
            onClick={() => call('add-folder', { folderPath }, 'folder')}
            disabled={!!busy || !folderPath.trim()}
            style={btnStyle('folder')}
          >
            {busy === 'folder' ? 'Scanning…' : 'Add Folder'}
          </button>
        </div>

        {/* Add File */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="text"
            placeholder="/mnt/jbod1/media/movies/Some Movie/movie.mkv"
            value={filePath}
            onChange={e => setFilePath(e.target.value)}
            style={inputStyle}
          />
          <button
            onClick={() => call('add-file', { filePath }, 'file')}
            disabled={!!busy || !filePath.trim()}
            style={btnStyle('file')}
          >
            {busy === 'file' ? 'Adding…' : 'Add File'}
          </button>
        </div>

        {msg && (
          <div style={{
            marginTop: 4,
            padding: '8px 12px',
            borderRadius: 6,
            fontSize: 12,
            background: msg.type === 'error' ? 'rgba(220,38,38,0.15)' : 'rgba(34,197,94,0.15)',
            color: msg.type === 'error' ? '#ef4444' : '#22c55e',
            border: `1px solid ${msg.type === 'error' ? '#dc2626' : '#16a34a'}`,
          }}>
            {msg.text}
          </div>
        )}

      </div>
    </div>
  );
}

/* Hide-Unsegmented toggle + searchable skipped panel */
function HideUnsegmentedPanel() {
  const [enabled, setEnabled] = useState(false);
  const [q, setQ] = useState('');
  const [data, setData] = useState({ total: 0, matched: 0, items: [] });
  const [loading, setLoading] = useState(false);

  // Load current setting
  useEffect(() => {
    fetch('/api/sf/config').then(r => r.json()).then(c => {
      setEnabled(!!c.hideUnsegmented);
    }).catch(() => {});
  }, []);

  const search = useCallback(async (query) => {
    setLoading(true);
    try {
      const r = await fetch('/api/sf/media/skipped?q=' + encodeURIComponent(query || ''));
      const d = await r.json();
      setData(d);
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => {
    const t = setTimeout(() => search(q), 250);
    return () => clearTimeout(t);
  }, [q, search]);

  const toggle = async () => {
    const next = !enabled;
    setEnabled(next);
    await fetch('/api/sf/media/hide-unsegmented', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: next }),
    });
    if (next) search('');
  };

  return (
    <div style={{
      marginTop: 16, padding: 16, background: 'var(--bg-card)',
      border: '1px solid var(--border)', borderRadius: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <h3 style={{ fontSize: 15, fontWeight: 700 }}>Hide Unsegmented Items</h3>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input type="checkbox" checked={enabled} onChange={toggle} />
          <span style={{ fontSize: 13 }}>{enabled ? 'Enabled' : 'Disabled'}</span>
        </label>
      </div>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
        When enabled, library and channels exclude any file that doesn't have a 'done' preseg entry. Use the search below to see what's being skipped and why.
      </p>
      <>
          <input
            type="text" placeholder="Search skipped items (title, path, reason)..."
            value={q} onChange={e => setQ(e.target.value)}
            style={{
              width: '100%', padding: '8px 10px', marginBottom: 8,
              background: 'var(--bg-elevated)', border: '1px solid var(--border)',
              borderRadius: 6, color: 'var(--text)', fontSize: 13,
            }}
          />
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
            {loading ? 'Loading…' : `${data.matched} of ${data.total} skipped items${data.matched > 500 ? ' (showing first 500)' : ''}`}
          </div>
          <div style={{
            maxHeight: 360, overflowY: 'auto', border: '1px solid var(--border)',
            borderRadius: 6, background: 'var(--bg-elevated)',
          }}>
            {data.items.length === 0 && !loading && (
              <div style={{ padding: 12, fontSize: 12, color: 'var(--text-muted)' }}>No matches.</div>
            )}
            {data.items.map((it, i) => (
              <div key={(it.id || '') + i} style={{
                padding: '8px 12px', borderBottom: '1px solid var(--border)', fontSize: 12,
              }}>
                <div style={{ fontWeight: 600 }}>
                  {it.title}{it.episodeTitle ? ` — ${it.episodeTitle}` : ''}
                  {it.season != null && it.episode != null ? ` (S${it.season}E${it.episode})` : ''}
                </div>
                <div style={{ color: 'var(--text-muted)', fontFamily: 'monospace', fontSize: 11 }}>{it.path}</div>
                <div style={{ color: '#f59e0b', marginTop: 2 }}>Reason: {it.reason}</div>
              </div>
            ))}
          </div>
      </>
    </div>
  );
}


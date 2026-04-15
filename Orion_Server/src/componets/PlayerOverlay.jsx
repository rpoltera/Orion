import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useApp } from '../contexts/AppContext';
import { X, Play, Pause, Volume2, VolumeX, Maximize2, Settings2, ChevronDown, SkipForward, BookOpen, Plus } from 'lucide-react';
const NATIVE_FORMATS = ['.mp4', '.webm', '.m4v', '.mp3', '.m4a', '.aac', '.ogg', '.opus', '.wav', '.flac'];
const AUDIO_EXTS = new Set(['.mp3', '.m4a', '.aac', '.ogg', '.opus', '.wav', '.flac']);
export default function PlayerOverlay() {
  const { nowPlaying, closePlayer, API, playNext, playPrev, queueIndex, mediaQueue } = useApp();
  console.log('[PlayerOverlay] MOUNTED, nowPlaying:', nowPlaying?.title);
  const hasPrev = queueIndex > 0;
  const hasNext = queueIndex < (mediaQueue?.length ?? 0) - 1;
  const videoRef = useRef(null);
  const [playing, setPlaying]         = useState(false);
  const [muted, setMuted]             = useState(false);
  const [volume, setVolume]           = useState(1);
  const [progress, setProgress]       = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const seekOffset = React.useRef(0);
  const trustedDuration = React.useRef(0);
  const hasAutoFullscreened = React.useRef(false);
  const [duration, setDuration]       = useState(0);
  const [buffered, setBuffered]       = useState(0);
  const [serverBuffered, setServerBuffered] = useState(0);
  const autoRetryCount = React.useRef(0);
  const stallTimerRef  = React.useRef(null);
  const [showControls, setShowControls] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState(null);
  const [audioTrack, setAudioTrack]   = useState(0);
  const [audioTracks, setAudioTracks] = useState([]);
  const [subtitleTracks, setSubtitleTracks] = useState([]);
  const [chapters, setChapters]       = useState([]);
  const [customChapters, setCustomChapters] = useState([]);
  const [introEnd, setIntroEnd]       = useState(0);
  const [outroStart, setOutroStart]   = useState(null);
  const [showSkipIntro, setShowSkipIntro] = useState(false);
  const [showSkipOutro, setShowSkipOutro] = useState(false);
  const [serverDuration, setServerDuration] = useState(0);
  const [settingsTab, setSettingsTab] = useState('audio');
  const [addingChapter, setAddingChapter] = useState(false);
  const [newChapterTitle, setNewChapterTitle] = useState('');
  const [_streamUrl, _setStreamUrl]    = useState('');
  const streamUrl = _streamUrl;
  const setStreamUrl = React.useCallback((url) => {
    if (url && url !== _streamUrl) {
      console.log('[setStreamUrl CALLED]', { url: url.slice(-100), stack: new Error().stack.split('\n').slice(1,4).join(' | ') });
    }
    _setStreamUrl(url);
  }, [_streamUrl]);
  const hideTimeout = useRef(null);
  const saveTimer   = useRef(null);
  const clog = useCallback((msg, data) => {
    console.log('[Player]', msg, data);
    fetch(`${API}/debug/client`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msg, data, t: Date.now() })
    }).catch(() => {});
  }, [API]);
  const ext = nowPlaying?.ext?.toLowerCase() || '.mkv';
  const isNative = NATIVE_FORMATS.includes(ext);
  const [hlsSessionId, setHlsSessionId] = React.useState(null);
  const [liveSessionId, setLiveSessionId] = React.useState(null);
  const hlsRef = React.useRef(null);
  const buildStreamUrl = useCallback((track = 0) => {
    if (!nowPlaying?.filePath && !nowPlaying?.url) return '';
    // Live IPTV channels — proxy through server so Chromium gets fMP4 instead of raw MPEG-TS
    if (nowPlaying?.url && !nowPlaying?.filePath) {
      return `${API}/stream/live/proxy?url=${encodeURIComponent(nowPlaying.url)}`;
    }
    const base = `${API}/stream?path=${encodeURIComponent(nowPlaying.filePath)}`;
    return isNative ? base : `${base}&transcode=1&audio=${track}`;
  }, [nowPlaying, API, isNative]);
  const startHLS = useCallback(async (filePath, track = 0, seekTime = 0) => {
    try {
      const resp = await fetch(`${API}/hls/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filePath,
          quality: 'source',
          audioTrack: track,
          seekTime,
          videoCodec: nowPlaying?.videoCodec || null,
          audioCodec: nowPlaying?.audioCodec || null,
        })
      });
      const data = await resp.json();
      if (!data.ok) throw new Error(data.error || 'HLS start failed');
      const playlistUrl = `${API}/hls/${data.sessionId}/index.m3u8`;
      for (let i = 0; i < 120; i++) {
        await new Promise(r => setTimeout(r, 500));
        try {
          const check = await fetch(playlistUrl);
          if (check.ok) {
            const text = await check.text();
            if (text.includes('.ts')) {
              setHlsSessionId(data.sessionId);
              return playlistUrl;
            }
          }
        } catch {}
      }
      throw new Error('HLS playlist never became ready');
    } catch (e) {
      console.warn('[HLS] Failed, falling back to direct stream:', e.message);
    }
    return null;
  }, [API, nowPlaying]);
  const loadHLS = useCallback(async (filePath, track = 0, seekTime = 0) => {
    const v = videoRef.current;
    if (!v) return;
    const playlistUrl = await startHLS(filePath, track, seekTime);
    if (!playlistUrl) {
      const url = buildStreamUrl(track) + (seekTime > 0 ? `&seek=${Math.floor(seekTime)}` : '');
      setStreamUrl(url);
      return;
    }
    if (window.Hls && window.Hls.isSupported()) {
      if (hlsRef.current) { hlsRef.current.destroy(); }
      const hls = new window.Hls({
        maxBufferLength: 30,
        maxMaxBufferLength: 120,
        maxBufferSize: 60 * 1000 * 1000,
        startLevel: -1,
        enableWorker: true,
        lowLatencyMode: false,
        backBufferLength: 30,
        liveSyncDuration: 3,
        liveMaxLatencyDuration: 30,
        manifestLoadingTimeOut: 20000,
        manifestLoadingMaxRetry: 10,
        manifestLoadingRetryDelay: 1000,
        levelLoadingTimeOut: 20000,
        fragLoadingTimeOut: 60000,
        fragLoadingMaxRetry: 6,
      });
      hls.loadSource(playlistUrl);
      hls.attachMedia(v);
      hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
        v.play().catch(() => {});
        setLoading(false);
        setPlaying(true);
      });
      hls.on(window.Hls.Events.ERROR, (event, data) => {
        if (data.fatal) {
          console.error('[HLS] Fatal error:', data.type, data.details);
          hls.destroy();
          hlsRef.current = null;
          const url = buildStreamUrl(track) + (seekTime > 0 ? `&seek=${Math.floor(seekTime)}` : '');
          setStreamUrl(url);
        }
      });
      hlsRef.current = hls;
    } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
      setStreamUrl(playlistUrl);
    } else {
      const url = buildStreamUrl(track) + (seekTime > 0 ? `&seek=${Math.floor(seekTime)}` : '');
      setStreamUrl(url);
    }
  }, [startHLS, buildStreamUrl, videoRef]);
  React.useEffect(() => {
    return () => {
      if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
      if (hlsSessionId) {
        fetch(`${API}/hls/${hlsSessionId}`, { method: 'DELETE' }).catch(() => {});
      }
      if (liveSessionId) {
        fetch(`${API}/stream/live/${liveSessionId}`, { method: 'DELETE' }).catch(() => {});
      }
    };
  }, [hlsSessionId, liveSessionId, API]);
  useEffect(() => {
    if (!nowPlaying) return;
    setError(null); setLoading(true); setPlaying(false);
    setProgress(0); setCurrentTime(0); setDuration(0); setBuffered(0);
    seekOffset.current = 0;
    hasAutoFullscreened.current = false;
    const runtimeSecs = nowPlaying?.runtime > 0 ? nowPlaying.runtime * 60 : 0;
    trustedDuration.current = runtimeSecs;
    if (runtimeSecs > 0) setDuration(runtimeSecs);
    else { trustedDuration.current = 0; setDuration(0); }
    setAudioTrack(0); setAudioTracks([]); setSubtitleTracks([]);
    setChapters([]); setCustomChapters([]);
    setIntroEnd(nowPlaying.introEnd || 0);
    setOutroStart(nowPlaying.outroStart || null);
    setShowSkipIntro(false); setShowSkipOutro(false);

    const url0 = buildStreamUrl(0);

    clog('setStreamUrl called', { url: url0?.slice(-80) });
    setStreamUrl(nowPlaying.filePath && !nowPlaying.url ? buildStreamUrl(0) : url0);
    if (nowPlaying.filePath) {
      if (nowPlaying.runtime > 0) setServerDuration(nowPlaying.runtime * 60);
      setTimeout(() => {
        fetch(`${API}/streams?path=${encodeURIComponent(nowPlaying.filePath)}`)
          .then(r => {
            const xDur = parseFloat(r.headers.get('X-Content-Duration') || '0');
            if (xDur > 0) setServerDuration(xDur);
            return r.json();
          })
          .then(data => {
            if (data.duration > 0) setServerDuration(data.duration);
            if (data.audio?.length > 0)     setAudioTracks(data.audio);
            if (data.subtitles?.length > 0) setSubtitleTracks(data.subtitles);
            if (data.chapters?.length > 0)  setChapters(data.chapters);
          }).catch(console.error);
      }, 1000);
      if (nowPlaying.id) {
        fetch(`${API}/chapters/${nowPlaying.id}`)
          .then(r => r.json())
          .then(data => {
            if (data.chapters?.length > 0) setCustomChapters(data.chapters);
            if (data.introEnd > 0)         setIntroEnd(data.introEnd);
            if (data.outroStart)           setOutroStart(data.outroStart);
          }).catch(() => {});
      }
    }
  }, [nowPlaying]);
  useEffect(() => {
    const match = streamUrl?.match(/[&?]seek=(\d+)/);
    seekOffset.current = match ? parseInt(match[1]) : 0;
  }, [streamUrl]);
  // Video event handlers — src set imperatively, NO <source> child element
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !streamUrl) return;
    clog('video events effect — setting src', { streamUrl: streamUrl?.slice(-60) });

    // Live IPTV proxy streams — use HLS.js to handle MPEG-TS
    const isLiveProxy = streamUrl.includes('/stream/live/proxy');
    if (isLiveProxy) {
      const loadHlsJs = () => new Promise((res, rej) => {
        if (window.Hls) return res();
        const s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.4.10/hls.min.js';
        s.onload = res; s.onerror = rej;
        document.head.appendChild(s);
      });
      loadHlsJs().then(() => {
        if (window.Hls && window.Hls.isSupported()) {
          if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
          const hls = new window.Hls({ lowLatencyMode: false });
          hlsRef.current = hls;
          hls.loadSource(streamUrl);
          hls.attachMedia(v);
          hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
            setLoading(false); setPlaying(true);
            v.play().catch(() => { v.muted = true; v.play().catch(() => {}); });
          });
          hls.on(window.Hls.Events.ERROR, (_, data) => {
            if (data.fatal) { setError('Stream failed — try another source'); setLoading(false); }
          });
        } else {
          // Safari native HLS
          v.src = streamUrl; v.load();
        }
      }).catch(() => { v.src = streamUrl; v.load(); });
      return;
    }

    if (v.src !== streamUrl) {
      v.src = streamUrl;
      v.load();
    }
    const onTime = () => {
      const rawT = v.currentTime;
      const t = seekOffset.current + rawT;
      const vDur = v.duration;
      const browserDurValid = isFinite(vDur) && vDur > 60 && vDur < 86400;
      const dur = trustedDuration.current > 0
        ? trustedDuration.current
        : browserDurValid
          ? vDur
          : serverDuration || (nowPlaying?.runtime ? nowPlaying.runtime * 60 : 0);
      setCurrentTime(t);
      if (dur > 0) { setDuration(dur); setProgress((t / dur) * 100); }
      if (v.buffered.length > 0 && dur > 0)
        setBuffered((v.buffered.end(v.buffered.length - 1) / dur) * 100);
      setShowSkipIntro(introEnd > 0 && t > 2 && t < introEnd);
      setShowSkipOutro(!!(outroStart && dur > 0 && t >= outroStart && t < dur - 5));
      if (nowPlaying?.filePath) {
        clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
          const dur = trustedDuration.current || serverDuration;
          try { localStorage.setItem('orion_resume_' + nowPlaying.filePath, t); } catch(e) {}
          if (nowPlaying.id && dur > 0) {
            const pct = t / dur;
            fetch(`${API}/progress/${nowPlaying.id}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ position: Math.floor(t), duration: Math.floor(dur) }),
            }).catch(() => {});
            fetch(`${API}/activity`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                mediaId: nowPlaying.id,
                title: nowPlaying.title,
                type: nowPlaying.type === 'tvShows' ? 'tv' : 'movie',
                action: pct >= 0.9 ? 'completed' : 'progress',
                position: Math.floor(t),
                duration: Math.floor(dur),
              }),
            }).catch(() => {});
          }
        }, 5000);
      }
    };
    const onLoaded = () => {
      const vDur = v.duration;
      const browserDurValid = isFinite(vDur) && vDur > 60 && vDur < 86400;
      const dur = browserDurValid
        ? vDur
        : (trustedDuration.current > 0 ? trustedDuration.current
          : serverDuration || (nowPlaying?.runtime ? nowPlaying.runtime * 60 : 0));
      if (dur > 0) setDuration(dur);
    };
    const handlers = {
      timeupdate:     onTime,
      loadedmetadata: onLoaded,
      durationchange: onLoaded,
      canplay:        () => { clog('canplay ✓', { readyState: v.readyState, duration: v.duration }); setLoading(false); v.play().catch(e => clog('play() failed', e.message)); },
      canplaythrough: () => { clog('canplaythrough', {}); },
      playing:        () => {
        setLoading(false);
        setPlaying(true);
        autoRetryCount.current = 0; // reset retry count on successful play
        clearTimeout(stallTimerRef.current);
        if (!hasAutoFullscreened.current) {
          hasAutoFullscreened.current = true;
          if (window.electron?.setFullscreen) {
            window.electron.setFullscreen(true);
          } else if (!document.fullscreenElement) {
            const overlay = document.querySelector('.player-overlay');
            overlay?.requestFullscreen().catch(() => {});
          }
        }
      },
      loadstart:      () => { clog('loadstart', { src: v.src?.slice(-80) }); },
      loadeddata:     () => { clog('loadeddata', { readyState: v.readyState }); },
      loadedmetadata: () => { clog('loadedmetadata', { duration: v.duration, videoW: v.videoWidth, videoH: v.videoHeight }); },
      progress:       () => { clog('progress (data arrived)', { buffered: v.buffered.length }); },
      suspend:        () => { clog('suspend', { readyState: v.readyState }); },
      stalled:        () => { clog('STALLED', { readyState: v.readyState, networkState: v.networkState }); },
      abort:          () => { clog('ABORT ❌', { src: v.src?.slice(-80), readyState: v.readyState, networkState: v.networkState }); },
      emptied:        () => { clog('EMPTIED ❌ — src was cleared', { readyState: v.readyState, networkState: v.networkState }); },
      play:      () => setPlaying(true),
      pause:     () => setPlaying(false),
      ended:     () => setPlaying(false),
      waiting:   () => {
        setLoading(true);
        clearTimeout(stallTimerRef.current);
        if (!isNative) {
          stallTimerRef.current = setTimeout(() => {
            const t = (seekOffset.current + (videoRef.current?.currentTime || 0));
            if (t > 2 && autoRetryCount.current < 3) {
              autoRetryCount.current++;
              console.warn(`[Player] Stall timeout at ${t.toFixed(1)}s — restarting stream (retry ${autoRetryCount.current})`);
              const base = streamUrl.replace(/[&?]seek=[^&]*/g, '');
              const sep  = base.includes('?') ? '&' : '?';
              setStreamUrl(base + `${sep}seek=${Math.floor(t)}`);
            }
          }, 20000);
        }
      },
      playing:   () => setLoading(false),
      error:     () => {
        const code = v.error?.code;
        const msg  = v.error?.message || '';
        const msgs = { 1:'Aborted', 2:'Network error — is the server running?', 3:'Decode error', 4:'Format not supported' };
        clog('ERROR ❌', { code, msg, networkState: v.networkState, readyState: v.readyState, src: v.src?.slice(-80) });
        if (code === 3) {
          const skipTo = Math.max(seekOffset.current + 30, currentTime + 30);
          console.warn(`[Player] Decode error at ${v.currentTime.toFixed(1)}s — auto-recovering, seeking to ${skipTo.toFixed(1)}s`);
          const base = streamUrl.replace(/[&?]seek=[^&]*/g, '');
          const sep = base.includes('?') ? '&' : '?';
          const recoverUrl = base + `${sep}seek=${Math.floor(skipTo)}`;
          setTimeout(() => { setStreamUrl(recoverUrl); }, 100);
          return;
        }
        if (code === 2) {
          const t = currentTime || 0;
          const dur = duration || serverDuration || 0;
          if (t > 5 && (dur === 0 || t < dur - 10) && autoRetryCount.current < 4) {
            autoRetryCount.current++;
            console.warn(`[Player] Network error at ${t.toFixed(1)}s — auto-restarting stream (retry ${autoRetryCount.current})`);
            const base = streamUrl.replace(/[&?]seek=[^&]*/g, '');
            const sep = base.includes('?') ? '&' : '?';
            setTimeout(() => { setStreamUrl(base + `${sep}seek=${Math.floor(t)}`); }, 500);
            return;
          }
          fetch(`${API}/server/load`).then(r => r.json()).then(data => {
            if (data.tier?.label === 'overload') {
              setError('Server is busy — too many streams. Retrying in 30s...');
              setTimeout(() => { setError(null); setStreamUrl(streamUrl + ''); }, 30000);
            } else {
              setError(msgs[code] || `Playback error (${code})`);
            }
          }).catch(() => setError(msgs[code] || `Playback error (${code})`));
          setLoading(false);
          return;
        }
        setError(msgs[code] || `Playback error (${code})`);
        setLoading(false);
      }
    };
    Object.entries(handlers).forEach(([e, h]) => v.addEventListener(e, h));
    return () => Object.entries(handlers).forEach(([e, h]) => v.removeEventListener(e, h));
  }, [streamUrl, introEnd, outroStart]);
  useEffect(() => {
    if (serverDuration > 60) {
      if (serverDuration > trustedDuration.current) {
        trustedDuration.current = serverDuration;
      }
      setDuration(prev => Math.max(prev, serverDuration));
    }
  }, [serverDuration]);
  const resetHide = () => {
    setShowControls(true);
    clearTimeout(hideTimeout.current);
    hideTimeout.current = setTimeout(() => setShowControls(false), 3500);
  };
  const togglePlay  = useCallback(() => { const v = videoRef.current; if (!v) return; v.paused ? v.play().catch(console.error) : v.pause(); }, []);
  const toggleMute  = useCallback(() => { const v = videoRef.current; if (!v) return; v.muted = !muted; setMuted(!muted); }, [muted]);
  const handleVol   = (e) => { const val = +e.target.value; setVolume(val); if (videoRef.current) videoRef.current.volume = val; setMuted(val === 0); };
  const seekTo = (s) => {
    const v = videoRef.current;
    if (!v) return;
    const targetSeconds = Math.max(0, Math.floor(s));
    const dur = duration || serverDuration;
    if (dur > 0 && v.seekable && v.seekable.length > 0 && v.seekable.end(0) > 10) {
      v.currentTime = targetSeconds - seekOffset.current;
      return;
    }
    const base = streamUrl.replace(/[&?]seek=[^&]*/g, '');
    const sep  = base.includes('?') ? '&' : '?';
    setStreamUrl(base + `${sep}seek=${targetSeconds}`);
  };
  const seek = (e) => {
    const dur = duration || serverDuration;
    if (!dur) return;
    const r = e.currentTarget.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    seekTo(Math.floor(pct * dur));
  };
  const handleFS    = () => {
    if (window.electron?.setFullscreen) {
      window.electron.isFullscreen().then(full => window.electron.setFullscreen(!full));
    } else {
      const overlay = document.querySelector('.player-overlay');
      if (!document.fullscreenElement) overlay?.requestFullscreen().catch(()=>{});
      else document.exitFullscreen();
    }
  };
  const fmtTime     = (s) => { if (!s || !isFinite(s)) return '0:00'; const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sec=Math.floor(s%60).toString().padStart(2,'0'); return h>0?`${h}:${m.toString().padStart(2,'0')}:${sec}`:`${m}:${sec}`; };
  const fmtLang     = (l) => ({eng:'English',spa:'Spanish',fra:'French',deu:'German',jpn:'Japanese',kor:'Korean',zho:'Chinese',por:'Portuguese',rus:'Russian',ita:'Italian',und:'Unknown'}[l])||l?.toUpperCase()||'Track';
  // Poll server for FFmpeg transcode progress (bufferedSeconds) when transcoding
  useEffect(() => {
    if (isNative || !streamUrl || !API) return;
    const filePath = new URLSearchParams(streamUrl.split('?')[1] || '').get('path') ||
                     decodeURIComponent((streamUrl.match(/[?&]path=([^&]*)/) || [])[1] || '');
    if (!filePath) return;
    const poll = () => {
      fetch(`${API}/streams?path=${encodeURIComponent(filePath)}`)
        .then(r => r.json())
        .then(d => {
          const sess = d.sessions?.[0];
          if (sess?.bufferedSeconds > 0) setServerBuffered(sess.bufferedSeconds);
        })
        .catch(() => {});
    };
    poll();
    const id = setInterval(poll, 1000);
    return () => clearInterval(id);
  }, [isNative, streamUrl, API]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      const dur = duration || serverDuration;
      const allCh = [...(chapters.length ? chapters : []), ...customChapters].sort((a,b) => a.start - b.start);
      switch (e.key) {
        case ' ':
        case 'k':          e.preventDefault(); togglePlay(); break;
        case 'ArrowLeft':  e.preventDefault(); seekTo(Math.max(0, currentTime - (e.shiftKey ? 30 : 10))); break;
        case 'ArrowRight': e.preventDefault(); seekTo(Math.min(dur || 999999, currentTime + (e.shiftKey ? 30 : 10))); break;
        case 'ArrowUp':    e.preventDefault(); { const v = videoRef.current; if (v) { v.volume = Math.min(1, v.volume + 0.1); setVolume(v.volume); } } break;
        case 'ArrowDown':  e.preventDefault(); { const v = videoRef.current; if (v) { v.volume = Math.max(0, v.volume - 0.1); setVolume(v.volume); } } break;
        case 'm':          toggleMute(); break;
        case 'f':          handleFS(); break;
        case 'Escape':     closePlayer(); break;
        case '[': {        // prev chapter
          e.preventDefault();
          const idx = allCh.findLastIndex(ch => ch.start <= currentTime - 2);
          if (idx > 0) seekTo(allCh[idx - 1].start);
          else if (allCh.length > 0) seekTo(allCh[0].start);
          break;
        }
        case ']': {        // next chapter
          e.preventDefault();
          const next = allCh.find(ch => ch.start > currentTime + 1);
          if (next) seekTo(next.start);
          break;
        }
        default: break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [currentTime, duration, serverDuration, togglePlay, toggleMute, seekTo, handleFS, closePlayer]);
  const switchAudio = (idx) => {
    setAudioTrack(idx); setLoading(true); setError(null);
    const pos = currentTime || 0;
    const url = buildStreamUrl(idx) + (pos > 0 ? `&seek=${Math.floor(pos)}` : '');
    setStreamUrl(url); setShowSettings(false);
  };
  const addChapter = () => {
    const t = videoRef.current?.currentTime || 0;
    const title = newChapterTitle.trim() || `Chapter ${customChapters.length + 1}`;
    const updated = [...customChapters, { title, start: Math.floor(t), end: null }].sort((a,b) => a.start - b.start);
    setCustomChapters(updated); setNewChapterTitle(''); setAddingChapter(false);
    if (nowPlaying?.id) fetch(`${API}/chapters/${nowPlaying.id}`, { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ chapters: updated }) }).catch(console.error);
  };
  const setIntroPoint = () => {
    const t = Math.floor(videoRef.current?.currentTime || 0); setIntroEnd(t);
    if (nowPlaying?.id) fetch(`${API}/chapters/${nowPlaying.id}`, { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ chapters: customChapters, introEnd: t }) }).catch(console.error);
  };
  const setOutroPoint = () => {
    const t = Math.floor(videoRef.current?.currentTime || 0); setOutroStart(t);
    if (nowPlaying?.id) fetch(`${API}/chapters/${nowPlaying.id}`, { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ chapters: customChapters, introEnd, outroStart: t }) }).catch(console.error);
  };
  const allChapters = [...(chapters.length ? chapters : []), ...customChapters].sort((a,b) => a.start - b.start);
  const dur = duration || serverDuration;
  const isMusic      = nowPlaying?.type === 'music'      || AUDIO_EXTS.has(ext);
  const isMusicVideo = nowPlaying?.type === 'musicVideos';
  const albumArt     = nowPlaying?.thumbnail ? (nowPlaying.thumbnail.startsWith('http') ? nowPlaying.thumbnail : `${API.replace('/api','')}${nowPlaying.thumbnail}`) : null;
  if (isMusic) {
    const audioHasPrev = hasPrev;
    const audioHasNext = hasNext;
    return (
      <div onMouseMove={resetHide}
        style={{ display:'flex', background:'#0a0a14', position:'fixed', inset:0, zIndex:9000 }}>
        {/* Hidden audio element — src set imperatively via useEffect, no <source> child */}
        <video ref={videoRef} style={{ display:'none' }} preload="auto"
          onEnded={() => { if (hasNext) playNext(); }} />
        <div style={{ width:'40%', minWidth:280, position:'relative', overflow:'hidden', flexShrink:0 }}>
          {albumArt
            ? <>
                <img src={albumArt} alt="" style={{ position:'absolute', inset:0, width:'100%', height:'100%', objectFit:'cover', filter:'blur(40px) brightness(0.35)', transform:'scale(1.1)' }} />
                <img src={albumArt} alt="" style={{ position:'absolute', top:'50%', left:'50%', transform:'translate(-50%, -50%)', width:'72%', aspectRatio:'1', objectFit:'cover', borderRadius:16, boxShadow:'0 32px 80px rgba(0,0,0,0.8)', zIndex:1,
                  animation: playing ? 'musicPulse 3s ease-in-out infinite' : 'none' }} />
              </>
            : <div style={{ width:'100%', height:'100%', display:'flex', alignItems:'center', justifyContent:'center', fontSize:100, opacity:0.15 }}>🎵</div>
          }
        </div>
        <div style={{ flex:1, display:'flex', flexDirection:'column', justifyContent:'center', padding:'48px 64px 120px', position:'relative' }}>
          <button onClick={closePlayer} style={{ position:'absolute', top:24, right:24, background:'rgba(255,255,255,0.1)', border:'none', color:'white', width:36, height:36, borderRadius:'50%', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center' }}>
            <X size={18} />
          </button>
          {nowPlaying?.artist && <div style={{ fontSize:14, color:'var(--accent)', fontWeight:600, marginBottom:10, letterSpacing:0.5 }}>{nowPlaying.artist}</div>}
          <div style={{ fontSize:42, fontWeight:800, color:'white', lineHeight:1.1, marginBottom:14 }}>{nowPlaying?.title || 'Unknown Track'}</div>
          {nowPlaying?.album && <div style={{ fontSize:18, color:'rgba(255,255,255,0.45)', marginBottom:6 }}>{nowPlaying.album}</div>}
          {nowPlaying?.year && <div style={{ fontSize:14, color:'rgba(255,255,255,0.25)' }}>{nowPlaying.year}</div>}
          {mediaQueue.length > 1 && <div style={{ fontSize:12, color:'rgba(255,255,255,0.2)', marginTop:12 }}>{queueIndex + 1} of {mediaQueue.length}</div>}
        </div>
        <div style={{ position:'absolute', bottom:0, left:0, right:0, zIndex:10,
          background:'linear-gradient(to top, rgba(0,0,0,0.95) 0%, rgba(0,0,0,0.7) 80%, transparent 100%)',
          padding:'40px 48px 28px' }}>
          <input type="range" min={0} max={dur||1} value={currentTime} step={0.1}
            onChange={e => seekTo(parseFloat(e.target.value))}
            style={{ width:'100%', accentColor:'var(--accent)', height:4, cursor:'pointer', display:'block', marginBottom:6 }} />
          <div style={{ display:'flex', justifyContent:'space-between', fontSize:12, color:'rgba(255,255,255,0.35)', marginBottom:16 }}>
            <span>{fmtTime(currentTime)}</span>
            <span>{fmtTime(dur)}</span>
          </div>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:24 }}>
            <button onClick={toggleMute} style={{ background:'none', border:'none', color:muted?'rgba(255,255,255,0.3)':'rgba(255,255,255,0.6)', cursor:'pointer' }}>
              {muted ? <VolumeX size={20}/> : <Volume2 size={20}/>}
            </button>
            <input type="range" min={0} max={1} step={0.02} value={volume}
              onChange={e => { const v=parseFloat(e.target.value); setVolume(v); if(videoRef.current) videoRef.current.volume=v; }}
              style={{ width:80, accentColor:'var(--accent)', cursor:'pointer' }} />
            <div style={{ flex:1 }} />
            <button onClick={() => hasPrev ? playPrev() : seekTo(0)}
              style={{ background:'none', border:'none', color: hasPrev?'white':'rgba(255,255,255,0.25)', cursor:'pointer', fontSize:24 }}>⏮</button>
            <button onClick={() => seekTo(Math.max(0, currentTime - 10))}
              style={{ background:'none', border:'none', color:'rgba(255,255,255,0.7)', cursor:'pointer', fontSize:20 }}>⏪</button>
            <button onClick={togglePlay}
              style={{ width:56, height:56, borderRadius:'50%', background:'var(--accent)', border:'none', color:'white', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', boxShadow:'0 0 24px var(--accent-glow)' }}>
              {playing ? <Pause size={24}/> : <Play size={24} fill="white"/>}
            </button>
            <button onClick={() => seekTo(Math.min(dur, currentTime + 10))}
              style={{ background:'none', border:'none', color:'rgba(255,255,255,0.7)', cursor:'pointer', fontSize:20 }}>⏩</button>
            <button onClick={() => hasNext && playNext()}
              style={{ background:'none', border:'none', color: hasNext?'white':'rgba(255,255,255,0.25)', cursor: hasNext?'pointer':'default', fontSize:24 }}>⏭</button>
            <div style={{ flex:1 }} />
            <div style={{ fontSize:11, color:'rgba(255,255,255,0.2)' }}>{ext.replace('.','').toUpperCase()}</div>
          </div>
        </div>
        <style>{`@keyframes musicPulse { 0%,100%{transform:translate(-50%,-50%) scale(1)} 50%{transform:translate(-50%,-50%) scale(1.02)} }`}</style>
      </div>
    );
  }
  if (isMusicVideo) {
    const mvHasPrev = queueIndex > 0;
    const mvHasNext = queueIndex < mediaQueue.length - 1;
    return (
      <div onMouseMove={resetHide}
        style={{ display:'block', background:'#000', position:'fixed', inset:0, zIndex:9000 }}>
        {/* Video element — src set imperatively, no <source> child */}
        <video ref={videoRef} muted={muted} preload="auto"
          style={{ width:'100%', height:'100%', objectFit:'contain', background:'#000', cursor:'pointer' }}
          onClick={togglePlay}
          onEnded={() => { if (mvHasNext) playNext(); }} />
        <div style={{ position:'absolute', top:0, left:0, right:0, padding:'20px 24px', background:'linear-gradient(to bottom, rgba(0,0,0,0.7) 0%, transparent 100%)',
          opacity: showControls ? 1 : 0, transition:'opacity 0.3s', pointerEvents:'none', zIndex:10 }}>
          <div style={{ display:'flex', alignItems:'center', gap:14 }}>
            {albumArt && <img src={albumArt} alt="" style={{ width:52, height:52, borderRadius:8, objectFit:'cover', flexShrink:0 }} />}
            <div>
              <div style={{ fontSize:16, fontWeight:800, color:'white' }}>{nowPlaying?.title}</div>
              {nowPlaying?.artist && <div style={{ fontSize:13, color:'rgba(255,255,255,0.6)', marginTop:2 }}>{nowPlaying.artist}</div>}
              {mediaQueue.length > 1 && <div style={{ fontSize:11, color:'rgba(255,255,255,0.35)', marginTop:2 }}>{queueIndex+1} of {mediaQueue.length}</div>}
            </div>
          </div>
        </div>
        <button onClick={closePlayer}
          style={{ position:'absolute', top:16, right:16, zIndex:20, background:'rgba(0,0,0,0.5)', border:'1px solid rgba(255,255,255,0.2)',
            color:'white', width:36, height:36, borderRadius:'50%', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center',
            opacity: showControls ? 1 : 0, transition:'opacity 0.3s' }}>
          <X size={18}/>
        </button>
        <div style={{ position:'absolute', bottom:0, left:0, right:0, zIndex:10,
          background:'linear-gradient(to top, rgba(0,0,0,0.9) 0%, transparent 100%)',
          padding:'40px 24px 20px' }}>
          <input type="range" min={0} max={dur||1} value={currentTime} step={0.1}
            onChange={e=>seekTo(parseFloat(e.target.value))}
            style={{ width:'100%', accentColor:'var(--accent)', height:4, cursor:'pointer', display:'block', marginBottom:6 }} />
          <div style={{ display:'flex', justifyContent:'space-between', fontSize:11, color:'rgba(255,255,255,0.4)', marginBottom:12 }}>
            <span>{fmtTime(currentTime)}</span><span>{fmtTime(dur)}</span>
          </div>
          <div style={{ display:'flex', alignItems:'center', gap:16 }}>
            <button onClick={() => mvHasPrev && playPrev()}
              style={{ background:'none', border:'none', color: mvHasPrev?'white':'rgba(255,255,255,0.25)', cursor:'pointer', fontSize:22, padding:4 }}>⏮</button>
            <button onClick={() => seekTo(Math.max(0,currentTime-10))}
              style={{ background:'none', border:'none', color:'rgba(255,255,255,0.8)', cursor:'pointer', fontSize:20, padding:4 }}>⏪</button>
            <button onClick={togglePlay}
              style={{ width:48, height:48, borderRadius:'50%', background:'var(--accent)', border:'none', color:'white', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
              {playing ? <Pause size={22}/> : <Play size={22} fill="white"/>}
            </button>
            <button onClick={() => seekTo(Math.min(dur,currentTime+10))}
              style={{ background:'none', border:'none', color:'rgba(255,255,255,0.8)', cursor:'pointer', fontSize:20, padding:4 }}>⏩</button>
            <button onClick={() => mvHasNext && playNext()}
              style={{ background:'none', border:'none', color: mvHasNext?'white':'rgba(255,255,255,0.25)', cursor:'pointer', fontSize:22, padding:4 }}>⏭</button>
            <div style={{ flex:1 }} />
            <button onClick={toggleMute} style={{ background:'none', border:'none', color:'white', cursor:'pointer', padding:4 }}>
              {muted ? <VolumeX size={20}/> : <Volume2 size={20}/>}
            </button>
            <input type="range" min={0} max={1} step={0.02} value={volume}
              onChange={e=>{const v=parseFloat(e.target.value);setVolume(v);if(videoRef.current)videoRef.current.volume=v;}}
              style={{ width:80, accentColor:'var(--accent)', cursor:'pointer' }} />
            <button onClick={handleFS} style={{ background:'none', border:'none', color:'white', cursor:'pointer', padding:4 }}><Maximize2 size={20}/></button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="player-overlay" onMouseMove={resetHide}>
      <div className="player-header" style={{ opacity: showControls ? 1 : 0, transition: 'opacity 0.3s' }}>
        <div>
          <div className="player-title">{nowPlaying?.title || 'Now Playing'}</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2, display: 'flex', gap: 10 }}>
            <span>{ext.replace('.','').toUpperCase()} • {isNative ? '▶ Direct' : '⚡ Transcode'}</span>
            {audioTracks.length > 1 && <span style={{ color:'var(--accent)' }}>🎵 {audioTracks.length} audio</span>}
            {allChapters.length > 0 && <span style={{ color:'var(--accent)' }}>📖 {allChapters.length} chapters</span>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="player-close" onClick={() => setShowSettings(!showSettings)}><Settings2 size={18} /></button>
          <button className="player-close" onClick={closePlayer}><X size={22} /></button>
        </div>
      </div>
      {showSettings && (
        <div style={{ position:'absolute', top:80, right:24, zIndex:20, minWidth:280, background:'var(--bg-card)', border:'1px solid var(--border)', borderRadius:'var(--radius-lg)', overflow:'hidden', boxShadow:'0 8px 32px rgba(0,0,0,0.5)' }}>
          <div style={{ display:'flex', borderBottom:'1px solid var(--border)' }}>
            {['audio','chapters','info'].map(tab => (
              <button key={tab} onClick={() => setSettingsTab(tab)} style={{ flex:1, padding:'10px', border:'none', cursor:'pointer', fontSize:11, fontWeight:600, background: settingsTab===tab?'var(--tag-bg)':'transparent', color: settingsTab===tab?'var(--accent)':'var(--text-muted)', textTransform:'uppercase' }}>
                {tab==='audio'?'🎵 Audio':tab==='chapters'?'📖 Chapters':'ℹ Info'}
              </button>
            ))}
          </div>
          <div style={{ padding:12, maxHeight:400, overflowY:'auto' }}>
            {settingsTab==='audio' && (
              <>
                <div style={{ fontSize:10, fontWeight:700, color:'var(--text-muted)', marginBottom:8, letterSpacing:1 }}>AUDIO TRACK</div>
                {audioTracks.length===0
                  ? <div style={{ fontSize:12, color:'var(--text-muted)' }}>No track info — play started</div>
                  : audioTracks.map((t,i) => (
                    <div key={i} onClick={() => switchAudio(i)} style={{ padding:'8px 10px', borderRadius:'var(--radius)', cursor:'pointer', background:audioTrack===i?'var(--tag-bg)':'transparent', color:audioTrack===i?'var(--tag-color)':'var(--text-secondary)', fontSize:13, marginBottom:2, display:'flex', alignItems:'center', gap:8, border:`1px solid ${audioTrack===i?'var(--border-accent)':'transparent'}` }}>
                      <span>{audioTrack===i?'🔊':'🔈'}</span>
                      <div style={{ flex:1 }}>
                        <div style={{ fontWeight:600 }}>{t.title||`Track ${i+1}`}{t.default&&<span style={{ fontSize:10, marginLeft:6, opacity:0.5 }}>(Default)</span>}</div>
                        <div style={{ fontSize:11, opacity:0.7 }}>{fmtLang(t.language)} • {t.codec?.toUpperCase()} • {t.channels}ch</div>
                      </div>
                      {audioTrack===i && <span>✓</span>}
                    </div>
                  ))
                }
                {subtitleTracks.length>0 && (
                  <>
                    <div style={{ fontSize:10, fontWeight:700, color:'var(--text-muted)', margin:'12px 0 8px', letterSpacing:1 }}>SUBTITLES</div>
                    {subtitleTracks.map((s,i) => <div key={i} style={{ padding:'6px 10px', fontSize:12, color:'var(--text-muted)' }}>{fmtLang(s.language)} {s.title?`— ${s.title}`:''} {s.forced?'(Forced)':''}</div>)}
                  </>
                )}
              </>
            )}
            {settingsTab==='chapters' && (
              <>
                <div style={{ fontSize:10, fontWeight:700, color:'var(--text-muted)', marginBottom:8, letterSpacing:1 }}>CHAPTERS</div>
                {allChapters.length===0
                  ? <div style={{ fontSize:12, color:'var(--text-muted)', marginBottom:12 }}>No chapters found.</div>
                  : allChapters.map((ch,i) => (
                    <div key={i} onClick={() => { seekTo(ch.start); setShowSettings(false); }} style={{ padding:'7px 10px', borderRadius:'var(--radius)', cursor:'pointer', display:'flex', alignItems:'center', gap:10, fontSize:13, marginBottom:2, background:currentTime>=ch.start&&(!allChapters[i+1]||currentTime<allChapters[i+1].start)?'var(--tag-bg)':'transparent', color:'var(--text-secondary)' }}>
                      <span style={{ fontSize:11, fontFamily:'monospace', color:'var(--accent)', minWidth:40 }}>{fmtTime(ch.start)}</span>
                      <span style={{ flex:1 }}>{ch.title}</span>
                      <SkipForward size={12} style={{ opacity:0.4 }} />
                    </div>
                  ))
                }
                <div style={{ borderTop:'1px solid var(--border)', marginTop:8, paddingTop:10 }}>
                  <div style={{ fontSize:10, fontWeight:700, color:'var(--text-muted)', marginBottom:8, letterSpacing:1 }}>ADD CHAPTER AT {fmtTime(currentTime)}</div>
                  {addingChapter ? (
                    <div style={{ display:'flex', gap:6 }}>
                      <input autoFocus value={newChapterTitle} onChange={e=>setNewChapterTitle(e.target.value)} onKeyDown={e=>e.key==='Enter'&&addChapter()} placeholder="Chapter name..." style={{ flex:1, padding:'6px 8px', background:'var(--bg-tertiary)', border:'1px solid var(--border)', borderRadius:'var(--radius)', color:'var(--text-primary)', fontSize:12, outline:'none' }} />
                      <button onClick={addChapter} className="btn btn-primary btn-sm" style={{ padding:'6px 10px', fontSize:11 }}>Add</button>
                      <button onClick={() => setAddingChapter(false)} className="btn btn-secondary btn-sm" style={{ padding:'6px 8px', fontSize:11 }}>✕</button>
                    </div>
                  ) : (
                    <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
                      <button onClick={() => setAddingChapter(true)} className="btn btn-secondary btn-sm" style={{ fontSize:11 }}><Plus size={11} /> Add Chapter</button>
                      <button onClick={setIntroPoint} className="btn btn-secondary btn-sm" style={{ fontSize:11, color:'#f59e0b' }}>⏩ Set Intro End</button>
                      <button onClick={setOutroPoint} className="btn btn-secondary btn-sm" style={{ fontSize:11, color:'#8b5cf6' }}>🎬 Set Outro Start</button>
                    </div>
                  )}
                  {introEnd > 0 && <div style={{ fontSize:11, color:'#f59e0b', marginTop:6 }}>⏩ Intro ends at {fmtTime(introEnd)}</div>}
                  {outroStart && <div style={{ fontSize:11, color:'#8b5cf6', marginTop:4 }}>🎬 Outro starts at {fmtTime(outroStart)}</div>}
                </div>
              </>
            )}
            {settingsTab==='info' && (
              <div style={{ fontSize:12 }}>
                {[{ label:'FILE', value:nowPlaying?.fileName },{ label:'DURATION', value:fmtTime(dur) },{ label:'FORMAT', value:ext.replace('.','').toUpperCase() },{ label:'MODE', value:isNative?'Direct Play':'Transcode → MP4' },nowPlaying?.size>0&&{ label:'SIZE', value:`${(nowPlaying.size/1024/1024/1024).toFixed(2)} GB` }].filter(Boolean).map(({label,value})=>(
                  <div key={label} style={{ marginBottom:10 }}>
                    <div style={{ color:'var(--text-muted)', fontSize:10, fontWeight:700, letterSpacing:1, marginBottom:2 }}>{label}</div>
                    <div style={{ color:'var(--text-secondary)', wordBreak:'break-all' }}>{value}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
      <div className="player-video-wrap" style={{ position:'relative', cursor:'pointer' }} onClick={togglePlay}>
        {/* Video element — src set imperatively via useEffect above, NO <source> child */}
        {streamUrl && (
          <video
            ref={videoRef}
            muted={muted}
            preload="auto"
            x-webkit-airplay="allow"
            style={{ width:'100%', height:'100%', background:'#000' }}
          />
        )}
        {showSkipIntro && (
          <button onClick={e => { e.stopPropagation(); seekTo(introEnd); setShowSkipIntro(false); }}
            style={{ position:'absolute', bottom:24, right:24, background:'rgba(0,0,0,0.75)', border:'2px solid white', color:'white', padding:'10px 20px', borderRadius:'var(--radius)', cursor:'pointer', fontSize:14, fontWeight:700, display:'flex', alignItems:'center', gap:8, zIndex:10 }}>
            <SkipForward size={16} /> Skip Intro
          </button>
        )}
        {showSkipOutro && (
          <button onClick={e => { e.stopPropagation(); seekTo(dur); }}
            style={{ position:'absolute', bottom:24, right:24, background:'rgba(0,0,0,0.75)', border:'2px solid #8b5cf6', color:'white', padding:'10px 20px', borderRadius:'var(--radius)', cursor:'pointer', fontSize:14, fontWeight:700, display:'flex', alignItems:'center', gap:8, zIndex:10 }}>
            <SkipForward size={16} /> Skip Credits
          </button>
        )}
        {loading && !error && (
          <div style={{ position:'absolute', inset:0, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:14, background:'rgba(0,0,0,0.85)', pointerEvents:'none' }}>
            <div style={{ width:48, height:48, border:'3px solid rgba(255,255,255,0.1)', borderTop:'3px solid var(--accent)', borderRadius:'50%', animation:'spin 0.9s linear infinite' }} />
            <div style={{ fontSize:14, color:'var(--text-secondary)' }}>
              {(nowPlaying?.url && !nowPlaying?.filePath)
                ? 'Connecting to live stream…'
                : isNative ? 'Loading...' : `Transcoding ${ext.replace('.','').toUpperCase()} → MP4...`}
            </div>
            <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
          </div>
        )}
        {error && (
          <div style={{ position:'absolute', inset:0, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:14, background:'rgba(0,0,0,0.9)', padding:40 }}>
            <div style={{ fontSize:40 }}>⚠️</div>
            <div style={{ fontSize:16, fontWeight:600, color:'#ef4444' }}>Playback Failed</div>
            <div style={{ fontSize:13, color:'var(--text-muted)', textAlign:'center' }}>{error}</div>
            <div style={{ fontSize:12, color:'var(--text-secondary)', textAlign:'center', background:'var(--bg-card)', padding:'10px 16px', borderRadius:'var(--radius)', border:'1px solid var(--border)' }}>
              Make sure <strong>npm run server</strong> is running.
            </div>
            <button className="btn btn-secondary btn-sm" onClick={() => { setError(null); setLoading(true); setStreamUrl(''); setTimeout(() => setStreamUrl(buildStreamUrl(audioTrack)), 100); }}>Retry</button>
          </div>
        )}
        {!playing && !loading && !error && (
          <div style={{ position:'absolute', inset:0, display:'flex', alignItems:'center', justifyContent:'center', pointerEvents:'none' }}>
            <div className="play-btn" style={{ width:68, height:68 }}><Play size={30} fill="white" color="white" /></div>
          </div>
        )}
      </div>
      <div style={{ opacity:showControls?1:0, transition:'opacity 0.3s', display:'flex', flexDirection:'column', gap:10, width:'100%', maxWidth:1100, padding:'0 8px', marginTop:14 }}>
        <div style={{ position:'relative' }}>
          <div style={{ width:'100%', height:5, background:'rgba(255,255,255,0.15)', borderRadius:3, cursor:'pointer', position:'relative' }} onClick={seek}>
            {/* Buffer / work-ahead bar — white, sits above track bg, below play progress */}
            <div style={{ position:'absolute', left:0, top:0, width:`${isNative ? buffered : (dur > 0 ? Math.min(100, (serverBuffered / dur) * 100) : buffered)}%`, height:'100%', background:'rgba(255,255,255,0.45)', borderRadius:3, zIndex:1 }} />
            {/* Play progress bar */}
            <div style={{ position:'absolute', left:0, top:0, width:`${progress}%`, height:'100%', background:'var(--accent)', borderRadius:3, transition:'width 0.1s', zIndex:2 }} />
            {dur>0 && allChapters.map((ch,i) => (
              <div key={i} title={ch.title} style={{ position:'absolute', top:-2, width:3, height:9, background:'rgba(255,255,255,0.7)', borderRadius:1, transform:'translateX(-50%)', left:`${(ch.start/dur)*100}%`, zIndex:5 }} onClick={e=>{e.stopPropagation();seekTo(ch.start);}} />
            ))}
            {dur>0 && introEnd>0 && <div title={`Intro ends at ${fmtTime(introEnd)}`} style={{ position:'absolute', top:-3, width:4, height:11, background:'#f59e0b', borderRadius:2, transform:'translateX(-50%)', left:`${(introEnd/dur)*100}%`, zIndex:6 }} />}
            {dur>0 && outroStart && <div title={`Outro at ${fmtTime(outroStart)}`} style={{ position:'absolute', top:-3, width:4, height:11, background:'#8b5cf6', borderRadius:2, transform:'translateX(-50%)', left:`${(outroStart/dur)*100}%`, zIndex:6 }} />}
          </div>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:12 }}>
          {/* Prev episode */}
          <button onClick={() => hasPrev ? playPrev() : seekTo(0)} title={hasPrev ? 'Previous episode' : 'Restart'}
            style={{ background:'none', border:'none', color: hasPrev?'white':'rgba(255,255,255,0.3)', cursor:'pointer', padding:4 }}>⏮</button>
          {/* Skip back 10s */}
          <button onClick={() => seekTo(Math.max(0, currentTime - 10))} title="Skip back 10s (←)"
            style={{ background:'none', border:'none', color:'rgba(255,255,255,0.8)', cursor:'pointer', padding:4, fontSize:18 }}>⏪</button>
          {/* Play/Pause */}
          <button onClick={togglePlay} style={{ background:'none', border:'none', color:'white', cursor:'pointer', padding:4 }}>{playing?<Pause size={22}/>:<Play size={22}/>}</button>
          {/* Skip forward 10s */}
          <button onClick={() => seekTo(Math.min(dur||999999, currentTime + 10))} title="Skip forward 10s (→)"
            style={{ background:'none', border:'none', color:'rgba(255,255,255,0.8)', cursor:'pointer', padding:4, fontSize:18 }}>⏩</button>
          {/* Next episode */}
          <button onClick={() => hasNext && playNext()} title="Next episode"
            style={{ background:'none', border:'none', color: hasNext?'white':'rgba(255,255,255,0.3)', cursor: hasNext?'pointer':'default', padding:4 }}>⏭</button>
          <button onClick={toggleMute} style={{ background:'none', border:'none', color:'white', cursor:'pointer', padding:4 }}>{muted?<VolumeX size={20}/>:<Volume2 size={20}/>}</button>
          <input type="range" min={0} max={1} step={0.05} value={muted?0:volume} onChange={handleVol} style={{ width:80, accentColor:'var(--accent)', cursor:'pointer' }} />
          <span style={{ fontSize:12, color:'rgba(255,255,255,0.5)', minWidth:100 }}>{fmtTime(currentTime)} / {fmtTime(dur)}</span>
          <div style={{ flex:1 }} />
          {/* Prev/Next chapter buttons — only shown when chapters exist */}
          {allChapters.length > 0 && (() => {
            const chIdx = allChapters.findLastIndex(ch => ch.start <= currentTime);
            const prevCh = chIdx > 0 ? allChapters[chIdx - 1] : null;
            const nextCh = allChapters[chIdx + 1] ?? null;
            return (
              <>
                <button onClick={() => prevCh && seekTo(prevCh.start)} disabled={!prevCh} title={prevCh ? `← ${prevCh.title}` : 'No previous chapter'}
                  style={{ background:'rgba(255,255,255,0.08)', border:'1px solid rgba(255,255,255,0.15)', color: prevCh?'white':'rgba(255,255,255,0.25)', cursor: prevCh?'pointer':'default', padding:'4px 8px', borderRadius:'var(--radius)', fontSize:12 }}>⏮ Ch</button>
                <button onClick={()=>{setShowSettings(true);setSettingsTab('chapters');}} style={{ background:'rgba(255,255,255,0.08)', border:'1px solid rgba(255,255,255,0.15)', color:'white', cursor:'pointer', padding:'4px 10px', borderRadius:'var(--radius)', fontSize:12, display:'flex', alignItems:'center', gap:5 }}>
                  <BookOpen size={12} /> {allChapters.length}
                </button>
                <button onClick={() => nextCh && seekTo(nextCh.start)} disabled={!nextCh} title={nextCh ? `→ ${nextCh.title}` : 'No next chapter'}
                  style={{ background:'rgba(255,255,255,0.08)', border:'1px solid rgba(255,255,255,0.15)', color: nextCh?'white':'rgba(255,255,255,0.25)', cursor: nextCh?'pointer':'default', padding:'4px 8px', borderRadius:'var(--radius)', fontSize:12 }}>Ch ⏭</button>
              </>
            );
          })()}
          {allChapters.length === 0 && (
            <button onClick={()=>{setShowSettings(true);setSettingsTab('chapters');}} style={{ background:'rgba(255,255,255,0.08)', border:'1px solid rgba(255,255,255,0.15)', color:'rgba(255,255,255,0.4)', cursor:'pointer', padding:'4px 10px', borderRadius:'var(--radius)', fontSize:12, display:'flex', alignItems:'center', gap:5 }}>
              <BookOpen size={12} /> Ch
            </button>
          )}
          {audioTracks.length>1 && (
            <button onClick={()=>{setShowSettings(true);setSettingsTab('audio');}} style={{ background:'rgba(255,255,255,0.08)', border:'1px solid rgba(255,255,255,0.15)', color:'white', cursor:'pointer', padding:'4px 10px', borderRadius:'var(--radius)', fontSize:12, display:'flex', alignItems:'center', gap:5 }}>
              🎵 {fmtLang(audioTracks[audioTrack]?.language)} <ChevronDown size={12}/>
            </button>
          )}
          <span style={{ fontSize:11, color:'rgba(255,255,255,0.4)', padding:'2px 8px', background:'rgba(255,255,255,0.08)', borderRadius:4 }}>{isNative?'▶ Direct':'⚡ Transcode'}</span>
          <button onClick={handleFS} style={{ background:'none', border:'none', color:'white', cursor:'pointer', padding:4 }}><Maximize2 size={18}/></button>
        </div>
      </div>
    </div>
  );
}

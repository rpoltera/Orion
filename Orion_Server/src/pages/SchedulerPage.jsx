import React, { useState, useEffect, useCallback } from 'react';
import { useApp } from '../contexts/AppContext';
import { Play, Clock, CheckCircle, XCircle, Loader, RefreshCw } from 'lucide-react';

const FREQ_OPTIONS = [
  { value: 'hourly',  label: 'Every Hour' },
  { value: 'daily',   label: 'Daily' },
  { value: 'weekly',  label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
];

const TASK_ICONS = {
  scan_libraries:    '📂',
  refresh_metadata:  '🎭',
  build_collections: '📁',
  db_backup:         '💾',
  db_optimize:       '🔧',
  clear_debug_log:   '🗑',
  check_updates:     '🔄',
};

function fmt(iso) {
  if (!iso) return 'Never';
  const d = new Date(iso);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function pad(n) { return String(n).padStart(2, '0'); }

export default function SchedulerPage() {
  const { API } = useApp();
  const [tasks, setTasks]         = useState([]);
  const [running, setRunning]     = useState({});
  const [editing, setEditing]     = useState(null); // task id being edited
  const [loading, setLoading]     = useState(true);

  const [taskProgress, setTaskProgress] = useState({});

  const fetchTasks = useCallback(() => {
    fetch(`${API}/scheduler`)
      .then(r => r.json())
      .then(d => { setTasks(d.tasks || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [API]);

  useEffect(() => { fetchTasks(); }, [fetchTasks]);

  // Socket for live progress
  useEffect(() => {
    let socket;
    import('socket.io-client').then(({ io }) => {
      socket = io('http://localhost:3001');
      socket.on('scheduler:progress', (data) => {
        setTaskProgress(prev => ({ ...prev, [data.id]: data }));
        if (data.done) {
          setRunning(r => ({ ...r, [data.id]: false }));
          fetchTasks();
        }
      });
      socket.on('scheduler:taskStart', (data) => {
        setRunning(r => ({ ...r, [data.id]: true }));
        setTaskProgress(prev => ({ ...prev, [data.id]: { status: 'Starting...', current: 0, total: 0 } }));
      });
      socket.on('scheduler:taskDone', (data) => {
        setRunning(r => ({ ...r, [data.id]: false }));
        fetchTasks();
      });
    }).catch(() => {});
    return () => { if (socket) socket.disconnect(); };
  }, [fetchTasks]);

  const update = async (id, patch) => {
    setTasks(prev => prev.map(t => t.id === id ? { ...t, ...patch } : t));
    await fetch(`${API}/scheduler/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
  };

  const runNow = async (task) => {
    setRunning(r => ({ ...r, [task.id]: true }));
    await fetch(`${API}/scheduler/${task.id}/run`, { method: 'POST' });
    setTimeout(() => {
      setRunning(r => ({ ...r, [task.id]: false }));
      fetchTasks();
    }, 2000);
  };

  const enabledCount = tasks.filter(t => t.enabled).length;

  if (loading) return (
    <div className="page" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 300 }}>
      <Loader size={24} style={{ animation: 'spin 1s linear infinite', opacity: 0.5 }} />
    </div>
  );

  return (
    <div className="page">
      <div className="page-header">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div className="page-title">⏰ Scheduled Tasks</div>
            <div className="page-subtitle">{enabledCount} of {tasks.length} tasks enabled</div>
          </div>
          <button className="btn btn-secondary btn-sm" onClick={fetchTasks}>
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
      </div>

      {/* Summary bar */}
      {enabledCount > 0 && (
        <div style={{ display: 'flex', gap: 10, marginBottom: 24, flexWrap: 'wrap' }}>
          {tasks.filter(t => t.enabled).map(t => (
            <div key={t.id} style={{
              background: 'rgba(0,99,229,0.1)', border: '1px solid rgba(0,99,229,0.25)',
              borderRadius: 20, padding: '4px 14px', fontSize: 12, fontWeight: 600, color: 'var(--accent2)',
              display: 'flex', alignItems: 'center', gap: 6,
            }}>
              <span>{TASK_ICONS[t.id]}</span>
              <span>{t.name}</span>
              <span style={{ opacity: 0.6 }}>·</span>
              <span style={{ opacity: 0.7 }}>{t.frequency} {pad(t.hour)}:{pad(t.minute)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Task list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {tasks.map(task => {
          const isRunning  = running[task.id];
          const isEditing  = editing === task.id;
          const statusColor = task.lastStatus === 'success' ? '#34d399' : task.lastStatus === 'error' ? '#f87171' : task.lastStatus === 'running' ? '#60a5fa' : 'var(--text-muted)';

          return (
            <div key={task.id} style={{
              background: 'var(--bg-card)', border: `1px solid ${task.enabled ? 'rgba(0,99,229,0.3)' : 'var(--border)'}`,
              borderRadius: 'var(--radius-lg)', overflow: 'hidden',
              transition: 'border-color 0.2s',
            }}>
              {/* Main row */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '16px 20px' }}>

                {/* Icon */}
                <div style={{
                  width: 44, height: 44, borderRadius: 12, flexShrink: 0,
                  background: task.enabled ? 'rgba(0,99,229,0.15)' : 'var(--bg-tertiary)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20,
                }}>
                  {TASK_ICONS[task.id]}
                </div>

                {/* Info */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 3 }}>
                    <span style={{ fontWeight: 700, fontSize: 15 }}>{task.name}</span>
                    {task.lastStatus === 'success' && <CheckCircle size={14} color="#34d399" />}
                    {task.lastStatus === 'error'   && <XCircle    size={14} color="#f87171" />}
                    {(isRunning || task.lastStatus === 'running') && <Loader size={14} color="#60a5fa" style={{ animation: 'spin 1s linear infinite' }} />}
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>{task.desc}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, display: 'flex', gap: 16 }}>
                    {task.enabled && (
                      <span style={{ color: 'var(--accent2)' }}>
                        <Clock size={11} style={{ display: 'inline', marginRight: 4 }} />
                        {task.frequency} at {pad(task.hour)}:{pad(task.minute)}
                      </span>
                    )}
                    <span style={{ color: statusColor }}>
                      Last run: {fmt(task.lastRun)}
                      {task.lastStatus === 'error' && task.lastError && ` — ${task.lastError}`}
                    </span>
                  </div>
                </div>

                {/* Actions */}
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
                  <button
                    title="Run now"
                    onClick={() => runNow(task)}
                    disabled={isRunning}
                    className="btn btn-secondary btn-sm"
                    style={{ gap: 6, opacity: isRunning ? 0.5 : 1 }}
                  >
                    {isRunning
                      ? <Loader size={13} style={{ animation: 'spin 1s linear infinite' }} />
                      : <Play size={13} />}
                    {isRunning ? 'Running...' : 'Run Now'}
                  </button>

                  <button
                    onClick={() => setEditing(isEditing ? null : task.id)}
                    className="btn btn-secondary btn-sm"
                    style={{ gap: 6, color: isEditing ? 'var(--accent)' : undefined }}
                  >
                    <Clock size={13} /> Schedule
                  </button>

                  {/* Toggle */}
                  <div
                    onClick={() => update(task.id, { enabled: !task.enabled })}
                    style={{
                      width: 44, height: 24, borderRadius: 12, cursor: 'pointer',
                      background: task.enabled ? 'var(--accent)' : 'rgba(255,255,255,0.1)',
                      position: 'relative', transition: 'background 0.2s', flexShrink: 0,
                    }}
                  >
                    <div style={{
                      position: 'absolute', top: 2, left: task.enabled ? 22 : 2,
                      width: 20, height: 20, borderRadius: '50%', background: 'white',
                      transition: 'left 0.2s', boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
                    }} />
                  </div>
                </div>
              </div>

              {/* Live progress panel */}
              {(isRunning || taskProgress[task.id]) && taskProgress[task.id] && (
                <div style={{ borderTop:'1px solid rgba(99,102,241,0.2)', padding:'12px 20px',
                  background:'rgba(99,102,241,0.08)' }}>
                  <div style={{ fontSize:12, color:'#a5b4fc', marginBottom: taskProgress[task.id].total > 0 ? 8 : 0,
                    wordBreak:'break-word' }}>
                    {taskProgress[task.id].status || 'Working...'}
                  </div>
                  {taskProgress[task.id].total > 0 && (
                    <>
                      <div style={{ height:4, background:'rgba(255,255,255,0.08)', borderRadius:2, marginBottom:6, overflow:'hidden' }}>
                        <div style={{ height:'100%', borderRadius:2, background:'#6366f1',
                          width:`${Math.round((taskProgress[task.id].current / taskProgress[task.id].total) * 100)}%`,
                          transition:'width 0.5s ease' }} />
                      </div>
                      <div style={{ display:'flex', gap:16, fontSize:11, color:'rgba(255,255,255,0.45)' }}>
                        <span>{taskProgress[task.id].current.toLocaleString()} / {taskProgress[task.id].total.toLocaleString()}</span>
                        {(taskProgress[task.id].downloaded || 0) > 0 && <span style={{ color:'#4ade80' }}>✓ {taskProgress[task.id].downloaded} downloaded</span>}
                        {(taskProgress[task.id].skipped || 0) > 0 && <span>↷ {taskProgress[task.id].skipped} skipped</span>}
                        {(taskProgress[task.id].failed || 0) > 0 && <span style={{ color:'#f87171' }}>✗ {taskProgress[task.id].failed} failed</span>}
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* Expanded schedule editor */}
              {isEditing && (
                <div style={{
                  borderTop: '1px solid var(--border)',
                  padding: '16px 20px',
                  background: 'rgba(0,0,0,0.2)',
                  display: 'flex', gap: 20, alignItems: 'flex-end', flexWrap: 'wrap',
                }}>
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 6 }}>Frequency</div>
                    <select
                      className="select-input"
                      value={task.frequency}
                      onChange={e => update(task.id, { frequency: e.target.value })}
                      style={{ minWidth: 140 }}
                    >
                      {FREQ_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </div>

                  <div>
                    <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 6 }}>Time</div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <select
                        className="select-input"
                        value={task.hour}
                        onChange={e => update(task.id, { hour: parseInt(e.target.value) })}
                        style={{ width: 80 }}
                      >
                        {Array.from({ length: 24 }, (_, i) => (
                          <option key={i} value={i}>{pad(i)}:00</option>
                        ))}
                      </select>
                      <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>:</span>
                      <select
                        className="select-input"
                        value={task.minute}
                        onChange={e => update(task.id, { minute: parseInt(e.target.value) })}
                        style={{ width: 80 }}
                      >
                        {[0, 15, 30, 45].map(m => (
                          <option key={m} value={m}>{pad(m)}</option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div style={{ fontSize: 13, color: 'var(--text-muted)', paddingBottom: 4 }}>
                    Runs {task.frequency} at {pad(task.hour)}:{pad(task.minute)}
                  </div>

                  <button className="btn btn-primary btn-sm" onClick={() => setEditing(null)}>
                    <CheckCircle size={13} /> Done
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div style={{ marginTop: 28, padding: '14px 18px', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6 }}>
        💡 Tasks run automatically in the background while Orion is open. Use <strong style={{ color: 'var(--text-primary)' }}>Run Now</strong> to trigger any task immediately.
        Database backups are saved as <code style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--accent2)' }}>library.json.bak</code> in the Orion data folder.
      </div>
    </div>
  );
}

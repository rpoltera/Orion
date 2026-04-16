import React, { useState, useEffect } from 'react';
import { useApp } from '../contexts/AppContext';
import { themes } from '../themes/themes';
import { FolderOpen, Trash2, RefreshCw, HardDrive, Palette, BookOpen, Cpu, Info, GitBranch, ExternalLink, Key, CheckCircle, Bug, Download, Trash, Bot, Zap, AlertCircle, ToggleLeft, ToggleRight, Film, BarChart2, Plus, Wand2, Clock, Users, LayoutDashboard, GripVertical, Eye, EyeOff } from 'lucide-react';
import LocalAISettings from '../components/LocalAISettings';
import SchedulerPage from './SchedulerPage';
import UsersPage from './UsersPage';

function MiniBarChart({ data, color = 'var(--accent)', height = 48, label }) {
  const max = Math.max(...data.map(d => d.value), 0.01);
  return (
    <div>
      {label && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>{label}</div>}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height }}>
        {data.map((d, i) => (
          <div key={i} title={`${d.label}: ${d.value}`}
            style={{ flex: 1, background: color, borderRadius: 2,
              height: `${Math.max(2, (d.value / max) * 100)}%`,
              opacity: i === data.length - 1 ? 1 : 0.4 + (i / data.length) * 0.6,
              transition: 'height 0.3s' }} />
        ))}
      </div>
    </div>
  );
}

function StatCard({ title, value, sub, color, bar }) {
  return (
    <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, padding: '16px 18px', flex: 1, minWidth: 160 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>{title}</div>
      <div style={{ fontSize: 26, fontWeight: 800, color: color || 'var(--text-primary)', lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>{sub}</div>}
      {bar && <div style={{ marginTop: 12 }}><MiniBarChart data={bar.data} color={bar.color || color} height={36} /></div>}
    </div>
  );
}

function ActivityTab({ API }) {
  const [activeTab, setActiveTab] = React.useState('system');
  const [stats, setStats] = React.useState(null);
  const [clients, setClients] = React.useState([]);
  const [activity, setActivity] = React.useState([]);
  const [loading, setLoading] = React.useState(true);

  const refresh = React.useCallback(() => {
    Promise.all([
      fetch(`${API}/system/stats`).then(r => r.json()).catch(() => null),
      fetch(`${API}/system/clients`).then(r => r.json()).catch(() => ({ clients: [] })),
      fetch(`${API}/activity?limit=500`).then(r => r.json()).catch(() => ({ activity: [] })),
    ]).then(([s, c, a]) => {
      if (s) setStats(s);
      setClients(c.clients || []);
      setActivity(a.activity || []);
      setLoading(false);
    });
  }, [API]);

  React.useEffect(() => {
    refresh();
    // Only poll when the activity tab is visible — avoid burning CPU in background
    const interval = setInterval(() => {
      if (!document.hidden) refresh();
    }, 10000); // 5s -> 10s
    return () => clearInterval(interval);
  }, [refresh]);

  const fmtTime = (iso) => {
    if (!iso) return '';
    const d = new Date(iso), now = new Date(), diff = Math.floor((now - d) / 60000);
    if (diff < 1) return 'just now';
    if (diff < 60) return `${diff}m ago`;
    if (diff < 1440) return `${Math.floor(diff/60)}h ago`;
    return d.toLocaleDateString();
  };

  const fmtBytes = (mb) => mb >= 1024 ? `${(mb/1024).toFixed(1)} GB` : `${mb} MB`;

  // Build user stats from activity
  const userStats = {};
  for (const ev of activity) {
    const key = ev.userName || ev.ip || 'Unknown';
    if (!userStats[key]) userStats[key] = { name: key, events: 0, completed: 0, ips: new Set(), devices: new Set(), lastSeen: ev.timestamp, dataBytes: 0 };
    userStats[key].events++;
    if (ev.action === 'completed') userStats[key].completed++;
    if (ev.ip) userStats[key].ips.add(ev.ip);
    if (ev.device) userStats[key].devices.add(ev.device);
    if (!userStats[key].lastSeen || ev.timestamp > userStats[key].lastSeen) userStats[key].lastSeen = ev.timestamp;
  }
  const topUsers = Object.values(userStats).sort((a, b) => b.events - a.events);

  const bwHistory = (stats?.bandwidth?.history || []).map((h, i) => ({ value: h.mbps, label: `${h.mbps} MB/s` }));
  const cpuVal = stats?.cpu?.usagePercent || 0;
  const memPct = stats?.memory?.usedPercent || 0;

  const tabs = ['system', 'users', 'devices', 'feed'];

  return (
    <div>
      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 2, marginBottom: 24, borderBottom: '1px solid var(--border)' }}>
        {tabs.map(t => (
          <button key={t} onClick={() => setActiveTab(t)} style={{
            padding: '8px 18px', border: 'none', background: 'transparent', cursor: 'pointer',
            fontSize: 13, fontWeight: 600, textTransform: 'capitalize',
            color: activeTab === t ? 'var(--accent)' : 'var(--text-muted)',
            borderBottom: activeTab === t ? '2px solid var(--accent)' : '2px solid transparent',
            marginBottom: -1,
          }}>{t}</button>
        ))}
        <div style={{ flex: 1 }} />
        <button className="btn btn-secondary btn-sm" onClick={refresh} style={{ marginBottom: 4 }}>↻ Refresh</button>
      </div>

      {loading ? <div style={{ color: 'var(--text-muted)', padding: 40, textAlign: 'center' }}>Loading...</div> : (<>

      {/* SYSTEM TAB */}
      {activeTab === 'system' && stats && (
        <div>
          {/* Uptime + streams row */}
          <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
            <StatCard title="Uptime" value={`${Math.floor(stats.uptime/3600)}h ${Math.floor((stats.uptime%3600)/60)}m`} sub="Server running" color="#10b981" />
            <StatCard title="Active Streams" value={stats.streams.active} sub={`${stats.streams.queued} queued · max ${stats.streams.max}`} color="var(--accent)" />
            <StatCard title="Connected Clients" value={clients.length} sub="Via WebSocket" color="#8b5cf6" />
            <StatCard title="Load Tier" value={stats.loadTier} sub="Adaptive quality" color={stats.loadTier === 'normal' ? '#10b981' : stats.loadTier === 'overload' ? '#ef4444' : '#f59e0b'} />
          </div>

          {/* CPU, Memory, Bandwidth graphs */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16, marginBottom: 16 }}>
            {/* CPU */}
            <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, padding: 18 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
                <div style={{ fontSize: 13, fontWeight: 700 }}>CPU Usage</div>
                <div style={{ fontSize: 24, fontWeight: 800, color: cpuVal > 80 ? '#ef4444' : cpuVal > 50 ? '#f59e0b' : '#10b981' }}>{cpuVal}%</div>
              </div>
              <div style={{ height: 8, background: 'rgba(255,255,255,0.1)', borderRadius: 4, overflow: 'hidden', marginBottom: 8 }}>
                <div style={{ height: '100%', borderRadius: 4, transition: 'width 1s',
                  background: cpuVal > 80 ? '#ef4444' : cpuVal > 50 ? '#f59e0b' : '#10b981',
                  width: `${cpuVal}%` }} />
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{stats.cpu.cores} cores · {stats.cpu.model?.slice(0, 40)}</div>
            </div>

            {/* Memory */}
            <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, padding: 18 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
                <div style={{ fontSize: 13, fontWeight: 700 }}>Memory</div>
                <div style={{ fontSize: 24, fontWeight: 800, color: memPct > 85 ? '#ef4444' : memPct > 70 ? '#f59e0b' : '#10b981' }}>{memPct}%</div>
              </div>
              <div style={{ height: 8, background: 'rgba(255,255,255,0.1)', borderRadius: 4, overflow: 'hidden', marginBottom: 8 }}>
                <div style={{ height: '100%', borderRadius: 4, transition: 'width 1s',
                  background: memPct > 85 ? '#ef4444' : memPct > 70 ? '#f59e0b' : '#10b981',
                  width: `${memPct}%` }} />
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                {fmtBytes(stats.memory.usedMB)} used of {fmtBytes(stats.memory.totalMB)} · Heap {fmtBytes(stats.memory.heapUsedMB)}
              </div>
            </div>

            {/* Bandwidth */}
            <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, padding: 18 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
                <div style={{ fontSize: 13, fontWeight: 700 }}>Bandwidth</div>
                <div style={{ fontSize: 24, fontWeight: 800, color: 'var(--accent)' }}>{stats.bandwidth.currentMbps} <span style={{ fontSize: 14 }}>MB/s</span></div>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 10 }}>Total served: {stats.bandwidth.totalGB} GB</div>
              {bwHistory.length > 0 && <MiniBarChart data={bwHistory} color="var(--accent)" height={48} />}
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'rgba(255,255,255,0.3)', marginTop: 4 }}>
                <span>60s ago</span><span>now</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* USERS TAB */}
      {activeTab === 'users' && (
        <div>
          {topUsers.length === 0 ? (
            <div style={{ color: 'var(--text-muted)', padding: 40, textAlign: 'center' }}>No user activity yet. Watch something to start tracking.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {topUsers.map(u => (
                <div key={u.name} style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, padding: '16px 20px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                    <div style={{ width: 40, height: 40, borderRadius: '50%', background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, fontWeight: 700, flexShrink: 0 }}>
                      {(u.name || '?')[0].toUpperCase()}
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 15, fontWeight: 700 }}>{u.name}</div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Last seen {fmtTime(u.lastSeen)}</div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--accent)' }}>{u.events}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>events</div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                    <div style={{ fontSize: 12 }}><span style={{ color: 'var(--text-muted)' }}>Completed: </span><span style={{ color: '#10b981', fontWeight: 600 }}>{u.completed}</span></div>
                    <div style={{ fontSize: 12 }}><span style={{ color: 'var(--text-muted)' }}>Devices: </span><span style={{ fontWeight: 600 }}>{[...u.devices].join(', ') || 'Unknown'}</span></div>
                    <div style={{ fontSize: 12 }}><span style={{ color: 'var(--text-muted)' }}>IP: </span><span style={{ fontWeight: 600, fontFamily: 'monospace' }}>{[...u.ips].join(', ') || 'Unknown'}</span></div>
                  </div>
                  {/* Activity bar for this user */}
                  <div style={{ marginTop: 10 }}>
                    <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                      {activity.filter(e => (e.userName || e.ip) === u.name && e.action !== 'progress').slice(0, 20).map(e => (
                        <div key={e.id} title={`${e.title} · ${e.action} · ${fmtTime(e.timestamp)}`}
                          style={{ width: 8, height: 8, borderRadius: 2,
                            background: e.action === 'completed' ? '#10b981' : e.action === 'paused' ? '#f59e0b' : 'var(--accent)' }} />
                      ))}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* DEVICES TAB */}
      {activeTab === 'devices' && (
        <div>
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 12 }}>Currently Connected ({clients.length})</div>
            {clients.length === 0 ? (
              <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No clients connected</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {clients.map(c => (
                  <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10 }}>
                    <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#10b981', flexShrink: 0 }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>{c.device}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'monospace' }}>{c.ip}</div>
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Connected {fmtTime(c.connectedAt)}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Device breakdown from activity */}
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 12 }}>Device Breakdown</div>
          {(() => {
            const deviceCount = {};
            for (const ev of activity) { const d = ev.device || 'Unknown'; deviceCount[d] = (deviceCount[d] || 0) + 1; }
            const total = Object.values(deviceCount).reduce((s, v) => s + v, 0);
            return Object.entries(deviceCount).sort((a, b) => b[1] - a[1]).map(([device, count]) => (
              <div key={device} style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{device}</span>
                  <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>{count} ({Math.round(count/total*100)}%)</span>
                </div>
                <div style={{ height: 6, background: 'rgba(255,255,255,0.1)', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ height: '100%', background: 'var(--accent)', borderRadius: 3, width: `${(count/total)*100}%` }} />
                </div>
              </div>
            ));
          })()}
        </div>
      )}

      {/* FEED TAB */}
      {activeTab === 'feed' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {activity.filter(e => e.action !== 'progress').slice(0, 100).length === 0 ? (
            <div style={{ color: 'var(--text-muted)', padding: 40, textAlign: 'center' }}>No activity yet.</div>
          ) : activity.filter(e => e.action !== 'progress').slice(0, 100).map(ev => {
            const icon = { started: '▶', resumed: '⏯', paused: '⏸', completed: '✓' }[ev.action] || '•';
            const color = { started: 'var(--accent)', completed: '#10b981', paused: '#f59e0b', resumed: 'var(--accent)' }[ev.action] || 'var(--text-muted)';
            return (
              <div key={ev.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', background: 'var(--bg-card)', borderRadius: 8, border: '1px solid var(--border)' }}>
                <span style={{ color, width: 20, textAlign: 'center', fontSize: 14 }}>{icon}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ev.title || 'Unknown'}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>
                    {ev.userName || ev.ip || 'Unknown'} · {ev.device || ''} · {ev.type || ''} · {ev.action}
                    {ev.position > 0 && ` at ${Math.floor(ev.position/60)}m`}
                  </div>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>{fmtTime(ev.timestamp)}</div>
              </div>
            );
          })}
        </div>
      )}

      </>)}
    </div>
  );
}

const ICONS = ['📁','🎬','🎵','📸','🏋️','🍳','📚','🎮','✈️','🏠','🐾','🌿','🎨','💼','🧘','🎭','🏃','🎤','🎸','🧸'];
const FILE_TYPES = [
  { value:'video',    label:'Videos',    desc:'MP4, MKV, AVI, MOV...' },
  { value:'image',    label:'Photos',    desc:'JPG, PNG, GIF, WEBP...' },
  { value:'audio',    label:'Audio',     desc:'MP3, FLAC, M4A, WAV...' },
  { value:'document', label:'Documents', desc:'PDF, EPUB, DOCX, TXT...' },
  { value:'any',      label:'All Files', desc:'Any supported file type' },
];

function NASSharesList({ API }) {
  const [shares, setShares] = React.useState([]);
  const [loading, setLoading] = React.useState(true);

  const load = () => {
    setLoading(true);
    fetch(`${API}/nas/shares`).then(r => r.json()).then(d => {
      setShares(d.shares || []);
      setLoading(false);
    }).catch(() => setLoading(false));
  };

  React.useEffect(() => { load(); }, []);

  const handleMount = async (mp) => {
    await fetch(`${API}/nas/mount`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ mountPoint: mp }) });
    load();
  };

  const handleUmount = async (mp) => {
    await fetch(`${API}/nas/umount`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ mountPoint: mp }) });
    load();
  };

  const handleRemove = async (mp) => {
    if (!window.confirm(`Remove mount ${mp} from fstab?`)) return;
    await fetch(`${API}/nas/shares`, { method:'DELETE', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ mountPoint: mp }) });
    load();
  };

  if (loading) return <div style={{ fontSize:13, color:'var(--text-muted)', padding:'8px 0' }}>Loading shares...</div>;
  if (!shares.length) return <div style={{ fontSize:13, color:'var(--text-muted)', padding:'8px 0' }}>No CIFS shares configured.</div>;

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
      {shares.map((s, i) => (
        <div key={i} style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 14px', background:'var(--bg-tertiary)', borderRadius:'var(--radius)', border:'1px solid var(--border)' }}>
          <div style={{ width:8, height:8, borderRadius:'50%', background: s.mounted ? '#10b981' : '#ef4444', flexShrink:0 }} />
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ fontSize:13, fontFamily:'monospace', color:'var(--text-primary)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{s.source}</div>
            <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:2 }}>{s.mountPoint} {s.user ? `· user: ${s.user}` : ''}</div>
          </div>
          <div style={{ display:'flex', gap:6 }}>
            {s.mounted
              ? <button onClick={() => handleUmount(s.mountPoint)} className="btn btn-secondary btn-sm">Unmount</button>
              : <button onClick={() => handleMount(s.mountPoint)} className="btn btn-primary btn-sm">Mount</button>
            }
            <button onClick={() => handleRemove(s.mountPoint)} style={{ padding:'4px 8px', background:'rgba(239,68,68,0.1)', border:'1px solid rgba(239,68,68,0.2)', borderRadius:'var(--radius)', color:'#ef4444', cursor:'pointer', fontSize:11 }}>Remove</button>
          </div>
        </div>
      ))}
    </div>
  );
}

function CustomLibrariesSettings({ API }) {
  const { customLibraries, fetchCustomLibraries } = useApp();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newIcon, setNewIcon] = useState('📁');
  const [newType, setNewType] = useState('video');
  const [expanded, setExpanded] = useState(null);
  const [addingPath, setAddingPath] = useState(false);

  const createLib = async () => {
    if (!newName.trim()) return;
    await fetch(`${API}/custom-libraries`, { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ name: newName.trim(), icon: newIcon, fileTypes: newType }) });
    await fetchCustomLibraries();
    setCreating(false); setNewName(''); setNewIcon('📁'); setNewType('video');
  };

  const deleteLib = async (id) => {
    if (!window.confirm('Delete this library and all its scanned items?')) return;
    await fetch(`${API}/custom-libraries/${id}`, { method:'DELETE' });
    await fetchCustomLibraries();
  };

  const addFolder = async (lib) => {
    const result = await window.electron?.openFolderDialog();
    if (!result?.canceled && result?.filePaths?.length) {
      for (const p of result.filePaths) {
        await fetch(`${API}/custom-libraries/${lib.id}/folders`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ path: p }) });
      }
      await fetchCustomLibraries();
    }
  };

  const removeFolder = async (lib, path) => {
    await fetch(`${API}/custom-libraries/${lib.id}/folders`, { method:'DELETE', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ path }) });
    await fetchCustomLibraries();
  };

  const scan = async (lib) => {
    await fetch(`${API}/custom-libraries/${lib.id}/scan`, { method:'POST' });
    await fetchCustomLibraries();
  };

  return (
    <div>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:24 }}>
        <div>
          <h3 style={{ fontSize:16, fontWeight:700, marginBottom:4 }}>Custom Libraries</h3>
          <p style={{ fontSize:13, color:'var(--text-muted)' }}>Create any library — books, photos, home movies, workouts, cooking videos, and more.</p>
        </div>
        <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}><Plus size={13}/> New Library</button>
      </div>

      {/* Create form */}
      {creating && (
        <div style={{ background:'var(--bg-card)', border:'1px solid var(--accent)', borderRadius:'var(--radius-lg)', padding:20, marginBottom:20 }}>
          <div style={{ fontSize:14, fontWeight:700, marginBottom:16 }}>New Custom Library</div>
          <div style={{ display:'flex', gap:8, marginBottom:12, flexWrap:'wrap', alignItems:'center' }}>
            <select value={newIcon} onChange={e => setNewIcon(e.target.value)}
              style={{ padding:'8px', background:'var(--bg-tertiary)', border:'1px solid var(--border)', borderRadius:'var(--radius)', color:'var(--text-primary)', fontSize:18 }}>
              {ICONS.map(ic => <option key={ic} value={ic}>{ic}</option>)}
            </select>
            <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Library name (e.g. Cooking Videos)"
              style={{ flex:1, minWidth:200, padding:'8px 12px', background:'var(--bg-tertiary)', border:'1px solid var(--border)', borderRadius:'var(--radius)', color:'var(--text-primary)', fontSize:13 }}
              onKeyDown={e => e.key === 'Enter' && createLib()} autoFocus />
          </div>
          <div style={{ fontSize:12, fontWeight:700, color:'var(--text-muted)', letterSpacing:1, marginBottom:8, textTransform:'uppercase' }}>File Type</div>
          <div style={{ display:'flex', gap:8, flexWrap:'wrap', marginBottom:16 }}>
            {FILE_TYPES.map(ft => (
              <div key={ft.value} onClick={() => setNewType(ft.value)}
                style={{ padding:'8px 14px', borderRadius:'var(--radius)', cursor:'pointer', border:`1px solid ${newType===ft.value?'var(--accent)':'var(--border)'}`,
                  background: newType===ft.value ? 'var(--tag-bg)' : 'var(--bg-tertiary)' }}>
                <div style={{ fontSize:13, fontWeight:600, color: newType===ft.value?'var(--accent)':'var(--text-primary)' }}>{ft.label}</div>
                <div style={{ fontSize:11, color:'var(--text-muted)' }}>{ft.desc}</div>
              </div>
            ))}
          </div>
          <div style={{ display:'flex', gap:8 }}>
            <button className="btn btn-primary btn-sm" onClick={createLib} disabled={!newName.trim()}>Create Library</button>
            <button className="btn btn-secondary btn-sm" onClick={() => setCreating(false)}>Cancel</button>
          </div>
        </div>
      )}

      {/* Library list */}
      {(customLibraries||[]).length === 0 && !creating && (
        <div style={{ textAlign:'center', padding:'48px 0', color:'var(--text-muted)' }}>
          <div style={{ fontSize:40, marginBottom:12 }}>📁</div>
          <div style={{ fontSize:15, fontWeight:600, marginBottom:6 }}>No custom libraries yet</div>
          <div style={{ fontSize:13 }}>Create one to get started</div>
        </div>
      )}

      {(customLibraries||[]).map(lib => (
        <div key={lib.id} style={{ background:'var(--bg-card)', border:'1px solid var(--border)', borderRadius:'var(--radius-lg)', marginBottom:12, overflow:'hidden' }}>
          <div style={{ display:'flex', alignItems:'center', padding:'14px 16px', cursor:'pointer' }} onClick={() => setExpanded(expanded===lib.id?null:lib.id)}>
            <span style={{ fontSize:22, marginRight:12 }}>{lib.icon}</span>
            <div style={{ flex:1 }}>
              <div style={{ fontWeight:700, fontSize:14 }}>{lib.name}</div>
              <div style={{ fontSize:12, color:'var(--text-muted)', marginTop:2 }}>
                {FILE_TYPES.find(f=>f.value===lib.fileTypes)?.label} · {lib.items?.length||0} items · {lib.paths?.length||0} folders
              </div>
            </div>
            <div style={{ display:'flex', gap:6 }}>
              <button className="btn btn-secondary btn-sm" onClick={e=>{e.stopPropagation();scan(lib);}}><RefreshCw size={12}/> Rescan</button>
              <button className="btn btn-secondary btn-sm" onClick={e=>{e.stopPropagation();addFolder(lib);}}><FolderOpen size={12}/> Add Folder</button>
              <button className="btn btn-sm" onClick={e=>{e.stopPropagation();deleteLib(lib.id);}} style={{ background:'rgba(239,68,68,0.1)', color:'#ef4444', border:'1px solid rgba(239,68,68,0.3)' }}>Delete</button>
            </div>
          </div>
          {expanded===lib.id && (
            <div style={{ padding:'0 16px 16px', borderTop:'1px solid var(--border)' }}>
              {(lib.paths||[]).length === 0
                ? <div style={{ fontSize:13, color:'var(--text-muted)', padding:'12px 0' }}>No folders added. Click Add Folder to get started.</div>
                : (lib.paths||[]).map((p,i) => (
                  <div key={i} style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'8px 0', borderBottom:'1px solid var(--border)' }}>
                    <span style={{ fontSize:12, fontFamily:'monospace', color:'var(--text-secondary)' }}>{p}</span>
                    <button className="btn btn-sm" onClick={() => removeFolder(lib,p)} style={{ fontSize:11, color:'var(--text-muted)' }}>Remove</button>
                  </div>
                ))
              }
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function AutoCollectionsEmbedded() {
  const API = 'http://localhost:3001/api';
  const [cfg, setCfg] = React.useState(null);
  const [running, setRunning] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [collections, setCollections] = React.useState([]);
  const [subTab, setSubTab] = React.useState('collections');
  const [buildProgress, setBuildProgress] = React.useState(null);
  const [streamProgress, setStreamProgress] = React.useState(null);
  const [streamPolling, setStreamPolling] = React.useState(false);
  const [providerState, setProviderState] = React.useState(null);
  const [providerPolling, setProviderPolling] = React.useState(false);

  // Poll streaming status on mount
  React.useEffect(() => {
    fetch(`${API}/autocollections/streaming/status`).then(r => r.json())
      .then(d => { setStreamProgress(d); if (d.running) setStreamPolling(true); }).catch(() => {});
    fetch(`${API}/metadata/providers/status`).then(r => r.json())
      .then(d => { setProviderState(d); if (d.running) setProviderPolling(true); }).catch(() => {});
  }, []);

  React.useEffect(() => {
    if (!streamPolling) return;
    const t = setInterval(() => {
      fetch(`${API}/autocollections/streaming/status`).then(r => r.json()).then(d => {
        setStreamProgress(d);
        if (!d.running) {
          setStreamPolling(false);
          fetch(`${API}/collections`).then(r => r.json()).then(d => setCollections(Array.isArray(d) ? d : (d.collections || []))).catch(() => {});
        }
      }).catch(() => {});
    }, 800);
    return () => clearInterval(t);
  }, [streamPolling]);

  React.useEffect(() => {
    if (!providerPolling) return;
    const t = setInterval(() => {
      fetch(`${API}/metadata/providers/status`).then(r => r.json()).then(d => {
        setProviderState(d);
        if (!d.running) setProviderPolling(false);
      }).catch(() => {});
    }, 800);
    return () => clearInterval(t);
  }, [providerPolling]);

  const runProviderRefresh = async (type) => {
    if (providerState?.running) return;
    setProviderState({ running: true, done: 0, total: 0, current: 'Starting...', errors: 0 });
    setProviderPolling(true);
    await fetch(`${API}/metadata/providers/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type }) }).catch(() => {});
  };

  const runStreaming = async (mediaType) => {
    if (streamProgress?.running) return;
    setStreamProgress({ running: true, phase: mediaType, done: 0, total: 0, current: 'Starting...' });
    setStreamPolling(true);
    await fetch(`${API}/autocollections/streaming/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mediaType }) }).catch(() => {});
  };

  React.useEffect(() => {
    fetch(`${API}/autocollections/config`).then(r => r.json()).then(setCfg).catch(() => {});
    fetch(`${API}/collections`).then(r => r.json()).then(d => setCollections(Array.isArray(d) ? d : (d.collections || []))).catch(() => {});
  }, []);

  const save = async (next) => {
    setCfg(next);
    await fetch(`${API}/autocollections/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next) }).catch(() => {});
    setSaved(true); setTimeout(() => setSaved(false), 2000);
  };

  const setSection = (section, key, val) => {
    const next = { ...cfg, [section]: { ...cfg[section], [key]: val } };
    save(next);
  };

  const Toggle = ({ on, onChange }) => (
    <button onClick={onChange} style={{ background: 'none', border: 'none', cursor: 'pointer', color: on ? 'var(--accent)' : 'var(--text-muted)', padding: 0, display: 'flex' }}>
      {on ? <ToggleRight size={26} /> : <ToggleLeft size={26} />}
    </button>
  );

  const Row = ({ label, desc, children }) => (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '11px 0', borderBottom: '1px solid var(--border)' }}>
      <div style={{ flex: 1, marginRight: 24 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{label}</div>
        {desc && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{desc}</div>}
      </div>
      {children}
    </div>
  );

  const SectionHead = ({ label }) => (
    <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1.2, textTransform: 'uppercase', margin: '20px 0 8px' }}>{label}</div>
  );

  const Select = ({ value, onChange, options }) => (
    <select value={value} onChange={e => onChange(e.target.value)}
      style={{ padding: '6px 10px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', color: 'var(--text-primary)', fontSize: 12, minWidth: 130 }}>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );

  if (!cfg) return <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: 20 }}>Loading…</div>;

  const auto = cfg.autoCollections || {};
  const overlays = cfg.overlays || {};
  const ratings = cfg.ratings || {};
  const byType = {};
  collections.forEach(col => { byType[col.type] = (byType[col.type] || 0) + 1; });

  const SUBTABS = [
    { id: 'collections', label: 'Collections' },
    { id: 'overlays',    label: 'Overlays' },
    { id: 'ratings',     label: 'Ratings' },
    { id: 'schedule',    label: 'Schedule' },
  ];

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Auto Collections</h3>
          <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Automatically build and maintain collections from your library with Kometa-style overlays and metadata.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
          {saved && <span style={{ fontSize: 12, color: '#34d399' }}>Saved ✓</span>}
          <button className="btn btn-secondary btn-sm" onClick={() => fetch(`${API}/autocollections/refresh-thumbnails`, { method: 'POST' })}>
            Refresh Posters
          </button>
          <button className="btn btn-secondary btn-sm" disabled={running} onClick={async () => {
            setRunning(true);
            await fetch(`${API}/autocollections/franchises`, { method: 'POST' }).catch(() => {});
            setTimeout(() => setRunning(false), 3000);
          }}>Rebuild Franchises</button>
          <button className="btn btn-primary btn-sm" disabled={running} onClick={async () => {
            setRunning(true);
            setBuildProgress({ running: true, phase: 'starting', done: 0, total: 0, current: 'Initializing...' });
            await fetch(`${API}/autocollections/run`, { method: 'POST' }).catch(() => {});
            const poll = setInterval(async () => {
              try {
                const s = await fetch(`${API}/autocollections/status`).then(r => r.json());
                setBuildProgress(s);
                if (!s.running) {
                  clearInterval(poll);
                  setRunning(false);
                  const d = await fetch(`${API}/collections`).then(r => r.json()).catch(() => null);
                  if (d) setCollections(Array.isArray(d) ? d : (d.collections || []));
                }
              } catch {}
            }, 800);
            setTimeout(() => { clearInterval(poll); setRunning(false); }, 300000);
          }}>
            <Wand2 size={13} /> {running ? 'Building…' : 'Build Now'}
          </button>
        </div>
      </div>

      {/* Stats row */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
        {[
          { label: 'Genre', value: byType['auto-genre'] || 0, icon: '🎭' },
          { label: 'Decade', value: byType['auto-decade'] || 0, icon: '📅' },
          { label: 'Year', value: byType['auto-year'] || 0, icon: '🗓' },
          { label: 'Franchise', value: byType['auto-franchise'] || 0, icon: '🎬' },
          { label: 'Network', value: byType['auto-network'] || 0, icon: '📺' },
          { label: 'Studio', value: byType['auto-studio'] || 0, icon: '🏢' },
          { label: 'Director', value: byType['auto-director'] || 0, icon: '🎥' },
          { label: 'Actor', value: byType['auto-actor'] || 0, icon: '🌟' },
          { label: 'Country', value: byType['auto-country'] || 0, icon: '🌍' },
          { label: 'Rating', value: byType['auto-rating'] || 0, icon: '⭐' },
          { label: 'Total', value: collections.length, icon: '📚' },
        ].map(({ label, value, icon }) => (
          <div key={label} style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px', minWidth: 70, textAlign: 'center' }}>
            <div style={{ fontSize: 16 }}>{icon}</div>
            <div style={{ fontSize: 18, fontWeight: 800, lineHeight: 1.2 }}>{value}</div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{label}</div>
          </div>
        ))}
      </div>

      {/* Build Progress Bar */}
      {buildProgress && (
        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, padding: '12px 16px', marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6 }}>
            <span style={{ color: buildProgress.phase === 'complete' ? '#10b981' : buildProgress.phase === 'error' ? '#ef4444' : 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '70%' }}>
              {buildProgress.phase === 'complete' ? '✅' : buildProgress.phase === 'error' ? '❌' : buildProgress.phase === 'genres' ? '🎭' : buildProgress.phase === 'franchises' ? '🎬' : buildProgress.phase === 'networks' ? '📡' : buildProgress.phase === 'actors' ? '🎭' : '⚙️'}
              {' '}{buildProgress.current || 'Processing...'}
            </span>
            <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>
              {buildProgress.total > 0 ? `${buildProgress.done} / ${buildProgress.total} (${Math.round((buildProgress.done / buildProgress.total) * 100)}%)` : ''}
            </span>
          </div>
          <div style={{ height: 6, background: 'var(--bg-tertiary)', borderRadius: 3, overflow: 'hidden' }}>
            {buildProgress.phase === 'complete' ? (
              <div style={{ height: '100%', width: '100%', background: '#10b981', borderRadius: 3 }} />
            ) : buildProgress.phase === 'error' ? (
              <div style={{ height: '100%', width: '100%', background: '#ef4444', borderRadius: 3 }} />
            ) : buildProgress.total > 0 ? (
              <div style={{ height: '100%', width: `${Math.round((buildProgress.done / buildProgress.total) * 100)}%`, background: 'var(--accent)', borderRadius: 3, transition: 'width 0.4s ease' }} />
            ) : (
              <div style={{ height: '100%', width: '35%', background: 'var(--accent)', borderRadius: 3, animation: 'progressPulse 1.2s ease-in-out infinite' }} />
            )}
          </div>
        </div>
      )}

      {/* Provider Refresh Card */}
      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, padding: '12px 16px', marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>🔄 Refresh Streaming Provider Data</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>
          Fetches watch provider data (Netflix, Disney+, Hulu etc.) from TMDB for all movies and TV shows.
          Required before building streaming collections. Takes ~35 min for full library.
          {providerState?.done > 0 && !providerState?.running && <span style={{ color: '#10b981' }}> Last run: {providerState.done} items updated.</span>}
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: providerState?.running ? 10 : 0, flexWrap: 'wrap' }}>
          {[{ label: '🎬 Movies Only', type: 'movies' }, { label: '📺 TV Only', type: 'tvShows' }, { label: '🔄 Both', type: 'both' }].map(({ label, type }) => (
            <button key={type} className="btn btn-secondary btn-sm" onClick={() => runProviderRefresh(type)} disabled={providerState?.running}
              style={{ opacity: providerState?.running ? 0.5 : 1 }}>
              {providerState?.running ? 'Running...' : label}
            </button>
          ))}
          {providerState?.running && (
            <button className="btn btn-secondary btn-sm" style={{ color: '#ef4444' }}
              onClick={() => fetch(`${API}/metadata/providers/stop`, { method: 'POST' })}>
              ⏹ Stop
            </button>
          )}
        </div>
        {providerState && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6 }}>
              <span style={{ color: providerState.running ? 'var(--text-secondary)' : providerState.errors > 0 ? '#f59e0b' : '#10b981', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '70%' }}>
                {providerState.running ? '⚙️ ' : providerState.errors > 0 ? '⚠️ ' : '✅ '}{providerState.current || 'Processing...'}
              </span>
              <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>
                {providerState.total > 0 ? `${providerState.done} / ${providerState.total} (${Math.round((providerState.done / providerState.total) * 100)}%)` : ''}
                {providerState.errors > 0 ? ` · ${providerState.errors} errors` : ''}
              </span>
            </div>
            <div style={{ height: 6, background: 'var(--bg-tertiary)', borderRadius: 3, overflow: 'hidden' }}>
              {!providerState.running && providerState.done > 0 ? (
                <div style={{ height: '100%', width: '100%', background: '#10b981', borderRadius: 3 }} />
              ) : providerState.total > 0 ? (
                <div style={{ height: '100%', width: `${Math.round((providerState.done / providerState.total) * 100)}%`, background: '#8b5cf6', borderRadius: 3, transition: 'width 0.4s ease' }} />
              ) : providerState.running ? (
                <div style={{ height: '100%', width: '35%', background: '#8b5cf6', borderRadius: 3, animation: 'progressPulse 1.2s ease-in-out infinite' }} />
              ) : null}
            </div>
          </div>
        )}
      </div>

      {/* Streaming Collections Builder */}
      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, padding: '12px 16px', marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>📡 Streaming Service Collections</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>Build collections grouped by streaming service (Netflix, Disney+, Hulu, etc.) from TMDB watchProvider data.</div>
        <div style={{ display: 'flex', gap: 8, marginBottom: streamProgress ? 10 : 0, flexWrap: 'wrap' }}>
          {[{ label: '🎬 Movies', mediaType: 'movies' }, { label: '📺 TV Shows', mediaType: 'tvShows' }, { label: '🔄 Both', mediaType: 'both' }].map(({ label, mediaType }) => (
            <button key={mediaType} className="btn btn-secondary btn-sm" onClick={() => runStreaming(mediaType)} disabled={streamProgress?.running}
              style={{ opacity: streamProgress?.running ? 0.5 : 1 }}>
              {streamProgress?.running ? 'Running...' : label}
            </button>
          ))}
        </div>
        {streamProgress && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6 }}>
              <span style={{ color: streamProgress.phase === 'complete' ? '#10b981' : streamProgress.phase === 'error' ? '#ef4444' : 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '70%' }}>
                {streamProgress.phase === 'movies' ? '🎬 ' : streamProgress.phase === 'tvShows' ? '📺 ' : streamProgress.phase === 'complete' ? '✅ ' : streamProgress.phase === 'error' ? '❌ ' : '⚙️ '}
                {streamProgress.current || 'Processing...'}
              </span>
              <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>
                {streamProgress.total > 0 ? `${streamProgress.done} / ${streamProgress.total} (${Math.round((streamProgress.done / streamProgress.total) * 100)}%)` : streamProgress.done > 0 ? `${streamProgress.done} processed` : ''}
              </span>
            </div>
            <div style={{ height: 6, background: 'var(--bg-tertiary)', borderRadius: 3, overflow: 'hidden' }}>
              {streamProgress.phase === 'complete' ? (
                <div style={{ height: '100%', width: '100%', background: '#10b981', borderRadius: 3 }} />
              ) : streamProgress.phase === 'error' ? (
                <div style={{ height: '100%', width: '100%', background: '#ef4444', borderRadius: 3 }} />
              ) : streamProgress.total > 0 ? (
                <div style={{ height: '100%', width: `${Math.round((streamProgress.done / streamProgress.total) * 100)}%`, background: '#06b6d4', borderRadius: 3, transition: 'width 0.4s ease' }} />
              ) : (
                <div style={{ height: '100%', width: '35%', background: '#06b6d4', borderRadius: 3, animation: 'progressPulse 1.2s ease-in-out infinite' }} />
              )}
            </div>
          </div>
        )}
      </div>

      {/* Sub-tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '1px solid var(--border)', paddingBottom: 0 }}>
        {SUBTABS.map(t => (
          <button key={t.id} onClick={() => setSubTab(t.id)}
            style={{ padding: '8px 16px', background: 'none', border: 'none', borderBottom: subTab === t.id ? '2px solid var(--accent)' : '2px solid transparent', color: subTab === t.id ? 'var(--accent)' : 'var(--text-muted)', fontWeight: subTab === t.id ? 700 : 500, cursor: 'pointer', fontSize: 13, fontFamily: 'inherit', marginBottom: -1 }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* COLLECTIONS TAB */}
      {subTab === 'collections' && (
        <div>
          <SectionHead label="Standard Collections" />
          {[
            { key: 'byGenre',    label: 'By Genre',          desc: 'Action, Comedy, Drama, Horror, etc.' },
            { key: 'byDecade',   label: 'By Decade',         desc: '80s, 90s, 2000s, 2010s, 2020s' },
            { key: 'byYear',     label: 'By Year',           desc: 'One collection per release year' },
            { key: 'byRating',   label: 'By Content Rating', desc: 'G, PG, PG-13, R, NR, TV-MA, etc.' },
            { key: 'byCountry',  label: 'By Country',        desc: 'Collections for each production country' },
            { key: 'byLanguage', label: 'By Language',       desc: 'Collections by original language' },
          ].map(({ key, label, desc }) => (
            <Row key={key} label={label} desc={desc}>
              <Toggle on={auto[key] !== false} onChange={() => setSection('autoCollections', key, !auto[key])} />
            </Row>
          ))}

          <SectionHead label="People Collections" />
          {[
            { key: 'byDirector',     label: 'By Director',      desc: 'Directors with 3+ movies in your library' },
            { key: 'byActor',        label: 'By Actor',          desc: 'Actors appearing in 5+ movies in your library' },
            { key: 'byProducer',     label: 'By Producer',       desc: 'Producers with 4+ movies in your library' },
            { key: 'byWriter',       label: 'By Writer',         desc: 'Writers with 4+ movies in your library' },
          ].map(({ key, label, desc }) => (
            <Row key={key} label={label} desc={desc}>
              <Toggle on={auto[key] === true} onChange={() => setSection('autoCollections', key, !auto[key])} />
            </Row>
          ))}

          <SectionHead label="Studio & Network Collections" />
          {[
            { key: 'byStudio',   label: 'By Studio',           desc: 'Disney, Warner Bros, Universal, etc.' },
            { key: 'byNetwork',  label: 'By Network',           desc: 'HBO, Netflix, AMC, BBC, etc. (TV Shows)' },
            { key: 'byStreamer', label: 'By Streaming Service', desc: 'Netflix Originals, Hulu Originals, etc.' },
          ].map(({ key, label, desc }) => (
            <Row key={key} label={label} desc={desc}>
              <Toggle on={auto[key] === true} onChange={() => setSection('autoCollections', key, !auto[key])} />
            </Row>
          ))}

          <SectionHead label="Franchise & Series" />
          {[
            { key: 'byFranchise',    label: 'TMDB Franchises',      desc: 'Marvel, Fast & Furious, Mission Impossible, etc.' },
            { key: 'byUniverse',     label: 'Cinematic Universes',  desc: 'MCU, DCU, Star Wars, Star Trek universes' },
          ].map(({ key, label, desc }) => (
            <Row key={key} label={label} desc={desc}>
              <Toggle on={auto[key] !== false} onChange={() => setSection('autoCollections', key, !auto[key])} />
            </Row>
          ))}

          <SectionHead label="Chart & Award Collections" />
          {[
            { key: 'imdbTop250',      label: 'IMDb Top 250',         desc: 'Collection of your IMDb Top 250 movies' },
            { key: 'oscarWinners',    label: 'Oscar Best Picture',   desc: 'Academy Award Best Picture winners' },
            { key: 'goldenGlobe',     label: 'Golden Globe Winners', desc: 'Golden Globe Best Picture winners' },
            { key: 'recentlyAdded',   label: 'Recently Added',       desc: 'Last 50 items added to your library' },
            { key: 'recentlyReleased',label: 'Recently Released',    desc: 'Movies/shows released in last 90 days' },
          ].map(({ key, label, desc }) => (
            <Row key={key} label={label} desc={desc}>
              <Toggle on={auto[key] === true} onChange={() => setSection('autoCollections', key, !auto[key])} />
            </Row>
          ))}

          <SectionHead label="Minimum Thresholds" />
          <Row label="Minimum items for genre collection" desc="Don't create a genre collection unless it has at least this many items">
            <Select value={auto.minGenreItems || '5'} onChange={v => setSection('autoCollections', 'minGenreItems', v)}
              options={['2','3','5','10','15','20'].map(v => ({ value: v, label: `${v} items` }))} />
          </Row>
          <Row label="Minimum movies for director collection" desc="Minimum movies in library before creating a director collection">
            <Select value={auto.minDirectorItems || '3'} onChange={v => setSection('autoCollections', 'minDirectorItems', v)}
              options={['2','3','4','5','10'].map(v => ({ value: v, label: `${v} movies` }))} />
          </Row>
          <Row label="Minimum movies for actor collection" desc="Minimum movies in library before creating an actor collection">
            <Select value={auto.minActorItems || '5'} onChange={v => setSection('autoCollections', 'minActorItems', v)}
              options={['3','5','7','10','15'].map(v => ({ value: v, label: `${v} movies` }))} />
          </Row>
        </div>
      )}

      {/* OVERLAYS TAB */}
      {subTab === 'overlays' && (
        <div>
          <SectionHead label="Resolution Overlays" />
          {[
            { key: 'show4K',       label: '4K UHD Badge',    desc: 'Show 4K badge on 2160p content' },
            { key: 'show1080p',    label: '1080p Badge',      desc: 'Show 1080p/FHD badge on 1080p content' },
            { key: 'show720p',     label: '720p Badge',       desc: 'Show 720p/HD badge on 720p content' },
            { key: 'showSD',       label: 'SD Badge',         desc: 'Show SD badge on standard definition content' },
          ].map(({ key, label, desc }) => (
            <Row key={key} label={label} desc={desc}>
              <Toggle on={overlays[key] !== false} onChange={() => setSection('overlays', key, !overlays[key])} />
            </Row>
          ))}

          <SectionHead label="HDR Overlays" />
          {[
            { key: 'showDolbyVision', label: 'Dolby Vision',  desc: 'Show Dolby Vision badge (DV profile)' },
            { key: 'showHDR10Plus',   label: 'HDR10+',         desc: 'Show HDR10+ badge' },
            { key: 'showHDR10',       label: 'HDR10',          desc: 'Show HDR10 badge' },
            { key: 'showHLG',         label: 'HLG',            desc: 'Show HLG badge' },
          ].map(({ key, label, desc }) => (
            <Row key={key} label={label} desc={desc}>
              <Toggle on={overlays[key] !== false} onChange={() => setSection('overlays', key, !overlays[key])} />
            </Row>
          ))}

          <SectionHead label="Audio Overlays" />
          {[
            { key: 'showAtmos',    label: 'Dolby Atmos',       desc: 'Show Atmos badge for Dolby Atmos audio' },
            { key: 'showDTSX',     label: 'DTS:X',             desc: 'Show DTS:X badge' },
            { key: 'showTrueHD',   label: 'Dolby TrueHD',      desc: 'Show TrueHD badge' },
            { key: 'showDTSHD',    label: 'DTS-HD MA',         desc: 'Show DTS-HD Master Audio badge' },
            { key: 'showDTS',      label: 'DTS',               desc: 'Show DTS badge' },
            { key: 'showDDPlus',   label: 'Dolby Digital+',    desc: 'Show EAC3/DD+ badge' },
            { key: 'showDD',       label: 'Dolby Digital',     desc: 'Show AC3/DD badge' },
            { key: 'showAAC',      label: 'AAC',               desc: 'Show AAC audio badge' },
          ].map(({ key, label, desc }) => (
            <Row key={key} label={label} desc={desc}>
              <Toggle on={overlays[key] === true} onChange={() => setSection('overlays', key, !overlays[key])} />
            </Row>
          ))}

          <SectionHead label="Status & Edition Overlays" />
          {[
            { key: 'showContentRating', label: 'Content Rating',    desc: 'Show rating badge (PG-13, R, TV-MA, etc.)' },
            { key: 'showStatus',        label: 'TV Show Status',     desc: 'Show Continuing/Ended ribbon on TV shows' },
            { key: 'showEdition',       label: 'Edition',            desc: "Show edition tag (Director's Cut, Extended, etc.)" },
            { key: 'showLanguage',      label: 'Language',           desc: 'Show original language flag/badge' },
            { key: 'showNewRibbon',     label: 'New Ribbon',         desc: 'Show "New" ribbon on items added in the last 30 days' },
          ].map(({ key, label, desc }) => (
            <Row key={key} label={label} desc={desc}>
              <Toggle on={overlays[key] === true} onChange={() => setSection('overlays', key, !overlays[key])} />
            </Row>
          ))}

          <SectionHead label="Overlay Appearance" />
          <Row label="Overlay position" desc="Corner where resolution/audio overlays appear on posters">
            <Select value={overlays.position || 'bottom-left'}
              onChange={v => setSection('overlays', 'position', v)}
              options={[
                { value: 'top-left', label: 'Top Left' },
                { value: 'top-right', label: 'Top Right' },
                { value: 'bottom-left', label: 'Bottom Left' },
                { value: 'bottom-right', label: 'Bottom Right' },
              ]} />
          </Row>
          <Row label="Overlay style" desc="Visual style of overlay badges">
            <Select value={overlays.style || 'badge'}
              onChange={v => setSection('overlays', 'style', v)}
              options={[
                { value: 'badge', label: 'Badge' },
                { value: 'ribbon', label: 'Ribbon' },
                { value: 'text', label: 'Text Only' },
              ]} />
          </Row>
        </div>
      )}

      {/* RATINGS TAB */}
      {subTab === 'ratings' && (
        <div>
          <SectionHead label="Rating Sources" />
          {[
            { key: 'showIMDb',       label: 'IMDb Rating',           desc: 'Show IMDb score on poster (e.g. 8.2)' },
            { key: 'showRT',         label: 'Rotten Tomatoes',       desc: 'Show RT Tomatometer score on poster' },
            { key: 'showRTAudience', label: 'RT Audience Score',     desc: 'Show RT Audience/Popcornmeter score' },
            { key: 'showTMDB',       label: 'TMDB Rating',           desc: 'Show TMDB community score' },
            { key: 'showMetacritic', label: 'Metacritic',            desc: 'Show Metacritic score on poster' },
            { key: 'showTVDB',       label: 'TVDB Rating (TV only)', desc: 'Show TVDB rating for TV shows' },
          ].map(({ key, label, desc }) => (
            <Row key={key} label={label} desc={desc}>
              <Toggle on={ratings[key] === true} onChange={() => setSection('ratings', key, !ratings[key])} />
            </Row>
          ))}

          <SectionHead label="Rating Display" />
          <Row label="Rating position" desc="Where ratings appear on the poster">
            <Select value={ratings.position || 'top-left'}
              onChange={v => setSection('ratings', 'position', v)}
              options={[
                { value: 'top-left', label: 'Top Left' },
                { value: 'top-right', label: 'Top Right' },
                { value: 'bottom-left', label: 'Bottom Left' },
                { value: 'bottom-right', label: 'Bottom Right' },
              ]} />
          </Row>
          <Row label="Rating style" desc="How ratings are displayed">
            <Select value={ratings.style || 'score'}
              onChange={v => setSection('ratings', 'style', v)}
              options={[
                { value: 'score', label: 'Score (8.2)' },
                { value: 'star', label: 'Stars (★★★★)' },
                { value: 'percent', label: 'Percent (82%)' },
              ]} />
          </Row>
          <Row label="Minimum rating count" desc="Only show ratings when at least this many votes exist">
            <Select value={ratings.minVotes || '100'}
              onChange={v => setSection('ratings', 'minVotes', v)}
              options={['10','50','100','500','1000','5000'].map(v => ({ value: v, label: `${v} votes` }))} />
          </Row>
        </div>
      )}

      {/* SCHEDULE TAB */}
      {subTab === 'schedule' && (
        <div>
          <SectionHead label="Auto-Rebuild Schedule" />
          <Row label="Rebuild frequency" desc="How often to automatically rebuild all collections">
            <Select value={cfg.schedule || 'daily'}
              onChange={v => save({ ...cfg, schedule: v })}
              options={[
                { value: 'hourly',  label: 'Every hour' },
                { value: 'daily',   label: 'Daily' },
                { value: 'weekly',  label: 'Weekly' },
                { value: 'manual',  label: 'Manual only' },
              ]} />
          </Row>
          <Row label="Rebuild time" desc="What time of day to run the automatic rebuild">
            <Select value={cfg.scheduleHour || '4'}
              onChange={v => save({ ...cfg, scheduleHour: v })}
              options={Array.from({length:24},(_,i)=>({ value: String(i), label: `${String(i).padStart(2,'0')}:00` }))} />
          </Row>

          <SectionHead label="On Library Scan" />
          <Row label="Rebuild after library scan" desc="Automatically rebuild collections whenever a library scan completes">
            <Toggle on={cfg.rebuildOnScan !== false} onChange={() => save({ ...cfg, rebuildOnScan: !cfg.rebuildOnScan })} />
          </Row>
          <Row label="Rebuild after metadata fetch" desc="Rebuild after metadata is refreshed for new items">
            <Toggle on={cfg.rebuildOnMetadata === true} onChange={() => save({ ...cfg, rebuildOnMetadata: !cfg.rebuildOnMetadata })} />
          </Row>

          {cfg.lastRun && (
            <div style={{ marginTop: 20, fontSize: 12, color: 'var(--text-muted)', padding: '12px 14px', background: 'var(--bg-card)', borderRadius: 'var(--radius)', border: '1px solid var(--border)' }}>
              Last built: {new Date(cfg.lastRun).toLocaleString()}
            </div>
          )}
        </div>
      )}
    </div>
  );
}


function hexToRgba(hex, alpha = 1) {
  const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function ThemeBuilder({ currentTheme, changeTheme }) {
  const API = 'http://localhost:3001/api';
  const [customThemes, setCustomThemes] = React.useState(() => {
    try { return JSON.parse(localStorage.getItem('orion_custom_themes') || '[]'); } catch { return []; }
  });
  const [creating, setCreating] = React.useState(false);
  const [editId, setEditId] = React.useState(null);
  const [name, setName] = React.useState('');
  const [colors, setColors] = React.useState({ '--bg-primary':'#0a0a14', '--bg-secondary':'#111122', '--bg-card':'#1a1a2e', '--accent':'#6366f1', '--text-primary':'#ffffff', '--text-secondary':'#a0a6b8', '--border':'#2a2a3e' });
  const [aiPrompt, setAiPrompt] = React.useState('');
  const [aiLoading, setAiLoading] = React.useState(false);
  const [aiError, setAiError] = React.useState('');

  const saveCustomThemes = (list) => {
    setCustomThemes(list);
    localStorage.setItem('orion_custom_themes', JSON.stringify(list));
    // Push to server so player clients can pull via /api/themes
    fetch(`${API}/themes/custom`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ themes: list }),
    }).catch(() => {});
  };

  const buildVars = (c) => ({
    '--bg-primary':    c['--bg-primary'],
    '--bg-secondary':  c['--bg-secondary'],
    '--bg-tertiary':   c['--bg-card'],
    '--bg-card':       c['--bg-card'],
    '--bg-hover':      c['--bg-secondary'],
    '--accent':        c['--accent'],
    '--accent-hover':  c['--accent'],
    '--accent-glow':   hexToRgba(c['--accent'], 0.35),
    '--text-primary':  c['--text-primary'],
    '--text-secondary':c['--text-secondary'],
    '--text-muted':    hexToRgba(c['--text-secondary'], 0.6),
    '--border':        c['--border'],
    '--border-accent': hexToRgba(c['--accent'], 0.5),
    '--gradient-hero': `linear-gradient(180deg, transparent 0%, ${hexToRgba(c['--bg-primary'],0.8)} 60%, ${c['--bg-primary']} 100%)`,
    '--gradient-card': `linear-gradient(180deg, transparent 50%, ${hexToRgba(c['--bg-primary'],0.95)} 100%)`,
    '--sidebar-bg':    hexToRgba(c['--bg-primary'], 0.97),
    '--tag-bg':        hexToRgba(c['--accent'], 0.2),
    '--tag-color':     c['--accent'],
    '--scrollbar':     c['--bg-card'],
    '--font-display':  '"Segoe UI", sans-serif',
    '--font-body':     '"Segoe UI", sans-serif',
    '--radius':        '6px',
    '--radius-lg':     '12px',
  });

  const startCreate = () => { setCreating(true); setEditId(null); setName('My Theme'); setAiPrompt(''); setAiError(''); };
  const startEdit = (ct) => {
    setCreating(true); setEditId(ct.id); setName(ct.name); setAiPrompt('');
    // Extract colors from vars
    const c = {};
    THEME_VARS.forEach(v => { c[v.key] = ct.vars[v.key] || '#000000'; });
    setColors(c);
  };

  const saveTheme = () => {
    const id = editId || `custom_${Date.now()}`;
    const ct = { id, name: name || 'Custom Theme', preview: [colors['--bg-primary'], colors['--accent'], colors['--text-primary']], vars: buildVars(colors) };
    const list = editId ? customThemes.map(t => t.id === editId ? ct : t) : [...customThemes, ct];
    saveCustomThemes(list);
    changeTheme(id);
    setCreating(false); setEditId(null);
  };

  const deleteTheme = (id) => {
    const list = customThemes.filter(t => t.id !== id);
    saveCustomThemes(list);
    if (currentTheme === id) changeTheme('disney');
  };

  const generateWithAI = async () => {
    if (!aiPrompt.trim()) return;
    setAiLoading(true); setAiError('');
    try {
      const systemPrompt = `You are a UI theme designer. Given a theme description, output ONLY valid JSON (no markdown, no explanation) with these exact hex color keys:
{"--bg-primary":"#...","--bg-secondary":"#...","--bg-card":"#...","--accent":"#...","--text-primary":"#...","--text-secondary":"#...","--border":"#..."}
Rules: bg-primary is the darkest background, bg-secondary slightly lighter, bg-card for cards, accent is the highlight/brand color, text-primary is bright (near white for dark themes), text-secondary is muted text, border is a subtle divider color. Output ONLY the JSON object.`;
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 300,
          system: systemPrompt,
          messages: [{ role: 'user', content: `Create a theme for: ${aiPrompt}` }]
        })
      });
      const data = await res.json();
      const text = data.content?.[0]?.text || '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON in response');
      const generated = JSON.parse(jsonMatch[0]);
      // Validate keys are hex colors
      const valid = {};
      THEME_VARS.forEach(v => { if (generated[v.key] && /^#[0-9a-fA-F]{6}$/.test(generated[v.key])) valid[v.key] = generated[v.key]; });
      setColors(prev => ({ ...prev, ...valid }));
      if (!name || name === 'My Theme') setName(aiPrompt.split(' ').slice(0,3).join(' ') + ' Theme');
    } catch(e) {
      setAiError('AI generation failed. Try adjusting your description.');
    }
    setAiLoading(false);
  };

  return (
    <div>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:24 }}>
        <div>
          <h3 style={{ fontSize:16, fontWeight:700, marginBottom:4 }}>Themes</h3>
          <p style={{ fontSize:13, color:'var(--text-muted)' }}>Choose a built-in theme or create your own.</p>
        </div>
        {!creating && <button className="btn btn-primary btn-sm" onClick={startCreate}><Plus size={13}/> Create Theme</button>}
      </div>

      {/* Built-in themes */}
      <div style={{ fontSize:11, fontWeight:800, color:'var(--text-muted)', letterSpacing:1.2, textTransform:'uppercase', marginBottom:12 }}>Built-in</div>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(160px,1fr))', gap:12, marginBottom:28 }}>
        {Object.values(themes).map(t => (
          <div key={t.id} onClick={() => changeTheme(t.id)} style={{
            background:'var(--bg-card)', border: currentTheme===t.id ? '2px solid var(--accent)' : '1px solid var(--border)',
            borderRadius:'var(--radius-lg)', overflow:'hidden', cursor:'pointer', transition:'all 0.2s'
          }}>
            <div style={{ height:56, display:'flex' }}>
              {t.preview.map((c,i) => <div key={i} style={{ flex:1, background:c }} />)}
            </div>
            <div style={{ padding:'10px 12px', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
              <div style={{ fontSize:12, fontWeight:600 }}>{t.name}</div>
              {currentTheme===t.id && <span style={{ fontSize:10, color:'var(--accent)' }}>✓ Active</span>}
            </div>
          </div>
        ))}
      </div>

      {/* Custom themes */}
      {customThemes.length > 0 && (
        <>
          <div style={{ fontSize:11, fontWeight:800, color:'var(--text-muted)', letterSpacing:1.2, textTransform:'uppercase', marginBottom:12 }}>Custom</div>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(160px,1fr))', gap:12, marginBottom:28 }}>
            {customThemes.map(ct => (
              <div key={ct.id} style={{
                background:'var(--bg-card)', border: currentTheme===ct.id ? '2px solid var(--accent)' : '1px solid var(--border)',
                borderRadius:'var(--radius-lg)', overflow:'hidden', transition:'all 0.2s', position:'relative'
              }}>
                <div onClick={() => changeTheme(ct.id)} style={{ cursor:'pointer' }}>
                  <div style={{ height:56, display:'flex' }}>
                    {ct.preview.map((c,i) => <div key={i} style={{ flex:1, background:c }} />)}
                  </div>
                  <div style={{ padding:'10px 12px', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
                    <div style={{ fontSize:12, fontWeight:600 }}>{ct.name}</div>
                    {currentTheme===ct.id && <span style={{ fontSize:10, color:'var(--accent)' }}>✓</span>}
                  </div>
                </div>
                <div style={{ display:'flex', gap:4, padding:'0 8px 8px' }}>
                  <button onClick={() => startEdit(ct)} className="btn btn-secondary btn-sm" style={{ flex:1, fontSize:11 }}>Edit</button>
                  <button onClick={() => deleteTheme(ct.id)} className="btn btn-sm" style={{ fontSize:11, color:'#ef4444', background:'rgba(239,68,68,0.1)', border:'1px solid rgba(239,68,68,0.3)' }}>Del</button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Theme creator / editor */}
      {creating && (
        <div style={{ background:'var(--bg-card)', border:'1px solid var(--accent)', borderRadius:'var(--radius-lg)', padding:24, marginTop:8 }}>
          <div style={{ fontSize:15, fontWeight:700, marginBottom:20 }}>{editId ? 'Edit Theme' : 'Create Theme'}</div>

          {/* Theme name */}
          <div style={{ marginBottom:20 }}>
            <label style={{ fontSize:12, fontWeight:700, color:'var(--text-muted)', display:'block', marginBottom:6 }}>THEME NAME</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="My Awesome Theme"
              style={{ width:'100%', padding:'8px 12px', background:'var(--bg-tertiary)', border:'1px solid var(--border)', borderRadius:'var(--radius)', color:'var(--text-primary)', fontSize:13, boxSizing:'border-box' }} />
          </div>

          {/* AI Generator */}
          <div style={{ marginBottom:20, padding:16, background:'rgba(99,102,241,0.06)', border:'1px solid rgba(99,102,241,0.2)', borderRadius:'var(--radius-lg)' }}>
            <div style={{ fontSize:12, fontWeight:700, color:'var(--accent)', marginBottom:8 }}>🤖 AI Theme Generator</div>
            <div style={{ fontSize:12, color:'var(--text-muted)', marginBottom:10 }}>Describe a theme and AI will generate the colors for you.</div>
            <div style={{ display:'flex', gap:8 }}>
              <input value={aiPrompt} onChange={e => setAiPrompt(e.target.value)}
                onKeyDown={e => e.key==='Enter' && generateWithAI()}
                placeholder="e.g. Midnight forest with emerald green accents..."
                style={{ flex:1, padding:'8px 12px', background:'var(--bg-tertiary)', border:'1px solid var(--border)', borderRadius:'var(--radius)', color:'var(--text-primary)', fontSize:13 }} />
              <button onClick={generateWithAI} disabled={aiLoading || !aiPrompt.trim()} className="btn btn-primary btn-sm">
                {aiLoading ? '⏳ Generating…' : '✨ Generate'}
              </button>
            </div>
            {aiError && <div style={{ fontSize:12, color:'#ef4444', marginTop:8 }}>{aiError}</div>}
          </div>

          {/* Color pickers */}
          <div style={{ fontSize:12, fontWeight:700, color:'var(--text-muted)', marginBottom:12, letterSpacing:1 }}>COLORS</div>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(180px,1fr))', gap:12, marginBottom:20 }}>
            {THEME_VARS.map(({ key, label }) => (
              <div key={key} style={{ display:'flex', alignItems:'center', gap:10 }}>
                <input type="color" value={colors[key]||'#000000'} onChange={e => setColors(c => ({...c, [key]: e.target.value}))}
                  style={{ width:36, height:36, border:'none', borderRadius:'var(--radius)', cursor:'pointer', padding:2, background:'var(--bg-tertiary)' }} />
                <div>
                  <div style={{ fontSize:12, fontWeight:600 }}>{label}</div>
                  <div style={{ fontSize:10, color:'var(--text-muted)', fontFamily:'monospace' }}>{colors[key]}</div>
                </div>
              </div>
            ))}
          </div>

          {/* Preview swatch */}
          <div style={{ marginBottom:20 }}>
            <div style={{ fontSize:12, fontWeight:700, color:'var(--text-muted)', marginBottom:10, letterSpacing:1 }}>PREVIEW</div>
            <div style={{ borderRadius:'var(--radius-lg)', overflow:'hidden', border:'1px solid var(--border)' }}>
              <div style={{ background: colors['--bg-primary'], padding:16 }}>
                <div style={{ background: colors['--bg-card'], borderRadius:8, padding:12, marginBottom:8, border:`1px solid ${colors['--border']}` }}>
                  <div style={{ color: colors['--text-primary'], fontWeight:700, fontSize:14, marginBottom:4 }}>Sample Card Title</div>
                  <div style={{ color: colors['--text-secondary'], fontSize:12 }}>This is how text looks in your theme</div>
                </div>
                <div style={{ display:'flex', gap:8, alignItems:'center' }}>
                  <div style={{ background: colors['--accent'], color:'#fff', padding:'6px 14px', borderRadius:6, fontSize:12, fontWeight:700 }}>Accent Button</div>
                  <div style={{ color: colors['--accent'], fontSize:12, fontWeight:600 }}>Accent Text Link</div>
                </div>
              </div>
            </div>
          </div>

          <div style={{ display:'flex', gap:8 }}>
            <button className="btn btn-primary" onClick={saveTheme}>{editId ? 'Save Changes' : 'Create Theme'}</button>
            <button className="btn btn-secondary" onClick={() => { setCreating(false); setEditId(null); }}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

function ThumbnailGeneratorRow({ libSettings, updateLibSettings, API }) {
  const [status, setStatus] = React.useState(null);
  const [progress, setProgress] = React.useState({ current: 0, total: 0, done: 0, failed: 0, status: '' });
  const socketRef = React.useRef(null);

  React.useEffect(() => {
    let sock;
    (async () => {
      try {
        const { io } = await import('socket.io-client');
        sock = io('http://localhost:3001');
        socketRef.current = sock;
        sock.on('thumbnail:progress', (data) => {
          setProgress(data);
          if (data.complete) {
            setStatus('done');
            setTimeout(() => { setStatus(null); setProgress({ current:0, total:0, done:0, failed:0, status:'' }); }, 8000);
          } else {
            setStatus('running');
          }
        });
        sock.on('dedup:progress', (data) => {
          const el = document.getElementById('dedup-status');
          if (el) {
            el.textContent = data.total ? `${data.status} (${data.current}/${data.total})` : data.status;
            el.style.color = data.done ? (data.status.startsWith('✅') ? '#10b981' : '#f87171') : 'var(--text-muted)';
          }
        });
      } catch {}
    })();
    return () => { if (sock) sock.disconnect(); };
  }, []);

  const runNow = async () => {
    setStatus('running');
    setProgress({ current: 0, total: 0, done: 0, failed: 0, status: 'Starting...' });
    try {
      const res = await fetch(`${API}/generate-thumbnails`, { method: 'POST' });
      if (!res.ok) throw new Error('Failed');
    } catch {
      setStatus('error');
      setTimeout(() => setStatus(null), 3000);
    }
  };

  const pct = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;

  return (
    <div style={{ padding:'16px 0', borderBottom:'1px solid var(--border)' }}>
      <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:16 }}>
        <div style={{ flex:1 }}>
          <div style={{ fontSize:14, fontWeight:600, marginBottom:3 }}>Auto-generate missing thumbnails</div>
          <div style={{ fontSize:12, color:'var(--text-muted)', marginBottom:10 }}>
            Extract a screenshot at 10% into any movie, episode or music video that has no poster art. Items with existing artwork are skipped.
          </div>
          <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap' }}>
            <button onClick={runNow} disabled={status==='running'} className="btn btn-primary btn-sm"
              style={{ display:'flex', alignItems:'center', gap:6 }}>
              {status==='running'
                ? <><span style={{ display:'inline-block', width:12, height:12, border:'2px solid rgba(255,255,255,0.3)', borderTopColor:'white', borderRadius:'50%', animation:'spin 0.8s linear infinite' }} /> Generating…</>
                : status==='done' ? '✓ Done!'
                : status==='error' ? '✗ Failed — check server log'
                : <><RefreshCw size={13}/> Generate All Now</>
              }
            </button>
            {status !== 'running' && (
              <span style={{ fontSize:12, color:'var(--text-muted)' }}>
                Skips items that already have artwork
              </span>
            )}
          </div>

          {/* Progress bar */}
          {status === 'running' && progress.total > 0 && (
            <div style={{ marginTop:14 }}>
              <div style={{ display:'flex', justifyContent:'space-between', fontSize:12, color:'var(--text-muted)', marginBottom:5 }}>
                <span style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', maxWidth:'60%' }}>{progress.status}</span>
                <span>{progress.current} / {progress.total} ({pct}%)</span>
              </div>
              <div style={{ height:6, background:'var(--bg-tertiary)', borderRadius:3, overflow:'hidden' }}>
                <div style={{ height:'100%', width:`${pct}%`, background:'var(--accent)', borderRadius:3, transition:'width 0.3s' }} />
              </div>
              <div style={{ display:'flex', gap:16, fontSize:11, color:'var(--text-muted)', marginTop:5 }}>
                <span style={{ color:'#10b981' }}>✓ {progress.done} generated</span>
                {progress.failed > 0 && <span style={{ color:'#ef4444' }}>✗ {progress.failed} failed</span>}
              </div>
            </div>
          )}

          {/* Done summary */}
          {status === 'done' && (
            <div style={{ marginTop:10, fontSize:12, color:'#10b981' }}>
              ✓ {progress.done} thumbnails generated{progress.failed > 0 ? `, ${progress.failed} failed` : ''} — cards will update as you browse
            </div>
          )}
        </div>
        <button onClick={() => updateLibSettings({ autoGenerateThumbnails: !libSettings.autoGenerateThumbnails })}
          style={{ background:'none', border:'none', cursor:'pointer', color: libSettings.autoGenerateThumbnails!==false?'var(--accent)':'var(--text-muted)', flexShrink:0, marginTop:2 }}>
          {libSettings.autoGenerateThumbnails !== false ? <ToggleRight size={28}/> : <ToggleLeft size={28}/>}
        </button>
      </div>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}} @keyframes progressPulse{0%{transform:translateX(-100%)}100%{transform:translateX(350%)}}`}</style>
    </div>
  );
}

function NavGroup({ group, activeTab, setActiveTab }) {
  const isGroupActive = group.tabs.some(t => t.id === activeTab);
  const [open, setOpen] = React.useState(isGroupActive);
  return (
    <div style={{ marginBottom:4 }}>
      <button onClick={() => setOpen(o => !o)} style={{
        display:'flex', alignItems:'center', justifyContent:'space-between',
        width:'100%', padding:'8px 12px', border:'none', cursor:'pointer',
        borderRadius:'var(--radius)', fontSize:11, fontWeight:800,
        letterSpacing:1.2, textTransform:'uppercase',
        background: isGroupActive ? 'rgba(99,102,241,0.08)' : 'transparent',
        color: isGroupActive ? 'var(--accent)' : 'var(--text-muted)',
        transition:'all 0.15s'
      }}>
        {group.label}
        <span style={{ fontSize:10, opacity:0.6 }}>{open ? '▾' : '▸'}</span>
      </button>
      {open && group.tabs.map(({ id, icon: Icon, label }) => (
        <button key={id} onClick={() => setActiveTab(id)} style={{
          display:'flex', alignItems:'center', gap:9, padding:'7px 12px 7px 20px',
          width:'100%', borderRadius:'var(--radius)', border:'none', cursor:'pointer',
          fontSize:13, fontWeight:500, textAlign:'left',
          background: activeTab === id ? 'var(--tag-bg)' : 'transparent',
          color: activeTab === id ? 'var(--accent)' : 'var(--text-secondary)',
          transition:'all 0.15s'
        }}>
          <Icon size={13} /> {label}
        </button>
      ))}
    </div>
  );
}

const DEFAULT_HOME_SECTIONS = [
  { id: 'continueWatching',       label: '⏯ Continue Watching' },
  { id: 'recentMovies',           label: '🎬 Recent Movies' },
  { id: 'tvSeries',               label: '📺 TV Series' },
  { id: 'collections',            label: '📚 Collections' },
  { id: 'music',                  label: '🎵 Music' },
  { id: 'musicVideos',            label: '🎞 Music Videos' },
  { id: 'recentlyReleasedMovies', label: '🆕 Recently Released Movies' },
  { id: 'newEpisodes',            label: '📡 Recently Added Episodes' },
  { id: 'recommendedMovies',      label: '⭐ Recommended Movies' },
  { id: 'recommendedShows',       label: '📺 Recommended Shows' },
];

function HomeLayoutSettings() {
  const [sections, setSections] = React.useState(null);
  const [saved, setSaved] = React.useState(false);
  const [dragIdx, setDragIdx] = React.useState(null);
  const [dragOver, setDragOver] = React.useState(null);

  React.useEffect(() => {
    fetch('http://localhost:3001/api/config').then(r => r.json()).then(d => {
      if (d.homeLayout?.length) {
        // Merge saved layout with defaults (in case new sections were added)
        const savedIds = new Set(d.homeLayout.map(s => s.id));
        const merged = [
          ...d.homeLayout,
          ...DEFAULT_HOME_SECTIONS.filter(s => !savedIds.has(s.id))
        ];
        setSections(merged);
      } else {
        setSections(DEFAULT_HOME_SECTIONS.map(s => ({ ...s, visible: true })));
      }
    }).catch(() => setSections(DEFAULT_HOME_SECTIONS.map(s => ({ ...s, visible: true }))));
  }, []);

  const save = async () => {
    await fetch('http://localhost:3001/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ homeLayout: sections })
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const toggleVisible = (id) => {
    setSections(prev => prev.map(s => s.id === id ? { ...s, visible: s.visible === false ? true : false } : s));
  };

  const onDragStart = (i) => setDragIdx(i);
  const onDragOver = (e, i) => { e.preventDefault(); setDragOver(i); };
  const onDrop = (i) => {
    if (dragIdx === null || dragIdx === i) { setDragIdx(null); setDragOver(null); return; }
    const next = [...sections];
    const [moved] = next.splice(dragIdx, 1);
    next.splice(i, 0, moved);
    setSections(next);
    setDragIdx(null);
    setDragOver(null);
  };

  if (!sections) return <div style={{ padding: 32, color: 'var(--text-muted)' }}>Loading...</div>;

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Home Page Layout</h3>
        <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Drag to reorder sections. Toggle the eye icon to show or hide.</p>
      </div>
      <div style={{ maxWidth: 500 }}>
        {sections.map((section, i) => (
          <div key={section.id}
            draggable
            onDragStart={() => onDragStart(i)}
            onDragOver={e => onDragOver(e, i)}
            onDrop={() => onDrop(i)}
            onDragEnd={() => { setDragIdx(null); setDragOver(null); }}
            style={{
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '12px 16px', marginBottom: 6,
              background: dragOver === i ? 'rgba(99,102,241,0.15)' : 'var(--bg-card)',
              border: `1px solid ${dragOver === i ? 'var(--accent)' : 'var(--border)'}`,
              borderRadius: 10, cursor: 'grab', transition: 'all 0.15s',
              opacity: section.visible === false ? 0.45 : 1,
            }}>
            <GripVertical size={16} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
            <span style={{ flex: 1, fontSize: 14, fontWeight: 500 }}>{section.label}</span>
            <button onClick={() => toggleVisible(section.id)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: section.visible === false ? 'var(--text-muted)' : 'var(--accent)', padding: 4, display: 'flex' }}>
              {section.visible === false ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        ))}
      </div>
      <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={save}>
        {saved ? '✅ Saved!' : '💾 Save Layout'}
      </button>
    </div>
  );
}
function MovieSmartDedup() {
  const API = 'http://localhost:3001/api';
  const [scanning, setScanning] = React.useState(false);
  const [popup, setPopup] = React.useState(null); // { groups: [...] }
  const [choices, setChoices] = React.useState({}); // groupIdx -> 'merge'|'remove'|'skip'
  const [running, setRunning] = React.useState(false);
  const [progressMsg, setProgressMsg] = React.useState('');

  const fetchPreview = async () => {
    setScanning(true);
    try {
      const d = await fetch(`${API}/library/movies/smart-dedup`).then(r=>r.json());
      const groups = [...(d.toRemove||[]).map(m => ({ type: 'remove', title: m.title, year: m.year, files: [m.filePath], ids: [m.id] })),
                      ...(d.toMerge||[]).map(m => ({ type: 'merge', title: m.title, year: m.year, files: m.files, paths: m.paths }))];
      if (!groups.length) { alert('✅ No duplicates found.'); setScanning(false); return; }
      const init = {};
      groups.forEach((g, i) => { init[i] = g.type; });
      setChoices(init);
      setPopup({ groups });
    } catch(e) { alert('Error: ' + e.message); }
    setScanning(false);
  };

  const runSelected = async () => {
    setRunning(true); setProgressMsg('Starting...');
    const toRemove = [], toMerge = [];
    popup.groups.forEach((g, i) => {
      if (choices[i] === 'remove') toRemove.push(...(g.ids || []));
      else if (choices[i] === 'merge' && g.paths) toMerge.push({ paths: g.paths });
    });
    try {
      await fetch(`${API}/library/movies/smart-dedup`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toRemove, toMerge })
      });
      setPopup(null);
    } catch(e) { setProgressMsg('Error: ' + e.message); }
    setRunning(false);
  };

  const selectedCount = Object.values(choices).filter(v => v !== 'skip').length;

  return (
    <>
      <button onClick={fetchPreview} disabled={scanning}
        style={{ padding: '8px 18px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', color: 'var(--text-primary)', cursor: 'pointer', fontSize: 13 }}>
        {scanning ? '🔍 Scanning...' : '🔍 Smart Dedup'}
      </button>

      {popup && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={e => { if (e.target === e.currentTarget) setPopup(null); }}>
          <div style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 16, width: '90%', maxWidth: 760, maxHeight: '85vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {/* Header */}
            <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontSize: 17, fontWeight: 700 }}>🎬 Duplicate Movies Found</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>{popup.groups.length} duplicate groups — choose action for each</div>
              </div>
              <button onClick={() => setPopup(null)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 20 }}>✕</button>
            </div>

            {/* Groups list */}
            <div style={{ overflowY: 'auto', flex: 1, padding: '12px 24px' }}>
              {popup.groups.map((g, i) => (
                <div key={i} style={{ padding: '14px 0', borderBottom: '1px solid var(--border)' }}>
                  <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 6 }}>{g.title} {g.year ? `(${g.year})` : ''}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 10 }}>
                    {g.files.map((f, fi) => <div key={fi}>📄 {f}</div>)}
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {[
                      { val: 'merge', label: '📁 Merge Folders', color: '#f59e0b', desc: 'Move all files into one folder' },
                      { val: 'remove', label: '🗑 Remove Duplicate', color: '#f87171', desc: 'Remove extra from library (keeps file)' },
                      { val: 'skip', label: '⏭ Skip', color: 'var(--text-muted)', desc: 'Do nothing' },
                    ].map(opt => (
                      <button key={opt.val} onClick={() => setChoices(c => ({ ...c, [i]: opt.val }))}
                        style={{ padding: '6px 14px', borderRadius: 8, border: `2px solid ${choices[i] === opt.val ? opt.color : 'var(--border)'}`,
                          background: choices[i] === opt.val ? `${opt.color}22` : 'var(--bg-card)',
                          color: choices[i] === opt.val ? opt.color : 'var(--text-muted)', cursor: 'pointer', fontSize: 12, fontWeight: 600, transition: 'all 0.15s' }}>
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            {/* Footer */}
            <div style={{ padding: '16px 24px', borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{progressMsg}</div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button onClick={() => setPopup(null)} style={{ padding: '9px 20px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text-primary)', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
                <button onClick={runSelected} disabled={running || selectedCount === 0}
                  style={{ padding: '9px 20px', background: selectedCount > 0 ? 'var(--accent)' : 'var(--bg-tertiary)', border: 'none', borderRadius: 8, color: 'white', cursor: selectedCount > 0 ? 'pointer' : 'default', fontSize: 13, fontWeight: 700 }}>
                  {running ? '⏳ Processing...' : `▶ Apply (${selectedCount} actions)`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function TVShowSmartDedup() {
  const API = 'http://localhost:3001/api';
  const [scanning, setScanning] = React.useState(false);
  const [popup, setPopup] = React.useState(null);
  const [choices, setChoices] = React.useState({});
  const [running, setRunning] = React.useState(false);
  const [progressMsg, setProgressMsg] = React.useState('');

  const fetchPreview = async () => {
    setScanning(true);
    try {
      const d = await fetch(`${API}/library/tvShows/smart-dedup`).then(r=>r.json());
      if (!d.groups?.length) { alert('✅ No duplicate TV shows found.'); setScanning(false); return; }
      const init = {};
      d.groups.forEach((g, i) => { init[i] = 'merge'; });
      setChoices(init);
      setPopup({ groups: d.groups });
    } catch(e) { alert('Error: ' + e.message); }
    setScanning(false);
  };

  const runSelected = async () => {
    setRunning(true); setProgressMsg('Processing...');
    const toMerge = [], toSkip = [];
    popup.groups.forEach((g, i) => {
      if (choices[i] === 'merge') toMerge.push(g);
      else toSkip.push(g);
    });
    try {
      const d = await fetch(`${API}/library/tvShows/smart-dedup`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toMerge })
      }).then(r=>r.json());
      setProgressMsg(`✅ Merged ${d.merged} show groups`);
      setPopup(null);
    } catch(e) { setProgressMsg('Error: ' + e.message); }
    setRunning(false);
  };

  const selectedCount = Object.values(choices).filter(v => v === 'merge').length;

  return (
    <>
      <button className="btn btn-secondary btn-sm" onClick={fetchPreview} disabled={scanning}>
        {scanning ? '🔍 Scanning...' : '🔍 Smart Dedup'}
      </button>
      {progressMsg && <span style={{ fontSize: 11, color: progressMsg.startsWith('✅') ? '#10b981' : 'var(--text-muted)', marginLeft: 8 }}>{progressMsg}</span>}

      {popup && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={e => { if (e.target === e.currentTarget) setPopup(null); }}>
          <div style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 16, width: '90%', maxWidth: 760, maxHeight: '85vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontSize: 17, fontWeight: 700 }}>📺 Duplicate TV Shows Found</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>{popup.groups.length} duplicate groups — choose action for each</div>
              </div>
              <button onClick={() => setPopup(null)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 20 }}>✕</button>
            </div>
            <div style={{ overflowY: 'auto', flex: 1, padding: '12px 24px' }}>
              {popup.groups.map((g, i) => (
                <div key={i} style={{ padding: '14px 0', borderBottom: '1px solid var(--border)' }}>
                  <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>Merge into: <span style={{ color: 'var(--accent)' }}>{g.primaryName}</span></div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 10 }}>
                    {g.names.map((n, ni) => <div key={ni}>• "{n.name}" — {n.count} episodes</div>)}
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {[
                      { val: 'merge', label: '🔀 Merge', color: 'var(--accent)' },
                      { val: 'skip', label: '⏭ Skip', color: 'var(--text-muted)' },
                    ].map(opt => (
                      <button key={opt.val} onClick={() => setChoices(c => ({ ...c, [i]: opt.val }))}
                        style={{ padding: '6px 14px', borderRadius: 8, border: `2px solid ${choices[i] === opt.val ? opt.color : 'var(--border)'}`,
                          background: choices[i] === opt.val ? `${opt.color}22` : 'var(--bg-card)',
                          color: choices[i] === opt.val ? opt.color : 'var(--text-muted)', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <div style={{ padding: '16px 24px', borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{progressMsg}</div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button onClick={() => setPopup(null)} style={{ padding: '9px 20px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text-primary)', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
                <button onClick={runSelected} disabled={running || selectedCount === 0}
                  style={{ padding: '9px 20px', background: selectedCount > 0 ? 'var(--accent)' : 'var(--bg-tertiary)', border: 'none', borderRadius: 8, color: 'white', cursor: selectedCount > 0 ? 'pointer' : 'default', fontSize: 13, fontWeight: 700 }}>
                  {running ? '⏳ Processing...' : `▶ Apply (${selectedCount} merges)`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function MovieFolderCleanup() {
  const API = 'http://localhost:3001/api';
  const [status, setStatus] = React.useState(null);
  const [running, setRunning] = React.useState(false);
  const [preview, setPreview] = React.useState(null);

  const fetchPreview = async () => {
    setRunning(true); setStatus(null);
    try {
      const d = await fetch(`${API}/library/movies/cleanup-folders?preview=1`).then(r=>r.json());
      setPreview(d.items || []);
    } catch(e) { setStatus('Error: ' + e.message); }
    setRunning(false);
  };

  const runCleanup = async () => {
    setRunning(true); setStatus(null);
    try {
      const d = await fetch(`${API}/library/movies/cleanup-folders`, { method: 'POST' }).then(r=>r.json());
      setStatus(`✅ Moved ${d.moved} movies into subfolders.`);
      setPreview(null);
    } catch(e) { setStatus('Error: ' + e.message); }
    setRunning(false);
  };

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
        <button onClick={fetchPreview} disabled={running}
          style={{ padding: '8px 18px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', color: 'var(--text-primary)', cursor: 'pointer', fontSize: 13 }}>
          {running && !preview ? '🔍 Scanning...' : '🔍 Preview'}
        </button>
        {preview?.length > 0 && (
          <button onClick={runCleanup} disabled={running}
            style={{ padding: '8px 18px', background: 'var(--accent)', border: 'none', borderRadius: 'var(--radius)', color: 'white', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
            {running ? '⏳ Moving...' : `▶ Move ${preview.length} Movies`}
          </button>
        )}
      </div>
      {preview !== null && preview.length === 0 && <div style={{ fontSize: 13, color: '#10b981' }}>✅ All movies are already in subfolders.</div>}
      {preview?.length > 0 && (
        <div style={{ maxHeight: 200, overflowY: 'auto', background: 'var(--bg-secondary)', borderRadius: 8, padding: 10 }}>
          {preview.map((p, i) => <div key={i} style={{ fontSize: 12, color: 'var(--text-muted)', padding: '2px 0' }}>📁 {p}</div>)}
        </div>
      )}
      {status && <div style={{ fontSize: 13, marginTop: 10, color: status.startsWith('✅') ? '#10b981' : '#f87171' }}>{status}</div>}
    </div>
  );
}

export default function SettingsPage() {
  const { theme, changeTheme, library, scanFolders, fetchLibrary, hardwareInfo, libraryPaths, fetchLibraryPaths, API } = useApp();
  const [localPaths, setLocalPaths] = useState({ movies: [], tvShows: [], music: [], musicVideos: [] });
  const [transcodeSettings, setTranscodeSettings] = useState({ hardware: 'auto', quality: '720p' });

  const [metadataSource, setMetadataSource] = useState('auto');
  // Library behavior settings (stored in config)
  const [apiKeys, setApiKeys] = useState({ tmdb: '', omdb: '', lastfm: '', fanart: '', youtube: '' });
  const [apiSaved, setApiSaved] = useState(false);
  const [ytdlpInstalled, setYtdlpInstalled] = useState(false);
  const [ytdlpInstalling, setYtdlpInstalling] = useState(false);
  const [ytdlpProgress, setYtdlpProgress] = useState('');
  const [ytdlpFailed, setYtdlpFailed] = useState(false);

  React.useEffect(() => {
    fetch(`${API}/ytdlp/status`).then(r=>r.json())
      .then(d => { setYtdlpInstalled(d.ready); if (d.progress) setYtdlpProgress(d.progress); }).catch(()=>{});
  }, []);

  const installYtdlp = async () => {
    setYtdlpInstalling(true);
    setYtdlpFailed(false);
    setYtdlpProgress('Starting download...');
    const r = await fetch(`${API}/ytdlp/install`, { method:'POST' }).then(r=>r.json()).catch(()=>({ok:false}));
    if (r.ok && r.path) {
      setYtdlpInstalled(true); setYtdlpInstalling(false);
      setYtdlpProgress(r.already ? 'Already installed' : 'Installed successfully');
      return;
    }
    if (!r.ok) { setYtdlpFailed(true); setYtdlpInstalling(false); setYtdlpProgress('Install failed — check server log'); return; }
    // Fallback poll in case install returns before file is written
    const poll = setInterval(async () => {
      const s = await fetch(`${API}/ytdlp/status`).then(r=>r.json()).catch(()=>({}));
      if (s.progress) setYtdlpProgress(s.progress);
      if (s.ready) {
        setYtdlpInstalled(true); setYtdlpInstalling(false); clearInterval(poll);
      } else if (s.status === 'failed') {
        setYtdlpFailed(true); setYtdlpInstalling(false); clearInterval(poll);
      }
    }, 2000);
    setTimeout(() => { clearInterval(poll); if (!ytdlpInstalled) { setYtdlpInstalling(false); setYtdlpFailed(true); setYtdlpProgress('Timed out — try again'); } }, 120000);
  };
  const [metadataSrc, setMetadataSrc] = useState('auto');

  const saveApiKeys = async () => {
    await fetch(`${API}/settings`, { method:'PUT', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ tmdbApiKey: apiKeys.tmdb, omdbApiKey: apiKeys.omdb, lastfmKey: apiKeys.lastfm, fanartKey: apiKeys.fanart, youtubeApiKey: apiKeys.youtube, metadataSource: metadataSrc }) });
    setApiSaved(true); setTimeout(() => setApiSaved(false), 2000);
  };

  const [extrasSettings, setExtrasSettings] = useState({
    cinemaTrailersFrom: 'unwatched',
    includeLibraryTrailers: true,
    includeTheatersTrailers: false,
    includeBlurayTrailers: false,
    alwaysIncludeEnglishTrailers: true,
    preRollVideo: '',
    musicVideosPath: '',
  });

  const saveExtrasSettings = async (updates) => {
    const updated = { ...extrasSettings, ...updates };
    setExtrasSettings(updated);
    await fetch(`${API}/settings`, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ extrasSettings: updated }) });
  };

  const [libSettings, setLibSettings] = useState({
    scanOnStartup: false,
    emptyTrashAfterScan: false,
    watchedThreshold: 90,
    continueWatchingWeeks: 16,
    continueWatchingMax: 40,
    includeSeasonPremieres: true,
    generateScreenshots: true,
    generateChapterThumbs: false,
    showRecentlyReleasedMovies: true,
    showRecentlyReleasedTV: true,
    showRecommendations: true,
    showContinueWatching: true,
    showRecentMovies: true,
    autoGenerateThumbnails: true,
    showTVSeries: true,
    showCollections: true,
    showMusic: true,
    showMusicVideos: true,
    recentlyReleasedDays: 90,
  });
  const [fullBackground, setFullBackground] = useState(() => localStorage.getItem('orion_full_background') === 'true');
  const [themeSong, setThemeSong] = useState(() => localStorage.getItem('orion_theme_song') !== 'false');
  const [libSettingsDirty, setLibSettingsDirty] = useState(false);
  const [libSettingsSaved, setLibSettingsSaved] = useState(false);
  const [libSettingsError, setLibSettingsError] = useState(false);
  const [pathMappings, setPathMappings] = useState([]); // [{unc, local}]
  const [activeTab, setActiveTab] = useState('library');
  const [metaStatus, setMetaStatus] = useState(null);
  const [debugEnabled, setDebugEnabled] = useState(false);
  const [probeStatus, setProbeStatus] = useState(null);
  const [probing, setProbing] = useState(false);
  const [posterCaching, setPosterCaching] = useState(false);
  const [posterCacheStatus, setPosterCacheStatus] = useState(null);

  const startProbe = async () => {
    if (!window.confirm('Scan all media files with FFprobe to detect resolution, HDR, and audio codec?\n\nThis runs in the background and may take a while for large libraries.')) return;
    setProbing(true);
    try {
      const r = await fetch(`${API}/library/probe/start`, { method: 'POST' });
      const d = await r.json();
      setProbeStatus(d);
      // Poll for progress
      const poll = setInterval(async () => {
        try {
          const s = await fetch(`${API}/library/probe/status`).then(r => r.json());
          setProbeStatus(s);
          if (!s.running) { clearInterval(poll); setProbing(false); }
        } catch { clearInterval(poll); setProbing(false); }
      }, 2000);
    } catch (e) { setProbing(false); alert('Failed to start probe: ' + e.message); }
  };

  const updateLibSettings = (updates) => {
    const next = { ...libSettings, ...updates };
    setLibSettings(next);
    setLibSettingsDirty(true);
    setLibSettingsSaved(false);
    // Mirror thumbnail toggle to localStorage so MediaCard can read it without an API call
    if ('autoGenerateThumbnails' in updates) {
      localStorage.setItem('orion_auto_thumbnails', updates.autoGenerateThumbnails ? 'true' : 'false');
    }
    fetch(`${API}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ libSettings: next }),
    }).then(() => {
      setLibSettingsDirty(false);
      setLibSettingsSaved(true);
      setTimeout(() => setLibSettingsSaved(false), 2000);
    }).catch(() => setLibSettingsError(true));
  };

  const saveLibSettings = async () => {
    setLibSettingsError(false);
    try {
      await fetch(`${API}/settings`, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ libSettings }) });
      localStorage.setItem('orion_full_background', fullBackground ? 'true' : 'false');
      localStorage.setItem('orion_theme_song', themeSong ? 'true' : 'false');
      setLibSettingsDirty(false);
      setLibSettingsSaved(true);
      setTimeout(() => setLibSettingsSaved(false), 3000);
    } catch {
      setLibSettingsError(true);
      setTimeout(() => setLibSettingsError(false), 4000);
    }
  };

  const startPosterCache = async () => {
    setPosterCaching(true);
    try {
      const r = await fetch(`${API}/postercache/start`, { method: 'POST' });
      const d = await r.json();
      setPosterCacheStatus(d);
      const poll = setInterval(async () => {
        try {
          const s = await fetch(`${API}/postercache/status`).then(r => r.json());
          setPosterCacheStatus(s);
          if (!s.running) { clearInterval(poll); setPosterCaching(false); }
        } catch { clearInterval(poll); setPosterCaching(false); }
      }, 2000);
    } catch (e) { setPosterCaching(false); alert('Failed: ' + e.message); }
  };
  const [debugLog, setDebugLog] = useState([]);
  const [debugLines, setDebugLines] = useState(0);

const TAB_GROUPS = [
  {
    label: 'Library',
    tabs: [
      { id: 'library',     icon: BookOpen,  label: 'Library Sources' },
      { id: 'custom',      icon: Plus,      label: 'Custom Libraries' },
      { id: 'libsettings', icon: HardDrive, label: 'Library Settings' },
      { id: 'autocollect', icon: Wand2,     label: 'Auto Collections' },
    ]
  },
  {
    label: 'Metadata',
    tabs: [
      { id: 'metadata',    icon: Key,       label: 'Metadata Source' },
      { id: 'apis',        icon: GitBranch, label: 'API Keys' },
    ]
  },
  {
    label: 'Playback',
    tabs: [
      { id: 'transcoding', icon: Cpu,       label: 'Transcoding' },
      { id: 'extras',      icon: Film,      label: 'Extras & Pre-Roll' },
    ]
  },
  {
    label: 'Appearance',
    tabs: [
      { id: 'themes',      icon: Palette,   label: 'Themes' },
      { id: 'homelayout',  icon: LayoutDashboard, label: 'Home Layout' },
    ]
  },
  {
    label: 'System',
    tabs: [
      { id: 'scheduler',   icon: Clock,     label: 'Scheduler' },
      { id: 'users',       icon: Users,     label: 'Users' },
      { id: 'ai',          icon: Bot,       label: 'Local AI' },
      { id: 'activity',    icon: BarChart2, label: 'Activity' },
      { id: 'debug',       icon: Bug,       label: 'Debug' },
      { id: 'about',       icon: Info,      label: 'About' },
    ]
  },
];

  // Load saved paths and settings on mount
  useEffect(() => {
    setLocalPaths(libraryPaths);
  }, [libraryPaths]);

  useEffect(() => {
    fetch(`${API}/settings`).then(r => r.json()).then(d => {
      if (d.metadataSource) setMetadataSource(d.metadataSource);
      if (d.libSettings) {
        setLibSettings(prev => ({ ...prev, ...d.libSettings }));
        if ('autoGenerateThumbnails' in d.libSettings) {
          localStorage.setItem('orion_auto_thumbnails', d.libSettings.autoGenerateThumbnails !== false ? 'true' : 'false');
        }
      }
      if (d.extrasSettings) setExtrasSettings(prev => ({ ...prev, ...d.extrasSettings }));
      if (d.tmdbApiKey) setApiKeys(k => ({ ...k, tmdb: d.tmdbApiKey }));
      if (d.omdbApiKey) setApiKeys(k => ({ ...k, omdb: d.omdbApiKey }));
      if (d.lastfmKey) setApiKeys(k => ({ ...k, lastfm: d.lastfmKey }));
      if (d.fanartKey) setApiKeys(k => ({ ...k, fanart: d.fanartKey }));
      if (d.youtubeApiKey) setApiKeys(k => ({ ...k, youtube: d.youtubeApiKey }));
      if (d.metadataSource) setMetadataSrc(d.metadataSource);
      if (d.pathMappings) setPathMappings(d.pathMappings);
    }).catch(() => {});
  }, [API]);

  // Fetch debug status on mount
  useEffect(() => {
    fetch(`${API}/debug`).then(r => r.json()).then(d => {
      setDebugEnabled(d.enabled);
      setDebugLines(d.lines);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    fetch(`${API}/settings`).then(r => r.json()).then(data => {
      if (data.transcoding) setTranscodeSettings(data.transcoding);
    }).catch(() => {});
    fetch(`${API}/metadata/status`).then(r => r.json()).then(setMetaStatus).catch(() => {});
  }, [API]);

  const [browserOpen, setBrowserOpen] = useState(false);
  const [browserPath, setBrowserPath] = useState('/');
  const [browserDirs, setBrowserDirs] = useState([]);
  const [browserType, setBrowserType] = useState(null);
  const [browserLoading, setBrowserLoading] = useState(false);

  const openBrowser = async (type) => {
    // In Electron — use native folder picker
    if (window.electron) {
      const result = await window.electron.openFolderDialog();
      if (!result?.canceled && result?.filePaths?.length) {
        await scanFolders(result.filePaths, type);
      }
      return;
    }
    // In browser — use server-side directory browser
    setBrowserType(type);
    setBrowserOpen(true);
    await browseTo('/');
  };

  const browseTo = async (path) => {
    setBrowserLoading(true);
    try {
      const r = await fetch(`${API}/browse?path=${encodeURIComponent(path)}`);
      const d = await r.json();
      setBrowserPath(d.path);
      setBrowserDirs(d.dirs || []);
    } catch(e) {}
    setBrowserLoading(false);
  };

  const handleAddFolder = async (type) => {
    openBrowser(type);
  };

  const handleBrowserSelect = async () => {
    await scanFolders([browserPath], browserType);
    setBrowserOpen(false);
  };

  const handleRemovePath = async (type, idx) => {
    const folderPath = localPaths[type][idx];
    if (!window.confirm(`Remove "${folderPath}" and delete all its media from the library?`)) return;
    try {
      await fetch(`${API}/library/${type}/folder`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderPath })
      });
      setLocalPaths(prev => ({ ...prev, [type]: prev[type].filter((_, i) => i !== idx) }));
      await fetchLibrary(type);
    } catch(e) {
      alert('Failed to remove library: ' + e.message);
    }
  };

  const handleRescan = async (type) => {
    if (localPaths[type]?.length) await scanFolders(localPaths[type], type);
  };

  const LIBRARY_TYPES = [
    { id: 'movies',      label: 'Movies',       icon: '🎬', count: library.movies?.length      || 0 },
    { id: 'tvShows',     label: 'TV Shows',      icon: '📺', count: library.tvShows?.length     || 0 },
    { id: 'music',       label: 'Music',         icon: '🎵', count: library.music?.length       || 0 },
    { id: 'musicVideos', label: 'Music Videos',  icon: '🎞', count: library.musicVideos?.length || 0 },
  ];

  return (
    <div className="page">
      {/* Directory Browser Modal */}
      {browserOpen && (
        <div style={{ position:'fixed',inset:0,zIndex:9999,background:'rgba(0,0,0,0.7)',display:'flex',alignItems:'center',justifyContent:'center' }}>
          <div style={{ background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:16,width:560,maxHeight:'80vh',display:'flex',flexDirection:'column',overflow:'hidden' }}>
            <div style={{ padding:'16px 20px',borderBottom:'1px solid var(--border)',display:'flex',alignItems:'center',justifyContent:'space-between' }}>
              <span style={{ fontWeight:700,fontSize:15 }}>📁 Select Folder</span>
              <button onClick={()=>setBrowserOpen(false)} style={{ background:'none',border:'none',color:'var(--text-muted)',cursor:'pointer',fontSize:20 }}>×</button>
            </div>
            {/* Current path */}
            <div style={{ padding:'10px 20px',background:'var(--bg-secondary)',borderBottom:'1px solid var(--border)',fontSize:12,color:'var(--text-muted)',fontFamily:'monospace',wordBreak:'break-all' }}>
              {browserPath}
            </div>
            {/* Dir listing */}
            <div style={{ flex:1,overflowY:'auto',padding:'8px 0' }}>
              {browserLoading
                ? <div style={{ padding:24,textAlign:'center',color:'var(--text-muted)' }}>Loading…</div>
                : <>
                  {browserPath !== '/' && (
                    <div onClick={()=>browseTo(browserPath.split('/').slice(0,-1).join('/')||'/')}
                      style={{ padding:'10px 20px',cursor:'pointer',display:'flex',alignItems:'center',gap:10,fontSize:13 }}
                      onMouseEnter={e=>e.currentTarget.style.background='rgba(255,255,255,0.05)'}
                      onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
                      <span>📁</span><span style={{ color:'var(--accent)' }}>.. (up)</span>
                    </div>
                  )}
                  {browserDirs.map(d => (
                    <div key={d.path} onClick={()=>browseTo(d.path)}
                      style={{ padding:'10px 20px',cursor:'pointer',display:'flex',alignItems:'center',gap:10,fontSize:13 }}
                      onMouseEnter={e=>e.currentTarget.style.background='rgba(255,255,255,0.05)'}
                      onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
                      <span>📁</span><span>{d.name}</span>
                    </div>
                  ))}
                  {browserDirs.length===0&&<div style={{ padding:24,textAlign:'center',color:'var(--text-muted)',fontSize:13 }}>No subdirectories</div>}
                </>
              }
            </div>
            {/* Actions */}
            <div style={{ padding:'14px 20px',borderTop:'1px solid var(--border)',display:'flex',gap:10,alignItems:'center' }}>
              <div style={{ flex:1,fontSize:12,color:'var(--text-muted)' }}>Selected: <span style={{ color:'var(--text-primary)',fontFamily:'monospace' }}>{browserPath}</span></div>
              <button onClick={()=>setBrowserOpen(false)} style={{ padding:'8px 16px',background:'var(--bg-tertiary)',border:'1px solid var(--border)',borderRadius:'var(--radius)',cursor:'pointer',fontSize:13 }}>Cancel</button>
              <button onClick={handleBrowserSelect} style={{ padding:'8px 16px',background:'var(--accent)',color:'white',border:'none',borderRadius:'var(--radius)',cursor:'pointer',fontSize:13,fontWeight:700 }}>Select This Folder</button>
            </div>
          </div>
        </div>
      )}

      <div className="page-header">
        <div className="page-title">⚙️ Settings</div>
        <div className="page-subtitle">Configure your Orion media server</div>
      </div>

      <div style={{ display:'flex', gap:0, minHeight:'70vh', padding:'0 48px 48px' }}>

        {/* Left nav — accordion groups */}
        <div style={{ width:210, flexShrink:0, borderRight:'1px solid var(--border)', marginRight:32, paddingTop:4 }}>
          {TAB_GROUPS.map(group => (
            <NavGroup key={group.label} group={group} activeTab={activeTab} setActiveTab={setActiveTab} />
          ))}
        </div>

        {/* Tab content */}
        <div style={{ flex:1, minWidth:0 }}>

        {activeTab === 'library' && (
          <>
            {/* Metadata status bar */}
            {metaStatus && (metaStatus.movies.total > 0 || metaStatus.tvShows.total > 0) && (
              <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '14px 18px', marginBottom: 24, display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>📊 Metadata Progress</div>
                {['movies', 'tvShows'].map(type => metaStatus[type]?.total > 0 && (
                  <div key={type} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{type === 'movies' ? 'Movies' : 'TV Shows'}:</span>
                    <div style={{ width: 100, height: 6, background: 'var(--bg-tertiary)', borderRadius: 3 }}>
                      <div style={{ width: `${Math.round((metaStatus[type].fetched / metaStatus[type].total) * 100)}%`, height: '100%', background: 'var(--accent)', borderRadius: 3, transition: 'width 1s' }} />
                    </div>
                    <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{metaStatus[type].fetched}/{metaStatus[type].total}</span>
                  </div>
                ))}
                {metaStatus.running && <span style={{ fontSize: 12, color: 'var(--tag-color)' }}>⚡ Fetching metadata...</span>}
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                <button className="btn btn-secondary btn-sm" onClick={async () => {
                  if (!window.confirm('Re-fetch all metadata? This will clear existing posters and re-download everything.')) return;
                  await fetch(`${API}/library/metadata/reset-all`, { method: 'POST' });
                  setTimeout(() => fetch(`${API}/metadata/status`).then(r => r.json()).then(setMetaStatus).catch(() => {}), 1000);
                }}>
                  <RefreshCw size={13} /> Refresh All Metadata
                </button>
                <button className="btn btn-secondary btn-sm" onClick={startProbe} disabled={probing} title="Scan files with FFprobe to detect 4K/1080p/HDR/audio codec">
                  {probing ? `⏳ Probing… ${probeStatus?.done||0}/${probeStatus?.total||'?'}` : '🔬 Probe Media'}
                </button>
                <button className="btn btn-secondary btn-sm" onClick={startPosterCache} disabled={posterCaching} title="Copy all NAS/network posters to local cache for faster loading">
                  {posterCaching ? `🖼 Caching… ${posterCacheStatus?.done||0}/${posterCacheStatus?.total||'?'}` : '🖼 Cache Posters'}
                </button>
                <button className="btn btn-secondary btn-sm" onClick={async () => {
                  if (!window.confirm('Remove featurettes, trailers and extras from the movie library?')) return;
                  const r = await fetch(`${API}/library/cleanup-extras`, { method: 'POST' }).then(r => r.json());
                  alert(`Removed ${r.removed} extras. Run Auto Collections to rebuild.`);
                }} title="Remove trailers/featurettes/extras from movie library">
                  🧹 Remove Extras
                </button>
              </div>
            </div>
            )}

            {/* Metadata Source */}
            <div className="settings-row" style={{ marginTop: 8, marginBottom: 8 }}>
              <div>
                <div className="settings-label">Metadata Source</div>
                <div className="settings-desc">Where to fetch posters, ratings and overviews</div>
              </div>
              <select className="select-input" value={metadataSrc} onChange={async e => {
                setMetadataSource(e.target.value);
                setMetadataSrc(e.target.value);
                await fetch(`${API}/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ metadataSource: e.target.value }) });
              }}>
                <option value="auto">Auto — TVMaze → OMDb → TMDB</option>
                <option value="tmdb">TMDB only (API key required)</option>
                <option value="omdb">OMDb only</option>
                <option value="tvmaze">TVMaze only (TV, free)</option>
              </select>
            </div>

            {LIBRARY_TYPES.map(({ id, label, icon, count }) => (
              <div key={id} style={{ marginBottom: 28 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 20 }}>{icon}</span>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 15 }}>{label}</div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{count.toLocaleString()} items</div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    {id === 'movies' && <MovieSmartDedup />}
                    {id === 'tvShows' && <TVShowSmartDedup />}
                    <button className="btn btn-secondary btn-sm" onClick={async () => {
                      await fetch(`${API}/library/${id}/metadata/reset`, { method: 'POST' });
                      setTimeout(() => fetch(`${API}/metadata/status`).then(r => r.json()).then(setMetaStatus).catch(() => {}), 500);
                    }}><RefreshCw size={13} /> Refresh Metadata</button>
                    <button className="btn btn-secondary btn-sm" onClick={() => handleRescan(id)}><RefreshCw size={13} /> Rescan Files</button>
                    <button className="btn btn-primary btn-sm" onClick={() => handleAddFolder(id)}><FolderOpen size={13} /> Add Folder</button>
                  </div>
                </div>
                <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', overflow: 'hidden' }}>
                  {(localPaths[id] || []).length === 0 ? (
                    <div style={{ padding: '16px 20px', color: 'var(--text-muted)', fontSize: 13 }}>No folders added yet.</div>
                  ) : (
                    (localPaths[id] || []).map((p, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: i < localPaths[id].length - 1 ? '1px solid var(--border)' : 'none' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <FolderOpen size={15} color="var(--accent)" />
                          <span style={{ fontSize: 13, fontFamily: 'monospace', color: 'var(--text-secondary)' }}>{p}</span>
                        </div>
                        <button onClick={() => handleRemovePath(id, i)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 4 }}>
                          <Trash2 size={14} />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            ))}

          {/* NAS Shares — only show on web (Linux server) */}
          {!window.electron && (
          <div style={{ marginTop:24, padding:20, background:'var(--bg-card)', border:'1px solid var(--border)', borderRadius:'var(--radius-lg)' }}>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:12 }}>
              <div>
                <div style={{ fontWeight:700, fontSize:14 }}>🗄 NAS Shares</div>
                <div style={{ fontSize:12, color:'var(--text-muted)', marginTop:2 }}>Manage CIFS/Samba mounts for your NAS</div>
              </div>
              <button className="btn btn-primary btn-sm" onClick={() => {
                const src = window.prompt('NAS share path (e.g. //192.168.0.245/media):');
                if (!src) return;
                const mp = window.prompt('Mount point (e.g. /mnt/media):');
                if (!mp) return;
                const user = window.prompt('NAS username [default: guest]:') || 'guest';
                const pass = window.prompt('NAS password [leave blank for none]:') || '';
                fetch(`${API}/nas/shares`, { method:'POST', headers:{'Content-Type':'application/json'},
                  body: JSON.stringify({ source: src, mountPoint: mp, user, password: pass }) })
                  .then(r => r.json()).then(d => {
                    if (d.ok) { alert('Share added and mounted!'); window.location.reload(); }
                    else alert('Error: ' + d.error);
                  });
              }}>+ Add Share</button>
            </div>
            <NASSharesList API={API} />
          </div>
          )}

          <div style={{ marginTop:24, padding:20, background:'var(--bg-card)', border:'1px solid var(--border)', borderRadius:'var(--radius-lg)' }}>
            <div style={{ fontWeight:700, fontSize:14, marginBottom:6 }}>📁 StreamForge Data Directory</div>
            <div style={{ fontSize:12, color:'var(--text-muted)', marginBottom:12 }}>
              Where StreamForge stores its channels, EPG, streams, and schedules. Defaults to AppData if left blank.
              Use a UNC path to store on your NAS (e.g. <code style={{ background:'rgba(255,255,255,0.06)', padding:'1px 6px', borderRadius:4 }}>\\192.168.0.245\config\streamforge</code>).
              Restart Orion after changing.
            </div>
            <div style={{ display:'flex', gap:8 }}>
              <input id="sfDataDirInput" placeholder="Leave blank for default (AppData\Orion\sf)"
                defaultValue=""
                style={{ flex:1, padding:'8px 12px', background:'var(--bg-tertiary)', border:'1px solid var(--border)', borderRadius:'var(--radius)', color:'var(--text-primary)', fontSize:12, fontFamily:'monospace' }}
                onFocus={async e => {
                  if (!e.target.value) {
                    const cfg = await fetch(`${API}/config`).then(r=>r.json()).catch(()=>({}));
                    e.target.value = cfg.sfDataDir || '';
                  }
                }}/>
              <button onClick={async () => {
                const val = document.getElementById('sfDataDirInput').value.trim();
                await fetch(`${API}/config`, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ sfDataDir: val }) });
                alert('Saved! Restart Orion to apply.');
              }} style={{ padding:'8px 16px', background:'var(--accent)', border:'none', borderRadius:'var(--radius)', color:'white', cursor:'pointer', fontSize:12, fontWeight:600 }}>
                Save
              </button>
            </div>
          </div>

          {window.electron && <div style={{ marginTop:24, padding:20, background:'var(--bg-card)', border:'1px solid var(--border)', borderRadius:'var(--radius-lg)' }}>
            <div style={{ fontWeight:700, fontSize:14, marginBottom:6 }}>🗺 Network Path Mappings</div>
            <div style={{ fontSize:12, color:'var(--text-muted)', marginBottom:12 }}>
              Map UNC paths to drive letters so FFprobe can scan NAS media.
              First map the drive in Windows Explorer (right-click This PC → Map Network Drive).
            </div>
            {pathMappings.map((m, i) => (
              <div key={i} style={{ display:'flex', gap:8, marginBottom:8, alignItems:'center' }}>
                <input style={{ flex:1, padding:'7px 10px', background:'var(--bg-tertiary)', border:'1px solid var(--border)', borderRadius:'var(--radius)', color:'var(--text-primary)', fontSize:12 }}
                  value={m.unc} onChange={e => { const n=[...pathMappings]; n[i]={...n[i],unc:e.target.value}; setPathMappings(n); }}
                  placeholder="\\192.168.0.245\media" />
                <span style={{ color:'var(--text-muted)' }}>to</span>
                <input style={{ flex:1, padding:'7px 10px', background:'var(--bg-tertiary)', border:'1px solid var(--border)', borderRadius:'var(--radius)', color:'var(--text-primary)', fontSize:12 }}
                  value={m.local} onChange={e => { const n=[...pathMappings]; n[i]={...n[i],local:e.target.value}; setPathMappings(n); }}
                  placeholder="Z:" />
                <button onClick={() => setPathMappings(pathMappings.filter((_,j)=>j!==i))}
                  style={{ padding:'6px 10px', background:'rgba(239,68,68,0.1)', border:'1px solid rgba(239,68,68,0.2)', borderRadius:'var(--radius)', color:'#ef4444', cursor:'pointer' }}>X</button>
              </div>
            ))}
            <div style={{ display:'flex', gap:8, marginTop:10 }}>
              <button onClick={() => setPathMappings([...pathMappings, {unc:'', local:''}])}
                style={{ padding:'7px 14px', background:'var(--bg-tertiary)', border:'1px solid var(--border)', borderRadius:'var(--radius)', color:'var(--text-secondary)', cursor:'pointer', fontSize:12 }}>
                + Add Mapping
              </button>
              <button onClick={async () => {
                await fetch(`${API}/settings`, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ pathMappings }) });
                alert('Saved! Now run Probe Media.');
              }} style={{ padding:'7px 14px', background:'var(--accent)', border:'none', borderRadius:'var(--radius)', color:'white', cursor:'pointer', fontSize:12, fontWeight:600 }}>
                Save Mappings
              </button>
            </div>
          </div>}
          </>
        )}

        {activeTab === 'metadata' && (
          <div>
            <div style={{ marginBottom: 28 }}>
              <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Metadata</h3>
              <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Configure where Orion fetches posters, ratings, descriptions and other media information.</p>
            </div>

            {/* Metadata Source */}
            <div style={{ marginBottom: 28 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 14 }}>Metadata Source</div>
              <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 14 }}>Choose where Orion fetches movie and TV info. Free sources work without any API key.</div>
              {[
                { value: 'auto',   label: '⚡ Auto (Recommended)', desc: 'Tries free sources first, falls back to TMDB if you have a key', badge: 'FREE', color: '#10b981' },
                { value: 'tvmaze', label: '📺 TVmaze + OMDb',      desc: 'TVmaze for TV, OMDb for movies — both completely free, no signup', badge: 'FREE', color: '#10b981' },
                { value: 'omdb',   label: '🎬 OMDb',               desc: 'Movies & TV, 1000 req/day free. API key removes the limit', badge: 'FREE', color: '#10b981' },
                { value: 'tmdb',   label: '🎥 TMDB',               desc: 'Best quality metadata and images. Requires a free API key', badge: 'KEY NEEDED', color: '#f59e0b' },
              ].map(opt => (
                <div key={opt.value} onClick={async () => {
                    setMetadataSrc(opt.value);
                    await fetch(`${API}/settings`, { method:'PUT', headers:{'Content-Type':'application/json'},
                      body: JSON.stringify({ metadataSource: opt.value }) }).catch(() => {});
                  }}
                  style={{ display:'flex', alignItems:'center', gap:14, padding:'12px 16px', borderRadius:'var(--radius-lg)', cursor:'pointer', marginBottom:8,
                    border:`2px solid ${metadataSrc === opt.value ? 'var(--accent)' : 'var(--border)'}`,
                    background: metadataSrc === opt.value ? 'var(--tag-bg)' : 'var(--bg-card)', transition:'all 0.15s' }}>
                  <div style={{ flex:1 }}>
                    <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:3 }}>
                      <span style={{ fontWeight:700, fontSize:14 }}>{opt.label}</span>
                      <span style={{ fontSize:10, fontWeight:700, padding:'2px 7px', borderRadius:10, background:opt.color+'22', color:opt.color, border:`1px solid ${opt.color}44` }}>{opt.badge}</span>
                    </div>
                    <div style={{ fontSize:12, color:'var(--text-muted)' }}>{opt.desc}</div>
                  </div>
                  <div style={{ width:20, height:20, borderRadius:'50%', border:`2px solid ${metadataSrc === opt.value ? 'var(--accent)' : 'var(--border)'}`,
                    background: metadataSrc === opt.value ? 'var(--accent)' : 'transparent', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                    {metadataSrc === opt.value && <div style={{ width:8, height:8, borderRadius:'50%', background:'white' }}/>}
                  </div>
                </div>
              ))}
            </div>

            <div style={{ marginTop:8, padding:'12px 16px', background:'rgba(99,102,241,0.08)', border:'1px solid rgba(99,102,241,0.2)', borderRadius:'var(--radius)' }}>
              <span style={{ fontSize:13, color:'var(--text-secondary)' }}>
                🔑 API keys are managed in the <strong>API Keys</strong> tab.
              </span>
            </div>
          </div>
        )}

        {activeTab === 'apis' && (
          <div>
            <div style={{ marginBottom: 28 }}>
              <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>API Keys</h3>
              <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                Third-party service keys that enhance Orion. All are optional except where noted. Orion works fully without any keys using free built-in sources.
              </p>
            </div>

            {[
              {
                key: 'tmdb', label: 'TMDB', sublabel: 'The Movie Database',
                what: 'Movie & TV metadata',
                why: 'Best quality posters, backdrops, cast photos, ratings and descriptions for movies and TV shows. Required if you select TMDB as your metadata source.',
                limit: 'Free — ~40 requests/sec with a free API key',
                link: 'https://www.themoviedb.org/settings/api',
                required: false,
              },
              {
                key: 'omdb', label: 'OMDb', sublabel: 'Open Movie Database',
                what: 'Movie & TV metadata (fallback)',
                why: 'Alternative metadata source for movies and TV. Works without a key at 1,000 requests/day. A free key removes that limit.',
                limit: 'Free — 1,000/day without key, unlimited with free key',
                link: 'https://www.omdbapi.com/apikey.aspx',
                required: false,
              },
              {
                key: 'youtube', label: 'YouTube Data API v3', sublabel: 'Google',
                what: 'Trailer fallback',
                why: 'Used as a fallback when TMDB has no trailer or the video is unavailable. Searches YouTube for the correct trailer by show name, with title validation to avoid wrong results.',
                limit: 'Free — 10,000 requests/day. Create a project at Google Cloud Console → Enable YouTube Data API v3 → Credentials → Create API Key.',
                link: 'https://console.cloud.google.com/apis/library/youtube.googleapis.com',
                required: false,
              },
              {
                key: 'lastfm', label: 'Last.fm', sublabel: 'Last.fm API',
                what: 'Music metadata',
                why: 'Album art, artist bios, track info and scrobbling for your music library.',
                limit: 'Free with a free API key',
                link: 'https://www.last.fm/api/account/create',
                required: false,
              },
              {
                key: 'fanart', label: 'Fanart.tv', sublabel: 'Fanart.tv API',
                what: 'High quality artwork',
                why: 'Extra high-res posters, backgrounds, logo images and disc art for movies and TV shows.',
                limit: 'Free with a free API key',
                link: 'https://fanart.tv/get-an-api-key/',
                required: false,
              },
            ].map(({ key, label, sublabel, what, why, limit, link, setup, required }) => (
              <div key={key} style={{ background:'var(--bg-card)', border:'1px solid var(--border)', borderRadius:'var(--radius-lg)', padding:'18px 20px', marginBottom:16 }}>
                <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', marginBottom:10 }}>
                  <div style={{ flex:1 }}>
                    <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:3 }}>
                      <span style={{ fontWeight:800, fontSize:15 }}>{label}</span>
                      <span style={{ fontSize:11, color:'var(--text-muted)' }}>{sublabel}</span>
                      <span style={{ fontSize:10, fontWeight:700, padding:'2px 8px', borderRadius:10,
                        background:'rgba(16,185,129,0.15)', color:'#10b981', border:'1px solid rgba(16,185,129,0.3)' }}>
                        {what}
                      </span>
                    </div>
                    <p style={{ fontSize:13, color:'var(--text-secondary)', lineHeight:1.6, margin:'4px 0 6px' }}>{why}</p>
                    <p style={{ fontSize:11, color:'var(--text-muted)', margin:0 }}>📊 {limit}</p>
                    {setup && <p style={{ fontSize:11, color:'var(--text-muted)', marginTop:4 }}>⚙️ {setup}</p>}
                  </div>
                  <a href={link} target="_blank" rel="noreferrer"
                    style={{ fontSize:12, color:'var(--accent)', textDecoration:'none', flexShrink:0, marginLeft:16,
                      padding:'6px 14px', border:'1px solid var(--border-accent)', borderRadius:'var(--radius)', whiteSpace:'nowrap' }}>
                    Get Key →
                  </a>
                </div>
                <div style={{ display:'flex', gap:8, alignItems:'center' }}>
                  <input type="password" value={apiKeys[key]||''}
                    onChange={e => setApiKeys(k => ({ ...k, [key]: e.target.value }))}
                    onFocus={e => e.target.type='text'}
                    onBlur={e => e.target.type='password'}
                    placeholder={`Paste your ${label} API key here`}
                    style={{ flex:1, padding:'9px 12px', background:'var(--bg-tertiary)', border:'1px solid var(--border)',
                      borderRadius:'var(--radius)', color:'var(--text-primary)', fontSize:13, outline:'none', fontFamily:'monospace' }}/>
                  {apiKeys[key] && <span style={{ fontSize:13, color:'#10b981', flexShrink:0 }}>✓ Set</span>}
                </div>
              </div>
            ))}

            <button className="btn btn-primary" style={{ marginTop:8 }} onClick={saveApiKeys}>
              {apiSaved ? '✅ Saved!' : '💾 Save All Keys'}
            </button>
          </div>
        )}

        {activeTab === 'custom' && (
          <CustomLibrariesSettings API={API} />
        )}

        {activeTab === 'libsettings' && (
          <div>
            <div style={{ marginBottom: 28 }}>
              <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Library Settings</h3>
              <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Control how Orion scans, watches and manages your media library.</p>
            </div>

            {/* Scanning */}
            <div style={{ marginBottom: 28 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 14 }}>Scanning</div>

              {[
                { key: 'scanOnStartup', label: 'Scan library on startup', desc: 'Automatically scan for new or removed media when Orion starts.' },
                { key: 'emptyTrashAfterScan', label: 'Empty trash after every scan', desc: 'Remove items from the library that are no longer found on disk.' },
              ].map(({ key, label, desc }) => (
                <div key={key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 0', borderBottom: '1px solid var(--border)' }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>{label}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>{desc}</div>
                  </div>
                  <button onClick={() => updateLibSettings({ [key]: !libSettings[key] })}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: libSettings[key] ? 'var(--accent)' : 'var(--text-muted)', flexShrink: 0, marginLeft: 24 }}>
                    {libSettings[key] ? <ToggleRight size={28} /> : <ToggleLeft size={28} />}
                  </button>
                </div>
              ))}
            </div>

            {/* Playback */}
            <div style={{ marginBottom: 28 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 14 }}>Playback</div>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 0', borderBottom: '1px solid var(--border)' }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>Video played threshold</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>Percentage of a video that must be watched to mark it as played.</div>
                </div>
                <select value={libSettings.watchedThreshold}
                  onChange={e => updateLibSettings({ watchedThreshold: parseInt(e.target.value) })}
                  style={{ padding: '7px 12px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', color: 'var(--text-primary)', fontSize: 13 }}>
                  {[50,75,80,85,90,95,100].map(v => <option key={v} value={v}>{v}%</option>)}
                </select>
              </div>
            </div>

            {/* Continue Watching */}
            <div style={{ marginBottom: 28 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 14 }}>Continue Watching</div>

              {[
                { key: 'includeSeasonPremieres', label: 'Include season premieres', desc: 'New season premieres always appear regardless of how long ago you watched.' },
              ].map(({ key, label, desc }) => (
                <div key={key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 0', borderBottom: '1px solid var(--border)' }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>{label}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>{desc}</div>
                  </div>
                  <button onClick={() => updateLibSettings({ [key]: !libSettings[key] })}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: libSettings[key] ? 'var(--accent)' : 'var(--text-muted)', flexShrink: 0, marginLeft: 24 }}>
                    {libSettings[key] ? <ToggleRight size={28} /> : <ToggleLeft size={28} />}
                  </button>
                </div>
              ))}

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 0', borderBottom: '1px solid var(--border)' }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>Weeks to consider for Continue Watching</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>Media unwatched beyond this many weeks won't appear in Continue Watching.</div>
                </div>
                <select value={libSettings.continueWatchingWeeks}
                  onChange={e => updateLibSettings({ continueWatchingWeeks: parseInt(e.target.value) })}
                  style={{ padding: '7px 12px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', color: 'var(--text-primary)', fontSize: 13 }}>
                  {[4,8,12,16,24,52].map(v => <option key={v} value={v}>{v} weeks</option>)}
                </select>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 0', borderBottom: '1px solid var(--border)' }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>Maximum Continue Watching items</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>Limits how many items appear in Continue Watching. Setting too high can affect performance.</div>              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>Limits how many items appear in Continue Watching. Setting too high can affect performance.</div>

              <div style={{ marginTop: 28, paddingTop: 20, borderTop: '1px solid var(--border)' }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 14 }}>Home Page Sections</div>

                {[
                  { key: 'showContinueWatching',       label: '⏯ Continue Watching',        desc: 'Show in-progress movies and TV episodes' },
                  { key: 'showRecentMovies',            label: '🎬 Recent Movies',            desc: 'Show recently added movies from your library' },
                  { key: 'showTVSeries',                label: '📺 TV Series',                desc: 'Show your TV show collection' },
                  { key: 'showCollections',             label: '📚 Collections',              desc: 'Show movie franchise collections' },
                  { key: 'showMusic',                   label: '🎵 Music',                   desc: 'Show recently added music' },
                  { key: 'showMusicVideos',             label: '🎞 Music Videos',             desc: 'Show recently added music videos' },
                  { key: 'showRecentlyReleasedMovies',  label: '🆕 Recently Released Movies', desc: 'Show movies released within your selected window' },
                  { key: 'showRecentlyReleasedTV',      label: '📡 Recently Added Episodes',       desc: 'Show shows with recently added episodes' },
                  { key: 'showRecommendations',         label: '⭐ Recommendations',          desc: 'Show personalized recommendations based on watch history' },
                ].map(({ key, label, desc }) => (
                  <div key={key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 600 }}>{label}</div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>{desc}</div>
                    </div>
                    <label className="toggle">
                      <input type="checkbox" checked={libSettings[key] !== false}
                        onChange={e => updateLibSettings({ [key]: e.target.checked })} />
                      <span className="toggle-slider" />
                    </label>
                  </div>
                ))}

                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>Recently Released Window</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>How far back to look for recently released movies.</div>
                  </div>
                  <select value={libSettings.recentlyReleasedDays || 90}
                    onChange={e => updateLibSettings({ recentlyReleasedDays: parseInt(e.target.value) })}
                    style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 10px', color: 'var(--text-primary)' }}>
                    <option value={30}>1 month</option>
                    <option value={60}>2 months</option>
                    <option value={90}>3 months</option>
                    <option value={180}>6 months</option>
                    <option value={365}>1 year</option>
                  </select>
                </div>
              </div>
                </div>
                <select value={libSettings.continueWatchingMax}
                  onChange={e => updateLibSettings({ continueWatchingMax: parseInt(e.target.value) })}
                  style={{ padding: '7px 12px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', color: 'var(--text-primary)', fontSize: 13 }}>
                  {[10,20,40,60,80,100].map(v => <option key={v} value={v}>{v} items</option>)}
                </select>
              </div>
            </div>

            {/* Media Generation */}
            <div style={{ marginBottom: 28 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 14 }}>Media Generation</div>

              {/* Thumbnail Generator — special row with manual run + schedule info */}
              <ThumbnailGeneratorRow libSettings={libSettings} updateLibSettings={updateLibSettings} API={API} />

              {[
                { key: 'generateScreenshots', label: 'Generate episode screenshots', desc: 'Extract a frame from each episode to use as the thumbnail. Requires a mapped drive letter for NAS media.' },
                { key: 'generateChapterThumbs', label: 'Generate chapter thumbnails', desc: 'Extract chapter images for use in the chapter view. Takes additional disk space.' },
              ].map(({ key, label, desc }) => (
                <div key={key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 0', borderBottom: '1px solid var(--border)' }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>{label}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>{desc}</div>
                  </div>
                  <button onClick={() => updateLibSettings({ [key]: !libSettings[key] })}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: libSettings[key] ? 'var(--accent)' : 'var(--text-muted)', flexShrink: 0, marginLeft: 24 }}>
                    {libSettings[key] ? <ToggleRight size={28} /> : <ToggleLeft size={28} />}
                  </button>
                </div>
              ))}
            </div>

            {/* Tools */}
            <div style={{ marginBottom: 28 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 14 }}>Tools</div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 0', borderBottom: '1px solid var(--border)' }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>yt-dlp</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>
                    Required for TV show theme songs when no YouTube API key is configured. Downloads automatically on first use.
                  </div>
                  {ytdlpInstalled && <div style={{ fontSize: 11, color: '#10b981', marginTop: 4 }}>✓ Installed</div>}
                </div>
                <div style={{ flexShrink:0, marginLeft:24, textAlign:'right' }}>
                  {ytdlpInstalled
                    ? <div style={{ fontSize:13, color:'#10b981', fontWeight:700 }}>✓ Ready</div>
                    : <button onClick={installYtdlp} disabled={ytdlpInstalling}
                        style={{ padding:'8px 18px', background: ytdlpFailed ? '#ef4444' : 'var(--accent)', border:'none',
                          borderRadius:'var(--radius)', color:'white', cursor: ytdlpInstalling ? 'not-allowed' : 'pointer',
                          fontSize:13, fontWeight:600, opacity: ytdlpInstalling ? 0.8 : 1 }}>
                        {ytdlpInstalling ? '⏳ Installing...' : ytdlpFailed ? '↺ Retry' : '⬇ Install'}
                      </button>
                  }
                  {ytdlpProgress && !ytdlpInstalled && (
                    <div style={{ fontSize:11, color: ytdlpFailed ? '#ef4444' : 'var(--text-muted)', marginTop:6, maxWidth:240 }}>
                      {ytdlpProgress}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Appearance */}
            <div style={{ marginBottom: 28 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 14 }}>Appearance</div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 0', borderBottom: '1px solid var(--border)' }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>Full page background image</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>Use the show or movie backdrop as a full-page background when browsing details.</div>
                </div>
                <button onClick={() => { setFullBackground(v => !v); setLibSettingsDirty(true); setLibSettingsSaved(false); }}
                  style={{ background:'none', border:'none', cursor:'pointer', color: fullBackground ? 'var(--accent)' : 'var(--text-muted)', flexShrink:0, marginLeft:24 }}>
                  {fullBackground ? <ToggleRight size={28} /> : <ToggleLeft size={28} />}
                </button>
              </div>
            </div>

            {/* TV Shows */}
            <div style={{ marginBottom: 28 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 14 }}>TV Shows</div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 0', borderBottom: '1px solid var(--border)' }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>🎵 Theme Songs</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>Auto-play the show theme song when browsing a TV series (fetched from TVmaze when available).</div>
                </div>
                <button onClick={() => { setThemeSong(v => !v); setLibSettingsDirty(true); setLibSettingsSaved(false); }}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: themeSong ? 'var(--accent)' : 'var(--text-muted)', flexShrink: 0, marginLeft: 24 }}>
                  {themeSong ? <ToggleRight size={28} /> : <ToggleLeft size={28} />}
                </button>
              </div>
            </div>

            {/* Save button */}
            {/* Cleanup */}
            <div style={{ marginBottom: 28 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 14 }}>Cleanup</div>
              <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '18px 20px' }}>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Organize Movies into Subfolders</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16 }}>
                  Finds movies sitting directly in the root media folder and moves each one into its own subfolder named <code style={{background:'var(--bg-tertiary)',padding:'1px 6px',borderRadius:4}}>Movie Title (Year)/</code>. Metadata files are moved with them.
                </div>
                <MovieFolderCleanup />
              </div>
            </div>

            <div style={{ display:'flex', alignItems:'center', gap:14, paddingTop:8, borderTop:'1px solid var(--border)', marginTop:8 }}>
              <button onClick={saveLibSettings}
                style={{ padding:'10px 28px', background: libSettingsSaved ? '#10b981' : libSettingsError ? '#ef4444' : 'var(--accent)',
                  border:'none', borderRadius:'var(--radius)', color:'white', cursor:'pointer', fontSize:14, fontWeight:700,
                  transition:'background 0.2s', opacity: libSettingsDirty ? 1 : 0.6 }}>
                {libSettingsSaved ? '✓ Saved' : libSettingsError ? '✗ Error — try again' : 'Save Settings'}
              </button>
              {libSettingsDirty && !libSettingsSaved && (
                <span style={{ fontSize:12, color:'var(--text-muted)' }}>You have unsaved changes</span>
              )}
            </div>
          </div>
        )}

        {activeTab === 'extras' && (
          <div>
            <div style={{ marginBottom: 28 }}>
              <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Extras</h3>
              <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Configure cinema trailers, pre-roll videos and music video paths.</p>
            </div>

            {/* Cinema Trailers */}
            <div style={{ marginBottom: 28 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 14 }}>Cinema Trailers</div>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 0', borderBottom: '1px solid var(--border)' }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>Choose Cinema Trailers from</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>Which trailers to play before movies.</div>
                </div>
                <select value={extrasSettings.cinemaTrailersFrom}
                  onChange={e => saveExtrasSettings({ cinemaTrailersFrom: e.target.value })}
                  style={{ padding: '7px 12px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', color: 'var(--text-primary)', fontSize: 13, marginLeft: 24, flexShrink: 0 }}>
                  <option value="all">All movies</option>
                  <option value="unwatched">Only unwatched movies</option>
                  <option value="never">Never</option>
                </select>
              </div>

              {[
                { key: 'includeLibraryTrailers', label: 'Include trailers from movies in my library', desc: 'Play trailers from your own library before movies.' },
                { key: 'includeTheatersTrailers', label: 'Include trailers from new and upcoming movies in theaters', desc: 'Fetches trailers for current theatrical releases.' },
                { key: 'includeBlurayTrailers', label: 'Include trailers from new and upcoming movies on Blu-ray', desc: 'Fetches trailers for upcoming Blu-ray releases.' },
                { key: 'alwaysIncludeEnglishTrailers', label: 'Always include English language trailers', desc: 'Include English trailers for movies not in your library.' },
              ].map(({ key, label, desc }) => (
                <div key={key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 0', borderBottom: '1px solid var(--border)' }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>{label}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>{desc}</div>
                  </div>
                  <button onClick={() => saveExtrasSettings({ [key]: !extrasSettings[key] })}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: extrasSettings[key] ? 'var(--accent)' : 'var(--text-muted)', flexShrink: 0, marginLeft: 24 }}>
                    {extrasSettings[key] ? <ToggleRight size={28} /> : <ToggleLeft size={28} />}
                  </button>
                </div>
              ))}
            </div>

            {/* Pre-roll */}
            <div style={{ marginBottom: 28 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 14 }}>Pre-roll Video</div>
              <div style={{ padding: '14px 0', borderBottom: '1px solid var(--border)' }}>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Movie pre-roll video</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>
                  Path to a video file to play before movies. Separate multiple paths with commas for sequential play, or semicolons to pick one randomly.
                </div>
                <input value={extrasSettings.preRollVideo}
                  onChange={e => setExtrasSettings(prev => ({ ...prev, preRollVideo: e.target.value }))}
                  onBlur={() => saveExtrasSettings({})}
                  placeholder="e.g. C:\Videos\intro.mp4"
                  style={{ width: '100%', padding: '8px 12px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', color: 'var(--text-primary)', fontSize: 13, boxSizing: 'border-box' }} />
              </div>
            </div>

            {/* yt-dlp path */}
            <div style={{ marginBottom: 28 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 14 }}>Tools</div>
              <div style={{ padding: '14px 0', borderBottom: '1px solid var(--border)' }}>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>yt-dlp path</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>Path to yt-dlp executable. Required for TV show theme songs. Leave blank to auto-detect.</div>
                <div style={{ display:'flex', gap:8 }}>
                  <input value={extrasSettings.ytdlpPath||''}
                    onChange={e => setExtrasSettings(prev => ({ ...prev, ytdlpPath: e.target.value }))}
                    onBlur={() => saveExtrasSettings({})}
                    placeholder="e.g. C:\Users\Ray\AppData\Local\Programs\yt-dlp\yt-dlp.exe"
                    style={{ flex:1, padding:'8px 12px', background:'var(--bg-tertiary)', border:'1px solid var(--border)', borderRadius:'var(--radius)', color:'var(--text-primary)', fontSize:13, boxSizing:'border-box' }}/>
                  <button onClick={async () => {
                    const r = await fetch(`${API}/theme/test`).then(r=>r.json()).catch(()=>({error:'failed'}));
                    alert(r.path ? 'Found: ' + r.path : 'Not found: ' + (r.error||'unknown'));
                  }} style={{ padding:'8px 14px', background:'var(--bg-tertiary)', border:'1px solid var(--border)', borderRadius:'var(--radius)', color:'var(--text-secondary)', cursor:'pointer', fontSize:12, whiteSpace:'nowrap' }}>
                    Test
                  </button>
                </div>
              </div>
            </div>

            {/* Music Videos */}
            <div style={{ marginBottom: 28 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 14 }}>Music Videos</div>
              <div style={{ padding: '14px 0', borderBottom: '1px solid var(--border)' }}>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Global music videos path</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>A global path to music videos available across all music libraries.</div>
                <input value={extrasSettings.musicVideosPath}
                  onChange={e => setExtrasSettings(prev => ({ ...prev, musicVideosPath: e.target.value }))}
                  onBlur={() => saveExtrasSettings({})}
                  placeholder="e.g. \\192.168.0.245\media\MusicVids"
                  style={{ width: '100%', padding: '8px 12px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', color: 'var(--text-primary)', fontSize: 13, boxSizing: 'border-box' }} />
              </div>
            </div>
          </div>
        )}

        {activeTab === 'themes' && (
          <ThemeBuilder currentTheme={theme} changeTheme={changeTheme} />
        )}

        {activeTab === 'transcoding' && (
          <div>
            {/* Hardware status banner */}
            {hardwareInfo && (
              <div style={{ background: hardwareInfo.isHardware ? 'rgba(16,185,129,0.08)' : 'rgba(245,158,11,0.08)', border: `1px solid ${hardwareInfo.isHardware ? 'rgba(16,185,129,0.25)' : 'rgba(245,158,11,0.25)'}`, borderRadius: 'var(--radius-lg)', padding: '16px 20px', marginBottom: 28, display: 'flex', alignItems: 'center', gap: 14 }}>
                <HardDrive size={24} color={hardwareInfo.isHardware ? '#34d399' : '#fbbf24'} />
                <div>
                  <div style={{ fontWeight: 700, fontSize: 14, color: hardwareInfo.isHardware ? '#34d399' : '#fbbf24' }}>
                    {hardwareInfo.isHardware ? '⚡ Hardware Acceleration Active' : '🖥 Software Transcoding (CPU)'}
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 2 }}>
                    Encoder: <code style={{ background: 'var(--bg-tertiary)', padding: '1px 6px', borderRadius: 3, fontSize: 12 }}>{hardwareInfo.encoder}</code> — {hardwareInfo.type}
                  </div>
                </div>
              </div>
            )}

            {/* Quality */}
            <div style={{ marginBottom: 28 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 14 }}>Quality</div>
              {[
                { label: 'Transcoder quality', key: 'quality', desc: 'Quality profile used by the transcoder.',
                  options: [{ value: 'auto', label: 'Automatic' },{ value: 'speed', label: 'Prefer higher speed encoding' },{ value: 'balanced', label: 'Balanced (recommended)' },{ value: 'quality', label: 'Prefer higher quality encoding' },{ value: 'insane', label: 'Make my CPU hurt' }] },
                { label: 'Default resolution', key: 'resolution', desc: 'Target resolution for transcoded streams.',
                  options: [{ value: '480p', label: '480p (2 Mbps)' },{ value: '720p', label: '720p (4 Mbps)' },{ value: '1080p', label: '1080p (8 Mbps)' },{ value: 'original', label: 'Original (no resize)' }] },
                { label: 'Background transcoding preset', key: 'x264preset', desc: 'x264 preset for background transcoding. Slower = better quality & smaller files.',
                  options: ['ultrafast','superfast','veryfast','faster','fast','medium','slow','slower','veryslow'].map(v => ({ value: v, label: v.charAt(0).toUpperCase()+v.slice(1) })) },
              ].map(row => (
                <div key={row.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 0', borderBottom: '1px solid var(--border)' }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>{row.label}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>{row.desc}</div>
                  </div>
                  <select value={transcodeSettings[row.key] || row.options[0].value}
                    onChange={e => { const updated = { ...transcodeSettings, [row.key]: e.target.value }; setTranscodeSettings(updated); fetch(`${API}/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ transcoding: updated }) }); }}
                    style={{ padding: '7px 12px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', color: 'var(--text-primary)', fontSize: 13, marginLeft: 24, flexShrink: 0 }}>
                    {row.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
              ))}
            </div>

            {/* Hardware */}
            <div style={{ marginBottom: 28 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 14 }}>Hardware Acceleration</div>
              {[
                { label: 'Hardware encoder', key: 'hardware', desc: 'GPU encoder to use for transcoding.',
                  options: [{ value: 'auto', label: 'Auto-detect (recommended)' },{ value: 'amf', label: 'AMD AMF (RX / Radeon)' },{ value: 'nvenc', label: 'NVIDIA NVENC' },{ value: 'qsv', label: 'Intel Quick Sync' },{ value: 'software', label: 'Software / CPU only' }] },
                { label: 'Hardware transcoding device', key: 'hwDevice', desc: 'The GPU or device used for hardware transcoding.',
                  options: [{ value: 'auto', label: 'Auto' },{ value: '0', label: 'GPU 0' },{ value: '1', label: 'GPU 1' },{ value: '2', label: 'GPU 2' }] },
              ].map(row => (
                <div key={row.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 0', borderBottom: '1px solid var(--border)' }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>{row.label}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>{row.desc}</div>
                  </div>
                  <select value={transcodeSettings[row.key] || row.options[0].value}
                    onChange={e => { const updated = { ...transcodeSettings, [row.key]: e.target.value }; setTranscodeSettings(updated); fetch(`${API}/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ transcoding: updated }) }); }}
                    style={{ padding: '7px 12px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', color: 'var(--text-primary)', fontSize: 13, marginLeft: 24, flexShrink: 0 }}>
                    {row.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
              ))}
              {[
                { key: 'hwAccel', label: 'Use hardware acceleration when available', desc: 'Orion will use GPU-accelerated encoding and decoding when possible.' },
                { key: 'hwEncoding', label: 'Use hardware-accelerated video encoding', desc: 'If hardware acceleration is enabled, also use it for encoding (not just decoding).' },
                { key: 'hdrToneMap', label: 'Enable HDR tone mapping', desc: 'Transcoded HDR content will appear dimmed without this. May require additional GPU drivers.' },
              ].map(({ key, label, desc }) => (
                <div key={key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 0', borderBottom: '1px solid var(--border)' }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>{label}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>{desc}</div>
                  </div>
                  <button onClick={() => { const updated = { ...transcodeSettings, [key]: !transcodeSettings[key] }; setTranscodeSettings(updated); fetch(`${API}/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ transcoding: updated }) }); }}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: transcodeSettings[key] ? 'var(--accent)' : 'var(--text-muted)', flexShrink: 0, marginLeft: 24 }}>
                    {transcodeSettings[key] ? <ToggleRight size={28} /> : <ToggleLeft size={28} />}
                  </button>
                </div>
              ))}
              {[
                { label: 'Tonemapping algorithm', key: 'tonemapAlgo', desc: 'Algorithm used when performing HDR tone mapping.',
                  options: ['linear','gamma','clip','reinhard','hable','mobius'].map(v => ({ value: v, label: v.charAt(0).toUpperCase()+v.slice(1) })) },
              ].map(row => (
                <div key={row.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 0', borderBottom: '1px solid var(--border)' }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>{row.label}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>{row.desc}</div>
                  </div>
                  <select value={transcodeSettings[row.key] || 'hable'}
                    onChange={e => { const updated = { ...transcodeSettings, [row.key]: e.target.value }; setTranscodeSettings(updated); fetch(`${API}/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ transcoding: updated }) }); }}
                    style={{ padding: '7px 12px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', color: 'var(--text-primary)', fontSize: 13, marginLeft: 24, flexShrink: 0 }}>
                    {row.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
              ))}
            </div>

            {/* Limits */}
            <div style={{ marginBottom: 28 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 14 }}>Limits</div>
              {[
                { label: 'Maximum simultaneous CPU transcodes', key: 'maxCpuTranscodes', desc: 'Limit simultaneous video transcode streams on your CPU.' },
                { label: 'Maximum simultaneous background transcodes', key: 'maxBgTranscodes', desc: 'Limit simultaneous transcodes for downloads and optimizer.' },
                { label: 'Work-ahead buffer (MB)', key: 'workAheadMB', desc: 'How much data to pre-transcode ahead of current playback. Higher = smoother over NAS, more RAM.' },
              ].map(row => (
                <div key={row.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 0', borderBottom: '1px solid var(--border)' }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>{row.label}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>{row.desc}</div>
                  </div>
                  <select value={transcodeSettings[row.key] || (row.key === 'workAheadMB' ? '20' : '0')}
                    onChange={e => { const updated = { ...transcodeSettings, [row.key]: e.target.value }; setTranscodeSettings(updated); fetch(`${API}/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ transcoding: updated }) }); }}
                    style={{ padding: '7px 12px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', color: 'var(--text-primary)', fontSize: 13, marginLeft: 24, flexShrink: 0 }}>
                    {row.key === 'workAheadMB' ? (
                      [8, 16, 20, 32, 48, 64, 96, 128, 192, 256].map(v => <option key={v} value={String(v)}>{v} MB</option>)
                    ) : (
                      <><option value="0">Unlimited</option>{[1,2,3,4,5,6,7,8,10,12,16,20].map(v => <option key={v} value={String(v)}>{v}</option>)}</>
                    )}
                  </select>
                </div>
              ))}
            </div>

            {/* Temp directories */}
            <div style={{ marginBottom: 28 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 14 }}>Temporary Directories</div>
              {[
                { label: 'Transcoder temporary directory', key: 'tempDir', placeholder: 'Default system temp', desc: 'Directory for temporary files during transcoding.' },
                { label: 'Downloads temporary directory', key: 'downloadTempDir', placeholder: 'Default system temp', desc: 'Directory for storing transcoded downloads until the client retrieves them.' },
              ].map(row => (
                <div key={row.key} style={{ padding: '14px 0', borderBottom: '1px solid var(--border)' }}>
                  <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>{row.label}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>{row.desc}</div>
                  <input value={transcodeSettings[row.key] || ''} placeholder={row.placeholder}
                    onChange={e => setTranscodeSettings(prev => ({ ...prev, [row.key]: e.target.value }))}
                    onBlur={e => { const updated = { ...transcodeSettings, [row.key]: e.target.value }; setTranscodeSettings(updated); fetch(`${API}/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ transcoding: updated }) }); }}
                    style={{ width: '100%', padding: '8px 12px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', color: 'var(--text-primary)', fontSize: 13, boxSizing: 'border-box' }} />
                </div>
              ))}
            </div>

            <div style={{ fontSize:12, color:'var(--text-muted)', marginTop:8, fontStyle:'italic' }}>Settings save automatically.</div>
          </div>
        )}


        {activeTab === 'activity' && (
          <ActivityTab API={API} />
        )}
        {activeTab === 'debug' && (
          <div style={{ maxWidth: 720 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 16 }}>Debug Logging</div>
                <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 2 }}>Capture detailed server logs to diagnose playback issues</div>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button className="btn btn-secondary" style={{ fontSize: 12, gap: 6 }} onClick={() => {
                  fetch(`${API}/debug/log`).then(r => r.json()).then(d => setDebugLog(d.log || []));
                }}>
                  <RefreshCw size={13} /> Refresh
                </button>
                <button className="btn btn-secondary" style={{ fontSize: 12, gap: 6 }} onClick={() => {
                  const a = document.createElement('a');
                  a.href = `${API}/debug/log?format=txt`;
                  a.download = `orion-debug-${Date.now()}.txt`;
                  a.click();
                }}>
                  <Download size={13} /> Download Log
                </button>
                <button className="btn btn-secondary" style={{ fontSize: 12, gap: 6, color: '#ef4444' }} onClick={() => {
                  fetch(`${API}/debug/log`, { method: 'DELETE' }).then(() => setDebugLog([]));
                }}>
                  <Trash size={13} /> Clear
                </button>
              </div>
            </div>

            {/* Toggle */}
            <div className="settings-row" style={{ marginBottom: 24 }}>
              <div>
                <div className="settings-label">Enable Debug Logging</div>
                <div className="settings-desc">Logs all stream requests, encoder selection, errors, and client disconnect events</div>
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
                <div onClick={() => {
                  fetch(`${API}/debug/toggle`, { method: 'POST' })
                    .then(r => r.json())
                    .then(d => {
                      setDebugEnabled(!!d.enabled);
                      if (d.enabled) setDebugLog([]);
                    })
                    .catch(e => console.error('Debug toggle failed:', e));
                }} style={{ width: 44, height: 24, borderRadius: 12, background: debugEnabled ? 'var(--accent)' : 'rgba(255,255,255,0.15)', position: 'relative', cursor: 'pointer', transition: 'background 0.2s', flexShrink: 0 }}>
                  <div style={{ position: 'absolute', top: 2, left: debugEnabled ? 22 : 2, width: 20, height: 20, borderRadius: '50%', background: 'white', transition: 'left 0.2s' }} />
                </div>
                <span style={{ fontSize: 13, color: debugEnabled ? 'var(--accent)' : 'var(--text-muted)' }}>{debugEnabled ? 'ON' : 'OFF'}</span>
              </label>
            </div>

            {/* Log viewer */}
            <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', overflow: 'hidden' }}>
              <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)' }}>LOG OUTPUT — {debugLog.length} entries</span>
                {!debugEnabled && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Enable debug logging then trigger a playback action</span>}
              </div>
              <div style={{ height: 380, overflowY: 'auto', padding: '10px 16px', fontFamily: 'monospace', fontSize: 11.5 }}>
                {debugLog.length === 0
                  ? <div style={{ color: 'var(--text-muted)', padding: '20px 0', textAlign: 'center' }}>
                      {debugEnabled ? 'No log entries yet — try playing a video' : 'Turn on debug logging above, then play a video'}
                    </div>
                  : [...debugLog].reverse().map((line, i) => (
                    <div key={i} style={{ marginBottom: 3, color: line.includes('ERROR') || line.includes('error') ? '#f87171' : line.includes('DISCONNECTED') || line.includes('disconnected') ? '#fbbf24' : line.includes('STREAM') ? '#60a5fa' : 'var(--text-secondary)', wordBreak: 'break-all' }}>
                      {line}
                    </div>
                  ))
                }
              </div>
            </div>
          </div>
        )}

        {activeTab === 'ai' && (
          <LocalAISettings API={API} />
        )}

        {activeTab === 'about' && (
          <div style={{ maxWidth: 520 }}>
            <div style={{ textAlign: 'center', marginBottom: 32 }}>
              <img src={`${process.env.PUBLIC_URL}/logo.png`} alt="Orion" style={{ width: 160, height: 160, objectFit: 'contain', marginBottom: 16 }} />
              <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Version 1.0.0 — Alpha</div>
            </div>
            {[
              { label: 'Developer', value: 'R. Poltera' },
              { label: 'Platform', value: window.electron ? 'Windows (Electron + React)' : 'Linux (Node.js + React)' },
              { label: 'License', value: 'MIT — Free & Open Source' },
            ].map(({ label, value }) => (
              <div key={label} className="settings-row">
                <div className="settings-label" style={{ color: 'var(--text-muted)' }}>{label}</div>
                <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{value}</div>
              </div>
            ))}
            <div style={{ marginTop: 24, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <button className="btn btn-secondary" style={{ width: '100%', justifyContent: 'center', gap: 8 }}
                onClick={() => window.electron ? window.electron.openExternal('https://github.com/rpoltera/Orion') : window.open('https://github.com/rpoltera/Orion', '_blank')}>
                <GitBranch size={16} /> View on GitHub
              </button>
            </div>
          </div>
        )}

        {activeTab === 'autocollect' && (
          <AutoCollectionsEmbedded />
        )}

        {activeTab === 'homelayout' && (
          <HomeLayoutSettings />
        )}

        {activeTab === 'scheduler' && <SchedulerPage embedded />}
        {activeTab === 'users'     && <UsersPage embedded />}

        {activeTab === 'homelayout' && (
          <HomeLayoutSettings />
        )}

        </div>
      </div>
    </div>
  );
}

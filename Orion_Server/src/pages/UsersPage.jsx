import React, { useState, useEffect } from 'react';
import { useApp } from '../contexts/AppContext';
import { Plus, Trash2, Edit2, Shield, User, Users, Check, X, ChevronDown, ChevronRight } from 'lucide-react';

const API = 'http://localhost:3001/api';
const AVATARS = ['👑','👤','🧑','👩','👦','👧','🧒','🎮','🎬','🎵','🌟','🚀','🦁','🐯','🦊','🐧'];
const GROUP_COLORS = ['#0063e5','#10b981','#f59e0b','#ef4444','#8b5cf6','#ec4899','#06b6d4','#84cc16'];

export default function UsersPage() {
  const { library, API: appAPI } = useApp();
  const [users, setUsers]       = useState([]);
  const [groups, setGroups]     = useState([]);
  const [tab, setTab]           = useState('users'); // users | groups
  const [editUser, setEditUser] = useState(null);    // user being edited
  const [editGroup, setEditGroup] = useState(null);
  const [showNewUser, setShowNewUser] = useState(false);
  const [showNewGroup, setShowNewGroup] = useState(false);
  const [assignTarget, setAssignTarget] = useState(null); // { type: 'user'|'group', id }
  const [assignSection, setAssignSection] = useState('movies');
  const [newUser, setNewUser]   = useState({ name:'', password:'', role:'user', avatar:'👤' });
  const [newGroup, setNewGroup] = useState({ name:'', color:'#0063e5' });
  const [msg, setMsg]           = useState('');

  useEffect(() => { fetchAll(); }, []);

  const fetchAll = async () => {
    const [u, g] = await Promise.all([
      fetch(`${API}/users`).then(r=>r.json()).catch(()=>({users:[]})),
      fetch(`${API}/groups`).then(r=>r.json()).catch(()=>({groups:[]})),
    ]);
    setUsers(u.users || []);
    setGroups(g.groups || []);
  };

  const createUser = async () => {
    if (!newUser.name || !newUser.pin) return;
    await fetch(`${API}/users`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(newUser) });
    setNewUser({ name:'', password:'', role:'user', avatar:'👤' });
    setShowNewUser(false);
    fetchAll();
    setMsg('User created');
  };

  const deleteUser = async (id) => {
    if (!window.confirm('Delete this user?')) return;
    await fetch(`${API}/users/${id}`, { method:'DELETE' });
    fetchAll();
  };

  const createGroup = async () => {
    if (!newGroup.name) return;
    await fetch(`${API}/groups`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(newGroup) });
    setNewGroup({ name:'', color:'#0063e5' });
    setShowNewGroup(false);
    fetchAll();
  };

  const deleteGroup = async (id) => {
    if (!window.confirm('Delete this group?')) return;
    await fetch(`${API}/groups/${id}`, { method:'DELETE' });
    fetchAll();
  };

  const toggleAccess = async (targetType, targetId, section, itemId) => {
    const target = targetType === 'user' ? users.find(u=>u.id===targetId) : groups.find(g=>g.id===targetId);
    if (!target) return;
    const current = target.mediaAccess?.[section] || [];
    const updated = current.includes(itemId) ? current.filter(x=>x!==itemId) : [...current, itemId];
    const endpoint = targetType === 'user' ? `${API}/users/${targetId}/access` : `${API}/groups/${targetId}/access`;
    await fetch(endpoint, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ [section]: updated }) });
    fetchAll();
  };

  const toggleAllAccess = async (targetType, targetId, val) => {
    const endpoint = targetType === 'user' ? `${API}/users/${targetId}/access` : `${API}/groups/${targetId}/access`;
    await fetch(endpoint, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ all: val }) });
    fetchAll();
  };

  const addUserToGroup = async (userId, groupId) => {
    const user = users.find(u=>u.id===userId);
    if (!user) return;
    const groupIds = user.groupIds?.includes(groupId)
      ? user.groupIds.filter(id=>id!==groupId)
      : [...(user.groupIds||[]), groupId];
    await fetch(`${API}/users/${userId}`, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ groupIds }) });
    fetchAll();
  };

  // Media sections for assignment
  const SECTIONS = [
    { id:'movies',   label:'Movies',   items: library.movies || [] },
    { id:'tvShows',  label:'TV Shows', items: library.tvShows || [] },
    { id:'music',    label:'Music',    items: library.music || [] },
    { id:'collections', label:'Collections', items: [] },
  ];

  const assignTargetObj = assignTarget?.type === 'user'
    ? users.find(u=>u.id===assignTarget.id)
    : groups.find(g=>g.id===assignTarget.id);

  return (
    <div className="page">
      <div className="page-header">
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
          <div>
            <div className="page-title">👥 User Management</div>
            <div className="page-subtitle">{users.length} users · {groups.length} groups</div>
          </div>
        </div>
      </div>

      {/* Tab bar */}
      <div style={{ display:'flex', gap:4, padding:'0 48px 24px' }}>
        {[{id:'users',label:'👤 Users'},{id:'groups',label:'👥 Groups'},{id:'assign',label:'🔐 Assign Media'}].map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            padding:'9px 18px', borderRadius:'var(--radius)', border:'none', cursor:'pointer', fontSize:13, fontWeight:600,
            background: tab===t.id ? 'var(--tag-bg)' : 'transparent',
            color: tab===t.id ? 'var(--accent)' : 'var(--text-secondary)',
          }}>{t.label}</button>
        ))}
      </div>

      <div style={{ padding:'0 48px 48px' }}>

        {/* ── USERS TAB ── */}
        {tab === 'users' && (
          <div>
            {/* New user form */}
            {showNewUser ? (
              <div style={{ background:'var(--bg-card)', border:'1px solid var(--border-accent)', borderRadius:'var(--radius-lg)', padding:20, marginBottom:20 }}>
                <div style={{ fontSize:14, fontWeight:700, marginBottom:14 }}>New User</div>
                {/* Avatar picker */}
                <div style={{ display:'flex', flexWrap:'wrap', gap:8, marginBottom:14 }}>
                  {AVATARS.map(a => (
                    <button key={a} onClick={() => setNewUser(u=>({...u,avatar:a}))}
                      style={{ width:40, height:40, fontSize:20, background: newUser.avatar===a ? 'var(--tag-bg)' : 'var(--bg-tertiary)', border:`2px solid ${newUser.avatar===a?'var(--accent)':'transparent'}`, borderRadius:8, cursor:'pointer' }}>
                      {a}
                    </button>
                  ))}
                </div>
                <div style={{ display:'flex', gap:10, flexWrap:'wrap', marginBottom:10 }}>
                  <input placeholder="Name" value={newUser.name} onChange={e=>setNewUser(u=>({...u,name:e.target.value}))}
                    style={{ flex:1, minWidth:140, padding:'8px 12px', background:'var(--bg-tertiary)', border:'1px solid var(--border)', borderRadius:'var(--radius)', color:'var(--text-primary)', fontSize:13, outline:'none' }} />
                  <input placeholder="Password" type="password" value={newUser.password} onChange={e=>setNewUser(u=>({...u,password:e.target.value}))}
                    style={{ flex:1, minWidth:140, padding:'8px 12px', background:'var(--bg-tertiary)', border:'1px solid var(--border)', borderRadius:'var(--radius)', color:'var(--text-primary)', fontSize:13, outline:'none' }} />
                  <select value={newUser.role} onChange={e=>setNewUser(u=>({...u,role:e.target.value}))} className="select-input">
                    <option value="user">User</option>
                    <option value="admin">Admin</option>
                  </select>
                  <select value={newUser.maxRating||''} onChange={e=>setNewUser(u=>({...u,maxRating:e.target.value||null}))}
                    style={{ padding:'8px 12px', background:'var(--bg-tertiary)', border:'1px solid var(--border)', borderRadius:'var(--radius)', color:'var(--text-primary)', fontSize:13 }}>
                    <option value="">No rating restriction</option>
                    {['G','TV-G','TV-Y','TV-Y7','PG','TV-PG','PG-13','TV-14','R','TV-MA','NC-17'].map(r => (
                      <option key={r} value={r}>Max: {r}</option>
                    ))}
                  </select>
                </div>
                <div style={{ display:'flex', gap:8 }}>
                  <button className="btn btn-primary btn-sm" onClick={createUser}>Create User</button>
                  <button className="btn btn-secondary btn-sm" onClick={() => setShowNewUser(false)}>Cancel</button>
                </div>
              </div>
            ) : (
              <button className="btn btn-secondary btn-sm" onClick={() => setShowNewUser(true)} style={{ marginBottom:20 }}>
                <Plus size={14} /> New User
              </button>
            )}

            {/* User list */}
            <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
              {users.map(user => (
                <div key={user.id} style={{ background:'var(--bg-card)', border:'1px solid var(--border)', borderRadius:'var(--radius-lg)', padding:'16px 20px', display:'flex', alignItems:'center', gap:16 }}>
                  {/* Avatar */}
                  <div style={{ width:52, height:52, borderRadius:'50%', background:'linear-gradient(135deg,#1a1a3e,#2d1b69)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:24, flexShrink:0 }}>
                    {user.avatar||'👤'}
                  </div>
                  {/* Info */}
                  <div style={{ flex:1 }}>
                    <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:4 }}>
                      <span style={{ fontWeight:700, fontSize:15 }}>{user.name}</span>
                      {user.role === 'admin' && <span style={{ fontSize:10, fontWeight:700, color:'#f59e0b', background:'rgba(245,158,11,0.15)', padding:'2px 7px', borderRadius:10, border:'1px solid rgba(245,158,11,0.3)' }}>ADMIN</span>}
                    </div>
                    <div style={{ fontSize:12, color:'var(--text-muted)', display:'flex', gap:12 }}>
                      {user.role !== 'admin' && (
                        <span>{user.mediaAccess?.all ? '✅ Full Access' : `🎬 ${user.mediaAccess?.movies?.length||0} movies · 📺 ${user.mediaAccess?.tvShows?.length||0} shows`}</span>
                      )}
                      {user.maxRating && (
                        <span style={{ color: '#f59e0b' }}>🔞 Max rating: {user.maxRating}</span>
                      )}
                      {(user.groupIds||[]).length > 0 && (
                        <span>Groups: {(user.groupIds||[]).map(gid => groups.find(g=>g.id===gid)?.name).filter(Boolean).join(', ')}</span>
                      )}
                    </div>
                  </div>
                  {/* Max Rating */}
                  <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                    <span style={{ fontSize:12, color:'var(--text-muted)', whiteSpace:'nowrap' }}>Max Rating:</span>
                    <select value={user.maxRating||''} onChange={async e => {
                      const val = e.target.value || null;
                      await fetch(`${API}/users/${user.id}`, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ maxRating: val }) });
                      fetchAll();
                    }} style={{ padding:'4px 8px', background:'var(--bg-tertiary)', border:'1px solid var(--border)', borderRadius:'var(--radius)', color:'var(--text-primary)', fontSize:12 }}>
                      <option value="">No restriction</option>
                      {['G','TV-G','TV-Y','TV-Y7','PG','TV-PG','PG-13','TV-14','R','TV-MA','NC-17'].map(r => (
                        <option key={r} value={r}>{r}</option>
                      ))}
                    </select>
                  </div>
                  {/* Groups */}
                  <div style={{ display:'flex', gap:6, flexWrap:'wrap', maxWidth:200 }}>
                    {groups.map(g => (
                      <button key={g.id} onClick={() => addUserToGroup(user.id, g.id)}
                        style={{ padding:'3px 10px', borderRadius:12, fontSize:11, fontWeight:600, cursor:'pointer', border:'1px solid', borderColor: (user.groupIds||[]).includes(g.id) ? g.color : 'var(--border)', background: (user.groupIds||[]).includes(g.id) ? g.color+'22' : 'transparent', color: (user.groupIds||[]).includes(g.id) ? g.color : 'var(--text-muted)' }}>
                        {g.name}
                      </button>
                    ))}
                  </div>
                  {/* Actions */}
                  <div style={{ display:'flex', gap:8 }}>
                    <button className="btn btn-secondary btn-sm" onClick={() => { setAssignTarget({type:'user',id:user.id}); setTab('assign'); }}>
                      <Shield size={13} /> Manage Access
                    </button>
                    {user.id !== 'admin' && (
                      <button onClick={() => deleteUser(user.id)} style={{ background:'none', border:'none', color:'var(--text-muted)', cursor:'pointer', padding:4 }}>
                        <Trash2 size={15} />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── GROUPS TAB ── */}
        {tab === 'groups' && (
          <div>
            {showNewGroup ? (
              <div style={{ background:'var(--bg-card)', border:'1px solid var(--border-accent)', borderRadius:'var(--radius-lg)', padding:20, marginBottom:20 }}>
                <div style={{ fontSize:14, fontWeight:700, marginBottom:14 }}>New Group</div>
                <div style={{ display:'flex', gap:10, marginBottom:12 }}>
                  <input placeholder="Group name (e.g. Kids, Adults, Family)" value={newGroup.name} onChange={e=>setNewGroup(g=>({...g,name:e.target.value}))}
                    style={{ flex:1, padding:'8px 12px', background:'var(--bg-tertiary)', border:'1px solid var(--border)', borderRadius:'var(--radius)', color:'var(--text-primary)', fontSize:13, outline:'none' }} />
                </div>
                <div style={{ display:'flex', gap:8, marginBottom:14 }}>
                  {GROUP_COLORS.map(c => (
                    <button key={c} onClick={() => setNewGroup(g=>({...g,color:c}))}
                      style={{ width:28, height:28, borderRadius:'50%', background:c, border:`3px solid ${newGroup.color===c?'white':'transparent'}`, cursor:'pointer' }} />
                  ))}
                </div>
                <div style={{ display:'flex', gap:8 }}>
                  <button className="btn btn-primary btn-sm" onClick={createGroup}>Create Group</button>
                  <button className="btn btn-secondary btn-sm" onClick={() => setShowNewGroup(false)}>Cancel</button>
                </div>
              </div>
            ) : (
              <button className="btn btn-secondary btn-sm" onClick={() => setShowNewGroup(true)} style={{ marginBottom:20 }}>
                <Plus size={14} /> New Group
              </button>
            )}

            <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
              {groups.map(g => (
                <div key={g.id} style={{ background:'var(--bg-card)', border:`1px solid ${g.color}44`, borderLeft:`4px solid ${g.color}`, borderRadius:'var(--radius-lg)', padding:'16px 20px', display:'flex', alignItems:'center', gap:16 }}>
                  <div style={{ flex:1 }}>
                    <div style={{ fontWeight:700, fontSize:15, marginBottom:4 }}>{g.name}</div>
                    <div style={{ fontSize:12, color:'var(--text-muted)' }}>
                      {g.mediaAccess?.all ? '✅ Full library access' : `🎬 ${g.mediaAccess?.movies?.length||0} movies · 📺 ${g.mediaAccess?.tvShows?.length||0} shows`}
                      {' · '}{users.filter(u=>(u.groupIds||[]).includes(g.id)).length} members
                    </div>
                  </div>
                  <div style={{ display:'flex', gap:8 }}>
                    <button className="btn btn-secondary btn-sm" onClick={() => { setAssignTarget({type:'group',id:g.id}); setTab('assign'); }}>
                      <Shield size={13} /> Manage Access
                    </button>
                    <button onClick={() => deleteGroup(g.id)} style={{ background:'none', border:'none', color:'var(--text-muted)', cursor:'pointer', padding:4 }}>
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
              ))}
              {groups.length === 0 && <div style={{ color:'var(--text-muted)', fontSize:13 }}>No groups yet. Create groups like "Kids", "Adults", "Family" to assign media in bulk.</div>}
            </div>
          </div>
        )}

        {/* ── ASSIGN MEDIA TAB ── */}
        {tab === 'assign' && (
          <div>
            {/* Target selector */}
            <div style={{ marginBottom:20 }}>
              <div style={{ fontSize:13, fontWeight:700, color:'var(--text-muted)', marginBottom:10, letterSpacing:1, textTransform:'uppercase' }}>Assign media to</div>
              <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
                {users.filter(u=>u.role!=='admin').map(u => (
                  <button key={u.id} onClick={() => setAssignTarget({type:'user',id:u.id})}
                    style={{ padding:'8px 14px', borderRadius:'var(--radius)', border:`1px solid ${assignTarget?.id===u.id?'var(--accent)':'var(--border)'}`, background: assignTarget?.id===u.id?'var(--tag-bg)':'transparent', color: assignTarget?.id===u.id?'var(--accent)':'var(--text-secondary)', cursor:'pointer', fontSize:13, display:'flex', alignItems:'center', gap:6 }}>
                    {u.avatar} {u.name}
                  </button>
                ))}
                {groups.map(g => (
                  <button key={g.id} onClick={() => setAssignTarget({type:'group',id:g.id})}
                    style={{ padding:'8px 14px', borderRadius:'var(--radius)', border:`1px solid ${assignTarget?.id===g.id?g.color:'var(--border)'}`, background: assignTarget?.id===g.id?g.color+'22':'transparent', color: assignTarget?.id===g.id?g.color:'var(--text-secondary)', cursor:'pointer', fontSize:13, display:'flex', alignItems:'center', gap:6 }}>
                    👥 {g.name}
                  </button>
                ))}
              </div>
            </div>

            {assignTargetObj && (
              <div>
                {/* Full access toggle */}
                <div style={{ background:'var(--bg-card)', border:'1px solid var(--border)', borderRadius:'var(--radius-lg)', padding:'14px 18px', marginBottom:16, display:'flex', alignItems:'center', justifyContent:'space-between' }}>
                  <div>
                    <div style={{ fontWeight:600, fontSize:14 }}>Full Library Access</div>
                    <div style={{ fontSize:12, color:'var(--text-muted)' }}>Allow access to everything in the library</div>
                  </div>
                  <button onClick={() => toggleAllAccess(assignTarget.type, assignTarget.id, !assignTargetObj.mediaAccess?.all)}
                    style={{ padding:'7px 16px', borderRadius:'var(--radius)', border:'none', cursor:'pointer', fontSize:13, fontWeight:600, background: assignTargetObj.mediaAccess?.all ? '#10b981' : 'var(--bg-tertiary)', color: assignTargetObj.mediaAccess?.all ? 'white' : 'var(--text-muted)' }}>
                    {assignTargetObj.mediaAccess?.all ? '✅ Enabled' : 'Enable'}
                  </button>
                </div>

                {!assignTargetObj.mediaAccess?.all && (
                  <>
                    {/* Section tabs */}
                    <div style={{ display:'flex', gap:4, marginBottom:16 }}>
                      {SECTIONS.map(s => (
                        <button key={s.id} onClick={() => setAssignSection(s.id)}
                          style={{ padding:'7px 14px', borderRadius:'var(--radius)', border:'none', cursor:'pointer', fontSize:12, fontWeight:600, background: assignSection===s.id?'var(--tag-bg)':'transparent', color: assignSection===s.id?'var(--accent)':'var(--text-muted)' }}>
                          {s.label} ({(assignTargetObj.mediaAccess?.[s.id]||[]).length}/{s.items.length})
                        </button>
                      ))}
                    </div>

                    {/* Select All / None */}
                    {(() => {
                      const sec = SECTIONS.find(s=>s.id===assignSection);
                      if (!sec) return null;
                      const allowed = assignTargetObj.mediaAccess?.[assignSection]||[];
                      const allSelected = sec.items.every(i=>allowed.includes(i.id));
                      return (
                        <div style={{ display:'flex', gap:8, marginBottom:14 }}>
                          <button className="btn btn-secondary btn-sm" onClick={async () => {
                            const endpoint = assignTarget.type==='user' ? `${API}/users/${assignTarget.id}/access` : `${API}/groups/${assignTarget.id}/access`;
                            await fetch(endpoint, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ [assignSection]: allSelected ? [] : sec.items.map(i=>i.id) }) });
                            fetchAll();
                          }}>
                            {allSelected ? 'Deselect All' : 'Select All'}
                          </button>
                          <span style={{ fontSize:12, color:'var(--text-muted)', alignSelf:'center' }}>{allowed.length} of {sec.items.length} selected</span>
                        </div>
                      );
                    })()}

                    {/* Media grid */}
                    <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(160px, 1fr))', gap:8 }}>
                      {(SECTIONS.find(s=>s.id===assignSection)?.items||[]).map(item => {
                        const allowed = (assignTargetObj.mediaAccess?.[assignSection]||[]).includes(item.id);
                        const thumbUrl = item.thumbnail ? (item.thumbnail.startsWith('http') ? item.thumbnail : 'http://localhost:3001'+item.thumbnail) : null;
                        return (
                          <div key={item.id} onClick={() => toggleAccess(assignTarget.type, assignTarget.id, assignSection, item.id)}
                            style={{ background:'var(--bg-card)', border:`2px solid ${allowed?'var(--accent)':'var(--border)'}`, borderRadius:'var(--radius)', overflow:'hidden', cursor:'pointer', position:'relative', transition:'all 0.15s' }}>
                            <div style={{ height:80, background:'var(--bg-tertiary)', overflow:'hidden' }}>
                              {thumbUrl && <img src={thumbUrl} alt="" style={{ width:'100%', height:'100%', objectFit:'cover', opacity: allowed?1:0.4 }} />}
                            </div>
                            <div style={{ padding:'6px 8px' }}>
                              <div style={{ fontSize:11, fontWeight:600, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', color: allowed?'var(--text-primary)':'var(--text-muted)' }}>{item.title}</div>
                              {item.year && <div style={{ fontSize:10, color:'var(--text-muted)' }}>{item.year}</div>}
                            </div>
                            {allowed && (
                              <div style={{ position:'absolute', top:5, right:5, width:20, height:20, borderRadius:'50%', background:'var(--accent)', display:'flex', alignItems:'center', justifyContent:'center' }}>
                                <Check size={12} color="white" />
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            )}
            {!assignTarget && (
              <div style={{ color:'var(--text-muted)', fontSize:13 }}>Select a user or group above to manage their media access.</div>
            )}
          </div>
        )}

      </div>
    </div>
  );
}

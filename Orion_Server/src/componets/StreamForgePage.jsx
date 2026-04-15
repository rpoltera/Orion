import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useApp } from '../contexts/AppContext';
import {
  Tv2, Radio, Play, Plus, Trash2, Edit2, Save, X, RefreshCw,
  Settings, Library, Calendar, Bot, Monitor, ChevronRight,
  List, Signal, Film, ExternalLink
} from 'lucide-react';

// ── API — always talks to Orion's own server at /api/sf/* ─────────────────────
function useSFApi() {
  const { API } = useApp();
  const base = API.replace('/api', ''); // http://localhost:3001
  return useCallback(async (method, endpoint, body) => {
    const res = await fetch(`${base}${endpoint}`, {
      method,
      headers: body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
      body: body ? (body instanceof FormData ? body : JSON.stringify(body)) : undefined,
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const ct = res.headers.get('content-type') || '';
    return ct.includes('json') ? res.json() : res.text();
  }, [base]);
}

// ── Shared helpers ────────────────────────────────────────────────────────────
function fmtDur(s) {
  if (!s || s < 0) return '0:00';
  const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sec=Math.floor(s%60);
  return h?`${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`:`${m}:${String(sec).padStart(2,'0')}`;
}
function fmtTs(ts) { return ts ? new Date(ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}) : ''; }

// ── Shared UI ─────────────────────────────────────────────────────────────────
function Toast({ msg, type }) {
  if (!msg) return null;
  return <div style={{ position:'fixed',bottom:24,right:24,zIndex:9999,padding:'12px 20px',borderRadius:'var(--radius-lg)',background:type==='error'?'#ef4444':'#10b981',color:'white',fontWeight:600,fontSize:13,boxShadow:'0 4px 20px rgba(0,0,0,0.4)' }}>{msg}</div>;
}

function Modal({ open, onClose, title, children, width=520 }) {
  if (!open) return null;
  return (
    <div style={{ position:'fixed',inset:0,zIndex:1000,background:'rgba(0,0,0,0.7)',display:'flex',alignItems:'center',justifyContent:'center',padding:24 }} onClick={onClose}>
      <div style={{ background:'var(--bg-secondary)',border:'1px solid var(--border)',borderRadius:'var(--radius-lg)',width:'100%',maxWidth:width,maxHeight:'90vh',overflowY:'auto',boxShadow:'0 20px 60px rgba(0,0,0,0.6)' }} onClick={e=>e.stopPropagation()}>
        <div style={{ display:'flex',alignItems:'center',justifyContent:'space-between',padding:'18px 24px',borderBottom:'1px solid var(--border)' }}>
          <div style={{ fontWeight:700,fontSize:16 }}>{title}</div>
          <button onClick={onClose} style={{ background:'none',border:'none',color:'var(--text-muted)',cursor:'pointer',padding:4 }}><X size={18}/></button>
        </div>
        <div style={{ padding:24 }}>{children}</div>
      </div>
    </div>
  );
}

function Field({ label, children, hint }) {
  return (
    <div style={{ marginBottom:16 }}>
      <label style={{ display:'block',fontSize:11,fontWeight:700,color:'var(--text-muted)',letterSpacing:1,textTransform:'uppercase',marginBottom:6 }}>{label}</label>
      {children}
      {hint && <div style={{ fontSize:11,color:'var(--text-muted)',marginTop:4 }}>{hint}</div>}
    </div>
  );
}

const inp = { width:'100%',padding:'9px 12px',background:'var(--bg-tertiary)',border:'1px solid var(--border)',borderRadius:'var(--radius)',color:'var(--text-primary)',fontSize:13,outline:'none',boxSizing:'border-box' };

function useToast() {
  const [toast, setToast] = useState(null);
  const notify = useCallback((msg, err=false) => { setToast({msg,type:err?'error':'success'}); setTimeout(()=>setToast(null),3500); }, []);
  return [toast, notify];
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
function Dashboard({ call, onTabChange }) {
  const [status, setStatus] = useState(null);
  useEffect(() => { call('GET','/api/sf/status').then(setStatus).catch(()=>{}); }, []);
  const stats = [
    { icon:'📺', label:'Channels',    val:status?.channelCount??'—',                                             tab:'channels'  },
    { icon:'🎬', label:'Media Items', val:status?.mediaCount!=null?status.mediaCount.toLocaleString():'—',       tab:'libraries' },
    { icon:'📡', label:'Live Streams',val:status?.streamCount??'—',                                              tab:'streams'   },
    { icon:'📅', label:'EPG Channels',val:status?.epgChannelCount??'—',                                          tab:'epg'       },
  ];
  return (
    <div>
      <div style={{ display:'flex',alignItems:'center',gap:10,marginBottom:24,padding:'10px 14px',background:'rgba(16,185,129,0.08)',border:'1px solid rgba(16,185,129,0.2)',borderRadius:'var(--radius-lg)' }}>
        <div style={{ width:8,height:8,borderRadius:'50%',background:'#10b981',boxShadow:'0 0 8px #10b981' }}/>
        <span style={{ fontSize:13,color:'#10b981',fontWeight:600 }}>StreamForge engine running inside Orion</span>
        {status && <span style={{ fontSize:11,color:'var(--text-muted)',marginLeft:8 }}>· {status.hwEncoder} · ffmpeg ready</span>}
      </div>
      <div style={{ display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:16,marginBottom:28 }}>
        {stats.map(c=>(
          <div key={c.label} onClick={()=>onTabChange(c.tab)} style={{ background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:'var(--radius-lg)',padding:'20px 24px',cursor:'pointer',transition:'all 0.2s' }}
            onMouseEnter={e=>{e.currentTarget.style.borderColor='var(--border-accent)';e.currentTarget.style.transform='translateY(-2px)'}}
            onMouseLeave={e=>{e.currentTarget.style.borderColor='var(--border)';e.currentTarget.style.transform=''}}>
            <div style={{ fontSize:28,marginBottom:8 }}>{c.icon}</div>
            <div style={{ fontSize:28,fontWeight:800,marginBottom:4 }}>{c.val}</div>
            <div style={{ fontSize:12,color:'var(--text-muted)' }}>{c.label}</div>
          </div>
        ))}
      </div>
      <div style={{ display:'grid',gridTemplateColumns:'1fr 1fr',gap:16 }}>
        <div style={{ background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:'var(--radius-lg)',padding:20 }}>
          <div style={{ fontWeight:700,fontSize:14,marginBottom:16 }}>⚡ Quick Actions</div>
          {[
            {label:'Create a Channel',    icon:<Plus size={14}/>,    tab:'channels'},
            {label:'Build AI Schedule',   icon:<Bot size={14}/>,     tab:'ai'},
            {label:'Import EPG Data',     icon:<Calendar size={14}/>,tab:'epg'},
            {label:'Add Live Stream',     icon:<Radio size={14}/>,   tab:'streams'},
            {label:'Watch Live TV',       icon:<Monitor size={14}/>, tab:'watch'},
          ].map(a=>(
            <div key={a.label} onClick={()=>onTabChange(a.tab)} style={{ display:'flex',alignItems:'center',gap:10,padding:'10px 12px',borderRadius:'var(--radius)',cursor:'pointer',marginBottom:4,transition:'background 0.15s' }}
              onMouseEnter={e=>e.currentTarget.style.background='var(--bg-hover)'}
              onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
              <span style={{ color:'var(--accent)' }}>{a.icon}</span>
              <span style={{ fontSize:13 }}>{a.label}</span>
              <ChevronRight size={12} style={{ marginLeft:'auto',color:'var(--text-muted)' }}/>
            </div>
          ))}
        </div>
        <div style={{ background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:'var(--radius-lg)',padding:20 }}>
          <div style={{ fontWeight:700,fontSize:14,marginBottom:16 }}>🔗 Output URLs</div>
          {[
            { label:'M3U Playlist', url:'http://localhost:3001/sf/iptv.m3u' },
            { label:'XMLTV EPG',    url:'http://localhost:3001/sf/xmltv.xml' },
          ].map(u=>(
            <div key={u.label} style={{ marginBottom:14 }}>
              <div style={{ fontSize:11,color:'var(--text-muted)',fontWeight:700,letterSpacing:0.5,marginBottom:4 }}>{u.label}</div>
              <div style={{ display:'flex',gap:8 }}>
                <code style={{ flex:1,fontSize:11,padding:'6px 10px',background:'var(--bg-tertiary)',border:'1px solid var(--border)',borderRadius:'var(--radius)',color:'var(--accent)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' }}>{u.url}</code>
                <button onClick={()=>navigator.clipboard.writeText(u.url)} style={{ padding:'6px 10px',background:'var(--bg-tertiary)',border:'1px solid var(--border)',borderRadius:'var(--radius)',color:'var(--text-muted)',cursor:'pointer',fontSize:11,flexShrink:0 }}>Copy</button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Channels ──────────────────────────────────────────────────────────────────
function Channels({ call, onWatch, onPlayout }) {
  const [channels,setChannels]=useState([]);
  const [streams,setStreams]=useState([]);
  const [epgChannels,setEpgChannels]=useState([]);
  const [modal,setModal]=useState(false);
  const [editing,setEditing]=useState(null);
  const [form,setForm]=useState({num:'',name:'',group:'',logo:'',epgChannelId:'',liveStreamId:''});
  const [toast,notify]=useToast();

  const load=useCallback(()=>{ Promise.all([call('GET','/api/sf/channels'),call('GET','/api/sf/streams'),call('GET','/api/sf/epg')]).then(([chs,sts,epg])=>{setChannels(chs);setStreams(sts);setEpgChannels(epg.channels||[]);}).catch(()=>{}); },[call]);
  useEffect(()=>{load();},[load]);

  const openNew=()=>{ setEditing(null);setForm({num:channels.length?Math.max(...channels.map(c=>c.num||0))+1:1,name:'',group:'',logo:'',epgChannelId:'',liveStreamId:''});setModal(true); };
  const openEdit=ch=>{ setEditing(ch);setForm({num:ch.num||'',name:ch.name||'',group:ch.group||'',logo:ch.logo||'',epgChannelId:ch.epgChannelId||'',liveStreamId:ch.liveStreamId||''});setModal(true); };
  const save=async()=>{ if(!form.name.trim()){notify('Channel name required',true);return;} try{ const p={...form,num:parseInt(form.num)||undefined,liveStreamId:form.liveStreamId||null}; if(editing)await call('PUT',`/api/sf/channels/${editing.id}`,p);else await call('POST','/api/sf/channels',p); notify('✅ Channel saved');setModal(false);load(); }catch(e){notify(e.message,true);} };
  const del=async(id,name)=>{ if(!window.confirm(`Delete "${name}"?`))return; await call('DELETE',`/api/sf/channels/${id}`);notify('Deleted');load(); };

  return (
    <div>
      <Toast {...toast} />
      <div style={{ display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:20 }}>
        <div style={{ fontSize:13,color:'var(--text-muted)' }}>{channels.length} channels</div>
        <div style={{ display:'flex',gap:8 }}>
          <button onClick={load} style={{ padding:'7px 12px',background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:'var(--radius)',color:'var(--text-muted)',cursor:'pointer',display:'flex',alignItems:'center',gap:6,fontSize:12 }}><RefreshCw size={13}/> Refresh</button>
          <button onClick={openNew} style={{ padding:'7px 14px',background:'var(--accent)',color:'white',border:'none',borderRadius:'var(--radius)',fontWeight:600,cursor:'pointer',display:'flex',alignItems:'center',gap:6,fontSize:12 }}><Plus size={13}/> New Channel</button>
        </div>
      </div>
      {channels.length===0
        ? <div className="empty-state"><div className="empty-state-icon">📺</div><h3>No channels yet</h3><p>Create your first IPTV channel.</p><button className="btn btn-primary" onClick={openNew}><Plus size={14}/> Create Channel</button></div>
        : <div style={{ display:'flex',flexDirection:'column',gap:8 }}>
            {channels.map(ch=>(
              <div key={ch.id} style={{ display:'flex',alignItems:'center',gap:16,padding:'14px 18px',background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:'var(--radius-lg)',transition:'border-color 0.2s' }}
                onMouseEnter={e=>e.currentTarget.style.borderColor='var(--border-accent)'} onMouseLeave={e=>e.currentTarget.style.borderColor='var(--border)'}>
                <div style={{ width:44,height:44,borderRadius:'var(--radius)',background:'var(--bg-tertiary)',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0,overflow:'hidden',fontSize:18,fontWeight:700,color:'var(--accent)' }}>
                  {ch.logo?<img src={ch.logo} alt="" style={{ width:'100%',height:'100%',objectFit:'contain' }} onError={e=>e.target.style.display='none'}/>:ch.num||'📺'}
                </div>
                <div style={{ flex:1,minWidth:0 }}>
                  <div style={{ fontWeight:700,fontSize:15 }}>{ch.num} — {ch.name}</div>
                  <div style={{ fontSize:12,color:'var(--text-muted)',marginTop:2,display:'flex',gap:10 }}>
                    {ch.group&&<span>{ch.group}</span>}
                    {ch.liveStreamId?<span style={{ color:'#f59e0b' }}>📡 24/7 Live</span>:<span>{(ch.playout||[]).length} items in queue</span>}
                    {ch.epgChannelId&&<span style={{ color:'var(--accent)' }}>📅 EPG linked</span>}
                  </div>
                </div>
                <div style={{ display:'flex',gap:6,flexShrink:0 }}>
                  <button onClick={()=>onWatch(ch.id)} style={{ padding:'6px 12px',background:'var(--bg-tertiary)',border:'1px solid var(--border)',borderRadius:'var(--radius)',color:'var(--text-secondary)',cursor:'pointer',fontSize:12,display:'flex',alignItems:'center',gap:5 }}><Monitor size={12}/> Watch</button>
                  <button onClick={()=>onPlayout(ch.id)} style={{ padding:'6px 12px',background:'var(--bg-tertiary)',border:'1px solid var(--border)',borderRadius:'var(--radius)',color:'var(--text-secondary)',cursor:'pointer',fontSize:12,display:'flex',alignItems:'center',gap:5 }}><List size={12}/> Playout</button>
                  <button onClick={()=>openEdit(ch)} style={{ padding:'6px 10px',background:'var(--bg-tertiary)',border:'1px solid var(--border)',borderRadius:'var(--radius)',color:'var(--text-secondary)',cursor:'pointer' }}><Edit2 size={13}/></button>
                  <button onClick={()=>del(ch.id,ch.name)} style={{ padding:'6px 10px',background:'rgba(239,68,68,0.08)',border:'1px solid rgba(239,68,68,0.2)',borderRadius:'var(--radius)',color:'#ef4444',cursor:'pointer' }}><Trash2 size={13}/></button>
                </div>
              </div>
            ))}
          </div>
      }
      <Modal open={modal} onClose={()=>setModal(false)} title={editing?`Edit: ${editing.name}`:'New Channel'}>
        <Field label="Channel Number"><input style={inp} type="number" value={form.num} onChange={e=>setForm(f=>({...f,num:e.target.value}))}/></Field>
        <Field label="Channel Name"><input style={inp} value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))}/></Field>
        <Field label="Group"><input style={inp} value={form.group} onChange={e=>setForm(f=>({...f,group:e.target.value}))} placeholder="News, Sports, Entertainment…"/></Field>
        <Field label="Logo URL"><input style={inp} value={form.logo} onChange={e=>setForm(f=>({...f,logo:e.target.value}))} placeholder="https://…"/></Field>
        <Field label="EPG Channel ID"><select style={inp} value={form.epgChannelId} onChange={e=>setForm(f=>({...f,epgChannelId:e.target.value}))}><option value="">— None —</option>{epgChannels.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        <Field label="24/7 Live Stream" hint="Plays this stream continuously — no playout queue needed"><select style={inp} value={form.liveStreamId} onChange={e=>setForm(f=>({...f,liveStreamId:e.target.value}))}><option value="">— None (use playout) —</option>{streams.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
        <div style={{ display:'flex',gap:10,marginTop:8 }}>
          <button onClick={()=>setModal(false)} style={{ flex:1,padding:'10px',background:'var(--bg-tertiary)',border:'1px solid var(--border)',borderRadius:'var(--radius)',color:'var(--text-secondary)',cursor:'pointer',fontWeight:600 }}>Cancel</button>
          <button onClick={save} style={{ flex:2,padding:'10px',background:'var(--accent)',color:'white',border:'none',borderRadius:'var(--radius)',fontWeight:700,cursor:'pointer' }}>Save Channel</button>
        </div>
      </Modal>
    </div>
  );
}

// ── Playout Builder ───────────────────────────────────────────────────────────
function PlayoutBuilder({ call, initialChannelId }) {
  const [channels,setChannels]=useState([]);
  const [channelId,setChannelId]=useState(initialChannelId||'');
  const [queue,setQueue]=useState([]);
  const [streams,setStreams]=useState([]);
  const [mediaItems,setMediaItems]=useState([]);
  const [search,setSearch]=useState('');
  const [saving,setSaving]=useState(false);
  const [toast,notify]=useToast();

  useEffect(()=>{ Promise.all([call('GET','/api/sf/channels'),call('GET','/api/sf/streams'),call('GET','/api/sf/media?limit=500')]).then(([chs,sts,med])=>{setChannels(chs);setStreams(sts);setMediaItems(med.items||med);}).catch(()=>{}); },[call]);
  useEffect(()=>{ if(!channelId)return; call('GET',`/api/sf/channels/${channelId}/playout`).then(q=>setQueue(q||[])).catch(()=>{}); },[channelId,call]);

  const save=async()=>{ if(!channelId)return; setSaving(true); try{ await call('PUT',`/api/sf/channels/${channelId}/playout`,queue);notify('✅ Playout saved'); }catch(e){notify(e.message,true);} setSaving(false); };
  const addMedia=item=>{ setQueue(q=>[...q,{mediaId:item.id,item}]);notify(`Added: ${item.title}`); };
  const addStream=stream=>{ setQueue(q=>[...q,{streamId:stream.id,duration:3600,_stream:stream}]);notify(`Added: ${stream.name}`); };
  const remove=i=>setQueue(q=>q.filter((_,idx)=>idx!==i));
  const moveUp=i=>{ if(i===0)return; setQueue(q=>{const a=[...q];[a[i-1],a[i]]=[a[i],a[i-1]];return a;}); };
  const moveDown=i=>{ if(i===queue.length-1)return; setQueue(q=>{const a=[...q];[a[i],a[i+1]]=[a[i+1],a[i]];return a;}); };

  const totalDur = queue.reduce((s,b)=>s+(b.streamId?(b.duration||0):(b.item?.duration||0)),0);
  const filtered = mediaItems.filter(m=>!search||m.title?.toLowerCase().includes(search.toLowerCase()));
  const movies = filtered.filter(m=>m.type==='movie');
  const musicVideos = filtered.filter(m=>m.type==='musicvideo');
  const musicTracks = filtered.filter(m=>m.type==='music');
  const showMap = {};
  filtered.filter(m=>m.type==='episode').forEach(ep=>{ const k=ep.title; if(!showMap[k])showMap[k]=[]; showMap[k].push(ep); });

  return (
    <div>
      <Toast {...toast}/>
      <div style={{ display:'flex',gap:16,alignItems:'center',marginBottom:20,flexWrap:'wrap' }}>
        <select style={{ ...inp,maxWidth:300 }} value={channelId} onChange={e=>setChannelId(e.target.value)}>
          <option value="">— Select a channel —</option>
          {channels.map(c=><option key={c.id} value={c.id}>{c.num} — {c.name}</option>)}
        </select>
        {channelId&&<>
          <span style={{ fontSize:12,color:'var(--text-muted)' }}>{queue.length} items · {fmtDur(totalDur)}</span>
          <button onClick={save} disabled={saving} style={{ padding:'7px 14px',background:'var(--accent)',color:'white',border:'none',borderRadius:'var(--radius)',fontWeight:600,cursor:'pointer',display:'flex',alignItems:'center',gap:6,fontSize:12,marginLeft:'auto' }}><Save size={13}/>{saving?'Saving…':'Save Playout'}</button>
        </>}
      </div>
      {!channelId
        ? <div className="empty-state"><div className="empty-state-icon">▶️</div><h3>Select a channel</h3><p>Choose a channel above to build its playout queue.</p></div>
        : <div style={{ display:'grid',gridTemplateColumns:'1fr 360px',gap:20 }}>
            <div>
              <div style={{ fontWeight:700,fontSize:13,color:'var(--text-muted)',marginBottom:12,textTransform:'uppercase',letterSpacing:1 }}>Playout Queue</div>
              {queue.length===0
                ? <div style={{ padding:'48px 24px',textAlign:'center',border:'2px dashed var(--border)',borderRadius:'var(--radius-lg)',color:'var(--text-muted)' }}><div style={{ fontSize:32,marginBottom:8 }}>▶️</div><div>Add media from the browser →</div></div>
                : <div style={{ display:'flex',flexDirection:'column',gap:4 }}>
                    {queue.map((b,i)=>(
                      <div key={i} style={{ display:'flex',alignItems:'center',gap:10,padding:'10px 14px',background:'var(--bg-card)',border:`1px solid ${b.streamId?'rgba(245,158,11,0.3)':'var(--border)'}`,borderRadius:'var(--radius)' }}>
                        <span style={{ fontSize:18,color:'var(--text-muted)',flexShrink:0 }}>⠿</span>
                        <span style={{ fontSize:12,fontWeight:700,color:'var(--text-muted)',minWidth:28 }}>{i+1}</span>
                        {b.streamId
                          ? <span style={{ flex:1,fontSize:13,color:'#f59e0b' }}>📡 {b._stream?.name||b.stream?.name||'Live Stream'}</span>
                          : <span style={{ flex:1,fontSize:13,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' }}>
                              {b.item?.season&&<span style={{ color:'var(--accent)',fontSize:11,marginRight:6 }}>S{String(b.item.season).padStart(2,'0')}E{String(b.item.episode||0).padStart(2,'0')}</span>}
                      {(b.item?.type==='musicvideo'||b.item?.type==='music')&&<span style={{ fontSize:11,marginRight:4 }}>{b.item.type==='music'?'🎶':'🎵'}</span>}
                              {b.item?.title||b.mediaId}
                            </span>
                        }
                        <span style={{ fontSize:11,color:'var(--text-muted)',flexShrink:0 }}>{fmtDur(b.streamId?(b.duration||0):(b.item?.duration||0))}</span>
                        <div style={{ display:'flex',gap:2 }}>
                          <button onClick={()=>moveUp(i)} style={{ padding:'2px 6px',background:'none',border:'none',color:'var(--text-muted)',cursor:'pointer',fontSize:14 }}>↑</button>
                          <button onClick={()=>moveDown(i)} style={{ padding:'2px 6px',background:'none',border:'none',color:'var(--text-muted)',cursor:'pointer',fontSize:14 }}>↓</button>
                          <button onClick={()=>remove(i)} style={{ padding:'4px 7px',background:'none',border:'none',color:'#ef4444',cursor:'pointer' }}><X size={12}/></button>
                        </div>
                      </div>
                    ))}
                  </div>
              }
            </div>
            <div style={{ background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:'var(--radius-lg)',overflow:'hidden',display:'flex',flexDirection:'column',maxHeight:600 }}>
              <div style={{ padding:'14px 16px',borderBottom:'1px solid var(--border)' }}>
                <div style={{ fontWeight:700,fontSize:13,marginBottom:10 }}>Add to Queue</div>
                <input style={{ ...inp,fontSize:12 }} value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search media…"/>
              </div>
              <div style={{ overflowY:'auto',flex:1,padding:12 }}>
                {streams.length>0&&<><div style={{ fontSize:10,fontWeight:700,color:'var(--text-muted)',letterSpacing:1,marginBottom:6 }}>LIVE STREAMS</div>
                  {streams.map(s=><div key={s.id} onClick={()=>addStream(s)} style={{ display:'flex',alignItems:'center',gap:10,padding:'7px 10px',borderRadius:'var(--radius)',cursor:'pointer',marginBottom:3,transition:'background 0.1s' }} onMouseEnter={e=>e.currentTarget.style.background='rgba(245,158,11,0.08)'} onMouseLeave={e=>e.currentTarget.style.background='transparent'}><span>📡</span><span style={{ flex:1,fontSize:12,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' }}>{s.name}</span><Plus size={12} style={{ color:'var(--text-muted)' }}/></div>)}
                  <div style={{ borderBottom:'1px solid var(--border)',margin:'8px 0' }}/></>
                }
                {movies.length>0&&<><div style={{ fontSize:10,fontWeight:700,color:'var(--text-muted)',letterSpacing:1,marginBottom:6 }}>MOVIES</div>
                  {movies.slice(0,50).map(m=><div key={m.id} onClick={()=>addMedia(m)} style={{ display:'flex',alignItems:'center',gap:10,padding:'7px 10px',borderRadius:'var(--radius)',cursor:'pointer',marginBottom:3,transition:'background 0.1s' }} onMouseEnter={e=>e.currentTarget.style.background='var(--bg-hover)'} onMouseLeave={e=>e.currentTarget.style.background='transparent'}><span>🎬</span><span style={{ flex:1,fontSize:12,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' }}>{m.title}{m.year?` (${m.year})`:''}</span><span style={{ fontSize:10,color:'var(--text-muted)',flexShrink:0 }}>{fmtDur(m.duration)}</span></div>)}</>
                }
                {Object.keys(showMap).length>0&&<><div style={{ fontSize:10,fontWeight:700,color:'var(--text-muted)',letterSpacing:1,marginBottom:6,marginTop:8 }}>TV SHOWS</div>
                  {Object.entries(showMap).slice(0,30).map(([show,eps])=>(
                    <details key={show} style={{ marginBottom:4 }}>
                      <summary style={{ padding:'7px 10px',borderRadius:'var(--radius)',cursor:'pointer',fontSize:12,fontWeight:600,listStyle:'none',display:'flex',alignItems:'center',gap:6 }} onMouseEnter={e=>e.currentTarget.style.background='var(--bg-hover)'} onMouseLeave={e=>e.currentTarget.style.background='transparent'}><span>📺</span><span style={{ flex:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' }}>{show}</span><span style={{ fontSize:10,color:'var(--text-muted)' }}>{eps.length} eps</span></summary>
                      <div style={{ paddingLeft:16,marginTop:2 }}>
                        {eps.map(ep=><div key={ep.id} onClick={()=>addMedia(ep)} style={{ display:'flex',alignItems:'center',gap:8,padding:'5px 10px',borderRadius:'var(--radius)',cursor:'pointer',marginBottom:2,transition:'background 0.1s' }} onMouseEnter={e=>e.currentTarget.style.background='var(--bg-hover)'} onMouseLeave={e=>e.currentTarget.style.background='transparent'}><span style={{ fontSize:10,color:'var(--accent)',minWidth:50 }}>S{String(ep.season||1).padStart(2,'0')}E{String(ep.episode||0).padStart(2,'0')}</span><span style={{ flex:1,fontSize:11,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' }}>{ep.title}</span><Plus size={11} style={{ color:'var(--text-muted)',flexShrink:0 }}/></div>)}
                      </div>
                    </details>
                  ))}</>
                }
                {musicVideos.length>0&&<><div style={{ borderBottom:'1px solid var(--border)',margin:'8px 0' }}/><div style={{ fontSize:10,fontWeight:700,color:'var(--text-muted)',letterSpacing:1,marginBottom:6 }}>MUSIC VIDEOS</div>
                  {musicVideos.slice(0,50).map(m=><div key={m.id} onClick={()=>addMedia(m)} style={{ display:'flex',alignItems:'center',gap:10,padding:'7px 10px',borderRadius:'var(--radius)',cursor:'pointer',marginBottom:3,transition:'background 0.1s' }} onMouseEnter={e=>e.currentTarget.style.background='var(--bg-hover)'} onMouseLeave={e=>e.currentTarget.style.background='transparent'}><span>🎵</span><span style={{ flex:1,fontSize:12,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' }}>{m.artist?`${m.artist} — `:''}{m.title}</span><span style={{ fontSize:10,color:'var(--text-muted)',flexShrink:0 }}>{fmtDur(m.duration)}</span></div>)}</>
                }
                {musicTracks.length>0&&<><div style={{ borderBottom:'1px solid var(--border)',margin:'8px 0' }}/><div style={{ fontSize:10,fontWeight:700,color:'var(--text-muted)',letterSpacing:1,marginBottom:6 }}>MUSIC / AUDIO</div>
                  {musicTracks.slice(0,50).map(m=><div key={m.id} onClick={()=>addMedia(m)} style={{ display:'flex',alignItems:'center',gap:10,padding:'7px 10px',borderRadius:'var(--radius)',cursor:'pointer',marginBottom:3,transition:'background 0.1s' }} onMouseEnter={e=>e.currentTarget.style.background='var(--bg-hover)'} onMouseLeave={e=>e.currentTarget.style.background='transparent'}><span>🎶</span><span style={{ flex:1,fontSize:12,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' }}>{m.artist?`${m.artist} — `:''}{m.title}{m.album?` (${m.album})`:''}</span><span style={{ fontSize:10,color:'var(--text-muted)',flexShrink:0 }}>{fmtDur(m.duration)}</span></div>)}</>
                }
              </div>
            </div>
          </div>
      }
    </div>
  );
}

// ── Live Streams ──────────────────────────────────────────────────────────────
function LiveStreams({ call }) {
  const [streams,setStreams]=useState([]);
  const [modal,setModal]=useState(false);
  const [editing,setEditing]=useState(null);
  const [form,setForm]=useState({name:'',url:'',group:'',logo:''});
  const [resolveUrl,setResolveUrl]=useState('');
  const [resolving,setResolving]=useState(false);
  const [toast,notify]=useToast();

  const load=()=>call('GET','/api/sf/streams').then(setStreams).catch(()=>{});
  useEffect(()=>{load();},[]);

  const save=async()=>{ if(!form.name.trim()||!form.url.trim()){notify('Name and URL required',true);return;} try{ if(editing)await call('PUT',`/api/sf/streams/${editing.id}`,form);else await call('POST','/api/sf/streams',form);notify('✅ Stream saved');setModal(false);load(); }catch(e){notify(e.message,true);} };
  const del=async(id,name)=>{ if(!window.confirm(`Delete "${name}"?`))return; await call('DELETE',`/api/sf/streams/${id}`);notify('Deleted');load(); };
  const resolve=async()=>{ if(!resolveUrl)return; setResolving(true); try{ const r=await call('POST','/api/sf/streams/resolve',{url:resolveUrl}); if(r.streamUrl){setForm(f=>({...f,url:r.streamUrl}));notify('✅ Stream URL extracted');}else notify('Could not find a stream at that URL',true); }catch(e){notify(e.message,true);} setResolving(false); };

  return (
    <div>
      <Toast {...toast}/>
      <div style={{ display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:20 }}>
        <div style={{ fontSize:13,color:'var(--text-muted)' }}>{streams.length} streams</div>
        <button onClick={()=>{setEditing(null);setForm({name:'',url:'',group:'',logo:''});setModal(true);}} style={{ padding:'7px 14px',background:'var(--accent)',color:'white',border:'none',borderRadius:'var(--radius)',fontWeight:600,cursor:'pointer',display:'flex',alignItems:'center',gap:6,fontSize:12 }}><Plus size={13}/> Add Stream</button>
      </div>
      {streams.length===0
        ? <div className="empty-state"><div className="empty-state-icon">📡</div><h3>No live streams yet</h3><p>Add HLS, MPEG-TS, or web stream URLs.</p></div>
        : <div style={{ display:'flex',flexDirection:'column',gap:8 }}>
            {streams.map(s=>(
              <div key={s.id} style={{ display:'flex',alignItems:'center',gap:14,padding:'14px 18px',background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:'var(--radius-lg)',transition:'border-color 0.2s' }} onMouseEnter={e=>e.currentTarget.style.borderColor='var(--border-accent)'} onMouseLeave={e=>e.currentTarget.style.borderColor='var(--border)'}>
                <span style={{ fontSize:20,flexShrink:0 }}>📡</span>
                <div style={{ flex:1,minWidth:0 }}><div style={{ fontWeight:700,fontSize:14 }}>{s.name}</div><div style={{ fontSize:11,color:'var(--text-muted)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',marginTop:2 }}>{s.url}</div></div>
                <div style={{ display:'flex',gap:6 }}>
                  <button onClick={()=>{setEditing(s);setForm({name:s.name,url:s.url,group:s.group||'',logo:s.logo||''});setModal(true);}} style={{ padding:'6px 10px',background:'var(--bg-tertiary)',border:'1px solid var(--border)',borderRadius:'var(--radius)',color:'var(--text-secondary)',cursor:'pointer' }}><Edit2 size={13}/></button>
                  <button onClick={()=>del(s.id,s.name)} style={{ padding:'6px 10px',background:'rgba(239,68,68,0.08)',border:'1px solid rgba(239,68,68,0.2)',borderRadius:'var(--radius)',color:'#ef4444',cursor:'pointer' }}><Trash2 size={13}/></button>
                </div>
              </div>
            ))}
          </div>
      }
      <Modal open={modal} onClose={()=>setModal(false)} title={editing?`Edit: ${editing.name}`:'Add Live Stream'}>
        <div style={{ marginBottom:20,padding:'14px 16px',background:'rgba(99,102,241,0.06)',border:'1px solid rgba(99,102,241,0.2)',borderRadius:'var(--radius)' }}>
          <div style={{ fontSize:12,fontWeight:700,color:'var(--accent)',marginBottom:8 }}>🔍 URL Resolver — extract stream from a website</div>
          <div style={{ display:'flex',gap:8 }}><input style={{ ...inp,flex:1,fontSize:12 }} value={resolveUrl} onChange={e=>setResolveUrl(e.target.value)} placeholder="Paste website URL…"/><button onClick={resolve} disabled={resolving} style={{ padding:'8px 14px',background:'var(--accent)',color:'white',border:'none',borderRadius:'var(--radius)',cursor:'pointer',fontWeight:600,fontSize:12,flexShrink:0 }}>{resolving?'⏳':'Extract'}</button></div>
        </div>
        <Field label="Stream Name"><input style={inp} value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))} placeholder="e.g. ABC News 24/7"/></Field>
        <Field label="Stream URL" hint="HLS (.m3u8), MPEG-TS, or direct URL"><input style={inp} value={form.url} onChange={e=>setForm(f=>({...f,url:e.target.value}))} placeholder="https://…"/></Field>
        <Field label="Group"><input style={inp} value={form.group} onChange={e=>setForm(f=>({...f,group:e.target.value}))} placeholder="News, Sports…"/></Field>
        <div style={{ display:'flex',gap:10 }}><button onClick={()=>setModal(false)} style={{ flex:1,padding:'10px',background:'var(--bg-tertiary)',border:'1px solid var(--border)',borderRadius:'var(--radius)',color:'var(--text-secondary)',cursor:'pointer',fontWeight:600 }}>Cancel</button><button onClick={save} style={{ flex:2,padding:'10px',background:'var(--accent)',color:'white',border:'none',borderRadius:'var(--radius)',fontWeight:700,cursor:'pointer' }}>Save Stream</button></div>
      </Modal>
    </div>
  );
}

// ── EPG ───────────────────────────────────────────────────────────────────────
function EPGManager({ call }) {
  const [epg,setEpg]=useState({channels:[],programs:[],importedAt:null});
  const [importUrl,setImportUrl]=useState('');
  const [importing,setImporting]=useState(false);
  const [browse,setBrowse]=useState(null);
  const [toast,notify]=useToast();

  const load=()=>call('GET','/api/sf/epg').then(setEpg).catch(()=>{});
  useEffect(()=>{load();},[]);

  const importEpg=async()=>{ if(!importUrl.trim())return; setImporting(true); try{ const r=await call('POST','/api/sf/epg/import',{url:importUrl});notify(`✅ Imported ${r.channels} channels, ${r.programs} programs`);await load(); }catch(e){notify(e.message,true);} setImporting(false); };

  const programs = browse ? epg.programs.filter(p=>p.channel===browse.id).sort((a,b)=>a.start-b.start) : [];

  return (
    <div>
      <Toast {...toast}/>
      <div style={{ background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:'var(--radius-lg)',padding:20,marginBottom:20 }}>
        <div style={{ fontWeight:700,fontSize:14,marginBottom:14 }}>📥 Import EPG (XMLTV)</div>
        <div style={{ display:'flex',gap:10,marginBottom:12 }}>
          <input style={{ ...inp,flex:1 }} value={importUrl} onChange={e=>setImportUrl(e.target.value)} placeholder="XMLTV URL…" onKeyDown={e=>e.key==='Enter'&&importEpg()}/>
          <button onClick={importEpg} disabled={importing} style={{ padding:'9px 16px',background:'var(--accent)',color:'white',border:'none',borderRadius:'var(--radius)',fontWeight:600,cursor:'pointer',flexShrink:0 }}>{importing?'Importing…':'Import'}</button>
        </div>
        {epg.importedAt&&<div style={{ fontSize:12,color:'var(--text-muted)' }}>Last imported: {new Date(epg.importedAt).toLocaleString()} · {epg.channels.length} channels · {epg.programs.length.toLocaleString()} programs</div>}
      </div>
      {epg.channels.length>0&&(
        <div>
          <div style={{ fontWeight:700,fontSize:13,color:'var(--text-muted)',marginBottom:12,textTransform:'uppercase',letterSpacing:1 }}>EPG Channels ({epg.channels.length})</div>
          <div style={{ display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(220px,1fr))',gap:8 }}>
            {epg.channels.map(ch=>(
              <div key={ch.id} onClick={()=>setBrowse(browse?.id===ch.id?null:ch)} style={{ display:'flex',alignItems:'center',gap:12,padding:'10px 14px',background:'var(--bg-card)',border:`1px solid ${browse?.id===ch.id?'var(--accent)':'var(--border)'}`,borderRadius:'var(--radius)',cursor:'pointer',transition:'all 0.15s' }}>
                {ch.logo?<img src={ch.logo} alt="" style={{ width:28,height:28,objectFit:'contain',borderRadius:4 }} onError={e=>e.target.style.display='none'}/>:<span style={{ fontSize:18 }}>📅</span>}
                <div style={{ flex:1,minWidth:0 }}><div style={{ fontSize:13,fontWeight:600,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' }}>{ch.name}</div><div style={{ fontSize:10,color:'var(--text-muted)' }}>{epg.programs.filter(p=>p.channel===ch.id).length} programs</div></div>
              </div>
            ))}
          </div>
          {browse&&(
            <div style={{ marginTop:20,background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:'var(--radius-lg)',overflow:'hidden' }}>
              <div style={{ padding:'14px 18px',borderBottom:'1px solid var(--border)',fontWeight:700,fontSize:14 }}>📅 {browse.name}</div>
              <div style={{ maxHeight:400,overflowY:'auto' }}>
                {programs.length===0?<div style={{ padding:24,color:'var(--text-muted)',textAlign:'center' }}>No programs for this channel.</div>
                  :programs.map((p,i)=><div key={i} style={{ display:'flex',gap:14,padding:'10px 18px',borderBottom:'1px solid rgba(255,255,255,0.04)' }}><span style={{ fontSize:12,color:'var(--accent)',minWidth:50,flexShrink:0 }}>{fmtTs(p.start)}</span><span style={{ fontSize:13,flex:1 }}>{p.title}</span></div>)
                }
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── AI Scheduler ──────────────────────────────────────────────────────────────
function AIScheduler({ call }) {
  const [channels,setChannels]=useState([]);
  const [epgChannels,setEpgChannels]=useState([]);
  const [targetCh,setTargetCh]=useState('');
  const [epgCh,setEpgCh]=useState('');
  const [date,setDate]=useState(new Date().toISOString().slice(0,10));
  const [prompt,setPrompt]=useState('');
  const [building,setBuilding]=useState(false);
  const [results,setResults]=useState(null);
  const [applying,setApplying]=useState(false);
  const [toast,notify]=useToast();

  useEffect(()=>{ Promise.all([call('GET','/api/sf/channels'),call('GET','/api/sf/epg'),call('GET','/api/sf/config')]).then(([chs,epg,cfg])=>{ setChannels(chs);setEpgChannels(epg.channels||[]); }).catch(()=>{}); },[call]);

  const build=async()=>{ if(!targetCh){notify('Select a target channel',true);return;} if(!epgCh){notify('Select an EPG channel',true);return;} setBuilding(true);setResults(null); try{ const r=await call('POST','/api/sf/ai/build-schedule',{channelId:epgCh,epgChannelId:epgCh,date,userPrompt:prompt,targetChannelId:targetCh});setResults({...r,targetCh});notify(`✅ ${r.suggestions?.length||0} items matched`); }catch(e){notify(e.message,true);} setBuilding(false); };
  const apply=async()=>{ if(!results)return; setApplying(true); try{ const r=await call('POST','/api/sf/ai/apply-schedule',{channelId:targetCh,suggestions:results.suggestions});notify(`✅ Added ${r.added} items to playout`);setResults(null); }catch(e){notify(e.message,true);} setApplying(false); };

  return (
    <div>
      <Toast {...toast}/>
      <div style={{ display:'grid',gridTemplateColumns:'1fr 1fr',gap:20,marginBottom:20 }}>
        <Field label="Target Channel — where to put the schedule"><select style={inp} value={targetCh} onChange={e=>setTargetCh(e.target.value)}><option value="">— Select a channel —</option>{channels.filter(c=>!c.liveStreamId).map(c=><option key={c.id} value={c.id}>{c.num} — {c.name}</option>)}</select></Field>
        <Field label="EPG Reference — which channel's guide to match"><select style={inp} value={epgCh} onChange={e=>setEpgCh(e.target.value)}><option value="">— Select EPG channel —</option>{epgChannels.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
      </div>
      <Field label="Date"><input style={{ ...inp,maxWidth:200 }} type="date" value={date} onChange={e=>setDate(e.target.value)}/></Field>
      <Field label="Extra Instructions (optional)"><textarea style={{ ...inp,minHeight:70,resize:'vertical' }} value={prompt} onChange={e=>setPrompt(e.target.value)} placeholder="e.g. At 9pm play a live news stream for 30 minutes"/></Field>
      <button onClick={build} disabled={building} style={{ width:'100%',padding:'12px',background:'var(--accent)',color:'white',border:'none',borderRadius:'var(--radius)',fontWeight:700,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',gap:8,fontSize:14 }}>
        <Bot size={16}/> {building?'Building AI Schedule…':'Build Schedule for This Channel'}
      </button>
      {results&&(
        <div style={{ marginTop:20,background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:'var(--radius-lg)',overflow:'hidden' }}>
          <div style={{ padding:'14px 18px',borderBottom:'1px solid var(--border)',display:'flex',alignItems:'center',justifyContent:'space-between' }}>
            <span style={{ fontWeight:700,fontSize:14 }}>✅ {results.suggestions?.length||0} matched · {results.unmatchedSlots?.length||0} unmatched</span>
            <button onClick={apply} disabled={applying} style={{ padding:'8px 16px',background:'#10b981',color:'white',border:'none',borderRadius:'var(--radius)',fontWeight:700,cursor:'pointer',fontSize:13 }}>{applying?'Applying…':'Apply to Channel →'}</button>
          </div>
          <div style={{ display:'grid',gridTemplateColumns:'1fr 1fr',maxHeight:400,overflow:'hidden' }}>
            <div style={{ borderRight:'1px solid var(--border)',overflowY:'auto',maxHeight:400 }}>
              <div style={{ padding:'8px 14px',fontSize:10,fontWeight:700,color:'#10b981',letterSpacing:1,borderBottom:'1px solid var(--border)' }}>MATCHED ✓</div>
              {(results.suggestions||[]).map((m,i)=><div key={i} style={{ padding:'8px 14px',borderBottom:'1px solid rgba(255,255,255,0.04)',fontSize:12 }}>{m.item?.title||m.title}</div>)}
            </div>
            <div style={{ overflowY:'auto',maxHeight:400 }}>
              <div style={{ padding:'8px 14px',fontSize:10,fontWeight:700,color:'#f59e0b',letterSpacing:1,borderBottom:'1px solid var(--border)' }}>UNMATCHED</div>
              {(results.unmatchedSlots||[]).map((u,i)=><div key={i} style={{ padding:'8px 14px',borderBottom:'1px solid rgba(255,255,255,0.04)',fontSize:12,color:'var(--text-muted)' }}>{u}</div>)}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Libraries ─────────────────────────────────────────────────────────────────
function Libraries({ call }) {
  const [libs,setLibs]=useState([]);
  const [modal,setModal]=useState(false);
  const [form,setForm]=useState({name:'',type:'local',path:'',url:'',token:'',sectionKey:'',parentId:''});
  const [scanning,setScanning]=useState({});
  const [toast,notify]=useToast();

  const load=()=>call('GET','/api/sf/libraries').then(setLibs).catch(()=>{});
  useEffect(()=>{load();},[]);
  const save=async()=>{ try{ await call('POST','/api/sf/libraries',form);notify('✅ Library added');setModal(false);load(); }catch(e){notify(e.message,true);} };
  const scan=async id=>{ setScanning(s=>({...s,[id]:true})); try{ await call('POST',`/api/sf/libraries/${id}/scan`);notify('✅ Scan started');load(); }catch(e){notify(e.message,true);} setScanning(s=>({...s,[id]:false})); };
  const del=async(id,name)=>{ if(!window.confirm(`Delete "${name}"?`))return; await call('DELETE',`/api/sf/libraries/${id}`);notify('Deleted');load(); };

  return (
    <div>
      <Toast {...toast}/>
      <div style={{ display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:20 }}>
        <div style={{ fontSize:13,color:'var(--text-muted)' }}>{libs.length} libraries</div>
        <button onClick={()=>{setForm({name:'',type:'local',path:'',url:'',token:'',sectionKey:'',parentId:''});setModal(true);}} style={{ padding:'7px 14px',background:'var(--accent)',color:'white',border:'none',borderRadius:'var(--radius)',fontWeight:600,cursor:'pointer',display:'flex',alignItems:'center',gap:6,fontSize:12 }}><Plus size={13}/> Add Library</button>
      </div>
      {libs.length===0?<div className="empty-state"><div className="empty-state-icon">📚</div><h3>No libraries yet</h3><p>Add a local folder, Plex, or Jellyfin library to import media.</p></div>
        :<div style={{ display:'flex',flexDirection:'column',gap:8 }}>
          {libs.map(lib=>(
            <div key={lib.id} style={{ display:'flex',alignItems:'center',gap:14,padding:'16px 20px',background:'var(--bg-card)',border:`1px solid ${lib.readonly?'rgba(16,185,129,0.25)':'var(--border)'}`,borderRadius:'var(--radius-lg)' }}>
              <span style={{ fontSize:24,flexShrink:0 }}>{lib.id==='orion-musicvideos'?'🎵':lib.id==='orion-music'?'🎶':lib.type==='orion'?'🎬':lib.type==='plex'?'🟡':lib.type==='jellyfin'?'🪼':'📁'}</span>
              <div style={{ flex:1,minWidth:0 }}>
                <div style={{ fontWeight:700,fontSize:14,display:'flex',alignItems:'center',gap:8 }}>
                  {lib.name}
                  {lib.readonly && <span style={{ fontSize:10,fontWeight:700,padding:'2px 7px',background:'rgba(16,185,129,0.12)',border:'1px solid rgba(16,185,129,0.3)',borderRadius:10,color:'#10b981',letterSpacing:0.5 }}>ORION</span>}
                </div>
                <div style={{ fontSize:12,color:'var(--text-muted)',marginTop:2 }}>
                  {lib.readonly ? lib.note : (lib.path||lib.url||'—')} · <strong style={{ color:'var(--text-secondary)' }}>{(lib.itemCount||0).toLocaleString()}</strong> items
                </div>
              </div>
              <div style={{ display:'flex',gap:6 }}>
                {!lib.readonly && <>
                  <button onClick={()=>scan(lib.id)} disabled={scanning[lib.id]} style={{ padding:'7px 14px',background:'var(--bg-tertiary)',border:'1px solid var(--border)',borderRadius:'var(--radius)',color:'var(--text-secondary)',cursor:'pointer',fontSize:12,display:'flex',alignItems:'center',gap:5 }}><RefreshCw size={12}/>{scanning[lib.id]?'Scanning…':'Scan'}</button>
                  <button onClick={()=>del(lib.id,lib.name)} style={{ padding:'6px 10px',background:'rgba(239,68,68,0.08)',border:'1px solid rgba(239,68,68,0.2)',borderRadius:'var(--radius)',color:'#ef4444',cursor:'pointer' }}><Trash2 size={13}/></button>
                </>}
                {lib.readonly && <span style={{ fontSize:12,color:'var(--text-muted)',padding:'6px 12px' }}>Auto-synced ✓</span>}
              </div>
            </div>
          ))}
        </div>
      }
      <Modal open={modal} onClose={()=>setModal(false)} title="Add Library">
        <div style={{ display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8,marginBottom:20 }}>
          {[{id:'local',icon:'📁',label:'Local Folder'},{id:'plex',icon:'🟡',label:'Plex'},{id:'jellyfin',icon:'🪼',label:'Jellyfin'}].map(t=>(
            <div key={t.id} onClick={()=>setForm(f=>({...f,type:t.id}))} style={{ padding:'12px 14px',borderRadius:'var(--radius)',border:`2px solid ${form.type===t.id?'var(--accent)':'var(--border)'}`,background:form.type===t.id?'rgba(99,102,241,0.08)':'var(--bg-tertiary)',cursor:'pointer',textAlign:'center' }}>
              <div style={{ fontSize:22,marginBottom:4 }}>{t.icon}</div><div style={{ fontSize:12,fontWeight:600 }}>{t.label}</div>
            </div>
          ))}
        </div>
        <Field label="Library Name"><input style={inp} value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))} placeholder="My Movies"/></Field>
        {form.type==='local'&&<Field label="Folder Path" hint="Absolute path on this machine"><input style={inp} value={form.path} onChange={e=>setForm(f=>({...f,path:e.target.value}))} placeholder="C:\Media\Movies or \\server\media"/></Field>}
        {form.type==='plex'&&<><Field label="Plex URL"><input style={inp} value={form.url} onChange={e=>setForm(f=>({...f,url:e.target.value}))} placeholder="http://192.168.x.x:32400"/></Field><Field label="Plex Token"><input style={inp} value={form.token} onChange={e=>setForm(f=>({...f,token:e.target.value}))}/></Field><Field label="Section Key"><input style={inp} value={form.sectionKey} onChange={e=>setForm(f=>({...f,sectionKey:e.target.value}))} placeholder="1"/></Field></>}
        {form.type==='jellyfin'&&<><Field label="Jellyfin URL"><input style={inp} value={form.url} onChange={e=>setForm(f=>({...f,url:e.target.value}))} placeholder="http://192.168.x.x:8096"/></Field><Field label="API Key"><input style={inp} value={form.token} onChange={e=>setForm(f=>({...f,token:e.target.value}))}/></Field></>}
        <div style={{ display:'flex',gap:10,marginTop:8 }}><button onClick={()=>setModal(false)} style={{ flex:1,padding:'10px',background:'var(--bg-tertiary)',border:'1px solid var(--border)',borderRadius:'var(--radius)',color:'var(--text-secondary)',cursor:'pointer',fontWeight:600 }}>Cancel</button><button onClick={save} style={{ flex:2,padding:'10px',background:'var(--accent)',color:'white',border:'none',borderRadius:'var(--radius)',fontWeight:700,cursor:'pointer' }}>Add Library</button></div>
      </Modal>
    </div>
  );
}

// ── Watch ─────────────────────────────────────────────────────────────────────
function Watch({ call, initialChannelId }) {
  const { API } = useApp();
  const base = API.replace('/api','');
  const [channels,setChannels]=useState([]);
  const [activeId,setActiveId]=useState(initialChannelId||'');
  const [nowPlaying,setNowPlaying]=useState(null);
  const [hlsUrl,setHlsUrl]=useState('');
  const videoRef=useRef(null);

  useEffect(()=>{ call('GET','/api/sf/channels').then(setChannels).catch(()=>{}); },[]);
  useEffect(()=>{ if(!activeId)return;
    call('POST',`/api/sf/channels/${activeId}/watch`).then(r=>{ if(r.hlsUrl)setHlsUrl(`${base}${r.hlsUrl}`); }).catch(()=>{});
    call('GET',`/api/sf/channels/${activeId}/now-playing`).then(setNowPlaying).catch(()=>{});
    return ()=>{ call('DELETE',`/api/sf/channels/${activeId}/watch`).catch(()=>{}); };
  },[activeId,base]);

  useEffect(()=>{ if(!hlsUrl||!videoRef.current)return; videoRef.current.src=hlsUrl; videoRef.current.play().catch(()=>{}); },[hlsUrl]);

  return (
    <div style={{ display:'grid',gridTemplateColumns:'280px 1fr',gap:0,minHeight:500,background:'var(--bg-secondary)',borderRadius:'var(--radius-lg)',border:'1px solid var(--border)',overflow:'hidden' }}>
      <div style={{ borderRight:'1px solid var(--border)',overflowY:'auto' }}>
        <div style={{ padding:'12px 16px',borderBottom:'1px solid var(--border)',fontSize:12,fontWeight:700,color:'var(--text-muted)',letterSpacing:1 }}>CHANNELS</div>
        {channels.map(ch=>(
          <div key={ch.id} onClick={()=>setActiveId(ch.id)} style={{ display:'flex',alignItems:'center',gap:12,padding:'12px 16px',cursor:'pointer',borderBottom:'1px solid rgba(255,255,255,0.04)',background:activeId===ch.id?'rgba(99,102,241,0.12)':'transparent',borderLeft:activeId===ch.id?'3px solid var(--accent)':'3px solid transparent',transition:'all 0.15s' }}>
            {ch.logo?<img src={ch.logo} alt="" style={{ width:28,height:28,objectFit:'contain',borderRadius:4 }} onError={e=>e.target.style.display='none'}/>:<span style={{ fontSize:16 }}>📺</span>}
            <div style={{ flex:1,minWidth:0 }}><div style={{ fontSize:13,fontWeight:600,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' }}>{ch.name}</div><div style={{ fontSize:10,color:'var(--text-muted)' }}>{ch.num}</div></div>
          </div>
        ))}
      </div>
      <div style={{ display:'flex',flexDirection:'column',background:'#000' }}>
        {!activeId?<div style={{ flex:1,display:'flex',alignItems:'center',justifyContent:'center',flexDirection:'column',gap:12,color:'rgba(255,255,255,0.3)' }}><Monitor size={48}/><div>Select a channel to start watching</div></div>
          :<>
            <video ref={videoRef} style={{ width:'100%',flex:1,background:'#000',minHeight:300 }} controls autoPlay/>
            {nowPlaying&&<div style={{ padding:'12px 18px',background:'rgba(0,0,0,0.5)',borderTop:'1px solid rgba(255,255,255,0.08)' }}><div style={{ fontSize:13,fontWeight:700 }}>▶ {nowPlaying.title||'Unknown'}</div></div>}
          </>
        }
      </div>
    </div>
  );
}

// ── Settings ──────────────────────────────────────────────────────────────────
function SFSettings({ call }) {
  const [config,setConfig]=useState(null);
  const [saving,setSaving]=useState(false);
  const [toast,notify]=useToast();
  useEffect(()=>{ call('GET','/api/sf/config').then(setConfig).catch(()=>{}); },[]);
  const save=async()=>{ setSaving(true); try{ await call('PUT','/api/sf/config',config);notify('✅ Settings saved'); }catch(e){notify(e.message,true);} setSaving(false); };
  const update=(k,v)=>setConfig(c=>({...c,[k]:v}));
  if(!config) return <div style={{ color:'var(--text-muted)',padding:40,textAlign:'center' }}>Loading…</div>;
  return (
    <div>
      <Toast {...toast}/>
      <div style={{ display:'grid',gridTemplateColumns:'1fr 1fr',gap:20 }}>
        <div style={{ background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:'var(--radius-lg)',padding:20 }}>
          <div style={{ fontWeight:700,fontSize:14,marginBottom:16 }}>⚙️ General</div>
          <Field label="Base URL" hint="Your machine's IP — used in M3U output"><input style={inp} value={config.baseUrl||''} onChange={e=>update('baseUrl',e.target.value)} placeholder="http://192.168.x.x:3001"/></Field>
          <Field label="EPG Days Ahead"><input style={inp} type="number" value={config.epgDaysAhead||7} onChange={e=>update('epgDaysAhead',+e.target.value)} min={1} max={14}/></Field>
          <Field label="Xtream Username"><input style={inp} value={config.xcUser||''} onChange={e=>update('xcUser',e.target.value)}/></Field>
          <Field label="Xtream Password"><input style={inp} value={config.xcPass||''} onChange={e=>update('xcPass',e.target.value)}/></Field>
        </div>
        <div style={{ background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:'var(--radius-lg)',padding:20 }}>
          <div style={{ fontWeight:700,fontSize:14,marginBottom:16 }}>🤖 AI Provider</div>
          <Field label="Provider">
            <select style={inp} value={config.aiProvider||'anthropic'} onChange={e=>update('aiProvider',e.target.value)}>
              <option value="anthropic">Anthropic (Claude)</option>
              <option value="openai">OpenAI (GPT-4)</option>
              <option value="ollama">Ollama (Local LLM)</option>
              <option value="openwebui">Open WebUI</option>
              <option value="custom">Custom Endpoint</option>
            </select>
          </Field>
          {config.aiProvider==='anthropic'&&<Field label="Anthropic API Key"><input style={inp} type="password" value={config.anthropicApiKey||''} onChange={e=>update('anthropicApiKey',e.target.value)} placeholder="sk-ant-…"/></Field>}
          {config.aiProvider==='openai'&&<><Field label="OpenAI API Key"><input style={inp} type="password" value={config.openaiApiKey||''} onChange={e=>update('openaiApiKey',e.target.value)}/></Field><Field label="Model"><input style={inp} value={config.openaiModel||'gpt-4o'} onChange={e=>update('openaiModel',e.target.value)}/></Field></>}
          {config.aiProvider==='ollama'&&<><Field label="Ollama URL"><input style={inp} value={config.ollamaUrl||''} onChange={e=>update('ollamaUrl',e.target.value)}/></Field><Field label="Model"><input style={inp} value={config.ollamaModel||'llama3.2'} onChange={e=>update('ollamaModel',e.target.value)}/></Field></>}
        </div>
        <div style={{ background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:'var(--radius-lg)',padding:20 }}>
          <div style={{ fontWeight:700,fontSize:14,marginBottom:16 }}>🎬 Transcoding</div>
          <Field label="Video Codec">
            <select style={inp} value={config.videoCodec||'copy'} onChange={e=>update('videoCodec',e.target.value)}>
              <option value="copy">Copy (no transcode — best performance)</option>
              <option value="h264">H.264 (transcode)</option>
              <option value="hevc">H.265/HEVC</option>
            </select>
          </Field>
          <Field label="Video Resolution" hint="Leave blank to keep source resolution"><input style={inp} value={config.videoResolution||''} onChange={e=>update('videoResolution',e.target.value)} placeholder="1920x1080 (or leave blank)"/></Field>
          <Field label="Audio Language" hint="ISO 639-2 code (e.g. eng, spa)"><input style={inp} value={config.audioLanguage||'eng'} onChange={e=>update('audioLanguage',e.target.value)}/></Field>
        </div>
        <div style={{ background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:'var(--radius-lg)',padding:20 }}>
          <div style={{ fontWeight:700,fontSize:14,marginBottom:16 }}>📡 HLS Output</div>
          <Field label="Segment Length (seconds)"><input style={inp} type="number" value={config.hlsSegmentSeconds||4} onChange={e=>update('hlsSegmentSeconds',+e.target.value)} min={1} max={30}/></Field>
          <Field label="Playlist Size (segments)"><input style={inp} type="number" value={config.hlsListSize||6} onChange={e=>update('hlsListSize',+e.target.value)} min={2} max={20}/></Field>
          <Field label="Idle Timeout (seconds)"><input style={inp} type="number" value={config.hlsIdleTimeoutSecs||60} onChange={e=>update('hlsIdleTimeoutSecs',+e.target.value)} min={10}/></Field>
        </div>
      </div>
      <div style={{ display:'flex',justifyContent:'flex-end',marginTop:20 }}>
        <button onClick={save} disabled={saving} style={{ padding:'10px 28px',background:'var(--accent)',color:'white',border:'none',borderRadius:'var(--radius)',fontWeight:700,cursor:'pointer',fontSize:14 }}>{saving?'Saving…':'Save Settings'}</button>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
const TABS = [
  { id:'dashboard', icon:<Signal size={14}/>,    label:'Dashboard'       },
  { id:'channels',  icon:<Tv2 size={14}/>,        label:'Channels'        },
  { id:'playout',   icon:<List size={14}/>,        label:'Playout Builder' },
  { id:'streams',   icon:<Radio size={14}/>,       label:'Live Streams'    },
  { id:'epg',       icon:<Calendar size={14}/>,    label:'EPG'             },
  { id:'ai',        icon:<Bot size={14}/>,          label:'AI Scheduler'    },
  { id:'libraries', icon:<Library size={14}/>,     label:'Libraries'       },
  { id:'watch',     icon:<Monitor size={14}/>,      label:'Watch'           },
  { id:'settings',  icon:<Settings size={14}/>,    label:'Settings'        },
];

export default function StreamForgePage() {
  const call = useSFApi();
  const [tab,setTab]=useState('dashboard');
  const [watchId,setWatchId]=useState(null);
  const [playoutId,setPlayoutId]=useState(null);

  const goWatch=id=>{ setWatchId(id); setTab('watch'); };
  const goPlayout=id=>{ setPlayoutId(id); setTab('playout'); };

  return (
    <div className="page">
      <div className="page-header" style={{ paddingBottom:0 }}>
        <div style={{ display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:16 }}>
          <div>
            <div style={{ display:'flex',alignItems:'center',gap:12,marginBottom:6 }}>
              <img
                src="https://raw.githubusercontent.com/rpoltera/streamforge/main/public/logo.png"
                alt="StreamForge"
                style={{ height:52,maxWidth:260,objectFit:'contain',mixBlendMode:'screen',flexShrink:0 }}
                onError={e=>{e.target.style.display='none';}}
              />
              <span style={{ fontSize:11,fontWeight:600,padding:'3px 8px',background:'rgba(16,185,129,0.12)',border:'1px solid rgba(16,185,129,0.3)',borderRadius:20,color:'#10b981',letterSpacing:0.5 }}>BUILT IN</span>
            </div>
            <div className="page-subtitle">IPTV Playout Manager — powered by Orion's transcoding engine</div>
          </div>
        </div>
        <div style={{ display:'flex',gap:2,borderBottom:'1px solid var(--border)',overflowX:'auto' }}>
          {TABS.map(t=>(
            <button key={t.id} onClick={()=>setTab(t.id)} style={{ display:'flex',alignItems:'center',gap:6,padding:'10px 16px',border:'none',cursor:'pointer',background:'transparent',whiteSpace:'nowrap',color:tab===t.id?'var(--accent)':'var(--text-muted)',borderBottom:tab===t.id?'2px solid var(--accent)':'2px solid transparent',fontSize:13,fontWeight:600,transition:'all 0.15s',marginBottom:-1 }}>
              {t.icon} {t.label}
            </button>
          ))}
        </div>
      </div>
      <div style={{ marginTop:24 }}>
        {tab==='dashboard' && <Dashboard  call={call} onTabChange={setTab}/>}
        {tab==='channels'  && <Channels   call={call} onWatch={goWatch} onPlayout={goPlayout}/>}
        {tab==='playout'   && <PlayoutBuilder call={call} initialChannelId={playoutId}/>}
        {tab==='streams'   && <LiveStreams call={call}/>}
        {tab==='epg'       && <EPGManager  call={call}/>}
        {tab==='ai'        && <AIScheduler call={call}/>}
        {tab==='libraries' && <Libraries   call={call}/>}
        {tab==='watch'     && <Watch       call={call} initialChannelId={watchId}/>}
        {tab==='settings'  && <SFSettings  call={call}/>}
      </div>
    </div>
  );
}

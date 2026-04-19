import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useApp } from '../contexts/AppContext';
import {
  Tv2, Radio, Play, Plus, Trash2, Edit2, Save, X, RefreshCw,
  Settings, Library, Calendar, Bot, Monitor, ChevronRight,
  List, Signal, Film, ExternalLink, Zap
} from 'lucide-react';

// ── API — always talks to Orion's own server at /api/sf/* ─────────────────────
// Spectrum basic cable channel names (TV Select / basic tier ~100 channels)
const SPECTRUM_BASIC = new Set([
  // Broadcast networks
  'abc','nbc','cbs','fox','pbs','cw','ion','mynetwork tv','mytv',
  'telemundo','univision','estrella',
  // News
  'cnn','fox news','msnbc','cnbc','hln','cnn international',
  'bbc news','bbc world news','bloomberg television','bloomberg tv',
  'c-span','c-span2','cspan','cspan2','newsmax','one america news','oan',
  'the weather channel','weather channel','weathernation','local now',
  // Sports
  'espn','espn2','espnu','espnews','espn classic','espn news',
  'fox sports 1','fox sports 2','fs1','fs2','nbc sports','nbc sports network',
  'cbs sports network','nfl network','nfl redzone','nba tv',
  'mlb network','mlb strike zone','nhl network','golf channel',
  'tennis channel','olympic channel','big ten network',
  'sec network','acc network','pac-12 network','stadium',
  // Entertainment
  'tbs','tnt','usa network','fx','fxx','amc','ifc','sundance tv',
  'bravo','oxygen','we tv','wetv','lifetime','lifetime movies',
  'lifetime movie network','lmn',
  'hallmark channel','hallmark movies and mysteries','hallmark drama',
  'e! entertainment','e!','comedy central','trutv','tru tv',
  'paramount network','pop tv','tv land','nick at nite',
  'reelz','logo tv','ovation',
  // Lifestyle
  'hgtv','food network','cooking channel','tlc','discovery channel','discovery',
  'animal planet','travel channel','history channel','history','history 2',
  'a&e','biography channel','bio','investigation discovery',
  'national geographic','nat geo','nat geo wild','nat geo adventure',
  'science channel','discovery life','own','magnolia network',
  'diy network','diy','bet her','bet gospel',
  // Kids
  'nickelodeon','nick jr','nicktoons','teennick',
  'cartoon network','adult swim','boomerang',
  'disney channel','disney xd','disney junior','freeform',
  'universal kids','sprout','baby tv',
  // Music / Culture
  'mtv','mtv2','mtv classic','vh1','vh1 classic',
  'bet','bet her','cmt','great american country','gac family','gac living',
  'fuse','palladia','axs tv',
  // Shopping / Other
  'qvc','hsn','jewellery television','jt','evine','shop hq',
  'rfd-tv','ewtn','tbn','hallmark channel',
]);

function normEpgName(name) {
  return (name||'').toLowerCase()
    .replace(/(east|west|hd|sd|4k|uhd|fhd)/gi, '')
    .replace(/[|\-_.[\]()]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function isBasicCableChannel(name) {
  return SPECTRUM_BASIC.has(normEpgName(name));
}

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
  const [channels,setChannels]     = useState([]);
  const [streams,setStreams]       = useState([]);
  const [epgChannels,setEpgChannels] = useState([]);
  const [loading,setLoading]       = useState(true);
  const [modal,setModal]           = useState(false);
  const [editing,setEditing]       = useState(null);
  const [form,setForm]             = useState({num:'',name:'',group:'',logo:'',epgChannelId:'',liveStreamId:'',splashUrl:''});
  const [toast,notify]             = useToast();
  const [orionChannels,setOrionChannels] = useState([]);
  const [iptvSearch,setIptvSearch] = useState('');
  const [showIptvPicker,setShowIptvPicker] = useState(false);
  const [basicCableModal,setBasicCableModal] = useState(false);
  const [basicCableSearch,setBasicCableSearch] = useState('');
  const [selectedBasic,setSelectedBasic] = useState(new Set());
  const [applyingBasic,setApplyingBasic] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      call('GET','/api/sf/channels'),
      call('GET','/api/sf/streams'),
      call('GET','/api/sf/epg?enabledOnly=1'),
      call('GET','/api/iptv/channels'),
    ]).then(([chs,sts,epg,iptv]) => {
      setChannels(chs); setStreams(sts);
      setEpgChannels(epg.channels||[]);
      setOrionChannels(iptv.channels||[]);
    }).catch(()=>{}).finally(()=>setLoading(false));
  },[call]);
  useEffect(()=>{load();},[load]);

  const openNew  = () => { setEditing(null); setShowIptvPicker(false); setIptvSearch(''); setForm({num:(()=>{const used=new Set(channels.map(c=>c.num||0));let n=1;while(used.has(n))n++;return n;})(),name:'',group:'',logo:'',epgChannelId:'',liveStreamId:'',splashUrl:''}); setModal(true); };
  const openEdit = ch => { setEditing(ch); setShowIptvPicker(false); setIptvSearch(''); setForm({num:ch.num||'',name:ch.name||'',group:ch.group||'',logo:ch.logo||'',epgChannelId:ch.epgChannelId||'',liveStreamId:ch.liveStreamId||'',splashUrl:ch.splashUrl||''}); setModal(true); };
  const save     = async () => { if(!form.name.trim()){notify('Channel name required',true);return;} try{ const p={...form,num:parseInt(form.num)||undefined,liveStreamId:form.liveStreamId||null,splashUrl:form.splashUrl||null}; if(editing)await call('PUT',`/api/sf/channels/${editing.id}`,p);else await call('POST','/api/sf/channels',p); notify('✅ Channel saved');setModal(false);load(); }catch(e){notify(e.message,true);} };
  const del      = async (id,name) => { if(!window.confirm(`Delete "${name}"?`))return; await call('DELETE',`/api/sf/channels/${id}`);notify('Deleted');load(); };

  const clearAllChannels = async () => {
    if (!window.confirm(`Delete all ${channels.length} channels? This cannot be undone.`)) return;
    try { await call('POST','/api/sf/reset/channels'); notify('✅ All channels cleared'); load(); }
    catch(e) { notify('Failed: '+e.message,true); }
  };

  // Assign an Orion IPTV channel as live stream — imports to SF streams if needed
  const assignIptvChannel = async (iptvCh) => {
    try {
      let stream = streams.find(s=>s.url===iptvCh.url);
      if (!stream) stream = await call('POST','/api/sf/streams',{name:iptvCh.name,url:iptvCh.url,group:iptvCh.group||'',logo:iptvCh.logo||''});
      setForm(f=>({...f,liveStreamId:stream.id}));
      setShowIptvPicker(false); setIptvSearch('');
      const sts = await call('GET','/api/sf/streams'); setStreams(sts);
    } catch(e) { notify('Failed to assign: '+e.message,true); }
  };

  // Bulk add selected basic cable EPG channels
  const applyBasicCable = async (basicEpg) => {
    const toAdd = basicEpg.filter(c=>selectedBasic.has(c.id));
    if (!toAdd.length) return;
    setApplyingBasic(true);
    const findMatch = (epgCh) => { const n=normEpgName(epgCh.name); return orionChannels.find(oc=>normEpgName(oc.name)===n)||orionChannels.find(oc=>normEpgName(oc.name).startsWith(n)||n.startsWith(normEpgName(oc.name))); };
    const usedNums = new Set(channels.map(c=>c.num||0));
    let nextNum = 1; while(usedNums.has(nextNum)) nextNum++;
    let added = 0;
    for (const epgCh of toAdd) {
      try {
        const iptvMatch = findMatch(epgCh);
        let liveStreamId = null;
        if (iptvMatch) {
          let stream = streams.find(s=>s.url===iptvMatch.url);
          if (!stream) stream = await call('POST','/api/sf/streams',{name:iptvMatch.name,url:iptvMatch.url,group:iptvMatch.group||'',logo:iptvMatch.logo||''});
          liveStreamId = stream.id;
        }
        await call('POST','/api/sf/channels',{name:epgCh.name,num:nextNum++,group:epgCh.group||'Basic Cable',logo:iptvMatch?.logo||'',liveStreamId,epgChannelId:epgCh.id});
        added++;
      } catch {}
    }
    notify(`✅ Added ${added} channel${added!==1?'s':''}`);
    setApplyingBasic(false); setBasicCableModal(false); setSelectedBasic(new Set()); load();
  };

  const inp = {width:'100%',padding:'9px 12px',background:'var(--bg-tertiary)',border:'1px solid var(--border)',borderRadius:'var(--radius)',color:'var(--text-primary)',fontSize:13,outline:'none',boxSizing:'border-box'};

  if (loading) return (
    <div style={{ display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',padding:'80px 24px',gap:20 }}>
      <div style={{ width:48,height:48,border:'3px solid var(--border)',borderTopColor:'var(--accent)',borderRadius:'50%',animation:'spin 0.8s linear infinite' }}/>
      <div style={{ color:'var(--text-muted)',fontSize:14 }}>Loading channels…</div>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );

  return (
    <div>
      <Toast {...toast}/>

      {/* Basic Cable Modal */}
      {basicCableModal && (() => {
        const basicEpg = epgChannels.filter(c=>isBasicCableChannel(c.name));
        const filtered = basicEpg.filter(c=>!basicCableSearch||c.name.toLowerCase().includes(basicCableSearch.toLowerCase()));
        const epgToSfChannel = new Map(channels.filter(c=>c.epgChannelId).map(c=>[c.epgChannelId,c]));
        const findIptvMatch = (epgCh) => { const n=normEpgName(epgCh.name); return orionChannels.find(oc=>normEpgName(oc.name)===n)||orionChannels.find(oc=>normEpgName(oc.name).startsWith(n)||n.startsWith(normEpgName(oc.name))); };
        const available = filtered.filter(c=>!epgToSfChannel.has(c.id));
        const allSelected = available.length>0&&available.every(c=>selectedBasic.has(c.id));
        const toggleAll = () => { const n=new Set(selectedBasic); if(allSelected)available.forEach(c=>n.delete(c.id));else available.forEach(c=>n.add(c.id)); setSelectedBasic(n); };
        return (
          <div style={{ position:'fixed',inset:0,zIndex:2000,background:'rgba(0,0,0,0.75)',display:'flex',alignItems:'center',justifyContent:'center',padding:24 }}
            onClick={()=>{setBasicCableModal(false);setSelectedBasic(new Set());}}>
            <div style={{ background:'var(--bg-secondary)',border:'1px solid var(--border)',borderRadius:'var(--radius-lg)',width:'100%',maxWidth:640,maxHeight:'85vh',display:'flex',flexDirection:'column',boxShadow:'0 20px 60px rgba(0,0,0,0.6)' }} onClick={e=>e.stopPropagation()}>
              <div style={{ padding:'18px 24px 14px',borderBottom:'1px solid var(--border)',display:'flex',alignItems:'center',justifyContent:'space-between' }}>
                <div><div style={{ fontWeight:700,fontSize:16 }}>📺 Spectrum Basic Cable</div><div style={{ fontSize:12,color:'var(--text-muted)',marginTop:2 }}>{basicEpg.length} channels from your EPG · check the ones you want · click Add Selected</div></div>
                <button onClick={()=>{setBasicCableModal(false);setSelectedBasic(new Set());}} style={{ background:'none',border:'none',color:'var(--text-muted)',cursor:'pointer',fontSize:20,lineHeight:1 }}>×</button>
              </div>
              <div style={{ padding:'12px 24px',borderBottom:'1px solid var(--border)',display:'flex',gap:8,alignItems:'center' }}>
                <input autoFocus type="text" placeholder="Search channels…" value={basicCableSearch} onChange={e=>setBasicCableSearch(e.target.value)}
                  style={{ flex:1,padding:'8px 12px',background:'var(--bg-tertiary)',border:'1px solid var(--border)',borderRadius:'var(--radius)',color:'var(--text-primary)',fontSize:13,outline:'none' }}/>
                <button onClick={toggleAll} style={{ padding:'8px 12px',background:'rgba(255,255,255,0.06)',border:'1px solid var(--border)',borderRadius:'var(--radius)',color:'var(--text-secondary)',cursor:'pointer',fontSize:12,whiteSpace:'nowrap' }}>{allSelected?'Deselect All':'Select All'}</button>
              </div>
              <div style={{ overflowY:'auto',flex:1 }}>
                {basicEpg.length===0
                  ? <div style={{ textAlign:'center',padding:40,color:'var(--text-muted)',fontSize:13 }}><div style={{ fontSize:32,marginBottom:12 }}>📅</div>No basic cable channels found in your EPG.<br/><span style={{ fontSize:11,marginTop:8,display:'block' }}>Import your Spectrum EPG in the EPG tab first.</span></div>
                  : filtered.map(epgCh => {
                    const sfCh = epgToSfChannel.get(epgCh.id);
                    const iptvMatch = findIptvMatch(epgCh);
                    const isChecked = selectedBasic.has(epgCh.id);
                    return (
                      <div key={epgCh.id} onClick={()=>{if(sfCh)return;const n=new Set(selectedBasic);isChecked?n.delete(epgCh.id):n.add(epgCh.id);setSelectedBasic(n);}}
                        style={{ display:'flex',alignItems:'center',gap:12,padding:'10px 24px',borderBottom:'1px solid rgba(255,255,255,0.04)',cursor:sfCh?'default':'pointer',background:isChecked?'rgba(99,102,241,0.1)':sfCh?'rgba(16,185,129,0.04)':'transparent' }}
                        onMouseEnter={e=>{if(!sfCh&&!isChecked)e.currentTarget.style.background='rgba(255,255,255,0.04)';}}
                        onMouseLeave={e=>{e.currentTarget.style.background=isChecked?'rgba(99,102,241,0.1)':sfCh?'rgba(16,185,129,0.04)':'transparent';}}>
                        <input type="checkbox" readOnly checked={isChecked||!!sfCh} disabled={!!sfCh} style={{ flexShrink:0 }}/>
                        {iptvMatch?.logo?<img src={iptvMatch.logo} alt="" style={{ width:36,height:26,objectFit:'contain',borderRadius:3,flexShrink:0 }} onError={e=>e.target.style.display='none'}/>:<span style={{ width:36,textAlign:'center',fontSize:16,flexShrink:0 }}>📺</span>}
                        <div style={{ flex:1,minWidth:0 }}>
                          <div style={{ fontSize:13,fontWeight:600,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' }}>{epgCh.name}</div>
                          <div style={{ fontSize:11,marginTop:1 }}>
                            {sfCh?<span style={{ color:'#10b981' }}>Already in StreamForge as CH {sfCh.num}</span>
                              :iptvMatch?<span style={{ color:'#10b981' }}>✓ IPTV stream matched</span>
                              :<span style={{ color:'#f97316' }}>No IPTV match</span>}
                          </div>
                        </div>
                      </div>
                    );
                  })}
              </div>
              <div style={{ padding:'14px 24px',borderTop:'1px solid var(--border)',display:'flex',alignItems:'center',justifyContent:'space-between' }}>
                <div style={{ fontSize:12,color:'var(--text-muted)' }}>{selectedBasic.size} selected · {filtered.filter(c=>findIptvMatch(c)&&!epgToSfChannel.has(c.id)).length} have IPTV streams</div>
                <div style={{ display:'flex',gap:8 }}>
                  <button onClick={()=>{setBasicCableModal(false);setSelectedBasic(new Set());}} style={{ padding:'9px 18px',background:'rgba(255,255,255,0.06)',border:'1px solid var(--border)',borderRadius:'var(--radius)',color:'var(--text-secondary)',cursor:'pointer',fontSize:13 }}>Cancel</button>
                  <button onClick={()=>applyBasicCable(basicEpg)} disabled={selectedBasic.size===0||applyingBasic}
                    style={{ padding:'9px 20px',background:'var(--accent)',border:'none',borderRadius:'var(--radius)',color:'white',fontWeight:700,cursor:'pointer',fontSize:13,opacity:selectedBasic.size===0?0.4:1 }}>
                    {applyingBasic?'Adding…':`Add Selected (${selectedBasic.size})`}
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Header */}
      <div style={{ display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:20 }}>
        <div style={{ fontSize:13,color:'var(--text-muted)' }}>{channels.length} channels</div>
        <div style={{ display:'flex',gap:8 }}>
          <button onClick={load} style={{ padding:'7px 12px',background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:'var(--radius)',color:'var(--text-muted)',cursor:'pointer',display:'flex',alignItems:'center',gap:6,fontSize:12 }}><RefreshCw size={13}/> Refresh</button>
          {channels.length>0&&<button onClick={clearAllChannels} style={{ padding:'7px 12px',background:'rgba(239,68,68,0.1)',border:'1px solid rgba(239,68,68,0.25)',borderRadius:'var(--radius)',color:'#ef4444',fontWeight:600,cursor:'pointer',display:'flex',alignItems:'center',gap:6,fontSize:12 }}><Trash2 size={13}/> Clear All</button>}
          {orionChannels.length>0&&<button onClick={()=>{setBasicCableModal(true);setBasicCableSearch('');}} style={{ padding:'7px 14px',background:'rgba(16,185,129,0.1)',border:'1px solid rgba(16,185,129,0.3)',borderRadius:'var(--radius)',color:'#10b981',fontWeight:600,cursor:'pointer',display:'flex',alignItems:'center',gap:6,fontSize:12 }}>📺 Basic Cable</button>}
          <button onClick={openNew} style={{ padding:'7px 14px',background:'var(--accent)',color:'white',border:'none',borderRadius:'var(--radius)',fontWeight:600,cursor:'pointer',display:'flex',alignItems:'center',gap:6,fontSize:12 }}><Plus size={13}/> New Channel</button>
        </div>
      </div>

      {/* Channel list */}
      {channels.length===0
        ? <div className="empty-state"><div className="empty-state-icon">📺</div><h3>No channels yet</h3><p>Create your first channel or use Basic Cable to import from your EPG.</p><button className="btn btn-primary" onClick={openNew}><Plus size={14}/> Create Channel</button></div>
        : <div style={{ display:'flex',flexDirection:'column',gap:8 }}>
            {[...channels].sort((a,b)=>(a.num||0)-(b.num||0)).map(ch=>(
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

      {/* Channel edit modal */}
      <Modal open={modal} onClose={()=>setModal(false)} title={editing?`Edit: ${editing.name}`:'New Channel'}>
        <Field label="Channel Number"><input style={inp} type="number" value={form.num} onChange={e=>setForm(f=>({...f,num:e.target.value}))}/></Field>
        <Field label="Channel Name"><input autoFocus style={inp} value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))} placeholder="Channel name…"/></Field>
        <Field label="Group"><input style={inp} value={form.group} onChange={e=>setForm(f=>({...f,group:e.target.value}))} placeholder="News, Sports, Entertainment…"/></Field>
        <Field label="Logo URL"><input style={inp} value={form.logo} onChange={e=>setForm(f=>({...f,logo:e.target.value}))} placeholder="https://…"/></Field>
        <Field label="Splash Screen" hint="Image shown while the channel loads — use a channel card, logo, or promo image">
          <div style={{ display:'flex',gap:8,alignItems:'center' }}>
            <input style={{...inp,flex:1}} value={form.splashUrl} onChange={e=>setForm(f=>({...f,splashUrl:e.target.value}))} placeholder="https://… (jpg, png, gif)"/>
            {form.splashUrl && <img src={form.splashUrl} alt="" style={{ width:60,height:40,objectFit:'cover',borderRadius:'var(--radius)',border:'1px solid var(--border)',flexShrink:0 }} onError={e=>e.target.style.display='none'}/>}
          </div>
        </Field>
        <Field label="EPG Channel ID"><select style={inp} value={form.epgChannelId} onChange={e=>setForm(f=>({...f,epgChannelId:e.target.value}))}><option value="">— None —</option>{epgChannels.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        <Field label="24/7 Live Stream" hint="Assign an IPTV channel or existing stream to play 24/7">
          <div style={{ display:'flex',flexDirection:'column',gap:6 }}>
            <div style={{ display:'flex',gap:6 }}>
              <select style={{...inp,flex:1}} value={form.liveStreamId} onChange={e=>setForm(f=>({...f,liveStreamId:e.target.value}))}>
                <option value="">— None (use playout queue) —</option>
                {streams.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <button type="button" onClick={()=>setShowIptvPicker(v=>!v)}
                style={{ padding:'0 12px',background:'rgba(99,102,241,0.12)',border:'1px solid rgba(99,102,241,0.3)',borderRadius:'var(--radius)',color:'#818cf8',fontSize:11,fontWeight:700,cursor:'pointer',whiteSpace:'nowrap' }}>
                📡 From IPTV
              </button>
            </div>
            {showIptvPicker&&(
              <div style={{ border:'1px solid var(--border)',borderRadius:'var(--radius)',overflow:'hidden',background:'var(--bg-primary)' }}>
                <div style={{ padding:'8px 10px',borderBottom:'1px solid var(--border)' }}>
                  <input type="text" placeholder="Search Orion IPTV channels…" value={iptvSearch} onChange={e=>setIptvSearch(e.target.value)}
                    style={{ width:'100%',padding:'6px 10px',background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:'var(--radius)',color:'var(--text-primary)',fontSize:12,outline:'none',boxSizing:'border-box' }}/>
                </div>
                <div style={{ maxHeight:200,overflowY:'auto' }}>
                  {orionChannels.filter(c=>!iptvSearch||c.name.toLowerCase().includes(iptvSearch.toLowerCase())||(c.group||'').toLowerCase().includes(iptvSearch.toLowerCase())).slice(0,50).map(c=>(
                    <div key={c.id} onClick={()=>assignIptvChannel(c)}
                      style={{ display:'flex',alignItems:'center',gap:10,padding:'8px 12px',cursor:'pointer',borderBottom:'1px solid rgba(255,255,255,0.04)' }}
                      onMouseEnter={e=>e.currentTarget.style.background='rgba(99,102,241,0.1)'}
                      onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
                      {c.logo?<img src={c.logo} alt="" style={{ width:28,height:20,objectFit:'contain',borderRadius:2,flexShrink:0 }} onError={e=>e.target.style.display='none'}/>:<span style={{ fontSize:14,flexShrink:0 }}>📡</span>}
                      <div style={{ flex:1,minWidth:0 }}>
                        <div style={{ fontSize:12,fontWeight:600,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' }}>{c.name}</div>
                        {c.group&&<div style={{ fontSize:10,color:'var(--text-muted)' }}>{c.group}</div>}
                      </div>
                      {streams.find(s=>s.url===c.url)&&<span style={{ fontSize:9,color:'#10b981',fontWeight:700 }}>IN SF</span>}
                    </div>
                  ))}
                  {orionChannels.filter(c=>!iptvSearch||c.name.toLowerCase().includes(iptvSearch.toLowerCase())).length===0&&<div style={{ padding:20,textAlign:'center',color:'var(--text-muted)',fontSize:12 }}>No channels match</div>}
                </div>
              </div>
            )}
          </div>
        </Field>
        <div style={{ display:'flex',gap:10,marginTop:8 }}>
          <button onClick={()=>setModal(false)} style={{ flex:1,padding:'10px',background:'var(--bg-tertiary)',border:'1px solid var(--border)',borderRadius:'var(--radius)',color:'var(--text-secondary)',cursor:'pointer',fontWeight:600 }}>Cancel</button>
          <button onClick={save} style={{ flex:2,padding:'10px',background:'var(--accent)',color:'white',border:'none',borderRadius:'var(--radius)',fontWeight:700,cursor:'pointer' }}>Save Channel</button>
        </div>
      </Modal>
    </div>
  );
}


// ── Playout Builder ───────────────────────────────────────────────────────────

function CollectionPreview({ call, channelId }) {
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [showAll, setShowAll] = React.useState(false);

  React.useEffect(() => {
    if (!channelId) return;
    setLoading(true);
    call('GET', `/api/sf/channels/${channelId}/collection-items`)
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [channelId, call]);

  if (loading) return <div style={{fontSize:11,color:'var(--text-muted)',padding:'4px 0'}}>Loading…</div>;
  if (!data || !data.count) return <div style={{fontSize:11,color:'var(--text-muted)',padding:'4px 0'}}>0 items</div>;

  const display = showAll ? data.items : data.items.slice(0, 15);
  return (
    <div>
      <div style={{fontSize:11,fontWeight:700,color:'var(--text-muted)',marginBottom:4}}>{data.count} ITEMS IN COLLECTION</div>
      <div style={{maxHeight:showAll?300:140,overflowY:'auto',display:'flex',flexDirection:'column',gap:2}}>
        {display.map((m,i) => (
          <div key={m.id||i} style={{fontSize:11,color:'var(--text-secondary)',padding:'2px 0',borderBottom:'1px solid rgba(255,255,255,0.04)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
            {m.title}{m.season!=null?` S${String(m.season).padStart(2,'0')}E${String(m.episode||0).padStart(2,'0')}`:''}
            {m.episodeTitle?' — '+m.episodeTitle:''}
          </div>
        ))}
      </div>
      {data.count > 15 && (
        <button onClick={()=>setShowAll(v=>!v)} style={{marginTop:6,background:'none',border:'none',color:'var(--accent)',cursor:'pointer',fontSize:11,padding:0}}>
          {showAll ? '▲ Show less' : `▼ Show all ${data.count} items`}
        </button>
      )}
    </div>
  );
}

function PlayoutBuilder({ call, initialChannelId }) {
  const [channels,setChannels]   = useState([]);
  const [channelId,setChannelId] = useState(initialChannelId||'');
  const [queue,setQueue]         = useState([]);
  const [streams,setStreams]     = useState([]);
  const [mediaItems,setMediaItems] = useState([]);
  const [saving,setSaving]       = useState(false);
  const [mediaSearch,setMediaSearch] = useState('');
  const [mediaType,setMediaType] = useState('episode'); // episode | movie
  const [toast,notify]           = useToast();
  const [mode,setMode]           = useState('queue'); // queue | series | library
  const [libraryInfo,setLibraryInfo] = useState(null);
  const [savingLibrary,setSavingLibrary] = useState(null);
  const [libraries,setLibraries]   = useState([]);
  const [genres,setGenres]         = useState([]);
  const [networks,setNetworks]      = useState([]);
  const [collectionTab,setCollectionTab] = useState('network'); // 'network' | 'genre'
  const [genreInfo,setGenreInfo]   = useState(null); // single legacy
  const [genreLoops,setGenreLoops]   = useState([]); // new multi-collection
  const [genreSearch,setGenreSearch] = useState('');
  const [savingGenre,setSavingGenre] = useState(false);

  // Series mode
  const [seriesSearch,setSeriesSearch] = useState('');
  const seriesSearchTimeout = useRef(null);
  const [selectedShow,setSelectedShow] = useState(null);
  const [seriesInfo,setSeriesInfo]     = useState(null);
  const [savingSeries,setSavingSeries] = useState(false);

  const [shows,setShows] = useState([]); // server-side grouped show list
  const [showsLoading,setShowsLoading] = useState(false);

  useEffect(()=>{
    Promise.all([
      call('GET','/api/sf/channels'),
      call('GET','/api/sf/streams'),
      call('GET','/api/sf/media?type=movie&limit=5000'),
      call('GET','/api/sf/libraries'),
      call('GET','/api/sf/media/genres').catch(()=>[]),
    ]).then(([chs,sts,med,libs,gns])=>{
      setChannels(chs);
      setStreams(sts);
      setMediaItems(med.items||med);
      setLibraries(libs||[]);
      setGenres(gns?.genres||[]); setNetworks(gns?.networks||[]);
    }).catch(()=>{});
    // Shows are loaded on-demand via search
  },[call]);

  useEffect(()=>{
    if(!channelId) return;
    // Only reload queue from server when channelId changes, not on every channels update
    call('GET',`/api/sf/channels/${channelId}/playout`).then(q=>setQueue(q||[])).catch(()=>{});
    const ch = channels.find(c=>c.id===channelId);
    if (ch?.seriesSchedule) { setSeriesInfo(ch.seriesSchedule); setMode('series'); }
    else if (ch?.libraryLoop) { setLibraryInfo(ch.libraryLoop); setMode('library'); }
    else if (ch?.genreLoops?.length || ch?.genreLoop) { const loops = ch.genreLoops?.length ? ch.genreLoops : [ch.genreLoop]; setGenreLoops(loops); setGenreInfo(loops[0]||null); setMode('collection'); }
    else { setSeriesInfo(null); setLibraryInfo(null); setGenreInfo(null); }
  },[channelId, call]);

  const save=async()=>{
    if(!channelId)return;
    setSaving(true);
    try{ await call('PUT',`/api/sf/channels/${channelId}/playout`,queue); notify('✅ Playout saved'); }
    catch(e){ notify(e.message,true); }
    setSaving(false);
  };

  const addItem=(m)=>{ console.log('[Queue] addItem', m.id, m.title); setQueue(q=>{ const n=[...q,{mediaId:m.id,title:m.episodeTitle||m.title}]; console.log('[Queue] new length:', n.length); return n; }); };
  const remove=(i)=>setQueue(q=>q.filter((_,j)=>j!==i));
  const move=(i,dir)=>setQueue(q=>{const n=[...q];const j=i+dir;if(j<0||j>=n.length)return q;[n[i],n[j]]=[n[j],n[i]];return n;});

  // Filter media — exclude live streams entirely from playout builder
  const episodes = mediaItems.filter(m=>(m.type==='episode'||m.season!=null)&&m.season!=null);
  const movies   = mediaItems.filter(m=>m.type==='movie'||(!m.season&&!m.episode&&m.filePath));
  const displayItems = (mediaType==='episode' ? episodes : movies)
    .filter(m=>!mediaSearch||m.title?.toLowerCase().includes(mediaSearch.toLowerCase())||(m.episodeTitle||'').toLowerCase().includes(mediaSearch.toLowerCase()));

  const filteredShows = shows; // shows already filtered server-side

  const selectShow=(show)=>{
    // Server already returns sorted episodes; just normalize season keys to numbers
    const sorted={};
    Object.entries(show.seasons).forEach(([s,eps])=>{
      sorted[Number(s)]=eps; // already sorted by server
    });
    setSelectedShow({...show,seasons:sorted});
  };

  const saveSeriesSchedule=async()=>{
    if(!channelId||!selectedShow)return;
    setSavingSeries(true);
    try{
      const seasonNums=Object.keys(selectedShow.seasons).map(Number).sort((a,b)=>a-b);
      const episodes=[];
      // Server-side format: episodes already have mediaId, season, episode, duration
      seasonNums.forEach(s=>selectedShow.seasons[s].forEach(ep=>{
        episodes.push({ mediaId:ep.mediaId, season:s, episode:ep.episode||0, title:ep.title||'', duration:ep.duration||1800 });
      }));
      const schedule={showTitle:selectedShow.title,episodes,rotationMode:'season_per_day'};
      await call('PUT',`/api/sf/channels/${channelId}`,{seriesSchedule:schedule});
      notify(`✅ Saved — ${seasonNums.length} seasons, ${episodes.length} episodes`);
      setSeriesInfo(schedule);
    }catch(e){notify(e.message,true);}
    setSavingSeries(false);
  };

  const clearSeries=async()=>{
    if(!window.confirm('Remove series schedule?'))return;
    try{ await call('PUT',`/api/sf/channels/${channelId}`,{seriesSchedule:null}); setSeriesInfo(null);setSelectedShow(null);setMode('queue');notify('✅ Cleared'); }
    catch(e){notify(e.message,true);}
  };

  const inp={padding:'9px 12px',background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:'var(--radius)',color:'var(--text-primary)',fontSize:13,outline:'none'};
  const sm={padding:'8px 12px',background:'var(--bg-tertiary)',border:'1px solid var(--border)',borderRadius:'var(--radius)',color:'var(--text-primary)',fontSize:12,outline:'none'};

  return (
    <div>
      <Toast {...toast}/>

      {/* ── Header row ── */}
      <div style={{display:'flex',gap:10,alignItems:'center',marginBottom:20,flexWrap:'wrap'}}>
        <select value={channelId} onChange={e=>setChannelId(e.target.value)}
          style={{...inp,flex:'1 1 220px',minWidth:0}}>
          <option value="">— Select a channel —</option>
          {channels.filter(c=>!c.liveStreamId).map(c=><option key={c.id} value={c.id}>{c.num} — {c.name}</option>)}
        </select>
        {channelId&&<>
          <div style={{display:'flex',borderRadius:'var(--radius)',overflow:'hidden',border:'1px solid var(--border)',flexShrink:0}}>
            <button onClick={()=>setMode('queue')}
              style={{padding:'9px 16px',background:mode==='queue'?'var(--accent)':'var(--bg-card)',color:mode==='queue'?'white':'var(--text-secondary)',border:'none',cursor:'pointer',fontSize:12,fontWeight:600}}>
              📋 Queue
            </button>
            <button onClick={()=>setMode('series')}
              style={{padding:'9px 16px',background:mode==='series'?'var(--accent)':'var(--bg-card)',color:mode==='series'?'white':'var(--text-secondary)',border:'none',borderLeft:'1px solid var(--border)',cursor:'pointer',fontSize:12,fontWeight:600}}>
              📺 Series{seriesInfo?' ✓':''}
            </button>
            <button onClick={()=>setMode('library')}
              style={{padding:'9px 16px',background:mode==='library'?'var(--accent)':'var(--bg-card)',color:mode==='library'?'white':'var(--text-secondary)',border:'none',borderLeft:'1px solid var(--border)',cursor:'pointer',fontSize:12,fontWeight:600}}>
              📚 Library{libraryInfo?' ✓':''}
            </button>
            <button onClick={()=>setMode('collection')}
              style={{padding:'9px 16px',background:mode==='collection'?'var(--accent)':'var(--bg-card)',color:mode==='collection'?'white':'var(--text-secondary)',border:'none',borderLeft:'1px solid var(--border)',cursor:'pointer',fontSize:12,fontWeight:600}}>
              🎭 Collection{genreInfo?' ✓':''}
            </button>
          </div>
          {mode==='queue'&&<button onClick={save} disabled={saving}
            style={{padding:'9px 20px',background:'var(--accent)',color:'white',border:'none',borderRadius:'var(--radius)',fontWeight:700,cursor:'pointer',fontSize:13,flexShrink:0}}>
            {saving?'Saving…':'Save Playout'}
          </button>}
        </>}
      </div>

      {/* ── No channel selected ── */}
      {!channelId&&(
        <div style={{textAlign:'center',padding:'60px 24px',color:'var(--text-muted)'}}>
          <div style={{fontSize:40,marginBottom:12}}>📺</div>
          <div style={{fontSize:16,fontWeight:600,marginBottom:6}}>Select a channel above</div>
          <div style={{fontSize:13}}>Only channels without a 24/7 live stream are shown here — those use the playout queue or series rotation</div>
        </div>
      )}

      {/* ── Series Mode ── */}
      {channelId&&mode==='series'&&(
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:20}}>
          {/* Left: show picker */}
          <div>
            <div style={{fontSize:11,fontWeight:700,color:'var(--text-muted)',letterSpacing:1,marginBottom:8}}>PICK A TV SHOW</div>
            {seriesInfo&&(
              <div style={{marginBottom:12,padding:'12px 14px',background:'rgba(99,102,241,0.1)',border:'1px solid rgba(99,102,241,0.3)',borderRadius:'var(--radius)',display:'flex',alignItems:'center',gap:10}}>
                <div style={{flex:1}}>
                  <div style={{fontWeight:700,fontSize:13}}>📺 {seriesInfo.showTitle}</div>
                  <div style={{fontSize:11,color:'var(--text-muted)',marginTop:2}}>{[...new Set(seriesInfo.episodes.map(e=>e.season))].length} seasons · {seriesInfo.episodes.length} total episodes</div>
                </div>
                <button onClick={clearSeries} style={{padding:'5px 10px',background:'rgba(239,68,68,0.1)',border:'1px solid rgba(239,68,68,0.25)',borderRadius:'var(--radius)',color:'#ef4444',fontSize:11,cursor:'pointer'}}>Clear</button>
              </div>
            )}
            <input value={seriesSearch}
              onChange={e=>{
                const v=e.target.value; setSeriesSearch(v); setSelectedShow(null);
                clearTimeout(seriesSearchTimeout.current);
                if(v.length<2){ setShows([]); return; }
                setShowsLoading(true);
                seriesSearchTimeout.current=setTimeout(()=>{
                  call('GET',`/api/sf/media/shows?q=${encodeURIComponent(v)}`)
                    .then(s=>{ setShows(s||[]); setShowsLoading(false); })
                    .catch(()=>setShowsLoading(false));
                },300);
              }}
              placeholder="Type to search your TV shows…"
              style={{...sm,width:'100%',marginBottom:8,boxSizing:'border-box'}}/>
            <div style={{display:'flex',flexDirection:'column',gap:3,maxHeight:420,overflowY:'auto'}}>
              {showsLoading&&<div style={{padding:24,textAlign:'center',color:'var(--text-muted)',fontSize:13}}>Searching…</div>}
              {!showsLoading&&seriesSearch.length<2&&<div style={{padding:24,textAlign:'center',color:'var(--text-muted)',fontSize:13}}>Start typing a show name above</div>}
              {!showsLoading&&seriesSearch.length>=2&&filteredShows.length===0&&<div style={{padding:24,textAlign:'center',color:'var(--text-muted)',fontSize:13}}>No shows found matching "{seriesSearch}"</div>}
              {filteredShows.slice(0,100).map(show=>{
                const sel=selectedShow?.title===show.title;
                const sc=Object.keys(show.seasons).length;
                return(
                  <div key={show.title} onClick={()=>selectShow(show)}
                    style={{padding:'10px 14px',background:sel?'rgba(99,102,241,0.15)':'var(--bg-card)',border:`1px solid ${sel?'rgba(99,102,241,0.5)':'var(--border)'}`,borderRadius:'var(--radius)',cursor:'pointer'}}>
                    <div style={{fontWeight:sel?700:500,fontSize:13,color:sel?'var(--accent)':'var(--text-primary)'}}>{show.title}</div>
                    <div style={{fontSize:11,color:'var(--text-muted)',marginTop:2}}>{show.seasonCount} season{show.seasonCount!==1?'s':''} · {show.totalEpisodes} episodes</div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Right: season breakdown */}
          <div>
            <div style={{fontSize:11,fontWeight:700,color:'var(--text-muted)',letterSpacing:1,marginBottom:8}}>SEASON ROTATION PREVIEW</div>
            {!selectedShow&&(
              <div style={{padding:32,textAlign:'center',color:'var(--text-muted)',fontSize:13,border:'1px dashed var(--border)',borderRadius:'var(--radius)'}}>
                <div style={{fontSize:28,marginBottom:8}}>📅</div>
                Select a show — each season plays for one full day, episodes in order, then rotates to the next season
              </div>
            )}
            {selectedShow&&(
              <>
                <div style={{display:'flex',flexDirection:'column',gap:4,maxHeight:360,overflowY:'auto',marginBottom:12}}>
                  {Object.keys(selectedShow.seasons).map(Number).sort((a,b)=>a-b).map((s,i)=>{
                    const eps=selectedShow.seasons[s];
                    const mins=Math.round(eps.reduce((t,e)=>t+(e.duration||1800),0)/60);
                    const h=Math.floor(mins/60),m=mins%60;
                    return(
                      <div key={s} style={{padding:'10px 14px',background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:'var(--radius)'}}>
                        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                          <span style={{fontWeight:600,fontSize:13}}>Day {i+1} → Season {s}</span>
                          <span style={{fontSize:11,color:'var(--accent)',fontWeight:600}}>{eps.length} eps</span>
                        </div>
                        <div style={{fontSize:11,color:'var(--text-muted)',marginTop:3,display:'flex',gap:12}}>
                          <span>E{String(eps[0].episode||1).padStart(2,'0')}–E{String(eps[eps.length-1].episode||eps.length).padStart(2,'0')}</span>
                          <span>~{h?`${h}h `:''}{ m?`${m}m`:''} total · loops if shorter than 24h</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <button onClick={saveSeriesSchedule} disabled={savingSeries}
                  style={{width:'100%',padding:'11px',background:'var(--accent)',color:'white',border:'none',borderRadius:'var(--radius)',fontWeight:700,cursor:'pointer',fontSize:14}}>
                  {savingSeries?'Saving…':`✓ Save Series Schedule  (${Object.keys(selectedShow.seasons).length} days)`}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Library Loop Mode ── */}
      {channelId&&mode==='library'&&(
        <div style={{maxWidth:500}}>
          {libraryInfo&&(
            <div style={{marginBottom:16,padding:'12px 16px',background:'rgba(99,102,241,0.1)',border:'1px solid rgba(99,102,241,0.3)',borderRadius:'var(--radius)',display:'flex',alignItems:'center',gap:12}}>
              <div style={{flex:1}}>
                <div style={{fontWeight:700,fontSize:13}}>📚 {libraries.find(l=>l.id===libraryInfo.libraryId)?.name||libraryInfo.libraryId}</div>
                <div style={{fontSize:11,color:'var(--text-muted)',marginTop:2}}>{libraryInfo.shuffle?'Playing in shuffle order':'Playing in order'} · loops continuously</div>
              </div>
              <button onClick={async()=>{ if(!window.confirm('Remove library loop?'))return; await call('PUT',`/api/sf/channels/${channelId}`,{libraryLoop:null}); setLibraryInfo(null); setMode('queue'); }}
                style={{padding:'5px 10px',background:'rgba(239,68,68,0.1)',border:'1px solid rgba(239,68,68,0.25)',borderRadius:'var(--radius)',color:'#ef4444',fontSize:11,cursor:'pointer'}}>Clear</button>
            </div>
          )}
          <div style={{marginBottom:16,padding:'12px 14px',background:'rgba(255,255,255,0.04)',borderRadius:'var(--radius)',fontSize:12,color:'var(--text-muted)'}}>
            All items in the selected library play in a continuous loop on this channel. Perfect for music videos, movies, or any library you want as a dedicated channel.
          </div>
          <div style={{marginBottom:12}}>
            <div style={{fontSize:11,fontWeight:700,color:'var(--text-muted)',letterSpacing:1,marginBottom:8}}>SELECT LIBRARY</div>
            {libraries.length===0&&<div style={{padding:16,color:'var(--text-muted)',fontSize:12,textAlign:'center'}}>Loading libraries…</div>}
            <div style={{display:'flex',flexDirection:'column',gap:6}}>
              {libraries.filter(l=>l.type==='orion'||l.itemCount>0).map(lib=>{
                const sel = libraryInfo?.libraryId===lib.id;
                return(
                  <div key={lib.id}
                    style={{display:'flex',alignItems:'center',gap:12,padding:'12px 16px',background:sel?'rgba(99,102,241,0.15)':'var(--bg-card)',border:`1px solid ${sel?'rgba(99,102,241,0.5)':'var(--border)'}`,borderRadius:'var(--radius)'}}>
                    <span style={{fontSize:20}}>📚</span>
                    <div style={{flex:1}}>
                      <div style={{fontWeight:sel?700:500,fontSize:13,color:sel?'var(--accent)':'var(--text-primary)'}}>{lib.name}</div>
                      <div style={{fontSize:11,color:'var(--text-muted)',marginTop:2}}>{lib.itemCount||'?'} items · loops continuously in order</div>
                    </div>
                    {sel
                      ? <span style={{color:'#10b981',fontWeight:700,fontSize:12,padding:'4px 10px',background:'rgba(16,185,129,0.1)',borderRadius:'var(--radius)'}}>✓ Active</span>
                      : <button onClick={async()=>{
                          setSavingLibrary(lib.id);
                          try{
                            const loop={libraryId:lib.id,shuffle:false};
                            await call('PUT',`/api/sf/channels/${channelId}`,{libraryLoop:loop,seriesSchedule:null,liveStreamId:null});
                            setLibraryInfo(loop);
                            notify(`✅ Channel set to loop ${lib.name}`);
                          }catch(e){ notify('Failed: '+e.message, true); }
                          setSavingLibrary(null);
                        }}
                        disabled={savingLibrary===lib.id}
                        style={{padding:'7px 16px',background:'var(--accent)',color:'white',border:'none',borderRadius:'var(--radius)',fontWeight:700,cursor:'pointer',fontSize:12,flexShrink:0}}>
                        {savingLibrary===lib.id?'Saving…':'Set Library'}
                      </button>
                    }
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ── Collection / Network / Genre Mode ── */}
      {channelId&&mode==='collection'&&(
        <div style={{maxWidth:640}}>
          {genreInfo&&(
            <div style={{marginBottom:14,padding:'12px 16px',background:'rgba(99,102,241,0.1)',border:'1px solid rgba(99,102,241,0.3)',borderRadius:'var(--radius)'}}>
              <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:8}}>
                <div style={{flex:1}}>
                  <div style={{fontWeight:700,fontSize:13}}>🎭 {genreLoops.length} Collection{genreLoops.length!==1?'s':''} Active</div>
                  <div style={{fontSize:11,color:'var(--text-muted)',marginTop:2}}>{genreLoops.map(l=>l.genre).join(', ')} · loops in order</div>
                </div>
                <button onClick={async()=>{ if(!window.confirm('Remove all collections?'))return; await call('PUT',`/api/sf/channels/${channelId}`,{genreLoop:null,genreLoops:[]}); setGenreInfo(null); setGenreLoops([]); setMode('queue'); }}
                  style={{padding:'5px 10px',background:'rgba(239,68,68,0.1)',border:'1px solid rgba(239,68,68,0.25)',borderRadius:'var(--radius)',color:'#ef4444',fontSize:11,cursor:'pointer'}}>Clear</button>
              </div>
              <CollectionPreview call={call} channelId={channelId}/>
            </div>
          )}
          {/* Tab switcher */}
          <div style={{display:'flex',gap:4,marginBottom:12,borderRadius:'var(--radius)',overflow:'hidden',border:'1px solid var(--border)',width:'fit-content'}}>
            <button onClick={()=>setCollectionTab('network')} style={{padding:'7px 18px',background:collectionTab==='network'?'var(--accent)':'var(--bg-card)',color:collectionTab==='network'?'white':'var(--text-secondary)',border:'none',cursor:'pointer',fontSize:12,fontWeight:600}}>📡 Networks</button>
            <button onClick={()=>setCollectionTab('genre')} style={{padding:'7px 18px',background:collectionTab==='genre'?'var(--accent)':'var(--bg-card)',color:collectionTab==='genre'?'white':'var(--text-secondary)',border:'none',borderLeft:'1px solid var(--border)',cursor:'pointer',fontSize:12,fontWeight:600}}>🎭 Genres</button>
          </div>
          <input value={genreSearch} onChange={e=>setGenreSearch(e.target.value)}
            placeholder={collectionTab==='network'?'Search networks…':'Search genres…'}
            style={{...sm,width:'100%',marginBottom:10,boxSizing:'border-box'}}/>
          {/* Pending list with save button */}
          {genreLoops.length>0&&(
            <div style={{marginBottom:10,padding:'10px 14px',background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:'var(--radius)'}}>
              <div style={{fontSize:11,fontWeight:700,color:'var(--text-muted)',marginBottom:6}}>SELECTED ({genreLoops.length})</div>
              <div style={{display:'flex',flexWrap:'wrap',gap:6,marginBottom:8}}>
                {genreLoops.map((l,i)=>(
                  <span key={i} style={{display:'flex',alignItems:'center',gap:4,padding:'3px 8px',background:'rgba(99,102,241,0.15)',border:'1px solid rgba(99,102,241,0.4)',borderRadius:12,fontSize:11,fontWeight:600,color:'var(--accent)'}}>
                    {l.genre} <span style={{fontSize:9,opacity:.7}}>({l.mediaType==='episode'?'TV':l.mediaType==='movie'?'Movies':'All'})</span>
                    <button onClick={()=>setGenreLoops(genreLoops.filter((_,j)=>j!==i))} style={{background:'none',border:'none',color:'#ef4444',cursor:'pointer',padding:0,fontSize:12,lineHeight:1}}>×</button>
                  </span>
                ))}
              </div>
              <button disabled={savingGenre} onClick={async()=>{
                setSavingGenre(true);
                try{
                  await call('PUT',`/api/sf/channels/${channelId}`,{genreLoops,genreLoop:genreLoops[0],libraryLoop:null,seriesSchedule:null,liveStreamId:null});
                  setGenreInfo(genreLoops[0]);
                  // Populate queue with all matching items so user can see what's in the collection
                  try {
                    const results = await Promise.all(genreLoops.map(l =>
                      call('GET', `/api/sf/media/by-network?network=${encodeURIComponent(l.genre)}`).catch(()=>[])
                    ));
                    const combined = results.flat();
                    const seen = new Set();
                    const unique = combined.filter(m=>{ if(seen.has(m.id))return false; seen.add(m.id); return true; });
                    const sorted = unique.sort((a,b)=>((a.season||0)*1000+(a.episode||0))-((b.season||0)*1000+(b.episode||0)));
                    setQueue(sorted.map(m=>({mediaId:m.id,title:(m.seriesTitle||m.title)+(m.season!=null?` S${String(m.season).padStart(2,'0')}E${String(m.episode||0).padStart(2,'0')}`:'')})));
                  } catch(qe) { console.warn('queue populate failed', qe); }
                  notify(`✅ Saved ${genreLoops.length} collection${genreLoops.length!==1?'s':''}`);
                }catch(e){notify('Failed: '+e.message,true);}
                setSavingGenre(false);
              }} style={{padding:'7px 20px',background:'var(--accent)',color:'white',border:'none',borderRadius:'var(--radius)',fontWeight:700,cursor:'pointer',fontSize:13}}>
                {savingGenre?'Saving…':'💾 Save Collections'}
              </button>
            </div>
          )}
          <div style={{display:'flex',flexDirection:'column',gap:4,maxHeight:430,overflowY:'auto'}}>
            {(() => {
              const list = collectionTab==='network' ? networks : genres;
              const matchType = collectionTab==='network' ? 'network' : 'genre';
              const icon = collectionTab==='network' ? '📡' : '🎭';
              const filtered = list.filter(g=>!genreSearch||g.toLowerCase().includes(genreSearch.toLowerCase()));
              if (filtered.length===0) return <div style={{padding:20,textAlign:'center',color:'var(--text-muted)',fontSize:12}}>{list.length===0?`No ${collectionTab}s found — ensure your library has NFO metadata`:`No matches for "${genreSearch}"`}</div>;
              return filtered.map(g=>{
                const active = genreLoops.some(l=>l.genre===g && l.matchType===matchType);
                return(
                  <div key={g} style={{display:'flex',alignItems:'center',gap:12,padding:'10px 14px',background:active?'rgba(99,102,241,0.15)':'var(--bg-card)',border:`1px solid ${active?'rgba(99,102,241,0.5)':'var(--border)'}`,borderRadius:'var(--radius)'}}>
                    <span style={{fontSize:15}}>{icon}</span>
                    <span style={{flex:1,fontSize:13,fontWeight:active?700:400,color:active?'var(--accent)':'var(--text-primary)'}}>{g}</span>
                    {active
                      ? <button onClick={()=>setGenreLoops(genreLoops.filter(l=>!(l.genre===g&&l.matchType===matchType)))}
                          style={{fontSize:11,color:'#ef4444',fontWeight:700,padding:'3px 8px',background:'rgba(239,68,68,0.1)',border:'1px solid rgba(239,68,68,0.3)',borderRadius:'var(--radius)',cursor:'pointer'}}>✕ Remove</button>
                      : <div style={{display:'flex',gap:4,flexShrink:0}}>
                          {['all','episode','movie'].map(mt=>(
                            <button key={mt} onClick={()=>{
                              const newLoop = {genre:g,mediaType:mt,matchType};
                              setGenreLoops(prev=>[...prev.filter(l=>!(l.genre===g&&l.matchType===matchType)),newLoop]);
                            }}
                            style={{padding:'5px 10px',background:mt==='episode'?'rgba(99,102,241,0.2)':mt==='movie'?'rgba(245,158,11,0.2)':'var(--bg-tertiary)',color:mt==='episode'?'#818cf8':mt==='movie'?'#f59e0b':'var(--text-secondary)',border:'1px solid var(--border)',borderRadius:'var(--radius)',cursor:'pointer',fontSize:11,fontWeight:600,whiteSpace:'nowrap'}}>
                              + {mt==='all'?'All':mt==='episode'?'TV Only':'Movies Only'}
                            </button>
                          ))}
                        </div>
                    }
                  </div>
                );
              });
            })()}
          </div>
        </div>
      )}

      {/* ── Queue Mode ── */}
      {channelId&&mode==='queue'&&(
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:20}}>
          {/* Queue */}
          <div>
            <div style={{fontSize:11,fontWeight:700,color:'var(--text-muted)',letterSpacing:1,marginBottom:8,display:'flex',alignItems:'center',justifyContent:'space-between'}}>
              <span>QUEUE ({queue.length} items)</span>
              {queue.length>0&&<button onClick={async()=>{if(window.confirm(`Clear all ${queue.length} items?`)){setQueue([]);try{await call('PUT',`/api/sf/channels/${channelId}/playout`,[]);notify('✅ Playout cleared');}catch(e){notify(e.message,true);}}}} style={{background:'none',border:'1px solid rgba(239,68,68,0.3)',borderRadius:'var(--radius)',color:'#ef4444',cursor:'pointer',fontSize:10,padding:'2px 8px',fontWeight:600}}>🗑 Clear Playout</button>}
            </div>
            {queue.length===0
              ?<div style={{padding:32,textAlign:'center',color:'var(--text-muted)',fontSize:13,border:'1px dashed var(--border)',borderRadius:'var(--radius)'}}>
                <div style={{fontSize:28,marginBottom:8}}>📋</div>
                Click episodes or movies on the right to add them
              </div>
              :<div style={{display:'flex',flexDirection:'column',gap:3,maxHeight:520,overflowY:'auto'}}>
                {queue.map((b,i)=>(
                  <div key={i} style={{display:'flex',alignItems:'center',gap:8,padding:'8px 12px',background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:'var(--radius)',fontSize:12}}>
                    <span style={{color:'var(--text-muted)',flexShrink:0,width:24,textAlign:'right'}}>{i+1}</span>
                    <span style={{flex:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{b.title||b.mediaId}</span>
                    <button onClick={()=>move(i,-1)} style={{background:'none',border:'none',cursor:'pointer',color:'var(--text-muted)',padding:'0 2px',fontSize:10}}>▲</button>
                    <button onClick={()=>move(i,1)} style={{background:'none',border:'none',cursor:'pointer',color:'var(--text-muted)',padding:'0 2px',fontSize:10}}>▼</button>
                    <button onClick={()=>remove(i)} style={{background:'none',border:'none',cursor:'pointer',color:'#ef4444',padding:'0 2px'}}>✕</button>
                  </div>
                ))}
              </div>
            }
          </div>

          {/* Media picker — no live streams */}
          <div>
            <div style={{display:'flex',gap:6,marginBottom:8,alignItems:'center'}}>
              <div style={{fontSize:11,fontWeight:700,color:'var(--text-muted)',letterSpacing:1,flex:1}}>ADD MEDIA</div>
              <button onClick={()=>setMediaType('episode')} style={{padding:'4px 10px',background:mediaType==='episode'?'var(--accent)':'var(--bg-tertiary)',color:mediaType==='episode'?'white':'var(--text-muted)',border:'1px solid var(--border)',borderRadius:'var(--radius)',fontSize:11,cursor:'pointer',fontWeight:600}}>Episodes</button>
              <button onClick={()=>setMediaType('movie')} style={{padding:'4px 10px',background:mediaType==='movie'?'var(--accent)':'var(--bg-tertiary)',color:mediaType==='movie'?'white':'var(--text-muted)',border:'1px solid var(--border)',borderRadius:'var(--radius)',fontSize:11,cursor:'pointer',fontWeight:600}}>Movies</button>
            </div>
            <input value={mediaSearch} onChange={e=>setMediaSearch(e.target.value)}
              placeholder={`Search ${mediaType==='episode'?'episodes':'movies'}…`}
              style={{...sm,width:'100%',marginBottom:8,boxSizing:'border-box'}}/>
            <div style={{maxHeight:460,overflowY:'auto',display:'flex',flexDirection:'column',gap:2}}>
              {displayItems.length===0&&<div style={{padding:20,textAlign:'center',color:'var(--text-muted)',fontSize:12}}>No {mediaType==='episode'?'episodes':'movies'} found{mediaSearch?` matching "${mediaSearch}"`:''}</div>}
              {displayItems.slice(0,150).map(m=>(
                <div key={m.id} onClick={()=>addItem(m)}
                  style={{padding:'7px 10px',background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:'var(--radius)',cursor:'pointer',fontSize:12}}
                  onMouseEnter={e=>e.currentTarget.style.borderColor='var(--accent)'}
                  onMouseLeave={e=>e.currentTarget.style.borderColor='var(--border)'}>
                  <div style={{overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',fontWeight:500}}>{m.title}</div>
                  {m.season&&<div style={{fontSize:10,color:'var(--text-muted)',marginTop:1}}>S{String(m.season).padStart(2,'0')}E{String(m.episode||0).padStart(2,'0')}{m.episodeTitle?` — ${m.episodeTitle}`:''}</div>}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
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
  const [importModal,setImportModal]=useState(false);
  const [importList,setImportList]=useState([]);
  const [importSearch,setImportSearch]=useState('');
  const [importSelected,setImportSelected]=useState(new Set());
  const [importing,setImporting]=useState(false);
  const [importLoading,setImportLoading]=useState(false);
  const [importGroupFilter,setImportGroupFilter]=useState('');

  const [testModal,setTestModal]=useState(null);
  const [testStatus,setTestStatus]=useState('idle'); // idle|loading|playing|error
  const [testError,setTestError]=useState('');
  const testVideoRef=useRef(null);
  const testHlsRef=useRef(null);
  const { API } = useApp();
  const base = API.replace('/api','');

  const load=useCallback(()=>call('GET','/api/sf/streams').then(setStreams).catch(()=>{}),[call]);
  useEffect(()=>{ load(); },[load]);

  const save=async()=>{ if(!form.name.trim()||!form.url.trim()){notify('Name and URL required',true);return;} try{ if(editing) await call('PUT',`/api/sf/streams/${editing.id}`,form); else await call('POST','/api/sf/streams',form); notify('\u2705 Stream saved'); setModal(false); load(); }catch(e){notify(e.message,true);} };
  const del=async(id,name)=>{ if(!window.confirm(`Delete "${name}"?`))return; await call('DELETE',`/api/sf/streams/${id}`);notify('Deleted');load(); };
  const resolve=async()=>{ if(!resolveUrl)return; setResolving(true); try{ const r=await call('POST','/api/sf/streams/resolve',{url:resolveUrl}); if(r.streamUrl){setForm(f=>({...f,url:r.streamUrl}));notify('\u2705 Extracted');}else notify('Could not extract',true); }catch(e){notify(e.message,true);} setResolving(false); };

  const closeTest = () => {
    if (testHlsRef.current) { testHlsRef.current.destroy(); testHlsRef.current=null; }
    if (testVideoRef.current) { testVideoRef.current.src=''; }
    setTestModal(null); setTestStatus('idle'); setTestError('');
  };

  const testStream = async (s) => {
    setTestModal(s); setTestStatus('loading'); setTestError('');
    if (!window.Hls) {
      await new Promise((res,rej)=>{ const sc=document.createElement('script'); sc.src='https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.4.10/hls.min.js'; sc.onload=res; sc.onerror=rej; document.head.appendChild(sc); });
    }
    await new Promise(r=>setTimeout(r,100));
    const video = testVideoRef.current;
    if (!video) return;
    const url = s.url;
    // Try native first (e.g. HLS on Safari), else use HLS.js
    if (window.Hls && window.Hls.isSupported()) {
      const hls = new window.Hls({ liveSyncDurationCount:2, liveMaxLatencyDurationCount:5, manifestLoadingTimeOut:8000, manifestLoadingMaxRetry:1 });
      testHlsRef.current = hls;
      hls.on(window.Hls.Events.ERROR, (e,d) => { if (d.fatal) { setTestStatus('error'); setTestError(d.details||'Stream failed to load'); hls.destroy(); }});
      hls.on(window.Hls.Events.MANIFEST_PARSED, () => { video.play().then(()=>setTestStatus('playing')).catch(()=>setTestStatus('playing')); });
      hls.loadSource(url);
      hls.attachMedia(video);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url;
      video.oncanplay = () => { video.play(); setTestStatus('playing'); };
      video.onerror = () => { setTestStatus('error'); setTestError('Stream failed'); };
    } else {
      // Fall back to direct URL (MPEG-TS etc)
      video.src = url;
      video.oncanplay = () => { video.play(); setTestStatus('playing'); };
      video.onerror = () => { setTestStatus('error'); setTestError('Cannot play this stream format in browser'); };
    }
  };

  const openImportModal=async()=>{ setImportModal(true);setImportLoading(true);setImportSearch('');setImportGroupFilter(''); try{ const r=await call('GET','/api/sf/import/orion-iptv/preview'); setImportList(r.channels||[]); setImportSelected(new Set((r.channels||[]).filter(c=>c.alreadyImported).map(c=>c.id))); }catch(e){notify(e.message,true);setImportModal(false);} setImportLoading(false); };
  const doImport=async()=>{ const orig=new Set(importList.filter(c=>c.alreadyImported).map(c=>c.id)); const toAdd=[...importSelected].filter(id=>!orig.has(id)); const toRemove=[...orig].filter(id=>!importSelected.has(id)); if(!toAdd.length&&!toRemove.length){notify('No changes');return;} setImporting(true); try{ const rs=importList.filter(c=>toRemove.includes(c.id)&&c.sfStreamId).map(c=>c.sfStreamId); const rc=importList.filter(c=>toRemove.includes(c.id)&&c.sfChannelId).map(c=>c.sfChannelId); const r=await call('POST','/api/sf/import/orion-iptv/sync',{selectedIds:toAdd,removeStreamIds:rs,removeChannelIds:rc}); notify(`\u2705 Added ${r.added}, removed ${r.removed}`); setImportModal(false);load(); }catch(e){notify(e.message,true);} setImporting(false); };

  const importGroups=[...new Set(importList.map(c=>c.group).filter(Boolean))].sort();
  const filteredImport=importList.filter(c=>{ const ms=!importSearch||c.name.toLowerCase().includes(importSearch.toLowerCase())||(c.group||'').toLowerCase().includes(importSearch.toLowerCase()); const mg=!importGroupFilter||c.group===importGroupFilter; return ms&&mg; });
  const allSel=filteredImport.length>0&&filteredImport.every(c=>importSelected.has(c.id));
  const toggleAll=()=>{ const n=new Set(importSelected); if(allSel) filteredImport.forEach(c=>n.delete(c.id)); else filteredImport.forEach(c=>n.add(c.id)); setImportSelected(n); };

  const inp={width:'100%',padding:'9px 12px',background:'var(--bg-tertiary)',border:'1px solid var(--border)',borderRadius:'var(--radius)',color:'var(--text-primary)',fontSize:13,outline:'none',boxSizing:'border-box'};

  return (
    <div>
      <Toast {...toast}/>
      {/* Test stream modal */}
      {testModal && (
        <div style={{ position:'fixed',inset:0,zIndex:2000,background:'rgba(0,0,0,0.85)',display:'flex',alignItems:'center',justifyContent:'center',padding:24 }} onClick={closeTest}>
          <div style={{ background:'#000',border:'1px solid var(--border)',borderRadius:'var(--radius-lg)',width:'100%',maxWidth:720,boxShadow:'0 20px 60px rgba(0,0,0,0.8)' }} onClick={e=>e.stopPropagation()}>
            <div style={{ display:'flex',alignItems:'center',justifyContent:'space-between',padding:'12px 18px',borderBottom:'1px solid rgba(255,255,255,0.08)' }}>
              <div style={{ fontSize:13,fontWeight:700,color:'white' }}>▶ Testing: {testModal.name}</div>
              <button onClick={closeTest} style={{ background:'none',border:'none',color:'rgba(255,255,255,0.5)',cursor:'pointer',fontSize:20,lineHeight:1 }}>×</button>
            </div>
            <div style={{ position:'relative',background:'#000',aspectRatio:'16/9' }}>
              <video ref={testVideoRef} style={{ width:'100%',height:'100%',display:'block' }} controls autoPlay muted/>
              {testStatus !== 'playing' && (
                <div style={{ position:'absolute',inset:0,display:'flex',alignItems:'center',justifyContent:'center',flexDirection:'column',gap:12,background:'rgba(0,0,0,0.7)' }}>
                  {testStatus==='loading' && <><div style={{ width:36,height:36,border:'3px solid rgba(255,255,255,0.1)',borderTop:'3px solid #06b6d4',borderRadius:'50%',animation:'spin 0.8s linear infinite' }}/><div style={{ color:'rgba(255,255,255,0.6)',fontSize:13 }}>Connecting…</div></>}
                  {testStatus==='error' && <><div style={{ fontSize:28 }}>⚠️</div><div style={{ color:'#ef4444',fontSize:13,textAlign:'center',maxWidth:280 }}>{testError}</div></>}
                  <style>{'@keyframes spin{to{transform:rotate(360deg)}}'}</style>
                </div>
              )}
            </div>
            <div style={{ padding:'10px 18px',fontSize:11,color:'rgba(255,255,255,0.3)',borderTop:'1px solid rgba(255,255,255,0.06)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' }}>{testModal.url}</div>
          </div>
        </div>
      )}

      {importModal&&(
        <div style={{ position:'fixed',inset:0,zIndex:2000,background:'rgba(0,0,0,0.75)',display:'flex',alignItems:'center',justifyContent:'center',padding:24 }} onClick={()=>setImportModal(false)}>
          <div style={{ background:'var(--bg-secondary)',border:'1px solid var(--border)',borderRadius:'var(--radius-lg)',width:'100%',maxWidth:580,maxHeight:'85vh',display:'flex',flexDirection:'column',boxShadow:'0 20px 60px rgba(0,0,0,0.6)' }} onClick={e=>e.stopPropagation()}>
            <div style={{ padding:'18px 24px',borderBottom:'1px solid var(--border)',display:'flex',alignItems:'center',justifyContent:'space-between' }}>
              <div style={{ fontWeight:700,fontSize:16 }}>\u2b07\ufe0f Import from Orion IPTV</div>
              <button onClick={()=>setImportModal(false)} style={{ background:'none',border:'none',color:'var(--text-muted)',cursor:'pointer',fontSize:20,lineHeight:1 }}>\u00d7</button>
            </div>
            <div style={{ padding:'14px 24px',borderBottom:'1px solid var(--border)',display:'flex',gap:8,alignItems:'center' }}>
              <input value={importSearch} onChange={e=>setImportSearch(e.target.value)} placeholder="Search channels\u2026" style={{ flex:1,padding:'8px 12px',background:'var(--bg-tertiary)',border:'1px solid var(--border)',borderRadius:'var(--radius)',color:'var(--text-primary)',fontSize:13,outline:'none' }}/>
              <select value={importGroupFilter} onChange={e=>setImportGroupFilter(e.target.value)} style={{ padding:'8px 10px',background:'var(--bg-tertiary)',border:'1px solid var(--border)',borderRadius:'var(--radius)',color:'var(--text-primary)',fontSize:12,outline:'none',maxWidth:160 }}>
                <option value="">All Groups</option>{importGroups.map(g=><option key={g} value={g}>{g}</option>)}
              </select>
              <button onClick={toggleAll} style={{ padding:'8px 12px',background:'rgba(255,255,255,0.06)',border:'1px solid var(--border)',borderRadius:'var(--radius)',color:'var(--text-secondary)',cursor:'pointer',fontSize:12,whiteSpace:'nowrap' }}>{allSel?'Deselect All':'Select All'}</button>
            </div>
            <div style={{ overflowY:'auto',flex:1,padding:'8px 16px' }}>
              {importLoading?<div style={{ textAlign:'center',padding:40,color:'var(--text-muted)' }}>Loading\u2026</div>:filteredImport.length===0?<div style={{ textAlign:'center',padding:40,color:'var(--text-muted)' }}>No channels</div>:filteredImport.map(c=>(
                <div key={c.id} onClick={()=>{ const s=new Set(importSelected); s.has(c.id)?s.delete(c.id):s.add(c.id); setImportSelected(s); }}
                  style={{ display:'flex',alignItems:'center',gap:12,padding:'9px 10px',borderRadius:'var(--radius)',cursor:'pointer',background:importSelected.has(c.id)?'rgba(99,102,241,0.12)':'transparent',marginBottom:2 }}
                  onMouseEnter={e=>{ e.currentTarget.style.background=importSelected.has(c.id)?'rgba(99,102,241,0.18)':'rgba(255,255,255,0.04)'; }}
                  onMouseLeave={e=>{ e.currentTarget.style.background=importSelected.has(c.id)?'rgba(99,102,241,0.12)':'transparent'; }}>
                  <input type="checkbox" readOnly checked={importSelected.has(c.id)} style={{ flexShrink:0 }}/>
                  {c.logo?<img src={c.logo} alt="" style={{ width:32,height:22,objectFit:'contain',borderRadius:3,flexShrink:0 }} onError={e=>e.target.style.display='none'}/>:<span style={{ width:32,textAlign:'center',fontSize:16 }}>\ud83d\udce1</span>}
                  <div style={{ flex:1,minWidth:0 }}><div style={{ fontSize:13,fontWeight:600,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' }}>{c.name}</div>{c.group&&<div style={{ fontSize:11,color:'var(--text-muted)' }}>{c.group}</div>}</div>
                  {c.alreadyImported&&<span style={{ fontSize:11,color:'#10b981',flexShrink:0 }}>\u2713 In SF</span>}
                </div>
              ))}
            </div>
            <div style={{ padding:'16px 24px',borderTop:'1px solid var(--border)',display:'flex',alignItems:'center',justifyContent:'space-between' }}>
              <div style={{ fontSize:12,color:'var(--text-muted)' }}>{[...importSelected].filter(id=>!new Set(importList.filter(c=>c.alreadyImported).map(c=>c.id)).has(id)).length} to add</div>
              <div style={{ display:'flex',gap:8 }}>
                <button onClick={()=>setImportModal(false)} style={{ padding:'9px 18px',background:'rgba(255,255,255,0.06)',border:'1px solid var(--border)',borderRadius:'var(--radius)',color:'var(--text-secondary)',cursor:'pointer',fontSize:13 }}>Cancel</button>
                <button onClick={doImport} disabled={importing} style={{ padding:'9px 20px',background:'var(--accent)',border:'none',borderRadius:'var(--radius)',color:'white',fontWeight:700,cursor:'pointer',fontSize:13 }}>{importing?'Applying\u2026':'Apply Changes'}</button>
              </div>
            </div>
          </div>
        </div>
      )}
      <div style={{ display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:20 }}>
        <div style={{ fontSize:13,color:'var(--text-muted)' }}>{streams.length} streams</div>
        <div style={{ display:'flex',gap:8 }}>
          <button onClick={openImportModal} style={{ padding:'7px 14px',background:'rgba(99,102,241,0.12)',border:'1px solid rgba(99,102,241,0.3)',borderRadius:'var(--radius)',color:'#818cf8',fontWeight:600,cursor:'pointer',display:'flex',alignItems:'center',gap:6,fontSize:12 }}>\u2b07\ufe0f Import from Orion IPTV</button>
          <button onClick={()=>{setEditing(null);setForm({name:'',url:'',group:'',logo:''});setModal(true);}} style={{ padding:'7px 14px',background:'var(--accent)',color:'white',border:'none',borderRadius:'var(--radius)',fontWeight:600,cursor:'pointer',display:'flex',alignItems:'center',gap:6,fontSize:12 }}><Plus size={13}/> Add Stream</button>
        </div>
      </div>
      {streams.length===0?<div className="empty-state"><div className="empty-state-icon">\ud83d\udce1</div><h3>No live streams yet</h3><p>Add stream URLs or import from Orion IPTV.</p></div>
        :<div style={{ display:'flex',flexDirection:'column',gap:8 }}>
          {streams.map(s=>(
            <div key={s.id} style={{ display:'flex',alignItems:'center',gap:14,padding:'14px 18px',background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:'var(--radius-lg)' }} onMouseEnter={e=>e.currentTarget.style.borderColor='var(--border-accent)'} onMouseLeave={e=>e.currentTarget.style.borderColor='var(--border)'}>
              <span style={{ fontSize:20,flexShrink:0 }}>\ud83d\udce1</span>
              <div style={{ flex:1,minWidth:0 }}><div style={{ fontWeight:700,fontSize:14 }}>{s.name}</div><div style={{ fontSize:11,color:'var(--text-muted)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',marginTop:2 }}>{s.url}</div></div>
              <div style={{ display:'flex',gap:6 }}>
                <button onClick={()=>testStream(s)} style={{ padding:'6px 12px',background:'rgba(6,182,212,0.12)',border:'1px solid rgba(6,182,212,0.3)',borderRadius:'var(--radius)',color:'#06b6d4',cursor:'pointer',fontSize:12,fontWeight:700,display:'flex',alignItems:'center',gap:5 }}>▶ Test</button>
                <button onClick={()=>{setEditing(s);setForm({name:s.name,url:s.url,group:s.group||'',logo:s.logo||''});setModal(true);}} style={{ padding:'6px 10px',background:'var(--bg-tertiary)',border:'1px solid var(--border)',borderRadius:'var(--radius)',color:'var(--text-secondary)',cursor:'pointer' }}><Edit2 size={13}/></button>
                <button onClick={()=>del(s.id,s.name)} style={{ padding:'6px 10px',background:'rgba(239,68,68,0.08)',border:'1px solid rgba(239,68,68,0.2)',borderRadius:'var(--radius)',color:'#ef4444',cursor:'pointer' }}><Trash2 size={13}/></button>
              </div>
            </div>
          ))}
        </div>
      }
      <Modal open={modal} onClose={()=>setModal(false)} title={editing?`Edit: ${editing.name}`:'Add Live Stream'}>
        <Field label="Stream Name"><input style={inp} value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))}/></Field>
        <Field label="Stream URL"><input style={inp} value={form.url} onChange={e=>setForm(f=>({...f,url:e.target.value}))} placeholder="https://\u2026 or rtmp://\u2026"/></Field>
        <Field label="Group"><input style={inp} value={form.group} onChange={e=>setForm(f=>({...f,group:e.target.value}))}/></Field>
        <Field label="Logo URL"><input style={inp} value={form.logo} onChange={e=>setForm(f=>({...f,logo:e.target.value}))}/></Field>
        <Field label="Resolve from page URL" hint="Paste a player page and extract the stream URL"><div style={{ display:'flex',gap:8 }}><input style={{...inp,flex:1}} value={resolveUrl} onChange={e=>setResolveUrl(e.target.value)} placeholder="https://\u2026"/><button onClick={resolve} disabled={resolving} style={{ padding:'9px 14px',background:'var(--bg-tertiary)',border:'1px solid var(--border)',borderRadius:'var(--radius)',color:'var(--text-secondary)',cursor:'pointer',fontSize:12,whiteSpace:'nowrap' }}>{resolving?'\u2026':'Extract'}</button></div></Field>
        <div style={{ display:'flex',gap:10,marginTop:8 }}>
          <button onClick={()=>setModal(false)} style={{ flex:1,padding:'10px',background:'var(--bg-tertiary)',border:'1px solid var(--border)',borderRadius:'var(--radius)',color:'var(--text-secondary)',cursor:'pointer',fontWeight:600 }}>Cancel</button>
          <button onClick={save} style={{ flex:2,padding:'10px',background:'var(--accent)',color:'white',border:'none',borderRadius:'var(--radius)',fontWeight:700,cursor:'pointer' }}>Save Stream</button>
        </div>
      </Modal>
    </div>
  );
}

// ── EPG ───────────────────────────────────────────────────────────────────────
function EPGManager({ call }) {
  const [epg,setEpg]=useState({channels:[],programs:[],importedAt:null,disabledChannels:[]});
  const [disabled,setDisabled]=useState(new Set());
  const [epgSearch,setEpgSearch]=useState('');
  const [epgGroup,setEpgGroup]=useState('');
  const [collapsedGroups,setCollapsedGroups]=useState(new Set());
  const [importUrl,setImportUrl]=useState('');
  const [importing,setImporting]=useState(false);
  const [browse,setBrowse]=useState(null);
  const [toast,notify]=useToast();
  const [epgTab,setEpgTab]=useState('url');

  // Schedules Direct state
  const [sdUser,setSdUser]=useState('');
  const [sdPass,setSdPass]=useState('');
  const [sdToken,setSdToken]=useState('');
  const [sdLoggingIn,setSdLoggingIn]=useState(false);
  const [sdLineups,setSdLineups]=useState([]);
  const [sdSearchZip,setSdSearchZip]=useState('');
  const [sdSearchCountry,setSdSearchCountry]=useState('USA');
  const [sdHeadends,setSdHeadends]=useState([]);
  const [sdSearching,setSdSearching]=useState(false);
  const [sdLineupId,setSdLineupId]=useState('');
  const [sdDays,setSdDays]=useState(7);
  const [sdImporting,setSdImporting]=useState(false);
  const [sdSavedConfig,setSdSavedConfig]=useState(null);

  const load=()=>call('GET','/api/sf/epg').then(d=>{ setEpg(d); setDisabled(new Set(d.disabledChannels||[])); }).catch(()=>{});
  useEffect(()=>{
    load();
    call('GET','/api/sf/sd/config').then(c=>{ setSdSavedConfig(c); if(c.username) setSdUser(c.username); if(c.lineupId) setSdLineupId(c.lineupId); }).catch(()=>{});
  },[]);

  const toggleDisabled = async (ch, e) => {
    e.stopPropagation();
    const nowDisabled = !disabled.has(ch.id);
    const next = new Set(disabled);
    nowDisabled ? next.add(ch.id) : next.delete(ch.id);
    setDisabled(next);
    try { await call('POST', '/api/sf/epg/disabled', { channelId: ch.id, disabled: nowDisabled }); }
    catch(err) { notify(err.message, true); setDisabled(disabled); } // revert on error
  };

  const importEpg=async()=>{ if(!importUrl.trim())return; setImporting(true); try{ const r=await call('POST','/api/sf/epg/import',{url:importUrl});notify(`✅ Imported ${r.channels} channels, ${r.programs} programs`);await load(); }catch(e){notify(e.message,true);} setImporting(false); };

  const sdLogin=async()=>{ if(!sdUser||!sdPass){notify('Username and password required',true);return;} setSdLoggingIn(true); try{ const r=await call('POST','/api/sf/sd/token',{username:sdUser,password:sdPass}); setSdToken(r.token); const l=await call('GET',`/api/sf/sd/lineups?token=${r.token}`); setSdLineups(l.lineups||[]); notify('✅ Logged in to Schedules Direct'); }catch(e){notify(e.message,true);} setSdLoggingIn(false); };

  const sdSearch=async()=>{ if(!sdToken){notify('Log in first',true);return;} if(!sdSearchZip){notify('Enter a postal code',true);return;} setSdSearching(true); try{ const r=await call('GET',`/api/sf/sd/headends?token=${sdToken}&country=${sdSearchCountry}&postalcode=${sdSearchZip}`); setSdHeadends(r||[]); }catch(e){notify(e.message,true);} setSdSearching(false); };

  const sdAddLineup=async(id)=>{ try{ await call('PUT',`/api/sf/sd/lineups/${id}?token=${sdToken}`); const l=await call('GET',`/api/sf/sd/lineups?token=${sdToken}`); setSdLineups(l.lineups||[]); setSdLineupId(id); notify(`✅ Added lineup`); }catch(e){notify(e.message,true);} };

  const sdImport=async()=>{ if(!sdUser||!sdPass||!sdLineupId){notify('Log in and select a lineup first',true);return;} setSdImporting(true); try{ const r=await call('POST','/api/sf/sd/import',{username:sdUser,password:sdPass,lineupId:sdLineupId,daysAhead:sdDays,save:true}); notify(`✅ Imported ${r.channels} channels, ${r.programs} programs`); await load(); setSdSavedConfig({username:sdUser,lineupId:sdLineupId,autoUpdate:true,hasPassword:true}); }catch(e){notify(e.message,true);} setSdImporting(false); };

  const sdRefresh=async()=>{ setSdImporting(true); try{ const r=await call('POST','/api/sf/sd/refresh'); notify(`✅ Refreshed: ${r.programs} programs`); await load(); }catch(e){notify(e.message,true);} setSdImporting(false); };

  const programs = browse ? epg.programs.filter(p=>p.channel===browse.id).sort((a,b)=>a.start-b.start) : [];

  return (
    <div>
      <Toast {...toast}/>

      {/* Tab switcher */}
      <div style={{ display:'flex',gap:2,marginBottom:20,borderBottom:'1px solid var(--border)',paddingBottom:0 }}>
        {[{id:'url',label:'📥 XMLTV / URL'},{id:'sd',label:'📡 Schedules Direct'}].map(t=>(
          <button key={t.id} onClick={()=>setEpgTab(t.id)} style={{ padding:'10px 20px',border:'none',cursor:'pointer',background:'transparent',color:epgTab===t.id?'var(--accent)':'var(--text-muted)',borderBottom:epgTab===t.id?'2px solid var(--accent)':'2px solid transparent',fontWeight:600,fontSize:13,marginBottom:-1 }}>{t.label}</button>
        ))}
      </div>

      {/* XMLTV / URL tab */}
      {epgTab==='url' && (
        <div style={{ background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:'var(--radius-lg)',padding:20,marginBottom:20 }}>
          <div style={{ fontWeight:700,fontSize:14,marginBottom:14 }}>📥 Import EPG from URL</div>
          <div style={{ display:'flex',gap:10,marginBottom:12 }}>
            <input style={{ ...inp,flex:1 }} value={importUrl} onChange={e=>setImportUrl(e.target.value)} placeholder="XMLTV URL (http://…/guide.xml)" onKeyDown={e=>e.key==='Enter'&&importEpg()}/>
            <button onClick={importEpg} disabled={importing} style={{ padding:'9px 16px',background:'var(--accent)',color:'white',border:'none',borderRadius:'var(--radius)',fontWeight:600,cursor:'pointer',flexShrink:0 }}>{importing?'Importing…':'Import'}</button>
          </div>
          {epg.importedAt&&<div style={{ fontSize:12,color:'var(--text-muted)' }}>Last imported: {new Date(epg.importedAt).toLocaleString()} · {epg.channels.length} channels · {epg.programs.length.toLocaleString()} programs</div>}
        </div>
      )}

      {/* Schedules Direct tab */}
      {epgTab==='sd' && (
        <div style={{ marginBottom:20 }}>
          {/* Saved config banner */}
          {sdSavedConfig?.username && (
            <div style={{ display:'flex',alignItems:'center',gap:12,padding:'12px 16px',background:'rgba(16,185,129,0.08)',border:'1px solid rgba(16,185,129,0.25)',borderRadius:'var(--radius-lg)',marginBottom:16 }}>
              <div style={{ width:8,height:8,borderRadius:'50%',background:'#10b981',boxShadow:'0 0 6px #10b981',flexShrink:0 }}/>
              <div style={{ flex:1,fontSize:13 }}>
                <span style={{ fontWeight:700,color:'#10b981' }}>Schedules Direct configured</span>
                <span style={{ color:'var(--text-muted)',marginLeft:10 }}>{sdSavedConfig.username} · {sdSavedConfig.lineupId}</span>
                {sdSavedConfig.autoUpdate && <span style={{ marginLeft:10,fontSize:11,color:'var(--accent)' }}>Auto-refresh daily ✓</span>}
              </div>
              <button onClick={sdRefresh} disabled={sdImporting} style={{ padding:'7px 14px',background:'var(--accent)',color:'white',border:'none',borderRadius:'var(--radius)',fontWeight:600,cursor:'pointer',fontSize:12 }}>
                {sdImporting?'Refreshing…':'↻ Refresh Now'}
              </button>
            </div>
          )}

          {/* Login */}
          <div style={{ background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:'var(--radius-lg)',padding:20,marginBottom:16 }}>
            <div style={{ fontWeight:700,fontSize:14,marginBottom:4 }}>🔐 Schedules Direct Login</div>
            <div style={{ fontSize:12,color:'var(--text-muted)',marginBottom:14 }}>
              Free account at <button onClick={()=>window.electron?.openExternal('https://www.schedulesdirect.org')} style={{ background:'none',border:'none',color:'var(--accent)',cursor:'pointer',padding:0,fontSize:12 }}>schedulesdirect.org</button> — 7-day free trial, then ~$25/yr for full US/Canada EPG.
            </div>
            <div style={{ display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,marginBottom:12 }}>
              <div>
                <label style={{ display:'block',fontSize:11,fontWeight:700,color:'var(--text-muted)',letterSpacing:1,textTransform:'uppercase',marginBottom:5 }}>Username</label>
                <input style={inp} value={sdUser} onChange={e=>setSdUser(e.target.value)} placeholder="your@email.com"/>
              </div>
              <div>
                <label style={{ display:'block',fontSize:11,fontWeight:700,color:'var(--text-muted)',letterSpacing:1,textTransform:'uppercase',marginBottom:5 }}>Password</label>
                <input style={inp} type="password" value={sdPass} onChange={e=>setSdPass(e.target.value)} onKeyDown={e=>e.key==='Enter'&&sdLogin()}/>
              </div>
            </div>
            <button onClick={sdLogin} disabled={sdLoggingIn||!!sdToken} style={{ padding:'9px 20px',background:sdToken?'rgba(16,185,129,0.15)':' var(--accent)',color:sdToken?'#10b981':'white',border:sdToken?'1px solid rgba(16,185,129,0.3)':'none',borderRadius:'var(--radius)',fontWeight:700,cursor:'pointer',fontSize:13 }}>
              {sdLoggingIn?'Logging in…':sdToken?'✓ Logged In':'Log In'}
            </button>
          </div>

          {/* Lineup picker */}
          {sdToken && (
            <div style={{ background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:'var(--radius-lg)',padding:20,marginBottom:16 }}>
              <div style={{ fontWeight:700,fontSize:14,marginBottom:14 }}>📋 Select Lineup</div>

              {/* Subscribed lineups */}
              {sdLineups.length>0 && (
                <div style={{ marginBottom:16 }}>
                  <div style={{ fontSize:11,fontWeight:700,color:'var(--text-muted)',letterSpacing:1,marginBottom:8,textTransform:'uppercase' }}>Your Subscribed Lineups</div>
                  {sdLineups.map(l=>(
                    <div key={l.lineup} onClick={()=>setSdLineupId(l.lineup)} style={{ display:'flex',alignItems:'center',gap:12,padding:'10px 14px',borderRadius:'var(--radius)',cursor:'pointer',marginBottom:4,background:sdLineupId===l.lineup?'rgba(99,102,241,0.12)':'var(--bg-tertiary)',border:`1px solid ${sdLineupId===l.lineup?'var(--accent)':'var(--border)'}`,transition:'all 0.15s' }}>
                      <div style={{ flex:1 }}><div style={{ fontWeight:600,fontSize:13 }}>{l.name}</div><div style={{ fontSize:11,color:'var(--text-muted)' }}>{l.lineup} · {l.location}</div></div>
                      {sdLineupId===l.lineup && <span style={{ color:'var(--accent)',fontWeight:700 }}>✓</span>}
                    </div>
                  ))}
                </div>
              )}

              {/* Search for new lineups */}
              <div style={{ fontSize:11,fontWeight:700,color:'var(--text-muted)',letterSpacing:1,marginBottom:8,textTransform:'uppercase' }}>Find Lineups by Postal Code</div>
              <div style={{ display:'flex',gap:10,marginBottom:8 }}>
                <select style={{ ...inp,width:90 }} value={sdSearchCountry} onChange={e=>setSdSearchCountry(e.target.value)}>
                  <option value="USA">🇺🇸 USA</option>
                  <option value="CAN">🇨🇦 CAN</option>
                  <option value="GBR">🇬🇧 GBR</option>
                  <option value="AUS">🇦🇺 AUS</option>
                </select>
                <input style={{ ...inp,flex:1 }} value={sdSearchZip} onChange={e=>setSdSearchZip(e.target.value)} placeholder="ZIP / Postal code" onKeyDown={e=>e.key==='Enter'&&sdSearch()}/>
                <button onClick={sdSearch} disabled={sdSearching} style={{ padding:'9px 16px',background:'var(--bg-tertiary)',border:'1px solid var(--border)',borderRadius:'var(--radius)',color:'var(--text-secondary)',fontWeight:600,cursor:'pointer',fontSize:13,flexShrink:0 }}>{sdSearching?'Searching…':'Search'}</button>
              </div>
              {sdHeadends.length>0 && (
                <div style={{ maxHeight:200,overflowY:'auto',display:'flex',flexDirection:'column',gap:4 }}>
                  {sdHeadends.flatMap(h=>(h.lineups||[]).map(l=>({ ...l, headend: h.headend, location: h.location, type: h.type }))).map(l=>(
                    <div key={l.lineup} style={{ display:'flex',alignItems:'center',gap:12,padding:'8px 12px',borderRadius:'var(--radius)',cursor:'pointer',background:'var(--bg-tertiary)',border:'1px solid var(--border)',transition:'all 0.15s' }}
                      onMouseEnter={e=>e.currentTarget.style.borderColor='var(--border-accent)'} onMouseLeave={e=>e.currentTarget.style.borderColor='var(--border)'}>
                      <div style={{ flex:1 }}><div style={{ fontWeight:600,fontSize:12 }}>{l.name}</div><div style={{ fontSize:10,color:'var(--text-muted)' }}>{l.lineup} · {l.type} · {l.location}</div></div>
                      <button onClick={()=>sdAddLineup(l.lineup)} style={{ padding:'5px 12px',background:'var(--accent)',color:'white',border:'none',borderRadius:'var(--radius)',cursor:'pointer',fontSize:11,fontWeight:600,flexShrink:0 }}>Add</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Import button */}
          {sdToken && sdLineupId && (
            <div style={{ background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:'var(--radius-lg)',padding:20 }}>
              <div style={{ fontWeight:700,fontSize:14,marginBottom:6 }}>📥 Import EPG Data</div>
              <div style={{ fontSize:12,color:'var(--text-muted)',marginBottom:14 }}>Selected lineup: <strong style={{ color:'var(--accent)' }}>{sdLineupId}</strong></div>
              <div style={{ display:'flex',alignItems:'center',gap:12,marginBottom:14 }}>
                <label style={{ fontSize:13,color:'var(--text-secondary)' }}>Days ahead:</label>
                <input type="number" style={{ ...inp,width:80 }} value={sdDays} onChange={e=>setSdDays(+e.target.value)} min={1} max={14}/>
              </div>
              <button onClick={sdImport} disabled={sdImporting} style={{ width:'100%',padding:'12px',background:'var(--accent)',color:'white',border:'none',borderRadius:'var(--radius)',fontWeight:700,cursor:'pointer',fontSize:14,display:'flex',alignItems:'center',justifyContent:'center',gap:8 }}>
                {sdImporting?'⏳ Importing…':'📡 Import from Schedules Direct'}
              </button>
              <div style={{ fontSize:11,color:'var(--text-muted)',marginTop:8,textAlign:'center' }}>Credentials and lineup will be saved for daily auto-refresh</div>
            </div>
          )}
        </div>
      )}
      {epg.channels.length>0&&(
        <div>
          {/* Header with search */}
          <div style={{ display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:14 }}>
            <div style={{ fontWeight:700,fontSize:13,color:'var(--text-muted)',textTransform:'uppercase',letterSpacing:1 }}>
              EPG Channels ({epg.channels.length})
              {disabled.size > 0 && <span style={{ marginLeft:10,fontSize:11,color:'#ef4444',fontWeight:400,textTransform:'none',letterSpacing:0 }}>{disabled.size} disabled</span>}
            </div>
            <input value={epgSearch} onChange={e=>setEpgSearch(e.target.value)} placeholder="Search channels…"
              style={{ padding:'6px 12px',background:'var(--bg-secondary)',border:'1px solid var(--border)',borderRadius:'var(--radius)',color:'var(--text-primary)',fontSize:12,outline:'none',width:200 }}/>
          </div>

          {/* Grouped view */}
          {(()=>{
            const grouped = {};
            epg.channels
              .filter(ch => !epgSearch || ch.name.toLowerCase().includes(epgSearch.toLowerCase()))
              .forEach(ch => { const g = ch.group||'Ungrouped'; if(!grouped[g]) grouped[g]=[]; grouped[g].push(ch); });
            return Object.keys(grouped).sort().map(group => {
              const chs = grouped[group];
              const allDisabled = chs.every(c => disabled.has(c.id));
              const someDisabled = chs.some(c => disabled.has(c.id));
              const isCollapsed = !epgSearch && !collapsedGroups?.has(group) === false;
              // groups start expanded; track collapsed ones
              const collapsed = collapsedGroups?.has(group);

              const toggleGroup = async (e) => {
                e.stopPropagation();
                const nowDisabling = !allDisabled;
                const ids = chs.map(c => c.id);
                // Optimistic update
                setDisabled(prev => {
                  const next = new Set(prev);
                  ids.forEach(id => nowDisabling ? next.add(id) : next.delete(id));
                  return next;
                });
                try {
                  await call('POST', '/api/sf/epg/disabled/bulk', { channelIds: ids, disabled: nowDisabling });
                } catch(err) {
                  notify(err.message, true);
                  // Revert on error
                  setDisabled(prev => {
                    const next = new Set(prev);
                    ids.forEach(id => nowDisabling ? next.delete(id) : next.add(id));
                    return next;
                  });
                }
              };

              return (
                <div key={group} style={{ marginBottom:8,border:'1px solid var(--border)',borderRadius:'var(--radius-lg)',overflow:'hidden' }}>
                  {/* Group header */}
                  <div style={{ display:'flex',alignItems:'center',gap:12,padding:'10px 16px',background:'var(--bg-secondary)',cursor:'pointer',userSelect:'none' }}
                    onClick={()=>{ const s=new Set(collapsedGroups||[]); s.has(group)?s.delete(group):s.add(group); setCollapsedGroups(s); }}>
                    <span style={{ fontSize:12,color:'var(--text-muted)',transform:collapsed?'rotate(-90deg)':'rotate(0deg)',transition:'transform 0.2s',display:'inline-block' }}>▼</span>
                    {/* Group checkbox — tri-state */}
                    <label onClick={e=>e.stopPropagation()} style={{ display:'flex',alignItems:'center',cursor:'pointer',flexShrink:0 }}>
                      <input type="checkbox"
                        ref={el=>{ if(el){ el.indeterminate=someDisabled&&!allDisabled; } }}
                        checked={!allDisabled}
                        onChange={e=>toggleGroup(e)}
                        style={{ width:15,height:15,cursor:'pointer' }}/>
                    </label>
                    <span style={{ fontWeight:700,fontSize:13,flex:1 }}>{group}</span>
                    <span style={{ fontSize:11,color:'var(--text-muted)' }}>{chs.length} channels</span>
                    {allDisabled && <span style={{ fontSize:11,color:'#ef4444',fontWeight:600 }}>All disabled</span>}
                    {someDisabled && !allDisabled && <span style={{ fontSize:11,color:'#f59e0b',fontWeight:600 }}>{chs.filter(c=>disabled.has(c.id)).length} disabled</span>}
                  </div>
                  {/* Channel list inside group */}
                  {!collapsed && (
                    <div style={{ display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(200px,1fr))',gap:6,padding:10,background:'var(--bg-primary)' }}>
                      {chs.map(ch=>{
                        const isDisabled = disabled.has(ch.id);
                        return (
                          <div key={ch.id}
                            style={{ display:'flex',alignItems:'center',gap:8,padding:'8px 10px',
                              background:isDisabled?'rgba(239,68,68,0.06)':'var(--bg-card)',
                              border:`1px solid ${browse?.id===ch.id?'var(--accent)':isDisabled?'rgba(239,68,68,0.25)':'var(--border)'}`,
                              borderRadius:'var(--radius)',opacity:isDisabled?0.6:1,transition:'all 0.15s' }}>
                            <label onClick={e=>e.stopPropagation()} style={{ flexShrink:0,cursor:'pointer' }}>
                              <input type="checkbox" checked={!isDisabled} onChange={e=>toggleDisabled(ch,e)} style={{ width:13,height:13,cursor:'pointer' }}/>
                            </label>
                            <div onClick={()=>setBrowse(browse?.id===ch.id?null:ch)} style={{ display:'flex',alignItems:'center',gap:8,flex:1,minWidth:0,cursor:'pointer' }}>
                              {ch.logo?<img src={ch.logo} alt="" style={{ width:22,height:22,objectFit:'contain',borderRadius:3,flexShrink:0 }} onError={e=>e.target.style.display='none'}/>:<span style={{ fontSize:14,flexShrink:0 }}>📅</span>}
                              <div style={{ flex:1,minWidth:0 }}>
                                <div style={{ fontSize:12,fontWeight:600,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' }}>{ch.name}</div>
                                <div style={{ fontSize:10,color:'var(--text-muted)' }}>{epg.programs.filter(p=>p.channel===ch.id).length} progs</div>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            });
          })()}

          {browse&&(
            <div style={{ marginTop:16,background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:'var(--radius-lg)',overflow:'hidden' }}>
              <div style={{ padding:'14px 18px',borderBottom:'1px solid var(--border)',fontWeight:700,fontSize:14,display:'flex',alignItems:'center',justifyContent:'space-between' }}>
                <span>📅 {browse.name}</span>
                <button onClick={()=>setBrowse(null)} style={{ background:'none',border:'none',color:'var(--text-muted)',cursor:'pointer',fontSize:18 }}>×</button>
              </div>
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
  const { API } = useApp();
  const base = API.replace('/api','');
  const [channels,setChannels]=useState([]);
  const [epgChannels,setEpgChannels]=useState([]);
  const [streams,setStreams]=useState([]);
  const [targetCh,setTargetCh]=useState('');
  const [epgCh,setEpgCh]=useState('');
  const [date,setDate]=useState(new Date().toISOString().slice(0,10));
  const DEFAULT_PROMPT = `Match my library to the EPG schedule as closely as possible:
- Use TV shows when the EPG slot is a TV show, movies when it is a movie
- Honor the original air time — if a show airs at 9 PM on the EPG, schedule my matching show at 9 PM
- Match genre: news slots get news/documentary, drama slots get drama, comedy slots get comedy, kids slots get kids content
- Prefer the episode that would be next in sequence (lowest unwatched season/episode number)
- Fill every slot — if there is no exact match, use the closest genre fit from my library
- Do not leave any scheduled slot empty`;

  const [prompt,setPrompt]=useState(DEFAULT_PROMPT);
  const [building,setBuilding]=useState(false);
  const [results,setResults]=useState(null);
  const [applying,setApplying]=useState(false);
  const [toast,notify]=useToast();

  // Build All state
  const [batchSize,setBatchSize]=useState(50);
  const [buildingAll,setBuildingAll]=useState(false);
  const [buildAllLog,setBuildAllLog]=useState([]);
  const [buildAllProgress,setBuildAllProgress]=useState(null);
  const [buildAllDone,setBuildAllDone]=useState(null); // final summary

  // Build mode
  const [buildMode,setBuildMode]=useState('epg'); // 'epg' | 'network' | 'template'
  const [templateNetworks,setTemplateNetworks]=useState('');
  const [templateEpgChannelId,setTemplateEpgChannelId]=useState('');
  const [templatePrompt,setTemplatePrompt]=useState('Disney Channel schedule: morning animated cartoons, afternoon live action, prime time movies 7-10pm, late night animation. Each show gets ONE permanent time slot, rotate episodes in order.');
  const [buildingTemplate,setBuildingTemplate]=useState(false);
  const [templateResult,setTemplateResult]=useState(null);
  const [networkDesc,setNetworkDesc]=useState('');
  const [buildingNetwork,setBuildingNetwork]=useState(false);
  const [networkResults,setNetworkResults]=useState(null);
  const [guideUrl,setGuideUrl]=useState('');

  // Single build status
  const [buildStatus,setBuildStatus]=useState(null); // null | 'building' | 'done' | 'error'
  const [buildStatusMsg,setBuildStatusMsg]=useState('');

  // Create from EPG
  const [showCreateEpg,setShowCreateEpg]=useState(false);
  const [epgSelection,setEpgSelection]=useState(new Set());
  const [epgSearch,setEpgSearch]=useState('');
  const [creating,setCreating]=useState(false);

  const [epgChSearch, setEpgChSearch] = useState('');
  const [showEpgChPicker, setShowEpgChPicker] = useState(false);

  // Live stream hint
  const [streamHint,setStreamHint]=useState('');
  const [streamHintTime,setStreamHintTime]=useState('');
  const [streamHintDur,setStreamHintDur]=useState('30');

  const load=useCallback(()=>{
    Promise.all([call('GET','/api/sf/channels'),call('GET','/api/sf/epg?enabledOnly=1'),call('GET','/api/sf/streams')])
      .then(([chs,epg,sts])=>{ setChannels(chs); setEpgChannels(epg.channels||[]); setStreams(sts); }).catch(()=>{});
  },[call]);
  useEffect(()=>{load();},[load]);

  const build=async()=>{
    if(!epgCh){notify('Select an EPG reference channel',true);return;}
    if(!targetCh){notify('Select a target channel',true);return;}
    setBuilding(true);setResults(null);setBuildStatus('building');setBuildStatusMsg('Sending request to AI…');
    try{
      setBuildStatusMsg('AI is analysing your library against the EPG schedule…');
      const r=await call('POST','/api/sf/ai/build-schedule',{channelId:epgCh,epgChannelId:epgCh,date,userPrompt:prompt,targetChannelId:targetCh});
      setResults({...r,targetCh});
      setBuildStatus('done');
      setBuildStatusMsg(`Matched ${r.suggestions?.length||0} items · ${r.unmatchedSlots?.length||0} unmatched · ${r.programCount||0} EPG slots total`);
      notify(`✅ ${r.suggestions?.length||0} items matched`);
    }catch(e){
      setBuildStatus('error');
      setBuildStatusMsg(e.message);
      notify(e.message,true);
    }
    setBuilding(false);
  };

  const apply=async()=>{
    if(!results)return; setApplying(true);
    try{
      const r=await call('POST','/api/sf/ai/apply-schedule',{channelId:targetCh,suggestions:results.suggestions});
      notify(`✅ Added ${r.added} items to playout`);setResults(null);
    }catch(e){notify(e.message,true);}
    setApplying(false);
  };

  const buildFromNetwork = async () => {
    if (!targetCh) { notify('Select a target channel first', true); return; }
    if (!networkDesc.trim()) { notify('Describe the channel (e.g. "24 hour news", "kids cartoons")', true); return; }
    setBuildingNetwork(true); setNetworkResults(null);
    try {
      const r = await call('POST', '/api/sf/ai/build-from-network', {
        targetChannelId: targetCh,
        channelDescription: networkDesc,
        guideUrl: guideUrl.trim() || null,
        date,
      });
      setNetworkResults(r);
      notify(`✅ Found ${r.suggestions?.length||0} items for this channel`);
    } catch(e) { notify(e.message, true); }
    setBuildingNetwork(false);
  };

  const applyNetworkSchedule = async () => {
    if (!networkResults?.suggestions?.length) return;
    setApplying(true);
    try {
      const r = await call('POST', '/api/sf/ai/apply-schedule', { channelId:targetCh, suggestions:networkResults.suggestions });
      notify(`✅ Added ${r.added} items to playout`); setNetworkResults(null);
    } catch(e) { notify(e.message, true); }
    setApplying(false);
  };

  const addStreamHint=()=>{
    const s=streams.find(x=>x.id===streamHint);
    if(!s){notify('Select a stream first',true);return;}
    const line=`At ${streamHintTime||'a specific time'}, play live stream "${s.name}" for ${streamHintDur} minutes.`;
    setPrompt(p=>(p?p.trim()+'\n':'')+line);
    notify(`Added "${s.name}" to prompt`);
  };

  const [clearing, setClearing] = useState(false);
  const clearAndRebuild = async () => {
    const total = channels.filter(c => !c.liveStreamId).length;
    if (!window.confirm(`Clear all schedules for ${total} channels and rebuild with AI from scratch?\n\nThis cannot be undone.`)) return;
    setClearing(true);
    try {
      const r = await call('POST', '/api/sf/channels/clear-all-playout', {});
      notify(`✅ Cleared ${r.cleared} channel schedules — starting rebuild…`);
      // Don't await load() — just fire build-all immediately with forceAll=true
      // so it processes every channel regardless of React state timing
      setClearing(false);
      // Directly kick off build-all with forceAll flag bypassing empty-playout check
      setBuildingAll(true); setBuildAllLog([]); setBuildAllProgress(null); setBuildAllDone(null);
      const base2 = API.replace('/api', '');
      const res2 = await fetch(`${base2}/api/sf/ai/build-all`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, userPrompt: prompt, batchSize, forceAll: true }),
      });
      const reader2 = res2.body.getReader(); const decoder2 = new TextDecoder();
      let buf2 = '';
      while (true) {
        const { done, value } = await reader2.read(); if (done) break;
        buf2 += decoder2.decode(value);
        const lines = buf2.split('\n'); buf2 = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          try {
            const d = JSON.parse(line.slice(5));
            if (d.stage === 'start') setBuildAllProgress({ done: 0, total: d.total, remaining: d.remaining });
            else if (d.stage === 'building') setBuildAllProgress(p => ({ ...p, channel: d.channel }));
            else if (d.stage === 'built' || d.stage === 'error' || d.stage === 'skip') {
              setBuildAllProgress(p => ({ ...p, done: (p?.done||0) + 1 }));
              setBuildAllLog(l => [...l, d]);
            } else if (d.stage === 'done') { setBuildAllDone(d); setBuildingAll(false); await load(); }
            else if (d.error) { notify(d.error, true); setBuildingAll(false); }
          } catch {}
        }
      }
      setBuildingAll(false);
    } catch(e) { notify(e.message, true); setClearing(false); setBuildingAll(false); }
  };
  const buildAll=async()=>{
    if(!window.confirm(`Build AI schedules for all empty channels in batches of ${batchSize}?

This may take several minutes. Only channels with no playout content will be processed.

You can run again to continue where it left off.`)) return;
    setBuildingAll(true); setBuildAllLog([]); setBuildAllProgress(null); setBuildAllDone(null);
    try{
      const res=await fetch(`${base}/api/sf/ai/build-all`,{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({date,userPrompt:prompt,batchSize}),
      });
      const reader=res.body.getReader(); const decoder=new TextDecoder();
      let buf='';
      while(true){
        const {done,value}=await reader.read(); if(done) break;
        buf+=decoder.decode(value);
        const lines=buf.split('\n'); buf=lines.pop()||'';
        for(const line of lines){
          if(!line.startsWith('data:')) continue;
          try{
            const raw = line.slice(5).trim();
            if (!raw || raw[0] !== '{') continue; // skip non-JSON lines
            const d=JSON.parse(raw);
            if(d.error){
              notify(`Build error: ${d.error}`,true);
              setBuildAllLog(prev=>[...prev,{stage:'error',channel:'System',error:d.error}]);
              break;
            }
            if(d.stage==='start') setBuildAllProgress({total:d.total,remaining:d.remaining,done:0});
            if(['building','built','skip','error'].includes(d.stage)){
              setBuildAllLog(prev=>[...prev,d]);
              if(d.stage!=='building') setBuildAllProgress(p=>p?{...p,done:(p.done||0)+1}:null);
            }
            if(d.stage==='done'){
              setBuildAllDone(d);
              const msg = `✅ Built ${d.done} schedules${d.errors?.length?` (${d.errors.length} errors)`:''}${d.remaining>0?` — ${d.remaining} remaining, run again to continue`:''}`;
              notify(msg);
              load();
            }
          }catch(parseErr){
            console.warn('[BuildAll] SSE parse error:', parseErr.message, 'line:', line.slice(0,80));
          }
        }
      }
    }catch(e){notify(e.message,true);}
    setBuildingAll(false);
  };

  const existingEpgIds=new Set(channels.map(c=>c.epgChannelId).filter(Boolean));
  const existingNames=new Set(channels.map(c=>(c.name||'').toLowerCase()));
  const filteredEpg=epgChannels.filter(c=>{
    if(existingEpgIds.has(c.id)||existingNames.has((c.name||'').toLowerCase())) return false;
    return !epgSearch||(c.name||c.id).toLowerCase().includes(epgSearch.toLowerCase());
  });

  const createFromEpg=async()=>{
    if(!epgSelection.size){notify('Select at least one channel',true);return;}
    setCreating(true);
    try{
      const r=await call('POST','/api/sf/channels/create-from-epg',{epgChannelIds:[...epgSelection]});
      notify(`✅ Created ${r.created} channels`);setEpgSelection(new Set());setShowCreateEpg(false);load();
    }catch(e){notify(e.message,true);}
    setCreating(false);
  };

  const sectionLabel = { fontSize:10,fontWeight:700,color:'var(--text-muted)',letterSpacing:1.5,textTransform:'uppercase',marginBottom:10,display:'block' };
  const card = { background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:'var(--radius-lg)',padding:'18px 20px',marginBottom:12 };

  return (
    <div onClick={()=>setShowEpgChPicker(false)}>
      <Toast {...toast}/>
      <div style={{ display:'grid',gridTemplateColumns:'1fr 320px',gap:16,alignItems:'start' }}>

        {/* ── Left column ── */}
        <div>

          {/* Build mode toggle */}
          <div style={{ display:'flex',gap:4,marginBottom:16,borderRadius:'var(--radius)',overflow:'hidden',border:'1px solid var(--border)',alignSelf:'flex-start',width:'fit-content' }}>
            <button onClick={()=>setBuildMode('epg')} style={{ padding:'8px 20px',background:buildMode==='epg'?'var(--accent)':'var(--bg-card)',color:buildMode==='epg'?'white':'var(--text-secondary)',border:'none',cursor:'pointer',fontSize:12,fontWeight:600 }}>📅 EPG Based</button>
            <button onClick={()=>setBuildMode('network')} style={{ padding:'8px 20px',background:buildMode==='network'?'var(--accent)':'var(--bg-card)',color:buildMode==='network'?'white':'var(--text-secondary)',border:'none',borderLeft:'1px solid var(--border)',cursor:'pointer',fontSize:12,fontWeight:600 }}>📡 Network Based</button>
            <button onClick={()=>setBuildMode('template')} style={{ padding:'8px 20px',background:buildMode==='template'?'var(--accent)':'var(--bg-card)',color:buildMode==='template'?'white':'var(--text-secondary)',border:'none',borderLeft:'1px solid var(--border)',cursor:'pointer',fontSize:12,fontWeight:600 }}>📺 Channel Template</button>
          </div>

          {/* EPG Reference */}
          {buildMode==='epg'&&<div style={card}>
            <span style={sectionLabel}>EPG Reference Channel</span>
            <div style={{ marginBottom:10 }}>
              <label style={{ ...sectionLabel,marginBottom:5 }}>Base Schedule on this EPG Channel</label>
              <div style={{ position:'relative' }}>
                {/* Search input — shows selected name or placeholder */}
                <div style={{ display:'flex', gap:6 }}>
                  <div style={{ position:'relative', flex:1 }}>
                    <input
                      type="text"
                      placeholder="Search EPG channels…"
                      value={showEpgChPicker ? epgChSearch : (epgChannels.find(c=>c.id===epgCh)?.name || '')}
                      onChange={e=>{ setEpgChSearch(e.target.value); setShowEpgChPicker(true); }}
                      onFocus={()=>{ setEpgChSearch(''); setShowEpgChPicker(true); }}
                      style={{...inp, cursor:'text'}}
                    />
                    {epgCh && !showEpgChPicker && (
                      <button onClick={()=>{ setEpgCh(''); setEpgChSearch(''); }}
                        style={{ position:'absolute', right:8, top:'50%', transform:'translateY(-50%)', background:'none', border:'none', cursor:'pointer', color:'var(--text-muted)', padding:0, lineHeight:1, fontSize:14 }}>×</button>
                    )}
                  </div>
                </div>
                {/* Dropdown list */}
                {showEpgChPicker && (
                  <div style={{ position:'absolute', top:'100%', left:0, right:0, zIndex:200, background:'var(--bg-card)', border:'1px solid var(--border)', borderRadius:'var(--radius)', maxHeight:260, overflowY:'auto', boxShadow:'0 8px 24px rgba(0,0,0,0.4)', marginTop:2 }}
                    onMouseDown={e=>e.preventDefault()}>
                    {epgChannels
                      .filter(c => !epgChSearch || c.name.toLowerCase().includes(epgChSearch.toLowerCase()))
                      .slice(0, 100)
                      .map(c => (
                        <div key={c.id}
                          onClick={()=>{ setEpgCh(c.id); setShowEpgChPicker(false); setEpgChSearch(''); }}
                          style={{ padding:'9px 14px', fontSize:13, cursor:'pointer', borderBottom:'1px solid rgba(255,255,255,0.04)', color: epgCh===c.id ? 'var(--accent)' : 'var(--text-primary)', background: epgCh===c.id ? 'rgba(var(--accent-rgb),0.08)' : 'transparent' }}
                          onMouseEnter={e=>{ if(epgCh!==c.id) e.currentTarget.style.background='rgba(255,255,255,0.05)'; }}
                          onMouseLeave={e=>{ if(epgCh!==c.id) e.currentTarget.style.background='transparent'; }}>
                          {epgCh===c.id && '✓ '}{c.name}
                        </div>
                      ))}
                    {epgChannels.filter(c => !epgChSearch || c.name.toLowerCase().includes(epgChSearch.toLowerCase())).length === 0 && (
                      <div style={{ padding:'16px 14px', fontSize:12, color:'var(--text-muted)', textAlign:'center' }}>No channels match</div>
                    )}
                  </div>
                )}
              </div>
              <div style={{ fontSize:11,color:'var(--text-muted)',marginTop:5 }}>The AI will look at what this channel airs and match your library to it</div>
            </div>
            <div>
              <label style={{ ...sectionLabel,marginBottom:5 }}>Date to Reference</label>
              <input style={{ ...inp,maxWidth:200 }} type="date" value={date} onChange={e=>setDate(e.target.value)}/>
            </div>
          </div>}

          {/* Network Based Build */}
          {buildMode==='network'&&<div style={card}>
            <span style={sectionLabel}>Network / Channel Type</span>
            <div style={{ marginBottom:12 }}>
              <label style={{ ...sectionLabel,marginBottom:5 }}>Describe the Channel</label>
              <input autoFocus style={inp} value={networkDesc} onChange={e=>setNetworkDesc(e.target.value)}
                placeholder="e.g. 24 hour news, kids cartoons, classic movies, true crime documentaries…"/>
              <div style={{ fontSize:11,color:'var(--text-muted)',marginTop:5 }}>
                The AI will scan your library and pick content that fits — be specific for better results
              </div>
            </div>
            <div style={{ marginBottom:12 }}>
              <label style={{ ...sectionLabel,marginBottom:5 }}>Network Schedule URL <span style={{ color:'var(--text-muted)',fontWeight:400,textTransform:'none',fontSize:10 }}>(optional — paste the network's schedule page)</span></label>
              <input style={inp} value={guideUrl} onChange={e=>setGuideUrl(e.target.value)}
                placeholder="e.g. https://www.cnn.com/tv/schedule/cnn"/>
              <div style={{ fontSize:11,color:'var(--text-muted)',marginTop:4 }}>
                The AI will read this page and match the show titles to your library — no EPG needed
              </div>
            </div>
            <div style={{ marginBottom:12 }}>
              <label style={{ ...sectionLabel,marginBottom:5 }}>Target Channel</label>
              <select style={inp} value={targetCh} onChange={e=>setTargetCh(e.target.value)}>
                <option value="">— Select a channel —</option>
                {channels.filter(c=>!c.liveStreamId).map(c=><option key={c.id} value={c.id}>{c.num} — {c.name}</option>)}
              </select>
            </div>
          </div>}

          {/* Channel Template Build — ErsatzTV style */}
          {buildMode==='template'&&<div style={card}>
            <span style={sectionLabel}>Channel Template (ErsatzTV Style)</span>
            <div style={{ fontSize:12,color:'var(--text-muted)',marginBottom:12,lineHeight:1.6 }}>
              AI assigns each show a permanent time slot. Episodes play in order every day — just like ErsatzTV.
              Movies rotate in prime time. Shows never repeat in the same day.
            </div>
            <div style={{ marginBottom:12 }}>
              <label style={{ ...sectionLabel,marginBottom:5 }}>Networks to Include (comma separated)</label>
              <input style={inp} value={templateNetworks} onChange={e=>setTemplateNetworks(e.target.value)}
                placeholder="Disney Channel, Disney+, Disney XD"/>
              <div style={{ fontSize:11,color:'var(--text-muted)',marginTop:4 }}>Leave blank to use all library content</div>
            </div>
            <div style={{ marginBottom:12 }}>
              <label style={{ ...sectionLabel,marginBottom:5 }}>EPG Reference Channel (optional)</label>
              <input type="text" style={inp} value={templateEpgChannelId} onChange={e=>setTemplateEpgChannelId(e.target.value)}
                placeholder="Use EPG channel ID for time slot reference"/>
            </div>
            <div style={{ marginBottom:12 }}>
              <label style={{ ...sectionLabel,marginBottom:5 }}>Target Channel</label>
              <select style={inp} value={targetCh} onChange={e=>setTargetCh(e.target.value)}>
                <option value="">— Select a channel —</option>
                {channels.filter(c=>!c.liveStreamId).map(c=><option key={c.id} value={c.id}>{c.num} — {c.name}</option>)}
              </select>
            </div>
            <div style={{ marginBottom:12 }}>
              <label style={{ ...sectionLabel,marginBottom:5 }}>Scheduling Instructions</label>
              <textarea style={{ ...inp,minHeight:100,resize:'vertical' }} value={templatePrompt} onChange={e=>setTemplatePrompt(e.target.value)}/>
            </div>
            {templateResult&&<div style={{ marginBottom:12,padding:'12px 14px',background:'rgba(16,185,129,0.08)',border:'1px solid rgba(16,185,129,0.25)',borderRadius:'var(--radius)' }}>
              <div style={{ fontWeight:700,fontSize:13,color:'#10b981',marginBottom:8 }}>✓ Template Built — {templateResult.slots?.length} time slots</div>
              <div style={{ maxHeight:200,overflowY:'auto',display:'flex',flexDirection:'column',gap:3 }}>
                {(templateResult.slots||[]).map((s,i)=>(
                  <div key={i} style={{ fontSize:11,color:'var(--text-secondary)',display:'flex',gap:8 }}>
                    <span style={{ color:'var(--accent)',fontWeight:700,minWidth:50 }}>{s.time}</span>
                    <span>{s.showTitle}</span>
                    <span style={{ color:'var(--text-muted)',fontSize:10 }}>({s.mediaType})</span>
                  </div>
                ))}
              </div>
            </div>}
            <button disabled={buildingTemplate||!targetCh} onClick={async()=>{
              setBuildingTemplate(true); setTemplateResult(null);
              try {
                const nets = templateNetworks.split(',').map(n=>n.trim()).filter(Boolean);
                const r = await call('POST','/api/sf/ai/build-channel-template',{
                  targetChannelId:targetCh, networks:nets.length?nets:null,
                  epgChannelId:templateEpgChannelId||null, date:schedDate, userPrompt:templatePrompt
                });
                setTemplateResult(r);
                notify('✅ Channel template built — '+r.slots?.length+' time slots');
              } catch(e){ notify(e.message,true); }
              setBuildingTemplate(false);
            }} style={{ width:'100%',padding:'12px',background:'var(--accent)',color:'white',border:'none',borderRadius:'var(--radius)',fontWeight:700,cursor:'pointer',fontSize:14,display:'flex',alignItems:'center',justifyContent:'center',gap:8 }}>
              <Bot size={15}/> {buildingTemplate?'Building Template…':'Build Channel Template'}
            </button>
          </div>}

          {/* Target Channel — EPG mode only (Network mode has it inside its own card) */}
          {buildMode==='epg'&&<div style={card}>
            <span style={sectionLabel}>Target Channel</span>
            <label style={{ ...sectionLabel,marginBottom:5 }}>Add Results to this StreamForge Channel</label>
            <select style={inp} value={targetCh} onChange={e=>setTargetCh(e.target.value)}>
              <option value="">— Select a channel —</option>
              {channels.filter(c=>!c.liveStreamId).map(c=><option key={c.id} value={c.id}>{c.num} — {c.name}</option>)}
            </select>
          </div>}

          {/* Your Request — EPG mode only */}
          {buildMode==='epg'&&<div style={card}>
            <span style={sectionLabel}>Your Request</span>
            <div style={{ display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:5 }}>
              <label style={{ ...sectionLabel,marginBottom:0 }}>Tell the AI what you want</label>
              <button onClick={()=>setPrompt(DEFAULT_PROMPT)} style={{ fontSize:11,background:'none',border:'1px solid var(--border)',borderRadius:'var(--radius)',color:'var(--text-muted)',cursor:'pointer',padding:'3px 8px' }}>↺ Reset to default</button>
            </div>
            <textarea style={{ ...inp,minHeight:130,resize:'vertical' }} value={prompt} onChange={e=>setPrompt(e.target.value)}
              placeholder="Describe what you want the AI to build…"/>

            {/* Live stream hint */}
            {streams.length>0 && (
              <div style={{ marginTop:12 }}>
                <label style={{ ...sectionLabel,marginBottom:6,color:'var(--accent)' }}>📡 Add Live Stream to Schedule (Optional)</label>
                <div style={{ display:'flex',gap:8,alignItems:'center',flexWrap:'wrap' }}>
                  <select style={{ ...inp,flex:2,minWidth:160 }} value={streamHint} onChange={e=>setStreamHint(e.target.value)}>
                    <option value="">— Pick a stream —</option>
                    {streams.map(s=><option key={s.id} value={s.id}>{s.name}{s.group?` (${s.group})`:''}</option>)}
                  </select>
                  <input style={{ ...inp,width:100 }} type="time" value={streamHintTime} onChange={e=>setStreamHintTime(e.target.value)} placeholder="--:-- --"/>
                  <input style={{ ...inp,width:72 }} type="number" value={streamHintDur} onChange={e=>setStreamHintDur(e.target.value)} min={5} placeholder="30"/>
                  <button onClick={addStreamHint} style={{ padding:'9px 14px',background:'var(--bg-tertiary)',border:'1px solid var(--border)',borderRadius:'var(--radius)',color:'var(--text-secondary)',cursor:'pointer',fontSize:12,fontWeight:600,flexShrink:0 }}>+ Add to Prompt</button>
                </div>
                <div style={{ fontSize:11,color:'var(--text-muted)',marginTop:5 }}>Pick a stream, set a time and duration, then add it to your prompt so the AI schedules it</div>
              </div>
            )}
          </div>}

          {/* Build All progress */}
          {(buildAllProgress||buildAllLog.length>0) && (
            <div style={{ ...card,borderColor:'rgba(99,102,241,0.3)' }}>
              <span style={sectionLabel}>Build All Progress</span>
              {buildAllProgress && (
                <div style={{ marginBottom:10 }}>
                  <div style={{ display:'flex',justifyContent:'space-between',fontSize:12,marginBottom:6 }}>
                    <span style={{ color:'var(--text-muted)' }}>{buildAllProgress.done||0} / {buildAllProgress.total} channels</span>
                    {buildAllProgress.remaining>0&&<span style={{ color:'#f59e0b' }}>{buildAllProgress.remaining} more after this batch</span>}
                  </div>
                  <div style={{ height:5,background:'var(--bg-tertiary)',borderRadius:3 }}>
                    <div style={{ height:'100%',background:'var(--accent)',borderRadius:3,width:`${buildAllProgress.total>0?Math.round(((buildAllProgress.done||0)/buildAllProgress.total)*100):0}%`,transition:'width 0.3s' }}/>
                  </div>
                </div>
              )}
              <div style={{ maxHeight:140,overflowY:'auto',fontSize:11 }}>
                {buildAllLog.slice(-20).map((e,i)=>(
                  <div key={i} style={{ marginBottom:2,color:e.stage==='error'?'#ef4444':e.stage==='built'?'#10b981':'var(--text-muted)' }}>
                    {e.stage==='built'?'✓':e.stage==='error'?'✗':e.stage==='skip'?'–':'▶'} {e.channel}{e.matched!=null?` — ${e.matched} items`:''}{e.error?` — ${e.error}`:''}{e.reason?` — ${e.reason}`:''}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Action buttons */}
          <div style={{ display:'flex',gap:10 }}>
            {buildMode==='epg'
              ? <button onClick={build} disabled={building} style={{ flex:2,padding:'13px',background:'var(--accent)',color:'white',border:'none',borderRadius:'var(--radius)',fontWeight:700,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',gap:8,fontSize:14 }}>
                  <Bot size={15}/> {building?'Building…':'Build Schedule with AI'}
                </button>
              : <button onClick={buildFromNetwork} disabled={buildingNetwork} style={{ flex:2,padding:'13px',background:'var(--accent)',color:'white',border:'none',borderRadius:'var(--radius)',fontWeight:700,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',gap:8,fontSize:14 }}>
                  <Bot size={15}/> {buildingNetwork?'Scanning Library…':'Build from Network Type'}
                </button>
            }
            <button onClick={buildAll} disabled={buildingAll||clearing} style={{ flex:1,padding:'13px',background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:'var(--radius)',color:'var(--text-secondary)',fontWeight:700,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',gap:8,fontSize:13 }}>
              <Bot size={14}/> {buildingAll?`Building… (${buildAllProgress?.done||0}/${buildAllProgress?.total||'?'})` :'Build All Channels'}
            </button>
            <button onClick={clearAndRebuild} disabled={buildingAll||clearing} title="Clear all schedules and rebuild from scratch with AI"
              style={{ padding:'13px 16px',background:'rgba(239,68,68,0.08)',border:'1px solid rgba(239,68,68,0.25)',borderRadius:'var(--radius)',color:'#ef4444',fontWeight:700,cursor:'pointer',fontSize:13,display:'flex',alignItems:'center',gap:6,flexShrink:0 }}>
              🗑️ {clearing?'Clearing…':'Clear & Rebuild All'}
            </button>
            <button onClick={()=>setShowCreateEpg(v=>!v)} style={{ padding:'13px 16px',background:showCreateEpg?'rgba(16,185,129,0.15)':'var(--bg-card)',border:`1px solid ${showCreateEpg?'rgba(16,185,129,0.4)':'var(--border)'}`,borderRadius:'var(--radius)',color:showCreateEpg?'#10b981':'var(--text-secondary)',fontWeight:700,cursor:'pointer',fontSize:13,flexShrink:0 }}>
              📺 Create from EPG
            </button>
          </div>

          {/* Create from EPG panel */}
          {showCreateEpg && (
            <div style={{ ...card,marginTop:12,borderColor:'rgba(16,185,129,0.25)' }}>
              <span style={sectionLabel}>Create Channels from EPG</span>
              {epgChannels.length===0
                ? <div style={{ color:'var(--text-muted)',fontSize:13 }}>No EPG imported yet — go to the EPG tab first.</div>
                : <>
                  <div style={{ display:'flex',gap:8,marginBottom:10 }}>
                    <input style={{ ...inp,flex:1 }} value={epgSearch} onChange={e=>setEpgSearch(e.target.value)} placeholder="Search channels…"/>
                    <button onClick={()=>setEpgSelection(new Set(filteredEpg.map(c=>c.id)))} style={{ padding:'7px 12px',background:'var(--bg-tertiary)',border:'1px solid var(--border)',borderRadius:'var(--radius)',color:'var(--text-secondary)',cursor:'pointer',fontSize:12 }}>All</button>
                    <button onClick={()=>setEpgSelection(new Set())} style={{ padding:'7px 12px',background:'var(--bg-tertiary)',border:'1px solid var(--border)',borderRadius:'var(--radius)',color:'var(--text-secondary)',cursor:'pointer',fontSize:12 }}>None</button>
                    <span style={{ padding:'7px 12px',fontSize:12,color:'var(--accent)',fontWeight:700 }}>{epgSelection.size} selected</span>
                  </div>
                  <div style={{ maxHeight:280,overflowY:'auto',border:'1px solid var(--border)',borderRadius:'var(--radius)' }}>
                    {filteredEpg.length===0
                      ? <div style={{ padding:16,textAlign:'center',color:'var(--text-muted)',fontSize:12 }}>All EPG channels already have StreamForge channels.</div>
                      : filteredEpg.map(c=>(
                        <label key={c.id} style={{ display:'flex',alignItems:'center',gap:10,padding:'9px 14px',borderBottom:'1px solid rgba(255,255,255,0.04)',cursor:'pointer',background:epgSelection.has(c.id)?'rgba(99,102,241,0.08)':'transparent' }}>
                          <input type="checkbox" checked={epgSelection.has(c.id)} onChange={e=>setEpgSelection(prev=>{const n=new Set(prev);e.target.checked?n.add(c.id):n.delete(c.id);return n;})} style={{ width:15,height:15,accentColor:'var(--accent)' }}/>
                          {c.logo?<img src={c.logo} alt="" style={{ width:28,height:28,objectFit:'contain',borderRadius:3 }} onError={e=>e.target.style.display='none'}/>:<span>📺</span>}
                          <div style={{ flex:1,minWidth:0 }}>
                            <div style={{ fontWeight:600,fontSize:13,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' }}>{c.name||c.id}</div>
                            <div style={{ fontSize:10,color:'var(--text-muted)' }}>{c.id}</div>
                          </div>
                        </label>
                      ))
                    }
                  </div>
                  <button onClick={createFromEpg} disabled={creating||!epgSelection.size} style={{ width:'100%',marginTop:10,padding:'11px',background:epgSelection.size?'#10b981':'var(--bg-tertiary)',color:epgSelection.size?'white':'var(--text-muted)',border:'none',borderRadius:'var(--radius)',fontWeight:700,cursor:epgSelection.size?'pointer':'not-allowed',fontSize:13 }}>
                    {creating?'Creating…':`📺 Create ${epgSelection.size} Channel${epgSelection.size!==1?'s':''} from EPG`}
                  </button>
                </>
              }
            </div>
          )}
        </div>

        {/* ── Right column — Results ── */}
        <div style={{ position:'sticky',top:20 }}>
          <div style={{ ...card,marginBottom:0 }}>
            <span style={sectionLabel}>AI Results</span>
            {!results && !networkResults
              ? <div style={{ color:'var(--text-muted)',fontSize:13,padding:'20px 0',textAlign:'center' }}>Results will appear here after building a schedule.</div>
              : <>
                <div style={{ display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:10 }}>
                  <span style={{ fontSize:13,fontWeight:700,color:'#10b981' }}>
                    ✓ {(results||networkResults)?.suggestions?.length||0} {networkResults?'items found':'matched'}
                  </span>
                  <button onClick={results?apply:applyNetworkSchedule} disabled={applying}
                    style={{ padding:'7px 14px',background:'#10b981',color:'white',border:'none',borderRadius:'var(--radius)',fontWeight:700,cursor:'pointer',fontSize:12 }}>
                    {applying?'Applying…':'Apply to Channel →'}
                  </button>
                </div>
                <div style={{ maxHeight:300,overflowY:'auto' }}>
                  {((results||networkResults)?.suggestions||[]).map((m,i)=>(
                    <div key={i} style={{ padding:'6px 0',borderBottom:'1px solid rgba(255,255,255,0.04)',fontSize:12 }}>
                      <span style={{ color:'var(--text-secondary)' }}>{m.item?.title||m.title}</span>
                      {m.reason&&<span style={{ fontSize:10,color:'var(--text-muted)',marginLeft:6 }}>— {m.reason}</span>}
                    </div>
                  ))}
                </div>
              </>
            }
          </div>

          {results?.unmatchedSlots?.length>0 && (
            <div style={{ ...card,marginTop:12,borderColor:'rgba(245,158,11,0.2)' }}>
              <span style={{ ...sectionLabel,color:'#f59e0b' }}>Unmatched EPG Slots</span>
              <div style={{ maxHeight:200,overflowY:'auto' }}>
                {results.unmatchedSlots.map((u,i)=>(
                  <div key={i} style={{ padding:'5px 0',borderBottom:'1px solid rgba(255,255,255,0.04)',fontSize:12,color:'var(--text-muted)' }}>{u}</div>
                ))}
              </div>
            </div>
          )}

          {/* Batch size for Build All */}
          <div style={{ ...card,marginTop:12 }}>
            <span style={sectionLabel}>Build All Settings</span>
            <label style={{ ...sectionLabel,marginBottom:5 }}>Batch Size</label>
            <input style={inp} type="number" value={batchSize} onChange={e=>setBatchSize(+e.target.value)} min={1} max={500}/>
            <div style={{ fontSize:11,color:'var(--text-muted)',marginTop:5 }}>Channels per run. 50 for cloud AI, any size for local Ollama.</div>
          </div>
        </div>
      </div>
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
  const [showSplash,setShowSplash]=useState(false);
  const [activeChannel,setActiveChannel]=useState(null);
  const [nowPlaying,setNowPlaying]=useState(null);
  const [upNext,setUpNext]=useState([]);
  const [status,setStatus]=useState('idle'); // idle | loading | playing | error
  const [errMsg,setErrMsg]=useState('');
  const [muted,setMuted]=useState(false);
  const videoRef=useRef(null);
  const hlsRef=useRef(null);
  const pollRef=useRef(null);

  const fmtDur = ms => { if(!ms) return ''; const s=Math.round(ms/1000); const h=Math.floor(s/3600),m=Math.floor((s%3600)/60); return h>0?`${h}h ${m}m`:`${m}m`; };
  const fmtTime = ms => { const d=new Date(ms); const h=d.getUTCHours(),m=d.getUTCMinutes(),ap=h<12?'AM':'PM',h12=h===0?12:h>12?h-12:h; return `${h12}:${String(m).padStart(2,'0')} ${ap}`; };

  // Load channel list — single bulk now-playing request instead of N individual ones
  const loadChannels = useCallback(async () => {
    try {
      const [chs, npAll] = await Promise.all([
        call('GET', '/api/sf/channels'),
        call('GET', '/api/sf/now-playing-all').catch(() => ({})),
      ]);
      const withNp = chs.filter(c => c.active).map(ch => {
        const np = npAll[ch.id];
        const hasContent = np && np.title && np.title !== 'Nothing scheduled';
        return { ...ch, nowPlaying: hasContent ? np : null };
      });
      setChannels(withNp.sort((a,b)=>(a.num||0)-(b.num||0)));
    } catch {}
  }, [call]);

  useEffect(() => { loadChannels(); }, [loadChannels]);
  useEffect(() => { if(initialChannelId) tuneToChannel(initialChannelId); }, [initialChannelId]);

  const updateNowPlaying = useCallback(async (chId) => {
    try {
      const [np, sched] = await Promise.all([
        call('GET',`/api/sf/channels/${chId}/now-playing`),
        call('GET',`/api/sf/schedule?from=${Date.now()}&to=${Date.now()+86400000}`),
      ]);
      const hasContent = np && np.title && np.title !== 'Nothing scheduled';
      setNowPlaying(hasContent ? np : null);
      const chSched = Array.isArray(sched) ? sched.find(r=>r.channel.id===chId) : null;
      if (chSched) setUpNext(chSched.programs.filter(p=>p.start>Date.now()).slice(0,5));
    } catch {}
  }, [call]);

  const tuneToChannel = useCallback(async (chId) => {
    if (hlsRef.current) {
      try { hlsRef.current.stopLoad(); hlsRef.current.detachMedia(); hlsRef.current.destroy(); } catch {}
      hlsRef.current=null;
    }
    clearInterval(pollRef.current);
    if (activeId && activeId !== chId) call('DELETE',`/api/sf/channels/${activeId}/watch`).catch(()=>{});
    setActiveId(chId);
    setStatus('loading');
    setErrMsg('');
    setNowPlaying(null);
    setUpNext([]);
    const chMeta = channels.find(c=>c.id===chId);
    setActiveChannel(chMeta||null);
    // Show splash for at least 1.5s even if stream starts fast
    setShowSplash(true);
    setTimeout(()=>setShowSplash(false), 1500);
    try {
      const video = videoRef.current;
      if (!video) return;

      // Fetch channel directly — don't rely on channels state (may not be loaded yet)
      const chData = await call('GET', `/api/sf/channels/${chId}`).catch(() => null);
      const isLiveChannel = !!chData?.liveStreamId;

      if (false) {
        // (live-proxy direct play removed — browser can't decode MPEG-TS natively)
      } else {
        // Playout channel — use HLS pipeline (needed for scheduled media files)
        const r = await call('POST',`/api/sf/channels/${chId}/watch`,{});
        if (r.error) { setStatus('error'); setErrMsg(r.error); return; }
        const hlsUrl = base + r.hlsUrl;


        if (!window.Hls) {
          await new Promise((res,rej) => {
            const s=document.createElement('script');
            s.src='https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.4.10/hls.min.js';
            s.onload=res; s.onerror=rej; document.head.appendChild(s);
          });
        }

        if (window.Hls && window.Hls.isSupported()) {
          const hls = new window.Hls({
            lowLatencyMode: false,
            liveSyncDurationCount: 8,        // stay 8 segments (16s) behind live edge
            liveMaxLatencyDurationCount: 50, // only jump if >100s behind (prevents mid-show skips)
            maxBufferLength: 60,             // buffer up to 60s
            maxBufferSize: 120 * 1000 * 1000,// 120MB buffer
            maxMaxBufferLength: 120,
            backBufferLength: 60,            // keep 60s of back buffer
            enableWorker: true,
            manifestLoadingTimeOut: 15000,
            manifestLoadingMaxRetry: 5,
            fragLoadingTimeOut: 15000,
            fragLoadingMaxRetry: 5,
            levelLoadingTimeOut: 15000,
            levelLoadingMaxRetry: 5,
            startPosition: -1,               // start at live edge
            nudgeMaxRetry: 5,
            highBufferWatchdogPeriod: 3,
            maxStarvationDelay: 4,
          });
          hlsRef.current = hls;
          hls.loadSource(hlsUrl);
          hls.attachMedia(video);
          hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
            setStatus('playing');
            video.muted = muted;
            video.volume = 1;
            video.play().catch(() => { video.muted=true; video.play().catch(()=>{}); });
          });

          let retries = 0;
          hls.on(window.Hls.Events.ERROR, async (_,data) => {
            if (data.fatal) {
              retries++;
              if (retries > 3) { setStatus('error'); setErrMsg('Stream failed after 3 retries'); hls.destroy(); return; }
              setStatus('loading'); setErrMsg(`Retrying… (${retries}/3)`);
              try { await call('DELETE',`/api/sf/channels/${chId}/watch`); } catch {}
              setTimeout(() => tuneToChannel(chId), 4000);
            }
          });
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.src = hlsUrl;
          video.onloadedmetadata = () => { setStatus('playing'); video.play(); };
        } else {
          setStatus('error'); setErrMsg('HLS not supported in this browser');
          return;
        }
      }

      await updateNowPlaying(chId);
      pollRef.current = setInterval(() => updateNowPlaying(chId), 15000);
    } catch(e) {
      setStatus('error'); setErrMsg('Failed to start: ' + e.message);
    }
  }, [activeId, base, call, channels, muted, updateNowPlaying]);

  // Cleanup on unmount
  useEffect(() => () => {
    if (hlsRef.current) hlsRef.current.destroy();
    clearInterval(pollRef.current);
    if (activeId) call('DELETE',`/api/sf/channels/${activeId}/watch`).catch(()=>{});
  }, []);

  // activeChannel is now state — set in tuneToChannel

  // Suppress HLS.js worker race condition error (harmless but triggers React error overlay)
  useEffect(() => {
    const handler = (e) => {
      if (e.message && e.message.includes("Cannot read properties of null") && e.filename && e.filename.includes('hls')) {
        e.preventDefault(); e.stopPropagation(); return false;
      }
    };
    window.addEventListener('error', handler, true);
    return () => window.removeEventListener('error', handler, true);
  }, []);

  return (
    <div style={{ display:'grid', gridTemplateColumns:'260px 1fr', minHeight:600, background:'#0a0a0f', borderRadius:'var(--radius-lg)', border:'1px solid var(--border)', overflow:'hidden' }}>

      {/* ── Channel list ── */}
      <div style={{ borderRight:'1px solid rgba(255,255,255,0.06)', overflowY:'auto', background:'#0d0d14' }}>
        <div style={{ padding:'10px 16px', borderBottom:'1px solid rgba(255,255,255,0.06)', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
          <span style={{ fontSize:11, fontWeight:700, color:'var(--text-muted)', letterSpacing:1.5 }}>CHANNELS</span>
          <button onClick={() => setChannels(prev => [...prev].sort((a,b)=>(a.num||0)-(b.num||0)))}
            title="Sort by channel number"
            style={{ background:'none', border:'none', color:'var(--text-muted)', cursor:'pointer', fontSize:11, padding:'2px 6px', borderRadius:4 }}>
            # ↑
          </button>
        </div>
        {channels.length === 0 && <div style={{ padding:24, color:'var(--text-muted)', fontSize:13, textAlign:'center' }}>No channels yet</div>}
        {channels.map(ch => (
          <div key={ch.id}
            onMouseEnter={() => {
              if (!ch.liveStreamId && ch.id !== activeId)
                call('POST',`/api/sf/channels/${ch.id}/watch`,{}).catch(()=>{});
            }}
            onClick={() => tuneToChannel(ch.id)}
            style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 14px', cursor:'pointer', borderBottom:'1px solid rgba(255,255,255,0.03)', background:activeId===ch.id?'rgba(99,102,241,0.15)':'transparent', borderLeft:activeId===ch.id?'3px solid var(--accent)':'3px solid transparent', transition:'all 0.15s' }}
            onMouseEnter={e=>{ if(activeId!==ch.id) e.currentTarget.style.background='rgba(255,255,255,0.04)'; }}
            onMouseLeave={e=>{ if(activeId!==ch.id) e.currentTarget.style.background='transparent'; }}>
            <span style={{ fontSize:11, fontWeight:700, color:'var(--text-muted)', minWidth:22, textAlign:'right' }}>{ch.num}</span>
            {ch.logo
              ? <img src={ch.logo} alt="" style={{ width:32, height:32, objectFit:'contain', borderRadius:4, flexShrink:0 }} onError={e=>e.target.style.display='none'}/>
              : <div style={{ width:32, height:32, background:'var(--bg-tertiary)', borderRadius:4, display:'flex', alignItems:'center', justifyContent:'center', fontSize:14, flexShrink:0 }}>📺</div>
            }
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ fontSize:12, fontWeight:600, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', color: activeId===ch.id?'white':'var(--text-secondary)' }}>{ch.name}</div>
              <div style={{ fontSize:10, color:'var(--text-muted)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', marginTop:1 }}>
                {ch.nowPlaying ? ch.nowPlaying.title : 'Nothing scheduled'}
              </div>
            </div>
            {ch.nowPlaying?.isLive && <span style={{ fontSize:9, fontWeight:700, color:'#ef4444', padding:'2px 5px', background:'rgba(239,68,68,0.15)', borderRadius:4, flexShrink:0 }}>🔴 LIVE</span>}
          </div>
        ))}
      </div>

      {/* ── Right side: player + info ── */}
      <div style={{ display:'flex', flexDirection:'column', background:'#000' }}>

        {/* Video player */}
        <div style={{ position:'relative', background:'#000', flex:'none' }}>
          <video ref={videoRef} style={{ width:'100%', display:'block', maxHeight:'60vh', minHeight:280, background:'#000' }} controls/>

          {/* Overlay */}
          {(status !== 'playing' || showSplash) && (
            <div style={{ position:'absolute', inset:0, display:'flex', alignItems:'center', justifyContent:'center', flexDirection:'column', gap:12, background:'rgba(0,0,0,0.85)', cursor: status==='loading'?'wait':'default' }}>
              {status === 'idle' && <><Monitor size={48} color="rgba(255,255,255,0.2)"/><div style={{ fontSize:15, color:'rgba(255,255,255,0.4)' }}>Select a channel to watch</div></>}
              {(status === 'loading' || showSplash) && (() => {
                const splash = activeChannel?.splashUrl || activeChannel?.logo;
                return (
                  <div style={{ position:'absolute',inset:0,background:'#000',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:16 }}>
                    {/* Background blur if logo exists */}
                    {splash && <img src={splash} alt="" style={{ position:'absolute',inset:0,width:'100%',height:'100%',objectFit:'cover',opacity:0.15,filter:'blur(12px)' }} onError={e=>e.target.style.display='none'}/>}
                    <div style={{ position:'relative',display:'flex',flexDirection:'column',alignItems:'center',gap:14 }}>
                      {/* Logo or channel number badge */}
                      {splash
                        ? <img src={splash} alt="" style={{ width:140,height:90,objectFit:'contain',filter:'drop-shadow(0 4px 16px rgba(0,0,0,0.8))' }} onError={e=>e.target.style.display='none'}/>
                        : <div style={{ width:80,height:80,borderRadius:16,background:'rgba(99,102,241,0.25)',border:'2px solid rgba(99,102,241,0.5)',display:'flex',alignItems:'center',justifyContent:'center',fontSize:24,fontWeight:800,color:'var(--accent)' }}>
                            {activeChannel?.num||'•'}
                          </div>
                      }
                      <div style={{ fontSize:20,fontWeight:700,color:'white',textShadow:'0 2px 12px rgba(0,0,0,0.9)',textAlign:'center' }}>{activeChannel?.name||''}</div>
                      <div style={{ display:'flex',alignItems:'center',gap:8,marginTop:4 }}>
                        <div style={{ width:20,height:20,border:'2px solid rgba(255,255,255,0.15)',borderTop:'2px solid white',borderRadius:'50%',animation:'spin 0.9s linear infinite' }}/>
                        <span style={{ fontSize:11,color:'rgba(255,255,255,0.5)',letterSpacing:2 }}>CONNECTING</span>
                      </div>
                    </div>
                  </div>
                );
              })()}
              {status === 'error' && <><div style={{ fontSize:32 }}>⚠️</div><div style={{ fontSize:14, color:'#ef4444', textAlign:'center', maxWidth:300 }}>{errMsg}</div><button onClick={()=>tuneToChannel(activeId)} style={{ padding:'8px 20px', background:'var(--accent)', color:'white', border:'none', borderRadius:'var(--radius)', cursor:'pointer', fontWeight:600, marginTop:8 }}>Retry</button></>}
              <style>{'@keyframes spin{to{transform:rotate(360deg)}}'}</style>
            </div>
          )}
        </div>

        {/* Now Playing bar */}
        <div style={{ padding:'14px 20px', background:'rgba(0,0,0,0.6)', borderTop:'1px solid rgba(255,255,255,0.06)', display:'flex', alignItems:'center', gap:16, minHeight:64 }}>
          {activeChannel && <span style={{ fontSize:11, fontWeight:700, color:'var(--accent)', background:'rgba(99,102,241,0.15)', padding:'3px 8px', borderRadius:4, flexShrink:0 }}>CH {activeChannel.num}</span>}
          <div style={{ flex:1, minWidth:0 }}>
            {nowPlaying ? (
              <>
                <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                  {nowPlaying.isLive && <span style={{ fontSize:9, fontWeight:700, color:'#ef4444', background:'rgba(239,68,68,0.2)', padding:'2px 6px', borderRadius:3 }}>🔴 LIVE</span>}
                  <div style={{ fontSize:15, fontWeight:700, color:'white', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{nowPlaying.title||'Unknown'}</div>
                </div>
                <div style={{ fontSize:11, color:'rgba(255,255,255,0.5)', marginTop:2 }}>
                  {!nowPlaying.isLive && nowPlaying.season ? `S${String(nowPlaying.season).padStart(2,'0')}E${String(nowPlaying.episode||0).padStart(2,'0')} · ` : ''}
                  {!nowPlaying.isLive && fmtDur(nowPlaying.duration)}
                  {activeChannel && <span style={{ marginLeft:8 }}>{activeChannel.name}</span>}
                </div>
              </>
            ) : activeId ? (
              <div style={{ fontSize:13, color:'rgba(255,255,255,0.3)' }}>{status==='loading'?'Loading…':'Nothing scheduled'}</div>
            ) : (
              <div style={{ fontSize:13, color:'rgba(255,255,255,0.3)' }}>Select a channel to start watching</div>
            )}
          </div>
          {nowPlaying?.thumb && <img src={nowPlaying.thumb} alt="" style={{ width:64, height:40, objectFit:'cover', borderRadius:4, flexShrink:0 }} onError={e=>e.target.style.display='none'}/>}
        </div>

        {/* Now Playing detail + Up Next */}
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', flex:1, overflow:'hidden', borderTop:'1px solid rgba(255,255,255,0.06)' }}>
          {/* Detail */}
          <div style={{ padding:'16px 20px', borderRight:'1px solid rgba(255,255,255,0.06)', overflowY:'auto' }}>
            <div style={{ fontSize:10, fontWeight:700, color:'rgba(255,255,255,0.3)', letterSpacing:1.5, marginBottom:10 }}>NOW PLAYING</div>
            {nowPlaying ? (
              <>
                {nowPlaying.thumb && <img src={nowPlaying.thumb} alt="" style={{ width:'100%', maxWidth:200, borderRadius:6, marginBottom:12, display:'block' }} onError={e=>e.target.style.display='none'}/>}
                <div style={{ fontSize:16, fontWeight:700, color:'white', marginBottom:4 }}>{nowPlaying.title}</div>
                <div style={{ fontSize:12, color:'rgba(255,255,255,0.4)', marginBottom:10 }}>
                  {nowPlaying.season ? `Season ${nowPlaying.season}, Episode ${nowPlaying.episode}` : ''}
                  {nowPlaying.year ? ` · ${nowPlaying.year}` : ''}
                </div>
                {nowPlaying.summary && <div style={{ fontSize:12, color:'rgba(255,255,255,0.5)', lineHeight:1.6 }}>{nowPlaying.summary}</div>}
              </>
            ) : (
              <div style={{ color:'rgba(255,255,255,0.2)', fontSize:13 }}>No information available</div>
            )}
          </div>

          {/* Up Next */}
          <div style={{ overflowY:'auto' }}>
            <div style={{ padding:'16px 20px 10px', fontSize:10, fontWeight:700, color:'rgba(255,255,255,0.3)', letterSpacing:1.5 }}>UP NEXT</div>
            {upNext.length === 0 ? (
              <div style={{ padding:'0 20px', color:'rgba(255,255,255,0.2)', fontSize:13 }}>No upcoming schedule</div>
            ) : upNext.map((p,i) => (
              <div key={i} style={{ display:'flex', alignItems:'center', gap:12, padding:'10px 20px', borderBottom:'1px solid rgba(255,255,255,0.04)' }}>
                <span style={{ fontSize:11, color:'var(--accent)', fontWeight:700, minWidth:55, flexShrink:0 }}>{fmtTime(p.start)}</span>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:12, fontWeight:600, color:'rgba(255,255,255,0.75)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{p.title}</div>
                  {p.end&&p.start&&<div style={{ fontSize:10, color:'rgba(255,255,255,0.3)', marginTop:1 }}>{fmtDur(p.end-p.start)}</div>}
                </div>
              </div>
            ))}
          </div>
        </div>
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
  const [testingAi, setTestingAi] = useState(false);
  const testAi = async () => {
    setTestingAi(true);
    try {
      const r = await call('POST', '/api/sf/ai/test');
      notify('✅ ' + (r.message || 'AI is working'));
    } catch(e) { notify(e.message, true); }
    setTestingAi(false);
  };
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
          {config.aiProvider==='anthropic' && <Field label="Anthropic API Key"><input style={inp} type="password" value={config.anthropicApiKey||''} onChange={e=>update('anthropicApiKey',e.target.value)} placeholder="sk-ant-…"/></Field>}
          {config.aiProvider==='openai' && <>
            <Field label="OpenAI API Key"><input style={inp} type="password" value={config.openaiApiKey||''} onChange={e=>update('openaiApiKey',e.target.value)}/></Field>
            <Field label="Model"><input style={inp} value={config.openaiModel||'gpt-4o'} onChange={e=>update('openaiModel',e.target.value)}/></Field>
          </>}
          {config.aiProvider==='ollama' && <>
            <Field label="Ollama URL" hint="e.g. http://192.168.0.x:11434"><input style={inp} value={config.ollamaUrl||'http://localhost:11434'} onChange={e=>update('ollamaUrl',e.target.value)}/></Field>
            <Field label="Model"><input style={inp} value={config.ollamaModel||'llama3.2'} onChange={e=>update('ollamaModel',e.target.value)}/></Field>
          </>}
          {config.aiProvider==='openwebui' && <>
            <Field label="Open WebUI URL" hint="e.g. http://192.168.0.x:3000"><input style={inp} value={config.openwebUIUrl||''} onChange={e=>update('openwebUIUrl',e.target.value)} placeholder="http://192.168.0.x:3000"/></Field>
            <Field label="API Key" hint="Found in Open WebUI → Settings → Account"><input style={inp} type="password" value={config.openwebUIKey||''} onChange={e=>update('openwebUIKey',e.target.value)} placeholder="sk-…"/></Field>
            <Field label="Model"><input style={inp} value={config.openwebUIModel||''} onChange={e=>update('openwebUIModel',e.target.value)} placeholder="llama3.2"/></Field>
          </>}
          {config.aiProvider==='custom' && <>
            <Field label="Base URL" hint="OpenAI-compatible /v1 endpoint"><input style={inp} value={config.customAiUrl||''} onChange={e=>update('customAiUrl',e.target.value)} placeholder="http://host:port/v1"/></Field>
            <Field label="API Key" hint="Leave blank if not required"><input style={inp} type="password" value={config.customAiKey||''} onChange={e=>update('customAiKey',e.target.value)}/></Field>
            <Field label="Model"><input style={inp} value={config.customAiModel||''} onChange={e=>update('customAiModel',e.target.value)} placeholder="model-name"/></Field>
          </>}
          <button onClick={testAi} disabled={testingAi} style={{ marginTop:10, padding:'7px 16px', background:'rgba(255,255,255,0.07)', border:'1px solid rgba(255,255,255,0.15)', color:'white', borderRadius:'var(--radius)', cursor:'pointer', fontSize:12 }}>
            {testingAi ? '⏳ Testing…' : '🧪 Test AI Connection'}
          </button>
        </div>
        <div style={{ background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:'var(--radius-lg)',padding:20 }}>
          <div style={{ fontWeight:700,fontSize:14,marginBottom:16 }}>🎬 Transcoding</div>
          <Field label="Video Codec">
            <select style={inp} value={config.videoCodec||'copy'} onChange={e=>update('videoCodec',e.target.value)}>
              <option value="copy">Copy (no transcode — fastest, may stutter with HEVC)</option>
              <option value="h264">H.264 (hardware encode — best compatibility)</option>
              <option value="hevc">H.265/HEVC (hardware encode — smaller files)</option>
            </select>
          </Field>
          {(config.videoCodec==='h264'||config.videoCodec==='hevc') && <>
            <Field label="Hardware Decode" hint="Use GPU to decode the input stream — eliminates CPU decoding entirely. NVIDIA=NVDEC, AMD=D3D11VA/VAAPI, Intel=QSV">
              <label style={{ display:'flex',alignItems:'center',gap:8,cursor:'pointer' }}>
                <input type="checkbox" checked={!!config.hwDecode} onChange={e=>update('hwDecode',e.target.checked)}/>
                <span style={{ fontSize:13 }}>Enable hardware decode (all GPU types supported)</span>
              </label>
            </Field>
            <Field label="GPU Count" hint="Number of GPUs available for round-robin channel distribution">
              <input style={inp} type="number" min={1} max={16} value={config.gpuCount||1} onChange={e=>update('gpuCount',parseInt(e.target.value)||1)}/>
            </Field>
          </>}
          <Field label="Maximum Resolution" hint="The highest resolution to encode. When adaptive quality is enabled this is the ceiling.">
            <select style={inp} value={config.maxResolution||config.videoResolution||''} onChange={e=>update('maxResolution',e.target.value)}>
              <option value="">Source (keep original)</option>
              <option value="3840x2160">4K UHD — 3840×2160</option>
              <option value="2560x1440">2K QHD — 2560×1440</option>
              <option value="1920x1080">1080p FHD — 1920×1080</option>
              <option value="1280x720">720p HD — 1280×720</option>
              <option value="854x480">480p SD — 854×480</option>
              <option value="640x360">360p — 640×360</option>
              <option value="426x240">240p — 426×240</option>
            </select>
          </Field>
          <Field label="Adaptive Quality" hint="Automatically reduce resolution when server load is high (like Netflix). Drops to 720p then 480p as needed, restores when load drops.">
            <label style={{ display:'flex', alignItems:'center', gap:8, cursor:'pointer' }}>
              <input type="checkbox" checked={!!config.adaptiveQuality} onChange={e=>update('adaptiveQuality', e.target.checked)} />
              <span style={{ fontSize:13 }}>Enable adaptive quality (auto-reduce resolution under load)</span>
            </label>
          </Field>
          <Field label="Audio Language" hint="ISO 639-2 code (e.g. eng, spa)"><input style={inp} value={config.audioLanguage||'eng'} onChange={e=>update('audioLanguage',e.target.value)}/></Field>
        </div>
        <div style={{ background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:'var(--radius-lg)',padding:20 }}>
          <div style={{ fontWeight:700,fontSize:14,marginBottom:16 }}>📡 HLS Output</div>
          <Field label="Segment Length (seconds)"><input style={inp} type="number" value={config.hlsSegmentSeconds||4} onChange={e=>update('hlsSegmentSeconds',+e.target.value)} min={1} max={30}/></Field>
          <Field label="Playlist Size (segments)"><input style={inp} type="number" value={config.hlsListSize||6} onChange={e=>update('hlsListSize',+e.target.value)} min={2} max={20}/></Field>
          <Field label="Idle Timeout (seconds)"><input style={inp} type="number" value={config.hlsIdleTimeoutSecs||60} onChange={e=>update('hlsIdleTimeoutSecs',+e.target.value)} min={10}/></Field>
          <Field label="Pre-buffer Mode" hint="Controls which channels are pre-buffered on server startup for instant playback">
            <select style={inp} value={config.prebufferMode||'library'} onChange={e=>update('prebufferMode',e.target.value)}>
              <option value="library">Library Only (TV shows, movies — recommended)</option>
              <option value="all">All Channels (library + live streams)</option>
              <option value="live">Live Streams Only</option>
              <option value="none">None (start on demand)</option>
            </select>
          </Field>
        </div>
      </div>
      <div style={{ display:'flex',justifyContent:'flex-end',marginTop:20 }}>
        <button onClick={save} disabled={saving} style={{ padding:'10px 28px',background:'var(--accent)',color:'white',border:'none',borderRadius:'var(--radius)',fontWeight:700,cursor:'pointer',fontSize:14 }}>{saving?'Saving…':'Save Settings'}</button>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
// ── Schedule Grid ─────────────────────────────────────────────────────────────
function ScheduleGrid({ call }) {
  const [date, setDate] = useState(() => new Date().toISOString().slice(0,10));
  const [schedule, setSchedule] = useState([]);
  const [loading, setLoading] = useState(false);
  const nowRef = useRef(null);

  const load = useCallback(async (d) => {
    setLoading(true);
    try {
      const data = await call('GET', `/api/sf/schedule?date=${d}&from=${new Date(d+'T00:00:00Z').getTime()}&to=${new Date(d+'T00:00:00Z').getTime()+86400000}`);
      setSchedule(Array.isArray(data) ? data : []);
    } catch { setSchedule([]); }
    setLoading(false);
  }, [call]);

  useEffect(() => { load(date); }, [date, load]);

  // Scroll to current time on load
  useEffect(() => {
    if (nowRef.current) nowRef.current.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }, [schedule]);

  const fmtTime = (ms) => {
    const d = new Date(ms);
    const h = d.getUTCHours(), m = d.getUTCMinutes();
    const ampm = h < 12 ? 'AM' : 'PM';
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `${h12}:${String(m).padStart(2,'0')} ${ampm}`;
  };

  const hours = Array.from({length:24}, (_,h) => h);
  const dayStart = new Date(date+'T00:00:00Z').getTime();
  const nowMs = Date.now();
  const isToday = date === new Date().toISOString().slice(0,10);
  const nowHour = isToday ? new Date().getUTCHours() : -1;

  const CELL_W = 120; // px per hour cell

  return (
    <div>
      <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:20 }}>
        <div style={{ fontWeight:700, fontSize:16 }}>📅 Schedule Grid</div>
        <input type="date" value={date} onChange={e=>setDate(e.target.value)}
          style={{ padding:'7px 12px', background:'var(--bg-card)', border:'1px solid var(--border)', borderRadius:'var(--radius)', color:'var(--text-primary)', fontSize:13 }}/>
        <button onClick={()=>setDate(new Date().toISOString().slice(0,10))}
          style={{ padding:'7px 14px', background:'var(--bg-card)', border:'1px solid var(--border)', borderRadius:'var(--radius)', color:'var(--text-secondary)', cursor:'pointer', fontSize:12, fontWeight:600 }}>
          Today
        </button>
        <button onClick={()=>load(date)}
          style={{ padding:'7px 14px', background:'var(--bg-card)', border:'1px solid var(--border)', borderRadius:'var(--radius)', color:'var(--text-secondary)', cursor:'pointer', fontSize:12 }}>
          ↻ Refresh
        </button>
        <div style={{ fontSize:13, color:'var(--text-muted)' }}>
          {new Date(date+'T12:00:00').toDateString()}
        </div>
      </div>

      {loading ? (
        <div style={{ textAlign:'center', padding:40, color:'var(--text-muted)' }}>Loading schedule…</div>
      ) : schedule.length === 0 ? (
        <div style={{ textAlign:'center', padding:40, color:'var(--text-muted)' }}>
          No channels with playout configured. Build AI schedules first.
        </div>
      ) : (
        <div style={{ overflowX:'auto', borderRadius:'var(--radius-lg)', border:'1px solid var(--border)' }}>
          {/* Timeline header */}
          <div style={{ display:'flex', position:'sticky', top:0, zIndex:10, background:'var(--bg-secondary)' }}>
            <div style={{ width:160, minWidth:160, borderRight:'1px solid var(--border)', borderBottom:'1px solid var(--border)', padding:'8px 12px', fontSize:11, fontWeight:700, color:'var(--text-muted)', letterSpacing:1 }}>CHANNEL</div>
            <div style={{ display:'flex', borderBottom:'1px solid var(--border)' }}>
              {hours.map(h => {
                const label = h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h-12} PM`;
                return (
                  <div key={h} ref={h === nowHour ? nowRef : null}
                    style={{ width:CELL_W, minWidth:CELL_W, padding:'8px 8px', fontSize:11, fontWeight:700, color: h === nowHour ? 'var(--accent)' : 'var(--text-muted)', borderRight:'1px solid var(--border)', background: h === nowHour ? 'rgba(99,102,241,0.08)' : 'transparent', letterSpacing:0.5 }}>
                    {label}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Channel rows */}
          {schedule.filter(row => row.programs && row.programs.length > 0).map(row => (
            <div key={row.channel.id} style={{ display:'flex', borderBottom:'1px solid rgba(255,255,255,0.05)' }}
              onMouseEnter={e=>e.currentTarget.style.background='rgba(255,255,255,0.02)'}
              onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
              {/* Channel label */}
              <div style={{ width:160, minWidth:160, borderRight:'1px solid var(--border)', padding:'10px 12px', display:'flex', alignItems:'center', gap:8 }}>
                <span style={{ fontSize:11, fontWeight:700, color:'var(--accent)', minWidth:20 }}>{row.channel.num}</span>
                <span style={{ fontSize:12, fontWeight:600, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{row.channel.name}</span>
              </div>

              {/* Hour cells */}
              <div style={{ display:'flex', flex:1 }}>
                {hours.map(h => {
                  const slotStart = dayStart + h * 3600000;
                  const slotEnd = slotStart + 3600000;
                  const isNowSlot = isToday && nowMs >= slotStart && nowMs < slotEnd;
                  const prog = row.programs.find(p => p.start < slotEnd && p.end > slotStart);
                  return (
                    <div key={h} style={{ width:CELL_W, minWidth:CELL_W, borderRight:'1px solid rgba(255,255,255,0.04)', padding:'6px 8px', background: isNowSlot ? 'rgba(99,102,241,0.1)' : 'transparent', borderLeft: isNowSlot ? '2px solid var(--accent)' : 'none' }}>
                      {prog ? (
                        <div title={prog.title}>
                          <div style={{ fontSize:11, fontWeight:600, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', color: prog.isLive ? '#ef4444' : 'var(--text-primary)' }}>
                            {prog.isLive ? '🔴 ' : ''}{prog.title}
                          </div>
                          <div style={{ fontSize:10, color:'var(--text-muted)', marginTop:2 }}>{fmtTime(prog.start)}</div>
                        </div>
                      ) : (
                        <div style={{ fontSize:11, color:'rgba(255,255,255,0.15)' }}>—</div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


function PreSegManager({ call }) {
  const [status, setStatus] = React.useState(null);
  const [channels, setChannels] = React.useState([]);
  const [loading, setLoading] = React.useState(false);
  const [msg, setMsg] = React.useState('');

  const refresh = async () => {
    try {
      const [s, chs] = await Promise.all([
        call('GET', '/api/sf/preseg/status'),
        call('GET', '/api/sf/channels'),
      ]);
      setStatus(s);
      setChannels(chs.filter(c => !c.liveStreamId));
    } catch(e) { setMsg(e.message); }
  };

  React.useEffect(() => { refresh(); const t = setInterval(refresh, 5000); return () => clearInterval(t); }, []);

  const queueChannel = async (chId, chName) => {
    setLoading(true);
    try {
      const r = await call('POST', '/api/sf/preseg/queue-channel', { channelId: chId });
      setMsg('✅ Queued ' + r.queued + ' items for "' + chName + '"');
      refresh();
    } catch(e) { setMsg(e.message); }
    setLoading(false);
  };

  const queueAll = async () => {
    if (!window.confirm('Queue ALL library content for pre-segmentation? This will use significant disk space and take a long time.')) return;
    setLoading(true);
    try {
      const r = await call('POST', '/api/sf/preseg/queue-all', {});
      setMsg('✅ Queued ' + r.queued + ' items for pre-segmentation');
      refresh();
    } catch(e) { setMsg(e.message); }
    setLoading(false);
  };

  const card = { background:'var(--bg-card)', border:'1px solid var(--border)', borderRadius:'var(--radius-lg)', padding:20, marginBottom:16 };

  return (
    <div>
      {msg && <div style={{ padding:'10px 14px', background:'rgba(99,102,241,0.1)', border:'1px solid rgba(99,102,241,0.3)', borderRadius:'var(--radius)', marginBottom:16, fontSize:13 }}>{msg}</div>}
      <div style={card}>
        <div style={{ fontWeight:700, fontSize:14, marginBottom:16 }}>⚡ Pre-Segmentation Engine</div>
        <div style={{ fontSize:12, color:'var(--text-muted)', marginBottom:16, lineHeight:1.6 }}>
          Pre-segments your media files to HLS once. Playback uses near-zero CPU — just file I/O.
          Target: 60+ channels with minimal server load.
        </div>
        {status && (
          <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:12, marginBottom:16 }}>
            {[
              { label:'Done', value:status.done, color:'#10b981' },
              { label:'Processing', value:status.processing, color:'var(--accent)' },
              { label:'Queued', value:status.queued, color:'#f59e0b' },
              { label:'Total Media', value:status.totalMedia, color:'var(--text-secondary)' },
            ].map(s => (
              <div key={s.label} style={{ background:'var(--bg-tertiary)', borderRadius:'var(--radius)', padding:'12px 16px', textAlign:'center' }}>
                <div style={{ fontSize:24, fontWeight:700, color:s.color }}>{(s.value||0).toLocaleString()}</div>
                <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:4 }}>{s.label}</div>
              </div>
            ))}
          </div>
        )}
        {status && status.done > 0 && status.totalMedia > 0 && (
          <div style={{ marginBottom:16 }}>
            <div style={{ display:'flex', justifyContent:'space-between', fontSize:11, color:'var(--text-muted)', marginBottom:4 }}>
              <span>Progress</span>
              <span>{Math.round(status.done/status.totalMedia*100)}%</span>
            </div>
            <div style={{ height:6, background:'var(--bg-tertiary)', borderRadius:3, overflow:'hidden' }}>
              <div style={{ height:'100%', width:(Math.round((status.done||0)/(status.totalMedia||1)*100))+'%', background:'#10b981', borderRadius:3, transition:'width 0.5s' }}/>
            </div>
          </div>
        )}
        <div style={{ display:'flex', gap:10 }}>
          <button onClick={queueAll} disabled={loading} style={{ padding:'9px 20px', background:'var(--accent)', color:'white', border:'none', borderRadius:'var(--radius)', fontWeight:700, cursor:'pointer', fontSize:13 }}>
            ⚡ Queue All Library
          </button>
          <button onClick={refresh} style={{ padding:'9px 14px', background:'var(--bg-tertiary)', border:'1px solid var(--border)', borderRadius:'var(--radius)', color:'var(--text-secondary)', cursor:'pointer', fontSize:13 }}>
            ↻ Refresh
          </button>
        </div>
      </div>
      <div style={card}>
        <div style={{ fontWeight:700, fontSize:14, marginBottom:12 }}>Queue by Channel</div>
        <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
          {channels.map(ch => (
            <div key={ch.id} style={{ display:'flex', alignItems:'center', gap:12, padding:'10px 14px', background:'var(--bg-tertiary)', borderRadius:'var(--radius)' }}>
              <span style={{ fontSize:11, fontWeight:700, color:'var(--accent)', minWidth:24 }}>{ch.num}</span>
              <span style={{ flex:1, fontSize:13 }}>{ch.name}</span>
              <button onClick={() => queueChannel(ch.id, ch.name)} disabled={loading} style={{ padding:'5px 14px', background:'rgba(99,102,241,0.15)', border:'1px solid rgba(99,102,241,0.3)', borderRadius:'var(--radius)', color:'#818cf8', cursor:'pointer', fontSize:11, fontWeight:600 }}>
                Queue Content
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const TABS = [
  { id:'dashboard', icon:<Signal size={14}/>,    label:'Dashboard'       },
  { id:'channels',  icon:<Tv2 size={14}/>,        label:'Channels'        },
  { id:'playout',   icon:<List size={14}/>,        label:'Playout Builder' },
  { id:'streams',   icon:<Radio size={14}/>,       label:'Live Streams'    },
  { id:'epg',       icon:<Calendar size={14}/>,    label:'EPG'             },
  { id:'ai',        icon:<Bot size={14}/>,          label:'AI Scheduler'    },
  { id:'libraries', icon:<Library size={14}/>,     label:'Libraries'       },
  { id:'schedule',  icon:<Calendar size={14}/>,     label:'Schedule'        },
  { id:'watch',     icon:<Monitor size={14}/>,      label:'Watch'           },
  { id:'preseg',    icon:<Zap size={14}/>,           label:'Pre-Segment'     },
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
                style={{ height:160,maxWidth:600,objectFit:'contain',mixBlendMode:'screen',flexShrink:0 }}
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
        {tab==='schedule'  && <ScheduleGrid  call={call}/>}
        {tab==='watch'     && <Watch       call={call} initialChannelId={watchId}/>}
        {tab==='settings'  && <SFSettings  call={call}/>}
      </div>
    </div>
  );
}

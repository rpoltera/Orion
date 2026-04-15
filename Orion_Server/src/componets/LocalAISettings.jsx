import React, { useState, useEffect, useCallback } from 'react';

export default function LocalAISettings({ API }) {
  const [ollamaUrl, setOllamaUrl]   = useState('http://localhost:11434');
  const [status, setStatus]         = useState(null);   // { ok, version, error }
  const [models, setModels]         = useState([]);
  const [loadingModels, setLM]      = useState(false);
  const [pullModel, setPullModel]   = useState('');
  const [pulling, setPulling]       = useState(false);
  const [pullLog, setPullLog]       = useState('');
  const [testing, setTesting]       = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [searchQ, setSearchQ]       = useState('');
  const [searchResults, setSR]      = useState([]);
  const [searching, setSearching]   = useState(false);
  const [deletingModel, setDel]     = useState(null);

  const checkStatus = useCallback(async () => {
    setStatus(null);
    try {
      const r = await fetch(`${API}/ai/status?url=${encodeURIComponent(ollamaUrl)}`);
      setStatus(await r.json());
    } catch(e) { setStatus({ ok: false, error: e.message }); }
  }, [API, ollamaUrl]);

  const loadModels = useCallback(async () => {
    setLM(true);
    try {
      const r = await fetch(`${API}/ai/models?url=${encodeURIComponent(ollamaUrl)}`);
      const d = await r.json();
      setModels(d.models || []);
    } catch {}
    setLM(false);
  }, [API, ollamaUrl]);

  useEffect(() => { checkStatus(); }, []);

  useEffect(() => {
    if (status?.ok) loadModels();
  }, [status?.ok]);

  const testAI = async () => {
    if (!models.length) return;
    setTesting(true); setTestResult(null);
    try {
      const r = await fetch(`${API}/ai/test`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: ollamaUrl, model: models[0]?.name }),
      });
      setTestResult(await r.json());
    } catch(e) { setTestResult({ ok: false, error: e.message }); }
    setTesting(false);
  };

  const pullModelFn = async (modelName) => {
    const name = modelName || pullModel.trim();
    if (!name) return;
    setPulling(true); setPullLog('Starting pull…\n'); setPullModel(name);
    try {
      const r = await fetch(`${API}/ai/pull`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: name, url: ollamaUrl }),
      });
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const lines = dec.decode(value).split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const d = JSON.parse(line);
            const msg = d.status + (d.completed && d.total ? ` (${Math.round(d.completed/d.total*100)}%)` : '');
            setPullLog(prev => prev + msg + '\n');
            if (d.status === 'success') { await loadModels(); }
          } catch {}
        }
      }
    } catch(e) { setPullLog(prev => prev + 'Error: ' + e.message + '\n'); }
    setPulling(false);
  };

  const deleteModel = async (name) => {
    if (!window.confirm(`Delete model "${name}"? This cannot be undone.`)) return;
    setDel(name);
    try {
      await fetch(`${API}/ai/models/${encodeURIComponent(name)}?url=${encodeURIComponent(ollamaUrl)}`, { method: 'DELETE' });
      setModels(m => m.filter(x => x.name !== name));
    } catch(e) { alert('Delete failed: ' + e.message); }
    setDel(null);
  };

  const searchModels = async () => {
    if (!searchQ.trim()) return;
    setSearching(true); setSR([]);
    try {
      const r = await fetch(`${API}/ai/search-models?q=${encodeURIComponent(searchQ)}`);
      const d = await r.json();
      setSR(d.results || []);
    } catch {}
    setSearching(false);
  };

  const card = { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: 20, marginBottom: 16 };
  const inp  = { width: '100%', padding: '8px 12px', background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', color: 'var(--text-primary)', fontSize: 13, outline: 'none', boxSizing: 'border-box' };
  const btn  = (extra = {}) => ({ padding: '8px 16px', borderRadius: 'var(--radius)', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600, ...extra });

  return (
    <div style={{ maxWidth: 720 }}>

      {/* Connection */}
      <div style={card}>
        <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 14 }}>🦙 Ollama Connection</div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <input style={{ ...inp, flex: 1 }} value={ollamaUrl} onChange={e => setOllamaUrl(e.target.value)}
            placeholder="http://localhost:11434" onKeyDown={e => e.key === 'Enter' && checkStatus()} />
          <button style={btn({ background: 'var(--accent)', color: 'white' })} onClick={checkStatus}>Connect</button>
        </div>
        {status && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13,
            color: status.ok ? '#10b981' : '#ef4444',
            background: status.ok ? 'rgba(16,185,129,0.08)' : 'rgba(239,68,68,0.08)',
            border: `1px solid ${status.ok ? 'rgba(16,185,129,0.2)' : 'rgba(239,68,68,0.2)'}`,
            borderRadius: 'var(--radius)', padding: '8px 12px' }}>
            <span>{status.ok ? '✅' : '❌'}</span>
            <span>{status.ok ? `Connected — Ollama v${status.version}` : `Not reachable: ${status.error}`}</span>
          </div>
        )}
        {status?.ok && (
          <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
            <button style={btn({ background: 'rgba(255,255,255,0.06)', color: 'var(--text-secondary)', border: '1px solid var(--border)' })}
              onClick={testAI} disabled={testing || !models.length}>
              {testing ? '⏳ Testing…' : '🧪 Test Generation'}
            </button>
            {testResult && (
              <div style={{ fontSize: 12, padding: '8px 12px', borderRadius: 'var(--radius)',
                color: testResult.ok ? '#10b981' : '#ef4444',
                background: testResult.ok ? 'rgba(16,185,129,0.08)' : 'rgba(239,68,68,0.08)' }}>
                {testResult.ok ? `✅ ${testResult.model}: "${testResult.response}"` : `❌ ${testResult.error}`}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Installed Models */}
      {status?.ok && (
        <div style={card}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
            <div style={{ fontWeight: 700, fontSize: 14 }}>📦 Installed Models</div>
            <button style={btn({ background: 'rgba(255,255,255,0.06)', color: 'var(--text-secondary)', border: '1px solid var(--border)', padding: '6px 12px' })}
              onClick={loadModels} disabled={loadingModels}>
              {loadingModels ? '⏳' : '↻ Refresh'}
            </button>
          </div>
          {models.length === 0 ? (
            <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No models installed. Pull one below.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {models.map(m => (
                <div key={m.name} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '10px 14px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius)', border: '1px solid var(--border)' }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{m.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{m.sizeGb}</div>
                  </div>
                  <button onClick={() => deleteModel(m.name)} disabled={deletingModel === m.name}
                    style={btn({ background: 'rgba(239,68,68,0.1)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.2)', padding: '5px 10px', fontSize: 12 })}>
                    {deletingModel === m.name ? '…' : 'Delete'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Pull a Model */}
      {status?.ok && (
        <div style={card}>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 14 }}>⬇️ Pull a Model</div>

          {/* Search Ollama library */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <input style={{ ...inp, flex: 1 }} value={searchQ} onChange={e => setSearchQ(e.target.value)}
              placeholder="Search Ollama model library…" onKeyDown={e => e.key === 'Enter' && searchModels()} />
            <button style={btn({ background: 'var(--accent)', color: 'white' })} onClick={searchModels} disabled={searching}>
              {searching ? '…' : 'Search'}
            </button>
          </div>

          {searchResults.length > 0 && (
            <div style={{ marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 200, overflowY: 'auto' }}>
              {searchResults.map(r => (
                <div key={r.name} onClick={() => { setPullModel(r.name); setSR([]); }}
                  style={{ padding: '8px 12px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius)', cursor: 'pointer',
                    border: '1px solid var(--border)', fontSize: 13 }}
                  onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--accent)'}
                  onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border)'}>
                  <div style={{ fontWeight: 600 }}>{r.name}</div>
                  {r.description && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{r.description}</div>}
                </div>
              ))}
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <input style={{ ...inp, flex: 1 }} value={pullModel} onChange={e => setPullModel(e.target.value)}
              placeholder="e.g. llama3.2, mistral, gemma2:9b" onKeyDown={e => e.key === 'Enter' && pullModelFn()} />
            <button style={btn({ background: '#10b981', color: 'white' })} onClick={() => pullModelFn()} disabled={pulling || !pullModel.trim()}>
              {pulling ? '⏳ Pulling…' : '⬇️ Pull'}
            </button>
          </div>

          {pullLog && (
            <pre style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid var(--border)', borderRadius: 'var(--radius)',
              padding: '10px 14px', fontSize: 11, color: 'var(--text-secondary)', maxHeight: 160, overflowY: 'auto',
              margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              {pullLog}
            </pre>
          )}
        </div>
      )}

    </div>
  );
}

import React, { useState, useEffect, useCallback, useRef } from 'react';

export default function AISettings({ API }) {
  const [config, setConfig] = useState({});
  const [loaded, setLoaded] = useState(false);
  const [testingAi, setTestingAi] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const saveTimerRef = useRef(null);

  // Ollama-specific state (only used when provider=ollama)
  const [installing, setInstalling] = useState(false);
  const [installLog, setInstallLog] = useState('');
  const [ollamaStatus, setOllamaStatus] = useState(null);
  const [models, setModels] = useState([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [pullModelName, setPullModelName] = useState('');
  const [pulling, setPulling] = useState(false);
  const [pullLog, setPullLog] = useState('');
  const [searchQ, setSearchQ] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [deletingModel, setDeletingModel] = useState(null);

  // Load streamforge config on mount
  useEffect(() => {
    fetch(`${API}/sf/config`)
      .then(r => r.json())
      .then(c => { setConfig(c || {}); setLoaded(true); })
      .catch(() => setLoaded(true));
  }, []);

  // Debounced PATCH back to backend
  const update = (key, value) => {
    setConfig(c => ({ ...c, [key]: value }));
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      try {
        await fetch(`${API}/sf/config`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [key]: value })
        });
      } catch (e) {}
    }, 500);
  };

  // Test AI connection (provider-agnostic backend endpoint)
  const testAi = async () => {
    setTestingAi(true);
    setTestResult(null);
    try {
      const r = await fetch(`${API}/sf/ai/test`, { method: 'POST' });
      const d = await r.json();
      setTestResult(d);
    } catch (e) {
      setTestResult({ ok: false, error: e.message });
    }
    setTestingAi(false);
  };

  // === Ollama-specific helpers ===
  const checkOllamaStatus = useCallback(async () => {
    const url = config.ollamaUrl;
    if (!url) return;
    setOllamaStatus(null);
    try {
      const r = await fetch(`${API}/ai/status?url=${encodeURIComponent(url)}`);
      setOllamaStatus(await r.json());
    } catch (e) {
      setOllamaStatus({ ok: false, error: e.message });
    }
  }, [API, config.ollamaUrl]);

  const loadModels = useCallback(async () => {
    const url = config.ollamaUrl;
    if (!url) return;
    setLoadingModels(true);
    try {
      const r = await fetch(`${API}/ai/models?url=${encodeURIComponent(url)}`);
      const d = await r.json();
      setModels(d.models || []);
    } catch {}
    setLoadingModels(false);
  }, [API, config.ollamaUrl]);

  // Auto-check ollama when provider is ollama and URL is set
  useEffect(() => {
    if (config.aiProvider === 'ollama' && config.ollamaUrl) checkOllamaStatus();
  }, [config.aiProvider, config.ollamaUrl, checkOllamaStatus]);

  useEffect(() => {
    if (ollamaStatus?.ok) loadModels();
  }, [ollamaStatus?.ok, loadModels]);

  const installOllama = async () => {
    setInstalling(true);
    setInstallLog('');
    try {
      const res = await fetch(`${API}/ai/install-ollama`, { method: 'POST' });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        setInstallLog(prev => prev + dec.decode(value));
      }
    } catch (e) {
      setInstallLog(prev => prev + '\n❌ ' + e.message);
    }
    setInstalling(false);
    checkOllamaStatus();
  };

  const pullModelFn = async (name) => {
    const m = name || pullModelName.trim();
    if (!m) return;
    setPulling(true);
    setPullLog('Starting pull…\n');
    setPullModelName(m);
    try {
      const r = await fetch(`${API}/ai/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: m, url: config.ollamaUrl })
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
            if (d.status === 'success') await loadModels();
          } catch {}
        }
      }
    } catch (e) {
      setPullLog(prev => prev + 'Error: ' + e.message + '\n');
    }
    setPulling(false);
  };

  const deleteModel = async (name) => {
    if (!window.confirm(`Delete model "${name}"? This cannot be undone.`)) return;
    setDeletingModel(name);
    try {
      await fetch(`${API}/ai/models/${encodeURIComponent(name)}?url=${encodeURIComponent(config.ollamaUrl)}`, { method: 'DELETE' });
      setModels(ms => ms.filter(x => x.name !== name));
    } catch (e) {
      alert('Delete failed: ' + e.message);
    }
    setDeletingModel(null);
  };

  const searchModels = async () => {
    if (!searchQ.trim()) return;
    setSearching(true);
    setSearchResults([]);
    try {
      const r = await fetch(`${API}/ai/search-models?q=${encodeURIComponent(searchQ)}`);
      const d = await r.json();
      setSearchResults(d.results || []);
    } catch {}
    setSearching(false);
  };

  // === Styles ===
  const card = { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: 20, marginBottom: 16 };
  const inp = { width: '100%', padding: '8px 12px', background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', color: 'var(--text-primary)', fontSize: 13, outline: 'none', boxSizing: 'border-box' };
  const btn = (extra = {}) => ({ padding: '8px 16px', borderRadius: 'var(--radius)', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600, ...extra });

  const Field = ({ label, hint, children }) => (
    <div style={{ marginBottom: 12 }}>
      <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6, display: 'block' }}>{label}</label>
      {children}
      {hint && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 5 }}>{hint}</div>}
    </div>
  );

  if (!loaded) {
    return <div style={{ padding: 20, color: 'var(--text-muted)', fontSize: 13 }}>Loading AI settings…</div>;
  }

  const provider = config.aiProvider || 'anthropic';

  return (
    <div style={{ maxWidth: 720 }}>

      {/* Provider Selection */}
      <div style={card}>
        <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 16 }}>🤖 AI Provider</div>
        <Field label="Provider" hint="Used by AI Scheduler, AI Suggestions, and other Orion AI features">
          <select style={inp} value={provider} onChange={e => update('aiProvider', e.target.value)}>
            <option value="anthropic">Anthropic (Claude)</option>
            <option value="openai">OpenAI (GPT)</option>
            <option value="ollama">Ollama (Local LLM)</option>
            <option value="openwebui">Open WebUI</option>
            <option value="custom">Custom Endpoint</option>
          </select>
        </Field>

        {provider === 'anthropic' && (
          <Field label="Anthropic API Key">
            <input style={inp} type="password" value={config.anthropicApiKey || ''} onChange={e => update('anthropicApiKey', e.target.value)} placeholder="sk-ant-…" />
          </Field>
        )}

        {provider === 'openai' && <>
          <Field label="OpenAI API Key">
            <input style={inp} type="password" value={config.openaiApiKey || ''} onChange={e => update('openaiApiKey', e.target.value)} />
          </Field>
          <Field label="Model">
            <input style={inp} value={config.openaiModel || 'gpt-4o'} onChange={e => update('openaiModel', e.target.value)} />
          </Field>
        </>}

        {provider === 'ollama' && <>
          <Field label="Ollama URL" hint="e.g. http://localhost:11434">
            <input style={inp} value={config.ollamaUrl || 'http://localhost:11434'} onChange={e => update('ollamaUrl', e.target.value)} />
          </Field>
          <Field label="Model">
            <input style={inp} value={config.ollamaModel || 'llama3.2'} onChange={e => update('ollamaModel', e.target.value)} />
          </Field>
        </>}

        {provider === 'openwebui' && <>
          <Field label="Open WebUI URL" hint="e.g. http://192.168.0.x:3000">
            <input style={inp} value={config.openwebUIUrl || ''} onChange={e => update('openwebUIUrl', e.target.value)} placeholder="http://192.168.0.x:3000" />
          </Field>
          <Field label="API Key" hint="Found in Open WebUI → Settings → Account">
            <input style={inp} type="password" value={config.openwebUIKey || ''} onChange={e => update('openwebUIKey', e.target.value)} placeholder="sk-…" />
          </Field>
          <Field label="Model">
            <input style={inp} value={config.openwebUIModel || ''} onChange={e => update('openwebUIModel', e.target.value)} placeholder="llama3.2" />
          </Field>
        </>}

        {provider === 'custom' && <>
          <Field label="Base URL" hint="OpenAI-compatible /v1 endpoint">
            <input style={inp} value={config.customAiUrl || ''} onChange={e => update('customAiUrl', e.target.value)} placeholder="http://host:port/v1" />
          </Field>
          <Field label="API Key" hint="Leave blank if not required">
            <input style={inp} type="password" value={config.customAiKey || ''} onChange={e => update('customAiKey', e.target.value)} />
          </Field>
          <Field label="Model">
            <input style={inp} value={config.customAiModel || ''} onChange={e => update('customAiModel', e.target.value)} placeholder="model-name" />
          </Field>
        </>}

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
          <button onClick={testAi} disabled={testingAi}
            style={btn({ background: 'rgba(255,255,255,0.06)', border: '1px solid var(--border)', color: 'var(--text-secondary)' })}>
            {testingAi ? '⏳ Testing…' : '🧪 Test AI Connection'}
          </button>
          {testResult && (
            <div style={{ fontSize: 12, padding: '6px 10px', borderRadius: 'var(--radius)',
              color: testResult.ok ? '#10b981' : '#ef4444',
              background: testResult.ok ? 'rgba(16,185,129,0.08)' : 'rgba(239,68,68,0.08)' }}>
              {testResult.ok ? `✅ ${testResult.message || 'Connected'}` : `❌ ${testResult.error || 'Failed'}`}
            </div>
          )}
        </div>
      </div>

      {/* === Ollama management section — only when provider=ollama === */}
      {provider === 'ollama' && <>
        <div style={card}>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 14 }}>🦙 Ollama Server</div>

          <div style={{ marginBottom: 14, padding: '12px 14px', background: 'rgba(255,255,255,0.04)', borderRadius: 'var(--radius)', border: '1px solid var(--border)' }}>
            <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 8 }}>Install Ollama directly on this server:</div>
            <button style={btn({ background: '#ff6600', color: 'white' })} onClick={installOllama} disabled={installing}>
              {installing ? '⏳ Installing…' : '⬇️ Install Ollama on Server'}
            </button>
            {installLog && (
              <pre style={{ marginTop: 10, padding: '10px 12px', background: 'rgba(0,0,0,0.3)', borderRadius: 'var(--radius)', fontSize: 11, color: '#10b981', maxHeight: 200, overflowY: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{installLog}</pre>
            )}
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <button style={btn({ background: 'var(--accent)', color: 'white' })} onClick={checkOllamaStatus}>↻ Check Connection</button>
          </div>

          {ollamaStatus && (
            <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8, fontSize: 13,
              color: ollamaStatus.ok ? '#10b981' : '#ef4444',
              background: ollamaStatus.ok ? 'rgba(16,185,129,0.08)' : 'rgba(239,68,68,0.08)',
              border: `1px solid ${ollamaStatus.ok ? 'rgba(16,185,129,0.2)' : 'rgba(239,68,68,0.2)'}`,
              borderRadius: 'var(--radius)', padding: '8px 12px' }}>
              {ollamaStatus.ok ? `✅ Connected — Ollama v${ollamaStatus.version}` : `❌ Not reachable: ${ollamaStatus.error}`}
            </div>
          )}
        </div>

        {ollamaStatus?.ok && (
          <div style={card}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <div style={{ fontWeight: 700, fontSize: 14 }}>📦 Installed Models</div>
              <button style={btn({ background: 'rgba(255,255,255,0.06)', border: '1px solid var(--border)', color: 'var(--text-secondary)', padding: '6px 12px' })} onClick={loadModels} disabled={loadingModels}>
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

        {ollamaStatus?.ok && (
          <div style={card}>
            <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 14 }}>⬇️ Pull a Model</div>

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
                  <div key={r.name} onClick={() => { setPullModelName(r.name); setSearchResults([]); }}
                    style={{ padding: '8px 12px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius)', cursor: 'pointer', border: '1px solid var(--border)', fontSize: 13 }}>
                    <div style={{ fontWeight: 600 }}>{r.name}</div>
                    {r.description && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{r.description}</div>}
                  </div>
                ))}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <input style={{ ...inp, flex: 1 }} value={pullModelName} onChange={e => setPullModelName(e.target.value)}
                placeholder="e.g. llama3.2, mistral, gemma2:9b" onKeyDown={e => e.key === 'Enter' && pullModelFn()} />
              <button style={btn({ background: '#10b981', color: 'white' })} onClick={() => pullModelFn()} disabled={pulling || !pullModelName.trim()}>
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
      </>}

    </div>
  );
}

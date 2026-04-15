import React, { useState, useEffect } from 'react';

const API = 'http://localhost:3001/api';
const AVATARS = ['👑','🧑','👩','👦','👧','🧒','🎮','🎬','🎵','🌟','🚀','🦁','🐯','🦊','🐧','🎭'];

export default function LoginScreen({ onLogin }) {
  const [mode, setMode]           = useState('checking'); // checking | setup | select | login
  const [users, setUsers]         = useState([]);
  const [selected, setSelected]   = useState(null);
  const [username, setUsername]   = useState('');
  const [password, setPassword]   = useState('');
  const [showPass, setShowPass]   = useState(false);
  const [error, setError]         = useState('');
  const [loading, setLoading]     = useState(false);

  // Setup wizard state
  const [setupStep, setSetupStep] = useState(1); // 1=welcome 2=credentials 3=avatar
  const [setupName, setSetupName] = useState('');
  const [setupPass, setSetupPass] = useState('');
  const [setupPass2, setSetupPass2] = useState('');
  const [setupAvatar, setSetupAvatar] = useState('👑');

  useEffect(() => {
    // Check if first run
    fetch(`${API}/setup/status`)
      .then(r => r.json())
      .then(d => {
        if (d.needsSetup) {
          setMode('setup');
        } else {
          fetch(`${API}/users`).then(r => r.json()).then(d => {
            setUsers(d.users || []);
            setMode(d.users?.length === 1 ? 'login' : 'select');
            if (d.users?.length === 1) setSelected(d.users[0]);
          });
        }
      })
      .catch(() => setMode('setup'));
  }, []);

  // ── First-run setup wizard ──────────────────────────────────────────────
  const handleSetupFinish = async () => {
    if (!setupName.trim()) { setError('Please enter a username'); return; }
    if (setupPass.length < 4) { setError('Password must be at least 4 characters'); return; }
    if (setupPass !== setupPass2) { setError('Passwords do not match'); return; }
    setLoading(true); setError('');
    try {
      const res = await fetch(`${API}/setup/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: setupName.trim(), password: setupPass }),
      });
      const data = await res.json();
      if (data.ok) {
        onLogin({ ...data.user, avatar: setupAvatar });
        // Save avatar
        await fetch(`${API}/users/${data.user.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ avatar: setupAvatar }),
        });
      } else {
        setError(data.error || 'Setup failed');
      }
    } catch (e) {
      setError('Cannot connect to Orion server. Make sure npm run server is running.');
    }
    setLoading(false);
  };

  // ── Login ───────────────────────────────────────────────────────────────
  const handleLogin = async () => {
    const name = selected?.name || username.trim();
    if (!name || !password) { setError('Enter username and password'); return; }
    setLoading(true); setError('');
    try {
      const res = await fetch(`${API}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, password }),
      });
      const data = await res.json();
      if (data.ok) { onLogin(data.user); }
      else { setError(data.error || 'Invalid username or password'); setPassword(''); }
    } catch (e) {
      setError('Cannot connect to server');
    }
    setLoading(false);
  };

  const inputStyle = {
    width: '100%', padding: '12px 14px',
    background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: 10, color: 'white', fontSize: 15, outline: 'none',
    fontFamily: 'inherit', transition: 'border-color 0.2s',
  };

  const btnPrimary = {
    width: '100%', padding: '13px', background: '#0063e5', color: 'white',
    border: 'none', borderRadius: 10, fontSize: 15, fontWeight: 700, cursor: 'pointer',
    transition: 'background 0.2s', marginTop: 8,
  };

  // ── CHECKING ──────────────────────────────────────────────────────────────
  if (mode === 'checking') return (
    <div style={wrapStyle}>
      <div style={{ width: 40, height: 40, border: '3px solid rgba(255,255,255,0.1)', borderTop: '3px solid #0063e5', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );

  // ── SETUP WIZARD ──────────────────────────────────────────────────────────
  if (mode === 'setup') return (
    <div style={wrapStyle}>
      <div style={{ width: '100%', maxWidth: 480, padding: '0 24px' }}>
        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: 16 }}>
          <img src="/logo.png" alt="Orion"
            style={{ width: 340, maxWidth: '90%', display: 'block', margin: '0 auto 0px', mixBlendMode: 'screen' }}
            onError={e => e.target.style.display='none'} />
          <div style={{ fontSize: 13, color: '#6b7180' }}>Let's set up your admin account</div>
        </div>

        {/* Step indicator */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 28 }}>
          {[1, 2, 3].map(n => (
            <React.Fragment key={n}>
              <div style={{ width: 28, height: 28, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, background: setupStep >= n ? '#0063e5' : 'rgba(255,255,255,0.08)', color: setupStep >= n ? 'white' : '#6b7180', transition: 'all 0.3s' }}>{n}</div>
              {n < 3 && <div style={{ width: 40, height: 2, background: setupStep > n ? '#0063e5' : 'rgba(255,255,255,0.08)', transition: 'all 0.3s' }} />}
            </React.Fragment>
          ))}
        </div>

        <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 16, padding: 28 }}>

          {/* Step 1 — Welcome */}
          {setupStep === 1 && (
            <div>
              <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Create Admin Account</div>
              <div style={{ fontSize: 14, color: '#a8acb3', lineHeight: 1.6, marginBottom: 24 }}>
                This is the master account for Orion. You'll use it to manage users, assign media access, and configure settings.<br/><br/>
                <span style={{ color: '#f59e0b' }}>⚠️ Store your password securely — there is no password reset.</span>
              </div>
              <button style={btnPrimary} onClick={() => setSetupStep(2)}>Get Started →</button>
            </div>
          )}

          {/* Step 2 — Credentials */}
          {setupStep === 2 && (
            <div>
              <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 20 }}>Choose your credentials</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7180', letterSpacing: 1, textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>Username</label>
                  <input style={inputStyle} value={setupName} onChange={e => { setSetupName(e.target.value); setError(''); }}
                    placeholder="e.g. Raymond" autoFocus autoComplete="username"
                    onFocus={e => e.target.style.borderColor = '#0063e5'}
                    onBlur={e => e.target.style.borderColor = 'rgba(255,255,255,0.12)'}
                    onKeyDown={e => e.key === 'Enter' && document.getElementById('setup-pass')?.focus()} />
                </div>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7180', letterSpacing: 1, textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>Password</label>
                  <div style={{ position: 'relative' }}>
                    <input id="setup-pass" style={inputStyle} type={showPass ? 'text' : 'password'} value={setupPass}
                      onChange={e => { setSetupPass(e.target.value); setError(''); }}
                      placeholder="Minimum 4 characters" autoComplete="new-password"
                      onFocus={e => e.target.style.borderColor = '#0063e5'}
                      onBlur={e => e.target.style.borderColor = 'rgba(255,255,255,0.12)'}
                      onKeyDown={e => e.key === 'Enter' && document.getElementById('setup-pass2')?.focus()} />
                    <button onClick={() => setShowPass(s => !s)} style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: '#6b7180', cursor: 'pointer', fontSize: 16 }}>{showPass ? '🙈' : '👁'}</button>
                  </div>
                </div>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7180', letterSpacing: 1, textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>Confirm Password</label>
                  <input id="setup-pass2" style={inputStyle} type={showPass ? 'text' : 'password'} value={setupPass2}
                    onChange={e => { setSetupPass2(e.target.value); setError(''); }}
                    placeholder="Repeat password" autoComplete="new-password"
                    onFocus={e => e.target.style.borderColor = '#0063e5'}
                    onBlur={e => e.target.style.borderColor = 'rgba(255,255,255,0.12)'}
                    onKeyDown={e => e.key === 'Enter' && setSetupStep(3)} />
                </div>
              </div>
              {error && <div style={{ marginTop: 10, fontSize: 13, color: '#f87171' }}>{error}</div>}
              <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
                <button style={{ ...btnPrimary, background: 'rgba(255,255,255,0.08)', marginTop: 0 }} onClick={() => setSetupStep(1)}>← Back</button>
                <button style={{ ...btnPrimary, marginTop: 0 }} onClick={() => {
                  if (!setupName.trim()) { setError('Enter a username'); return; }
                  if (setupPass.length < 4) { setError('Password must be at least 4 characters'); return; }
                  if (setupPass !== setupPass2) { setError('Passwords do not match'); return; }
                  setError(''); setSetupStep(3);
                }}>Next →</button>
              </div>
            </div>
          )}

          {/* Step 3 — Avatar */}
          {setupStep === 3 && (
            <div>
              <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>Choose an avatar</div>
              <div style={{ fontSize: 13, color: '#6b7180', marginBottom: 18 }}>This appears on the login screen</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 20 }}>
                {AVATARS.map(a => (
                  <button key={a} onClick={() => setSetupAvatar(a)}
                    style={{ width: 48, height: 48, fontSize: 24, borderRadius: 10, cursor: 'pointer', background: setupAvatar === a ? 'rgba(0,99,229,0.25)' : 'rgba(255,255,255,0.05)', border: `2px solid ${setupAvatar === a ? '#0063e5' : 'transparent'}`, transition: 'all 0.15s' }}>
                    {a}
                  </button>
                ))}
              </div>
              {/* Preview */}
              <div style={{ textAlign: 'center', padding: '16px 0', borderTop: '1px solid rgba(255,255,255,0.06)', marginBottom: 16 }}>
                <div style={{ width: 64, height: 64, borderRadius: '50%', background: 'linear-gradient(135deg,#1a1a3e,#2d1b69)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 30, margin: '0 auto 8px' }}>{setupAvatar}</div>
                <div style={{ fontWeight: 700, fontSize: 16 }}>{setupName}</div>
                <div style={{ fontSize: 11, color: '#f59e0b', marginTop: 2 }}>ADMIN</div>
              </div>
              {error && <div style={{ marginTop: 10, fontSize: 13, color: '#f87171', marginBottom: 8 }}>{error}</div>}
              <div style={{ display: 'flex', gap: 10 }}>
                <button style={{ ...btnPrimary, background: 'rgba(255,255,255,0.08)', marginTop: 0 }} onClick={() => setSetupStep(2)}>← Back</button>
                <button style={{ ...btnPrimary, marginTop: 0, background: loading ? '#147fcd' : '#0063e5' }} onClick={handleSetupFinish} disabled={loading}>
                  {loading ? 'Creating account...' : '✓ Finish Setup'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  // ── USER SELECT (multiple users) ──────────────────────────────────────────
  if (mode === 'select' && !selected) return (
    <div style={wrapStyle}>
      <div style={{ textAlign: 'center', marginBottom: 36 }}>
        <img src="/logo.png" alt="Orion"
          style={{ width: 280, maxWidth: '80%', display: 'block', margin: '0 auto 16px', mixBlendMode: 'screen' }}
          onError={e => e.target.style.display = 'none'} />
        <div style={{ fontSize: 20, fontWeight: 700, color: 'white' }}>Who's watching?</div>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, justifyContent: 'center', maxWidth: 600, padding: '0 24px' }}>
        {users.map(user => (
          <div key={user.id} onClick={() => setSelected(user)}
            style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, cursor: 'pointer', padding: '20px 24px', borderRadius: 14, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', transition: 'all 0.2s', minWidth: 110 }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(0,99,229,0.18)'; e.currentTarget.style.borderColor = 'rgba(0,99,229,0.4)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)'; }}>
            <div style={{ width: 68, height: 68, borderRadius: '50%', background: 'linear-gradient(135deg,#1a1a3e,#2d1b69)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 30, border: '2px solid rgba(255,255,255,0.1)' }}>
              {user.avatar || '👤'}
            </div>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'white' }}>{user.name}</div>
            {user.role === 'admin' && <div style={{ fontSize: 9, color: '#f59e0b', fontWeight: 700, letterSpacing: 1 }}>ADMIN</div>}
          </div>
        ))}
      </div>
    </div>
  );

  // ── LOGIN FORM ────────────────────────────────────────────────────────────
  return (
    <div style={wrapStyle}>
      <div style={{ width: '100%', maxWidth: 380, padding: '0 24px' }}>
        {/* Avatar */}
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          {selected ? (
            <>
              <div style={{ width: 72, height: 72, borderRadius: '50%', background: 'linear-gradient(135deg,#1a1a3e,#2d1b69)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 32, margin: '0 auto 10px', border: '2px solid rgba(255,255,255,0.12)' }}>
                {selected.avatar || '👤'}
              </div>
              <div style={{ fontSize: 20, fontWeight: 700, color: 'white' }}>{selected.name}</div>
            </>
          ) : (
            <>
              <img src="/logo.png" alt="Orion"
                style={{ width: 260, maxWidth: '80%', display: 'block', margin: '0 auto 4px', mixBlendMode: 'screen' }}
                onError={e => e.target.style.display = 'none'} />
            </>
          )}
        </div>

        <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 16, padding: 24 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {!selected && (
              <div>
                <label style={{ fontSize: 11, fontWeight: 700, color: '#6b7180', letterSpacing: 1, textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>Username</label>
                <input style={inputStyle} value={username} onChange={e => { setUsername(e.target.value); setError(''); }}
                  placeholder="Your username" autoFocus autoComplete="username"
                  onFocus={e => e.target.style.borderColor = '#0063e5'}
                  onBlur={e => e.target.style.borderColor = 'rgba(255,255,255,0.12)'}
                  onKeyDown={e => e.key === 'Enter' && document.getElementById('login-pass')?.focus()} />
              </div>
            )}
            <div>
              <label style={{ fontSize: 11, fontWeight: 700, color: '#6b7180', letterSpacing: 1, textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>Password</label>
              <div style={{ position: 'relative' }}>
                <input id="login-pass" style={inputStyle} type={showPass ? 'text' : 'password'}
                  value={password} onChange={e => { setPassword(e.target.value); setError(''); }}
                  placeholder="Enter password" autoFocus={!!selected} autoComplete="current-password"
                  onFocus={e => e.target.style.borderColor = '#0063e5'}
                  onBlur={e => e.target.style.borderColor = 'rgba(255,255,255,0.12)'}
                  onKeyDown={e => e.key === 'Enter' && handleLogin()} />
                <button onClick={() => setShowPass(s => !s)} style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: '#6b7180', cursor: 'pointer', fontSize: 16 }}>{showPass ? '🙈' : '👁'}</button>
              </div>
            </div>
          </div>

          {error && <div style={{ marginTop: 12, fontSize: 13, color: '#f87171' }}>{error}</div>}

          <button style={{ ...btnPrimary, background: loading ? '#147fcd' : '#0063e5' }} onClick={handleLogin} disabled={loading}>
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </div>

        {/* Back to user select */}
        {(selected || mode === 'select') && users.length > 1 && (
          <button onClick={() => { setSelected(null); setPassword(''); setError(''); }}
            style={{ display: 'block', margin: '14px auto 0', background: 'none', border: 'none', color: '#6b7180', cursor: 'pointer', fontSize: 13 }}>
            ← Switch User
          </button>
        )}
      </div>
    </div>
  );
}

const wrapStyle = {
  position: 'fixed', inset: 0, zIndex: 9999,
  background: 'radial-gradient(ellipse at 50% 40%, #0d1a3a 0%, #040714 70%)',
  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
  fontFamily: "'Segoe UI', Arial, sans-serif",
};

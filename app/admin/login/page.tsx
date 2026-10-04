'use client';

import { useState } from 'react';

export default function AdminLogin() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const res = await fetch('/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      const next = new URLSearchParams(window.location.search).get('next');
      window.location.href = next && next.startsWith('/admin') ? next : '/admin';
      return;
    }
    setError(data.error || 'Sign-in failed.');
    setBusy(false);
  }

  return (
    <main className="login-shell">
      <form className="login-card" onSubmit={submit}>
        <div className="brand">
          Spark<span>WA</span>
        </div>
        <p className="muted">Admin sign-in</p>
        <label htmlFor="password">Password</label>
        <input id="password" type="password" autoFocus autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} />
        {error && <div className="login-error">{error}</div>}
        <button className="primary" disabled={busy || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}

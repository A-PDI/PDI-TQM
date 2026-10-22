import { useState } from 'react';
import { ApiError, api } from '../api';
import { useAuth } from '../auth';
import logoUrl from '../assets/pdi-logo.png';

export function Login() {
  const { refresh } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 16 }}>
      <form
        className="card"
        style={{ width: 'min(380px, 100%)' }}
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await api('/api/auth/login', { body: { email, password } });
            await refresh();
          } catch (err) {
            setError(err instanceof ApiError ? err.message : 'Sign-in failed');
          } finally {
            setBusy(false);
          }
        }}
      >
        <div style={{ background: 'var(--navy)', color: '#fff', margin: '-14px -16px 16px', padding: '16px', borderRadius: '8px 8px 0 0' }}>
          <div className="brand-title">
            <img className="brand-logo" src={logoUrl} alt="PDI" />
            <div>
              <strong style={{ fontSize: 18 }}>TQM</strong>
              <div className="small" style={{ color: '#c9d1e0' }}>
                Total Quality Management
              </div>
            </div>
          </div>
        </div>
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {error && (
          <div className="notice notice-error" role="alert">
            {error}
          </div>
        )}
        <button type="submit" className="btn btn-primary" style={{ width: '100%' }} disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

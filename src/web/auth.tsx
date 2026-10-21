import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Capability } from '../shared/capabilities';
import { ApiError, api, setCsrfToken } from './api';

export interface Me {
  user: { id: string; email: string; displayName: string };
  capabilities: Capability[];
  csrfToken: string;
  environment: string;
  displayTimeZone: string;
}

interface AuthState {
  me: Me | null;
  loading: boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
  can: (cap: Capability) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const data = await api<Me>('/api/auth/me');
      setCsrfToken(data.csrfToken);
      setMe(data);
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 401) console.error(err);
      setCsrfToken(null);
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onSignedOut = () => {
      setCsrfToken(null);
      setMe(null);
    };
    window.addEventListener('tqms:signed-out', onSignedOut);
    return () => window.removeEventListener('tqms:signed-out', onSignedOut);
  }, [refresh]);

  const signOut = useCallback(async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } finally {
      setCsrfToken(null);
      setMe(null);
    }
  }, []);

  const can = useCallback((cap: Capability) => Boolean(me?.capabilities.includes(cap)), [me]);

  return <AuthContext.Provider value={{ me, loading, refresh, signOut, can }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}

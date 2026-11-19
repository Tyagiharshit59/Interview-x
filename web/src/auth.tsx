import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { get, post } from './api';

export interface Me {
  user: { id: string; email: string; name: string; isSuperAdmin: boolean; emailVerified: boolean; mfaEnabled: boolean };
  memberships: Array<{ company_id: string; company_name: string; role: string }>;
  role: string | null; permissions: string[];
  company: { id: string; name: string; slug: string; settings: Record<string, any> } | null;
}
interface Ctx { me: Me | null; loading: boolean; refresh: () => Promise<void>; setMe: (m: Me | null) => void; logout: () => Promise<void>; can: (p: string) => boolean }
const C = createContext<Ctx>(null as any);
export const useAuth = () => useContext(C);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try { setMe(await get('/auth/me')); } catch { setMe(null); } finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { const h = () => setMe(null); window.addEventListener('ivx:unauthenticated', h); return () => window.removeEventListener('ivx:unauthenticated', h); }, []);
  const logout = async () => { await post('/auth/logout'); setMe(null); };
  const can = (p: string) => !!me?.permissions.includes(p);
  return <C.Provider value={{ me, loading, refresh, setMe, logout, can }}>{children}</C.Provider>;
}

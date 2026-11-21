'use client';
import { api, ApiError, setToken } from '@/lib/api';
import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';

/** What GET /api/auth/me returns. */
interface MeResponse {
  staffId: string;
  name: string;
  role: string;
  siteId: string | null;
  permissions: string[];
}

export interface AuthUser {
  /** The server's role, lower-case and hyphenated: 'head-office', 'manager', ... */
  role: string;
  roleLabel: string;
  name: string;
  email: string;
  initials: string;
  scope: string;
  scopeDetail: string;
  /** The site this user is restricted to. null = head office (sees all sites) */
  assignedSite: string | null;
  /** Who is signed in, for defaults such as the witness to a cash drop. */
  staffId?: string;
}

interface AuthContextValue {
  user: AuthUser | null;
  login: (user: AuthUser) => void;
  logout: () => void;
  /** true when logged-in user is a site manager (not head office) */
  isSiteManager: boolean;
  /** The site name this user is locked to, or null for head office */
  assignedSite: string | null;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  login: () => {},
  logout: () => {},
  isSiteManager: false,
  assignedSite: null,
});

const STORAGE_KEY = 'forecourt_auth_user';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);

  // Restore, then VERIFY. The browser's copy is shown at once so the screen
  // does not flash, but it can be stale: the session may have been revoked
  // (Revoke on the Users screen, or an administrator ending it), or the role
  // may have changed since sign-in. It used to be trusted as-is, so a revoked
  // user kept the app open until some action failed, and a demoted one kept
  // seeing screens for their old role. The server's answer now wins.
  useEffect(() => {
    let stored: AuthUser | null = null;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) stored = JSON.parse(raw) as AuthUser;
    } catch {
      // ignore
    }
    if (!stored) return;
    setUser(stored);
    const base = stored;
    void api
      .get<MeResponse>('/api/auth/me')
      .then((me) => {
        const wide = ['DIRECTOR', 'SYSTEM_ADMIN', 'HEAD_OFFICE'].includes(me.role);
        const fresh: AuthUser = {
          ...base,
          role: me.role.toLowerCase().replace('_', '-'),
          roleLabel: me.role.replace('_', ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()),
          name: me.name,
          scope: wide ? 'All sites' : 'This site',
          scopeDetail: me.permissions.length + ' permissions',
          assignedSite: wide ? null : me.siteId,
          staffId: me.staffId,
        };
        setUser(fresh);
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(fresh));
        } catch {
          // ignore
        }
      })
      .catch((e) => {
        // Only a refusal ends the session. A network failure keeps what we
        // have -- a forecourt with patchy signal must not sign people out.
        if (e instanceof ApiError && e.status === 401) {
          setUser(null);
          setToken(null);
          try {
            localStorage.removeItem(STORAGE_KEY);
          } catch {
            // ignore
          }
        }
      });
  }, []);

  const login = (authUser: AuthUser) => {
    setUser(authUser);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(authUser));
    } catch {
      // ignore
    }
  };

  /**
   * Sign out properly.
   *
   * This cleared the remembered user and nothing else: the TOKEN stayed in
   * sessionStorage, and the server session stayed valid until it expired on
   * its own. On a shared forecourt machine that means the next person at the
   * keyboard could still be carrying the last person's session.
   *
   * The server call is best-effort and its failure is ignored -- what must not
   * fail is the local clearing, so a lost network never leaves somebody signed
   * in on a machine they walked away from.
   */
  const logout = () => {
    void api.post<unknown>('/api/auth/logout', {}).catch(() => undefined);
    setUser(null);
    setToken(null);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  };

  // Scoped to one site unless the role runs the company or the platform.
  const isSiteManager = !!user && !['head-office', 'system-admin', 'director'].includes(user.role);
  const assignedSite = user?.assignedSite ?? null;

  return (
    <AuthContext.Provider value={{ user, login, logout, isSiteManager, assignedSite }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}

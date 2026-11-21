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
  /** The NAME of the site this user is restricted to -- what rows carry in
   *  their `site` and what is shown. null = head office (sees all sites), or a
   *  station whose name is still being looked up. */
  assignedSite: string | null;
  /** That site's id, for calls to the API. */
  assignedSiteId?: string | null;
  /** Who is signed in, for defaults such as the witness to a cash drop. */
  staffId?: string;
}

// Sign-in and /api/auth/me give a site's id. Every screen compares and shows
// its NAME (rows carry `site: "Kiboga Station"`), so a station user's lists
// were filtered against an id and came out empty on ten screens, and the
// sidebar read "<uuid> only". (Audit Nov 2026, W1.) The name is looked up here.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function normalise(u: AuthUser): AuthUser {
  // A session saved before the fix holds the id in assignedSite.
  if (u.assignedSite && UUID.test(u.assignedSite)) return { ...u, assignedSiteId: u.assignedSite, assignedSite: null };
  return u;
}

interface AuthContextValue {
  user: AuthUser | null;
  login: (user: AuthUser) => void;
  logout: () => void;
  /** true when logged-in user is a site manager (not head office) */
  isSiteManager: boolean;
  /** The site name this user is locked to, or null for head office */
  assignedSite: string | null;
  /** That site's id, for calls to the API. */
  assignedSiteId: string | null;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  login: () => {},
  logout: () => {},
  isSiteManager: false,
  assignedSite: null,
  assignedSiteId: null,
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
    stored = normalise(stored);
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
          assignedSiteId: wide ? null : me.siteId,
          // keep the name already looked up while the station is the same
          assignedSite: wide ? null : (base.assignedSiteId === me.siteId ? base.assignedSite : null),
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

  // The station's name, once its id is known (W1).
  useEffect(() => {
    const id = user?.assignedSiteId;
    if (!id || user?.assignedSite) return;
    let cancelled = false;
    void api
      .get<{ sites: { id: string; name: string }[] }>('/api/v1/dashboard/overview')
      .then((o) => {
        const name = o.sites.find((s) => s.id === id)?.name;
        if (cancelled || !name) return;
        setUser((u) => {
          if (!u || u.assignedSiteId !== id) return u;
          const next = { ...u, assignedSite: name };
          try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
          } catch {
            // ignore
          }
          return next;
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [user?.assignedSiteId, user?.assignedSite]);

  const login = (raw: AuthUser) => {
    const authUser = normalise(raw);
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
  const assignedSiteId = user?.assignedSiteId ?? null;

  return (
    <AuthContext.Provider value={{ user, login, logout, isSiteManager, assignedSite, assignedSiteId }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}

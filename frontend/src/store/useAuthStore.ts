import { create } from 'zustand';
import { API_BASE, J, jfetch, setAuthHandlers } from '../api/http';

/** The five permissioned sections of the platform (mirrors the backend). */
export type Section = 'texts' | 'workspace' | 'translate' | 'phonetics' | 'documents';
export type PermLevel = 'none' | 'read' | 'modify';

export interface OrgAccess {
  id: number;
  name: string;
  can_manage_org: boolean;
  perms: Record<Section, PermLevel>;
  /** Role names held in this org (display only; perms are the server-computed max). */
  roles: string[];
}

export interface AuthUser {
  id: number;
  email: string;
  display_name: string;
  is_superuser: boolean;
  has_password: boolean;
  has_google: boolean;
}

interface MePayload {
  user: AuthUser;
  orgs: OrgAccess[];
}

const ORG_KEY = 'sapche.activeOrgId';

interface AuthState {
  status: 'booting' | 'unauthenticated' | 'authenticated';
  user: AuthUser | null;
  orgs: OrgAccess[];
  activeOrgId: number | null;
  /** First-run: no accounts exist yet — the login screen offers "create admin". */
  bootstrapNeeded: boolean;
  /** Last 403 detail, for a transient notice. Cleared by the UI. */
  permissionNotice: string | null;

  boot: () => Promise<void>;
  /** Re-fetch /auth/me after a profile edit or a Google link. */
  refreshMe: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  loginGoogle: (credential: string, inviteToken?: string) => Promise<void>;
  createFirstAdmin: (email: string, password: string, displayName: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Persists the choice and HARD-RELOADS: every store is org-scoped, and a fresh
   *  boot is the one reset that cannot miss any of them. */
  switchOrg: (orgId: number) => void;
  clearPermissionNotice: () => void;
}

function pickOrg(orgs: OrgAccess[]): number | null {
  const stored = Number(localStorage.getItem(ORG_KEY));
  if (orgs.some(o => o.id === stored)) return stored;
  return orgs[0]?.id ?? null;
}

function applyMe(payload: MePayload): Partial<AuthState> {
  const activeOrgId = pickOrg(payload.orgs);
  if (activeOrgId != null) localStorage.setItem(ORG_KEY, String(activeOrgId));
  return {
    status: 'authenticated', user: payload.user, orgs: payload.orgs,
    activeOrgId, bootstrapNeeded: false,
  };
}

export const useAuthStore = create<AuthState>((set, get) => ({
  status: 'booting',
  user: null,
  orgs: [],
  activeOrgId: null,
  bootstrapNeeded: false,
  permissionNotice: null,

  boot: async () => {
    try {
      set(applyMe(await jfetch<MePayload>(`${API_BASE}/auth/me`)));
    } catch {
      let bootstrapNeeded = false;
      try {
        const r = await jfetch<{ bootstrap_needed: boolean }>(
          `${API_BASE}/auth/bootstrap-needed`);
        bootstrapNeeded = r.bootstrap_needed;
      } catch { /* backend down — the login screen will say so on submit */ }
      set({ status: 'unauthenticated', user: null, orgs: [], activeOrgId: null,
            bootstrapNeeded });
    }
  },

  refreshMe: async () => {
    set(applyMe(await jfetch<MePayload>(`${API_BASE}/auth/me`)));
  },

  login: async (email, password) => {
    const payload = await jfetch<MePayload>(`${API_BASE}/auth/login`, {
      method: 'POST', headers: J, body: JSON.stringify({ email, password }),
    });
    set(applyMe(payload));
  },

  loginGoogle: async (credential, inviteToken) => {
    const payload = await jfetch<MePayload>(`${API_BASE}/auth/google`, {
      method: 'POST', headers: J,
      body: JSON.stringify({ credential, invite_token: inviteToken ?? null }),
    });
    set(applyMe(payload));
  },

  createFirstAdmin: async (email, password, displayName) => {
    const payload = await jfetch<MePayload>(`${API_BASE}/auth/bootstrap`, {
      method: 'POST', headers: J,
      body: JSON.stringify({ email, password, display_name: displayName }),
    });
    set(applyMe(payload));
  },

  logout: async () => {
    try {
      await jfetch(`${API_BASE}/auth/logout`, { method: 'POST' });
    } catch { /* cookie may already be dead — still drop local state */ }
    set({ status: 'unauthenticated', user: null, orgs: [], activeOrgId: null });
  },

  switchOrg: (orgId) => {
    if (orgId === get().activeOrgId) return;
    localStorage.setItem(ORG_KEY, String(orgId));
    window.location.assign('/');
  },

  clearPermissionNotice: () => set({ permissionNotice: null }),
}));

// The fetch layer calls back into auth state without importing this module.
setAuthHandlers({
  getOrgId: () => useAuthStore.getState().activeOrgId,
  onUnauthorized: () => {
    const s = useAuthStore.getState();
    if (s.status === 'authenticated') {
      useAuthStore.setState({ status: 'unauthenticated', user: null, orgs: [],
                              activeOrgId: null });
    }
  },
  onForbidden: (detail) => {
    let msg = 'You do not have permission for that action.';
    try {
      const parsed = JSON.parse(detail);
      if (parsed?.detail) msg = String(parsed.detail);
    } catch { /* non-JSON detail — keep the generic message */ }
    useAuthStore.setState({ permissionNotice: msg });
  },
});

/** The active org's access row (null while unauthenticated). */
export function activeOrg(state: AuthState): OrgAccess | null {
  return state.orgs.find(o => o.id === state.activeOrgId) ?? null;
}

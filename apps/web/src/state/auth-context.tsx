/**
 * Authentication state.
 *
 * The session is owned by the server: the only source of truth is a successful
 * `GET /auth/me`. The client never fabricates a user, never caches a token in
 * local storage, and never treats an unverified email as a usable account.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import {
  ROLE_PERMISSIONS,
  type AuthSessionDTO,
  type OrganizationDTO,
  type Permission,
  type UserDTO,
} from '@zyvano/shared';

import { ApiError, setActiveOrganizationId, setSessionExpiredHandler } from '../lib/api-client';
import { authApi, type RegisterPayload } from '../lib/api';

const ACTIVE_ORG_KEY = 'zyvano.activeOrganization';

interface AuthContextValue {
  user: UserDTO | null;
  organizations: OrganizationDTO[];
  activeOrganization: OrganizationDTO | null;
  csrfToken: string | null;
  expiresAt: string | null;
  /** True until the initial session probe completes. */
  initializing: boolean;
  /** True once the server confirmed there is no usable session. */
  authenticated: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (payload: RegisterPayload) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  switchOrganization: (organizationId: string) => void;
  /** Applies a session payload returned by a mutating auth endpoint. */
  applySession: (session: AuthSessionDTO) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function readStoredOrganization(): string | null {
  try {
    return window.localStorage.getItem(ACTIVE_ORG_KEY);
  } catch {
    return null;
  }
}

function storeOrganization(id: string | null): void {
  try {
    if (id) window.localStorage.setItem(ACTIVE_ORG_KEY, id);
    else window.localStorage.removeItem(ACTIVE_ORG_KEY);
  } catch {
    // Storage can be unavailable (private mode); the selection is a convenience,
    // never a security boundary, so failing to persist it is harmless.
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserDTO | null>(null);
  const [organizations, setOrganizations] = useState<OrganizationDTO[]>([]);
  const [csrfToken, setCsrfToken] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [activeOrganizationId, setActiveOrgState] = useState<string | null>(readStoredOrganization());
  const [initializing, setInitializing] = useState(true);

  const applySession = useCallback((session: AuthSessionDTO) => {
    setUser(session.user);
    setOrganizations(session.organizations);
    setCsrfToken(session.csrfToken);
    setExpiresAt(session.expiresAt);

    // Keep the selected organization valid: if the stored id is not among the
    // caller's memberships (revoked, or another account signed in) fall back to
    // the first membership rather than sending a stale tenant header.
    const stored = readStoredOrganization();
    const stillMember = stored && session.organizations.some((org) => org.id === stored);
    const next = stillMember ? stored : (session.organizations[0]?.id ?? null);
    storeOrganization(next);
    setActiveOrgState(next);
    setActiveOrganizationId(next);
  }, []);

  const clearSession = useCallback(() => {
    setUser(null);
    setOrganizations([]);
    setCsrfToken(null);
    setExpiresAt(null);
    // The organization preference survives a logout so the same operator returns
    // to the workspace they were using.
    setActiveOrganizationId(null);
  }, []);

  const refresh = useCallback(async () => {
    try {
      applySession(await authApi.me());
    } catch (error) {
      if (error instanceof ApiError && error.isAuthenticationRequired()) {
        clearSession();
        return;
      }
      // A transport or infrastructure failure must not sign the user out: keep
      // whatever state we have and let individual screens surface the error.
      if (!(error instanceof ApiError)) throw error;
    }
  }, [applySession, clearSession]);

  // A 401 from any request clears the local session; the router then sends the
  // user to sign-in with a return path instead of showing an error screen.
  useEffect(() => {
    setSessionExpiredHandler(() => clearSession());
    setActiveOrganizationId(activeOrganizationId);
    return () => setSessionExpiredHandler(null);
    // Intentionally keyed on the organization id only: the handler identity is stable.
  }, [clearSession, activeOrganizationId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const session = await authApi.me();
        if (!cancelled) applySession(session);
      } catch (error) {
        if (!cancelled && error instanceof ApiError && error.isAuthenticationRequired()) {
          clearSession();
        }
      } finally {
        if (!cancelled) setInitializing(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applySession, clearSession]);

  const login = useCallback(
    async (email: string, password: string) => {
      applySession(await authApi.login({ email, password }));
    },
    [applySession],
  );

  const register = useCallback(
    async (payload: RegisterPayload) => {
      applySession(await authApi.register(payload));
    },
    [applySession],
  );

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } finally {
      clearSession();
    }
  }, [clearSession]);

  const switchOrganization = useCallback(
    (organizationId: string) => {
      storeOrganization(organizationId);
      setActiveOrgState(organizationId);
      setActiveOrganizationId(organizationId);
    },
    [],
  );

  const activeOrganization = useMemo(
    () => organizations.find((org) => org.id === activeOrganizationId) ?? organizations[0] ?? null,
    [organizations, activeOrganizationId],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      organizations,
      activeOrganization,
      csrfToken,
      expiresAt,
      initializing,
      authenticated: user !== null,
      login,
      register,
      logout,
      refresh,
      switchOrganization,
      applySession,
    }),
    [
      user,
      organizations,
      activeOrganization,
      csrfToken,
      expiresAt,
      initializing,
      login,
      register,
      logout,
      refresh,
      switchOrganization,
      applySession,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside an AuthProvider.');
  return context;
}

/**
 * The permission set of the caller inside the active organization.
 *
 * Derived from the shared `ROLE_PERMISSIONS` table rather than re-listing roles
 * here, so the client can never drift from the server's grant matrix. This drives
 * what the UI offers; it is never a security control — every endpoint authorizes
 * independently and a forged client would simply receive a 403.
 */
export function usePermissions() {
  const { activeOrganization } = useAuth();

  return useMemo(() => {
    const role = activeOrganization?.role ?? null;
    const granted = role ? ROLE_PERMISSIONS[role] : [];
    const can = (permission: Permission) => granted.includes(permission);

    return {
      role,
      can,
      canEdit: can('project:update'),
      canDeleteProject: can('project:delete'),
      canGenerate: can('generation:create'),
      canCancelGeneration: can('generation:cancel'),
      canUpload: can('asset:upload'),
      canDelete: can('asset:delete'),
      canExport: can('export:create'),
      canManageMembers: can('org:manage_members'),
      canDeleteOrganization: can('org:delete'),
      canReadAudit: can('audit:read'),
      canReadUsage: can('usage:read'),
      canManageProjects: can('project:create'),
    };
  }, [activeOrganization]);
}

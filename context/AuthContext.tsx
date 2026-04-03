import React from 'react';
import type { User } from 'firebase/auth';
import { onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import { getFirebaseAuth } from '../utils/firebase';
import { setAuthTokenProvider } from '../api/client';
import { fetchMyPermissions, type RbacSnapshot } from '../api/client';
import { useSessionTracking } from '../hooks/useSessionTracking';

type AuthContextValue = {
  user: User | null;
  loading: boolean;
  initError: string | null;
  isAdmin: boolean;
  rbac: RbacSnapshot | null;
  hasPermission: (moduleName: string, action: string) => boolean;
  signInWithEmailPassword: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = React.createContext<AuthContextValue | null>(null);

const ALLOWED_DOMAIN = 'trendocean.de';
const BOOTSTRAP_ADMIN_EMAIL = 'admin@trendocean.de';
const AUTH_MIGRATION_KEY = 'avystock:auth:migrated:v1';

const isAllowedEmail = (email?: string | null) => {
  const value = String(email || '').trim().toLowerCase();
  return value.endsWith(`@${ALLOWED_DOMAIN}`);
};

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = React.useState<User | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [rbac, setRbac] = React.useState<RbacSnapshot | null>(null);
  const [initError, setInitError] = React.useState<string | null>(null);

  const [auth, setAuth] = React.useState<ReturnType<typeof getFirebaseAuth> | null>(null);

  React.useEffect(() => {
    try {
      const instance = getFirebaseAuth();
      setAuth(instance);
      setInitError(null);
    } catch (e: any) {
      console.error('Firebase auth init failed:', e);
      setAuth(null);
      setUser(null);
      setRbac(null);
      setInitError(e?.message || 'Firebase auth init failed.');
      setLoading(false);
    }
  }, []);

  // One-time migration: if older builds left a persisted session, force a clean re-login after rollout.
  // This ensures the login screen shows up immediately after deploying the auth changes.
  React.useEffect(() => {
    if (!auth) return;
    try {
      const already = window.localStorage.getItem(AUTH_MIGRATION_KEY) === '1';
      if (!already) {
        window.localStorage.setItem(AUTH_MIGRATION_KEY, '1');
        signOut(auth).catch(() => {});
      }
    } catch {
      // ignore storage errors
    }
  }, [auth]);

  React.useEffect(() => {
    if (!auth) return;
    const unsub = onAuthStateChanged(auth, async (u) => {
      setUser(u);
      setLoading(false);
    });
    return () => unsub();
  }, [auth]);

  React.useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!auth?.currentUser) {
        setRbac(null);
        return;
      }
      try {
        const snapshot = await fetchMyPermissions();
        if (!cancelled) {
          setRbac(snapshot);
        }
      } catch {
        if (!cancelled) {
          setRbac({ roles: [], permissions: {}, profile: null });
        }
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [auth, user?.uid]);

  React.useEffect(() => {
    if (!auth) return;
    // Wire token provider for backend calls.
    // Use auth.currentUser to avoid transient "null provider" windows between state updates.
    setAuthTokenProvider(async (forceRefresh?: boolean) => {
      const current = auth.currentUser;
      if (!current) return null;
      try {
        return await current.getIdToken(Boolean(forceRefresh));
      } catch (error) {
        // Retry once with forced refresh if the first attempt fails.
        if (!forceRefresh) {
          return await current.getIdToken(true);
        }
        throw error;
      }
    });
    return () => setAuthTokenProvider(null);
  }, [auth]);

  const signInWithEmailPassword = React.useCallback(
    async (email: string, password: string) => {
      if (!auth) {
        throw new Error(initError || 'Auth is not configured.');
      }
      const normalized = String(email || '').trim().toLowerCase();
      if (!isAllowedEmail(normalized)) {
        throw new Error(`Nur @${ALLOWED_DOMAIN} E-Mail-Adressen sind erlaubt.`);
      }
      await signInWithEmailAndPassword(auth, normalized, password);
    },
    [auth, initError]
  );

  const { endCurrentSession } = useSessionTracking(user);

  const logout = React.useCallback(async () => {
    if (!auth) return;
    await endCurrentSession();
    await signOut(auth);
  }, [auth, endCurrentSession]);

  const isAdmin = Boolean(user?.email && String(user.email).toLowerCase() === BOOTSTRAP_ADMIN_EMAIL);

  const hasPermission = React.useCallback(
    (moduleName: string, action: string) => {
      if (isAdmin) return true;
      const mod = String(moduleName || '').trim();
      const act = String(action || '').trim();
      if (!mod || !act) return false;
      const perms = rbac?.permissions || {};
      if (perms?.['*']?.['*'] === true) return true;
      const modPerm = perms[mod] || perms['*'] || null;
      if (!modPerm) return false;
      if (modPerm['*'] === true) return true;
      return modPerm[act] === true;
    },
    [rbac?.permissions, isAdmin]
  );

  const value: AuthContextValue = React.useMemo(
    () => ({
      user,
      loading,
      initError,
      isAdmin,
      rbac,
      hasPermission,
      signInWithEmailPassword,
      logout,
    }),
    [user, loading, initError, isAdmin, rbac, hasPermission, signInWithEmailPassword, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = () => {
  const ctx = React.useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within <AuthProvider>');
  }
  return ctx;
};


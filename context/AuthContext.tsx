import React from 'react';
import type { User } from 'firebase/auth';
import { onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import { getFirebaseAuth } from '../utils/firebase';
import { setAuthTokenProvider } from '../api/client';

type AuthContextValue = {
  user: User | null;
  loading: boolean;
  isAdmin: boolean;
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

  const auth = React.useMemo(() => getFirebaseAuth(), []);

  // One-time migration: if older builds left a persisted session, force a clean re-login after rollout.
  // This ensures the login screen shows up immediately after deploying the auth changes.
  React.useEffect(() => {
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
    const unsub = onAuthStateChanged(auth, async (u) => {
      setUser(u);
      setLoading(false);
    });
    return () => unsub();
  }, [auth]);

  React.useEffect(() => {
    // Wire token provider for backend calls.
    setAuthTokenProvider(async () => {
      if (!user) return null;
      return await user.getIdToken();
    });
    return () => setAuthTokenProvider(null);
  }, [user]);

  const signInWithEmailPassword = React.useCallback(
    async (email: string, password: string) => {
      const normalized = String(email || '').trim().toLowerCase();
      if (!isAllowedEmail(normalized)) {
        throw new Error(`Nur @${ALLOWED_DOMAIN} E-Mail-Adressen sind erlaubt.`);
      }
      await signInWithEmailAndPassword(auth, normalized, password);
    },
    [auth]
  );

  const logout = React.useCallback(async () => {
    await signOut(auth);
  }, [auth]);

  const isAdmin = Boolean(user?.email && String(user.email).toLowerCase() === BOOTSTRAP_ADMIN_EMAIL);

  const value: AuthContextValue = React.useMemo(
    () => ({
      user,
      loading,
      isAdmin,
      signInWithEmailPassword,
      logout,
    }),
    [user, loading, isAdmin, signInWithEmailPassword, logout]
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


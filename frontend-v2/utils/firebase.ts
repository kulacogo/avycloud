import { initializeApp, type FirebaseApp } from 'firebase/app';
import {
  browserLocalPersistence,
  browserSessionPersistence,
  inMemoryPersistence,
  initializeAuth,
  type Auth,
  type Persistence,
} from 'firebase/auth';

export type FirebaseConfigStatus = {
  ok: boolean;
  missingKeys: Array<
    | 'VITE_FIREBASE_API_KEY'
    | 'VITE_FIREBASE_AUTH_DOMAIN'
    | 'VITE_FIREBASE_PROJECT_ID'
    | 'VITE_FIREBASE_APP_ID'
  >;
};

const REQUIRED_KEYS: FirebaseConfigStatus['missingKeys'] = [
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_AUTH_DOMAIN',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_APP_ID',
];

export const getFirebaseConfigStatus = (): FirebaseConfigStatus => {
  const missing = REQUIRED_KEYS.filter((k) => !import.meta.env[k]);
  return { ok: missing.length === 0, missingKeys: missing };
};

const getFirebaseConfigOrThrow = () => {
  const status = getFirebaseConfigStatus();
  if (!status.ok) {
    throw new Error(
      `Firebase config missing: ${status.missingKeys.join(', ')}. Add them to your Vite env (.env.local) and restart dev server.`
    );
  }
  return {
    apiKey: String(import.meta.env.VITE_FIREBASE_API_KEY),
    authDomain: String(import.meta.env.VITE_FIREBASE_AUTH_DOMAIN),
    projectId: String(import.meta.env.VITE_FIREBASE_PROJECT_ID),
    appId: String(import.meta.env.VITE_FIREBASE_APP_ID),
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  };
};

let app: FirebaseApp | null = null;
let auth: Auth | null = null;

export function getFirebaseApp(): FirebaseApp {
  if (!app) {
    app = initializeApp(getFirebaseConfigOrThrow());
  }
  return app;
}

export function getFirebaseAuth(): Auth {
  if (!auth) {
    const mode = import.meta.env.VITE_AUTH_PERSISTENCE || 'session';
    const persistence: Persistence =
      mode === 'local'
        ? browserLocalPersistence
        : mode === 'none'
          ? inMemoryPersistence
          : browserSessionPersistence;

    auth = initializeAuth(getFirebaseApp(), {
      persistence,
      // We do not use popup/redirect flows, so we can skip the resolver to keep it minimal.
      popupRedirectResolver: undefined,
    });
  }
  return auth;
}


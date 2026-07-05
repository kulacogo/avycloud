'use strict';

/**
 * Fix 5 (2026-07-05): Self-Service-Zugangsdaten wirken zur LAUFZEIT.
 *
 * Der IntegrationWizard speichert Zugangsdaten (SendCloud/Kaufland/SevDesk)
 * seit jeher in Firestore (`integrations_config`) — aber KEIN Runtime-Pfad
 * hat sie je gelesen: alle Libs gingen direkt auf ENV/Secret Manager.
 * "Neu verbinden" in der UI war damit wirkungslos.
 *
 * Neu: `resolveProviderCredentials` (normalisiert, 60s-TTL) und
 * `getIntegrationSecret` (Drop-in für getSecretValue bei den bekannten
 * Integration-Secrets) — Store gewinnt, ENV/Secret Manager bleibt Fallback.
 */

// '@google-cloud/firestore' vor-patchen, bevor integration-store lädt.
const gcfPath = require.resolve('@google-cloud/firestore');
const docStore = new Map(); // docId → data
class FakeFirestore {
  collection(name) {
    return {
      doc: (id) => ({
        get: async () => {
          const data = docStore.get(`${name}/${id}`);
          return { exists: Boolean(data), data: () => data, id };
        },
        set: async (doc) => { docStore.set(`${name}/${id}`, doc); },
        update: async (patch) => {
          const cur = docStore.get(`${name}/${id}`) || {};
          docStore.set(`${name}/${id}`, { ...cur, ...patch });
        },
        delete: async () => { docStore.delete(`${name}/${id}`); },
      }),
      where: () => ({ get: async () => ({ docs: [] }) }),
    };
  }
}
require.cache[gcfPath] = {
  id: gcfPath,
  filename: gcfPath,
  loaded: true,
  exports: {
    Firestore: FakeFirestore,
    FieldValue: { serverTimestamp: () => 'ts' },
    Timestamp: { fromMillis: (ms) => ms },
  },
};

// Diese Datei testet den Store-Pfad selbst → Kill-Switch wieder einschalten
// (vitest.setup.js setzt ihn global auf 'off').
process.env.INTEGRATION_CREDENTIALS_STORE = 'on';

// Secret-Fallback über ENV (getSecretValue liest process.env zuerst).
process.env.SENDCLOUD_PUBLIC_KEY = 'env-public';
process.env.SENDCLOUD_SECRET_KEY = 'env-secret';
process.env.SEVDESK_API_TOKEN = 'env-sevdesk-token';
process.env.KAUFLAND_CLIENT_KEY = '__NULL__'; // simuliert fehlendes Secret
process.env.KAUFLAND_SECRET_KEY = '__NULL__';

const store = require('../../services/integration-store');

describe('resolveProviderCredentials — Store gewinnt, Fallback bleibt', () => {
  beforeEach(() => {
    docStore.clear();
    store.invalidateCredentialsCache();
  });

  it('liefert ENV/Secret-Fallback, solange nichts im Store liegt', async () => {
    const creds = await store.resolveProviderCredentials('sendcloud');
    expect(creds).toEqual({ publicKey: 'env-public', secretKey: 'env-secret' });
  });

  it('liefert null-frei nichts, wenn weder Store noch Secrets existieren', async () => {
    const creds = await store.resolveProviderCredentials('kaufland');
    expect(creds).toBeNull();
  });

  it('bevorzugt aktive Self-Service-Zugangsdaten aus dem Store', async () => {
    docStore.set('integrations_config/default__sendcloud', {
      tenantId: 'default',
      type: 'sendcloud',
      status: 'active',
      credentials: { data: { publicKey: 'ui-public', secretKey: 'ui-secret' }, encrypted: false },
    });
    const creds = await store.resolveProviderCredentials('sendcloud');
    expect(creds).toEqual({ publicKey: 'ui-public', secretKey: 'ui-secret' });
  });

  it('ignoriert Store-Einträge mit status != active', async () => {
    docStore.set('integrations_config/default__sendcloud', {
      tenantId: 'default',
      type: 'sendcloud',
      status: 'error',
      credentials: { data: { publicKey: 'ui-public', secretKey: 'ui-secret' }, encrypted: false },
    });
    const creds = await store.resolveProviderCredentials('sendcloud');
    expect(creds).toEqual({ publicKey: 'env-public', secretKey: 'env-secret' });
  });

  it('cached pro Provider und sieht neue Werte nach invalidateCredentialsCache', async () => {
    const first = await store.resolveProviderCredentials('sendcloud');
    expect(first.publicKey).toBe('env-public');

    docStore.set('integrations_config/default__sendcloud', {
      tenantId: 'default',
      type: 'sendcloud',
      status: 'active',
      credentials: { data: { publicKey: 'fresh-public', secretKey: 'fresh-secret' }, encrypted: false },
    });

    // Noch gecacht:
    const cached = await store.resolveProviderCredentials('sendcloud');
    expect(cached.publicKey).toBe('env-public');

    store.invalidateCredentialsCache('sendcloud');
    const fresh = await store.resolveProviderCredentials('sendcloud');
    expect(fresh.publicKey).toBe('fresh-public');
  });

  it('saveIntegration invalidiert den Cache automatisch', async () => {
    const before = await store.resolveProviderCredentials('sendcloud');
    expect(before.publicKey).toBe('env-public');

    await store.saveIntegration({
      tenantId: 'default',
      type: 'sendcloud',
      authType: 'api_key',
      credentials: { publicKey: 'saved-public', secretKey: 'saved-secret' },
      actor: null,
    });

    const after = await store.resolveProviderCredentials('sendcloud');
    expect(after.publicKey).toBe('saved-public');
  });
});

describe('getIntegrationSecret — Drop-in für getSecretValue', () => {
  beforeEach(() => {
    docStore.clear();
    store.invalidateCredentialsCache();
  });

  it('mappt bekannte Secret-Namen auf Store-Felder', async () => {
    docStore.set('integrations_config/default__sevdesk', {
      tenantId: 'default',
      type: 'sevdesk',
      status: 'active',
      credentials: { data: { apiToken: 'ui-sevdesk-token' }, encrypted: false },
    });
    const token = await store.getIntegrationSecret('SEVDESK_API_TOKEN');
    expect(token).toBe('ui-sevdesk-token');
  });

  it('fällt für bekannte Namen ohne Store-Eintrag auf das Secret zurück', async () => {
    const token = await store.getIntegrationSecret('SEVDESK_API_TOKEN');
    expect(token).toBe('env-sevdesk-token');
  });

  it('reicht unbekannte Secret-Namen direkt an getSecretValue durch', async () => {
    process.env.SOME_OTHER_SECRET = 'plain-secret';
    const v = await store.getIntegrationSecret('SOME_OTHER_SECRET');
    expect(v).toBe('plain-secret');
  });
});

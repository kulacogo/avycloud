'use strict';

/**
 * integration-store.js — Credential management for integrations.
 *
 * Stores encrypted credentials in Firestore `integrations_config` collection.
 * Falls back to Google Secret Manager / ENV for backwards-compatibility.
 *
 * Encryption: AES-256-GCM with key from INTEGRATION_ENCRYPTION_KEY env/secret.
 * If no encryption key is configured, credentials are stored as plain text
 * (acceptable for single-tenant with Firestore security rules).
 */

const crypto = require('crypto');
const { Firestore, FieldValue } = require('@google-cloud/firestore');
const { getSecretValue } = require('../lib/secret-values');
const { getProvider, validateCredentialFields } = require('../lib/integration-registry');

const COLLECTION = 'integrations_config';
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

let _db;
function getDb() {
  if (!_db) _db = new Firestore();
  return _db;
}

let _encryptionKey;
async function getEncryptionKey() {
  if (_encryptionKey !== undefined) return _encryptionKey;
  const raw = await getSecretValue('INTEGRATION_ENCRYPTION_KEY').catch(() => null);
  _encryptionKey = raw ? Buffer.from(raw, 'hex') : null;
  return _encryptionKey;
}

// ─── Encryption helpers ──────────────────────────────────────

function encrypt(text, key) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

function decrypt(encryptedText, key) {
  const [ivHex, authTagHex, data] = encryptedText.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(data, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

async function encryptCredentials(credentials) {
  const key = await getEncryptionKey();
  if (!key) return { data: credentials, encrypted: false };
  const json = JSON.stringify(credentials);
  return { data: encrypt(json, key), encrypted: true };
}

async function decryptCredentials(stored) {
  if (!stored) return null;
  if (!stored.encrypted) return stored.data;
  const key = await getEncryptionKey();
  if (!key) {
    console.warn('[integration-store] Encryption key not available, cannot decrypt credentials');
    return null;
  }
  try {
    return JSON.parse(decrypt(stored.data, key));
  } catch (err) {
    console.error('[integration-store] Failed to decrypt credentials:', err.message);
    return null;
  }
}

// ─── Firestore CRUD ──────────────────────────────────────────

/**
 * Get a stored integration by type.
 * @param {{ tenantId: string, type: string }} opts
 * @returns {Promise<object|null>}
 */
async function getIntegration({ tenantId = 'default', type }) {
  const docId = `${tenantId}__${type}`;
  const doc = await getDb().collection(COLLECTION).doc(docId).get();
  if (!doc.exists) return null;

  const data = doc.data();
  const credentials = await decryptCredentials(data.credentials);
  return {
    id: doc.id,
    tenantId: data.tenantId,
    type: data.type,
    authType: data.authType,
    status: data.status,
    credentials,
    settings: data.settings || {},
    connectedAt: data.connectedAt?.toDate?.() || data.connectedAt || null,
    updatedAt: data.updatedAt?.toDate?.() || data.updatedAt || null,
    lastSync: data.lastSync?.toDate?.() || data.lastSync || null,
    lastError: data.lastError || null,
    connectedBy: data.connectedBy || null,
  };
}

/**
 * List all integrations for a tenant.
 * @param {{ tenantId: string }} opts
 * @returns {Promise<object[]>}
 */
async function listIntegrations({ tenantId = 'default' }) {
  const snap = await getDb()
    .collection(COLLECTION)
    .where('tenantId', '==', tenantId)
    .get();

  const results = [];
  for (const doc of snap.docs) {
    const data = doc.data();
    results.push({
      id: doc.id,
      tenantId: data.tenantId,
      type: data.type,
      authType: data.authType,
      status: data.status,
      // Do NOT decrypt credentials for list view (security)
      settings: data.settings || {},
      connectedAt: data.connectedAt?.toDate?.() || data.connectedAt || null,
      updatedAt: data.updatedAt?.toDate?.() || data.updatedAt || null,
      lastSync: data.lastSync?.toDate?.() || data.lastSync || null,
      lastError: data.lastError || null,
      connectedBy: data.connectedBy || null,
    });
  }
  return results;
}

/**
 * Save/update an integration's credentials.
 * @param {{ tenantId: string, type: string, authType: string, credentials: object, actor: { uid: string, email: string } }} opts
 * @returns {Promise<object>}
 */
async function saveIntegration({ tenantId = 'default', type, authType, credentials, actor }) {
  const docId = `${tenantId}__${type}`;
  const encryptedCreds = await encryptCredentials(credentials);

  const doc = {
    tenantId,
    type,
    authType,
    status: 'active',
    credentials: encryptedCreds,
    updatedAt: FieldValue.serverTimestamp(),
    connectedBy: actor ? { uid: actor.uid, email: actor.email } : null,
  };

  // Only set connectedAt on first creation
  const existing = await getDb().collection(COLLECTION).doc(docId).get();
  if (!existing.exists) {
    doc.connectedAt = FieldValue.serverTimestamp();
    doc.settings = {
      syncProducts: true,
      syncOrders: true,
      syncPrices: true,
      syncStock: true,
      direction: 'bidirectional',
    };
  }

  await getDb().collection(COLLECTION).doc(docId).set(doc, { merge: true });

  return { ok: true, type, status: 'active' };
}

/**
 * Update integration settings (sync config, interval, etc.).
 * @param {{ tenantId: string, type: string, settings: object }} opts
 * @returns {Promise<object>}
 */
async function updateSettings({ tenantId = 'default', type, settings }) {
  const docId = `${tenantId}__${type}`;
  const existing = await getDb().collection(COLLECTION).doc(docId).get();
  if (!existing.exists) {
    return { ok: false, error: 'Integration nicht gefunden' };
  }

  await getDb().collection(COLLECTION).doc(docId).update({
    settings,
    updatedAt: FieldValue.serverTimestamp(),
  });

  return { ok: true, type };
}

/**
 * Delete (disconnect) an integration.
 * @param {{ tenantId: string, type: string }} opts
 * @returns {Promise<object>}
 */
async function deleteIntegration({ tenantId = 'default', type }) {
  const docId = `${tenantId}__${type}`;
  await getDb().collection(COLLECTION).doc(docId).delete();

  // eBay stores OAuth tokens in a separate doc ('ebay') — delete it too
  if (type === 'ebay') {
    try {
      await getDb().collection(COLLECTION).doc('ebay').delete();
    } catch (err) {
      console.warn(`[integration-store] Failed to delete eBay OAuth doc: ${err.message}`);
    }
  }

  return { ok: true, type, status: 'disconnected' };
}

/**
 * Record a sync timestamp and optional error.
 * @param {{ tenantId: string, type: string, error?: string }} opts
 */
async function recordSync({ tenantId = 'default', type, error }) {
  const docId = `${tenantId}__${type}`;
  const update = {
    lastSync: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (error) {
    update.lastError = error;
    update.status = 'error';
  } else {
    update.lastError = null;
    update.status = 'active';
  }
  await getDb().collection(COLLECTION).doc(docId).update(update).catch(() => {
    // Ignore if doc doesn't exist (not yet configured via self-service)
  });
}

// ─── Connection Test ─────────────────────────────────────────

/**
 * Test integration credentials by making a provider-specific API call.
 * @param {{ type: string, credentials: object }} opts
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
async function testConnection({ type, credentials }) {
  try {
    switch (type) {
      case 'kaufland': {
        const { kauflandRequest } = require('../lib/kaufland-api');
        // Test with info/locale endpoint using provided credentials
        const result = await kauflandRequest('GET', '/v2/info/locale', null, {
          clientKey: credentials.clientKey,
          secretKey: credentials.secretKey,
        });
        return { ok: true, message: `Verbunden! ${Array.isArray(result) ? result.length : 0} Locales gefunden.` };
      }

      case 'baselinker': {
        const fetchFn = global.fetch || require('node-fetch');
        const resp = await fetchFn('https://api.baselinker.com/connector.php', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-BLToken': credentials.apiToken },
          body: 'method=getInventories',
        });
        const data = await resp.json();
        if (data.status === 'SUCCESS') {
          const count = data.inventories?.length || 0;
          return { ok: true, message: `Verbunden! ${count} Inventare gefunden.` };
        }
        return { ok: false, message: data.error_message || 'Verbindung fehlgeschlagen' };
      }

      case 'sendcloud': {
        const fetchFn = global.fetch || require('node-fetch');
        const auth = Buffer.from(`${credentials.publicKey}:${credentials.secretKey}`).toString('base64');
        const resp = await fetchFn('https://panel.sendcloud.sc/api/v2/user', {
          headers: { Authorization: `Basic ${auth}` },
        });
        if (resp.ok) {
          const data = await resp.json();
          const company = data.user?.company?.name || '';
          return { ok: true, message: `Verbunden! Firma: ${company}` };
        }
        return { ok: false, message: `Verbindung fehlgeschlagen (HTTP ${resp.status})` };
      }

      case 'sevdesk': {
        const fetchFn = global.fetch || require('node-fetch');
        const resp = await fetchFn('https://my.sevdesk.de/api/v1/CheckAccount?limit=1', {
          headers: { Authorization: credentials.apiToken },
        });
        if (resp.ok) {
          const data = await resp.json();
          const count = data.objects?.length || 0;
          return { ok: true, message: `Verbunden! ${count} Konten gefunden.` };
        }
        return { ok: false, message: `Verbindung fehlgeschlagen (HTTP ${resp.status})` };
      }

      case 'ebay':
        // eBay uses OAuth — test is done via the OAuth callback
        return { ok: true, message: 'eBay wird über OAuth verbunden. Bitte den OAuth-Flow starten.' };

      default:
        return { ok: false, message: `Unbekannter Provider: ${type}` };
    }
  } catch (err) {
    return { ok: false, message: `Verbindungstest fehlgeschlagen: ${err.message}` };
  }
}

// ─── Credential Resolution (Firestore → ENV Fallback) ────────

/**
 * Resolve credentials for a provider. Checks Firestore first, falls back to ENV/Secret Manager.
 * @param {{ tenantId: string, type: string }} opts
 * @returns {Promise<object|null>}
 */
async function resolveCredentials({ tenantId = 'default', type }) {
  // 1. Check Firestore (self-service credentials)
  const stored = await getIntegration({ tenantId, type });
  if (stored?.credentials && stored.status === 'active') {
    return stored.credentials;
  }

  // 2. Fallback to ENV / Secret Manager
  const provider = getProvider(type);
  if (!provider?.secretKeys) return null;

  const fallback = {};
  let hasAny = false;
  for (const secretName of provider.secretKeys) {
    const value = await getSecretValue(secretName).catch(() => null);
    if (value) {
      fallback[secretName] = value;
      hasAny = true;
    }
  }
  return hasAny ? fallback : null;
}

module.exports = {
  getIntegration,
  listIntegrations,
  saveIntegration,
  updateSettings,
  deleteIntegration,
  recordSync,
  testConnection,
  resolveCredentials,
  // Exposed for testing
  encrypt,
  decrypt,
};

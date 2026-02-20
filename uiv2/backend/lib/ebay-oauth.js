const crypto = require('crypto');
const { FieldValue, Timestamp } = require('@google-cloud/firestore');
const { getSecretValue } = require('./secret-values');
const { firestore } = require('./firestore');

const fetchImpl = global.fetch || require('node-fetch');

const OAUTH_STATES_COLLECTION = 'oauthStates';
const INTEGRATIONS_COLLECTION = 'integrations';
const EBAY_INTEGRATION_DOC_ID = 'ebay';

function normalizeEnv(raw) {
  const v = String(raw || '').trim().toLowerCase();
  return v === 'sandbox' ? 'sandbox' : 'production';
}

function getEbayEnvironment() {
  return normalizeEnv(process.env.EBAY_ENV || 'production');
}

function getAuthBaseUrl(env) {
  return env === 'sandbox' ? 'https://auth.sandbox.ebay.com' : 'https://auth.ebay.com';
}

function getApiBaseUrl(env) {
  return env === 'sandbox' ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com';
}

async function getEbayClientId() {
  const direct = process.env.EBAY_CLIENT_ID || process.env.EBAY_APP_ID;
  if (direct) return String(direct).trim();
  const secret = await getSecretValue('EBAY_CLIENT_ID');
  return secret ? String(secret).trim() : '';
}

async function getEbayClientSecret() {
  const direct = process.env.EBAY_CLIENT_SECRET || process.env.EBAY_CERT_ID;
  if (direct) return String(direct).trim();
  const secret = await getSecretValue('EBAY_CLIENT_SECRET');
  return secret ? String(secret).trim() : '';
}

async function getEbayRuName() {
  const direct =
    process.env.EBAY_RU_NAME ||
    process.env.EBAY_REDIRECT_URI ||
    process.env.EBAY_REDIRECT_URI_NAME;
  if (direct) return String(direct).trim();
  const secret = await getSecretValue('EBAY_RU_NAME');
  return secret ? String(secret).trim() : '';
}

function parseScopes(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const tokens = text
    .split(/[\s,]+/g)
    .map((s) => s.trim())
    .filter(Boolean);
  return tokens.length ? tokens : null;
}

async function getEbayScopes() {
  // Default: read-only inventory access (sufficient to fetch offers/listings by SKU).
  const fallback = ['https://api.ebay.com/oauth/api_scope/sell.inventory.readonly'];
  const fromEnv = parseScopes(process.env.EBAY_SCOPES);
  return fromEnv || fallback;
}

async function getEbayOAuthConfig() {
  const env = getEbayEnvironment();
  const [clientId, clientSecret, ruName, scopes] = await Promise.all([
    getEbayClientId(),
    getEbayClientSecret(),
    getEbayRuName(),
    getEbayScopes(),
  ]);

  const missing = [];
  if (!clientId) missing.push('EBAY_CLIENT_ID');
  if (!clientSecret) missing.push('EBAY_CLIENT_SECRET');
  if (!ruName) missing.push('EBAY_RU_NAME (RuName / redirect_uri value)');

  if (missing.length) {
    const err = new Error(`eBay OAuth config missing: ${missing.join(', ')}`);
    err.code = 'EBAY_CONFIG_MISSING';
    throw err;
  }

  return {
    env,
    authBaseUrl: getAuthBaseUrl(env),
    apiBaseUrl: getApiBaseUrl(env),
    tokenEndpoint: `${getApiBaseUrl(env)}/identity/v1/oauth2/token`,
    clientId,
    clientSecret,
    ruName,
    scopes,
  };
}

function base64OAuthCredentials(clientId, clientSecret) {
  // Per eBay docs: base64("<client_id>:<client_secret>")
  return Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64');
}

async function fetchWithTimeout(url, init, timeoutMs = 25000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

async function exchangeAuthorizationCodeForToken({ code }) {
  const cfg = await getEbayOAuthConfig();
  const params = new URLSearchParams();
  params.set('grant_type', 'authorization_code');
  // Important: redirect_uri must be the RuName value (not the literal callback URL)
  params.set('redirect_uri', cfg.ruName);
  params.set('code', String(code || '').trim());

  const res = await fetchWithTimeout(
    cfg.tokenEndpoint,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${base64OAuthCredentials(cfg.clientId, cfg.clientSecret)}`,
      },
      body: params.toString(),
    },
    parseInt(process.env.EBAY_OAUTH_TIMEOUT_MS || '25000', 10)
  );

  const bodyText = await res.text().catch(() => '');
  if (!res.ok) {
    let reason = bodyText;
    try {
      const parsed = JSON.parse(bodyText);
      reason = parsed.error_description || parsed.error || parsed?.message || reason;
    } catch {
      // ignore JSON parse issues
    }
    const err = new Error(`eBay token exchange failed (${res.status}): ${reason}`);
    err.code = 'EBAY_TOKEN_EXCHANGE_FAILED';
    throw err;
  }

  const json = JSON.parse(bodyText || '{}');
  return json;
}

async function refreshUserAccessToken({ refreshToken }) {
  const cfg = await getEbayOAuthConfig();
  const params = new URLSearchParams();
  params.set('grant_type', 'refresh_token');
  params.set('refresh_token', String(refreshToken || '').trim());
  // Scope is optional per eBay docs, but when specified must be <= original scopes.
  if (Array.isArray(cfg.scopes) && cfg.scopes.length) {
    params.set('scope', cfg.scopes.join(' '));
  }

  const res = await fetchWithTimeout(
    cfg.tokenEndpoint,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${base64OAuthCredentials(cfg.clientId, cfg.clientSecret)}`,
      },
      body: params.toString(),
    },
    parseInt(process.env.EBAY_OAUTH_TIMEOUT_MS || '25000', 10)
  );

  const bodyText = await res.text().catch(() => '');
  if (!res.ok) {
    let reason = bodyText;
    try {
      const parsed = JSON.parse(bodyText);
      reason = parsed.error_description || parsed.error || parsed?.message || reason;
    } catch {
      // ignore JSON parse issues
    }
    const err = new Error(`eBay token refresh failed (${res.status}): ${reason}`);
    err.code = 'EBAY_TOKEN_REFRESH_FAILED';
    throw err;
  }

  const json = JSON.parse(bodyText || '{}');
  return json;
}

async function createOAuthState({ provider = 'ebay', actor = null } = {}) {
  const state = crypto.randomUUID();
  const ref = firestore.collection(OAUTH_STATES_COLLECTION).doc(state);
  await ref.set({
    provider: String(provider || 'ebay'),
    createdAt: FieldValue.serverTimestamp(),
    actor: actor
      ? {
          uid: actor?.uid || null,
          email: actor?.email || null,
        }
      : null,
  });
  return state;
}

async function consumeOAuthState(state, provider = 'ebay') {
  const key = String(state || '').trim();
  if (!key) return null;
  const ref = firestore.collection(OAUTH_STATES_COLLECTION).doc(key);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const data = snap.data() || {};
  if (String(data.provider || '').trim() !== String(provider || '').trim()) {
    return null;
  }
  // Consume: delete so it can't be replayed.
  try {
    await ref.delete();
  } catch {
    // ignore
  }
  return data;
}

async function buildConsentUrl({ state, locale = 'de-DE', prompt = null } = {}) {
  const cfg = await getEbayOAuthConfig();
  const url = new URL('/oauth2/authorize', cfg.authBaseUrl);
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('redirect_uri', cfg.ruName);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', (cfg.scopes || []).join(' '));
  if (state) url.searchParams.set('state', String(state));
  if (locale) url.searchParams.set('locale', String(locale));
  if (prompt) url.searchParams.set('prompt', String(prompt));
  return url.toString();
}

function integrationRef() {
  return firestore.collection(INTEGRATIONS_COLLECTION).doc(EBAY_INTEGRATION_DOC_ID);
}

function toMillis(tsOrIso) {
  if (!tsOrIso) return 0;
  if (typeof tsOrIso?.toMillis === 'function') return tsOrIso.toMillis();
  const d = new Date(tsOrIso);
  const ms = d.getTime();
  return Number.isFinite(ms) ? ms : 0;
}

async function upsertEbayTokenSet(tokenSet, { actor = null } = {}) {
  const cfg = await getEbayOAuthConfig();
  const nowMs = Date.now();
  const expiresInSec = Number(tokenSet?.expires_in || 0);
  const refreshExpiresInSec = Number(tokenSet?.refresh_token_expires_in || 0);

  const accessExpiresAtMs = expiresInSec > 0 ? nowMs + expiresInSec * 1000 : null;
  const refreshExpiresAtMs =
    refreshExpiresInSec > 0 ? nowMs + refreshExpiresInSec * 1000 : null;

  const payload = {
    provider: 'ebay',
    env: cfg.env,
    scopes: cfg.scopes || [],
    tokenType: tokenSet?.token_type || 'User Access Token',
    accessToken: tokenSet?.access_token || null,
    accessTokenExpiresAt: accessExpiresAtMs ? Timestamp.fromMillis(accessExpiresAtMs) : null,
    refreshToken: tokenSet?.refresh_token || null,
    refreshTokenExpiresAt: refreshExpiresAtMs ? Timestamp.fromMillis(refreshExpiresAtMs) : null,
    connectedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    connectedBy: actor
      ? {
          uid: actor?.uid || null,
          email: actor?.email || null,
        }
      : null,
  };

  await integrationRef().set(payload, { merge: true });
  return payload;
}

async function getEbayIntegration() {
  const snap = await integrationRef().get();
  return snap.exists ? snap.data() || null : null;
}

async function getValidEbayAccessToken() {
  const cfg = await getEbayOAuthConfig();
  const doc = await getEbayIntegration();
  if (!doc?.accessToken) {
    const err = new Error('eBay is not connected. Please connect the eBay account first.');
    err.code = 'EBAY_NOT_CONNECTED';
    throw err;
  }

  const nowMs = Date.now();
  const accessExpMs = toMillis(doc.accessTokenExpiresAt);
  const refreshExpMs = toMillis(doc.refreshTokenExpiresAt);

  // Keep a small safety buffer so we don't race expiry mid-request.
  const BUFFER_MS = Math.max(60_000, parseInt(process.env.EBAY_TOKEN_EXPIRY_BUFFER_MS || '180000', 10) || 180_000);
  if (accessExpMs && accessExpMs - nowMs > BUFFER_MS) {
    return { accessToken: String(doc.accessToken), env: cfg.env, apiBaseUrl: cfg.apiBaseUrl };
  }

  const refreshToken = doc.refreshToken ? String(doc.refreshToken) : '';
  if (!refreshToken) {
    const err = new Error('eBay access token expired and no refresh token is available. Please reconnect eBay.');
    err.code = 'EBAY_REFRESH_MISSING';
    throw err;
  }
  if (refreshExpMs && refreshExpMs - nowMs <= 0) {
    const err = new Error('eBay refresh token expired. Please reconnect eBay.');
    err.code = 'EBAY_REFRESH_EXPIRED';
    throw err;
  }

  const refreshed = await refreshUserAccessToken({ refreshToken });
  const expiresInSec = Number(refreshed?.expires_in || 0);
  const nextAccessExpiresAtMs = expiresInSec > 0 ? nowMs + expiresInSec * 1000 : null;
  const patch = {
    accessToken: refreshed?.access_token || null,
    accessTokenExpiresAt: nextAccessExpiresAtMs ? Timestamp.fromMillis(nextAccessExpiresAtMs) : null,
    tokenType: refreshed?.token_type || doc.tokenType || 'User Access Token',
    updatedAt: FieldValue.serverTimestamp(),
    lastRefreshedAt: FieldValue.serverTimestamp(),
  };
  await integrationRef().set(patch, { merge: true });

  return { accessToken: String(patch.accessToken || ''), env: cfg.env, apiBaseUrl: cfg.apiBaseUrl };
}

function publicStatus(doc) {
  if (!doc) return { connected: false };
  const accessExpMs = toMillis(doc.accessTokenExpiresAt);
  const refreshExpMs = toMillis(doc.refreshTokenExpiresAt);
  return {
    connected: Boolean(doc.accessToken),
    env: doc.env || null,
    scopes: Array.isArray(doc.scopes) ? doc.scopes : [],
    tokenType: doc.tokenType || null,
    connectedBy: doc.connectedBy || null,
    connectedAt: doc.connectedAt?.toDate?.().toISOString?.() || null,
    updatedAt: doc.updatedAt?.toDate?.().toISOString?.() || null,
    lastRefreshedAt: doc.lastRefreshedAt?.toDate?.().toISOString?.() || null,
    accessTokenExpiresAt: accessExpMs ? new Date(accessExpMs).toISOString() : null,
    refreshTokenExpiresAt: refreshExpMs ? new Date(refreshExpMs).toISOString() : null,
  };
}

module.exports = {
  getEbayOAuthConfig,
  getEbayEnvironment,
  getAuthBaseUrl,
  getApiBaseUrl,
  createOAuthState,
  consumeOAuthState,
  buildConsentUrl,
  exchangeAuthorizationCodeForToken,
  upsertEbayTokenSet,
  getEbayIntegration,
  getValidEbayAccessToken,
  publicStatus,
};


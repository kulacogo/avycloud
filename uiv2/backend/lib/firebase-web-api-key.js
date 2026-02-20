/**
 * Helper to discover the correct Firebase Web API key for the project.
 *
 * Why this exists:
 * - Firebase Admin `generatePasswordResetLink` / `generateEmailVerificationLink` embeds an `apiKey` query param.
 * - In this project, the generated links used the GENAI API key (format "AQ...."), which fails against Identity Toolkit,
 *   causing the hosted action handler to show "expired or already used".
 *
 * We instead fetch the Firebase hosting init config and use its `apiKey` (browser key auto-created by Firebase).
 */

let cachedKey = null;
let cachedAtMs = 0;
let inflight = null;

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_INIT_JSON_URL = 'https://avycloud.firebaseapp.com/__/firebase/init.json';

function nowMs() {
  return Date.now();
}

async function fetchKeyFromInitJson() {
  const res = await fetch(DEFAULT_INIT_JSON_URL, {
    method: 'GET',
    headers: {
      // Keep it explicit; some proxies behave oddly without an UA.
      'User-Agent': 'avycloud-backend/1.0',
      'Accept': 'application/json',
    },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch Firebase init.json (${res.status})`);
  }

  const json = await res.json();
  const apiKey = typeof json?.apiKey === 'string' ? json.apiKey.trim() : '';
  if (!apiKey) {
    throw new Error('Firebase init.json did not include apiKey');
  }
  return apiKey;
}

async function getFirebaseWebApiKey() {
  // Prefer explicit env var when provided (useful for multi-env setups).
  const envKey = (process.env.FIREBASE_WEB_API_KEY || process.env.VITE_FIREBASE_API_KEY || '').trim();
  if (envKey) return envKey;

  const now = nowMs();
  if (cachedKey && now - cachedAtMs < CACHE_TTL_MS) {
    return cachedKey;
  }

  if (inflight) return inflight;
  inflight = (async () => {
    const key = await fetchKeyFromInitJson();
    cachedKey = key;
    cachedAtMs = nowMs();
    return key;
  })()
    .catch((error) => {
      // Clear inflight so next request can retry.
      inflight = null;
      throw error;
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

async function rewriteActionLinkApiKey(actionLink) {
  const link = String(actionLink || '').trim();
  if (!link) return link;

  let url;
  try {
    url = new URL(link);
  } catch {
    return link;
  }

  // Only rewrite when it's a Firebase action handler link.
  if (!url.pathname.includes('/__/auth/action')) {
    return link;
  }

  try {
    const correctKey = await getFirebaseWebApiKey();
    if (correctKey) {
      url.searchParams.set('apiKey', correctKey);
    }
  } catch (error) {
    // Best-effort: keep original link, but log to aid diagnosis.
    console.error('Failed to discover Firebase Web API key for action link rewrite:', {
      message: error?.message || String(error),
    });
    return link;
  }

  return url.toString();
}

module.exports = {
  getFirebaseWebApiKey,
  rewriteActionLinkApiKey,
};


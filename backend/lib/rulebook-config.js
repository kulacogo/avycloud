/* eslint-disable no-console */
/**
 * Runtime Rulebook Config (admin-editable).
 *
 * IMPORTANT:
 * - This is designed to allow admin UI edits without redeploy.
 * - Callers that need strict, identical behavior across LLMs should read from this cache.
 * - Title policy and other sync-time validations use the SYNC getter to avoid async plumbing.
 */

const { Firestore, Timestamp } = require('@google-cloud/firestore');

const firestore = new Firestore({
  projectId: process.env.GOOGLE_CLOUD_PROJECT || 'avycloud',
});

const COLLECTION = 'rulebookConfigs';
const ACTIVE_DOC_ID = 'active';

const DEFAULT_CONFIG = {
  version: 1,
  title: {
    minLen: 65,
    softMaxLen: 75,
    maxLen: 80,
    mobileMaxLen: 60,
    // Additional marketing words to strip; merged with code defaults.
    marketingWords: ['neu', 'top', 'neuware'],
  },
  highlights: {
    // SchemaId -> rule
    rulesBySchema: {
      electronics_computer: { min: 4, max: 6, minLen: 80, maxLen: 120 },
      auto_parts: { min: 4, max: 5, minLen: 70, maxLen: 110 },
      fashion: { min: 4, max: 5, minLen: 70, maxLen: 100 },
      shoes_accessories: { min: 4, max: 5, minLen: 70, maxLen: 100 },
      home_garden: { min: 4, max: 6, minLen: 80, maxLen: 120 },
      kitchen_household: { min: 4, max: 5, minLen: 70, maxLen: 100 },
      beauty: { min: 4, max: 5, minLen: 70, maxLen: 100 },
      sport: { min: 4, max: 5, minLen: 70, maxLen: 100 },
      toys_baby: { min: 4, max: 6, minLen: 70, maxLen: 100 },
      office: { min: 3, max: 5, minLen: 70, maxLen: 100 },
      lighting: { min: 4, max: 5, minLen: 70, maxLen: 110 },
      books_media: { min: 3, max: 5, minLen: 70, maxLen: 100 },
      generic: { min: 4, max: 6, minLen: 70, maxLen: 110 },
    },
    requireDashTemplate: true,
  },
  attributes: {
    // Map of lowercase input key -> canonical output key
    canonicalKeyMap: {
      // can be extended by admin
    },
  },
};

let cache = {
  config: DEFAULT_CONFIG,
  loadedAtMs: 0,
  source: 'default',
};

function deepMerge(a, b) {
  if (!b || typeof b !== 'object') return a;
  if (!a || typeof a !== 'object') return b;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(b) ? b : a;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = deepMerge(a[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

function getRulebookConfigCached() {
  return cache.config || DEFAULT_CONFIG;
}

function setRulebookConfigCached(nextConfig, { source = 'manual' } = {}) {
  cache = {
    config: deepMerge(DEFAULT_CONFIG, nextConfig || {}),
    loadedAtMs: Date.now(),
    source,
  };
  return cache.config;
}

async function loadRulebookConfigFromFirestore() {
  const snap = await firestore.collection(COLLECTION).doc(ACTIVE_DOC_ID).get();
  if (!snap.exists) {
    // Seed default config once (best effort).
    try {
      await firestore.collection(COLLECTION).doc(ACTIVE_DOC_ID).set(
        {
          config: DEFAULT_CONFIG,
          version: DEFAULT_CONFIG.version,
          updatedAt: Timestamp.now(),
          updatedBy: 'system',
        },
        { merge: true }
      );
    } catch {
      // ignore seeding failures
    }
    return setRulebookConfigCached(DEFAULT_CONFIG, { source: 'default_seed' });
  }
  const data = snap.data() || {};
  const cfg = data.config && typeof data.config === 'object' ? data.config : {};
  return setRulebookConfigCached(cfg, { source: 'firestore' });
}

async function getRulebookConfig({ maxAgeMs = 30_000 } = {}) {
  const age = Date.now() - (cache.loadedAtMs || 0);
  if (age < maxAgeMs && cache.config) return cache.config;
  return await loadRulebookConfigFromFirestore();
}

module.exports = {
  DEFAULT_CONFIG,
  getRulebookConfigCached,
  setRulebookConfigCached,
  loadRulebookConfigFromFirestore,
  getRulebookConfig,
};


'use strict';

/**
 * attachUserContext middleware — Phase D.0 (Multi-Tenant Activation prep).
 *
 * Reads the authenticated user (set by `requireAuth` from `lib/auth.js`) and
 * decorates `req.user` with a `tenantId` field resolved from one of:
 *   1. Custom claim `req.user.claims.tenantId` (fast path, no Firestore read)
 *   2. Firestore `users/{uid}.tenantId` (fallback — authoritative profile field)
 *   3. Hard default `'default'` (preserves current single-tenant behaviour)
 *
 * IMPORTANT — DEFENSIVE BY DESIGN:
 *   - Never throws. A missing user profile, Firestore outage, or malformed
 *     claim all fall through to `'default'` and log a warning. This guarantees
 *     no auth-adjacent regression to existing routes while the middleware is
 *     opt-in (mounted only where ready — see separate PR for mounting).
 *   - Additive only. Does NOT modify `req.user.uid`, `email`, `isAdmin`, or
 *     any existing field. Just sets `tenantId`.
 *   - In-process 30s TTL cache for uid → tenantId lookups, to spare Firestore
 *     under burst load on hot endpoints. Cache is cleared on process restart
 *     and intentionally NOT distributed.
 *
 * Activation: requires mounting AFTER `requireAuth` for routes that want to
 * opt-in. Pre-conditions / rollout steps are documented in
 * `docs/runbooks/multi-tenant-activation.md`.
 *
 * @see /Users/oguz/Dev/avycloud/backend/lib/auth.js  (requireAuth, req.user shape)
 * Plan: /Users/oguz/.claude/plans/sieht-ziemlich-komplex-unstrukturiert-woolly-tulip.md (Phase D.0)
 */

const DEFAULT_TENANT_ID = 'default';
const USERS_COLLECTION = 'users';
const CACHE_TTL_MS = 30_000;

// Module-scoped cache: uid -> { tenantId, expiresAt }
const tenantCache = new Map();

function normalizeTenantId(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function getCachedTenantId(uid, now) {
  const entry = tenantCache.get(uid);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    tenantCache.delete(uid);
    return null;
  }
  return entry.tenantId;
}

function setCachedTenantId(uid, tenantId, now) {
  tenantCache.set(uid, { tenantId, expiresAt: now + CACHE_TTL_MS });
}

/**
 * Resolve tenantId from Firestore `users/{uid}` doc. Cached for 30s.
 * Never throws — falls back to `'default'` on any failure.
 *
 * @param {string} uid
 * @param {object} [deps]
 * @param {object} [deps.firestore] - Injectable Firestore client (test-only).
 * @returns {Promise<string>} resolved tenantId
 */
async function lookupTenantIdFromFirestore(uid, deps = {}) {
  const now = Date.now();
  const cached = getCachedTenantId(uid, now);
  if (cached) return cached;

  let tenantId = DEFAULT_TENANT_ID;
  try {
    const firestore = deps.firestore || require('./firestore').firestore;
    if (!firestore || typeof firestore.collection !== 'function') {
      // Firestore not initialised — fall back to default without warning spam.
      setCachedTenantId(uid, DEFAULT_TENANT_ID, now);
      return DEFAULT_TENANT_ID;
    }
    const snap = await firestore.collection(USERS_COLLECTION).doc(uid).get();
    if (snap && snap.exists) {
      const data = (typeof snap.data === 'function' ? snap.data() : null) || {};
      tenantId = normalizeTenantId(data.tenantId) || DEFAULT_TENANT_ID;
    } else {
      tenantId = DEFAULT_TENANT_ID;
    }
  } catch (err) {
    // Defensive: never throw. Log + fall back to default.
    // eslint-disable-next-line no-console
    console.warn(
      `[attachUserContext] firestore lookup for uid=${uid} failed: ${err && err.message ? err.message : err} — defaulting to '${DEFAULT_TENANT_ID}'`
    );
    tenantId = DEFAULT_TENANT_ID;
  }

  setCachedTenantId(uid, tenantId, now);
  return tenantId;
}

/**
 * Express middleware. MUST be mounted AFTER `requireAuth` (it relies on
 * `req.user.uid`). When `req.user` is missing (anonymous routes, CORS
 * pre-flight, etc.) it simply calls next() — no failure, no decoration.
 *
 * Resolution order:
 *   1. `req.user.claims.tenantId` (no Firestore call)
 *   2. Firestore `users/{uid}.tenantId` (30s cached)
 *   3. `'default'`
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function attachUserContext(req, res, next) {
  // No authenticated user — pass through unchanged.
  if (!req || !req.user || typeof req.user !== 'object') return next();

  // Fast path: claim already carries tenantId.
  const claimTenantId = normalizeTenantId(req.user.claims && req.user.claims.tenantId);
  if (claimTenantId) {
    req.user.tenantId = claimTenantId;
    return next();
  }

  // No uid → cannot query Firestore; default and continue.
  const uid = normalizeTenantId(req.user.uid);
  if (!uid) {
    req.user.tenantId = DEFAULT_TENANT_ID;
    return next();
  }

  lookupTenantIdFromFirestore(uid)
    .then((tenantId) => {
      req.user.tenantId = tenantId || DEFAULT_TENANT_ID;
      next();
    })
    .catch((err) => {
      // Belt-and-braces: lookupTenantIdFromFirestore already swallows errors.
      // eslint-disable-next-line no-console
      console.warn(
        `[attachUserContext] unexpected error: ${err && err.message ? err.message : err} — defaulting to '${DEFAULT_TENANT_ID}'`
      );
      req.user.tenantId = DEFAULT_TENANT_ID;
      next();
    });
}

/** Test-only helper: clear the in-process cache. */
function _clearTenantCache() {
  tenantCache.clear();
}

module.exports = {
  attachUserContext,
  lookupTenantIdFromFirestore,
  DEFAULT_TENANT_ID,
  CACHE_TTL_MS,
  _clearTenantCache,
};

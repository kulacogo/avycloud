/**
 * Distributed stock lock with Firestore backend (default in production).
 * Falls back to in-memory in tests unless explicitly overridden.
 */
'use strict';

const { firestore } = require('./firestore');

const _locks = new Map(); // key -> { promise, resolve } (test/local fallback only)
const LOCK_COLLECTION = process.env.STOCK_LOCK_COLLECTION || 'stock_locks';
const LOCK_LEASE_MS = Number.parseInt(process.env.STOCK_LOCK_LEASE_MS || '30000', 10);
const WAIT_SLICE_MS = Number.parseInt(process.env.STOCK_LOCK_WAIT_SLICE_MS || '100', 10);
const HOST_ID = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

function getBackend() {
  const explicit = String(process.env.STOCK_LOCK_BACKEND || '').trim().toLowerCase();
  if (explicit === 'firestore' || explicit === 'memory') return explicit;
  if (process.env.NODE_ENV === 'test') return 'memory';
  return 'firestore';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lockDocId(key) {
  return encodeURIComponent(String(key || ''));
}

async function acquireMemoryLock(key, timeoutMs = 15000) {
  const startMs = Date.now();
  while (_locks.has(key)) {
    const remaining = timeoutMs - (Date.now() - startMs);
    if (remaining <= 0) {
      throw new Error(`stock-lock timeout (memory) key=${key} timeoutMs=${timeoutMs}`);
    }
    const timeout = new Promise((r) => setTimeout(r, Math.min(remaining, WAIT_SLICE_MS)));
    await Promise.race([_locks.get(key).promise, timeout]);
  }
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  _locks.set(key, { promise, resolve });
  return () => {
    _locks.delete(key);
    resolve();
  };
}

async function tryAcquireFirestoreLock({ key, ownerId, leaseMs }) {
  const ref = firestore.collection(LOCK_COLLECTION).doc(lockDocId(key));
  const now = Date.now();
  const expiresAtMs = now + leaseMs;
  return firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      tx.set(ref, {
        key,
        ownerId,
        acquiredAtMs: now,
        expiresAtMs,
        updatedAt: new Date(now).toISOString(),
      });
      return { acquired: true };
    }

    const data = snap.data() || {};
    const currentExpiresAtMs = Number(data.expiresAtMs || 0);
    if (!Number.isFinite(currentExpiresAtMs) || currentExpiresAtMs <= now) {
      tx.set(ref, {
        key,
        ownerId,
        acquiredAtMs: now,
        expiresAtMs,
        updatedAt: new Date(now).toISOString(),
      }, { merge: true });
      return { acquired: true };
    }
    return { acquired: false, heldBy: data.ownerId || null, expiresAtMs: currentExpiresAtMs };
  });
}

async function acquireFirestoreLock(key, timeoutMs = 15000) {
  const ownerId = `${HOST_ID}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
  const startMs = Date.now();
  while (Date.now() - startMs < timeoutMs) {
    const res = await tryAcquireFirestoreLock({
      key,
      ownerId,
      leaseMs: Math.max(LOCK_LEASE_MS, timeoutMs + 5000),
    });
    if (res?.acquired) {
      return async () => {
        try {
          const ref = firestore.collection(LOCK_COLLECTION).doc(lockDocId(key));
          await firestore.runTransaction(async (tx) => {
            const snap = await tx.get(ref);
            if (!snap.exists) return;
            const data = snap.data() || {};
            if (String(data.ownerId || '') === ownerId) {
              tx.delete(ref);
            }
          });
        } catch (err) {
          console.warn(`[stock-lock] release failed key=${key}: ${err.message}`);
        }
      };
    }
    await sleep(Math.min(WAIT_SLICE_MS, Math.max(25, timeoutMs - (Date.now() - startMs))));
  }
  throw new Error(`stock-lock timeout (firestore) key=${key} timeoutMs=${timeoutMs}`);
}

async function acquireStockLock(key, timeoutMs = 15000) {
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey) throw new Error('stock-lock key is required');
  const backend = getBackend();
  if (backend === 'memory') return acquireMemoryLock(normalizedKey, timeoutMs);
  try {
    return await acquireFirestoreLock(normalizedKey, timeoutMs);
  } catch (err) {
    // HARDEN-9 (2026-05-20): in Production NICHT auf memory degradieren — mehrere
    // Cloud-Run-Instanzen würden Stock-Mutationen ohne echte Synchronisation fahren
    // (silent oversell, race conditions). Stattdessen loud-fail.
    // CLAUDE.md Regel #12: kein In-Memory-Stock-Lock in Production.
    // ACHTUNG: In Cloud Run ist NODE_ENV NICHT gesetzt (verifiziert). Würde der
    // Guard nur strikt auf === 'production' prüfen, wäre isProd dort false und der
    // gefährliche Memory-Fallback griffe → kein Cross-Instance-Lock → Oversell.
    // Daher fail-closed by default: ALLES außer 'test'/'development' gilt als Prod.
    const env = process.env.NODE_ENV;
    const isProd = env !== 'test' && env !== 'development';
    if (isProd) {
      console.error(`[stock-lock] CRITICAL: firestore acquire failed in production for key=${normalizedKey}: ${err.message}`);
      throw new Error(`stock-lock unavailable (firestore failed, no memory-fallback in production): key=${normalizedKey} reason=${err.message}`);
    }
    // Dev / local / test outage: degrade to memory lock so devs can keep working.
    console.warn(`[stock-lock] firestore acquire failed for key=${normalizedKey}, fallback=memory (dev/local): ${err.message}`);
    return acquireMemoryLock(normalizedKey, timeoutMs);
  }
}

async function withStockLock(key, fn, timeoutMs = 15000) {
  const release = await acquireStockLock(key, timeoutMs);
  try {
    return await fn();
  } finally {
    await release();
  }
}

module.exports = { acquireStockLock, withStockLock };

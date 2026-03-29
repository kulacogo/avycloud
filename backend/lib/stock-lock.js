/**
 * In-Memory Lock per SKU / productId.
 * Prevents concurrent stock operations for the same entity.
 *
 * Usage:
 *   const release = await acquireStockLock(sku);
 *   try { ... } finally { release(); }
 *
 * Or:
 *   await withStockLock(sku, async () => { ... });
 */

const _locks = new Map(); // key → { promise, resolve }

async function acquireStockLock(key, timeoutMs = 15000) {
  const startMs = Date.now();
  while (_locks.has(key)) {
    const remaining = timeoutMs - (Date.now() - startMs);
    if (remaining <= 0) {
      console.warn(`[stock-lock] Timeout waiting for lock: ${key} (${timeoutMs}ms)`);
      break; // Don't deadlock — proceed with warning
    }
    const timeout = new Promise((r) => setTimeout(r, remaining));
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

async function withStockLock(key, fn, timeoutMs = 15000) {
  const release = await acquireStockLock(key, timeoutMs);
  try {
    return await fn();
  } finally {
    release();
  }
}

module.exports = { acquireStockLock, withStockLock };

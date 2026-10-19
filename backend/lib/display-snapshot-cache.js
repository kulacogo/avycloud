'use strict';

// Only list/display callers may opt in. Never use for transaction decisions,
// stock writes, authorization, publishing, or the full product detail read.
// Firestore supplies an initial consistent snapshot followed by document deltas,
// including hard deletes and writes made by other processes.
function createDisplaySnapshotCache({ now = Date.now, startupMs = 4000, idleMs = 120000,
  maxPauseMs = 15000, maxEntries = 8 } = {}) {
  const entries = new Map();
  let lastTick = now();
  const drop = (key, entry, error = new Error('Display listener expired')) => {
    if (entries.get(key) !== entry) return;
    entries.delete(key);
    clearTimeout(entry.timeout);
    entry.stop?.();
    entry.reject(error);
  };
  const check = () => {
    const time = now();
    const paused = time - lastTick > maxPauseMs;
    lastTick = time;
    for (const [key, entry] of entries) {
      if (paused || time - entry.lastUse > idleMs) drop(key, entry);
    }
  };
  const heartbeat = setInterval(check, Math.min(5000, maxPauseMs / 2));
  heartbeat.unref?.();
  return {
    async read(key, query) {
      if (!key || typeof query.onSnapshot !== 'function') return query.get();
      check();
      let entry = entries.get(key);
      if (!entry) {
        if (entries.size >= maxEntries) {
          const [oldKey, old] = [...entries].sort((a, b) => a[1].lastUse - b[1].lastUse)[0];
          drop(oldKey, old);
        }
        entry = { lastUse: now(), snapshot: null, stop: null };
        entry.ready = new Promise((resolve, reject) => { entry.resolve = resolve; entry.reject = reject; });
        entry.ready.catch(() => {});
        entries.set(key, entry);
        entry.timeout = setTimeout(() => drop(key, entry, new Error('Display listener startup timeout')), startupMs);
        entry.timeout.unref?.();
        try {
          entry.stop = query.onSnapshot(snapshot => {
            if (entries.get(key) !== entry) return;
            clearTimeout(entry.timeout);
            entry.snapshot = snapshot;
            entry.resolve(snapshot);
          }, error => drop(key, entry, error));
          // Some test/adaptor implementations report failure synchronously.
          if (entries.get(key) !== entry) entry.stop?.();
        } catch (error) { drop(key, entry, error); }
      }
      entry.lastUse = now();
      try { return entry.snapshot || await entry.ready; }
      catch { return query.get(); } // no stale-on-error for business displays
    },
    close() {
      clearInterval(heartbeat);
      for (const [key, entry] of entries) drop(key, entry);
    },
  };
}

let shared;
function readDisplaySnapshot(query, { tenantId, collection }) {
  if (!tenantId || !collection) throw new Error('Display cache requires tenant and collection');
  if (process.env.DISPLAY_SNAPSHOT_CACHE === 'off') return query.get();
  shared ||= createDisplaySnapshotCache();
  return shared.read(JSON.stringify([tenantId, collection]), query);
}
module.exports = { createDisplaySnapshotCache, readDisplaySnapshot };

// Module-scoped flag the Capture wizard sets while a long-running identify call
// is in flight. Other parts of the app (e.g. App.tsx products polling) read this
// to suppress concurrent fetches that would otherwise race the same Cloud-Run
// connection limit and produce spurious "Failed to fetch" toasts during a 30-180s
// identify request.
//
// Implemented as a tiny pub/sub so consumers can subscribe to changes (React
// useSyncExternalStore) without prop drilling or extra context providers.
//
// Single source of truth: the boolean below. setIdentifyRunning(true) is
// idempotent — if multiple identify calls overlap (multi-group capture), we
// reference-count so the flag drops only after ALL of them finish.

let activeCount = 0;
const listeners = new Set<() => void>();

const notify = () => {
  for (const fn of listeners) {
    try {
      fn();
    } catch (err) {
      // Defensive: a bad subscriber must not break others.
      console.warn("[identifyRunFlag] listener threw:", err);
    }
  }
};

/**
 * Mark an identify call as running. Returns a "release" function that the
 * caller MUST invoke (in finally) so the flag stays accurate even if the call
 * throws or the component unmounts mid-run.
 */
export function beginIdentifyRun(): () => void {
  activeCount += 1;
  if (activeCount === 1) notify();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeCount = Math.max(0, activeCount - 1);
    if (activeCount === 0) notify();
  };
}

/** Read current state synchronously. */
export function isIdentifyRunning(): boolean {
  return activeCount > 0;
}

/** Subscribe to changes (returns an unsubscribe fn). Used by React hooks. */
export function subscribeIdentifyRun(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * useSystemAlerts — HARDEN-Wave-9 (2026-05-22).
 *
 * Polls GET /api/admin/alerts/recent?days=1 every 60s and returns the count
 * of unresolved stock-failure alerts. Used by the Topbar Bell-Badge.
 *
 * Defensive design:
 *  - Only polls when `enabled` is true (caller passes user.isAdmin)
 *  - Backoff to 5min after consecutive errors (avoids 401-spam for non-admins)
 *  - Initial result = null; UI should treat null as "loading / unknown"
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { adminListRecentAlerts, type AdminStockFailureAlert } from "../api/client";

export interface UseSystemAlertsResult {
  count: number | null;
  latest: AdminStockFailureAlert[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

const NORMAL_INTERVAL_MS = 60_000;
const BACKOFF_INTERVAL_MS = 5 * 60_000;
const MAX_LATEST = 5;

export function useSystemAlerts(enabled: boolean): UseSystemAlertsResult {
  const [count, setCount] = useState<number | null>(null);
  const [latest, setLatest] = useState<AdminStockFailureAlert[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorStreakRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const load = useCallback(async () => {
    if (!enabledRef.current) return;
    setLoading(true);
    try {
      const res = await adminListRecentAlerts(1);
      setCount(res.total);
      setLatest((res.alerts || []).slice(0, MAX_LATEST));
      setError(null);
      errorStreakRef.current = 0;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      errorStreakRef.current += 1;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setCount(null);
      setLatest([]);
      setError(null);
      return;
    }
    void load();
    const tick = () => {
      void load();
      const next = errorStreakRef.current >= 2 ? BACKOFF_INTERVAL_MS : NORMAL_INTERVAL_MS;
      timerRef.current = window.setTimeout(tick, next) as unknown as number;
    };
    timerRef.current = window.setTimeout(tick, NORMAL_INTERVAL_MS) as unknown as number;
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [enabled, load]);

  return { count, latest, loading, error, refresh: load };
}

export default useSystemAlerts;

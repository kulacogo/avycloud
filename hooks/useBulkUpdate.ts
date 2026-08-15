import { useState, useCallback } from "react";
import {
  bulkUpdateProducts,
  type BulkFieldUpdate,
  type BulkUpdateResult,
  type BulkUpdateDiffEntry,
} from "../api/client";

interface UseBulkUpdateReturn {
  loading: boolean;
  error: string | null;
  preview: BulkUpdateDiffEntry[] | null;
  result: BulkUpdateResult["data"] | null;
  executeDryRun: (productIds: string[], updates: BulkFieldUpdate[]) => Promise<void>;
  /** true = wirklich geschrieben. Der Aufrufer darf Eingaben nur dann verwerfen. */
  executeCommit: (productIds: string[], updates: BulkFieldUpdate[]) => Promise<boolean>;
  reset: () => void;
}

export function useBulkUpdate(): UseBulkUpdateReturn {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<BulkUpdateDiffEntry[] | null>(null);
  const [result, setResult] = useState<BulkUpdateResult["data"] | null>(null);

  const executeDryRun = useCallback(async (productIds: string[], updates: BulkFieldUpdate[]) => {
    setLoading(true);
    setError(null);
    setPreview(null);
    try {
      const res = await bulkUpdateProducts({ productIds, updates, dryRun: true });
      if (!res.ok) {
        setError(res.error?.message || "Vorschau fehlgeschlagen");
        return;
      }
      setPreview(res.data?.diff || []);
    } catch (err: any) {
      setError(err?.message || "Vorschau fehlgeschlagen");
    } finally {
      setLoading(false);
    }
  }, []);

  const executeCommit = useCallback(async (productIds: string[], updates: BulkFieldUpdate[]) => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await bulkUpdateProducts({ productIds, updates, dryRun: false });
      if (!res.ok) {
        setError(res.error?.message || "Bulk-Update fehlgeschlagen");
        return false;
      }
      setResult(res.data || null);
      return true;
    } catch (err: any) {
      setError(err?.message || "Bulk-Update fehlgeschlagen");
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  const reset = useCallback(() => {
    setLoading(false);
    setError(null);
    setPreview(null);
    setResult(null);
  }, []);

  return { loading, error, preview, result, executeDryRun, executeCommit, reset };
}

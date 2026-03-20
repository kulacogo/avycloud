import { useCallback, useEffect, useRef, useState } from "react";
import {
  listRules, createRule, updateRule, deleteRule, toggleRule,
  executeRuleApi, getJobStatus, previewRule,
  type RuleData, type RuleJobData,
} from "../api/client";

export function useRules() {
  const [rules, setRules] = useState<RuleData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listRules();
      setRules(data);
    } catch (err: any) {
      setError(err?.message || "Regeln konnten nicht geladen werden");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleCreate = useCallback(async (data: Partial<RuleData>) => {
    const created = await createRule(data);
    setRules((prev) => [created, ...prev]);
    return created;
  }, []);

  const handleUpdate = useCallback(async (ruleId: string, data: Partial<RuleData>) => {
    const updated = await updateRule(ruleId, data);
    setRules((prev) => prev.map((r) => (r.id === ruleId ? updated : r)));
    return updated;
  }, []);

  const handleDelete = useCallback(async (ruleId: string) => {
    await deleteRule(ruleId);
    setRules((prev) => prev.filter((r) => r.id !== ruleId));
  }, []);

  const handleToggle = useCallback(async (ruleId: string) => {
    const result = await toggleRule(ruleId);
    setRules((prev) => prev.map((r) => (r.id === ruleId ? { ...r, active: result.active } : r)));
    return result;
  }, []);

  const handleExecute = useCallback(async (
    ruleId: string,
    mode: "execute" | "dry_run",
    onProgress?: (job: RuleJobData) => void,
  ): Promise<RuleJobData> => {
    const { jobId } = await executeRuleApi(ruleId, mode);

    // Poll for completion
    return new Promise((resolve, reject) => {
      const poll = async () => {
        try {
          const job = await getJobStatus(jobId);
          onProgress?.(job);
          if (job.status === "done" || job.status === "failed") {
            if (job.status === "done") {
              await load(); // Refresh rule stats
            }
            resolve(job);
          } else {
            setTimeout(poll, 2000);
          }
        } catch (err: any) {
          reject(err);
        }
      };
      setTimeout(poll, 500);
    });
  }, [load]);

  const handlePreview = useCallback(async (ruleId: string, limit = 20) => {
    return previewRule(ruleId, limit);
  }, []);

  return {
    rules, loading, error, reload: load,
    create: handleCreate,
    update: handleUpdate,
    remove: handleDelete,
    toggle: handleToggle,
    execute: handleExecute,
    preview: handlePreview,
  };
}

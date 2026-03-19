import { useState, useCallback, useEffect } from "react";
import {
  fetchAllPricingRules,
  createPricingRule,
  deletePricingRule as apiDeleteRule,
  togglePricingRule as apiToggleRule,
} from "../api/client";

export interface PricingRule {
  id: string;
  productId: string;
  ruleType: string;
  params: Record<string, any>;
  active: boolean;
  lastApplied: string | null;
  updatedAt: string;
}

export function usePricingRules() {
  const [rules, setRules] = useState<PricingRule[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const listRules = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchAllPricingRules();
      setRules(data as PricingRule[]);
    } catch (err: any) {
      setError(err?.message || "Fehler beim Laden der Regeln");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    listRules();
  }, [listRules]);

  const addRule = useCallback(
    async (rule: { productId: string; ruleType: string; params?: Record<string, any> }) => {
      setError(null);
      try {
        await createPricingRule(rule);
        await listRules();
      } catch (err: any) {
        setError(err?.message || "Fehler beim Erstellen der Regel");
        throw err;
      }
    },
    [listRules]
  );

  const deleteRule = useCallback(
    async (ruleId: string) => {
      setError(null);
      try {
        await apiDeleteRule(ruleId);
        setRules((prev) => prev.filter((r) => r.id !== ruleId));
      } catch (err: any) {
        setError(err?.message || "Fehler beim Löschen der Regel");
        throw err;
      }
    },
    []
  );

  const toggleRule = useCallback(
    async (ruleId: string) => {
      setError(null);
      try {
        const result = await apiToggleRule(ruleId);
        setRules((prev) =>
          prev.map((r) => (r.id === ruleId ? { ...r, active: result.active } : r))
        );
      } catch (err: any) {
        setError(err?.message || "Fehler beim Umschalten der Regel");
        throw err;
      }
    },
    []
  );

  return { rules, loading, error, listRules, addRule, deleteRule, toggleRule };
}

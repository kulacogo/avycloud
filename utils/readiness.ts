import type { Readiness } from "../types";

/**
 * Single source of truth for the product-datasheet status.
 *
 * Exactly THREE states, always in German, identical everywhere (table, sheet,
 * inventory). An empty/missing status is shown as "Ausstehend" — never blank.
 */
export type ReadinessState = "ready" | "in_progress" | "pending";

export const READINESS_LABELS: Record<ReadinessState, string> = {
  ready: "Bereit",
  in_progress: "In Bearbeitung",
  pending: "Ausstehend",
};

// null / undefined / "pending" / anything unknown → "pending" (Ausstehend)
export function normalizeReadiness(value?: Readiness | string | null): ReadinessState {
  if (value === "ready") return "ready";
  if (value === "in_progress") return "in_progress";
  return "pending";
}

export function readinessLabel(value?: Readiness | string | null): string {
  return READINESS_LABELS[normalizeReadiness(value)];
}

// Tailwind design-token classes per state (dim background + status color).
export function readinessBadgeClasses(value?: Readiness | string | null): string {
  switch (normalizeReadiness(value)) {
    case "ready":
      return "bg-success-dim text-success";
    case "in_progress":
      return "bg-info-dim text-info";
    default:
      return "bg-warning-dim text-warning";
  }
}

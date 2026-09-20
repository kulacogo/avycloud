import type { PerformanceDataQuality, PerformanceRow, SupportPerformance } from "../../api/client";
import { METRICS } from "./teamWorkspaceModel.ts";
import { creditedCount, CONTRIBUTION_WEIGHTS, SUPPORT_WEIGHT } from "./workContribution.ts";

export function activityDetails(row: PerformanceRow, quality?: PerformanceDataQuality, version?: number, rated = false) {
  return METRICS.map((metric) => {
    const source = metric.key === "erfasst" || metric.key === "angereichert" ? "audit" : metric.key === "eingelagert" ? "warehouse" : "orders";
    const available = quality?.sources?.[source] !== "unavailable" && (metric.key !== "angereichert" || version === 3);
    const count = available ? creditedCount(row, metric.key) : null;
    return { ...metric, count, points: rated && count !== null ? count * CONTRIBUTION_WEIGHTS[metric.key] : null };
  });
}

export function supportChannelView(source: SupportPerformance["channels"]["ebay"]) {
  const available = source.status === "complete" || source.status === "limited";
  const count = available && typeof source.cases === "number" && Number.isFinite(source.cases) ? Math.max(0, source.cases) : null;
  const replies = available && typeof source.replies === "number" && Number.isFinite(source.replies) ? Math.max(0, source.replies) : null;
  return {
    count, replies, points: count === null ? null : count * SUPPORT_WEIGHT,
    partial: source.status === "limited",
    label: source.status === "complete" ? "Verbunden" : source.status === "limited" ? "Unvollständig" : source.status === "connection_required" ? "Nicht verbunden" : "Nicht verfügbar",
  };
}

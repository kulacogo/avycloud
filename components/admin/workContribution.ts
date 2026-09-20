import type { AdminUserRecord, PerformanceRow } from "../../api/client";
import {
  METRICS,
  metricValue,
  userId,
  hasActivity,
} from "./teamWorkspaceModel.ts";

// Owner's effort order: enrichment/readiness > photos/capture > packing > pick.
// These are effort tiers, not measured time ratios or quality/attendance grades.
export const CONTRIBUTION_MODEL_VERSION = "Aufwandsstufen";
export const CONTRIBUTION_WEIGHTS = {
  erfasst: 3,
  eingelagert: 1,
  kommissioniert: 1,
  verpackt: 2,
  angereichert: 4,
} as const;
export function creditedCount(
  row: PerformanceRow,
  key: keyof typeof CONTRIBUTION_WEIGHTS,
) {
  const count = metricValue(row, key);
  const edited = Number.isFinite(row.productCareEdited)
    ? Math.max(0, row.productCareEdited!)
    : 0;
  return key === "angereichert" ? Math.min(count, edited) : count;
}
export function contributionPoints(row: PerformanceRow) {
  return METRICS.reduce(
    (total, metric) =>
      total + creditedCount(row, metric.key) * CONTRIBUTION_WEIGHTS[metric.key],
    0,
  );
}
export type ContributionRow = PerformanceRow & {
  points: number | null;
  share: number | null;
  status: "rated" | "no_activity" | "historical" | "incomplete" | "unverified";
  role: string;
};
export function buildContributions(
  rows: PerformanceRow[],
  users: AdminUserRecord[],
  complete?: boolean,
): ContributionRow[] {
  const directory = new Map(users.map((user) => [userId(user), user]));
  const scores: ContributionRow[] = rows.map((row) => {
    const account = directory.get(row.uid);
    const points = contributionPoints(row);
    const status =
      complete !== true
        ? "incomplete"
        : !account || account.disabled
          ? "historical"
          : points > 0
            ? "rated"
            : hasActivity(row)
              ? "unverified"
              : "no_activity";
    return {
      ...row,
      role: account?.roles?.[0] || "unassigned",
      points: status === "rated" || status === "no_activity" ? points : null,
      share: null,
      status,
    };
  });
  const total = scores.reduce((sum, row) => sum + (row.points || 0), 0);
  return scores
    .map((row) => ({
      ...row,
      share:
        row.status === "rated" && total > 0
          ? (row.points! / total) * 100
          : null,
    }))
    .sort(
      (a, b) =>
        (b.points ?? -1) - (a.points ?? -1) ||
        a.name.localeCompare(b.name, "de"),
    );
}
export const CONTRIBUTION_STATUS = {
  rated: "Arbeitsbeitrag",
  no_activity: "Keine Tätigkeit erfasst",
  historical: "Historisches Konto · ohne Bewertung",
  incomplete: "Daten nicht vollständig",
  unverified: "Nur Speicherungen dokumentiert",
} as const;

import React from "react";
import { Product } from "../types";

interface IdentifyV4BadgeProps {
  product: Product;
  compact?: boolean;
}

interface V4Meta {
  pipeline?: string;
  waves?: Array<{ wave: number; workers: string[]; durationMs: number; refinement?: boolean }>;
  confidence?: {
    overall?: number;
    readyForPublish?: boolean;
    fieldScores?: Record<string, { score: number; passes?: boolean }>;
    missingCritical?: string[];
  };
  critic?: {
    ebay_ready_score?: number;
    issues?: Array<{ field: string; severity: "error" | "warning"; message: string }>;
  };
  needsHumanReview?: boolean;
  durationMs?: number;
}

function extractV4Meta(product: Product): V4Meta | null {
  const dq = product?.ops?.data_quality;
  if (!dq || typeof dq !== "object") return null;
  const v4 = (dq as Record<string, any>).identify_v4;
  if (!v4 || typeof v4 !== "object") return null;
  return v4 as V4Meta;
}

const scoreColorClass = (score: number | undefined): string => {
  if (score == null) return "text-txt-muted";
  if (score >= 0.85) return "text-success";
  if (score >= 0.6) return "text-warning";
  return "text-danger";
};

const scoreBgClass = (score: number | undefined): string => {
  if (score == null) return "bg-app-elevated/50";
  if (score >= 0.85) return "bg-success-dim";
  if (score >= 0.6) return "bg-warning-dim";
  return "bg-danger-dim";
};

/**
 * Renders a compact V4-provenance badge + optional needs-human-review banner
 * based on `product.ops.data_quality.identify_v4`. Safely returns null when
 * the product was produced by V3 or earlier (no V4 metadata).
 */
const IdentifyV4Badge: React.FC<IdentifyV4BadgeProps> = ({ product, compact = false }) => {
  const meta = extractV4Meta(product);
  if (!meta) return null;

  const readyScore = meta.critic?.ebay_ready_score;
  const overall = meta.confidence?.overall;
  const needsReview = Boolean(meta.needsHumanReview) ||
    (typeof readyScore === "number" && readyScore < 0.8);
  const missingCritical = meta.confidence?.missingCritical || [];
  const issues = (meta.critic?.issues || []).slice(0, 3);

  if (compact) {
    return (
      <span
        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-mono uppercase ${scoreBgClass(
          readyScore
        )} ${scoreColorClass(readyScore)}`}
        title={
          readyScore != null
            ? `V4 · eBay-ready ${(readyScore * 100).toFixed(0)}%${overall != null ? ` · confidence ${(overall * 100).toFixed(0)}%` : ""}`
            : "V4"
        }
      >
        V4
        {readyScore != null && <span>{(readyScore * 100).toFixed(0)}%</span>}
      </span>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-mono uppercase ${scoreBgClass(
            readyScore
          )} ${scoreColorClass(readyScore)}`}
        >
          V4
          {readyScore != null && (
            <span className="font-semibold">
              eBay-ready {(readyScore * 100).toFixed(0)}%
            </span>
          )}
        </span>
        {overall != null && (
          <span className="text-[11px] text-txt-muted">
            Confidence: <span className={scoreColorClass(overall)}>{(overall * 100).toFixed(0)}%</span>
          </span>
        )}
        {meta.durationMs != null && (
          <span className="text-[11px] text-txt-muted">
            {(meta.durationMs / 1000).toFixed(1)}s
          </span>
        )}
        {Array.isArray(meta.waves) && meta.waves.length > 0 && (
          <span className="text-[11px] text-txt-muted">
            {meta.waves.length} waves
          </span>
        )}
      </div>

      {needsReview && (
        <div className="rounded-lg bg-warning-dim border border-warning/30 px-3 py-2 text-xs">
          <p className="font-semibold text-warning">
            ⚠️ Manuelle Pr&uuml;fung empfohlen
          </p>
          {missingCritical.length > 0 && (
            <p className="mt-1 text-txt-secondary">
              Kritische Felder mit niedriger Konfidenz:{" "}
              <span className="font-mono">{missingCritical.join(", ")}</span>
            </p>
          )}
          {issues.length > 0 && (
            <ul className="mt-1 ml-4 list-disc space-y-0.5 text-txt-muted">
              {issues.map((issue, i) => (
                <li key={i}>
                  <span
                    className={`font-mono ${issue.severity === "error" ? "text-danger" : "text-warning"}`}
                  >
                    [{issue.severity}]
                  </span>{" "}
                  <span className="font-mono">{issue.field}</span>: {issue.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};

export const FieldConfidenceBadge: React.FC<{
  product: Product;
  field: string;
}> = ({ product, field }) => {
  const meta = extractV4Meta(product);
  const entry = meta?.confidence?.fieldScores?.[field];
  if (!entry || typeof entry.score !== "number") return null;
  const pct = Math.round(entry.score * 100);
  return (
    <span
      className={`ml-1.5 inline-block h-1.5 w-1.5 rounded-full ${
        entry.score >= 0.85
          ? "bg-success"
          : entry.score >= 0.6
            ? "bg-warning"
            : "bg-danger"
      }`}
      title={`V4 confidence: ${pct}%`}
      aria-label={`Confidence ${pct}%`}
    />
  );
};

export default IdentifyV4Badge;

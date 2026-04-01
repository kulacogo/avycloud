import React, { useCallback } from "react";
import type { Product, ValidationResults, ValidationMarketplaceResult, ValidationIssue } from "../types";
import { useValidation } from "../hooks/useValidation";
import { Spinner } from "./Spinner";
import { useI18n } from "../i18n";

interface ValidationPanelProps {
  product: Product;
}

/* ── Score badge ────────────────────────────────────────── */

function ScoreBadge({ score, ready }: { score: number; ready: boolean }) {
  let bg: string;
  let text: string;
  let label: string;

  if (ready && score >= 90) {
    bg = "bg-success-dim";
    text = "text-success";
    label = "Bereit";
  } else if (score >= 70) {
    bg = "bg-warning-dim";
    text = "text-warning";
    label = "Eingeschraenkt";
  } else {
    bg = "bg-danger-dim";
    text = "text-danger";
    label = "Nicht bereit";
  }

  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold ${bg} ${text}`}>
      <span>{score}%</span>
      <span className="hidden sm:inline">{label}</span>
    </span>
  );
}

/* ── Severity icon ──────────────────────────────────────── */

function SeverityIcon({ severity }: { severity: string }) {
  if (severity === "error") {
    return (
      <svg className="w-4 h-4 text-danger flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
      </svg>
    );
  }
  if (severity === "warning") {
    return (
      <svg className="w-4 h-4 text-warning flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
      </svg>
    );
  }
  return (
    <svg className="w-4 h-4 text-info flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" />
    </svg>
  );
}

/* ── Issue row ──────────────────────────────────────────── */

function IssueRow({ issue }: { issue: ValidationIssue }) {
  const borderColor =
    issue.severity === "error"
      ? "border-danger"
      : issue.severity === "warning"
        ? "border-warning"
        : "border-info";

  return (
    <div className={`flex items-start gap-3 p-3 rounded-lg bg-app-elevated border-l-4 ${borderColor}`}>
      <SeverityIcon severity={issue.severity} />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-txt-primary">{issue.message}</p>
        {issue.suggestion && (
          <p className="text-xs text-txt-secondary mt-1">{issue.suggestion}</p>
        )}
        {issue.fields.length > 0 && (
          <p className="text-[10px] text-txt-muted mt-1 font-mono truncate">
            {issue.fields.slice(0, 3).join(", ")}
          </p>
        )}
      </div>
    </div>
  );
}

/* ── Marketplace section ────────────────────────────────── */

function MarketplaceSection({
  name,
  result,
}: {
  name: string;
  result: ValidationMarketplaceResult;
}) {
  const allIssues = [...result.errors, ...result.warnings, ...result.info];

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-txt-primary capitalize">{name}</span>
          <ScoreBadge score={result.score} ready={result.ready} />
        </div>
        <div className="flex items-center gap-3 text-xs text-txt-muted">
          {result.counts.errors > 0 && (
            <span className="text-danger">{result.counts.errors} Fehler</span>
          )}
          {result.counts.warnings > 0 && (
            <span className="text-warning">{result.counts.warnings} Warnungen</span>
          )}
          {result.counts.info > 0 && (
            <span className="text-info">{result.counts.info} Hinweise</span>
          )}
        </div>
      </div>

      {/* Issues */}
      {allIssues.length === 0 ? (
        <p className="text-sm text-success flex items-center gap-2">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          Alle Checks bestanden
        </p>
      ) : (
        <div className="space-y-2">
          {allIssues.map((issue, idx) => (
            <IssueRow key={`${issue.code}-${idx}`} issue={issue} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Listing Errors (persisted from eBay API) ──────────── */

interface ListingError {
  code?: string | null;
  message: string;
  severity?: string;
}

function ListingErrorsSection({ errors, at }: { errors: ListingError[]; at?: string }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-danger">eBay Listing-Fehler</span>
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-danger-dim text-danger">
            {errors.length} {errors.length === 1 ? "Fehler" : "Fehler"}
          </span>
        </div>
        {at && (
          <span className="text-[10px] text-txt-muted">
            {new Date(at).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" })}
          </span>
        )}
      </div>
      <div className="space-y-2">
        {errors.map((err, idx) => (
          <div key={idx} className="flex items-start gap-3 p-3 rounded-lg bg-app-elevated border-l-4 border-danger">
            <SeverityIcon severity="error" />
            <div className="flex-1 min-w-0">
              <p className="text-sm text-txt-primary">{err.message}</p>
              {err.code && err.code !== "READINESS" && (
                <p className="text-[10px] text-txt-muted mt-1 font-mono">Code: {err.code}</p>
              )}
            </div>
          </div>
        ))}
      </div>
      <p className="text-xs text-txt-muted">
        Diese Fehler wurden beim letzten eBay-Listing-Versuch von der eBay API zurueckgegeben. Beheben Sie die Probleme und listen Sie den Artikel erneut.
      </p>
    </div>
  );
}

/* ── Main Panel ─────────────────────────────────────────── */

const ValidationPanel: React.FC<ValidationPanelProps> = ({ product }) => {
  const { t } = useI18n();
  const { loading, results, error, runValidation } = useValidation();

  const handleValidate = useCallback(() => {
    runValidation(product, ["ebay", "kaufland"]);
  }, [product, runValidation]);

  // Read persisted listing errors from product document
  const ebayData = (product as unknown as Record<string, unknown>)?.marketplace as Record<string, unknown> | undefined;
  const ebayMp = ebayData?.ebay as Record<string, unknown> | undefined;
  const listingErrors = Array.isArray(ebayMp?.listing_errors) ? (ebayMp.listing_errors as ListingError[]) : [];
  const listingErrorsAt = typeof ebayMp?.listing_errors_at === "string" ? ebayMp.listing_errors_at : undefined;

  return (
    <section className="p-5 bg-app-surface border border-app-border rounded-2xl">
      {/* Panel header */}
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-txt-muted uppercase tracking-wide">
          {t("validation.title")}
        </h3>
        <button
          type="button"
          onClick={handleValidate}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-accent-dim text-accent hover:bg-accent/20 transition-colors disabled:opacity-40"
        >
          {loading ? (
            <>
              <Spinner className="w-3.5 h-3.5" />
              {t("validation.running")}
            </>
          ) : (
            <>
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              {t("validation.run")}
            </>
          )}
        </button>
      </div>

      {/* Persisted eBay listing errors (from last publish attempt) */}
      {listingErrors.length > 0 && (
        <div className="mb-5">
          <ListingErrorsSection errors={listingErrors} at={listingErrorsAt} />
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="p-3 rounded-lg bg-danger-dim text-danger text-sm mb-4">
          {error}
        </div>
      )}

      {/* No results yet */}
      {!results && !loading && !error && listingErrors.length === 0 && (
        <p className="text-sm text-txt-muted">
          {t("validation.hint")}
        </p>
      )}

      {/* Results */}
      {results && (
        <div className="space-y-6">
          {results.ebay && (
            <MarketplaceSection name="eBay" result={results.ebay} />
          )}
          {results.kaufland && (
            <>
              {results.ebay && (
                <div className="border-t border-app-border" />
              )}
              <MarketplaceSection name="Kaufland" result={results.kaufland} />
            </>
          )}
        </div>
      )}
    </section>
  );
};

export default ValidationPanel;

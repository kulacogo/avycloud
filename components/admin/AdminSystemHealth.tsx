/**
 * AdminSystemHealth — HARDEN-Wave-9 (2026-05-22).
 *
 * Operator-Dashboard mit vier Kacheln:
 *  - Stock-Sync-Alerts (Drain-Failures)
 *  - KI-Kosten heute
 *  - KI-Qualität
 *  - Externe APIs (SerpAPI/BrightData)
 *
 * Auto-Refresh alle 30s. Drill-Down via Modal pro Karte.
 * Quelle: GET /api/admin/system-health + GET /api/admin/alerts/recent
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  adminGetSystemHealth,
  adminListRecentAlerts,
  type AdminSystemHealthResponse,
  type AdminSystemHealthDrain,
  type AdminSystemHealthLlm,
  type AdminSystemHealthExternalApis,
  type AdminStockFailureAlert,
} from "../../api/client";

const REFRESH_INTERVAL_MS = 30_000;

type DrillDown = "drain" | "llm" | "externalApis" | null;

function isError<T>(v: T | { error: string } | null | undefined): v is { error: string } {
  return Boolean(v && typeof v === "object" && "error" in v);
}

function formatRelative(iso?: string | null): string {
  if (!iso) return "—";
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return "—";
  const diffSec = Math.round((Date.now() - ts) / 1000);
  if (diffSec < 60) return `vor ${diffSec}s`;
  if (diffSec < 3600) return `vor ${Math.round(diffSec / 60)} Min`;
  if (diffSec < 86400) return `vor ${Math.round(diffSec / 3600)} Std`;
  return `vor ${Math.round(diffSec / 86400)} Tagen`;
}

function formatEuro(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("de-DE", { style: "currency", currency: "USD" }).format(n);
}

function formatNum(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("de-DE").format(Math.round(n));
}

function formatPct(n: number | null | undefined, digits = 0): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(digits)}%`;
}

function formatMs(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n < 1000) return `${Math.round(n)} ms`;
  return `${(n / 1000).toFixed(1)} s`;
}

/* ─── Tile-Komponenten ─────────────────────────────────────────── */

interface TileShellProps {
  icon: string;
  title: string;
  tone?: "default" | "alert" | "success" | "warning";
  onOpenDetail?: () => void;
  children: React.ReactNode;
}

const TileShell: React.FC<TileShellProps> = ({ icon, title, tone = "default", onOpenDetail, children }) => {
  const toneClass =
    tone === "alert"
      ? "border-danger/40 bg-danger-dim"
      : tone === "warning"
      ? "border-warning/40 bg-warning-dim"
      : tone === "success"
      ? "border-success/40 bg-success-dim"
      : "border-app-border bg-app-surface";
  return (
    <div className={`flex flex-col rounded-xl border ${toneClass} p-4 shadow-sm transition-shadow hover:shadow-md`}>
      <div className="mb-3 flex items-center gap-2">
        <span className="text-xl" aria-hidden="true">{icon}</span>
        <h3 className="text-sm font-semibold text-txt-primary">{title}</h3>
      </div>
      <div className="flex-1">{children}</div>
      {onOpenDetail && (
        <button
          type="button"
          onClick={onOpenDetail}
          className="mt-3 self-start rounded-md border border-app-border bg-app-surface/60 px-2.5 py-1 text-xs font-medium text-txt-secondary transition-colors hover:bg-app-elevated hover:text-txt-primary focus:outline-none focus:ring-2 focus:ring-accent"
        >
          Details
        </button>
      )}
    </div>
  );
};

const DrainTile: React.FC<{ drain: AdminSystemHealthDrain | { error: string } | null; onOpenDetail: () => void }> = ({ drain, onOpenDetail }) => {
  if (!drain) {
    return (
      <TileShell icon="🚨" title="Stock-Sync-Alerts">
        <p className="text-sm text-txt-muted">Lade…</p>
      </TileShell>
    );
  }
  if (isError(drain)) {
    return (
      <TileShell icon="🚨" title="Stock-Sync-Alerts" tone="warning">
        <p className="text-xs text-txt-secondary">Daten gerade nicht verfügbar.</p>
      </TileShell>
    );
  }
  const hasIssues = drain.abandoned_24h > 0 || drain.needs_manual_24h > 0;
  return (
    <TileShell icon="🚨" title="Stock-Sync-Alerts" tone={hasIssues ? "alert" : "success"} onOpenDetail={onOpenDetail}>
      <div className="space-y-1.5">
        <div className="flex items-baseline gap-2">
          <span className="text-3xl font-semibold text-txt-primary">{formatNum(drain.total_alerts_24h)}</span>
          <span className="text-xs text-txt-muted">in 24 Stunden</span>
        </div>
        <div className="space-y-0.5 text-xs text-txt-secondary">
          <div>Abgebrochen: <strong className="text-txt-primary">{formatNum(drain.abandoned_24h)}</strong> heute · {formatNum(drain.abandoned_7d)} (7 T)</div>
          <div>Manuelle Aktion nötig: <strong className="text-txt-primary">{formatNum(drain.needs_manual_24h)}</strong> heute · {formatNum(drain.needs_manual_7d)} (7 T)</div>
          {drain.latest && (
            <div className="pt-1 text-[11px] text-txt-muted">
              Letzter: {drain.latest.terminalStatus?.toUpperCase()} · {formatRelative(drain.latest.createdAt)}
            </div>
          )}
        </div>
      </div>
    </TileShell>
  );
};

const LlmTile: React.FC<{ llm: AdminSystemHealthLlm | { error: string } | null; onOpenDetail: () => void }> = ({ llm, onOpenDetail }) => {
  if (!llm) {
    return (
      <TileShell icon="💸" title="KI-Kosten heute">
        <p className="text-sm text-txt-muted">Lade…</p>
      </TileShell>
    );
  }
  if (isError(llm)) {
    return (
      <TileShell icon="💸" title="KI-Kosten heute" tone="warning">
        <p className="text-xs text-txt-secondary">Daten gerade nicht verfügbar.</p>
      </TileShell>
    );
  }
  return (
    <TileShell icon="💸" title="KI-Kosten heute" onOpenDetail={onOpenDetail}>
      <div className="space-y-1.5">
        <div className="flex items-baseline gap-2">
          <span className="text-3xl font-semibold text-txt-primary">{formatEuro(llm.totalCostUsd_24h)}</span>
          <span className="text-xs text-txt-muted">in 24 Stunden</span>
        </div>
        <div className="space-y-0.5 text-xs text-txt-secondary">
          <div>{formatNum(llm.calls_24h)} KI-Anfragen · Ø {formatMs(llm.avgLatencyMs)}</div>
          {llm.driftAlerts > 0 && (
            <div className="text-warning">
              ⚠ {llm.driftAlerts} Quality-Drift-Warnungen
            </div>
          )}
        </div>
      </div>
    </TileShell>
  );
};

const QualityTile: React.FC<{ llm: AdminSystemHealthLlm | { error: string } | null }> = ({ llm }) => {
  if (!llm) {
    return (
      <TileShell icon="📊" title="KI-Qualität">
        <p className="text-sm text-txt-muted">Lade…</p>
      </TileShell>
    );
  }
  if (isError(llm)) {
    return (
      <TileShell icon="📊" title="KI-Qualität" tone="warning">
        <p className="text-xs text-txt-secondary">Daten gerade nicht verfügbar.</p>
      </TileShell>
    );
  }
  const rate = llm.schemaValidRate;
  const tone: "default" | "success" | "warning" | "alert" =
    rate === null ? "default" : rate >= 0.95 ? "success" : rate >= 0.80 ? "warning" : "alert";
  return (
    <TileShell icon="📊" title="KI-Qualität" tone={tone}>
      <div className="space-y-1.5">
        <div className="flex items-baseline gap-2">
          <span className="text-3xl font-semibold text-txt-primary">{formatPct(rate, 1)}</span>
          <span className="text-xs text-txt-muted">Schema-OK-Rate</span>
        </div>
        <div className="text-xs text-txt-secondary">
          {llm.byPipeline.length > 0 ? (
            <>
              Pipelines aktiv: {llm.byPipeline.length}
              <div className="mt-1 space-y-0.5">
                {llm.byPipeline.slice(0, 3).map((p) => (
                  <div key={p.pipeline}>
                    {p.pipeline}: {formatNum(p.calls)} Calls · {formatMs(p.avgLatencyMs)}
                  </div>
                ))}
              </div>
            </>
          ) : (
            <>Noch keine KI-Calls in den letzten 24h.</>
          )}
        </div>
      </div>
    </TileShell>
  );
};

const ExternalApisTile: React.FC<{ apis: AdminSystemHealthExternalApis | { error: string } | null; onOpenDetail: () => void }> = ({ apis, onOpenDetail }) => {
  if (!apis) {
    return (
      <TileShell icon="🌐" title="Externe APIs">
        <p className="text-sm text-txt-muted">Lade…</p>
      </TileShell>
    );
  }
  if (isError(apis)) {
    return (
      <TileShell icon="🌐" title="Externe APIs" tone="warning">
        <p className="text-xs text-txt-secondary">Daten gerade nicht verfügbar.</p>
      </TileShell>
    );
  }
  const services = Object.entries(apis.byService);
  const totalCalls = services.reduce((sum, [, b]) => sum + b.total, 0);
  const anyDegraded = services.some(([, b]) => b.successRate !== null && b.successRate < 0.95);
  return (
    <TileShell icon="🌐" title="Externe APIs" tone={anyDegraded ? "warning" : services.length > 0 ? "success" : "default"} onOpenDetail={onOpenDetail}>
      <div className="space-y-1.5">
        <div className="flex items-baseline gap-2">
          <span className="text-3xl font-semibold text-txt-primary">{formatNum(totalCalls)}</span>
          <span className="text-xs text-txt-muted">Calls in 24 Std</span>
        </div>
        <div className="space-y-0.5 text-xs text-txt-secondary">
          {services.length === 0 && <div>Keine Calls registriert.</div>}
          {services.slice(0, 3).map(([name, b]) => (
            <div key={name} className={b.successRate !== null && b.successRate < 0.95 ? "text-warning" : undefined}>
              {name}: {formatPct(b.successRate)} OK · Ø {formatMs(b.avgLatencyMs)}
            </div>
          ))}
        </div>
      </div>
    </TileShell>
  );
};

/* ─── Drill-Down Modal ────────────────────────────────────────── */

interface DetailModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}

const DetailModal: React.FC<DetailModalProps> = ({ open, title, onClose, children }) => {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="presentation" onClick={onClose}>
      <div
        className="relative max-h-[85vh] w-full max-w-3xl overflow-hidden rounded-xl border border-app-border bg-app-surface shadow-2xl"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-app-border px-5 py-3.5">
          <h3 className="text-base font-semibold text-txt-primary">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Schließen"
            className="flex h-8 w-8 items-center justify-center rounded-md text-txt-secondary hover:bg-app-elevated hover:text-txt-primary focus:outline-none focus:ring-2 focus:ring-accent"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 6l12 12M6 18L18 6" />
            </svg>
          </button>
        </header>
        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>
  );
};

/* ─── Drill-Down: Drain-Alerts-Liste ─────────────────────────── */

const DrainDetail: React.FC = () => {
  const [alerts, setAlerts] = useState<AdminStockFailureAlert[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    (async () => {
      try {
        const res = await adminListRecentAlerts(7);
        setAlerts(res.alerts || []);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);
  if (err) return <p className="text-sm text-danger">{err}</p>;
  if (!alerts) return <p className="text-sm text-txt-muted">Lade…</p>;
  if (alerts.length === 0) return <p className="text-sm text-txt-secondary">Keine Alerts in den letzten 7 Tagen — alles ruhig.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="bg-app-elevated">
          <tr>
            <th className="border-b border-app-border px-3 py-2 text-left text-xs font-semibold text-txt-secondary">Wann</th>
            <th className="border-b border-app-border px-3 py-2 text-left text-xs font-semibold text-txt-secondary">Status</th>
            <th className="border-b border-app-border px-3 py-2 text-left text-xs font-semibold text-txt-secondary">Begründung</th>
            <th className="border-b border-app-border px-3 py-2 text-left text-xs font-semibold text-txt-secondary">Doc-ID</th>
          </tr>
        </thead>
        <tbody>
          {alerts.map((a) => (
            <tr key={a.id} className="border-b border-app-border last:border-b-0">
              <td className="px-3 py-2 text-xs text-txt-secondary">{formatRelative(a.createdAt)}</td>
              <td className="px-3 py-2 text-xs">
                <span className={`rounded px-2 py-0.5 text-[11px] font-semibold ${
                  a.terminalStatus === "abandoned" ? "bg-danger-dim text-danger" : "bg-warning-dim text-warning"
                }`}>
                  {a.terminalStatus?.toUpperCase()}
                </span>
              </td>
              <td className="px-3 py-2 text-xs text-txt-primary">{a.reason || "—"}</td>
              <td className="px-3 py-2 font-mono text-[11px] text-txt-muted">{a.failureDocId || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const LlmDetail: React.FC<{ llm: AdminSystemHealthLlm | { error: string } | null }> = ({ llm }) => {
  if (!llm || isError(llm)) return <p className="text-sm text-txt-secondary">Keine Daten verfügbar.</p>;
  if (llm.byPipeline.length === 0) return <p className="text-sm text-txt-secondary">Noch keine KI-Calls in den letzten 24h.</p>;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3 text-sm">
        <div className="rounded-lg bg-app-elevated p-3">
          <div className="text-[11px] uppercase text-txt-muted">Calls (24h)</div>
          <div className="mt-1 text-xl font-semibold text-txt-primary">{formatNum(llm.calls_24h)}</div>
        </div>
        <div className="rounded-lg bg-app-elevated p-3">
          <div className="text-[11px] uppercase text-txt-muted">Kosten (24h)</div>
          <div className="mt-1 text-xl font-semibold text-txt-primary">{formatEuro(llm.totalCostUsd_24h)}</div>
        </div>
        <div className="rounded-lg bg-app-elevated p-3">
          <div className="text-[11px] uppercase text-txt-muted">Schema-OK</div>
          <div className="mt-1 text-xl font-semibold text-txt-primary">{formatPct(llm.schemaValidRate, 1)}</div>
        </div>
      </div>
      <table className="min-w-full text-sm">
        <thead className="bg-app-elevated">
          <tr>
            <th className="border-b border-app-border px-3 py-2 text-left text-xs font-semibold text-txt-secondary">Pipeline</th>
            <th className="border-b border-app-border px-3 py-2 text-right text-xs font-semibold text-txt-secondary">Calls</th>
            <th className="border-b border-app-border px-3 py-2 text-right text-xs font-semibold text-txt-secondary">Kosten</th>
            <th className="border-b border-app-border px-3 py-2 text-right text-xs font-semibold text-txt-secondary">Ø Latenz</th>
          </tr>
        </thead>
        <tbody>
          {llm.byPipeline.map((p) => (
            <tr key={p.pipeline} className="border-b border-app-border last:border-b-0">
              <td className="px-3 py-2 font-mono text-xs text-txt-primary">{p.pipeline}</td>
              <td className="px-3 py-2 text-right text-xs text-txt-primary">{formatNum(p.calls)}</td>
              <td className="px-3 py-2 text-right text-xs text-txt-primary">{formatEuro(p.costUsd)}</td>
              <td className="px-3 py-2 text-right text-xs text-txt-primary">{formatMs(p.avgLatencyMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const ExternalApisDetail: React.FC<{ apis: AdminSystemHealthExternalApis | { error: string } | null }> = ({ apis }) => {
  if (!apis || isError(apis)) return <p className="text-sm text-txt-secondary">Keine Daten verfügbar.</p>;
  const services = Object.entries(apis.byService);
  if (services.length === 0) return <p className="text-sm text-txt-secondary">Keine externen API-Calls in den letzten 24h.</p>;
  return (
    <table className="min-w-full text-sm">
      <thead className="bg-app-elevated">
        <tr>
          <th className="border-b border-app-border px-3 py-2 text-left text-xs font-semibold text-txt-secondary">Service</th>
          <th className="border-b border-app-border px-3 py-2 text-right text-xs font-semibold text-txt-secondary">Calls</th>
          <th className="border-b border-app-border px-3 py-2 text-right text-xs font-semibold text-txt-secondary">Erfolg</th>
          <th className="border-b border-app-border px-3 py-2 text-right text-xs font-semibold text-txt-secondary">Ø Latenz</th>
          <th className="border-b border-app-border px-3 py-2 text-left text-xs font-semibold text-txt-secondary">Top-Fehler</th>
        </tr>
      </thead>
      <tbody>
        {services.map(([name, b]) => (
          <tr key={name} className="border-b border-app-border last:border-b-0">
            <td className="px-3 py-2 font-mono text-xs text-txt-primary">{name}</td>
            <td className="px-3 py-2 text-right text-xs text-txt-primary">{formatNum(b.total)}</td>
            <td className="px-3 py-2 text-right text-xs">
              <span className={(b.successRate ?? 0) < 0.95 ? "text-warning" : "text-success"}>
                {formatPct(b.successRate, 1)}
              </span>
            </td>
            <td className="px-3 py-2 text-right text-xs text-txt-primary">{formatMs(b.avgLatencyMs)}</td>
            <td className="px-3 py-2 text-xs text-txt-secondary">
              {b.topErrors.length === 0 ? "—" : b.topErrors.map((e) => `${e.code} (${e.count})`).join(", ")}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

/* ─── Main Component ──────────────────────────────────────────── */

export const AdminSystemHealth: React.FC = () => {
  const [data, setData] = useState<AdminSystemHealthResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastFetch, setLastFetch] = useState<number | null>(null);
  const [drill, setDrill] = useState<DrillDown>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await adminGetSystemHealth();
      setData(res);
      setLastFetch(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => { void load(); }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [load]);

  const lastFetchLabel = useMemo(() => {
    if (!lastFetch) return "—";
    return formatRelative(new Date(lastFetch).toISOString());
  }, [lastFetch]);

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-txt-primary">System-Status</h2>
          <p className="text-sm text-txt-secondary">
            Live-Übersicht über Bestand-Sync, KI-Kosten und externe Services.
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs text-txt-muted">
          {data?.health?.nodeEnv && (
            <span className="rounded-full border border-app-border bg-app-surface px-2 py-0.5 font-medium">
              {data.health.nodeEnv}
            </span>
          )}
          {data?.health?.slackAlertsConfigured ? (
            <span className="rounded-full border border-success/30 bg-success-dim px-2 py-0.5 font-medium text-success">
              Slack aktiv
            </span>
          ) : (
            <span className="rounded-full border border-app-border bg-app-elevated px-2 py-0.5 font-medium text-txt-muted">
              Slack inaktiv
            </span>
          )}
          <span>Aktualisiert {lastFetchLabel}</span>
          <button
            type="button"
            onClick={() => { void load(); }}
            disabled={loading}
            className="rounded-md border border-app-border bg-app-surface px-2.5 py-1 font-medium text-txt-secondary transition-colors hover:bg-app-elevated hover:text-txt-primary disabled:opacity-50"
          >
            {loading ? "…" : "Neu laden"}
          </button>
        </div>
      </header>

      {error && (
        <div className="rounded-lg border border-danger/30 bg-danger-dim p-3 text-sm">
          <p className="font-semibold text-danger">Status konnte nicht geladen werden</p>
          <p className="mt-1 text-txt-secondary">{error}</p>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        <DrainTile drain={data?.drain ?? null} onOpenDetail={() => setDrill("drain")} />
        <LlmTile llm={data?.llm ?? null} onOpenDetail={() => setDrill("llm")} />
        <QualityTile llm={data?.llm ?? null} />
        <ExternalApisTile apis={data?.externalApis ?? null} onOpenDetail={() => setDrill("externalApis")} />
      </div>

      {data?.health && (
        <details className="rounded-lg border border-app-border bg-app-surface p-3 text-xs text-txt-secondary">
          <summary className="cursor-pointer font-medium text-txt-primary">Konfiguration</summary>
          <dl className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            <div><dt className="inline text-txt-muted">LLM-Sample-Rate:</dt> <dd className="inline">{data.health.llmTelemetrySampleRate}</dd></div>
            <div><dt className="inline text-txt-muted">Background-Job-Tenants:</dt> <dd className="inline">{data.health.backgroundJobTenants}</dd></div>
            <div><dt className="inline text-txt-muted">Aggregat-Latenz:</dt> <dd className="inline">{formatMs(data.health.aggregateLatencyMs)}</dd></div>
            <div><dt className="inline text-txt-muted">Tenant:</dt> <dd className="inline font-mono">{data.tenantId}</dd></div>
          </dl>
        </details>
      )}

      <DetailModal open={drill === "drain"} title="Stock-Sync-Alerts (letzte 7 Tage)" onClose={() => setDrill(null)}>
        <DrainDetail />
      </DetailModal>
      <DetailModal open={drill === "llm"} title="KI-Kosten pro Pipeline (24h)" onClose={() => setDrill(null)}>
        <LlmDetail llm={data?.llm ?? null} />
      </DetailModal>
      <DetailModal open={drill === "externalApis"} title="Externe APIs (24h)" onClose={() => setDrill(null)}>
        <ExternalApisDetail apis={data?.externalApis ?? null} />
      </DetailModal>
    </div>
  );
};

export default AdminSystemHealth;

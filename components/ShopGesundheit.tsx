import React from "react";
import {
  adminGetSystemHealth,
  type AdminSystemHealthResponse,
  type AdminSystemHealthSync,
  type AdminSystemHealthDrain,
  type AdminSystemHealthLlm,
  type AdminSystemHealthExternalApis,
} from "../api/client";
import { AdminSystemHealth } from "./admin/AdminSystemHealth";

/**
 * Shop-Gesundheit — Operations-Dashboard (Status · KPIs · Service-Metriken).
 *
 * Aufbau nach gängiger Ops-Dashboard-Praxis: kompakte Status-Zeile, eine Reihe
 * Stat-Kacheln (Label · Wert · Kontext), darunter die Service-Tabelle mit echten
 * Metriken. Status immer Punkt + Text (nie Farbe allein). Die vollständige
 * Diagnose-Ansicht bleibt als "Erweiterte Diagnose" eingeklappt erreichbar.
 */

type Verdict = "ok" | "warn" | "critical" | "unknown";

const hasError = (x: unknown): x is { error: string } =>
  Boolean(x && typeof x === "object" && "error" in (x as Record<string, unknown>));

/** Gesamt-Status aus Sync-SLO (Backend-berechnet) + Drain-Alerts. */
export const computeVerdict = (
  sync?: AdminSystemHealthSync | { error: string } | null,
  drain?: AdminSystemHealthDrain | { error: string } | null
): Verdict => {
  const s = sync && !hasError(sync) ? (sync as AdminSystemHealthSync) : null;
  const d = drain && !hasError(drain) ? (drain as AdminSystemHealthDrain) : null;
  if (!s && !d) return "unknown";
  if (s?.status === "critical") return "critical";
  if (d && (d.abandoned_24h > 0 || d.needs_manual_24h > 0)) return "critical";
  if (s?.status === "warn") return "warn";
  if (d && d.total_alerts_24h > 0) return "warn";
  return "ok";
};

const VERDICT: Record<Verdict, { dot: string; text: string; label: string }> = {
  ok: { dot: "bg-success", text: "text-success", label: "Betriebsbereit" },
  warn: { dot: "bg-warning", text: "text-warning", label: "Sync-Verzögerung" },
  critical: { dot: "bg-danger", text: "text-danger", label: "Sync-Backlog kritisch" },
  unknown: { dot: "bg-txt-muted", text: "text-txt-muted", label: "Status unbekannt" },
};

const nf = new Intl.NumberFormat("de-DE");
const fmtCurrencyUsd = (v: number) =>
  new Intl.NumberFormat("de-DE", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(v);
const fmtPct = (v: number | null) => (v == null ? "–" : `${(v * 100).toFixed(1).replace(".", ",")} %`);
const fmtMs = (v: number | null | undefined) =>
  v == null ? "–" : v >= 1000 ? `${(v / 1000).toFixed(1).replace(".", ",")} s` : `${Math.round(v)} ms`;

/** Stat-Kachel: Label · Wert · Kontextzeile (optional mit Status-Färbung des Werts). */
const Stat: React.FC<{ label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: "default" | "success" | "warning" | "danger" }> = ({ label, value, sub, tone = "default" }) => {
  const toneCls =
    tone === "danger" ? "text-danger" : tone === "warning" ? "text-warning" : tone === "success" ? "text-success" : "text-txt-primary";
  return (
    <div className="rounded-xl border border-app-border bg-app-surface px-4 py-3.5">
      <div className="text-xs text-txt-muted">{label}</div>
      <div className={`mt-1 text-2xl font-semibold leading-none ${toneCls}`}>{value}</div>
      {sub ? <div className="mt-1.5 text-xs text-txt-muted">{sub}</div> : null}
    </div>
  );
};

const SERVICE_LABELS: Record<string, string> = {
  serpapi: "SerpAPI",
  brightdata: "BrightData",
  gemini: "Gemini",
  ebay: "eBay API",
  kaufland: "Kaufland API",
  sendcloud: "SendCloud",
  sevdesk: "SevDesk",
};

const serviceStatus = (rate: number | null): { label: string; dot: string; text: string } => {
  if (rate == null) return { label: "–", dot: "bg-txt-muted", text: "text-txt-muted" };
  if (rate >= 0.95) return { label: "Operational", dot: "bg-success", text: "text-txt-secondary" };
  if (rate >= 0.8) return { label: "Degraded", dot: "bg-warning", text: "text-warning" };
  return { label: "Ausfall", dot: "bg-danger", text: "text-danger" };
};

export const ShopGesundheit: React.FC = () => {
  const [data, setData] = React.useState<AdminSystemHealthResponse | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [showDiag, setShowDiag] = React.useState(false);
  const [updatedAt, setUpdatedAt] = React.useState<Date | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await adminGetSystemHealth());
      setUpdatedAt(new Date());
    } catch (e: any) {
      setError(e?.message || "Status konnte nicht geladen werden");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    load();
    const t = window.setInterval(load, 60_000);
    return () => window.clearInterval(t);
  }, [load]);

  const sync = data?.sync && !hasError(data.sync) ? (data.sync as AdminSystemHealthSync) : null;
  const drain = data?.drain && !hasError(data.drain) ? (data.drain as AdminSystemHealthDrain) : null;
  const ebayListingSync =
    data?.listingSync && !hasError(data.listingSync) ? data.listingSync.ebay || null : null;
  const llm = data?.llm && !hasError(data.llm) ? (data.llm as AdminSystemHealthLlm) : null;
  const ext = data?.externalApis && !hasError(data.externalApis) ? (data.externalApis as AdminSystemHealthExternalApis) : null;

  const verdict = computeVerdict(data?.sync, data?.drain);
  const v = VERDICT[verdict];

  const extTotals = React.useMemo(() => {
    if (!ext?.byService) return null;
    let total = 0;
    let failure = 0;
    for (const s of Object.values(ext.byService)) {
      total += s.total || 0;
      failure += s.failure || 0;
    }
    return { total, failure, errorRate: total > 0 ? failure / total : null };
  }, [ext]);

  const services = React.useMemo(
    () => Object.entries(ext?.byService || {}).sort((a, b) => (b[1].total || 0) - (a[1].total || 0)),
    [ext]
  );

  return (
    <div className="space-y-4">
      {/* Kopfzeile: Titel · Status · Stand */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-txt-primary">Shop-Gesundheit</h1>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-app-border bg-app-surface px-2.5 py-1 text-xs font-medium">
            <span className={`w-2 h-2 rounded-full ${v.dot}`} aria-hidden />
            <span className={v.text}>{v.label}</span>
          </span>
        </div>
        <div className="flex items-center gap-3 text-xs text-txt-muted">
          {updatedAt && <span>Stand {updatedAt.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>}
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="rounded-lg bg-app-elevated border border-white/[0.08] hover:bg-white/10 disabled:opacity-60 px-3 py-1.5 text-xs font-semibold text-txt-primary"
          >
            {loading ? "Lädt…" : "Aktualisieren"}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-danger/20 bg-danger-dim px-4 py-3 text-sm text-danger">{error}</div>
      )}

      {/* Alert-Banner nur bei Problemen */}
      {verdict === "critical" && (
        <div className="rounded-xl border border-danger/30 bg-danger-dim px-4 py-3 text-sm">
          <span className="font-semibold text-danger">Überverkauf-Risiko:</span>{" "}
          <span className="text-txt-primary">
            {sync && sync.pendingCount > 0
              ? `${nf.format(sync.pendingCount)} Bestands-Syncs im Backlog${sync.oldestAgeMinutes != null ? ` · ältester ${Math.round(sync.oldestAgeMinutes)} min` : ""}.`
              : "Fehlgeschlagene Bestands-Syncs erfordern manuelle Prüfung."}
            {drain && drain.needs_manual_24h > 0 ? ` ${nf.format(drain.needs_manual_24h)} Vorgänge benötigen manuelle Aktion.` : ""}
          </span>
        </div>
      )}

      {/* eBay-Angebots-Abgleich gestört (z. B. Token ungültig) */}
      {ebayListingSync && ebayListingSync.healthy === false && (
        <div className="rounded-xl border border-danger/30 bg-danger-dim px-4 py-3 text-sm">
          <span className="font-semibold text-danger">eBay-Angebots-Abgleich gestört:</span>{" "}
          <span className="text-txt-primary">
            {ebayListingSync.lastSuccessAtIso
              ? `Letzter erfolgreicher Abruf am ${new Date(ebayListingSync.lastSuccessAtIso).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}.`
              : "Noch nie erfolgreich abgerufen."}{" "}
            Angezeigte eBay-Angebote können veraltet sein.
            {ebayListingSync.lastError?.message ? ` Fehler: ${ebayListingSync.lastError.message}` : ""}
            {" "}Prüfe die eBay-Verbindung unter Integrationen.
          </span>
        </div>
      )}

      {/* KPI-Reihe */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat
          label="Sync-Backlog"
          value={sync ? nf.format(sync.pendingCount) : "–"}
          tone={sync ? (sync.status === "critical" ? "danger" : sync.status === "warn" ? "warning" : "success") : "default"}
          sub={
            sync && sync.pendingCount > 0 && sync.oldestAgeMinutes != null
              ? `Ältester ${Math.round(sync.oldestAgeMinutes)} min`
              : "Ausstehende Bestands-Syncs"
          }
        />
        <Stat
          label="Sync-Fehler · 7 T"
          value={drain ? nf.format(drain.abandoned_7d + drain.needs_manual_7d) : "–"}
          tone={drain && (drain.abandoned_24h > 0 || drain.needs_manual_24h > 0) ? "danger" : drain && drain.abandoned_7d + drain.needs_manual_7d > 0 ? "warning" : "success"}
          sub={drain ? `Heute ${nf.format(drain.abandoned_24h + drain.needs_manual_24h)} · davon manuell ${nf.format(drain.needs_manual_24h)}` : "Abgebrochen + manuell"}
        />
        <Stat
          label="KI-Kosten · 24 h"
          value={llm ? fmtCurrencyUsd(llm.totalCostUsd_24h) : "–"}
          sub={llm ? `${nf.format(llm.calls_24h)} Calls · Ø ${fmtMs(llm.avgLatencyMs)}` : "Keine Telemetrie"}
        />
        <Stat
          label="API-Calls · 24 h"
          value={extTotals ? nf.format(extTotals.total) : "–"}
          sub={extTotals ? `Fehlerrate ${fmtPct(extTotals.errorRate)}` : "Externe Dienste"}
        />
      </div>

      {/* Service-Tabelle */}
      <div className="rounded-xl border border-app-border bg-app-surface overflow-hidden">
        <div className="px-4 py-3 border-b border-app-border flex items-center justify-between">
          <h2 className="text-sm font-semibold text-txt-primary">Externe Dienste · 24 h</h2>
          {drain?.latest?.createdAt && (
            <span className="text-xs text-txt-muted">
              Letzter Sync-Vorfall: {new Date(drain.latest.createdAt).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
              {drain.latest.terminalStatus ? ` (${drain.latest.terminalStatus})` : ""}
            </span>
          )}
        </div>
        {services.length === 0 ? (
          <div className="px-4 py-6 text-sm text-txt-muted">Keine API-Aktivität im Zeitfenster.</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-txt-muted border-b border-app-border">
                <th className="text-left font-medium px-4 py-2">Dienst</th>
                <th className="text-right font-medium px-4 py-2">Calls</th>
                <th className="text-right font-medium px-4 py-2">Erfolgsrate</th>
                <th className="text-right font-medium px-4 py-2">Ø Latenz</th>
                <th className="text-left font-medium px-4 py-2">Status</th>
                <th className="text-left font-medium px-4 py-2 hidden md:table-cell">Häufigster Fehler</th>
              </tr>
            </thead>
            <tbody className="[font-variant-numeric:tabular-nums]">
              {services.map(([name, s]) => {
                const st = serviceStatus(s.successRate);
                const topError = s.topErrors?.[0];
                return (
                  <tr key={name} className="border-b border-white/5 last:border-0">
                    <td className="px-4 py-2.5 text-txt-primary font-medium">{SERVICE_LABELS[name] || name}</td>
                    <td className="px-4 py-2.5 text-right text-txt-secondary">{nf.format(s.total)}</td>
                    <td className={`px-4 py-2.5 text-right ${s.successRate != null && s.successRate < 0.95 ? "text-warning" : "text-txt-secondary"}`}>
                      {fmtPct(s.successRate)}
                    </td>
                    <td className="px-4 py-2.5 text-right text-txt-secondary">{fmtMs(s.avgLatencyMs)}</td>
                    <td className="px-4 py-2.5">
                      <span className="inline-flex items-center gap-1.5">
                        <span className={`w-2 h-2 rounded-full ${st.dot}`} aria-hidden />
                        <span className={`text-xs ${st.text}`}>{st.label}</span>
                      </span>
                    </td>
                    <td className="px-4 py-2.5 hidden md:table-cell text-xs text-txt-muted">
                      {topError ? `${topError.code} (${nf.format(topError.count)}×)` : "–"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Erweiterte Diagnose */}
      <div className="rounded-xl border border-app-border bg-app-surface">
        <button
          type="button"
          onClick={() => setShowDiag((s) => !s)}
          className="w-full flex items-center justify-between px-4 py-2.5 text-sm font-medium text-txt-secondary hover:text-txt-primary"
        >
          <span>Erweiterte Diagnose</span>
          <span aria-hidden className="text-xs">{showDiag ? "▾" : "▸"}</span>
        </button>
        {showDiag && (
          <div className="px-4 pb-4 border-t border-app-border pt-4">
            <AdminSystemHealth />
          </div>
        )}
      </div>
    </div>
  );
};

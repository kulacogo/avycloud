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
 * Shop-Gesundheit — die Klartext-Sicht für den Inhaber.
 *
 * Führt mit EINEM Ampel-Urteil ("droht gerade ein Überverkauf?") und übersetzt
 * die Technik-Kennzahlen in verständliche Karten. Die vollständige technische
 * Ansicht (AdminSystemHealth) bleibt eingeklappt darunter erreichbar.
 */

type Verdict = "gruen" | "gelb" | "rot" | "unbekannt";

const hasError = (x: unknown): x is { error: string } =>
  Boolean(x && typeof x === "object" && "error" in (x as Record<string, unknown>));

/**
 * Gesamt-Urteil aus Sync-Ampel (bereits im Backend berechnet) + Drain-Alerts.
 * ROT  = Aktualisierungen hängen fest / mussten aufgegeben werden → Überverkauf möglich.
 * GELB = Rückstau oder Vorfälle in den letzten 24h, System arbeitet automatisch dran.
 * GRÜN = alles synchron.
 */
export const computeVerdict = (
  sync?: AdminSystemHealthSync | { error: string } | null,
  drain?: AdminSystemHealthDrain | { error: string } | null
): Verdict => {
  const syncOk = sync && !hasError(sync) ? (sync as AdminSystemHealthSync) : null;
  const drainOk = drain && !hasError(drain) ? (drain as AdminSystemHealthDrain) : null;
  if (!syncOk && !drainOk) return "unbekannt";

  if (syncOk?.status === "critical") return "rot";
  if (drainOk && (drainOk.abandoned_24h > 0 || drainOk.needs_manual_24h > 0)) return "rot";
  if (syncOk?.status === "warn") return "gelb";
  if (drainOk && drainOk.total_alerts_24h > 0) return "gelb";
  return "gruen";
};

const VERDICT_UI: Record<Verdict, { bg: string; dot: string; title: string }> = {
  gruen: {
    bg: "border-success/30 bg-success-dim",
    dot: "bg-success",
    title: "Alles in Ordnung — Bestände sind mit den Marktplätzen synchron.",
  },
  gelb: {
    bg: "border-warning/30 bg-warning-dim",
    dot: "bg-warning",
    title: "Ein paar Bestands-Aktualisierungen brauchen länger — das System versucht es automatisch weiter.",
  },
  rot: {
    bg: "border-danger/30 bg-danger-dim",
    dot: "bg-danger",
    title: "Achtung: Bestands-Aktualisierungen hängen fest — Überverkauf möglich. Bitte prüfen.",
  },
  unbekannt: {
    bg: "border-app-border bg-app-surface",
    dot: "bg-txt-muted",
    title: "Status konnte gerade nicht ermittelt werden.",
  },
};

const Card: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="rounded-2xl border border-app-border bg-app-surface p-5">
    <h3 className="text-sm font-semibold text-txt-muted uppercase tracking-wide mb-3">{title}</h3>
    {children}
  </div>
);

// Sprechende Namen für die Recherche-Dienste (statt roher Service-Keys).
const SERVICE_NAMES: Record<string, string> = {
  serpapi: "Produkt-Suche (SerpAPI)",
  brightdata: "Web-Recherche (BrightData)",
  gemini: "KI (Gemini)",
  ebay: "eBay",
  kaufland: "Kaufland",
  sendcloud: "SendCloud",
  sevdesk: "SevDesk",
};

const serviceHealth = (rate: number | null): { label: string; cls: string } => {
  if (rate == null) return { label: "keine Daten", cls: "text-txt-muted" };
  if (rate >= 0.95) return { label: "funktioniert normal", cls: "text-success" };
  if (rate >= 0.8) return { label: "eingeschränkt", cls: "text-warning" };
  return { label: "gestört", cls: "text-danger" };
};

export const ShopGesundheit: React.FC = () => {
  const [data, setData] = React.useState<AdminSystemHealthResponse | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [showTech, setShowTech] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await adminGetSystemHealth());
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
  const llm = data?.llm && !hasError(data.llm) ? (data.llm as AdminSystemHealthLlm) : null;
  const ext = data?.externalApis && !hasError(data.externalApis) ? (data.externalApis as AdminSystemHealthExternalApis) : null;

  const verdict = computeVerdict(data?.sync, data?.drain);
  const v = VERDICT_UI[verdict];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-txt-primary">Shop-Gesundheit</h1>
          <p className="text-sm text-txt-muted">Läuft alles? Ein Blick genügt — Details nur, wenn etwas auffällt.</p>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="rounded-xl bg-app-elevated border border-white/[0.08] hover:bg-white/10 disabled:opacity-60 px-4 py-2 text-sm font-semibold text-txt-primary"
        >
          {loading ? "Lade…" : "Aktualisieren"}
        </button>
      </div>

      {error && (
        <div className="rounded-xl border border-danger/20 bg-danger-dim px-4 py-3 text-sm text-danger">{error}</div>
      )}

      {/* ─── Die Ampel ─── */}
      <div className={`rounded-2xl border p-5 flex items-center gap-4 ${v.bg}`}>
        <span className={`shrink-0 w-4 h-4 rounded-full ${v.dot}`} aria-hidden />
        <div className="min-w-0">
          <p className="font-semibold text-txt-primary">{v.title}</p>
          {verdict === "rot" && sync && sync.pendingCount > 0 && (
            <p className="text-sm text-txt-secondary mt-0.5">
              {sync.pendingCount} Aktualisierung{sync.pendingCount === 1 ? "" : "en"} offen
              {sync.oldestAgeMinutes != null ? `, die älteste seit ${Math.round(sync.oldestAgeMinutes)} Minuten` : ""}.
            </p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* ─── Überverkauf-Wächter ─── */}
        <Card title="Überverkauf-Wächter">
          {!drain && !sync ? (
            <p className="text-sm text-txt-muted">Gerade keine Daten.</p>
          ) : (
            <div className="space-y-2 text-sm">
              <p className="text-txt-secondary">
                Wenn ein Verkauf den Bestand ändert, meldet avycloud das sofort an eBay & Kaufland.
                Hier siehst du, ob dabei etwas hängen bleibt.
              </p>
              <ul className="space-y-1.5 text-txt-primary">
                <li className="flex justify-between gap-3">
                  <span>Gerade in Warteschlange</span>
                  <strong className={sync && sync.pendingCount > 0 ? "text-warning" : "text-success"}>
                    {sync ? sync.pendingCount : "–"}
                  </strong>
                </li>
                <li className="flex justify-between gap-3">
                  <span>Aufgegeben (letzte 7 Tage)</span>
                  <strong className={drain && drain.abandoned_7d > 0 ? "text-danger" : "text-success"}>
                    {drain ? drain.abandoned_7d : "–"}
                  </strong>
                </li>
                <li className="flex justify-between gap-3">
                  <span>Manuelles Eingreifen nötig (heute)</span>
                  <strong className={drain && drain.needs_manual_24h > 0 ? "text-danger" : "text-success"}>
                    {drain ? drain.needs_manual_24h : "–"}
                  </strong>
                </li>
              </ul>
              {drain && drain.abandoned_7d > 0 && (
                <p className="text-xs text-warning">
                  „Aufgegeben" heißt: Der Marktplatz hat die Bestands-Meldung mehrfach abgelehnt —
                  dieser Artikel könnte dort mit falschem Bestand stehen.
                </p>
              )}
            </div>
          )}
        </Card>

        {/* ─── KI-Nutzung ─── */}
        <Card title="KI-Nutzung heute">
          {!llm || llm.calls_24h === 0 ? (
            <p className="text-sm text-txt-muted">Heute noch keine KI-Nutzung erfasst.</p>
          ) : (
            <div className="space-y-2 text-sm">
              <p className="text-2xl font-bold text-txt-primary tabular-nums">
                {llm.totalCostUsd_24h.toFixed(2).replace(".", ",")} $
                <span className="ml-2 text-sm font-normal text-txt-muted">({llm.calls_24h} Anfragen, 24 Std)</span>
              </p>
              <p className="text-txt-secondary">
                {llm.totalCostUsd_24h < 5
                  ? "Im normalen Rahmen."
                  : llm.totalCostUsd_24h < 15
                    ? "Erhöht — z. B. durch viele Erfassungen. Kein Handlungsbedarf."
                    : "Ungewöhnlich hoch — bei anhaltend hohen Werten melden."}
                {" "}Abgerechnet wird in US-Dollar.
              </p>
            </div>
          )}
        </Card>
      </div>

      {/* ─── Recherche-Dienste ─── */}
      <Card title="Angeschlossene Dienste (letzte 24 Std)">
        {!ext || !ext.byService || Object.keys(ext.byService).length === 0 ? (
          <p className="text-sm text-txt-muted">Gerade keine Daten.</p>
        ) : (
          <ul className="space-y-1.5 text-sm">
            {Object.entries(ext.byService).map(([name, s]) => {
              const h = serviceHealth(s.successRate);
              return (
                <li key={name} className="flex items-center justify-between gap-3">
                  <span className="text-txt-primary">{SERVICE_NAMES[name] || name}</span>
                  <span className={`font-medium ${h.cls}`}>{h.label}</span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {/* ─── Technische Details (für Admins/Technik) ─── */}
      <div className="rounded-2xl border border-app-border bg-app-surface">
        <button
          type="button"
          onClick={() => setShowTech((s) => !s)}
          className="w-full flex items-center justify-between px-5 py-3 text-sm font-semibold text-txt-secondary hover:text-txt-primary"
        >
          <span>Technische Details {showTech ? "ausblenden" : "anzeigen"}</span>
          <span aria-hidden>{showTech ? "▾" : "▸"}</span>
        </button>
        {showTech && (
          <div className="px-5 pb-5">
            <AdminSystemHealth />
          </div>
        )}
      </div>
    </div>
  );
};

import React from "react";
import { startEbayOAuth, type SupportPerformance } from "../../api/client";
import { useAuth } from "../../context/AuthContext";
import { secondaryButton } from "./TeamPrimitives";
import { SUPPORT_WEIGHT } from "./workContribution";

export function SupportPerformancePanel({ data, ownerName, loading, error, onReload, details = false }: {
  data?: SupportPerformance; ownerName?: string; loading?: boolean; error?: boolean;
  onReload: () => void; details?: boolean;
}) {
  const { hasPermission } = useAuth();
  const [connecting, setConnecting] = React.useState(false);
  const [connectionError, setConnectionError] = React.useState("");
  const connect = async () => {
    setConnecting(true);
    setConnectionError("");
    // Open synchronously so the browser doesn't block the consent window.
    const popup = window.open("about:blank", "avycloud-support-ebay", "width=900,height=780");
    if (popup) popup.opener = null;
    try {
      const url = await startEbayOAuth({ includeMessages: true });
      if (popup) popup.location.href = url;
      else window.location.assign(url);
    } catch (err) {
      popup?.close();
      setConnectionError(err instanceof Error ? err.message : "Verbindung konnte nicht gestartet werden.");
    } finally { setConnecting(false); }
  };
  return <section aria-label={details ? "Supportdetails" : "Kundensupport"} className="rounded-2xl border border-app-border bg-app-surface p-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h3 className="text-sm font-semibold">Kundensupport {ownerName && <span className="font-normal text-txt-secondary">· {ownerName}</span>}</h3>
        <p className="mt-1 text-xs leading-relaxed text-txt-muted">
          Alleinige Zuständigkeit laut Inhaber. Antworten weiterhin direkt bei Kaufland und eBay.
        </p>
      </div>
      {!details && <button className={secondaryButton} onClick={onReload} disabled={loading}>Support aktualisieren</button>}
    </div>
    {loading && !data ? <p className="mt-3 text-xs text-txt-muted" role="status">Supportdaten werden geladen …</p> : error || !data?.ownerUid ? <p className="mt-3 text-xs text-warning">Supportdaten oder Zuständigkeit fehlen. Der angezeigte Beitrag ist unvollständig.</p> : <>
      <div className={`mt-3 grid gap-3 ${details ? "" : "sm:grid-cols-2"}`}>
        {(["kaufland", "ebay"] as const).map((key) => {
          const source = data.channels[key];
          const available = source.status === "complete" || source.status === "limited";
          return <div key={key} className="rounded-xl bg-app-elevated p-3">
            <p className="text-xs font-semibold">{key === "kaufland" ? "Kaufland-Tickets" : "eBay-Nachrichten"}</p>
            {available && !details ? <p className={`mt-2 text-xs ${source.status === "limited" ? "text-warning" : "text-success"}`}>{source.status === "limited" ? "Teilweise im Beitrag erfasst" : "Im Beitrag enthalten"} · Einzelzahlen nach Mitarbeiterauswahl</p> : available ? <>
              <p className="mt-2 text-sm"><strong className="text-lg tabular-nums">{source.status === "limited" ? "≥ " : ""}{source.cases?.toLocaleString("de-DE")}</strong> bearbeitete Anliegen</p>
              <p className="mt-1 text-xs text-txt-muted">{source.replies?.toLocaleString("de-DE")} Antworten · {((source.cases || 0) * SUPPORT_WEIGHT).toLocaleString("de-DE")} Punkte</p>
              {source.status === "limited" && <p className="mt-2 text-xs text-warning">Nur teilweise geladen; weitere Arbeit kann fehlen.</p>}
            </> : <p className="mt-2 text-xs text-warning">{source.status === "connection_required" ? "Nachrichtenfreigabe fehlt. Noch nicht im Beitrag enthalten." : "Quelle nicht verfügbar. Keine Nullwertung."}</p>}
            {key === "ebay" && source.status === "connection_required" && hasPermission("integrations", "write") && <><button disabled={connecting} className={`${secondaryButton} mt-3`} onClick={connect}>{connecting ? "Wird geöffnet …" : "eBay-Nachrichten verbinden"}</button><p className="mt-2 text-xs text-txt-muted">Nach der Freigabe hier „Support aktualisieren“ wählen.</p></>}
          </div>;
        })}
      </div>
      {details && <p className="mt-3 text-[11px] leading-relaxed text-txt-muted">
        {SUPPORT_WEIGHT} Punkte je Anliegen mit Händlerantwort im Zeitraum, unabhängig von der Anzahl der Antworten. Vorläufige Aufwandsstufe für Lesen, Prüfen und Beantworten; keine gemessene Bearbeitungszeit. Daten werden bis zu einer Minute zwischengespeichert.
      </p>}
    </>}
    {connectionError && <p role="alert" className="mt-3 text-xs text-danger">{connectionError}</p>}
  </section>;
}

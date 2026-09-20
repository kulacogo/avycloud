import React from "react";
import { startEbayOAuth, type SupportPerformance } from "../../api/client";
import { useAuth } from "../../context/AuthContext";
import { secondaryButton } from "./TeamPrimitives";
import { supportChannelView } from "./performancePresentation";

export function SupportPerformancePanel({ data, loading, error, onReload, details = false }: {
  data?: SupportPerformance; loading?: boolean; error?: boolean;
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
  const missing = Boolean(error || (!loading && !data?.ownerUid));
  return <section aria-label={details ? "Supportdetails" : "Supportstatus"} className={details ? "mt-3 border-t border-app-border pt-3" : "flex flex-wrap items-center gap-x-3 gap-y-1 text-xs"}>
    {details && <div className="mb-1 flex items-center justify-between text-xs"><h4 className="font-semibold">Support</h4><span className="text-txt-muted">Anliegen / Punkte</span></div>}
    {loading && !data ? <span className="text-xs text-txt-muted" role="status">Support lädt …</span> : missing ? <div className="flex items-center gap-2 text-xs text-warning" role="status">Support nicht verfügbar <button type="button" onClick={onReload} className="underline">Erneut laden</button></div> : data && (["kaufland", "ebay"] as const).map((key) => {
      const source = data.channels[key];
      const view = supportChannelView(source);
      const label = key === "kaufland" ? "Kaufland" : "eBay";
      const needsConnection = key === "ebay" && source.status === "connection_required" && hasPermission("integrations", "write");
      return <div key={key} className={details ? "py-2" : "flex items-center gap-1.5"}>
        {details ? <div className="grid grid-cols-[minmax(0,1fr)_auto_3rem] items-start gap-3 text-sm">
          <div><span>{label}</span>{view.replies !== null && <span className="mt-0.5 block text-[11px] text-txt-muted">{view.replies.toLocaleString("de-DE")} Antworten</span>}</div>
          <span className="tabular-nums">{view.count === null ? "—" : `${view.partial ? "≥ " : ""}${view.count.toLocaleString("de-DE")}`}</span>
          <span className="text-right font-medium tabular-nums text-accent">{view.points === null ? "—" : `${view.partial ? "≥ " : ""}${view.points.toLocaleString("de-DE")}`}</span>
        </div> : <span className={`inline-flex items-center gap-1.5 ${source.status === "complete" ? "text-txt-muted" : "text-warning"}`} aria-label={`${label}: ${view.label}`} title={`${label}: ${view.label}`}><span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${source.status === "complete" ? "bg-success" : "bg-warning"}`} />{label}{source.status !== "complete" && <span>· {view.label}</span>}</span>}
        {details && source.status !== "complete" && <span className="text-[11px] text-warning">{view.label}</span>}
        {needsConnection && <button type="button" disabled={connecting} className={details ? `${secondaryButton} mt-2` : "font-medium text-accent hover:underline"} onClick={connect}>{connecting ? "Öffnet …" : "Verbinden"}</button>}
      </div>;
    })}
    {connectionError && <p role="alert" className="text-xs text-danger">{connectionError}</p>}
  </section>;
}

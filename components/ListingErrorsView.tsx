import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchListingErrors,
  publishToKaufland,
  bulkPublishToEbay,
  type ListingErrorsResponse,
  type ListingErrorRow,
} from "../api/client";
import { PageTitle } from "./ui/PageTitle";

type ChannelFilter = "all" | "ebay" | "kaufland";

function channelBadge(channel: string): { label: string; cls: string } {
  return channel === "ebay"
    ? { label: "eBay", cls: "bg-info-dim text-info" }
    : { label: "Kaufland", cls: "bg-accent-dim text-accent" };
}

function StatTile({ label, value, tone }: { label: string; value: number | string; tone?: "danger" | "muted" }) {
  return (
    <div className="rounded-xl border border-app-border bg-app-surface p-4">
      <p className="text-[11px] uppercase tracking-widest text-txt-muted">{label}</p>
      <p className={`mt-1 text-3xl font-semibold ${tone === "danger" ? "text-danger" : "text-txt-primary"}`}>{value}</p>
    </div>
  );
}

export default function ListingErrorsView() {
  const [data, setData] = useState<ListingErrorsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [channel, setChannel] = useState<ChannelFilter>("all");
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [retrying, setRetrying] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<string | null>(null);
  // Ergebnis je Artikel, an der Zeile verankert statt als flüchtiger Hinweis.
  const [retryOutcome, setRetryOutcome] = useState<Map<string, { ok: boolean; message: string }>>(new Map());

  const load = useCallback(async (opts?: { keepExpanded?: boolean }) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchListingErrors();
      setData(res);
      // Auto-expand the biggest group on first load so the view isn't a wall of collapsed rows.
      // Beim Nachladen nach einem Wiederholversuch bleibt die Arbeitsposition
      // erhalten: vorher klappte JEDE offene Gruppe zu und eine fremde auf.
      // Die aufgeklappte Gruppe wird nur ERGÄNZT, nie ersetzt — sonst fällt
      // beim Filterwechsel weiterhin alles zu.
      if (res.groups.length) {
        setExpanded((prev) =>
          opts?.keepExpanded && prev.size ? prev : new Set([...prev, res.groups[0].groupKey])
        );
      }
    } catch (e) {
      setError((e as Error)?.message || "Fehler beim Laden");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const rows = data?.rows || [];

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (channel === "all" || r.channel === channel) &&
        (!q ||
          (r.title || "").toLowerCase().includes(q) ||
          (r.sku || "").toLowerCase().includes(q) ||
          r.errors.some((e) => (e.message || "").toLowerCase().includes(q))),
    );
  }, [rows, channel, search]);

  const groups = useMemo(() => {
    const m = new Map<string, { groupKey: string; label: string; rows: ListingErrorRow[] }>();
    for (const r of filteredRows) {
      const g = m.get(r.primaryGroupKey) || { groupKey: r.primaryGroupKey, label: r.primaryLabel, rows: [] };
      g.rows.push(r);
      m.set(r.primaryGroupKey, g);
    }
    return Array.from(m.values()).sort((a, b) => b.rows.length - a.rows.length);
  }, [filteredRows]);

  const toggle = (k: string) =>
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  const openProduct = (id: string) => {
    window.location.hash = `#/sheet/${id}`;
  };

  const retry = async (row: ListingErrorRow) => {
    setRetrying((prev) => new Set(prev).add(row.productId));
    setRetryOutcome((prev) => {
      const n = new Map(prev);
      n.delete(row.productId);
      return n;
    });
    try {
      if (row.channel === "ebay") {
        // `bulkPublishToEbay` wirft NICHT, wenn eBay ablehnt — die Ablehnung
        // kommt als ok:false mit Gründen zurück (HTTP 200). Vorher meldete der
        // Knopf deshalb auch bei erneuter Ablehnung "Erneut versucht".
        // Der Aufruf wird von zwei weiteren Ansichten geteilt, die bewusst pro
        // Artikel auswerten — die Prüfung gehört daher hierhin, nicht in die
        // gemeinsame API-Funktion.
        const first = (await bulkPublishToEbay([row.productId]))?.results?.[0];
        if (first && first.ok === false) {
          const grund = (first.blockers || []).join(" · ") || "unbekannter Grund";
          setRetryOutcome((prev) => new Map(prev).set(row.productId, { ok: false, message: grund }));
          await load({ keepExpanded: true });
          return;
        }
      } else {
        await publishToKaufland(row.productId);
      }
      setRetryOutcome((prev) => new Map(prev).set(row.productId, { ok: true, message: "Erneut eingestellt." }));
      await load({ keepExpanded: true });
    } catch (e) {
      setRetryOutcome((prev) =>
        new Map(prev).set(row.productId, { ok: false, message: (e as Error)?.message || "unbekannt" })
      );
    } finally {
      setRetrying((prev) => {
        const n = new Set(prev);
        n.delete(row.productId);
        return n;
      });
    }
  };

  const summary = data?.summary || { total: 0, ebay: 0, kaufland: 0 };

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4">
      <div className="flex items-center justify-between">
        <div>
          <PageTitle className="text-2xl font-semibold text-txt-primary">Listing-Fehler</PageTitle>
          <p className="text-sm text-txt-muted">
            Alle Artikel, die nicht auf eBay oder Kaufland gelistet werden konnten — bleiben hier, bis sie behoben sind.
          </p>
        </div>
        <button
          onClick={() => void load({ keepExpanded: true })}
          className="rounded-lg border border-app-border bg-app-surface px-3 py-2 text-sm font-medium text-txt-primary hover:bg-app-elevated"
        >
          Aktualisieren
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Fehlgeschlagen" value={summary.total} tone={summary.total > 0 ? "danger" : undefined} />
        <StatTile label="eBay" value={summary.ebay} />
        <StatTile label="Kaufland" value={summary.kaufland} />
        <StatTile label="Fehlergründe" value={data?.groups.length || 0} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-lg border border-app-border bg-app-surface p-0.5">
          {(["all", "ebay", "kaufland"] as ChannelFilter[]).map((c) => (
            <button
              key={c}
              onClick={() => setChannel(c)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium ${
                channel === c ? "bg-accent text-white" : "text-txt-secondary hover:text-txt-primary"
              }`}
            >
              {c === "all" ? "Alle" : c === "ebay" ? "eBay" : "Kaufland"}
            </button>
          ))}
        </div>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Titel, SKU oder Fehlertext suchen…"
          className="min-w-[240px] flex-1 rounded-lg border border-app-border bg-app-bg px-3 py-2 text-sm text-txt-primary focus:outline-none"
        />
      </div>

      {toast && (
        <div className="rounded-lg border border-app-border bg-app-elevated px-3 py-2 text-sm text-txt-primary">{toast}</div>
      )}

      {loading && <div className="p-8 text-center text-txt-muted">Lädt…</div>}
      {error && !loading && (
        <div className="rounded-xl border border-danger/40 bg-danger-dim p-4 text-sm text-danger">{error}</div>
      )}

      {!loading && !error && groups.length === 0 && (
        <div className="rounded-xl border border-app-border bg-app-surface p-10 text-center">
          <p className="text-lg font-medium text-success">Keine offenen Listing-Fehler 🎉</p>
          <p className="mt-1 text-sm text-txt-muted">Sobald ein Listing fehlschlägt, erscheint es hier — mit Grund und direkter Fix-Aktion.</p>
        </div>
      )}

      {!loading &&
        !error &&
        groups.map((g) => {
          const isOpen = expanded.has(g.groupKey);
          return (
            <div key={g.groupKey} className="overflow-hidden rounded-xl border border-app-border bg-app-surface">
              <button
                onClick={() => toggle(g.groupKey)}
                className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-app-elevated"
              >
                <div className="flex items-center gap-3">
                  <span className="flex h-7 min-w-[28px] items-center justify-center rounded-md bg-danger-dim px-2 text-sm font-semibold text-danger">
                    {g.rows.length}
                  </span>
                  <span className="font-medium text-txt-primary">{g.label}</span>
                </div>
                <span className="text-txt-muted">{isOpen ? "▾" : "▸"}</span>
              </button>

              {isOpen && (
                <div className="divide-y divide-app-border border-t border-app-border">
                  {g.rows.map((r) => {
                    const badge = channelBadge(r.channel);
                    const isRetrying = retrying.has(r.productId);
                    return (
                      <div key={`${r.channel}:${r.productId}`} className="flex items-start gap-3 px-4 py-3">
                        <div className="h-12 w-12 shrink-0 overflow-hidden rounded-lg border border-app-border bg-app-bg">
                          {r.imageUrl ? (
                            <img src={r.imageUrl} alt="" className="h-full w-full object-contain" />
                          ) : null}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${badge.cls}`}>{badge.label}</span>
                            <p className="truncate text-sm font-medium text-txt-primary">{r.title || r.productId}</p>
                          </div>
                          {r.sku && <p className="text-xs text-txt-muted">SKU: {r.sku}</p>}
                          <ul className="mt-1 space-y-0.5">
                            {r.errors.map((e, i) => (
                              <li key={i} className="text-xs text-danger">
                                {e.message || e.label}
                              </li>
                            ))}
                          </ul>
                          {/* Ergebnis des letzten Wiederholversuchs — bleibt an der
                              Zeile stehen. Als 4-Sekunden-Hinweis war der Grund weg,
                              bevor der Bediener ihn zuordnen konnte. Achtung: bei
                              der Ablehnung "Bereits auf eBay gelistet" wird der
                              gespeicherte Fehler oben NICHT aktualisiert — nur diese
                              Zeile zeigt dann den aktuellen Stand. */}
                          {retryOutcome.has(r.productId) && (
                            <p
                              className={`mt-1.5 text-xs font-medium ${
                                retryOutcome.get(r.productId)!.ok ? "text-success" : "text-warning"
                              }`}
                            >
                              {retryOutcome.get(r.productId)!.ok
                                ? retryOutcome.get(r.productId)!.message
                                : `Erneut fehlgeschlagen: ${retryOutcome.get(r.productId)!.message}`}
                            </p>
                          )}
                        </div>
                        <div className="flex shrink-0 flex-col gap-1.5">
                          <button
                            onClick={() => openProduct(r.productId)}
                            className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:bg-accent/80"
                          >
                            Öffnen & Fixen
                          </button>
                          <button
                            onClick={() => retry(r)}
                            disabled={isRetrying}
                            className="rounded-lg border border-app-border px-3 py-1.5 text-xs font-medium text-txt-primary hover:bg-app-elevated disabled:opacity-40"
                          >
                            {isRetrying ? "Läuft…" : "Erneut listen"}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
    </div>
  );
}

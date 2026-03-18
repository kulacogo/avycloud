import React, { useCallback, useEffect, useMemo, useState } from "react";
import { fetchInvoices, updateInvoiceStatus, downloadInvoicePdfBlob, type InvoiceData } from "../../api/client";
import { EmptyState } from "../ui/EmptyState";

/* ─── Helpers ─── */
const grossAmt = (inv: any): number => inv.amountGross ?? inv.amountBrutto ?? 0;
const nettoAmt = (inv: any): number => inv.amountNet ?? inv.amountNetto ?? 0;

const OPEN_STATUSES = new Set(["offen", "erstellt", "gesendet"]);

function normalizeStatus(status: string | undefined): { label: string; cls: string } {
  if (!status) return { label: "—", cls: "bg-app-elevated text-txt-muted" };
  if (OPEN_STATUSES.has(status)) return { label: "Offen", cls: "bg-info-dim text-info" };
  const MAP: Record<string, { label: string; cls: string }> = {
    bezahlt:      { label: "Bezahlt",       cls: "bg-success-dim text-success" },
    ueberfaellig: { label: "Überfällig",    cls: "bg-danger-dim text-danger" },
    storniert:    { label: "Storniert",     cls: "bg-app-elevated text-txt-muted" },
    teilkorrigiert:{ label: "Teilkorrigiert",cls: "bg-warning-dim text-warning" },
    entwurf:      { label: "Entwurf",       cls: "bg-app-elevated text-txt-secondary" },
  };
  return MAP[status] || { label: status, cls: "bg-app-elevated text-txt-muted" };
}

const TYPE_BADGE: Record<string, { label: string; cls: string }> = {
  storno:    { label: "Storno",    cls: "bg-danger-dim text-danger" },
  gutschrift:{ label: "Gutschrift",cls: "bg-warning-dim text-warning" },
};

type SortCol = "date" | "invoiceNumber" | "amount" | "status";
type SortDir = "asc" | "desc";
type TabKey = "alle" | "offen" | "bezahlt" | "ueberfaellig" | "storniert" | "entwurf";

/* ─── KPI Card ─── */
const KpiCard: React.FC<{ label: string; value: string | number; tone?: string }> = ({
  label, value, tone = "text-txt-primary",
}) => (
  <div className="rounded-xl border border-app-border bg-app-surface p-4 flex flex-col gap-1">
    <span className="text-xs font-medium text-txt-muted uppercase tracking-wider">{label}</span>
    <span className={`text-2xl font-bold ${tone}`}>{value}</span>
  </div>
);

/* ─── Sort Header ─── */
const SortTh: React.FC<{
  col: SortCol; label: string; align?: "left" | "right";
  sortCol: SortCol; sortDir: SortDir; onSort: (c: SortCol) => void;
}> = ({ col, label, align = "left", sortCol, sortDir, onSort }) => {
  const active = sortCol === col;
  return (
    <th
      className={`px-4 py-3 text-xs font-semibold text-txt-muted uppercase tracking-wider cursor-pointer select-none hover:text-txt-primary transition ${align === "right" ? "text-right" : "text-left"}`}
      onClick={() => onSort(col)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        <span className={`text-[10px] ${active ? "opacity-100" : "opacity-20"}`}>
          {active ? (sortDir === "asc" ? "▲" : "▼") : "▼"}
        </span>
      </span>
    </th>
  );
};

/* ─── Main ─── */
export const InvoicesView: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TabKey>("alle");
  const [invoices, setInvoices] = useState<InvoiceData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [datePreset, setDatePreset] = useState<"all" | "today" | "7d" | "30d" | "90d">("all");
  const [sortCol, setSortCol] = useState<SortCol>("invoiceNumber");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const loadInvoices = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await fetchInvoices({ limit: 2000 });
      setInvoices(data);
    } catch (err: any) {
      setError(err?.message || "Rechnungen konnten nicht geladen werden");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadInvoices(); }, [loadInvoices]);

  const handleSort = (col: SortCol) => {
    if (sortCol === col) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortCol(col); setSortDir("desc"); }
  };

  /* ─── Tab classification ─── */
  const classifyTab = (inv: any): TabKey => {
    if ((inv as any).type === "storno" || (inv as any).type === "gutschrift" || inv.status === "storniert") return "storniert";
    if (inv.status === "bezahlt") return "bezahlt";
    if (inv.status === "ueberfaellig") return "ueberfaellig";
    if (inv.status === "entwurf") return "entwurf";
    if (OPEN_STATUSES.has(inv.status || "")) return "offen";
    return "offen"; // default for unknown
  };

  const tabCounts = useMemo(() => {
    const c: Record<TabKey | "alle", number> = { alle: 0, offen: 0, bezahlt: 0, ueberfaellig: 0, storniert: 0, entwurf: 0 };
    for (const inv of invoices) {
      c.alle++;
      const t = classifyTab(inv);
      c[t] = (c[t] || 0) + 1;
    }
    return c;
  }, [invoices]);

  /* ─── Filter + Sort ─── */
  const filtered = useMemo(() => {
    let list = invoices.filter((inv) => activeTab === "alle" || classifyTab(inv) === activeTab);

    if (datePreset !== "all") {
      const now = Date.now();
      const cutoff = datePreset === "today"
        ? new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).getTime()
        : datePreset === "7d" ? now - 7 * 86400000
        : datePreset === "30d" ? now - 30 * 86400000
        : now - 90 * 86400000;
      list = list.filter((inv) => {
        const d = new Date((inv as any).date || inv.createdAt || "");
        return !isNaN(d.getTime()) && d.getTime() >= cutoff;
      });
    }

    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      list = list.filter((inv) =>
        (inv.invoiceNumber || "").toLowerCase().includes(q) ||
        ((inv.customer as any)?.name || inv.customer || "").toString().toLowerCase().includes(q) ||
        ((inv as any).marketplaceOrderId || "").toLowerCase().includes(q) ||
        (inv.orderId || "").toLowerCase().includes(q)
      );
    }

    // Sort
    list = [...list].sort((a, b) => {
      let va: any, vb: any;
      if (sortCol === "date") {
        va = new Date((a as any).date || a.createdAt || "").getTime() || 0;
        vb = new Date((b as any).date || b.createdAt || "").getTime() || 0;
      } else if (sortCol === "amount") {
        va = grossAmt(a);
        vb = grossAmt(b);
      } else if (sortCol === "invoiceNumber") {
        // Numeric sort: RE-1529 > RE-1516 > RE-1086; blanks go last
        const parse = (n: string | undefined) => parseInt((n || "").replace(/^[A-Z]+-/, "")) || 0;
        va = parse(a.invoiceNumber);
        vb = parse(b.invoiceNumber);
      } else if (sortCol === "status") {
        va = a.status || "";
        vb = b.status || "";
      } else {
        va = 0; vb = 0;
      }
      if (va < vb) return sortDir === "asc" ? -1 : 1;
      if (va > vb) return sortDir === "asc" ? 1 : -1;
      return 0;
    });

    return list;
  }, [invoices, activeTab, datePreset, searchQuery, sortCol, sortDir]);

  /* ─── KPIs ─── */
  const kpis = useMemo(() => {
    const main = invoices.filter((inv) => !(inv as any).type);
    const openInvs = main.filter((inv) => OPEN_STATUSES.has(inv.status || ""));
    const today = Date.now();
    const overdue = main.filter((inv) => {
      if (inv.status === "bezahlt" || inv.status === "storniert") return false;
      const due = (inv as any).dueDate ? new Date((inv as any).dueDate).getTime() : 0;
      return due > 0 && due < today;
    });
    const totalGross = main.reduce((s, inv) => s + grossAmt(inv), 0);
    return {
      total: invoices.length,
      open: openInvs.length,
      overdue: overdue.length,
      totalGross: totalGross.toLocaleString("de-DE", { minimumFractionDigits: 2 }),
    };
  }, [invoices]);

  const TABS: { key: TabKey | "alle"; label: string }[] = [
    { key: "alle", label: "Alle" },
    { key: "offen", label: "Offen" },
    { key: "bezahlt", label: "Bezahlt" },
    { key: "ueberfaellig", label: "Überfällig" },
    { key: "storniert", label: "Stornos & Gutschriften" },
    ...(tabCounts.entwurf > 0 ? [{ key: "entwurf" as TabKey, label: "Entwürfe" }] : []),
  ];

  const handleMarkPaid = async (id: string) => {
    try {
      await updateInvoiceStatus(id, "bezahlt");
      setInvoices((prev) => prev.map((inv) => inv.id === id ? { ...inv, status: "bezahlt" } : inv));
    } catch (err: any) {
      setError(err?.message || "Fehler beim Status-Update");
    }
  };

  const handleDownloadPdf = async (invoiceId: string) => {
    try {
      const blob = await downloadInvoicePdfBlob(invoiceId);
      const url = URL.createObjectURL(blob);
      const w = window.open(url, "_blank");
      if (!w) {
        const a = document.createElement("a");
        a.href = url; a.download = `rechnung-${invoiceId}.pdf`; a.click();
      }
      setTimeout(() => URL.revokeObjectURL(url), 120000);
    } catch (err: any) {
      setError(err?.message || "PDF-Download fehlgeschlagen");
    }
  };

  /* ─── Loading ─── */
  if (loading) {
    return (
      <div className="max-w-7xl mx-auto space-y-5">
        <div>
          <h1 className="text-2xl font-bold text-txt-primary">Rechnungen</h1>
          <p className="text-sm text-txt-muted">Alle Rechnungen aus eBay & Kaufland Bestellungen</p>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[1,2,3,4].map((i) => <div key={i} className="rounded-xl border border-app-border bg-app-surface p-4 h-20 animate-pulse" />)}
        </div>
        <div className="rounded-xl border border-app-border bg-app-surface h-64 animate-pulse" />
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-txt-primary">Rechnungen</h1>
          <p className="text-sm text-txt-muted">Alle Rechnungen aus eBay & Kaufland Bestellungen</p>
        </div>
        <button
          type="button"
          onClick={loadInvoices}
          className="inline-flex items-center gap-2 rounded-lg bg-app-elevated text-txt-secondary px-3 py-2 text-sm font-medium hover:text-txt-primary transition"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          Aktualisieren
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-xl border border-danger/20 bg-danger-dim px-4 py-3 text-sm text-danger flex items-center justify-between gap-2">
          <span>{error.includes("index") ? "Datenbank-Index wird erstellt — bitte kurz warten." : error}</span>
          <button type="button" onClick={() => setError(null)} className="opacity-60 hover:opacity-100">&times;</button>
        </div>
      )}

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard label="Gesamt Rechnungen" value={kpis.total} tone="text-accent" />
        <KpiCard label="Offene Rechnungen" value={kpis.open} tone="text-info" />
        <KpiCard label="Überfällig" value={kpis.overdue} tone={kpis.overdue > 0 ? "text-danger" : "text-txt-muted"} />
        <KpiCard label="Gesamtumsatz (Brutto)" value={`${kpis.totalGross} €`} tone="text-success" />
      </div>

      {/* Search + Date */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-txt-muted" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clipRule="evenodd" />
          </svg>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Rechnungsnr., Kunde, Bestell-ID…"
            className="w-full rounded-xl border border-app-border bg-app-surface text-txt-primary pl-9 pr-3 py-2 text-sm placeholder:text-txt-muted focus:outline-none focus:ring-1 focus:ring-accent/40 focus:border-accent/40"
          />
          {searchQuery && (
            <button type="button" onClick={() => setSearchQuery("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-txt-muted hover:text-txt-primary">&times;</button>
          )}
        </div>
        <div className="flex items-center gap-1">
          {(["all","today","7d","30d","90d"] as const).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setDatePreset(key)}
              className={`rounded-lg px-2.5 py-1.5 text-xs font-medium transition ${
                datePreset === key ? "bg-accent text-white" : "bg-app-surface text-txt-muted border border-app-border hover:bg-app-elevated"
              }`}
            >
              {key === "all" ? "Alle" : key === "today" ? "Heute" : key.replace("d", "T")}
            </button>
          ))}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap gap-2">
        {TABS.map((tab) => {
          const count = tabCounts[tab.key as TabKey | "alle"] || 0;
          const active = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key as TabKey)}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition border ${
                active ? "bg-accent-dim text-accent border-accent/20 ring-1 ring-accent/20"
                       : "bg-app-surface text-txt-muted border-app-border hover:border-txt-muted"
              }`}
            >
              {tab.label}
              <span className={`text-[10px] ${active ? "opacity-80" : "opacity-50"}`}>{count}</span>
            </button>
          );
        })}
      </div>

      {/* Empty */}
      {invoices.length === 0 && !error && (
        <div className="rounded-xl border border-app-border bg-app-surface">
          <EmptyState
            icon={
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-txt-muted">
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
              </svg>
            }
            title="Keine Rechnungen"
            description="Rechnungen werden automatisch erstellt sobald eine Bestellung kommissioniert wird."
          />
        </div>
      )}

      {/* Table */}
      {filtered.length > 0 && (
        <div className="rounded-xl border border-app-border bg-app-surface overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-app-border bg-app-bg/50">
                  <SortTh col="invoiceNumber" label="Rechnungs-Nr" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} />
                  <SortTh col="date" label="Datum" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} />
                  <th className="text-left px-4 py-3 text-xs font-semibold text-txt-muted uppercase tracking-wider">Kunde</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-txt-muted uppercase tracking-wider">Bestell-ID</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-txt-muted uppercase tracking-wider">Netto</th>
                  <SortTh col="amount" label="Brutto" align="right" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} />
                  <SortTh col="status" label="Status" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} />
                  <th className="text-left px-4 py-3 text-xs font-semibold text-txt-muted uppercase tracking-wider">Fällig</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-txt-muted uppercase tracking-wider">PDF</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((inv) => {
                  const statusCfg = normalizeStatus(inv.status);
                  const type = (inv as any).type as string | undefined;
                  const typeBadge = type ? TYPE_BADGE[type] : null;
                  const dueTs = (inv as any).dueDate ? new Date((inv as any).dueDate).getTime() : 0;
                  const overdue = dueTs > 0 && dueTs < Date.now() && inv.status !== "bezahlt" && inv.status !== "storniert";
                  const marketplace = String((inv as any).marketplace || "").toLowerCase();
                  const isOpenStatus = OPEN_STATUSES.has(inv.status || "");

                  return (
                    <tr key={inv.id} className="border-b border-app-border last:border-b-0 hover:bg-app-elevated/40 transition">
                      {/* Invoice Number */}
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="font-mono text-sm font-bold text-txt-primary">
                            {inv.invoiceNumber || <span className="text-txt-muted font-normal italic">kein Nr.</span>}
                          </span>
                          {typeBadge && (
                            <span className={`inline-flex rounded px-1.5 py-0.5 text-[10px] font-semibold ${typeBadge.cls}`}>
                              {typeBadge.label}
                            </span>
                          )}
                        </div>
                        {(inv as any).originalInvoiceNumber && (
                          <span className="block text-[10px] text-txt-muted mt-0.5">zu {(inv as any).originalInvoiceNumber}</span>
                        )}
                        {(inv as any).sevdeskId && (
                          <span className="block text-[10px] text-success mt-0.5">SevDesk ✓</span>
                        )}
                      </td>
                      {/* Date */}
                      <td className="px-4 py-3 text-xs text-txt-muted whitespace-nowrap">
                        {(inv as any).date ? new Date((inv as any).date).toLocaleDateString("de-DE") : "—"}
                      </td>
                      {/* Customer */}
                      <td className="px-4 py-3 text-txt-primary font-medium max-w-[160px] truncate">
                        {((inv.customer as any)?.name || inv.customer || "—") as string}
                      </td>
                      {/* Order ID */}
                      <td className="px-4 py-3">
                        <span className="font-mono text-xs text-txt-secondary block truncate max-w-[140px]">
                          {(inv as any).marketplaceOrderId || (inv as any).orderNumber || inv.orderId || "—"}
                        </span>
                        {marketplace && (
                          <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold mt-0.5 ${
                            marketplace.includes("ebay") ? "bg-warning-dim text-warning" :
                            marketplace.includes("kaufland") ? "bg-danger-dim text-danger" :
                            "bg-app-elevated text-txt-muted"
                          }`}>
                            {marketplace.includes("ebay") ? "eBay" : marketplace.includes("kaufland") ? "Kaufland" : (inv as any).marketplace}
                          </span>
                        )}
                      </td>
                      {/* Netto */}
                      <td className="px-4 py-3 text-right text-txt-secondary tabular-nums text-xs">
                        {nettoAmt(inv) > 0 ? `${nettoAmt(inv).toLocaleString("de-DE", { minimumFractionDigits: 2 })} €` : "—"}
                      </td>
                      {/* Brutto */}
                      <td className="px-4 py-3 text-right font-semibold text-txt-primary tabular-nums">
                        {grossAmt(inv) > 0 ? `${grossAmt(inv).toLocaleString("de-DE", { minimumFractionDigits: 2 })} €` : "—"}
                      </td>
                      {/* Status */}
                      <td className="px-4 py-3">
                        <span className={`inline-flex rounded-md px-2 py-0.5 text-[11px] font-semibold ${statusCfg.cls}`}>
                          {statusCfg.label}
                        </span>
                      </td>
                      {/* Due Date */}
                      <td className="px-4 py-3">
                        <span className={`text-xs whitespace-nowrap ${overdue ? "text-danger font-semibold" : "text-txt-muted"}`}>
                          {(inv as any).dueDate ? new Date((inv as any).dueDate).toLocaleDateString("de-DE") : "—"}
                        </span>
                      </td>
                      {/* Actions */}
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1.5">
                          {(inv as any).pdfUrl && (
                            <button
                              type="button"
                              onClick={() => handleDownloadPdf(inv.id)}
                              className="rounded-lg bg-accent-dim p-1.5 text-accent hover:opacity-80 transition"
                              title="PDF öffnen"
                            >
                              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                              </svg>
                            </button>
                          )}
                          {isOpenStatus && (
                            <button
                              type="button"
                              onClick={() => handleMarkPaid(inv.id)}
                              className="rounded-lg bg-success-dim p-1.5 text-success hover:opacity-80 transition"
                              title="Als bezahlt markieren"
                            >
                              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                              </svg>
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="text-xs text-txt-muted text-right">
        {filtered.length} von {invoices.length} Rechnungen
      </div>
    </div>
  );
};

export default InvoicesView;

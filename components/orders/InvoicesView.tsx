import React, { useCallback, useEffect, useMemo, useState } from "react";
import { fetchInvoices, updateInvoiceStatus, downloadInvoicePdfBlob, type InvoiceData } from "../../api/client";
import { EmptyState } from "../ui/EmptyState";

/* ─── Config ─── */
const STATUS_CONFIG: Record<string, { label: string; cls: string }> = {
  entwurf: { label: "Entwurf", cls: "bg-info-dim text-info" },
  gesendet: { label: "Gesendet", cls: "bg-warning-dim text-warning" },
  bezahlt: { label: "Bezahlt", cls: "bg-success-dim text-success" },
  ueberfaellig: { label: "Überfällig", cls: "bg-danger-dim text-danger" },
  storniert: { label: "Storniert", cls: "bg-app-elevated text-txt-muted" },
};

type TabKey = "alle" | string;

const TABS: { key: TabKey; label: string }[] = [
  { key: "alle", label: "Alle" },
  { key: "entwurf", label: "Entwürfe" },
  { key: "gesendet", label: "Gesendet" },
  { key: "bezahlt", label: "Bezahlt" },
  { key: "ueberfaellig", label: "Überfällig" },
  { key: "storniert", label: "Storniert" },
];

/* ─── KPI Card ─── */
const KpiCard: React.FC<{ label: string; value: string | number; tone?: string }> = ({
  label,
  value,
  tone = "text-txt-primary",
}) => (
  <div className="rounded-xl border border-app-border bg-app-surface p-4 flex flex-col gap-1">
    <span className="text-xs font-medium text-txt-muted uppercase tracking-wider">{label}</span>
    <span className={`text-2xl font-bold ${tone}`}>{value}</span>
  </div>
);

/* ─── Main Component ─── */
export const InvoicesView: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TabKey>("alle");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [invoices, setInvoices] = useState<InvoiceData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadInvoices = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await fetchInvoices({ limit: 200 });
      setInvoices(data);
    } catch (err: any) {
      console.error("[InvoicesView] load failed:", err);
      setError(err?.message || "Rechnungen konnten nicht geladen werden");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadInvoices();
  }, [loadInvoices]);

  const filtered = useMemo(() => {
    if (activeTab === "alle") return invoices;
    return invoices.filter((inv) => inv.status === activeTab);
  }, [invoices, activeTab]);

  const tabCounts = useMemo(() => {
    const counts: Record<string, number> = { alle: invoices.length };
    for (const inv of invoices) {
      if (inv.status) counts[inv.status] = (counts[inv.status] || 0) + 1;
    }
    return counts;
  }, [invoices]);

  /* KPIs from real data */
  const kpis = useMemo(() => {
    const open = invoices.filter((inv) => inv.status !== "bezahlt" && inv.status !== "storniert").length;
    const overdue = invoices.filter((inv) => inv.status === "ueberfaellig").length;
    const paidTotal = invoices
      .filter((inv) => inv.status === "bezahlt")
      .reduce((sum, inv) => sum + (inv.amountGross || 0), 0);
    return {
      open,
      overdue,
      paidTotal: paidTotal.toLocaleString("de-DE", { minimumFractionDigits: 2 }),
    };
  }, [invoices]);

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === filtered.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filtered.map((inv) => inv.id)));
    }
  };

  const handleMarkPaid = async (id: string) => {
    try {
      await updateInvoiceStatus(id, "bezahlt");
      setInvoices((prev) => prev.map((inv) => (inv.id === id ? { ...inv, status: "bezahlt" } : inv)));
    } catch (err: any) {
      console.error("[InvoicesView] mark paid failed:", err);
      setError(err?.message || "Status konnte nicht geändert werden");
    }
  };

  const isDueSoon = (dueDate?: string | null, status?: string): boolean => {
    if (!dueDate || status === "bezahlt" || status === "storniert") return false;
    return new Date(dueDate).getTime() < Date.now();
  };

  const handleDownloadPdf = async (invoiceId: string) => {
    try {
      const blob = await downloadInvoicePdfBlob(invoiceId);
      const blobUrl = URL.createObjectURL(blob);
      const printWindow = window.open(blobUrl, "_blank");
      if (!printWindow) {
        const a = document.createElement("a");
        a.href = blobUrl;
        a.download = `rechnung-${invoiceId}.pdf`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
      } else {
        setTimeout(() => URL.revokeObjectURL(blobUrl), 120000);
      }
    } catch (err: any) {
      console.error("[InvoicesView] PDF download failed:", err);
      setError(err?.message || "PDF-Download fehlgeschlagen");
    }
  };

  /* ─── Loading ─── */
  if (loading) {
    return (
      <div className="max-w-7xl mx-auto space-y-5">
        <div>
          <h1 className="text-2xl font-bold text-txt-primary">Rechnungen</h1>
          <p className="text-sm text-txt-muted">Rechnungen erstellen, versenden und verwalten</p>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="rounded-xl border border-app-border bg-app-surface p-4 h-20 animate-pulse" />
          ))}
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
          <p className="text-sm text-txt-muted">Rechnungen erstellen, versenden und verwalten</p>
        </div>
        <button
          type="button"
          onClick={loadInvoices}
          className="inline-flex items-center gap-2 rounded-lg bg-app-elevated text-txt-secondary px-4 py-2.5 text-sm font-semibold hover:text-txt-primary transition"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          Aktualisieren
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-xl border border-danger/20 bg-danger-dim px-4 py-3 text-sm text-danger">
          {error.includes("FAILED_PRECONDITION") || error.includes("index")
            ? "Datenbank-Index wird erstellt. Bitte versuche es in wenigen Minuten erneut."
            : error}
        </div>
      )}

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard label="Offene Rechnungen" value={kpis.open} tone="text-info" />
        <KpiCard label="Gesamt Rechnungen" value={invoices.length} tone="text-accent" />
        <KpiCard label="Überfällig" value={kpis.overdue} tone="text-danger" />
        <KpiCard label="Bezahlt gesamt" value={`${kpis.paidTotal} EUR`} tone="text-success" />
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap gap-2">
        {TABS.map((tab) => {
          const count = tabCounts[tab.key] || 0;
          const active = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition border ${
                active
                  ? "bg-accent-dim text-accent border-accent/20 ring-1 ring-accent/20"
                  : "bg-app-surface text-txt-muted border-app-border hover:border-txt-muted"
              }`}
            >
              {tab.label}
              <span className={`text-[10px] ${active ? "opacity-80" : "opacity-50"}`}>{count}</span>
            </button>
          );
        })}
      </div>

      {/* Bulk Actions */}
      {selected.size > 0 && (
        <div className="flex items-center gap-2 rounded-xl border border-accent/20 bg-accent-dim px-4 py-2.5">
          <span className="text-sm font-medium text-accent">{selected.size} ausgewählt</span>
          <div className="ml-auto flex gap-2">
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="rounded-lg bg-app-elevated text-txt-secondary px-3 py-1.5 text-xs font-semibold hover:text-txt-primary transition"
            >
              Auswahl aufheben
            </button>
          </div>
        </div>
      )}

      {/* Empty state */}
      {!loading && invoices.length === 0 && !error && (
        <div className="rounded-xl border border-app-border bg-app-surface">
          <EmptyState
            icon={<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-txt-muted"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /><polyline points="10 9 9 9 8 9" /></svg>}
            title="Keine Rechnungen vorhanden"
            description="Rechnungen werden automatisch bei versendeten Aufträgen erstellt oder können manuell angelegt werden."
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
                  <th className="px-4 py-3 w-10">
                    <input
                      type="checkbox"
                      checked={selected.size === filtered.length && filtered.length > 0}
                      onChange={toggleAll}
                      className="rounded border-app-border"
                    />
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-txt-muted uppercase tracking-wider">Rechnungs-Nr</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-txt-muted uppercase tracking-wider">Datum</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-txt-muted uppercase tracking-wider">Kunde</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-txt-muted uppercase tracking-wider">Auftrag-ID</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-txt-muted uppercase tracking-wider">Netto</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-txt-muted uppercase tracking-wider">Brutto</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-txt-muted uppercase tracking-wider">Status</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-txt-muted uppercase tracking-wider">Fällig am</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-txt-muted uppercase tracking-wider">Aktionen</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((inv) => {
                  const status = STATUS_CONFIG[inv.status || ""] || { label: inv.status || "—", cls: "bg-app-elevated text-txt-muted" };
                  const overdue = isDueSoon(inv.dueDate, inv.status);
                  return (
                    <tr
                      key={inv.id}
                      className="border-b border-app-border last:border-b-0 hover:bg-app-elevated/40 transition"
                    >
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={selected.has(inv.id)}
                          onChange={() => toggleSelect(inv.id)}
                          className="rounded border-app-border"
                        />
                      </td>
                      <td className="px-4 py-3">
                        <span className="font-mono text-sm font-bold text-txt-primary">{inv.invoiceNumber || "—"}</span>
                      </td>
                      <td className="px-4 py-3 text-xs text-txt-muted whitespace-nowrap">
                        {inv.date ? new Date(inv.date).toLocaleDateString("de-DE") : "—"}
                      </td>
                      <td className="px-4 py-3 text-txt-primary font-medium">{typeof inv.customer === "string" ? inv.customer : inv.customer?.name || "—"}</td>
                      <td className="px-4 py-3 font-mono text-xs text-txt-secondary">{inv.orderId || "—"}</td>
                      <td className="px-4 py-3 text-right text-txt-secondary">
                        {typeof inv.amountNet === "number"
                          ? `${inv.amountNet.toLocaleString("de-DE", { minimumFractionDigits: 2 })} EUR`
                          : "—"}
                      </td>
                      <td className="px-4 py-3 text-right font-semibold text-txt-primary">
                        {typeof inv.amountGross === "number"
                          ? `${inv.amountGross.toLocaleString("de-DE", { minimumFractionDigits: 2 })} EUR`
                          : "—"}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex rounded-md px-2 py-0.5 text-[11px] font-semibold ${status.cls}`}>
                          {status.label}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`text-xs whitespace-nowrap ${overdue ? "text-danger font-semibold" : "text-txt-muted"}`}>
                          {inv.dueDate ? new Date(inv.dueDate).toLocaleDateString("de-DE") : "—"}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1.5">
                          {/* Download PDF */}
                          {inv.pdfUrl && (
                            <button
                              type="button"
                              onClick={() => handleDownloadPdf(inv.id)}
                              className="rounded-lg bg-accent-dim p-1.5 text-accent hover:opacity-80 transition"
                              title="PDF herunterladen"
                            >
                              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                              </svg>
                            </button>
                          )}
                          {/* Mark Paid */}
                          {(inv.status === "gesendet" || inv.status === "ueberfaellig") && (
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
        {filtered.length} / {invoices.length} Rechnungen angezeigt
      </div>
    </div>
  );
};

export default InvoicesView;

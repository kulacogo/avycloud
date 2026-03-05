import React, { useMemo, useState } from "react";

/* ─── Types ─── */
type InvoiceStatus = "entwurf" | "gesendet" | "bezahlt" | "ueberfaellig" | "storniert";

interface Invoice {
  id: string;
  invoiceNumber: string;
  date: string;
  customer: string;
  orderId: string;
  amountNet: number;
  amountGross: number;
  status: InvoiceStatus;
  dueDate: string;
}

/* ─── Config ─── */
const STATUS_CONFIG: Record<InvoiceStatus, { label: string; cls: string }> = {
  entwurf: { label: "Entwurf", cls: "bg-info-dim text-info" },
  gesendet: { label: "Gesendet", cls: "bg-warning-dim text-warning" },
  bezahlt: { label: "Bezahlt", cls: "bg-success-dim text-success" },
  ueberfaellig: { label: "Ueberfaellig", cls: "bg-danger-dim text-danger" },
  storniert: { label: "Storniert", cls: "bg-app-elevated text-txt-muted" },
};

type TabKey = "alle" | InvoiceStatus;

const TABS: { key: TabKey; label: string }[] = [
  { key: "alle", label: "Alle" },
  { key: "entwurf", label: "Entwuerfe" },
  { key: "gesendet", label: "Gesendet" },
  { key: "bezahlt", label: "Bezahlt" },
  { key: "ueberfaellig", label: "Ueberfaellig" },
  { key: "storniert", label: "Storniert" },
];

/* ─── Mock Data ─── */
const MOCK_INVOICES: Invoice[] = [
  {
    id: "inv-1",
    invoiceNumber: "RE-2026-0042",
    date: "2026-03-05",
    customer: "Maximilian Huber",
    orderId: "ORD-2026-1210",
    amountNet: 966.39,
    amountGross: 1150.0,
    status: "entwurf",
    dueDate: "2026-03-19",
  },
  {
    id: "inv-2",
    invoiceNumber: "RE-2026-0041",
    date: "2026-03-04",
    customer: "Lena Schneider",
    orderId: "ORD-2026-1208",
    amountNet: 234.45,
    amountGross: 279.0,
    status: "gesendet",
    dueDate: "2026-03-18",
  },
  {
    id: "inv-3",
    invoiceNumber: "RE-2026-0040",
    date: "2026-03-03",
    customer: "Thomas Wagner",
    orderId: "ORD-2026-1205",
    amountNet: 545.38,
    amountGross: 649.0,
    status: "bezahlt",
    dueDate: "2026-03-17",
  },
  {
    id: "inv-4",
    invoiceNumber: "RE-2026-0039",
    date: "2026-02-20",
    customer: "Julia Becker",
    orderId: "ORD-2026-1185",
    amountNet: 276.47,
    amountGross: 329.0,
    status: "ueberfaellig",
    dueDate: "2026-03-06",
  },
  {
    id: "inv-5",
    invoiceNumber: "RE-2026-0038",
    date: "2026-02-18",
    customer: "Andreas Fischer",
    orderId: "ORD-2026-1170",
    amountNet: 293.28,
    amountGross: 349.0,
    status: "ueberfaellig",
    dueDate: "2026-03-04",
  },
  {
    id: "inv-6",
    invoiceNumber: "RE-2026-0037",
    date: "2026-02-15",
    customer: "Sabine Keller",
    orderId: "ORD-2026-1160",
    amountNet: 839.5,
    amountGross: 999.0,
    status: "storniert",
    dueDate: "2026-03-01",
  },
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

  // TODO: fetch invoices from API — GET /api/orders/invoices
  const invoices = MOCK_INVOICES;

  const filtered = useMemo(() => {
    if (activeTab === "alle") return invoices;
    return invoices.filter((inv) => inv.status === activeTab);
  }, [invoices, activeTab]);

  const tabCounts = useMemo(() => {
    const counts: Record<string, number> = { alle: invoices.length };
    for (const inv of invoices) {
      counts[inv.status] = (counts[inv.status] || 0) + 1;
    }
    return counts;
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

  const handleCreateInvoice = () => {
    // TODO: open create-invoice modal / navigate to invoice creation
  };

  const handleDownloadPdf = (_id: string) => {
    // TODO: GET /api/orders/invoices/:id/pdf — trigger download
  };

  const handleSendInvoice = (_id: string) => {
    // TODO: POST /api/orders/invoices/:id/send — send via email
  };

  const handleMarkPaid = (_id: string) => {
    // TODO: PATCH /api/orders/invoices/:id { status: 'bezahlt' }
  };

  const handleBulkPrint = () => {
    // TODO: POST /api/orders/invoices/bulk-print { ids: [...selected] }
  };

  const handleDunningRun = () => {
    // TODO: POST /api/orders/invoices/dunning-run — start dunning process for overdue invoices
  };

  const isDueSoon = (dueDate: string, status: InvoiceStatus): boolean => {
    if (status === "bezahlt" || status === "storniert") return false;
    const due = new Date(dueDate).getTime();
    const now = Date.now();
    return due < now;
  };

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
          onClick={handleCreateInvoice}
          className="inline-flex items-center gap-2 rounded-lg bg-accent text-white px-4 py-2.5 text-sm font-semibold hover:bg-accent/80 transition"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          Rechnung erstellen
        </button>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard label="Offene Rechnungen" value={7} tone="text-info" />
        <KpiCard label="Gesendet diese Woche" value={23} tone="text-accent" />
        <KpiCard label="Ueberfaellig" value={2} tone="text-danger" />
        <KpiCard label="Umsatz Monat" value="12.450 EUR" tone="text-success" />
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
          <span className="text-sm font-medium text-accent">{selected.size} ausgewaehlt</span>
          <div className="ml-auto flex gap-2">
            <button
              type="button"
              onClick={handleBulkPrint}
              className="rounded-lg bg-app-elevated text-txt-secondary px-3 py-1.5 text-xs font-semibold hover:text-txt-primary transition"
            >
              Alle drucken
            </button>
            <button
              type="button"
              onClick={handleDunningRun}
              className="rounded-lg bg-danger-dim text-danger px-3 py-1.5 text-xs font-semibold hover:opacity-80 transition"
            >
              Mahnlauf starten
            </button>
          </div>
        </div>
      )}

      {/* Table */}
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
                <th className="text-left px-4 py-3 text-xs font-semibold text-txt-muted uppercase tracking-wider">Faellig am</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-txt-muted uppercase tracking-wider">Aktionen</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((inv) => {
                const status = STATUS_CONFIG[inv.status];
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
                      <span className="font-mono text-sm font-bold text-txt-primary">{inv.invoiceNumber}</span>
                    </td>
                    <td className="px-4 py-3 text-xs text-txt-muted whitespace-nowrap">
                      {new Date(inv.date).toLocaleDateString("de-DE")}
                    </td>
                    <td className="px-4 py-3 text-txt-primary font-medium">{inv.customer}</td>
                    <td className="px-4 py-3 font-mono text-xs text-txt-secondary">{inv.orderId}</td>
                    <td className="px-4 py-3 text-right text-txt-secondary">
                      {inv.amountNet.toLocaleString("de-DE", { minimumFractionDigits: 2 })} EUR
                    </td>
                    <td className="px-4 py-3 text-right font-semibold text-txt-primary">
                      {inv.amountGross.toLocaleString("de-DE", { minimumFractionDigits: 2 })} EUR
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex rounded-md px-2 py-0.5 text-[11px] font-semibold ${status.cls}`}>
                        {status.label}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-xs whitespace-nowrap ${overdue ? "text-danger font-semibold" : "text-txt-muted"}`}>
                        {new Date(inv.dueDate).toLocaleDateString("de-DE")}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1.5">
                        {/* PDF Download */}
                        <button
                          type="button"
                          onClick={() => handleDownloadPdf(inv.id)}
                          className="rounded-lg bg-app-elevated p-1.5 text-txt-muted hover:text-txt-primary transition"
                          title="PDF herunterladen"
                        >
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                          </svg>
                        </button>
                        {/* Send */}
                        {inv.status !== "storniert" && inv.status !== "bezahlt" && (
                          <button
                            type="button"
                            onClick={() => handleSendInvoice(inv.id)}
                            className="rounded-lg bg-app-elevated p-1.5 text-txt-muted hover:text-txt-primary transition"
                            title="Per E-Mail senden"
                          >
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
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

      {/* Footer */}
      <div className="text-xs text-txt-muted text-right">
        {filtered.length} / {invoices.length} Rechnungen angezeigt
      </div>
    </div>
  );
};

export default InvoicesView;

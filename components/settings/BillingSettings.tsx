import React, { useEffect, useState } from "react";
import { Card } from "../ui/Card";
import { Button } from "../ui/Button";
import { Badge } from "../ui/Badge";
import { ProgressBar } from "../ui/ProgressBar";
import { Skeleton } from "../ui/Skeleton";
import { fetchBillingUsage, type BillingUsageData } from "../../api/client";

const CheckIcon: React.FC = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-success shrink-0">
    <path d="M20 6L9 17l-5-5" />
  </svg>
);

const CreditCardIcon: React.FC = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-txt-muted">
    <rect x="1" y="4" width="22" height="16" rx="2" ry="2" />
    <line x1="1" y1="10" x2="23" y2="10" />
  </svg>
);

const DownloadIcon: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </svg>
);

const EditIcon: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
    <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
  </svg>
);

/* Plan features — placeholder until Stripe integration */
const planFeatures = [
  "Bis zu 5.000 Produkte",
  "3 Marktplatz-Integrationen",
  "5 Teammitglieder",
  "API-Zugang",
  "E-Mail-Support",
];

interface Invoice {
  id: string;
  date: string;
  description: string;
  amount: string;
  status: "paid" | "pending";
}

function formatNumber(n: number): string {
  return n.toLocaleString("de-DE");
}

interface UsageRow {
  label: string;
  current: number;
  max: number;
}

function buildUsageRows(data: BillingUsageData): UsageRow[] {
  return [
    { label: "Produkte", current: data.products.current, max: data.products.max },
    { label: "Aufträge/Monat", current: data.orders.current, max: data.orders.max },
    { label: "Integrationen", current: data.integrations.current, max: data.integrations.max },
  ];
}

function getProgressVariant(pct: number): "accent" | "warning" | "danger" {
  if (pct > 95) return "danger";
  if (pct > 80) return "warning";
  return "accent";
}

function UsageLoadingSkeleton(): React.ReactElement {
  return (
    <div className="space-y-5">
      {[1, 2, 3].map((i) => (
        <div key={i}>
          <div className="flex items-center justify-between mb-1.5">
            <Skeleton width="80px" height="14px" />
            <Skeleton width="60px" height="14px" />
          </div>
          <Skeleton width="100%" height="8px" />
        </div>
      ))}
    </div>
  );
}

export const BillingSettings: React.FC = () => {
  const [changingPlan] = useState(false);
  const [usage, setUsage] = useState<BillingUsageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /* Invoices — empty until API is available (Stripe integration pending) */
  const [invoices] = useState<Invoice[]>([]);

  useEffect(() => {
    let cancelled = false;

    async function loadUsage(): Promise<void> {
      try {
        setLoading(true);
        setError(null);
        const data = await fetchBillingUsage();
        if (!cancelled) {
          setUsage(data);
        }
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : "Nutzungsdaten konnten nicht geladen werden";
          setError(message);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    loadUsage();
    return () => { cancelled = true; };
  }, []);

  const handleChangePlan = (): void => {
    // TODO: Open plan selection modal or navigate to plan page
  };

  const handleChangePayment = (): void => {
    // TODO: Open Stripe payment method update (POST /api/billing/update-payment-method)
  };

  const handleDownloadInvoice = (_invoiceId: string): void => {
    // TODO: API call to download invoice PDF (GET /api/billing/invoices/:id/pdf)
  };

  const usageRows = usage ? buildUsageRows(usage) : [];

  return (
    <div className="space-y-6">
      {/* Aktueller Plan — Placeholder bis Stripe-Integration */}
      <Card className="border-accent/30">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <h3 className="text-sm font-semibold text-txt-primary">Aktueller Plan</h3>
              <Badge variant="accent" size="md">Professional</Badge>
            </div>
            <p className="text-2xl font-bold text-txt-primary">
              49 <span className="text-base font-normal text-txt-muted">EUR/Monat</span>
            </p>
            <ul className="mt-4 space-y-2.5">
              {planFeatures.map((feature) => (
                <li key={feature} className="flex items-center gap-2.5 text-sm text-txt-secondary">
                  <CheckIcon />
                  {feature}
                </li>
              ))}
            </ul>
          </div>
          <Button
            variant="secondary"
            size="md"
            loading={changingPlan}
            iconLeft={<EditIcon />}
            onClick={handleChangePlan}
            className="shrink-0"
          >
            Plan ändern
          </Button>
        </div>
      </Card>

      {/* Nutzung */}
      <Card>
        <h3 className="text-sm font-semibold text-txt-primary mb-4">Nutzung</h3>

        {loading && <UsageLoadingSkeleton />}

        {error && !loading && (
          <div className="flex items-center justify-between rounded-lg bg-danger/10 px-4 py-3">
            <p className="text-sm text-danger">{error}</p>
            <Button variant="secondary" size="sm" onClick={() => window.location.reload()}>
              Erneut versuchen
            </Button>
          </div>
        )}

        {!loading && !error && usage && (
          <div className="space-y-5">
            {usageRows.map((item) => {
              const pct = (item.current / item.max) * 100;
              const variant = getProgressVariant(pct);
              return (
                <div key={item.label}>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-sm text-txt-secondary">{item.label}</span>
                    <span className="text-sm font-medium text-txt-primary">
                      {formatNumber(item.current)} / {formatNumber(item.max)}
                    </span>
                  </div>
                  <ProgressBar value={pct} variant={variant} />
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* Zahlungsmethode — Placeholder bis Stripe-Integration */}
      <Card>
        <h3 className="text-sm font-semibold text-txt-primary mb-4">Zahlungsmethode</h3>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-12 h-8 rounded-lg bg-app-elevated border border-app-border flex items-center justify-center">
              <CreditCardIcon />
            </div>
            <div>
              <p className="text-sm text-txt-muted italic">Noch keine Zahlungsmethode hinterlegt</p>
            </div>
          </div>
          <Button variant="secondary" size="sm" onClick={handleChangePayment}>
            Zahlungsmethode ändern
          </Button>
        </div>
      </Card>

      {/* Rechnungshistorie */}
      <Card>
        <h3 className="text-sm font-semibold text-txt-primary mb-4">Rechnungshistorie</h3>

        {invoices.length === 0 ? (
          <p className="text-sm text-txt-muted py-4 text-center">
            Noch keine Rechnungen vorhanden.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-app-border">
                  <th className="text-left py-2.5 px-3 text-xs font-medium uppercase tracking-wide text-txt-muted">Datum</th>
                  <th className="text-left py-2.5 px-3 text-xs font-medium uppercase tracking-wide text-txt-muted">Beschreibung</th>
                  <th className="text-right py-2.5 px-3 text-xs font-medium uppercase tracking-wide text-txt-muted">Betrag</th>
                  <th className="text-center py-2.5 px-3 text-xs font-medium uppercase tracking-wide text-txt-muted">Status</th>
                  <th className="text-right py-2.5 px-3 text-xs font-medium uppercase tracking-wide text-txt-muted">PDF</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((invoice) => (
                  <tr key={invoice.id} className="border-b border-app-border/50 last:border-0">
                    <td className="py-3 px-3 text-txt-secondary whitespace-nowrap">{invoice.date}</td>
                    <td className="py-3 px-3 text-txt-primary">{invoice.description}</td>
                    <td className="py-3 px-3 text-txt-primary text-right font-medium whitespace-nowrap">{invoice.amount}</td>
                    <td className="py-3 px-3 text-center">
                      <Badge variant={invoice.status === "paid" ? "success" : "warning"} size="sm">
                        {invoice.status === "paid" ? "Bezahlt" : "Ausstehend"}
                      </Badge>
                    </td>
                    <td className="py-3 px-3 text-right">
                      <button
                        type="button"
                        onClick={() => handleDownloadInvoice(invoice.id)}
                        className="p-1.5 rounded-lg text-txt-muted hover:text-txt-primary hover:bg-app-elevated transition-colors inline-flex"
                        title="PDF herunterladen"
                      >
                        <DownloadIcon />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
};

export default BillingSettings;

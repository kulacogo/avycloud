import React, { useState } from "react";
import { Card } from "../ui/Card";
import { Button } from "../ui/Button";
import { Badge } from "../ui/Badge";
import { ProgressBar } from "../ui/ProgressBar";

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

const planFeatures = [
  "Bis zu 5.000 Produkte",
  "3 Marktplatz-Integrationen",
  "5 Teammitglieder",
  "API-Zugang",
  "E-Mail-Support",
];

interface UsageItem {
  label: string;
  current: number;
  max: number;
  display: string;
}

const usageItems: UsageItem[] = [
  { label: "Produkte", current: 342, max: 5000, display: "342 / 5.000" },
  { label: "Auftrage/Monat", current: 89, max: 2000, display: "89 / 2.000" },
  { label: "Integrationen", current: 3, max: 5, display: "3 / 5" },
  { label: "API-Calls/Monat", current: 28432, max: 100000, display: "28.432 / 100.000" },
];

interface Invoice {
  id: string;
  date: string;
  description: string;
  amount: string;
  status: "paid" | "pending";
}

const invoices: Invoice[] = [
  { id: "INV-2026-003", date: "01.03.2026", description: "Professional Plan -- Marz 2026", amount: "49,00 EUR", status: "paid" },
  { id: "INV-2026-002", date: "01.02.2026", description: "Professional Plan -- Februar 2026", amount: "49,00 EUR", status: "paid" },
  { id: "INV-2026-001", date: "01.01.2026", description: "Professional Plan -- Januar 2026", amount: "49,00 EUR", status: "paid" },
];

export const BillingSettings: React.FC = () => {
  const [changingPlan] = useState(false);

  const handleChangePlan = () => {
    // TODO: Open plan selection modal or navigate to plan page
  };

  const handleChangePayment = () => {
    // TODO: Open Stripe payment method update (POST /api/billing/update-payment-method)
  };

  const handleDownloadInvoice = (_invoiceId: string) => {
    // TODO: API call to download invoice PDF (GET /api/billing/invoices/:id/pdf)
  };

  return (
    <div className="space-y-6">
      {/* Aktueller Plan */}
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
            Plan andern
          </Button>
        </div>
      </Card>

      {/* Nutzung */}
      <Card>
        <h3 className="text-sm font-semibold text-txt-primary mb-4">Nutzung</h3>
        <div className="space-y-5">
          {usageItems.map((item) => {
            const pct = (item.current / item.max) * 100;
            const variant = pct > 80 ? "warning" : pct > 95 ? "danger" : "accent";
            return (
              <div key={item.label}>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-sm text-txt-secondary">{item.label}</span>
                  <span className="text-sm font-medium text-txt-primary">{item.display}</span>
                </div>
                <ProgressBar value={pct} variant={variant} />
              </div>
            );
          })}
        </div>
      </Card>

      {/* Zahlungsmethode */}
      <Card>
        <h3 className="text-sm font-semibold text-txt-primary mb-4">Zahlungsmethode</h3>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-12 h-8 rounded-lg bg-app-elevated border border-app-border flex items-center justify-center">
              <CreditCardIcon />
            </div>
            <div>
              <p className="text-sm font-medium text-txt-primary">Visa •••• 4242</p>
              <p className="text-xs text-txt-muted">Ablauf: 12/2027</p>
            </div>
          </div>
          <Button variant="secondary" size="sm" onClick={handleChangePayment}>
            Zahlungsmethode andern
          </Button>
        </div>
      </Card>

      {/* Rechnungshistorie */}
      <Card>
        <h3 className="text-sm font-semibold text-txt-primary mb-4">Rechnungshistorie</h3>
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
                    <Badge variant="success" size="sm">Bezahlt</Badge>
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
      </Card>
    </div>
  );
};

export default BillingSettings;

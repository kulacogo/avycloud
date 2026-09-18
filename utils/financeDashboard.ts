import type { FinancialReport } from "../types";

export function financeMoney(value: number | null | undefined, currency = "EUR") {
  return value == null || !Number.isFinite(value) ? "—" : new Intl.NumberFormat("de-DE", {
    style: "currency", currency: /^[A-Z]{3}$/.test(currency) ? currency : "EUR", maximumFractionDigits: 2,
  }).format(value);
}
export function validFinanceDates(from: string, to: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to)
    && Number.isFinite(Date.parse(from)) && Number.isFinite(Date.parse(to))
    && new Date(from).toISOString().slice(0, 10) === from && new Date(to).toISOString().slice(0, 10) === to && from <= to;
}
export function financeSummary(report: FinancialReport) {
  const p = report.pnl;
  const net = p.pnlBasis === "netto";
  const revenue = net ? p.umsatzNetto ?? null : p.umsatzBrutto;
  const refunds = net ? p.retourenNetto ?? null : p.retouren;
  const fees = net ? p.gebuehrenNetto ?? null : p.marketplaceFees;
  const shipping = net ? p.versandNetto ?? null : p.versandBrutto;
  const missingCogs = !report.costModel.usable && !(p.coveragePct != null && p.coveragePct > 0);
  const estimatedFees = ["rates", "mixed"].includes(p.feeSource);
  const missingBasis = revenue == null || refunds == null || fees == null;
  const provisional = missingBasis || shipping == null || missingCogs || estimatedFees || report.costModel.usable
    || p.estimatedItemCount > 0 || p.unmatchedItemCount > 0;
  // Never manufacture a final profit when a cost source is absent.
  const result = missingCogs || missingBasis ? null : p.rohgewinn;
  const margin = missingCogs || missingBasis ? null : p.margePct;
  const costs = [
    { key: "cogs", label: "Wareneinsatz", amount: missingCogs ? null : p.cogs, estimated: report.costModel.usable || p.estimatedItemCount > 0, tone: "bg-info" },
    { key: "fees", label: "Marktplatzgebühren", amount: fees, estimated: estimatedFees, tone: "bg-accent" },
    { key: "shipping", label: "Versand", amount: shipping, estimated: false, tone: "bg-warning" },
    { key: "refunds", label: "Erstattungen", amount: refunds, estimated: false, tone: "bg-danger" },
  ];
  const notices = [
    ...(missingBasis ? ["Nettobasis unvollständig"] : []),
    ...(missingCogs ? ["Wareneinsatz fehlt"] : []),
    ...(shipping == null ? ["Versandkosten offen"] : []),
    ...(estimatedFees ? ["Gebühren geschätzt"] : []),
    ...(p.unmatchedItemCount > 0 ? [`${p.unmatchedItemCount} Positionen ohne Warenkosten`] : []),
  ];
  return { net, revenue, refunds, fees, shipping, missingCogs, estimatedFees, provisional, result, margin, costs, notices };
}

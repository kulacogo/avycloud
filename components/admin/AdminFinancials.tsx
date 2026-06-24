import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { fetchFinancialReport } from "../../api/client";
import type { FinancialReport, FinancialReportMarketplaceRow } from "../../types";

// ─── Helpers ────────────────────────────────────────────────────────────────
const safeCur = (c?: string) => (/^[A-Z]{3}$/.test((c || "").toUpperCase()) ? c!.toUpperCase() : "EUR");
const fmtCur = (v: number | null | undefined, c = "EUR", compact = false) => {
  if (v == null || Number.isNaN(v)) return "—";
  try {
    return new Intl.NumberFormat("de-DE", {
      style: "currency",
      currency: safeCur(c),
      maximumFractionDigits: compact && Math.abs(v) >= 1000 ? 0 : 2,
    }).format(v);
  } catch {
    return `${v.toFixed(2)} ${c}`;
  }
};
const fmtNum = (n: number | null | undefined) => (n == null ? "—" : new Intl.NumberFormat("de-DE").format(n));
const fmtPct = (n: number | null | undefined) => (n == null ? "—" : `${n.toLocaleString("de-DE")} %`);

const PRESETS = [
  { id: "today", label: "Heute" },
  { id: "last7", label: "Letzte 7 Tage" },
  { id: "this_week", label: "Diese Woche" },
  { id: "month_to_date", label: "Dieser Monat" },
  { id: "last_month", label: "Letzter Monat" },
  { id: "year_to_date", label: "Dieses Jahr" },
  { id: "last_year", label: "Letztes Jahr" },
  { id: "all_time", label: "Gesamter Zeitraum" },
  { id: "custom", label: "Benutzerdefiniert" },
];

// ─── Honesty badge ────────────────────────────────────────────────────────────
type Trust = "exakt" | "geschätzt" | "abgeleitet" | "kalkulatorisch";
const trustTone: Record<Trust, string> = {
  exakt: "bg-success-dim text-success",
  geschätzt: "bg-warning-dim text-warning",
  abgeleitet: "bg-info-dim text-info",
  kalkulatorisch: "bg-warning-dim text-warning",
};
const TrustBadge: React.FC<{ trust: Trust; note?: string }> = ({ trust, note }) => (
  <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${trustTone[trust]}`}>
    {trust}
    {note ? <span className="opacity-80 font-normal">· {note}</span> : null}
  </span>
);

// ─── Metric card ──────────────────────────────────────────────────────────────
type Tone = "green" | "blue" | "amber" | "violet" | "red" | "neutral";
const toneVal: Record<Tone, string> = {
  green: "text-success", blue: "text-info", amber: "text-warning",
  violet: "text-accent", red: "text-danger", neutral: "text-txt-primary",
};
const toneBar: Record<Tone, string> = {
  green: "bg-success", blue: "bg-info", amber: "bg-warning",
  violet: "bg-accent", red: "bg-danger", neutral: "bg-app-border",
};
const Card: React.FC<{
  label: string; value: React.ReactNode; sub?: React.ReactNode;
  tone?: Tone; badge?: React.ReactNode; size?: "hero" | "normal";
}> = ({ label, value, sub, tone = "neutral", badge, size = "normal" }) => (
  <div className="relative overflow-hidden rounded-xl border border-app-border bg-app-surface p-5 flex flex-col gap-1.5">
    <span aria-hidden className={`absolute inset-y-0 left-0 w-[3px] ${toneBar[tone]}`} />
    <div className="flex items-start justify-between gap-2">
      <p className="text-xs text-txt-muted font-medium">{label}</p>
      {badge}
    </div>
    <p className={`font-semibold tabular-nums leading-tight ${toneVal[tone]} ${size === "hero" ? "text-3xl lg:text-4xl" : "text-2xl"}`}>{value}</p>
    {sub ? <div className="text-xs text-txt-muted leading-snug mt-0.5">{sub}</div> : null}
  </div>
);

// ─── Date range picker (self-contained; mirrors the dashboard's UX) ─────────────
const DateRangePicker: React.FC<{
  activePreset: string;
  presetLabel: string;
  onSelect: (id: string) => void;
  onRefresh: () => void;
  customFrom: string;
  customTo: string;
  onCustomChange: (from: string, to: string) => void;
}> = ({ activePreset, presetLabel, onSelect, onRefresh, customFrom, customTo, onCustomChange }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);
  const handleSelect = (id: string) => {
    onSelect(id);
    if (id !== "custom") setOpen(false);
  };
  return (
    <div ref={ref} className="relative flex items-center gap-2">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-2 px-3 py-2 rounded-md bg-app-surface border border-app-border hover:bg-app-elevated transition-all text-sm text-txt-primary font-medium"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" className="w-4 h-4 text-txt-muted flex-shrink-0">
          <rect x="3" y="4" width="18" height="18" rx="2" />
          <path d="M16 2v4M8 2v4M3 10h18" />
        </svg>
        <span className="max-w-[13rem] truncate">{presetLabel}</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`w-3.5 h-3.5 text-txt-muted transition-transform flex-shrink-0 ${open ? "rotate-180" : ""}`}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      <button
        type="button"
        onClick={onRefresh}
        title="Aktualisieren"
        className="w-9 h-9 flex items-center justify-center rounded-md bg-app-surface border border-app-border text-txt-muted hover:text-txt-primary hover:bg-app-elevated transition-all"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
          <path d="M1 4v6h6M23 20v-6h-6" />
          <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10M23 14l-4.64 4.36A9 9 0 0 1 3.51 15" />
        </svg>
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-2 z-50 bg-app-elevated border border-app-border rounded-lg shadow-app overflow-hidden" style={{ minWidth: "16rem" }}>
          <div className="p-2">
            <p className="text-xs text-txt-muted font-medium px-2 pt-1 pb-1.5">Zeitraum</p>
            {PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => handleSelect(p.id)}
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-all text-left ${
                  activePreset === p.id ? "bg-accent-dim text-accent font-medium" : "text-txt-secondary hover:bg-app-surface hover:text-txt-primary"
                }`}
              >
                {activePreset === p.id ? (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5 text-accent flex-shrink-0">
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                ) : <span className="w-3.5 inline-block" />}
                {p.label}
              </button>
            ))}
          </div>
          {activePreset === "custom" && (
            <div className="border-t border-app-border p-3 space-y-2">
              <p className="text-xs text-txt-muted font-medium px-1">Von – Bis</p>
              <div className="flex gap-2">
                <input type="date" value={customFrom} onChange={(e) => onCustomChange(e.target.value, customTo)} className="flex-1 bg-app-surface border border-app-border rounded-md px-2 py-1.5 text-xs text-txt-primary focus:outline-none focus:border-accent/50" />
                <input type="date" value={customTo} onChange={(e) => onCustomChange(customFrom, e.target.value)} className="flex-1 bg-app-surface border border-app-border rounded-md px-2 py-1.5 text-xs text-txt-primary focus:outline-none focus:border-accent/50" />
              </div>
              <button
                type="button"
                onClick={() => { if (customFrom && customTo) setOpen(false); onRefresh(); }}
                disabled={!customFrom || !customTo}
                className="w-full py-1.5 rounded-md bg-accent-dim text-accent text-xs font-semibold hover:bg-accent/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Anwenden
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ─── P&L row (waterfall) ────────────────────────────────────────────────────
const PnlRow: React.FC<{ label: string; value: React.ReactNode; trust?: Trust; trustNote?: string; sign?: "minus" | "eq"; strong?: boolean }> = ({ label, value, trust, trustNote, sign, strong }) => (
  <div className={`flex items-center justify-between gap-3 py-2 ${strong ? "border-t border-app-border mt-1 pt-3" : ""}`}>
    <div className="flex items-center gap-2 min-w-0">
      <span className={`text-sm ${strong ? "font-semibold text-txt-primary" : "text-txt-secondary"}`}>
        {sign === "minus" ? <span className="text-txt-muted mr-1">−</span> : sign === "eq" ? <span className="text-txt-muted mr-1">=</span> : null}
        {label}
      </span>
      {trust ? <TrustBadge trust={trust} note={trustNote} /> : null}
    </div>
    <span className={`tabular-nums whitespace-nowrap ${strong ? "text-base font-semibold text-txt-primary" : "text-sm text-txt-primary"}`}>{value}</span>
  </div>
);

const mkLabel: Record<string, string> = { ebay: "eBay", kaufland: "Kaufland", other: "Sonstige" };

// ─── Main ─────────────────────────────────────────────────────────────────────
export const AdminFinancials: React.FC = () => {
  const [preset, setPreset] = useState("month_to_date");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [report, setReport] = useState<FinancialReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const opts = preset === "custom" && customFrom && customTo ? { from_date: customFrom, to_date: customTo } : undefined;
      const data = await fetchFinancialReport(preset, opts);
      setReport(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Finanzbericht konnte nicht geladen werden.");
    } finally {
      setLoading(false);
    }
  }, [preset, customFrom, customTo]);

  useEffect(() => {
    // For custom, only fetch once both dates are set (via the "Anwenden" button → onRefresh).
    if (preset === "custom" && (!customFrom || !customTo)) return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset]);

  const presetLabel = useMemo(() => {
    if (report?.range?.label) return report.range.label;
    return PRESETS.find((p) => p.id === preset)?.label || "Zeitraum";
  }, [report, preset]);

  const pnl = report?.pnl;
  const cur = report?.currency || "EUR";
  const payoutExact = pnl?.auszahlungSource === "ebay_finances";
  // When (almost) no sold item has a buyPrice, COGS can't be computed → the
  // "Rohgewinn" excludes goods cost and would overstate profit. Flag it loudly.
  const cov = pnl?.coveragePct;
  const cogsMissing = cov == null || cov < 50;
  const cogsAbsent = cov == null || cov <= 0;

  const chartData = useMemo(
    () => (report?.timeseries || []).map((b) => ({ date: b.date, Umsatz: b.umsatz, Rohertrag: b.rohertrag })),
    [report],
  );

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-txt-primary">Finanzbericht</h2>
          <p className="text-xs text-txt-muted">{presetLabel} · Umsatz, Kosten, Auszahlung &amp; Gewinn</p>
        </div>
        <DateRangePicker
          activePreset={preset}
          presetLabel={presetLabel}
          onSelect={(id) => setPreset(id)}
          onRefresh={() => void load()}
          customFrom={customFrom}
          customTo={customTo}
          onCustomChange={(f, t) => { setCustomFrom(f); setCustomTo(t); }}
        />
      </div>

      {error ? (
        <div className="rounded-xl border border-danger/40 bg-danger-dim p-4 text-sm text-danger">{error}</div>
      ) : null}

      {!loading && report && cogsMissing ? (
        <div className="rounded-xl border border-warning/40 bg-warning-dim p-4 text-sm text-warning">
          <span className="font-semibold">Gewinn unvollständig:</span>{" "}
          Für {fmtPct(cov == null ? 0 : 100 - cov)} der Verkäufe ist kein Einkaufspreis hinterlegt
          {report.inventory.articlesWithCost === 0 ? " (0 Produkte mit Einkaufspreis)" : ""}.
          Der Wareneinsatz ist daher kalkulatorisch unvollständig und der Rohgewinn überschätzt.
          Sobald Einkaufspreise gepflegt sind (Produkt-UI oder CSV-Import „Einkaufspreis"), füllt sich die Marge automatisch.
        </div>
      ) : null}

      {loading || !report ? (
        <div className="rounded-xl border border-app-border bg-app-surface p-8 text-center text-sm text-txt-muted">
          {loading ? "Lade Finanzdaten …" : "Keine Daten."}
        </div>
      ) : (
        <>
          {/* Hero KPIs */}
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
            <Card label="Umsatz (brutto)" value={fmtCur(pnl?.umsatzBrutto, cur, true)} tone="blue" size="hero"
              badge={<TrustBadge trust="exakt" />}
              sub={`${fmtNum(pnl?.orderCount)} Aufträge`} />
            <Card label="Auszahlung" value={fmtCur(pnl?.auszahlung, cur, true)} tone="violet" size="hero"
              badge={<TrustBadge trust={payoutExact ? "exakt" : "geschätzt"} />}
              sub={payoutExact ? "eBay Finances + Kaufland" : "geschätzt (eBay ×0,75 · Kaufland ×0,8334)"} />
            <Card
              label={cogsAbsent ? "Deckungsbeitrag (ohne Wareneinsatz)" : "Rohgewinn / Deckungsbeitrag"}
              value={fmtCur(pnl?.rohgewinn, cur, true)}
              tone={cogsMissing ? "amber" : (pnl?.rohgewinn ?? 0) >= 0 ? "green" : "red"} size="hero"
              badge={<TrustBadge trust="kalkulatorisch" />}
              sub={cogsAbsent ? "⚠ Einkaufspreise fehlen — Gewinn überschätzt" : `Marge ${fmtPct(pnl?.margePct)} · COGS-Abdeckung ${fmtPct(cov)}`} />
            <Card label="Kontostand (SevDesk)" value={fmtCur(report.balances.total, cur, true)}
              tone={report.balances.total >= 0 ? "neutral" : "red"} size="hero"
              badge={<TrustBadge trust="exakt" note="Stichtag" />}
              sub={`${fmtNum(report.balances.accounts.length)} Konten`} />
          </div>

          {/* P&L breakdown + Chart */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="rounded-xl border border-app-border bg-app-surface p-5">
              <h3 className="text-sm font-semibold text-txt-primary mb-2">Gewinn &amp; Verlust</h3>
              <PnlRow label="Umsatz (brutto)" value={fmtCur(pnl?.umsatzBrutto, cur)} trust="exakt" />
              <PnlRow label="Marktplatz-Gebühren" value={fmtCur(pnl?.marketplaceFees, cur)} trust="abgeleitet" sign="minus" />
              <PnlRow label="Auszahlung" value={fmtCur(pnl?.auszahlung, cur)} trust={payoutExact ? "exakt" : "geschätzt"} sign="eq" />
              <PnlRow label="Versandkosten (brutto)" value={fmtCur(pnl?.versandBrutto, cur)} trust="exakt" sign="minus" />
              <PnlRow label="Wareneinsatz (COGS)" value={fmtCur(pnl?.cogs, cur)} trust="kalkulatorisch" trustNote={`${fmtPct(pnl?.coveragePct)} Abdeckung`} sign="minus" />
              <PnlRow label="Retouren (Erstattungen)" value={fmtCur(pnl?.retouren, cur)} trust="exakt" sign="minus" />
              <PnlRow label="Rohgewinn / Deckungsbeitrag" value={fmtCur(pnl?.rohgewinn, cur)} sign="eq" strong />
              <p className="text-[11px] text-txt-muted mt-3 leading-snug">
                Rohgewinn = Auszahlung − Versand − Wareneinsatz − Retouren. Fixkosten (z. B. Monatsgebühren)
                sind nicht enthalten — daher Deckungsbeitrag, nicht Reingewinn.
              </p>
            </div>

            <div className="rounded-xl border border-app-border bg-app-surface p-5">
              <h3 className="text-sm font-semibold text-txt-primary mb-3">Umsatz &amp; Rohertrag im Zeitverlauf</h3>
              {chartData.length === 0 ? (
                <div className="h-[240px] flex items-center justify-center text-sm text-txt-muted">Keine Aufträge im Zeitraum.</div>
              ) : (
                <ResponsiveContainer width="100%" height={240}>
                  <ComposedChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="date" tick={{ fontSize: 11, fill: "var(--text-muted)" }} tickLine={false} axisLine={{ stroke: "var(--border)" }} />
                    <YAxis tick={{ fontSize: 11, fill: "var(--text-muted)" }} tickLine={false} axisLine={false} width={48}
                      tickFormatter={(v: number) => (Math.abs(v) >= 1000 ? `${Math.round(v / 1000)}k` : String(v))} />
                    <Tooltip
                      cursor={{ fill: "var(--surface)" }}
                      content={(props: any) => {
                        if (!props?.active || !props?.payload?.length) return null;
                        return (
                          <div className="rounded-lg border border-app-border bg-app-elevated px-3 py-2 text-xs shadow-app">
                            <p className="text-txt-muted mb-1">{props.label}</p>
                            {props.payload.map((p: any) => (
                              <p key={p.dataKey} className="flex items-center justify-between gap-3">
                                <span className="text-txt-secondary">{p.name}</span>
                                <span className="tabular-nums text-txt-primary">{fmtCur(p.value, cur)}</span>
                              </p>
                            ))}
                          </div>
                        );
                      }}
                    />
                    <Bar dataKey="Umsatz" fill="var(--info)" radius={[3, 3, 0, 0]} maxBarSize={28} />
                    <Line dataKey="Rohertrag" stroke="var(--success)" strokeWidth={2} dot={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              )}
              <p className="text-[11px] text-txt-muted mt-2">Rohertrag = Umsatz − Wareneinsatz (pro Bucket exakt; ohne Gebühren/Versand).</p>
            </div>
          </div>

          {/* Marketplace breakdown */}
          <div className="rounded-xl border border-app-border bg-app-surface p-5">
            <h3 className="text-sm font-semibold text-txt-primary mb-3">Nach Marktplatz</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-txt-muted text-left">
                    <th className="font-medium py-1.5 pr-3">Marktplatz</th>
                    <th className="font-medium py-1.5 px-3 text-right">Aufträge</th>
                    <th className="font-medium py-1.5 px-3 text-right">Umsatz</th>
                    <th className="font-medium py-1.5 px-3 text-right">Auszahlung</th>
                    <th className="font-medium py-1.5 px-3 text-right">Gebühren</th>
                    <th className="font-medium py-1.5 pl-3 text-right">Wareneinsatz</th>
                  </tr>
                </thead>
                <tbody>
                  {(["ebay", "kaufland", "other"] as const).map((k) => {
                    const m: FinancialReportMarketplaceRow = report.marketplace[k];
                    if (!m || (m.orders === 0 && m.umsatz === 0)) return null;
                    return (
                      <tr key={k} className="border-t border-app-border/60">
                        <td className="py-2 pr-3 text-txt-primary font-medium">{mkLabel[k]}</td>
                        <td className="py-2 px-3 text-right tabular-nums text-txt-secondary">{fmtNum(m.orders)}</td>
                        <td className="py-2 px-3 text-right tabular-nums text-txt-primary">{fmtCur(m.umsatz, cur)}</td>
                        <td className="py-2 px-3 text-right tabular-nums text-txt-secondary">{fmtCur(m.payout, cur)}</td>
                        <td className="py-2 px-3 text-right tabular-nums text-txt-muted">{fmtCur(m.fees, cur)} <span className="text-[10px]">({fmtPct(m.feePct)})</span></td>
                        <td className="py-2 pl-3 text-right tabular-nums text-txt-secondary">{fmtCur(m.cogs, cur)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Inventory + balances */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="rounded-xl border border-app-border bg-app-surface p-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-txt-primary">Bestandswert</h3>
                <TrustBadge trust="exakt" note="Stichtag heute" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="text-xs text-txt-muted">Potenzieller Umsatz</p>
                  <p className="text-xl font-semibold tabular-nums text-txt-primary">{fmtCur(report.inventory.potentialRevenue, cur, true)}</p>
                  <p className="text-[11px] text-txt-muted">Menge × Verkaufs-/Marktpreis</p>
                </div>
                <div>
                  <p className="text-xs text-txt-muted">Gebundenes Kapital</p>
                  <p className="text-xl font-semibold tabular-nums text-txt-primary">
                    {report.inventory.articlesWithCost > 0 ? fmtCur(report.inventory.capitalAtCost, cur, true) : "—"}
                  </p>
                  <p className="text-[11px] text-txt-muted">
                    {report.inventory.articlesWithCost > 0
                      ? `Menge × Einkaufspreis · ${fmtNum(report.inventory.articlesWithCost)}/${fmtNum(report.inventory.articleCount)} Artikel mit EK`
                      : "Einkaufspreise fehlen"}
                  </p>
                </div>
              </div>
              <p className="text-xs text-txt-muted mt-3">{fmtNum(report.inventory.articleCount)} Artikel · {fmtNum(report.inventory.unitCount)} Einheiten</p>
            </div>

            <div className="rounded-xl border border-app-border bg-app-surface p-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-txt-primary">Kontostand</h3>
                <TrustBadge trust="exakt" note="SevDesk" />
              </div>
              {report.balances.accounts.length === 0 ? (
                <p className="text-sm text-txt-muted">Keine Konten verfügbar.</p>
              ) : (
                <ul className="space-y-1.5">
                  {report.balances.accounts.map((a) => (
                    <li key={a.id} className="flex items-center justify-between text-sm">
                      <span className="text-txt-secondary truncate">{a.name}</span>
                      <span className={`tabular-nums ${a.balance < 0 ? "text-danger" : "text-txt-primary"}`}>{fmtCur(a.balance, a.currency || cur)}</span>
                    </li>
                  ))}
                  <li className="flex items-center justify-between text-sm border-t border-app-border pt-1.5 mt-1.5 font-semibold">
                    <span className="text-txt-primary">Gesamt</span>
                    <span className={`tabular-nums ${report.balances.total < 0 ? "text-danger" : "text-txt-primary"}`}>{fmtCur(report.balances.total, cur)}</span>
                  </li>
                </ul>
              )}
            </div>
          </div>

          {/* Data quality / honesty panel */}
          <div className="rounded-xl border border-app-border bg-app-bg/40 p-5">
            <h3 className="text-sm font-semibold text-txt-primary mb-3">Datenqualität</h3>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
              <div>
                <p className="text-xs text-txt-muted">COGS-Abdeckung</p>
                <p className="font-semibold tabular-nums text-txt-primary">{fmtPct(report.quality.cogsCoveragePct)}</p>
                <p className="text-[11px] text-txt-muted">{fmtNum(report.quality.unmatchedItemCount)} Posten ohne Kostendaten</p>
              </div>
              <div>
                <p className="text-xs text-txt-muted">Auszahlungs-Quelle</p>
                <p className="font-semibold text-txt-primary">{payoutExact ? "eBay Finances" : "Geschätzt"}</p>
                <p className="text-[11px] text-txt-muted">{payoutExact ? "exakt nach Gebühren" : "×0,75 / ×0,8334"}</p>
              </div>
              <div>
                <p className="text-xs text-txt-muted">Versand-Quelle</p>
                <p className="font-semibold text-txt-primary">{report.quality.shippingSource || "—"}</p>
                <p className="text-[11px] text-txt-muted">{report.shipping ? `${fmtNum(report.shipping.parcelCount)} Sendungen` : "keine Daten"}</p>
              </div>
              <div>
                <p className="text-xs text-txt-muted">Produkte im Katalog</p>
                <p className="font-semibold tabular-nums text-txt-primary">{fmtNum(report.quality.productCount)}</p>
                <p className="text-[11px] text-txt-muted">Basis für COGS &amp; Bestand</p>
              </div>
            </div>
            {report.errors.length > 0 ? (
              <ul className="mt-3 space-y-1">
                {report.errors.map((e, i) => (
                  <li key={i} className="text-xs text-warning flex items-center gap-1.5">
                    <span className="w-1 h-1 rounded-full bg-warning inline-block" /> {e}
                  </li>
                ))}
              </ul>
            ) : null}
            <p className="text-[11px] text-txt-muted mt-3">
              „Kalkulatorisch": Wareneinsatz basiert auf dem heutigen Einkaufspreis je verkauftem Artikel
              (historische Preisänderungen nicht erfasst). Stand: {new Date(report.generated_at_iso).toLocaleString("de-DE")}.
            </p>
          </div>
        </>
      )}
    </div>
  );
};

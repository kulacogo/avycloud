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
import { fetchFinancialReport, saveFinancialCostModel } from "../../api/client";
import type { FinancialReport, FinancialReportMarketplaceRow, FinancialCostModelInput } from "../../types";

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
const fmtPct = (n: number | null | undefined) => (n == null ? "—" : `${n.toLocaleString("de-DE", { maximumFractionDigits: 1 })} %`);

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

// ─── Honesty badge — only NON-exact values are flagged (exact is the norm) ───
type Trust = "geschätzt" | "erwartet" | "kalkulatorisch" | "ausstehend";
const trustTone: Record<Trust, string> = {
  geschätzt: "bg-warning-dim text-warning",
  erwartet: "bg-info-dim text-info",
  kalkulatorisch: "bg-warning-dim text-warning",
  ausstehend: "bg-app-elevated text-txt-muted",
};
const TrustBadge: React.FC<{ trust: Trust; note?: string }> = ({ trust, note }) => (
  <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full whitespace-nowrap ${trustTone[trust]}`}>
    {trust}
    {note ? <span className="opacity-80 font-normal">· {note}</span> : null}
  </span>
);

// ─── Info tooltip (native title — explanations live here, not in the layout) ─
const Info: React.FC<{ text: string }> = ({ text }) => (
  <span
    title={text}
    className="inline-flex h-4 w-4 shrink-0 cursor-help items-center justify-center rounded-full border border-app-border text-[10px] font-semibold text-txt-muted hover:text-txt-primary hover:border-txt-muted"
    aria-label={text}
  >
    i
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
  tone?: Tone; badge?: React.ReactNode; info?: string;
}> = ({ label, value, sub, tone = "neutral", badge, info }) => (
  <div className="relative overflow-hidden rounded-xl border border-app-border bg-app-surface p-5 flex flex-col gap-1.5">
    <span aria-hidden className={`absolute inset-y-0 left-0 w-[3px] ${toneBar[tone]}`} />
    <div className="flex items-start justify-between gap-2">
      <p className="flex items-center gap-1.5 text-xs text-txt-muted font-medium">
        {label}
        {info ? <Info text={info} /> : null}
      </p>
      {badge}
    </div>
    <p className={`font-semibold tabular-nums leading-tight text-3xl lg:text-4xl ${toneVal[tone]}`}>{value}</p>
    {sub ? <div className="text-xs text-txt-muted leading-snug mt-0.5">{sub}</div> : null}
  </div>
);

// ─── Date range picker ────────────────────────────────────────────────────────
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

// ─── P&L row ─────────────────────────────────────────────────────────────────
const PnlRow: React.FC<{ label: string; value: React.ReactNode; badge?: React.ReactNode; sign?: "minus" | "eq"; strong?: boolean }> = ({ label, value, badge, sign, strong }) => (
  <div className={`flex items-center justify-between gap-3 py-2 ${strong ? "border-t border-app-border mt-1 pt-3" : ""}`}>
    <div className="flex items-center gap-2 min-w-0">
      <span className={`text-sm ${strong ? "font-semibold text-txt-primary" : "text-txt-secondary"}`}>
        {sign === "minus" ? <span className="text-txt-muted mr-1">−</span> : sign === "eq" ? <span className="text-txt-muted mr-1">=</span> : null}
        {label}
      </span>
      {badge}
    </div>
    <span className={`tabular-nums whitespace-nowrap ${strong ? "text-base font-semibold text-txt-primary" : "text-sm text-txt-primary"}`}>{value}</span>
  </div>
);

const mkLabel: Record<string, string> = { ebay: "eBay", kaufland: "Kaufland", other: "Sonstige" };

// ─── Cost model editor (unchanged mechanics, lives in the footer zone) ────────
const CostModelEditor: React.FC<{ report: FinancialReport; open: boolean; onToggle: () => void; onSaved: () => void }> = ({ report, open, onToggle, onSaved }) => {
  const cm = report.costModel;
  const [palletCostBrutto, setPalletCostBrutto] = useState(String(cm.palletCostBrutto || ""));
  const [unitsPerPallet, setUnitsPerPallet] = useState(String(cm.unitsPerPallet || ""));
  const [vatMode, setVatMode] = useState<"netto" | "brutto">(cm.vatMode);
  const [mode, setMode] = useState<"proportional" | "flat">(cm.mode);
  const [feeEbay, setFeeEbay] = useState(String(Math.round((cm.feeRateEbay || 0) * 10000) / 100));
  const [feeKaufland, setFeeKaufland] = useState(String(Math.round((cm.feeRateKaufland || 0) * 10000) / 100));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      const input: FinancialCostModelInput = {
        mode,
        vatMode,
        palletCostBrutto: parseFloat(palletCostBrutto.replace(",", ".")) || 0,
        unitsPerPallet: parseFloat(unitsPerPallet.replace(",", ".")) || 0,
        feeRateEbay: (parseFloat(feeEbay.replace(",", ".")) || 0) / 100,
        feeRateKaufland: (parseFloat(feeKaufland.replace(",", ".")) || 0) / 100,
      };
      await saveFinancialCostModel(input);
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Speichern fehlgeschlagen.");
    } finally {
      setSaving(false);
    }
  };

  const field = "w-full bg-app-surface border border-app-border rounded-md px-2.5 py-1.5 text-sm text-txt-primary focus:outline-none focus:border-accent/50";
  const lbl = "text-xs text-txt-muted mb-1 block";

  return (
    <div className="rounded-xl border border-app-border bg-app-bg/40 p-4">
      <button type="button" onClick={onToggle} className="w-full flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0 text-left">
          <h3 className="text-sm font-semibold text-txt-primary shrink-0">Kostenmodell</h3>
          <p className="truncate text-[11px] text-txt-muted">
            {cm.usable
              ? `Quote ${cm.ratio != null ? (cm.ratio * 100).toFixed(1) + " %" : "—"} · Ø-EK ${fmtCur(cm.avgUnitCostNetto, "EUR")} · eBay ${fmtPct(Math.round(cm.feeRateEbay * 1000) / 10)} · Kaufland ${fmtPct(Math.round(cm.feeRateKaufland * 1000) / 10)}`
              : "Nicht eingestellt — Palettenpreis + Einheiten eingeben"}
          </p>
          <Info text="Wareneinsatz je Artikel = Verkaufspreis × Kostenquote (aus Palettenpreis ÷ Einheiten). Ein echter Einkaufspreis am Produkt schlägt das Modell. Die Gebührensätze dienen als Fallback, solange keine Bank-Gutschrift vorliegt." />
        </div>
        <span className="shrink-0 text-txt-muted text-xs">{open ? "▲ schließen" : "bearbeiten"}</span>
      </button>

      {open ? (
        <div className="mt-4 space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div>
              <label className={lbl}>Palettenpreis (brutto €)</label>
              <input className={field} value={palletCostBrutto} onChange={(e) => setPalletCostBrutto(e.target.value)} inputMode="decimal" placeholder="400" />
            </div>
            <div>
              <label className={lbl}>Einheiten je Palette</label>
              <input className={field} value={unitsPerPallet} onChange={(e) => setUnitsPerPallet(e.target.value)} inputMode="decimal" placeholder="18" />
            </div>
            <div>
              <label className={lbl}>Kostenbasis</label>
              <select className={field} value={vatMode} onChange={(e) => setVatMode(e.target.value as "netto" | "brutto")}>
                <option value="netto">Netto (Vorsteuer abziehbar)</option>
                <option value="brutto">Brutto (wie bezahlt)</option>
              </select>
            </div>
            <div>
              <label className={lbl}>Verteilung</label>
              <select className={field} value={mode} onChange={(e) => setMode(e.target.value as "proportional" | "flat")}>
                <option value="proportional">Proportional z. Verkaufspreis</option>
                <option value="flat">Pauschal gleich je Stück</option>
              </select>
            </div>
            <div>
              <label className={lbl}>eBay-Gebühr (%)</label>
              <input className={field} value={feeEbay} onChange={(e) => setFeeEbay(e.target.value)} inputMode="decimal" placeholder="11" />
            </div>
            <div>
              <label className={lbl}>Kaufland-Gebühr (%)</label>
              <input className={field} value={feeKaufland} onChange={(e) => setFeeKaufland(e.target.value)} inputMode="decimal" placeholder="16.66" />
            </div>
          </div>
          {err ? <p className="text-xs text-danger">{err}</p> : null}
          <button type="button" onClick={save} disabled={saving} className="rounded-md bg-accent px-4 py-1.5 text-sm font-semibold text-txt-primary hover:bg-accent/90 disabled:opacity-50">
            {saving ? "Speichere …" : "Speichern & neu berechnen"}
          </button>
        </div>
      ) : null}
    </div>
  );
};

// ─── Main ─────────────────────────────────────────────────────────────────────
export const AdminFinancials: React.FC = () => {
  const [preset, setPreset] = useState("month_to_date");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [report, setReport] = useState<FinancialReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Sequence guard: only the latest request may write state.
  const reqSeqRef = useRef(0);

  const load = useCallback(async () => {
    const seq = ++reqSeqRef.current;
    setLoading(true);
    setError(null);
    try {
      const opts = preset === "custom" && customFrom && customTo ? { from_date: customFrom, to_date: customTo } : undefined;
      const data = await fetchFinancialReport(preset, opts);
      if (seq === reqSeqRef.current) setReport(data);
    } catch (e) {
      if (seq === reqSeqRef.current) setError(e instanceof Error ? e.message : "Finanzbericht konnte nicht geladen werden.");
    } finally {
      if (seq === reqSeqRef.current) setLoading(false);
    }
  }, [preset, customFrom, customTo]);

  useEffect(() => {
    if (preset === "custom" && (!customFrom || !customTo)) return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset]);

  const presetLabel = useMemo(() => {
    if (report?.range?.label) return report.range.label;
    return PRESETS.find((p) => p.id === preset)?.label || "Zeitraum";
  }, [report, preset]);

  const [editCost, setEditCost] = useState(false);

  const pnl = report?.pnl;
  const cur = report?.currency || "EUR";
  const payoutExact = pnl?.auszahlungSource === "sevdesk";
  const cm = report?.costModel;
  const cogsModelActive = !!cm?.usable;
  const cov = pnl?.coveragePct;
  const cogsUnavailable = !cogsModelActive && (cov == null || cov <= 0);

  // ── Settlement-aware P&L ────────────────────────────────────────────────────
  // Payouts lag sales (marketplace settlement). For short windows the bank
  // credit is often still 0 — the naive flow formula (Gebühren = Umsatz −
  // Auszahlung) would then claim "fees = 100%" and a deeply negative Rohgewinn.
  // That is noise, not truth. While the payout is pending we show a RATE-BASED
  // estimate (cost-model fee rates) and mark it as such; once real bank
  // credits exist, the exact flow numbers take over automatically.
  const derived = useMemo(() => {
    if (!report || !pnl) return null;
    const umsatz = pnl.umsatzBrutto ?? 0;
    const payoutPending = (pnl.auszahlung ?? 0) <= 0 && umsatz > 0;
    if (!payoutPending) {
      return {
        payoutPending: false,
        fees: pnl.marketplaceFees,
        feesTrust: pnl.feeSource === "flow" ? null : ("kalkulatorisch" as Trust),
        payout: pnl.auszahlung,
        rohgewinn: pnl.rohgewinn,
        marge: pnl.margePct,
      };
    }
    const rateOf: Record<string, number> = {
      ebay: cm?.feeRateEbay ?? 0.13,
      kaufland: cm?.feeRateKaufland ?? 0.13,
      other: 0,
    };
    let fees = 0;
    (["ebay", "kaufland", "other"] as const).forEach((k) => {
      const m = report.marketplace[k];
      if (m) fees += (m.umsatz || 0) * (rateOf[k] || 0);
    });
    fees = Math.round(fees * 100) / 100;
    const retouren = pnl.retouren ?? 0;
    const expectedPayout = Math.round((umsatz - retouren - fees) * 100) / 100;
    const rohgewinn = Math.round((expectedPayout - (pnl.cogs ?? 0) - (pnl.versandBrutto ?? 0)) * 100) / 100;
    const marge = umsatz > 0 ? Math.round((rohgewinn / umsatz) * 1000) / 10 : null;
    return { payoutPending: true, fees, feesTrust: "kalkulatorisch" as Trust, payout: expectedPayout, rohgewinn, marge };
  }, [report, pnl, cm]);

  const chartData = useMemo(
    () => (report?.timeseries || []).map((b) => ({ date: b.date, Umsatz: b.umsatz, Rohertrag: b.rohertrag })),
    [report],
  );

  const rohTone: Tone = cogsUnavailable ? "amber" : (derived?.rohgewinn ?? 0) >= 0 ? "green" : "red";

  return (
    <div className="space-y-4">
      {/* Controls — the page title comes from the surrounding view */}
      <div className="flex items-center justify-end">
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

      {!loading && report && cogsUnavailable ? (
        <div className="rounded-xl border border-warning/40 bg-warning-dim p-4 text-sm text-warning flex items-center justify-between gap-3">
          <span>
            <span className="font-semibold">Wareneinsatz fehlt:</span>{" "}
            Rohgewinn enthält keine Warenkosten.
          </span>
          <button type="button" onClick={() => setEditCost(true)} className="shrink-0 rounded-md bg-warning/20 px-3 py-1.5 text-xs font-semibold text-warning hover:bg-warning/30">
            Kostenmodell einstellen
          </button>
        </div>
      ) : null}

      {loading || !report ? (
        <div className="rounded-xl border border-app-border bg-app-surface p-8 text-center text-sm text-txt-muted">
          {loading ? "Lade Finanzdaten …" : "Keine Daten."}
        </div>
      ) : (
        <>
          {/* ① Answer: 4 hero KPIs */}
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
            <Card label="Umsatz" value={fmtCur(pnl?.umsatzBrutto, cur, true)} tone="blue"
              sub={`${fmtNum(pnl?.orderCount)} Aufträge · brutto`} />
            <Card
              label="Rohgewinn"
              value={fmtCur(derived?.rohgewinn, cur, true)}
              tone={rohTone}
              badge={derived?.payoutPending ? <TrustBadge trust="kalkulatorisch" /> : undefined}
              info="Auszahlung − Wareneinsatz − Versand. Fixkosten nicht enthalten (Deckungsbeitrag). Solange die Marktplatz-Auszahlung aussteht, wird mit den Gebührensätzen gerechnet."
              sub={cogsUnavailable ? "ohne Warenkosten — Kostenmodell einstellen" : `Marge ${fmtPct(derived?.marge)}`} />
            <Card
              label={derived?.payoutPending ? "Auszahlung (erwartet)" : "Auszahlung"}
              value={fmtCur(derived?.payout, cur, true)} tone="violet"
              badge={derived?.payoutPending ? <TrustBadge trust="ausstehend" /> : undefined}
              info="Echte Bank-Gutschriften der Marktplätze (SevDesk). Marktplätze zahlen zeitversetzt aus — bei kurzen Zeiträumen wird die erwartete Auszahlung angezeigt, bis die Gutschrift eingeht."
              sub={derived?.payoutPending ? "Bank-Gutschrift folgt zeitversetzt" : "Bank-Gutschriften eBay + Kaufland"} />
            <Card label="Kontostand" value={fmtCur(report.balances.total, cur, true)}
              tone={report.balances.total >= 0 ? "neutral" : "red"}
              info="Sichteinlagen laut SevDesk, Stand heute."
              sub={`${fmtNum(report.balances.accounts.length)} ${report.balances.accounts.length === 1 ? "Konto" : "Konten"} · SevDesk`} />
          </div>

          {/* ② Trajectory + P&L */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2 rounded-xl border border-app-border bg-app-surface p-5">
              <h3 className="flex items-center gap-1.5 text-sm font-semibold text-txt-primary mb-3">
                Umsatz &amp; Rohertrag
                <Info text="Rohertrag = Umsatz − Wareneinsatz je Tag (ohne Gebühren und Versand)." />
              </h3>
              {chartData.length === 0 ? (
                <div className="h-[260px] flex items-center justify-center text-sm text-txt-muted">Keine Aufträge im Zeitraum.</div>
              ) : (
                <ResponsiveContainer width="100%" height={260}>
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
            </div>

            <div className="rounded-xl border border-app-border bg-app-surface p-5">
              <h3 className="flex items-center gap-1.5 text-sm font-semibold text-txt-primary mb-2">
                Gewinn &amp; Verlust
                <Info text={derived?.payoutPending
                  ? "Auszahlung steht noch aus (Settlement) — Gebühren und Rohgewinn werden bis dahin aus den Gebührensätzen gerechnet und automatisch durch die exakten Bank-Werte ersetzt."
                  : "Gebühren = Umsatz − Retouren − Auszahlung (alle Marktplatzgebühren inkl. Werbung). Rohgewinn = Auszahlung − Wareneinsatz − Versand. Fixkosten nicht enthalten."} />
              </h3>
              <PnlRow label="Umsatz" value={fmtCur(pnl?.umsatzBrutto, cur)} />
              <PnlRow label="Gebühren" value={fmtCur(derived?.fees, cur)} sign="minus"
                badge={derived?.feesTrust ? <TrustBadge trust={derived.feesTrust} /> : undefined} />
              <PnlRow label="Retouren" value={fmtCur(pnl?.retouren, cur)} sign="minus" />
              <PnlRow label={derived?.payoutPending ? "Auszahlung (erwartet)" : "Auszahlung"} value={fmtCur(derived?.payout, cur)} sign="eq"
                badge={derived?.payoutPending ? <TrustBadge trust="ausstehend" /> : undefined} />
              <PnlRow label="Wareneinsatz" value={fmtCur(pnl?.cogs, cur)} sign="minus"
                badge={cogsModelActive ? <TrustBadge trust="kalkulatorisch" /> : undefined} />
              <PnlRow label="Versand" value={fmtCur(pnl?.versandBrutto, cur)} sign="minus" />
              <PnlRow label="Rohgewinn" value={<span className={(derived?.rohgewinn ?? 0) >= 0 ? "text-success" : "text-danger"}>{fmtCur(derived?.rohgewinn, cur)}</span>} sign="eq" strong />
            </div>
          </div>

          {/* ③ Drill-down: marketplaces */}
          <div className="rounded-xl border border-app-border bg-app-surface p-5">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold text-txt-primary mb-3">
              Nach Marktplatz
              <Info text="Auszahlung = echte SevDesk-Bank-Gutschriften. Solange sie aussteht, werden die Gebühren aus den Sätzen des Kostenmodells gerechnet." />
            </h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-txt-muted text-left">
                    <th className="font-medium py-1.5 pr-3">Marktplatz</th>
                    <th className="font-medium py-1.5 px-3 text-right">Aufträge</th>
                    <th className="font-medium py-1.5 px-3 text-right">Umsatz</th>
                    <th className="font-medium py-1.5 px-3 text-right">Retouren</th>
                    <th className="font-medium py-1.5 px-3 text-right">Gebühren</th>
                    <th className="font-medium py-1.5 pl-3 text-right">Auszahlung</th>
                  </tr>
                </thead>
                <tbody>
                  {(["ebay", "kaufland", "other"] as const).map((k) => {
                    const m: FinancialReportMarketplaceRow = report.marketplace[k];
                    if (!m || (m.orders === 0 && m.umsatz === 0)) return null;
                    const pending = derived?.payoutPending;
                    const rate = k === "ebay" ? (cm?.feeRateEbay ?? 0.13) : k === "kaufland" ? (cm?.feeRateKaufland ?? 0.13) : 0;
                    const feesShown = pending ? Math.round((m.umsatz || 0) * rate * 100) / 100 : m.fees;
                    const feePctShown = pending ? Math.round(rate * 1000) / 10 : m.feePct;
                    return (
                      <tr key={k} className="border-t border-app-border/60">
                        <td className="py-2 pr-3 text-txt-primary font-medium">{mkLabel[k]}</td>
                        <td className="py-2 px-3 text-right tabular-nums text-txt-secondary">{fmtNum(m.orders)}</td>
                        <td className="py-2 px-3 text-right tabular-nums text-txt-primary">{fmtCur(m.umsatz, cur)}</td>
                        <td className="py-2 px-3 text-right tabular-nums text-txt-muted">{fmtCur(m.retouren, cur)}</td>
                        <td className="py-2 px-3 text-right tabular-nums text-txt-muted">
                          {fmtCur(feesShown, cur)} <span className="text-[10px]">({fmtPct(feePctShown)}{pending ? " kalk." : ""})</span>
                        </td>
                        <td className="py-2 pl-3 text-right tabular-nums text-txt-secondary">
                          {pending ? <span className="text-txt-muted">ausstehend</span> : m.payout != null ? fmtCur(m.payout, cur) : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* ④ Assets & drivers */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="rounded-xl border border-app-border bg-app-surface p-5">
              <h3 className="flex items-center gap-1.5 text-sm font-semibold text-txt-primary mb-3">
                Bestandswert
                <Info text="Stand heute. Potenzieller Umsatz = Menge × Verkaufs-/Marktpreis. Gebundenes Kapital = Menge × Einkaufspreis (bzw. Kostenmodell, wo keiner hinterlegt ist)." />
              </h3>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="text-xs text-txt-muted">Potenzieller Umsatz</p>
                  <p className="text-xl font-semibold tabular-nums text-txt-primary">{fmtCur(report.inventory.potentialRevenue, cur, true)}</p>
                </div>
                <div>
                  <p className="text-xs text-txt-muted">Gebundenes Kapital</p>
                  <p className="text-xl font-semibold tabular-nums text-txt-primary">
                    {(report.inventory.articlesWithCost + report.inventory.articlesEstimated) > 0 ? fmtCur(report.inventory.capitalAtCost, cur, true) : "—"}
                  </p>
                </div>
              </div>
              <p className="text-xs text-txt-muted mt-3">{fmtNum(report.inventory.articleCount)} Artikel · {fmtNum(report.inventory.unitCount)} Einheiten</p>
            </div>

            <div className="rounded-xl border border-app-border bg-app-surface p-5">
              <h3 className="flex items-center gap-1.5 text-sm font-semibold text-txt-primary mb-3">
                Konten
                <Info text="Sichteinlagen laut SevDesk, Stand heute." />
              </h3>
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

            <div className="rounded-xl border border-app-border bg-app-surface p-5">
              <h3 className="flex items-center gap-1.5 text-sm font-semibold text-txt-primary mb-3">
                Artikel online
                <Info text="Verkaufstreiber: je mehr Artikel online, desto mehr Verkäufe. Der aktuelle Wert stammt aus der internen Liste und kann durch Sync-Drift leicht von eBay abweichen. Ø online basiert auf Tages-Snapshots." />
              </h3>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="text-xs text-txt-muted">Aktuell (eBay)</p>
                  <p className="text-xl font-semibold tabular-nums text-txt-primary">{fmtNum(report.listingsOnline.currentActive)}</p>
                </div>
                <div>
                  <p className="text-xs text-txt-muted">Ø im Zeitraum</p>
                  <p className="text-xl font-semibold tabular-nums text-txt-primary">
                    {report.listingsOnline.reliable ? "" : "~"}{fmtNum(Math.round(report.listingsOnline.avgOnline))}
                  </p>
                </div>
              </div>
              <p className="text-xs text-txt-muted mt-3">
                {report.listingsOnline.source === "snapshot"
                  ? `Tages-Snapshots · ${fmtNum(report.listingsOnline.snapshotDays)} Tage`
                  : "Näherung aus aktiven Listings"}
              </p>
            </div>
          </div>

          {/* ⑤ Footer: cost model + data quality (collapsed by default) */}
          <CostModelEditor report={report} open={editCost} onToggle={() => setEditCost((v) => !v)} onSaved={() => void load()} />

          <details className="rounded-xl border border-app-border bg-app-bg/40 px-4 py-3 group">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm">
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-semibold text-txt-primary">Datenqualität</span>
                <span className="text-[11px] text-txt-muted">
                  COGS {fmtNum(report.quality.exactItemCount)} exakt · {fmtNum(report.quality.estimatedItemCount)} kalk.
                  {"  ·  "}Auszahlung {payoutExact ? "SevDesk" : "Sätze"}
                  {"  ·  "}Versand {report.quality.shippingSource || "—"}
                  {"  ·  "}Stand {new Date(report.generated_at_iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}
                </span>
                {report.errors.length > 0 ? (
                  <span className="rounded-full bg-warning-dim px-1.5 py-0.5 text-[10px] font-semibold text-warning">{report.errors.length} Hinweis{report.errors.length > 1 ? "e" : ""}</span>
                ) : null}
              </span>
              <span className="shrink-0 text-xs text-txt-muted group-open:rotate-180 transition-transform">▾</span>
            </summary>
            <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
              <div>
                <p className="text-xs text-txt-muted">Wareneinsatz-Quelle</p>
                <p className="font-semibold text-txt-primary">{report.quality.exactItemCount > 0 ? "EK + Pauschale" : cogsModelActive ? "Paletten-Pauschale" : "—"}</p>
                <p className="text-[11px] text-txt-muted">{fmtNum(report.quality.exactItemCount)} exakt · {fmtNum(report.quality.estimatedItemCount)} kalk. · {fmtNum(report.quality.unmatchedItemCount)} offen</p>
              </div>
              <div>
                <p className="text-xs text-txt-muted">Auszahlungs-Quelle</p>
                <p className="font-semibold text-txt-primary">{payoutExact ? "SevDesk" : "Gebührensätze"}</p>
                <p className="text-[11px] text-txt-muted">{payoutExact ? "echte Bank-Gutschriften" : "erwartet aus Umsatz − Gebühren"}</p>
              </div>
              <div>
                <p className="text-xs text-txt-muted">Versand-Quelle</p>
                <p className="font-semibold text-txt-primary">{report.quality.shippingSource || "—"}</p>
                <p className="text-[11px] text-txt-muted">{report.shipping ? `${fmtNum(report.shipping.parcelCount)} Sendungen` : "keine Daten"}</p>
              </div>
              <div>
                <p className="text-xs text-txt-muted">Produkte im Katalog</p>
                <p className="font-semibold tabular-nums text-txt-primary">{fmtNum(report.quality.productCount)}</p>
                <p className="text-[11px] text-txt-muted">Basis für Wareneinsatz &amp; Bestand</p>
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
          </details>
        </>
      )}
    </div>
  );
};

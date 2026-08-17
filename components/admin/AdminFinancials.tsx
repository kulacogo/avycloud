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
import type { FinancialReport, FinancialCostModelInput } from "../../types";

// ─── Formatting ──────────────────────────────────────────────────────────────
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

// ─── Hero KPI ─────────────────────────────────────────────────────────────────
const Kpi: React.FC<{
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: "green" | "red" | "neutral";
  approx?: boolean;
  approxHint?: string;
}> = ({ label, value, sub, tone = "neutral", approx, approxHint }) => (
  <div className="rounded-xl border border-app-border bg-app-surface p-5">
    <p className="text-xs font-medium uppercase tracking-wider text-txt-muted">{label}</p>
    <p
      className={`mt-1 font-bold tabular-nums leading-tight text-4xl ${
        tone === "green" ? "text-success" : tone === "red" ? "text-danger" : "text-txt-primary"
      }`}
      title={approx ? approxHint : undefined}
    >
      {approx ? <span className="mr-1 font-semibold text-txt-muted" aria-label="Näherung">≈</span> : null}
      {value}
    </p>
    {sub ? <p className="mt-1 text-xs text-txt-muted">{sub}</p> : null}
  </div>
);

// ─── Cost model editor (behind the footer link) ──────────────────────────────
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

  if (!open) return null;
  const field = "w-full bg-app-surface border border-app-border rounded-md px-2.5 py-1.5 text-sm text-txt-primary focus:outline-none focus:border-accent/50";
  const lbl = "text-xs text-txt-muted mb-1 block";

  return (
    <div className="rounded-xl border border-app-border bg-app-bg/40 p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-txt-primary">Kostenmodell</h3>
        <button type="button" onClick={onToggle} className="text-xs text-txt-muted hover:text-txt-primary">schließen</button>
      </div>
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
      {err ? <p className="mt-2 text-xs text-danger">{err}</p> : null}
      <button type="button" onClick={save} disabled={saving} className="mt-3 rounded-md bg-accent px-4 py-1.5 text-sm font-semibold text-txt-primary hover:bg-accent/90 disabled:opacity-50">
        {saving ? "Speichere …" : "Speichern & neu berechnen"}
      </button>
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
  const [editCost, setEditCost] = useState(false);
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

  const pnl = report?.pnl;
  const cur = report?.currency || "EUR";
  const cm = report?.costModel;
  const cogsModelActive = !!cm?.usable;
  const cov = pnl?.coveragePct;
  const cogsUnavailable = !cogsModelActive && (cov == null || cov <= 0);

  // Der Gewinn kommt jetzt vom Backend (accrual, lib/financial-pnl.js) statt hier
  // nachgerechnet zu werden. Der frühere `payoutPending`-Guard war halb offen: er
  // feuerte nur bei einer Auszahlung von EXAKT 0, während eine TEIL-Auszahlung
  // ungefiltert durchlief — genau der Fall im Incident 2026-07-28 (2.051 € von
  // 10.796 € → 8.121 € „Gebühren" = 75 %).
  const view = useMemo(() => {
    if (!report || !pnl) return null;
    const umsatz = pnl.umsatzBrutto ?? 0;
    const retouren = pnl.retouren ?? 0;
    const ware = pnl.cogs ?? 0;
    // null heisst "noch nicht abgebucht", nicht "kostenlos". Frueher wurde
    // daraus 0 € — und der Gewinn sah um die kompletten Versandkosten zu gut
    // aus. Gemessen im August: 270 Sendungen, 0 € gezeigt, Marge 71,8 %.
    const versandOffen = pnl.versandBrutto == null;
    const versand = pnl.versandBrutto ?? 0;
    // Retouren an STORNIERTEN Auftraegen werden nicht abgezogen (ihr Umsatz war
    // nie gebucht). Sie muessen aber sichtbar bleiben: auf der Retouren-Seite
    // sieht der Bediener ALLE Vorgaenge, hier stand bisher nur der Rest — eine
    // Zahl, die er nirgends wiederfand.
    const retourenStorno = pnl.retourenStorno ?? 0;
    const retourenStornoAnzahl = pnl.retourenStornoAnzahl ?? 0;
    const retourenGesamt = pnl.retourenGesamt ?? (retouren + retourenStorno);
    const gebuehren = pnl.marketplaceFees ?? 0;

    // Kompatibilität im Deploy-Fenster: das Frontend kann vor dem Backend live sein.
    // Am neuen Feld erkennen wir, ob der Gewinn schon accrual gerechnet wurde.
    const backendV2 = pnl.settlementStatus !== undefined;
    const gewinn = backendV2
      ? pnl.rohgewinn ?? 0
      : Math.round((umsatz - retouren - gebuehren - ware - versand) * 100) / 100;
    const marge = backendV2
      ? pnl.margePct ?? null
      : umsatz > 0
        ? Math.round((gewinn / umsatz) * 1000) / 10
        : null;

    const feeApprox = pnl.feeSource === "rates" || pnl.feeSource === "mixed";
    return { umsatz, retouren, retourenStorno, retourenStornoAnzahl, retourenGesamt, gebuehren, ware, versand, versandOffen, gewinn, marge, feeApprox, approx: feeApprox || cogsModelActive };
  }, [report, pnl, cogsModelActive]);

  // Geldeingang: Erwartung (accrual) gegen Bank-Ist. Eigene Größe, KEIN Balkensegment —
  // als Segment würde sie mit Gewinn/Gebühren doppelt zählen und der Balken bräche über 100 %.
  const settlement = useMemo(() => {
    if (!pnl || pnl.auszahlungIst == null) return null;
    const erwartet = pnl.auszahlungErwartet ?? 0;
    if (erwartet <= 0) return null;
    const ist = pnl.auszahlungIst;
    const offen = Math.max(0, pnl.offeneAuszahlung ?? 0);
    const pctIst = Math.max(0, Math.min(100, (ist / erwartet) * 100));
    return { erwartet, ist, offen, pctIst, status: pnl.settlementStatus ?? "unknown" };
  }, [pnl]);

  const chartData = useMemo(
    () => (report?.timeseries || []).map((b) => ({ date: b.date, Umsatz: b.umsatz, Ertrag: b.rohertrag })),
    [report],
  );

  // Money-flow segments (share of revenue).
  const flow = useMemo(() => {
    if (!view || view.umsatz <= 0) return null;
    const seg = (v: number) => Math.max(0, (v / view.umsatz) * 100);
    return [
      { key: "Gewinn", value: Math.max(0, view.gewinn), pct: seg(view.gewinn), cls: "bg-success" },
      { key: "Ware", value: view.ware, pct: seg(view.ware), cls: "bg-info" },
      { key: "Gebühren", value: view.gebuehren, pct: seg(view.gebuehren), cls: "bg-accent", approx: view.feeApprox },
      { key: "Versand", value: view.versand, pct: seg(view.versand), cls: "bg-warning", offen: view.versandOffen },
      ...(view.retouren > 0 ? [{ key: "Retouren", value: view.retouren, pct: seg(view.retouren), cls: "bg-danger" }] : []),
    ];
  }, [view]);

  const mkRows = useMemo(() => {
    if (!report) return [];
    const label: Record<string, string> = { ebay: "eBay", kaufland: "Kaufland", other: "Sonstige" };
    const rows = (["ebay", "kaufland", "other"] as const)
      .map((k) => ({ key: k, label: label[k], m: report.marketplace[k] }))
      .filter((r) => r.m && (r.m.orders > 0 || r.m.umsatz > 0));
    const max = Math.max(1, ...rows.map((r) => r.m.umsatz || 0));
    return rows.map((r) => ({ ...r, pct: ((r.m.umsatz || 0) / max) * 100 }));
  }, [report]);

  const approxHint = "≈ Näherung: Die Marktplatz-Auszahlung ist noch unterwegs bzw. Warenkosten stammen aus dem Kostenmodell. Sobald echte Zahlen vorliegen, ersetzt das System sie automatisch.";

  return (
    <div className="space-y-4">
      {/* Controls */}
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
        <div className="rounded-xl border border-warning/40 bg-warning-dim p-3 text-sm text-warning flex items-center justify-between gap-3">
          <span><span className="font-semibold">Warenkosten fehlen</span> — der Gewinn ist zu hoch ausgewiesen.</span>
          <button type="button" onClick={() => setEditCost(true)} className="shrink-0 rounded-md bg-warning/20 px-3 py-1.5 text-xs font-semibold text-warning hover:bg-warning/30">
            Kostenmodell einstellen
          </button>
        </div>
      ) : null}

      {!loading && report && pnl?.settlementStatus === "pending" ? (
        <div className="rounded-xl border border-warning/40 bg-warning-dim p-3 text-sm text-warning">
          <span className="font-semibold">Keine Auszahlung im Zeitraum</span> — Gewinn und Gebühren sind kalkuliert, nicht abgerechnet.
        </div>
      ) : null}

      {loading || !report || !view ? (
        <div className="rounded-xl border border-app-border bg-app-surface p-8 text-center text-sm text-txt-muted">
          {loading ? "Lade Finanzdaten …" : "Keine Daten."}
        </div>
      ) : (
        <>
          {/* ① Vier Zahlen — die Antwort */}
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
            <Kpi label="Umsatz" value={fmtCur(view.umsatz, cur, true)} sub={`${fmtNum(pnl?.orderCount)} Aufträge`} />
            <Kpi
              label="Gewinn"
              value={fmtCur(view.gewinn, cur, true)}
              tone={cogsUnavailable ? "neutral" : view.gewinn >= 0 ? "green" : "red"}
              approx={view.approx}
              approxHint={approxHint}
              sub={view.marge != null ? `${view.marge.toLocaleString("de-DE")} % vom Umsatz` : undefined}
            />
            {/* total === null heisst "nicht abrufbar", nicht "null Euro". */}
            <Kpi
              label="Konto"
              value={report.balances.total == null ? "—" : fmtCur(report.balances.total, cur, true)}
              tone={report.balances.total != null && report.balances.total < 0 ? "red" : "neutral"}
              sub={report.balances.total == null ? "Kontostand nicht abrufbar (SevDesk)" : "Bankstand heute"}
            />
            <Kpi
              label="Lagerwert"
              value={(report.inventory.articlesWithCost + report.inventory.articlesEstimated) > 0 ? fmtCur(report.inventory.capitalAtCost, cur, true) : "—"}
              approx={report.inventory.articlesEstimated > 0}
              approxHint={approxHint}
              sub={`Verkaufswert ${fmtCur(report.inventory.potentialRevenue, cur, true)} · ${fmtNum(report.inventory.unitCount)} Einheiten`}
            />
          </div>

          {/* ② Verlauf */}
          <div className="rounded-xl border border-app-border bg-app-surface p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-txt-primary">Verlauf</h3>
              <div className="flex items-center gap-4 text-xs text-txt-muted">
                <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-info inline-block" />Umsatz</span>
                <span className="inline-flex items-center gap-1.5"><span className="h-0.5 w-3 bg-success inline-block" />nach Warenkosten</span>
              </div>
            </div>
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
                              <span className="text-txt-secondary">{p.name === "Ertrag" ? "nach Warenkosten" : p.name}</span>
                              <span className="tabular-nums text-txt-primary">{fmtCur(p.value, cur)}</span>
                            </p>
                          ))}
                        </div>
                      );
                    }}
                  />
                  <Bar dataKey="Umsatz" fill="var(--info)" radius={[3, 3, 0, 0]} maxBarSize={28} />
                  <Line dataKey="Ertrag" stroke="var(--success)" strokeWidth={2} dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            )}
          </div>

          {/* ③ Wohin geht der Umsatz? — die G&V als EIN Balken */}
          <div className="rounded-xl border border-app-border bg-app-surface p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-txt-primary">Wohin geht der Umsatz?</h3>
              {view.approx ? <span className="text-xs text-txt-muted" title={approxHint}>≈ Näherung</span> : null}
            </div>
            {flow ? (
              <>
                <div className="flex h-9 w-full overflow-hidden rounded-lg">
                  {flow.map((s) =>
                    s.pct > 0 ? (
                      <div
                        key={s.key}
                        className={`${s.cls} h-full`}
                        style={{ width: `${s.pct}%` }}
                        title={`${s.key}: ${fmtCur(s.value, cur)}`}
                      />
                    ) : null,
                  )}
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5">
                  {flow.map((s) => (
                    <span key={s.key} className="inline-flex items-center gap-1.5 text-sm">
                      <span className={`h-2.5 w-2.5 rounded-sm ${s.cls} inline-block`} />
                      <span className="text-txt-secondary">{s.key}</span>
                      <span className="tabular-nums font-semibold text-txt-primary">
                        {"approx" in s && s.approx ? "≈ " : ""}
                        {/* "noch nicht abgebucht" statt 0,00 €: die Frachtrechnung
                            kommt nach der Sendung. Eine 0 hier laesst den Gewinn um
                            die kompletten Versandkosten zu gut aussehen. */}
                        {"offen" in s && (s as { offen?: boolean }).offen
                          ? "noch offen"
                          : fmtCur(s.key === "Gewinn" ? view.gewinn : s.value, cur, true)}
                      </span>
                    </span>
                  ))}
                </div>
                {view.gewinn < 0 ? (
                  <p className="mt-2 text-xs text-danger">Die Kosten übersteigen den Umsatz in diesem Zeitraum.</p>
                ) : null}
                {view.retourenStorno > 0 ? (
                  <p className="mt-2 text-xs text-txt-muted">
                    Auf der Retouren-Seite stehen {fmtCur(view.retourenGesamt, cur, true)} —
                    {" "}{fmtCur(view.retourenStorno, cur, true)} davon ({view.retourenStornoAnzahl}{" "}
                    {view.retourenStornoAnzahl === 1 ? "Vorgang" : "Vorgänge"}) gehören zu stornierten
                    Aufträgen. Deren Umsatz ist bereits herausgerechnet, sie werden hier deshalb nicht
                    noch einmal abgezogen.
                  </p>
                ) : null}
                {view.versandOffen && report?.shipping?.parcelCount ? (
                  <p className="mt-2 text-xs text-warning">
                    Die Versandkosten für diesen Zeitraum sind noch nicht vom Konto abgebucht —
                    {" "}{report.shipping.parcelCount} Sendungen sind raus. Gewinn und Marge sind deshalb
                    noch zu hoch.
                  </p>
                ) : null}

                {/* Geldeingang — eigene Zeile: Timing ist kein Kostenblock. */}
                {settlement ? (
                  <div className="mt-4 border-t border-app-border pt-3">
                    <div className="mb-1.5 flex items-baseline justify-between gap-3">
                      <span className="text-xs font-medium text-txt-secondary">Geldeingang</span>
                      <span className="text-xs tabular-nums text-txt-muted">
                        {fmtCur(settlement.ist, cur, true)} von {fmtCur(settlement.erwartet, cur, true)} auf dem Konto
                      </span>
                    </div>
                    <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-app-elevated">
                      <div
                        className="h-full bg-success"
                        style={{ width: `${settlement.pctIst}%` }}
                        title={`Eingegangen: ${fmtCur(settlement.ist, cur)}`}
                      />
                      <div
                        className="h-full bg-accent-dim"
                        style={{ width: `${100 - settlement.pctIst}%` }}
                        title={`Noch nicht ausgezahlt: ${fmtCur(settlement.offen, cur)}`}
                      />
                    </div>
                    {settlement.status !== "settled" ? (
                      <p className="mt-1.5 text-xs text-txt-muted">
                        {fmtCur(settlement.offen, cur, true)} zahlen die Marktplätze erst später aus — das ist kein Verlust.
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </>
            ) : (
              <p className="text-sm text-txt-muted">Kein Umsatz im Zeitraum.</p>
            )}
          </div>

          {/* ④ Marktplätze + Artikel online */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2 rounded-xl border border-app-border bg-app-surface p-5">
              <h3 className="text-sm font-semibold text-txt-primary mb-4">Marktplätze</h3>
              {mkRows.length === 0 ? (
                <p className="text-sm text-txt-muted">Keine Aufträge im Zeitraum.</p>
              ) : (
                <div className="space-y-3">
                  {mkRows.map((r) => (
                    <div key={r.key}>
                      <div className="flex items-baseline justify-between text-sm mb-1">
                        <span className="font-medium text-txt-primary">{r.label}</span>
                        <span className="tabular-nums text-txt-primary font-semibold">
                          {fmtCur(r.m.umsatz, cur, true)}
                          <span className="ml-2 font-normal text-xs text-txt-muted">{fmtNum(r.m.orders)} Aufträge</span>
                        </span>
                      </div>
                      <div className="h-2.5 w-full rounded-full bg-app-elevated overflow-hidden">
                        <div className="h-full rounded-full bg-info" style={{ width: `${r.pct}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="rounded-xl border border-app-border bg-app-surface p-5">
              <h3 className="text-sm font-semibold text-txt-primary mb-4" title="Je mehr Artikel online sind, desto mehr wird verkauft.">Artikel online</h3>
              <div className="flex items-end gap-6">
                <div>
                  <p className="text-3xl font-bold tabular-nums text-txt-primary">{fmtNum(report.listingsOnline.currentActive)}</p>
                  <p className="text-xs text-txt-muted mt-0.5">jetzt</p>
                </div>
                <div>
                  <p className="text-3xl font-bold tabular-nums text-txt-muted">
                    {report.listingsOnline.reliable ? "" : "≈"}{fmtNum(Math.round(report.listingsOnline.avgOnline))}
                  </p>
                  <p className="text-xs text-txt-muted mt-0.5">Ø im Zeitraum</p>
                </div>
              </div>
            </div>
          </div>

          {/* ⑤ Fußzeile — eine Zeile */}
          <div className="flex flex-wrap items-center justify-between gap-2 px-1 text-xs text-txt-muted">
            <span>
              Stand {new Date(report.generated_at_iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })} Uhr
              {view.approx ? <span className="ml-2" title={approxHint}>≈ enthält Näherungen</span> : null}
              {report.errors.length > 0 ? <span className="ml-2 text-warning" title={report.errors.join(" · ")}>{report.errors.length} Hinweis{report.errors.length > 1 ? "e" : ""}</span> : null}
            </span>
            <button type="button" onClick={() => setEditCost((v) => !v)} className="text-txt-muted underline-offset-2 hover:text-txt-primary hover:underline">
              Kostenmodell bearbeiten
            </button>
          </div>

          <CostModelEditor report={report} open={editCost} onToggle={() => setEditCost(false)} onSaved={() => { setEditCost(false); void load(); }} />
        </>
      )}
    </div>
  );
};

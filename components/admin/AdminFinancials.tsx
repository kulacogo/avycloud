import { useAuth } from "../../context/AuthContext";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { fetchFinancialReport, saveFinancialCostModel } from "../../api/client";
import type { FinancialReport, FinancialCostModelInput } from "../../types";
import { financeMoney, financeSummary, validFinanceDates } from "../../utils/financeDashboard";

const fmtCur = financeMoney;
const fmtNum = (v: number | null | undefined) => v == null ? "—" : new Intl.NumberFormat("de-DE").format(v);
const presets = [{ id: "today", label: "Heute" }, { id: "last7", label: "7 Tage" }, { id: "month_to_date", label: "Dieser Monat" }, { id: "last_month", label: "Letzter Monat" }, { id: "year_to_date", label: "Dieses Jahr" }, { id: "all_time", label: "Gesamt" }, { id: "custom", label: "Zeitraum wählen" }];
const panel = "rounded-xl border border-app-border bg-app-surface";
const button = "rounded-md px-3 py-2 text-sm transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent";
const dayLabel = (date: string) => new Date(date.length === 7 ? date + "-01T12:00:00Z" : date + "T12:00:00Z").toLocaleDateString("de-DE", date.length === 7 ? { month: "short", year: "2-digit" } : { day: "2-digit", month: "short" });

const Stat = ({ label, value, detail, status, tone = "" }: { label: string; value: string; detail?: string; status?: string; tone?: string }) => (
  <div className={`${panel} p-5 sm:p-6`}>
    <div className="flex min-h-6 items-center justify-between gap-2"><span className="text-sm font-medium text-txt-secondary">{label}</span>{status && <span className="rounded-full bg-warning-dim px-2 py-0.5 text-xs font-medium text-warning">{status}</span>}</div>
    <p title={value} className={`mt-3 text-3xl xl:text-[clamp(1.25rem,2.5vw,2.35rem)] font-semibold tracking-tight tabular-nums ${tone || "text-txt-primary"}`}>{value}</p>
    {detail && <p className="mt-2 text-sm text-txt-secondary">{detail}</p>}
  </div>
);

// ─── Cost model editor (behind the footer link) ──────────────────────────────
const CostModelEditor: React.FC<{ report: FinancialReport; open: boolean; onToggle: () => void; onSaved: () => void }> = ({ report, open, onToggle, onSaved }) => {
  const cm = report.costModel;
  const [feeEbay, setFeeEbay] = useState(String(Math.round((cm.feeRateEbay || 0) * 10000) / 100));
  const [feeKaufland, setFeeKaufland] = useState(String(Math.round((cm.feeRateKaufland || 0) * 10000) / 100));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      // Paletten-Felder werden bewusst UNVERAENDERT durchgereicht: der
      // Einkaufspreis kommt ausschliesslich aus den Losen, die Palette ist
      // keine Kostenquelle mehr. Sie hier auf 0 zu setzen waere ein stiller
      // Datenverlust an einem Feld, das die Oberflaeche nicht mehr zeigt.
      const input: FinancialCostModelInput = {
        mode: cm.mode,
        vatMode: cm.vatMode,
        palletCostBrutto: cm.palletCostBrutto || 0,
        unitsPerPallet: cm.unitsPerPallet || 0,
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
        <h3 className="text-sm font-semibold text-txt-primary">Marktplatz-Gebühren</h3>
        <button type="button" onClick={onToggle} className="text-xs text-txt-muted hover:text-txt-primary">schließen</button>
      </div>
      <p className="text-sm text-txt-secondary mb-3">Ersatzwerte für noch nicht abgerechnete Gebühren.</p>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
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



export const AdminFinancials: React.FC = () => {
  const { hasPermission } = useAuth();
  const canEditCosts = hasPermission('admin', 'reports.write');
  const [preset, setPreset] = useState("month_to_date");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [appliedDates, setAppliedDates] = useState<{ from_date: string; to_date: string } | undefined>();
  const [report, setReport] = useState<FinancialReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editCost, setEditCost] = useState(false);
  const [metric, setMetric] = useState<"umsatz" | "orders">("umsatz");
  const [table, setTable] = useState(false);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [market, setMarket] = useState<"ebay" | "kaufland" | "other" | null>(null);
  const sequence = useRef(0);
  const load = useCallback(async () => {
    if (preset === "custom" && !appliedDates) { setLoading(false); return; }
    const seq = ++sequence.current;
    setLoading(true); setError(null); setSelectedDate(null);
    try {
      const result = await fetchFinancialReport(preset, preset === "custom" ? appliedDates : undefined);
      if (seq === sequence.current) setReport(result);
    } catch (cause) {
      if (seq === sequence.current) setError(cause instanceof Error ? cause.message : "Finanzdaten nicht verfügbar.");
    } finally { if (seq === sequence.current) setLoading(false); }
  }, [preset, appliedDates]);
  useEffect(() => { void load(); return () => { sequence.current++; }; }, [load]);
  const summary = useMemo(() => report ? financeSummary(report) : null, [report]);
  const currency = report?.currency || "EUR";
  const money = (v: number | null | undefined) => fmtCur(v, currency);
  const chartData = report?.timeseries || [];
  const selected = chartData.find(row => row.date === selectedDate);
  const marketNames = { ebay: "eBay", kaufland: "Kaufland", other: "Sonstige" };
  const marketKeys = (["ebay", "kaufland", "other"] as const).filter(key => report && (report.marketplace[key].orders > 0 || report.marketplace[key].umsatz > 0));
  const marketTotal = marketKeys.reduce((sum, key) => sum + (report?.marketplace[key].umsatz || 0), 0);
  const costMax = Math.max(1, ...(summary?.costs.map(row => row.amount || 0) || []));
  const incomplete = Boolean(summary?.provisional || report?.errors.length);
  const graphClick = (state: any) => {
    const index = state?.activeTooltipIndex;
    if (index != null && chartData[Number(index)]) setSelectedDate(chartData[Number(index)].date);
  };
  const graphTooltip = ({ active, payload, label }: any) => active && payload?.length ? (
    <div className="rounded-lg border border-app-border bg-app-elevated px-4 py-3 shadow-app">
      <p className="text-sm text-txt-secondary">{dayLabel(String(label))}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums text-txt-primary">{metric === "umsatz" ? money(payload[0].value) : `${fmtNum(payload[0].value)} Bestellungen`}</p>
    </div>
  ) : null;
  return <div className="space-y-5 pb-8">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-2"><span className={`h-2 w-2 rounded-full ${incomplete ? "bg-warning" : "bg-success"}`} /><span className="text-sm font-medium text-txt-secondary">{loading ? "Wird aktualisiert …" : report?.range.label || "Finanzübersicht"}</span></div>
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="Finanzzeitraum" value={preset} onChange={event => { setPreset(event.target.value); setReport(null); }} className="rounded-md border border-app-border bg-app-surface px-3 py-2 text-sm text-txt-primary">
          {presets.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
        <button type="button" aria-label="Finanzdaten aktualisieren" title="Aktualisieren" disabled={loading} onClick={() => void load()} className={`${button} border border-app-border text-txt-secondary hover:bg-app-elevated disabled:opacity-40`}>↻</button>
      </div>
    </div>
    {preset === "custom" && <div className={`${panel} flex flex-wrap items-center gap-3 p-4`}>
      <label className="flex items-center gap-2 text-sm text-txt-secondary">Von<input type="date" aria-label="Finanzen von" value={customFrom} onChange={e => setCustomFrom(e.target.value)} className="rounded-md border border-app-border bg-app-bg px-3 py-2 text-txt-primary" /></label>
      <label className="flex items-center gap-2 text-sm text-txt-secondary">Bis<input type="date" aria-label="Finanzen bis" value={customTo} onChange={e => setCustomTo(e.target.value)} className="rounded-md border border-app-border bg-app-bg px-3 py-2 text-txt-primary" /></label>
      <button type="button" disabled={!validFinanceDates(customFrom, customTo)} onClick={() => setAppliedDates({ from_date: customFrom, to_date: customTo })} className={`${button} bg-accent text-white disabled:opacity-40`}>Anwenden</button>
    </div>}
    {error && <div role="alert" className="rounded-lg border border-danger/30 bg-danger-dim p-4 text-sm text-danger">{error}</div>}
    {loading ? <div role="status" className="grid grid-cols-2 gap-4 xl:grid-cols-4" aria-label="Finanzdaten laden">{[0, 1, 2, 3].map(i => <div key={i} className={`${panel} h-36 animate-pulse`} />)}</div> : report && summary ? <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label={`Umsatz ${summary.net ? "netto" : "brutto"}`} value={money(summary.revenue)} detail={`${fmtNum(report.pnl.orderCount)} Bestellungen`} />
        <Stat label="Ergebnis nach Kosten" value={money(summary.result)} status={summary.provisional ? "Vorläufig" : undefined} tone={summary.result != null ? summary.result < 0 ? "text-danger" : "text-success" : ""} detail={summary.missingCogs ? "Wareneinsatz fehlt" : summary.shipping == null ? "Versandkosten noch offen" : "Ware · Gebühren · Versand"} />
        <Stat label="Marge" value={summary.margin == null ? "—" : `${fmtNum(summary.margin)} %`} status={summary.provisional ? "Vorläufig" : undefined} detail={summary.net ? "Auf Nettoumsatz" : "Auf Bruttoumsatz"} />
        <Stat label="Ø Bestellwert brutto" value={report.pnl.orderCount > 0 ? money(report.pnl.umsatzBrutto / report.pnl.orderCount) : "—"} detail={`${fmtNum(report.pnl.orderCount)} Bestellungen im Zeitraum`} />
      </div>
      <div className="grid gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
        <section className={`${panel} min-w-0 p-5 sm:p-6`}>
          <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
            <div><h2 className="text-base font-semibold text-txt-primary">Verkaufsverlauf</h2><p className="mt-1 text-sm text-txt-secondary">{metric === "umsatz" ? "Umsatz brutto" : "Anzahl Bestellungen"}</p></div>
            <div className="flex items-center gap-1 rounded-lg bg-app-bg p-1">
              {([['umsatz', 'Umsatz'], ['orders', 'Bestellungen']] as const).map(([id, label]) => <button key={id} type="button" aria-pressed={metric === id} onClick={() => setMetric(id)} className={`${button} ${metric === id ? "bg-app-elevated text-txt-primary" : "text-txt-secondary hover:text-txt-primary"}`}>{label}</button>)}
              <button type="button" aria-pressed={table} onClick={() => setTable(!table)} className={`${button} ${table ? "bg-app-elevated text-accent" : "text-txt-secondary"}`}>Tabelle</button>
            </div>
          </div>
          {!chartData.length ? <div className="flex h-64 items-center justify-center text-sm text-txt-secondary">Keine Bestellungen im Zeitraum.</div> : table ? <div className="h-[280px] overflow-auto"><table className="w-full text-sm"><thead className="sticky top-0 bg-app-surface text-left text-txt-secondary"><tr><th className="py-3 font-medium">Datum</th><th className="text-right font-medium">Umsatz brutto</th><th className="text-right font-medium">Bestellungen</th></tr></thead><tbody>{chartData.map(row => <tr key={row.date} className={`border-t border-app-border ${selectedDate === row.date ? "bg-accent-dim" : ""}`}><td><button type="button" onClick={() => setSelectedDate(row.date)} className="py-3 text-accent hover:underline">{dayLabel(row.date)}</button></td><td className="text-right tabular-nums">{money(row.umsatz)}</td><td className="text-right tabular-nums">{fmtNum(row.orders)}</td></tr>)}</tbody></table></div> : <div className="h-[280px]" role="img" aria-label={metric === 'umsatz' ? 'Umsatzverlauf brutto. Exakte Werte über Tabelle.' : 'Bestellungen im Zeitverlauf. Exakte Werte über Tabelle.'}>
            <ResponsiveContainer width="100%" height="100%">{metric === "umsatz" ? <AreaChart data={chartData} onClick={graphClick} margin={{ top: 10, right: 8, bottom: 0, left: 0 }}>
              <defs><linearGradient id="finance-revenue-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--accent)" stopOpacity={0.3} /><stop offset="100%" stopColor="var(--accent)" stopOpacity={0.02} /></linearGradient></defs>
              <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 5" /><XAxis dataKey="date" tickFormatter={dayLabel} tick={{ fill: 'var(--text-muted)', fontSize: 12 }} minTickGap={36} axisLine={false} tickLine={false} /><YAxis width={50} tick={{ fill: 'var(--text-muted)', fontSize: 12 }} tickFormatter={v => Math.abs(v) >= 1000 ? `${v / 1000}k` : String(v)} axisLine={false} tickLine={false} /><Tooltip content={graphTooltip} /><Area type="monotone" dataKey="umsatz" stroke="var(--accent)" strokeWidth={2.5} fill="url(#finance-revenue-fill)" activeDot={{ r: 5 }} />
            </AreaChart> : <BarChart data={chartData} onClick={graphClick} margin={{ top: 10, right: 8, bottom: 0, left: 0 }}><CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 5" /><XAxis dataKey="date" tickFormatter={dayLabel} minTickGap={36} tick={{ fill: 'var(--text-muted)', fontSize: 12 }} axisLine={false} tickLine={false} /><YAxis allowDecimals={false} width={40} tick={{ fill: 'var(--text-muted)', fontSize: 12 }} axisLine={false} tickLine={false} /><Tooltip content={graphTooltip} /><Bar dataKey="orders" fill="var(--accent)" radius={[4, 4, 0, 0]} maxBarSize={28} /></BarChart>}</ResponsiveContainer>
          </div>}
          {selected && <div className="mt-4 flex flex-wrap items-center gap-4 rounded-lg bg-app-bg px-4 py-3 text-sm"><span className="font-medium">{dayLabel(selected.date)}</span><span className="tabular-nums">{money(selected.umsatz)} brutto</span><span>{fmtNum(selected.orders)} Bestellungen</span><button type="button" onClick={() => setSelectedDate(null)} className="ml-auto text-txt-muted" aria-label="Tagesauswahl aufheben">×</button></div>}
        </section>
        <section className={`${panel} p-5 sm:p-6`}>
          <h2 className="text-base font-semibold text-txt-primary">Geldeingang</h2>
          <p className="mt-7 text-sm text-txt-secondary">Bereits ausgezahlt</p><p className="mt-2 text-3xl font-semibold tracking-tight tabular-nums">{money(report.pnl.auszahlungIst)}</p>
          <div className="mt-5 h-2 overflow-hidden rounded-full bg-app-elevated" role="img" aria-label="Anteil der erwarteten Auszahlung"><div className="h-full rounded-full bg-success transition-all" style={{ width: `${report.pnl.auszahlungIst != null && (report.pnl.auszahlungErwartet || 0) > 0 ? Math.min(100, Math.max(0, report.pnl.auszahlungIst / report.pnl.auszahlungErwartet! * 100)) : 0}%` }} /></div>
          <dl className="mt-5 space-y-4 text-sm"><div className="flex justify-between gap-3"><dt className="text-txt-secondary">Erwartet</dt><dd className="font-medium tabular-nums">{money(report.pnl.auszahlungErwartet)}</dd></div><div className="flex justify-between gap-3"><dt className="text-txt-secondary">Noch offen</dt><dd className="font-medium tabular-nums text-warning">{money(report.pnl.offeneAuszahlung)}</dd></div><div className="flex justify-between gap-3 border-t border-app-border pt-4"><dt className="text-txt-secondary">Kontostand heute</dt><dd className="font-medium tabular-nums">{money(report.balances.total)}</dd></div></dl>
          {report.balances.total == null && <span className="mt-4 inline-flex rounded-full bg-app-elevated px-3 py-1 text-xs text-txt-secondary">Bankdaten nicht verbunden</span>}
        </section>
      </div>
      <div className="grid gap-5 xl:grid-cols-2">
        <section className={`${panel} p-5 sm:p-6`}>
          <div className="mb-6 flex items-center justify-between"><h2 className="text-base font-semibold">Kosten & Ergebnis</h2><span className="text-sm text-txt-secondary">{summary.net ? "Netto" : "Brutto"}</span></div>
          <div className="space-y-5">{summary.costs.map(row => <div key={row.key}><div className="mb-2 flex items-center justify-between gap-3 text-sm"><span className="text-txt-secondary">{row.label}</span><span className={`font-medium tabular-nums ${row.amount == null ? "text-warning" : "text-txt-primary"}`}>{row.amount == null ? "Offen" : `${row.estimated ? "≈ " : ""}${money(row.amount)}`}</span></div><div className="h-1.5 rounded-full bg-app-elevated"><div className={`h-full rounded-full ${row.tone}`} style={{ width: `${Math.min(100, Math.max(0, (row.amount || 0) / costMax * 100))}%` }} /></div></div>)}</div>
          <div className="mt-6 flex items-center justify-between border-t border-app-border pt-5"><span className="text-sm font-medium">Ergebnis{summary.provisional ? " · vorläufig" : ""}</span><span className={`text-xl font-semibold tabular-nums ${summary.result != null && summary.result < 0 ? "text-danger" : "text-success"}`}>{money(summary.result)}</span></div>
        </section>
        <section className={`${panel} p-5 sm:p-6`}>
          <div className="mb-5 flex items-center justify-between"><h2 className="text-base font-semibold">Marktplätze</h2><span className="text-sm text-txt-secondary">Umsatz brutto</span></div>
          <div className="space-y-2">{marketKeys.map(key => { const row = report.marketplace[key]; return <button key={key} type="button" aria-expanded={market === key} onClick={() => setMarket(market === key ? null : key)} className={`w-full rounded-lg p-3 text-left transition-colors ${market === key ? "bg-accent-dim ring-1 ring-accent/30" : "hover:bg-app-elevated"}`}><div className="flex justify-between gap-3"><span className="text-sm font-medium">{marketNames[key]}</span><span className="text-base font-semibold tabular-nums">{money(row.umsatz)}</span></div><div className="my-3 h-2 rounded-full bg-app-elevated"><div className="h-full rounded-full bg-accent" style={{ width: `${marketTotal > 0 ? Math.max(0, row.umsatz / marketTotal * 100) : 0}%` }} /></div><div className="flex justify-between text-sm text-txt-secondary"><span>{fmtNum(row.orders)} Bestellungen</span><span>{marketTotal > 0 ? fmtNum(Math.round(row.umsatz / marketTotal * 100)) : 0} %</span></div></button>; })}</div>
          {market && <dl className="mt-4 grid grid-cols-2 gap-4 border-t border-app-border pt-4 text-sm"><div><dt className="text-txt-secondary">Verkaufte Einheiten</dt><dd className="mt-1 font-semibold tabular-nums">{fmtNum(report.marketplace[market].units)}</dd></div><div><dt className="text-txt-secondary">Gebühren brutto</dt><dd className="mt-1 font-semibold tabular-nums">{report.marketplace[market].feeSource === 'rates' ? '≈ ' : ''}{money(report.marketplace[market].fees)}</dd></div><div><dt className="text-txt-secondary">Erstattungen brutto</dt><dd className="mt-1 font-semibold tabular-nums">{money(report.marketplace[market].retouren)}</dd></div><div><dt className="text-txt-secondary">Ausgezahlt</dt><dd className="mt-1 font-semibold tabular-nums">{money(report.marketplace[market].payout)}</dd></div></dl>}
        </section>
      </div>
      <section className={`${panel} grid grid-cols-2 gap-6 p-5 sm:p-6 lg:grid-cols-4`}>
        <div><p className="text-sm text-txt-secondary">Warenwert im Lager</p><p className="mt-2 text-xl font-semibold tabular-nums">{report.inventory.articlesWithCost + (report.inventory.articlesFromLot || 0) + report.inventory.articlesEstimated > 0 ? `${report.inventory.articlesEstimated ? '≈ ' : ''}${money(report.inventory.capitalAtCost)}` : '—'}</p></div>
        <div><p className="text-sm text-txt-secondary">Verkaufswert brutto</p><p className="mt-2 text-xl font-semibold tabular-nums">{money(report.inventory.potentialRevenue)}</p></div>
        <div><p className="text-sm text-txt-secondary">Einheiten im Lager</p><p className="mt-2 text-xl font-semibold tabular-nums">{fmtNum(report.inventory.unitCount)}</p></div>
        <div><p className="text-sm text-txt-secondary">eBay-Angebote online</p><p className="mt-2 text-xl font-semibold tabular-nums">{fmtNum(report.listingsOnline.currentActive)}</p></div>
      </section>
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-txt-secondary"><span>Stand {new Date(report.generated_at_iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}</span>{canEditCosts && <button type="button" onClick={() => setEditCost(!editCost)} className="hover:text-accent">Gebührensätze</button>}</div>
      <details className={`${panel} px-5 py-4`}><summary className="cursor-pointer text-sm font-medium">Datengrundlage{incomplete ? <span className="ml-3 rounded-full bg-warning-dim px-2 py-1 text-xs text-warning">Vorläufig</span> : null}</summary><div className="mt-4 space-y-3 text-sm text-txt-secondary">
        {summary.notices.length > 0 && <div className="flex flex-wrap gap-2">{summary.notices.map(notice => <span key={notice} className="rounded-md bg-warning-dim px-3 py-1.5 text-warning">{notice}</span>)}</div>}
        <dl className="grid gap-3 sm:grid-cols-2"><div><dt>Warenkosten-Abdeckung</dt><dd className="mt-1 font-medium text-txt-primary">{fmtNum(report.pnl.coveragePct)} %</dd></div><div><dt>Umsatzsteuer-Anteil</dt><dd className="mt-1 font-medium text-txt-primary">{money(report.pnl.umsatzsteuerAnteil)}</dd></div><div><dt>Erstattungen zu stornierten Aufträgen</dt><dd className="mt-1 font-medium text-txt-primary">{money(report.pnl.retourenStorno)} · {fmtNum(report.pnl.retourenStornoAnzahl)} Vorgänge</dd></div></dl>
        <p>Verlauf und Marktplätze: Brutto. Ergebnis: {summary.net ? 'Netto' : 'Brutto'}, ohne betriebliche Fixkosten.</p>
        {report.errors.length > 0 && <ul className="list-disc space-y-1 pl-5">{report.errors.map((message, i) => <li key={i}>{message}</li>)}</ul>}
      </div></details>
      {canEditCosts && <CostModelEditor key={report.generated_at_iso} report={report} open={editCost} onToggle={() => setEditCost(false)} onSaved={() => { setEditCost(false); void load(); }} />}
    </> : !error && <div className={`${panel} p-8 text-center text-sm text-txt-secondary`}>{preset === 'custom' ? 'Zeitraum auswählen und anwenden.' : 'Keine Finanzdaten verfügbar.'}</div>}
  </div>;
};

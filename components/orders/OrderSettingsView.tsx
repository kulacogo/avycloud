import React, { useState, useEffect, useCallback } from "react";
import { fetchOrderSettings, saveOrderSettings, runRepricingBatch, fetchPricingRules } from "../../api/client";
import { useToast } from "../../context/ToastContext";

/* ─── Types ─── */
interface AutomationRule {
  id: string;
  label: string;
  enabled: boolean;
}

interface OrderStatusConfig {
  id: string;
  name: string;
  description: string;
  color: string;
}

interface NumberRange {
  prefix: string;
  startNumber: string;
}

interface DocTemplate {
  id: string;
  name: string;
  lastEdited: string;
}

/* ─── Default values for first-time setup ─── */
const DEFAULT_RULES: AutomationRule[] = [
  { id: "rule-1", label: "Wenn Zahlung eingegangen → Status 'Bestätigt'", enabled: true },
  { id: "rule-2", label: "Wenn alle Items gepickt → Status 'Kommissioniert'", enabled: true },
  { id: "rule-3", label: "Wenn Versandlabel erstellt → Status 'Versendet'", enabled: true },
  { id: "rule-4", label: "Wenn Tracking 'Zugestellt' → Status 'Abgeschlossen'", enabled: false },
];

const DEFAULT_STATUSES: OrderStatusConfig[] = [
  { id: "st-1", name: "Neu", description: "Bestellung eingegangen, noch nicht bearbeitet", color: "#3B82F6" },
  { id: "st-2", name: "Bestätigt", description: "Zahlung eingegangen, bereit zur Bearbeitung", color: "#EAB308" },
  { id: "st-3", name: "Kommissionierung", description: "Artikel werden aus dem Lager gepickt", color: "#8B5CF6" },
  { id: "st-4", name: "Verpackung", description: "Artikel werden verpackt und versandfertig gemacht", color: "#F97316" },
  { id: "st-5", name: "Versendet", description: "Paket wurde an den Versanddienstleister übergeben", color: "#22C55E" },
  { id: "st-6", name: "Zugestellt", description: "Paket wurde erfolgreich zugestellt", color: "#6B7280" },
  { id: "st-7", name: "Storniert", description: "Bestellung wurde storniert", color: "#EF4444" },
];

const DEFAULT_NUMBER_RANGES: Record<string, NumberRange> = {
  invoice: { prefix: "RE-", startNumber: "2026-0001" },
  order: { prefix: "ORD-", startNumber: "2026-0001" },
  deliveryNote: { prefix: "LS-", startNumber: "2026-0001" },
};

/* ─── Section Header ─── */
const SectionHeader: React.FC<{ title: string; description?: string }> = ({ title, description }) => (
  <div className="mb-4">
    <h2 className="text-lg font-bold text-txt-primary">{title}</h2>
    {description && <p className="text-sm text-txt-muted mt-0.5">{description}</p>}
  </div>
);

/* ─── Toggle Switch ─── */
const Toggle: React.FC<{ enabled: boolean; onChange: () => void }> = ({ enabled, onChange }) => (
  <button
    type="button"
    onClick={onChange}
    className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
      enabled ? "bg-accent" : "bg-app-elevated"
    }`}
  >
    <span
      className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
        enabled ? "translate-x-5" : "translate-x-0"
      }`}
    />
  </button>
);

/* ─── Main Component ─── */
export const OrderSettingsView: React.FC = () => {
  const [rules, setRules] = useState<AutomationRule[]>([]);
  const [statuses, setStatuses] = useState<OrderStatusConfig[]>([]);
  const [numberRanges, setNumberRanges] = useState<Record<string, NumberRange>>(DEFAULT_NUMBER_RANGES);
  const [templates, setTemplates] = useState<DocTemplate[]>([]);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [repricingBusy, setRepricingBusy] = useState(false);
  const [repricingResult, setRepricingResult] = useState<any>(null);
  const [pricingRulesCount, setPricingRulesCount] = useState<number | null>(null);
  const toast = useToast();

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchOrderSettings();
      setRules(data.rules?.length ? data.rules : DEFAULT_RULES);
      setStatuses(data.statuses?.length ? data.statuses : DEFAULT_STATUSES);
      if (data.numberRanges && Object.keys(data.numberRanges).length > 0) {
        setNumberRanges(data.numberRanges);
      }
      if (data.templates) setTemplates(data.templates);
    } catch (err: any) {
      setError(err.message || "Fehler beim Laden der Auftragseinstellungen");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSettings();
    fetchPricingRules().then((r) => setPricingRulesCount(r.length)).catch(() => {});
  }, [loadSettings]);

  const toggleRule = (id: string) => {
    setRules((prev) => prev.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r)));
  };

  const updateStatusName = (id: string, name: string) => {
    setStatuses((prev) => prev.map((s) => (s.id === id ? { ...s, name } : s)));
  };

  const handleAddStatus = () => {
    const newId = `st-${Date.now()}`;
    setStatuses((prev) => [
      ...prev,
      { id: newId, name: "Neuer Status", description: "Beschreibung eingeben", color: "#6B7280" },
    ]);
  };

  const updateRange = (key: string, field: keyof NumberRange, value: string) => {
    setNumberRanges((prev) => ({
      ...prev,
      [key]: { ...prev[key], [field]: value },
    }));
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSaveSuccess(false);
    try {
      await saveOrderSettings({ rules, statuses, numberRanges, templates });
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err: any) {
      setError(err.message || "Fehler beim Speichern");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto space-y-8 animate-pulse">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="rounded-xl border border-app-border bg-app-surface p-6 h-40" />
        ))}
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-txt-primary">Auftragseinstellungen</h1>
        <p className="text-sm text-txt-muted">Automatisierungen, Status und Nummernkreise konfigurieren</p>
      </div>

      {/* Error / Success Banners */}
      {error && (
        <div className="bg-danger-dim border border-app-border rounded-xl px-4 py-3 flex items-center gap-3">
          <span className="text-sm text-danger flex-1">{error}</span>
          <button onClick={() => setError(null)} className="text-txt-muted hover:text-txt-primary text-sm">Schließen</button>
        </div>
      )}
      {saveSuccess && (
        <div className="bg-success-dim border border-app-border rounded-xl px-4 py-3 text-sm text-success font-medium">
          Einstellungen erfolgreich gespeichert.
        </div>
      )}

      {/* Section 1: Automatisierung */}
      <div className="rounded-xl border border-app-border bg-app-surface p-6">
        <SectionHeader title="Automatisierung" description="Regeln für automatische Statusänderungen bei Aufträgen" />
        <div className="space-y-3">
          {rules.map((rule) => (
            <div key={rule.id} className="flex items-center justify-between gap-4 rounded-xl border border-app-border bg-app-bg p-4">
              <span className={`text-sm ${rule.enabled ? "text-txt-primary" : "text-txt-muted"}`}>{rule.label}</span>
              <Toggle enabled={rule.enabled} onChange={() => toggleRule(rule.id)} />
            </div>
          ))}
        </div>
      </div>

      {/* Section 2: Status-Konfiguration */}
      <div className="rounded-xl border border-app-border bg-app-surface p-6">
        <SectionHeader title="Status-Konfiguration" description="Auftragsstatus definieren und anpassen" />
        <div className="space-y-2">
          {statuses.map((status) => (
            <div key={status.id} className="flex items-center gap-3 rounded-xl border border-app-border bg-app-bg px-4 py-3">
              <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: status.color }} />
              <input
                type="text"
                value={status.name}
                onChange={(e) => updateStatusName(status.id, e.target.value)}
                className="bg-transparent text-sm font-semibold text-txt-primary border-none outline-none focus:ring-0 w-40"
              />
              <span className="text-xs text-txt-muted flex-1 truncate">{status.description}</span>
              <svg className="w-4 h-4 text-txt-muted flex-shrink-0 cursor-grab" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 8h16M4 16h16" />
              </svg>
            </div>
          ))}
          <button
            type="button"
            onClick={handleAddStatus}
            className="w-full rounded-xl border border-dashed border-app-border bg-app-bg p-3 text-sm text-txt-muted hover:text-txt-secondary hover:border-txt-muted transition text-center"
          >
            + Status hinzufügen
          </button>
        </div>
      </div>

      {/* Section 3: Nummernkreise */}
      <div className="rounded-xl border border-app-border bg-app-surface p-6">
        <SectionHeader title="Nummernkreise" description="Präfix und Startnummern für Dokumente festlegen" />
        <div className="space-y-5">
          {[
            { key: "invoice", label: "Rechnungs-Nummernkreis" },
            { key: "order", label: "Auftrags-Nummernkreis" },
            { key: "deliveryNote", label: "Lieferschein-Nummernkreis" },
          ].map(({ key, label }) => (
            <div key={key}>
              <h3 className="text-sm font-semibold text-txt-primary mb-2">{label}</h3>
              <div className="flex items-center gap-3">
                <div className="flex-1">
                  <label className="text-xs text-txt-muted mb-1 block">Präfix</label>
                  <input
                    type="text"
                    value={numberRanges[key]?.prefix || ""}
                    onChange={(e) => updateRange(key, "prefix", e.target.value)}
                    className="w-full rounded-lg border border-app-border bg-app-bg px-3 py-2 text-sm text-txt-primary focus:outline-none focus:ring-1 focus:ring-accent"
                  />
                </div>
                <div className="flex-1">
                  <label className="text-xs text-txt-muted mb-1 block">Startnummer</label>
                  <input
                    type="text"
                    value={numberRanges[key]?.startNumber || ""}
                    onChange={(e) => updateRange(key, "startNumber", e.target.value)}
                    className="w-full rounded-lg border border-app-border bg-app-bg px-3 py-2 text-sm text-txt-primary focus:outline-none focus:ring-1 focus:ring-accent"
                  />
                </div>
                <div className="flex-1">
                  <label className="text-xs text-txt-muted mb-1 block">Vorschau</label>
                  <div className="rounded-lg border border-app-border bg-app-elevated px-3 py-2 text-sm font-mono text-txt-secondary">
                    {numberRanges[key]?.prefix}{numberRanges[key]?.startNumber}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Section 4: Dokumenten-Templates */}
      {templates.length > 0 && (
        <div className="rounded-xl border border-app-border bg-app-surface p-6">
          <SectionHeader title="Dokumenten-Templates" description="Vorlagen für Rechnungen, Lieferscheine und Auftragsbestätigungen" />
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {templates.map((tpl) => (
              <div key={tpl.id} className="rounded-xl border border-app-border bg-app-bg overflow-hidden">
                <div className="h-32 bg-app-elevated flex items-center justify-center border-b border-app-border">
                  <svg className="w-10 h-10 text-txt-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                  </svg>
                </div>
                <div className="p-4">
                  <h4 className="text-sm font-semibold text-txt-primary">{tpl.name}</h4>
                  <p className="text-xs text-txt-muted mt-1">
                    Zuletzt bearbeitet: {new Date(tpl.lastEdited).toLocaleDateString("de-DE")}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Pricing Engine */}
      <div className="rounded-xl border border-app-border bg-app-surface p-6">
        <h3 className="text-base font-bold text-txt-primary mb-1">Pricing & Repricing</h3>
        <p className="text-sm text-txt-muted mb-4">
          Automatische Preisvorschläge basierend auf EAN-Vergleich, Kategoriedurchschnitt und Marktdaten.
          {pricingRulesCount !== null && (
            <span className="ml-1 font-medium">{pricingRulesCount} aktive Regeln.</span>
          )}
        </p>

        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={repricingBusy}
            onClick={async () => {
              setRepricingBusy(true);
              setRepricingResult(null);
              try {
                const result = await runRepricingBatch();
                setRepricingResult(result);
                toast.success(
                  `Repricing: ${result.updated}/${result.processed} Produkte aktualisiert`
                );
              } catch (err: any) {
                toast.error(err?.message || "Repricing fehlgeschlagen");
              } finally {
                setRepricingBusy(false);
              }
            }}
            className="inline-flex items-center gap-2 rounded-lg bg-accent text-white px-4 py-2.5 text-sm font-semibold hover:bg-accent/90 transition disabled:opacity-50"
          >
            {repricingBusy && (
              <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            )}
            {repricingBusy ? "Repricing läuft…" : "Repricing starten"}
          </button>

          {repricingResult && (
            <div className="text-sm text-txt-muted">
              <span className="font-semibold text-success">{repricingResult.updated}</span> aktualisiert,{" "}
              <span className="font-semibold">{repricingResult.processed}</span> geprüft
              {repricingResult.errors > 0 && (
                <span className="ml-1 text-danger">({repricingResult.errors} Fehler)</span>
              )}
            </div>
          )}
        </div>

        {repricingResult?.suggestions?.length > 0 && (
          <div className="mt-4 rounded-lg border border-app-border overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-app-bg/50 border-b border-app-border">
                  <th className="text-left px-4 py-2 text-xs font-semibold text-txt-muted">Produkt</th>
                  <th className="text-right px-4 py-2 text-xs font-semibold text-txt-muted">Aktuell</th>
                  <th className="text-right px-4 py-2 text-xs font-semibold text-txt-muted">Vorschlag</th>
                  <th className="text-right px-4 py-2 text-xs font-semibold text-txt-muted">Marge</th>
                  <th className="text-left px-4 py-2 text-xs font-semibold text-txt-muted">Tier</th>
                </tr>
              </thead>
              <tbody>
                {repricingResult.suggestions.slice(0, 20).map((s: any, i: number) => (
                  <tr key={s.productId || i} className="border-b border-app-border last:border-b-0">
                    <td className="px-4 py-2 font-mono text-xs text-txt-primary">{s.productId?.slice(0, 12)}…</td>
                    <td className="px-4 py-2 text-right text-txt-muted">
                      {typeof s.currentPrice === "number" ? `${s.currentPrice.toFixed(2)} €` : "—"}
                    </td>
                    <td className="px-4 py-2 text-right font-semibold text-accent">
                      {typeof s.suggestedPrice === "number" ? `${s.suggestedPrice.toFixed(2)} €` : "—"}
                    </td>
                    <td className="px-4 py-2 text-right text-txt-muted">
                      {typeof s.margin === "number" ? `${(s.margin * 100).toFixed(0)}%` : "—"}
                    </td>
                    <td className="px-4 py-2">
                      <span className="inline-flex rounded-md px-2 py-0.5 text-[11px] font-semibold bg-accent-dim text-accent">
                        {s.pricingTier || "—"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Save Button */}
      <div className="flex justify-end pb-8">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="inline-flex items-center gap-2 rounded-lg bg-accent text-white px-6 py-2.5 text-sm font-semibold hover:bg-accent/80 transition disabled:opacity-50"
        >
          {saving && (
            <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
          )}
          Einstellungen speichern
        </button>
      </div>
    </div>
  );
};

export default OrderSettingsView;

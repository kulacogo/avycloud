import React, { useState } from "react";

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

/* ─── Initial State ─── */
const INITIAL_RULES: AutomationRule[] = [
  { id: "rule-1", label: "Wenn Zahlung eingegangen \u2192 Status 'Bestaetigt'", enabled: true },
  { id: "rule-2", label: "Wenn alle Items gepickt \u2192 Status 'Kommissioniert'", enabled: true },
  { id: "rule-3", label: "Wenn Versandlabel erstellt \u2192 Status 'Versendet'", enabled: true },
  { id: "rule-4", label: "Wenn Tracking 'Zugestellt' \u2192 Status 'Abgeschlossen'", enabled: false },
];

const INITIAL_STATUSES: OrderStatusConfig[] = [
  { id: "st-1", name: "Neu", description: "Bestellung eingegangen, noch nicht bearbeitet", color: "#3B82F6" },
  { id: "st-2", name: "Bestaetigt", description: "Zahlung eingegangen, bereit zur Bearbeitung", color: "#EAB308" },
  { id: "st-3", name: "Kommissionierung", description: "Artikel werden aus dem Lager gepickt", color: "#8B5CF6" },
  { id: "st-4", name: "Verpackung", description: "Artikel werden verpackt und versandfertig gemacht", color: "#F97316" },
  { id: "st-5", name: "Versendet", description: "Paket wurde an den Versanddienstleister uebergeben", color: "#22C55E" },
  { id: "st-6", name: "Zugestellt", description: "Paket wurde erfolgreich zugestellt", color: "#6B7280" },
  { id: "st-7", name: "Storniert", description: "Bestellung wurde storniert", color: "#EF4444" },
];

const INITIAL_NUMBER_RANGES: Record<string, NumberRange> = {
  invoice: { prefix: "RE-", startNumber: "2026-0001" },
  order: { prefix: "ORD-", startNumber: "2026-0001" },
  deliveryNote: { prefix: "LS-", startNumber: "2026-0001" },
};

const INITIAL_TEMPLATES: DocTemplate[] = [
  { id: "tpl-1", name: "Rechnung", lastEdited: "2026-02-28" },
  { id: "tpl-2", name: "Lieferschein", lastEdited: "2026-02-20" },
  { id: "tpl-3", name: "Auftragsbestaetigung", lastEdited: "2026-01-15" },
];

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
  const [rules, setRules] = useState<AutomationRule[]>(INITIAL_RULES);
  const [statuses, setStatuses] = useState<OrderStatusConfig[]>(INITIAL_STATUSES);
  const [numberRanges, setNumberRanges] = useState(INITIAL_NUMBER_RANGES);
  const [templates] = useState<DocTemplate[]>(INITIAL_TEMPLATES);
  const [saving, setSaving] = useState(false);

  /* ─── Automation Handlers ─── */
  const toggleRule = (id: string) => {
    setRules((prev) =>
      prev.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r))
    );
  };

  const handleAddRule = () => {
    // TODO: open modal to define new automation rule
  };

  /* ─── Status Handlers ─── */
  const updateStatusName = (id: string, name: string) => {
    setStatuses((prev) =>
      prev.map((s) => (s.id === id ? { ...s, name } : s))
    );
  };

  const handleAddStatus = () => {
    const newId = `st-${Date.now()}`;
    setStatuses((prev) => [
      ...prev,
      { id: newId, name: "Neuer Status", description: "Beschreibung eingeben", color: "#6B7280" },
    ]);
  };

  /* ─── Number Range Handlers ─── */
  const updateRange = (key: string, field: keyof NumberRange, value: string) => {
    setNumberRanges((prev) => ({
      ...prev,
      [key]: { ...prev[key], [field]: value },
    }));
  };

  /* ─── Template Handlers ─── */
  const handleEditTemplate = (_id: string) => {
    // TODO: navigate to template editor
  };

  const handlePreviewTemplate = (_id: string) => {
    // TODO: open template preview modal / GET /api/orders/templates/:id/preview
  };

  /* ─── Save ─── */
  const handleSave = async () => {
    setSaving(true);
    // TODO: POST /api/orders/settings { rules, statuses, numberRanges }
    setTimeout(() => setSaving(false), 800);
  };

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-txt-primary">Auftragseinstellungen</h1>
        <p className="text-sm text-txt-muted">Automatisierungen, Status und Nummernkreise konfigurieren</p>
      </div>

      {/* Section 1: Automatisierung */}
      <div className="rounded-xl border border-app-border bg-app-surface p-6">
        <SectionHeader
          title="Automatisierung"
          description="Regeln fuer automatische Statusaenderungen bei Auftraegen"
        />
        <div className="space-y-3">
          {rules.map((rule) => (
            <div
              key={rule.id}
              className="flex items-center justify-between gap-4 rounded-xl border border-app-border bg-app-bg p-4"
            >
              <span className={`text-sm ${rule.enabled ? "text-txt-primary" : "text-txt-muted"}`}>
                {rule.label}
              </span>
              <Toggle enabled={rule.enabled} onChange={() => toggleRule(rule.id)} />
            </div>
          ))}
          <button
            type="button"
            onClick={handleAddRule}
            className="w-full rounded-xl border border-dashed border-app-border bg-app-bg p-3 text-sm text-txt-muted hover:text-txt-secondary hover:border-txt-muted transition text-center"
          >
            + Regel hinzufuegen
          </button>
        </div>
      </div>

      {/* Section 2: Status-Konfiguration */}
      <div className="rounded-xl border border-app-border bg-app-surface p-6">
        <SectionHeader
          title="Status-Konfiguration"
          description="Auftragsstatus definieren und anpassen"
        />
        <div className="space-y-2">
          {statuses.map((status) => (
            <div
              key={status.id}
              className="flex items-center gap-3 rounded-xl border border-app-border bg-app-bg px-4 py-3"
            >
              {/* Color dot */}
              <span
                className="w-3 h-3 rounded-full flex-shrink-0"
                style={{ backgroundColor: status.color }}
              />
              {/* Name (editable) */}
              <input
                type="text"
                value={status.name}
                onChange={(e) => updateStatusName(status.id, e.target.value)}
                className="bg-transparent text-sm font-semibold text-txt-primary border-none outline-none focus:ring-0 w-40"
              />
              {/* Description */}
              <span className="text-xs text-txt-muted flex-1 truncate">{status.description}</span>
              {/* Drag handle placeholder */}
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
            + Status hinzufuegen
          </button>
        </div>
      </div>

      {/* Section 3: Nummernkreise */}
      <div className="rounded-xl border border-app-border bg-app-surface p-6">
        <SectionHeader
          title="Nummernkreise"
          description="Praefix und Startnummern fuer Dokumente festlegen"
        />
        <div className="space-y-5">
          {/* Invoice */}
          <div>
            <h3 className="text-sm font-semibold text-txt-primary mb-2">Rechnungs-Nummernkreis</h3>
            <div className="flex items-center gap-3">
              <div className="flex-1">
                <label className="text-xs text-txt-muted mb-1 block">Praefix</label>
                <input
                  type="text"
                  value={numberRanges.invoice.prefix}
                  onChange={(e) => updateRange("invoice", "prefix", e.target.value)}
                  className="w-full rounded-lg border border-app-border bg-app-bg px-3 py-2 text-sm text-txt-primary focus:outline-none focus:ring-1 focus:ring-accent"
                />
              </div>
              <div className="flex-1">
                <label className="text-xs text-txt-muted mb-1 block">Startnummer</label>
                <input
                  type="text"
                  value={numberRanges.invoice.startNumber}
                  onChange={(e) => updateRange("invoice", "startNumber", e.target.value)}
                  className="w-full rounded-lg border border-app-border bg-app-bg px-3 py-2 text-sm text-txt-primary focus:outline-none focus:ring-1 focus:ring-accent"
                />
              </div>
              <div className="flex-1">
                <label className="text-xs text-txt-muted mb-1 block">Vorschau</label>
                <div className="rounded-lg border border-app-border bg-app-elevated px-3 py-2 text-sm font-mono text-txt-secondary">
                  {numberRanges.invoice.prefix}{numberRanges.invoice.startNumber.replace(/^(\d{4}-)0*(\d+)$/, (_, y, n) => `${y}${n.padStart(4, "0").slice(0, -1)}2`)}
                </div>
              </div>
            </div>
          </div>

          {/* Order */}
          <div>
            <h3 className="text-sm font-semibold text-txt-primary mb-2">Auftrags-Nummernkreis</h3>
            <div className="flex items-center gap-3">
              <div className="flex-1">
                <label className="text-xs text-txt-muted mb-1 block">Praefix</label>
                <input
                  type="text"
                  value={numberRanges.order.prefix}
                  onChange={(e) => updateRange("order", "prefix", e.target.value)}
                  className="w-full rounded-lg border border-app-border bg-app-bg px-3 py-2 text-sm text-txt-primary focus:outline-none focus:ring-1 focus:ring-accent"
                />
              </div>
              <div className="flex-1">
                <label className="text-xs text-txt-muted mb-1 block">Startnummer</label>
                <input
                  type="text"
                  value={numberRanges.order.startNumber}
                  onChange={(e) => updateRange("order", "startNumber", e.target.value)}
                  className="w-full rounded-lg border border-app-border bg-app-bg px-3 py-2 text-sm text-txt-primary focus:outline-none focus:ring-1 focus:ring-accent"
                />
              </div>
              <div className="flex-1">
                <label className="text-xs text-txt-muted mb-1 block">Vorschau</label>
                <div className="rounded-lg border border-app-border bg-app-elevated px-3 py-2 text-sm font-mono text-txt-secondary">
                  {numberRanges.order.prefix}{numberRanges.order.startNumber}
                </div>
              </div>
            </div>
          </div>

          {/* Delivery Note */}
          <div>
            <h3 className="text-sm font-semibold text-txt-primary mb-2">Lieferschein-Nummernkreis</h3>
            <div className="flex items-center gap-3">
              <div className="flex-1">
                <label className="text-xs text-txt-muted mb-1 block">Praefix</label>
                <input
                  type="text"
                  value={numberRanges.deliveryNote.prefix}
                  onChange={(e) => updateRange("deliveryNote", "prefix", e.target.value)}
                  className="w-full rounded-lg border border-app-border bg-app-bg px-3 py-2 text-sm text-txt-primary focus:outline-none focus:ring-1 focus:ring-accent"
                />
              </div>
              <div className="flex-1">
                <label className="text-xs text-txt-muted mb-1 block">Startnummer</label>
                <input
                  type="text"
                  value={numberRanges.deliveryNote.startNumber}
                  onChange={(e) => updateRange("deliveryNote", "startNumber", e.target.value)}
                  className="w-full rounded-lg border border-app-border bg-app-bg px-3 py-2 text-sm text-txt-primary focus:outline-none focus:ring-1 focus:ring-accent"
                />
              </div>
              <div className="flex-1">
                <label className="text-xs text-txt-muted mb-1 block">Vorschau</label>
                <div className="rounded-lg border border-app-border bg-app-elevated px-3 py-2 text-sm font-mono text-txt-secondary">
                  {numberRanges.deliveryNote.prefix}{numberRanges.deliveryNote.startNumber}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Section 4: Dokumenten-Templates */}
      <div className="rounded-xl border border-app-border bg-app-surface p-6">
        <SectionHeader
          title="Dokumenten-Templates"
          description="Vorlagen fuer Rechnungen, Lieferscheine und Auftragsbestaetigungen"
        />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {templates.map((tpl) => (
            <div
              key={tpl.id}
              className="rounded-xl border border-app-border bg-app-bg overflow-hidden"
            >
              {/* Preview area */}
              <div className="h-32 bg-app-elevated flex items-center justify-center border-b border-app-border">
                <svg className="w-10 h-10 text-txt-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                </svg>
              </div>
              {/* Info */}
              <div className="p-4">
                <h4 className="text-sm font-semibold text-txt-primary">{tpl.name}</h4>
                <p className="text-xs text-txt-muted mt-1">
                  Zuletzt bearbeitet: {new Date(tpl.lastEdited).toLocaleDateString("de-DE")}
                </p>
                <div className="flex gap-2 mt-3">
                  <button
                    type="button"
                    onClick={() => handleEditTemplate(tpl.id)}
                    className="flex-1 rounded-lg bg-accent text-white px-3 py-1.5 text-xs font-semibold hover:bg-accent/80 transition text-center"
                  >
                    Bearbeiten
                  </button>
                  <button
                    type="button"
                    onClick={() => handlePreviewTemplate(tpl.id)}
                    className="flex-1 rounded-lg bg-app-elevated text-txt-secondary px-3 py-1.5 text-xs font-semibold hover:text-txt-primary transition text-center"
                  >
                    Vorschau
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
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

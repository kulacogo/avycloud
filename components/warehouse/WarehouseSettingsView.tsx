import React, { useState, useEffect, useCallback } from "react";
import { fetchWarehouseSettings, saveWarehouseSettings } from "../../api/client";

/* ─── Types ─── */
interface ZoneType {
  id: string;
  name: string;
  description: string;
  capacity: number;
}

type BinStrategy = "fifo" | "next_free" | "group_same";
type BarcodeFormat = "code128" | "qr" | "ean13";
type LabelSize = "standard" | "large" | "small";
type NotificationChannel = "email" | "dashboard" | "both";
type InventoryInterval = "monthly" | "quarterly" | "biannual" | "yearly";

interface WarehouseSettings {
  autoBinAssignment: boolean;
  binStrategy: BinStrategy;
  barcodeFormat: BarcodeFormat;
  binPrefix: string;
  labelSize: LabelSize;
  defaultMinStock: number;
  alarmThreshold: number;
  lowStockNotification: boolean;
  notificationChannel: NotificationChannel;
  inventoryInterval: InventoryInterval;
  inventoryReminder: boolean;
  reminderDaysBefore: number;
}

const DEFAULT_SETTINGS: WarehouseSettings = {
  autoBinAssignment: true,
  binStrategy: "fifo",
  barcodeFormat: "code128",
  binPrefix: "BIN-",
  labelSize: "standard",
  defaultMinStock: 5,
  alarmThreshold: 3,
  lowStockNotification: true,
  notificationChannel: "both",
  inventoryInterval: "quarterly",
  inventoryReminder: true,
  reminderDaysBefore: 7,
};

const DEFAULT_ZONE_TYPES: ZoneType[] = [
  { id: "regal", name: "Regal", description: "Standard", capacity: 50 },
  { id: "palette", name: "Palette", description: "Schwerlast", capacity: 200 },
  { id: "kleinteile", name: "Kleinteile", description: "Sortiment", capacity: 500 },
  { id: "kuehlung", name: "Kühlung", description: "Temperaturgeführt", capacity: 30 },
];

const STRATEGY_OPTIONS: { value: BinStrategy; label: string; desc: string }[] = [
  { value: "fifo", label: "FIFO (First In, First Out)", desc: "Älteste Positionen werden zuerst belegt. Ideal für verderbliche Waren oder Chargen-Tracking." },
  { value: "next_free", label: "Nächste freie Position", desc: "Artikel werden dem nächsten verfügbaren Bin zugewiesen. Schnellste Einlagerung." },
  { value: "group_same", label: "Gleicher Artikel zusammen", desc: "Identische Artikel werden im selben Bin oder benachbarten Bins gruppiert." },
];

/* ─── Reusable UI pieces ─── */
const SectionCard: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="rounded-xl border border-app-border bg-app-surface p-6">
    <h3 className="text-base font-semibold text-txt-primary mb-4">{title}</h3>
    {children}
  </div>
);

const Toggle: React.FC<{ checked: boolean; onChange: (v: boolean) => void; label: string }> = ({ checked, onChange, label }) => (
  <label className="flex items-center justify-between gap-3 cursor-pointer">
    <span className="text-sm text-txt-primary">{label}</span>
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${checked ? "bg-accent" : "bg-app-elevated"}`}
    >
      <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-6" : "translate-x-1"}`} />
    </button>
  </label>
);

const FieldLabel: React.FC<{ children: React.ReactNode; htmlFor?: string }> = ({ children, htmlFor }) => (
  <label htmlFor={htmlFor} className="block text-sm font-medium text-txt-secondary mb-1">{children}</label>
);

const HelpText: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <p className="text-xs text-txt-muted mt-1">{children}</p>
);

/* ─── Main Component ─── */
export const WarehouseSettingsView: React.FC = () => {
  const [settings, setSettings] = useState<WarehouseSettings>(DEFAULT_SETTINGS);
  const [zoneTypes, setZoneTypes] = useState<ZoneType[]>([]);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchWarehouseSettings();
      if (data.settings) {
        setSettings({ ...DEFAULT_SETTINGS, ...data.settings });
      }
      setZoneTypes(data.zoneTypes?.length ? data.zoneTypes : DEFAULT_ZONE_TYPES);
    } catch (err: any) {
      setError(err.message || "Fehler beim Laden der Lager-Einstellungen");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const update = <K extends keyof WarehouseSettings>(key: K, value: WarehouseSettings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const removeZoneType = (id: string) => {
    setZoneTypes((prev) => prev.filter((z) => z.id !== id));
  };

  const addZoneType = () => {
    const id = `zone_${Date.now()}`;
    setZoneTypes((prev) => [...prev, { id, name: "", description: "", capacity: 0 }]);
  };

  const updateZoneType = (id: string, field: keyof ZoneType, value: string | number) => {
    setZoneTypes((prev) => prev.map((z) => (z.id === id ? { ...z, [field]: value } : z)));
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSaveSuccess(false);
    try {
      await saveWarehouseSettings({ settings, zoneTypes });
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err: any) {
      setError(err.message || "Fehler beim Speichern der Lager-Einstellungen");
    } finally {
      setSaving(false);
    }
  };

  const selectCls = "w-full rounded-lg border border-app-border bg-app-bg px-3 py-2 text-sm text-txt-primary focus:outline-none focus:ring-2 focus:ring-accent/40";
  const inputCls = selectCls;

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto flex flex-col gap-6 pb-10 animate-pulse">
        {[1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="rounded-xl border border-app-border bg-app-surface p-6 h-40" />
        ))}
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto flex flex-col gap-6 pb-10">
      <h2 className="text-xl font-bold text-txt-primary">Lager-Einstellungen</h2>

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

      {/* ── Section 1: Bin-Logik ── */}
      <SectionCard title="Bin-Logik">
        <div className="flex flex-col gap-4">
          <Toggle checked={settings.autoBinAssignment} onChange={(v) => update("autoBinAssignment", v)} label="Automatische Bin-Zuweisung" />
          <div>
            <FieldLabel htmlFor="binStrategy">Vergabe-Strategie</FieldLabel>
            <select id="binStrategy" value={settings.binStrategy} onChange={(e) => update("binStrategy", e.target.value as BinStrategy)} className={selectCls}>
              {STRATEGY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <HelpText>{STRATEGY_OPTIONS.find((o) => o.value === settings.binStrategy)?.desc}</HelpText>
          </div>
        </div>
      </SectionCard>

      {/* ── Section 2: Zonen-Typen ── */}
      <SectionCard title="Zonen-Typen">
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead>
              <tr className="border-b border-app-border text-txt-muted text-xs uppercase tracking-wider">
                <th className="py-2 pr-3">Name</th>
                <th className="py-2 pr-3">Beschreibung</th>
                <th className="py-2 pr-3 text-right">Standard-Kapazität</th>
                <th className="py-2 text-right">Aktionen</th>
              </tr>
            </thead>
            <tbody>
              {zoneTypes.map((z) => (
                <tr key={z.id} className="border-b border-app-border last:border-b-0">
                  <td className="py-2.5 pr-3">
                    <input value={z.name} onChange={(e) => updateZoneType(z.id, "name", e.target.value)} className={`${inputCls} max-w-[140px]`} placeholder="Name" />
                  </td>
                  <td className="py-2.5 pr-3">
                    <input value={z.description} onChange={(e) => updateZoneType(z.id, "description", e.target.value)} className={`${inputCls} max-w-[180px]`} placeholder="Beschreibung" />
                  </td>
                  <td className="py-2.5 pr-3 text-right">
                    <input type="number" min={0} value={z.capacity} onChange={(e) => updateZoneType(z.id, "capacity", Number(e.target.value))} className={`${inputCls} max-w-[100px] text-right`} />
                  </td>
                  <td className="py-2.5 text-right">
                    <button type="button" onClick={() => removeZoneType(z.id)} className="text-xs text-danger hover:text-danger/80 transition-colors">Löschen</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button type="button" onClick={addZoneType} className="mt-3 rounded-lg border border-dashed border-app-border px-4 py-2 text-sm text-txt-secondary hover:bg-app-elevated transition-colors">
          + Zonen-Typ hinzufügen
        </button>
      </SectionCard>

      {/* ── Section 3: Barcode-Einstellungen ── */}
      <SectionCard title="Barcode-Einstellungen">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <FieldLabel htmlFor="barcodeFormat">Barcode-Format</FieldLabel>
            <select id="barcodeFormat" value={settings.barcodeFormat} onChange={(e) => update("barcodeFormat", e.target.value as BarcodeFormat)} className={selectCls}>
              <option value="code128">Code128</option>
              <option value="qr">QR-Code</option>
              <option value="ean13">EAN-13</option>
            </select>
          </div>
          <div>
            <FieldLabel htmlFor="binPrefix">Bin-Prefix</FieldLabel>
            <input id="binPrefix" value={settings.binPrefix} onChange={(e) => update("binPrefix", e.target.value)} className={inputCls} />
          </div>
          <div>
            <FieldLabel htmlFor="labelSize">Label-Größe</FieldLabel>
            <select id="labelSize" value={settings.labelSize} onChange={(e) => update("labelSize", e.target.value as LabelSize)} className={selectCls}>
              <option value="standard">Standard (50x25mm)</option>
              <option value="large">Groß (100x50mm)</option>
              <option value="small">Klein (30x15mm)</option>
            </select>
          </div>
          <div className="flex items-end">
            <button type="button" className="rounded-lg border border-app-border bg-app-elevated px-4 py-2 text-sm text-txt-secondary hover:bg-app-bg transition-colors">
              Test-Label drucken
            </button>
          </div>
        </div>
      </SectionCard>

      {/* ── Section 4: Bestandsgrenzen ── */}
      <SectionCard title="Bestandsgrenzen">
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <FieldLabel htmlFor="defaultMinStock">Standard-Mindestbestand</FieldLabel>
              <input id="defaultMinStock" type="number" min={0} value={settings.defaultMinStock} onChange={(e) => update("defaultMinStock", Number(e.target.value))} className={inputCls} />
            </div>
            <div>
              <FieldLabel htmlFor="alarmThreshold">Alarm-Schwelle</FieldLabel>
              <input id="alarmThreshold" type="number" min={0} value={settings.alarmThreshold} onChange={(e) => update("alarmThreshold", Number(e.target.value))} className={inputCls} />
              <HelpText>Benachrichtigung wenn Bestand unter diesen Wert fällt</HelpText>
            </div>
          </div>
          <Toggle checked={settings.lowStockNotification} onChange={(v) => update("lowStockNotification", v)} label="Benachrichtigung bei Niedrig-Bestand" />
          {settings.lowStockNotification && (
            <div>
              <FieldLabel htmlFor="notificationChannel">Benachrichtigungskanal</FieldLabel>
              <select id="notificationChannel" value={settings.notificationChannel} onChange={(e) => update("notificationChannel", e.target.value as NotificationChannel)} className={selectCls}>
                <option value="email">E-Mail</option>
                <option value="dashboard">Dashboard</option>
                <option value="both">Beides</option>
              </select>
            </div>
          )}
        </div>
      </SectionCard>

      {/* ── Section 5: Inventur ── */}
      <SectionCard title="Inventur">
        <div className="flex flex-col gap-4">
          <div>
            <FieldLabel htmlFor="inventoryInterval">Inventur-Intervall</FieldLabel>
            <select id="inventoryInterval" value={settings.inventoryInterval} onChange={(e) => update("inventoryInterval", e.target.value as InventoryInterval)} className={selectCls}>
              <option value="monthly">Monatlich</option>
              <option value="quarterly">Quartalsweise</option>
              <option value="biannual">Halbjährlich</option>
              <option value="yearly">Jährlich</option>
            </select>
          </div>
          <Toggle checked={settings.inventoryReminder} onChange={(v) => update("inventoryReminder", v)} label="Inventur-Erinnerung" />
          {settings.inventoryReminder && (
            <div>
              <FieldLabel htmlFor="reminderDays">Erinnerung X Tage vorher</FieldLabel>
              <input id="reminderDays" type="number" min={1} value={settings.reminderDaysBefore} onChange={(e) => update("reminderDaysBefore", Number(e.target.value))} className={inputCls} />
            </div>
          )}
          <p className="text-sm text-txt-muted bg-app-elevated rounded-lg px-3 py-2">
            Nächste Inventur: <span className="font-medium text-txt-secondary">01.04.2026</span>
          </p>
        </div>
      </SectionCard>

      {/* ── Save ── */}
      <div className="flex justify-end">
        <button type="button" onClick={handleSave} disabled={saving} className="rounded-lg bg-accent px-6 py-2.5 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50 transition-colors">
          {saving ? "Speichern..." : "Einstellungen speichern"}
        </button>
      </div>
    </div>
  );
};

export default WarehouseSettingsView;

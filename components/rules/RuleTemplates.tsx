import React from "react";
import type { Condition } from "./ConditionRow";
import type { Action } from "./ActionRow";

export interface RuleTemplate {
  name: string;
  description: string;
  icon: string;
  conditions: Condition[];
  actions: Action[];
}

const TEMPLATES: RuleTemplate[] = [
  {
    name: "Preisrundung auf .99",
    description: "Rundet Verkaufspreise auf .99 ab",
    icon: "💰",
    conditions: [{ field: "details.pricing.sellPrice", operator: "greater_than", value: 0 }],
    actions: [{ type: "adjust_price", field: "details.pricing.sellPrice", value: -0.01, params: { mode: "absolute" } }],
  },
  {
    name: "eBay Titel-Prefix",
    description: "Fügt ein Prefix zu allen Produktnamen hinzu",
    icon: "🏷️",
    conditions: [{ field: "identification.name", operator: "is_not_empty" }],
    actions: [{ type: "prepend_text", field: "identification.name", value: "✅ " }],
  },
  {
    name: "Niedrigbestand markieren",
    description: "Setzt Verfügbarkeit bei weniger als 5 Stück",
    icon: "📦",
    conditions: [{ field: "inventory.quantity", operator: "less_than", value: 5 }],
    actions: [{ type: "set_field", field: "details.attributes.verfuegbarkeit", value: "Wenige verfügbar" }],
  },
  {
    name: "Fehlende Beschreibung",
    description: "Generiert Kurzbeschreibung aus Produktname",
    icon: "📝",
    conditions: [{ field: "details.short_description", operator: "is_empty" }],
    actions: [{ type: "set_field", field: "details.short_description", value: "Jetzt kaufen bei TrendOcean" }],
  },
  {
    name: "Zustand standardisieren",
    description: "Setzt Zustand auf 'Neu' für neue Produkte",
    icon: "✨",
    conditions: [
      { field: "identification.name", operator: "contains", value: "neu" },
      { field: "identification.brand", operator: "is_not_empty" },
    ],
    actions: [{ type: "set_field", field: "details.attributes.zustand", value: "Neu" }],
  },
  {
    name: "Mindestpreis-Guard",
    description: "Warnt bei Verkaufspreis unter Einkaufspreis",
    icon: "🛡️",
    conditions: [{ field: "details.pricing.sellPrice", operator: "less_than", value: 1 }],
    actions: [{ type: "set_field", field: "details.attributes.preiswarnung", value: "Preis prüfen!" }],
  },
];

interface Props {
  onSelect: (template: RuleTemplate) => void;
  onClose: () => void;
}

export const RuleTemplates: React.FC<Props> = ({ onSelect, onClose }) => (
  <div className="space-y-4">
    <div className="flex items-center justify-between">
      <h3 className="text-lg font-semibold text-txt-primary">Vorlagen</h3>
      <button type="button" onClick={onClose} className="text-txt-muted hover:text-txt-primary transition" aria-label="Schließen">&times;</button>
    </div>
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {TEMPLATES.map((t) => (
        <button
          key={t.name}
          type="button"
          onClick={() => onSelect(t)}
          className="text-left bg-app-surface border border-app-border rounded-lg p-4 hover:border-accent/50 hover:bg-app-elevated transition"
        >
          <div className="text-2xl mb-2">{t.icon}</div>
          <div className="font-semibold text-txt-primary text-sm mb-1">{t.name}</div>
          <div className="text-xs text-txt-muted">{t.description}</div>
        </button>
      ))}
    </div>
  </div>
);

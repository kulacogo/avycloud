import React from "react";

export interface Condition {
  field: string;
  operator: string;
  value?: any;
}

export const CONDITION_FIELDS = [
  { value: "identification.name", label: "Produktname", type: "string" },
  { value: "identification.brand", label: "Marke", type: "string" },
  { value: "identification.category", label: "Kategorie", type: "string" },
  { value: "details.pricing.sellPrice", label: "Verkaufspreis", type: "number" },
  { value: "details.pricing.buyPrice", label: "Einkaufspreis", type: "number" },
  { value: "details.short_description", label: "Kurzbeschreibung", type: "string" },
  { value: "details.key_features", label: "Highlights", type: "array" },
  { value: "details.identifiers.ean", label: "EAN", type: "string" },
  { value: "inventory.quantity", label: "Bestand", type: "number" },
  { value: "storage.binCode", label: "Lagerplatz", type: "string" },
] as const;

const OPERATORS_BY_TYPE: Record<string, { value: string; label: string }[]> = {
  string: [
    { value: "equals", label: "ist gleich" },
    { value: "not_equals", label: "ist nicht gleich" },
    { value: "contains", label: "enthält" },
    { value: "not_contains", label: "enthält nicht" },
    { value: "starts_with", label: "beginnt mit" },
    { value: "ends_with", label: "endet mit" },
    { value: "is_empty", label: "ist leer" },
    { value: "is_not_empty", label: "ist nicht leer" },
  ],
  number: [
    { value: "greater_than", label: "größer als" },
    { value: "less_than", label: "kleiner als" },
    { value: "equals", label: "ist gleich" },
    { value: "is_empty", label: "ist leer" },
  ],
  array: [
    { value: "is_empty", label: "ist leer" },
    { value: "is_not_empty", label: "ist nicht leer" },
  ],
};

const NO_VALUE_OPERATORS = new Set(["is_empty", "is_not_empty"]);

interface Props {
  condition: Condition;
  onChange: (updated: Condition) => void;
  onRemove: () => void;
}

export const ConditionRow: React.FC<Props> = ({ condition, onChange, onRemove }) => {
  const fieldDef = CONDITION_FIELDS.find((f) => f.value === condition.field);
  const fieldType = fieldDef?.type || "string";
  const operators = OPERATORS_BY_TYPE[fieldType] || OPERATORS_BY_TYPE.string;
  const hideValue = NO_VALUE_OPERATORS.has(condition.operator);

  return (
    <div className="flex items-center gap-2 bg-app-elevated rounded-lg p-3">
      <select
        value={condition.field}
        onChange={(e) => onChange({ ...condition, field: e.target.value, operator: "", value: "" })}
        className="flex-1 min-w-0 rounded-lg border border-app-border bg-app-surface text-txt-primary px-3 py-2 text-sm"
      >
        <option value="">Feld wählen...</option>
        {CONDITION_FIELDS.map((f) => (
          <option key={f.value} value={f.value}>{f.label}</option>
        ))}
      </select>

      <select
        value={condition.operator}
        onChange={(e) => onChange({ ...condition, operator: e.target.value })}
        className="flex-1 min-w-0 rounded-lg border border-app-border bg-app-surface text-txt-primary px-3 py-2 text-sm"
      >
        <option value="">Operator...</option>
        {operators.map((op) => (
          <option key={op.value} value={op.value}>{op.label}</option>
        ))}
      </select>

      {!hideValue && (
        <input
          type={fieldType === "number" ? "number" : "text"}
          value={condition.value ?? ""}
          onChange={(e) => onChange({ ...condition, value: fieldType === "number" ? Number(e.target.value) : e.target.value })}
          placeholder="Wert..."
          className="flex-1 min-w-0 rounded-lg border border-app-border bg-app-surface text-txt-primary px-3 py-2 text-sm"
        />
      )}

      <button
        type="button"
        onClick={onRemove}
        className="shrink-0 w-8 h-8 flex items-center justify-center rounded-lg text-txt-muted hover:text-danger hover:bg-danger-dim transition"
        aria-label="Bedingung entfernen"
      >
        &times;
      </button>
    </div>
  );
};

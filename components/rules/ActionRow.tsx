import React from "react";
import { CONDITION_FIELDS } from "./ConditionRow";

export interface Action {
  type: string;
  field: string;
  value?: any;
  params?: Record<string, any>;
}

const ACTION_TYPES = [
  { value: "set_field", label: "Feld setzen" },
  { value: "adjust_price", label: "Preis anpassen" },
  { value: "prepend_text", label: "Text voranstellen" },
  { value: "append_text", label: "Text anhängen" },
  { value: "replace_text", label: "Text ersetzen" },
] as const;

interface Props {
  action: Action;
  onChange: (updated: Action) => void;
  onRemove: () => void;
}

export const ActionRow: React.FC<Props> = ({ action, onChange, onRemove }) => {
  const isReplaceText = action.type === "replace_text";
  const isAdjustPrice = action.type === "adjust_price";

  return (
    <div className="flex flex-wrap items-center gap-2 bg-app-elevated rounded-lg p-3">
      <select
        value={action.type}
        onChange={(e) => onChange({ ...action, type: e.target.value, params: {} })}
        className="min-w-[140px] rounded-lg border border-app-border bg-app-surface text-txt-primary px-3 py-2 text-sm"
      >
        <option value="">Typ wählen...</option>
        {ACTION_TYPES.map((t) => (
          <option key={t.value} value={t.value}>{t.label}</option>
        ))}
      </select>

      <select
        value={action.field}
        onChange={(e) => onChange({ ...action, field: e.target.value })}
        className="min-w-[140px] rounded-lg border border-app-border bg-app-surface text-txt-primary px-3 py-2 text-sm"
      >
        <option value="">Feld...</option>
        {CONDITION_FIELDS.map((f) => (
          <option key={f.value} value={f.value}>{f.label}</option>
        ))}
      </select>

      {isAdjustPrice && (
        <select
          value={action.params?.mode || "absolute"}
          onChange={(e) => onChange({ ...action, params: { ...action.params, mode: e.target.value } })}
          className="min-w-[100px] rounded-lg border border-app-border bg-app-surface text-txt-primary px-3 py-2 text-sm"
        >
          <option value="absolute">Absolut (€)</option>
          <option value="percent">Prozent (%)</option>
        </select>
      )}

      {isReplaceText ? (
        <>
          <input
            type="text"
            value={action.params?.search ?? ""}
            onChange={(e) => onChange({ ...action, params: { ...action.params, search: e.target.value } })}
            placeholder="Suchen..."
            className="flex-1 min-w-[100px] rounded-lg border border-app-border bg-app-surface text-txt-primary px-3 py-2 text-sm"
          />
          <span className="text-txt-muted text-sm">&rarr;</span>
          <input
            type="text"
            value={action.params?.replace ?? ""}
            onChange={(e) => onChange({ ...action, params: { ...action.params, replace: e.target.value } })}
            placeholder="Ersetzen mit..."
            className="flex-1 min-w-[100px] rounded-lg border border-app-border bg-app-surface text-txt-primary px-3 py-2 text-sm"
          />
        </>
      ) : (
        <input
          type={isAdjustPrice ? "number" : "text"}
          value={action.value ?? ""}
          onChange={(e) => onChange({ ...action, value: isAdjustPrice ? Number(e.target.value) : e.target.value })}
          placeholder={isAdjustPrice ? "Betrag..." : "Wert..."}
          className="flex-1 min-w-[100px] rounded-lg border border-app-border bg-app-surface text-txt-primary px-3 py-2 text-sm"
        />
      )}

      <button
        type="button"
        onClick={onRemove}
        className="shrink-0 w-8 h-8 flex items-center justify-center rounded-lg text-txt-muted hover:text-danger hover:bg-danger-dim transition"
        aria-label="Aktion entfernen"
      >
        &times;
      </button>
    </div>
  );
};

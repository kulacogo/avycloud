import React, { useCallback, useEffect, useRef, useState } from "react";
import { ConditionRow, type Condition } from "./ConditionRow";
import { ActionRow, type Action } from "./ActionRow";
import { RulePreview } from "./RulePreview";
import { previewRule, type RuleData } from "../../api/client";

interface Props {
  rule?: RuleData | null;
  onSave: (data: { name: string; description: string; conditions: Condition[]; actions: Action[]; channel: string | null }) => Promise<void>;
  onCancel: () => void;
}

const emptyCondition = (): Condition => ({ field: "", operator: "", value: "" });
const emptyAction = (): Action => ({ type: "", field: "", value: "" });

export const RuleForm: React.FC<Props> = ({ rule, onSave, onCancel }) => {
  const [name, setName] = useState(rule?.name || "");
  const [description, setDescription] = useState(rule?.description || "");
  const [channel, setChannel] = useState<string | null>(rule?.channel || null);
  const [conditions, setConditions] = useState<Condition[]>(
    rule?.conditions?.length ? rule.conditions : [emptyCondition()]
  );
  const [actions, setActions] = useState<Action[]>(
    rule?.actions?.length ? rule.actions : [emptyAction()]
  );
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [previewData, setPreviewData] = useState<any>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const previewTimerRef = useRef<ReturnType<typeof setTimeout>>();

  // Debounced preview count
  useEffect(() => {
    if (!rule?.id) return;
    if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
    previewTimerRef.current = setTimeout(async () => {
      try {
        setPreviewLoading(true);
        const data = await previewRule(rule.id, 5);
        setPreviewData(data);
      } catch {
        setPreviewData(null);
      } finally {
        setPreviewLoading(false);
      }
    }, 500);
    return () => { if (previewTimerRef.current) clearTimeout(previewTimerRef.current); };
  }, [rule?.id, conditions, actions]);

  const updateCondition = useCallback((idx: number, updated: Condition) => {
    setConditions((prev) => prev.map((c, i) => (i === idx ? updated : c)));
  }, []);

  const updateAction = useCallback((idx: number, updated: Action) => {
    setActions((prev) => prev.map((a, i) => (i === idx ? updated : a)));
  }, []);

  const validate = () => {
    const errs: string[] = [];
    if (!name.trim()) errs.push("Name ist erforderlich");
    if (conditions.length === 0 || !conditions.some((c) => c.field && c.operator)) {
      errs.push("Mindestens eine vollständige Bedingung ist erforderlich");
    }
    if (actions.length === 0 || !actions.some((a) => a.type && a.field)) {
      errs.push("Mindestens eine vollständige Aktion ist erforderlich");
    }
    return errs;
  };

  const handleSubmit = async () => {
    const errs = validate();
    if (errs.length > 0) { setErrors(errs); return; }
    setErrors([]);
    setSaving(true);
    try {
      await onSave({
        name: name.trim(),
        description: description.trim(),
        conditions: conditions.filter((c) => c.field && c.operator),
        actions: actions.filter((a) => a.type && a.field),
        channel,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-bold text-txt-primary">
        {rule ? `Regel bearbeiten: ${rule.name}` : "Neue Regel"}
      </h2>

      {errors.length > 0 && (
        <div className="rounded-lg bg-danger-dim text-danger p-3 text-sm">
          {errors.map((e, i) => <div key={i}>{e}</div>)}
        </div>
      )}

      {/* Basic fields */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-txt-secondary mb-1">Name *</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="z.B. Preise runden auf .99"
            className="w-full rounded-lg border border-app-border bg-app-surface text-txt-primary px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-txt-secondary mb-1">Kanal</label>
          <select
            value={channel || ""}
            onChange={(e) => setChannel(e.target.value || null)}
            className="w-full rounded-lg border border-app-border bg-app-surface text-txt-primary px-3 py-2 text-sm"
          >
            <option value="">Alle Kanäle</option>
            <option value="ebay">eBay</option>
            <option value="kaufland">Kaufland</option>
          </select>
        </div>
      </div>
      <div>
        <label className="block text-sm font-medium text-txt-secondary mb-1">Beschreibung</label>
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Optional: Was macht diese Regel?"
          className="w-full rounded-lg border border-app-border bg-app-surface text-txt-primary px-3 py-2 text-sm"
        />
      </div>

      {/* Conditions */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-txt-primary">Bedingungen (AND)</h3>
          {previewData && !previewLoading && (
            <span className="text-accent font-semibold text-sm">{previewData.matchCount} Produkte treffen zu</span>
          )}
          {previewLoading && <span className="text-txt-muted text-xs">Zähle...</span>}
        </div>
        <div className="space-y-2">
          {conditions.map((c, i) => (
            <ConditionRow
              key={i}
              condition={c}
              onChange={(u) => updateCondition(i, u)}
              onRemove={() => setConditions((prev) => prev.filter((_, j) => j !== i))}
            />
          ))}
        </div>
        <button
          type="button"
          onClick={() => setConditions((prev) => [...prev, emptyCondition()])}
          className="mt-2 text-sm text-accent hover:text-accent/80 font-medium"
        >
          + Bedingung hinzufügen
        </button>
      </div>

      {/* Actions */}
      <div>
        <h3 className="text-sm font-semibold text-txt-primary mb-2">Aktionen (sequentiell)</h3>
        <div className="space-y-2">
          {actions.map((a, i) => (
            <ActionRow
              key={i}
              action={a}
              onChange={(u) => updateAction(i, u)}
              onRemove={() => setActions((prev) => prev.filter((_, j) => j !== i))}
            />
          ))}
        </div>
        <button
          type="button"
          onClick={() => setActions((prev) => [...prev, emptyAction()])}
          className="mt-2 text-sm text-accent hover:text-accent/80 font-medium"
        >
          + Aktion hinzufügen
        </button>
      </div>

      {/* Preview section for existing rules */}
      {previewData && previewData.sample?.length > 0 && (
        <RulePreview changes={previewData.sample.flatMap((s: any) => s.changes.map((c: any) => ({ ...c, productId: s.productId, productName: s.productName })))} matchCount={previewData.matchCount} />
      )}

      {/* Footer */}
      <div className="flex items-center justify-end gap-3 pt-4 border-t border-app-border">
        <button type="button" onClick={onCancel} className="rounded-lg border border-app-border bg-app-surface text-txt-primary px-4 py-2 text-sm font-semibold hover:bg-app-elevated transition">
          Abbrechen
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={saving}
          className="rounded-lg bg-accent text-white px-4 py-2 text-sm font-semibold hover:bg-accent/90 transition disabled:opacity-50"
        >
          {saving ? "Speichern..." : "Speichern"}
        </button>
      </div>
    </div>
  );
};

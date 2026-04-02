import React, { useState } from "react";
import { useBulkUpdate } from "../../hooks/useBulkUpdate";
import BulkDiffPreview from "./BulkDiffPreview";
import type { BulkFieldUpdate } from "../../api/client";

interface BulkUpdateModalProps {
  selectedIds: Set<string>;
  onClose: () => void;
  onSuccess: () => void;
}

const EDITABLE_FIELDS: { field: string; label: string; type: "text" | "number" | "select"; options?: { value: string; label: string }[] }[] = [
  { field: "details.pricing.sellPrice", label: "Verkaufspreis", type: "number" },
  { field: "details.pricing.buyPrice", label: "Einkaufspreis", type: "number" },
  { field: "identification.name", label: "Name", type: "text" },
  { field: "identification.brand", label: "Marke", type: "text" },
  { field: "identification.category", label: "Kategorie", type: "text" },
  {
    field: "details.attributes.condition",
    label: "Zustand",
    type: "select",
    options: [
      { value: "Neu", label: "Neu" },
      { value: "Gebraucht", label: "Gebraucht" },
      { value: "Generalüberholt", label: "Generalüberholt" },
    ],
  },
  {
    field: "ops.readiness",
    label: "Readiness",
    type: "select",
    options: [
      { value: "ready", label: "Ready" },
      { value: "pending", label: "Pending" },
      { value: "", label: "— (Leer)" },
    ],
  },
];

type Step = "select" | "value" | "preview" | "done";

const BulkUpdateModal: React.FC<BulkUpdateModalProps> = ({ selectedIds, onClose, onSuccess }) => {
  const [step, setStep] = useState<Step>("select");
  const [selectedField, setSelectedField] = useState<typeof EDITABLE_FIELDS[0] | null>(null);
  const [inputValue, setInputValue] = useState<string>("");
  const { loading, error, preview, result, executeDryRun, executeCommit, reset } = useBulkUpdate();

  const productIds = Array.from(selectedIds);

  const handlePreview = async () => {
    if (!selectedField) return;
    const value = selectedField.type === "number" ? parseFloat(inputValue) : inputValue;
    if (selectedField.type === "number" && isNaN(value as number)) return;
    const updates: BulkFieldUpdate[] = [{ field: selectedField.field, value }];
    await executeDryRun(productIds, updates);
    setStep("preview");
  };

  const handleCommit = async () => {
    if (!selectedField) return;
    const value = selectedField.type === "number" ? parseFloat(inputValue) : inputValue;
    const updates: BulkFieldUpdate[] = [{ field: selectedField.field, value }];
    await executeCommit(productIds, updates);
    setStep("done");
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleDone = () => {
    reset();
    onSuccess();
  };

  const readyCount = preview?.filter((d) => d.status === "ready").length || 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-app-surface rounded-lg border border-app-border shadow-xl w-full max-w-2xl max-h-[85vh] overflow-y-auto mx-4">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-app-border">
          <h2 className="text-lg font-semibold text-txt-primary">
            Feld ändern
            <span className="ml-2 text-sm font-normal text-txt-muted">({productIds.length} Produkte)</span>
          </h2>
          <button type="button" onClick={handleClose} className="text-txt-muted hover:text-txt-primary transition text-xl leading-none">&times;</button>
        </div>

        {/* Steps indicator */}
        <div className="flex items-center gap-2 px-4 pt-3">
          {(["select", "value", "preview"] as Step[]).map((s, i) => (
            <React.Fragment key={s}>
              <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${step === s || (step === "done" && s === "preview") ? "bg-accent text-white" : step === "done" || (["select", "value", "preview"].indexOf(step) > i) ? "bg-success text-white" : "bg-app-elevated text-txt-muted"}`}>
                {i + 1}
              </span>
              {i < 2 && <div className="flex-1 h-px bg-app-border" />}
            </React.Fragment>
          ))}
        </div>

        {/* Content */}
        <div className="p-4 space-y-4">
          {error && (
            <div className="rounded-md bg-danger-dim border border-danger/20 p-3 text-sm text-danger">{error}</div>
          )}

          {step === "select" && (
            <div className="space-y-3">
              <label className="block text-sm font-medium text-txt-secondary">Welches Feld soll geändert werden?</label>
              <div className="grid gap-2">
                {EDITABLE_FIELDS.map((f) => (
                  <button
                    key={f.field}
                    type="button"
                    onClick={() => { setSelectedField(f); setStep("value"); setInputValue(""); }}
                    className={`text-left px-4 py-3 rounded-lg border transition ${selectedField?.field === f.field ? "border-accent bg-accent-dim" : "border-app-border hover:border-accent/40 hover:bg-app-elevated/50"}`}
                  >
                    <span className="text-sm font-medium text-txt-primary">{f.label}</span>
                    <span className="ml-2 text-xs text-txt-muted">{f.field}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {step === "value" && selectedField && (
            <div className="space-y-3">
              <button type="button" onClick={() => setStep("select")} className="text-xs text-accent hover:underline">&larr; Feld ändern</button>
              <label className="block text-sm font-medium text-txt-secondary">
                Neuer Wert für <span className="text-txt-primary font-semibold">{selectedField.label}</span>
              </label>
              {selectedField.type === "select" ? (
                <select
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  className="w-full rounded-lg border border-app-border bg-app-elevated px-3 py-2 text-sm text-txt-primary"
                >
                  <option value="">Bitte wählen...</option>
                  {selectedField.options?.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              ) : (
                <input
                  type={selectedField.type}
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  placeholder={selectedField.type === "number" ? "0.00" : "Neuer Wert..."}
                  min={selectedField.type === "number" ? "0" : undefined}
                  step={selectedField.type === "number" ? "0.01" : undefined}
                  className="w-full rounded-lg border border-app-border bg-app-elevated px-3 py-2 text-sm text-txt-primary"
                  autoFocus
                />
              )}
              <button
                type="button"
                onClick={handlePreview}
                disabled={!inputValue || loading}
                className="w-full rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent/90 transition disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {loading ? "Vorschau wird erstellt..." : "Vorschau"}
              </button>
            </div>
          )}

          {step === "preview" && preview && (
            <div className="space-y-3">
              <button type="button" onClick={() => { setStep("value"); reset(); }} className="text-xs text-accent hover:underline">&larr; Wert ändern</button>
              <BulkDiffPreview diff={preview} />
              {readyCount > 0 ? (
                <button
                  type="button"
                  onClick={handleCommit}
                  disabled={loading}
                  className="w-full rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent/90 transition disabled:opacity-40"
                >
                  {loading ? "Wird gespeichert..." : `${readyCount} Änderungen übernehmen`}
                </button>
              ) : (
                <div className="text-sm text-txt-muted text-center py-2">Keine Änderungen erkannt.</div>
              )}
            </div>
          )}

          {step === "done" && result && (
            <div className="space-y-3 text-center py-4">
              <div className="text-3xl">&#10003;</div>
              <p className="text-sm text-txt-primary">
                <span className="font-semibold">{result.updated}</span> Produkte aktualisiert
                {result.skipped > 0 && <>, <span className="text-txt-muted">{result.skipped} übersprungen</span></>}
                {result.errors.length > 0 && <>, <span className="text-danger">{result.errors.length} Fehler</span></>}
              </p>
              {result.errors.length > 0 && (
                <div className="text-left text-xs text-danger space-y-1">
                  {result.errors.slice(0, 5).map((e) => (
                    <div key={e.id}>{e.id}: {e.reason}</div>
                  ))}
                </div>
              )}
              <button
                type="button"
                onClick={handleDone}
                className="rounded-lg bg-accent px-6 py-2 text-sm font-semibold text-white hover:bg-accent/90 transition"
              >
                Fertig
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default BulkUpdateModal;

import React, { useState } from "react";

export interface PricingRuleFormData {
  productId: string;
  ruleType: string;
  params: {
    minMargin?: number;
    minPrice?: number;
    maxPrice?: number;
    targetMargin?: number;
  };
  active: boolean;
}

interface PricingRuleFormProps {
  initial?: Partial<PricingRuleFormData> | null;
  onSave: (data: PricingRuleFormData) => Promise<void>;
  onCancel: () => void;
  productName?: string;
}

const STRATEGY_OPTIONS = [
  { value: "competitor_median", label: "Wettbewerber-Median" },
  { value: "category_match", label: "Kategorie-Durchschnitt" },
  { value: "cost_plus", label: "Kosten + Aufschlag" },
  { value: "manual", label: "Manuell" },
] as const;

const strategyLabel = (value: string) =>
  STRATEGY_OPTIONS.find((s) => s.value === value)?.label ?? value;

const PricingRuleForm: React.FC<PricingRuleFormProps> = ({
  initial,
  onSave,
  onCancel,
  productName,
}) => {
  const [productId, setProductId] = useState(initial?.productId ?? "");
  const [ruleType, setRuleType] = useState(initial?.ruleType ?? "competitor_median");
  const [minMargin, setMinMargin] = useState<string>(
    initial?.params?.minMargin != null ? String(initial.params.minMargin * 100) : "10"
  );
  const [minPrice, setMinPrice] = useState<string>(
    initial?.params?.minPrice != null ? String(initial.params.minPrice) : ""
  );
  const [maxPrice, setMaxPrice] = useState<string>(
    initial?.params?.maxPrice != null ? String(initial.params.maxPrice) : ""
  );
  const [active, setActive] = useState(initial?.active ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isEdit = Boolean(initial?.productId);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!productId.trim()) {
      setError("Produkt-ID ist erforderlich");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({
        productId: productId.trim(),
        ruleType,
        params: {
          ...(minMargin ? { minMargin: parseFloat(minMargin) / 100 } : {}),
          ...(minPrice ? { minPrice: parseFloat(minPrice) } : {}),
          ...(maxPrice ? { maxPrice: parseFloat(maxPrice) } : {}),
        },
        active,
      });
    } catch (err: any) {
      setError(err?.message || "Fehler beim Speichern");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[999] flex items-center justify-center bg-black/50">
      <div className="bg-app-surface border border-app-border rounded-lg shadow-xl w-full max-w-md mx-4">
        <div className="px-5 py-4 border-b border-app-border">
          <h3 className="text-base font-semibold text-txt-primary">
            {isEdit ? "Preisregel bearbeiten" : "Neue Preisregel"}
          </h3>
        </div>

        <form onSubmit={handleSubmit} className="px-5 py-4 space-y-4">
          {/* Product ID */}
          <div>
            <label className="block text-sm font-medium text-txt-secondary mb-1">
              Produkt-ID
            </label>
            {isEdit ? (
              <div className="text-sm text-txt-primary font-mono bg-app-elevated px-3 py-2 rounded-md">
                {productName || productId}
              </div>
            ) : (
              <input
                type="text"
                value={productId}
                onChange={(e) => setProductId(e.target.value)}
                placeholder="Produkt-ID eingeben"
                className="w-full px-3 py-2 text-sm bg-app-bg border border-app-border rounded-md
                  text-txt-primary placeholder:text-txt-muted
                  focus:outline-none focus:ring-1 focus:ring-accent focus:border-accent"
              />
            )}
          </div>

          {/* Strategy */}
          <div>
            <label className="block text-sm font-medium text-txt-secondary mb-1">
              Strategie
            </label>
            <select
              value={ruleType}
              onChange={(e) => setRuleType(e.target.value)}
              className="w-full px-3 py-2 text-sm bg-app-bg border border-app-border rounded-md
                text-txt-primary focus:outline-none focus:ring-1 focus:ring-accent focus:border-accent"
            >
              {STRATEGY_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {/* Min Margin */}
          <div>
            <label className="block text-sm font-medium text-txt-secondary mb-1">
              Min. Marge (%)
            </label>
            <input
              type="number"
              step="0.1"
              value={minMargin}
              onChange={(e) => setMinMargin(e.target.value)}
              placeholder="10"
              className="w-full px-3 py-2 text-sm bg-app-bg border border-app-border rounded-md
                text-txt-primary placeholder:text-txt-muted
                focus:outline-none focus:ring-1 focus:ring-accent focus:border-accent"
            />
          </div>

          {/* Min / Max Price row */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-txt-secondary mb-1">
                Min. Preis
              </label>
              <input
                type="number"
                step="0.01"
                value={minPrice}
                onChange={(e) => setMinPrice(e.target.value)}
                placeholder="--"
                className="w-full px-3 py-2 text-sm bg-app-bg border border-app-border rounded-md
                  text-txt-primary placeholder:text-txt-muted
                  focus:outline-none focus:ring-1 focus:ring-accent focus:border-accent"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-txt-secondary mb-1">
                Max. Preis
              </label>
              <input
                type="number"
                step="0.01"
                value={maxPrice}
                onChange={(e) => setMaxPrice(e.target.value)}
                placeholder="--"
                className="w-full px-3 py-2 text-sm bg-app-bg border border-app-border rounded-md
                  text-txt-primary placeholder:text-txt-muted
                  focus:outline-none focus:ring-1 focus:ring-accent focus:border-accent"
              />
            </div>
          </div>

          {/* Active toggle */}
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-txt-secondary">Aktiv</span>
            <button
              type="button"
              onClick={() => setActive(!active)}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                active ? "bg-accent" : "bg-app-elevated"
              }`}
            >
              <span
                className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                  active ? "translate-x-[18px]" : "translate-x-[3px]"
                }`}
              />
            </button>
          </div>

          {error && (
            <div className="text-sm text-danger px-3 py-2 bg-danger-dim rounded-md">{error}</div>
          )}

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onCancel}
              disabled={saving}
              className="px-4 py-2 text-sm font-medium rounded-md text-txt-secondary
                bg-app-elevated hover:bg-app-bg transition-colors disabled:opacity-50"
            >
              Abbrechen
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 text-sm font-medium rounded-md text-white
                bg-accent hover:bg-accent/90 transition-colors disabled:opacity-50"
            >
              {saving ? "Speichern..." : isEdit ? "Aktualisieren" : "Erstellen"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export { strategyLabel };
export default PricingRuleForm;

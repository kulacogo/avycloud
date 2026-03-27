import React, { useState, useMemo } from "react";
import { Product } from "../../types";
import { saveProduct } from "../../api/client";
import { Card } from "../ui/Card";
import { Button } from "../ui/Button";
import { Badge } from "../ui/Badge";
import { useToast } from "../../context/ToastContext";

interface StepSummaryProps {
  products: Product[];
  onSave: (saved: Product[]) => void;
  onBack: () => void;
  onReset: () => void;
}

const SummaryRow: React.FC<{ label: string; value?: string | number | null; badge?: boolean }> = ({
  label,
  value,
  badge,
}) => (
  <div className="flex items-start justify-between py-1.5">
    <span className="text-sm text-txt-muted">{label}</span>
    {badge ? (
      <Badge variant={value ? "success" : "neutral"} size="sm">
        {value || "—"}
      </Badge>
    ) : (
      <span className="text-sm text-txt-primary text-right max-w-[60%] truncate">
        {value ?? "—"}
      </span>
    )}
  </div>
);

function getHeroImage(product: Product): string | null {
  const images = product.details?.images;
  if (!images?.length) return null;
  const first = images[0];
  return typeof first === "string" ? first : (first as any)?.url || (first as any)?.url_or_base64 || null;
}

function getEan(product: Product): string | undefined {
  const ean = product.details?.identifiers?.ean;
  const val = Array.isArray(ean) ? ean[0] : ean;
  return val || product.identification?.barcodes?.[0];
}

const ProductCard: React.FC<{ product: Product }> = ({ product }) => {
  const heroImage = getHeroImage(product);

  return (
    <div className="grid grid-cols-1 md:grid-cols-[120px_1fr] gap-4">
      {/* Image */}
      <div>
        {heroImage ? (
          <div className="aspect-square rounded-xl overflow-hidden border border-app-border bg-app-elevated">
            <img src={heroImage} alt={product.identification?.name} className="w-full h-full object-cover" />
          </div>
        ) : (
          <div className="aspect-square rounded-xl border border-app-border bg-app-elevated flex items-center justify-center">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-txt-muted">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <path d="m21 15-5-5L5 21" />
            </svg>
          </div>
        )}
        {product.details?.images?.length > 1 && (
          <p className="text-xs text-txt-muted text-center mt-1">
            {product.details.images.length} Bilder
          </p>
        )}
      </div>

      {/* Details */}
      <Card padding="sm">
        <div className="divide-y divide-app-border">
          <SummaryRow label="Name" value={product.identification?.name} />
          <SummaryRow label="Marke" value={product.identification?.brand} />
          <SummaryRow label="Kategorie" value={product.identification?.category} />
          <SummaryRow label="EAN" value={getEan(product)} />
          <SummaryRow
            label="Zustand"
            value={product.details?.attributes?.condition as string}
            badge
          />
          <SummaryRow label="SKU" value={product.identification?.sku} />
        </div>
      </Card>
    </div>
  );
};

const StepSummary: React.FC<StepSummaryProps> = ({ products, onSave, onBack, onReset }) => {
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveResults, setSaveResults] = useState<{ success: number; failed: number; errors: string[] }>({
    success: 0, failed: 0, errors: [],
  });
  const { addToast } = useToast();

  const handleSave = async () => {
    setSaving(true);
    const successes: Product[] = [];
    const errors: string[] = [];

    for (const product of products) {
      try {
        const result = await saveProduct(product);
        if (!result.ok) {
          throw new Error(result.error?.message || "Speichern fehlgeschlagen.");
        }
        successes.push(product);
      } catch (err: any) {
        errors.push(`${product.identification?.name || product.id}: ${err?.message || "Fehler"}`);
      }
    }

    setSaveResults({ success: successes.length, failed: errors.length, errors });
    setSaving(false);

    if (successes.length > 0) {
      setSaved(true);
      const msg = products.length === 1
        ? `"${successes[0].identification?.name}" gespeichert`
        : `${successes.length} von ${products.length} Produkten gespeichert`;
      addToast("success", msg);
      onSave(successes);
    } else {
      addToast("error", `Keine Produkte gespeichert: ${errors[0]}`);
    }
  };

  if (saved) {
    return (
      <div className="space-y-6">
        <Card padding="lg" className="text-center">
          <div className="flex flex-col items-center gap-4">
            <div className="w-16 h-16 rounded-full bg-success/10 flex items-center justify-center">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-success">
                <path d="M20 6L9 17l-5-5" />
              </svg>
            </div>
            <div>
              <h2 className="text-lg font-semibold text-txt-primary">
                {products.length === 1
                  ? "Produkt erfolgreich angelegt"
                  : `${saveResults.success} Produkte erfolgreich angelegt`}
              </h2>
              <p className="text-sm text-txt-muted mt-1">
                {products.length === 1
                  ? `„${products[0].identification?.name}" wurde im Katalog gespeichert.`
                  : `${saveResults.success} von ${products.length} Produkten wurden im Katalog gespeichert.`}
              </p>
              {saveResults.failed > 0 && (
                <div className="mt-2 text-sm text-danger">
                  {saveResults.errors.map((e, i) => <div key={i}>{e}</div>)}
                </div>
              )}
            </div>
          </div>
        </Card>
        <div className="flex justify-center gap-3">
          <Button variant="secondary" onClick={() => window.location.hash = "#/products"}>
            Zum Produktkatalog
          </Button>
          <Button onClick={onReset}>
            Nächste Produkte erfassen
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-txt-primary">Zusammenfassung</h2>
        <p className="text-sm text-txt-muted mt-0.5">
          {products.length === 1
            ? "Prüfe die Daten und speichere das Produkt."
            : `Prüfe die Daten und speichere ${products.length} Produkte.`}
        </p>
      </div>

      <div className="space-y-4">
        {products.map((product, i) => (
          <Card key={product.id || i} padding="md">
            {products.length > 1 && (
              <h3 className="text-sm font-medium text-txt-secondary mb-3">
                Produkt {i + 1} von {products.length}
              </h3>
            )}
            <ProductCard product={product} />
          </Card>
        ))}
      </div>

      {/* Actions */}
      <div className="flex justify-between">
        <Button variant="secondary" onClick={onBack}>Zurück</Button>
        <Button
          onClick={handleSave}
          loading={saving}
          iconLeft={
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" />
              <polyline points="17 21 17 13 7 13 7 21" />
              <polyline points="7 3 7 8 15 8" />
            </svg>
          }
        >
          {products.length === 1 ? "Produkt speichern" : `${products.length} Produkte speichern`}
        </Button>
      </div>
    </div>
  );
};

export default StepSummary;

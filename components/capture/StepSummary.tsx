import React, { useState, useMemo } from "react";
import { Product } from "../../types";
import { saveProduct } from "../../api/client";
import { Card } from "../ui/Card";
import { Button } from "../ui/Button";
import { Badge } from "../ui/Badge";
import { useToast } from "../../context/ToastContext";

interface StepSummaryProps {
  product: Product;
  onSave: (saved: Product) => void;
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

const StepSummary: React.FC<StepSummaryProps> = ({ product, onSave, onBack, onReset }) => {
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const { addToast } = useToast();

  const heroImage = useMemo(() => {
    const images = product.details?.images;
    if (!images?.length) return null;
    const first = images[0];
    return typeof first === "string" ? first : (first as any)?.url || (first as any)?.url_or_base64 || null;
  }, [product]);

  const pricing = product.details?.pricing;
  const sellPrice = pricing?.sellPrice;
  const buyPrice = pricing?.buyPrice;
  const margin =
    sellPrice && buyPrice && buyPrice > 0
      ? ((sellPrice - buyPrice) / buyPrice * 100).toFixed(1)
      : null;

  const handleSave = async () => {
    setSaving(true);
    try {
      const result = await saveProduct(product);
      if (!result.ok) {
        throw new Error(result.error?.message || "Speichern fehlgeschlagen.");
      }
      setSaved(true);
      addToast({
        type: "success",
        title: `"${product.identification?.name}" gespeichert`,
        message: result.data?.sku ? `SKU: ${result.data.sku}` : undefined,
      });
      onSave(product);
    } catch (err: any) {
      addToast({
        type: "error",
        title: "Fehler beim Speichern",
        message: err?.message || "Ein unerwarteter Fehler ist aufgetreten.",
      });
    } finally {
      setSaving(false);
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
              <h2 className="text-lg font-semibold text-txt-primary">Produkt erfolgreich angelegt</h2>
              <p className="text-sm text-txt-muted mt-1">
                „{product.identification?.name}" wurde im Katalog gespeichert.
              </p>
            </div>
          </div>
        </Card>
        <div className="flex justify-center gap-3">
          <Button variant="secondary" onClick={() => window.location.hash = "#/products"}>
            Zum Produktkatalog
          </Button>
          <Button onClick={onReset}>
            Nächstes Produkt erfassen
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
          Prüfe die Daten und speichere das Produkt.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[180px_1fr] gap-6">
        {/* Image */}
        <div>
          {heroImage ? (
            <div className="aspect-square rounded-xl overflow-hidden border border-app-border bg-app-elevated">
              <img src={heroImage} alt={product.identification?.name} className="w-full h-full object-cover" />
            </div>
          ) : (
            <div className="aspect-square rounded-xl border border-app-border bg-app-elevated flex items-center justify-center">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-txt-muted">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <path d="m21 15-5-5L5 21" />
              </svg>
            </div>
          )}
          {product.details?.images?.length > 1 && (
            <p className="text-xs text-txt-muted text-center mt-2">
              {product.details.images.length} Bilder
            </p>
          )}
        </div>

        {/* Details */}
        <div className="space-y-4">
          <Card padding="sm">
            <h3 className="text-xs font-medium text-txt-muted mb-2">Produktdaten</h3>
            <div className="divide-y divide-app-border">
              <SummaryRow label="Name" value={product.identification?.name} />
              <SummaryRow label="Marke" value={product.identification?.brand} />
              <SummaryRow label="Kategorie" value={product.identification?.category} />
              <SummaryRow
                label="EAN"
                value={product.details?.identifiers?.ean?.[0] || product.identification?.barcodes?.[0]}
              />
              <SummaryRow
                label="Zustand"
                value={product.details?.attributes?.condition as string}
                badge
              />
              <SummaryRow label="SKU" value={product.identification?.sku} />
            </div>
          </Card>

          <Card padding="sm">
            <h3 className="text-xs font-medium text-txt-muted mb-2">Preis & Lager</h3>
            <div className="divide-y divide-app-border">
              <SummaryRow label="Verkaufspreis" value={sellPrice ? `${sellPrice.toFixed(2)} €` : null} />
              <SummaryRow label="Einkaufspreis" value={buyPrice ? `${buyPrice.toFixed(2)} €` : null} />
              {margin && <SummaryRow label="Marge" value={`${margin}%`} />}
              <SummaryRow label="Menge" value={product.ops?.pending_intake_quantity || 1} />
              <SummaryRow label="Lagerplatz" value={product.storage?.binCode} />
            </div>
          </Card>

          {product.details?.short_description && (
            <Card padding="sm">
              <h3 className="text-xs font-medium text-txt-muted mb-2">Beschreibung</h3>
              <p className="text-sm text-txt-secondary line-clamp-4">
                {product.details.short_description}
              </p>
            </Card>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="flex justify-between">
        <Button variant="secondary" onClick={onBack}>Zurück</Button>
        <div className="flex gap-3">
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
            Produkt speichern
          </Button>
        </div>
      </div>
    </div>
  );
};

export default StepSummary;

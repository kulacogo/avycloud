import React, { useState, useMemo } from "react";
import { Product } from "../../types";
import { Card } from "../ui/Card";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Badge } from "../ui/Badge";

import type { ReuseNotice } from "../../utils/reuseNotice";

interface StepReviewProps {
  product: Product;
  /**
   * Gesetzt, wenn dieses Produkt beim Erfassen als BEREITS VORHANDEN erkannt
   * wurde. Dann zeigt das Datenblatt den Bestand, nicht das frische Ergebnis —
   * das muss dranstehen, sonst haelt der Bediener die alten Werte fuer die
   * frisch erkannten. Bleibt bewusst stehen (kein Auto-Ausblenden), siehe
   * CLAUDE.md Punkt 16.
   */
  reuseNotice?: ReuseNotice | null;
  onComplete: (edited: Product) => void;
  onBack: () => void;
  isLastProduct?: boolean;
}

const CONDITIONS = [
  { value: "new", label: "Neu" },
  { value: "used_very_good", label: "Gebraucht – Sehr gut" },
  { value: "used_good", label: "Gebraucht – Gut" },
  { value: "used_acceptable", label: "Gebraucht – Akzeptabel" },
  { value: "refurbished", label: "Generalüberholt" },
  { value: "defective", label: "Defekt" },
];

const ConfidenceBadge: React.FC<{ value: number }> = ({ value }) => {
  if (value >= 0.8) return <Badge variant="success" size="sm">Sicher</Badge>;
  if (value >= 0.5) return <Badge variant="warning" size="sm">Unsicher</Badge>;
  return <Badge variant="danger" size="sm">Geschätzt</Badge>;
};

const StepReview: React.FC<StepReviewProps> = ({ product, onComplete, onBack, isLastProduct = true, reuseNotice = null }) => {
  const [name, setName] = useState(product.identification?.name || "");
  const [brand, setBrand] = useState(product.identification?.brand || "");
  const [category, setCategory] = useState(product.identification?.category || "");
  const [ean, setEan] = useState(
    (Array.isArray(product.details?.identifiers?.ean)
      ? product.details?.identifiers?.ean?.[0]
      : product.details?.identifiers?.ean) ||
    product.identification?.barcodes?.[0] || ""
  );
  const [condition, setCondition] = useState(
    product.details?.attributes?.condition as string || "new"
  );
  const [description, setDescription] = useState(
    product.details?.short_description || ""
  );

  const confidence = product.identification?.confidence ?? 0.5;

  const heroImage = useMemo(() => {
    const images = product.details?.images;
    if (!images?.length) return null;
    const first = images[0];
    return typeof first === "string" ? first : (first as any)?.url || (first as any)?.url_or_base64 || null;
  }, [product]);

  const handleSubmit = () => {
    const edited: Product = {
      ...product,
      identification: {
        ...product.identification,
        name: name.trim() || product.identification.name,
        brand: brand.trim(),
        category: category.trim(),
        barcodes: ean.trim() ? [ean.trim()] : product.identification.barcodes,
      },
      details: {
        ...product.details,
        short_description: description,
        identifiers: {
          ...product.details?.identifiers,
          ean: ean.trim() || (product.details?.identifiers?.ean as string) || "",
        },
        attributes: {
          ...product.details?.attributes,
          condition,
        },
      },
    };
    onComplete(edited);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-txt-primary">Ergebnisse prüfen</h2>
          <p className="text-sm text-txt-muted mt-0.5">
            Überprüfe und korrigiere die KI-erkannten Daten.
          </p>
        </div>
        <ConfidenceBadge value={confidence} />
      </div>

      {reuseNotice && (
        <div
          className="rounded-xl border border-warning/40 bg-warning/10 px-4 py-3"
          role="status"
        >
          <p className="text-sm font-semibold text-txt-primary">{reuseNotice.title}</p>
          <p className="text-sm text-txt-muted mt-0.5">{reuseNotice.detail}</p>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-[200px_1fr] gap-6">
        {/* Hero image */}
        <div>
          {heroImage ? (
            <div className="aspect-square rounded-xl overflow-hidden border border-app-border bg-app-elevated">
              <img src={heroImage} alt={name} className="w-full h-full object-cover" />
            </div>
          ) : (
            <div className="aspect-square rounded-xl border border-app-border bg-app-elevated flex items-center justify-center">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-txt-muted">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <path d="m21 15-5-5L5 21" />
              </svg>
            </div>
          )}
          {product.details?.images?.length > 1 && (
            <p className="text-xs text-txt-muted text-center mt-2">
              +{product.details.images.length - 1} weitere Bilder
            </p>
          )}
        </div>

        {/* Form */}
        <Card padding="md">
          <div className="space-y-4">
            <div>
              <div className="flex items-center gap-2 mb-1.5">
                <label className="text-xs font-medium text-txt-muted">Produktname</label>
                {confidence < 0.8 && <Badge variant="warning" size="sm">Prüfen</Badge>}
              </div>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full h-10 px-3 text-sm rounded-xl bg-app-elevated border border-app-border text-txt-primary placeholder:text-txt-muted focus:outline-none focus:ring-1 focus:ring-accent focus:border-accent"
                placeholder="z.B. Apple iPhone 14 Pro 128GB Space Black"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <Input
                label="Marke"
                value={brand}
                onChange={(e) => setBrand(e.target.value)}
                placeholder="z.B. Apple"
              />
              <Input
                label="Kategorie"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="z.B. Smartphones"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <Input
                label="EAN / Barcode"
                value={ean}
                onChange={(e) => setEan(e.target.value)}
                placeholder="z.B. 4006381333931"
                helpText={ean.length === 13 ? "Gültige EAN-13" : ean.length > 0 ? `${ean.length} Stellen` : undefined}
              />
              <div className="space-y-1.5">
                <label className="block text-xs font-medium uppercase tracking-wide text-txt-muted">
                  Zustand
                </label>
                <select
                  value={condition}
                  onChange={(e) => setCondition(e.target.value)}
                  className="w-full h-10 px-3 text-sm rounded-xl bg-app-elevated border border-app-border text-txt-primary focus:outline-none focus:ring-1 focus:ring-accent focus:border-accent"
                >
                  {CONDITIONS.map((c) => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium uppercase tracking-wide text-txt-muted mb-1.5">
                Beschreibung
              </label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={4}
                className="w-full px-3 py-2 text-sm rounded-xl bg-app-elevated border border-app-border text-txt-primary placeholder:text-txt-muted focus:outline-none focus:ring-1 focus:ring-accent focus:border-accent resize-y"
                placeholder="Produktbeschreibung…"
              />
            </div>

            {/* Key features preview */}
            {product.details?.key_features?.length > 0 && (
              <div>
                <label className="block text-xs font-medium uppercase tracking-wide text-txt-muted mb-1.5">
                  Erkannte Merkmale
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {product.details.key_features.map((feat, i) => (
                    <span
                      key={i}
                      className="px-2 py-0.5 text-xs rounded-lg bg-app-elevated border border-app-border text-txt-secondary"
                    >
                      {feat}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </Card>
      </div>

      {/* Actions */}
      <div className="flex justify-between">
        <Button variant="secondary" onClick={onBack}>Zurück</Button>
        <Button
          onClick={handleSubmit}
          disabled={!name.trim()}
          iconRight={
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M5 12h14M12 5l7 7-7 7" />
            </svg>
          }
        >
          {isLastProduct ? "Weiter zur Zusammenfassung" : "Nächstes Produkt"}
        </Button>
      </div>
    </div>
  );
};

export default StepReview;

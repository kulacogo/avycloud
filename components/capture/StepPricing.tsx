import React, { useState, useMemo } from "react";
import { Product } from "../../types";
import { Card } from "../ui/Card";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Badge } from "../ui/Badge";

interface StepPricingProps {
  product: Product;
  onComplete: (updated: Product) => void;
  onBack: () => void;
}

const StepPricing: React.FC<StepPricingProps> = ({ product, onComplete, onBack }) => {
  const pricing = product.details?.pricing;

  const [sellPrice, setSellPrice] = useState<string>(
    pricing?.sellPrice?.toString() || pricing?.suggestedPrice?.toString() || ""
  );
  const [buyPrice, setBuyPrice] = useState<string>(
    pricing?.buyPrice?.toString() || ""
  );
  const [quantity, setQuantity] = useState<string>("1");
  const [bin, setBin] = useState<string>(
    product.storageBins?.[0]?.code || product.storage?.binCode || ""
  );

  const suggestedPrice = pricing?.suggestedPrice || pricing?.lowest_price?.amount || null;
  const priceSource = pricing?.pricingMatchBasis || (pricing?.lowest_price?.sources?.[0]?.name ? `${pricing.lowest_price.sources[0].name}` : null);

  const margin = useMemo(() => {
    const sell = parseFloat(sellPrice);
    const buy = parseFloat(buyPrice);
    if (!isFinite(sell) || !isFinite(buy) || buy === 0) return null;
    const abs = sell - buy;
    const pct = ((abs / buy) * 100).toFixed(1);
    return { abs: abs.toFixed(2), pct, positive: abs > 0 };
  }, [sellPrice, buyPrice]);

  const handleSubmit = () => {
    const sell = parseFloat(sellPrice) || undefined;
    const buy = parseFloat(buyPrice) || undefined;
    const qty = parseInt(quantity, 10) || 1;

    const updated: Product = {
      ...product,
      details: {
        ...product.details,
        pricing: {
          ...product.details?.pricing,
          sellPrice: sell,
          buyPrice: buy,
        },
      },
      ops: {
        ...product.ops,
        pending_intake_quantity: qty,
      },
      storage: bin.trim()
        ? {
            zone: product.storage?.zone ?? "M",
            etage: product.storage?.etage ?? "EG",
            gang: product.storage?.gang ?? 0,
            regal: product.storage?.regal ?? 0,
            ebene: product.storage?.ebene ?? "",
            quantity: product.storage?.quantity ?? qty,
            ...product.storage,
            binCode: bin.trim(),
            assigned_at: new Date().toISOString(),
          }
        : product.storage || null,
    };
    onComplete(updated);
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-txt-primary">Preis & Lager</h2>
        <p className="text-sm text-txt-muted mt-0.5">
          Lege Verkaufspreis, Einkaufspreis und Lagerplatz fest.
        </p>
      </div>

      {/* KI price suggestion */}
      {suggestedPrice && (
        <Card padding="sm" className="border-accent/30 bg-accent/5">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-txt-primary">KI-Preisvorschlag</p>
              <p className="text-2xl font-bold text-accent mt-0.5">
                {suggestedPrice.toFixed(2)} €
              </p>
              {priceSource && (
                <p className="text-xs text-txt-muted mt-0.5">Quelle: {priceSource}</p>
              )}
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setSellPrice(suggestedPrice.toFixed(2))}
            >
              Übernehmen
            </Button>
          </div>
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Pricing card */}
        <Card padding="md">
          <h3 className="text-sm font-medium text-txt-primary mb-4">Preise</h3>
          <div className="space-y-4">
            <Input
              label="Verkaufspreis (€)"
              type="number"
              value={sellPrice}
              onChange={(e) => setSellPrice(e.target.value)}
              placeholder="0.00"
              inputSize="lg"
            />
            <Input
              label="Einkaufspreis (€)"
              type="number"
              value={buyPrice}
              onChange={(e) => setBuyPrice(e.target.value)}
              placeholder="0.00"
              helpText="Optional — wird für die Margenberechnung verwendet"
            />

            {/* Margin display */}
            {margin && (
              <div className={`flex items-center gap-2 px-3 py-2 rounded-lg ${margin.positive ? "bg-success/10" : "bg-danger/10"}`}>
                <span className={`text-sm font-medium ${margin.positive ? "text-success" : "text-danger"}`}>
                  Marge: {margin.abs} € ({margin.pct}%)
                </span>
              </div>
            )}
          </div>
        </Card>

        {/* Stock card */}
        <Card padding="md">
          <h3 className="text-sm font-medium text-txt-primary mb-4">Lager</h3>
          <div className="space-y-4">
            <Input
              label="Menge"
              type="number"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              placeholder="1"
              inputSize="lg"
            />
            <Input
              label="Lagerplatz / Bin"
              value={bin}
              onChange={(e) => setBin(e.target.value)}
              placeholder="z.B. A-01-03"
              helpText="Optional — kann auch später zugewiesen werden"
            />
          </div>
        </Card>
      </div>

      {/* Competitor prices preview */}
      {pricing?.competitorPrices && pricing.competitorPrices.length > 0 && (
        <Card padding="sm">
          <h3 className="text-sm font-medium text-txt-primary mb-3">Wettbewerbspreise</h3>
          <div className="space-y-1.5">
            {pricing.competitorPrices.slice(0, 5).map((c, i) => (
              <div key={i} className="flex items-center justify-between text-sm">
                <span className="text-txt-secondary truncate flex-1">{c.title}</span>
                <div className="flex items-center gap-2 ml-3">
                  <Badge variant="neutral" size="sm">{c.marketplace}</Badge>
                  <span className="font-medium text-txt-primary">{c.price.toFixed(2)} €</span>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Actions */}
      <div className="flex justify-between">
        <Button variant="secondary" onClick={onBack}>Zurück</Button>
        <Button
          onClick={handleSubmit}
          iconRight={
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M5 12h14M12 5l7 7-7 7" />
            </svg>
          }
        >
          Weiter zur Zusammenfassung
        </Button>
      </div>
    </div>
  );
};

export default StepPricing;

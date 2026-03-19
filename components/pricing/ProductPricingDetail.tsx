import React, { useState, useCallback } from "react";
import { usePricingSuggestion } from "../../hooks/usePricingSuggestion";
import CompetitorPrices from "../CompetitorPrices";
import CompetitorPriceChart from "../CompetitorPriceChart";
import PricingRuleForm, { PricingRuleFormData } from "./PricingRuleForm";
import { createPricingRule, saveProduct } from "../../api/client";
import { CompetitorListing } from "../../types";

interface ProductPricingDetailProps {
  productId: string;
  sellPrice?: number;
  buyPrice?: number;
  suggestedPrice?: number;
  pricingTier?: number | null;
  pricingConfidence?: number;
  pricingMatchBasis?: string | null;
  ean?: string;
  competitorPrices?: CompetitorListing[];
  lastPriceCheck?: string;
  onPriceUpdated?: () => void;
}

const fmt = (amount: number) =>
  new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(amount);

const confidenceLabel = (c: number): { text: string; cls: string } => {
  if (c >= 0.8) return { text: "Hoch", cls: "text-success bg-success-dim" };
  if (c >= 0.5) return { text: "Mittel", cls: "text-warning bg-warning-dim" };
  return { text: "Niedrig", cls: "text-danger bg-danger-dim" };
};

const tierLabel = (tier: number | null | undefined) => {
  if (tier === 1) return "Tier 1 (EAN-Match)";
  if (tier === 2) return "Tier 2 (Kategorie)";
  if (tier === 0) return "Tier 0 (Kosten)";
  return "Unbekannt";
};

const ProductPricingDetail: React.FC<ProductPricingDetailProps> = ({
  productId,
  sellPrice,
  buyPrice,
  suggestedPrice: storedSuggested,
  pricingTier: storedTier,
  pricingConfidence: storedConfidence,
  pricingMatchBasis: storedMatchBasis,
  ean,
  competitorPrices,
  lastPriceCheck,
  onPriceUpdated,
}) => {
  const { suggestion, loading, error, fetchSuggestion } = usePricingSuggestion();
  const [accepting, setAccepting] = useState(false);
  const [showRuleForm, setShowRuleForm] = useState(false);

  // Use fresh suggestion if available, otherwise stored data
  const displaySuggested = suggestion?.suggestedPrice ?? storedSuggested ?? null;
  const displayTier = suggestion?.pricingTier ?? storedTier ?? null;
  const displayConfidence = suggestion?.confidence ?? storedConfidence ?? 0;
  const displayMatchBasis = suggestion?.matchBasis ?? storedMatchBasis ?? null;
  const displayMargin = suggestion?.margin ?? null;

  const currentSell = sellPrice ?? 0;
  const currentBuy = buyPrice ?? 0;
  const ownMargin = currentBuy > 0 && currentSell > 0
    ? ((currentSell - currentBuy) / currentBuy) * 100
    : null;

  const handleFetchSuggestion = useCallback(async () => {
    await fetchSuggestion(productId);
  }, [fetchSuggestion, productId]);

  const handleAccept = useCallback(async () => {
    if (!displaySuggested) return;
    setAccepting(true);
    try {
      await saveProduct({
        id: productId,
        details: {
          pricing: {
            sellPrice: displaySuggested,
          },
        },
      } as any);
      onPriceUpdated?.();
    } catch {
      // error handled upstream
    } finally {
      setAccepting(false);
    }
  }, [displaySuggested, productId, onPriceUpdated]);

  const handleCreateRule = useCallback(
    async (data: PricingRuleFormData) => {
      await createPricingRule({
        productId: data.productId,
        ruleType: data.ruleType,
        params: data.params,
      });
      setShowRuleForm(false);
    },
    []
  );

  return (
    <div className="space-y-5">
      {/* Price comparison cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {/* Current sell price */}
        <div className="bg-app-surface border border-app-border rounded-md px-4 py-3">
          <p className="text-xs text-txt-muted uppercase tracking-wider">Verkaufspreis</p>
          <p className="text-xl font-bold text-txt-primary mt-1">
            {currentSell > 0 ? fmt(currentSell) : "--"}
          </p>
          {ownMargin != null && (
            <p className={`text-xs mt-0.5 ${ownMargin >= 0 ? "text-success" : "text-danger"}`}>
              Marge: {ownMargin.toFixed(1)}%
            </p>
          )}
        </div>

        {/* Buy price */}
        <div className="bg-app-surface border border-app-border rounded-md px-4 py-3">
          <p className="text-xs text-txt-muted uppercase tracking-wider">Einkaufspreis</p>
          <p className="text-xl font-bold text-txt-primary mt-1">
            {currentBuy > 0 ? fmt(currentBuy) : "--"}
          </p>
          {currentBuy <= 0 && (
            <p className="text-xs text-warning mt-0.5">Einkaufspreis fehlt</p>
          )}
        </div>

        {/* Suggested price */}
        <div className="bg-app-surface border border-app-border rounded-md px-4 py-3">
          <p className="text-xs text-txt-muted uppercase tracking-wider">Vorschlag</p>
          <p className="text-xl font-bold text-accent mt-1">
            {displaySuggested != null ? fmt(displaySuggested) : "--"}
          </p>
          {displayConfidence > 0 && (
            <div className="flex items-center gap-1.5 mt-0.5">
              <span
                className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${
                  confidenceLabel(displayConfidence).cls
                }`}
              >
                {confidenceLabel(displayConfidence).text}
              </span>
              <span className="text-[10px] text-txt-muted">{tierLabel(displayTier)}</span>
            </div>
          )}
        </div>
      </div>

      {/* Match basis */}
      {displayMatchBasis && (
        <div className="text-xs text-txt-secondary bg-app-elevated/50 px-3 py-2 rounded-md">
          {displayMatchBasis}
        </div>
      )}

      {/* Suggested margin display */}
      {displayMargin != null && currentBuy > 0 && (
        <div className="text-xs text-txt-secondary">
          Vorgeschlagene Marge:{" "}
          <span className={displayMargin >= 0 ? "text-success font-medium" : "text-danger font-medium"}>
            {displayMargin.toFixed(1)}%
          </span>
        </div>
      )}

      {/* Action buttons */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={handleFetchSuggestion}
          disabled={loading}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md
            bg-app-elevated text-txt-secondary hover:text-txt-primary hover:bg-app-bg transition-colors
            disabled:opacity-50"
        >
          {loading ? (
            <>
              <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Berechne...
            </>
          ) : (
            "Preis berechnen"
          )}
        </button>

        {displaySuggested != null && (
          <button
            onClick={handleAccept}
            disabled={accepting}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md
              bg-success-dim text-success hover:bg-success/25 transition-colors disabled:opacity-50"
          >
            {accepting ? "..." : "Vorschlag übernehmen"}
          </button>
        )}

        <button
          onClick={() => setShowRuleForm(true)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md
            bg-accent-dim text-accent hover:bg-accent/25 transition-colors"
        >
          Preisregel erstellen
        </button>
      </div>

      {error && (
        <div className="text-sm text-danger px-3 py-2 bg-danger-dim rounded-md">{error}</div>
      )}

      {/* Competitor prices (existing component) */}
      {ean && (
        <CompetitorPrices
          ean={ean}
          ownPrice={currentSell}
          storedPrices={competitorPrices}
          lastPriceCheck={lastPriceCheck}
        />
      )}

      {/* Competitor price chart (existing component) */}
      <CompetitorPriceChart productId={productId} />

      {/* Rule creation form */}
      {showRuleForm && (
        <PricingRuleForm
          initial={{ productId, ruleType: "competitor_median", active: true }}
          productName={productId}
          onSave={handleCreateRule}
          onCancel={() => setShowRuleForm(false)}
        />
      )}
    </div>
  );
};

export default ProductPricingDetail;

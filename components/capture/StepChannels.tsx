import React, { useEffect, useState, useCallback } from "react";
import { Product } from "../../types";
import { Card } from "../ui/Card";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Badge } from "../ui/Badge";
import { useListingPipeline } from "../../hooks/useListingPipeline";
import type { ChannelListing } from "../../api/client";

interface StepChannelsProps {
  product: Product;
  onComplete: (product: Product, listings: Record<string, ChannelListing>) => void;
  onBack: () => void;
}

interface ChannelState {
  enabled: boolean;
  listing: ChannelListing | null;
}

const CHANNEL_INFO: Record<string, { label: string; titleMax: number }> = {
  ebay: { label: "eBay", titleMax: 80 },
  kaufland: { label: "Kaufland", titleMax: 150 },
};

const Spinner: React.FC = () => (
  <svg
    className="animate-spin h-5 w-5 text-accent"
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden="true"
  >
    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
    <path
      className="opacity-75"
      fill="currentColor"
      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
    />
  </svg>
);

const ChannelCard: React.FC<{
  channel: string;
  state: ChannelState;
  onToggle: () => void;
  onTitleChange: (val: string) => void;
  onDescriptionChange: (val: string) => void;
  loading: boolean;
}> = ({ channel, state, onToggle, onTitleChange, onDescriptionChange, loading }) => {
  const info = CHANNEL_INFO[channel];
  if (!info) return null;

  const listing = state.listing;
  const validation = listing?.validation;
  const validationVariant = !validation
    ? "neutral"
    : validation.ready
      ? "success"
      : validation.issues.some((i) => i.severity === "error")
        ? "danger"
        : "warning";

  const validationLabel = !validation
    ? "Ausstehend"
    : validation.ready
      ? "Bereit"
      : "Probleme";

  return (
    <Card
      variant="surface"
      padding="md"
      className={!state.enabled ? "opacity-50" : undefined}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold text-txt-primary">{info.label}</span>
          <Badge variant={state.enabled ? validationVariant : "neutral"} size="sm">
            {state.enabled ? validationLabel : "Deaktiviert"}
          </Badge>
        </div>
        <label className="relative inline-flex items-center cursor-pointer">
          <input
            type="checkbox"
            checked={state.enabled}
            onChange={onToggle}
            className="sr-only peer"
          />
          <div className="w-9 h-5 bg-app-elevated peer-focus:ring-2 peer-focus:ring-accent rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-txt-muted after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-accent peer-checked:after:bg-white" />
        </label>
      </div>

      {loading && state.enabled && (
        <div className="flex items-center gap-2 py-6 justify-center text-txt-secondary text-sm">
          <Spinner />
          <span>KI optimiert Listings...</span>
        </div>
      )}

      {!loading && state.enabled && listing && (
        <div className="space-y-4">
          {/* Title */}
          <div>
            <Input
              label={`${info.label}-Titel`}
              value={listing.title}
              onChange={(e) => onTitleChange(e.target.value)}
              maxLength={info.titleMax}
            />
            <span className="text-xs text-txt-muted mt-1 block">
              {listing.title.length}/{info.titleMax} Zeichen
            </span>
          </div>

          {/* Description */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium uppercase tracking-wide text-txt-muted">
              {info.label}-Beschreibung
            </label>
            <textarea
              value={listing.description}
              onChange={(e) => onDescriptionChange(e.target.value)}
              rows={4}
              className="w-full rounded-sm bg-app-elevated border border-app-border text-txt-primary text-sm p-3 resize-y focus:outline-none focus:ring-1 focus:ring-accent focus:border-accent"
            />
          </div>

          {/* Category */}
          {listing.categoryName && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-txt-muted">Kategorie:</span>
              <span className="text-xs text-txt-secondary">{listing.categoryName}</span>
            </div>
          )}

          {/* Validation Issues */}
          {validation && validation.issues.length > 0 && (
            <div className="space-y-1 pt-2 border-t border-app-border">
              {validation.issues.map((issue, idx) => (
                <div
                  key={idx}
                  className={`text-xs ${issue.severity === "error" ? "text-danger" : "text-warning"}`}
                >
                  {issue.severity === "error" ? "\u2718" : "\u26A0"} {issue.message}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {!loading && state.enabled && !listing && (
        <p className="text-sm text-txt-muted py-4 text-center">
          Keine Listing-Daten verfügbar. Klicke "Erneut generieren".
        </p>
      )}
    </Card>
  );
};

const StepChannels: React.FC<StepChannelsProps> = ({ product, onComplete, onBack }) => {
  const pipeline = useListingPipeline();
  const [channels, setChannels] = useState<Record<string, ChannelState>>({
    ebay: { enabled: true, listing: null },
    kaufland: { enabled: true, listing: null },
  });
  const [generated, setGenerated] = useState(false);

  // Auto-generate on mount
  useEffect(() => {
    if (!generated && product.id) {
      setGenerated(true);
      pipeline.generate(product.id).then((res) => {
        if (res?.listings) {
          setChannels((prev) => ({
            ebay: { ...prev.ebay, listing: res.listings.ebay || null },
            kaufland: { ...prev.kaufland, listing: res.listings.kaufland || null },
          }));
        }
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product.id]);

  const handleToggle = useCallback((ch: string) => {
    setChannels((prev) => ({
      ...prev,
      [ch]: { ...prev[ch], enabled: !prev[ch].enabled },
    }));
  }, []);

  const handleTitleChange = useCallback((ch: string, val: string) => {
    setChannels((prev) => ({
      ...prev,
      [ch]: {
        ...prev[ch],
        listing: prev[ch].listing ? { ...prev[ch].listing!, title: val } : null,
      },
    }));
  }, []);

  const handleDescriptionChange = useCallback((ch: string, val: string) => {
    setChannels((prev) => ({
      ...prev,
      [ch]: {
        ...prev[ch],
        listing: prev[ch].listing ? { ...prev[ch].listing!, description: val } : null,
      },
    }));
  }, []);

  const handleRetry = useCallback(() => {
    if (product.id) {
      pipeline.generate(product.id).then((res) => {
        if (res?.listings) {
          setChannels((prev) => ({
            ebay: { ...prev.ebay, listing: res.listings.ebay || prev.ebay.listing },
            kaufland: { ...prev.kaufland, listing: res.listings.kaufland || prev.kaufland.listing },
          }));
        }
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product.id]);

  const handleContinue = () => {
    const listings: Record<string, ChannelListing> = {};
    for (const [ch, state] of Object.entries(channels)) {
      if (state.enabled && state.listing) {
        listings[ch] = state.listing;
      }
    }

    // Attach marketplace_listings to product
    const updated: Product = {
      ...product,
      marketplace_listings: {
        ...listings,
        generated_at: new Date().toISOString(),
      },
    } as Product;

    onComplete(updated, listings);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-txt-primary">Marktplatz-Optimierung</h2>
          <p className="text-sm text-txt-muted mt-0.5">
            Die KI hat optimierte Listings für jeden Marktplatz erstellt. Prüfe und bearbeite die Texte.
          </p>
        </div>
        {pipeline.error && (
          <Button variant="secondary" size="sm" onClick={handleRetry} loading={pipeline.loading}>
            Erneut generieren
          </Button>
        )}
      </div>

      {pipeline.error && (
        <div className="bg-danger-dim text-danger text-sm rounded-md p-3">
          {pipeline.error}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {Object.keys(CHANNEL_INFO).map((ch) => (
          <ChannelCard
            key={ch}
            channel={ch}
            state={channels[ch]}
            onToggle={() => handleToggle(ch)}
            onTitleChange={(val) => handleTitleChange(ch, val)}
            onDescriptionChange={(val) => handleDescriptionChange(ch, val)}
            loading={pipeline.loading}
          />
        ))}
      </div>

      <div className="flex justify-between pt-4">
        <Button variant="secondary" onClick={onBack}>
          Zurück
        </Button>
        <Button onClick={handleContinue} disabled={pipeline.loading}>
          Weiter
        </Button>
      </div>
    </div>
  );
};

export default StepChannels;

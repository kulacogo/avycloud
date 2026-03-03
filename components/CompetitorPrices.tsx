import React, { useEffect, useState, useCallback } from 'react';
import { CompetitorListing, CompetitorPricesResponse } from '../types';
import { fetchCompetitorPrices } from '../api/client';

interface CompetitorPricesProps {
  ean: string;
  ownPrice?: number;
  /** Pre-loaded competitor prices from Firestore (set by background runner) */
  storedPrices?: CompetitorListing[];
  /** ISO timestamp of when stored prices were last fetched */
  lastPriceCheck?: string;
}

const fmt = (amount: number) =>
  new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(amount);

const timeAgo = (iso: string) => {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'gerade eben';
  if (mins < 60) return `vor ${mins} Min.`;
  const hrs = Math.floor(mins / 60);
  return `vor ${hrs} Std.`;
};

const PriceBadge: React.FC<{ price: number; ownPrice?: number }> = ({ price, ownPrice }) => {
  if (ownPrice == null || ownPrice <= 0) {
    return <span className="font-semibold text-white">{fmt(price)}</span>;
  }
  const diff = price - ownPrice;
  const pct = ((diff / ownPrice) * 100).toFixed(0);
  if (Math.abs(diff) < 0.5) {
    return (
      <span className="font-semibold text-slate-200" title={`Gleicher Preis wie du (${fmt(ownPrice)})`}>
        {fmt(price)}
      </span>
    );
  }
  if (diff > 0) {
    return (
      <span className="font-semibold text-emerald-400" title={`${fmt(diff)} teurer als du (${fmt(ownPrice)})`}>
        {fmt(price)} <span className="text-xs font-normal text-emerald-400/70">+{pct}%</span>
      </span>
    );
  }
  return (
    <span className="font-semibold text-rose-400" title={`${fmt(Math.abs(diff))} günstiger als du (${fmt(ownPrice)})`}>
      {fmt(price)} <span className="text-xs font-normal text-rose-400/70">{pct}%</span>
    </span>
  );
};

const MarketplaceIcon: React.FC<{ marketplace: 'ebay' | 'kaufland' }> = ({ marketplace }) => {
  if (marketplace === 'ebay') {
    return (
      <span className="inline-flex items-center justify-center w-5 h-5 rounded bg-[#e53238]/20 text-[#e53238] text-[10px] font-bold leading-none">
        eB
      </span>
    );
  }
  return (
    <span className="inline-flex items-center justify-center w-5 h-5 rounded bg-[#e10915]/20 text-[#e10915] text-[10px] font-bold leading-none">
      KL
    </span>
  );
};

const ListingRow: React.FC<{ listing: CompetitorListing; ownPrice?: number }> = ({ listing, ownPrice }) => (
  <div className="flex items-center justify-between gap-3 px-3 py-2 bg-slate-900/50 rounded-lg">
    <div className="flex items-center gap-2.5 min-w-0">
      <MarketplaceIcon marketplace={listing.marketplace} />
      <div className="min-w-0">
        {listing.url ? (
          <a
            href={listing.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-sky-400 hover:underline truncate block max-w-[240px]"
            title={listing.title}
          >
            {listing.seller || listing.title || 'Angebot'}
          </a>
        ) : (
          <span className="text-sm text-slate-300 truncate block max-w-[240px]" title={listing.title}>
            {listing.seller || listing.title || 'Angebot'}
          </span>
        )}
        {listing.shippingCost != null && listing.shippingCost > 0 && (
          <span className="text-[11px] text-slate-500">+ {fmt(listing.shippingCost)} Versand</span>
        )}
      </div>
    </div>
    <PriceBadge price={listing.price} ownPrice={ownPrice} />
  </div>
);

const CompetitorPrices: React.FC<CompetitorPricesProps> = ({ ean, ownPrice, storedPrices, lastPriceCheck }) => {
  // Build initial data from Firestore-stored prices if available (avoids API call on mount)
  const storedData: CompetitorPricesResponse | null =
    storedPrices && storedPrices.length > 0
      ? {
          ebay: storedPrices.filter((p) => p.marketplace === 'ebay'),
          kaufland: storedPrices.filter((p) => p.marketplace === 'kaufland'),
          cached: true,
          fetched_at: lastPriceCheck || new Date().toISOString(),
        }
      : null;

  const [data, setData] = useState<CompetitorPricesResponse | null>(storedData);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!ean) return;
    setLoading(true);
    setError(null);
    try {
      const result = await fetchCompetitorPrices(ean);
      setData(result);
    } catch (err: any) {
      setError(err?.message || 'Fehler beim Laden der Konkurrenzpreise');
    } finally {
      setLoading(false);
    }
  }, [ean]);

  // Only auto-fetch on mount if no stored data available
  useEffect(() => {
    if (!storedData) {
      load();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const totalListings = (data?.ebay?.length || 0) + (data?.kaufland?.length || 0);
  const allListings = [
    ...(data?.ebay || []),
    ...(data?.kaufland || []),
  ].sort((a, b) => a.price - b.price);

  // Find cheapest competitor
  const cheapest = allListings.length > 0 ? allListings[0] : null;

  return (
    <div className="space-y-3">
      {/* Header with refresh button */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h4 className="text-sm font-semibold text-slate-300">Konkurrenzpreise</h4>
          {data && !loading && (
            <span className="text-[11px] text-slate-500">
              {totalListings} Angebot{totalListings !== 1 ? 'e' : ''}
              {data.cached && ' (Cache)'}
            </span>
          )}
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-lg
            bg-slate-700/50 text-slate-300 hover:bg-slate-700 hover:text-white
            disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          title="Konkurrenzpreise aktualisieren"
        >
          <svg
            className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0011.664 0l3.181-3.183"
            />
          </svg>
          Aktualisieren
        </button>
      </div>

      {/* Summary bar */}
      {cheapest && ownPrice != null && ownPrice > 0 && !loading && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-800/60 border border-white/5">
          <span className="text-xs text-slate-400">Günstigster Konkurrent:</span>
          <PriceBadge price={cheapest.price} ownPrice={ownPrice} />
          <span className="text-xs text-slate-500">
            ({cheapest.marketplace === 'ebay' ? 'eBay' : 'Kaufland'})
          </span>
        </div>
      )}

      {/* Loading state */}
      {loading && !data && (
        <div className="flex items-center justify-center py-6">
          <svg className="w-5 h-5 animate-spin text-slate-500" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
          <span className="ml-2 text-sm text-slate-500">Lade Konkurrenzpreise...</span>
        </div>
      )}

      {/* Error state */}
      {error && !loading && (
        <div className="text-sm text-rose-400 px-3 py-2 bg-rose-500/10 rounded-lg">
          {error}
        </div>
      )}

      {/* Empty state */}
      {data && totalListings === 0 && !loading && !error && (
        <div className="text-sm text-slate-500 px-3 py-4 text-center">
          Keine Konkurrenzangebote für diese EAN gefunden.
        </div>
      )}

      {/* Listings grouped by marketplace */}
      {data && totalListings > 0 && !loading && (
        <div className="space-y-2">
          {/* eBay section */}
          {(data.ebay?.length || 0) > 0 && (
            <div>
              <div className="flex items-center gap-1.5 mb-1.5">
                <MarketplaceIcon marketplace="ebay" />
                <span className="text-xs font-medium text-slate-400">
                  eBay ({data.ebay.length})
                </span>
              </div>
              <div className="space-y-1">
                {data.ebay.slice(0, 8).map((listing, i) => (
                  <ListingRow key={`ebay-${i}`} listing={listing} ownPrice={ownPrice} />
                ))}
                {data.ebay.length > 8 && (
                  <p className="text-[11px] text-slate-500 pl-3">
                    + {data.ebay.length - 8} weitere Angebote
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Kaufland section */}
          {(data.kaufland?.length || 0) > 0 && (
            <div>
              <div className="flex items-center gap-1.5 mb-1.5">
                <MarketplaceIcon marketplace="kaufland" />
                <span className="text-xs font-medium text-slate-400">
                  Kaufland ({data.kaufland.length})
                </span>
              </div>
              <div className="space-y-1">
                {data.kaufland.slice(0, 8).map((listing, i) => (
                  <ListingRow key={`kl-${i}`} listing={listing} ownPrice={ownPrice} />
                ))}
                {data.kaufland.length > 8 && (
                  <p className="text-[11px] text-slate-500 pl-3">
                    + {data.kaufland.length - 8} weitere Angebote
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Timestamp */}
      {(data?.fetched_at || lastPriceCheck) && !loading && (
        <p className="text-right text-[11px] text-slate-600">
          Zuletzt geprüft: {timeAgo(data?.fetched_at || lastPriceCheck || '')}
          {data?.cached && !loading && <span className="ml-1 text-slate-700">· gespeichert</span>}
        </p>
      )}
    </div>
  );
};

export default CompetitorPrices;

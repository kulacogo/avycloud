
import React from 'react';
import { Pricing } from '../types';
import { LinkIcon } from './icons/Icons';

interface PricingInfoProps {
  pricing?: Pricing;
  isEditing?: boolean;
  onChange?: (next: Pricing) => void;
}

/**
 * Preis-Panel im Produktdatenblatt.
 *
 * WICHTIG (Incident 2026-07-10): Der Hauptwert ist der VERKAUFSPREIS
 * (pricing.sellPrice — das Feld, das eBay/Kaufland syncen und das die
 * Produkttabelle als "Preis" zeigt). Der recherchierte Marktpreis
 * (pricing.lowest_price) ist nur Referenz mit Quellen. Vorher zeigte dieses
 * Panel lowest_price als "Selling price" an UND schrieb Edits dorthin —
 * dadurch wichen Tabelle (18,89 €) und Datenblatt (14,38 €) voneinander ab.
 */
const PricingInfo: React.FC<PricingInfoProps> = ({ pricing, isEditing = false, onChange }) => {
  const safePricing: Pricing = pricing || {
    lowest_price: { amount: 0, currency: 'EUR', sources: [], last_checked_iso: undefined as any },
    price_confidence: 0,
  };
  const { lowest_price, price_confidence, sellPrice } = safePricing;
  // Bekannt-kaputte Quellen-URLs in Bestandsdaten: nie als Link rendern.
  const BROKEN_EVIDENCE_URL = /^https?:\/\/(encrypted-tbn\d*\.gstatic\.com|(www\.)?example\.com)\//i;
  const linkSources = (lowest_price?.sources || []).filter(
    (source) => source && typeof source.url === 'string' && /^https?:\/\//i.test(source.url) && !BROKEN_EVIDENCE_URL.test(source.url)
  );
  const nonLinkSources = (lowest_price?.sources || []).filter(
    (source) => source && typeof source.url === 'string' && source.url.trim()
      && (!/^https?:\/\//i.test(source.url) || BROKEN_EVIDENCE_URL.test(source.url))
  );

  function safeCurrency(code?: string) {
    const c = (code || '').toString().trim().toUpperCase();
    if (/^[A-Z]{3}$/.test(c)) return c;
    return 'EUR';
  }
  const fmt = (v: number, currency?: string) =>
    new Intl.NumberFormat('de-DE', { style: 'currency', currency: safeCurrency(currency) }).format(v);

  const setSellPrice = (val: string) => {
    if (!onChange) return;
    const amount = parseFloat(val.replace(',', '.'));
    onChange({ ...safePricing, sellPrice: Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) / 100 : undefined });
  };

  const nowIso = () => new Date().toISOString();
  const setMarketAmount = (val: string) => {
    if (!onChange) return;
    const amount = parseFloat(val.replace(',', '.')) || 0;
    onChange({
      ...safePricing,
      lowest_price: {
        amount,
        currency: safeCurrency(lowest_price?.currency),
        sources: [{ name: 'Manuell', url: 'manual://ui', price: amount, checked_at: nowIso() }],
        last_checked_iso: nowIso(),
      },
    });
  };

  const marketAmount = typeof lowest_price?.amount === 'number' && lowest_price.amount > 0 ? lowest_price.amount : null;
  const hasSell = typeof sellPrice === 'number' && Number.isFinite(sellPrice) && sellPrice > 0;

  return (
    <>
      {/* Verkaufspreis — DER Preis (eBay/Kaufland-Sync, Tabellen-Spalte "Preis") */}
      <div className="flex items-baseline gap-4">
        <strong>Verkaufspreis:</strong>
        {isEditing ? (
          <input
            type="number"
            step="0.01"
            defaultValue={hasSell ? sellPrice : undefined}
            placeholder={marketAmount != null ? String(marketAmount) : '0,00'}
            onBlur={(e) => setSellPrice(e.target.value)}
            className="w-28 bg-app-elevated border border-app-border rounded px-2 py-1 text-txt-secondary"
          />
        ) : (
          <span id="price-value" className="text-3xl font-bold text-txt-primary">
            {hasSell ? fmt(sellPrice!, lowest_price?.currency) : '—'}
          </span>
        )}
        {!hasSell && !isEditing ? (
          <span className="text-xs text-warning">kein Verkaufspreis gesetzt</span>
        ) : null}
      </div>

      {/* Marktpreis (Recherche) — Referenz, nicht der Angebotspreis */}
      <div className="mt-2 flex items-baseline gap-3 text-sm">
        <span className="text-txt-muted">Marktpreis (niedrigster):</span>
        {isEditing ? (
          <input
            type="number"
            step="0.01"
            defaultValue={marketAmount ?? undefined}
            onBlur={(e) => setMarketAmount(e.target.value)}
            className="w-28 bg-app-elevated border border-app-border rounded px-2 py-1 text-txt-secondary"
          />
        ) : (
          <span className="font-medium text-txt-primary">{marketAmount != null ? fmt(marketAmount, lowest_price?.currency) : '—'}</span>
        )}
        {price_confidence > 0 ? (
          <span className="text-xs text-txt-muted">Konfidenz {(price_confidence * 100).toFixed(0)} %</span>
        ) : null}
      </div>

      {(nonLinkSources.length > 0 || linkSources.length > 0) && (
        <div className="mt-4">
          <h4 className="font-semibold text-txt-secondary mb-2">Quellen:</h4>
          <ul id="price-sources" className="space-y-2">
            {nonLinkSources.map((source, index) => (
              <li key={`nonlink-${index}`} className="flex items-center justify-between p-2 bg-app-elevated/50 rounded-md">
                <div className="flex items-center">
                  <LinkIcon className="w-4 h-4 text-txt-muted mr-2" />
                  <span className="text-txt-secondary">{source.name}</span>
                </div>
                <span className="font-mono text-txt-secondary">
                  {source.price ? fmt(source.price, lowest_price?.currency) : ''}
                </span>
              </li>
            ))}
            {linkSources.map((source, index) => (
              <li key={index} className="flex items-center justify-between p-2 bg-app-elevated/50 rounded-md">
                <div className="flex items-center">
                  <LinkIcon className="w-4 h-4 text-txt-muted mr-2" />
                  <a href={source.url} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
                    {source.name}
                  </a>
                </div>
                <span className="font-mono text-txt-secondary">
                  {source.price ? fmt(source.price, lowest_price?.currency) : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {lowest_price?.last_checked_iso && (
        <small id="price-checked" className="block text-right text-xs text-txt-muted mt-4">
          Zuletzt geprüft: {new Date(lowest_price.last_checked_iso).toLocaleString('de-DE')}
        </small>
      )}
    </>
  );
};

export default PricingInfo;

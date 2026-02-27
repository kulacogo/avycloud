
import React from 'react';
import { Pricing } from '../types';
import { LinkIcon } from './icons/Icons';

interface PricingInfoProps {
  pricing?: Pricing;
  isEditing?: boolean;
  onChange?: (next: Pricing) => void;
}

const PricingInfo: React.FC<PricingInfoProps> = ({ pricing, isEditing = false, onChange }) => {
  const safePricing: Pricing = pricing || {
    lowest_price: { amount: 0, currency: 'EUR', sources: [], last_checked_iso: undefined as any },
    price_confidence: 0,
  };
  const { lowest_price, price_confidence } = safePricing;
  const linkSources = (lowest_price?.sources || []).filter(
    (source) => source && typeof source.url === 'string' && /^https?:\/\//i.test(source.url)
  );
  const nonLinkSources = (lowest_price?.sources || []).filter(
    (source) => source && typeof source.url === 'string' && source.url.trim() && !/^https?:\/\//i.test(source.url)
  );
  const nowIso = () => new Date().toISOString();
  const withManualSource = (amount: number, currency: string) => ({
    amount,
    currency,
    sources: [
      {
        name: 'Manual',
        url: 'manual://ui',
        price: amount,
        checked_at: nowIso(),
      },
    ],
    last_checked_iso: nowIso(),
  });
  const setAmount = (val: string) => {
    if (!onChange) return;
    const amount = parseFloat(val) || 0;
    onChange({
      ...safePricing,
      lowest_price: withManualSource(amount, safeCurrency(lowest_price.currency)),
    });
  };
  const setCurrency = (val: string) => {
    if (!onChange) return;
    const currency = safeCurrency(val);
    const amount = typeof lowest_price.amount === 'number' && Number.isFinite(lowest_price.amount) ? lowest_price.amount : 0;
    onChange({
      ...safePricing,
      lowest_price: withManualSource(amount, currency),
    });
  };
  const setConfidence = (val: string) => onChange && onChange({ ...safePricing, price_confidence: Math.max(0, Math.min(1, parseFloat(val) || 0)) });

  function safeCurrency(code?: string) {
    const c = (code || '').toString().trim().toUpperCase();
    if (/^[A-Z]{3}$/.test(c)) return c;
    return 'EUR';
  }

  return (
    <>
      <div className="flex items-baseline space-x-4">
        <strong>Selling price:</strong>
        {isEditing ? (
          <div className="flex items-center gap-2">
            <input type="number" step="0.01" defaultValue={lowest_price.amount} onBlur={e => setAmount(e.target.value)} className="w-28 bg-slate-700 border border-white/10 rounded px-2 py-1 text-slate-200" />
            <input type="text" defaultValue={lowest_price.currency} onBlur={e => setCurrency(e.target.value.toUpperCase())} className="w-20 bg-slate-700 border border-white/10 rounded px-2 py-1 text-slate-200 uppercase" />
          </div>
        ) : (
          <span id="price-value" className="text-3xl font-bold text-sky-400">
            {lowest_price?.amount > 0
              ? new Intl.NumberFormat('de-DE', { style: 'currency', currency: safeCurrency(lowest_price.currency) }).format(lowest_price.amount)
              : 'Not Available'}
          </span>
        )}
      </div>
      <div className="mt-1">
        <span className="text-sm text-slate-400">Confidence: </span>
        {isEditing ? (
          <input type="number" step="0.01" min="0" max="1" defaultValue={price_confidence} onBlur={e => setConfidence(e.target.value)} className="w-24 bg-slate-700 border border-white/10 rounded px-2 py-1 text-slate-200" />
        ) : (
          <span className="text-sm font-medium text-white">{ (price_confidence * 100).toFixed(0) }%</span>
        )}
      </div>

      {(nonLinkSources.length > 0 || linkSources.length > 0) && (
        <div className="mt-4">
          <h4 className="font-semibold text-slate-300 mb-2">Evidence sources:</h4>
          <ul id="price-sources" className="space-y-2">
            {nonLinkSources.map((source, index) => (
              <li key={`nonlink-${index}`} className="flex items-center justify-between p-2 bg-slate-700/50 rounded-md">
                <div className="flex items-center">
                  <LinkIcon className="w-4 h-4 text-slate-500 mr-2" />
                  <span className="text-slate-200">
                    {source.name}
                  </span>
                </div>
                <span className="font-mono text-slate-300">
                  {source.price ? new Intl.NumberFormat('de-DE', { style: 'currency', currency: safeCurrency(lowest_price.currency) }).format(source.price) : ''}
                </span>
              </li>
            ))}
            {linkSources.map((source, index) => (
              <li key={index} className="flex items-center justify-between p-2 bg-slate-700/50 rounded-md">
                <div className="flex items-center">
                  <LinkIcon className="w-4 h-4 text-slate-500 mr-2" />
                  <a href={source.url} target="_blank" rel="noopener noreferrer" className="text-sky-400 hover:underline">
                    {source.name}
                  </a>
                </div>
                <span className="font-mono text-slate-300">
                  {source.price ? new Intl.NumberFormat('de-DE', { style: 'currency', currency: safeCurrency(lowest_price.currency) }).format(source.price) : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {lowest_price.last_checked_iso && (
        <small id="price-checked" className="block text-right text-xs text-slate-500 mt-4">
          Last checked: {new Date(lowest_price.last_checked_iso).toLocaleString()}
        </small>
      )}
    </>
  );
};

export default PricingInfo;

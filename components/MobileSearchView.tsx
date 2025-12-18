import React, { useEffect, useMemo, useState } from 'react';
import { Product } from '../types';
import { getProductQuantity } from '../utils/product';

interface MobileSearchViewProps {
  products: Product[];
  onSelectProduct: (productId: string) => void;
  isLoading?: boolean;
}

const MobileSearchView: React.FC<MobileSearchViewProps> = ({ products, onSelectProduct, isLoading }) => {
  const [term, setTerm] = useState('');
  const [debouncedTerm, setDebouncedTerm] = useState('');

  useEffect(() => {
    const handle = setTimeout(() => setDebouncedTerm(term), 200);
    return () => clearTimeout(handle);
  }, [term]);

  const filtered = useMemo(() => {
    const q = debouncedTerm.trim().toLowerCase();
    if (!q) return [];
    return products.filter((p) => {
      const name = (p.identification?.name || '').toLowerCase();
      const sku = (p.identification?.sku || p.details?.identifiers?.sku || '').toLowerCase();
      const ean = (p.details?.identifiers?.ean || p.details?.identifiers?.gtin || '').toLowerCase();
      const brand = (p.identification?.brand || '').toLowerCase();
      return name.includes(q) || sku.includes(q) || ean.includes(q) || brand.includes(q);
    });
  }, [products, debouncedTerm]);

  const visible = filtered.slice(0, 200);
  const showEmpty = !isLoading && products.length === 0;
  const hasQuery = debouncedTerm.trim().length > 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-white">Search</h1>
          <p className="text-slate-400 text-sm">Suche fokussiert auf Inventar</p>
        </div>
        <span className="text-xs text-slate-400">{hasQuery ? `${filtered.length} Treffer` : 'Tippe zum Suchen'}</span>
      </div>

      <div className="rounded-2xl bg-slate-800 border border-white/5 p-3">
        <input
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="Suche nach SKU, EAN, Name, Marke"
          className="w-full bg-slate-900 text-slate-100 rounded-xl px-3 py-2 text-sm focus:outline-none border border-slate-700"
        />
      </div>

      <div className="space-y-3">
        {!hasQuery && (
          <p className="text-sm text-slate-400">Gib einen Suchbegriff ein (z.B. SKU, EAN, Name, Marke), um Ergebnisse zu sehen.</p>
        )}
        {isLoading && !hasQuery && products.length === 0 && (
          <p className="text-sm text-slate-400">Lädt Produkte …</p>
        )}
        {showEmpty && <p className="text-sm text-slate-400">Keine Produkte verfügbar.</p>}

        {hasQuery && visible.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onSelectProduct(p.id)}
            className="w-full text-left rounded-2xl bg-slate-800 border border-white/5 p-3 shadow-sm shadow-black/30"
          >
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-lg bg-slate-700 overflow-hidden flex items-center justify-center">
                {p.details?.images?.[0]?.url_or_base64 ? (
                  <img src={p.details.images[0].url_or_base64} alt="" className="w-full h-full object-cover" />
                ) : (
                  <span className="text-xs text-slate-300">No Img</span>
                )}
              </div>
              <div className="flex-1">
                <p className="text-sm font-semibold text-white line-clamp-2">{p.identification?.name}</p>
                <p className="text-xs text-slate-400">
                  SKU {p.identification?.sku || '—'} · BIN {p.storage?.binCode || '—'}
                </p>
              </div>
              <div className="text-right">
                <p className="text-sm text-white">
                  {p.details?.pricing?.lowest_price?.amount ? `${p.details.pricing.lowest_price.amount.toFixed(2)} €` : '—'}
                </p>
                <p className="text-xs text-slate-400">Qty {getProductQuantity(p)}</p>
              </div>
            </div>
          </button>
        ))}

        {hasQuery && filtered.length === 0 && !isLoading && products.length > 0 && (
          <p className="text-sm text-slate-400">Keine Ergebnisse.</p>
        )}
        {hasQuery && filtered.length > visible.length && (
          <p className="text-xs text-slate-500">Zeige die ersten {visible.length} von {filtered.length} Treffern.</p>
        )}
      </div>
    </div>
  );
};

export default MobileSearchView;

import React from 'react';
import type { Product } from '../types';

const safe = (v: any) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());

const pickSku = (p: Product) => safe(p?.identification?.sku) || safe(p?.details?.identifiers?.sku) || '';
const pickPrice = (p: Product) => {
  const lp: any = (p as any)?.details?.pricing?.lowest_price || {};
  const v: any = lp?.amount != null ? lp.amount : lp?.price;
  const n = typeof v === 'string' ? Number(String(v).replace(',', '.')) : Number(v);
  return Number.isFinite(n) ? n : null;
};
const gpsrFilledNoPlaceholder = (p: Product) => {
  const g: any = (p as any)?.details?.gpsr || {};
  const lower = (x: any) => safe(x).toLowerCase();
  const isPlaceholder = (val: any) => {
    const v = lower(val);
    if (!v) return false;
    return (
      v.includes('musterstraße') ||
      v.includes('muster str') ||
      v.includes('musterstadt') ||
      v.includes('musterbundesland') ||
      v === '12345' ||
      v.includes('info@muster') ||
      v.includes('+49 000') ||
      v === 'germany'
    );
  };
  const keys = [
    'entity_country',
    'manufacturer_address',
    'manufacturer_city',
    'manufacturer_postalcode',
    'manufacturer_state_province',
    'manufacturer_name',
    'email',
    'manufacturer_phone',
  ];
  return keys.reduce((n: number, k: string) => {
    const v = safe(g?.[k]);
    return v && !isPlaceholder(v) ? n + 1 : n;
  }, 0);
};
const hasKtyp = (p: Product) => {
  const attrs: any = (p as any)?.details?.attributes || {};
  const key = Object.keys(attrs).find((k) => ['k-typ', 'ktyp', 'k typ'].includes(String(k).trim().toLowerCase()));
  return Boolean(key && safe(attrs[key]));
};

export const InventoryDrilldownPanel: React.FC<{
  title: string;
  products: Product[];
  ids: string[];
  onClose: () => void;
  onOpenProductInNewTab: (productId: string) => void;
}> = ({ title, products, ids, onClose, onOpenProductInNewTab }) => {
  const [q, setQ] = React.useState('');
  const idSet = React.useMemo(() => new Set(ids || []), [ids]);

  const filtered = React.useMemo(() => {
    const base = products.filter((p) => p?.id && idSet.has(p.id));
    const needle = safe(q).toLowerCase();
    if (!needle) return base;
    return base.filter((p) => {
      const hay = `${safe(p?.identification?.name)} ${safe(p?.identification?.brand)} ${pickSku(p)} ${safe(p?.identification?.category)}`.toLowerCase();
      return hay.includes(needle);
    });
  }, [products, idSet, q]);

  return (
    <div className="rounded-2xl bg-[var(--surface-secondary)]/60 p-4 ring-1 ring-[var(--border)]/60">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-[color:var(--text-primary)]">{title}</div>
          <div className="text-xs text-[color:var(--text-tertiary)]">
            Treffer: <span className="text-[color:var(--text-primary)]">{filtered.length}</span> /{' '}
            <span className="text-[color:var(--text-primary)]">{ids.length}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Suchen (Name, Marke, SKU, Kategorie)…"
            className="w-56 rounded-xl bg-[var(--surface-hover)]/70 px-3 py-2 text-xs text-[color:var(--text-primary)] ring-1 ring-[var(--border)]/60 placeholder:text-[color:var(--text-tertiary)]"
          />
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl bg-[var(--surface-hover)]/80 px-3 py-2 text-xs font-semibold text-[color:var(--text-primary)] hover:bg-[var(--surface)]"
            title="Schließen"
          >
            ✕
          </button>
        </div>
      </div>

      <div className="mt-3 overflow-auto rounded-xl ring-1 ring-[var(--border)]/50">
        <table className="min-w-full text-left text-xs">
          <thead className="bg-[var(--surface-secondary)]/60 text-[color:var(--text-secondary)]">
            <tr>
              <th className="px-3 py-2 font-semibold">Produkt</th>
              <th className="px-3 py-2 font-semibold">SKU</th>
              <th className="px-3 py-2 font-semibold">Kategorie</th>
              <th className="px-3 py-2 font-semibold">Preis</th>
              <th className="px-3 py-2 font-semibold">GPSR</th>
              <th className="px-3 py-2 font-semibold">K‑Typ</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)]/60 bg-[var(--bg)]/20">
            {filtered.map((p) => {
              const price = pickPrice(p);
              const gpsr = gpsrFilledNoPlaceholder(p);
              return (
                <tr
                  key={p.id}
                  className="cursor-pointer hover:bg-[var(--surface-secondary)]/40"
                  onClick={() => onOpenProductInNewTab(p.id)}
                  title="Produktdetails in neuem Tab öffnen"
                >
                  <td className="px-3 py-2">
                    <div className="font-semibold text-[color:var(--text-primary)]">{safe(p?.identification?.name) || '—'}</div>
                    <div className="text-[11px] text-[color:var(--text-tertiary)]">{safe(p?.identification?.brand) || '—'}</div>
                  </td>
                  <td className="px-3 py-2 font-mono text-[color:var(--text-primary)]">{pickSku(p) || '—'}</td>
                  <td className="px-3 py-2 text-[color:var(--text-secondary)]">{safe(p?.identification?.category) || '—'}</td>
                  <td className="px-3 py-2 text-[color:var(--text-secondary)]">{price == null ? '—' : `${price.toFixed(2)} €`}</td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                        gpsr === 8 ? 'bg-[var(--success-bg)] text-[color:var(--success)]' : 'bg-[var(--warning-bg)] text-[color:var(--warning)]'
                      }`}
                    >
                      {gpsr}/8
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                        hasKtyp(p) ? 'bg-[var(--success-bg)] text-[color:var(--success)]' : 'bg-[var(--surface)]/60 text-[color:var(--text-secondary)]'
                      }`}
                    >
                      {hasKtyp(p) ? 'set' : '—'}
                    </span>
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 ? (
              <tr>
                <td className="px-3 py-6 text-center text-[color:var(--text-tertiary)]" colSpan={6}>
                  Keine Treffer. Tipp: Suche nach SKU oder Marke.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className="mt-2 text-[11px] text-[color:var(--text-tertiary)]">
        Tipp: Klick auf eine Zeile öffnet das Produkt in einem neuen Tab. Die Liste aktualisiert sich automatisch, wenn du oben einen anderen KPI auswählst.
      </div>
    </div>
  );
};


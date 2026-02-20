import React from 'react';
import type { Product } from '../../types';
import { getProductDisplayCategory } from '../../utils/product';

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
      const hay = `${safe(p?.identification?.name)} ${safe(p?.identification?.brand)} ${pickSku(p)} ${safe(getProductDisplayCategory(p))}`.toLowerCase();
      return hay.includes(needle);
    });
  }, [products, idSet, q]);

  return (
    <div className="rounded-xl bg-[var(--surface)] border border-[var(--border)] p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-[var(--text-primary)]">{title}</div>
          <div className="text-xs text-[var(--text-tertiary)]">
            Treffer: <span className="text-[var(--text-secondary)]">{filtered.length}</span> /{' '}
            <span className="text-[var(--text-secondary)]">{ids.length}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Suchen (Name, Marke, SKU, Kategorie)..."
            className="w-56 rounded-lg bg-[var(--bg)] border border-[var(--border)] px-3 py-2 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--avy-purple)] focus:shadow-[var(--shadow-focus)] transition-all"
          />
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-[var(--surface-secondary)] border border-[var(--border)] px-3 py-2 text-xs font-semibold text-[var(--text-primary)] hover:border-[var(--border-hover)] transition-colors"
            title="Schliessen"
          >
            ✕
          </button>
        </div>
      </div>

      <div className="mt-3 overflow-auto rounded-lg border border-[var(--border)]">
        <table className="min-w-full text-left text-xs">
          <thead className="bg-[var(--surface-secondary)] text-[var(--text-secondary)]">
            <tr>
              <th className="px-3 py-2.5 font-semibold">Produkt</th>
              <th className="px-3 py-2.5 font-semibold">SKU</th>
              <th className="px-3 py-2.5 font-semibold">Kategorie</th>
              <th className="px-3 py-2.5 font-semibold">Preis</th>
              <th className="px-3 py-2.5 font-semibold">GPSR</th>
              <th className="px-3 py-2.5 font-semibold">K-Typ</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)] bg-[var(--surface)]">
            {filtered.map((p) => {
              const price = pickPrice(p);
              const gpsr = gpsrFilledNoPlaceholder(p);
              return (
                <tr
                  key={p.id}
                  className="cursor-pointer hover:bg-[var(--surface-secondary)] transition-colors"
                  onClick={() => onOpenProductInNewTab(p.id)}
                  title="Produktdetails in neuem Tab oeffnen"
                >
                  <td className="px-3 py-2.5">
                    <div className="font-semibold text-[var(--text-primary)]">{safe(p?.identification?.name) || '\u2014'}</div>
                    <div className="text-[11px] text-[var(--text-tertiary)]">{safe(p?.identification?.brand) || '\u2014'}</div>
                  </td>
                  <td className="px-3 py-2.5 font-mono text-[var(--text-primary)]">{pickSku(p) || '\u2014'}</td>
                  <td className="px-3 py-2.5 text-[var(--text-secondary)]">{safe(getProductDisplayCategory(p)) || '\u2014'}</td>
                  <td className="px-3 py-2.5 text-[var(--text-secondary)]">{price == null ? '\u2014' : `${price.toFixed(2)} \u20AC`}</td>
                  <td className="px-3 py-2.5">
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                        gpsr === 8
                          ? 'bg-[var(--success-bg)] text-[var(--success)]'
                          : 'bg-[var(--warning-bg)] text-[var(--warning)]'
                      }`}
                    >
                      {gpsr}/8
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                        hasKtyp(p)
                          ? 'bg-[var(--success-bg)] text-[var(--success)]'
                          : 'bg-[var(--surface-secondary)] text-[var(--text-secondary)]'
                      }`}
                    >
                      {hasKtyp(p) ? 'set' : '\u2014'}
                    </span>
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 ? (
              <tr>
                <td className="px-3 py-6 text-center text-[var(--text-tertiary)]" colSpan={6}>
                  Keine Treffer. Tipp: Suche nach SKU oder Marke.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className="mt-2 text-[11px] text-[var(--text-tertiary)]">
        Tipp: Klick auf eine Zeile oeffnet das Produkt in einem neuen Tab. Die Liste aktualisiert sich automatisch, wenn du oben einen anderen KPI auswaehlst.
      </div>
    </div>
  );
};

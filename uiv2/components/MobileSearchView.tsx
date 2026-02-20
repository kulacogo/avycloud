import React, { useEffect, useMemo, useState } from 'react';
import { Product } from '../types';
import { getProductQuantity } from '../utils/product';
import { useI18n } from '../i18n';

interface MobileSearchViewProps {
  products: Product[];
  onSelectProduct: (productId: string) => void;
  isLoading?: boolean;
}

const MobileSearchView: React.FC<MobileSearchViewProps> = ({ products, onSelectProduct, isLoading }) => {
  const { t, locale } = useI18n();
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

  const formatMoney = (amount: number, currency?: string | null) => {
    const c = (currency || 'EUR').toString().trim().toUpperCase();
    const safe = /^[A-Z]{3}$/.test(c) ? c : 'EUR';
    const intlLocale = locale === 'de' ? 'de-DE' : locale === 'tr' ? 'tr-TR' : 'en-GB';
    try {
      return new Intl.NumberFormat(intlLocale, { style: 'currency', currency: safe }).format(amount);
    } catch {
      return `${amount.toFixed(2)} ${safe}`;
    }
  };

  return (
    <div className="space-y-4 max-w-xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-[color:white]">{t('nav.search')}</h1>
          <p className="text-[color:var(--text-tertiary)] text-sm">{t('mobile.search.subtitle')}</p>
        </div>
        <span className="text-xs text-[color:var(--text-tertiary)]">
          {hasQuery ? t('mobile.search.resultsCount', { count: filtered.length }) : t('mobile.search.tapToSearch')}
        </span>
      </div>

      <div className="rounded-2xl bg-[var(--surface-hover)] border border-[var(--border)] p-3">
        <input
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder={t('mobile.search.placeholder')}
          autoFocus
          inputMode="search"
          enterKeyHint="search"
          className="w-full bg-[var(--surface-secondary)] text-[color:var(--text-primary)] rounded-xl px-4 py-3 text-base focus:outline-none border border-[var(--border)]"
        />
      </div>

      <div className="space-y-3">
        {!hasQuery && (
          <p className="text-sm text-[color:var(--text-tertiary)]">{t('mobile.search.hint')}</p>
        )}
        {isLoading && !hasQuery && products.length === 0 && (
          <p className="text-sm text-[color:var(--text-tertiary)]">{t('status.loading.products')}</p>
        )}
        {showEmpty && <p className="text-sm text-[color:var(--text-tertiary)]">{t('mobile.search.noProducts')}</p>}

        {hasQuery && visible.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onSelectProduct(p.id)}
            className="w-full text-left rounded-2xl bg-[var(--surface-hover)] border border-[var(--border)] p-3 shadow-sm shadow-black/30 active:scale-[0.99] transition"
          >
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-lg bg-[var(--surface)] overflow-hidden flex items-center justify-center">
                {p.details?.images?.[0]?.url_or_base64 ? (
                  <img src={p.details.images[0].url_or_base64} alt="" className="w-full h-full object-cover" />
                ) : (
                  <span className="text-xs text-[color:var(--text-secondary)]">{t('common.noImage')}</span>
                )}
              </div>
              <div className="flex-1">
                <p className="text-sm font-semibold text-[color:white] line-clamp-2">{p.identification?.name}</p>
                <p className="text-xs text-[color:var(--text-tertiary)]">
                  {t('common.sku')} {p.identification?.sku || '—'} · {t('common.bin')} {p.storage?.binCode || '—'}
                </p>
              </div>
              <div className="text-right">
                <p className="text-sm text-[color:white]">
                  {p.details?.pricing?.lowest_price?.amount
                    ? formatMoney(p.details.pricing.lowest_price.amount, p.details?.pricing?.lowest_price?.currency)
                    : '—'}
                </p>
                <p className="text-xs text-[color:var(--text-tertiary)]">
                  {t('common.qty')} {getProductQuantity(p)}
                </p>
              </div>
            </div>
          </button>
        ))}

        {hasQuery && filtered.length === 0 && !isLoading && products.length > 0 && (
          <p className="text-sm text-[color:var(--text-tertiary)]">{t('mobile.search.noResults')}</p>
        )}
        {hasQuery && filtered.length > visible.length && (
          <p className="text-xs text-[color:var(--text-tertiary)]">
            {t('mobile.search.showingFirst', { shown: visible.length, total: filtered.length })}
          </p>
        )}
      </div>
    </div>
  );
};

export default MobileSearchView;

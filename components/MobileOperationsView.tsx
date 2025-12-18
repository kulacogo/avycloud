import React, { useMemo } from 'react';
import { Product } from '../types';
import { getProductQuantity } from '../utils/product';

type OpsMode = 'operations' | 'operations-identify' | 'operations-stow' | 'operations-pick' | 'operations-pack';

interface MobileOperationsViewProps {
  products: Product[];
  mode: OpsMode;
  onNavigate: (view: OpsMode | 'input' | 'queue' | 'sheet') => void;
  onSelectProduct: (productId: string) => void;
}

const SectionTitle: React.FC<{ title: string; desc?: string }> = ({ title, desc }) => (
  <div className="space-y-1 mb-3">
    <h2 className="text-xl font-semibold text-white">{title}</h2>
    {desc && <p className="text-sm text-slate-400">{desc}</p>}
  </div>
);

const StatusBadge: React.FC<{ label: string; tone?: 'neutral' | 'success' | 'warn' }> = ({ label, tone = 'neutral' }) => {
  const toneClasses =
    tone === 'success'
      ? 'bg-emerald-900/60 text-emerald-200 border-emerald-700/60'
      : tone === 'warn'
        ? 'bg-amber-900/60 text-amber-100 border-amber-700/60'
        : 'bg-slate-800 text-slate-200 border-slate-700/60';
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold border ${toneClasses}`}>
      {label}
    </span>
  );
};

const ProductCard: React.FC<{ product: Product; onClick: () => void; footer?: React.ReactNode }> = ({ product, onClick, footer }) => (
  <button
    type="button"
    onClick={onClick}
    className="w-full text-left rounded-2xl bg-slate-800 border border-white/5 p-3 flex gap-3 shadow-sm shadow-black/20"
  >
    <div className="w-12 h-12 rounded-lg bg-slate-700 overflow-hidden flex items-center justify-center">
      {product.details?.images?.[0]?.url_or_base64 ? (
        <img src={product.details.images[0].url_or_base64} alt="" className="w-full h-full object-cover" />
      ) : (
        <span className="text-xs text-slate-300">No Img</span>
      )}
    </div>
    <div className="flex-1">
      <p className="text-sm font-semibold text-white line-clamp-2">{product.identification?.name}</p>
      <p className="text-xs text-slate-400">
        SKU {product.identification?.sku || '—'} · BIN {product.storage?.binCode || '—'}
      </p>
      <p className="text-xs text-slate-400">Qty {getProductQuantity(product)}</p>
    </div>
    {footer && <div className="flex flex-col items-end gap-1">{footer}</div>}
  </button>
);

const MobileOperationsView: React.FC<MobileOperationsViewProps> = ({ products, mode, onNavigate, onSelectProduct }) => {
  const stowList = useMemo(
    () => products.filter((p) => getProductQuantity(p) > 0 && !p.storage?.binCode),
    [products]
  );
  const pickList = useMemo(
    () => products.filter((p) => getProductQuantity(p) > 0 && p.storage?.binCode),
    [products]
  );
  const packList = useMemo(
    () => products.filter((p) => (p.ops?.sync_status || 'pending') !== 'synced' && getProductQuantity(p) > 0),
    [products]
  );

  if (mode === 'operations-identify') {
    return (
      <div className="space-y-4">
        <SectionTitle title="Identify" desc="Fotos hochladen oder Kamera nutzen" />
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            className="rounded-2xl bg-sky-600 text-white font-semibold py-4"
            onClick={() => onNavigate('input')}
          >
            Kamera / Upload
          </button>
          <button
            type="button"
            className="rounded-2xl bg-slate-800 text-slate-100 font-semibold py-4 border border-slate-700"
            onClick={() => onNavigate('queue')}
          >
            Identify Queue
          </button>
        </div>
      </div>
    );
  }

  if (mode === 'operations-stow') {
    return (
      <div className="space-y-3">
        <SectionTitle title="Stow" desc="Ohne BIN, mit Bestand" />
        {stowList.length === 0 && <p className="text-sm text-slate-400">Keine Produkte ohne BIN.</p>}
        {stowList.slice(0, 100).map((p) => (
          <ProductCard
            key={p.id}
            product={p}
            onClick={() => onSelectProduct(p.id)}
            footer={<StatusBadge label="Stow" tone="warn" />}
          />
        ))}
      </div>
    );
  }

  if (mode === 'operations-pick') {
    return (
      <div className="space-y-3">
        <SectionTitle title="Pick" desc="Produkte mit BIN und Bestand" />
        {pickList.length === 0 && <p className="text-sm text-slate-400">Keine pickbaren Produkte.</p>}
        {pickList.slice(0, 100).map((p) => (
          <ProductCard
            key={p.id}
            product={p}
            onClick={() => onSelectProduct(p.id)}
            footer={<StatusBadge label={p.storage?.binCode || 'Pick'} tone="success" />}
          />
        ))}
      </div>
    );
  }

  if (mode === 'operations-pack') {
    return (
      <div className="space-y-3">
        <SectionTitle title="Pack" desc="Offene/pending Produkte" />
        {packList.length === 0 && <p className="text-sm text-slate-400">Keine offenen Pack-Aufgaben.</p>}
        {packList.slice(0, 100).map((p) => (
          <ProductCard
            key={p.id}
            product={p}
            onClick={() => onSelectProduct(p.id)}
            footer={<StatusBadge label={p.ops?.sync_status || 'pending'} tone={p.ops?.sync_status === 'synced' ? 'success' : 'warn'} />}
          />
        ))}
      </div>
    );
  }

  // Hub
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-white">Operations</h1>
          <p className="text-slate-400 text-sm">Schnellzugriff für Mobile</p>
        </div>
        <div className="text-right text-xs text-slate-400 space-y-0.5">
          <p>Stow: {stowList.length}</p>
          <p>Pick: {pickList.length}</p>
          <p>Pack: {packList.length}</p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <button
          type="button"
          className="rounded-2xl bg-sky-600 text-white font-semibold py-4"
          onClick={() => onNavigate('operations-identify')}
        >
          Identify
        </button>
        <button
          type="button"
          className="rounded-2xl bg-emerald-600 text-white font-semibold py-4"
          onClick={() => onNavigate('operations-stow')}
        >
          Stow
        </button>
        <button
          type="button"
          className="rounded-2xl bg-amber-600 text-white font-semibold py-4"
          onClick={() => onNavigate('operations-pick')}
        >
          Pick
        </button>
        <button
          type="button"
          className="rounded-2xl bg-slate-700 text-white font-semibold py-4"
          onClick={() => onNavigate('operations-pack')}
        >
          Pack
        </button>
      </div>
    </div>
  );
};

export default MobileOperationsView;

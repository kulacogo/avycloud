import React, { useMemo, useRef, useState } from 'react';
import { Product } from '../types';
import { getProductQuantity } from '../utils/product';

type OpsMode = 'operations' | 'operations-identify' | 'operations-stow' | 'operations-pick' | 'operations-pack';

interface MobileOperationsViewProps {
  products: Product[];
  mode: OpsMode;
  onNavigate: (view: OpsMode | 'input' | 'queue' | 'sheet') => void;
  onSelectProduct?: (productId: string) => void;
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

const ProductCard: React.FC<{ product: Product; footer?: React.ReactNode }> = ({ product, footer }) => (
  <div className="w-full text-left rounded-2xl bg-slate-800 border border-white/5 p-3 flex gap-3 shadow-sm shadow-black/20">
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
  </div>
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

  const [stowSku, setStowSku] = useState('');
  const [stowBin, setStowBin] = useState('');
  const [stowQty, setStowQty] = useState(1);

  const [pickBin, setPickBin] = useState('');
  const [pickSku, setPickSku] = useState('');
  const [pickQty, setPickQty] = useState(1);

  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);

  const handleSubmitStow = (e: React.FormEvent) => {
    e.preventDefault();
    if (!stowSku || !stowBin || stowQty <= 0) return;
    alert(`Stow erfasst: SKU ${stowSku}, BIN ${stowBin}, Menge ${stowQty}`);
    setStowSku('');
    setStowBin('');
    setStowQty(1);
  };

  const handleSubmitPick = (e: React.FormEvent) => {
    e.preventDefault();
    if (!pickSku || !pickBin || pickQty <= 0) return;
    alert(`Pick erfasst: BIN ${pickBin}, SKU ${pickSku}, Menge ${pickQty}`);
    setPickSku('');
    setPickBin('');
    setPickQty(1);
  };

  if (mode === 'operations-identify') {
    return (
      <div className="space-y-4">
        <SectionTitle title="Identify" desc="Mehrere Fotos aufnehmen oder hochladen" />
        <div className="grid grid-cols-1 gap-3">
          <button
            type="button"
            className="rounded-2xl bg-sky-600 text-white font-semibold py-4"
            onClick={() => cameraInputRef.current?.click()}
          >
            Kamera / Mehrere Fotos
          </button>
          <button
            type="button"
            className="rounded-2xl bg-slate-800 text-slate-100 font-semibold py-4 border border-slate-700"
            onClick={() => uploadInputRef.current?.click()}
          >
            Bilder hochladen
          </button>
          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            multiple
            className="hidden"
          />
          <input ref={uploadInputRef} type="file" accept="image/*" multiple className="hidden" />
        </div>
        <p className="text-xs text-slate-400">
          Hinweis: Fotos werden gesammelt. Nach Upload bitte den Identify-Job im Desktop nicht öffnen; dieser Screen bleibt mobil.
        </p>
      </div>
    );
  }

  if (mode === 'operations-stow') {
    return (
      <div className="space-y-3">
        <SectionTitle title="Stow" desc="Ohne BIN, mit Bestand" />
        <form onSubmit={handleSubmitStow} className="space-y-2 rounded-2xl border border-white/10 bg-slate-800/70 p-3">
          <p className="text-xs text-slate-300">Scanner-Flow: Erst SKU scannen, dann BIN scannen, Menge eingeben.</p>
          <input
            value={stowSku}
            onChange={(e) => setStowSku(e.target.value)}
            placeholder="SKU scannen/eingeben"
            className="w-full rounded-xl bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-white"
          />
          <input
            value={stowBin}
            onChange={(e) => setStowBin(e.target.value)}
            placeholder="BIN scannen/eingeben"
            className="w-full rounded-xl bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-white"
          />
          <input
            type="number"
            min={1}
            value={stowQty}
            onChange={(e) => setStowQty(Number(e.target.value))}
            placeholder="Menge"
            className="w-full rounded-xl bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-white"
          />
          <button type="submit" className="w-full rounded-xl bg-emerald-600 text-white font-semibold py-2">
            Stow abschließen
          </button>
        </form>
        {stowList.length === 0 && <p className="text-sm text-slate-400">Keine Produkte ohne BIN.</p>}
        {stowList.slice(0, 100).map((p) => (
          <ProductCard key={p.id} product={p} footer={<StatusBadge label="Stow" tone="warn" />} />
        ))}
      </div>
    );
  }

  if (mode === 'operations-pick') {
    return (
      <div className="space-y-3">
        <SectionTitle title="Pick" desc="Produkte mit BIN und Bestand" />
        <form onSubmit={handleSubmitPick} className="space-y-2 rounded-2xl border border-white/10 bg-slate-800/70 p-3">
          <p className="text-xs text-slate-300">Scanner-Flow: Erst BIN scannen, dann SKU scannen, Menge eingeben.</p>
          <input
            value={pickBin}
            onChange={(e) => setPickBin(e.target.value)}
            placeholder="BIN scannen/eingeben"
            className="w-full rounded-xl bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-white"
          />
          <input
            value={pickSku}
            onChange={(e) => setPickSku(e.target.value)}
            placeholder="SKU scannen/eingeben"
            className="w-full rounded-xl bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-white"
          />
          <input
            type="number"
            min={1}
            value={pickQty}
            onChange={(e) => setPickQty(Number(e.target.value))}
            placeholder="Menge"
            className="w-full rounded-xl bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-white"
          />
          <button type="submit" className="w-full rounded-xl bg-sky-600 text-white font-semibold py-2">
            Pick abschließen
          </button>
        </form>
        {pickList.length === 0 && <p className="text-sm text-slate-400">Keine pickbaren Produkte.</p>}
        {pickList.slice(0, 100).map((p) => (
          <ProductCard key={p.id} product={p} footer={<StatusBadge label={p.storage?.binCode || 'Pick'} tone="success" />} />
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
      <div className="flex flex-col gap-3">
        <button
          type="button"
          className="w-full rounded-2xl bg-sky-600 text-white font-semibold py-4 text-lg"
          onClick={() => onNavigate('operations-identify')}
        >
          Identify
        </button>
        <button
          type="button"
          className="w-full rounded-2xl bg-emerald-600 text-white font-semibold py-4 text-lg"
          onClick={() => onNavigate('operations-stow')}
        >
          Stow
        </button>
        <button
          type="button"
          className="w-full rounded-2xl bg-amber-600 text-white font-semibold py-4 text-lg"
          onClick={() => onNavigate('operations-pick')}
        >
          Pick
        </button>
        <button
          type="button"
          className="w-full rounded-2xl bg-slate-700 text-white font-semibold py-4 text-lg"
          onClick={() => onNavigate('operations-pack')}
        >
          Pack
        </button>
      </div>
    </div>
  );
};

export default MobileOperationsView;

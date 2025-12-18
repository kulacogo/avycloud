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
  // Nur offene Kommissionierungen: nehmen wir als Heuristik ops.sync_status === 'pending'
  const pickList = useMemo(
    () => products.filter((p) => getProductQuantity(p) > 0 && p.storage?.binCode && (p.ops?.sync_status ?? 'pending') === 'pending'),
    [products]
  );
  // Pack: nur bereits gepickte; Heuristik ops.sync_status === 'picked'
  const packList = useMemo(
    () => products.filter((p) => (p.ops?.sync_status ?? 'pending') === 'picked' && getProductQuantity(p) > 0),
    [products]
  );

  const [stowSku, setStowSku] = useState('');
  const [stowBin, setStowBin] = useState('');
  const [stowQty, setStowQty] = useState(1);
  const [stowedSkus, setStowedSkus] = useState<Set<string>>(new Set());

  const [pickBin, setPickBin] = useState('');
  const [pickSku, setPickSku] = useState('');
  const [pickQty, setPickQty] = useState(1);

  const [identifySlots, setIdentifySlots] = useState<number[]>([0]);
  const uploadInputRefs = useRef<Record<number, HTMLInputElement | null>>({});
  const cameraInputRefs = useRef<Record<number, HTMLInputElement | null>>({});

  const handleSubmitStow = () => {
    if (!stowSku || !stowBin || stowQty <= 0) return;
    alert(`Stow erfasst: SKU ${stowSku}, BIN ${stowBin}, Menge ${stowQty}`);
    setStowedSkus((prev) => {
      const next = new Set(prev);
      next.add(stowSku);
      return next;
    });
    setStowSku('');
    setStowBin('');
    setStowQty(1);
  };

  const handleSubmitPick = () => {
    if (!pickSku || !pickBin || pickQty <= 0) return;
    alert(`Pick erfasst: BIN ${pickBin}, SKU ${pickSku}, Menge ${pickQty}`);
    setPickSku('');
    setPickBin('');
    setPickQty(1);
  };

  const scanSku = () => {
    const value = window.prompt('SKU scannen/eingeben');
    if (value) setStowSku(value.trim());
  };

  const scanBin = () => {
    const value = window.prompt('BIN scannen/eingeben');
    if (value) setStowBin(value.trim());
    if (value) {
      const qty = window.prompt('Menge eingeben');
      const n = qty ? Number(qty) : 1;
      if (Number.isFinite(n) && n > 0) {
        setStowQty(n);
        setTimeout(handleSubmitStow, 0);
      }
    }
  };

  const scanPickBin = () => {
    const value = window.prompt('BIN scannen/eingeben');
    if (value) setPickBin(value.trim());
  };

  const scanPickSku = () => {
    const value = window.prompt('SKU scannen/eingeben');
    if (value) {
      setPickSku(value.trim());
      const qty = window.prompt('Menge eingeben');
      const n = qty ? Number(qty) : 1;
      if (Number.isFinite(n) && n > 0) {
        setPickQty(n);
        setTimeout(handleSubmitPick, 0);
      }
    }
  };

  const stowFiltered = useMemo(
    () => stowList.filter((p) => !stowedSkus.has(p.identification?.sku || p.details?.identifiers?.sku || '')),
    [stowList, stowedSkus]
  );

  const addIdentifySlot = () => {
    setIdentifySlots((prev) => [...prev, Date.now()]);
  };

  const triggerIdentifyInput = (slot: number, type: 'camera' | 'upload') => {
    const refMap = type === 'camera' ? cameraInputRefs.current : uploadInputRefs.current;
    const input = refMap[slot];
    if (input) input.click();
  };

  if (mode === 'operations-identify') {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <SectionTitle title="Identify" desc="Mehrere Fotos aufnehmen oder hochladen" />
          <button
            type="button"
            className="rounded-full bg-slate-800 text-white px-3 py-2 text-sm font-semibold border border-slate-700"
            onClick={addIdentifySlot}
          >
            + Add
          </button>
        </div>
        <div className="grid grid-cols-1 gap-3">
          {identifySlots.map((slot) => (
            <div key={slot} className="rounded-2xl border border-dashed border-white/15 bg-slate-800/70 p-4 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  className="rounded-2xl bg-sky-600 text-white font-semibold py-3"
                  onClick={() => triggerIdentifyInput(slot, 'camera')}
                >
                  Kamera
                </button>
                <button
                  type="button"
                  className="rounded-2xl bg-slate-800 text-slate-100 font-semibold py-3 border border-slate-700"
                  onClick={() => triggerIdentifyInput(slot, 'upload')}
                >
                  Upload
                </button>
              </div>
              <input
                ref={(el) => {
                  cameraInputRefs.current[slot] = el;
                }}
                type="file"
                accept="image/*"
                capture="environment"
                multiple
                className="hidden"
              />
              <input
                ref={(el) => {
                  uploadInputRefs.current[slot] = el;
                }}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
              />
            </div>
          ))}
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
        <div className="rounded-2xl border border-white/10 bg-slate-800/70 p-3 space-y-2">
          <p className="text-xs text-slate-300">Scanner-Flow: SKU scannen → Produkt wird gehighlightet. BIN scannen → Menge abfragen → Stow abschließen.</p>
          <div className="flex flex-col gap-2">
            <button type="button" onClick={scanSku} className="rounded-xl bg-sky-700 text-white font-semibold py-2">
              SKU scannen
            </button>
            <button type="button" onClick={scanBin} className="rounded-xl bg-emerald-700 text-white font-semibold py-2">
              BIN scannen & Menge
            </button>
          </div>
        </div>
        {stowFiltered.length === 0 && <p className="text-sm text-slate-400">Keine Produkte ohne BIN.</p>}
        {stowFiltered.slice(0, 100).map((p) => {
          const sku = p.identification?.sku || p.details?.identifiers?.sku || '';
          const highlight = stowSku && sku === stowSku;
          return (
            <div
              key={p.id}
              className={`rounded-2xl border p-3 bg-slate-800 shadow-sm shadow-black/30 ${highlight ? 'border-emerald-400 bg-emerald-900/30' : 'border-white/5'}`}
            >
              <ProductCard product={p} footer={<StatusBadge label="Stow" tone="warn" />} />
            </div>
          );
        })}
      </div>
    );
  }

  if (mode === 'operations-pick') {
    return (
      <div className="space-y-3">
        <SectionTitle title="Pick" desc="Produkte mit BIN und Bestand" />
        <div className="rounded-2xl border border-white/10 bg-slate-800/70 p-3 space-y-2">
          <p className="text-xs text-slate-300">Scanner-Flow: BIN scannen → SKU scannen → Menge eingeben → Pick abschließen.</p>
          <div className="flex flex-col gap-2">
            <button type="button" onClick={scanPickBin} className="rounded-xl bg-sky-700 text-white font-semibold py-2">
              BIN scannen
            </button>
            <button type="button" onClick={scanPickSku} className="rounded-xl bg-emerald-700 text-white font-semibold py-2">
              SKU scannen & Menge
            </button>
          </div>
        </div>
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

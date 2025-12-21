import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Order, Product } from '../types';
import { getProductQuantity } from '../utils/product';
import { fetchOrders as fetchOrdersApi, syncOrders as syncOrdersApi, completeOrder, stockInProduct } from '../api/client';

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
  // Pack: nutze "synced" als konservative Heuristik, da "picked" kein gültiger SyncStatus ist
  const packList = useMemo(
    () => products.filter((p) => (p.ops?.sync_status ?? 'pending') === 'synced' && getProductQuantity(p) > 0),
    [products]
  );

  const [stowSku, setStowSku] = useState('');
  const [stowBin, setStowBin] = useState('');
  const [stowQty, setStowQty] = useState(1);
  const [stowEntries, setStowEntries] = useState<Array<{ sku: string; bin: string; qty: number }>>([]);
  const [stowedSkus, setStowedSkus] = useState<Set<string>>(new Set());
  const [stowMessage, setStowMessage] = useState<string | null>(null);

  const [orders, setOrders] = useState<Order[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [activeBin, setActiveBin] = useState('');
  const [activeSku, setActiveSku] = useState('');
  const [highlightKey, setHighlightKey] = useState<string | null>(null);

  const [identifySlots, setIdentifySlots] = useState<number[]>([0]);
  const uploadInputRefs = useRef<Record<number, HTMLInputElement | null>>({});
  const cameraInputRefs = useRef<Record<number, HTMLInputElement | null>>({});
  const isUnmountedRef = useRef(false);

  const dedupeOrders = (list: Order[]) => {
    const seen = new Set<string>();
    const result: Order[] = [];
    list.forEach((order) => {
      const key = order.baselinkerId || order.id;
      if (seen.has(key)) return;
      seen.add(key);
      result.push(order);
    });
    return result;
  };

  const refreshOrders = useCallback(
    async (isCancelled?: () => boolean) => {
      if (isCancelled?.()) return;
      setOrdersLoading(true);
      try {
        try {
          await syncOrdersApi({ timeoutMs: 10000 });
        } catch (err) {
          console.warn('Order sync failed (will still fetch)', err);
        }
        const data = await fetchOrdersApi(200, { timeoutMs: 10000 });
        if (!isCancelled?.() && !isUnmountedRef.current) setOrders(dedupeOrders(data || []));
      } catch (err) {
        console.warn('Failed to load orders', err);
      } finally {
        if (!isCancelled?.() && !isUnmountedRef.current) setOrdersLoading(false);
      }
    },
    [dedupeOrders]
  );

  useEffect(() => {
    isUnmountedRef.current = false;
    let cancelled = false;
    refreshOrders(() => cancelled);
    const interval = setInterval(() => refreshOrders(() => cancelled), 30000);
    return () => {
      cancelled = true;
      isUnmountedRef.current = true;
      clearInterval(interval);
    };
  }, [refreshOrders]);

  const pickItems = useMemo(() => {
    // Nur offene BaseLinker-Aufträge: Status "new" / "Neue Bestellung"
    const openOrders = orders.filter((o) => (o.status || '').toLowerCase() === 'new');
    const bucket: Record<string, { orderId: string; sku: string; name: string; binCode: string; qty: number; pickHint?: any }> = {};
    openOrders.forEach((o) => {
      o.items
        .filter((it) => !it.pickCompleted)
        .forEach((it) => {
          const sku = it.sku || it.id;
          const binCode = it.pickHint?.binCode || '—';
          const key = `${o.id}::${sku}::${binCode}`;
          const qty = Number.isFinite(it.quantity) ? it.quantity : 1;
          if (!bucket[key]) {
            bucket[key] = { orderId: o.id, sku, name: it.name, binCode, qty: 0, pickHint: it.pickHint };
          }
          bucket[key].qty += qty;
        });
    });
    return Object.values(bucket);
  }, [orders]);

  const packItems = useMemo(() => {
    const ready = orders.filter((o) => o.status === 'picked');
    const bucket: Record<string, { orderId: string; sku: string; name: string; binCode: string; qty: number }> = {};
    ready.forEach((o) => {
      o.items.forEach((it) => {
        const sku = it.sku || it.id;
        const binCode = it.pickHint?.binCode || '—';
        const key = `${o.id}::${sku}::${binCode}`;
        const qty = Number.isFinite(it.quantity) ? it.quantity : 1;
        if (!bucket[key]) {
          bucket[key] = { orderId: o.id, sku, name: it.name, binCode, qty: 0 };
        }
        bucket[key].qty += qty;
      });
    });
    return Object.values(bucket);
  }, [orders]);

  const equalsIgnoreCase = useCallback((a?: string | null, b?: string | null) => (a || '').toLowerCase() === (b || '').toLowerCase(), []);

  const completePickFlow = useCallback(
    async (item: { orderId: string; sku: string; name: string; binCode: string }, bin: string, sku: string) => {
      const qtyStr = window.prompt('Menge eingeben', '1');
      const qty = qtyStr ? Number(qtyStr) : 1;
      if (!Number.isFinite(qty) || qty <= 0) return;
      alert(`Pick erfasst: BIN ${bin} · SKU ${sku} · Menge ${qty} · Auftrag ${item.orderId}`);
      try {
        await completeOrder(item.orderId);
      } catch (err: any) {
        console.error('Failed to mark order as picked', err);
      }
      await refreshOrders();
      setActiveBin('');
      setActiveSku('');
      setHighlightKey(null);
    },
    [refreshOrders]
  );

  const normalize = (val?: string | null) => (val || '').replace(/\s+/g, '').toUpperCase();
  const resolveProductForStow = useCallback(
    (skuValue: string) => {
      const needle = normalize(skuValue);
      if (!needle) return null;
      return (
        products.find((p) => normalize(p.identification?.sku || p.details?.identifiers?.sku || '') === needle) ||
        products.find((p) =>
          (p.identification?.barcodes || []).some((bc) => normalize(bc) === needle)
        ) ||
        null
      );
    },
    [products]
  );

  const handleSubmitStow = useCallback(async () => {
    if (!stowSku || !stowBin || stowQty <= 0) return;
    setStowMessage(null);
    const productMatch = resolveProductForStow(stowSku);
    const payload = {
      productId: productMatch?.id,
      sku: stowSku,
      binCode: stowBin,
      quantity: stowQty,
      barcode: productMatch?.identification?.barcodes?.[0] || productMatch?.details?.identifiers?.ean || undefined,
    };
    const result = await stockInProduct(payload);
    if (!result.ok) {
      setStowMessage(result.error?.message || 'Einlagerung fehlgeschlagen.');
      return;
    }
    setStowEntries((prev) => [...prev, { sku: stowSku, bin: stowBin, qty: stowQty }]);
    setStowedSkus((prev) => {
      const next = new Set(prev);
      next.add(normalize(stowSku));
      return next;
    });
    setStowMessage('Einlagerung gespeichert.');
    setStowSku('');
    setStowBin('');
    setStowQty(1);
  }, [resolveProductForStow, stowBin, stowQty, stowSku, normalize]);

  const handleScannedValue = useCallback(
    (value: string) => {
      const normalized = value.trim();
      if (!normalized) return;

      if (mode === 'operations-stow') {
        const numeric = /^\d+$/;
        if (!stowSku && !numeric.test(normalized)) {
          setStowSku(normalized);
          return;
        }
        if (stowSku && !stowBin && !numeric.test(normalized)) {
          setStowBin(normalized);
          return;
        }
        if (numeric.test(normalized)) {
          const n = Number(normalized);
          if (Number.isFinite(n) && n > 0) {
            setStowQty(n);
            setTimeout(handleSubmitStow, 0);
          }
        }
        return;
      }

      let nextBin = activeBin;
      let nextSku = activeSku;

      const binMatches = pickItems.filter((it) => equalsIgnoreCase(it.binCode, normalized));
      const skuMatches = pickItems.filter((it) => equalsIgnoreCase(it.sku, normalized));

      if (binMatches.length) {
        nextBin = binMatches[0].binCode;
      }
      if (skuMatches.length) {
        nextSku = skuMatches[0].sku || '';
      }

      setActiveBin(nextBin);
      setActiveSku(nextSku);

      const findCandidate = () => {
        if (nextBin && nextSku) {
          return pickItems.find((it) => equalsIgnoreCase(it.binCode, nextBin) && equalsIgnoreCase(it.sku, nextSku));
        }
        if (nextBin && binMatches.length === 1) {
          return binMatches[0];
        }
        if (nextSku && skuMatches.length === 1) {
          return skuMatches[0];
        }
        return null;
      };

      const candidate = findCandidate();
      if (candidate) {
        const key = `${candidate.orderId}-${candidate.sku}-${candidate.binCode}`;
        setHighlightKey(key);
        // Sobald eindeutig: Menge abfragen und Pick abschließen
        if ((nextBin && nextSku) || binMatches.length === 1) {
          void completePickFlow(candidate, nextBin || candidate.binCode, nextSku || candidate.sku);
        }
      }
    },
    [activeBin, activeSku, completePickFlow, equalsIgnoreCase, pickItems, handleSubmitStow, stowBin, stowQty, stowSku]
  );
  useEffect(() => {
    const bufferRef = { current: '' };

    const onKeyDown = (e: KeyboardEvent) => {
      if (mode !== 'operations-pick' && mode !== 'operations-stow') return;
      const target = e.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA'].includes(target.tagName)) return;

      if (e.key === 'Enter') {
        const val = bufferRef.current.trim();
        bufferRef.current = '';
        if (val) {
          e.preventDefault();
          handleScannedValue(val);
        }
        return;
      }

      if (e.key.length === 1) {
        bufferRef.current += e.key;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleScannedValue, mode]);

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
    const showKeypad = Boolean(stowSku && stowBin);
    return (
      <div className="space-y-3">
        <SectionTitle title="Stow" desc="Ohne BIN, mit Bestand" />
        <div className="rounded-2xl border border-white/10 bg-slate-800/70 p-3 space-y-2">
          <p className="text-xs text-slate-300">
            Scanner-Flow: SKU scannen → BIN scannen → Menge (Ziffern) scannen. Nach jeder Einlagerung wird alles zurückgesetzt.
          </p>
          {stowMessage && <p className="text-xs text-emerald-300">{stowMessage}</p>}
          <div className="grid grid-cols-2 gap-2 text-sm text-slate-200">
            <div className="rounded-xl bg-slate-900/60 border border-white/10 p-2">
              <p className="text-[11px] uppercase tracking-widest text-slate-400">SKU</p>
              <p className="text-base font-semibold break-all">{stowSku || '—'}</p>
            </div>
            <div className="rounded-xl bg-slate-900/60 border border-white/10 p-2">
              <p className="text-[11px] uppercase tracking-widest text-slate-400">BIN</p>
              <p className="text-base font-semibold break-all">{stowBin || '—'}</p>
            </div>
          </div>
          {showKeypad && (
            <div className="rounded-xl bg-slate-900/60 border border-white/10 p-3 space-y-3">
              <p className="text-[11px] uppercase tracking-widest text-slate-400">Menge (Scanner oder Num-Pad)</p>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  readOnly
                  value={stowQty}
                  className="flex-1 rounded-lg bg-slate-800 text-white text-xl font-semibold px-3 py-2 border border-slate-700"
                />
                <button
                  type="button"
                  className="rounded-lg px-3 py-2 bg-slate-700 text-white text-sm font-semibold"
                  onClick={() => setStowQty(0)}
                >
                  Clear
                </button>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
                  <button
                    key={n}
                    type="button"
                    className="rounded-lg bg-slate-800 text-white text-xl font-semibold py-3"
                    onClick={() => setStowQty((prev) => Number(`${prev}${n}`))}
                  >
                    {n}
                  </button>
                ))}
                <button
                  type="button"
                  className="rounded-lg bg-slate-800 text-white text-lg font-semibold py-3"
                  onClick={() => setStowQty((prev) => Math.max(0, Math.floor(prev / 10)))}
                >
                  ⌫
                </button>
                <button
                  type="button"
                  className="rounded-lg bg-slate-800 text-white text-xl font-semibold py-3"
                  onClick={() => setStowQty((prev) => Number(`${prev}0`))}
                >
                  0
                </button>
                <button
                  type="button"
                  className="rounded-lg bg-slate-800 text-white text-lg font-semibold py-3"
                  onClick={() => setStowQty(0)}
                >
                  C
                </button>
              </div>
            </div>
          )}
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              disabled={!stowSku || !stowBin || stowQty <= 0}
              onClick={handleSubmitStow}
              className="rounded-lg bg-emerald-600 text-white font-semibold py-3 disabled:opacity-40"
            >
              Einlagern
            </button>
            <button
              type="button"
              onClick={() => {
                setStowSku('');
                setStowBin('');
                setStowQty(1);
              }}
              className="rounded-lg bg-slate-700 text-white font-semibold py-3"
            >
              Zurücksetzen
            </button>
          </div>
        </div>

        {stowEntries.length > 0 && (
          <div className="rounded-2xl border border-white/10 bg-slate-800/70 p-3 space-y-2">
            <p className="text-sm font-semibold text-white">Erfasste Stows (Session)</p>
            <div className="space-y-2">
              {stowEntries.map((entry, idx) => (
                <div key={`${entry.sku}-${entry.bin}-${idx}`} className="rounded-xl border border-white/10 bg-slate-900/60 p-2 text-sm text-slate-200">
                  <div className="flex justify-between gap-2">
                    <span className="font-semibold break-all">{entry.sku}</span>
                    <span className="text-slate-300">Qty {entry.qty}</span>
                  </div>
                  <p className="text-xs text-slate-400 break-all">BIN {entry.bin}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  if (mode === 'operations-pick') {
    return (
      <div className="space-y-3">
        <SectionTitle title="Pick" desc="Offene Aufträge (BaseLinker)" />
        <div className="rounded-2xl border border-white/10 bg-slate-800/70 p-3 space-y-2">
          <p className="text-xs text-slate-300">
            Scanner-Flow: BIN scannen → SKU scannen (oder nur BIN falls eindeutig) → Menge eingeben → Pick fertig.
          </p>
          <div className="text-xs text-slate-400 flex flex-wrap gap-2">
            <span className="px-2 py-1 rounded-full border border-white/10 bg-white/5">BIN: {activeBin || '—'}</span>
            <span className="px-2 py-1 rounded-full border border-white/10 bg-white/5">SKU: {activeSku || '—'}</span>
            <span className="px-2 py-1 rounded-full border border-white/10 bg-white/5">
              Fokus: Scanner-Eingabe wird automatisch erfasst (Enter schließt den Scan ab)
            </span>
          </div>
        </div>
        {ordersLoading && <p className="text-sm text-slate-400">Lade Aufträge …</p>}
        {pickItems.length === 0 && !ordersLoading && <p className="text-sm text-slate-400">Keine offenen Pick-Aufträge.</p>}
        {pickItems.slice(0, 100).map((item) => {
          const key = `${item.orderId}-${item.sku}-${item.binCode}`;
          const isHighlighted = highlightKey === key;
          return (
            <div
              key={key}
              className={`rounded-2xl border p-3 shadow-sm shadow-black/20 ${
                isHighlighted ? 'border-sky-500 bg-sky-900/30' : 'border-white/5 bg-slate-800'
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1">
                  <p className="text-sm font-semibold text-white line-clamp-2">{item.name}</p>
                  <p className="text-xs text-slate-400">SKU {item.sku || '—'} · BIN {item.binCode || '—'}</p>
                  <p className="text-xs text-slate-400">Qty {item.qty}</p>
                </div>
                <StatusBadge label={item.binCode || 'Pick'} tone={isHighlighted ? 'warn' : 'success'} />
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  if (mode === 'operations-pack') {
    return (
      <div className="space-y-3">
        <SectionTitle title="Pack" desc="Bereit zum Verpacken" />
        {ordersLoading && <p className="text-sm text-slate-400">Lade Aufträge …</p>}
        {packItems.length === 0 && !ordersLoading && <p className="text-sm text-slate-400">Keine gepickten Aufträge zum Packen.</p>}
        {packItems.slice(0, 100).map((item) => (
          <div key={`${item.orderId}-${item.sku}`} className="rounded-2xl border border-white/5 bg-slate-800 p-3 shadow-sm shadow-black/20">
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1">
                <p className="text-sm font-semibold text-white line-clamp-2">{item.name}</p>
                <p className="text-xs text-slate-400">SKU {item.sku || '—'} · BIN {item.binCode || '—'}</p>
                <p className="text-xs text-slate-400">Qty {item.qty}</p>
              </div>
              <StatusBadge label="Pack" tone="warn" />
            </div>
          </div>
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

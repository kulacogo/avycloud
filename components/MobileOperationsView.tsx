import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Order, Product } from '../types';
import { getProductQuantity } from '../utils/product';
import { fetchOrders as fetchOrdersApi, syncOrders as syncOrdersApi, completeOrder, packOrder, stockInProduct, stockOutProduct } from '../api/client';
import { useI18n } from '../i18n';
import { compareBinCodesForPickRoute } from '../utils/warehouseRoute';
import type { UploadGroupPayload } from '../hooks/useIdentification';

type OpsMode = 'operations' | 'operations-identify' | 'operations-stow' | 'operations-pick' | 'operations-pack';

type MobilePickTask = {
  orderId: string;
  orderNumber?: string | null;
  itemId: string;
  name: string;
  sku: string;
  binCode: string;
  suggestedQty: number;
  remainingTotal: number;
  itemTotal: number;
  pickedSoFar: number;
  productId?: string | null;
  availableInBin?: number | null;
};

interface MobileOperationsViewProps {
  products: Product[];
  mode: OpsMode;
  onNavigate: (view: OpsMode | 'input' | 'sheet') => void;
  onSelectProduct?: (productId: string) => void;
  onIdentify?: (groups: UploadGroupPayload[], barcodes: string) => void;
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

const ProductCard: React.FC<{ product: Product; footer?: React.ReactNode }> = ({ product, footer }) => {
  const { t } = useI18n();
  return (
  <div className="w-full text-left rounded-2xl bg-slate-800 border border-white/5 p-3 flex gap-3 shadow-sm shadow-black/20">
    <div className="w-12 h-12 rounded-lg bg-slate-700 overflow-hidden flex items-center justify-center">
      {product.details?.images?.[0]?.url_or_base64 ? (
        <img src={product.details.images[0].url_or_base64} alt="" className="w-full h-full object-cover" />
      ) : (
          <span className="text-xs text-slate-300">{t('common.noImage')}</span>
      )}
    </div>
    <div className="flex-1">
      <p className="text-sm font-semibold text-white line-clamp-2">{product.identification?.name}</p>
      <p className="text-xs text-slate-400">
          {t('common.sku')} {product.identification?.sku || '—'} · {t('common.bin')} {product.storage?.binCode || '—'}
        </p>
        <p className="text-xs text-slate-400">
          {t('common.qty')} {getProductQuantity(product)}
      </p>
    </div>
    {footer && <div className="flex flex-col items-end gap-1">{footer}</div>}
  </div>
);
};

const MobileOperationsView: React.FC<MobileOperationsViewProps> = ({ products, mode, onNavigate, onSelectProduct, onIdentify }) => {
  const { t } = useI18n();
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
  const [pickMessage, setPickMessage] = useState<string | null>(null);
  const [packMessage, setPackMessage] = useState<string | null>(null);
  // Mobile pick progress (supports partial picks across bins)
  const [pickedByItemId, setPickedByItemId] = useState<Record<string, number>>({});
  // Local bin deltas to avoid stale product data causing repeated picks from the same BIN
  const [pickedFromBin, setPickedFromBin] = useState<Record<string, number>>({}); // key: `${productId}::${BIN}` -> pickedQty
  const [pendingPick, setPendingPick] = useState<MobilePickTask | null>(null);
  const [pendingPickQty, setPendingPickQty] = useState<number>(1);

  const [identifySlots, setIdentifySlots] = useState<number[]>([0]);
  const uploadInputRefs = useRef<Record<number, HTMLInputElement | null>>({});
  const cameraInputRefs = useRef<Record<number, HTMLInputElement | null>>({});
  const isUnmountedRef = useRef(false);

  type IdentifySlotImage = { id: string; file: File; previewUrl: string };
  const [identifyImagesBySlot, setIdentifyImagesBySlot] = useState<Record<number, IdentifySlotImage[]>>({});

  const clearIdentifySlot = useCallback((slot: number) => {
    setIdentifyImagesBySlot((prev) => {
      const current = prev[slot] || [];
      current.forEach((img) => URL.revokeObjectURL(img.previewUrl));
      const next = { ...prev };
      delete next[slot];
      return next;
    });
  }, []);

  useEffect(() => {
    return () => {
      Object.values(identifyImagesBySlot)
        .flat()
        .forEach((img) => URL.revokeObjectURL(img.previewUrl));
    };
  }, [identifyImagesBySlot]);

  const handleIdentifyFilesSelected = useCallback((slot: number, fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList).filter((f) => f && f.type && f.type.startsWith('image/'));
    if (!files.length) return;
    setIdentifyImagesBySlot((prev) => {
      const existing = prev[slot] || [];
      const seen = new Set<string>(existing.map((img) => `${img.file.name}:${img.file.size}:${img.file.lastModified}`));
      const additions: IdentifySlotImage[] = [];
      files.forEach((file) => {
        const key = `${file.name}:${file.size}:${file.lastModified}`;
        if (seen.has(key)) return;
        seen.add(key);
        additions.push({
          id: `${slot}_${Math.random().toString(36).slice(2, 9)}`,
          file,
          previewUrl: URL.createObjectURL(file),
        });
      });
      if (!additions.length) return prev;
      return { ...prev, [slot]: [...existing, ...additions] };
    });
  }, []);

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
          await syncOrdersApi({ timeoutMs: 20000 });
        } catch (err) {
          console.warn('Order sync failed (will still fetch)', err);
        }
        const data = await fetchOrdersApi(100, { timeoutMs: 20000 });
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

  const openOrders = useMemo(() => {
    const isCancelled = (label?: string | null) => {
      const raw = (label || '').toLowerCase();
      return raw.includes('storniert') || raw.includes('cancel');
    };
    return orders.filter((o) => (o.status || '').toLowerCase() === 'new' && !isCancelled(o.statusLabel));
  }, [orders]);

  const readyToPackOrders = useMemo(() => {
    // We only want orders that are actually in BaseLinker status "Kommissioniert" (local status: picked + label contains kommissioniert)
    return orders.filter(
      (o) => o.status === 'picked' && (o.statusLabel || '').toLowerCase().includes('kommissioniert')
    );
  }, [orders]);

  const normalizeScan = (val?: string | null) => (val || '').replace(/\s+/g, '').toUpperCase();
  const normalizeSkuScan = (val?: string | null) => normalizeScan(val).replace(/^SKU[-_\s]*/i, '');
  const equalsSkuScan = (a?: string | null, b?: string | null) => {
    const na = normalizeScan(a);
    const nb = normalizeScan(b);
    if (!na || !nb) return false;
    if (na === nb) return true;
    return normalizeSkuScan(na) === normalizeSkuScan(nb);
  };

  const resolveProductForItem = useCallback(
    (item: { productId?: string | null; sku?: string | null; ean?: string | null }) => {
      if (item.productId) {
        const byId = products.find((p) => p.id === item.productId);
        if (byId) return byId;
      }
      const keys = [item.sku, item.ean].filter(Boolean).map((v) => normalizeSkuScan(String(v)));
      if (!keys.length) return null;
      return (
        products.find((p) => {
          const candidateValues = [
            p.identification?.sku,
            p.details?.identifiers?.sku,
            p.details?.identifiers?.ean,
            p.details?.identifiers?.gtin,
            p.details?.identifiers?.upc,
            p.id,
            ...(p.identification?.barcodes || []),
          ]
            .filter(Boolean)
            .map((val) => normalizeSkuScan(String(val)));
          return candidateValues.some((candidate) => keys.includes(candidate));
        }) || null
      );
    },
    [products]
  );

  const getAdjustedBinQty = useCallback(
    (productId: string, binCode: string, baseQty: number) => {
      const key = `${productId}::${binCode.toUpperCase()}`;
      const picked = Number(pickedFromBin[key] || 0) || 0;
      return Math.max(0, (Number(baseQty) || 0) - picked);
    },
    [pickedFromBin]
  );

  const pickTasks = useMemo(() => {
    const tasks: MobilePickTask[] = [];

    const chooseBestBin = (product: Product | null) => {
      if (!product) return null;
      const bins = Array.isArray(product.storageBins) ? product.storageBins : [];
      const positive = bins
        .filter((b) => b && b.code && Number(b.quantity || 0) > 0)
        .map((b) => ({
          code: String(b.code).toUpperCase(),
          quantity: getAdjustedBinQty(product.id, String(b.code), Number(b.quantity || 0) || 0),
        }))
        .filter((b) => b.quantity > 0);
      if (positive.length) {
        positive.sort((a, b) => (b.quantity - a.quantity) || compareBinCodesForPickRoute(a.code, b.code));
        return positive[0];
      }
      if (product.storage?.binCode) {
        const base = Number(product.storage.quantity || 0) || 0;
        return { code: String(product.storage.binCode).toUpperCase(), quantity: getAdjustedBinQty(product.id, String(product.storage.binCode), base) };
      }
      return null;
    };

    openOrders.forEach((order) => {
      order.items.forEach((it) => {
        const itemId = it.id;
        const pickedSoFar = Number(pickedByItemId[itemId] || 0) || 0;
        const total = Number(it.quantity || 0) || 0;
        const remainingTotal = Math.max(0, total - pickedSoFar);
        if (!remainingTotal) return;

        const product = resolveProductForItem(it);
        const hint = it.pickHint as any;

        const skuCandidate =
          normalizeScan(it.sku) ||
          normalizeScan(hint?.sku) ||
          normalizeScan(it.ean) ||
          normalizeScan(product?.details?.identifiers?.sku) ||
          normalizeScan(product?.identification?.sku) ||
          normalizeScan(product?.details?.identifiers?.ean) ||
          normalizeScan(product?.details?.identifiers?.gtin) ||
          normalizeScan(product?.id) ||
          itemId;

        const bestBin =
          chooseBestBin(product) ||
          (hint?.binCode ? { code: String(hint.binCode).toUpperCase(), quantity: Number(hint.quantityAvailable || 0) || 0 } : null);

        const binCode = bestBin?.code || '';
        const availableInBin = Number.isFinite(Number(bestBin?.quantity)) ? Number(bestBin?.quantity || 0) : null;
        const suggestedQty =
          typeof availableInBin === 'number' && availableInBin > 0
            ? Math.max(1, Math.min(remainingTotal, availableInBin))
            : Math.max(1, remainingTotal);

        tasks.push({
          orderId: order.id,
          orderNumber: order.number,
          itemId,
          name: hint?.productName || product?.identification?.name || it.name,
          sku: skuCandidate,
          binCode,
          suggestedQty,
          remainingTotal,
          itemTotal: total,
          pickedSoFar,
          productId: (product?.id || hint?.productId || it.productId || null) as any,
          availableInBin: typeof availableInBin === 'number' ? availableInBin : null,
        });
        });
    });

    tasks.sort((a, b) => compareBinCodesForPickRoute(a.binCode, b.binCode));
    return tasks;
  }, [openOrders, pickedByItemId, resolveProductForItem, getAdjustedBinQty]);

  const packItems = useMemo(() => {
    const ready = readyToPackOrders;
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
  }, [readyToPackOrders]);

  const equalsIgnoreCase = useCallback(
    (a?: string | null, b?: string | null) => normalizeScan(a) === normalizeScan(b),
    []
  );

  useEffect(() => {
    const stillOpenItemIds = new Set<string>();
    openOrders.forEach((o) => o.items.forEach((it) => stillOpenItemIds.add(it.id)));

    setPickedByItemId((prev) => {
      const next: Record<string, number> = {};
      Object.entries(prev).forEach(([id, qty]) => {
        if (stillOpenItemIds.has(id)) next[id] = qty;
      });
      return next;
    });

    if (pendingPick && !stillOpenItemIds.has(pendingPick.itemId)) {
      setPendingPick(null);
      setPendingPickQty(1);
      setHighlightKey(null);
      setActiveBin('');
      setActiveSku('');
    }
  }, [openOrders]);

  const submitPick = useCallback(
    async (task: MobilePickTask, qty: number) => {
      const numeric = Number(qty);
      if (!Number.isFinite(numeric) || numeric <= 0) return;
      if (numeric > task.remainingTotal) {
        setPickMessage(
          t('ops.mobile.pick.errorQtyExceedsRemaining', { qty: numeric, remaining: task.remainingTotal })
        );
        return;
      }
      if (typeof task.availableInBin === 'number' && Number.isFinite(task.availableInBin) && numeric > task.availableInBin) {
        setPickMessage(t('ops.mobile.pick.errorNotEnoughInBin', { available: task.availableInBin }));
        return;
      }

      try {
        const stockResult = await stockOutProduct({
          productId: task.productId || undefined,
          sku: task.sku,
          binCode: task.binCode,
          quantity: numeric,
          orderId: task.orderId,
          orderItemId: task.itemId,
          meta: { flow: 'pick', orderId: task.orderId, orderItemId: task.itemId },
        });
        if (!stockResult.ok) {
          throw new Error(stockResult.error?.message || t('ops.errors.pick'));
        }

        const newPickedForItem = Math.min(task.itemTotal, task.pickedSoFar + numeric);
        setPickedByItemId((prev) => ({
          ...prev,
          [task.itemId]: Math.min(task.itemTotal, (Number(prev[task.itemId] || 0) || 0) + numeric),
        }));
        if (task.productId && task.binCode) {
          const key = `${task.productId}::${task.binCode.toUpperCase()}`;
          setPickedFromBin((prev) => ({
            ...prev,
            [key]: (Number(prev[key] || 0) || 0) + numeric,
          }));
        }

        const targetOrder = openOrders.find((o) => o.id === task.orderId) || null;
        const isOrderDone = targetOrder
          ? targetOrder.items.every((it) => {
              const total = Number(it.quantity || 0) || 0;
              const picked =
                it.id === task.itemId ? newPickedForItem : Number(pickedByItemId[it.id] || 0) || 0;
              return picked >= total;
            })
          : false;

        if (isOrderDone) {
          await completeOrder(task.orderId);
          setPickMessage(
            t('ops.mobile.pick.successOrderDone', {
              bin: task.binCode,
              sku: task.sku,
              qty: numeric,
              order: task.orderNumber || task.orderId,
            })
          );
        } else {
          setPickMessage(
            t('ops.mobile.pick.success', {
              bin: task.binCode,
              sku: task.sku,
              qty: numeric,
              remaining: Math.max(0, task.remainingTotal - numeric),
            })
          );
        }
      } catch (err: any) {
        console.error('Pick failed', err);
        setPickMessage(
          t('ops.mobile.pick.errorGeneric', { message: err?.message || t('common.unknownError') })
        );
      }

      await refreshOrders();
      setPendingPick(null);
      setPendingPickQty(1);
      setActiveBin('');
      setActiveSku('');
      setHighlightKey(null);
    },
    [openOrders, pickedByItemId, refreshOrders, t]
  );
  const resolveProductForStow = useCallback(
    (skuValue: string) => {
      const needle = normalizeScan(skuValue);
      if (!needle) return null;
      return (
        products.find((p) => normalizeScan(p.identification?.sku || p.details?.identifiers?.sku || '') === needle) ||
        products.find((p) =>
          (p.identification?.barcodes || []).some((bc) => normalizeScan(bc) === needle)
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
      meta: { flow: 'stow' },
    };
    const result = await stockInProduct(payload);
    if (!result.ok) {
      setStowMessage(result.error?.message || t('ops.errors.stow'));
      return;
    }
    setStowEntries((prev) => [...prev, { sku: stowSku, bin: stowBin, qty: stowQty }]);
    setStowedSkus((prev) => {
      const next = new Set(prev);
      next.add(normalizeScan(stowSku));
      return next;
    });
    setStowMessage(
      t('ops.status.stowSuccess', { name: productMatch?.identification?.name || stowSku })
    );
    setStowSku('');
    setStowBin('');
    setStowQty(1);
  }, [resolveProductForStow, stowBin, stowQty, stowSku, t]);

  const handleScannedValue = useCallback(
    (value: string) => {
      const rawTrimmed = value.trim();
      if (!rawTrimmed) return;

      if (mode === 'operations-stow') {
        const numeric = /^\d+$/;
        if (!stowSku && !numeric.test(rawTrimmed)) {
          setStowSku(rawTrimmed);
          return;
        }
        if (stowSku && !stowBin && !numeric.test(rawTrimmed)) {
          setStowBin(rawTrimmed);
          return;
        }
        if (numeric.test(rawTrimmed)) {
          const n = Number(rawTrimmed);
          if (Number.isFinite(n) && n > 0) {
            setStowQty(n);
            setTimeout(handleSubmitStow, 0);
          }
        }
        return;
      }

      // PACK flow
      if (mode === 'operations-pack') {
        const normalized = normalizeScan(rawTrimmed);
        if (!normalized) return;

        const matches: Array<{ orderId: string; orderNumber?: string | null }> = [];
        const seen = new Set<string>();
        for (const o of readyToPackOrders) {
          const hit = o.items.some((it) => equalsSkuScan(it.sku || '', normalized) || equalsSkuScan(it.ean || '', normalized));
          if (!hit) continue;
          const key = String(o.id);
          if (seen.has(key)) continue;
          seen.add(key);
          matches.push({ orderId: o.id, orderNumber: o.number });
        }

        if (matches.length === 0) {
          setPackMessage(t('ops.mobile.pack.scan.notFound', { sku: rawTrimmed }));
          return;
        }
        if (matches.length > 1) {
          setPackMessage(t('ops.mobile.pack.scan.ambiguous', { sku: rawTrimmed, count: matches.length }));
          return;
        }

        const target = matches[0];
        setPackMessage(null);
        void (async () => {
          try {
            await packOrder(target.orderId);
            setPackMessage(
              t('ops.mobile.pack.scan.success', {
                order: target.orderNumber || target.orderId,
                sku: rawTrimmed,
              })
            );
          } catch (err: any) {
            setPackMessage(t('ops.mobile.pack.scan.error', { message: err?.message || t('common.unknownError') }));
          }
          await refreshOrders();
        })();
        return;
      }

      // PICK flow
      const normalized = normalizeScan(rawTrimmed);
      if (!normalized) return;
      const isNumericOnly = /^\d+$/.test(normalized);

      // If a pick task is already selected, interpret a numeric scan as quantity and execute immediately.
      if (pendingPick) {
        if (isNumericOnly) {
          const n = Number(normalized);
          if (Number.isFinite(n) && n > 0) {
            void submitPick(pendingPick, n);
          }
          return;
        }
        // Any non-numeric scan resets the pending pick selection (user started scanning next task)
        setPendingPick(null);
        setPendingPickQty(1);
      }

      let nextBin = activeBin;
      let nextSku = activeSku;

      const binMatches = pickTasks.filter((it) => equalsIgnoreCase(it.binCode, normalized));
      const skuMatches = pickTasks.filter((it) => equalsSkuScan(it.sku, normalized));

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
          return (
            pickTasks.find((it) => equalsIgnoreCase(it.binCode, nextBin) && equalsSkuScan(it.sku, nextSku)) ||
            null
          );
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
        const key = `${candidate.orderId}-${candidate.itemId}-${candidate.binCode}`;
        setHighlightKey(key);
        setPendingPick(candidate);
        setPendingPickQty(candidate.suggestedQty || 1);
      }
    },
    [
      activeBin,
      activeSku,
      equalsIgnoreCase,
      pickTasks,
      pendingPick,
      submitPick,
      handleSubmitStow,
      stowBin,
      stowQty,
      stowSku,
      equalsSkuScan,
      mode,
      readyToPackOrders,
      refreshOrders,
      t,
    ]
  );
  useEffect(() => {
    const bufferRef = { current: '' };

    const onKeyDown = (e: KeyboardEvent) => {
      if (mode !== 'operations-pick' && mode !== 'operations-stow' && mode !== 'operations-pack') return;
      const target = e.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA'].includes(target.tagName)) {
        const anyTarget = target as any;
        const readOnly = Boolean(anyTarget?.readOnly);
        // Allow scanner input even if a readOnly field has focus (common on Android handheld scanners).
        if (!readOnly) return;
      }

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
      <div className="space-y-4 max-w-xl mx-auto">
        <div className="flex items-center justify-between">
          <SectionTitle title={t('ops.mode.identify')} desc={t('ops.mode.identify.subtitle')} />
          <button
            type="button"
            className="rounded-full bg-slate-800 text-white px-3 py-2 text-sm font-semibold border border-slate-700"
            onClick={addIdentifySlot}
          >
            + {t('common.add')}
          </button>
        </div>
        <div className="grid grid-cols-1 gap-3">
          {identifySlots.map((slot) => (
            <div key={slot} className="rounded-2xl border border-dashed border-white/15 bg-slate-800/70 p-4 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-semibold text-slate-100">
                  {t('input.groups.defaultName', { index: identifySlots.indexOf(slot) + 1 })}
                </p>
                <button
                  type="button"
                  className="rounded-full bg-slate-900/60 border border-slate-700 text-slate-100 px-3 py-1.5 text-xs font-semibold disabled:opacity-40"
                  onClick={() => clearIdentifySlot(slot)}
                  disabled={!identifyImagesBySlot[slot]?.length}
                >
                  {t('common.clear')}
                </button>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  className="rounded-2xl bg-sky-600 text-white font-semibold py-3"
                  onClick={() => triggerIdentifyInput(slot, 'camera')}
                >
                  {t('common.camera')}
                </button>
                <button
                  type="button"
                  className="rounded-2xl bg-slate-800 text-slate-100 font-semibold py-3 border border-slate-700"
                  onClick={() => triggerIdentifyInput(slot, 'upload')}
                >
                  {t('common.upload')}
                </button>
              </div>
              {identifyImagesBySlot[slot]?.length ? (
                <div className="space-y-2">
                  <p className="text-xs text-slate-400">{t('identifyQueue.files', { count: identifyImagesBySlot[slot].length })}</p>
                  <div className="grid grid-cols-4 gap-2">
                    {identifyImagesBySlot[slot].slice(0, 8).map((img) => (
                      <img
                        key={img.id}
                        src={img.previewUrl}
                        alt=""
                        className="w-full aspect-square object-cover rounded-lg border border-slate-700"
                        loading="lazy"
                      />
                    ))}
                  </div>
                </div>
              ) : null}
              <input
                ref={(el) => {
                  cameraInputRefs.current[slot] = el;
                }}
                type="file"
                accept="image/*"
                capture="environment"
                multiple
                className="hidden"
                onChange={(e) => {
                  handleIdentifyFilesSelected(slot, e.currentTarget.files);
                  // allow re-selecting the same image(s)
                  e.currentTarget.value = '';
                }}
              />
              <input
                ref={(el) => {
                  uploadInputRefs.current[slot] = el;
                }}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => {
                  handleIdentifyFilesSelected(slot, e.currentTarget.files);
                  e.currentTarget.value = '';
                }}
              />
              <button
                type="button"
                className="w-full rounded-2xl bg-emerald-600 text-white font-semibold py-3 disabled:opacity-40"
                disabled={!identifyImagesBySlot[slot]?.length}
                onClick={() => {
                  const images = (identifyImagesBySlot[slot] || []).map((img) => img.file);
                  if (!images.length) return;
                  const index = identifySlots.indexOf(slot) + 1;
                  const payload: UploadGroupPayload[] = [
                    { id: `mobile-slot-${slot}`, label: t('input.groups.defaultName', { index }), images },
                  ];
                  if (onIdentify) {
                    onIdentify(payload, '');
                    clearIdentifySlot(slot);
                  } else {
                    onNavigate('input');
                  }
                }}
              >
                {t('ops.identify.run')}
              </button>
            </div>
          ))}
        </div>
        <p className="text-xs text-slate-400">
          {t('ops.mobile.identify.hint')}
        </p>
      </div>
    );
  }

  if (mode === 'operations-stow') {
    const showKeypad = Boolean(stowSku && stowBin);
    return (
      <div className="space-y-3 max-w-xl mx-auto">
        <SectionTitle title={t('ops.mode.stow')} desc={t('ops.mode.stow.subtitle')} />
        <div className="rounded-2xl border border-white/10 bg-slate-800/70 p-3 space-y-2">
          <p className="text-xs text-slate-300">
            {t('ops.mobile.stow.flowHelp')}
          </p>
          {stowMessage && <p className="text-xs text-emerald-300">{stowMessage}</p>}
          <div className="grid grid-cols-2 gap-2 text-sm text-slate-200">
            <div className="rounded-xl bg-slate-900/60 border border-white/10 p-2">
              <p className="text-[11px] uppercase tracking-widest text-slate-400">{t('common.sku')}</p>
              <p className="text-base font-semibold break-all">{stowSku || '—'}</p>
            </div>
            <div className="rounded-xl bg-slate-900/60 border border-white/10 p-2">
              <p className="text-[11px] uppercase tracking-widest text-slate-400">{t('common.bin')}</p>
              <p className="text-base font-semibold break-all">{stowBin || '—'}</p>
            </div>
          </div>
          {showKeypad && (
            <div className="rounded-xl bg-slate-900/60 border border-white/10 p-3 space-y-3">
              <p className="text-[11px] uppercase tracking-widest text-slate-400">{t('ops.mobile.qtyScannerOrPad')}</p>
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
                  {t('common.clear')}
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
              {t('ops.stow.submit')}
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
              {t('common.reset')}
            </button>
          </div>
        </div>

        {stowEntries.length > 0 && (
          <div className="rounded-2xl border border-white/10 bg-slate-800/70 p-3 space-y-2">
            <p className="text-sm font-semibold text-white">{t('ops.mobile.stow.sessionTitle')}</p>
            <div className="space-y-2">
              {stowEntries.map((entry, idx) => (
                <div key={`${entry.sku}-${entry.bin}-${idx}`} className="rounded-xl border border-white/10 bg-slate-900/60 p-2 text-sm text-slate-200">
                  <div className="flex justify-between gap-2">
                    <span className="font-semibold break-all">{entry.sku}</span>
                    <span className="text-slate-300">
                      {t('common.qty')} {entry.qty}
                    </span>
                  </div>
                  <p className="text-xs text-slate-400 break-all">
                    {t('common.bin')} {entry.bin}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  if (mode === 'operations-pick') {
    const nextTask = pickTasks[0] || null;
    return (
      <div className="space-y-3 max-w-xl mx-auto">
        <SectionTitle title={t('ops.mode.pick')} desc={`${t('ops.orders.open')} · BaseLinker`} />
        <div className="rounded-2xl border border-white/10 bg-slate-800/70 p-3 space-y-2">
          <p className="text-xs text-slate-300">
            {t('ops.mobile.pick.flowHelp')}
          </p>
          <div className="text-xs text-slate-400 flex flex-wrap gap-2">
            <span className="px-2 py-1 rounded-full border border-white/10 bg-white/5">
              {t('common.bin')}: {activeBin || '—'}
            </span>
            <span className="px-2 py-1 rounded-full border border-white/10 bg-white/5">
              {t('common.sku')}: {activeSku || '—'}
            </span>
            <span className="px-2 py-1 rounded-full border border-white/10 bg-white/5">
              {t('ops.mobile.scannerFocusHint')}
            </span>
          </div>
          {nextTask && !pendingPick && (
            <p className="text-xs text-slate-300">
              {t('ops.labels.nextPick')}:{' '}
              <span className="text-slate-100 font-semibold">{nextTask.binCode || '—'}</span> ·{' '}
              <span className="text-slate-100 font-semibold">{nextTask.sku}</span> ·{' '}
              <span className="text-slate-100 font-semibold">
                {t('ops.labels.openRemaining', { count: nextTask.remainingTotal })}
              </span>
            </p>
          )}
          {pickMessage && <p className="text-xs text-emerald-300">{pickMessage}</p>}
        </div>
        {ordersLoading && <p className="text-sm text-slate-400">{t('ops.orders.loading')}</p>}
        {pendingPick && (
          <div className="rounded-2xl border border-sky-500 bg-sky-900/20 p-3 space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1">
                <p className="text-sm font-semibold text-white line-clamp-2">{pendingPick.name}</p>
                <p className="text-xs text-slate-300">
                  {t('common.order')} {pendingPick.orderNumber || pendingPick.orderId} · {t('common.sku')} {pendingPick.sku} · {t('common.bin')}{' '}
                  {pendingPick.binCode || '—'}
                </p>
                <p className="text-xs text-slate-300">
                  <span className="font-semibold text-white">
                    {t('ops.labels.openRemaining', { count: pendingPick.remainingTotal })}
                  </span>{' '}
                  {typeof pendingPick.availableInBin === 'number' ? (
                    <>
                      ·{' '}
                      <span className="font-semibold text-white">
                        {t('ops.mobile.availableInBin', { value: pendingPick.availableInBin })}
                      </span>
                    </>
                  ) : null}
                </p>
              </div>
              <StatusBadge label={t('ops.badge.pick')} tone="warn" />
            </div>

            <div className="rounded-xl bg-slate-900/60 border border-white/10 p-3 space-y-3">
              <p className="text-[11px] uppercase tracking-widest text-slate-400">{t('ops.mobile.pick.qtyPadHint')}</p>
              <div className="flex items-center gap-2">
                <div className="flex-1 rounded-lg bg-slate-800 text-white text-2xl font-semibold px-3 py-2 border border-slate-700">
                  {pendingPickQty}
                </div>
                <button
                  type="button"
                  className="rounded-lg px-3 py-2 bg-slate-700 text-white text-sm font-semibold"
                  onClick={() => setPendingPickQty(0)}
                >
                  {t('common.clear')}
                </button>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
                  <button
                    key={n}
                    type="button"
                    className="rounded-lg bg-slate-800 text-white text-xl font-semibold py-3"
                    onClick={() => setPendingPickQty((prev) => Number(`${prev}${n}`))}
                  >
                    {n}
                  </button>
                ))}
                <button
                  type="button"
                  className="rounded-lg bg-slate-800 text-white text-lg font-semibold py-3"
                  onClick={() => setPendingPickQty((prev) => Math.max(0, Math.floor(prev / 10)))}
                >
                  ⌫
                </button>
                <button
                  type="button"
                  className="rounded-lg bg-slate-800 text-white text-xl font-semibold py-3"
                  onClick={() => setPendingPickQty((prev) => Number(`${prev}0`))}
                >
                  0
                </button>
                <button
                  type="button"
                  className="rounded-lg bg-slate-800 text-white text-lg font-semibold py-3"
                  onClick={() => setPendingPickQty(pendingPick.suggestedQty || 1)}
                >
                  {t('ops.orders.auto')}
                </button>
              </div>
            </div>

            <div className="sticky bottom-0 z-10 -mx-3 px-3 pt-2 pb-[calc(env(safe-area-inset-bottom)+12px)] bg-slate-950/85 backdrop-blur border-t border-white/10">
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  disabled={!pendingPickQty || pendingPickQty <= 0}
                  onClick={() => void submitPick(pendingPick, pendingPickQty)}
                  className="rounded-lg bg-emerald-600 text-white font-semibold py-3 disabled:opacity-40"
                >
                  {t('ops.pick.submit')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setPendingPick(null);
                    setPendingPickQty(1);
                    setActiveBin('');
                    setActiveSku('');
                    setHighlightKey(null);
                  }}
                  className="rounded-lg bg-slate-700 text-white font-semibold py-3"
                >
                  {t('common.cancel')}
                </button>
              </div>
            </div>
          </div>
        )}

        {pickTasks.length === 0 && !ordersLoading && <p className="text-sm text-slate-400">{t('ops.orders.none')}</p>}
        {pickTasks.slice(0, 100).map((task) => {
          const key = `${task.orderId}-${task.itemId}-${task.binCode}`;
          const isHighlighted = highlightKey === key;
          return (
            <button
              type="button"
              key={key}
              onClick={() => {
                setPendingPick(task);
                setPendingPickQty(task.suggestedQty || 1);
                setActiveBin(task.binCode || '');
                setActiveSku(task.sku || '');
                setHighlightKey(key);
              }}
              className={`w-full text-left rounded-2xl border p-3 shadow-sm shadow-black/20 ${
                isHighlighted ? 'border-sky-500 bg-sky-900/30' : 'border-white/5 bg-slate-800'
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1">
                  <p className="text-sm font-semibold text-white line-clamp-2">{task.name}</p>
                  <p className="text-xs text-slate-400">
                    {t('common.order')} {task.orderNumber || task.orderId} · {t('common.sku')} {task.sku} · {t('common.bin')}{' '}
                    {task.binCode || '—'}
                  </p>
                  <p className="text-xs text-slate-400">
                    {t('ops.labels.openRemaining', { count: task.remainingTotal })} · {t('ops.pick.quantityHint', { value: task.suggestedQty })}
                    {typeof task.availableInBin === 'number' ? ` · ${t('ops.mobile.availableInBin', { value: task.availableInBin })}` : ''}
                  </p>
                </div>
                <StatusBadge label={task.binCode || t('ops.badge.pick')} tone={isHighlighted ? 'warn' : 'success'} />
              </div>
            </button>
          );
        })}
      </div>
    );
  }

  if (mode === 'operations-pack') {
    return (
      <div className="space-y-3 max-w-xl mx-auto">
        <SectionTitle title={t('ops.mode.pack')} desc={t('ops.mode.pack.subtitle')} />
        {packMessage ? (
          <div className="rounded-2xl border border-white/10 bg-slate-900/40 p-3 text-sm text-slate-200">
            {packMessage}
          </div>
        ) : null}
        {ordersLoading && <p className="text-sm text-slate-400">{t('ops.orders.loading')}</p>}
        {packItems.length === 0 && !ordersLoading && <p className="text-sm text-slate-400">{t('ops.mobile.pack.none')}</p>}
        {packItems.slice(0, 100).map((item) => (
          <div key={`${item.orderId}-${item.sku}`} className="rounded-2xl border border-white/5 bg-slate-800 p-3 shadow-sm shadow-black/20">
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1">
                <p className="text-sm font-semibold text-white line-clamp-2">{item.name}</p>
                <p className="text-xs text-slate-400">
                  {t('common.sku')} {item.sku || '—'} · {t('common.bin')} {item.binCode || '—'}
                </p>
                <p className="text-xs text-slate-400">
                  {t('common.qty')} {item.qty}
                </p>
              </div>
              <StatusBadge label={t('ops.badge.pack')} tone="warn" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  // Hub
  return (
    <div className="space-y-4 max-w-xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-white">{t('ops.title')}</h1>
          <p className="text-slate-400 text-sm">{t('ops.subtitle')}</p>
        </div>
        <div className="text-right text-xs text-slate-400 space-y-0.5">
          <p>
            {t('ops.mode.stow')}: {stowList.length}
          </p>
          <p>
            {t('ops.mode.pick')}: {pickList.length}
          </p>
          <p>
            {t('ops.mode.pack')}: {packList.length}
          </p>
        </div>
      </div>
      <div className="flex flex-col gap-3">
        <button
          type="button"
          className="w-full rounded-2xl bg-sky-600 text-white font-semibold py-4 text-lg"
          onClick={() => onNavigate('operations-identify')}
        >
          {t('ops.mode.identify')}
        </button>
        <button
          type="button"
          className="w-full rounded-2xl bg-emerald-600 text-white font-semibold py-4 text-lg"
          onClick={() => onNavigate('operations-stow')}
        >
          {t('ops.mode.stow')}
        </button>
        <button
          type="button"
          className="w-full rounded-2xl bg-amber-600 text-white font-semibold py-4 text-lg"
          onClick={() => onNavigate('operations-pick')}
        >
          {t('ops.mode.pick')}
        </button>
        <button
          type="button"
          className="w-full rounded-2xl bg-slate-700 text-white font-semibold py-4 text-lg"
          onClick={() => onNavigate('operations-pack')}
        >
          {t('ops.mode.pack')}
        </button>
      </div>
    </div>
  );
};

export default MobileOperationsView;

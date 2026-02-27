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
  orderCreatedAt?: string | null;
  itemId: string;
  name: string;
  sku: string;
  binCode: string;
  thumbnailUrl?: string | null;
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
        : 'bg-slate-800/60 text-slate-200 border-white/10';
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold border ${toneClasses}`}>
      {label}
    </span>
  );
};

const ProductCard: React.FC<{ product: Product; footer?: React.ReactNode }> = ({ product, footer }) => {
  const { t } = useI18n();
  return (
  <div className="w-full text-left rounded-2xl bg-slate-800/40 border border-white/10 p-3 flex gap-3">
    <div className="w-12 h-12 rounded-xl bg-slate-800/60 overflow-hidden flex items-center justify-center">
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
  const [ordersError, setOrdersError] = useState<string | null>(null);
  const [activeBin, setActiveBin] = useState('');
  const [activeSku, setActiveSku] = useState('');
  const [highlightKey, setHighlightKey] = useState<string | null>(null);
  const [pickMessage, setPickMessage] = useState<string | null>(null);
  const [pickMessageTone, setPickMessageTone] = useState<'info' | 'success' | 'error' | null>(null);
  const [packMessage, setPackMessage] = useState<string | null>(null);
  const [packScopedOrderKey, setPackScopedOrderKey] = useState<string | null>(null);
  const [packSelectedKey, setPackSelectedKey] = useState<string | null>(null);
  // Mobile pick progress (supports partial picks across bins)
  const [pickedByItemId, setPickedByItemId] = useState<Record<string, number>>({});
  // Local bin deltas to avoid stale product data causing repeated picks from the same BIN
  const [pickedFromBin, setPickedFromBin] = useState<Record<string, number>>({}); // key: `${productId}::${BIN}` -> pickedQty
  const [pendingPick, setPendingPick] = useState<MobilePickTask | null>(null);
  const [pendingPickQty, setPendingPickQty] = useState<number>(0);

  const [identifySlots, setIdentifySlots] = useState<number[]>([0]);
  const uploadInputRefs = useRef<Record<number, HTMLInputElement | null>>({});
  const cameraInputRefs = useRef<Record<number, HTMLInputElement | null>>({});
  const isUnmountedRef = useRef(false);
  const pickSubmitInFlightRef = useRef(false);

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

  const normalizeScan = (val?: string | null) => (val || '').replace(/\s+/g, '').toUpperCase();
  const normalizeSkuScan = (val?: string | null) => normalizeScan(val).replace(/^SKU[-_\s]*/i, '');

  const getOrderSourceId = useCallback((order: Order) => {
    const top = order.orderSourceId;
    if (top != null && String(top).trim()) return String(top).trim();
    const raw = (order as any)?.raw?.order_source_id;
    if (raw != null && String(raw).trim()) return String(raw).trim();
    return null;
  }, []);

  const getOrderSource = useCallback((order: Order) => {
    const top = order.orderSource;
    if (top != null && String(top).trim()) return String(top).trim();
    const raw = (order as any)?.raw?.order_source;
    if (raw != null && String(raw).trim()) return String(raw).trim();
    return null;
  }, []);

  const getOrderCouplingKey = useCallback(
    (order: Order) => {
      const src = (getOrderSource(order) || '-').toString().trim() || '-';
      const srcId = (getOrderSourceId(order) || '-').toString().trim() || '-';
      const orderId = (order.baselinkerId || order.id || '').toString().trim();
      return order.baselinkerOrderKey || `${orderId}::${src}::${srcId}`;
    },
    [getOrderSource, getOrderSourceId]
  );

  const dedupeOrders = useCallback(
    (list: Order[]) => {
      const seen = new Set<string>();
      const result: Order[] = [];
      list.forEach((order) => {
        const key = getOrderCouplingKey(order);
        if (seen.has(key)) return;
        seen.add(key);
        result.push(order);
      });
      return result;
    },
    [getOrderCouplingKey]
  );

  const refreshOrders = useCallback(
    async (isCancelled?: () => boolean) => {
      if (isCancelled?.()) return;
      setOrdersLoading(true);
      setOrdersError(null);
      try {
        try {
          await syncOrdersApi({ timeoutMs: 20000 });
        } catch (err) {
          console.warn('Order sync failed (will still fetch)', err);
        }
        const data = await fetchOrdersApi(100, { timeoutMs: 20000 });
        if (!isCancelled?.() && !isUnmountedRef.current) {
          setOrders(dedupeOrders(data || []));
        }
      } catch (err) {
        console.warn('Failed to load orders', err);
        if (!isCancelled?.() && !isUnmountedRef.current) {
          setOrdersError((err as any)?.message || t('common.unknownError'));
        }
      } finally {
        if (!isCancelled?.() && !isUnmountedRef.current) setOrdersLoading(false);
      }
    },
    [dedupeOrders, t]
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
    // Safety gate:
    // Pack flow must only contain BaseLinker status "Kommissioniert".
    // Explicitly exclude "Verpackt"/shipped/cancelled labels so packed orders never reappear here.
    const isCancelled = (label?: string | null) => {
      const raw = (label || '').toLowerCase();
      return raw.includes('storniert') || raw.includes('cancel');
    };
    const isPackedOrBeyond = (label?: string | null) => {
      const raw = (label || '').toLowerCase();
      return (
        raw.includes('verpackt') ||
        raw.includes('packed') ||
        raw.includes('versendet') ||
        raw.includes('shipped') ||
        raw.includes('zugestellt') ||
        raw.includes('delivered')
      );
    };
    const filtered = orders.filter((o) => {
      const label = (o.statusLabel || '').toLowerCase();
      const isKommissioniert = label.includes('kommissioniert');
      return o.status === 'picked' && isKommissioniert && !isCancelled(label) && !isPackedOrBeyond(label);
    });
    // Stable processing order to keep scanner behavior deterministic.
    return filtered.sort((a, b) => {
      const aTs = Date.parse(a.createdAt || '') || 0;
      const bTs = Date.parse(b.createdAt || '') || 0;
      if (aTs !== bTs) return aTs - bTs;
      return getOrderCouplingKey(a).localeCompare(getOrderCouplingKey(b));
    });
  }, [orders, getOrderCouplingKey]);

  useEffect(() => {
    if (!packScopedOrderKey) return;
    const exists = readyToPackOrders.some((order) => getOrderCouplingKey(order) === packScopedOrderKey);
    if (!exists) {
      setPackScopedOrderKey(null);
      setPackSelectedKey(null);
    }
  }, [packScopedOrderKey, readyToPackOrders, getOrderCouplingKey]);
  const equalsSkuScan = (a?: string | null, b?: string | null) => {
    const na = normalizeScan(a);
    const nb = normalizeScan(b);
    if (!na || !nb) return false;
    if (na === nb) return true;
    return normalizeSkuScan(na) === normalizeSkuScan(nb);
  };

  const isOrderIdentityScanMatch = useCallback(
    (order: Order, rawScan: string) => {
      const scan = normalizeScan(rawScan);
      if (!scan) return false;
      const sourceId = getOrderSourceId(order);
      const orderId = (order.baselinkerId || order.id || '').toString().trim();
      const candidates = new Set(
        [
          orderId,
          order.number || '',
          sourceId || '',
          sourceId ? `${orderId}-${sourceId}` : '',
          sourceId ? `${orderId}/${sourceId}` : '',
          (order as any)?.raw?.external_order_id || '',
          (order as any)?.raw?.shop_order_id || '',
          (order as any)?.raw?.delivery_package_nr || '',
        ]
          .map((v) => normalizeScan(String(v || '')))
          .filter(Boolean)
      );
      return candidates.has(scan);
    },
    [getOrderSourceId]
  );

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

    // Allocate available BIN quantities across tasks deterministically so multiple orders
    // don't all "claim" the same BIN when stock is split (prevents impossible pick routes).
    const binPoolByProductId = new Map<string, Array<{ code: string; quantity: number }>>();

    const getBinPool = (product: Product): Array<{ code: string; quantity: number }> => {
      const cached = binPoolByProductId.get(product.id);
      if (cached) return cached;

      const bins = Array.isArray(product.storageBins) ? product.storageBins : [];
      const pool = bins
        .filter((b) => b && b.code && Number(b.quantity || 0) > 0)
        .map((b) => ({
          code: String(b.code).toUpperCase(),
          quantity: getAdjustedBinQty(product.id, String(b.code), Number(b.quantity || 0) || 0),
        }))
        .filter((b) => b.quantity > 0);

      if (!pool.length && product.storage?.binCode) {
        const base = Number(product.storage.quantity || 0) || 0;
        const adjusted = getAdjustedBinQty(product.id, String(product.storage.binCode), base);
        if (adjusted > 0) {
          pool.push({ code: String(product.storage.binCode).toUpperCase(), quantity: adjusted });
        }
      }

      pool.sort((a, b) => (b.quantity - a.quantity) || compareBinCodesForPickRoute(a.code, b.code));
      binPoolByProductId.set(product.id, pool);
      return pool;
    };

    const chooseAllocatableBin = (product: Product | null) => {
      if (!product) return null;
      const pool = getBinPool(product);
      if (!pool.length) return null;
      pool.sort((a, b) => (b.quantity - a.quantity) || compareBinCodesForPickRoute(a.code, b.code));
      return pool.find((b) => b.quantity > 0) || null;
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

        const allocatedBin = chooseAllocatableBin(product);
        const fallbackHintBin = hint?.binCode ? String(hint.binCode).toUpperCase() : '';
        const bestBin = allocatedBin || (fallbackHintBin ? { code: fallbackHintBin, quantity: Number(hint.quantityAvailable || 0) || 0 } : null);

        const binCode = bestBin?.code || '';
        const availableInBin = Number.isFinite(Number(bestBin?.quantity)) ? Number(bestBin?.quantity || 0) : null;
        const suggestedQty =
          typeof availableInBin === 'number' && availableInBin > 0
            ? Math.max(1, Math.min(remainingTotal, availableInBin))
            : Math.max(1, remainingTotal);

        if (allocatedBin) {
          allocatedBin.quantity = Math.max(0, allocatedBin.quantity - suggestedQty);
        }

        tasks.push({
          orderId: order.id,
          orderNumber: order.number,
          orderCreatedAt: order.createdAt || null,
          itemId,
          name: hint?.productName || product?.identification?.name || it.name,
          sku: skuCandidate,
          binCode,
          thumbnailUrl: product?.details?.images?.[0]?.url_or_base64 || null,
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
    const bucket: Record<
      string,
      {
        orderId: string;
        orderKey: string;
        orderNumber?: string | null;
        orderSourceId?: string | null;
        sku: string;
        ean?: string | null;
        name: string;
        thumbnailUrl?: string | null;
        productId?: string | null;
        binCode: string;
        qty: number;
      }
    > = {};
    ready.forEach((o) => {
      const orderKey = getOrderCouplingKey(o);
      const orderSourceId = getOrderSourceId(o);
      o.items.forEach((it) => {
        const product = resolveProductForItem(it);
        const sku = it.sku || it.id;
        const binCode = it.pickHint?.binCode || product?.storage?.binCode || '—';
        const key = `${orderKey}::${sku}::${binCode}`;
        const qty = Number.isFinite(it.quantity) ? it.quantity : 1;
        if (!bucket[key]) {
          bucket[key] = {
            orderId: o.id,
            orderKey,
            orderNumber: o.number || o.baselinkerId || o.id,
            orderSourceId,
            sku,
            ean: it.ean || null,
            name: product?.identification?.name || it.name,
            thumbnailUrl: product?.details?.images?.[0]?.url_or_base64 || null,
            productId: product?.id || it.productId || null,
            binCode,
            qty: 0,
          };
        }
        bucket[key].qty += qty;
      });
    });
    return Object.values(bucket).sort((a, b) => a.orderKey.localeCompare(b.orderKey));
  }, [readyToPackOrders, getOrderCouplingKey, getOrderSourceId, resolveProductForItem]);

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
      setPendingPickQty(0);
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
        setPickMessageTone('error');
        return;
      }
      if (typeof task.availableInBin === 'number' && Number.isFinite(task.availableInBin) && numeric > task.availableInBin) {
        setPickMessage(t('ops.mobile.pick.errorNotEnoughInBin', { available: task.availableInBin }));
        setPickMessageTone('error');
        return;
      }

      if (pickSubmitInFlightRef.current) return;
      pickSubmitInFlightRef.current = true;
      try {
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

          // UI must stay fluid: never block on BaseLinker status updates or full order refresh.
          // We update UI immediately and sync order status in background if the order is complete.
          if (isOrderDone) {
            setPickMessage(
              t('ops.mobile.pick.successOrderDone', {
                bin: task.binCode,
                sku: task.sku,
                qty: numeric,
                order: task.orderNumber || task.orderId,
              })
            );
            setPickMessageTone('success');
            void completeOrder(task.orderId)
              .catch((err: any) => {
                console.warn('completeOrder failed (background):', err);
                setPickMessage(
                  t('ops.mobile.pick.errorGeneric', { message: err?.message || t('common.unknownError') })
                );
                setPickMessageTone('error');
              })
              .finally(() => {
                void refreshOrders();
              });
          } else {
            setPickMessage(
              t('ops.mobile.pick.success', {
                bin: task.binCode,
                sku: task.sku,
                qty: numeric,
                remaining: Math.max(0, task.remainingTotal - numeric),
              })
            );
            setPickMessageTone('success');
          }
        } catch (err: any) {
          console.error('Pick failed', err);
          setPickMessage(t('ops.mobile.pick.errorGeneric', { message: err?.message || t('common.unknownError') }));
          setPickMessageTone('error');
        }
        setPendingPick(null);
        setPendingPickQty(0);
        setActiveBin('');
        setActiveSku('');
        setHighlightKey(null);
      } finally {
        pickSubmitInFlightRef.current = false;
      }
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

        const orderIdentityMatches = readyToPackOrders.filter((o) => isOrderIdentityScanMatch(o, normalized));
        if (orderIdentityMatches.length === 1) {
          const selected = orderIdentityMatches[0];
          const selectedKey = getOrderCouplingKey(selected);
          setPackScopedOrderKey(selectedKey);
          setPackSelectedKey(null);
          setPackMessage(
            t('ops.mobile.pack.scan.orderSelected', {
              order: selected.number || selected.baselinkerId || selected.id,
            })
          );
          return;
        }
        if (orderIdentityMatches.length > 1) {
          setPackMessage(
            t('ops.mobile.pack.scan.orderAmbiguous', {
              value: rawTrimmed,
              count: orderIdentityMatches.length,
            })
          );
          return;
        }

        const scopedItems = packScopedOrderKey ? packItems.filter((it) => it.orderKey === packScopedOrderKey) : packItems;
        const candidates = scopedItems.filter(
          (it) => equalsSkuScan(it.sku || '', normalized) || equalsSkuScan(it.ean || '', normalized)
        );

        if (candidates.length === 0) {
          setPackMessage(t('ops.mobile.pack.scan.notFound', { sku: rawTrimmed }));
          return;
        }
        if (candidates.length > 1) {
          setPackMessage(t('ops.mobile.pack.scan.ambiguous', { sku: rawTrimmed, count: candidates.length }));
          return;
        }

        const item = candidates[0];
        setPackMessage(null);
        setPackScopedOrderKey(item.orderKey);
        setPackSelectedKey(`${item.orderKey}::${item.sku}::${item.binCode}`);
        return;
      }

      // PICK flow
      const normalized = normalizeScan(rawTrimmed);
      if (!normalized) return;
      const isNumericOnly = /^\d+$/.test(normalized);
      if (pickSubmitInFlightRef.current) {
        setPickMessage(t('ops.pick.submitting'));
        setPickMessageTone('info');
        return;
      }

      const binMatches = pickTasks.filter((it) => equalsIgnoreCase(it.binCode, normalized));
      const skuMatches = pickTasks.filter((it) => equalsSkuScan(it.sku, normalized));

      // If a pick task is already active:
      // - SKU scan confirms quantity (1 scan = qty 1).
      // - numeric scan is supported as an optional override (e.g. scan "3" to pick 3).
      if (pendingPick) {
        const targetQty = Math.max(1, Number(pendingPick.suggestedQty || 1) || 1);
        if (isNumericOnly) {
          const n = Number(normalized);
          if (Number.isFinite(n) && n > 0) {
            void submitPick(pendingPick, n);
          }
          return;
        }
        if (equalsSkuScan(pendingPick.sku, normalized)) {
          const nextCount = Math.min(targetQty, (Number(pendingPickQty || 0) || 0) + 1);
          setPendingPickQty(nextCount);
          setPickMessage(`SKU bestätigt: ${nextCount}/${targetQty}`);
          setPickMessageTone('info');
          if (nextCount >= targetQty) {
            void submitPick(pendingPick, nextCount);
          }
          return;
        }
        // Any other scan resets the pending pick selection (user started scanning another task)
        setPendingPick(null);
        setPendingPickQty(0);
        setHighlightKey(null);
      }

      if (binMatches.length === 0 && skuMatches.length === 0 && !isNumericOnly) {
        setPickMessage(t('ops.mobile.pick.scan.noMatch', { value: rawTrimmed }));
        setPickMessageTone('error');
        return;
      }

      // Clear any previous pick status when new scans come in.
      setPickMessage(null);
      setPickMessageTone(null);

      // BIN scan: lock BIN context, then wait for SKU scans.
      if (binMatches.length) {
        const nextBin = binMatches[0].binCode;
        setActiveBin(nextBin);
        setActiveSku('');
        setPickMessage(t('ops.mobile.pick.scan.needSku'));
        setPickMessageTone('info');
        return;
      }

      // SKU scan without BIN: instruct user to scan BIN first.
      if (!activeBin && skuMatches.length) {
        setActiveSku(skuMatches[0]?.sku || '');
        setPickMessage(t('ops.mobile.pick.scan.needBin'));
        setPickMessageTone('info');
        return;
      }

      // SKU scan with BIN: resolve exact task and start counting scans.
      if (activeBin && skuMatches.length) {
        const sku = skuMatches[0]?.sku || '';
        setActiveSku(sku);
        const matches = pickTasks.filter((it) => equalsIgnoreCase(it.binCode, activeBin) && equalsSkuScan(it.sku, sku));
        if (matches.length === 0) {
          setPickMessage(t('ops.mobile.pick.scan.noMatch', { value: rawTrimmed }));
          setPickMessageTone('error');
          return;
        }
        // If multiple orders contain the same SKU in the same BIN, pick the oldest order first (FIFO)
        // to keep the scanner flow unblocked and deterministic.
        const candidate =
          matches.length > 1
            ? [...matches].sort((a, b) => {
                const aTs = Date.parse(a.orderCreatedAt || '') || 0;
                const bTs = Date.parse(b.orderCreatedAt || '') || 0;
                if (aTs !== bTs) return aTs - bTs;
                const aOrder = (a.orderNumber || a.orderId || '').toString();
                const bOrder = (b.orderNumber || b.orderId || '').toString();
                if (aOrder !== bOrder) return aOrder.localeCompare(bOrder);
                return (a.itemId || '').localeCompare(b.itemId || '');
              })[0]
            : matches[0];
        const key = `${candidate.orderId}-${candidate.itemId}-${candidate.binCode}`;
        const targetQty = Math.max(1, Number(candidate.suggestedQty || 1) || 1);
        setHighlightKey(key);
        setPendingPick(candidate);
        setPendingPickQty(1); // the SKU scan itself confirms qty=1
        setPickMessage(`SKU bestätigt: 1/${targetQty}`);
        setPickMessageTone('info');
        if (targetQty <= 1) {
          void submitPick(candidate, 1);
        }
        return;
      }

      // Fallback (should be rare): ambiguous scans
      setPickMessage(t('ops.mobile.pick.scan.ambiguous'));
      setPickMessageTone('error');
    },
    [
      activeBin,
      activeSku,
      equalsIgnoreCase,
      pickTasks,
      pendingPick,
      pendingPickQty,
      submitPick,
      handleSubmitStow,
      stowBin,
      stowQty,
      stowSku,
      equalsSkuScan,
      mode,
      isOrderIdentityScanMatch,
      getOrderCouplingKey,
      packScopedOrderKey,
      packItems,
      readyToPackOrders,
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
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            className="h-11 rounded-xl bg-slate-800/40 text-white px-3 text-sm font-semibold border border-white/10"
            onClick={addIdentifySlot}
          >
            + {t('common.add')}
          </button>
        </div>
        <SectionTitle title={t('ops.mode.identify')} />
        <div className="grid grid-cols-1 gap-3">
          {identifySlots.map((slot) => (
            <div key={slot} className="rounded-2xl border border-dashed border-white/15 bg-slate-800/40 p-4 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-semibold text-slate-100">
                  {t('input.groups.defaultName', { index: identifySlots.indexOf(slot) + 1 })}
                </p>
                <button
                  type="button"
                  className="rounded-full bg-slate-900/60 border border-white/10 text-slate-100 px-3 py-1.5 text-xs font-semibold disabled:opacity-40"
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
                  className="rounded-2xl bg-slate-800/40 text-slate-100 font-semibold py-3 border border-white/10"
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
                        className="w-full aspect-square object-cover rounded-lg border border-white/10"
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
      </div>
    );
  }

  if (mode === 'operations-stow') {
    const showKeypad = Boolean(stowSku && stowBin);
    const stowProduct = stowSku ? resolveProductForStow(stowSku) : null;
    return (
      <div className="space-y-3 max-w-xl mx-auto">
        <SectionTitle title={t('ops.mode.stow')} />
        <div className="rounded-2xl border border-white/10 bg-slate-800/40 p-3 space-y-2">
          {stowMessage && <p className="text-xs text-emerald-300">{stowMessage}</p>}
          {stowProduct ? <ProductCard product={stowProduct} /> : null}
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
                  className="flex-1 rounded-xl bg-slate-800/40 text-white border border-white/10 text-xl font-semibold px-3 py-2 border border-white/10"
                />
                <button
                  type="button"
                  className="rounded-xl px-3 py-2 bg-slate-800/60 text-white text-sm font-semibold border border-white/10"
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
                    className="rounded-xl bg-slate-800/40 text-white border border-white/10 text-xl font-semibold py-3"
                    onClick={() => setStowQty((prev) => Number(`${prev}${n}`))}
                  >
                    {n}
                  </button>
                ))}
                <button
                  type="button"
                  className="rounded-xl bg-slate-800/40 text-white border border-white/10 text-lg font-semibold py-3"
                  onClick={() => setStowQty((prev) => Math.max(0, Math.floor(prev / 10)))}
                >
                  ⌫
                </button>
                <button
                  type="button"
                  className="rounded-xl bg-slate-800/40 text-white border border-white/10 text-xl font-semibold py-3"
                  onClick={() => setStowQty((prev) => Number(`${prev}0`))}
                >
                  0
                </button>
                <button
                  type="button"
                  className="rounded-xl bg-slate-800/40 text-white border border-white/10 text-lg font-semibold py-3"
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
              className="rounded-xl bg-emerald-600/20 text-emerald-300 font-semibold py-3 disabled:opacity-40"
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
              className="rounded-xl bg-slate-800/60 text-white font-semibold py-3 border border-white/10"
            >
              {t('common.reset')}
            </button>
          </div>
        </div>

        {stowEntries.length > 0 ? (
          <details className="rounded-2xl border border-white/10 bg-slate-800/40 p-3">
            <summary className="cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden text-sm font-semibold text-slate-100 flex items-center justify-between">
              <span>
                {t('ops.mobile.stow.sessionTitle')} ({stowEntries.length})
              </span>
              <span className="text-slate-400">▾</span>
            </summary>
            <div className="mt-3 space-y-2">
              {stowEntries.map((entry, idx) => (
                <div
                  key={`${entry.sku}-${entry.bin}-${idx}`}
                  className="rounded-xl border border-white/10 bg-slate-900/60 p-2 text-sm text-slate-200"
                >
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
          </details>
        ) : null}
      </div>
    );
  }

  if (mode === 'operations-pick') {
    const nextTask = pickTasks[0] || null;
    const nextBinGroupCount = nextTask?.binCode
      ? pickTasks.filter((it) => equalsIgnoreCase(it.binCode, nextTask.binCode)).length
      : 0;
    const expectedScan: 'bin' | 'sku' =
      pendingPick
        ? 'sku'
        : !activeBin && !activeSku
          ? 'bin'
          : activeBin && !activeSku
            ? 'sku'
            : !activeBin && activeSku
              ? 'bin'
              : 'sku';

    const scanBoxClass = (kind: 'bin' | 'sku') => {
      const isExpected = expectedScan === kind;
      return `rounded-2xl border p-3 ${
        isExpected ? 'border-sky-500 bg-sky-900/20' : 'border-white/10 bg-slate-900/40'
      }`;
    };

    return (
      <div className="max-w-xl mx-auto flex flex-col gap-3">
        <div className="flex items-end justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold text-white">{t('ops.mode.pick')}</h2>
          </div>
          <div className="text-right text-xs text-slate-400">
            <p className="font-semibold text-slate-200 tabular-nums">{pickTasks.length}</p>
            <p>{t('ops.badge.pick')}</p>
          </div>
        </div>

        {ordersError ? (
          <div className="rounded-2xl border border-rose-800 bg-rose-900/30 p-3 text-sm text-rose-100">
            <p className="font-semibold">{t('ops.errors.ordersLoad')}</p>
            <p className="mt-1 text-xs text-rose-200/90 break-words">{ordersError}</p>
          </div>
        ) : null}

        <div className="rounded-2xl border border-white/10 bg-slate-800/40 p-3 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <div className={scanBoxClass('bin')}>
              <p className="text-[11px] uppercase tracking-widest text-slate-400">{t('common.bin')}</p>
              <p className="text-2xl font-extrabold text-white tracking-wider break-all">
                {activeBin || `${t('ops.actions.scan')} ${t('common.bin')}`}
              </p>
            </div>
            <div className={scanBoxClass('sku')}>
              <p className="text-[11px] uppercase tracking-widest text-slate-400">{t('common.sku')}</p>
              <p className="text-base font-bold text-white break-all">
                {activeSku || `${t('ops.actions.scan')} ${t('common.sku')}`}
              </p>
            </div>
          </div>

          <div className="flex items-start justify-between gap-3">
            <div />
            <button
              type="button"
              className="shrink-0 rounded-xl bg-slate-900/50 border border-white/10 px-3 py-2 text-xs font-semibold text-white"
              onClick={() => {
                setActiveBin('');
                setActiveSku('');
                setPendingPick(null);
                setPendingPickQty(0);
                setHighlightKey(null);
                setPickMessage(null);
                setPickMessageTone(null);
              }}
            >
              {t('common.reset')}
            </button>
          </div>

          {pickMessage ? (
            <p
              className={`text-xs ${
                pickMessageTone === 'error'
                  ? 'text-rose-300'
                  : pickMessageTone === 'success'
                    ? 'text-emerald-300'
                    : 'text-sky-200'
              }`}
            >
              {pickMessage}
            </p>
          ) : null}
          {ordersLoading ? <p className="text-xs text-slate-400">{t('ops.orders.loading')}</p> : null}
        </div>

        <div className="rounded-2xl border border-white/10 bg-slate-900/30 p-3">
          {pendingPick ? (
            <div className="space-y-2">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0 flex items-start gap-3">
                  <div className="w-12 h-12 rounded-xl bg-slate-800 border border-white/10 overflow-hidden flex items-center justify-center shrink-0">
                    {pendingPick.thumbnailUrl ? (
                      <img src={pendingPick.thumbnailUrl} alt="" className="w-full h-full object-cover" loading="lazy" />
                    ) : (
                      <span className="text-[11px] text-slate-300">{t('common.noImage')}</span>
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-white line-clamp-2">{pendingPick.name}</p>
                    <p className="text-xs text-slate-400 mt-1">
                      {t('common.order')} {pendingPick.orderNumber || pendingPick.orderId}
                    </p>
                    <p className="text-[11px] text-slate-400 mt-1 tabular-nums">
                      Scan SKU:{' '}
                      <span className="font-semibold text-slate-200">
                        {Math.max(0, Number(pendingPickQty || 0) || 0)}/{Math.max(1, Number(pendingPick.suggestedQty || 1) || 1)}
                      </span>
                    </p>
                  </div>
                </div>
                <StatusBadge label={t('ops.badge.pick')} tone="warn" />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-xl bg-slate-900/60 border border-white/10 p-2">
                  <p className="text-[11px] uppercase tracking-widest text-slate-400">{t('common.bin')}</p>
                  <p className="text-3xl font-extrabold text-white tracking-wider break-all">
                    {pendingPick.binCode || '—'}
                  </p>
                </div>
                <div className="rounded-xl bg-slate-900/60 border border-white/10 p-2">
                  <p className="text-[11px] uppercase tracking-widest text-slate-400">{t('common.sku')}</p>
                  <p className="text-lg font-bold text-white break-all">{pendingPick.sku || '—'}</p>
                </div>
              </div>
              <p className="text-xs text-slate-300">
                <span className="font-semibold text-white">
                  {t('ops.labels.openRemaining', { count: pendingPick.remainingTotal })}
                </span>
                {typeof pendingPick.availableInBin === 'number' ? (
                  <>
                    {' '}
                    ·{' '}
                    <span className="font-semibold text-white">
                      {t('ops.mobile.availableInBin', { value: pendingPick.availableInBin })}
                    </span>
                  </>
                ) : null}
              </p>
            </div>
          ) : pickTasks.length === 0 && !ordersLoading ? (
            <p className="text-sm text-slate-300">{t('ops.orders.none')}</p>
          ) : nextTask ? (
            <div className="space-y-2">
              <div className="flex items-start gap-3">
                <div className="w-12 h-12 rounded-xl bg-slate-800 border border-white/10 overflow-hidden flex items-center justify-center shrink-0">
                  {nextTask.thumbnailUrl ? (
                    <img src={nextTask.thumbnailUrl} alt="" className="w-full h-full object-cover" loading="lazy" />
                  ) : (
                    <span className="text-[11px] text-slate-300">{t('common.noImage')}</span>
                  )}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-white line-clamp-2">{nextTask.name}</p>
                  <p className="text-xs text-slate-400 mt-1">
                    {t('common.order')} {nextTask.orderNumber || nextTask.orderId}
                  </p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-xl bg-slate-900/60 border border-white/10 p-2">
                  <p className="text-[11px] uppercase tracking-widest text-slate-400">{t('common.bin')}</p>
                  <p className="text-3xl font-extrabold text-white tracking-wider break-all">{nextTask.binCode || '—'}</p>
                  {nextBinGroupCount > 1 ? (
                    <p className="text-[11px] text-slate-400 mt-1">
                      {t('ops.mobile.pick.binGroupCount', { count: nextBinGroupCount })}
                    </p>
                  ) : null}
                </div>
                <div className="rounded-xl bg-slate-900/60 border border-white/10 p-2">
                  <p className="text-[11px] uppercase tracking-widest text-slate-400">{t('common.sku')}</p>
                  <p className="text-base font-bold text-white break-all">{nextTask.sku}</p>
                  <p className="text-[11px] text-slate-400 mt-1">{t('ops.labels.openRemaining', { count: nextTask.remainingTotal })}</p>
                </div>
              </div>
            </div>
          ) : null}
        </div>

        {!pendingPick && pickTasks.length > 0 ? (
          <details className="rounded-2xl border border-white/10 bg-slate-800/40 p-3">
            <summary className="cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden text-sm font-semibold text-slate-100 flex items-center justify-between">
              <span>
                {t('ops.mobile.route')} ({pickTasks.length})
              </span>
              <span className="text-slate-400">▾</span>
            </summary>
            <div className="mt-3 space-y-2">
              {pickTasks.slice(0, 100).map((task) => {
                const key = `${task.orderId}-${task.itemId}-${task.binCode}`;
                const isHighlighted = highlightKey === key;
                return (
                  <button
                    type="button"
                    key={key}
                    onClick={() => {
                      setPendingPick(task);
                      setPendingPickQty(0);
                      setActiveBin(task.binCode || '');
                      setActiveSku(task.sku || '');
                      setHighlightKey(key);
                    }}
                    className={`w-full text-left rounded-2xl border p-3 shadow-sm shadow-black/20 ${
                      isHighlighted ? 'border-sky-500 bg-sky-900/30' : 'border-white/5 bg-slate-900/50'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-white line-clamp-2">{task.name}</p>
                        <p className="text-xs text-slate-400 mt-1">
                          {t('common.order')} {task.orderNumber || task.orderId}
                        </p>
                        <div className="mt-2 flex flex-wrap gap-2 text-xs">
                          <span className="px-2 py-1 rounded-full border border-white/10 bg-white/5 text-slate-200">
                            {t('common.sku')}: <span className="font-semibold text-white">{task.sku}</span>
                          </span>
                          <span className="px-2 py-1 rounded-full border border-white/10 bg-white/5 text-slate-200">
                            {t('ops.labels.openRemaining', { count: task.remainingTotal })}
                          </span>
                          <span className="px-2 py-1 rounded-full border border-white/10 bg-white/5 text-slate-200">
                            {t('ops.pick.quantityHint', { value: task.suggestedQty })}
                          </span>
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="text-[11px] uppercase tracking-widest text-slate-400">{t('common.bin')}</p>
                        <p className="text-xl font-extrabold text-white tracking-wider">{task.binCode || '—'}</p>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </details>
        ) : null}
      </div>
    );
  }

  if (mode === 'operations-pack') {
    const scopedOrderPreview = packScopedOrderKey
      ? packItems.find((item) => item.orderKey === packScopedOrderKey) || null
      : null;
    const scopedItems = packScopedOrderKey ? packItems.filter((item) => item.orderKey === packScopedOrderKey) : packItems;
    const selectedItem = packSelectedKey
      ? packItems.find((item) => `${item.orderKey}::${item.sku}::${item.binCode}` === packSelectedKey) || null
      : null;

    const cycleSelection = (direction: 1 | -1) => {
      const list = scopedItems.length ? scopedItems : packItems;
      if (!list.length) return;
      const keys = list.map((item) => `${item.orderKey}::${item.sku}::${item.binCode}`);
      const current = packSelectedKey && keys.includes(packSelectedKey) ? packSelectedKey : null;
      const idx = current ? keys.indexOf(current) : -1;
      const nextIdx = current ? (idx + direction + keys.length) % keys.length : 0;
      const nextKey = keys[nextIdx];
      const nextItem = list[nextIdx];
      setPackSelectedKey(nextKey);
      setPackScopedOrderKey(nextItem.orderKey);
      setPackMessage(null);
    };

    const submitPack = () => {
      if (!selectedItem?.orderId) return;
      setPackMessage(null);
      void (async () => {
        try {
          await packOrder(selectedItem.orderId);
          setPackMessage(
            t('ops.mobile.pack.scan.success', {
              order: selectedItem.orderNumber || selectedItem.orderId,
              sku: selectedItem.sku,
            })
          );
        } catch (err: any) {
          setPackMessage(t('ops.mobile.pack.scan.error', { message: err?.message || t('common.unknownError') }));
        }
        void refreshOrders();
        setPackScopedOrderKey(null);
        setPackSelectedKey(null);
      })();
    };
    return (
      <div className="max-w-xl mx-auto flex flex-col gap-3">
        <div className="flex items-end justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold text-white">{t('ops.mode.pack')}</h2>
          </div>
          <div className="text-right text-xs text-slate-400">
            <p className="font-semibold text-slate-200 tabular-nums">{packScopedOrderKey ? scopedItems.length : packItems.length}</p>
            <p>{t('ops.badge.pack')}</p>
          </div>
        </div>

        {packMessage ? (
          <div className="rounded-2xl border border-white/10 bg-slate-900/40 p-3 text-sm text-slate-200">{packMessage}</div>
        ) : null}

        <div className="rounded-2xl border border-white/10 bg-slate-800/40 p-3 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-2xl border border-white/10 bg-slate-900/40 p-3">
              <p className="text-[11px] uppercase tracking-widest text-slate-400">{t('common.order')}</p>
              <p className="text-base font-bold text-white break-all">
                {scopedOrderPreview?.orderNumber ||
                  (packScopedOrderKey ? packScopedOrderKey : `${t('ops.actions.scan')} ${t('common.order')}`)}
              </p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-slate-900/40 p-3">
              <p className="text-[11px] uppercase tracking-widest text-slate-400">{t('common.sku')}</p>
              <p className="text-base font-bold text-white break-all">
                {selectedItem?.sku || `${t('ops.actions.scan')} ${t('common.sku')}`}
              </p>
            </div>
          </div>

          <div className="flex items-start justify-end gap-3">
            <button
              type="button"
              className="shrink-0 rounded-xl bg-slate-900/50 border border-white/10 px-3 py-2 text-xs font-semibold text-white"
              onClick={() => {
                setPackMessage(null);
                setPackScopedOrderKey(null);
                setPackSelectedKey(null);
              }}
            >
              {t('common.reset')}
            </button>
          </div>

          {ordersLoading ? <p className="text-xs text-slate-400">{t('ops.orders.loading')}</p> : null}
        </div>

        {packItems.length === 0 && !ordersLoading ? (
          <p className="text-sm text-slate-400">{t('ops.mobile.pack.none')}</p>
        ) : null}

        {selectedItem ? (
          <div className="rounded-2xl border border-white/10 bg-slate-900/30 p-3 space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0 flex items-start gap-3">
                <div className="w-12 h-12 rounded-xl bg-slate-800 border border-white/10 overflow-hidden flex items-center justify-center shrink-0">
                  {selectedItem.thumbnailUrl ? (
                    <img src={selectedItem.thumbnailUrl} alt="" className="w-full h-full object-cover" loading="lazy" />
                  ) : (
                    <span className="text-[11px] text-slate-300">{t('common.noImage')}</span>
                  )}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-white line-clamp-2">{selectedItem.name}</p>
                  <p className="text-xs text-slate-400 mt-1">
                    {t('common.order')} {selectedItem.orderNumber || selectedItem.orderId}
                  </p>
                </div>
              </div>
              <StatusBadge label={t('ops.badge.pack')} tone="warn" />
            </div>

            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="rounded-xl bg-slate-900/60 border border-white/10 p-2">
                <p className="text-[11px] uppercase tracking-widest text-slate-400">{t('common.bin')}</p>
                <p className="text-lg font-bold text-white break-all">{selectedItem.binCode || '—'}</p>
              </div>
              <div className="rounded-xl bg-slate-900/60 border border-white/10 p-2">
                <p className="text-[11px] uppercase tracking-widest text-slate-400">{t('common.qty')}</p>
                <p className="text-lg font-extrabold text-white tabular-nums">{selectedItem.qty}</p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                className="h-14 rounded-2xl bg-emerald-600/20 text-emerald-300 font-extrabold text-lg"
                onClick={submitPack}
              >
                Verpackt
              </button>
              <button
                type="button"
                className="h-14 rounded-2xl bg-slate-800/60 text-white font-semibold text-lg border border-white/10"
                onClick={() => cycleSelection(1)}
              >
                Nächstes
              </button>
            </div>
          </div>
        ) : packItems.length > 0 ? (
          <div className="rounded-2xl border border-white/10 bg-slate-900/30 p-3 space-y-3">
            <p className="text-sm text-slate-300">Scan Auftrag oder SKU, um zu starten.</p>
            <button
              type="button"
              className="h-14 rounded-2xl bg-slate-800/60 text-white font-semibold text-lg border border-white/10"
              onClick={() => cycleSelection(1)}
            >
              Produkte durchgehen
            </button>
          </div>
        ) : null}
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
          className="w-full rounded-2xl bg-sky-600/20 text-sky-300 font-semibold py-4 text-lg border border-sky-500/20"
          onClick={() => onNavigate('operations-identify')}
        >
          {t('ops.mode.identify')}
        </button>
        <button
          type="button"
          className="w-full rounded-2xl bg-emerald-600/20 text-emerald-300 font-semibold py-4 text-lg border border-emerald-500/20"
          onClick={() => onNavigate('operations-stow')}
        >
          {t('ops.mode.stow')}
        </button>
        <button
          type="button"
          className="w-full rounded-2xl bg-amber-600/20 text-amber-300 font-semibold py-4 text-lg border border-amber-500/20"
          onClick={() => onNavigate('operations-pick')}
        >
          {t('ops.mode.pick')}
        </button>
        <button
          type="button"
          className="w-full rounded-2xl bg-slate-800/40 text-white font-semibold py-4 text-lg border border-white/10"
          onClick={() => onNavigate('operations-pack')}
        >
          {t('ops.mode.pack')}
        </button>
      </div>
    </div>
  );
};

export default MobileOperationsView;

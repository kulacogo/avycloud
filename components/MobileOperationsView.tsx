import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Order, Product, getOrderStatus } from '../types';
import { getProductQuantity } from '../utils/product';
import {
  fetchOrders as fetchOrdersApi,
  syncOrders as syncOrdersApi,
  completeOrder,
  packOrder,
  packAndShip,
  stockInProduct,
  stockOutProduct,
  fetchProfile,
  fetchShippingPreview,
  updateOrderWeight,
} from '../api/client';
import type { ShippingPreview, ShippingPreviewMatch } from '../api/client';
import { CarrierPickModal, WeightPromptModal } from './orders/ShippingDecisionDialog';
import { useI18n } from '../i18n';
import { compareBinCodesForPickRoute } from '../utils/warehouseRoute';
import type { UploadGroupPayload } from '../hooks/useIdentification';
import QuantityNumpad from './operations/QuantityNumpad';

type OpsMode = 'operations' | 'operations-identify' | 'operations-stow' | 'operations-pick' | 'operations-pack';

type MobilePickTask = {
  taskKey: string;
  orderId: string;
  orderNumber?: string | null;
  orderCreatedAt?: string | null;
  name: string;
  sku: string;
  binCode: string;
  thumbnailUrl?: string | null;
  suggestedQty: number;
  remainingTotal: number;
  productId?: string | null;
  availableInBin?: number | null;
  allocations: Array<{
    itemId: string;
    orderItemId: string;
    remaining: number;
    itemTotal: number;
    pickedSoFar: number;
    productId?: string | null;
  }>;
};

interface MobileOperationsViewProps {
  products: Product[];
  mode: OpsMode;
  onNavigate: (view: OpsMode | 'input' | 'sheet') => void;
  onSelectProduct?: (productId: string) => void;
  onIdentify?: (groups: UploadGroupPayload[], barcodes: string, paletteCode?: string) => void;
}

const SectionTitle: React.FC<{ title: string; desc?: string }> = ({ title, desc }) => (
  <div className="space-y-1 mb-3">
    <h2 className="text-xl font-semibold text-txt-primary">{title}</h2>
    {desc && <p className="text-sm text-txt-muted">{desc}</p>}
  </div>
);

const StatusBadge: React.FC<{ label: string; tone?: 'neutral' | 'success' | 'warn' }> = ({ label, tone = 'neutral' }) => {
  const toneClasses =
    tone === 'success'
      ? 'bg-success-dim text-success border-success/30'
      : tone === 'warn'
        ? 'bg-warning-dim text-warning border-warning/30'
        : 'bg-app-surface text-txt-secondary border-app-border';
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold border ${toneClasses}`}>
      {label}
    </span>
  );
};

const ProductCard: React.FC<{ product: Product; footer?: React.ReactNode }> = ({ product, footer }) => {
  const { t } = useI18n();
  return (
  <div className="w-full text-left rounded-2xl bg-app-surface border border-app-border p-3 flex gap-3">
    <div className="w-12 h-12 rounded-xl bg-app-surface overflow-hidden flex items-center justify-center">
      {product.details?.images?.[0]?.url_or_base64 ? (
        <img src={product.details.images[0].url_or_base64} alt="" className="w-full h-full object-cover" />
      ) : (
          <span className="text-xs text-txt-secondary">{t('common.noImage')}</span>
      )}
    </div>
    <div className="flex-1">
      <p className="text-sm font-semibold text-txt-primary line-clamp-2">{product.identification?.name}</p>
      <p className="text-xs text-txt-muted">
          {t('common.sku')} {product.identification?.sku || '—'} · {t('common.bin')} {product.storage?.binCode || '—'}
        </p>
        <p className="text-xs text-txt-muted">
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
  const [printingPrefs, setPrintingPrefs] = useState<{ labelFormat?: string; autoPrint?: boolean; networkPrinterUrl?: string }>({});
  // Mobile pick progress (supports partial picks across bins)
  const [pickedByItemId, setPickedByItemId] = useState<Record<string, number>>({});
  // Local bin deltas to avoid stale product data causing repeated picks from the same BIN
  const [pickedFromBin, setPickedFromBin] = useState<Record<string, number>>({}); // key: `${productId}::${BIN}` -> pickedQty
  const [pendingPick, setPendingPick] = useState<MobilePickTask | null>(null);
  const [pendingPickQty, setPendingPickQty] = useState<number>(0);

  // ── Pack decision flow ─────────────────────────────────────────────
  // Two-step UX before creating a label:
  //   1. If `weight` is missing on the order → ask the user, persist via
  //      updateOrderWeight, re-run preview.
  //   2. If multiple carrier rules match → ask the user to pick one;
  //      forward the chosen `shippingMethodId` to packAndShip.
  // Both modals are deliberately local to the pack mode — they unmount
  // when leaving the screen.
  type ShipDecisionStep = 'idle' | 'weight' | 'pick' | 'executing';
  type PendingShipTarget = {
    orderId: string;
    orderLabel: string;
    initialWeight: number | null;
  };
  const [shipDecisionStep, setShipDecisionStep] = useState<ShipDecisionStep>('idle');
  const [shipDecisionTarget, setShipDecisionTarget] = useState<PendingShipTarget | null>(null);
  const [shipDecisionMatches, setShipDecisionMatches] = useState<ShippingPreviewMatch[]>([]);
  const [shipDecisionWeight, setShipDecisionWeight] = useState<number | null>(null);
  const [shipDecisionError, setShipDecisionError] = useState<string | null>(null);
  const [shipDecisionBusy, setShipDecisionBusy] = useState(false);

  const [identifyPaletteCode, setIdentifyPaletteCode] = useState('');
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
      const orderId = (order.orderId || order.id || '').toString().trim();
      return `${orderId}::${src}::${srcId}`;
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
    return orders.filter((o) => {
      // OMS orders use 'pending'/'confirmed'/'picking'; legacy BL orders used 'new'
      const oms = getOrderStatus(o);
      const isOpen = oms === 'new' || oms === 'pending' || oms === 'confirmed' || oms === 'picking';
      return isOpen && !isCancelled(o.statusLabel);
    });
  }, [orders]);

  const readyToPackOrders = useMemo(() => {
    // Safety gate:
    // Pack flow must only contain status "Kommissioniert".
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
      const oms = getOrderStatus(o);
      if (isCancelled(label)) return false;
      // Packed orders without a shipping label: show for retry-ship
      if (oms === 'packed' && !(o as any).trackingNumber) return true;
      // Normal case: picked orders not yet packed
      const isPicked = oms === 'picked' || label.includes('kommissioniert');
      return isPicked && !isPackedOrBeyond(label);
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

  // Load user printing preferences when entering pack mode
  useEffect(() => {
    if (mode === 'operations-pack') {
      fetchProfile()
        .then((data) => {
          if (data.printing) setPrintingPrefs(data.printing);
        })
        .catch(() => {}); // Non-critical — defaults work fine
    }
  }, [mode]);

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
      const orderId = (order.orderId || order.id || '').toString().trim();
      const candidates = new Set(
        [
          orderId,
          order.number || '',
          (order as any).marketplaceOrderId || '',
          (order as any).externalOrderId || '',
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
    const taskMap = new Map<string, MobilePickTask>();

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

        const orderNumber = (order as any).marketplaceOrderId || order.number || (order as any).orderId || order.id;
        const taskKey = `${order.id}::${binCode || '-'}::${skuCandidate}`;
        const resolvedProductId = (product?.id || hint?.productId || it.productId || null) as any;
        const taskName = hint?.productName || product?.identification?.name || it.name;
        const taskThumbnail = product?.details?.images?.[0]?.url_or_base64 || null;
        const existing = taskMap.get(taskKey);

        if (existing) {
          existing.remainingTotal += remainingTotal;
          existing.suggestedQty += suggestedQty;
          existing.allocations.push({
            itemId,
            orderItemId: itemId,
            remaining: remainingTotal,
            itemTotal: total,
            pickedSoFar,
            productId: resolvedProductId,
          });
          if (!existing.name && taskName) existing.name = taskName;
          if (!existing.thumbnailUrl && taskThumbnail) existing.thumbnailUrl = taskThumbnail;
          if (!existing.productId && resolvedProductId) existing.productId = resolvedProductId;
          if (typeof availableInBin === 'number') {
            const current = typeof existing.availableInBin === 'number' ? existing.availableInBin : 0;
            existing.availableInBin = current + availableInBin;
          }
        } else {
          taskMap.set(taskKey, {
            taskKey,
            orderId: order.id,
            orderNumber,
            orderCreatedAt: order.createdAt || null,
            name: taskName,
            sku: skuCandidate,
            binCode,
            thumbnailUrl: taskThumbnail,
            suggestedQty,
            remainingTotal,
            productId: resolvedProductId,
            availableInBin: typeof availableInBin === 'number' ? availableInBin : null,
            allocations: [
              {
                itemId,
                orderItemId: itemId,
                remaining: remainingTotal,
                itemTotal: total,
                pickedSoFar,
                productId: resolvedProductId,
              },
            ],
          });
        }
        });
    });

    const tasks = Array.from(taskMap.values()).map((task) => {
      const maxByBin = typeof task.availableInBin === 'number' ? task.availableInBin : task.remainingTotal;
      return {
        ...task,
        suggestedQty: Math.max(1, Math.min(task.suggestedQty, task.remainingTotal, maxByBin)),
      };
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
            orderNumber: (o as any).marketplaceOrderId || o.number || (o as any).orderId || o.id,
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

          // UI must stay fluid: never block on status updates or full order refresh.
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
    const sourcePalette = productMatch?.ops?.sourcePalette || undefined;
    const payload = {
      productId: productMatch?.id,
      sku: stowSku,
      binCode: stowBin,
      quantity: stowQty,
      barcode: productMatch?.identification?.barcodes?.[0] || productMatch?.details?.identifiers?.ean || undefined,
      meta: { flow: 'stow', ...(sourcePalette ? { paletteCode: sourcePalette } : {}) },
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
              order: selected.number || selected.orderId || selected.id,
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

        let item = candidates[0];
        let ambiguousRemaining = 0;
        if (candidates.length > 1) {
          // FIFO: pick the candidate from the oldest picked order. readyToPackOrders is sorted
          // by createdAt so its index is a stable age ranking. Scanning the order ID still
          // overrides this choice, and "Zurücksetzen" clears the scope.
          const rankByOrderKey = new Map(readyToPackOrders.map((o, idx) => [getOrderCouplingKey(o), idx]));
          const rank = (key: string) => rankByOrderKey.get(key) ?? Number.MAX_SAFE_INTEGER;
          item = [...candidates].sort((a, b) => rank(a.orderKey) - rank(b.orderKey))[0];
          ambiguousRemaining = candidates.length - 1;
        }

        setPackScopedOrderKey(item.orderKey);
        setPackSelectedKey(`${item.orderKey}::${item.sku}::${item.binCode}`);
        setPackMessage(
          ambiguousRemaining > 0
            ? t('ops.mobile.pack.scan.autoSelected', {
                order: item.orderNumber || item.orderId,
                remaining: ambiguousRemaining,
              })
            : null
        );
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
            aria-label="Neuen Identifizierungs-Slot hinzufuegen"
            className="h-11 rounded-xl bg-app-surface text-txt-primary px-3 text-sm font-semibold border border-app-border"
            onClick={addIdentifySlot}
          >
            + {t('common.add')}
          </button>
        </div>
        <SectionTitle title={t('ops.mode.identify')} />
        {/* Palette scan — Pflicht für neue Ware */}
        <div className={`rounded-2xl border ${identifyPaletteCode ? 'border-success/40' : 'border-danger/40'} bg-app-surface p-3 mb-3`}>
          <label className="block text-xs font-semibold text-txt-muted mb-1">Palette (Pflicht)</label>
          <input
            type="text"
            inputMode="none"
            autoComplete="off"
            className="w-full rounded-xl bg-app-bg border border-app-border px-3 py-2 text-sm text-txt-primary placeholder:text-txt-muted/50 focus:outline-none focus:ring-2 focus:ring-accent/40"
            placeholder="Palette scannen (z.B. PGA001)"
            value={identifyPaletteCode}
            onChange={(e) => setIdentifyPaletteCode(e.target.value.toUpperCase())}
          />
          {identifyPaletteCode ? (
            <p className="text-xs text-success mt-1">Palette {identifyPaletteCode} aktiv — alle erkannten Produkte werden zugeordnet.</p>
          ) : (
            <p className="text-xs text-danger mt-1">Bitte zuerst Palette scannen</p>
          )}
        </div>
        <div className="grid grid-cols-1 gap-3">
          {identifySlots.map((slot) => (
            <div key={slot} className="rounded-2xl border border-dashed border-app-border bg-app-surface p-4 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-semibold text-txt-primary">
                  {t('input.groups.defaultName', { index: identifySlots.indexOf(slot) + 1 })}
                </p>
                <button
                  type="button"
                  aria-label={t('common.clear')}
                  className="rounded-full bg-app-bg/60 border border-app-border text-txt-primary px-3 py-1.5 text-xs font-semibold disabled:opacity-40"
                  onClick={() => clearIdentifySlot(slot)}
                  disabled={!identifyImagesBySlot[slot]?.length}
                >
                  {t('common.clear')}
                </button>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  aria-label={t('common.camera')}
                  className="rounded-2xl bg-accent text-txt-primary font-semibold py-3"
                  onClick={() => triggerIdentifyInput(slot, 'camera')}
                >
                  {t('common.camera')}
                </button>
                <button
                  type="button"
                  aria-label={t('common.upload')}
                  className="rounded-2xl bg-app-surface text-txt-primary font-semibold py-3 border border-app-border"
                  onClick={() => triggerIdentifyInput(slot, 'upload')}
                >
                  {t('common.upload')}
                </button>
              </div>
              {identifyImagesBySlot[slot]?.length ? (
                <div className="space-y-2">
                  <p className="text-xs text-txt-muted">{t('identifyQueue.files', { count: identifyImagesBySlot[slot].length })}</p>
                  <div className="grid grid-cols-4 gap-2">
                    {identifyImagesBySlot[slot].slice(0, 8).map((img) => (
                      <img
                        key={img.id}
                        src={img.previewUrl}
                        alt=""
                        className="w-full aspect-square object-cover rounded-lg border border-app-border"
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
                aria-hidden="true"
                tabIndex={-1}
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
                aria-hidden="true"
                tabIndex={-1}
                className="hidden"
                onChange={(e) => {
                  handleIdentifyFilesSelected(slot, e.currentTarget.files);
                  e.currentTarget.value = '';
                }}
              />
              <button
                type="button"
                aria-label={t('ops.identify.run')}
                className="w-full rounded-2xl bg-success text-txt-primary font-semibold py-3 disabled:opacity-40"
                disabled={!identifyImagesBySlot[slot]?.length || !identifyPaletteCode}
                onClick={() => {
                  const images = (identifyImagesBySlot[slot] || []).map((img) => img.file);
                  if (!images.length) return;
                  const index = identifySlots.indexOf(slot) + 1;
                  const payload: UploadGroupPayload[] = [
                    { id: `mobile-slot-${slot}`, label: t('input.groups.defaultName', { index }), images },
                  ];
                  if (onIdentify) {
                    onIdentify(payload, '', identifyPaletteCode || undefined);
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
        <div className="rounded-2xl border border-app-border bg-app-surface p-3 space-y-2">
          {stowMessage && <p role="status" aria-live="polite" className="text-xs text-success">{stowMessage}</p>}
          {stowProduct ? <ProductCard product={stowProduct} /> : null}
          <div className="grid grid-cols-2 gap-2 text-sm text-txt-secondary">
            <div className="rounded-xl bg-app-bg/60 border border-app-border p-2">
              <p className="text-[11px] uppercase tracking-widest text-txt-muted">{t('common.sku')}</p>
              <p className="text-base font-semibold break-all">{stowSku || '—'}</p>
            </div>
            <div className="rounded-xl bg-app-bg/60 border border-app-border p-2">
              <p className="text-[11px] uppercase tracking-widest text-txt-muted">{t('common.bin')}</p>
              <p className="text-base font-semibold break-all">{stowBin || '—'}</p>
            </div>
          </div>
          {showKeypad && (
            <div className="rounded-xl bg-app-bg/60 border border-app-border p-3 space-y-3">
              <p className="text-[11px] uppercase tracking-widest text-txt-muted">{t('ops.mobile.qtyScannerOrPad')}</p>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  readOnly
                  value={stowQty}
                  aria-label="Einlagerungsmenge"
                  className="flex-1 rounded-xl bg-app-surface text-txt-primary border border-app-border text-xl font-semibold px-3 py-2 border border-app-border"
                />
                <button
                  type="button"
                  aria-label="Menge zuruecksetzen"
                  className="rounded-xl px-3 py-2 bg-app-surface text-txt-primary text-sm font-semibold border border-app-border"
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
                    className="rounded-xl bg-app-surface text-txt-primary border border-app-border text-xl font-semibold py-3"
                    onClick={() => setStowQty((prev) => Number(`${prev}${n}`))}
                  >
                    {n}
                  </button>
                ))}
                <button
                  type="button"
                  aria-label="Letzte Ziffer loeschen"
                  className="rounded-xl bg-app-surface text-txt-primary border border-app-border text-lg font-semibold py-3"
                  onClick={() => setStowQty((prev) => Math.max(0, Math.floor(prev / 10)))}
                >
                  <span aria-hidden="true">⌫</span>
                </button>
                <button
                  type="button"
                  className="rounded-xl bg-app-surface text-txt-primary border border-app-border text-xl font-semibold py-3"
                  onClick={() => setStowQty((prev) => Number(`${prev}0`))}
                >
                  0
                </button>
                <button
                  type="button"
                  aria-label="Menge auf Null setzen"
                  className="rounded-xl bg-app-surface text-txt-primary border border-app-border text-lg font-semibold py-3"
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
              aria-label={t('ops.stow.submit')}
              className="rounded-xl bg-success-dim text-success font-semibold py-3 disabled:opacity-40"
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
              aria-label={t('common.reset')}
              className="rounded-xl bg-app-surface text-txt-primary font-semibold py-3 border border-app-border"
            >
              {t('common.reset')}
            </button>
          </div>
        </div>

        {stowEntries.length > 0 ? (
          <details className="rounded-2xl border border-app-border bg-app-surface p-3">
            <summary className="cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden text-sm font-semibold text-txt-primary flex items-center justify-between">
              <span>
                {t('ops.mobile.stow.sessionTitle')} ({stowEntries.length})
              </span>
              <span className="text-txt-muted">▾</span>
            </summary>
            <div className="mt-3 space-y-2">
              {stowEntries.map((entry, idx) => (
                <div
                  key={`${entry.sku}-${entry.bin}-${idx}`}
                  className="rounded-xl border border-app-border bg-app-bg/60 p-2 text-sm text-txt-secondary"
                >
                  <div className="flex justify-between gap-2">
                    <span className="font-semibold break-all">{entry.sku}</span>
                    <span className="text-txt-secondary">
                      {t('common.qty')} {entry.qty}
                    </span>
                  </div>
                  <p className="text-xs text-txt-muted break-all">
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
        isExpected ? 'border-accent bg-accent-dim' : 'border-app-border bg-app-bg/40'
      }`;
    };

    return (
      <div className="max-w-xl mx-auto flex flex-col gap-3">
        <div className="flex items-end justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold text-txt-primary">{t('ops.mode.pick')}</h2>
          </div>
          <div className="text-right text-xs text-txt-muted">
            <p className="font-semibold text-txt-secondary tabular-nums">{pickTasks.length}</p>
            <p>{t('ops.badge.pick')}</p>
          </div>
        </div>

        {ordersError ? (
          <div role="alert" className="rounded-2xl border border-danger/30 bg-danger-dim p-3 text-sm text-danger">
            <p className="font-semibold">{t('ops.errors.ordersLoad')}</p>
            <p className="mt-1 text-xs text-danger/90 break-words">{ordersError}</p>
          </div>
        ) : null}

        <div className="rounded-2xl border border-app-border bg-app-surface p-3 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <div className={scanBoxClass('bin')}>
              <p className="text-[11px] uppercase tracking-widest text-txt-muted">{t('common.bin')}</p>
              <p className={`font-extrabold text-txt-primary tracking-wider break-all ${activeBin ? 'text-2xl' : 'text-base'}`}>
                {activeBin || 'BIN scannen'}
              </p>
            </div>
            <div className={scanBoxClass('sku')}>
              <p className="text-[11px] uppercase tracking-widest text-txt-muted">{t('common.sku')}</p>
              <p className="text-base font-bold text-txt-primary break-all">
                {activeSku || `${t('ops.actions.scan')} ${t('common.sku')}`}
              </p>
            </div>
          </div>

          <div className="flex items-start justify-between gap-3">
            <div />
            <button
              type="button"
              aria-label="Scan-Eingaben zuruecksetzen"
              className="shrink-0 rounded-xl bg-app-bg/50 border border-app-border px-3 py-2 text-xs font-semibold text-txt-primary"
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
              role={pickMessageTone === 'error' ? 'alert' : 'status'}
              aria-live="polite"
              className={`text-xs ${
                pickMessageTone === 'error'
                  ? 'text-danger'
                  : pickMessageTone === 'success'
                    ? 'text-success'
                    : 'text-accent'
              }`}
            >
              {pickMessage}
            </p>
          ) : null}
          {ordersLoading ? <p role="status" aria-live="polite" className="text-xs text-txt-muted">{t('ops.orders.loading')}</p> : null}
        </div>

        <div className="rounded-2xl border border-app-border bg-app-bg/30 p-3">
          {pendingPick ? (
            <div className="space-y-2">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0 flex items-start gap-3">
                  <div className="w-12 h-12 rounded-xl bg-app-elevated border border-app-border overflow-hidden flex items-center justify-center shrink-0">
                    {pendingPick.thumbnailUrl ? (
                      <img src={pendingPick.thumbnailUrl} alt="" className="w-full h-full object-cover" loading="lazy" />
                    ) : (
                      <span className="text-[11px] text-txt-secondary">{t('common.noImage')}</span>
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-txt-primary line-clamp-2">{pendingPick.name}</p>
                    <p className="text-xs text-txt-muted mt-1">
                      {t('common.order')} {pendingPick.orderNumber || pendingPick.orderId}
                    </p>
                    <p className="text-[11px] text-txt-muted mt-1 tabular-nums">
                      Scan SKU:{' '}
                      <span className="font-semibold text-txt-secondary">
                        {Math.max(0, Number(pendingPickQty || 0) || 0)}/{Math.max(1, Number(pendingPick.suggestedQty || 1) || 1)}
                      </span>
                    </p>
                  </div>
                </div>
                <StatusBadge label={t('ops.badge.pick')} tone="warn" />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-xl bg-app-bg/60 border border-app-border p-2">
                  <p className="text-[11px] uppercase tracking-widest text-txt-muted">{t('common.bin')}</p>
                  <p className="text-3xl font-extrabold text-txt-primary tracking-wider break-all">
                    {pendingPick.binCode || '—'}
                  </p>
                </div>
                <div className="rounded-xl bg-app-bg/60 border border-app-border p-2">
                  <p className="text-[11px] uppercase tracking-widest text-txt-muted">{t('common.sku')}</p>
                  <p className="text-lg font-bold text-txt-primary break-all">{pendingPick.sku || '—'}</p>
                </div>
              </div>
              <p className="text-xs text-txt-secondary">
                <span className="font-semibold text-txt-primary">
                  {t('ops.labels.openRemaining', { count: pendingPick.remainingTotal })}
                </span>
                {typeof pendingPick.availableInBin === 'number' ? (
                  <>
                    {' '}
                    ·{' '}
                    <span className="font-semibold text-txt-primary">
                      {t('ops.mobile.availableInBin', { value: pendingPick.availableInBin })}
                    </span>
                  </>
                ) : null}
              </p>
            </div>
          ) : pickTasks.length === 0 && !ordersLoading ? (
            <p className="text-sm text-txt-secondary">{t('ops.orders.none')}</p>
          ) : nextTask ? (
            <div className="space-y-2">
              <div className="flex items-start gap-3">
                <div className="w-12 h-12 rounded-xl bg-app-elevated border border-app-border overflow-hidden flex items-center justify-center shrink-0">
                  {nextTask.thumbnailUrl ? (
                    <img src={nextTask.thumbnailUrl} alt="" className="w-full h-full object-cover" loading="lazy" />
                  ) : (
                    <span className="text-[11px] text-txt-secondary">{t('common.noImage')}</span>
                  )}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-txt-primary line-clamp-2">{nextTask.name}</p>
                  <p className="text-xs text-txt-muted mt-1">
                    {t('common.order')} {nextTask.orderNumber || nextTask.orderId}
                  </p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-xl bg-app-bg/60 border border-app-border p-2">
                  <p className="text-[11px] uppercase tracking-widest text-txt-muted">{t('common.bin')}</p>
                  <p className="text-3xl font-extrabold text-txt-primary tracking-wider break-all">{nextTask.binCode || '—'}</p>
                  {nextBinGroupCount > 1 ? (
                    <p className="text-[11px] text-txt-muted mt-1">
                      {t('ops.mobile.pick.binGroupCount', { count: nextBinGroupCount })}
                    </p>
                  ) : null}
                </div>
                <div className="rounded-xl bg-app-bg/60 border border-app-border p-2">
                  <p className="text-[11px] uppercase tracking-widest text-txt-muted">{t('common.sku')}</p>
                  <p className="text-base font-bold text-txt-primary break-all">{nextTask.sku}</p>
                  <p className="text-[11px] text-txt-muted mt-1">{t('ops.labels.openRemaining', { count: nextTask.remainingTotal })}</p>
                </div>
              </div>
            </div>
          ) : null}
        </div>

        {!pendingPick && pickTasks.length > 0 ? (
          <details className="rounded-2xl border border-app-border bg-app-surface p-3">
            <summary className="cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden text-sm font-semibold text-txt-primary flex items-center justify-between">
              <span>
                {t('ops.mobile.route')} ({pickTasks.length})
              </span>
              <span className="text-txt-muted">▾</span>
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
                    aria-label={`Pick-Aufgabe: ${task.name}, BIN ${task.binCode || 'unbekannt'}, SKU ${task.sku}`}
                    className={`w-full text-left rounded-2xl border p-3 shadow-sm shadow-black/20 ${
                      isHighlighted ? 'border-accent bg-accent-dim' : 'border-app-border bg-app-bg/50'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-txt-primary line-clamp-2">{task.name}</p>
                        <p className="text-xs text-txt-muted mt-1">
                          {t('common.order')} {task.orderNumber || task.orderId}
                        </p>
                        <div className="mt-2 flex flex-wrap gap-2 text-xs">
                          <span className="px-2 py-1 rounded-full border border-app-border bg-white/5 text-txt-secondary">
                            {t('common.sku')}: <span className="font-semibold text-txt-primary">{task.sku}</span>
                          </span>
                          <span className="px-2 py-1 rounded-full border border-app-border bg-white/5 text-txt-secondary">
                            {t('ops.labels.openRemaining', { count: task.remainingTotal })}
                          </span>
                          <span className="px-2 py-1 rounded-full border border-app-border bg-white/5 text-txt-secondary">
                            {t('ops.pick.quantityHint', { value: task.suggestedQty })}
                          </span>
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="text-[11px] uppercase tracking-widest text-txt-muted">{t('common.bin')}</p>
                        <p className="text-xl font-extrabold text-txt-primary tracking-wider">{task.binCode || '—'}</p>
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

    /**
     * Execute the actual pack + ship + print step.
     * Used both as the happy-path tail of submitPack (single carrier match)
     * AND from the CarrierPickModal's onConfirm.
     */
    const executePackAndShip = async (
      orderId: string,
      orderLabel: string,
      weightKg: number,
      shippingMethodId: number | null
    ) => {
      try {
        const result = await packAndShip(orderId, {
          weight: weightKg,
          ...(shippingMethodId ? { shippingMethodId } : {}),
          labelFormat: printingPrefs.labelFormat || 'a6',
        });

        if (result.labelBlobUrl) {
          window.open(result.labelBlobUrl, '_blank');
          setTimeout(() => URL.revokeObjectURL(result.labelBlobUrl!), 5 * 60 * 1000);
          setPackMessage(
            `${orderLabel} verpackt & Label erstellt (${result.carrier || '?'}) — PDF im neuen Tab geöffnet. Druck manuell starten.`
          );
        } else if (result.labelBlob) {
          const url = URL.createObjectURL(result.labelBlob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `label-${orderLabel}.pdf`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 5 * 60 * 1000);
          setPackMessage(
            `${orderLabel} verpackt & Label erstellt (${result.carrier || '?'}) — Label-PDF heruntergeladen.`
          );
        } else {
          setPackMessage(
            `${orderLabel} verpackt & versendet — kein Label-PDF verfügbar.${result.labelError ? ` (${result.labelError})` : ''}`
          );
        }
      } catch (err: any) {
        setPackMessage(t('ops.mobile.pack.scan.error', { message: err?.message || t('common.unknownError') }));
      } finally {
        void refreshOrders();
        setPackScopedOrderKey(null);
        setPackSelectedKey(null);
      }
    };

    /**
     * Drive the preview → decision pipeline.
     * Returns once the next user prompt is open OR shipping has been triggered.
     */
    const driveShipping = async (
      target: PendingShipTarget,
      preview: ShippingPreview
    ) => {
      if (!preview.hasWeight) {
        setShipDecisionTarget(target);
        setShipDecisionMatches([]);
        setShipDecisionWeight(null);
        setShipDecisionError(null);
        setShipDecisionStep('weight');
        return;
      }

      const matches = preview.matches || [];
      const weight = preview.weight!;

      if (matches.length === 0) {
        setPackMessage(
          `${target.orderLabel}: Keine Versandregel passt zu ${weight.toLocaleString('de-DE')} kg. Bitte Versandregeln anpassen.`
        );
        return;
      }

      if (matches.length === 1) {
        setShipDecisionStep('executing');
        await executePackAndShip(target.orderId, target.orderLabel, weight, matches[0].shippingMethodId);
        setShipDecisionStep('idle');
        setShipDecisionTarget(null);
        return;
      }

      setShipDecisionTarget(target);
      setShipDecisionMatches(matches);
      setShipDecisionWeight(weight);
      setShipDecisionError(null);
      setShipDecisionStep('pick');
    };

    const submitPack = () => {
      if (!selectedItem?.orderId) return;
      setPackMessage(null);

      const order = readyToPackOrders.find((o) => o.id === selectedItem.orderId);
      const orderLabel = selectedItem.orderNumber || selectedItem.orderId;

      // No address → pack only, never attempt a label (avoids a guaranteed SendCloud 400).
      const cust = order?.customer;
      const hasAddress = cust?.street && cust?.city && cust?.zip;
      if (!hasAddress) {
        void (async () => {
          try {
            await packOrder(selectedItem.orderId);
            setPackMessage(
              `${orderLabel} verpackt — Versandlabel nicht möglich (Adresse unvollständig).`
            );
          } catch (err: any) {
            setPackMessage(t('ops.mobile.pack.scan.error', { message: err?.message || t('common.unknownError') }));
          } finally {
            void refreshOrders();
            setPackScopedOrderKey(null);
            setPackSelectedKey(null);
          }
        })();
        return;
      }

      void (async () => {
        try {
          const preview = await fetchShippingPreview(selectedItem.orderId);
          await driveShipping(
            {
              orderId: selectedItem.orderId,
              orderLabel,
              initialWeight: preview.weight,
            },
            preview
          );
        } catch (err: any) {
          setPackMessage(t('ops.mobile.pack.scan.error', { message: err?.message || t('common.unknownError') }));
        }
      })();
    };

    const handleWeightConfirm = async (kg: number) => {
      if (!shipDecisionTarget) return;
      setShipDecisionBusy(true);
      setShipDecisionError(null);
      try {
        await updateOrderWeight(shipDecisionTarget.orderId, kg);
        const preview = await fetchShippingPreview(shipDecisionTarget.orderId);
        await driveShipping(shipDecisionTarget, preview);
      } catch (err: any) {
        setShipDecisionError(err?.message || t('common.unknownError'));
      } finally {
        setShipDecisionBusy(false);
      }
    };

    const handleCarrierConfirm = async (match: ShippingPreviewMatch) => {
      if (!shipDecisionTarget || shipDecisionWeight == null) return;
      setShipDecisionBusy(true);
      setShipDecisionError(null);
      try {
        setShipDecisionStep('executing');
        await executePackAndShip(
          shipDecisionTarget.orderId,
          shipDecisionTarget.orderLabel,
          shipDecisionWeight,
          match.shippingMethodId
        );
        setShipDecisionStep('idle');
        setShipDecisionTarget(null);
        setShipDecisionMatches([]);
      } catch (err: any) {
        setShipDecisionError(err?.message || t('common.unknownError'));
        setShipDecisionStep('pick');
      } finally {
        setShipDecisionBusy(false);
      }
    };

    const cancelShipDecision = () => {
      if (shipDecisionBusy) return;
      setShipDecisionStep('idle');
      setShipDecisionTarget(null);
      setShipDecisionMatches([]);
      setShipDecisionWeight(null);
      setShipDecisionError(null);
    };
    return (
      <div className="max-w-xl mx-auto flex flex-col gap-3">
        <div className="flex items-end justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold text-txt-primary">{t('ops.mode.pack')}</h2>
          </div>
          <div className="text-right text-xs text-txt-muted">
            <p className="font-semibold text-txt-secondary tabular-nums">{packScopedOrderKey ? scopedItems.length : packItems.length}</p>
            <p>{t('ops.badge.pack')}</p>
          </div>
        </div>

        {packMessage ? (
          <div role="status" aria-live="polite" className="rounded-2xl border border-app-border bg-app-bg/40 p-3 text-sm text-txt-secondary">{packMessage}</div>
        ) : null}

        <div className="rounded-2xl border border-app-border bg-app-surface p-3 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-2xl border border-app-border bg-app-bg/40 p-3">
              <p className="text-[11px] uppercase tracking-widest text-txt-muted">{t('common.order')}</p>
              <p className="text-base font-bold text-txt-primary break-all">
                {scopedOrderPreview?.orderNumber ||
                  (packScopedOrderKey ? packScopedOrderKey : `${t('ops.actions.scan')} ${t('common.order')}`)}
              </p>
            </div>
            <div className="rounded-2xl border border-app-border bg-app-bg/40 p-3">
              <p className="text-[11px] uppercase tracking-widest text-txt-muted">{t('common.sku')}</p>
              <p className="text-base font-bold text-txt-primary break-all">
                {selectedItem?.sku || `${t('ops.actions.scan')} ${t('common.sku')}`}
              </p>
            </div>
          </div>

          <div className="flex items-start justify-end gap-3">
            <button
              type="button"
              aria-label="Verpackungs-Auswahl zuruecksetzen"
              className="shrink-0 rounded-xl bg-app-bg/50 border border-app-border px-3 py-2 text-xs font-semibold text-txt-primary"
              onClick={() => {
                setPackMessage(null);
                setPackScopedOrderKey(null);
                setPackSelectedKey(null);
              }}
            >
              {t('common.reset')}
            </button>
          </div>

          {ordersLoading ? <p role="status" aria-live="polite" className="text-xs text-txt-muted">{t('ops.orders.loading')}</p> : null}
        </div>

        {packItems.length === 0 && !ordersLoading ? (
          <p className="text-sm text-txt-muted">{t('ops.mobile.pack.none')}</p>
        ) : null}

        {selectedItem ? (
          <div className="rounded-2xl border border-app-border bg-app-bg/30 p-3 space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0 flex items-start gap-3">
                <div className="w-12 h-12 rounded-xl bg-app-elevated border border-app-border overflow-hidden flex items-center justify-center shrink-0">
                  {selectedItem.thumbnailUrl ? (
                    <img src={selectedItem.thumbnailUrl} alt="" className="w-full h-full object-cover" loading="lazy" />
                  ) : (
                    <span className="text-[11px] text-txt-secondary">{t('common.noImage')}</span>
                  )}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-txt-primary line-clamp-2">{selectedItem.name}</p>
                  <p className="text-xs text-txt-muted mt-1">
                    {t('common.order')} {selectedItem.orderNumber || selectedItem.orderId}
                  </p>
                </div>
              </div>
              <StatusBadge label={t('ops.badge.pack')} tone="warn" />
            </div>

            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="rounded-xl bg-app-bg/60 border border-app-border p-2">
                <p className="text-[11px] uppercase tracking-widest text-txt-muted">{t('common.bin')}</p>
                <p className="text-lg font-bold text-txt-primary break-all">{selectedItem.binCode || '—'}</p>
              </div>
              <div className="rounded-xl bg-app-bg/60 border border-app-border p-2">
                <p className="text-[11px] uppercase tracking-widest text-txt-muted">{t('common.qty')}</p>
                <p className="text-lg font-extrabold text-txt-primary tabular-nums">{selectedItem.qty}</p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                aria-label="Als verpackt markieren"
                className="h-14 rounded-2xl bg-success-dim text-success font-extrabold text-lg"
                onClick={submitPack}
              >
                Verpackt
              </button>
              <button
                type="button"
                aria-label="Naechstes Produkt anzeigen"
                className="h-14 rounded-2xl bg-app-surface text-txt-primary font-semibold text-lg border border-app-border"
                onClick={() => cycleSelection(1)}
              >
                Nächstes
              </button>
            </div>
          </div>
        ) : packItems.length > 0 ? (
          <div className="rounded-2xl border border-app-border bg-app-bg/30 p-3 space-y-3">
            <p className="text-sm text-txt-secondary">Scan Auftrag oder SKU, um zu starten.</p>
            <button
              type="button"
              aria-label="Produkte durchgehen"
              className="h-14 rounded-2xl bg-app-surface text-txt-primary font-semibold text-lg border border-app-border"
              onClick={() => cycleSelection(1)}
            >
              Produkte durchgehen
            </button>
          </div>
        ) : null}

        {shipDecisionStep === 'weight' && shipDecisionTarget ? (
          <WeightPromptModal
            initialKg={shipDecisionTarget.initialWeight}
            contextLabel={shipDecisionTarget.orderLabel}
            busy={shipDecisionBusy}
            errorMessage={shipDecisionError}
            onConfirm={handleWeightConfirm}
            onCancel={cancelShipDecision}
          />
        ) : null}

        {shipDecisionStep === 'pick' && shipDecisionTarget && shipDecisionWeight != null ? (
          <CarrierPickModal
            weightKg={shipDecisionWeight}
            matches={shipDecisionMatches}
            contextLabel={shipDecisionTarget.orderLabel}
            busy={shipDecisionBusy}
            errorMessage={shipDecisionError}
            onConfirm={handleCarrierConfirm}
            onCancel={cancelShipDecision}
          />
        ) : null}
      </div>
    );
  }

  // Hub
  return (
    <div className="space-y-4 max-w-xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-txt-primary">{t('ops.title')}</h1>
          <p className="text-txt-muted text-sm">{t('ops.subtitle')}</p>
        </div>
        <div className="text-right text-xs text-txt-muted space-y-0.5">
          <p>
            {t('ops.mode.stow')}: {stowList.length}
          </p>
          <p>
            {t('ops.mode.pick')}: {pickList.length}
          </p>
          <p>
            {t('ops.mode.pack')}: {readyToPackOrders.length}
          </p>
        </div>
      </div>
      <div className="flex flex-col gap-3">
        <button
          type="button"
          aria-label={t('ops.mode.identify')}
          className="w-full rounded-2xl bg-accent-dim text-accent font-semibold py-4 px-5 text-lg border border-accent/20 flex items-center gap-3"
          onClick={() => onNavigate('operations-identify')}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><path d="M3 7V5a2 2 0 0 1 2-2h2" /><path d="M17 3h2a2 2 0 0 1 2 2v2" /><path d="M21 17v2a2 2 0 0 1-2 2h-2" /><path d="M7 21H5a2 2 0 0 1-2-2v-2" /><line x1="7" y1="12" x2="17" y2="12" /><line x1="7" y1="8" x2="13" y2="8" /><line x1="7" y1="16" x2="11" y2="16" /></svg>
          <span className="flex-1 text-left">{t('ops.mode.identify')}</span>
        </button>
        <button
          type="button"
          aria-label={t('ops.mode.stow')}
          className="w-full rounded-2xl bg-success-dim text-success font-semibold py-4 px-5 text-lg border border-success/30 flex items-center gap-3"
          onClick={() => onNavigate('operations-stow')}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><path d="M12 3h7a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-7" /><path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h7" /><path d="M12 12v9" /><path d="M12 3v9" /><line x1="9" y1="15" x2="15" y2="15" /><line x1="12" y1="12" x2="12" y2="18" /></svg>
          <span className="flex-1 text-left">{t('ops.mode.stow')}</span>
          {stowList.length > 0 && <span className="bg-success/20 text-success text-sm font-bold px-2.5 py-0.5 rounded-full">{stowList.length}</span>}
        </button>
        <button
          type="button"
          aria-label={t('ops.mode.pick')}
          className="w-full rounded-2xl bg-warning-dim text-warning font-semibold py-4 px-5 text-lg border border-warning/20 flex items-center gap-3"
          onClick={() => onNavigate('operations-pick')}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><line x1="8" y1="8" x2="8.01" y2="8" /><line x1="12" y1="8" x2="16" y2="8" /><line x1="8" y1="12" x2="8.01" y2="12" /><line x1="12" y1="12" x2="16" y2="12" /><line x1="8" y1="16" x2="8.01" y2="16" /><line x1="12" y1="16" x2="16" y2="16" /></svg>
          <span className="flex-1 text-left">{t('ops.mode.pick')}</span>
          {pickList.length > 0 && <span className="bg-warning/20 text-warning text-sm font-bold px-2.5 py-0.5 rounded-full">{pickList.length}</span>}
        </button>
        <button
          type="button"
          aria-label={t('ops.mode.pack')}
          className="w-full rounded-2xl bg-app-surface text-txt-primary font-semibold py-4 px-5 text-lg border border-app-border flex items-center gap-3"
          onClick={() => onNavigate('operations-pack')}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" /><polyline points="3.27 6.96 12 12.01 20.73 6.96" /><line x1="12" y1="22.08" x2="12" y2="12" /></svg>
          <span className="flex-1 text-left">{t('ops.mode.pack')}</span>
          {readyToPackOrders.length > 0 && <span className="bg-accent/15 text-txt-secondary text-sm font-bold px-2.5 py-0.5 rounded-full">{readyToPackOrders.length}</span>}
        </button>
      </div>
    </div>
  );
};

export default MobileOperationsView;

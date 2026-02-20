import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Order, Product } from '../types';
import { getProductQuantity } from '../utils/product';
import { fetchOrders as fetchOrdersApi, syncOrders as syncOrdersApi, completeOrder, packOrder, stockInProduct, stockOutProduct } from '../api/client';
import { useI18n } from '../i18n';
import { compareBinCodesForPickRoute } from '../utils/warehouseRoute';
import type { UploadGroupPayload } from '../hooks/useIdentification';
import {
  Check, Camera, Search, Package, Minus, Plus, Image as ImageIcon,
  ScanBarcode, ChevronDown, Delete, Eye, Upload
} from 'lucide-react';

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
  <div>
    <div className="mob-section-title" style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>{title}</div>
    {desc && <p style={{ fontSize: 13, color: 'var(--text-tertiary)', marginTop: 2 }}>{desc}</p>}
  </div>
);

const StatusBadge: React.FC<{ label: string; tone?: 'neutral' | 'success' | 'warn' }> = ({ label, tone = 'neutral' }) => {
  const cls = tone === 'success' ? 'mob-order-badge done' : 'mob-order-badge';
  return <span className={cls}>{label}</span>;
};

const ProductCard: React.FC<{ product: Product; footer?: React.ReactNode }> = ({ product, footer }) => {
  const { t } = useI18n();
  return (
    <div className="mob-scanned-item">
      <div className="mob-scanned-item-header">
        <div className="mob-item-image">
          {product.details?.images?.[0]?.url_or_base64 ? (
            <img src={product.details.images[0].url_or_base64} alt="" />
          ) : (
            <ImageIcon size={24} />
          )}
        </div>
        <div className="mob-item-info">
          <div className="mob-item-name">{product.identification?.name}</div>
          <div className="mob-item-sku">
            {t('common.sku')} {product.identification?.sku || '—'} &middot; {t('common.bin')} {product.storage?.binCode || '—'}
          </div>
          <div className="mob-item-sku">{t('common.qty')} {getProductQuantity(product)}</div>
        </div>
      </div>
      {footer && <div>{footer}</div>}
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
  const [ordersLastOkIso, setOrdersLastOkIso] = useState<string | null>(null);
  const [activeBin, setActiveBin] = useState('');
  const [activeSku, setActiveSku] = useState('');
  const [highlightKey, setHighlightKey] = useState<string | null>(null);
  const [pickMessage, setPickMessage] = useState<string | null>(null);
  const [pickMessageTone, setPickMessageTone] = useState<'info' | 'success' | 'error' | null>(null);
  const [packMessage, setPackMessage] = useState<string | null>(null);
  const [packScopedOrderKey, setPackScopedOrderKey] = useState<string | null>(null);
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
          setOrdersLastOkIso(new Date().toISOString());
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
    const bucket: Record<
      string,
      {
        orderId: string;
        orderKey: string;
        orderNumber?: string | null;
        orderSourceId?: string | null;
        sku: string;
        name: string;
        binCode: string;
        qty: number;
      }
    > = {};
    ready.forEach((o) => {
      const orderKey = getOrderCouplingKey(o);
      const orderSourceId = getOrderSourceId(o);
      o.items.forEach((it) => {
        const sku = it.sku || it.id;
        const binCode = it.pickHint?.binCode || '—';
        const key = `${orderKey}::${sku}::${binCode}`;
        const qty = Number.isFinite(it.quantity) ? it.quantity : 1;
        if (!bucket[key]) {
          bucket[key] = {
            orderId: o.id,
            orderKey,
            orderNumber: o.number || o.baselinkerId || o.id,
            orderSourceId,
            sku,
            name: it.name,
            binCode,
            qty: 0,
          };
        }
        bucket[key].qty += qty;
      });
    });
    return Object.values(bucket).sort((a, b) => a.orderKey.localeCompare(b.orderKey));
  }, [readyToPackOrders, getOrderCouplingKey, getOrderSourceId]);

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
        setPickMessageTone('error');
        return;
      }
      if (typeof task.availableInBin === 'number' && Number.isFinite(task.availableInBin) && numeric > task.availableInBin) {
        setPickMessage(t('ops.mobile.pick.errorNotEnoughInBin', { available: task.availableInBin }));
        setPickMessageTone('error');
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
          setPickMessageTone('success');
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
        setPickMessage(
          t('ops.mobile.pick.errorGeneric', { message: err?.message || t('common.unknownError') })
        );
        setPickMessageTone('error');
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

        const orderIdentityMatches = readyToPackOrders.filter((o) => isOrderIdentityScanMatch(o, normalized));
        if (orderIdentityMatches.length === 1) {
          const selected = orderIdentityMatches[0];
          const selectedKey = getOrderCouplingKey(selected);
          setPackScopedOrderKey(selectedKey);
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

        const scopedOrders = packScopedOrderKey
          ? readyToPackOrders.filter((o) => getOrderCouplingKey(o) === packScopedOrderKey)
          : readyToPackOrders;
        const candidateOrders = scopedOrders.length ? scopedOrders : readyToPackOrders;

        const matches: Array<{ orderId: string; orderKey: string; orderNumber?: string | null }> = [];
        const seen = new Set<string>();
        for (const o of candidateOrders) {
          const hit = o.items.some((it) => equalsSkuScan(it.sku || '', normalized) || equalsSkuScan(it.ean || '', normalized));
          if (!hit) continue;
          const key = getOrderCouplingKey(o);
          if (seen.has(key)) continue;
          seen.add(key);
          matches.push({ orderId: o.id, orderKey: key, orderNumber: o.number || o.baselinkerId || o.id });
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
            setPackScopedOrderKey(target.orderKey);
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

      if (binMatches.length === 0 && skuMatches.length === 0) {
        setPickMessage(t('ops.mobile.pick.scan.noMatch', { value: rawTrimmed }));
        setPickMessageTone('error');
        return;
      }

      // Clear any previous pick status when new scans come in.
      setPickMessage(null);
      setPickMessageTone(null);

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
        setPickMessage(t('ops.mobile.pick.scan.ready'));
        setPickMessageTone('info');
        return;
      }

      if (nextBin && !nextSku) {
        setPickMessage(t('ops.mobile.pick.scan.needSku'));
        setPickMessageTone('info');
        return;
      }
      if (nextSku && !nextBin) {
        setPickMessage(t('ops.mobile.pick.scan.needBin'));
        setPickMessageTone('info');
        return;
      }
      setPickMessage(t('ops.mobile.pick.scan.ambiguous'));
      setPickMessageTone('error');
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
      isOrderIdentityScanMatch,
      getOrderCouplingKey,
      packScopedOrderKey,
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
      <div className="mob-content">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <SectionTitle title={t('ops.mode.identify')} />
          <button type="button" className="mob-pick-quick-btn" onClick={addIdentifySlot}>
            + {t('common.add')}
          </button>
        </div>
        {identifySlots.map((slot) => (
          <div key={slot} className="mob-identify-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <span className="mob-item-name">{t('input.groups.defaultName', { index: identifySlots.indexOf(slot) + 1 })}</span>
              <button
                type="button"
                className="mob-pick-quick-btn"
                onClick={() => clearIdentifySlot(slot)}
                disabled={!identifyImagesBySlot[slot]?.length}
                style={{ opacity: identifyImagesBySlot[slot]?.length ? 1 : 0.4 }}
              >
                {t('common.clear')}
              </button>
            </div>
            <div className="mob-identify-actions">
              <button type="button" className="mob-identify-camera-btn" onClick={() => triggerIdentifyInput(slot, 'camera')}>
                <Camera size={16} style={{ display: 'inline', verticalAlign: -2, marginRight: 6 }} />
                {t('common.camera')}
              </button>
              <button type="button" className="mob-identify-upload-btn" onClick={() => triggerIdentifyInput(slot, 'upload')}>
                <Upload size={16} style={{ display: 'inline', verticalAlign: -2, marginRight: 6 }} />
                {t('common.upload')}
              </button>
            </div>
            {identifyImagesBySlot[slot]?.length ? (
              <div style={{ marginBottom: 12 }}>
                <div className="mob-item-sku" style={{ marginBottom: 6 }}>{t('identifyQueue.files', { count: identifyImagesBySlot[slot].length })}</div>
                <div className="mob-identify-preview-grid">
                  {identifyImagesBySlot[slot].slice(0, 8).map((img) => (
                    <img key={img.id} src={img.previewUrl} alt="" className="mob-identify-preview-img" loading="lazy" />
                  ))}
                </div>
              </div>
            ) : null}
            <input
              ref={(el) => { cameraInputRefs.current[slot] = el; }}
              type="file"
              accept="image/*"
              capture="environment"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => { handleIdentifyFilesSelected(slot, e.currentTarget.files); e.currentTarget.value = ''; }}
            />
            <input
              ref={(el) => { uploadInputRefs.current[slot] = el; }}
              type="file"
              accept="image/*"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => { handleIdentifyFilesSelected(slot, e.currentTarget.files); e.currentTarget.value = ''; }}
            />
            <button
              type="button"
              className="mob-identify-run-btn"
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
    );
  }

  if (mode === 'operations-stow') {
    const showKeypad = Boolean(stowSku && stowBin);
    const resolvedProduct = stowSku ? resolveProductForStow(stowSku) : null;
    return (
      <div className="mob-content">
        {/* Scanner viewfinder */}
        <div className="mob-scanner-viewfinder">
          <div className="mob-viewfinder-corner bottom-left" />
          <div className="mob-viewfinder-corner bottom-right" />
          <div className="mob-scan-line" />
          <ScanBarcode className="mob-scan-icon" />
          <span className="mob-scan-text">{t('ops.mobile.scannerFocusHint')}</span>
        </div>

        {/* Manual input row */}
        <div className="mob-manual-input-row">
          <input
            type="text"
            className="mob-manual-input"
            placeholder={`${t('common.sku')} / EAN`}
            inputMode="text"
            autoComplete="off"
            value={stowSku}
            onChange={(e) => setStowSku(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleScannedValue(stowSku); }}
          />
          <button type="button" className="mob-manual-submit" onClick={() => handleScannedValue(stowSku)}>
            <Search size={20} />
          </button>
        </div>

        {/* Scanned item card */}
        {stowSku && (
          <div className="mob-scanned-item">
            <div className="mob-scanned-item-header">
              <div className="mob-item-image">
                {resolvedProduct?.details?.images?.[0]?.url_or_base64 ? (
                  <img src={resolvedProduct.details.images[0].url_or_base64} alt="" />
                ) : (
                  <ImageIcon size={24} />
                )}
              </div>
              <div className="mob-item-info">
                <div className="mob-item-name">{resolvedProduct?.identification?.name || stowSku}</div>
                <div className="mob-item-sku">{stowSku}</div>
              </div>
            </div>

            {stowMessage && (
              <div className="mob-banner success" style={{ marginBottom: 16 }}>{stowMessage}</div>
            )}

            <div className="mob-bin-target">
              <div>
                <div className="mob-bin-label">{t('common.bin')}</div>
                <div className="mob-bin-value">{stowBin || '—'}</div>
              </div>
            </div>

            {showKeypad ? (
              <>
                <div className="mob-quantity-row">
                  <span className="mob-quantity-label">{t('ops.mobile.qtyScannerOrPad')}</span>
                  <div className="mob-quantity-stepper">
                    <button type="button" className="mob-qty-btn" onClick={() => setStowQty((prev) => Math.max(1, prev - 1))}>
                      <Minus size={18} />
                    </button>
                    <div className="mob-qty-value">{stowQty}</div>
                    <button type="button" className="mob-qty-btn" onClick={() => setStowQty((prev) => prev + 1)}>
                      <Plus size={18} />
                    </button>
                  </div>
                </div>

                <div className="mob-keypad" style={{ marginBottom: 16 }}>
                  {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
                    <button key={n} type="button" className="mob-keypad-btn" onClick={() => setStowQty((prev) => Number(`${prev}${n}`))}>
                      {n}
                    </button>
                  ))}
                  <button type="button" className="mob-keypad-btn" onClick={() => setStowQty((prev) => Math.max(0, Math.floor(prev / 10)))}>
                    <Delete size={18} />
                  </button>
                  <button type="button" className="mob-keypad-btn" onClick={() => setStowQty((prev) => Number(`${prev}0`))}>
                    0
                  </button>
                  <button type="button" className="mob-keypad-btn" onClick={() => setStowQty(0)}>
                    C
                  </button>
                </div>

                <button
                  type="button"
                  className="mob-stow-btn"
                  disabled={!stowSku || !stowBin || stowQty <= 0}
                  onClick={handleSubmitStow}
                >
                  <Check size={20} />
                  {t('ops.stow.submit')}
                </button>
              </>
            ) : (
              <button
                type="button"
                className="mob-pick-cancel-btn"
                style={{ width: '100%' }}
                onClick={() => { setStowSku(''); setStowBin(''); setStowQty(1); }}
              >
                {t('common.reset')}
              </button>
            )}
          </div>
        )}

        {/* Stow history */}
        {stowEntries.length > 0 && (
          <>
            <div className="mob-section-title">{t('ops.mobile.stow.sessionTitle')}</div>
            <div className="mob-stow-history">
              {stowEntries.map((entry, idx) => (
                <div key={`${entry.sku}-${entry.bin}-${idx}`} className="mob-history-item">
                  <div className="mob-history-check"><Check size={14} /></div>
                  <div className="mob-history-info">
                    <div className="mob-history-name">{entry.sku}</div>
                    <div className="mob-history-meta">
                      <span className="mob-history-bin">{entry.bin}</span>
                      <span>x{entry.qty}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    );
  }

  if (mode === 'operations-pick') {
    const nextTask = pickTasks[0] || null;
    const nextBinGroupCount = nextTask?.binCode
      ? pickTasks.filter((it) => equalsIgnoreCase(it.binCode, nextTask.binCode)).length
      : 0;
    const expectedScan: 'bin' | 'sku' | 'qty' =
      pendingPick
        ? 'qty'
        : !activeBin && !activeSku
          ? 'bin'
          : activeBin && !activeSku
            ? 'sku'
            : !activeBin && activeSku
              ? 'bin'
              : 'bin';

    return (
      <div className="mob-content">
        {/* Order card / scan status */}
        {ordersError ? (
          <div className="mob-banner error" style={{ marginBottom: 16 }}>
            <strong>{t('ops.errors.ordersLoad')}</strong>
            <div style={{ fontSize: 12, marginTop: 4, wordBreak: 'break-word' }}>{ordersError}</div>
          </div>
        ) : null}

        <div className="mob-scan-status">
          <div className="mob-scan-status-grid">
            <div className={`mob-scan-box${expectedScan === 'bin' ? ' active' : ''}`}>
              <div className="mob-scan-box-label">{t('common.bin')}</div>
              <div className="mob-scan-box-value large">{activeBin || `${t('ops.actions.scan')} ${t('common.bin')}`}</div>
            </div>
            <div className={`mob-scan-box${expectedScan === 'sku' ? ' active' : ''}`}>
              <div className="mob-scan-box-label">{t('common.sku')}</div>
              <div className="mob-scan-box-value">{activeSku || `${t('ops.actions.scan')} ${t('common.sku')}`}</div>
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginTop: 10 }}>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              {pendingPick ? t('ops.mobile.pick.qtyPadHint') : t('ops.mobile.scannerFocusHint')}
              {ordersLastOkIso ? (
                <span style={{ display: 'block', fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>
                  {new Date(ordersLastOkIso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              ) : null}
            </div>
            <button
              type="button"
              className="mob-pick-quick-btn"
              onClick={() => {
                setActiveBin('');
                setActiveSku('');
                setPendingPick(null);
                setPendingPickQty(1);
                setHighlightKey(null);
                setPickMessage(null);
                setPickMessageTone(null);
              }}
            >
              {t('common.reset')}
            </button>
          </div>
          {pickMessage ? (
            <div
              className={`mob-banner ${pickMessageTone === 'error' ? 'error' : 'success'}`}
              style={{ marginTop: 8 }}
            >
              {pickMessage}
            </div>
          ) : null}
          {ordersLoading ? <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 8 }}>{t('ops.orders.loading')}</div> : null}
        </div>

        {/* Pending pick task panel / next task hint */}
        <div className="mob-pick-task-panel">
          {pendingPick ? (
            <>
              <div className="mob-order-header">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="mob-item-name" style={{ lineHeight: 1.3 }}>{pendingPick.name}</div>
                  <div className="mob-item-sku" style={{ marginTop: 4 }}>
                    {t('common.order')} {pendingPick.orderNumber || pendingPick.orderId}
                  </div>
                </div>
                <StatusBadge label={t('ops.badge.pick')} tone="warn" />
              </div>
              <div className="mob-scan-status-grid" style={{ marginTop: 8 }}>
                <div className="mob-scan-box">
                  <div className="mob-scan-box-label">{t('common.bin')}</div>
                  <div className="mob-scan-box-value large">{pendingPick.binCode || '—'}</div>
                </div>
                <div className="mob-scan-box">
                  <div className="mob-scan-box-label">{t('common.sku')}</div>
                  <div className="mob-scan-box-value">{pendingPick.sku || '—'}</div>
                </div>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 8 }}>
                <strong style={{ color: 'var(--text-primary)' }}>
                  {t('ops.labels.openRemaining', { count: pendingPick.remainingTotal })}
                </strong>
                {typeof pendingPick.availableInBin === 'number' ? (
                  <>
                    {' '}&middot;{' '}
                    <strong style={{ color: 'var(--text-primary)' }}>
                      {t('ops.mobile.availableInBin', { value: pendingPick.availableInBin })}
                    </strong>
                  </>
                ) : null}
              </div>
            </>
          ) : pickTasks.length === 0 && !ordersLoading ? (
            <div style={{ fontSize: 14, color: 'var(--text-secondary)' }}>{t('ops.orders.none')}</div>
          ) : nextTask ? (
            <>
              <div className="mob-scan-box-label" style={{ marginBottom: 8 }}>{t('ops.labels.nextPick')}</div>
              <div className="mob-scan-status-grid">
                <div className="mob-scan-box">
                  <div className="mob-scan-box-label">{t('common.bin')}</div>
                  <div className="mob-scan-box-value large">{nextTask.binCode || '—'}</div>
                  {nextBinGroupCount > 1 ? (
                    <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>
                      {t('ops.mobile.pick.binGroupCount', { count: nextBinGroupCount })}
                    </div>
                  ) : null}
                </div>
                <div className="mob-scan-box">
                  <div className="mob-scan-box-label">{t('common.sku')}</div>
                  <div className="mob-scan-box-value">{nextTask.sku}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>
                    {t('ops.labels.openRemaining', { count: nextTask.remainingTotal })}
                  </div>
                </div>
              </div>
            </>
          ) : null}
        </div>

        {/* Route list (collapsible) */}
        {!pendingPick && pickTasks.length > 0 ? (
          <div className="mob-route-details">
            <details>
              <summary style={{ cursor: 'pointer', padding: '12px 16px', listStyle: 'none', display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontWeight: 600, fontSize: 14, color: 'var(--text-primary)' }}>
                <span>{t('ops.mobile.route')} ({pickTasks.length})</span>
                <ChevronDown size={16} style={{ color: 'var(--text-tertiary)' }} />
              </summary>
              <div className="mob-route-body">
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
                      className={`mob-route-item${isHighlighted ? ' highlighted' : ''}`}
                      style={{ width: '100%', textAlign: 'left' }}
                    >
                      <div className="mob-route-item-info">
                        <div className="mob-route-item-name">{task.name}</div>
                        <div className="mob-route-item-meta">
                          <span>{t('common.order')} {task.orderNumber || task.orderId}</span>
                          <span>{t('common.sku')}: {task.sku}</span>
                          <span>{t('ops.labels.openRemaining', { count: task.remainingTotal })}</span>
                        </div>
                      </div>
                      <div className="mob-route-item-bin">{task.binCode || '—'}</div>
                    </button>
                  );
                })}
              </div>
            </details>
          </div>
        ) : null}

        {/* Bottom bar with qty stepper and confirm/cancel */}
        {pendingPick ? (
          <div className="mob-pick-bottom-bar">
            {(() => {
              const maxAllowed =
                typeof pendingPick.availableInBin === 'number'
                  ? Math.max(0, Math.min(pendingPick.remainingTotal, pendingPick.availableInBin))
                  : Math.max(0, pendingPick.remainingTotal);

              const clampQty = (raw: number) => {
                const n = Number(raw) || 0;
                if (n <= 0) return 0;
                return Math.min(n, maxAllowed || n);
              };

              return (
                <>
                  <div className="mob-pick-qty-stepper">
                    <button
                      type="button"
                      className="mob-pick-qty-btn"
                      onClick={() => setPendingPickQty((prev) => clampQty((Number(prev) || 0) - 1))}
                    >
                      <Minus size={20} />
                    </button>
                    <div className="mob-pick-qty-display">{pendingPickQty}</div>
                    <button
                      type="button"
                      className="mob-pick-qty-btn"
                      onClick={() => setPendingPickQty((prev) => clampQty((Number(prev) || 0) + 1))}
                    >
                      <Plus size={20} />
                    </button>
                  </div>
                  <div className="mob-pick-quick-amounts">
                    <button type="button" className="mob-pick-quick-btn" onClick={() => setPendingPickQty(clampQty(1))}>1</button>
                    <button type="button" className="mob-pick-quick-btn" onClick={() => setPendingPickQty(clampQty(pendingPick.suggestedQty || 1))}>{t('ops.orders.auto')}</button>
                    <button type="button" className="mob-pick-quick-btn" onClick={() => setPendingPickQty(clampQty(maxAllowed || pendingPick.remainingTotal || 1))}>Max</button>
                    <button type="button" className="mob-pick-quick-btn" onClick={() => setPendingPickQty(0)}>{t('common.clear')}</button>
                  </div>
                  <div className="mob-pick-actions">
                    <button
                      type="button"
                      className="mob-pick-confirm-btn"
                      disabled={!pendingPickQty || pendingPickQty <= 0}
                      onClick={() => void submitPick(pendingPick, pendingPickQty)}
                    >
                      {t('ops.pick.submit')}
                    </button>
                    <button
                      type="button"
                      className="mob-pick-cancel-btn"
                      onClick={() => {
                        setPendingPick(null);
                        setPendingPickQty(1);
                        setActiveBin('');
                        setActiveSku('');
                        setHighlightKey(null);
                      }}
                    >
                      {t('common.cancel')}
                    </button>
                  </div>
                </>
              );
            })()}
          </div>
        ) : null}
      </div>
    );
  }

  if (mode === 'operations-pack') {
    const scopedOrderPreview = packScopedOrderKey
      ? packItems.find((item) => item.orderKey === packScopedOrderKey) || null
      : null;
    return (
      <div className="mob-content">
        <SectionTitle title={t('ops.mode.pack')} />

        {packMessage ? (
          <div className="mob-banner success" style={{ marginTop: 12 }}>{packMessage}</div>
        ) : null}

        {packScopedOrderKey ? (
          <div className="mob-pack-card selected" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 }}>
            <span style={{ fontSize: 14, color: 'var(--text-primary)' }}>
              {t('ops.mobile.pack.scope.active')}: <strong>{scopedOrderPreview?.orderNumber || packScopedOrderKey}</strong>
            </span>
            <button type="button" className="mob-pick-quick-btn" onClick={() => setPackScopedOrderKey(null)}>
              {t('common.reset')}
            </button>
          </div>
        ) : null}

        {ordersLoading && <div style={{ fontSize: 14, color: 'var(--text-tertiary)', marginTop: 12 }}>{t('ops.orders.loading')}</div>}
        {packItems.length === 0 && !ordersLoading && (
          <div className="mob-completion-screen">
            <div className="mob-completion-icon"><Check size={40} /></div>
            <div className="mob-completion-title">{t('ops.mobile.pack.none')}</div>
          </div>
        )}

        <div style={{ marginTop: 12 }}>
          {packItems.slice(0, 100).map((item) => (
            <button
              type="button"
              key={`${item.orderKey}-${item.sku}-${item.binCode}`}
              onClick={() => setPackScopedOrderKey(item.orderKey)}
              className={`mob-pack-card${packScopedOrderKey === item.orderKey ? ' selected' : ''}`}
              style={{ width: '100%', textAlign: 'left' }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="mob-item-name" style={{ marginBottom: 6 }}>{item.name}</div>
                  <div className="mob-route-item-meta">
                    <span>{t('common.order')}: <strong>{item.orderNumber || item.orderId}</strong></span>
                    {item.orderSourceId ? <span>{t('ops.mobile.pack.scope.source')}: <strong>{item.orderSourceId}</strong></span> : null}
                    <span>{t('common.sku')}: <strong>{item.sku || '—'}</strong></span>
                    <span>{t('common.bin')}: <strong>{item.binCode || '—'}</strong></span>
                  </div>
                </div>
                <div style={{ flexShrink: 0, textAlign: 'right' }}>
                  <div className="mob-scan-box-label">{t('common.qty')}</div>
                  <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{item.qty}</div>
                  <div style={{ marginTop: 4 }}><StatusBadge label={t('ops.badge.pack')} tone="warn" /></div>
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>
    );
  }

  // Hub
  return (
    <div className="mob-content">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-primary)' }}>{t('ops.title')}</div>
          <div style={{ fontSize: 13, color: 'var(--text-tertiary)', marginTop: 2 }}>{t('ops.subtitle')}</div>
        </div>
        <div style={{ textAlign: 'right', fontSize: 12, color: 'var(--text-tertiary)' }}>
          <div>{t('ops.mode.stow')}: {stowList.length}</div>
          <div>{t('ops.mode.pick')}: {pickList.length}</div>
          <div>{t('ops.mode.pack')}: {packList.length}</div>
        </div>
      </div>
      <button type="button" className="mob-hub-btn" style={{ background: 'var(--avy-purple)' }} onClick={() => onNavigate('operations-identify')}>
        <Eye size={20} />
        {t('ops.mode.identify')}
      </button>
      <button type="button" className="mob-hub-btn" style={{ background: 'var(--success)' }} onClick={() => onNavigate('operations-stow')}>
        <Package size={20} />
        {t('ops.mode.stow')}
      </button>
      <button type="button" className="mob-hub-btn" style={{ background: 'var(--warning)' }} onClick={() => onNavigate('operations-pick')}>
        <Check size={20} />
        {t('ops.mode.pick')}
      </button>
      <button type="button" className="mob-hub-btn" style={{ background: 'var(--surface-secondary)', color: 'var(--text-primary)' }} onClick={() => onNavigate('operations-pack')}>
        <Package size={20} />
        {t('ops.mode.pack')}
      </button>
    </div>
  );
};

export default MobileOperationsView;

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BrowserMultiFormatReader } from '@zxing/browser';
import { Product, WarehouseBin, Order } from '../../types';
import {
  fetchWarehouseBinDetail,
  stockInProduct,
  stockOutProduct,
  buildImageProxyUrl,
  fetchOrders as fetchOrdersApi,
  syncOrders as syncOrdersApi,
  completeOrder as completeOrderApi,
} from '../../api/client';
import { ScannerOverlay } from '../shared/ScannerOverlay';
import { WarehouseIcon, SyncIcon, CameraIcon } from '../icons/Icons';
import { useI18n } from '../../i18n';
import { addMediaQueryListener } from '../../utils/mediaQuery';
import { compareBinCodesForPickRoute } from '../../utils/warehouseRoute';

interface OperationsViewProps {
  products: Product[];
  onProductUpdate: (product: Product) => void;
  onStockChanged?: (bin: WarehouseBin) => void;
  onSwitchView?: (
    view: 'dashboard' | 'input' | 'sheet' | 'inventory' | 'warehouse' | 'operations' | 'queue'
  ) => void;
}

type WorkflowMode = 'stow' | 'pick';
type ScannerTarget = 'stowSku' | 'stowBin' | 'pickBin' | 'pickSku';

type PickRouteTask = {
  orderId: string;
  orderNumber?: string | null;
  customer?: string | null;
  itemId: string;
  itemName: string;
  sku?: string | null;
  binCode: string;
  quantity: number;
  itemTotal: number;
  remainingTotal: number;
  pickedSoFar: number;
  productId?: string | null;
  available?: number | null;
  image?: string | null;
};

type ScanStatus = 'pending' | 'ok' | 'mismatch';

const WORKFLOW_CARDS: Array<{
  mode: WorkflowMode;
  titleKey: string;
  subtitleKey: string;
  icon: React.ReactNode;
}> = [
    {
      mode: 'stow',
      titleKey: 'ops.mode.stow',
      subtitleKey: 'ops.mode.stow.subtitle',
      icon: <WarehouseIcon className="w-8 h-8" />,
    },
    {
      mode: 'pick',
      titleKey: 'ops.mode.pick',
      subtitleKey: 'ops.mode.pick.subtitle',
      icon: <SyncIcon className="w-8 h-8" />,
    },
  ];

/* ────────── Inline SVG helpers ────────── */
const ScannerSvg = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M3 5V3h4M13 3h4v2M3 15v2h4M13 17h4v-2M7 7v6M10 7v6M13 7v6" />
  </svg>
);

const CheckSvg = ({ size = 12 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M2 6l3 3 5-6" />
  </svg>
);

const ArrowRightSvg = ({ color = 'var(--text-tertiary)' }: { color?: string }) => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke={color} strokeWidth="1.5">
    <path d="M3 7h8M8 4l3 3-3 3" />
  </svg>
);

const ChevronRightSvg = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M6 4l4 4-4 4" />
  </svg>
);

const StowArrowSvg = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M14 10v5a1 1 0 01-1 1H5a1 1 0 01-1-1v-5M9 2v9M6 5l3-3 3 3" />
  </svg>
);

const PickArrowSvg = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M4 10v5a1 1 0 001 1h8a1 1 0 001-1v-5M9 12V2M6 9l3 3 3-3" />
  </svg>
);

const BinSvg = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M2 12V5l5-3 5 3v7M2 5h10M5 12V9h4v3" />
  </svg>
);

const ImagePlaceholderSvg = () => (
  <svg width="32" height="32" viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.2">
    <rect x="4" y="4" width="24" height="24" rx="4" />
    <circle cx="12" cy="14" r="3" />
    <path d="M4 24l6-6 4 4 6-8 8 10" />
  </svg>
);

const ThumbSvg = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" className="w-4 h-4">
    <rect x="2" y="2" width="12" height="12" rx="2" />
  </svg>
);

export const OperationsView: React.FC<OperationsViewProps> = ({ products, onProductUpdate, onStockChanged, onSwitchView }) => {
  const { t } = useI18n();
  const [isMobile, setIsMobile] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.matchMedia('(max-width: 768px)').matches : false
  );
  const [workflow, setWorkflow] = useState<WorkflowMode>('stow');
  const [scannerTarget, setScannerTarget] = useState<ScannerTarget | null>(null);

  const [stowSku, setStowSku] = useState('');
  const [stowBin, setStowBin] = useState('');
  const [stowQuantity, setStowQuantity] = useState<number | ''>('');

  const [pickBin, setPickBin] = useState('');
  const [pickSku, setPickSku] = useState('');
  const [pickQuantity, setPickQuantity] = useState<number | ''>('');
  const [pickBinDetail, setPickBinDetail] = useState<WarehouseBin | null>(null);
  const [isLoadingBin, setIsLoadingBin] = useState(false);
  const [pickScanStatus, setPickScanStatus] = useState<{ bin: ScanStatus; sku: ScanStatus }>({
    bin: 'pending',
    sku: 'pending',
  });
  const [pickedByItemId, setPickedByItemId] = useState<Record<string, number>>({});
  const [skippedPickItemIds, setSkippedPickItemIds] = useState<string[]>([]);

  const [orders, setOrders] = useState<Order[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [ordersError, setOrdersError] = useState<string | null>(null);
  const [orderStatusMessage, setOrderStatusMessage] = useState<string | null>(null);
  const [orderErrorMessage, setOrderErrorMessage] = useState<string | null>(null);
  const [isSyncingOrders, setIsSyncingOrders] = useState(false);
  const [showAllOpenOrders, setShowAllOpenOrders] = useState(false);
  const [autoOrderSync, setAutoOrderSync] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem('avystock:autoOrderSync') === 'true';
  });
  const autoSyncIntervalRef = useRef<number | null>(null);

  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const fallbackReaderRef = useRef<BrowserMultiFormatReader | null>(null);
  const [isFallbackDecoding, setIsFallbackDecoding] = useState(false);
  const stowSkuRef = useRef<HTMLInputElement | null>(null);
  const stowBinRef = useRef<HTMLInputElement | null>(null);
  const [showOrdersPanel, setShowOrdersPanel] = useState<boolean>(() => !isMobile);
  const lastAutoBinRef = useRef<string | null>(null);

  const matchedStowProduct = useMemo(() => {
    if (!stowSku.trim()) return null;
    const normalized = stowSku.trim().toLowerCase();
    return (
      products.find((p) => {
        const skuCandidates = [
          p.identification?.sku,
          p.details?.identifiers?.sku,
          p.details?.identifiers?.ean,
          p.details?.identifiers?.gtin,
          p.details?.identifiers?.upc,
          p.id,
        ]
          .filter(Boolean)
          .map((val) => String(val).toLowerCase());
        const barcodeMatch = (p.identification?.barcodes || []).some((code) => code?.toLowerCase() === normalized);
        return skuCandidates.includes(normalized) || barcodeMatch;
      }) || null
    );
  }, [products, stowSku]);

  const matchedPickProduct = useMemo(() => {
    if (!pickSku.trim()) return null;
    const normalized = pickSku.trim().toLowerCase();
    if (pickBinDetail?.products) {
      const entry = pickBinDetail.products.find((item) => {
        const skuCandidates = [item.sku, item.productId].filter(Boolean).map((v) => String(v).toLowerCase());
        return skuCandidates.includes(normalized);
      });
      if (entry) {
        return products.find((p) => p.id === entry.productId) || null;
      }
    }
    return (
      products.find((p) => {
        const skuCandidates = [
          p.identification?.sku,
          p.details?.identifiers?.sku,
          p.details?.identifiers?.ean,
          p.details?.identifiers?.gtin,
          p.details?.identifiers?.upc,
          p.id,
        ]
          .filter(Boolean)
          .map((val) => String(val).toLowerCase());
        const barcodeMatch = (p.identification?.barcodes || []).some((code) => code?.toLowerCase() === normalized);
        return skuCandidates.includes(normalized) || barcodeMatch;
      }) || null
    );
  }, [products, pickSku, pickBinDetail]);

  const skippedPickItemSet = useMemo(() => new Set(skippedPickItemIds), [skippedPickItemIds]);

  const openOrders = useMemo(() => orders.filter((order) => order.status === 'new'), [orders]);
  const visibleOrders = useMemo(
    () => (showAllOpenOrders ? openOrders : openOrders.slice(0, 5)),
    [openOrders, showAllOpenOrders]
  );

  const resolveImageSrc = useCallback((value?: string | null) => {
    if (!value) return '';
    if (value.startsWith('data:') || value.startsWith('blob:')) {
      return value;
    }
    return buildImageProxyUrl(value);
  }, []);

  const renderScanStatusBadge = useCallback(
    (status: ScanStatus) => {
      const base = 'px-2 py-0.5 rounded-full text-[11px] font-semibold uppercase tracking-wide';
      if (status === 'ok') {
        return <span className={`${base} bg-[var(--success-bg)] text-[var(--success)]`}>{t('ops.pick.steps.ok')}</span>;
      }
      if (status === 'mismatch') {
        return <span className={`${base} bg-[var(--error-bg)] text-[var(--error)]`}>{t('ops.pick.steps.mismatch')}</span>;
      }
      return <span className={`${base} bg-[var(--surface-secondary)] text-[var(--text-secondary)]`}>{t('ops.pick.steps.pending')}</span>;
    },
    [t]
  );

  useEffect(() => {
    if (openOrders.length <= 5 && showAllOpenOrders) {
      setShowAllOpenOrders(false);
    }
  }, [openOrders.length, showAllOpenOrders]);

  useEffect(() => {
    const stillOpenIds = new Set<string>();
    openOrders.forEach((order) => order.items.forEach((item) => stillOpenIds.add(item.id)));

    setSkippedPickItemIds((prev) => prev.filter((id) => stillOpenIds.has(id)));
    setPickedByItemId((prev) => {
      const next: Record<string, number> = {};
      Object.entries(prev).forEach(([id, qty]) => {
        if (stillOpenIds.has(id)) {
          next[id] = qty;
        }
      });
      return next;
    });
  }, [openOrders]);

  const orderSummary = useMemo(() => {
    const total = orders.length;
    const open = openOrders.length;
    const pickedToday = orders.filter((order) => {
      if (!order.pickedAt) return false;
      const pickedDate = new Date(order.pickedAt).toDateString();
      return pickedDate === new Date().toDateString();
    }).length;
    return { total, open, pickedToday };
  }, [orders, openOrders]);

  const formatOrderDate = (iso?: string | null) => {
    if (!iso) return '--';
    try {
      return new Date(iso).toLocaleString('de-DE');
    } catch {
      return iso;
    }
  };

  const resolveProductForItem = useCallback(
    (item: { productId?: string | null; sku?: string | null; ean?: string | null }) => {
      if (item.productId) {
        const byId = products.find((p) => p.id === item.productId);
        if (byId) return byId;
      }
      const searchKeys = [item.sku, item.ean].filter(Boolean).map((value) => String(value).toLowerCase());
      if (!searchKeys.length) {
        return null;
      }
      return (
        products.find((product) => {
          const candidateValues = [
            product.identification?.sku,
            product.details?.identifiers?.sku,
            product.details?.identifiers?.ean,
            product.details?.identifiers?.gtin,
            product.details?.identifiers?.upc,
            product.id,
            ...(product.identification?.barcodes || []),
          ]
            .filter(Boolean)
            .map((val) => String(val).toLowerCase());
          return candidateValues.some((candidate) => searchKeys.includes(candidate));
        }) || null
      );
    },
    [products]
  );

  const pickRouteTasks = useMemo(() => {
    const tasks: PickRouteTask[] = [];

    const normalizeSku = (value?: string | null) =>
      (value || '').toString().trim().toUpperCase();

    // Allocate available BIN quantities across tasks deterministically so split stock
    // doesn't produce impossible pick routes (e.g. 2 picks from a BIN that only has 1).
    const binPoolByProductId = new Map<string, Array<{ code: string; quantity: number }>>();

    const getBinPool = (product: Product): Array<{ code: string; quantity: number }> => {
      const cached = binPoolByProductId.get(product.id);
      if (cached) return cached;

      const bins = Array.isArray(product.storageBins) ? product.storageBins : [];
      const pool = bins
        .filter((b) => b && b.code && Number(b.quantity || 0) > 0)
        .map((b) => ({ code: String(b.code).toUpperCase(), quantity: Number(b.quantity || 0) || 0 }))
        .filter((b) => b.quantity > 0);

      if (!pool.length && product.storage?.binCode) {
        const base = Number(product.storage.quantity || 0) || 0;
        if (base > 0) {
          pool.push({ code: String(product.storage.binCode).toUpperCase(), quantity: base });
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
      order.items.forEach((item) => {
        if (skippedPickItemSet.has(item.id)) return;

        const pickedSoFar = Number(pickedByItemId[item.id] || 0) || 0;
        const itemTotal = Number(item.quantity || 0) || 0;
        const remainingTotal = Math.max(0, itemTotal - pickedSoFar);
        if (!remainingTotal) return;

        const hint = item.pickHint || null;
        const product = resolveProductForItem(item);

        const skuCandidate =
          normalizeSku(item.sku) ||
          normalizeSku(hint?.sku) ||
          normalizeSku(item.ean) ||
          normalizeSku(product?.details?.identifiers?.sku) ||
          normalizeSku(product?.identification?.sku) ||
          normalizeSku(product?.details?.identifiers?.ean) ||
          normalizeSku(product?.details?.identifiers?.gtin) ||
          normalizeSku(product?.id) ||
              null;

        if (!skuCandidate) return;

        const allocatedBin = chooseAllocatableBin(product);
        const fallbackHintBin = hint?.binCode ? String(hint.binCode).toUpperCase() : '';
        const bestBin = allocatedBin || (fallbackHintBin ? { code: fallbackHintBin, quantity: Number(hint.quantityAvailable || 0) || 0 } : null);

        const binCode = bestBin?.code || '';
        const availableInBin =
          Number.isFinite(Number(bestBin?.quantity))
            ? Number(bestBin?.quantity || 0)
            : typeof hint?.quantityAvailable === 'number'
              ? hint.quantityAvailable
              : null;

        const pickNow =
          typeof availableInBin === 'number' && Number.isFinite(availableInBin) && availableInBin > 0
            ? Math.max(1, Math.min(remainingTotal, availableInBin))
            : remainingTotal;

        if (allocatedBin) {
          allocatedBin.quantity = Math.max(0, allocatedBin.quantity - pickNow);
        }

        tasks.push({
          orderId: order.id,
          orderNumber: order.number,
          customer: order.customer?.name,
          itemId: item.id,
          itemName: hint?.productName || product?.identification?.name || item.name,
          sku: skuCandidate,
          binCode,
          quantity: pickNow,
          itemTotal,
          remainingTotal,
          pickedSoFar,
          productId: hint?.productId || product?.id || item.productId || undefined,
          available: typeof availableInBin === 'number' && Number.isFinite(availableInBin) ? availableInBin : null,
          image: hint?.image || product?.details?.images?.[0]?.url_or_base64 || null,
        });
      });
    });

    tasks.sort((a, b) => {
      const aHasBin = Boolean(a.binCode);
      const bHasBin = Boolean(b.binCode);
      if (aHasBin !== bHasBin) return aHasBin ? -1 : 1;
      return compareBinCodesForPickRoute(a.binCode, b.binCode);
    });

    return tasks;
  }, [openOrders, resolveProductForItem, skippedPickItemSet, pickedByItemId]);

  const nextPickTask = pickRouteTasks[0] || null;

  const resetPickForm = useCallback(() => {
    if (workflow !== 'pick') return;
    setPickBin('');
    setPickSku('');
    setPickQuantity(nextPickTask?.quantity || 1);
    setPickScanStatus({ bin: 'pending', sku: 'pending' });
  }, [nextPickTask, workflow]);

  useEffect(() => {
    if (workflow !== 'pick') return;
    if (!nextPickTask) return;
    if (pickScanStatus.bin !== 'pending' || pickScanStatus.sku !== 'pending') return;
    setPickQuantity(nextPickTask.quantity || 1);
  }, [workflow, nextPickTask?.itemId, nextPickTask?.binCode, nextPickTask?.quantity, pickScanStatus.bin, pickScanStatus.sku]);

  const evaluateScanStatus = useCallback(
    (type: 'bin' | 'sku', value: string): ScanStatus => {
      const task = nextPickTask;
      if (!task || !value) {
        return 'pending';
      }
      if (type === 'bin') {
        const expected = task.binCode?.toUpperCase();
        if (!expected) {
          return value ? 'ok' : 'pending';
        }
        return value.toUpperCase() === expected ? 'ok' : 'mismatch';
      }
      const expectedSku = (task.sku || '').trim().toLowerCase();
      if (!expectedSku) {
        return 'ok';
      }
      return value.trim().toLowerCase() === expectedSku ? 'ok' : 'mismatch';
    },
    [nextPickTask]
  );

  const handleScannerResult = (value: string) => {
    switch (scannerTarget) {
      case 'stowSku':
        setStowSku(value);
        break;
      case 'stowBin':
        setStowBin(value.toUpperCase());
        break;
      case 'pickBin': {
        const normalized = value.toUpperCase();
        setPickBin(normalized);
        setPickScanStatus((prev) => ({
          ...prev,
          bin: evaluateScanStatus('bin', normalized),
        }));
        loadBinDetail(normalized);
        break;
      }
      case 'pickSku': {
        setPickSku(value);
        setPickScanStatus((prev) => ({
          ...prev,
          sku: evaluateScanStatus('sku', value),
        }));
        break;
      }
      default:
        break;
    }
    setScannerTarget(null);
  };

  const loadFallbackReader = async () => {
    if (fallbackReaderRef.current) {
      return fallbackReaderRef.current;
    }
    const module = await import('@zxing/browser');
    fallbackReaderRef.current = new module.BrowserMultiFormatReader();
    return fallbackReaderRef.current;
  };

  const handleFallbackCapture = () => {
    setErrorMessage(null);
    fileInputRef.current?.click();
  };

  const handleFallbackFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setIsFallbackDecoding(true);
    setStatusMessage(t('ops.status.analyzingPhoto'));
    setErrorMessage(null);
    try {
      const reader = await loadFallbackReader();
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.src = url;
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error(t('ops.errors.imageLoad')));
      });
      const result = await reader.decodeFromImageElement(img);
      const value = (result?.getText?.() ?? (result as any)?.text ?? '').trim();
      if (value) {
        handleScannerResult(value);
        setStatusMessage(t('ops.status.codeCaptured'));
      } else {
        setErrorMessage(t('ops.errors.scanInvalid'));
      }
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Fallback decode failed:', error);
      setErrorMessage(t('ops.errors.scanInvalid'));
    } finally {
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      setIsFallbackDecoding(false);
    }
  };

  const loadBinDetail = async (code: string) => {
    if (!code) {
      setPickBinDetail(null);
      return;
    }
    setIsLoadingBin(true);
    setErrorMessage(null);
    try {
      const detail = await fetchWarehouseBinDetail(code.toUpperCase());
      setPickBinDetail(detail);
    } catch (error: any) {
      setErrorMessage(error?.message || t('ops.errors.binLoad'));
      setPickBinDetail(null);
    } finally {
      setIsLoadingBin(false);
    }
  };

  const handleSyncOrders = async (showToast = true) => {
    try {
      setIsSyncingOrders(true);
      setOrderErrorMessage(null);
      const data = await syncOrdersApi();
      setOrders(data);
      if (showToast) {
        setOrderStatusMessage(t('ops.orders.syncSuccess', { count: data.length }));
        window.setTimeout(() => setOrderStatusMessage(null), 4000);
      }
    } catch (error: any) {
      console.error('Order sync failed', error);
      setOrderErrorMessage(t('ops.orders.syncError'));
    } finally {
      setIsSyncingOrders(false);
    }
  };

  const handleAutoSyncToggle = () => {
    setAutoOrderSync((prev) => {
      const next = !prev;
      if (typeof window !== 'undefined') {
        window.localStorage.setItem('avystock:autoOrderSync', next ? 'true' : 'false');
      }
      return next;
    });
  };

  const handleResetPickScans = useCallback(() => {
    resetPickForm();
  }, [resetPickForm]);

  useEffect(() => {
    let cancelled = false;
    const loadOrders = async () => {
      setOrdersLoading(true);
      try {
        const data = await fetchOrdersApi();
        if (!cancelled) {
          setOrders(data);
          setOrdersError(null);
        }
      } catch (error: any) {
        if (!cancelled) {
          setOrdersError(error?.message || t('ops.errors.ordersLoad'));
        }
      } finally {
        if (!cancelled) {
          setOrdersLoading(false);
        }
      }
    };
    loadOrders();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    if (!autoOrderSync) {
      if (autoSyncIntervalRef.current) {
        window.clearInterval(autoSyncIntervalRef.current);
        autoSyncIntervalRef.current = null;
      }
      return undefined;
    }
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        handleSyncOrders(false);
      }
    }, 60000);
    autoSyncIntervalRef.current = id;
    return () => {
      window.clearInterval(id);
      autoSyncIntervalRef.current = null;
    };
  }, [autoOrderSync]);

  useEffect(() => {
    if (workflow === 'stow') {
      stowSkuRef.current?.focus();
    }
  }, [workflow]);

  useEffect(() => {
    resetPickForm();
  }, [resetPickForm]);

  const pickConfirmReady = useMemo(
    () => pickScanStatus.bin === 'ok' && pickScanStatus.sku === 'ok' && Number(pickQuantity) > 0,
    [pickScanStatus, pickQuantity]
  );

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const mq = window.matchMedia('(max-width: 768px)');
    const handler = (event: MediaQueryListEvent) => {
      setIsMobile(event.matches);
      setShowOrdersPanel(event.matches ? false : true);
    };
    const detach = addMediaQueryListener(mq, handler);
    setIsMobile(mq.matches);
    setShowOrdersPanel(mq.matches ? false : true);
    return () => detach();
  }, []);

  const handleStow = async (resetAfter = false) => {
    if (!stowBin || (!matchedStowProduct && !stowSku)) {
      setErrorMessage(t('ops.errors.stowValidation'));
      return;
    }
    try {
      setIsSubmitting(true);
      setErrorMessage(null);
      const payload = {
        sku: stowSku || undefined,
        productId: matchedStowProduct?.id,
        binCode: stowBin.toUpperCase(),
        quantity: typeof stowQuantity === 'number' ? stowQuantity : Number(stowQuantity) || 0,
        meta: {
          flow: 'stow',
        },
      };
      const result = await stockInProduct(payload);
      if (!result.ok || !result.data) {
        throw new Error(result.error?.message || t('ops.errors.stow'));
      }
      onProductUpdate(result.data.product);
      onStockChanged?.(result.data.bin);
      setStatusMessage(
        t('ops.status.stowSuccess', {
          name: result.data.product.identification?.name || stowSku,
        })
      );
      setStowQuantity(1);
      if (resetAfter) {
        setStowSku('');
        setStowBin('');
        setScannerTarget('stowSku');
      }
    } catch (error: any) {
      setErrorMessage(error?.message || t('ops.errors.stow'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const markPickTaskCompleted = (itemId?: string | null) => {
    if (!itemId) return;
    setSkippedPickItemIds((prev) => {
      if (prev.includes(itemId)) {
        return prev;
      }
      return [...prev, itemId];
    });
  };

  const handlePick = async () => {
    if (workflow !== 'pick') {
      return;
    }
    const activeTask = nextPickTask;
    if (!activeTask) {
      setErrorMessage(t('ops.labels.noPickTasks'));
      return;
    }

    if (pickScanStatus.bin === 'mismatch' || pickScanStatus.sku === 'mismatch') {
      setErrorMessage(t('ops.errors.pickScanMismatch'));
      return;
    }

    if (pickScanStatus.bin !== 'ok' || pickScanStatus.sku !== 'ok') {
      setErrorMessage(t('ops.errors.pickScansMissing'));
      return;
    }

    if (!pickBin || !pickSku) {
      setErrorMessage(t('ops.errors.pickValidation'));
      return;
    }
    const numericQuantity =
      typeof pickQuantity === 'number' ? pickQuantity : Number(pickQuantity) || 0;
    if (!numericQuantity || numericQuantity <= 0) {
      setErrorMessage(t('ops.errors.pickValidation'));
      return;
    }
    try {
      setIsSubmitting(true);
      setErrorMessage(null);
      if (typeof activeTask.available === 'number' && Number.isFinite(activeTask.available) && numericQuantity > activeTask.available) {
        throw new Error(t('ops.errors.pickValidation'));
      }
      if (numericQuantity > activeTask.remainingTotal) {
        throw new Error(t('ops.errors.pickValidation'));
      }
      const payload = {
        sku: pickSku || undefined,
        productId: matchedPickProduct?.id || activeTask.productId || undefined,
        binCode: pickBin.toUpperCase(),
        quantity: numericQuantity,
        orderId: activeTask.orderId,
        orderItemId: activeTask.itemId,
        meta: {
          flow: 'pick',
          orderId: activeTask.orderId,
          orderItemId: activeTask.itemId,
        },
      };
      const activeTaskId = activeTask.itemId;
      const result = await stockOutProduct(payload);
      if (!result.ok || !result.data) {
        throw new Error(result.error?.message || t('ops.errors.pick'));
      }
      onProductUpdate(result.data.product);
      onStockChanged?.(result.data.bin);
      setStatusMessage(
        t('ops.status.pickSuccess', {
          name: result.data.product.identification?.name || pickSku,
        })
      );
      loadBinDetail(pickBin.toUpperCase());
      if (activeTaskId) {
        const pickedNow = (Number(pickedByItemId[activeTaskId] || 0) || 0) + numericQuantity;
        const clampedPicked = Math.min(activeTask.itemTotal, pickedNow);
        setPickedByItemId((prev) => ({
          ...prev,
          [activeTaskId]: Math.min(activeTask.itemTotal, (Number(prev[activeTaskId] || 0) || 0) + numericQuantity),
        }));

        setOrders((prev) =>
          prev.map((order) => {
            if (order.id !== activeTask.orderId) return order;
            return {
                ...order,
              items: order.items.map((it) => {
                const qtyPicked =
                  it.id === activeTaskId ? clampedPicked : Number(pickedByItemId[it.id] || 0) || 0;
                const done = (it.pickCompleted === true) || (qtyPicked >= Number(it.quantity || 0));
                return done ? { ...it, pickCompleted: true } : it;
              }),
            };
          })
        );

        const targetOrder = openOrders.find((o) => o.id === activeTask.orderId) || null;
        const isOrderDone = targetOrder
          ? targetOrder.items.every((it) => {
            const qtyPicked =
              it.id === activeTaskId ? clampedPicked : Number(pickedByItemId[it.id] || 0) || 0;
            return (it.pickCompleted === true) || (qtyPicked >= Number(it.quantity || 0));
          })
          : false;

        try {
          if (isOrderDone) {
          await completeOrderApi(activeTask.orderId);
          setOrders((prev) =>
            prev.map((order) =>
              order.id === activeTask.orderId
                ? {
                  ...order,
                  status: 'picked',
                  statusLabel: t('ops.orders.complete'),
                  pickedAt: new Date().toISOString(),
                }
                : order
            )
          );
          }
        } catch (error) {
          console.warn('Order completion failed:', error);
          setOrderErrorMessage(
            error instanceof Error ? error.message : t('ops.errors.pick')
          );
        }
      }
      resetPickForm();
    } catch (error: any) {
      setErrorMessage(error?.message || t('ops.errors.pick'));
    } finally {
      setIsSubmitting(false);
    }
  };

  /* ──────────────────────────────────────────
     Compute pick progress for the current order
     ────────────────────────────────────────── */
  const currentPickOrder = useMemo(() => {
    if (!nextPickTask) return null;
    return openOrders.find((o) => o.id === nextPickTask.orderId) || null;
  }, [nextPickTask, openOrders]);

  const pickProgress = useMemo(() => {
    if (!currentPickOrder) return { total: 0, done: 0, pct: 0 };
    const total = currentPickOrder.items.length;
    const done = currentPickOrder.items.filter((it) => {
      const qtyPicked = Number(pickedByItemId[it.id] || 0) || 0;
      return (it.pickCompleted === true) || (qtyPicked >= Number(it.quantity || 0));
    }).length;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    return { total, done, pct };
  }, [currentPickOrder, pickedByItemId]);

  /* ──────────────────────────────────────────
     RENDER
     ────────────────────────────────────────── */
  return (
    <section className="space-y-0">
      {/* ═══════ PAGE HEADER ═══════ */}
      <div className="flex items-start justify-between flex-wrap gap-4 mb-5">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-[var(--text-primary)]">{t('ops.title')}</h1>
          <p className="text-sm text-[var(--text-tertiary)] mt-0.5">{t('ops.mode.stow.subtitle')} &amp; {t('ops.mode.pick.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => handleSyncOrders(true)}
            disabled={isSyncingOrders}
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[13px] font-semibold text-[var(--text-secondary)] hover:border-[var(--border-hover)] hover:shadow-[var(--shadow-sm)] transition-all disabled:opacity-50"
          >
            <SyncIcon className={`w-3.5 h-3.5 ${isSyncingOrders ? 'animate-spin' : ''}`} />
            {isSyncingOrders ? t('ops.orders.syncing') : t('ops.orders.sync')}
          </button>
        </div>
      </div>

      {/* ═══════ MODE TABS ═══════ */}
      <div className="flex gap-1 bg-[var(--surface-secondary)] rounded-lg p-1 mb-6">
        <button
          type="button"
          onClick={() => setWorkflow('stow')}
          className={`flex-1 flex items-center justify-center gap-2 py-3 px-6 rounded-md text-[15px] font-semibold transition-all ${
            workflow === 'stow'
              ? 'bg-[var(--surface)] text-[var(--text-primary)] shadow-[var(--shadow-sm)]'
              : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]'
          }`}
        >
          <StowArrowSvg />
          {t('ops.mode.stow')}
          <span className={`text-[11px] font-bold px-2 py-0.5 rounded-[10px] ${
            workflow === 'stow'
              ? 'bg-[var(--avy-purple)] text-white'
              : 'bg-[rgba(99,91,255,0.12)] text-[var(--avy-purple)]'
          }`}>
            {orderSummary.open}
          </span>
        </button>
        <button
          type="button"
          onClick={() => setWorkflow('pick')}
          className={`flex-1 flex items-center justify-center gap-2 py-3 px-6 rounded-md text-[15px] font-semibold transition-all ${
            workflow === 'pick'
              ? 'bg-[var(--surface)] text-[var(--text-primary)] shadow-[var(--shadow-sm)]'
              : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]'
          }`}
        >
          <PickArrowSvg />
          {t('ops.mode.pick')}
          <span className={`text-[11px] font-bold px-2 py-0.5 rounded-[10px] ${
            workflow === 'pick'
              ? 'bg-[var(--avy-purple)] text-white'
              : 'bg-[rgba(99,91,255,0.12)] text-[var(--avy-purple)]'
          }`}>
            {pickRouteTasks.length}
          </span>
        </button>
      </div>

      {/* Status / error toasts */}
      {orderStatusMessage && (
        <div className="mb-4 flex items-center gap-2 text-sm text-[var(--success)] bg-[var(--success-bg)] border border-[var(--success-border)] px-4 py-2.5 rounded-lg">
          <CheckSvg size={14} />
          {orderStatusMessage}
        </div>
      )}
      {(ordersError || orderErrorMessage) && (
        <div className="mb-4 text-sm text-[var(--error)] bg-[var(--error-bg)] border border-[var(--error-border)] px-4 py-2.5 rounded-lg">
          {ordersError || orderErrorMessage}
        </div>
      )}
      {statusMessage && (
        <div className="mb-4 flex items-center gap-2 text-sm text-[var(--success)] bg-[var(--success-bg)] border border-[var(--success-border)] px-4 py-2.5 rounded-lg">
          <CheckSvg size={14} />
          {statusMessage}
        </div>
      )}
      {errorMessage && (
        <div className="mb-4 text-sm text-[var(--error)] bg-[var(--error-bg)] border border-[var(--error-border)] px-4 py-2.5 rounded-lg">
          {errorMessage}
        </div>
      )}

      {/* ═════════════════════════════════════════
          STOW TAB
          ═════════════════════════════════════════ */}
      {workflow === 'stow' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Left: Scanner + Scanned Item */}
          <div>
            {/* Scanner Input */}
            <div
              className="relative mb-5"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleStow(false);
                }
              }}
            >
              <input
                ref={stowSkuRef}
                value={stowSku}
                onChange={(e) => setStowSku(e.target.value)}
                className="w-full py-4 pl-12 pr-36 text-[17px] font-medium border-2 border-[var(--border)] rounded-lg bg-[var(--surface)] text-[var(--text-primary)] outline-none transition-all focus:border-[var(--avy-purple)] focus:shadow-[0_0_0_3px_rgba(99,91,255,0.12)] placeholder:text-[var(--text-tertiary)] placeholder:font-normal"
                placeholder={t('ops.stow.product')}
                autoComplete="off"
              />
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)] transition-colors peer-focus:text-[var(--avy-purple)]">
                <ScannerSvg />
              </span>
              <div className="absolute right-4 top-1/2 -translate-y-1/2 flex items-center gap-1.5 text-[12px] font-medium text-[var(--text-tertiary)]">
                <span className="w-2 h-2 rounded-full bg-[var(--success)] animate-pulse" />
                Scanner bereit
              </div>
            </div>

            {/* Scanned Item Card */}
            {matchedStowProduct ? (
              <div className="bg-[var(--surface)] border-2 border-[var(--avy-purple)] rounded-lg p-5 mb-5 shadow-[0_0_0_3px_rgba(99,91,255,0.12)] animate-[slideDown_300ms_ease]">
                <div className="flex gap-5">
                  {/* Thumbnail */}
                  <div className="w-20 h-20 rounded-md bg-[var(--surface-secondary)] border border-[var(--border)] flex items-center justify-center flex-shrink-0 overflow-hidden">
                    {matchedStowProduct.details?.images?.[0]?.url_or_base64 ? (
                      <img
                        src={resolveImageSrc(matchedStowProduct.details.images[0].url_or_base64)}
                        alt={matchedStowProduct.identification?.name || ''}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <span className="text-[var(--text-tertiary)]"><ImagePlaceholderSvg /></span>
                    )}
                  </div>
                  {/* Details */}
                  <div className="flex-1 min-w-0">
                    <p className="text-[15px] font-semibold text-[var(--text-primary)] mb-1">{matchedStowProduct.identification?.name}</p>
                    <div className="flex flex-wrap gap-2 mb-3">
                      {matchedStowProduct.identification?.sku && (
                        <span className="text-[11px] font-semibold px-2 py-0.5 rounded bg-[var(--surface-secondary)] text-[var(--text-secondary)] font-mono">
                          {matchedStowProduct.identification.sku}
                        </span>
                      )}
                      {matchedStowProduct.details?.identifiers?.ean && (
                        <span className="text-[11px] font-semibold px-2 py-0.5 rounded bg-[var(--surface-secondary)] text-[var(--text-secondary)] font-mono">
                          EAN {matchedStowProduct.details.identifiers.ean}
                        </span>
                      )}
                    </div>
                    {/* Suggested Bin */}
                    {matchedStowProduct.storage?.binCode && (
                      <div className="mb-3">
                        <span className="text-[12px] text-[var(--text-tertiary)] mr-2">Vorgeschlagener Platz:</span>
                        <span className="inline-flex items-center gap-1.5 text-[13px] font-bold px-3 py-1 rounded-md bg-[rgba(99,91,255,0.12)] text-[var(--avy-purple)] font-mono">
                          <BinSvg />
                          {matchedStowProduct.storage.binCode}
                        </span>
                      </div>
                    )}
                    {/* Bin + Qty + Confirm */}
                    <div className="flex items-center gap-3 flex-wrap">
                      <div className="flex items-center gap-2">
                        <input
                          ref={stowBinRef}
                          value={stowBin}
                          onChange={(e) => setStowBin(e.target.value.toUpperCase())}
                          className="w-28 px-3 py-2 text-[13px] font-semibold border border-[var(--border)] rounded-md bg-[var(--surface)] text-[var(--text-primary)] uppercase font-mono outline-none transition-all focus:border-[var(--avy-purple)] focus:shadow-[0_0_0_3px_rgba(99,91,255,0.12)]"
                          placeholder="BIN..."
                        />
                        <button
                          type="button"
                          onClick={() => setScannerTarget('stowBin')}
                          className="p-2 rounded-md border border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)] hover:border-[var(--border-hover)] transition-all"
                        >
                          <CameraIcon className="w-4 h-4" />
                        </button>
                      </div>
                      <label className="text-[12px] font-medium text-[var(--text-secondary)]">{t('ops.stow.quantity')}:</label>
                      <input
                        type="number"
                        min={1}
                        value={stowQuantity}
                        onChange={(e) => {
                          const val = e.target.value;
                          if (val === '') setStowQuantity('');
                          else setStowQuantity(Math.max(1, Number(val)));
                        }}
                        className="w-[72px] px-3 py-2 text-[15px] font-semibold border border-[var(--border)] rounded-md bg-[var(--surface)] text-[var(--text-primary)] text-center outline-none transition-all focus:border-[var(--avy-purple)] focus:shadow-[0_0_0_3px_rgba(99,91,255,0.12)]"
                      />
                      <button
                        type="button"
                        onClick={() => handleStow(false)}
                        disabled={isSubmitting || !stowSku || !stowBin || !stowQuantity}
                        className="flex-1 min-w-[180px] inline-flex items-center justify-center gap-2 py-3 px-6 rounded-lg bg-[var(--avy-purple)] text-white text-[15px] font-semibold transition-all hover:bg-[var(--avy-purple-hover)] hover:-translate-y-px hover:shadow-[0_4px_12px_rgba(99,91,255,0.3)] active:translate-y-0 disabled:opacity-50 disabled:hover:translate-y-0"
                      >
                        <CheckSvg size={16} />
                        {t('ops.stow.submit')}
                      </button>
                    </div>
                    {/* Stow & Next */}
                    <button
                      type="button"
                      onClick={() => handleStow(true)}
                      disabled={isSubmitting || !stowSku || !stowBin || !stowQuantity}
                      className="mt-2 w-full py-2.5 rounded-md bg-[var(--surface)] text-[var(--text-secondary)] text-[13px] font-semibold border border-[var(--border)] hover:border-[var(--border-hover)] hover:shadow-[var(--shadow-sm)] transition-all disabled:opacity-50"
                    >
                      {t('ops.stow.submit.next')}
                    </button>
                  </div>
                </div>
              </div>
            ) : stowSku ? (
              <div className="bg-[var(--surface)] border-2 border-[var(--border)] rounded-lg p-5 mb-5">
                <div className="flex gap-5">
                  <div className="w-20 h-20 rounded-md bg-[var(--surface-secondary)] border border-[var(--border)] flex items-center justify-center flex-shrink-0">
                    <span className="text-[var(--text-tertiary)]"><ImagePlaceholderSvg /></span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[14px] text-[var(--error)] font-medium mb-2">{t('ops.labels.noProductFound')}</p>
                    <p className="text-[12px] text-[var(--text-tertiary)]">SKU/Barcode: {stowSku}</p>
                    {/* Still allow manual bin entry */}
                    <div className="flex items-center gap-3 mt-3 flex-wrap">
                      <input
                        ref={stowBinRef}
                        value={stowBin}
                        onChange={(e) => setStowBin(e.target.value.toUpperCase())}
                        className="w-28 px-3 py-2 text-[13px] font-semibold border border-[var(--border)] rounded-md bg-[var(--surface)] text-[var(--text-primary)] uppercase font-mono outline-none transition-all focus:border-[var(--avy-purple)] focus:shadow-[0_0_0_3px_rgba(99,91,255,0.12)]"
                        placeholder="BIN..."
                      />
                      <button
                        type="button"
                        onClick={() => setScannerTarget('stowBin')}
                        className="p-2 rounded-md border border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)] hover:border-[var(--border-hover)] transition-all"
                      >
                        <CameraIcon className="w-4 h-4" />
                      </button>
                      <input
                        type="number"
                        min={1}
                        value={stowQuantity}
                        onChange={(e) => {
                          const val = e.target.value;
                          if (val === '') setStowQuantity('');
                          else setStowQuantity(Math.max(1, Number(val)));
                        }}
                        className="w-[72px] px-3 py-2 text-[15px] font-semibold border border-[var(--border)] rounded-md bg-[var(--surface)] text-[var(--text-primary)] text-center outline-none transition-all focus:border-[var(--avy-purple)] focus:shadow-[0_0_0_3px_rgba(99,91,255,0.12)]"
                      />
                      <button
                        type="button"
                        onClick={() => handleStow(false)}
                        disabled={isSubmitting || !stowSku || !stowBin || !stowQuantity}
                        className="flex-1 min-w-[140px] inline-flex items-center justify-center gap-2 py-2.5 px-4 rounded-md bg-[var(--avy-purple)] text-white text-[13px] font-semibold transition-all hover:bg-[var(--avy-purple-hover)] disabled:opacity-50"
                      >
                        {t('ops.stow.submit')}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              /* Empty State */
              <div className="flex flex-col items-center justify-center py-12 text-[var(--text-tertiary)]">
                <svg width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.2" className="mb-4 opacity-40">
                  <path d="M8 14V8h8M32 8h8v6M8 34v6h8M32 40h8v-6M18 18v12M24 18v12M30 18v12" />
                </svg>
                <p className="text-[15px] font-medium">Barcode scannen um zu starten</p>
                <p className="text-[13px] mt-1">Scanne einen Artikel-Barcode oder gib eine SKU ein</p>
              </div>
            )}
          </div>

          {/* Right: Stow Queue (Orders) */}
          <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl transition-[border-color] hover:border-[var(--border-hover)]">
            <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border)]">
              <span className="text-[14px] font-semibold text-[var(--text-primary)]">{t('ops.orders.section')}</span>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-1.5 text-[12px] text-[var(--text-secondary)] cursor-pointer">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 rounded border-[var(--border)] bg-[var(--bg)] text-[var(--avy-purple)] focus:ring-[var(--avy-purple)]"
                    checked={autoOrderSync}
                    onChange={handleAutoSyncToggle}
                  />
                  Auto
                </label>
                <span className="text-[12px] text-[var(--text-tertiary)] font-medium">{orderSummary.open} {t('ops.orders.open')}</span>
              </div>
            </div>
            <div className="p-2">
              {ordersLoading ? (
                <div className="py-8 text-center text-[var(--text-tertiary)] text-sm">{t('ops.orders.loading')}</div>
              ) : openOrders.length === 0 ? (
                <div className="py-8 text-center text-[var(--text-tertiary)] text-sm">{t('ops.orders.none')}</div>
              ) : (
                <div className="flex flex-col gap-0.5">
                  {visibleOrders.map((order, idx) => (
                    <div
                      key={order.id}
                      className="flex items-center gap-3 px-4 py-3 rounded-md border border-transparent transition-all cursor-pointer hover:bg-[var(--surface-hover)] hover:border-[var(--border)]"
                    >
                      <div className="w-10 h-10 rounded-md bg-[var(--surface-secondary)] border border-[var(--border)] flex items-center justify-center flex-shrink-0">
                        <ThumbSvg />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-[13px] font-medium text-[var(--text-primary)] truncate">
                          {order.customer?.name || t('ops.labels.unknownCustomer')}
                        </p>
                        <div className="text-[11px] text-[var(--text-tertiary)] flex gap-2 items-center">
                          <span className="text-[11px] font-bold text-[var(--avy-purple)] font-mono bg-[rgba(99,91,255,0.12)] px-1.5 py-px rounded">
                            {order.number || order.id.slice(0, 8)}
                          </span>
                          <span>{order.items.length} Pos.</span>
                        </div>
                      </div>
                      <div className="text-[12px] font-semibold text-[var(--text-secondary)] whitespace-nowrap">
                        {typeof order.totalAmount === 'number' ? `${order.currency || 'EUR'} ${order.totalAmount.toFixed(2)}` : ''}
                      </div>
                      {idx === 0 ? (
                        <span className="flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-[10px] text-[var(--warning)] bg-[var(--warning-bg)] whitespace-nowrap">
                          <span className="w-1.5 h-1.5 rounded-full bg-[var(--warning)] animate-pulse" />
                          In Bearbeitung
                        </span>
                      ) : (
                        <span className="text-[10px] font-semibold px-2 py-0.5 rounded-[10px] text-[var(--text-tertiary)] bg-[var(--surface-secondary)] whitespace-nowrap">
                          Wartend
                        </span>
                      )}
                    </div>
                  ))}
                  {openOrders.length > 5 && (
                    <div className="flex justify-center py-2">
                      <button
                        type="button"
                        onClick={() => setShowAllOpenOrders((prev) => !prev)}
                        className="text-[12px] text-[var(--avy-purple)] hover:text-[var(--avy-purple-hover)] font-medium transition-colors"
                      >
                        {showAllOpenOrders ? t('ops.orders.less') : `${t('ops.orders.more')} (${openOrders.length})`}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ═════════════════════════════════════════
          PICK TAB
          ═════════════════════════════════════════ */}
      {workflow === 'pick' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Left: Active Pick List */}
          <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl transition-[border-color] hover:border-[var(--border-hover)]">
            <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border)]">
              <span className="text-[14px] font-semibold text-[var(--text-primary)]">{t('ops.mode.pick')}</span>
              <span className="text-[12px] font-medium text-[var(--text-tertiary)]">
                {currentPickOrder ? `${t('ops.labels.activeWorkflow')}` : t('ops.labels.noPickTasks')}
              </span>
            </div>
            <div className="p-5">
              {nextPickTask ? (
                <div
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handlePick();
                    }
                  }}
                >
                  {/* Order Header */}
                  <div className="flex items-center justify-between flex-wrap gap-2 mb-4">
                    <div>
                      <p className="text-[16px] font-bold text-[var(--avy-purple)] font-mono">
                        #{nextPickTask.orderNumber || nextPickTask.orderId.slice(0, 8)}
                      </p>
                      <p className="text-[13px] text-[var(--text-secondary)]">
                        {nextPickTask.customer || t('ops.labels.unknownCustomer')}
                      </p>
                    </div>
                    <span className="flex items-center gap-1 text-[12px] font-semibold px-3 py-1 rounded-[10px] text-[var(--warning)] bg-[var(--warning-bg)]">
                      <span className="w-1.5 h-1.5 rounded-full bg-[var(--warning)] animate-pulse" />
                      In Bearbeitung
                    </span>
                  </div>

                  {/* Progress Bar */}
                  <div className="mb-5">
                    <div className="h-2 bg-[var(--surface-secondary)] rounded overflow-hidden mb-1.5">
                      <div
                        className="h-full rounded bg-gradient-to-r from-[var(--avy-purple)] to-[var(--info)] transition-[width] duration-500 ease-out relative overflow-hidden"
                        style={{ width: `${pickProgress.pct}%` }}
                      >
                        <span className="absolute inset-0 bg-gradient-to-r from-transparent via-white/30 to-transparent animate-[shimmer_1.5s_ease-in-out_infinite]" />
                      </div>
                    </div>
                    <div className="flex justify-between text-[12px] font-semibold text-[var(--text-secondary)]">
                      <span>{pickProgress.done} / {pickProgress.total} Artikel gepickt</span>
                      <span>{pickProgress.pct}%</span>
                    </div>
                  </div>

                  {/* Pick Items List */}
                  {currentPickOrder && (
                    <div className="flex flex-col gap-0.5 mb-5">
                      {currentPickOrder.items.map((item) => {
                        const qtyPicked = Number(pickedByItemId[item.id] || 0) || 0;
                        const isDone = (item.pickCompleted === true) || (qtyPicked >= Number(item.quantity || 0));
                        const product = resolveProductForItem(item);
                        const hint = item.pickHint || null;
                        const binCode = hint?.binCode || product?.storage?.binCode || '';

                        return (
                          <div
                            key={item.id}
                            className={`flex items-center gap-3 px-4 py-3 rounded-md border border-transparent transition-all cursor-pointer hover:bg-[var(--surface-hover)] hover:border-[var(--border)] ${isDone ? 'opacity-50' : ''}`}
                          >
                            <div className={`w-[22px] h-[22px] rounded-md border-2 flex items-center justify-center flex-shrink-0 transition-all ${
                              isDone
                                ? 'bg-[var(--success)] border-[var(--success)] text-white'
                                : 'border-[var(--border)] bg-[var(--surface)]'
                            }`}>
                              {isDone && <CheckSvg />}
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className={`text-[13px] font-medium transition-all ${isDone ? 'line-through text-[var(--text-tertiary)]' : 'text-[var(--text-primary)]'}`}>
                                {hint?.productName || product?.identification?.name || item.name}
                              </p>
                              <div className="text-[11px] text-[var(--text-tertiary)] flex gap-2 items-center">
                                {(item.sku || hint?.sku) && <span>{item.sku || hint?.sku}</span>}
                                {binCode && (
                                  <span className="text-[12px] font-bold text-[var(--avy-purple)] font-mono bg-[rgba(99,91,255,0.12)] px-1.5 py-px rounded">
                                    {binCode}
                                  </span>
                                )}
                              </div>
                            </div>
                            <span className="text-[13px] font-semibold text-[var(--text-secondary)] whitespace-nowrap">
                              x{item.quantity}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Pick Route Visual */}
                  {pickRouteTasks.length > 0 && (
                    <div className="bg-[var(--surface-secondary)] rounded-md p-4 mb-4">
                      <p className="text-[12px] font-semibold text-[var(--text-tertiary)] uppercase tracking-wider mb-3">Optimale Pick-Route</p>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {pickRouteTasks.slice(0, 6).map((task, idx) => {
                          const isCurrent = idx === 0;
                          const isPast = false; // first item is always current in this context
                          return (
                            <React.Fragment key={task.itemId}>
                              {idx > 0 && (
                                <ArrowRightSvg color={isCurrent ? 'var(--avy-purple)' : 'var(--text-tertiary)'} />
                              )}
                              <span
                                className={`text-[12px] font-bold font-mono px-2 py-0.5 rounded ${
                                  isCurrent
                                    ? 'text-[13px] px-2.5 py-1 border-2 border-[var(--avy-purple)] text-[var(--avy-purple)] bg-[rgba(99,91,255,0.12)]'
                                    : 'text-[var(--avy-purple)] bg-[rgba(99,91,255,0.12)]'
                                }`}
                              >
                                {task.binCode || '?'}
                              </span>
                            </React.Fragment>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Scan Steps */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                    {/* Bin Scan */}
                    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] p-4">
                      <div className="flex items-center justify-between gap-3 mb-3">
                        <div>
                          <p className="text-[10px] uppercase tracking-wider text-[var(--text-tertiary)]">{t('ops.pick.steps.bin')}</p>
                          <p className={`text-xl font-semibold ${nextPickTask.binCode ? 'text-[var(--text-primary)]' : 'text-[var(--error)]'}`}>
                            {nextPickTask.binCode || 'Kein Platz'}
                          </p>
                        </div>
                        {renderScanStatusBadge(pickScanStatus.bin)}
                      </div>
                      <div className="space-y-1 text-[11px] text-[var(--text-tertiary)] mb-3">
                        <p>{t('ops.pick.steps.expected')}: <span className="text-[var(--text-secondary)]">{nextPickTask.binCode || 'Beliebig'}</span></p>
                        <p>{t('ops.pick.steps.scanned')}: <span className="text-[var(--text-secondary)]">{pickBin || t('ops.pick.steps.pending')}</span></p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => setScannerTarget('pickBin')}
                          className="rounded-md border border-[var(--border)] px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-secondary)] hover:border-[var(--border-hover)] transition-all"
                        >
                          {t('ops.pick.steps.cta')}
                        </button>
                        <button
                          type="button"
                          onClick={() => loadBinDetail(pickBin || nextPickTask.binCode || '')}
                          className="rounded-md border border-[var(--border)] px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-secondary)] hover:border-[var(--border-hover)] transition-all"
                        >
                          {t('ops.actions.reloadBin')}
                        </button>
                      </div>
                    </div>
                    {/* SKU Scan */}
                    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] p-4">
                      <div className="flex items-center justify-between gap-3 mb-3">
                        <div>
                          <p className="text-[10px] uppercase tracking-wider text-[var(--text-tertiary)]">{t('ops.pick.steps.sku')}</p>
                          <p className="text-base font-semibold text-[var(--text-primary)] break-all">{nextPickTask.sku || '--'}</p>
                        </div>
                        {renderScanStatusBadge(pickScanStatus.sku)}
                      </div>
                      <div className="space-y-1 text-[11px] text-[var(--text-tertiary)] mb-3">
                        <p>{t('ops.pick.steps.expected')}: <span className="text-[var(--text-secondary)]">{nextPickTask.sku || '--'}</span></p>
                        <p>{t('ops.pick.steps.scanned')}: <span className="text-[var(--text-secondary)]">{pickSku || t('ops.pick.steps.pending')}</span></p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setScannerTarget('pickSku')}
                        className="rounded-md border border-[var(--border)] px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-secondary)] hover:border-[var(--border-hover)] transition-all"
                      >
                        {t('ops.pick.steps.cta')}
                      </button>
                    </div>
                  </div>

                  {/* Pick Quantity */}
                  <div className="flex items-end gap-4 mb-4">
                    <div className="flex-1">
                      <label className="text-[11px] text-[var(--text-tertiary)] uppercase tracking-wider font-semibold">{t('ops.pick.quantity')}</label>
                      <input
                        type="number"
                        min={1}
                        value={pickQuantity}
                        onChange={(e) => {
                          const val = e.target.value;
                          if (val === '') setPickQuantity('');
                          else setPickQuantity(Math.max(1, Number(val)));
                        }}
                        className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none transition-all focus:border-[var(--avy-purple)] focus:shadow-[0_0_0_3px_rgba(99,91,255,0.12)]"
                      />
                      <p className="mt-1 text-[11px] text-[var(--text-tertiary)]">
                        {t('ops.pick.quantityHint', { value: nextPickTask.quantity || 1 })}
                      </p>
                    </div>
                    <div className="flex gap-2 pb-6">
                      <button
                        type="button"
                        onClick={handleResetPickScans}
                        className="rounded-md border border-[var(--border)] px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-secondary)] hover:border-[var(--border-hover)] transition-all"
                      >
                        {t('ops.pick.reset')}
                      </button>
                      <button
                        type="button"
                        onClick={() => markPickTaskCompleted(nextPickTask.itemId)}
                        className="rounded-md border border-[var(--border)] px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-secondary)] hover:border-[var(--border-hover)] transition-all"
                      >
                        {t('ops.actions.skipOrder')}
                      </button>
                      {skippedPickItemIds.length > 0 && (
                        <button
                          type="button"
                          onClick={() => setSkippedPickItemIds([])}
                          className="rounded-md border border-[var(--border)] px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-secondary)] hover:border-[var(--border-hover)] transition-all"
                        >
                          {t('ops.actions.resetRoute')}
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Bin Detail */}
                  {pickBinDetail && (
                    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] p-4 mb-4">
                      <h4 className="text-[var(--text-primary)] font-semibold mb-2 font-mono">BIN {pickBinDetail.code}</h4>
                      {pickBinDetail.products?.length ? (
                        <ul className="space-y-2 max-h-52 overflow-y-auto text-sm">
                          {pickBinDetail.products.map((item) => (
                            <li
                              key={item.productId}
                              className={`flex items-center justify-between px-3 py-2 rounded-md ${
                                pickSku && item.sku?.toLowerCase() === pickSku.toLowerCase()
                                  ? 'bg-[rgba(99,91,255,0.12)]'
                                  : 'bg-[var(--surface)]'
                              }`}
                            >
                              <div>
                                <p className="text-[var(--text-primary)] text-[13px] font-medium">{item.name}</p>
                                <p className="text-[11px] text-[var(--text-tertiary)]">
                                  SKU {item.sku} &middot; Menge {item.quantity}
                                </p>
                              </div>
                              {item.image && (
                                <img
                                  src={resolveImageSrc(item.image)}
                                  alt={item.name}
                                  className="w-10 h-10 object-cover rounded-md border border-[var(--border)]"
                                />
                              )}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-[var(--text-tertiary)] text-sm">{t('ops.labels.binEmpty')}</p>
                      )}
                    </div>
                  )}

                  {/* Submit Button */}
                  <button
                    type="button"
                    onClick={handlePick}
                    disabled={!pickConfirmReady || isSubmitting}
                    className="w-full inline-flex items-center justify-center gap-2 py-3 px-6 rounded-lg bg-[var(--success)] text-white text-[15px] font-semibold transition-all hover:opacity-90 hover:-translate-y-px hover:shadow-[0_4px_12px_rgba(14,159,110,0.3)] active:translate-y-0 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-y-0"
                  >
                    <CheckSvg size={16} />
                    {isSubmitting ? t('ops.pick.submitting') : t('ops.pick.submit')}
                  </button>
                </div>
              ) : (
                <div className="py-12 text-center text-[var(--text-tertiary)]">
                  <svg width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.2" className="mx-auto mb-4 opacity-40">
                    <path d="M8 14V8h8M32 8h8v6M8 34v6h8M32 40h8v-6M18 18v12M24 18v12M30 18v12" />
                  </svg>
                  <p className="text-[15px] font-medium">{t('ops.labels.noPickTasks')}</p>
                  <p className="text-[13px] mt-1">Alle Bestellungen wurden kommissioniert</p>
                </div>
              )}
            </div>
          </div>

          {/* Right: Next Orders + Scanner */}
          <div className="space-y-5">
            {/* Next Orders Queue */}
            <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl transition-[border-color] hover:border-[var(--border-hover)]">
              <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border)]">
                <span className="text-[14px] font-semibold text-[var(--text-primary)]">{t('ops.orders.section')}</span>
                <span className="text-[12px] text-[var(--text-tertiary)] font-medium">{openOrders.length} {t('ops.orders.open')}</span>
              </div>
              <div className="p-3">
                {ordersLoading ? (
                  <div className="py-6 text-center text-[var(--text-tertiary)] text-sm">{t('ops.orders.loading')}</div>
                ) : openOrders.length === 0 ? (
                  <div className="py-6 text-center text-[var(--text-tertiary)] text-sm">{t('ops.orders.none')}</div>
                ) : (
                  <div className="space-y-2">
                    {visibleOrders.map((order) => (
                      <div
                        key={order.id}
                        className="flex items-center gap-3 px-4 py-3 rounded-md border border-[var(--border)] transition-all cursor-pointer hover:border-[var(--border-hover)] hover:shadow-[var(--shadow-sm)]"
                      >
                        <div className="flex-1">
                          <p className="text-[12px] font-bold text-[var(--avy-purple)] font-mono">
                            #{order.number || order.id.slice(0, 8)}
                          </p>
                          <p className="text-[12px] text-[var(--text-secondary)]">{order.customer?.name || t('ops.labels.unknownCustomer')}</p>
                          <p className="text-[11px] text-[var(--text-tertiary)]">{order.items.length} Artikel</p>
                        </div>
                        <span className="text-[var(--text-tertiary)] opacity-0 group-hover:opacity-100 transition-opacity">
                          <ChevronRightSvg />
                        </span>
                      </div>
                    ))}
                    {openOrders.length > 5 && (
                      <div className="flex justify-center pt-1">
                        <button
                          type="button"
                          onClick={() => setShowAllOpenOrders((prev) => !prev)}
                          className="text-[12px] text-[var(--avy-purple)] hover:text-[var(--avy-purple-hover)] font-medium transition-colors"
                        >
                          {showAllOpenOrders ? t('ops.orders.less') : `${t('ops.orders.more')} (${openOrders.length})`}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Pick Scanner Card */}
            <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl transition-[border-color] hover:border-[var(--border-hover)]">
              <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border)]">
                <span className="text-[14px] font-semibold text-[var(--text-primary)]">Artikel scannen</span>
              </div>
              <div className="p-5">
                <div className="relative">
                  <input
                    value={pickSku}
                    onChange={(e) => {
                      setPickSku(e.target.value);
                      setPickScanStatus((prev) => ({
                        ...prev,
                        sku: evaluateScanStatus('sku', e.target.value),
                      }));
                    }}
                    className="w-full py-3 pl-11 pr-4 text-[15px] font-medium border-2 border-[var(--border)] rounded-lg bg-[var(--surface)] text-[var(--text-primary)] outline-none transition-all focus:border-[var(--avy-purple)] focus:shadow-[0_0_0_3px_rgba(99,91,255,0.12)] placeholder:text-[var(--text-tertiary)] placeholder:font-normal"
                    placeholder="Artikel scannen zum Abharken..."
                    autoComplete="off"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handlePick();
                      }
                    }}
                  />
                  <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]">
                    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path d="M3 5V3h3M12 3h3v2M3 13v2h3M12 15h3v-2M6 6v6M9 6v6M12 6v6" />
                    </svg>
                  </span>
                </div>
                {nextPickTask && (
                  <p className="text-[11px] text-[var(--text-tertiary)] mt-2 text-center">
                    Naechster Artikel: <strong className="text-[var(--avy-purple)]">{nextPickTask.binCode || '?'}</strong> &mdash; {nextPickTask.itemName}
                  </p>
                )}
              </div>
            </div>

            {/* Stats Row */}
            <div className="grid grid-cols-3 gap-3">
              <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-5 transition-all hover:border-[var(--border-hover)] hover:shadow-[var(--shadow-md)] hover:-translate-y-px cursor-default">
                <p className="text-[12px] font-medium text-[var(--text-tertiary)] mb-1">{t('ops.orders.open')}</p>
                <p className="text-[28px] font-bold tracking-tight text-[var(--text-primary)]">{orderSummary.open}</p>
              </div>
              <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-5 transition-all hover:border-[var(--border-hover)] hover:shadow-[var(--shadow-md)] hover:-translate-y-px cursor-default">
                <p className="text-[12px] font-medium text-[var(--text-tertiary)] mb-1">{t('ops.orders.total')}</p>
                <p className="text-[28px] font-bold tracking-tight text-[var(--text-primary)]">{orderSummary.total}</p>
              </div>
              <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-5 transition-all hover:border-[var(--border-hover)] hover:shadow-[var(--shadow-md)] hover:-translate-y-px cursor-default">
                <p className="text-[12px] font-medium text-[var(--text-tertiary)] mb-1">{t('ops.orders.today')}</p>
                <p className="text-[28px] font-bold tracking-tight text-[var(--text-primary)]">{orderSummary.pickedToday}</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ═══════ SCANNER OVERLAY & HIDDEN FILE INPUT ═══════ */}
      <ScannerOverlay
        open={scannerTarget !== null}
        title="Code scannen"
        onDetected={handleScannerResult}
        onClose={() => setScannerTarget(null)}
        onFallbackCapture={handleFallbackCapture}
        fallbackBusy={isFallbackDecoding}
        fallbackHint="iOS-Chrome unterstutzt keinen Live-Scanner. Nimm ein Foto auf, wir lesen den Code daraus."
      />
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={handleFallbackFileChange}
      />
    </section>
  );
};

export default OperationsView;

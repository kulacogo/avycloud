import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BrowserMultiFormatReader } from '@zxing/browser';
import { Product, WarehouseBin, Order } from '../types';
import {
  fetchWarehouseBinDetail,
  stockInProduct,
  stockOutProduct,
  buildImageProxyUrl,
  fetchOrders as fetchOrdersApi,
  syncOrders as syncOrdersApi,
  completeOrder as completeOrderApi,
} from '../api/client';
import { ScannerOverlay } from './ScannerOverlay';
import { WarehouseIcon, SyncIcon, CameraIcon } from './icons/Icons';
import { useI18n } from '../i18n';
import { addMediaQueryListener } from '../utils/mediaQuery';
import { compareBinCodesForPickRoute } from '../utils/warehouseRoute';

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
  quantity: number; // recommended pick quantity for THIS step (may be partial if stock is split across bins)
  itemTotal: number;
  remainingTotal: number;
  pickedSoFar: number;
  productId?: string | null;
  available?: number | null; // available in selected bin (best-effort)
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
  // Pick progress for open orders (per item id): supports partial picks across multiple BINs.
  const [pickedByItemId, setPickedByItemId] = useState<Record<string, number>>({});
  // "Skip" list for route building (does NOT mark as picked, only hides from the current route)
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

  // Keep behavior consistent with Mobile: only "new" orders are considered open/pickable.
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
        return <span className={`${base} bg-emerald-500/20 text-emerald-300`}>{t('ops.pick.steps.ok')}</span>;
      }
      if (status === 'mismatch') {
        return <span className={`${base} bg-rose-500/20 text-rose-200`}>{t('ops.pick.steps.mismatch')}</span>;
      }
      return <span className={`${base} bg-slate-700 text-slate-300`}>{t('ops.pick.steps.pending')}</span>;
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

  // Keep default pick quantity aligned with the current route task (important for partial picks across bins).
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
          // If no bin assigned, accept any scanned bin
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
    // "Skip" item in current route (does not affect stock or order status)
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

        // Update UI state for pickCompleted flags (best-effort, derived from pickedByItemId)
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

  return (
    <section className="space-y-6">
      <div className="bg-slate-800/40 rounded-2xl p-5 border border-white/10 space-y-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-sm uppercase tracking-widest text-slate-400">BaseLinker</p>
            <h2 className="text-xl font-semibold text-white">{t('ops.orders.section')}</h2>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-slate-500 bg-slate-900 text-sky-500 focus:ring-sky-500"
                checked={autoOrderSync}
                onChange={handleAutoSyncToggle}
              />
              {t('ops.orders.auto')}
            </label>
            <button
              type="button"
              onClick={() => handleSyncOrders(true)}
              disabled={isSyncingOrders}
              className="inline-flex items-center gap-2 rounded-full bg-sky-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {isSyncingOrders ? t('ops.orders.syncing') : t('ops.orders.sync')}
            </button>
            {isMobile && (
              <button
                type="button"
                onClick={() => setShowOrdersPanel((prev) => !prev)}
                className="inline-flex items-center rounded-full border border-white/10 px-3 py-2 text-sm text-slate-100 hover:border-slate-400"
              >
                {showOrdersPanel ? t('ops.orders.hide') : t('ops.orders.show')}
              </button>
            )}
          </div>
        </div>
        {orderStatusMessage && <div className="text-sm text-emerald-300 bg-emerald-900/30 px-3 py-2 rounded">{orderStatusMessage}</div>}
        {(ordersError || orderErrorMessage) && (
          <div className="text-sm text-rose-300 bg-rose-900/30 px-3 py-2 rounded">{ordersError || orderErrorMessage}</div>
        )}
        {showOrdersPanel && (
          <>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="bg-slate-900/40 rounded-xl p-4 border border-white/10">
                <p className="text-xs uppercase tracking-widest text-slate-400">{t('ops.orders.open')}</p>
                <p className="text-2xl font-semibold text-white mt-1">{orderSummary.open}</p>
              </div>
              <div className="bg-slate-900/40 rounded-xl p-4 border border-white/10">
                <p className="text-xs uppercase tracking-widest text-slate-400">{t('ops.orders.total')}</p>
                <p className="text-2xl font-semibold text-white mt-1">{orderSummary.total}</p>
              </div>
              <div className="bg-slate-900/40 rounded-xl p-4 border border-white/10">
                <p className="text-xs uppercase tracking-widest text-slate-400">{t('ops.orders.today')}</p>
                <p className="text-2xl font-semibold text-white mt-1">{orderSummary.pickedToday}</p>
              </div>
            </div>
            <div className="bg-slate-900/40 rounded-2xl p-4 border border-white/10">
              {ordersLoading ? (
                <p className="text-slate-400 text-sm">{t('ops.orders.loading')}</p>
              ) : openOrders.length === 0 ? (
                <p className="text-slate-400 text-sm">{t('ops.orders.none')}</p>
              ) : (
                <div className="space-y-3">
                  <ul className="space-y-3">
                    {visibleOrders.map((order) => (
                      <li key={order.id} className="bg-slate-900/60 border border-white/10 rounded-xl p-3">
                        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                          <div>
                            <p className="text-sm font-semibold text-white">
                              {order.customer?.name || t('ops.labels.unknownCustomer')}
                            </p>
                            <p className="text-xs text-slate-400">
                              {order.items.length} Positionen · {formatOrderDate(order.createdAt)}
                            </p>
                            {typeof order.totalAmount === 'number' && (
                              <p className="text-xs text-slate-500">
                                {order.currency || 'EUR'} {order.totalAmount.toFixed(2)}
                              </p>
                            )}
                            <div className="mt-2 text-xs text-slate-300 space-y-1">
                              {order.items.slice(0, 3).map((item) => (
                                <p key={item.id}>
                                  {item.quantity}× {item.name}
                                </p>
                              ))}
                              {order.items.length > 3 && (
                                <p className="text-slate-500">
                                  {t('ops.labels.additionalItems', { count: order.items.length - 3 })}
                                </p>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <span
                              className={`text-xs font-semibold ${order.status === 'picked' ? 'text-emerald-300' : 'text-slate-400'
                                }`}
                            >
                              {order.statusLabel}
                            </span>
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                  {openOrders.length > 5 && (
                    <div className="flex justify-center">
                      <button
                        type="button"
                        onClick={() => setShowAllOpenOrders((prev) => !prev)}
                        className="text-sm text-sky-300 hover:text-sky-200 underline-offset-4 underline"
                      >
                        {showAllOpenOrders ? t('ops.orders.less') : `${t('ops.orders.more')} (${openOrders.length})`}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      <header className="bg-slate-800/40 rounded-2xl p-5 border border-white/10">
        <h1 className="text-2xl font-semibold text-white mb-4">{t('ops.title')}</h1>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {WORKFLOW_CARDS.map((card) => {
            const active = workflow === card.mode;
            return (
              <button
                key={card.mode}
                type="button"
                onClick={() => setWorkflow(card.mode)}
                className={`flex items-center gap-4 rounded-2xl border px-4 py-3 text-left transition ${active ? 'border-sky-500 bg-sky-500/20 text-white shadow-lg shadow-sky-900/30' : 'border-white/10 bg-slate-900/40 text-slate-300 hover:border-slate-500'
                  }`}
              >
                <span className={`p-3 rounded-2xl ${active ? 'bg-sky-600/30 text-white' : 'bg-slate-800 text-slate-200'}`}>{card.icon}</span>
                <div>
                  <p className="font-semibold">{t(card.titleKey)}</p>
                  <p className="text-xs text-slate-400">{t(card.subtitleKey)}</p>
                </div>
              </button>
            );
          })}
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => onSwitchView?.('input')}
            className="rounded-full border border-white/10 px-4 py-2 text-sm text-slate-100 hover:border-slate-400"
          >
            {t('ops.mode.identify')}
          </button>
          <button
            type="button"
            onClick={() => setWorkflow('stow')}
            className={`rounded-full px-4 py-2 text-sm ${workflow === 'stow' ? 'bg-emerald-600 text-white' : 'border border-white/10 text-slate-100 hover:border-slate-400'}`}
          >
            {t('ops.mode.stow')}
          </button>
          <button
            type="button"
            onClick={() => setWorkflow('pick')}
            className={`rounded-full px-4 py-2 text-sm ${workflow === 'pick' ? 'bg-amber-600 text-white' : 'border border-white/10 text-slate-100 hover:border-slate-400'}`}
          >
            {t('ops.mode.pick')}
          </button>
        </div>
      </header>

      <div className="bg-slate-800/40 rounded-2xl p-5 border border-white/10 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm uppercase tracking-widest text-slate-400">{t('ops.labels.activeWorkflow')}</p>
            <h2 className="text-xl font-semibold text-white">{workflow === 'stow' ? t('ops.mode.stow') : t('ops.mode.pick')}</h2>
          </div>
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-full border border-white/10 px-4 py-2 text-sm text-slate-200 hover:border-slate-400"
            onClick={() => setScannerTarget(workflow === 'stow' ? 'stowSku' : 'pickBin')}
          >
            <CameraIcon className="w-4 h-4" />
            {workflow === 'stow' ? t('ops.actions.scan.product') : t('ops.actions.scan.bin')}
          </button>
        </div>

        {statusMessage && <div className="text-sm text-emerald-300 bg-emerald-900/30 px-3 py-2 rounded">{statusMessage}</div>}
        {errorMessage && <div className="text-sm text-rose-300 bg-rose-900/30 px-3 py-2 rounded">{errorMessage}</div>}

        {workflow === 'stow' ? (
          <div
            className="flex flex-col gap-5"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleStow(false);
              }
            }}
          >
            {/* Produkt */}
            <div className="bg-slate-900/50 p-4 rounded-xl border border-white/10">
              <label className="text-xs text-slate-400 uppercase tracking-wide block mb-2">{t('ops.stow.product')}</label>
              <div className="flex gap-3">
                <input
                  value={stowSku}
                  ref={stowSkuRef}
                  onChange={(e) => setStowSku(e.target.value)}
                  className="flex-1 bg-slate-950 border border-white/10 rounded-xl px-4 py-3 text-base text-white focus:ring-2 focus:ring-sky-500 outline-none"
                  placeholder={t('ops.stow.product')}
                />
                <button
                  type="button"
                  onClick={() => setScannerTarget('stowSku')}
                  className="px-4 py-3 rounded-xl bg-slate-700 text-white hover:bg-slate-600 active:scale-95 transition-transform"
                >
                  <CameraIcon className="w-6 h-6" />
                </button>
              </div>
              {matchedStowProduct ? (
                <div className="mt-3 bg-slate-800/50 p-3 rounded-lg border border-white/10">
                  <p className="text-sm font-medium text-white">{matchedStowProduct.identification?.name}</p>
                  {matchedStowProduct.storage?.binCode && (
                    <p className="text-xs text-emerald-400 mt-1">
                      {t('ops.labels.currentBin', { code: matchedStowProduct.storage.binCode })}
                    </p>
                  )}
                </div>
              ) : (
                stowSku && <div className="mt-2 text-sm text-rose-400">{t('ops.labels.noProductFound')}</div>
              )}
            </div>

            {/* Bin & Menge */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="bg-slate-900/50 p-4 rounded-xl border border-white/10">
                <label className="text-xs text-slate-400 uppercase tracking-wide block mb-2">{t('ops.stow.bin')}</label>
                <div className="flex gap-3">
                  <input
                    value={stowBin}
                    ref={stowBinRef}
                    onChange={(e) => setStowBin(e.target.value.toUpperCase())}
                    className="flex-1 bg-slate-950 border border-white/10 rounded-xl px-4 py-3 text-base text-white uppercase font-mono focus:ring-2 focus:ring-sky-500 outline-none"
                    placeholder="BIN..."
                  />
                  <button
                    type="button"
                    onClick={() => setScannerTarget('stowBin')}
                    className="px-4 py-3 rounded-xl bg-slate-700 text-white hover:bg-slate-600 active:scale-95 transition-transform"
                  >
                    <CameraIcon className="w-6 h-6" />
                  </button>
                </div>
              </div>

              <div className="bg-slate-900/50 p-4 rounded-xl border border-white/10">
                <label className="text-xs text-slate-400 uppercase tracking-wide block mb-2">{t('ops.stow.quantity')}</label>
                <input
                  type="number"
                  min={1}
                  value={stowQuantity}
                  onChange={(e) => {
                    const val = e.target.value;
                    if (val === '') {
                      setStowQuantity('');
                    } else {
                      setStowQuantity(Math.max(1, Number(val)));
                    }
                  }}
                  className="w-full bg-slate-950 border border-white/10 rounded-xl px-4 py-3 text-base text-white font-mono focus:ring-2 focus:ring-sky-500 outline-none"
                />
              </div>
            </div>

            {/* Actions */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
              <button
                type="button"
                onClick={() => handleStow(false)}
                disabled={isSubmitting || !stowSku || !stowBin || !stowQuantity}
                className="w-full py-4 rounded-xl bg-sky-600 text-white font-semibold shadow-lg shadow-sky-900/20 hover:bg-sky-500 active:scale-95 transition-all disabled:opacity-50 disabled:active:scale-100"
              >
                {t('ops.stow.submit')}
              </button>
              <button
                type="button"
                onClick={() => handleStow(true)}
                disabled={isSubmitting || !stowSku || !stowBin || !stowQuantity}
                className="w-full py-4 rounded-xl bg-slate-700 text-white font-semibold border border-white/10 hover:bg-slate-600 active:scale-95 transition-all disabled:opacity-50 disabled:active:scale-100"
              >
                {t('ops.stow.submit.next')}
              </button>
            </div>
          </div>
        ) : (
          <div
            className="space-y-4"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handlePick();
              }
            }}
          >
            <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4">
              {nextPickTask ? (
                <div className="space-y-3">
                  <div className="flex items-center justify-between text-[11px] uppercase tracking-wide text-amber-200">
                    <span>{t('ops.labels.nextPick')}</span>
                    <span>{t('ops.labels.openRemaining', { count: pickRouteTasks.length })}</span>
                  </div>
                  <div>
                    <p className="text-lg font-semibold text-white">{nextPickTask.itemName}</p>
                    <p className="text-sm text-slate-300">
                      Auftrag {nextPickTask.orderNumber || nextPickTask.orderId} ·{' '}
                      {nextPickTask.customer || t('ops.labels.unknownCustomer')}
                    </p>
                  </div>
                  {nextPickTask.image && (
                    <div className="flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-900/70 p-3">
                      <img
                        src={resolveImageSrc(nextPickTask.image)}
                        alt={nextPickTask.itemName}
                        className="h-16 w-16 rounded-lg border border-white/10 object-cover"
                        loading="lazy"
                      />
                      <div className="text-xs text-slate-300">
                        <p>Visuelle Referenz</p>
                        <p className="text-[11px] text-slate-500">Nutze zur Identifikation im Bin</p>
                      </div>
                    </div>
                  )}
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-3 text-sm">
                    <div className="rounded-xl border border-white/10 bg-slate-900/70 px-3 py-2">
                      <p className="text-[10px] uppercase tracking-wide text-slate-400">{t('ops.labels.stepBin')}</p>
                      <p className={`text-xl font-semibold ${nextPickTask.binCode ? 'text-amber-300' : 'text-rose-400'}`}>
                        {nextPickTask.binCode || 'Kein Platz'}
                      </p>
                    </div>
                    <div className="rounded-xl border border-white/10 bg-slate-900/70 px-3 py-2">
                      <p className="text-[10px] uppercase tracking-wide text-slate-400">{t('ops.labels.stepSku')}</p>
                      <p className="text-base font-semibold text-white break-all">{nextPickTask.sku || '—'}</p>
                    </div>
                    <div className="rounded-xl border border-white/10 bg-slate-900/70 px-3 py-2">
                      <p className="text-[10px] uppercase tracking-wide text-slate-400">{t('ops.labels.quantity')}</p>
                      <p className="text-xl font-semibold text-white">{nextPickTask.quantity}</p>
                      {typeof nextPickTask.available === 'number' && (
                        <p className="text-[11px] text-slate-400">
                          {t('ops.labels.stock', { value: nextPickTask.available })}
                        </p>
                      )}
                    </div>
                  </div>
                  <p className="text-[12px] text-slate-400">
                    {t('ops.labels.pickInstructions', {
                      bin: nextPickTask.binCode || 'Lagerplatz',
                      sku: nextPickTask.sku || '—',
                    })}
                  </p>
                  <div className="flex flex-wrap gap-2 text-sm">
                    <button
                      type="button"
                      onClick={() => nextPickTask.binCode && loadBinDetail(nextPickTask.binCode)}
                      disabled={!nextPickTask.binCode}
                      className="rounded-full border border-white/10 px-3 py-1.5 text-slate-100 hover:border-slate-400 disabled:opacity-50"
                    >
                      {t('ops.actions.reloadBin')}
                    </button>
                    <button
                      type="button"
                      onClick={() => markPickTaskCompleted(nextPickTask.itemId)}
                      className="rounded-full border border-white/10 px-3 py-1.5 text-slate-100 hover:border-slate-400"
                    >
                      {t('ops.actions.skipOrder')}
                    </button>
                    {skippedPickItemIds.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setSkippedPickItemIds([])}
                        className="rounded-full border border-white/10 px-3 py-1.5 text-slate-100 hover:border-slate-400"
                      >
                        {t('ops.actions.resetRoute')}
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <div className="text-sm text-slate-300">{t('ops.labels.noPickTasks')}</div>
              )}
            </div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-[10px] uppercase tracking-wide text-slate-400">{t('ops.pick.steps.bin')}</p>
                    <p className={`text-xl font-semibold ${nextPickTask?.binCode ? 'text-white' : 'text-rose-400'}`}>
                      {nextPickTask?.binCode || 'Kein Platz'}
                    </p>
                  </div>
                  {renderScanStatusBadge(pickScanStatus.bin)}
                </div>
                <div className="mt-3 space-y-1 text-xs text-slate-400">
                  <p>
                    {t('ops.pick.steps.expected')}: <span className="text-slate-200">{nextPickTask?.binCode || 'Beliebig'}</span>
                  </p>
                  <p>
                    {t('ops.pick.steps.scanned')}: <span className="text-slate-200">{pickBin || t('ops.pick.steps.pending')}</span>
                  </p>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setScannerTarget('pickBin')}
                    className="rounded-full border border-white/10 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-slate-200 hover:border-slate-400"
                  >
                    {t('ops.pick.steps.cta')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const code = pickBin || nextPickTask?.binCode || '';
                      loadBinDetail(code);
                    }}
                    className="rounded-full border border-white/10 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-slate-200 hover:border-slate-400"
                  >
                    {t('ops.actions.reloadBin')}
                  </button>
                </div>
              </div>
              <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-[10px] uppercase tracking-wide text-slate-400">{t('ops.pick.steps.sku')}</p>
                    <p className="text-base font-semibold text-white break-all">{nextPickTask?.sku || '—'}</p>
                  </div>
                  {renderScanStatusBadge(pickScanStatus.sku)}
                </div>
                <div className="mt-3 space-y-1 text-xs text-slate-400">
                  <p>
                    {t('ops.pick.steps.expected')}: <span className="text-slate-200">{nextPickTask?.sku || '—'}</span>
                  </p>
                  <p>
                    {t('ops.pick.steps.scanned')}: <span className="text-slate-200">{pickSku || t('ops.pick.steps.pending')}</span>
                  </p>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setScannerTarget('pickSku')}
                    className="rounded-full border border-white/10 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-slate-200 hover:border-slate-400"
                  >
                    {t('ops.pick.steps.cta')}
                  </button>
                </div>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <label className="text-xs text-slate-400 uppercase tracking-wide">{t('ops.pick.quantity')}</label>
                <input
                  type="number"
                  min={1}
                  value={pickQuantity}
                  onChange={(e) => {
                    const val = e.target.value;
                    if (val === '') {
                      setPickQuantity('');
                    } else {
                      setPickQuantity(Math.max(1, Number(val)));
                    }
                  }}
                  className="mt-1 w-full rounded-xl border border-white/10 bg-slate-900 px-3 py-2 text-sm text-white"
                />
                <p className="mt-1 text-xs text-slate-400">
                  {t('ops.pick.quantityHint', { value: nextPickTask?.quantity || 1 })}
                </p>
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <button
                  type="button"
                  onClick={handleResetPickScans}
                  className="rounded-full border border-white/10 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-slate-200 hover:border-slate-400"
                >
                  {t('ops.pick.reset')}
                </button>
              </div>
            </div>

            {pickBinDetail && (
              <div className="rounded-xl border border-white/10 bg-slate-900/60 p-4">
                <h4 className="text-white font-semibold mb-2">BIN {pickBinDetail.code}</h4>
                {pickBinDetail.products?.length ? (
                  <ul className="space-y-2 max-h-52 overflow-y-auto text-sm">
                    {pickBinDetail.products.map((item) => (
                      <li
                        key={item.productId}
                        className={`flex items-center justify-between px-3 py-2 rounded ${pickSku && item.sku?.toLowerCase() === pickSku.toLowerCase() ? 'bg-sky-600/30' : 'bg-slate-800'
                          }`}
                      >
                        <div>
                          <p className="text-white">{item.name}</p>
                          <p className="text-xs text-slate-400">
                            SKU {item.sku} · Menge {item.quantity}
                          </p>
                        </div>
                        {item.image && (
                          <img
                            src={resolveImageSrc(item.image)}
                            alt={item.name}
                            className="w-12 h-12 object-cover rounded border border-white/10"
                          />
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-slate-400 text-sm">{t('ops.labels.binEmpty')}</p>
                )}
              </div>
            )}

            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={handlePick}
                disabled={!pickConfirmReady || isSubmitting}
                className="rounded-full bg-emerald-600 px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-slate-600"
              >
                {isSubmitting ? t('ops.pick.submitting') : t('ops.pick.submit')}
              </button>
            </div>
          </div>
        )}
      </div>

      <ScannerOverlay
        open={scannerTarget !== null}
        title="Code scannen"
        onDetected={handleScannerResult}
        onClose={() => setScannerTarget(null)}
        onFallbackCapture={handleFallbackCapture}
        fallbackBusy={isFallbackDecoding}
        fallbackHint="iOS-Chrome unterstützt keinen Live-Scanner. Nimm ein Foto auf, wir lesen den Code daraus."
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

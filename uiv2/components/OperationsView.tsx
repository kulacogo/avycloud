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
      if (status === 'ok') {
        return <span className="status-badge success">{t('ops.pick.steps.ok')}</span>;
      }
      if (status === 'mismatch') {
        return <span className="status-badge error">{t('ops.pick.steps.mismatch')}</span>;
      }
      return <span className="status-badge draft">{t('ops.pick.steps.pending')}</span>;
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

    const chooseBestBinForProduct = (product: Product | null) => {
      if (!product) return null;
      const bins = Array.isArray(product.storageBins) ? product.storageBins : [];
      const positive = bins
        .filter((b) => b && b.code && Number(b.quantity || 0) > 0)
        .map((b) => ({ code: String(b.code).toUpperCase(), quantity: Number(b.quantity || 0) || 0 }));
      if (positive.length) {
        positive.sort((a, b) => (b.quantity - a.quantity) || compareBinCodesForPickRoute(a.code, b.code));
        return positive[0];
      }
      if (product.storage?.binCode) {
        return { code: String(product.storage.binCode).toUpperCase(), quantity: Number(product.storage.quantity || 0) || 0 };
      }
      return null;
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

        const bestBin =
          chooseBestBinForProduct(product) ||
          (hint?.binCode ? { code: String(hint.binCode).toUpperCase(), quantity: Number(hint.quantityAvailable || 0) || 0 } : null);

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
    <section>
      {/* ═══════ PAGE HEADER ═══════ */}
      <div className="page-header">
        <div>
          <h1>{t('ops.title')}</h1>
          <div className="page-header-sub">Einlagern &amp; Kommissionieren</div>
        </div>
        <div className="page-header-actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => onSwitchView?.('input')}
          >
            {t('ops.mode.identify')}
          </button>
        </div>
      </div>

      <div className="content" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
        {/* ═══════ ORDERS SECTION (BaseLinker) ═══════ */}
        <div className="card">
          <div className="card-header">
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
              <span className="card-title" style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-tertiary)', fontWeight: 500 }}>BaseLinker</span>
              <span className="card-title">{t('ops.orders.section')}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', fontSize: '13px', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={autoOrderSync}
                  onChange={handleAutoSyncToggle}
                  style={{ accentColor: 'var(--avy-purple)' }}
                />
                {t('ops.orders.auto')}
              </label>
              <button
                type="button"
                onClick={() => handleSyncOrders(true)}
                disabled={isSyncingOrders}
                className="btn btn-primary btn-sm"
              >
                {isSyncingOrders ? t('ops.orders.syncing') : t('ops.orders.sync')}
              </button>
              {isMobile && (
                <button
                  type="button"
                  onClick={() => setShowOrdersPanel((prev) => !prev)}
                  className="btn btn-secondary btn-sm"
                >
                  {showOrdersPanel ? t('ops.orders.hide') : t('ops.orders.show')}
                </button>
              )}
            </div>
          </div>
          <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
            {orderStatusMessage && (
              <div style={{ fontSize: '13px', color: 'var(--success)', background: 'var(--success-bg)', border: '1px solid var(--success-border)', padding: 'var(--space-2) var(--space-3)', borderRadius: 'var(--radius-md)' }}>
                {orderStatusMessage}
              </div>
            )}
            {(ordersError || orderErrorMessage) && (
              <div style={{ fontSize: '13px', color: 'var(--error)', background: 'var(--error-bg)', border: '1px solid var(--error-border)', padding: 'var(--space-2) var(--space-3)', borderRadius: 'var(--radius-md)' }}>
                {ordersError || orderErrorMessage}
              </div>
            )}
            {showOrdersPanel && (
              <>
                {/* Order Stats */}
                <div className="kpi-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
                  <div className="kpi-card">
                    <div className="kpi-label">{t('ops.orders.open')}</div>
                    <div className="kpi-value">{orderSummary.open}</div>
                  </div>
                  <div className="kpi-card">
                    <div className="kpi-label">{t('ops.orders.total')}</div>
                    <div className="kpi-value">{orderSummary.total}</div>
                  </div>
                  <div className="kpi-card">
                    <div className="kpi-label">{t('ops.orders.today')}</div>
                    <div className="kpi-value">{orderSummary.pickedToday}</div>
                  </div>
                </div>

                {/* Order List */}
                <div className="card">
                  <div className="card-body" style={{ padding: 'var(--space-3)' }}>
                    {ordersLoading ? (
                      <p style={{ color: 'var(--text-tertiary)', fontSize: '13px' }}>{t('ops.orders.loading')}</p>
                    ) : openOrders.length === 0 ? (
                      <p style={{ color: 'var(--text-tertiary)', fontSize: '13px' }}>{t('ops.orders.none')}</p>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
                        {visibleOrders.map((order) => (
                          <div
                            key={order.id}
                            className="next-order"
                          >
                            <div className="next-order-info" style={{ flex: 1 }}>
                              <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>
                                {order.customer?.name || t('ops.labels.unknownCustomer')}
                              </div>
                              <div style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>
                                {order.items.length} Positionen · {formatOrderDate(order.createdAt)}
                              </div>
                              {typeof order.totalAmount === 'number' && (
                                <div style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>
                                  {order.currency || 'EUR'} {order.totalAmount.toFixed(2)}
                                </div>
                              )}
                              <div style={{ marginTop: 'var(--space-2)', fontSize: '12px', color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: '2px' }}>
                                {order.items.slice(0, 3).map((item) => (
                                  <span key={item.id}>
                                    {item.quantity}x {item.name}
                                  </span>
                                ))}
                                {order.items.length > 3 && (
                                  <span style={{ color: 'var(--text-tertiary)' }}>
                                    {t('ops.labels.additionalItems', { count: order.items.length - 3 })}
                                  </span>
                                )}
                              </div>
                            </div>
                            <span className={`status-badge ${order.status === 'picked' ? 'success' : 'draft'}`}>
                              {order.statusLabel}
                            </span>
                          </div>
                        ))}
                        {openOrders.length > 5 && (
                          <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 'var(--space-2)' }}>
                            <button
                              type="button"
                              onClick={() => setShowAllOpenOrders((prev) => !prev)}
                              className="btn btn-ghost btn-sm"
                              style={{ color: 'var(--avy-purple)' }}
                            >
                              {showAllOpenOrders ? t('ops.orders.less') : `${t('ops.orders.more')} (${openOrders.length})`}
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>

        {/* ═══════ MODE TABS ═══════ */}
        <div className="mode-tabs">
          <button
            type="button"
            className={`mode-tab ${workflow === 'stow' ? 'active' : ''}`}
            onClick={() => setWorkflow('stow')}
          >
            <WarehouseIcon className="w-5 h-5" />
            {t('ops.mode.stow')}
          </button>
          <button
            type="button"
            className={`mode-tab ${workflow === 'pick' ? 'active' : ''}`}
            onClick={() => setWorkflow('pick')}
          >
            <SyncIcon className="w-5 h-5" />
            {t('ops.mode.pick')}
            {pickRouteTasks.length > 0 && (
              <span className="tab-count">{pickRouteTasks.length}</span>
            )}
          </button>
        </div>

        {/* ═══════ ACTIVE WORKFLOW CARD ═══════ */}
        <div className="card">
          <div className="card-header">
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
              <span style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-tertiary)', fontWeight: 500 }}>{t('ops.labels.activeWorkflow')}</span>
              <span className="card-title">{workflow === 'stow' ? t('ops.mode.stow') : t('ops.mode.pick')}</span>
            </div>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setScannerTarget(workflow === 'stow' ? 'stowSku' : 'pickBin')}
            >
              <CameraIcon className="w-4 h-4" />
              {workflow === 'stow' ? t('ops.actions.scan.product') : t('ops.actions.scan.bin')}
            </button>
          </div>
          <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
            {/* Status / Error Messages */}
            {statusMessage && (
              <div style={{ fontSize: '13px', color: 'var(--success)', background: 'var(--success-bg)', border: '1px solid var(--success-border)', padding: 'var(--space-2) var(--space-3)', borderRadius: 'var(--radius-md)' }}>
                {statusMessage}
              </div>
            )}
            {errorMessage && (
              <div style={{ fontSize: '13px', color: 'var(--error)', background: 'var(--error-bg)', border: '1px solid var(--error-border)', padding: 'var(--space-2) var(--space-3)', borderRadius: 'var(--radius-md)' }}>
                {errorMessage}
              </div>
            )}

            {workflow === 'stow' ? (
              /* ═══════ STOW FORM ═══════ */
              <div
                style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleStow(false);
                  }
                }}
              >
                {/* Product Scanner */}
                <div className="form-group">
                  <label className="form-label">{t('ops.stow.product')}</label>
                  <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                    <div className="scanner-wrap" style={{ flex: 1, marginBottom: 0 }}>
                      <input
                        value={stowSku}
                        ref={stowSkuRef}
                        onChange={(e) => setStowSku(e.target.value)}
                        className="scanner-input"
                        placeholder={t('ops.stow.product')}
                        style={{ fontSize: '15px', padding: '12px 12px 12px 44px' }}
                      />
                      <svg className="scanner-icon" width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ left: '14px' }}><path d="M3 5V3h3M12 3h3v2M3 13v2h3M12 15h3v-2M6 6v6M9 6v6M12 6v6"/></svg>
                    </div>
                    <button
                      type="button"
                      onClick={() => setScannerTarget('stowSku')}
                      className="btn btn-secondary btn-icon"
                      style={{ width: '44px', height: '44px' }}
                    >
                      <CameraIcon className="w-5 h-5" />
                    </button>
                  </div>
                  {matchedStowProduct ? (
                    <div className="scanned-item" style={{ marginTop: 'var(--space-3)', marginBottom: 0, padding: 'var(--space-3)' }}>
                      <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>{matchedStowProduct.identification?.name}</div>
                      {matchedStowProduct.storage?.binCode && (
                        <div style={{ marginTop: '4px' }}>
                          <span className="bin-tag">
                            {t('ops.labels.currentBin', { code: matchedStowProduct.storage.binCode })}
                          </span>
                        </div>
                      )}
                    </div>
                  ) : (
                    stowSku && <div className="form-error">{t('ops.labels.noProductFound')}</div>
                  )}
                </div>

                {/* Bin & Quantity */}
                <div className="ops-grid">
                  <div className="form-group">
                    <label className="form-label">{t('ops.stow.bin')}</label>
                    <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                      <input
                        value={stowBin}
                        ref={stowBinRef}
                        onChange={(e) => setStowBin(e.target.value.toUpperCase())}
                        className="form-input"
                        placeholder="BIN..."
                        style={{ fontFamily: "'SF Mono','Fira Code','Consolas', monospace", textTransform: 'uppercase' }}
                      />
                      <button
                        type="button"
                        onClick={() => setScannerTarget('stowBin')}
                        className="btn btn-secondary btn-icon"
                        style={{ width: '44px', height: '44px', flexShrink: 0 }}
                      >
                        <CameraIcon className="w-5 h-5" />
                      </button>
                    </div>
                  </div>

                  <div className="form-group">
                    <label className="form-label">{t('ops.stow.quantity')}</label>
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
                      className="form-input"
                      style={{ fontFamily: "'SF Mono','Fira Code','Consolas', monospace" }}
                    />
                  </div>
                </div>

                {/* Actions */}
                <div className="ops-grid">
                  <button
                    type="button"
                    onClick={() => handleStow(false)}
                    disabled={isSubmitting || !stowSku || !stowBin || !stowQuantity}
                    className="btn btn-primary btn-lg"
                    style={{ width: '100%', justifyContent: 'center' }}
                  >
                    {t('ops.stow.submit')}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleStow(true)}
                    disabled={isSubmitting || !stowSku || !stowBin || !stowQuantity}
                    className="btn btn-secondary btn-lg"
                    style={{ width: '100%', justifyContent: 'center' }}
                  >
                    {t('ops.stow.submit.next')}
                  </button>
                </div>
              </div>
            ) : (
              /* ═══════ PICK FORM ═══════ */
              <div
                style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handlePick();
                  }
                }}
              >
                {/* Next Pick Task Banner */}
                <div style={{ border: '1px solid var(--warning-border)', background: 'var(--warning-bg)', borderRadius: 'var(--radius-lg)', padding: 'var(--space-4)' }}>
                  {nextPickTask ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <span className="status-badge warning">{t('ops.labels.nextPick')}</span>
                        <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-tertiary)' }}>{t('ops.labels.openRemaining', { count: pickRouteTasks.length })}</span>
                      </div>
                      <div>
                        <div style={{ fontSize: '17px', fontWeight: 700, color: 'var(--text-primary)' }}>{nextPickTask.itemName}</div>
                        <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                          Auftrag {nextPickTask.orderNumber || nextPickTask.orderId} ·{' '}
                          {nextPickTask.customer || t('ops.labels.unknownCustomer')}
                        </div>
                      </div>
                      {nextPickTask.image && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', background: 'var(--surface)', padding: 'var(--space-3)' }}>
                          <img
                            src={resolveImageSrc(nextPickTask.image)}
                            alt={nextPickTask.itemName}
                            style={{ height: '64px', width: '64px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', objectFit: 'cover' }}
                            loading="lazy"
                          />
                          <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                            <div>Visuelle Referenz</div>
                            <div style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>Nutze zur Identifikation im Bin</div>
                          </div>
                        </div>
                      )}
                      {/* Task Details Grid */}
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 'var(--space-3)' }}>
                        <div className="card" style={{ borderRadius: 'var(--radius-md)' }}>
                          <div style={{ padding: 'var(--space-3)' }}>
                            <div style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-tertiary)', fontWeight: 500 }}>{t('ops.labels.stepBin')}</div>
                            <div className="bin-tag" style={{ marginTop: '4px', fontSize: nextPickTask.binCode ? '17px' : '13px' }}>
                              {nextPickTask.binCode || 'Kein Platz'}
                            </div>
                          </div>
                        </div>
                        <div className="card" style={{ borderRadius: 'var(--radius-md)' }}>
                          <div style={{ padding: 'var(--space-3)' }}>
                            <div style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-tertiary)', fontWeight: 500 }}>{t('ops.labels.stepSku')}</div>
                            <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)', marginTop: '4px', wordBreak: 'break-all', fontFamily: "'SF Mono','Fira Code','Consolas', monospace" }}>
                              {nextPickTask.sku || '\u2014'}
                            </div>
                          </div>
                        </div>
                        <div className="card" style={{ borderRadius: 'var(--radius-md)' }}>
                          <div style={{ padding: 'var(--space-3)' }}>
                            <div style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-tertiary)', fontWeight: 500 }}>{t('ops.labels.quantity')}</div>
                            <div style={{ fontSize: '20px', fontWeight: 700, color: 'var(--text-primary)', marginTop: '4px' }}>{nextPickTask.quantity}</div>
                            {typeof nextPickTask.available === 'number' && (
                              <div style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>
                                {t('ops.labels.stock', { value: nextPickTask.available })}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                      <div style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>
                        {t('ops.labels.pickInstructions', {
                          bin: nextPickTask.binCode || 'Lagerplatz',
                          sku: nextPickTask.sku || '\u2014',
                        })}
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
                        <button
                          type="button"
                          onClick={() => nextPickTask.binCode && loadBinDetail(nextPickTask.binCode)}
                          disabled={!nextPickTask.binCode}
                          className="btn btn-secondary btn-sm"
                        >
                          {t('ops.actions.reloadBin')}
                        </button>
                        <button
                          type="button"
                          onClick={() => markPickTaskCompleted(nextPickTask.itemId)}
                          className="btn btn-secondary btn-sm"
                        >
                          {t('ops.actions.skipOrder')}
                        </button>
                        {skippedPickItemIds.length > 0 && (
                          <button
                            type="button"
                            onClick={() => setSkippedPickItemIds([])}
                            className="btn btn-secondary btn-sm"
                          >
                            {t('ops.actions.resetRoute')}
                          </button>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>{t('ops.labels.noPickTasks')}</div>
                  )}
                </div>

                {/* Scan Steps: Bin + SKU */}
                <div className="ops-grid">
                  {/* BIN Scan Step */}
                  <div className="card">
                    <div className="card-body">
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-3)' }}>
                        <div>
                          <div style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-tertiary)', fontWeight: 500 }}>{t('ops.pick.steps.bin')}</div>
                          <div className="bin-tag" style={{ marginTop: '4px' }}>
                            {nextPickTask?.binCode || 'Kein Platz'}
                          </div>
                        </div>
                        {renderScanStatusBadge(pickScanStatus.bin)}
                      </div>
                      <div style={{ marginTop: 'var(--space-3)', display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', color: 'var(--text-tertiary)' }}>
                        <span>
                          {t('ops.pick.steps.expected')}: <strong style={{ color: 'var(--text-primary)' }}>{nextPickTask?.binCode || 'Beliebig'}</strong>
                        </span>
                        <span>
                          {t('ops.pick.steps.scanned')}: <strong style={{ color: 'var(--text-primary)' }}>{pickBin || t('ops.pick.steps.pending')}</strong>
                        </span>
                      </div>
                      <div style={{ marginTop: 'var(--space-3)', display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
                        <button
                          type="button"
                          onClick={() => setScannerTarget('pickBin')}
                          className="btn btn-primary btn-sm"
                        >
                          {t('ops.pick.steps.cta')}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            const code = pickBin || nextPickTask?.binCode || '';
                            loadBinDetail(code);
                          }}
                          className="btn btn-secondary btn-sm"
                        >
                          {t('ops.actions.reloadBin')}
                        </button>
                      </div>
                    </div>
                  </div>
                  {/* SKU Scan Step */}
                  <div className="card">
                    <div className="card-body">
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-3)' }}>
                        <div>
                          <div style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-tertiary)', fontWeight: 500 }}>{t('ops.pick.steps.sku')}</div>
                          <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)', marginTop: '4px', wordBreak: 'break-all', fontFamily: "'SF Mono','Fira Code','Consolas', monospace" }}>
                            {nextPickTask?.sku || '\u2014'}
                          </div>
                        </div>
                        {renderScanStatusBadge(pickScanStatus.sku)}
                      </div>
                      <div style={{ marginTop: 'var(--space-3)', display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', color: 'var(--text-tertiary)' }}>
                        <span>
                          {t('ops.pick.steps.expected')}: <strong style={{ color: 'var(--text-primary)' }}>{nextPickTask?.sku || '\u2014'}</strong>
                        </span>
                        <span>
                          {t('ops.pick.steps.scanned')}: <strong style={{ color: 'var(--text-primary)' }}>{pickSku || t('ops.pick.steps.pending')}</strong>
                        </span>
                      </div>
                      <div style={{ marginTop: 'var(--space-3)', display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
                        <button
                          type="button"
                          onClick={() => setScannerTarget('pickSku')}
                          className="btn btn-primary btn-sm"
                        >
                          {t('ops.pick.steps.cta')}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Pick Quantity + Reset */}
                <div className="ops-grid">
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <label className="form-label">{t('ops.pick.quantity')}</label>
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
                      className="form-input"
                      style={{ fontFamily: "'SF Mono','Fira Code','Consolas', monospace" }}
                    />
                    <div style={{ marginTop: '4px', fontSize: '12px', color: 'var(--text-tertiary)' }}>
                      {t('ops.pick.quantityHint', { value: nextPickTask?.quantity || 1 })}
                    </div>
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 'var(--space-2)' }}>
                    <button
                      type="button"
                      onClick={handleResetPickScans}
                      className="btn btn-secondary btn-sm"
                    >
                      {t('ops.pick.reset')}
                    </button>
                  </div>
                </div>

                {/* Bin Detail */}
                {pickBinDetail && (
                  <div className="card">
                    <div className="card-header">
                      <span className="card-title">BIN {pickBinDetail.code}</span>
                    </div>
                    <div className="card-body" style={{ padding: 'var(--space-3)' }}>
                      {pickBinDetail.products?.length ? (
                        <div className="queue-list" style={{ maxHeight: '200px', overflowY: 'auto' }}>
                          {pickBinDetail.products.map((item) => (
                            <div
                              key={item.productId}
                              className="queue-item"
                              style={pickSku && item.sku?.toLowerCase() === pickSku.toLowerCase() ? { background: 'var(--avy-purple-glow)', borderColor: 'var(--avy-purple)' } : undefined}
                            >
                              {item.image && (
                                <div className="queue-thumb">
                                  <img
                                    src={resolveImageSrc(item.image)}
                                    alt={item.name}
                                    style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'var(--radius-sm)' }}
                                  />
                                </div>
                              )}
                              <div className="queue-info">
                                <div className="queue-name">{item.name}</div>
                                <div className="queue-sub">
                                  <span className="queue-bin">SKU {item.sku}</span>
                                  <span>Menge {item.quantity}</span>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p style={{ color: 'var(--text-tertiary)', fontSize: '13px' }}>{t('ops.labels.binEmpty')}</p>
                      )}
                    </div>
                  </div>
                )}

                {/* Confirm Pick */}
                <div>
                  <button
                    type="button"
                    onClick={handlePick}
                    disabled={!pickConfirmReady || isSubmitting}
                    className="btn btn-success btn-lg"
                    style={{ width: '100%', justifyContent: 'center' }}
                  >
                    {isSubmitting ? t('ops.pick.submitting') : t('ops.pick.submit')}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ═══════ SCANNER OVERLAY ═══════ */}
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
        style={{ display: 'none' }}
        onChange={handleFallbackFileChange}
      />
    </section>
  );
};

export default OperationsView;

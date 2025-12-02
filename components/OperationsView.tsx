import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BrowserMultiFormatReader } from '@zxing/browser';
import { Product, WarehouseBin, Order } from '../types';
import {
  fetchWarehouseBinDetail,
  stockInProduct,
  stockOutProduct,
  buildImageProxyUrl,
  scanDocument,
  fetchOrders as fetchOrdersApi,
  syncOrders as syncOrdersApi,
  completeOrder as completeOrderApi,
} from '../api/client';
import { ScannerOverlay } from './ScannerOverlay';
import { WarehouseIcon, SyncIcon, CameraIcon } from './icons/Icons';
import { useI18n } from '../i18n';

interface OperationsViewProps {
  products: Product[];
  onProductUpdate: (product: Product) => void;
  onStockChanged?: (bin: WarehouseBin) => void;
  onSwitchView?: (view: 'dashboard' | 'input' | 'sheet' | 'inventory' | 'warehouse' | 'operations') => void;
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
  productId?: string | null;
  available?: number | null;
  image?: string | null;
};

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
  const [completedPickItemIds, setCompletedPickItemIds] = useState<string[]>([]);

  const [orders, setOrders] = useState<Order[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [ordersError, setOrdersError] = useState<string | null>(null);
  const [orderStatusMessage, setOrderStatusMessage] = useState<string | null>(null);
  const [orderErrorMessage, setOrderErrorMessage] = useState<string | null>(null);
  const [isSyncingOrders, setIsSyncingOrders] = useState(false);
  const [completingOrderId, setCompletingOrderId] = useState<string | null>(null);
  const [showAllOpenOrders, setShowAllOpenOrders] = useState(false);
  const [autoOrderSync, setAutoOrderSync] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem('avystock:autoOrderSync') === 'true';
  });
  const autoSyncIntervalRef = useRef<number | null>(null);

  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isScanningDoc, setIsScanningDoc] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanResult, setScanResult] = useState<{ base64: string; mimeType: string; capturedAt: string } | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const fallbackReaderRef = useRef<BrowserMultiFormatReader | null>(null);
  const [isFallbackDecoding, setIsFallbackDecoding] = useState(false);
  const stowSkuRef = useRef<HTMLInputElement | null>(null);
  const stowBinRef = useRef<HTMLInputElement | null>(null);
  const pickBinRef = useRef<HTMLInputElement | null>(null);
  const pickSkuRef = useRef<HTMLInputElement | null>(null);
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

  const completedPickItemSet = useMemo(() => new Set(completedPickItemIds), [completedPickItemIds]);

  const openOrders = useMemo(() => orders.filter((order) => order.status !== 'picked'), [orders]);
  const visibleOrders = useMemo(
    () => (showAllOpenOrders ? openOrders : openOrders.slice(0, 5)),
    [openOrders, showAllOpenOrders]
  );

  useEffect(() => {
    if (openOrders.length <= 5 && showAllOpenOrders) {
      setShowAllOpenOrders(false);
    }
  }, [openOrders.length, showAllOpenOrders]);

  useEffect(() => {
    if (!completedPickItemIds.length) return;
    const stillOpenIds = new Set<string>();
    openOrders.forEach((order) => order.items.forEach((item) => stillOpenIds.add(item.id)));
    const filtered = completedPickItemIds.filter((id) => stillOpenIds.has(id));
    if (filtered.length !== completedPickItemIds.length) {
      setCompletedPickItemIds(filtered);
    }
  }, [openOrders, completedPickItemIds]);

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
    openOrders.forEach((order) => {
      order.items.forEach((item) => {
        if (completedPickItemSet.has(item.id)) {
          return;
        }
        const hint = item.pickHint || null;
        let binCode = hint?.binCode?.toUpperCase() || null;
        let skuCandidate = item.sku || hint?.sku || item.ean || null;
        let product: Product | null = null;

        if (!binCode || !skuCandidate || !hint?.image || typeof hint?.quantityAvailable !== 'number') {
          product = resolveProductForItem(item);
          if (!binCode && product) {
            binCode =
              product.storage?.binCode ||
              (product.storageBins && product.storageBins.length ? product.storageBins[0]?.code : null) ||
              null;
            if (binCode) {
              binCode = binCode.toUpperCase();
            }
          }
          if (!skuCandidate && product) {
            skuCandidate =
              product.details?.identifiers?.sku ||
              product.identification?.sku ||
              product.details?.identifiers?.ean ||
              product.details?.identifiers?.gtin ||
              product.id ||
              null;
          }
        }

        if (!binCode || !skuCandidate) {
          return;
        }

        tasks.push({
          orderId: order.id,
          orderNumber: order.number,
          customer: order.customer?.name,
          itemId: item.id,
          itemName: hint?.productName || product?.identification?.name || item.name,
          sku: skuCandidate,
          binCode: binCode.toUpperCase(),
          quantity: item.quantity,
          productId: hint?.productId || product?.id || item.productId || undefined,
          available:
            typeof hint?.quantityAvailable === 'number'
              ? hint.quantityAvailable
              : product?.storage?.quantity || product?.inventory?.quantity || null,
          image: hint?.image || product?.details?.images?.[0]?.url_or_base64 || null,
        });
      });
    });
    return tasks;
  }, [completedPickItemSet, openOrders, resolveProductForItem]);

  const nextPickTask = pickRouteTasks[0] || null;

  const handleScannerResult = (value: string) => {
    switch (scannerTarget) {
      case 'stowSku':
        setStowSku(value);
        break;
      case 'stowBin':
        setStowBin(value.toUpperCase());
        break;
      case 'pickBin':
        setPickBin(value.toUpperCase());
        loadBinDetail(value.toUpperCase());
        break;
      case 'pickSku':
        setPickSku(value);
        break;
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
    setStatusMessage('Analysiere Foto …');
    setErrorMessage(null);
    try {
      const reader = await loadFallbackReader();
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.src = url;
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('Bild konnte nicht geladen werden.'));
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

  const handleTriggerScan = async () => {
    setIsScanningDoc(true);
    setScanError(null);
    try {
      const result = await scanDocument();
      if (!result.ok || !result.data) {
        setScanError(result.error?.message || t('ops.errors.scan'));
        setScanResult(null);
      } else {
        setScanResult(result.data);
      }
    } catch (error: any) {
      setScanError(error?.message || t('ops.errors.scan'));
      setScanResult(null);
    } finally {
      setIsScanningDoc(false);
    }
  };

  const loadBinDetail = async (code: string) => {
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

  const handleMarkOrderComplete = async (orderId: string) => {
    try {
      setCompletingOrderId(orderId);
      setOrderErrorMessage(null);
      await completeOrderApi(orderId);
      setOrders((prev) =>
        prev.map((order) =>
          order.id === orderId
            ? { ...order, status: 'picked', statusLabel: 'Kommissioniert', pickedAt: new Date().toISOString() }
            : order
        )
      );
      setOrderStatusMessage(t('ops.orders.markedComplete'));
      window.setTimeout(() => setOrderStatusMessage(null), 4000);
    } catch (error: any) {
      setOrderErrorMessage(error?.message || t('ops.errors.orderComplete'));
    } finally {
      setCompletingOrderId(null);
    }
  };

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
    } else if (workflow === 'pick') {
      pickBinRef.current?.focus();
    }
  }, [workflow]);

  useEffect(() => {
    if (workflow !== 'pick') return;
    if (!nextPickTask) {
      return;
    }
    setPickBin((prev) => (prev === nextPickTask.binCode ? prev : nextPickTask.binCode));
    setPickSku((prev) => (prev === (nextPickTask.sku || '') ? prev : nextPickTask.sku || ''));
    setPickQuantity((prev) => {
      const nextQty = nextPickTask.quantity || 1;
      return prev === nextQty ? prev : nextQty;
    });
    if (lastAutoBinRef.current !== nextPickTask.binCode) {
      lastAutoBinRef.current = nextPickTask.binCode;
      loadBinDetail(nextPickTask.binCode);
    }
  }, [nextPickTask, workflow]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const mq = window.matchMedia('(max-width: 768px)');
    const handler = (event: MediaQueryListEvent) => {
      setIsMobile(event.matches);
      setShowOrdersPanel(event.matches ? false : true);
    };
    mq.addEventListener('change', handler);
    setIsMobile(mq.matches);
    setShowOrdersPanel(mq.matches ? false : true);
    return () => mq.removeEventListener('change', handler);
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
      }
    } catch (error: any) {
      setErrorMessage(error?.message || t('ops.errors.stow'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const markPickTaskCompleted = (itemId?: string | null) => {
    if (!itemId) return;
    setCompletedPickItemIds((prev) => {
      if (prev.includes(itemId)) {
        return prev;
      }
      return [...prev, itemId];
    });
  };

  const handlePick = async () => {
    if (!pickBin || (!matchedPickProduct && !pickSku)) {
      setErrorMessage(t('ops.errors.pickValidation'));
      return;
    }
    try {
      setIsSubmitting(true);
      setErrorMessage(null);
      const payload = {
        sku: pickSku || undefined,
        productId: matchedPickProduct?.id,
        binCode: pickBin.toUpperCase(),
        quantity: typeof pickQuantity === 'number' ? pickQuantity : Number(pickQuantity) || 0,
      };
      const activeTaskId = nextPickTask?.itemId;
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
      setPickQuantity(1);
      loadBinDetail(pickBin.toUpperCase());
      if (activeTaskId) {
        markPickTaskCompleted(activeTaskId);
      }
    } catch (error: any) {
      setErrorMessage(error?.message || t('ops.errors.pick'));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <section className="space-y-6">
      <div className="bg-slate-800 rounded-2xl p-5 border border-slate-700 shadow-lg space-y-4">
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
                className="inline-flex items-center rounded-full border border-slate-600 px-3 py-2 text-sm text-slate-100 hover:border-slate-400"
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
              <div className="bg-slate-900/40 rounded-xl p-4 border border-slate-700">
                <p className="text-xs uppercase tracking-widest text-slate-400">{t('ops.orders.open')}</p>
                <p className="text-2xl font-semibold text-white mt-1">{orderSummary.open}</p>
              </div>
              <div className="bg-slate-900/40 rounded-xl p-4 border border-slate-700">
                <p className="text-xs uppercase tracking-widest text-slate-400">{t('ops.orders.total')}</p>
                <p className="text-2xl font-semibold text-white mt-1">{orderSummary.total}</p>
              </div>
              <div className="bg-slate-900/40 rounded-xl p-4 border border-slate-700">
                <p className="text-xs uppercase tracking-widest text-slate-400">{t('ops.orders.today')}</p>
                <p className="text-2xl font-semibold text-white mt-1">{orderSummary.pickedToday}</p>
              </div>
            </div>
            <div className="bg-slate-900/40 rounded-2xl p-4 border border-slate-700">
              {ordersLoading ? (
                <p className="text-slate-400 text-sm">{t('ops.orders.loading')}</p>
              ) : openOrders.length === 0 ? (
                <p className="text-slate-400 text-sm">{t('ops.orders.none')}</p>
              ) : (
                <div className="space-y-3">
                  <ul className="space-y-3">
                    {visibleOrders.map((order) => (
                      <li key={order.id} className="bg-slate-900/60 border border-slate-700 rounded-xl p-3">
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
                            <span className="text-xs text-slate-400">{order.statusLabel}</span>
                            <button
                              type="button"
                              onClick={() => handleMarkOrderComplete(order.id)}
                              disabled={completingOrderId === order.id}
                              className="px-3 py-2 rounded-full bg-emerald-600 text-white text-sm font-semibold disabled:opacity-50"
                            >
                              {completingOrderId === order.id ? 'Aktualisiere …' : t('ops.orders.complete')}
                            </button>
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

      <header className="bg-slate-800 rounded-2xl p-5 border border-slate-700 shadow-lg">
        <h1 className="text-2xl font-semibold text-white mb-4">{t('ops.title')}</h1>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {WORKFLOW_CARDS.map((card) => {
            const active = workflow === card.mode;
            return (
              <button
                key={card.mode}
                type="button"
                onClick={() => setWorkflow(card.mode)}
                className={`flex items-center gap-4 rounded-2xl border px-4 py-3 text-left transition ${
                  active ? 'border-sky-500 bg-sky-500/20 text-white shadow-lg shadow-sky-900/30' : 'border-slate-700 bg-slate-900/40 text-slate-300 hover:border-slate-500'
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
            className="rounded-full border border-slate-600 px-4 py-2 text-sm text-slate-100 hover:border-slate-400"
          >
            {t('ops.mode.identify')}
          </button>
          <button
            type="button"
            onClick={() => setWorkflow('stow')}
            className={`rounded-full px-4 py-2 text-sm ${workflow === 'stow' ? 'bg-emerald-600 text-white' : 'border border-slate-600 text-slate-100 hover:border-slate-400'}`}
          >
            {t('ops.mode.stow')}
          </button>
          <button
            type="button"
            onClick={() => setWorkflow('pick')}
            className={`rounded-full px-4 py-2 text-sm ${workflow === 'pick' ? 'bg-amber-600 text-white' : 'border border-slate-600 text-slate-100 hover:border-slate-400'}`}
          >
            {t('ops.mode.pick')}
          </button>
        </div>
      </header>

      <div className="bg-slate-800 rounded-2xl p-5 border border-slate-700 shadow-lg space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm uppercase tracking-widest text-slate-400">{t('ops.labels.activeWorkflow')}</p>
            <h2 className="text-xl font-semibold text-white">{workflow === 'stow' ? t('ops.mode.stow') : t('ops.mode.pick')}</h2>
          </div>
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-full border border-slate-600 px-4 py-2 text-sm text-slate-200 hover:border-slate-400"
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
            className="grid grid-cols-1 md:grid-cols-3 gap-4"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleStow(false);
              }
            }}
          >
            <div className="space-y-2">
              <label className="text-xs text-slate-400 uppercase tracking-wide">{t('ops.stow.product')}</label>
              <div className="flex gap-2">
                <input
                  value={stowSku}
                  ref={stowSkuRef}
                  onChange={(e) => setStowSku(e.target.value)}
                  className="flex-1 bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-sm text-white"
                  placeholder={t('ops.stow.product')}
                />
                <button type="button" onClick={() => setScannerTarget('stowSku')} className="px-3 py-2 rounded-xl bg-slate-700 text-sm text-white">
                  {t('ops.actions.scan')}
                </button>
              </div>
              {matchedStowProduct ? (
                <div className="text-xs text-slate-300">
                  {matchedStowProduct.identification?.name}
                  {matchedStowProduct.storage?.binCode && (
                    <span className="block text-emerald-300">
                      {t('ops.labels.currentBin', { code: matchedStowProduct.storage.binCode })}
                    </span>
                  )}
                </div>
              ) : (
                stowSku && <div className="text-xs text-rose-300">{t('ops.labels.noProductFound')}</div>
              )}
            </div>

            <div className="space-y-2">
              <label className="text-xs text-slate-400 uppercase tracking-wide">{t('ops.stow.bin')}</label>
              <div className="flex gap-2">
                <input
                  value={stowBin}
                  ref={stowBinRef}
                  onChange={(e) => setStowBin(e.target.value.toUpperCase())}
                  className="flex-1 bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-sm text-white uppercase"
                  placeholder="XGA0101A"
                />
                <button type="button" onClick={() => setScannerTarget('stowBin')} className="px-3 py-2 rounded-xl bg-slate-700 text-sm text-white">
                  {t('ops.actions.scan')}
                </button>
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-xs text-slate-400 uppercase tracking-wide">{t('ops.stow.quantity')}</label>
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
                className="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-sm text-white"
              />
            </div>

            <div className="md:col-span-3 flex flex-wrap gap-3 mt-2">
              <button
                type="button"
                onClick={() => handleStow(false)}
                disabled={isSubmitting || !stowSku || !stowBin || !stowQuantity}
                className="px-4 py-2 rounded-xl bg-sky-600 text-white disabled:opacity-50"
              >
                {t('ops.stow.submit')}
              </button>
              <button
                type="button"
                onClick={() => handleStow(true)}
                disabled={isSubmitting || !stowSku || !stowBin || !stowQuantity}
                className="px-4 py-2 rounded-xl bg-slate-700 text-white disabled:opacity-50"
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
                        src={buildImageProxyUrl(nextPickTask.image)}
                        alt={nextPickTask.itemName}
                        className="h-16 w-16 rounded-lg border border-slate-700 object-cover"
                        loading="lazy"
                      />
                      <div className="text-xs text-slate-300">
                        <p>Visuelle Referenz</p>
                        <p className="text-[11px] text-slate-500">Nutze zur Identifikation im Bin</p>
                      </div>
                    </div>
                  )}
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-3 text-sm">
                    <div className="rounded-xl border border-slate-700 bg-slate-900/70 px-3 py-2">
                      <p className="text-[10px] uppercase tracking-wide text-slate-400">1 · Bin</p>
                      <p className="text-xl font-semibold text-amber-300">{nextPickTask.binCode}</p>
                    </div>
                    <div className="rounded-xl border border-slate-700 bg-slate-900/70 px-3 py-2">
                      <p className="text-[10px] uppercase tracking-wide text-slate-400">2 · SKU</p>
                      <p className="text-base font-semibold text-white break-all">{nextPickTask.sku || '—'}</p>
                    </div>
                    <div className="rounded-xl border border-slate-700 bg-slate-900/70 px-3 py-2">
                      <p className="text-[10px] uppercase tracking-wide text-slate-400">Menge</p>
                      <p className="text-xl font-semibold text-white">{nextPickTask.quantity}</p>
                      {typeof nextPickTask.available === 'number' && (
                        <p className="text-[11px] text-slate-400">Bestand: {nextPickTask.available}</p>
                      )}
                    </div>
                  </div>
                  <p className="text-[12px] text-slate-400">
                    {t('ops.labels.pickInstructions', {
                      bin: nextPickTask.binCode,
                      sku: nextPickTask.sku || '—',
                    })}
                  </p>
                  <div className="flex flex-wrap gap-2 text-sm">
                    <button
                      type="button"
                      onClick={() => loadBinDetail(nextPickTask.binCode)}
                      className="rounded-full border border-slate-600 px-3 py-1.5 text-slate-100 hover:border-slate-400"
                    >
                      {t('ops.actions.reloadBin')}
                    </button>
                    <button
                      type="button"
                      onClick={() => markPickTaskCompleted(nextPickTask.itemId)}
                      className="rounded-full border border-slate-600 px-3 py-1.5 text-slate-100 hover:border-slate-400"
                    >
                      {t('ops.actions.skipOrder')}
                    </button>
                    {completedPickItemIds.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setCompletedPickItemIds([])}
                        className="rounded-full border border-slate-600 px-3 py-1.5 text-slate-100 hover:border-slate-400"
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
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="text-xs text-slate-400 uppercase tracking-wide">{t('ops.pick.bin')}</label>
                <div className="flex gap-2">
                  <input
                    value={pickBin}
                    ref={pickBinRef}
                    onChange={(e) => setPickBin(e.target.value.toUpperCase())}
                    className="flex-1 bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-sm text-white uppercase"
                    placeholder="XGA0101A"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      if (pickBin) {
                        loadBinDetail(pickBin.toUpperCase());
                      }
                    }}
                    className="px-3 py-2 rounded-xl bg-slate-700 text-sm text-white"
                  >
                    {t('ops.actions.reloadBin')}
                  </button>
                  <button type="button" onClick={() => setScannerTarget('pickBin')} className="px-3 py-2 rounded-xl bg-slate-700 text-sm text-white">
                    {t('ops.actions.scan')}
                  </button>
                </div>
                {isLoadingBin && <p className="text-xs text-slate-400 mt-1">{t('ops.labels.loadingBin')}</p>}
              </div>
              <div>
                <label className="text-xs text-slate-400 uppercase tracking-wide">{t('ops.pick.product')}</label>
                <div className="flex gap-2">
                  <input
                    value={pickSku}
                    ref={pickSkuRef}
                    onChange={(e) => setPickSku(e.target.value)}
                    className="flex-1 bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-sm text-white"
                    placeholder={t('ops.pick.product')}
                  />
                <button type="button" onClick={() => setScannerTarget('pickSku')} className="px-3 py-2 rounded-xl bg-slate-700 text-sm text-white">
                  {t('ops.actions.scan')}
                  </button>
                </div>
              </div>
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
                className="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-sm text-white"
              />
              </div>
            </div>

            {pickBinDetail && (
              <div className="bg-slate-900 rounded-xl p-4 border border-slate-700">
                <h4 className="text-white font-semibold mb-2">BIN {pickBinDetail.code}</h4>
                {pickBinDetail.products?.length ? (
                  <ul className="space-y-2 max-h-52 overflow-y-auto text-sm">
                    {pickBinDetail.products.map((item) => (
                      <li
                        key={item.productId}
                        className={`flex items-center justify-between px-3 py-2 rounded ${
                          pickSku && item.sku?.toLowerCase() === pickSku.toLowerCase() ? 'bg-sky-600/30' : 'bg-slate-800'
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
                            src={buildImageProxyUrl(item.image)}
                            alt={item.name}
                            className="w-12 h-12 object-cover rounded border border-slate-700"
                          />
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-slate-400 text-sm">Bin ist leer.</p>
                )}
              </div>
            )}

            <button
              type="button"
              onClick={handlePick}
              disabled={isSubmitting || !pickBin || !pickSku || !pickQuantity}
              className="px-4 py-2 rounded-xl bg-emerald-600 text-white disabled:opacity-50"
            >
              {t('ops.pick.submit')}
            </button>
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

      <div className="bg-slate-800 rounded-2xl p-5 border border-slate-700 shadow-lg space-y-3">
        <h3 className="text-lg font-semibold text-white">Stationärer Scanner (SANE)</h3>
        <p className="text-sm text-slate-400">
          Verbundene Scanner werden über <code className="font-mono">scanimage</code> aus dem SANE-Projekt angesteuert. Der Server muss Zugriff auf das Gerät haben.
        </p>
        <button
          type="button"
          onClick={handleTriggerScan}
          disabled={isScanningDoc}
          className="px-4 py-2 rounded-xl bg-emerald-600 text-white disabled:opacity-40"
        >
          {isScanningDoc ? 'Scanner läuft …' : 'Dokument scannen'}
        </button>
        {scanError && <p className="text-sm text-rose-300">{scanError}</p>}
        {scanResult && (
          <div className="space-y-2">
            <p className="text-xs text-slate-400">Erfasst am {new Date(scanResult.capturedAt).toLocaleString('de-DE')}</p>
            <img
              src={`data:${scanResult.mimeType};base64,${scanResult.base64}`}
              alt="Scanvorschau"
              className="w-full max-w-md rounded-lg border border-slate-600"
            />
            <a
              href={`data:${scanResult.mimeType};base64,${scanResult.base64}`}
              download={`scan-${scanResult.capturedAt}.png`}
              className="inline-flex items-center px-3 py-1.5 text-sm rounded-lg bg-slate-700 text-white"
            >
              Download
            </a>
          </div>
        )}
      </div>
    </section>
  );
};

export default OperationsView;

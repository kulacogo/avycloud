import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BrowserMultiFormatReader } from '@zxing/browser';
import { Product, WarehouseBin, Order, View } from '../types';
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
  onSwitchView?: (view: View) => void;
}

type WorkflowMode = 'stow' | 'pick';
type ScannerTarget = 'stowSku' | 'stowBin' | 'pickBin' | 'pickSku';

// Fenster, in dem eine identische Einlagerung als Doppel-Absenden gilt und
// verworfen wird. Enter und der Wagenrueclauf eines Handscanners koennen kurz
// hintereinander feuern, teils erst nachdem die laufende Buchung fertig ist —
// dann greift die In-Flight-Sperre nicht mehr. Eine ECHTE Wiederholung derselben
// Buchung braucht eine neue Mengeneingabe und liegt jenseits dieses Fensters.
const DUPLICATE_STOW_WINDOW_MS = 2500;

/**
 * Kennung EINER Einlager-Absicht. Der Server nutzt sie als Idempotenz-Schluessel:
 * dieselbe Id zweimal = Wiederholung (wird verworfen), neue Id = neue Buchung.
 * Bewusst pro Absicht neu erzeugt — NICHT pro Wiederholversuch, sonst wuerde ein
 * echter Netz-Retry als neue Buchung durchgehen.
 */
const neueStowRequestId = (): string =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? `stow:${crypto.randomUUID()}`
    : `stow:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

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
      icon: <WarehouseIcon className="w-8 h-8" aria-hidden="true" />,
    },
    {
      mode: 'pick',
      titleKey: 'ops.mode.pick',
      subtitleKey: 'ops.mode.pick.subtitle',
      icon: <SyncIcon className="w-8 h-8" aria-hidden="true" />,
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
  // Doppel-Absenden-Sperre fuer Einlagern. Ein Ref und nicht `isSubmitting`:
  // Enter bzw. der Wagenrueclauf eines Handscanners kann mehrfach im selben Tick
  // feuern, in dem ein State-Update noch nicht sichtbar ist — beide Laeufe kaemen
  // durch. `isSubmitting` bleibt fuer die UI (Button deaktivieren) zustaendig.
  const stowSubmitInFlightRef = useRef(false);
  // Kennung der AKTUELLEN Einlager-Absicht. Sie wird einmal erzeugt und erst nach einer
  // ERFOLGREICHEN Buchung verworfen. Damit gilt:
  //  - Doppelfeuer (Scanner/Enter/setTimeout) sendet dieselbe Kennung -> Server erkennt
  //    die Wiederholung exakt und bucht nur einmal.
  //  - Ein zweiter, echter Karton kommt nach einem Erfolg -> neue Kennung -> wird gebucht.
  //  - Ein fehlgeschlagener Versuch behaelt die Kennung -> Wiederholung bleibt idempotent.
  const stowRequestIdRef = useRef<string | null>(null);

  // Letzte ERFOLGREICHE Einlagerung, um ein verspaetetes Doppellesen zu erkennen,
  // das erst nach dem Freigeben der In-Flight-Sperre eintrifft.
  const lastStowSubmitRef = useRef<{ signature: string; at: number } | null>(null);
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
        return <span className={`${base} bg-success-dim text-success`}>{t('ops.pick.steps.ok')}</span>;
      }
      if (status === 'mismatch') {
        return <span className={`${base} bg-danger-dim text-danger`}>{t('ops.pick.steps.mismatch')}</span>;
      }
      return <span className={`${base} bg-app-elevated text-txt-secondary`}>{t('ops.pick.steps.pending')}</span>;
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
        const bestBin = allocatedBin || (fallbackHintBin ? { code: fallbackHintBin, quantity: Number(hint?.quantityAvailable || 0) || 0 } : null);

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
    const quantity = typeof stowQuantity === 'number' ? stowQuantity : Number(stowQuantity) || 0;
    if (!Number.isFinite(quantity) || quantity <= 0) {
      setErrorMessage(t('ops.errors.stowValidation'));
      return;
    }

    // Sperre 1 — In-Flight. Deckt den Enter-/Scanner-Pfad ab, der `handleStow`
    // bisher ohne jede Pruefung aufrief.
    if (stowSubmitInFlightRef.current) return;

    // Sperre 2 — identische Buchung im Kurzfenster. Faengt das Doppellesen, das
    // erst NACH dem Freigeben von Sperre 1 eintrifft. Eine echte Wiederholung
    // derselben Buchung liegt weit jenseits dieses Fensters.
    const signature = `${(matchedStowProduct?.id || '').trim()}::${stowSku.trim().toUpperCase()}::${stowBin
      .trim()
      .toUpperCase()}::${quantity}`;
    const last = lastStowSubmitRef.current;
    if (last && last.signature === signature && Date.now() - last.at < DUPLICATE_STOW_WINDOW_MS) {
      return;
    }

    stowSubmitInFlightRef.current = true;
    if (!stowRequestIdRef.current) stowRequestIdRef.current = neueStowRequestId();
    try {
      setIsSubmitting(true);
      setErrorMessage(null);
      const payload = {
        sku: stowSku || undefined,
        productId: matchedStowProduct?.id,
        binCode: stowBin.toUpperCase(),
        quantity,
        meta: {
          flow: 'stow',
          ...(matchedStowProduct?.ops?.sourceLot ? { lotCode: matchedStowProduct.ops.sourceLot } : {}),
        },
        // Eine Kennung pro Einlager-Absicht. Damit erkennt der Server eine echte
        // Doppel-Absendung exakt und muss nicht auf das unscharfe Zeitfenster
        // zurueckfallen. Wichtig fuer den Fall "zweiter gleicher Karton in denselben
        // Platz" — der wuerde sonst still verworfen und die Ware fehlte im System.
        requestId: stowRequestIdRef.current,
      };
      const result = await stockInProduct(payload);
      if (!result.ok || !result.data) {
        throw new Error(result.error?.message || t('ops.errors.stow'));
      }
      if (result.deduped) {
        // Der Server hat NICHTS gebucht. Nicht als Erfolg melden, sonst fehlt die Ware
        // im Bestand und niemand merkt es.
        throw new Error('Doppel-Absendung erkannt — es wurde NICHTS gebucht. Bestand prüfen.');
      }
      lastStowSubmitRef.current = { signature, at: Date.now() };
      stowRequestIdRef.current = null; // Absicht erledigt — der naechste Karton bekommt eine neue Kennung.
      if (result.data.product) onProductUpdate(result.data.product);
      onStockChanged?.(result.data.bin);
      setStatusMessage(
        t('ops.status.stowSuccess', {
          name: result.data.product.identification?.name || stowSku,
        })
      );
      // Menge LEEREN, nicht auf 1 setzen. Mit 1 blieben beide Buttons aktiv und
      // ein versehentliches Enter haette denselben Artikel erneut gebucht. Leer
      // heisst: die Pflichtfeld-Pruefung oben greift, es wird nichts gebucht.
      // Die Unterscheidung "Einlagern" vs. "Einlagern & Neuer Scan" bleibt
      // dadurch unveraendert — nur Letzteres leert SKU und Lagerplatz.
      setStowQuantity('');
      if (resetAfter) {
        setStowSku('');
        setStowBin('');
        setScannerTarget('stowSku');
      }
    } catch (error: any) {
      setErrorMessage(error?.message || t('ops.errors.stow'));
    } finally {
      stowSubmitInFlightRef.current = false;
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
      <div className="bg-app-surface rounded-2xl p-5 border border-app-border space-y-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-sm uppercase tracking-widest text-txt-muted">Aufträge</p>
            <h2 className="text-xl font-semibold text-txt-primary">{t('ops.orders.section')}</h2>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <label className="flex items-center gap-2 text-sm text-txt-secondary cursor-pointer">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-app-border bg-app-bg text-accent focus:ring-accent"
                checked={autoOrderSync}
                onChange={handleAutoSyncToggle}
                aria-label={t('ops.orders.auto')}
              />
              {t('ops.orders.auto')}
            </label>
            <button
              type="button"
              onClick={() => handleSyncOrders(true)}
              disabled={isSyncingOrders}
              aria-label={isSyncingOrders ? t('ops.orders.syncing') : t('ops.orders.sync')}
              className="inline-flex items-center gap-2 rounded-full bg-accent px-4 py-2 text-sm font-semibold text-txt-primary disabled:opacity-50"
            >
              {isSyncingOrders ? t('ops.orders.syncing') : t('ops.orders.sync')}
            </button>
            {isMobile && (
              <button
                type="button"
                onClick={() => setShowOrdersPanel((prev) => !prev)}
                aria-label={showOrdersPanel ? t('ops.orders.hide') : t('ops.orders.show')}
                aria-expanded={showOrdersPanel}
                className="inline-flex items-center rounded-full border border-app-border px-3 py-2 text-sm text-txt-primary hover:border-app-border"
              >
                {showOrdersPanel ? t('ops.orders.hide') : t('ops.orders.show')}
              </button>
            )}
          </div>
        </div>
        {orderStatusMessage && <div role="status" aria-live="polite" className="text-sm text-success bg-success-dim px-3 py-2 rounded">{orderStatusMessage}</div>}
        {(ordersError || orderErrorMessage) && (
          <div role="alert" className="text-sm text-danger bg-danger-dim px-3 py-2 rounded">{ordersError || orderErrorMessage}</div>
        )}
        {showOrdersPanel && (
          <>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="bg-app-bg/40 rounded-xl p-4 border border-app-border">
                <p className="text-xs uppercase tracking-widest text-txt-muted">{t('ops.orders.open')}</p>
                <p className="text-2xl font-semibold text-txt-primary mt-1">{orderSummary.open}</p>
              </div>
              <div className="bg-app-bg/40 rounded-xl p-4 border border-app-border">
                <p className="text-xs uppercase tracking-widest text-txt-muted">{t('ops.orders.total')}</p>
                <p className="text-2xl font-semibold text-txt-primary mt-1">{orderSummary.total}</p>
              </div>
              <div className="bg-app-bg/40 rounded-xl p-4 border border-app-border">
                <p className="text-xs uppercase tracking-widest text-txt-muted">{t('ops.orders.today')}</p>
                <p className="text-2xl font-semibold text-txt-primary mt-1">{orderSummary.pickedToday}</p>
              </div>
            </div>
            <div className="bg-app-bg/40 rounded-2xl p-4 border border-app-border">
              {ordersLoading ? (
                <p role="status" aria-live="polite" className="text-txt-muted text-sm">{t('ops.orders.loading')}</p>
              ) : openOrders.length === 0 ? (
                <p className="text-txt-muted text-sm">{t('ops.orders.none')}</p>
              ) : (
                <div className="space-y-3">
                  <ul className="space-y-3">
                    {visibleOrders.map((order) => (
                      <li key={order.id} className="bg-app-bg/60 border border-app-border rounded-xl p-3">
                        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                          <div>
                            <p className="text-sm font-semibold text-txt-primary">
                              {order.customer?.name || t('ops.labels.unknownCustomer')}
                            </p>
                            <p className="text-xs text-txt-muted">
                              {order.items.length} Positionen · {formatOrderDate(order.createdAt)}
                            </p>
                            {typeof order.totalAmount === 'number' && (
                              <p className="text-xs text-txt-muted">
                                {order.currency || 'EUR'} {order.totalAmount.toFixed(2)}
                              </p>
                            )}
                            <div className="mt-2 text-xs text-txt-secondary space-y-1">
                              {order.items.slice(0, 3).map((item) => (
                                <p key={item.id}>
                                  {item.quantity}× {item.name}
                                </p>
                              ))}
                              {order.items.length > 3 && (
                                <p className="text-txt-muted">
                                  {t('ops.labels.additionalItems', { count: order.items.length - 3 })}
                                </p>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <span
                              className={`text-xs font-semibold ${order.status === 'picked' ? 'text-success' : 'text-txt-muted'
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
                        aria-label={showAllOpenOrders ? t('ops.orders.less') : `${t('ops.orders.more')} (${openOrders.length})`}
                        aria-expanded={showAllOpenOrders}
                        className="text-sm text-accent hover:text-accent underline-offset-4 underline"
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

      <header className="bg-app-surface rounded-2xl p-5 border border-app-border">
        <h1 className="text-2xl font-semibold text-txt-primary mb-4">{t('ops.title')}</h1>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {WORKFLOW_CARDS.map((card) => {
            const active = workflow === card.mode;
            return (
              <button
                key={card.mode}
                type="button"
                onClick={() => setWorkflow(card.mode)}
                aria-label={t(card.titleKey)}
                aria-pressed={active}
                className={`flex items-center gap-4 rounded-2xl border px-4 py-3 text-left transition ${active ? 'border-accent bg-accent-dim text-txt-primary shadow-lg shadow-sky-900/30' : 'border-app-border bg-app-bg/40 text-txt-secondary hover:border-app-border'
                  }`}
              >
                <span className={`p-3 rounded-2xl ${active ? 'bg-accent/30 text-txt-primary' : 'bg-app-elevated text-txt-secondary'}`}>{card.icon}</span>
                <div>
                  <p className="font-semibold">{t(card.titleKey)}</p>
                  <p className="text-xs text-txt-muted">{t(card.subtitleKey)}</p>
                </div>
              </button>
            );
          })}
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => onSwitchView?.('input')}
            aria-label={t('ops.mode.identify')}
            className="rounded-full border border-app-border px-4 py-2 text-sm text-txt-primary hover:border-app-border"
          >
            {t('ops.mode.identify')}
          </button>
          <button
            type="button"
            onClick={() => setWorkflow('stow')}
            aria-label={t('ops.mode.stow')}
            aria-pressed={workflow === 'stow'}
            className={`rounded-full px-4 py-2 text-sm ${workflow === 'stow' ? 'bg-success text-txt-primary' : 'border border-app-border text-txt-primary hover:border-app-border'}`}
          >
            {t('ops.mode.stow')}
          </button>
          <button
            type="button"
            onClick={() => setWorkflow('pick')}
            aria-label={t('ops.mode.pick')}
            aria-pressed={workflow === 'pick'}
            className={`rounded-full px-4 py-2 text-sm ${workflow === 'pick' ? 'bg-amber-600 text-txt-primary' : 'border border-app-border text-txt-primary hover:border-app-border'}`}
          >
            {t('ops.mode.pick')}
          </button>
        </div>
      </header>

      <div className="bg-app-surface rounded-2xl p-5 border border-app-border space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm uppercase tracking-widest text-txt-muted">{t('ops.labels.activeWorkflow')}</p>
            <h2 className="text-xl font-semibold text-txt-primary">{workflow === 'stow' ? t('ops.mode.stow') : t('ops.mode.pick')}</h2>
          </div>
          <button
            type="button"
            aria-label={workflow === 'stow' ? t('ops.actions.scan.product') : t('ops.actions.scan.bin')}
            className="inline-flex items-center gap-2 rounded-full border border-app-border px-4 py-2 text-sm text-txt-secondary hover:border-app-border"
            onClick={() => setScannerTarget(workflow === 'stow' ? 'stowSku' : 'pickBin')}
          >
            <CameraIcon className="w-4 h-4" aria-hidden="true" />
            {workflow === 'stow' ? t('ops.actions.scan.product') : t('ops.actions.scan.bin')}
          </button>
        </div>

        {statusMessage && <div role="status" aria-live="polite" className="text-sm text-success bg-success-dim px-3 py-2 rounded">{statusMessage}</div>}
        {errorMessage && <div role="alert" className="text-sm text-danger bg-danger-dim px-3 py-2 rounded">{errorMessage}</div>}

        {workflow === 'stow' ? (
          <div
            className="flex flex-col gap-5"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                // Enter kommt auch als Wagenrueclauf vom Handscanner, teils
                // mehrfach. `isSubmitting` ist der sichtbare Zustand, der Ref in
                // `handleStow` die eigentliche Sperre — hier beides pruefen, damit
                // wir gar nicht erst in den Aufruf laufen.
                if (isSubmitting || stowSubmitInFlightRef.current) return;
                void handleStow(false);
              }
            }}
          >
            {/* Produkt */}
            <div className="bg-app-bg/50 p-4 rounded-xl border border-app-border">
              <label className="text-xs text-txt-muted uppercase tracking-wide block mb-2">{t('ops.stow.product')}</label>
              <div className="flex gap-3">
                <input
                  value={stowSku}
                  ref={stowSkuRef}
                  onChange={(e) => setStowSku(e.target.value)}
                  className="flex-1 bg-app-bg border border-app-border rounded-xl px-4 py-3 text-base text-txt-primary focus:ring-2 focus:ring-accent outline-none"
                  placeholder={t('ops.stow.product')}
                />
                <button
                  type="button"
                  onClick={() => setScannerTarget('stowSku')}
                  aria-label="Produkt-Barcode scannen"
                  className="px-4 py-3 rounded-xl bg-app-elevated text-txt-primary hover:bg-app-border active:scale-95 transition-transform"
                >
                  <CameraIcon className="w-6 h-6" aria-hidden="true" />
                </button>
              </div>
              {matchedStowProduct ? (
                <div className="mt-3 bg-app-elevated/50 p-3 rounded-lg border border-app-border">
                  <p className="text-sm font-medium text-txt-primary">{matchedStowProduct.identification?.name}</p>
                  {matchedStowProduct.storage?.binCode && (
                    <p className="text-xs text-success mt-1">
                      {t('ops.labels.currentBin', { code: matchedStowProduct.storage.binCode })}
                    </p>
                  )}
                </div>
              ) : (
                stowSku && <div className="mt-2 text-sm text-danger">{t('ops.labels.noProductFound')}</div>
              )}
            </div>

            {/* Bin & Menge */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="bg-app-bg/50 p-4 rounded-xl border border-app-border">
                <label className="text-xs text-txt-muted uppercase tracking-wide block mb-2">{t('ops.stow.bin')}</label>
                <div className="flex gap-3">
                  <input
                    value={stowBin}
                    ref={stowBinRef}
                    onChange={(e) => setStowBin(e.target.value.toUpperCase())}
                    className="flex-1 bg-app-bg border border-app-border rounded-xl px-4 py-3 text-base text-txt-primary uppercase font-mono focus:ring-2 focus:ring-accent outline-none"
                    placeholder="BIN..."
                  />
                  <button
                    type="button"
                    onClick={() => setScannerTarget('stowBin')}
                    aria-label="Lagerplatz-Barcode scannen"
                    className="px-4 py-3 rounded-xl bg-app-elevated text-txt-primary hover:bg-app-border active:scale-95 transition-transform"
                  >
                    <CameraIcon className="w-6 h-6" aria-hidden="true" />
                  </button>
                </div>
              </div>

              <div className="bg-app-bg/50 p-4 rounded-xl border border-app-border">
                <label className="text-xs text-txt-muted uppercase tracking-wide block mb-2">{t('ops.stow.quantity')}</label>
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
                  className="w-full bg-app-bg border border-app-border rounded-xl px-4 py-3 text-base text-txt-primary font-mono focus:ring-2 focus:ring-accent outline-none"
                />
              </div>
            </div>

            {/* Actions */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
              <button
                type="button"
                onClick={() => handleStow(false)}
                disabled={isSubmitting || !stowSku || !stowBin || !stowQuantity}
                aria-label={t('ops.stow.submit')}
                className="w-full py-4 rounded-xl bg-accent-dim text-accent font-semibold hover:bg-accent/30 active:scale-[0.99] transition-all disabled:opacity-50 disabled:active:scale-100"
              >
                {t('ops.stow.submit')}
              </button>
              <button
                type="button"
                onClick={() => handleStow(true)}
                disabled={isSubmitting || !stowSku || !stowBin || !stowQuantity}
                aria-label={t('ops.stow.submit.next')}
                className="w-full py-4 rounded-xl bg-app-elevated text-txt-primary font-semibold border border-app-border hover:bg-app-border active:scale-95 transition-all disabled:opacity-50 disabled:active:scale-100"
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
                    <p className="text-lg font-semibold text-txt-primary">{nextPickTask.itemName}</p>
                    <p className="text-sm text-txt-secondary">
                      Auftrag {nextPickTask.orderNumber || nextPickTask.orderId} ·{' '}
                      {nextPickTask.customer || t('ops.labels.unknownCustomer')}
                    </p>
                  </div>
                  {nextPickTask.image && (
                    <div className="flex items-center gap-3 rounded-xl border border-app-border bg-app-bg/70 p-3">
                      <img
                        src={resolveImageSrc(nextPickTask.image)}
                        alt={nextPickTask.itemName}
                        className="h-16 w-16 rounded-lg border border-app-border object-cover"
                        loading="lazy"
                      />
                      <div className="text-xs text-txt-secondary">
                        <p>Visuelle Referenz</p>
                        <p className="text-[11px] text-txt-muted">Nutze zur Identifikation im Bin</p>
                      </div>
                    </div>
                  )}
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-3 text-sm">
                    <div className="rounded-xl border border-app-border bg-app-bg/70 px-3 py-2">
                      <p className="text-[10px] uppercase tracking-wide text-txt-muted">{t('ops.labels.stepBin')}</p>
                      <p className={`text-xl font-semibold ${nextPickTask.binCode ? 'text-amber-300' : 'text-danger'}`}>
                        {nextPickTask.binCode || 'Kein Platz'}
                      </p>
                    </div>
                    <div className="rounded-xl border border-app-border bg-app-bg/70 px-3 py-2">
                      <p className="text-[10px] uppercase tracking-wide text-txt-muted">{t('ops.labels.stepSku')}</p>
                      <p className="text-base font-semibold text-txt-primary break-all">{nextPickTask.sku || '—'}</p>
                    </div>
                    <div className="rounded-xl border border-app-border bg-app-bg/70 px-3 py-2">
                      <p className="text-[10px] uppercase tracking-wide text-txt-muted">{t('ops.labels.quantity')}</p>
                      <p className="text-xl font-semibold text-txt-primary">{nextPickTask.quantity}</p>
                      {typeof nextPickTask.available === 'number' && (
                        <p className="text-[11px] text-txt-muted">
                          {t('ops.labels.stock', { value: nextPickTask.available })}
                        </p>
                      )}
                    </div>
                  </div>
                  <p className="text-[12px] text-txt-muted">
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
                      aria-label={t('ops.actions.reloadBin')}
                      className="rounded-full border border-app-border px-3 py-1.5 text-txt-primary hover:border-app-border disabled:opacity-50"
                    >
                      {t('ops.actions.reloadBin')}
                    </button>
                    <button
                      type="button"
                      onClick={() => markPickTaskCompleted(nextPickTask.itemId)}
                      aria-label={t('ops.actions.skipOrder')}
                      className="rounded-full border border-app-border px-3 py-1.5 text-txt-primary hover:border-app-border"
                    >
                      {t('ops.actions.skipOrder')}
                    </button>
                    {skippedPickItemIds.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setSkippedPickItemIds([])}
                        aria-label={t('ops.actions.resetRoute')}
                        className="rounded-full border border-app-border px-3 py-1.5 text-txt-primary hover:border-app-border"
                      >
                        {t('ops.actions.resetRoute')}
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <div className="text-sm text-txt-secondary">{t('ops.labels.noPickTasks')}</div>
              )}
            </div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="rounded-2xl border border-app-border bg-app-bg/60 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-[10px] uppercase tracking-wide text-txt-muted">{t('ops.pick.steps.bin')}</p>
                    <p className={`text-xl font-semibold ${nextPickTask?.binCode ? 'text-txt-primary' : 'text-danger'}`}>
                      {nextPickTask?.binCode || 'Kein Platz'}
                    </p>
                  </div>
                  {renderScanStatusBadge(pickScanStatus.bin)}
                </div>
                <div className="mt-3 space-y-1 text-xs text-txt-muted">
                  <p>
                    {t('ops.pick.steps.expected')}: <span className="text-txt-secondary">{nextPickTask?.binCode || 'Beliebig'}</span>
                  </p>
                  <p>
                    {t('ops.pick.steps.scanned')}: <span className="text-txt-secondary">{pickBin || t('ops.pick.steps.pending')}</span>
                  </p>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setScannerTarget('pickBin')}
                    aria-label="BIN-Code scannen"
                    className="rounded-full border border-app-border px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-txt-secondary hover:border-app-border"
                  >
                    {t('ops.pick.steps.cta')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const code = pickBin || nextPickTask?.binCode || '';
                      loadBinDetail(code);
                    }}
                    aria-label={t('ops.actions.reloadBin')}
                    className="rounded-full border border-app-border px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-txt-secondary hover:border-app-border"
                  >
                    {t('ops.actions.reloadBin')}
                  </button>
                </div>
              </div>
              <div className="rounded-2xl border border-app-border bg-app-bg/60 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-[10px] uppercase tracking-wide text-txt-muted">{t('ops.pick.steps.sku')}</p>
                    <p className="text-base font-semibold text-txt-primary break-all">{nextPickTask?.sku || '—'}</p>
                  </div>
                  {renderScanStatusBadge(pickScanStatus.sku)}
                </div>
                <div className="mt-3 space-y-1 text-xs text-txt-muted">
                  <p>
                    {t('ops.pick.steps.expected')}: <span className="text-txt-secondary">{nextPickTask?.sku || '—'}</span>
                  </p>
                  <p>
                    {t('ops.pick.steps.scanned')}: <span className="text-txt-secondary">{pickSku || t('ops.pick.steps.pending')}</span>
                  </p>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setScannerTarget('pickSku')}
                    aria-label="SKU-Barcode scannen"
                    className="rounded-full border border-app-border px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-txt-secondary hover:border-app-border"
                  >
                    {t('ops.pick.steps.cta')}
                  </button>
                </div>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <label className="text-xs text-txt-muted uppercase tracking-wide">{t('ops.pick.quantity')}</label>
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
                  className="mt-1 w-full rounded-xl border border-app-border bg-app-bg px-3 py-2 text-sm text-txt-primary"
                />
                <p className="mt-1 text-xs text-txt-muted">
                  {t('ops.pick.quantityHint', { value: nextPickTask?.quantity || 1 })}
                </p>
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <button
                  type="button"
                  onClick={handleResetPickScans}
                  aria-label={t('ops.pick.reset')}
                  className="rounded-full border border-app-border px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-txt-secondary hover:border-app-border"
                >
                  {t('ops.pick.reset')}
                </button>
              </div>
            </div>

            {pickBinDetail && (
              <div className="rounded-xl border border-app-border bg-app-bg/60 p-4">
                <h4 className="text-txt-primary font-semibold mb-2">BIN {pickBinDetail.code}</h4>
                {pickBinDetail.products?.length ? (
                  <ul className="space-y-2 max-h-52 overflow-y-auto text-sm">
                    {pickBinDetail.products.map((item) => (
                      <li
                        key={item.productId}
                        className={`flex items-center justify-between px-3 py-2 rounded-lg ${pickSku && item.sku?.toLowerCase() === pickSku.toLowerCase() ? 'bg-accent/30' : 'bg-app-surface'
                          }`}
                      >
                        <div>
                          <p className="text-txt-primary">{item.name}</p>
                          <p className="text-xs text-txt-muted">
                            SKU {item.sku} · Menge {item.quantity}
                          </p>
                        </div>
                        {item.image && (
                          <img
                            src={resolveImageSrc(item.image)}
                            alt={item.name}
                            className="w-12 h-12 object-cover rounded border border-app-border"
                          />
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-txt-muted text-sm">{t('ops.labels.binEmpty')}</p>
                )}
              </div>
            )}

            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={handlePick}
                disabled={!pickConfirmReady || isSubmitting}
                aria-label={isSubmitting ? t('ops.pick.submitting') : t('ops.pick.submit')}
                className="rounded-full bg-success px-5 py-2 text-sm font-semibold text-txt-primary transition-colors hover:bg-success/80 disabled:cursor-not-allowed disabled:bg-app-border"
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
        aria-hidden="true"
        tabIndex={-1}
        className="hidden"
        onChange={handleFallbackFileChange}
      />

    </section>
  );
};

export default OperationsView;

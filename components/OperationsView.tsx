import React, { useEffect, useMemo, useRef, useState } from 'react';
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

interface OperationsViewProps {
  products: Product[];
  onProductUpdate: (product: Product) => void;
  onStockChanged?: (bin: WarehouseBin) => void;
}

type WorkflowMode = 'stow' | 'pick';
type ScannerTarget = 'stowSku' | 'stowBin' | 'pickBin' | 'pickSku';

const WORKFLOW_CARDS: Array<{
  mode: WorkflowMode;
  title: string;
  subtitle: string;
  icon: React.ReactNode;
}> = [
  {
    mode: 'stow',
    title: 'Einlagern (Stow)',
    subtitle: 'Produkte scannen und Lagerplatz zuweisen',
    icon: <WarehouseIcon className="w-8 h-8" />,
  },
  {
    mode: 'pick',
    title: 'Kommissionierung (Pick)',
    subtitle: 'Bin zuerst scannen, Menge entnehmen',
    icon: <SyncIcon className="w-8 h-8" />,
  },
];

export const OperationsView: React.FC<OperationsViewProps> = ({ products, onProductUpdate, onStockChanged }) => {
  const [workflow, setWorkflow] = useState<WorkflowMode>('stow');
  const [scannerTarget, setScannerTarget] = useState<ScannerTarget | null>(null);

  const [stowSku, setStowSku] = useState('');
  const [stowBin, setStowBin] = useState('');
  const [stowQuantity, setStowQuantity] = useState(1);

  const [pickBin, setPickBin] = useState('');
  const [pickSku, setPickSku] = useState('');
  const [pickQuantity, setPickQuantity] = useState(1);
  const [pickBinDetail, setPickBinDetail] = useState<WarehouseBin | null>(null);
  const [isLoadingBin, setIsLoadingBin] = useState(false);

  const [orders, setOrders] = useState<Order[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [ordersError, setOrdersError] = useState<string | null>(null);
  const [orderStatusMessage, setOrderStatusMessage] = useState<string | null>(null);
  const [orderErrorMessage, setOrderErrorMessage] = useState<string | null>(null);
  const [isSyncingOrders, setIsSyncingOrders] = useState(false);
  const [completingOrderId, setCompletingOrderId] = useState<string | null>(null);
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

  const openOrders = useMemo(() => orders.filter((order) => order.status !== 'picked'), [orders]);

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
        setStatusMessage('Code erkannt und übernommen.');
      } else {
        setErrorMessage('Kein gültiger Code erkannt. Bitte erneut versuchen.');
      }
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Fallback decode failed:', error);
      setErrorMessage('Der Code konnte nicht gelesen werden. Bitte erneut versuchen.');
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
        setScanError(result.error?.message || 'Scanner-Abruf fehlgeschlagen.');
        setScanResult(null);
      } else {
        setScanResult(result.data);
      }
    } catch (error: any) {
      setScanError(error?.message || 'Scanner-Abruf fehlgeschlagen.');
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
      setErrorMessage(error?.message || 'Bin konnte nicht geladen werden.');
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
        setOrderStatusMessage(`Aufträge aktualisiert (${data.length})`);
        window.setTimeout(() => setOrderStatusMessage(null), 4000);
      }
    } catch (error: any) {
      setOrderErrorMessage(error?.message || 'Auftragssync fehlgeschlagen.');
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
      setOrderStatusMessage('Auftrag als kommissioniert markiert.');
      window.setTimeout(() => setOrderStatusMessage(null), 4000);
    } catch (error: any) {
      setOrderErrorMessage(error?.message || 'Auftrag konnte nicht aktualisiert werden.');
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
          setOrdersError(error?.message || 'Aufträge konnten nicht geladen werden.');
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
      handleSyncOrders(false);
    }, 60000);
    autoSyncIntervalRef.current = id;
    return () => {
      window.clearInterval(id);
      autoSyncIntervalRef.current = null;
    };
  }, [autoOrderSync]);

  const handleStow = async (resetAfter = false) => {
    if (!stowBin || (!matchedStowProduct && !stowSku)) {
      setErrorMessage('Bitte SKU und BIN auswählen.');
      return;
    }
    try {
      setIsSubmitting(true);
      setErrorMessage(null);
      const payload = {
        sku: stowSku || undefined,
        productId: matchedStowProduct?.id,
        binCode: stowBin.toUpperCase(),
        quantity: stowQuantity,
      };
      const result = await stockInProduct(payload);
      if (!result.ok || !result.data) {
        throw new Error(result.error?.message || 'Einlagerung fehlgeschlagen.');
      }
      onProductUpdate(result.data.product);
      onStockChanged?.(result.data.bin);
      setStatusMessage(`Einlagerung erfolgreich: ${result.data.product.identification?.name || stowSku}`);
      setStowQuantity(1);
      if (resetAfter) {
        setStowSku('');
        setStowBin('');
      }
    } catch (error: any) {
      setErrorMessage(error?.message || 'Einlagerung fehlgeschlagen.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handlePick = async () => {
    if (!pickBin || (!matchedPickProduct && !pickSku)) {
      setErrorMessage('Bitte Bin und Artikel auswählen.');
      return;
    }
    try {
      setIsSubmitting(true);
      setErrorMessage(null);
      const payload = {
        sku: pickSku || undefined,
        productId: matchedPickProduct?.id,
        binCode: pickBin.toUpperCase(),
        quantity: pickQuantity,
      };
      const result = await stockOutProduct(payload);
      if (!result.ok || !result.data) {
        throw new Error(result.error?.message || 'Kommissionierung fehlgeschlagen.');
      }
      onProductUpdate(result.data.product);
      onStockChanged?.(result.data.bin);
      setStatusMessage(`Kommissionierung erfolgreich: ${result.data.product.identification?.name || pickSku}`);
      setPickQuantity(1);
      loadBinDetail(pickBin.toUpperCase());
    } catch (error: any) {
      setErrorMessage(error?.message || 'Kommissionierung fehlgeschlagen.');
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
            <h2 className="text-xl font-semibold text-white">Neue Aufträge</h2>
            <p className="text-sm text-slate-400">Synchronisiere offene Bestellungen für die Kommissionierung.</p>
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-slate-500 bg-slate-900 text-sky-500 focus:ring-sky-500"
                checked={autoOrderSync}
                onChange={handleAutoSyncToggle}
              />
              Auto
            </label>
            <button
              type="button"
              onClick={() => handleSyncOrders(true)}
              disabled={isSyncingOrders}
              className="inline-flex items-center gap-2 rounded-full bg-sky-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {isSyncingOrders ? 'Sync läuft …' : 'Aufträge synchronisieren'}
            </button>
          </div>
        </div>
        {orderStatusMessage && <div className="text-sm text-emerald-300 bg-emerald-900/30 px-3 py-2 rounded">{orderStatusMessage}</div>}
        {(ordersError || orderErrorMessage) && (
          <div className="text-sm text-rose-300 bg-rose-900/30 px-3 py-2 rounded">{ordersError || orderErrorMessage}</div>
        )}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="bg-slate-900/40 rounded-xl p-4 border border-slate-700">
            <p className="text-xs uppercase tracking-widest text-slate-400">Offene Aufträge</p>
            <p className="text-2xl font-semibold text-white mt-1">{orderSummary.open}</p>
          </div>
          <div className="bg-slate-900/40 rounded-xl p-4 border border-slate-700">
            <p className="text-xs uppercase tracking-widest text-slate-400">Gesamt</p>
            <p className="text-2xl font-semibold text-white mt-1">{orderSummary.total}</p>
          </div>
          <div className="bg-slate-900/40 rounded-xl p-4 border border-slate-700">
            <p className="text-xs uppercase tracking-widest text-slate-400">Heute kommissioniert</p>
            <p className="text-2xl font-semibold text-white mt-1">{orderSummary.pickedToday}</p>
          </div>
        </div>
        <div className="bg-slate-900/40 rounded-2xl p-4 border border-slate-700">
          {ordersLoading ? (
            <p className="text-slate-400 text-sm">Lade Aufträge …</p>
          ) : openOrders.length === 0 ? (
            <p className="text-slate-400 text-sm">Keine offenen Aufträge vorhanden.</p>
          ) : (
            <ul className="space-y-3">
              {openOrders.slice(0, 5).map((order) => (
                <li key={order.id} className="bg-slate-900/60 border border-slate-700 rounded-xl p-3">
                  <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                    <div>
                      <p className="text-sm font-semibold text-white">
                        {order.customer?.name || 'Unbekannter Kunde'}
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
                          <p className="text-slate-500">+ {order.items.length - 3} weitere Positionen</p>
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
                        {completingOrderId === order.id ? 'Aktualisiere …' : 'Kommissioniert'}
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <header className="bg-slate-800 rounded-2xl p-5 border border-slate-700 shadow-lg">
        <div className="flex items-center gap-3 mb-4">
          <div className="rounded-2xl bg-sky-900/40 p-3 text-sky-300">
            <WarehouseIcon className="w-7 h-7" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold text-white">Operationen</h1>
            <p className="text-sm text-slate-400">Arbeite konzentriert im Einlagerungs- oder Kommissionierungsprozess.</p>
          </div>
        </div>
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
                  <p className="font-semibold">{card.title}</p>
                  <p className="text-xs text-slate-400">{card.subtitle}</p>
                </div>
              </button>
            );
          })}
        </div>
      </header>

      <div className="bg-slate-800 rounded-2xl p-5 border border-slate-700 shadow-lg space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm uppercase tracking-widest text-slate-400">Aktiver Workflow</p>
            <h2 className="text-xl font-semibold text-white">{workflow === 'stow' ? 'Einlagern' : 'Kommissionierung'}</h2>
          </div>
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-full border border-slate-600 px-4 py-2 text-sm text-slate-200 hover:border-slate-400"
            onClick={() => setScannerTarget(workflow === 'stow' ? 'stowSku' : 'pickBin')}
          >
            <CameraIcon className="w-4 h-4" />
            {workflow === 'stow' ? 'Produkt scannen' : 'Bin scannen'}
          </button>
        </div>

        {statusMessage && <div className="text-sm text-emerald-300 bg-emerald-900/30 px-3 py-2 rounded">{statusMessage}</div>}
        {errorMessage && <div className="text-sm text-rose-300 bg-rose-900/30 px-3 py-2 rounded">{errorMessage}</div>}

        {workflow === 'stow' ? (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-2">
              <label className="text-xs text-slate-400 uppercase tracking-wide">Artikel / SKU</label>
              <div className="flex gap-2">
                <input
                  value={stowSku}
                  onChange={(e) => setStowSku(e.target.value)}
                  className="flex-1 bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-sm text-white"
                  placeholder="SKU oder Barcode scannen"
                />
                <button type="button" onClick={() => setScannerTarget('stowSku')} className="px-3 py-2 rounded-xl bg-slate-700 text-sm text-white">
                  Scan
                </button>
              </div>
              {matchedStowProduct ? (
                <div className="text-xs text-slate-300">
                  {matchedStowProduct.identification?.name}
                  {matchedStowProduct.storage?.binCode && (
                    <span className="block text-emerald-300">Aktuell in BIN {matchedStowProduct.storage.binCode}</span>
                  )}
                </div>
              ) : (
                stowSku && <div className="text-xs text-rose-300">Kein Produkt gefunden</div>
              )}
            </div>

            <div className="space-y-2">
              <label className="text-xs text-slate-400 uppercase tracking-wide">BIN-Code</label>
              <div className="flex gap-2">
                <input
                  value={stowBin}
                  onChange={(e) => setStowBin(e.target.value.toUpperCase())}
                  className="flex-1 bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-sm text-white uppercase"
                  placeholder="z.B. XGA0101A"
                />
                <button type="button" onClick={() => setScannerTarget('stowBin')} className="px-3 py-2 rounded-xl bg-slate-700 text-sm text-white">
                  Scan
                </button>
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-xs text-slate-400 uppercase tracking-wide">Menge</label>
              <input
                type="number"
                min={1}
                value={stowQuantity}
                onChange={(e) => setStowQuantity(Math.max(1, Number(e.target.value)))}
                className="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-sm text-white"
              />
            </div>

            <div className="md:col-span-3 flex flex-wrap gap-3 mt-2">
              <button
                type="button"
                onClick={() => handleStow(false)}
                disabled={isSubmitting || !stowSku || !stowBin}
                className="px-4 py-2 rounded-xl bg-sky-600 text-white disabled:opacity-50"
              >
                Einlagern
              </button>
              <button
                type="button"
                onClick={() => handleStow(true)}
                disabled={isSubmitting || !stowSku || !stowBin}
                className="px-4 py-2 rounded-xl bg-slate-700 text-white disabled:opacity-50"
              >
                Einlagern & Neuer Scan
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="text-xs text-slate-400 uppercase tracking-wide">BIN-Code</label>
                <div className="flex gap-2">
                  <input
                    value={pickBin}
                    onChange={(e) => setPickBin(e.target.value.toUpperCase())}
                    className="flex-1 bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-sm text-white uppercase"
                    placeholder="z.B. XGA0101A"
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
                    Laden
                  </button>
                  <button type="button" onClick={() => setScannerTarget('pickBin')} className="px-3 py-2 rounded-xl bg-slate-700 text-sm text-white">
                    Scan
                  </button>
                </div>
                {isLoadingBin && <p className="text-xs text-slate-400 mt-1">Lade Bin …</p>}
              </div>
              <div>
                <label className="text-xs text-slate-400 uppercase tracking-wide">Artikel / SKU</label>
                <div className="flex gap-2">
                  <input
                    value={pickSku}
                    onChange={(e) => setPickSku(e.target.value)}
                    className="flex-1 bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-sm text-white"
                    placeholder="SKU im Bin scannen"
                  />
                  <button type="button" onClick={() => setScannerTarget('pickSku')} className="px-3 py-2 rounded-xl bg-slate-700 text-sm text-white">
                    Scan
                  </button>
                </div>
              </div>
              <div>
                <label className="text-xs text-slate-400 uppercase tracking-wide">Menge</label>
                <input
                  type="number"
                  min={1}
                  value={pickQuantity}
                  onChange={(e) => setPickQuantity(Math.max(1, Number(e.target.value)))}
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
              disabled={isSubmitting || !pickBin || !pickSku}
              className="px-4 py-2 rounded-xl bg-emerald-600 text-white disabled:opacity-50"
            >
              Kommissionierung buchen
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


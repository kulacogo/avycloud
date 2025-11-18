import React, { useMemo, useState } from 'react';
import { Product, WarehouseBin } from '../types';
import { fetchWarehouseBinDetail, stockInProduct, stockOutProduct } from '../api/client';
import { buildImageProxyUrl } from '../api/client';
import { ScannerOverlay } from './ScannerOverlay';

interface StockWorkflowsProps {
  products: Product[];
  onProductUpdate: (product: Product) => void;
  onStockChanged: (binCode: string) => void;
}

type WorkflowTab = 'stow' | 'pick';
type ScannerTarget = 'stowSku' | 'stowBin' | 'pickBin' | 'pickSku';

export const StockWorkflows: React.FC<StockWorkflowsProps> = ({ products, onProductUpdate, onStockChanged }) => {
  const [activeTab, setActiveTab] = useState<WorkflowTab>('stow');
  const [scannerTarget, setScannerTarget] = useState<ScannerTarget | null>(null);

  const [stowSku, setStowSku] = useState('');
  const [stowBin, setStowBin] = useState('');
  const [stowQuantity, setStowQuantity] = useState(1);

  const [pickBin, setPickBin] = useState('');
  const [pickSku, setPickSku] = useState('');
  const [pickQuantity, setPickQuantity] = useState(1);
  const [pickBinDetail, setPickBinDetail] = useState<WarehouseBin | null>(null);
  const [isLoadingBin, setIsLoadingBin] = useState(false);

  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

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

  const handleStow = async (resetAfter = false) => {
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
      onStockChanged(result.data.bin.code);
      setStatusMessage(`Einlagerung erfolgreich: ${result.data.product.identification?.name || stowSku}`);
      if (resetAfter) {
        setStowSku('');
        setStowBin('');
        setStowQuantity(1);
      } else {
        setStowQuantity(1);
      }
    } catch (error: any) {
      setErrorMessage(error?.message || 'Einlagerung fehlgeschlagen.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handlePick = async () => {
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
      onStockChanged(result.data.bin.code);
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
    <section className="bg-slate-800 rounded-lg p-4 shadow space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-white text-xl font-semibold">Lager-Workflows</h3>
          <p className="text-slate-400 text-sm">Scanne Artikel und Bins für Einlagerung (Stow) oder Kommissionierung.</p>
        </div>
        <div className="inline-flex bg-slate-900 rounded-full p-1">
          {(['stow', 'pick'] as WorkflowTab[]).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-1.5 rounded-full text-sm font-semibold ${
                activeTab === tab ? 'bg-sky-600 text-white' : 'text-slate-400'
              }`}
            >
              {tab === 'stow' ? 'Stow' : 'Kommissionierung'}
            </button>
          ))}
        </div>
      </div>

      {statusMessage && <div className="text-sm text-emerald-300 bg-emerald-900/30 px-3 py-2 rounded">{statusMessage}</div>}
      {errorMessage && <div className="text-sm text-rose-300 bg-rose-900/30 px-3 py-2 rounded">{errorMessage}</div>}

      {activeTab === 'stow' ? (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="space-y-2">
            <label className="text-sm text-slate-400">Artikel / SKU</label>
            <div className="flex gap-2">
              <input
                value={stowSku}
                onChange={(e) => setStowSku(e.target.value)}
                className="flex-1 bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-white"
                placeholder="SKU oder Barcode scannen"
              />
              <button
                type="button"
                onClick={() => setScannerTarget('stowSku')}
                className="px-3 py-2 bg-slate-700 rounded text-white text-sm"
              >
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
            <label className="text-sm text-slate-400">BIN-Code</label>
            <div className="flex gap-2">
              <input
                value={stowBin}
                onChange={(e) => setStowBin(e.target.value.toUpperCase())}
                className="flex-1 bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-white uppercase"
                placeholder="z.B. XGA0101A"
              />
              <button type="button" onClick={() => setScannerTarget('stowBin')} className="px-3 py-2 bg-slate-700 rounded text-white text-sm">
                Scan
              </button>
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm text-slate-400">Menge</label>
            <input
              type="number"
              min={1}
              value={stowQuantity}
              onChange={(e) => setStowQuantity(Math.max(1, Number(e.target.value)))}
              className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-white"
            />
          </div>

          <div className="md:col-span-3 flex flex-wrap gap-3 mt-2">
            <button
              type="button"
              onClick={() => handleStow(false)}
              disabled={isSubmitting || !stowSku || !stowBin}
              className="px-4 py-2 rounded bg-sky-600 text-white disabled:opacity-50"
            >
              Einlagern
            </button>
            <button
              type="button"
              onClick={() => handleStow(true)}
              disabled={isSubmitting || !stowSku || !stowBin}
              className="px-4 py-2 rounded bg-slate-700 text-white disabled:opacity-50"
            >
              Einlagern & Neuer Scan
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="text-sm text-slate-400">BIN-Code</label>
              <div className="flex gap-2">
                <input
                  value={pickBin}
                  onChange={(e) => setPickBin(e.target.value.toUpperCase())}
                  className="flex-1 bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-white uppercase"
                  placeholder="z.B. XGA0101A"
                />
                <button
                  type="button"
                  onClick={() => {
                    if (pickBin) {
                      loadBinDetail(pickBin.toUpperCase());
                    }
                  }}
                  className="px-3 py-2 bg-slate-700 rounded text-white text-sm"
                >
                  Laden
                </button>
                <button type="button" onClick={() => setScannerTarget('pickBin')} className="px-3 py-2 bg-slate-700 rounded text-white text-sm">
                  Scan
                </button>
              </div>
              {isLoadingBin && <p className="text-xs text-slate-400 mt-1">Lade Bin …</p>}
            </div>
            <div>
              <label className="text-sm text-slate-400">Artikel / SKU</label>
              <div className="flex gap-2">
                <input
                  value={pickSku}
                  onChange={(e) => setPickSku(e.target.value)}
                  className="flex-1 bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-white"
                  placeholder="SKU im Bin scannen"
                />
                <button type="button" onClick={() => setScannerTarget('pickSku')} className="px-3 py-2 bg-slate-700 rounded text-white text-sm">
                  Scan
                </button>
              </div>
            </div>
            <div>
              <label className="text-sm text-slate-400">Menge</label>
              <input
                type="number"
                min={1}
                value={pickQuantity}
                onChange={(e) => setPickQuantity(Math.max(1, Number(e.target.value)))}
                className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-white"
              />
            </div>
          </div>

          {pickBinDetail && (
            <div className="bg-slate-900 rounded-lg p-4 border border-slate-700">
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
            className="px-4 py-2 rounded bg-emerald-600 text-white disabled:opacity-50"
          >
            Kommissionierung buchen
          </button>
        </div>
      )}

  <ScannerOverlay
    open={scannerTarget !== null}
    title="Code scannen"
    onDetected={handleScannerResult}
    onClose={() => setScannerTarget(null)}
  />
    </section>
  );
};


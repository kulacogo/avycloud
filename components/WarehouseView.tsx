import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  fetchWarehouseZones,
  createWarehouseLayoutApi,
  fetchWarehouseBins,
  fetchWarehouseBinDetail,
  removeProductFromBinApi,
  openBinLabelWindow,
} from '../api/client';
import { WarehouseBin, WarehouseLayout } from '../types';
import { PrintIcon } from './icons/Icons';

const ZONE_OPTIONS: Array<'X' | 'XS' | 'S' | 'M' | 'L' | 'XL'> = ['X', 'XS', 'S', 'M', 'L', 'XL'];
const ETAGE_OPTIONS: Array<'GA' | 'UG' | 'EG'> = ['GA', 'UG', 'EG'];

interface WarehouseViewProps {
  refreshBin?: WarehouseBin | null;
  onRefreshBinConsumed?: () => void;
}

const WarehouseView: React.FC<WarehouseViewProps> = ({ refreshBin, onRefreshBinConsumed }) => {
  const [zones, setZones] = useState<WarehouseLayout[]>([]);
  const [selectedZone, setSelectedZone] = useState<WarehouseLayout | null>(null);
  const [bins, setBins] = useState<WarehouseBin[]>([]);
  const [selectedGang, setSelectedGang] = useState<number | null>(null);
  const [selectedRegal, setSelectedRegal] = useState<number | null>(null);
  const [selectedBin, setSelectedBin] = useState<WarehouseBin | null>(null);
  const [binDetail, setBinDetail] = useState<any>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isLoadingBins, setIsLoadingBins] = useState(false);
  const [layoutForm, setLayoutForm] = useState({
    zone: 'X',
    etage: 'GA',
    gangs: '1-2',
    regale: '1-4',
    ebenen: 'A-E',
  });

  const loadZones = useCallback(async () => {
    try {
      const data = await fetchWarehouseZones();
      setZones(data);
      if (!selectedZone && data.length > 0) {
        setSelectedZone(data[0]);
      }
    } catch (error: any) {
      setStatusMessage(error?.message || 'Fehler beim Laden der Lagerzonen.');
    }
  }, [selectedZone]);

  useEffect(() => {
    loadZones();
  }, [loadZones]);

  const loadBins = useCallback(async (zone: string, etage: string, preserveBinCode?: string) => {
    setIsLoadingBins(true);
    try {
      const data = await fetchWarehouseBins(zone, etage);
      setBins(data);
      if (data.length > 0) {
        setSelectedGang(data[0].gang);
        setSelectedRegal(data[0].regal);
      } else {
        setSelectedGang(null);
        setSelectedRegal(null);
      }
      if (preserveBinCode) {
        const preserved = data.find((bin) => bin.code === preserveBinCode);
        if (preserved) {
          setSelectedBin(preserved);
          try {
            const detail = await fetchWarehouseBinDetail(preserved.code);
            setBinDetail(detail);
          } catch (error) {
            console.error('Failed to refresh bin detail:', error);
          }
        } else {
          setSelectedBin(null);
          setBinDetail(null);
        }
      } else {
        setSelectedBin(null);
        setBinDetail(null);
      }
    } catch (error: any) {
      setStatusMessage(error?.message || 'Fehler beim Laden der Bins.');
    } finally {
      setIsLoadingBins(false);
    }
  }, []);

  useEffect(() => {
    if (selectedZone) {
      loadBins(selectedZone.zone, selectedZone.etage);
    }
  }, [selectedZone, loadBins]);

  useEffect(() => {
    if (!refreshBin) return;
    const zoneMatch = zones.find((zone) => zone.zone === refreshBin.zone && zone.etage === refreshBin.etage);
    if (zoneMatch) {
      setSelectedZone(zoneMatch);
      loadBins(refreshBin.zone, refreshBin.etage, refreshBin.code);
    }
    onRefreshBinConsumed?.();
  }, [refreshBin, zones, loadBins, onRefreshBinConsumed]);

  const binsByGang = useMemo(() => {
    const map = new Map<number, WarehouseBin[]>();
    bins.forEach((bin) => {
      if (!map.has(bin.gang)) {
        map.set(bin.gang, []);
      }
      map.get(bin.gang)!.push(bin);
    });
    return map;
  }, [bins]);

  const regaleForSelectedGang = useMemo(() => {
    if (selectedGang == null) return [];
    const list = binsByGang.get(selectedGang) || [];
    const regaleMap = new Map<number, WarehouseBin[]>();
    list.forEach((bin) => {
      if (!regaleMap.has(bin.regal)) {
        regaleMap.set(bin.regal, []);
      }
      regaleMap.get(bin.regal)!.push(bin);
    });
    return Array.from(regaleMap.entries()).map(([regal, binList]) => ({
      regal,
      bins: binList.sort((a, b) => a.ebene.localeCompare(b.ebene)),
    }));
  }, [selectedGang, binsByGang]);

  const handleCreateLayout = async () => {
    setStatusMessage(null);
    const response = await createWarehouseLayoutApi(layoutForm);
    if (!response.ok) {
      setStatusMessage(response.error?.message || 'Layout konnte nicht erstellt werden.');
      return;
    }
    setStatusMessage('Layout erfolgreich erstellt.');
    await loadZones();
  };

  const handleSelectBin = async (bin: WarehouseBin) => {
    setSelectedBin(bin);
    try {
      const detail = await fetchWarehouseBinDetail(bin.code);
      setBinDetail(detail);
    } catch (error: any) {
      setStatusMessage(error?.message || 'Fehler beim Laden des BIN-Details.');
    }
  };

  const handleRemoveProduct = async (productId: string) => {
    if (!selectedBin) return;
    const response = await removeProductFromBinApi(selectedBin.code, productId);
    if (!response.ok) {
      setStatusMessage(response.error?.message || 'Fehler beim Entfernen.');
      return;
    }
    setStatusMessage('Produkt entfernt.');
    await loadBins(selectedZone!.zone, selectedZone!.etage, selectedBin.code);
  };

  const selectedGangBins = selectedGang != null ? binsByGang.get(selectedGang) || [] : [];

  return (
    <section className="space-y-6">
      {statusMessage && (
        <div className="bg-slate-700 text-slate-100 px-4 py-2 rounded-md shadow">{statusMessage}</div>
      )}

      <div className="bg-slate-800 rounded-lg p-4 shadow border border-slate-700">
        <h3 className="text-lg font-semibold text-white mb-2">Operative Workflows</h3>
        <p className="text-sm text-slate-400">
          Einlagerung (Stow) und Kommissionierung (Pick) findest du jetzt im Bereich <span className="text-white font-semibold">Operationen</span>. Wechsel dort,
          um Artikel zu buchen.
        </p>
      </div>

      <div className="bg-slate-800 rounded-lg p-4 shadow">
        <h3 className="text-xl font-semibold text-white mb-3">Neue Lagerstruktur anlegen</h3>
        <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
          <div>
            <label className="block text-sm text-slate-400 mb-1">Zone</label>
            <select
              value={layoutForm.zone}
              onChange={(e) => setLayoutForm((prev) => ({ ...prev, zone: e.target.value }))}
              className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-2"
            >
              {ZONE_OPTIONS.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm text-slate-400 mb-1">Etage</label>
            <select
              value={layoutForm.etage}
              onChange={(e) => setLayoutForm((prev) => ({ ...prev, etage: e.target.value }))}
              className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-2"
            >
              {ETAGE_OPTIONS.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm text-slate-400 mb-1">Gänge (z.B. 1-3)</label>
            <input
              value={layoutForm.gangs}
              onChange={(e) => setLayoutForm((prev) => ({ ...prev, gangs: e.target.value }))}
              className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-2"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-400 mb-1">Regale (z.B. 1-4)</label>
            <input
              value={layoutForm.regale}
              onChange={(e) => setLayoutForm((prev) => ({ ...prev, regale: e.target.value }))}
              className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-2"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-400 mb-1">Ebenen (z.B. A-E)</label>
            <input
              value={layoutForm.ebenen}
              onChange={(e) => setLayoutForm((prev) => ({ ...prev, ebenen: e.target.value }))}
              className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-2"
            />
          </div>
        </div>
        <button
          onClick={handleCreateLayout}
          className="mt-4 px-4 py-2 bg-sky-600 text-white rounded hover:bg-sky-500"
        >
          Bins generieren
        </button>
      </div>

      <div className="bg-slate-800 rounded-lg p-4 shadow">
        <h3 className="text-xl font-semibold text-white mb-3">Zonenübersicht</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {zones.map((zone) => (
            <button
              key={zone.id}
              onClick={() => setSelectedZone(zone)}
              className={`text-left p-3 rounded border ${
                selectedZone?.id === zone.id ? 'border-sky-500 bg-slate-700' : 'border-slate-700 hover:border-sky-600'
              }`}
            >
              <div className="text-lg font-semibold text-white">
                Zone {zone.zone} / {zone.etage}
              </div>
              <div className="text-sm text-slate-300">{zone.binCount} Bins · {zone.totalProducts || 0} Produkte</div>
              <div className="text-xs text-slate-500">
                Gänge {zone.gangs?.join(', ')} · Regale {zone.regale?.join(', ')} · Ebenen {zone.ebenen?.join(', ')}
              </div>
            </button>
          ))}
        </div>
      </div>

      {selectedZone && (
        <div className="bg-slate-800 rounded-lg p-4 shadow">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-xl font-semibold text-white">
                Zone {selectedZone.zone} / {selectedZone.etage}
              </h3>
              <p className="text-slate-400 text-sm">{bins.length} Bins insgesamt</p>
            </div>
            {selectedBin && (
              <button
                onClick={() => openBinLabelWindow(selectedBin.code)}
                className="flex items-center px-3 py-1.5 text-sm bg-emerald-600 text-white rounded-md"
              >
                <PrintIcon className="w-4 h-4 mr-1.5" /> BIN Label
              </button>
            )}
          </div>

          <div className="flex flex-wrap gap-2 mb-4">
            {Array.from(binsByGang.keys())
              .sort((a, b) => a - b)
              .map((gang) => (
                <button
                  key={gang}
                  onClick={() => {
                    setSelectedGang(gang);
                    setSelectedRegal(null);
                    setSelectedBin(null);
                    setBinDetail(null);
                  }}
                  className={`px-3 py-1 rounded ${
                    selectedGang === gang ? 'bg-sky-600 text-white' : 'bg-slate-700 text-slate-200'
                  }`}
                >
                  Gang {gang}
                </button>
              ))}
          </div>

          {isLoadingBins ? (
            <div className="text-slate-300">Lade Bins...</div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <h4 className="text-lg text-white mb-2">Regale & Ebenen</h4>
                <div className="space-y-3 max-h-[480px] overflow-y-auto pr-2">
                  {regaleForSelectedGang.map(({ regal, bins: binList }) => (
                    <div key={regal} className="border border-slate-700 rounded">
                      <button
                        className="w-full text-left px-3 py-2 bg-slate-700 text-white"
                        onClick={() => {
                          setSelectedRegal(regal);
                          setSelectedBin(null);
                          setBinDetail(null);
                        }}
                      >
                        Regal {regal}
                      </button>
                      <div className="grid grid-cols-5 gap-2 p-3">
                        {binList.map((bin) => (
                          <button
                            key={bin.code}
                            onClick={() => handleSelectBin(bin)}
                            className={`px-2 py-2 rounded text-xs ${
                              selectedBin?.code === bin.code ? 'bg-sky-600 text-white' : 'bg-slate-700 text-slate-200'
                            }`}
                          >
                            <div className="font-semibold">{bin.ebene}</div>
                            <div>{bin.productCount} Stk</div>
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <h4 className="text-lg text-white mb-2">BIN Detail</h4>
                {binDetail ? (
                  <div className="bg-slate-700 rounded p-4 space-y-3">
                    <div className="text-2xl font-semibold">{binDetail.code}</div>
                    <div className="text-slate-300 text-sm">
                      Gang {binDetail.gang} · Regal {binDetail.regal} · Ebene {binDetail.ebene}
                    </div>
                    <div className="text-slate-200">
                      {binDetail.productCount || 0} Produkte ·{' '}
                      {binDetail.firstStoredAt ? `seit ${new Date(binDetail.firstStoredAt).toLocaleString('de-DE')}` : 'leer'}
                    </div>

                    <div className="border-t border-slate-600 pt-3">
                      <h5 className="text-white font-semibold mb-2">Produkte</h5>
                      {binDetail.products?.length ? (
                        <ul className="space-y-2 max-h-48 overflow-y-auto">
                          {binDetail.products.map((item: any) => (
                            <li key={item.productId} className="flex justify-between items-center bg-slate-800 px-3 py-2 rounded">
                              <div>
                                <div className="text-white text-sm">{item.name}</div>
                                <div className="text-xs text-slate-400">
                                  SKU {item.sku} · Menge {item.quantity}
                                </div>
                              </div>
                              <button
                                onClick={() => handleRemoveProduct(item.productId)}
                                className="text-xs text-red-300 hover:text-red-200"
                              >
                                Entfernen
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <div className="text-slate-400 text-sm">Keine Produkte eingelagert.</div>
                      )}
                    </div>

                  </div>
                ) : (
                  <div className="text-slate-400">Bitte einen BIN auswählen.</div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
};

export default WarehouseView;


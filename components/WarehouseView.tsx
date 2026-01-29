import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  fetchWarehouseZones,
  createWarehouseLayoutApi,
  fetchWarehouseBins,
  fetchWarehouseBinDetail,
  removeProductFromBinApi,
  deleteWarehouseGangApi,
  deleteWarehouseRegalApi,
  deleteWarehouseEbeneApi,
  openBinLabelWindow,
  openBinLabelsBatchWindow,
} from '../api/client';
import { WarehouseBin, WarehouseLayout } from '../types';
import { PrintIcon } from './icons/Icons';
import { PageHeader } from './ui/PageHeader';
import { HelpDisclosure } from './ui/HelpDisclosure';

const ZONE_OPTIONS: Array<'X' | 'XS' | 'S' | 'M' | 'L' | 'XL' | 'XQ'> = ['X', 'XS', 'S', 'M', 'L', 'XL', 'XQ'];
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
  const [selectedBinCodes, setSelectedBinCodes] = useState<Set<string>>(new Set());
  const [layoutForm, setLayoutForm] = useState({
    zone: 'X',
    etage: 'GA',
    gangs: '1-2',
    regale: '1-4',
    ebenen: 'A-E',
  });
  const [removingProductId, setRemovingProductId] = useState<string | null>(null);
  const [deletingStructure, setDeletingStructure] = useState(false);

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
      setSelectedBinCodes((prev) => {
        if (!prev.size) return prev;
        const allowed = new Set(data.map((bin) => bin.code));
        const next = new Set<string>();
        prev.forEach((code) => {
          if (allowed.has(code)) {
            next.add(code);
          }
        });
        if (next.size === prev.size) {
          return prev;
        }
        return next;
      });
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

  const selectedCount = selectedBinCodes.size;

  const toggleBinSelection = useCallback((code: string) => {
    setSelectedBinCodes((prev) => {
      const next = new Set(prev);
      if (next.has(code)) {
        next.delete(code);
      } else {
        next.add(code);
      }
      return next;
    });
  }, []);

  const applySelection = useCallback((codes: string[], mode: 'add' | 'set' = 'add') => {
    setSelectedBinCodes((prev) => {
      const next = mode === 'set' ? new Set<string>() : new Set(prev);
      codes.forEach((code) => next.add(code));
      return next;
    });
  }, []);

  const selectAllInZone = useCallback(() => {
    applySelection(bins.map((bin) => bin.code), 'set');
    setStatusMessage(`Alle ${bins.length} Bins ausgewählt.`);
  }, [bins, applySelection]);

  const selectCurrentGang = useCallback(() => {
    if (selectedGang == null) return;
    const gangBins = bins.filter((bin) => bin.gang === selectedGang).map((bin) => bin.code);
    applySelection(gangBins);
    setStatusMessage(`Gang ${selectedGang}: ${gangBins.length} Bins markiert.`);
  }, [bins, selectedGang, applySelection]);

  const selectCurrentRegal = useCallback(() => {
    if (selectedGang == null || selectedRegal == null) return;
    const regalBins = bins
      .filter((bin) => bin.gang === selectedGang && bin.regal === selectedRegal)
      .map((bin) => bin.code);
    applySelection(regalBins);
    setStatusMessage(`Regal ${selectedRegal} in Gang ${selectedGang}: ${regalBins.length} Bins markiert.`);
  }, [bins, selectedGang, selectedRegal, applySelection]);

  const clearSelection = useCallback(() => {
    setSelectedBinCodes(new Set());
  }, []);

  const handlePrintSelectedBins = useCallback(() => {
    if (selectedCount > 0) {
      const codes = Array.from(selectedBinCodes);
      const result = openBinLabelsBatchWindow({ codes });
      if (!result.ok) {
        setStatusMessage(result.error?.message || 'BIN-Labels konnten nicht erstellt werden.');
        return;
      }
      setStatusMessage(`BIN-Labeldruck für ${codes.length} Bins gestartet.`);
      return;
    }
    if (!selectedZone) {
      setStatusMessage('Bitte Bins auswählen oder Zone/Etage festlegen.');
      return;
    }
    const params: {
      zone: string;
      etage: string;
      gang?: number;
      regal?: number;
    } = {
      zone: selectedZone.zone,
      etage: selectedZone.etage,
    };
    if (selectedGang != null) {
      params.gang = selectedGang;
    }
    if (selectedRegal != null) {
      params.regal = selectedRegal;
    }
    const result = openBinLabelsBatchWindow(params);
    if (!result.ok) {
      setStatusMessage(result.error?.message || 'BIN-Labels konnten nicht erstellt werden.');
      return;
    }
    const scope = params.regal != null ? `Regal ${params.regal}` : params.gang != null ? `Gang ${params.gang}` : 'Zone';
    setStatusMessage(`BIN-Labeldruck für ${scope} ${params.regal ?? params.gang ?? `${params.zone}/${params.etage}`} gestartet.`);
  }, [selectedBinCodes, selectedCount, selectedZone, selectedGang, selectedRegal]);

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
    setRemovingProductId(productId);
    try {
      const response = await removeProductFromBinApi(selectedBin.code, productId);
      if (!response.ok) {
        setStatusMessage(response.error?.message || 'Fehler beim Entfernen.');
        return;
      }
      setStatusMessage('Produkt entfernt.');
      if (selectedZone) {
        await loadBins(selectedZone.zone, selectedZone.etage, selectedBin.code);
      }
      // refresh bin detail to update UI immediately
      const detail = await fetchWarehouseBinDetail(selectedBin.code);
      setBinDetail(detail);
    } catch (error: any) {
      setStatusMessage(error?.message || 'Fehler beim Entfernen.');
    } finally {
      setRemovingProductId(null);
    }
  };

  const handleDeleteGang = async () => {
    if (!selectedZone || selectedGang == null) return;
    setStatusMessage(null);
    setDeletingStructure(true);
    try {
      const dry = await deleteWarehouseGangApi(selectedZone.zone, selectedZone.etage, selectedGang, { dryRun: true, timeoutMs: 25000 });
      if (!dry.ok) {
        setStatusMessage(dry.error?.message || 'Gang konnte nicht geprüft werden.');
        return;
      }
      const codes: string[] = Array.isArray(dry.data?.binCodes) ? dry.data.binCodes : [];
      const ok = window.confirm(`Gang ${selectedGang} löschen?\n\nBetroffene Bins: ${codes.length}\n\nNur möglich wenn alle Bins leer sind.`);
      if (!ok) return;
      const resp = await deleteWarehouseGangApi(selectedZone.zone, selectedZone.etage, selectedGang, { confirm: true, timeoutMs: 25000 });
      if (!resp.ok) {
        setStatusMessage(resp.error?.message || 'Gang löschen fehlgeschlagen.');
        return;
      }
      setStatusMessage(`Gang ${selectedGang} gelöscht (${resp.data?.deleted || 0} Bins).`);
      await loadZones();
      await loadBins(selectedZone.zone, selectedZone.etage);
      setSelectedGang(null);
      setSelectedRegal(null);
      setSelectedBin(null);
      setBinDetail(null);
    } finally {
      setDeletingStructure(false);
    }
  };

  const handleDeleteRegal = async () => {
    if (!selectedZone || selectedGang == null || selectedRegal == null) return;
    setStatusMessage(null);
    setDeletingStructure(true);
    try {
      const dry = await deleteWarehouseRegalApi(selectedZone.zone, selectedZone.etage, selectedGang, selectedRegal, { dryRun: true, timeoutMs: 25000 });
      if (!dry.ok) {
        setStatusMessage(dry.error?.message || 'Regal konnte nicht geprüft werden.');
        return;
      }
      const codes: string[] = Array.isArray(dry.data?.binCodes) ? dry.data.binCodes : [];
      const ok = window.confirm(
        `Regal ${selectedRegal} (Gang ${selectedGang}) löschen?\n\nBetroffene Bins: ${codes.length}\n\nNur möglich wenn alle Bins leer sind.`
      );
      if (!ok) return;
      const resp = await deleteWarehouseRegalApi(selectedZone.zone, selectedZone.etage, selectedGang, selectedRegal, { confirm: true, timeoutMs: 25000 });
      if (!resp.ok) {
        setStatusMessage(resp.error?.message || 'Regal löschen fehlgeschlagen.');
        return;
      }
      setStatusMessage(`Regal ${selectedRegal} gelöscht (${resp.data?.deleted || 0} Bins).`);
      await loadZones();
      await loadBins(selectedZone.zone, selectedZone.etage);
      setSelectedRegal(null);
      setSelectedBin(null);
      setBinDetail(null);
    } finally {
      setDeletingStructure(false);
    }
  };

  const handleDeleteEbene = async () => {
    if (!selectedZone || !selectedBin) return;
    setStatusMessage(null);
    setDeletingStructure(true);
    try {
      const gang = selectedBin.gang;
      const regal = selectedBin.regal;
      const ebene = selectedBin.ebene;
      const dry = await deleteWarehouseEbeneApi(selectedZone.zone, selectedZone.etage, gang, regal, ebene, { dryRun: true, timeoutMs: 25000 });
      if (!dry.ok) {
        setStatusMessage(dry.error?.message || 'Ebene konnte nicht geprüft werden.');
        return;
      }
      const ok = window.confirm(
        `Ebene ${ebene} (Gang ${gang} · Regal ${regal}) löschen?\n\nDies entfernt den BIN ${selectedBin.code}.\n\nNur möglich wenn der BIN leer ist.`
      );
      if (!ok) return;
      const resp = await deleteWarehouseEbeneApi(selectedZone.zone, selectedZone.etage, gang, regal, ebene, { confirm: true, timeoutMs: 25000 });
      if (!resp.ok) {
        setStatusMessage(resp.error?.message || 'Ebene löschen fehlgeschlagen.');
        return;
      }
      setStatusMessage(`Ebene ${ebene} gelöscht (${resp.data?.deleted || 0} BIN).`);
      await loadZones();
      await loadBins(selectedZone.zone, selectedZone.etage);
      setSelectedBin(null);
      setBinDetail(null);
    } finally {
      setDeletingStructure(false);
    }
  };

  const selectedGangBins = selectedGang != null ? binsByGang.get(selectedGang) || [] : [];

  return (
    <section className="space-y-6">
      <PageHeader
        title="Inventory"
        subtitle="Lagerplätze (BINs) ansehen, Labels drucken und Produkte aus BINs entfernen."
      >
        <HelpDisclosure title="Wie nutze ich Inventory? (2 Minuten)">
          <ol className="list-decimal pl-5 space-y-1">
            <li>
              <b>Zone/Etage wählen</b> → du siehst alle BINs in diesem Bereich.
            </li>
            <li>
              <b>BIN anklicken</b> → Details & enthaltene Produkte erscheinen rechts/unten.
            </li>
            <li>
              <b>Labels drucken</b>: wähle BINs (Checkbox) oder nutze “Zone/Gang/Regal markieren”.
            </li>
          </ol>
        </HelpDisclosure>
      </PageHeader>

      {statusMessage && (
        <div className="bg-slate-700 text-slate-100 px-4 py-2 rounded-md shadow">{statusMessage}</div>
      )}

      {/* Header moved to PageHeader above */}

      <div className="bg-slate-800 rounded-lg p-4 shadow border border-slate-700 space-y-3">
        <h3 className="text-lg font-semibold text-white">BIN-Auswahl & Druck</h3>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={selectAllInZone}
            className="px-3 py-1.5 rounded-lg bg-slate-700 text-sm text-white hover:bg-slate-600"
          >
            Zone markieren
          </button>
          <button
            type="button"
            onClick={selectCurrentGang}
            disabled={selectedGang == null}
            className="px-3 py-1.5 rounded-lg text-sm text-white disabled:opacity-40 bg-slate-700 hover:bg-slate-600"
          >
            Gang markieren
          </button>
          <button
            type="button"
            onClick={selectCurrentRegal}
            disabled={selectedGang == null || selectedRegal == null}
            className="px-3 py-1.5 rounded-lg text-sm text-white disabled:opacity-40 bg-slate-700 hover:bg-slate-600"
          >
            Regal markieren
          </button>
          <button
            type="button"
            onClick={clearSelection}
            className="px-3 py-1.5 rounded-lg bg-slate-700 text-sm text-white hover:bg-slate-600"
          >
            Auswahl leeren
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-slate-300">Ausgewählte Bins: {selectedCount}</span>
          <button
            type="button"
            onClick={handlePrintSelectedBins}
            disabled={!selectedCount}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 text-white disabled:opacity-40"
          >
            <PrintIcon className="w-4 h-4" />
            BIN Labels drucken
          </button>
        </div>
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

          <div className="flex flex-wrap items-center gap-2 mb-4">
            <button
              type="button"
              disabled={!selectedZone || selectedGang == null || deletingStructure}
              onClick={handleDeleteGang}
              className="px-3 py-1.5 rounded-lg bg-rose-700 text-sm text-white disabled:opacity-40 hover:bg-rose-600"
              title="Löscht alle leeren Bins in diesem Gang."
            >
              Gang löschen
            </button>
            <button
              type="button"
              disabled={!selectedZone || selectedGang == null || selectedRegal == null || deletingStructure}
              onClick={handleDeleteRegal}
              className="px-3 py-1.5 rounded-lg bg-rose-700 text-sm text-white disabled:opacity-40 hover:bg-rose-600"
              title="Löscht alle leeren Bins in diesem Regal (innerhalb des gewählten Gangs)."
            >
              Regal löschen
            </button>
            <button
              type="button"
              disabled={!selectedZone || !selectedBin || deletingStructure}
              onClick={handleDeleteEbene}
              className="px-3 py-1.5 rounded-lg bg-rose-700 text-sm text-white disabled:opacity-40 hover:bg-rose-600"
              title="Löscht den aktuell ausgewählten BIN (Ebene)."
            >
              Ebene löschen
            </button>
            <span className="text-xs text-slate-400">
              Löschen ist nur möglich, wenn die betroffenen Bins leer sind.
            </span>
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
                        {binList.map((bin) => {
                          const isActive = selectedBin?.code === bin.code;
                          const isMarked = selectedBinCodes.has(bin.code);
                          return (
                            <div key={bin.code} className="relative">
                              <button
                                onClick={() => handleSelectBin(bin)}
                                className={`w-full px-2 py-2 rounded text-xs transition ${
                                  isActive ? 'bg-sky-600 text-white' : 'bg-slate-700 text-slate-200'
                                } ${isMarked ? 'ring-2 ring-emerald-400' : ''}`}
                              >
                                <div className="font-semibold">{bin.ebene}</div>
                                <div>{bin.productCount} Stk</div>
                              </button>
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  toggleBinSelection(bin.code);
                                }}
                                className={`absolute -top-2 -right-2 w-6 h-6 rounded-full text-xs font-bold ${
                                  isMarked ? 'bg-emerald-500 text-white' : 'bg-slate-600 text-white'
                                }`}
                                title={isMarked ? 'Aus Auswahl entfernen' : 'Zur Auswahl hinzufügen'}
                              >
                                {isMarked ? '✓' : '+'}
                              </button>
                            </div>
                          );
                        })}
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
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={!selectedBin || deletingStructure}
                        onClick={handleDeleteEbene}
                        className="px-3 py-1.5 rounded bg-rose-700 text-white text-sm disabled:opacity-40 hover:bg-rose-600"
                        title="Löscht diesen BIN (nur wenn leer)"
                      >
                        Ebene löschen
                      </button>
                      <span className="text-xs text-slate-300">Nur möglich, wenn der BIN leer ist.</span>
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
                                disabled={removingProductId === item.productId}
                                className="text-xs text-red-300 hover:text-red-200"
                              >
                                {removingProductId === item.productId ? '...' : 'Entfernen'}
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

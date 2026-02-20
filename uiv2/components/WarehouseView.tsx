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
import { Notice } from './ui/Notice';
import { ConfirmDialog } from './ui/ConfirmDialog';

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
  const [confirmDialog, setConfirmDialog] = useState<{
    title: string;
    description?: React.ReactNode;
    details?: React.ReactNode;
    tone?: 'default' | 'danger';
    confirmLabel: string;
    onConfirm: () => void | Promise<void>;
  } | null>(null);
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
      setConfirmDialog({
        title: `Gang ${selectedGang} löschen?`,
        tone: 'danger',
        description: `Diese Aktion entfernt alle Bins im Gang. Nur möglich wenn alle Bins leer sind.`,
        details: `Betroffene Bins: ${codes.length}\n${codes.slice(0, 50).join('\n')}${codes.length > 50 ? `\n… +${codes.length - 50} mehr` : ''}`,
        confirmLabel: 'Löschen',
        onConfirm: async () => {
          setConfirmDialog(null);
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
        },
      });
      return;
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
      setConfirmDialog({
        title: `Regal ${selectedRegal} löschen?`,
        tone: 'danger',
        description: `Gang ${selectedGang} · Regal ${selectedRegal}. Nur möglich wenn alle Bins leer sind.`,
        details: `Betroffene Bins: ${codes.length}\n${codes.slice(0, 50).join('\n')}${codes.length > 50 ? `\n… +${codes.length - 50} mehr` : ''}`,
        confirmLabel: 'Löschen',
        onConfirm: async () => {
          setConfirmDialog(null);
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
        },
      });
      return;
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
      setConfirmDialog({
        title: `Ebene ${ebene} löschen?`,
        tone: 'danger',
        description: `Gang ${gang} · Regal ${regal}. Dies entfernt den BIN ${selectedBin.code}. Nur möglich wenn der BIN leer ist.`,
        confirmLabel: 'Löschen',
        onConfirm: async () => {
          setConfirmDialog(null);
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
        },
      });
      return;
    } finally {
      setDeletingStructure(false);
    }
  };

  const selectedGangBins = selectedGang != null ? binsByGang.get(selectedGang) || [] : [];

  return (
    <section className="space-y-6">
      <PageHeader
        title="Warehouse"
        subtitle="Lagerstruktur (Zonen/BINs) ansehen, Labels drucken und BIN-Inhalte verwalten."
      >
        <HelpDisclosure title="Wie nutze ich Warehouse? (2 Minuten)">
          <ol className="list-decimal pl-5 space-y-1">
            <li>
              <b>Zone/Etage wählen</b> → du siehst alle BINs in diesem Bereich.
            </li>
            <li>
              <b>Gang → Regal → BIN</b> auswählen → Details & enthaltene Produkte erscheinen rechts/unten.
            </li>
            <li>
              <b>Labels drucken</b>: wähle BINs (Checkbox) oder nutze “Zone/Gang/Regal markieren”.
            </li>
            <li>
              <b>Aufräumen</b>: Produkte aus BINs entfernen oder (leer) Struktur löschen.
            </li>
          </ol>
        </HelpDisclosure>
      </PageHeader>

      {zones.length === 0 ? (
        <Notice tone="info" title="Noch keine Lagerstruktur">
          Lege zuerst eine Zone/Etage-Struktur an (unten: „Neue Lagerstruktur anlegen“). Danach kannst du Bins auswählen und Labels drucken.
        </Notice>
      ) : null}

      {statusMessage && (
        <Notice tone="info" title="Status" onDismiss={() => setStatusMessage(null)}>
          {statusMessage}
        </Notice>
      )}

      {confirmDialog ? (
        <ConfirmDialog
          open
          title={confirmDialog.title}
          description={confirmDialog.description}
          details={confirmDialog.details}
          tone={confirmDialog.tone || 'default'}
          confirmLabel={confirmDialog.confirmLabel}
          onCancel={() => setConfirmDialog(null)}
          onConfirm={confirmDialog.onConfirm}
        />
      ) : null}

      {/* Header moved to PageHeader above */}

      <div className="bg-[var(--surface-hover)] rounded-lg p-4 shadow border border-[var(--border)] space-y-3">
        <h3 className="text-lg font-semibold text-[color:white]">BIN-Auswahl & Druck</h3>
        <div className="text-xs text-[color:var(--text-tertiary)]">
          Bereich: {selectedZone ? `${selectedZone.zone}/${selectedZone.etage}` : '—'}
          {selectedGang != null ? ` · Gang ${selectedGang}` : ''}
          {selectedRegal != null ? ` · Regal ${selectedRegal}` : ''}
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={selectAllInZone}
            className="px-3 py-1.5 rounded-lg bg-[var(--surface)] text-sm text-[color:white] hover:bg-[var(--surface-secondary)]"
          >
            Zone markieren
          </button>
          <button
            type="button"
            onClick={selectCurrentGang}
            disabled={selectedGang == null}
            className="px-3 py-1.5 rounded-lg text-sm text-[color:white] disabled:opacity-40 bg-[var(--surface)] hover:bg-[var(--surface-secondary)]"
          >
            Gang markieren
          </button>
          <button
            type="button"
            onClick={selectCurrentRegal}
            disabled={selectedGang == null || selectedRegal == null}
            className="px-3 py-1.5 rounded-lg text-sm text-[color:white] disabled:opacity-40 bg-[var(--surface)] hover:bg-[var(--surface-secondary)]"
          >
            Regal markieren
          </button>
          <button
            type="button"
            onClick={clearSelection}
            className="px-3 py-1.5 rounded-lg bg-[var(--surface)] text-sm text-[color:white] hover:bg-[var(--surface-secondary)]"
          >
            Auswahl leeren
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-[color:var(--text-secondary)]">Ausgewählte Bins: {selectedCount}</span>
          <button
            type="button"
            onClick={handlePrintSelectedBins}
            disabled={!selectedCount && !selectedZone}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--success)] text-[color:white] disabled:opacity-40"
          >
            <PrintIcon className="w-4 h-4" />
            BIN Labels drucken
          </button>
        </div>
      </div>

      <div className="bg-[var(--surface-hover)] rounded-lg p-4 shadow">
        <h3 className="text-xl font-semibold text-[color:white] mb-3">Neue Lagerstruktur anlegen</h3>
        <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
          <div>
            <label className="block text-sm text-[color:var(--text-tertiary)] mb-1">Zone</label>
            <select
              value={layoutForm.zone}
              onChange={(e) => setLayoutForm((prev) => ({ ...prev, zone: e.target.value }))}
              className="w-full bg-[var(--surface)] border border-[var(--border-hover)] rounded px-3 py-2"
            >
              {ZONE_OPTIONS.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm text-[color:var(--text-tertiary)] mb-1">Etage</label>
            <select
              value={layoutForm.etage}
              onChange={(e) => setLayoutForm((prev) => ({ ...prev, etage: e.target.value }))}
              className="w-full bg-[var(--surface)] border border-[var(--border-hover)] rounded px-3 py-2"
            >
              {ETAGE_OPTIONS.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm text-[color:var(--text-tertiary)] mb-1">Gänge (z.B. 1-3)</label>
            <input
              value={layoutForm.gangs}
              onChange={(e) => setLayoutForm((prev) => ({ ...prev, gangs: e.target.value }))}
              className="w-full bg-[var(--surface)] border border-[var(--border-hover)] rounded px-3 py-2"
            />
          </div>
          <div>
            <label className="block text-sm text-[color:var(--text-tertiary)] mb-1">Regale (z.B. 1-4)</label>
            <input
              value={layoutForm.regale}
              onChange={(e) => setLayoutForm((prev) => ({ ...prev, regale: e.target.value }))}
              className="w-full bg-[var(--surface)] border border-[var(--border-hover)] rounded px-3 py-2"
            />
          </div>
          <div>
            <label className="block text-sm text-[color:var(--text-tertiary)] mb-1">Ebenen (z.B. A-E)</label>
            <input
              value={layoutForm.ebenen}
              onChange={(e) => setLayoutForm((prev) => ({ ...prev, ebenen: e.target.value }))}
              className="w-full bg-[var(--surface)] border border-[var(--border-hover)] rounded px-3 py-2"
            />
          </div>
        </div>
        <button
          onClick={handleCreateLayout}
          className="mt-4 px-4 py-2 bg-[var(--avy-purple)] text-[color:white] rounded hover:bg-[var(--avy-purple-hover)]"
        >
          Bins generieren
        </button>
      </div>

      <div className="bg-[var(--surface-hover)] rounded-lg p-4 shadow">
        <h3 className="text-xl font-semibold text-[color:white] mb-3">Zonenübersicht</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {zones.map((zone) => (
            <button
              key={zone.id}
              onClick={() => setSelectedZone(zone)}
              className={`text-left p-3 rounded border ${
                selectedZone?.id === zone.id ? 'border-[var(--avy-purple)] bg-[var(--surface)]' : 'border-[var(--border)] hover:border-[var(--avy-purple)]'
              }`}
            >
              <div className="text-lg font-semibold text-[color:white]">
                Zone {zone.zone} / {zone.etage}
              </div>
              <div className="text-sm text-[color:var(--text-secondary)]">{zone.binCount} Bins · {zone.totalProducts || 0} Produkte</div>
              <div className="text-xs text-[color:var(--text-tertiary)]">
                Gänge {zone.gangs?.join(', ')} · Regale {zone.regale?.join(', ')} · Ebenen {zone.ebenen?.join(', ')}
              </div>
            </button>
          ))}
        </div>
      </div>

      {selectedZone && (
        <div className="bg-[var(--surface-hover)] rounded-lg p-4 shadow">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-xl font-semibold text-[color:white]">
                Zone {selectedZone.zone} / {selectedZone.etage}
              </h3>
              <p className="text-[color:var(--text-tertiary)] text-sm">{bins.length} Bins insgesamt</p>
            </div>
            {selectedBin && (
              <button
                onClick={() => openBinLabelWindow(selectedBin.code)}
                className="flex items-center px-3 py-1.5 text-sm bg-[var(--success)] text-[color:white] rounded-md"
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
                    selectedGang === gang ? 'bg-[var(--avy-purple)] text-[color:white]' : 'bg-[var(--surface)] text-[color:var(--text-primary)]'
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
              className="px-3 py-1.5 rounded-lg bg-[var(--error)] text-sm text-[color:white] disabled:opacity-40 hover:bg-[#B91C1C]"
              title="Löscht alle leeren Bins in diesem Gang."
            >
              Gang löschen
            </button>
            <button
              type="button"
              disabled={!selectedZone || selectedGang == null || selectedRegal == null || deletingStructure}
              onClick={handleDeleteRegal}
              className="px-3 py-1.5 rounded-lg bg-[var(--error)] text-sm text-[color:white] disabled:opacity-40 hover:bg-[#B91C1C]"
              title="Löscht alle leeren Bins in diesem Regal (innerhalb des gewählten Gangs)."
            >
              Regal löschen
            </button>
            <button
              type="button"
              disabled={!selectedZone || !selectedBin || deletingStructure}
              onClick={handleDeleteEbene}
              className="px-3 py-1.5 rounded-lg bg-[var(--error)] text-sm text-[color:white] disabled:opacity-40 hover:bg-[#B91C1C]"
              title="Löscht den aktuell ausgewählten BIN (Ebene)."
            >
              Ebene löschen
            </button>
            <span className="text-xs text-[color:var(--text-tertiary)]">
              Löschen ist nur möglich, wenn die betroffenen Bins leer sind.
            </span>
          </div>

          {isLoadingBins ? (
            <div className="text-[color:var(--text-secondary)]">Lade Bins...</div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <h4 className="text-lg text-[color:white] mb-2">Regale & Ebenen</h4>
                <div className="space-y-3 max-h-[480px] overflow-y-auto pr-2">
                  {regaleForSelectedGang.map(({ regal, bins: binList }) => (
                    <div key={regal} className="border border-[var(--border)] rounded">
                      <button
                        className="w-full text-left px-3 py-2 bg-[var(--surface)] text-[color:white]"
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
                                  isActive ? 'bg-[var(--avy-purple)] text-[color:white]' : 'bg-[var(--surface)] text-[color:var(--text-primary)]'
                                } ${isMarked ? 'ring-2 ring-[var(--success)]' : ''}`}
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
                                  isMarked ? 'bg-[var(--success)] text-[color:white]' : 'bg-[var(--surface-secondary)] text-[color:white]'
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
                <h4 className="text-lg text-[color:white] mb-2">BIN Detail</h4>
                {binDetail ? (
                  <div className="bg-[var(--surface)] rounded p-4 space-y-3">
                    <div className="text-2xl font-semibold">{binDetail.code}</div>
                    <div className="text-[color:var(--text-secondary)] text-sm">
                      Gang {binDetail.gang} · Regal {binDetail.regal} · Ebene {binDetail.ebene}
                    </div>
                    <div className="text-[color:var(--text-primary)]">
                      {binDetail.productCount || 0} Produkte ·{' '}
                      {binDetail.firstStoredAt ? `seit ${new Date(binDetail.firstStoredAt).toLocaleString('de-DE')}` : 'leer'}
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={!selectedBin || deletingStructure}
                        onClick={handleDeleteEbene}
                        className="px-3 py-1.5 rounded bg-[var(--error)] text-[color:white] text-sm disabled:opacity-40 hover:bg-[#B91C1C]"
                        title="Löscht diesen BIN (nur wenn leer)"
                      >
                        Ebene löschen
                      </button>
                      <span className="text-xs text-[color:var(--text-secondary)]">Nur möglich, wenn der BIN leer ist.</span>
                    </div>

                    <div className="border-t border-[var(--border-hover)] pt-3">
                      <h5 className="text-[color:white] font-semibold mb-2">Produkte</h5>
                      {binDetail.products?.length ? (
                        <ul className="space-y-2 max-h-48 overflow-y-auto">
                          {binDetail.products.map((item: any) => (
                            <li key={item.productId} className="flex justify-between items-center bg-[var(--surface-hover)] px-3 py-2 rounded">
                              <div>
                                <div className="text-[color:white] text-sm">{item.name}</div>
                                <div className="text-xs text-[color:var(--text-tertiary)]">
                                  SKU {item.sku} · Menge {item.quantity}
                                </div>
                              </div>
                              <button
                                onClick={() => handleRemoveProduct(item.productId)}
                                disabled={removingProductId === item.productId}
                                className="text-xs text-[color:var(--error)] hover:text-[color:var(--error)]"
                              >
                                {removingProductId === item.productId ? '...' : 'Entfernen'}
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <div className="text-[color:var(--text-tertiary)] text-sm">Keine Produkte eingelagert.</div>
                      )}
                    </div>

                  </div>
                ) : (
                  <div className="text-[color:var(--text-tertiary)]">Bitte einen BIN auswählen.</div>
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

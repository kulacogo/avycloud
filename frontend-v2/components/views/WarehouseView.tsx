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
} from '../../api/client';
import { WarehouseBin, WarehouseLayout } from '../../types';
import { PrintIcon } from '../icons/Icons';
import { PageHeader } from '../shared/PageHeader';
import { HelpDisclosure } from '../shared/HelpDisclosure';
import { Notice } from '../shared/Notice';
import { ConfirmDialog } from '../shared/ConfirmDialog';

const ZONE_OPTIONS: Array<'X' | 'XS' | 'S' | 'M' | 'L' | 'XL' | 'XQ'> = ['X', 'XS', 'S', 'M', 'L', 'XL', 'XQ'];
const ETAGE_OPTIONS: Array<'GA' | 'UG' | 'EG'> = ['GA', 'UG', 'EG'];

const ZONE_COLORS: Record<string, string> = {
  X: 'var(--avy-purple)', XS: 'var(--info)', S: 'var(--success)', M: 'var(--warning)',
  L: 'var(--avy-purple)', XL: 'var(--info)', XQ: 'var(--success)',
};

/* ------------------------------------------------------------------ */
/*  Bin state helper                                                   */
/* ------------------------------------------------------------------ */
function getBinState(bin: WarehouseBin): 'empty' | 'partial' | 'full' | 'overflow' {
  if (bin.productCount === 0) return 'empty';
  // We do not have capacity info per-bin from the API, so treat any bin with products as partial.
  // If >=5 items, treat as full. If >=10, overflow (rough heuristic).
  if (bin.productCount >= 10) return 'overflow';
  if (bin.productCount >= 5) return 'full';
  return 'partial';
}

function getBinFillPercent(bin: WarehouseBin): number {
  // heuristic: assume capacity of ~10 per bin for visual fill bar
  const capacity = 10;
  return Math.min((bin.productCount / capacity) * 100, 100);
}

function getFillBarColor(pct: number): string {
  if (pct === 0) return '';
  if (pct < 50) return 'bg-[var(--success)]';
  if (pct < 80) return 'bg-[var(--warning)]';
  return 'bg-[var(--error)]';
}

interface WarehouseViewProps {
  refreshBin?: WarehouseBin | null;
  onRefreshBinConsumed?: () => void;
}

const WarehouseView: React.FC<WarehouseViewProps> = ({ refreshBin, onRefreshBinConsumed }) => {
  /* ------------------------------------------------------------------ */
  /*  State                                                              */
  /* ------------------------------------------------------------------ */
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

  // New UI state for search/filter
  const [searchTerm, setSearchTerm] = useState('');
  const [filterMode, setFilterMode] = useState<'all' | 'occupied' | 'empty' | 'overflow'>('all');
  const [showCreateLayout, setShowCreateLayout] = useState(false);

  /* ------------------------------------------------------------------ */
  /*  Data loading                                                       */
  /* ------------------------------------------------------------------ */
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

  /* ------------------------------------------------------------------ */
  /*  Derived data                                                       */
  /* ------------------------------------------------------------------ */
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

  // Filtered bins for the visual grid
  const filteredBins = useMemo(() => {
    let result = bins;
    if (filterMode === 'occupied') result = result.filter((b) => b.productCount > 0);
    else if (filterMode === 'empty') result = result.filter((b) => b.productCount === 0);
    else if (filterMode === 'overflow') result = result.filter((b) => b.productCount >= 10);
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      result = result.filter(
        (b) =>
          b.code.toLowerCase().includes(term) ||
          b.ebene.toLowerCase().includes(term) ||
          b.products?.some((p) => p.name.toLowerCase().includes(term) || p.sku?.toLowerCase().includes(term))
      );
    }
    return result;
  }, [bins, filterMode, searchTerm]);

  // Group filtered bins by gang > regal > ebene for the visual grid
  const gridData = useMemo(() => {
    const gangMap = new Map<number, Map<number, WarehouseBin[]>>();
    filteredBins.forEach((bin) => {
      if (!gangMap.has(bin.gang)) gangMap.set(bin.gang, new Map());
      const regalMap = gangMap.get(bin.gang)!;
      if (!regalMap.has(bin.regal)) regalMap.set(bin.regal, []);
      regalMap.get(bin.regal)!.push(bin);
    });
    return gangMap;
  }, [filteredBins]);

  const selectedCount = selectedBinCodes.size;

  // KPI stats
  const kpiStats = useMemo(() => {
    const total = bins.length;
    const occupied = bins.filter((b) => b.productCount > 0).length;
    const empty = total - occupied;
    const utilization = total > 0 ? Math.round((occupied / total) * 1000) / 10 : 0;
    return { total, occupied, empty, utilization };
  }, [bins]);

  /* ------------------------------------------------------------------ */
  /*  Event handlers                                                     */
  /* ------------------------------------------------------------------ */
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
    setStatusMessage(`Alle ${bins.length} Bins ausgewahlt.`);
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
      setStatusMessage(`BIN-Labeldruck fur ${codes.length} Bins gestartet.`);
      return;
    }
    if (!selectedZone) {
      setStatusMessage('Bitte Bins auswahlen oder Zone/Etage festlegen.');
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
    setStatusMessage(`BIN-Labeldruck fur ${scope} ${params.regal ?? params.gang ?? `${params.zone}/${params.etage}`} gestartet.`);
  }, [selectedBinCodes, selectedCount, selectedZone, selectedGang, selectedRegal]);

  const handleCreateLayout = async () => {
    setStatusMessage(null);
    const response = await createWarehouseLayoutApi(layoutForm);
    if (!response.ok) {
      setStatusMessage(response.error?.message || 'Layout konnte nicht erstellt werden.');
      return;
    }
    setStatusMessage('Layout erfolgreich erstellt.');
    setShowCreateLayout(false);
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
        setStatusMessage(dry.error?.message || 'Gang konnte nicht gepruft werden.');
        return;
      }
      const codes: string[] = Array.isArray(dry.data?.binCodes) ? dry.data.binCodes : [];
      setConfirmDialog({
        title: `Gang ${selectedGang} loschen?`,
        tone: 'danger',
        description: `Diese Aktion entfernt alle Bins im Gang. Nur moglich wenn alle Bins leer sind.`,
        details: `Betroffene Bins: ${codes.length}\n${codes.slice(0, 50).join('\n')}${codes.length > 50 ? `\n... +${codes.length - 50} mehr` : ''}`,
        confirmLabel: 'Loschen',
        onConfirm: async () => {
          setConfirmDialog(null);
          const resp = await deleteWarehouseGangApi(selectedZone.zone, selectedZone.etage, selectedGang, { confirm: true, timeoutMs: 25000 });
          if (!resp.ok) {
            setStatusMessage(resp.error?.message || 'Gang loschen fehlgeschlagen.');
            return;
          }
          setStatusMessage(`Gang ${selectedGang} geloscht (${resp.data?.deleted || 0} Bins).`);
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
        setStatusMessage(dry.error?.message || 'Regal konnte nicht gepruft werden.');
        return;
      }
      const codes: string[] = Array.isArray(dry.data?.binCodes) ? dry.data.binCodes : [];
      setConfirmDialog({
        title: `Regal ${selectedRegal} loschen?`,
        tone: 'danger',
        description: `Gang ${selectedGang} / Regal ${selectedRegal}. Nur moglich wenn alle Bins leer sind.`,
        details: `Betroffene Bins: ${codes.length}\n${codes.slice(0, 50).join('\n')}${codes.length > 50 ? `\n... +${codes.length - 50} mehr` : ''}`,
        confirmLabel: 'Loschen',
        onConfirm: async () => {
          setConfirmDialog(null);
          const resp = await deleteWarehouseRegalApi(selectedZone.zone, selectedZone.etage, selectedGang, selectedRegal, { confirm: true, timeoutMs: 25000 });
          if (!resp.ok) {
            setStatusMessage(resp.error?.message || 'Regal loschen fehlgeschlagen.');
            return;
          }
          setStatusMessage(`Regal ${selectedRegal} geloscht (${resp.data?.deleted || 0} Bins).`);
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
        setStatusMessage(dry.error?.message || 'Ebene konnte nicht gepruft werden.');
        return;
      }
      setConfirmDialog({
        title: `Ebene ${ebene} loschen?`,
        tone: 'danger',
        description: `Gang ${gang} / Regal ${regal}. Dies entfernt den BIN ${selectedBin.code}. Nur moglich wenn der BIN leer ist.`,
        confirmLabel: 'Loschen',
        onConfirm: async () => {
          setConfirmDialog(null);
          const resp = await deleteWarehouseEbeneApi(selectedZone.zone, selectedZone.etage, gang, regal, ebene, { confirm: true, timeoutMs: 25000 });
          if (!resp.ok) {
            setStatusMessage(resp.error?.message || 'Ebene loschen fehlgeschlagen.');
            return;
          }
          setStatusMessage(`Ebene ${ebene} geloscht (${resp.data?.deleted || 0} BIN).`);
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

  const handleCloseDetailPanel = () => {
    setSelectedBin(null);
    setBinDetail(null);
  };

  /* ------------------------------------------------------------------ */
  /*  Render                                                             */
  /* ------------------------------------------------------------------ */
  return (
    <section className="space-y-5">
      {/* ---- Page Header ---- */}
      <PageHeader
        title="Warehouse"
        subtitle="Lagerverwaltung & Bin-Uebersicht"
        right={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowCreateLayout((v) => !v)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-[13px] font-semibold text-[var(--text-secondary)] transition hover:border-[var(--border-hover)] hover:text-[var(--text-primary)] hover:shadow-sm"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="2" width="10" height="10" rx="2"/><path d="M7 5v4M5 7h4"/></svg>
              Zone erstellen
            </button>
            <button
              type="button"
              onClick={handlePrintSelectedBins}
              disabled={!selectedCount && !selectedZone}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--avy-purple)] px-4 py-2 text-[13px] font-semibold text-white transition hover:bg-[var(--avy-purple-hover)] hover:-translate-y-px hover:shadow-[0_4px_12px_rgba(99,91,255,0.3)] active:translate-y-0 disabled:opacity-40 disabled:hover:transform-none"
            >
              <PrintIcon className="h-3.5 w-3.5" />
              Labels drucken {selectedCount > 0 && `(${selectedCount})`}
            </button>
          </div>
        }
      >
        <HelpDisclosure title="Wie nutze ich Warehouse? (2 Minuten)">
          <ol className="list-decimal pl-5 space-y-1">
            <li><b>Zone/Etage wahlen</b> -- du siehst alle BINs in diesem Bereich.</li>
            <li><b>Gang -- Regal -- BIN</b> auswahlen -- Details & enthaltene Produkte erscheinen rechts/unten.</li>
            <li><b>Labels drucken</b>: wahle BINs (Checkbox) oder nutze "Zone/Gang/Regal markieren".</li>
            <li><b>Aufraumen</b>: Produkte aus BINs entfernen oder (leer) Struktur loschen.</li>
          </ol>
        </HelpDisclosure>
      </PageHeader>

      {zones.length === 0 ? (
        <Notice tone="info" title="Noch keine Lagerstruktur">
          Lege zuerst eine Zone/Etage-Struktur an (unten: "Neue Lagerstruktur anlegen"). Danach kannst du Bins auswahlen und Labels drucken.
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

      {/* ---- Create Layout Panel (collapsible) ---- */}
      {showCreateLayout && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-sm)]">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-[15px] font-semibold text-[var(--text-primary)]">Neue Lagerstruktur anlegen</h3>
            <button
              type="button"
              onClick={() => setShowCreateLayout(false)}
              className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-tertiary)] transition hover:bg-[var(--surface-secondary)] hover:text-[var(--text-primary)]"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M4 4l8 8M12 4l-8 8"/></svg>
            </button>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-5">
            <div>
              <label className="mb-1 block text-[12px] font-medium text-[var(--text-tertiary)]">Zone</label>
              <select
                value={layoutForm.zone}
                onChange={(e) => setLayoutForm((prev) => ({ ...prev, zone: e.target.value }))}
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[13px] font-medium text-[var(--text-primary)] outline-none transition focus:border-[var(--avy-purple)] focus:shadow-[var(--shadow-focus)]"
              >
                {ZONE_OPTIONS.map((z) => (
                  <option key={z} value={z}>{z}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-[12px] font-medium text-[var(--text-tertiary)]">Etage</label>
              <select
                value={layoutForm.etage}
                onChange={(e) => setLayoutForm((prev) => ({ ...prev, etage: e.target.value }))}
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[13px] font-medium text-[var(--text-primary)] outline-none transition focus:border-[var(--avy-purple)] focus:shadow-[var(--shadow-focus)]"
              >
                {ETAGE_OPTIONS.map((e) => (
                  <option key={e} value={e}>{e}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-[12px] font-medium text-[var(--text-tertiary)]">Gange (z.B. 1-3)</label>
              <input
                value={layoutForm.gangs}
                onChange={(e) => setLayoutForm((prev) => ({ ...prev, gangs: e.target.value }))}
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[13px] font-medium text-[var(--text-primary)] outline-none transition focus:border-[var(--avy-purple)] focus:shadow-[var(--shadow-focus)]"
              />
            </div>
            <div>
              <label className="mb-1 block text-[12px] font-medium text-[var(--text-tertiary)]">Regale (z.B. 1-4)</label>
              <input
                value={layoutForm.regale}
                onChange={(e) => setLayoutForm((prev) => ({ ...prev, regale: e.target.value }))}
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[13px] font-medium text-[var(--text-primary)] outline-none transition focus:border-[var(--avy-purple)] focus:shadow-[var(--shadow-focus)]"
              />
            </div>
            <div>
              <label className="mb-1 block text-[12px] font-medium text-[var(--text-tertiary)]">Ebenen (z.B. A-E)</label>
              <input
                value={layoutForm.ebenen}
                onChange={(e) => setLayoutForm((prev) => ({ ...prev, ebenen: e.target.value }))}
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[13px] font-medium text-[var(--text-primary)] outline-none transition focus:border-[var(--avy-purple)] focus:shadow-[var(--shadow-focus)]"
              />
            </div>
          </div>
          <button
            onClick={handleCreateLayout}
            className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-[var(--avy-purple)] px-4 py-2 text-[13px] font-semibold text-white transition hover:bg-[var(--avy-purple-hover)] hover:-translate-y-px hover:shadow-[0_4px_12px_rgba(99,91,255,0.3)] active:translate-y-0"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M7 2v10M2 7h10"/></svg>
            Bins generieren
          </button>
        </div>
      )}

      {/* ---- KPI Cards ---- */}
      {selectedZone && (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-4">
          {/* Total Bins */}
          <div className="group relative overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 transition-all duration-200 hover:border-[var(--border-hover)] hover:shadow-[var(--shadow-md)] hover:-translate-y-px cursor-default">
            <div className="mb-3 flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-[13px] font-medium text-[var(--text-tertiary)]">
                <svg className="h-[15px] w-[15px]" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/></svg>
                Bins gesamt
              </span>
            </div>
            <div className="text-[28px] font-bold tracking-tight leading-tight text-[var(--text-primary)] mb-1.5">{kpiStats.total}</div>
            <span className="inline-flex items-center gap-1 rounded-full bg-[var(--success-bg)] px-2 py-0.5 text-[12px] font-semibold text-[var(--success)]">
              <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><path d="M5 2l3 4H2z"/></svg>
              Zone {selectedZone.zone}/{selectedZone.etage}
            </span>
          </div>

          {/* Occupied */}
          <div className="group relative overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 transition-all duration-200 hover:border-[var(--border-hover)] hover:shadow-[var(--shadow-md)] hover:-translate-y-px cursor-default">
            <div className="mb-3 flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-[13px] font-medium text-[var(--text-tertiary)]">
                <svg className="h-[15px] w-[15px]" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 14V6l6-4 6 4v8"/><path d="M6 14v-4h4v4"/></svg>
                Belegt
              </span>
            </div>
            <div className="text-[28px] font-bold tracking-tight leading-tight text-[var(--text-primary)] mb-1.5">{kpiStats.occupied}</div>
            <span className="inline-flex items-center gap-1 rounded-full bg-[var(--warning-bg)] px-2 py-0.5 text-[12px] font-semibold text-[var(--warning)]">
              <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><path d="M2 5h6"/></svg>
              {kpiStats.utilization}% Auslastung
            </span>
          </div>

          {/* Free Slots */}
          <div className="group relative overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 transition-all duration-200 hover:border-[var(--border-hover)] hover:shadow-[var(--shadow-md)] hover:-translate-y-px cursor-default">
            <div className="mb-3 flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-[13px] font-medium text-[var(--text-tertiary)]">
                <svg className="h-[15px] w-[15px]" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="2" width="12" height="12" rx="2"/><path d="M5 5l6 6M11 5l-6 6" opacity="0.3"/></svg>
                Freie Plaetze
              </span>
            </div>
            <div className="text-[28px] font-bold tracking-tight leading-tight text-[var(--text-primary)] mb-1.5">{kpiStats.empty}</div>
            <span className="inline-flex items-center gap-1 rounded-full bg-[var(--error-bg)] px-2 py-0.5 text-[12px] font-semibold text-[var(--error)]">
              <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><path d="M5 8l3-4H2z"/></svg>
              {kpiStats.empty} frei
            </span>
          </div>

          {/* Utilization with progress bar */}
          <div className="group relative overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 transition-all duration-200 hover:border-[var(--border-hover)] hover:shadow-[var(--shadow-md)] hover:-translate-y-px cursor-default">
            <div className="mb-3 flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-[13px] font-medium text-[var(--text-tertiary)]">
                <svg className="h-[15px] w-[15px]" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="8" cy="8" r="6"/><path d="M8 4v4l3 2"/></svg>
                Auslastung
              </span>
            </div>
            <div className="text-[28px] font-bold tracking-tight leading-tight text-[var(--text-primary)] mb-1.5">{kpiStats.utilization}%</div>
            <div className="mt-2">
              <div className="h-1.5 rounded-full bg-[var(--surface-secondary)] overflow-hidden">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-[var(--avy-purple)] to-[var(--info)] transition-all duration-700"
                  style={{ width: `${kpiStats.utilization}%` }}
                />
              </div>
              <div className="mt-1 flex justify-between text-[11px] font-medium text-[var(--text-tertiary)]">
                <span>{kpiStats.occupied} / {kpiStats.total} Bins</span>
                <span>{kpiStats.utilization}%</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ---- Search & Filter Bar ---- */}
      {selectedZone && (
        <div className="flex flex-wrap items-center gap-3">
          {/* Search Input */}
          <div className="flex min-w-[260px] max-w-[420px] flex-1 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3.5 py-[7px] transition focus-within:border-[var(--avy-purple)] focus-within:shadow-[var(--shadow-focus)]">
            <svg className="h-[15px] w-[15px] shrink-0 text-[var(--text-tertiary)]" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="7" cy="7" r="4.5"/><path d="M11 11l3 3"/></svg>
            <input
              type="text"
              placeholder="Bin-ID, Produkt oder SKU suchen..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="flex-1 border-none bg-transparent text-[13px] font-medium text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)]"
            />
          </div>

          {/* Filter Chips */}
          {[
            { key: 'all' as const, label: 'Alle' },
            { key: 'occupied' as const, label: 'Belegt' },
            { key: 'empty' as const, label: 'Leer' },
            { key: 'overflow' as const, label: 'Ueberlauf' },
          ].map((chip) => (
            <button
              key={chip.key}
              type="button"
              onClick={() => setFilterMode(chip.key)}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-semibold transition ${
                filterMode === chip.key
                  ? 'border-[var(--avy-purple)] bg-[rgba(99,91,255,0.12)] text-[var(--avy-purple)]'
                  : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)] hover:border-[var(--border-hover)] hover:text-[var(--text-primary)]'
              }`}
            >
              {chip.key === 'overflow' ? (
                <svg className="h-3 w-3" viewBox="0 0 12 12" fill="none" stroke="var(--error)" strokeWidth="1.5"><path d="M6 1l5 10H1z"/></svg>
              ) : (
                <svg className="h-3 w-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="1" y="1" width="10" height="10" rx="2" fill={chip.key === 'occupied' ? 'currentColor' : 'none'} opacity={chip.key === 'occupied' ? 0.2 : 1}/></svg>
              )}
              {chip.label}
            </button>
          ))}

          {/* Batch selection buttons */}
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={selectAllInZone}
              className="rounded-md px-2.5 py-1 text-[12px] font-medium text-[var(--text-secondary)] transition hover:bg-[var(--surface-secondary)] hover:text-[var(--text-primary)]"
            >
              Zone markieren
            </button>
            <button
              type="button"
              onClick={selectCurrentGang}
              disabled={selectedGang == null}
              className="rounded-md px-2.5 py-1 text-[12px] font-medium text-[var(--text-secondary)] transition hover:bg-[var(--surface-secondary)] hover:text-[var(--text-primary)] disabled:opacity-40"
            >
              Gang markieren
            </button>
            <button
              type="button"
              onClick={clearSelection}
              className="rounded-md px-2.5 py-1 text-[12px] font-medium text-[var(--text-secondary)] transition hover:bg-[var(--surface-secondary)] hover:text-[var(--text-primary)]"
            >
              Auswahl leeren
            </button>
            {selectedCount > 0 && (
              <span className="rounded-full bg-[var(--avy-purple)] px-2.5 py-0.5 text-[11px] font-semibold text-white">
                {selectedCount} ausgewahlt
              </span>
            )}
          </div>
        </div>
      )}

      {/* ---- Zone Tabs ---- */}
      {zones.length > 0 && (
        <div className="relative">
          <div className="flex gap-2 overflow-x-auto pb-0.5 scrollbar-none" style={{ scrollbarWidth: 'none' }}>
            {zones.map((zone) => {
              const isActive = selectedZone?.id === zone.id;
              const zoneColor = ZONE_COLORS[zone.zone] || 'var(--avy-purple)';
              return (
                <button
                  key={zone.id}
                  type="button"
                  onClick={() => {
                    setSelectedZone(zone);
                    setSearchTerm('');
                    setFilterMode('all');
                  }}
                  className={`flex min-w-max items-center gap-2 whitespace-nowrap rounded-xl border px-5 py-2.5 transition-all duration-200 ${
                    isActive
                      ? 'border-[var(--avy-purple)] bg-[rgba(99,91,255,0.12)] shadow-[var(--shadow-focus)]'
                      : 'border-[var(--border)] bg-[var(--surface)] hover:border-[var(--border-hover)] hover:shadow-[var(--shadow-sm)] hover:-translate-y-px'
                  }`}
                >
                  <div
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[13px] font-bold text-white"
                    style={{ background: zoneColor }}
                  >
                    {zone.zone}
                  </div>
                  <div className="flex flex-col items-start">
                    <span className={`text-[13px] font-semibold ${isActive ? 'text-[var(--avy-purple)]' : 'text-[var(--text-primary)]'}`}>
                      Zone {zone.zone} / {zone.etage}
                    </span>
                    <span className="text-[11px] font-medium text-[var(--text-tertiary)]">
                      {zone.binCount} Bins
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* ---- Warehouse Main: Grid + Detail Panel ---- */}
      {selectedZone && (
        <div className={`grid gap-6 ${selectedBin ? 'grid-cols-1 xl:grid-cols-[1fr_380px]' : 'grid-cols-1'}`}>
          {/* Grid Container */}
          <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
            {/* Grid Header */}
            <div className="flex items-center justify-between border-b border-[var(--border)] px-6 py-4">
              <div className="flex items-center">
                <span className="text-[14px] font-semibold text-[var(--text-primary)]">Bin-Raster</span>
                <span className="ml-2 text-[12px] font-medium text-[var(--text-tertiary)]">
                  Zone {selectedZone.zone} / {selectedZone.etage} -- {filteredBins.length} Bins
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                {/* Structure delete actions */}
                <button
                  type="button"
                  disabled={selectedGang == null || deletingStructure}
                  onClick={handleDeleteGang}
                  className="inline-flex items-center gap-1 rounded-md border border-[var(--error-border)] bg-transparent px-2.5 py-1 text-[12px] font-semibold text-[var(--error)] transition hover:bg-[var(--error-bg)] hover:border-[var(--error)] disabled:opacity-40"
                >
                  <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 4h10M5 4V3a1 1 0 011-1h2a1 1 0 011 1v1M4 4v8a1 1 0 001 1h4a1 1 0 001-1V4"/></svg>
                  Gang
                </button>
                <button
                  type="button"
                  disabled={selectedGang == null || selectedRegal == null || deletingStructure}
                  onClick={handleDeleteRegal}
                  className="inline-flex items-center gap-1 rounded-md border border-[var(--error-border)] bg-transparent px-2.5 py-1 text-[12px] font-semibold text-[var(--error)] transition hover:bg-[var(--error-bg)] hover:border-[var(--error)] disabled:opacity-40"
                >
                  <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 4h10M5 4V3a1 1 0 011-1h2a1 1 0 011 1v1M4 4v8a1 1 0 001 1h4a1 1 0 001-1V4"/></svg>
                  Regal
                </button>
                <button
                  type="button"
                  disabled={!selectedBin || deletingStructure}
                  onClick={handleDeleteEbene}
                  className="inline-flex items-center gap-1 rounded-md border border-[var(--error-border)] bg-transparent px-2.5 py-1 text-[12px] font-semibold text-[var(--error)] transition hover:bg-[var(--error-bg)] hover:border-[var(--error)] disabled:opacity-40"
                >
                  <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 4h10M5 4V3a1 1 0 011-1h2a1 1 0 011 1v1M4 4v8a1 1 0 001 1h4a1 1 0 001-1V4"/></svg>
                  Ebene
                </button>
              </div>
            </div>

            {/* Grid Body */}
            <div className="overflow-x-auto p-5">
              {isLoadingBins ? (
                <div className="flex items-center justify-center py-12 text-[var(--text-tertiary)]">
                  <svg className="mr-2 h-5 w-5 animate-spin" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
                  Lade Bins...
                </div>
              ) : filteredBins.length === 0 ? (
                <div className="py-12 text-center text-[14px] text-[var(--text-tertiary)]">
                  {searchTerm || filterMode !== 'all' ? 'Keine Bins gefunden.' : 'Keine Bins in dieser Zone.'}
                </div>
              ) : (
                <div className="min-w-[600px]">
                  {Array.from(gridData.entries())
                    .sort(([a], [b]) => a - b)
                    .map(([gang, regalMap]) => {
                      const sortedRegale = Array.from(regalMap.keys()).sort((a, b) => a - b);
                      // Collect all ebenen across all regale in this gang
                      const allEbenen = new Set<string>();
                      regalMap.forEach((binList) => binList.forEach((bin) => allEbenen.add(bin.ebene)));
                      const sortedEbenen = Array.from(allEbenen).sort();

                      const colTemplate = `42px repeat(${sortedRegale.length}, 1fr)`;

                      return (
                        <div key={gang} className="mb-5 last:mb-0">
                          {/* Aisle label */}
                          <div className="mb-3 inline-flex items-center gap-1.5 rounded-full bg-[var(--surface-secondary)] px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider text-[var(--text-tertiary)]">
                            <svg className="h-3 w-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 6h8M6 2v8"/></svg>
                            Gang {String(gang).padStart(2, '0')}
                          </div>

                          {/* Shelf headers */}
                          <div className="mb-1.5" style={{ display: 'grid', gridTemplateColumns: colTemplate, gap: '6px' }}>
                            <div />
                            {sortedRegale.map((regal) => (
                              <button
                                key={regal}
                                type="button"
                                onClick={() => {
                                  setSelectedGang(gang);
                                  setSelectedRegal(regal);
                                }}
                                className={`text-center text-[10px] font-bold uppercase tracking-wide transition ${
                                  selectedGang === gang && selectedRegal === regal
                                    ? 'text-[var(--avy-purple)]'
                                    : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]'
                                }`}
                              >
                                Regal {String(regal).padStart(2, '0')}
                              </button>
                            ))}
                          </div>

                          {/* Bin rows by level */}
                          {sortedEbenen.map((ebene) => (
                            <div
                              key={ebene}
                              className="mb-1.5 items-center"
                              style={{ display: 'grid', gridTemplateColumns: colTemplate, gap: '6px' }}
                            >
                              {/* Level label */}
                              <div className="pr-2 text-right text-[10px] font-bold uppercase tracking-wide text-[var(--text-tertiary)]">
                                {ebene}
                              </div>

                              {/* Bin cells per regal */}
                              {sortedRegale.map((regal) => {
                                const bin = regalMap.get(regal)?.find((b) => b.ebene === ebene);
                                if (!bin) return <div key={regal} className="min-h-[56px]" />;

                                const state = getBinState(bin);
                                const pct = getBinFillPercent(bin);
                                const fillColor = getFillBarColor(pct);
                                const isActive = selectedBin?.code === bin.code;
                                const isMarked = selectedBinCodes.has(bin.code);

                                const stateClasses: Record<string, string> = {
                                  empty: 'bg-[var(--surface-secondary)] border-[var(--border)]',
                                  partial: 'bg-[var(--surface)] border-[var(--border)] border-l-[3px] border-l-[var(--info)]',
                                  full: 'bg-[var(--surface)] border-[var(--border)] border-l-[3px] border-l-[var(--avy-purple)]',
                                  overflow: 'bg-[var(--error-bg)] border-[var(--error-border)] border-l-[3px] border-l-[var(--error)]',
                                };

                                return (
                                  <div key={regal} className="relative">
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setSelectedGang(gang);
                                        setSelectedRegal(regal);
                                        handleSelectBin(bin);
                                      }}
                                      className={`flex w-full flex-col justify-between rounded-lg p-1.5 transition-all duration-200 aspect-[4/3] min-h-[56px] border-[1.5px] cursor-pointer relative overflow-hidden ${stateClasses[state]} ${
                                        isActive
                                          ? 'border-[var(--avy-purple)] shadow-[0_0_0_3px_rgba(99,91,255,0.12),var(--shadow-md)] -translate-y-0.5 scale-[1.02] z-[3]'
                                          : 'hover:border-[var(--border-hover)] hover:shadow-[var(--shadow-md)] hover:-translate-y-0.5 hover:scale-[1.02] hover:z-[2]'
                                      } ${isMarked ? 'ring-2 ring-[var(--success)]' : ''}`}
                                    >
                                      {/* Bin ID */}
                                      <span className={`font-mono text-[10px] font-semibold tracking-wide ${state === 'empty' ? 'text-[var(--text-tertiary)]' : 'text-[var(--text-secondary)]'}`}>
                                        {bin.code}
                                      </span>

                                      {/* Empty icon */}
                                      {state === 'empty' && (
                                        <div className="flex flex-1 items-center justify-center opacity-40 text-[var(--text-tertiary)]">
                                          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1"><rect x="3" y="3" width="8" height="8" rx="1.5" strokeDasharray="2 2"/></svg>
                                        </div>
                                      )}

                                      {/* Bottom: count + fill bar */}
                                      <div className="flex items-end justify-between gap-1">
                                        <span className={`text-[10px] font-semibold ${
                                          state === 'partial' ? 'text-[var(--info)]'
                                            : state === 'full' ? 'text-[var(--avy-purple)]'
                                              : state === 'overflow' ? 'text-[var(--error)]'
                                                : 'text-[var(--text-tertiary)]'
                                        }`}>
                                          {bin.productCount > 0 ? `${bin.productCount} Stk` : ''}
                                        </span>
                                        {bin.productCount > 0 && (
                                          <div className="h-[3px] w-full max-w-[40px] overflow-hidden rounded bg-[var(--border)]">
                                            <div className={`h-full rounded transition-all duration-500 ${fillColor}`} style={{ width: `${pct}%` }} />
                                          </div>
                                        )}
                                      </div>
                                    </button>

                                    {/* Selection toggle */}
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        toggleBinSelection(bin.code);
                                      }}
                                      className={`absolute -right-1.5 -top-1.5 z-10 flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold transition ${
                                        isMarked
                                          ? 'bg-[var(--success)] text-white shadow-sm'
                                          : 'border border-[var(--border)] bg-[var(--surface)] text-[var(--text-tertiary)] opacity-0 group-hover:opacity-100 hover:border-[var(--border-hover)]'
                                      }`}
                                      style={isMarked ? {} : { opacity: 1 }}
                                      title={isMarked ? 'Aus Auswahl entfernen' : 'Zur Auswahl hinzufugen'}
                                    >
                                      {isMarked ? '\u2713' : '+'}
                                    </button>
                                  </div>
                                );
                              })}
                            </div>
                          ))}
                        </div>
                      );
                    })}
                </div>
              )}
            </div>
          </div>

          {/* Detail Panel */}
          {selectedBin && (
            <div className="sticky top-[76px] max-h-[calc(100vh-100px)] overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--surface)]">
              {/* Panel Header */}
              <div className="flex items-start justify-between border-b border-[var(--border)] p-5 pb-4">
                <div>
                  <div className="font-mono text-[18px] font-bold text-[var(--text-primary)]">
                    {binDetail?.code || selectedBin.code}
                  </div>
                  <div className="mt-1 text-[12px] font-medium text-[var(--text-tertiary)]">
                    Zone {selectedBin.zone} / {selectedBin.etage}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleCloseDetailPanel}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-tertiary)] transition hover:bg-[var(--surface-secondary)] hover:text-[var(--text-primary)]"
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M4 4l8 8M12 4l-8 8"/></svg>
                </button>
              </div>

              {/* Location Section */}
              <div className="border-b border-[var(--border)] p-5 py-4">
                <div className="mb-3 text-[11px] font-bold uppercase tracking-wide text-[var(--text-tertiary)]">Standort</div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <div className="text-[11px] font-medium text-[var(--text-tertiary)]">Zone</div>
                    <div className="text-[14px] font-semibold text-[var(--text-primary)]">{selectedBin.zone}</div>
                  </div>
                  <div>
                    <div className="text-[11px] font-medium text-[var(--text-tertiary)]">Gang</div>
                    <div className="text-[14px] font-semibold text-[var(--text-primary)]">{String(selectedBin.gang).padStart(2, '0')}</div>
                  </div>
                  <div>
                    <div className="text-[11px] font-medium text-[var(--text-tertiary)]">Regal</div>
                    <div className="text-[14px] font-semibold text-[var(--text-primary)]">{String(selectedBin.regal).padStart(2, '0')}</div>
                  </div>
                  <div>
                    <div className="text-[11px] font-medium text-[var(--text-tertiary)]">Ebene</div>
                    <div className="text-[14px] font-semibold text-[var(--text-primary)]">{selectedBin.ebene}</div>
                  </div>
                </div>
              </div>

              {/* Capacity Section */}
              <div className="border-b border-[var(--border)] p-5 py-4">
                <div className="mb-3 text-[11px] font-bold uppercase tracking-wide text-[var(--text-tertiary)]">Kapazitaet</div>
                <div className="flex items-center justify-between text-[12px] mb-1.5">
                  <span className="font-medium text-[var(--text-secondary)]">Belegung</span>
                  <span className="font-bold text-[var(--text-primary)]">
                    {binDetail?.productCount ?? selectedBin.productCount} Produkte
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded bg-[var(--surface-secondary)]">
                  <div
                    className="h-full rounded bg-[var(--avy-purple)] transition-all duration-500"
                    style={{ width: `${getBinFillPercent(selectedBin)}%` }}
                  />
                </div>
                {binDetail?.firstStoredAt && (
                  <div className="mt-2 text-[11px] text-[var(--text-tertiary)]">
                    Erstmalig eingelagert: {new Date(binDetail.firstStoredAt).toLocaleString('de-DE')}
                  </div>
                )}
              </div>

              {/* Products Section */}
              <div className="border-b border-[var(--border)] p-5 py-4">
                <div className="mb-3 text-[11px] font-bold uppercase tracking-wide text-[var(--text-tertiary)]">
                  Produkte in diesem Bin
                </div>
                {binDetail?.products?.length ? (
                  <div className="space-y-2 max-h-[240px] overflow-y-auto">
                    {binDetail.products.map((item: any) => (
                      <div
                        key={item.productId}
                        className="flex items-center gap-3 rounded-lg bg-[var(--surface-secondary)] p-3 transition hover:bg-[var(--surface-hover)] hover:shadow-[var(--shadow-sm)]"
                      >
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-[var(--border)] bg-[var(--surface)] text-[14px] text-[var(--text-tertiary)]">
                          {item.name?.charAt(0) || 'P'}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[13px] font-semibold text-[var(--text-primary)]">{item.name}</div>
                          <div className="font-mono text-[11px] text-[var(--text-tertiary)]">SKU {item.sku}</div>
                        </div>
                        <div className="text-right">
                          <div className="text-[13px] font-bold text-[var(--avy-purple)]">{item.quantity} Stk</div>
                          <button
                            type="button"
                            onClick={() => handleRemoveProduct(item.productId)}
                            disabled={removingProductId === item.productId}
                            className="text-[11px] font-medium text-[var(--error)] transition hover:opacity-80 disabled:opacity-40"
                          >
                            {removingProductId === item.productId ? '...' : 'Entfernen'}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="py-5 text-center text-[13px] text-[var(--text-tertiary)]">
                    Kein Produkt eingelagert
                  </div>
                )}
              </div>

              {/* Actions Section */}
              <div className="flex flex-col gap-2 p-5 py-4">
                <button
                  type="button"
                  onClick={() => openBinLabelWindow(selectedBin.code)}
                  className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-[var(--avy-purple)] px-4 py-2 text-[13px] font-semibold text-white transition hover:bg-[var(--avy-purple-hover)] hover:-translate-y-px hover:shadow-[0_4px_12px_rgba(99,91,255,0.3)] active:translate-y-0"
                >
                  <PrintIcon className="h-3.5 w-3.5" />
                  BIN Label drucken
                </button>
                <button
                  type="button"
                  disabled={!selectedBin || deletingStructure}
                  onClick={handleDeleteEbene}
                  className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-[var(--error-border)] bg-transparent px-4 py-2 text-[13px] font-semibold text-[var(--error)] transition hover:bg-[var(--error-bg)] hover:border-[var(--error)] disabled:opacity-40"
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 4h10M5 4V3a1 1 0 011-1h2a1 1 0 011 1v1M4 4v8a1 1 0 001 1h4a1 1 0 001-1V4"/></svg>
                  Ebene loschen
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ---- Legend ---- */}
      {selectedZone && bins.length > 0 && (
        <div className="flex flex-wrap items-center gap-5 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-6 py-4">
          <span className="text-[11px] font-bold uppercase tracking-wide text-[var(--text-tertiary)]">Legende</span>

          <div className="flex items-center gap-1.5 text-[12px] font-medium text-[var(--text-secondary)]">
            <div className="h-3 w-4 rounded-[3px] border-[1.5px] border-[var(--border)] bg-[var(--surface-secondary)]" />
            Leer
          </div>
          <div className="flex items-center gap-1.5 text-[12px] font-medium text-[var(--text-secondary)]">
            <div className="h-3 w-4 rounded-[3px] border-[1.5px] border-[var(--info)] border-l-[3px] bg-[var(--surface)]" />
            Teilbelegt
          </div>
          <div className="flex items-center gap-1.5 text-[12px] font-medium text-[var(--text-secondary)]">
            <div className="h-3 w-4 rounded-[3px] border-[1.5px] border-[var(--avy-purple)] border-l-[3px] bg-[var(--surface)]" />
            Voll (&gt;80%)
          </div>
          <div className="flex items-center gap-1.5 text-[12px] font-medium text-[var(--text-secondary)]">
            <div className="h-3 w-4 rounded-[3px] border-[1.5px] border-[var(--error-border)] border-l-[3px] bg-[var(--error-bg)]" />
            Ueberlauf
          </div>

          <div className="h-5 w-px bg-[var(--border)]" />

          <div className="flex items-center gap-1.5 text-[12px] font-medium text-[var(--text-secondary)]">
            <div className="h-[3px] w-5 rounded bg-[var(--success)]" />
            &lt;50%
          </div>
          <div className="flex items-center gap-1.5 text-[12px] font-medium text-[var(--text-secondary)]">
            <div className="h-[3px] w-5 rounded bg-[var(--warning)]" />
            50-80%
          </div>
          <div className="flex items-center gap-1.5 text-[12px] font-medium text-[var(--text-secondary)]">
            <div className="h-[3px] w-5 rounded bg-[var(--error)]" />
            &gt;80%
          </div>
        </div>
      )}
    </section>
  );
};

export default WarehouseView;

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

  // Compute KPI values from zones data
  const totalBins = zones.reduce((sum, z) => sum + (z.binCount || 0), 0);
  const totalProducts = zones.reduce((sum, z) => sum + (z.totalProducts || 0), 0);
  const occupiedBins = bins.filter((b) => b.productCount > 0).length;
  const freeBins = bins.length - occupiedBins;
  const occupancyPct = bins.length > 0 ? ((occupiedBins / bins.length) * 100).toFixed(1) : '0';

  return (
    <section className="content">
      {/* ── Page Header ── */}
      <div className="page-header">
        <div>
          <h1>Warehouse</h1>
          <div className="page-header-sub">Lagerverwaltung &amp; Bin-Uebersicht</div>
        </div>
        <div className="page-header-actions">
          <HelpDisclosure title="Wie nutze ich Warehouse? (2 Minuten)">
            <ol style={{ paddingLeft: '1.25rem', display: 'flex', flexDirection: 'column', gap: '4px', listStyle: 'decimal' }}>
              <li>
                <b>Zone/Etage wählen</b> → du siehst alle BINs in diesem Bereich.
              </li>
              <li>
                <b>Gang → Regal → BIN</b> auswählen → Details & enthaltene Produkte erscheinen rechts/unten.
              </li>
              <li>
                <b>Labels drucken</b>: wähle BINs (Checkbox) oder nutze "Zone/Gang/Regal markieren".
              </li>
              <li>
                <b>Aufräumen</b>: Produkte aus BINs entfernen oder (leer) Struktur löschen.
              </li>
            </ol>
          </HelpDisclosure>
        </div>
      </div>

      {zones.length === 0 ? (
        <Notice tone="info" title="Noch keine Lagerstruktur">
          Lege zuerst eine Zone/Etage-Struktur an (unten: „Neue Lagerstruktur anlegen"). Danach kannst du Bins auswählen und Labels drucken.
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

      {/* ── KPI Cards ── */}
      <div className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-top">
            <div className="kpi-label">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="2" width="5" height="5" rx="1" /><rect x="9" y="2" width="5" height="5" rx="1" /><rect x="2" y="9" width="5" height="5" rx="1" /><rect x="9" y="9" width="5" height="5" rx="1" /></svg>
              Bins gesamt
            </div>
          </div>
          <div className="kpi-value">{totalBins}</div>
          <span className="kpi-change up">{zones.length} Zonen aktiv</span>
        </div>
        <div className="kpi-card">
          <div className="kpi-top">
            <div className="kpi-label">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 14V6l6-4 6 4v8" /><path d="M6 14v-4h4v4" /></svg>
              Produkte gesamt
            </div>
          </div>
          <div className="kpi-value">{totalProducts}</div>
          <span className="kpi-change neutral">Alle Zonen</span>
        </div>
        <div className="kpi-card">
          <div className="kpi-top">
            <div className="kpi-label">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="2" width="12" height="12" rx="2" /><path d="M5 5l6 6M11 5l-6 6" opacity="0.3" /></svg>
              Freie Bins
            </div>
          </div>
          <div className="kpi-value">{freeBins}</div>
          <span className="kpi-change down">{selectedZone ? `${selectedZone.zone}/${selectedZone.etage}` : '--'}</span>
        </div>
        <div className="kpi-card">
          <div className="kpi-top">
            <div className="kpi-label">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="8" cy="8" r="6" /><path d="M8 4v4l3 2" /></svg>
              Auslastung
            </div>
          </div>
          <div className="kpi-value">{occupancyPct}%</div>
          <div className="kpi-progress-wrap">
            <div className="kpi-progress-bar"><div className="kpi-progress-fill" style={{ width: `${occupancyPct}%` }} /></div>
            <div className="kpi-progress-label"><span>{occupiedBins} / {bins.length} Bins</span><span>{occupancyPct}%</span></div>
          </div>
        </div>
      </div>

      {/* ── BIN Selection & Print Card ── */}
      <div className="card" style={{ marginBottom: 'var(--space-6)' }}>
        <div className="card-header">
          <span className="card-title">BIN-Auswahl &amp; Druck</span>
          <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>
            Bereich: {selectedZone ? `${selectedZone.zone}/${selectedZone.etage}` : '\u2014'}
            {selectedGang != null ? ` \u00B7 Gang ${selectedGang}` : ''}
            {selectedRegal != null ? ` \u00B7 Regal ${selectedRegal}` : ''}
          </span>
        </div>
        <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
            <button type="button" onClick={selectAllInZone} className="btn btn-secondary btn-sm">
              Zone markieren
            </button>
            <button type="button" onClick={selectCurrentGang} disabled={selectedGang == null} className="btn btn-secondary btn-sm">
              Gang markieren
            </button>
            <button type="button" onClick={selectCurrentRegal} disabled={selectedGang == null || selectedRegal == null} className="btn btn-secondary btn-sm">
              Regal markieren
            </button>
            <button type="button" onClick={clearSelection} className="btn btn-ghost btn-sm">
              Auswahl leeren
            </button>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-3)' }}>
            <span style={{ fontSize: '13px', color: 'var(--text-secondary)', fontWeight: 500 }}>Ausgewählte Bins: {selectedCount}</span>
            <button
              type="button"
              onClick={handlePrintSelectedBins}
              disabled={!selectedCount && !selectedZone}
              className="btn btn-success"
            >
              <PrintIcon className="w-4 h-4" />
              BIN Labels drucken
            </button>
          </div>
        </div>
      </div>

      {/* ── New Layout Form Card ── */}
      <div className="card" style={{ marginBottom: 'var(--space-6)' }}>
        <div className="card-header">
          <span className="card-title">Neue Lagerstruktur anlegen</span>
        </div>
        <div className="card-body">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 'var(--space-3)' }}>
            <div className="form-group">
              <label className="form-label">Zone</label>
              <select
                value={layoutForm.zone}
                onChange={(e) => setLayoutForm((prev) => ({ ...prev, zone: e.target.value }))}
                className="form-input"
              >
                {ZONE_OPTIONS.map((z) => (
                  <option key={z} value={z}>{z}</option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Etage</label>
              <select
                value={layoutForm.etage}
                onChange={(e) => setLayoutForm((prev) => ({ ...prev, etage: e.target.value }))}
                className="form-input"
              >
                {ETAGE_OPTIONS.map((e) => (
                  <option key={e} value={e}>{e}</option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Gänge (z.B. 1-3)</label>
              <input
                value={layoutForm.gangs}
                onChange={(e) => setLayoutForm((prev) => ({ ...prev, gangs: e.target.value }))}
                className="form-input"
              />
            </div>
            <div className="form-group">
              <label className="form-label">Regale (z.B. 1-4)</label>
              <input
                value={layoutForm.regale}
                onChange={(e) => setLayoutForm((prev) => ({ ...prev, regale: e.target.value }))}
                className="form-input"
              />
            </div>
            <div className="form-group">
              <label className="form-label">Ebenen (z.B. A-E)</label>
              <input
                value={layoutForm.ebenen}
                onChange={(e) => setLayoutForm((prev) => ({ ...prev, ebenen: e.target.value }))}
                className="form-input"
              />
            </div>
          </div>
          <div style={{ marginTop: 'var(--space-4)' }}>
            <button onClick={handleCreateLayout} className="btn btn-primary">
              Bins generieren
            </button>
          </div>
        </div>
      </div>

      {/* ── Zone Tabs ── */}
      <div className="zone-tabs-wrap" style={{ marginBottom: 'var(--space-5)' }}>
        <div className="zone-tabs-scroll" style={{ display: 'flex', gap: 'var(--space-2)', overflowX: 'auto', paddingBottom: '2px' }}>
          {zones.map((zone) => (
            <button
              key={zone.id}
              onClick={() => setSelectedZone(zone)}
              className={`zone-tab${selectedZone?.id === zone.id ? ' active' : ''}`}
              style={{
                display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 20px',
                background: selectedZone?.id === zone.id ? 'var(--avy-purple-glow)' : 'var(--surface)',
                border: `1px solid ${selectedZone?.id === zone.id ? 'var(--avy-purple)' : 'var(--border)'}`,
                borderRadius: 'var(--radius-lg)', cursor: 'pointer', whiteSpace: 'nowrap',
                transition: 'all var(--transition)',
              }}
            >
              <div style={{
                width: '28px', height: '28px', borderRadius: 'var(--radius-sm)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontWeight: 700, fontSize: '13px', color: 'white', flexShrink: 0,
                background: 'var(--avy-gradient)',
              }}>
                {zone.zone}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <span style={{ fontSize: '13px', fontWeight: 600, color: selectedZone?.id === zone.id ? 'var(--avy-purple)' : 'var(--text-primary)' }}>
                  Zone {zone.zone} / {zone.etage}
                </span>
                <span style={{ fontSize: '11px', color: 'var(--text-tertiary)', fontWeight: 500 }}>
                  {zone.binCount} Bins &middot; {zone.totalProducts || 0} Produkte
                </span>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* ── Warehouse Main Grid ── */}
      {selectedZone && (
        <div className={`warehouse-main${binDetail ? ' with-panel' : ''}`} style={{
          display: 'grid',
          gridTemplateColumns: binDetail ? '1fr 380px' : '1fr',
          gap: 'var(--space-6)',
        }}>
          {/* Grid Container */}
          <div className="card">
            <div className="card-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span className="card-title">
                  Zone {selectedZone.zone} / {selectedZone.etage}
                </span>
                <span style={{ fontSize: '12px', color: 'var(--text-tertiary)', fontWeight: 500 }}>
                  {bins.length} Bins insgesamt
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                {selectedBin && (
                  <button onClick={() => openBinLabelWindow(selectedBin.code)} className="btn btn-success btn-sm">
                    <PrintIcon className="w-4 h-4" /> BIN Label
                  </button>
                )}
              </div>
            </div>
            <div className="card-body">
              {/* Gang tabs */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)', marginBottom: 'var(--space-4)' }}>
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
                      className={`btn btn-sm ${selectedGang === gang ? 'btn-primary' : 'btn-secondary'}`}
                    >
                      Gang {gang}
                    </button>
                  ))}
              </div>

              {/* Delete actions */}
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)', marginBottom: 'var(--space-4)' }}>
                <button
                  type="button"
                  disabled={!selectedZone || selectedGang == null || deletingStructure}
                  onClick={handleDeleteGang}
                  className="btn btn-danger btn-sm"
                  title="Löscht alle leeren Bins in diesem Gang."
                >
                  Gang löschen
                </button>
                <button
                  type="button"
                  disabled={!selectedZone || selectedGang == null || selectedRegal == null || deletingStructure}
                  onClick={handleDeleteRegal}
                  className="btn btn-danger btn-sm"
                  title="Löscht alle leeren Bins in diesem Regal (innerhalb des gewählten Gangs)."
                >
                  Regal löschen
                </button>
                <button
                  type="button"
                  disabled={!selectedZone || !selectedBin || deletingStructure}
                  onClick={handleDeleteEbene}
                  className="btn btn-danger btn-sm"
                  title="Löscht den aktuell ausgewählten BIN (Ebene)."
                >
                  Ebene löschen
                </button>
                <span style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>
                  Löschen ist nur möglich, wenn die betroffenen Bins leer sind.
                </span>
              </div>

              {/* Bin grid */}
              {isLoadingBins ? (
                <div style={{ color: 'var(--text-secondary)', padding: 'var(--space-4)' }}>Lade Bins...</div>
              ) : (
                <div className="wh-grid-wrapper">
                  {regaleForSelectedGang.map(({ regal, bins: binList }) => (
                    <div key={regal} className="wh-aisle" style={{ marginBottom: 'var(--space-5)' }}>
                      <button
                        className="wh-aisle-label"
                        onClick={() => {
                          setSelectedRegal(regal);
                          setSelectedBin(null);
                          setBinDetail(null);
                        }}
                        style={{
                          display: 'inline-flex', alignItems: 'center', gap: '6px',
                          fontSize: '11px', fontWeight: 700, color: 'var(--text-tertiary)',
                          textTransform: 'uppercase', letterSpacing: '0.06em',
                          marginBottom: 'var(--space-3)', padding: '3px 10px',
                          background: selectedRegal === regal ? 'var(--avy-purple-glow)' : 'var(--surface-secondary)',
                          borderRadius: '20px', border: 'none', cursor: 'pointer',
                          transition: 'all var(--transition)',
                        }}
                      >
                        Regal {regal}
                      </button>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(80px, 1fr))', gap: '6px' }}>
                        {binList.map((bin) => {
                          const isActive = selectedBin?.code === bin.code;
                          const isMarked = selectedBinCodes.has(bin.code);
                          const binState = bin.productCount === 0 ? 'empty' : 'partial';
                          return (
                            <div key={bin.code} style={{ position: 'relative' }}>
                              <button
                                onClick={() => handleSelectBin(bin)}
                                className={`bin-cell ${binState}${isActive ? ' selected' : ''}`}
                                style={{
                                  width: '100%', aspectRatio: '4/3', minHeight: '56px',
                                  background: isActive ? 'var(--avy-purple-glow)' : (binState === 'empty' ? 'var(--surface-secondary)' : 'var(--surface)'),
                                  border: `1.5px solid ${isActive ? 'var(--avy-purple)' : 'var(--border)'}`,
                                  borderRadius: 'var(--radius-md)', padding: '6px 8px',
                                  cursor: 'pointer', transition: 'all 200ms cubic-bezier(0.4, 0, 0.2, 1)',
                                  display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
                                  position: 'relative', overflow: 'hidden',
                                  boxShadow: isActive ? 'var(--shadow-focus), var(--shadow-md)' : (isMarked ? '0 0 0 2px var(--success)' : 'none'),
                                }}
                              >
                                <div style={{ fontFamily: "'SF Mono', 'Fira Code', monospace", fontSize: '10px', fontWeight: 600, color: binState === 'empty' ? 'var(--text-tertiary)' : 'var(--text-secondary)', letterSpacing: '0.02em' }}>
                                  {bin.ebene}
                                </div>
                                <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '4px' }}>
                                  <span style={{ fontSize: '10px', fontWeight: 600, color: bin.productCount > 0 ? 'var(--avy-purple)' : 'var(--text-tertiary)' }}>
                                    {bin.productCount} Stk
                                  </span>
                                </div>
                              </button>
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  toggleBinSelection(bin.code);
                                }}
                                style={{
                                  position: 'absolute', top: '-8px', right: '-8px',
                                  width: '22px', height: '22px', borderRadius: '50%',
                                  fontSize: '11px', fontWeight: 700, border: 'none', cursor: 'pointer',
                                  background: isMarked ? 'var(--success)' : 'var(--surface-secondary)',
                                  color: isMarked ? 'white' : 'var(--text-secondary)',
                                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                                  transition: 'all 150ms ease',
                                }}
                                title={isMarked ? 'Aus Auswahl entfernen' : 'Zur Auswahl hinzufügen'}
                              >
                                {isMarked ? '\u2713' : '+'}
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Detail Panel */}
          {binDetail && (
            <div className="detail-panel active" style={{
              background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)',
              position: 'sticky', top: '76px', maxHeight: 'calc(100vh - 100px)', overflowY: 'auto',
              display: 'block',
            }}>
              <div className="detail-panel-header" style={{
                padding: 'var(--space-5) var(--space-5) var(--space-4)',
                borderBottom: '1px solid var(--border)', display: 'flex',
                alignItems: 'flex-start', justifyContent: 'space-between',
              }}>
                <div className="detail-panel-title" style={{
                  fontFamily: "'SF Mono', 'Fira Code', monospace",
                  fontSize: '18px', fontWeight: 700, color: 'var(--text-primary)',
                }}>
                  {binDetail.code}
                </div>
                <button
                  className="btn btn-ghost btn-icon btn-sm"
                  onClick={() => { setSelectedBin(null); setBinDetail(null); }}
                  title="Schliessen"
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M4 4l8 8M12 4l-8 8" /></svg>
                </button>
              </div>

              {/* Location section */}
              <div className="detail-section" style={{ padding: 'var(--space-4) var(--space-5)', borderBottom: '1px solid var(--border)' }}>
                <div className="detail-section-title" style={{
                  fontSize: '11px', fontWeight: 700, color: 'var(--text-tertiary)',
                  textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 'var(--space-3)',
                }}>Standort</div>
                <div className="detail-meta-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' }}>
                  <div>
                    <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', fontWeight: 500, marginBottom: '2px' }}>Gang</div>
                    <div style={{ fontSize: '14px', color: 'var(--text-primary)', fontWeight: 600 }}>{binDetail.gang}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', fontWeight: 500, marginBottom: '2px' }}>Regal</div>
                    <div style={{ fontSize: '14px', color: 'var(--text-primary)', fontWeight: 600 }}>{binDetail.regal}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', fontWeight: 500, marginBottom: '2px' }}>Ebene</div>
                    <div style={{ fontSize: '14px', color: 'var(--text-primary)', fontWeight: 600 }}>{binDetail.ebene}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', fontWeight: 500, marginBottom: '2px' }}>Eingelagert seit</div>
                    <div style={{ fontSize: '14px', color: 'var(--text-primary)', fontWeight: 600 }}>
                      {binDetail.firstStoredAt ? new Date(binDetail.firstStoredAt).toLocaleString('de-DE') : 'leer'}
                    </div>
                  </div>
                </div>
              </div>

              {/* Capacity section */}
              <div className="detail-section" style={{ padding: 'var(--space-4) var(--space-5)', borderBottom: '1px solid var(--border)' }}>
                <div className="detail-section-title" style={{
                  fontSize: '11px', fontWeight: 700, color: 'var(--text-tertiary)',
                  textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 'var(--space-3)',
                }}>Kapazität</div>
                <div style={{ fontSize: '14px', color: 'var(--text-primary)', fontWeight: 600 }}>
                  {binDetail.productCount || 0} Produkte
                </div>
              </div>

              {/* Actions */}
              <div className="detail-section" style={{ padding: 'var(--space-4) var(--space-5)', borderBottom: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                  <button
                    type="button"
                    disabled={!selectedBin || deletingStructure}
                    onClick={handleDeleteEbene}
                    className="btn btn-danger btn-sm"
                    title="Löscht diesen BIN (nur wenn leer)"
                  >
                    Ebene löschen
                  </button>
                  <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>Nur möglich, wenn der BIN leer ist.</span>
                </div>
              </div>

              {/* Products section */}
              <div className="detail-section" style={{ padding: 'var(--space-4) var(--space-5)' }}>
                <div className="detail-section-title" style={{
                  fontSize: '11px', fontWeight: 700, color: 'var(--text-tertiary)',
                  textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 'var(--space-3)',
                }}>Produkte in diesem Bin</div>
                {binDetail.products?.length ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', maxHeight: '240px', overflowY: 'auto' }}>
                    {binDetail.products.map((item: any) => (
                      <div key={item.productId} className="detail-product" style={{
                        display: 'flex', alignItems: 'center', gap: 'var(--space-3)', padding: 'var(--space-3)',
                        background: 'var(--surface-secondary)', borderRadius: 'var(--radius-md)',
                        transition: 'all 150ms',
                      }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {item.name}
                          </div>
                          <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', fontFamily: "'SF Mono', monospace" }}>
                            SKU {item.sku} &middot; Menge {item.quantity}
                          </div>
                        </div>
                        <button
                          onClick={() => handleRemoveProduct(item.productId)}
                          disabled={removingProductId === item.productId}
                          className="btn btn-danger btn-sm"
                          style={{ flexShrink: 0 }}
                        >
                          {removingProductId === item.productId ? '...' : 'Entfernen'}
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{ fontSize: '13px', color: 'var(--text-tertiary)' }}>Keine Produkte eingelagert.</div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Legend */}
      <div className="legend" style={{
        display: 'flex', alignItems: 'center', gap: 'var(--space-5)', flexWrap: 'wrap',
        padding: 'var(--space-4) var(--space-6)', background: 'var(--surface)',
        border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)',
        marginTop: 'var(--space-5)',
      }}>
        <div className="legend-title" style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          Legende
        </div>
        <div className="legend-item" style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--text-secondary)', fontWeight: 500 }}>
          <div style={{ width: '16px', height: '12px', borderRadius: '3px', background: 'var(--surface-secondary)', border: '1.5px solid var(--border)' }} />
          Leer
        </div>
        <div className="legend-item" style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--text-secondary)', fontWeight: 500 }}>
          <div style={{ width: '16px', height: '12px', borderRadius: '3px', background: 'var(--surface)', border: '1.5px solid var(--info)', borderLeftWidth: '3px' }} />
          Teilbelegt
        </div>
        <div className="legend-item" style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--text-secondary)', fontWeight: 500 }}>
          <div style={{ width: '16px', height: '12px', borderRadius: '3px', background: 'var(--surface)', border: '1.5px solid var(--avy-purple)', borderLeftWidth: '3px' }} />
          Voll (&gt;80%)
        </div>
        <div className="legend-item" style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--text-secondary)', fontWeight: 500 }}>
          <div style={{ width: '16px', height: '12px', borderRadius: '3px', background: 'var(--error-bg)', border: '1.5px solid var(--error-border)', borderLeftWidth: '3px' }} />
          Überlauf
        </div>
      </div>
    </section>
  );
};

export default WarehouseView;

import React, { useCallback, useMemo, useState } from "react";
import { Modal, ModalHeader, ModalBody, ModalFooter } from "../ui/Modal";
import { Button } from "../ui/Button";
import {
  INVENTORY_EXPORT_FIELDS,
  INVENTORY_EXPORT_GROUP_LABELS,
  INVENTORY_EXPORT_GROUP_ORDER,
  INVENTORY_EXPORT_DEFAULT_FIELDS,
  type InventoryExportGroup,
  type InventoryExportNumberFormat,
} from "../../utils/inventory-export";

export type InventoryExportScope = "filtered" | "all";

interface InventoryExportDialogProps {
  open: boolean;
  onClose: () => void;
  filteredCount: number;
  totalCount: number;
  /** Wahr, wenn Filter oder Suche aktiv sind — sonst ist die Umfangswahl bedeutungslos. */
  filterActive: boolean;
  initialFields: string[];
  initialNumberFormat: InventoryExportNumberFormat;
  onExport: (options: {
    scope: InventoryExportScope;
    fields: string[];
    numberFormat: InventoryExportNumberFormat;
  }) => void;
}

const SegmentedOption: React.FC<{
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}> = ({ active, onClick, children }) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={active}
    className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
      active ? "bg-accent text-white" : "bg-app-elevated text-txt-secondary hover:text-txt-primary"
    }`}
  >
    {children}
  </button>
);

const InventoryExportDialog: React.FC<InventoryExportDialogProps> = ({
  open,
  onClose,
  filteredCount,
  totalCount,
  filterActive,
  initialFields,
  initialNumberFormat,
  onExport,
}) => {
  const [scope, setScope] = useState<InventoryExportScope>("filtered");
  const [selected, setSelected] = useState<string[]>(initialFields);
  const [numberFormat, setNumberFormat] = useState<InventoryExportNumberFormat>(initialNumberFormat);

  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const fieldsByGroup = useMemo(() => {
    const map = new Map<InventoryExportGroup, typeof INVENTORY_EXPORT_FIELDS>();
    INVENTORY_EXPORT_GROUP_ORDER.forEach((g) => map.set(g, []));
    INVENTORY_EXPORT_FIELDS.forEach((field) => {
      map.get(field.group)?.push(field);
    });
    return map;
  }, []);

  const toggleField = useCallback((key: string) => {
    setSelected((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  }, []);

  const toggleGroup = useCallback(
    (group: InventoryExportGroup, on: boolean) => {
      const keys = (fieldsByGroup.get(group) || []).map((f) => f.key);
      setSelected((prev) => (on ? Array.from(new Set([...prev, ...keys])) : prev.filter((k) => !keys.includes(k))));
    },
    [fieldsByGroup]
  );

  const rowCount = scope === "all" ? totalCount : filteredCount;
  const canExport = selected.length > 0 && rowCount > 0;

  const handleExport = () => {
    if (!canExport) return;
    onExport({ scope, fields: selected, numberFormat });
  };

  return (
    <Modal open={open} onClose={onClose} size="lg">
      <ModalHeader onClose={onClose}>Warenbestand exportieren</ModalHeader>

      <ModalBody className="space-y-5 max-h-[65vh] overflow-y-auto">
        {/* Umfang */}
        <section>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-txt-muted mb-2">Umfang</h4>
          <div className="flex gap-2">
            <SegmentedOption active={scope === "filtered"} onClick={() => setScope("filtered")}>
              {filterActive ? "Gefilterte Auswahl" : "Aktuelle Ansicht"} ({filteredCount.toLocaleString("de-DE")})
            </SegmentedOption>
            <SegmentedOption active={scope === "all"} onClick={() => setScope("all")}>
              Gesamter Bestand ({totalCount.toLocaleString("de-DE")})
            </SegmentedOption>
          </div>
          <p className="text-xs text-txt-muted mt-1.5">
            Die Sortierung der Tabelle wird übernommen. Beide Umfänge enthalten nur Artikel mit Bestand.
          </p>
        </section>

        {/* Zahlenformat */}
        <section>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-txt-muted mb-2">Zahlenformat</h4>
          <div className="flex gap-2">
            <SegmentedOption active={numberFormat === "de"} onClick={() => setNumberFormat("de")}>
              Deutsch (1234,56)
            </SegmentedOption>
            <SegmentedOption active={numberFormat === "intl"} onClick={() => setNumberFormat("intl")}>
              International (1234.56)
            </SegmentedOption>
          </div>
          <p className="text-xs text-txt-muted mt-1.5">
            Deutsches Excel liest Zahlen mit Punkt als Text. Tausendertrenner werden nie geschrieben.
          </p>
        </section>

        {/* Felder */}
        <section>
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-txt-muted">
              Felder ({selected.length} ausgewählt)
            </h4>
            <button
              type="button"
              onClick={() => setSelected(INVENTORY_EXPORT_DEFAULT_FIELDS)}
              className="text-xs text-accent hover:underline"
            >
              Standard wiederherstellen
            </button>
          </div>

          <div className="grid sm:grid-cols-2 gap-3">
            {INVENTORY_EXPORT_GROUP_ORDER.map((group) => {
              const fields = fieldsByGroup.get(group) || [];
              const allOn = fields.every((f) => selectedSet.has(f.key));
              return (
                <div key={group} className="rounded-lg border border-app-border bg-app-elevated/40 p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-medium text-txt-primary">
                      {INVENTORY_EXPORT_GROUP_LABELS[group]}
                    </span>
                    <button
                      type="button"
                      onClick={() => toggleGroup(group, !allOn)}
                      className="text-xs text-txt-muted hover:text-accent"
                    >
                      {allOn ? "Keine" : "Alle"}
                    </button>
                  </div>
                  <div className="space-y-1">
                    {fields.map((field) => (
                      <label
                        key={field.key}
                        className="flex items-center gap-2 text-sm text-txt-secondary hover:text-txt-primary cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={selectedSet.has(field.key)}
                          onChange={() => toggleField(field.key)}
                          className="w-4 h-4 rounded accent-accent cursor-pointer"
                        />
                        {field.label}
                      </label>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          <p className="text-xs text-txt-muted mt-3">
            <span className="text-txt-secondary">EK-Quelle</span> zeigt an, ob der Einkaufspreis erfasst oder aus dem
            recherchierten Marktpreis geschätzt ist. Für Inventur- und Belegzwecke mitexportieren.
          </p>
        </section>
      </ModalBody>

      <ModalFooter>
        <span className="mr-auto text-xs text-txt-muted">
          {selected.length} Spalten · {rowCount.toLocaleString("de-DE")} Zeilen
        </span>
        <Button variant="secondary" onClick={onClose}>
          Abbrechen
        </Button>
        <Button variant="primary" onClick={handleExport} disabled={!canExport}>
          CSV herunterladen
        </Button>
      </ModalFooter>
    </Modal>
  );
};

export default InventoryExportDialog;

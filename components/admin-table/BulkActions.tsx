import React, { useState } from "react";
import { TrashIcon, OperationsIcon } from "../icons/Icons";
import { ProductBulkActionName } from "./types";
import BulkUpdateModal from "./BulkUpdateModal";
import { exportProductsCsv } from "../../api/client";
import { useAuth } from "../../context/AuthContext";

const ActionButton: React.FC<{
  icon: React.ReactNode;
  label: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tone?: "primary" | "secondary" | "danger" | "accent";
  ariaLabel?: string;
}> = ({ icon, label, onClick, disabled, tone = "secondary", ariaLabel }) => {
  const toneClasses = {
    primary:
      "bg-accent/90 text-white hover:bg-accent border border-accent/30",
    secondary:
      "bg-app-elevated/80 text-txt-primary hover:bg-app-border border border-app-border/40",
    danger:
      "bg-danger/90 text-white hover:bg-danger border border-danger/30",
    accent:
      "bg-accent/90 text-white hover:bg-accent border border-accent/30",
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition shadow-sm ${toneClasses[tone]} ${disabled ? "opacity-40 cursor-not-allowed hover:none" : ""}`}
    >
      {icon}
      <span className="whitespace-nowrap">{label}</span>
    </button>
  );
};

// Pencil icon for "Feld ändern"
const PencilIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
    <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
  </svg>
);

// Grid/edit-mode toggle icon
const GridEditIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
    <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h18M3 14h18M10 3v18M14 3v18" />
  </svg>
);

// Download icon for CSV export
const DownloadIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
    <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
  </svg>
);

interface BulkActionsProps {
  selectedIds: Set<string>;
  setSelectedIds: (ids: Set<string>) => void;
  totalFilteredCount: number;

  // Bulk jobs (data-fix)
  bulkJobLoading: boolean;
  enqueueBulkForSelection: (
    action: ProductBulkActionName,
    opts?: { apply?: boolean }
  ) => Promise<void>;

  // Improve
  onImproveSelected?: (productIds: string[]) => void;
  improveInProgress: boolean;
  setImproveInProgress: (v: boolean) => void;
  setImproveMessage: (v: string | null) => void;

  // Delete
  handleBatchDelete: () => void;

  // Label print
  handleBatchLabelPrint: () => void;

  // Grid edit mode (Layer 2)
  isEditMode?: boolean;
  onToggleEditMode?: () => void;
  dirtyCount?: number;
  onCommitEdits?: () => void;
  onDiscardEdits?: () => void;

  // Refresh after bulk update
  onRefreshProducts: () => void;

  // Legacy props (kept for backwards-compat, ignored)
  ebayPublishInProgress?: boolean;
  handleBatchPublishEbay?: () => void;
  ebayUpdateInProgress?: boolean;
  handleBatchUpdateEbay?: () => void;
  hasSelectedEbayListings?: boolean;
  ebaySyncInProgress?: boolean;
  handleSyncEbayListings?: () => void;
  hasSelectedKauflandListings?: boolean;
  kauflandSyncInProgress?: boolean;
  handleSyncKauflandListings?: () => void;
}

const menuItemClass =
  "w-full text-left px-3 py-2 text-sm text-txt-primary hover:bg-app-elevated/60 rounded-xl transition";

const BulkActions: React.FC<BulkActionsProps> = ({
  selectedIds,
  setSelectedIds,
  totalFilteredCount,
  bulkJobLoading,
  enqueueBulkForSelection,
  onImproveSelected,
  improveInProgress,
  setImproveInProgress,
  setImproveMessage,
  handleBatchDelete,
  handleBatchLabelPrint,
  isEditMode,
  onToggleEditMode,
  dirtyCount = 0,
  onCommitEdits,
  onDiscardEdits,
  onRefreshProducts,
}) => {
  const { isAdmin } = useAuth();
  const [showBulkUpdateModal, setShowBulkUpdateModal] = useState(false);
  const [csvExporting, setCsvExporting] = useState(false);

  const handleCsvExport = async () => {
    setCsvExporting(true);
    try {
      await exportProductsCsv();
    } catch (err) {
      console.error("CSV export failed:", err);
    } finally {
      setCsvExporting(false);
    }
  };

  return (
    <>
      <div className="rounded-xl border border-accent/20 bg-accent/5 p-3 space-y-2">
        <div className="flex items-center justify-between">
          <div className="inline-flex items-center gap-2 text-sm font-semibold text-txt-primary">
            <span className="inline-flex items-center justify-center min-w-[24px] h-6 rounded-md bg-accent-dim px-1.5 text-xs font-bold text-accent">
              {selectedIds.size}
            </span>
            <span>
              von {totalFilteredCount} ausgewählt
            </span>
          </div>
          <button
            type="button"
            onClick={() => setSelectedIds(new Set())}
            className="text-xs text-txt-muted hover:text-txt-secondary transition"
          >
            Auswahl aufheben
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {/* Feld ändern — BULK-001 Layer 1 */}
          <ActionButton
            icon={<PencilIcon className="w-3.5 h-3.5" />}
            label="Feld ändern"
            ariaLabel="Feld für ausgewählte Produkte ändern"
            onClick={() => setShowBulkUpdateModal(true)}
            disabled={selectedIds.size === 0}
            tone="accent"
          />

          {/* Grid Edit Mode toggle — BULK-001 Layer 2 */}
          {onToggleEditMode && (
            <ActionButton
              icon={<GridEditIcon className="w-3.5 h-3.5" />}
              label={isEditMode ? "Edit-Modus aus" : "Edit-Modus"}
              ariaLabel="Inline-Bearbeitung umschalten"
              onClick={onToggleEditMode}
              tone={isEditMode ? "accent" : "secondary"}
            />
          )}

          {/* Dirty edit commit/discard (Layer 2) */}
          {isEditMode && dirtyCount > 0 && (
            <>
              <ActionButton
                icon={<span className="text-xs">&#10003;</span>}
                label={`Speichern (${dirtyCount})`}
                ariaLabel="Alle Änderungen speichern"
                onClick={() => onCommitEdits?.()}
                tone="accent"
              />
              <ActionButton
                icon={<span className="text-xs">&times;</span>}
                label="Verwerfen"
                ariaLabel="Alle Änderungen verwerfen"
                onClick={() => onDiscardEdits?.()}
                tone="secondary"
              />
            </>
          )}

          <div className="w-px h-5 bg-app-elevated mx-1" />

          {onImproveSelected ? (
            <>
              <ActionButton
                icon={<OperationsIcon className="w-3.5 h-3.5" />}
                label="KI Verbessern"
                ariaLabel="Ausgewählte Produkte mit KI verbessern"
                onClick={() => {
                  const ids = Array.from(selectedIds);
                  if (!ids.length) return;
                  setImproveInProgress(true);
                  setImproveMessage(
                    `Verbessern gestartet (${ids.length}) \u2026`
                  );
                  try {
                    onImproveSelected(ids);
                  } catch (err: any) {
                    console.error(
                      "Improve Selected failed",
                      err?.message || err
                    );
                    setImproveMessage("Fehler beim Verbessern");
                  } finally {
                    setTimeout(() => setImproveInProgress(false), 3000);
                  }
                }}
                disabled={selectedIds.size === 0 || improveInProgress}
                tone="secondary"
              />
            </>
          ) : null}

          {isAdmin && (
            <ActionButton
              icon={
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              }
              label="Schnell-Check"
              ariaLabel="Ausgewählte Produkte validieren und korrigieren (Titel, Kategorie, Preis, Attribute)"
              onClick={() => enqueueBulkForSelection("validate")}
              disabled={selectedIds.size === 0 || bulkJobLoading}
              tone="accent"
            />
          )}

          <ActionButton
            icon={<TrashIcon className="w-3.5 h-3.5" />}
            label="Löschen"
            ariaLabel="Ausgewählte Produkte löschen"
            onClick={handleBatchDelete}
            disabled={selectedIds.size === 0}
            tone="danger"
          />

          <div className="w-px h-5 bg-app-elevated mx-1" />

          <details className="relative">
            <summary className="cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden inline-flex items-center gap-1 rounded-lg bg-app-elevated/80 border border-app-border/40 px-3 py-1.5 text-xs font-semibold text-txt-primary hover:bg-app-border transition shadow-sm">
              <svg
                className="w-3.5 h-3.5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth="2"
              >
                <circle cx="12" cy="12" r="1" />
                <circle cx="12" cy="5" r="1" />
                <circle cx="12" cy="19" r="1" />
              </svg>
              Mehr
            </summary>
            <div className="absolute right-0 mt-2 w-[300px] max-w-[90vw] rounded-xl border border-app-border bg-app-bg p-1.5 shadow-xl shadow-black/40 z-30">
              <div className="px-2.5 pt-1.5 pb-1 text-[10px] uppercase tracking-wider font-semibold text-txt-muted">
                Daten-Fix
              </div>
              <button
                type="button"
                onClick={() => enqueueBulkForSelection("price")}
                disabled={bulkJobLoading}
                className={menuItemClass}
              >
                Price Refresh
              </button>
              <button
                type="button"
                onClick={() => enqueueBulkForSelection("title")}
                disabled={bulkJobLoading}
                className={menuItemClass}
              >
                Titel fix
              </button>
              <button
                type="button"
                onClick={() => enqueueBulkForSelection("category")}
                disabled={bulkJobLoading}
                className={menuItemClass}
              >
                Kategorie fix
              </button>
              <button
                type="button"
                onClick={() => enqueueBulkForSelection("ktype")}
                disabled={bulkJobLoading}
                className={menuItemClass}
              >
                K&#x2011;Typ enrich
              </button>

              <div className="my-1.5 border-t border-app-border/60" />
              <div className="px-2.5 pt-1 pb-1 text-[10px] uppercase tracking-wider font-semibold text-txt-muted">
                Import / Export
              </div>
              <button
                type="button"
                onClick={handleCsvExport}
                disabled={csvExporting}
                className={menuItemClass}
              >
                <span className="inline-flex items-center gap-1.5">
                  <DownloadIcon className="w-3.5 h-3.5" />
                  {csvExporting ? "Exportiere..." : "CSV Export"}
                </span>
              </button>

              <div className="my-1.5 border-t border-app-border/60" />
              <div className="px-2.5 pt-1 pb-1 text-[10px] uppercase tracking-wider font-semibold text-txt-muted">
                Sonstiges
              </div>
              <button
                type="button"
                onClick={handleBatchLabelPrint}
                disabled={selectedIds.size === 0}
                className={menuItemClass}
              >
                Label drucken
              </button>
              <button
                type="button"
                onClick={handleBatchDelete}
                disabled={selectedIds.size === 0}
                className={`${menuItemClass} text-danger hover:bg-danger-dim`}
              >
                Auswahl löschen
              </button>
            </div>
          </details>
        </div>
      </div>

      {showBulkUpdateModal && (
        <BulkUpdateModal
          selectedIds={selectedIds}
          onClose={() => setShowBulkUpdateModal(false)}
          onSuccess={() => {
            setShowBulkUpdateModal(false);
            setSelectedIds(new Set());
            onRefreshProducts();
          }}
        />
      )}
    </>
  );
};

export default BulkActions;

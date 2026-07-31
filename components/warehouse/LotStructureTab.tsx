import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchWarehouseLots,
  createWarehouseLotsApi,
  updateWarehouseLotApi,
  deleteWarehouseLotApi,
  openLotLabelsBatchWindow,
} from "../../api/client";
import type { WarehouseLot } from "../../types";
import { PrintIcon } from "../icons/Icons";
import { Notice } from "../ui/Notice";
import { ConfirmDialog } from "../ui/ConfirmDialog";

/**
 * Los-Struktur: L-/NL-Lose anlegen, drucken (QR-Labels wie BIN-Labels) und pflegen.
 * Ein Los ist die Einkaufs-Zugehörigkeit einer Ware (Auktion = L, sonst NL) —
 * kein Lagerplatz und kein Bestand.
 */

const MONTH_OPTIONS = Array.from({ length: 12 }, (_, i) => i + 1);

const formatEk = (value: number | null | undefined): string => {
  if (value === null || value === undefined) return "—";
  return value.toLocaleString("de-DE", { style: "currency", currency: "EUR" });
};

const LotStructureTab: React.FC = () => {
  const now = new Date();
  const [lots, setLots] = useState<WarehouseLot[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [selectedCodes, setSelectedCodes] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<{ type: "L" | "NL"; month: number; year: number; numbers: string }>({
    type: "L",
    month: now.getMonth() + 1,
    year: now.getFullYear(),
    numbers: "",
  });
  const [ekDrafts, setEkDrafts] = useState<Record<string, string>>({});
  const [savingEkCode, setSavingEkCode] = useState<string | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{
    title: string;
    description?: React.ReactNode;
    confirmLabel: string;
    onConfirm: () => void | Promise<void>;
  } | null>(null);

  const yearOptions = useMemo(() => {
    const current = now.getFullYear();
    return [current - 1, current, current + 1];
  }, [now]);

  const loadLots = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchWarehouseLots();
      setLots(data);
      setSelectedCodes((prev) => {
        if (!prev.size) return prev;
        const allowed = new Set(data.map((lot) => lot.code));
        const next = new Set<string>();
        prev.forEach((code) => {
          if (allowed.has(code)) next.add(code);
        });
        return next;
      });
    } catch (error: any) {
      setStatusMessage(error?.message || "Lose konnten nicht geladen werden.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadLots();
  }, [loadLots]);

  const handleCreate = useCallback(async () => {
    if (form.type === "L" && !form.numbers.trim()) {
      setStatusMessage("Bitte Los-Nummer(n) angeben, z.B. „12“ oder „1-38“.");
      return;
    }
    setCreating(true);
    try {
      const result = await createWarehouseLotsApi({
        type: form.type,
        month: form.month,
        year: form.year,
        numbers: form.type === "L" ? form.numbers.trim() : undefined,
      });
      if (!result.ok) {
        setStatusMessage(result.error?.message || "Lose konnten nicht angelegt werden.");
        return;
      }
      const created = result.data?.created || [];
      const skipped = result.data?.skipped || [];
      const parts: string[] = [];
      if (created.length) parts.push(`${created.length} Los${created.length === 1 ? "" : "e"} angelegt (${created[0]}${created.length > 1 ? ` … ${created[created.length - 1]}` : ""})`);
      if (skipped.length) parts.push(`${skipped.length} übersprungen (existierten bereits)`);
      setStatusMessage(parts.join(" · ") || "Nichts zu tun.");
      setForm((prev) => ({ ...prev, numbers: "" }));
      await loadLots();
    } finally {
      setCreating(false);
    }
  }, [form, loadLots]);

  const toggleSelection = useCallback((code: string) => {
    setSelectedCodes((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }, []);

  const handlePrintSelected = useCallback(() => {
    const codes = selectedCodes.size ? [...selectedCodes] : [];
    if (!codes.length) {
      setStatusMessage("Bitte zuerst Lose auswählen (Checkbox).");
      return;
    }
    const result = openLotLabelsBatchWindow(codes);
    if (!result.ok) {
      setStatusMessage(result.error?.message || "Labels konnten nicht geöffnet werden.");
    }
  }, [selectedCodes]);

  const handlePrintSingle = useCallback((code: string) => {
    const result = openLotLabelsBatchWindow([code]);
    if (!result.ok) {
      setStatusMessage(result.error?.message || "Label konnte nicht geöffnet werden.");
    }
  }, []);

  const handleSaveEk = useCallback(
    async (lot: WarehouseLot) => {
      const draft = ekDrafts[lot.code];
      if (draft === undefined) return;
      const trimmed = draft.trim().replace(",", ".");
      const value = trimmed === "" ? null : Number(trimmed);
      if (value !== null && (!Number.isFinite(value) || value < 0)) {
        setStatusMessage("EK (brutto) muss eine Zahl ≥ 0 sein.");
        return;
      }
      setSavingEkCode(lot.code);
      try {
        const result = await updateWarehouseLotApi(lot.code, { ekBrutto: value });
        if (!result.ok) {
          setStatusMessage(result.error?.message || "EK konnte nicht gespeichert werden.");
          return;
        }
        setLots((prev) => prev.map((l) => (l.code === lot.code ? { ...l, ekBrutto: value } : l)));
        setEkDrafts((prev) => {
          const next = { ...prev };
          delete next[lot.code];
          return next;
        });
      } finally {
        setSavingEkCode(null);
      }
    },
    [ekDrafts]
  );

  const handleDelete = useCallback(
    (lot: WarehouseLot) => {
      setConfirmDialog({
        title: `Los ${lot.code} löschen?`,
        description: "Das Los wird entfernt. Löschen ist nur möglich, solange keine Produkte zugeordnet sind.",
        confirmLabel: "Löschen",
        onConfirm: async () => {
          setConfirmDialog(null);
          const result = await deleteWarehouseLotApi(lot.code);
          if (!result.ok) {
            setStatusMessage(result.error?.message || "Los konnte nicht gelöscht werden.");
            return;
          }
          setStatusMessage(`Los ${lot.code} gelöscht.`);
          await loadLots();
        },
      });
    },
    [loadLots]
  );

  return (
    <div className="space-y-6">
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
          tone="danger"
          confirmLabel={confirmDialog.confirmLabel}
          onCancel={() => setConfirmDialog(null)}
          onConfirm={confirmDialog.onConfirm}
        />
      ) : null}

      {/* Neues Los anlegen */}
      <div className="bg-app-surface rounded-2xl p-5 border border-app-border">
        <h3 className="text-xl font-semibold text-txt-primary mb-1">Neue Lose anlegen</h3>
        <p className="text-sm text-txt-muted mb-3">
          <b>L</b> = Auktions-Los (z.B. L-072612, Nummer 01–200 je Monat) · <b>NL</b> = Non-Los für alle
          Ware ohne Auktion (z.B. NL-0726, eins pro Monat). Die Labels werden beim Wareneingang auf
          Rollwagen/Gitterwagen geklebt.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <div>
            <label className="block text-sm text-txt-muted mb-1">Typ</label>
            <select
              value={form.type}
              onChange={(e) => setForm((prev) => ({ ...prev, type: e.target.value as "L" | "NL" }))}
              className="w-full bg-app-elevated border border-app-border rounded-lg px-3 py-2"
            >
              <option value="L">L (Auktions-Los)</option>
              <option value="NL">NL (Non-Los)</option>
            </select>
          </div>
          <div>
            <label className="block text-sm text-txt-muted mb-1">Monat</label>
            <select
              value={form.month}
              onChange={(e) => setForm((prev) => ({ ...prev, month: Number(e.target.value) }))}
              className="w-full bg-app-elevated border border-app-border rounded-lg px-3 py-2"
            >
              {MONTH_OPTIONS.map((m) => (
                <option key={m} value={m}>
                  {String(m).padStart(2, "0")}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm text-txt-muted mb-1">Jahr</label>
            <select
              value={form.year}
              onChange={(e) => setForm((prev) => ({ ...prev, year: Number(e.target.value) }))}
              className="w-full bg-app-elevated border border-app-border rounded-lg px-3 py-2"
            >
              {yearOptions.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </div>
          {form.type === "L" ? (
            <div>
              <label className="block text-sm text-txt-muted mb-1">Nummer(n) 1–200</label>
              <input
                value={form.numbers}
                onChange={(e) => setForm((prev) => ({ ...prev, numbers: e.target.value }))}
                placeholder="12 oder 1-38"
                className="w-full bg-app-elevated border border-app-border rounded-lg px-3 py-2"
              />
            </div>
          ) : (
            <div className="flex items-end">
              <p className="text-xs text-txt-muted pb-2">
                Ergibt: <span className="font-mono">NL-{String(form.month).padStart(2, "0")}{String(form.year % 100).padStart(2, "0")}</span>
              </p>
            </div>
          )}
        </div>
        <button
          onClick={handleCreate}
          disabled={creating}
          className="mt-4 px-4 py-2 bg-accent-dim text-accent rounded-xl hover:bg-accent/20 transition disabled:opacity-40"
        >
          {creating ? "Wird angelegt…" : form.type === "L" ? "Lose anlegen" : "Los anlegen"}
        </button>
      </div>

      {/* Druck-Leiste */}
      <div className="bg-app-surface rounded-2xl p-5 border border-app-border space-y-3">
        <h3 className="text-lg font-semibold text-txt-primary">Los-Labels drucken</h3>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-txt-secondary">Ausgewählte Lose: {selectedCodes.size}</span>
          <button
            type="button"
            onClick={handlePrintSelected}
            disabled={!selectedCodes.size}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-success-dim text-success disabled:opacity-40 hover:bg-success/20 transition"
          >
            <PrintIcon className="w-4 h-4" />
            Los-Labels drucken
          </button>
          {selectedCodes.size > 0 && (
            <button
              type="button"
              onClick={() => setSelectedCodes(new Set())}
              className="px-3 py-1.5 rounded-xl bg-app-surface text-sm text-txt-primary hover:bg-app-elevated/60"
            >
              Auswahl leeren
            </button>
          )}
        </div>
        <p className="text-xs text-txt-muted">
          Gleiches Format wie BIN-Labels (62×29 mm, QR-Code + Klartext).
        </p>
      </div>

      {/* Los-Liste */}
      <div className="bg-app-surface rounded-2xl p-5 border border-app-border">
        <h3 className="text-xl font-semibold text-txt-primary mb-3">Lose</h3>
        {loading ? (
          <p className="text-sm text-txt-muted">Lose werden geladen…</p>
        ) : lots.length === 0 ? (
          <p className="text-sm text-txt-muted">
            Noch keine Lose angelegt. Lege oben das erste Los an (z.B. NL für den aktuellen Monat).
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-txt-muted border-b border-app-border">
                  <th className="py-2 pr-2 w-8"></th>
                  <th className="py-2 pr-4">Los</th>
                  <th className="py-2 pr-4">Typ</th>
                  <th className="py-2 pr-4">Zeitraum</th>
                  <th className="py-2 pr-4">Produkte</th>
                  <th className="py-2 pr-4">EK brutto</th>
                  <th className="py-2 pr-4">Angelegt</th>
                  <th className="py-2"></th>
                </tr>
              </thead>
              <tbody>
                {lots.map((lot) => {
                  const draft = ekDrafts[lot.code];
                  return (
                    <tr key={lot.code} className="border-b border-app-border/50 hover:bg-app-elevated/30">
                      <td className="py-2 pr-2">
                        <input
                          type="checkbox"
                          checked={selectedCodes.has(lot.code)}
                          onChange={() => toggleSelection(lot.code)}
                          className="accent-current"
                        />
                      </td>
                      <td className="py-2 pr-4 font-mono font-semibold text-txt-primary">{lot.code}</td>
                      <td className="py-2 pr-4">
                        <span
                          className={`px-2 py-0.5 rounded-md text-xs font-medium ${
                            lot.type === "L" ? "bg-accent-dim text-accent" : "bg-info-dim text-info"
                          }`}
                        >
                          {lot.type === "L" ? "Auktion" : "Non-Los"}
                        </span>
                      </td>
                      <td className="py-2 pr-4 text-txt-secondary">
                        {lot.month ? String(lot.month).padStart(2, "0") : "—"}/{lot.year ?? "—"}
                      </td>
                      <td className="py-2 pr-4 text-txt-secondary">{lot.productCount ?? 0}</td>
                      <td className="py-2 pr-4">
                        <div className="flex items-center gap-2">
                          <input
                            value={draft !== undefined ? draft : lot.ekBrutto ?? ""}
                            onChange={(e) => setEkDrafts((prev) => ({ ...prev, [lot.code]: e.target.value }))}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") handleSaveEk(lot);
                            }}
                            placeholder="—"
                            inputMode="decimal"
                            className="w-24 bg-app-elevated border border-app-border rounded-lg px-2 py-1 text-sm"
                          />
                          {draft !== undefined && draft !== String(lot.ekBrutto ?? "") ? (
                            <button
                              type="button"
                              onClick={() => handleSaveEk(lot)}
                              disabled={savingEkCode === lot.code}
                              className="px-2 py-1 text-xs rounded-lg bg-accent-dim text-accent hover:bg-accent/20 disabled:opacity-40"
                            >
                              {savingEkCode === lot.code ? "…" : "Speichern"}
                            </button>
                          ) : (
                            <span className="text-xs text-txt-muted">{formatEk(lot.ekBrutto)}</span>
                          )}
                        </div>
                      </td>
                      <td className="py-2 pr-4 text-xs text-txt-muted">
                        {lot.createdAt ? new Date(lot.createdAt).toLocaleDateString("de-DE") : "—"}
                      </td>
                      <td className="py-2 text-right whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => handlePrintSingle(lot.code)}
                          className="px-2 py-1 text-xs rounded-lg bg-app-elevated text-txt-primary hover:bg-app-elevated/70 mr-2"
                          title="Label drucken"
                        >
                          Label
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(lot)}
                          disabled={(lot.productCount ?? 0) > 0}
                          className="px-2 py-1 text-xs rounded-lg bg-danger/15 text-danger hover:bg-danger/25 disabled:opacity-30"
                          title={
                            (lot.productCount ?? 0) > 0
                              ? "Nicht löschbar: Produkte zugeordnet"
                              : "Los löschen"
                          }
                        >
                          Löschen
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

export default LotStructureTab;

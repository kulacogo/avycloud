import React, { useState, useEffect, useCallback } from "react";
import {
  fetchWarehouseInventories,
  fetchWarehouseInventory,
  createWarehouseInventory,
  recordInventoryCounts,
  completeWarehouseInventory,
  WarehouseInventory,
  InventoryCount,
} from "../../api/client";
import { Spinner } from "../Spinner";

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const StatusBadge: React.FC<{ status: string }> = ({ status }) => {
  const cls =
    status === "completed"
      ? "bg-success-dim text-success"
      : status === "active"
        ? "bg-warning-dim text-warning"
        : "bg-accent-dim text-accent";

  const label =
    status === "completed" ? "Abgeschlossen" : status === "active" ? "Aktiv" : "Geplant";

  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded ${cls}`}>{label}</span>
  );
};

const ProgressBar: React.FC<{ pct: number }> = ({ pct }) => (
  <div className="w-full bg-app-elevated rounded-full h-2">
    <div
      className="bg-accent h-2 rounded-full transition-all"
      style={{ width: `${Math.min(100, pct)}%` }}
    />
  </div>
);

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

type View = "list" | "create" | "detail";

const WarehouseInventoryTab: React.FC = () => {
  const [view, setView] = useState<View>("list");
  const [inventories, setInventories] = useState<WarehouseInventory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create form
  const [createName, setCreateName] = useState("");
  const [createScope, setCreateScope] = useState<"full" | "zone">("full");
  const [createZone, setCreateZone] = useState("X");
  const [creating, setCreating] = useState(false);

  // Detail view
  const [activeInventory, setActiveInventory] = useState<WarehouseInventory | null>(null);
  const [countInputs, setCountInputs] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  // ---- List loading ----
  const loadList = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await fetchWarehouseInventories();
      setInventories(list);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (view === "list") loadList();
  }, [view, loadList]);

  // ---- Create ----
  const handleCreate = async () => {
    if (!createName.trim()) return;
    setCreating(true);
    try {
      const inv = await createWarehouseInventory({
        name: createName.trim(),
        scope: createScope,
        zoneFilter: createScope === "zone" ? createZone : undefined,
      });
      setActiveInventory(inv);
      initCountInputs(inv.counts || []);
      setView("detail");
      setCreateName("");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  };

  // ---- Detail loading ----
  const openDetail = async (id: string) => {
    setLoading(true);
    try {
      const inv = await fetchWarehouseInventory(id);
      setActiveInventory(inv);
      initCountInputs(inv.counts || []);
      setView("detail");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const initCountInputs = (counts: InventoryCount[]) => {
    const inputs: Record<string, string> = {};
    for (const c of counts) {
      const key = `${c.binCode}__${c.productId}`;
      inputs[key] = c.countedQty !== null ? String(c.countedQty) : "";
    }
    setCountInputs(inputs);
  };

  // ---- Save counts ----
  const handleSaveCounts = async () => {
    if (!activeInventory) return;
    setSaving(true);
    setSaveMessage(null);
    try {
      const counts: Array<{ binCode: string; productId: string; countedQty: number }> = [];
      for (const c of activeInventory.counts || []) {
        const key = `${c.binCode}__${c.productId}`;
        const val = countInputs[key];
        if (val !== "" && val !== undefined) {
          counts.push({
            binCode: c.binCode,
            productId: c.productId,
            countedQty: parseInt(val, 10),
          });
        }
      }
      if (counts.length === 0) {
        setSaveMessage("Keine Zählungen zum Speichern");
        setSaving(false);
        return;
      }
      const result = await recordInventoryCounts(activeInventory.id, counts);
      setSaveMessage(`${result.countedItems} Positionen gespeichert. Gesamtabweichung: ${result.totalVariance}`);
      // Reload detail
      const inv = await fetchWarehouseInventory(activeInventory.id);
      setActiveInventory(inv);
      initCountInputs(inv.counts || []);
    } catch (err: any) {
      setSaveMessage(`Fehler: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  // ---- Complete ----
  const handleComplete = async () => {
    if (!activeInventory) return;
    setCompleting(true);
    try {
      await completeWarehouseInventory(activeInventory.id);
      const inv = await fetchWarehouseInventory(activeInventory.id);
      setActiveInventory(inv);
      setSaveMessage("Inventur abgeschlossen!");
    } catch (err: any) {
      setSaveMessage(`Fehler: ${err.message}`);
    } finally {
      setCompleting(false);
    }
  };

  const formatDate = (iso: string | null) => {
    if (!iso) return "\u2014";
    return new Date(iso).toLocaleDateString("de-DE", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
  };

  // ---- Render: List ----
  if (view === "list") {
    if (loading) {
      return (
        <div className="flex items-center justify-center h-48">
          <Spinner />
        </div>
      );
    }

    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-txt-primary font-semibold">Inventur-Zyklen</h3>
          <button
            onClick={() => setView("create")}
            className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-medium hover:opacity-90 transition-opacity"
          >
            Neue Inventur
          </button>
        </div>

        {error && <p className="text-danger text-sm">{error}</p>}

        {inventories.length === 0 ? (
          <div className="text-center py-16 text-txt-muted text-sm">
            Noch keine Inventuren erstellt
          </div>
        ) : (
          <div className="grid gap-3">
            {inventories.map((inv) => (
              <button
                key={inv.id}
                onClick={() => openDetail(inv.id)}
                className="text-left rounded-xl bg-app-surface border border-app-border p-4 hover:bg-app-elevated/50 transition-colors"
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-txt-primary font-medium">{inv.name}</span>
                  <StatusBadge status={inv.status} />
                </div>
                <div className="flex items-center gap-4 text-xs text-txt-muted">
                  <span>
                    {inv.scope === "zone" ? `Zone ${inv.zoneFilter}` : "Gesamtes Lager"}
                  </span>
                  <span>{formatDate(inv.createdAt)}</span>
                  {inv.summary && (
                    <span>
                      {inv.summary.countedItems}/{inv.summary.totalItems} gezählt
                    </span>
                  )}
                </div>
                {inv.status === "active" && inv.summary && (
                  <div className="mt-2">
                    <ProgressBar pct={inv.summary.completionPct} />
                  </div>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ---- Render: Create ----
  if (view === "create") {
    return (
      <div className="space-y-4 max-w-md">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setView("list")}
            className="text-txt-muted hover:text-txt-primary transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <h3 className="text-txt-primary font-semibold">Neue Inventur anlegen</h3>
        </div>

        {error && <p className="text-danger text-sm">{error}</p>}

        <div>
          <label className="block text-sm text-txt-secondary mb-1">Name</label>
          <input
            type="text"
            placeholder="z.B. Q1 2026 Inventur"
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
            className="w-full bg-app-surface border border-app-border rounded-lg px-3 py-2 text-sm text-txt-primary focus:outline-none focus:ring-1 focus:ring-accent placeholder:text-txt-muted"
          />
        </div>

        <div>
          <label className="block text-sm text-txt-secondary mb-2">Umfang</label>
          <div className="flex gap-3">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="scope"
                checked={createScope === "full"}
                onChange={() => setCreateScope("full")}
                className="accent-accent"
              />
              <span className="text-sm text-txt-primary">Gesamtes Lager</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="scope"
                checked={createScope === "zone"}
                onChange={() => setCreateScope("zone")}
                className="accent-accent"
              />
              <span className="text-sm text-txt-primary">Bestimmte Zone</span>
            </label>
          </div>
        </div>

        {createScope === "zone" && (
          <div>
            <label className="block text-sm text-txt-secondary mb-1">Zone</label>
            <select
              value={createZone}
              onChange={(e) => setCreateZone(e.target.value)}
              className="bg-app-surface border border-app-border rounded-lg px-3 py-2 text-sm text-txt-primary focus:outline-none focus:ring-1 focus:ring-accent"
            >
              {["X", "XS", "S", "M", "L", "XL", "XQ"].map((z) => (
                <option key={z} value={z}>{z}</option>
              ))}
            </select>
          </div>
        )}

        <button
          onClick={handleCreate}
          disabled={creating || !createName.trim()}
          className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
        >
          {creating ? "Wird erstellt..." : "Inventur starten"}
        </button>
      </div>
    );
  }

  // ---- Render: Detail ----
  if (!activeInventory) {
    return (
      <div className="flex items-center justify-center h-48">
        <Spinner />
      </div>
    );
  }

  const counts = activeInventory.counts || [];
  const isCompleted = activeInventory.status === "completed";

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => { setView("list"); setActiveInventory(null); setSaveMessage(null); }}
          className="text-txt-muted hover:text-txt-primary transition-colors"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-txt-primary font-semibold">{activeInventory.name}</h3>
            <StatusBadge status={activeInventory.status} />
          </div>
          <div className="text-xs text-txt-muted mt-0.5">
            {activeInventory.scope === "zone" ? `Zone ${activeInventory.zoneFilter}` : "Gesamtes Lager"}
            {" \u00B7 "}
            {formatDate(activeInventory.createdAt)}
          </div>
        </div>
      </div>

      {/* Progress */}
      {activeInventory.summary && (
        <div className="rounded-xl bg-app-surface border border-app-border p-4">
          <div className="flex items-center justify-between text-sm mb-2">
            <span className="text-txt-secondary">
              {activeInventory.summary.countedItems} / {activeInventory.summary.totalItems} Positionen gezählt
            </span>
            <span className="text-txt-primary font-medium">{activeInventory.summary.completionPct}%</span>
          </div>
          <ProgressBar pct={activeInventory.summary.completionPct} />
          {activeInventory.summary.totalVariance !== 0 && (
            <div className={`text-xs mt-2 ${activeInventory.summary.totalVariance < 0 ? "text-danger" : "text-success"}`}>
              Gesamtabweichung: {activeInventory.summary.totalVariance > 0 ? "+" : ""}{activeInventory.summary.totalVariance}
            </div>
          )}
        </div>
      )}

      {saveMessage && (
        <div className="text-sm px-3 py-2 rounded-lg bg-app-elevated text-txt-secondary">
          {saveMessage}
        </div>
      )}

      {/* Counts table */}
      <div className="rounded-xl bg-app-surface border border-app-border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-app-border text-left">
                <th className="px-3 py-3 font-medium text-txt-secondary">BIN</th>
                <th className="px-3 py-3 font-medium text-txt-secondary">Produkt</th>
                <th className="px-3 py-3 font-medium text-txt-secondary">SKU</th>
                <th className="px-3 py-3 font-medium text-txt-secondary text-right">System</th>
                <th className="px-3 py-3 font-medium text-txt-secondary text-right w-24">Gezählt</th>
                <th className="px-3 py-3 font-medium text-txt-secondary text-right">Abweichung</th>
              </tr>
            </thead>
            <tbody>
              {counts.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-center py-12 text-txt-muted text-sm">
                    Keine Positionen in dieser Inventur
                  </td>
                </tr>
              ) : (
                counts.map((c, idx) => {
                  const key = `${c.binCode}__${c.productId}`;
                  const inputVal = countInputs[key] ?? "";
                  const counted = inputVal !== "" ? parseInt(inputVal, 10) : null;
                  const variance = counted !== null ? counted - c.systemQty : null;

                  return (
                    <tr key={`${key}_${idx}`} className="border-b border-app-border hover:bg-app-elevated/50 transition-colors">
                      <td className="px-3 py-2">
                        <span className="text-xs font-mono text-txt-primary">{c.binCode}</span>
                      </td>
                      <td className="px-3 py-2 text-txt-primary text-xs truncate max-w-[200px]">
                        {c.productName || c.productId}
                      </td>
                      <td className="px-3 py-2 text-xs text-txt-secondary font-mono">
                        {c.sku || "\u2014"}
                      </td>
                      <td className="px-3 py-2 text-right text-txt-secondary tabular-nums">
                        {c.systemQty}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {isCompleted ? (
                          <span className="tabular-nums text-txt-primary">{c.countedQty ?? "\u2014"}</span>
                        ) : (
                          <input
                            type="number"
                            min="0"
                            value={inputVal}
                            onChange={(e) =>
                              setCountInputs((prev) => ({ ...prev, [key]: e.target.value }))
                            }
                            className="w-20 bg-app-elevated border border-app-border rounded px-2 py-1 text-sm text-right text-txt-primary tabular-nums focus:outline-none focus:ring-1 focus:ring-accent"
                            placeholder="\u2014"
                          />
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {variance !== null ? (
                          <span
                            className={`font-bold tabular-nums ${
                              variance < 0 ? "text-danger" : variance > 0 ? "text-success" : "text-txt-muted"
                            }`}
                          >
                            {variance > 0 ? `+${variance}` : variance}
                          </span>
                        ) : (
                          <span className="text-txt-muted">\u2014</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Actions */}
      {!isCompleted && counts.length > 0 && (
        <div className="flex items-center gap-3">
          <button
            onClick={handleSaveCounts}
            disabled={saving}
            className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            {saving ? "Speichert..." : "Zählungen speichern"}
          </button>
          <button
            onClick={handleComplete}
            disabled={completing}
            className="bg-success-dim text-success rounded-lg px-4 py-2 text-sm font-medium hover:bg-success/20 disabled:opacity-50 transition-colors"
          >
            {completing ? "Wird abgeschlossen..." : "Inventur abschließen"}
          </button>
        </div>
      )}
    </div>
  );
};

export default WarehouseInventoryTab;

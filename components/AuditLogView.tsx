import React, { useState, useEffect, useCallback } from "react";
import { Card } from "./ui/Card";
import { Button } from "./ui/Button";
import { Badge } from "./ui/Badge";
import { useToast } from "../context/ToastContext";
import { fetchAuditLog, AuditLogEntry } from "../api/client";

const ACTION_LABELS: Record<string, string> = {
  "product.created": "Produkt erstellt",
  "product.updated": "Produkt aktualisiert",
  "product.merged": "Produkte zusammengeführt",
  "product.deleted": "Produkt gelöscht",
  "product.bulk_import": "Massenimport",
  "product.exported": "Produkte exportiert",
  "order.created": "Auftrag erstellt",
  "order.status_changed": "Auftragsstatus geändert",
  "listing.published": "Listing veröffentlicht",
  "listing.synced": "Listing synchronisiert",
  "user.login": "Anmeldung",
  "user.invited": "Benutzer eingeladen",
  "settings.updated": "Einstellungen geändert",
};

const ACTION_ICONS: Record<string, { color: string; label: string }> = {
  product: { color: "text-accent", label: "Produkt" },
  order: { color: "text-success", label: "Auftrag" },
  listing: { color: "text-warning", label: "Listing" },
  user: { color: "text-info", label: "Benutzer" },
  settings: { color: "text-txt-muted", label: "System" },
};

const FILTER_OPTIONS = [
  { value: "", label: "Alle Aktionen" },
  { value: "product", label: "Produkte" },
  { value: "order", label: "Aufträge" },
  { value: "listing", label: "Listings" },
  { value: "user", label: "Benutzer" },
  { value: "settings", label: "Einstellungen" },
];

const AuditLogView: React.FC = () => {
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");
  const [hasMore, setHasMore] = useState(false);
  const { addToast } = useToast();

  const loadEntries = useCallback(async (append = false, startAfter?: string) => {
    if (!append) setLoading(true);
    try {
      const result = await fetchAuditLog({
        action: filter || undefined,
        limit: 50,
        startAfter,
      });
      if (result.ok && result.data) {
        if (append) {
          setEntries((prev) => [...prev, ...result.data!]);
        } else {
          setEntries(result.data);
        }
        setHasMore(result.data.length === 50);
      } else {
        addToast({ type: "error", title: "Fehler", message: result.error?.message });
      }
    } catch (err: any) {
      addToast({ type: "error", title: "Fehler", message: err?.message });
    } finally {
      setLoading(false);
    }
  }, [filter, addToast]);

  useEffect(() => {
    loadEntries();
  }, [loadEntries]);

  const loadMore = () => {
    const last = entries[entries.length - 1];
    if (last?.timestamp) {
      loadEntries(true, last.timestamp);
    }
  };

  const getActionCategory = (action: string) => {
    const prefix = action.split(".")[0];
    return ACTION_ICONS[prefix] || { color: "text-txt-muted", label: prefix };
  };

  const formatAction = (action: string) => {
    return ACTION_LABELS[action] || action.replace(/[._]/g, " ");
  };

  const formatTimestamp = (ts: string) => {
    const d = new Date(ts);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);

    if (diffMin < 1) return "Gerade eben";
    if (diffMin < 60) return `vor ${diffMin} Min.`;
    if (diffMin < 1440) return `vor ${Math.floor(diffMin / 60)} Std.`;
    return d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  };

  const renderDetails = (entry: AuditLogEntry) => {
    if (!entry.details) return null;
    const parts: string[] = [];

    if (entry.details.imported != null) parts.push(`${entry.details.imported} importiert`);
    if (entry.details.failed != null && entry.details.failed > 0) parts.push(`${entry.details.failed} fehlgeschlagen`);
    if (entry.details.keepId) parts.push(`Behalten: ${entry.details.keepId.slice(0, 8)}…`);
    if (entry.details.removeId) parts.push(`Archiviert: ${entry.details.removeId.slice(0, 8)}…`);
    if (entry.details.merged) {
      const m = entry.details.merged;
      parts.push(`${m.barcodes || 0} Barcodes, ${m.images || 0} Bilder`);
    }

    if (parts.length === 0) return null;
    return <span className="text-xs text-txt-muted">— {parts.join(" · ")}</span>;
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-txt-primary">Aktivitätsprotokoll</h1>
          <p className="text-sm text-txt-muted mt-0.5">
            Alle Änderungen und Aktionen im System
          </p>
        </div>
        <Button variant="secondary" onClick={() => loadEntries()} loading={loading}>
          Aktualisieren
        </Button>
      </div>

      {/* Filter */}
      <div className="flex items-center gap-2">
        {FILTER_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => setFilter(opt.value)}
            className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${
              filter === opt.value
                ? "bg-accent text-white"
                : "bg-app-elevated text-txt-secondary hover:text-txt-primary"
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Loading */}
      {loading && entries.length === 0 && (
        <div className="space-y-2">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="h-16 rounded-xl bg-app-elevated animate-pulse" />
          ))}
        </div>
      )}

      {/* Empty state */}
      {!loading && entries.length === 0 && (
        <Card padding="lg" className="text-center">
          <p className="text-txt-muted py-6">
            {filter ? "Keine Einträge für diesen Filter." : "Noch keine Aktivitäten protokolliert."}
          </p>
        </Card>
      )}

      {/* Entries */}
      {entries.length > 0 && (
        <Card padding="none">
          <div className="divide-y divide-app-border">
            {entries.map((entry) => {
              const cat = getActionCategory(entry.action);
              return (
                <div key={entry.id} className="flex items-start gap-3 px-4 py-3 hover:bg-app-elevated/50 transition-colors">
                  {/* Category dot */}
                  <div className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${cat.color.replace("text-", "bg-")}`} />

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-txt-primary">
                        {formatAction(entry.action)}
                      </span>
                      <Badge variant="neutral" size="sm">{cat.label}</Badge>
                      {renderDetails(entry)}
                    </div>
                    <div className="flex items-center gap-3 mt-0.5 text-xs text-txt-muted">
                      {entry.userEmail && (
                        <span>{entry.userEmail}</span>
                      )}
                      {entry.resourceId && (
                        <span
                          className="font-mono cursor-pointer hover:text-accent transition-colors"
                          onClick={() => {
                            if (entry.resourceType === "product") {
                              window.location.hash = `#/product/${entry.resourceId}`;
                            }
                          }}
                        >
                          {entry.resourceId.length > 16
                            ? `${entry.resourceId.slice(0, 8)}…${entry.resourceId.slice(-6)}`
                            : entry.resourceId}
                        </span>
                      )}
                      <span>{formatTimestamp(entry.timestamp)}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Load more */}
          {hasMore && (
            <div className="flex justify-center py-3 border-t border-app-border">
              <Button variant="secondary" size="sm" onClick={loadMore}>
                Weitere laden
              </Button>
            </div>
          )}
        </Card>
      )}
    </div>
  );
};

export default AuditLogView;

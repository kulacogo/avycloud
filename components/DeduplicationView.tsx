import React, { useState, useEffect, useCallback } from "react";
import { Card } from "./ui/Card";
import { Button } from "./ui/Button";
import { Badge } from "./ui/Badge";
import { Modal, ModalHeader, ModalBody, ModalFooter } from "./ui/Modal";
import { useToast } from "../context/ToastContext";
import {
  fetchDuplicates,
  fetchMergeSuggestion,
  executeMerge,
  DuplicateGroup,
  MergeSuggestion,
} from "../api/client";

const TYPE_LABELS: Record<string, string> = {
  ean: "EAN / Barcode",
  mpn: "MPN",
  brand_name: "Marke + Name",
};

const TYPE_VARIANTS: Record<string, "accent" | "success" | "warning"> = {
  ean: "accent",
  mpn: "success",
  brand_name: "warning",
};

const DeduplicationView: React.FC = () => {
  const [loading, setLoading] = useState(true);
  const [groups, setGroups] = useState<DuplicateGroup[]>([]);
  const [totalProducts, setTotalProducts] = useState(0);
  const [mergeModal, setMergeModal] = useState<{
    group: DuplicateGroup;
    suggestions: { productA: MergeSuggestion; productB: MergeSuggestion } | null;
    loading: boolean;
    keepId: string | null;
  } | null>(null);
  const [merging, setMerging] = useState(false);
  const { addToast } = useToast();

  const loadDuplicates = useCallback(async () => {
    setLoading(true);
    try {
      const result = await fetchDuplicates();
      if (result.ok && result.data) {
        setGroups(result.data.duplicates);
        setTotalProducts(result.data.totalProducts);
      } else {
        addToast({ type: "error", title: "Fehler", message: result.error?.message || "Duplikate konnten nicht geladen werden." });
      }
    } catch (err: any) {
      addToast({ type: "error", title: "Fehler", message: err?.message });
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  useEffect(() => {
    loadDuplicates();
  }, [loadDuplicates]);

  const openMergeModal = useCallback(async (group: DuplicateGroup) => {
    const [idA, idB] = group.productIds;
    setMergeModal({ group, suggestions: null, loading: true, keepId: null });
    try {
      const result = await fetchMergeSuggestion(idA, idB);
      if (result.ok && result.data) {
        setMergeModal((prev) => prev ? { ...prev, suggestions: result.data!, loading: false, keepId: result.data!.productA.id } : null);
      } else {
        addToast({ type: "error", title: "Fehler", message: result.error?.message });
        setMergeModal(null);
      }
    } catch (err: any) {
      addToast({ type: "error", title: "Fehler", message: err?.message });
      setMergeModal(null);
    }
  }, [addToast]);

  const handleMerge = useCallback(async () => {
    if (!mergeModal?.suggestions || !mergeModal.keepId) return;
    const keepId = mergeModal.keepId;
    const removeId = keepId === mergeModal.suggestions.productA.id
      ? mergeModal.suggestions.productB.id
      : mergeModal.suggestions.productA.id;

    setMerging(true);
    try {
      const result = await executeMerge(keepId, removeId);
      if (result.ok && result.data) {
        addToast({
          type: "success",
          title: "Produkte zusammengeführt",
          message: `${result.data.merged.barcodes} Barcodes, ${result.data.merged.images} Bilder übernommen`,
        });
        setMergeModal(null);
        loadDuplicates();
      } else {
        addToast({ type: "error", title: "Merge fehlgeschlagen", message: result.error?.message });
      }
    } catch (err: any) {
      addToast({ type: "error", title: "Fehler", message: err?.message });
    } finally {
      setMerging(false);
    }
  }, [mergeModal, addToast, loadDuplicates]);

  const formatKey = (group: DuplicateGroup) => {
    if (group.type === "brand_name") {
      const [brand, name] = group.key.split("|");
      return `${brand} — ${name}`;
    }
    return group.key;
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-txt-primary">Duplikaterkennung</h1>
          <p className="text-sm text-txt-muted mt-0.5">
            {loading ? "Analyse läuft..." : `${totalProducts} Produkte analysiert`}
          </p>
        </div>
        <Button variant="secondary" onClick={loadDuplicates} loading={loading}>
          Erneut scannen
        </Button>
      </div>

      {/* Summary KPIs */}
      {!loading && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Card padding="md">
            <p className="text-xs text-txt-muted">Duplikatgruppen</p>
            <p className="text-2xl font-bold text-txt-primary mt-1">{groups.length}</p>
          </Card>
          <Card padding="md">
            <p className="text-xs text-txt-muted">Betroffene Produkte</p>
            <p className="text-2xl font-bold text-txt-primary mt-1">
              {groups.reduce((sum, g) => sum + g.productIds.length, 0)}
            </p>
          </Card>
          <Card padding="md">
            <p className="text-xs text-txt-muted">Erkennungsmethoden</p>
            <div className="flex gap-1.5 mt-2">
              {["ean", "mpn", "brand_name"].map((type) => {
                const count = groups.filter((g) => g.type === type).length;
                if (count === 0) return null;
                return (
                  <Badge key={type} variant={TYPE_VARIANTS[type]} size="sm">
                    {TYPE_LABELS[type]}: {count}
                  </Badge>
                );
              })}
            </div>
          </Card>
        </div>
      )}

      {/* Loading state */}
      {loading && (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-20 rounded-xl bg-app-elevated animate-pulse" />
          ))}
        </div>
      )}

      {/* Empty state */}
      {!loading && groups.length === 0 && (
        <Card padding="lg" className="text-center">
          <div className="flex flex-col items-center gap-3 py-6">
            <div className="w-14 h-14 rounded-full bg-success/10 flex items-center justify-center">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-success">
                <path d="M20 6L9 17l-5-5" />
              </svg>
            </div>
            <div>
              <p className="text-lg font-semibold text-txt-primary">Keine Duplikate gefunden</p>
              <p className="text-sm text-txt-muted mt-1">Alle {totalProducts} Produkte sind einzigartig.</p>
            </div>
          </div>
        </Card>
      )}

      {/* Duplicate groups list */}
      {!loading && groups.length > 0 && (
        <div className="space-y-3">
          {groups.map((group, idx) => (
            <Card key={`${group.type}-${group.key}-${idx}`} padding="md">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3 min-w-0">
                  <Badge variant={TYPE_VARIANTS[group.type]} size="sm">
                    {TYPE_LABELS[group.type]}
                  </Badge>
                  <span className="text-sm font-mono text-txt-primary truncate" title={group.key}>
                    {formatKey(group)}
                  </span>
                  <span className="text-xs text-txt-muted whitespace-nowrap">
                    {group.productIds.length} Produkte
                  </span>
                </div>
                <div className="flex items-center gap-2 ml-3">
                  {group.productIds.length === 2 && (
                    <Button size="sm" onClick={() => openMergeModal(group)}>
                      Vergleichen & Mergen
                    </Button>
                  )}
                  {group.productIds.length > 2 && (
                    <span className="text-xs text-txt-muted">Manuelles Mergen erforderlich</span>
                  )}
                </div>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {group.productIds.map((id) => (
                  <span
                    key={id}
                    className="text-xs font-mono px-2 py-0.5 rounded bg-app-elevated text-txt-secondary cursor-pointer hover:text-accent transition-colors"
                    onClick={() => { window.location.hash = `#/product/${id}`; }}
                    title={`Produkt öffnen: ${id}`}
                  >
                    {id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id}
                  </span>
                ))}
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Merge comparison modal */}
      {mergeModal && (
        <Modal open onClose={() => !merging && setMergeModal(null)} size="lg">
          <ModalHeader onClose={() => !merging && setMergeModal(null)}>Duplikat vergleichen</ModalHeader>
          <ModalBody>
            {mergeModal.loading ? (
              <div className="flex items-center justify-center py-12">
                <div className="w-8 h-8 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
              </div>
            ) : mergeModal.suggestions ? (
              <div className="space-y-4">
                <p className="text-sm text-txt-muted">
                  Wähle das Produkt, das <strong>behalten</strong> werden soll. Barcodes und Bilder des anderen Produkts werden übernommen, das andere wird archiviert.
                </p>

                <div className="grid grid-cols-2 gap-4">
                  {[mergeModal.suggestions.productA, mergeModal.suggestions.productB].map((product) => {
                    const isSelected = mergeModal.keepId === product.id;
                    return (
                      <Card
                        key={product.id}
                        padding="md"
                        className={`cursor-pointer transition-all ${
                          isSelected
                            ? "ring-2 ring-accent border-accent/50"
                            : "hover:border-app-border/80 opacity-70"
                        }`}
                        onClick={() => setMergeModal((prev) => prev ? { ...prev, keepId: product.id } : null)}
                      >
                        <div className="space-y-3">
                          <div className="flex items-center justify-between">
                            <Badge variant={isSelected ? "accent" : "neutral"} size="sm">
                              {isSelected ? "Behalten" : "Archivieren"}
                            </Badge>
                            <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center ${
                              isSelected ? "border-accent bg-accent" : "border-app-border"
                            }`}>
                              {isSelected && (
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round">
                                  <path d="M20 6L9 17l-5-5" />
                                </svg>
                              )}
                            </div>
                          </div>

                          <div>
                            <p className="text-sm font-semibold text-txt-primary truncate">{product.name || "—"}</p>
                            <p className="text-xs text-txt-muted mt-0.5">{product.brand || "—"}</p>
                          </div>

                          <div className="divide-y divide-app-border text-xs">
                            <div className="flex justify-between py-1">
                              <span className="text-txt-muted">SKU</span>
                              <span className="text-txt-primary font-mono">{product.sku || "—"}</span>
                            </div>
                            <div className="flex justify-between py-1">
                              <span className="text-txt-muted">Barcodes</span>
                              <span className="text-txt-primary">{product.barcodes?.length || 0}</span>
                            </div>
                            <div className="flex justify-between py-1">
                              <span className="text-txt-muted">Bilder</span>
                              <span className="text-txt-primary">{product.images}</span>
                            </div>
                            <div className="flex justify-between py-1">
                              <span className="text-txt-muted">Bestand</span>
                              <span className="text-txt-primary">{product.stock}</span>
                            </div>
                            <div className="flex justify-between py-1">
                              <span className="text-txt-muted">Erstellt</span>
                              <span className="text-txt-primary">
                                {product.createdAt
                                  ? new Date(product.createdAt).toLocaleDateString("de-DE")
                                  : "—"}
                              </span>
                            </div>
                          </div>
                        </div>
                      </Card>
                    );
                  })}
                </div>

                <div className="bg-app-elevated rounded-lg p-3 text-xs text-txt-muted">
                  <strong>Hinweis:</strong> Das archivierte Produkt wird NICHT gelöscht, sondern als zusammengeführt markiert. Barcodes und Bilder werden zum behaltenen Produkt übertragen.
                </div>
              </div>
            ) : null}
          </ModalBody>
          {mergeModal.suggestions && (
            <ModalFooter>
              <Button variant="secondary" onClick={() => setMergeModal(null)} disabled={merging}>
                Abbrechen
              </Button>
              <Button onClick={handleMerge} loading={merging} disabled={!mergeModal.keepId}>
                Zusammenführen
              </Button>
            </ModalFooter>
          )}
        </Modal>
      )}
    </div>
  );
};

export default DeduplicationView;

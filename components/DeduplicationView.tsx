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
import { PageTitle } from "./ui/PageTitle";
import type { Product } from "../types";
import {
  enrichDuplicateGroups,
  filterAndSortGroups,
  summarizeGroups,
  DUPLICATE_FILTER_DEFAULTS,
  type DuplicateFilters,
  type DuplicateSort,
} from "../utils/duplicates";

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

/**
 * Duplikate — Arbeitsliste statt Rätselraten.
 *
 * Der Server liefert je Gruppe nur Typ, Schlüssel und Produkt-IDs. Die Seite
 * zeigte genau das: einen Typ-Aufkleber und abgeschnittene Kennungen. Man
 * musste jeden Eintrag einzeln öffnen, um zu sehen, ob er Bestand hat oder
 * online steht — sortieren und filtern ging gar nicht.
 *
 * Die Produktdaten liegen im Browser bereits vor; sie werden hier an die
 * Gruppen gehängt. Damit steht alles in der Zeile, was für die Entscheidung
 * zählt, und die Liste lässt sich nach Dringlichkeit abarbeiten.
 */
interface DeduplicationViewProps {
  /** Bereits geladene Produkte — Quelle für Bestand, Preis und Online-Status. */
  products?: Product[];
}

const DeduplicationView: React.FC<DeduplicationViewProps> = ({ products = [] }) => {
  const [filters, setFilters] = useState<DuplicateFilters>(DUPLICATE_FILTER_DEFAULTS);
  const [sort, setSort] = useState<DuplicateSort>("prioritaet");
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
        // BUG-078: Filter groups with <2 products — a duplicate group needs ≥2 products
        const realDuplicates = result.data.duplicates.filter((g) => g.productIds.length >= 2);
        setGroups(realDuplicates);
        setTotalProducts(result.data.totalProducts);
      } else {
        addToast("error", `Fehler: ${result.error?.message || "Duplikate konnten nicht geladen werden."}`);
      }
    } catch (err: any) {
      addToast("error", `Fehler: ${err?.message || "Unbekannter Fehler"}`);
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
        addToast("error", `Fehler: ${result.error?.message || "Vorschläge konnten nicht geladen werden."}`);
        setMergeModal(null);
      }
    } catch (err: any) {
      addToast("error", `Fehler: ${err?.message || "Unbekannter Fehler"}`);
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
        addToast("success", `Produkte zusammengeführt: ${result.data.merged.barcodes} Barcodes, ${result.data.merged.images} Bilder übernommen`);
        setMergeModal(null);
        loadDuplicates();
      } else {
        addToast("error", `Merge fehlgeschlagen: ${result.error?.message || "Unbekannter Fehler"}`);
      }
    } catch (err: any) {
      addToast("error", `Fehler: ${err?.message || "Unbekannter Fehler"}`);
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

  const angereichert = React.useMemo(
    () => enrichDuplicateGroups(groups, products),
    [groups, products]
  );
  const sichtbar = React.useMemo(
    () => filterAndSortGroups(angereichert, filters, sort),
    [angereichert, filters, sort]
  );
  const zahlen = React.useMemo(() => summarizeGroups(angereichert), [angereichert]);
  const filterAktiv =
    filters.suche !== "" || filters.typ !== "alle" || filters.bestand !== "alle" || filters.online !== "alle";

  const selectCls =
    "rounded-lg border border-app-border bg-app-bg px-3 py-2 text-sm text-txt-primary focus:outline-none focus:ring-2 focus:ring-accent/40";

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <PageTitle>Duplikate</PageTitle>
          <p className="text-sm text-txt-muted mt-0.5">
            {loading ? "Analyse läuft…" : `${totalProducts} Produkte geprüft`}
          </p>
        </div>
        <Button variant="secondary" onClick={loadDuplicates} loading={loading}>
          Erneut scannen
        </Button>
      </div>

      {/* Womit anfangen? Die Kacheln sind die Arbeitsreihenfolge, nicht Statistik. */}
      {!loading && groups.length > 0 && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <button
            type="button"
            onClick={() => setFilters({ ...DUPLICATE_FILTER_DEFAULTS, online: "gelistet" })}
            className="rounded-xl border border-danger/30 bg-danger-dim p-4 text-left transition hover:border-danger"
          >
            <p className="text-xs font-semibold uppercase tracking-wide text-danger">Mehrfach online</p>
            <p className="mt-1 text-2xl font-bold text-danger">{zahlen.mehrfachOnline}</p>
            <p className="mt-0.5 text-[11px] text-danger/80">Überverkauf möglich — zuerst</p>
          </button>
          <button
            type="button"
            onClick={() => setFilters({ ...DUPLICATE_FILTER_DEFAULTS, bestand: "mit" })}
            className="rounded-xl border border-warning/30 bg-warning-dim p-4 text-left transition hover:border-warning"
          >
            <p className="text-xs font-semibold uppercase tracking-wide text-warning">Mit Bestand</p>
            <p className="mt-1 text-2xl font-bold text-warning">{zahlen.mitBestand}</p>
            <p className="mt-0.5 text-[11px] text-warning/80">Zählung wird sonst falsch</p>
          </button>
          <div className="rounded-xl border border-app-border bg-app-surface p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-txt-muted">Gruppen</p>
            <p className="mt-1 text-2xl font-bold text-txt-primary">{zahlen.gruppen}</p>
          </div>
          <div className="rounded-xl border border-app-border bg-app-surface p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-txt-muted">Betroffene Artikel</p>
            <p className="mt-1 text-2xl font-bold text-txt-primary">{zahlen.artikel}</p>
          </div>
        </div>
      )}

      {/* Filter + Sortierung */}
      {!loading && groups.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={filters.suche}
            onChange={(e) => setFilters((f) => ({ ...f, suche: e.target.value }))}
            placeholder="Name, SKU oder EAN suchen…"
            className={`${selectCls} min-w-[220px] flex-1`}
          />
          <select value={filters.typ} onChange={(e) => setFilters((f) => ({ ...f, typ: e.target.value }))} className={selectCls}>
            <option value="alle">Alle Erkennungen</option>
            <option value="ean">EAN / Barcode</option>
            <option value="mpn">Herstellernummer</option>
            <option value="brand_name">Marke + Name</option>
          </select>
          <select
            value={filters.bestand}
            onChange={(e) => setFilters((f) => ({ ...f, bestand: e.target.value as typeof f.bestand }))}
            className={selectCls}
          >
            <option value="alle">Bestand: egal</option>
            <option value="mit">Nur mit Bestand</option>
            <option value="ohne">Nur ohne Bestand</option>
          </select>
          <select
            value={filters.online}
            onChange={(e) => setFilters((f) => ({ ...f, online: e.target.value as typeof f.online }))}
            className={selectCls}
          >
            <option value="alle">Online: egal</option>
            <option value="gelistet">Nur gelistete</option>
            <option value="nichtGelistet">Nur nicht gelistete</option>
          </select>
          <select value={sort} onChange={(e) => setSort(e.target.value as DuplicateSort)} className={selectCls}>
            <option value="prioritaet">Sortierung: Dringlichkeit</option>
            <option value="bestand">Sortierung: Bestand</option>
            <option value="wert">Sortierung: Preis</option>
            <option value="anzahl">Sortierung: Anzahl Artikel</option>
            <option value="name">Sortierung: Name</option>
          </select>
          {filterAktiv && (
            <button
              type="button"
              onClick={() => setFilters(DUPLICATE_FILTER_DEFAULTS)}
              className="text-sm font-medium text-accent hover:underline"
            >
              Filter zurücksetzen
            </button>
          )}
          <span className="ml-auto text-sm text-txt-muted">
            {sichtbar.length} von {zahlen.gruppen} Gruppen
          </span>
        </div>
      )}

      {/* Ladezustand */}
      {loading && (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-28 rounded-xl bg-app-elevated animate-pulse" />
          ))}
        </div>
      )}

      {/* Nichts gefunden */}
      {!loading && groups.length === 0 && (
        <Card padding="lg" className="text-center">
          <div className="flex flex-col items-center gap-3 py-6">
            <div className="w-14 h-14 rounded-full bg-success/10 flex items-center justify-center">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-success">
                <path d="M20 6L9 17l-5-5" />
              </svg>
            </div>
            <div>
              <p className="text-lg font-semibold text-txt-primary">Keine Duplikate</p>
              <p className="text-sm text-txt-muted mt-1">Alle {totalProducts} Produkte sind eindeutig.</p>
            </div>
          </div>
        </Card>
      )}

      {/* Filter zu eng — anderer Fall als "keine Duplikate" */}
      {!loading && groups.length > 0 && sichtbar.length === 0 && (
        <Card padding="lg" className="text-center">
          <p className="text-sm text-txt-primary">Kein Treffer für diese Filter.</p>
          <button
            type="button"
            onClick={() => setFilters(DUPLICATE_FILTER_DEFAULTS)}
            className="mt-2 text-sm font-medium text-accent hover:underline"
          >
            Filter zurücksetzen
          </button>
        </Card>
      )}

      {/* Gruppen — alles Nötige steht in der Zeile, ohne Öffnen */}
      {!loading && sichtbar.length > 0 && (
        <div className="space-y-3">
          {sichtbar.map((group, idx) => (
            <Card key={`${group.type}-${group.key}-${idx}`} padding="md">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span
                    className={`rounded px-2 py-0.5 text-[11px] font-semibold ${
                      group.priority >= 100
                        ? "bg-danger-dim text-danger"
                        : group.priority >= 80
                          ? "bg-warning-dim text-warning"
                          : group.priority >= 50
                            ? "bg-accent-dim text-accent"
                            : "bg-app-elevated text-txt-muted"
                    }`}
                  >
                    {group.priorityReason}
                  </span>
                  <Badge variant={TYPE_VARIANTS[group.type] || "neutral"} size="sm">
                    {TYPE_LABELS[group.type] || group.type}
                  </Badge>
                  <span className="truncate font-mono text-sm text-txt-secondary" title={group.key}>
                    {formatKey({ type: group.type, key: group.key, productIds: [] } as DuplicateGroup)}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {group.members.length === 2 ? (
                    <Button
                      size="sm"
                      onClick={() =>
                        openMergeModal({ type: group.type, key: group.key, productIds: group.members.map((m) => m.id) } as DuplicateGroup)
                      }
                    >
                      Vergleichen & zusammenführen
                    </Button>
                  ) : (
                    <span className="text-xs text-txt-muted">{group.members.length} Artikel — von Hand zusammenführen</span>
                  )}
                </div>
              </div>

              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {group.members.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => { window.location.hash = `#/sheet/${m.id}`; }}
                    className="flex items-start gap-3 rounded-lg border border-app-border bg-app-bg/50 p-2.5 text-left transition hover:border-accent/50"
                  >
                    <div className="h-14 w-14 shrink-0 overflow-hidden rounded-md border border-app-border bg-app-elevated">
                      {m.imageUrl ? (
                        <img src={m.imageUrl} alt="" className="h-full w-full object-contain" loading="lazy" />
                      ) : null}
                    </div>
                    <div className="min-w-0 flex-1">
                      {m.missing ? (
                        <p className="text-sm text-txt-muted">Artikel nicht mehr vorhanden ({m.id.slice(0, 10)}…)</p>
                      ) : (
                        <>
                          <p className="truncate text-sm font-medium text-txt-primary">{m.name || "Ohne Namen"}</p>
                          <p className="mt-0.5 truncate font-mono text-[11px] text-txt-muted">
                            {m.sku || "—"}{m.ean ? ` · ${m.ean}` : ""}
                          </p>
                          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px]">
                            <span
                              className={`rounded px-1.5 py-0.5 font-semibold ${
                                m.physical > 0 ? "bg-warning-dim text-warning" : "bg-app-elevated text-txt-muted"
                              }`}
                            >
                              Bestand {m.physical}
                            </span>
                            {m.binCode && <span className="text-txt-muted">{m.binCode}</span>}
                            {m.price != null && (
                              <span className="text-txt-secondary">
                                {m.price.toLocaleString("de-DE", { style: "currency", currency: "EUR" })}
                              </span>
                            )}
                            {m.listedEbay && <span className="rounded bg-info-dim px-1.5 py-0.5 text-info">eBay online</span>}
                            {m.listedKaufland && <span className="rounded bg-accent-dim px-1.5 py-0.5 text-accent">Kaufland online</span>}
                          </div>
                        </>
                      )}
                    </div>
                  </button>
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

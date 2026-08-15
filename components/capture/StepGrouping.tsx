import React, { useState, useEffect, useCallback, useRef } from "react";
import { Card } from "../ui/Card";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { ProgressBar } from "../ui/ProgressBar";
import { groupImages } from "../../api/client";
import type { ProductGroupProposal } from "../../api/client";
import type { ImagePreview, ConfirmedGroup } from "./CaptureView";
import { compressImageForUpload } from "../../utils/imageCompress";

interface StepGroupingProps {
  images: ImagePreview[];
  barcodes: string;
  onConfirm: (groups: ConfirmedGroup[]) => void;
  onBack: () => void;
  /**
   * Bereits bestätigte Gruppen aus einem früheren Besuch.
   *
   * Der Startschutz dieses Schrittes lag in einem Ref, das mit der Instanz
   * stirbt. Beim Zurückkommen lief deshalb `groupImages` erneut (echter
   * Gemini-Aufruf plus Bildkompression) und überschrieb jede von Hand gezogene
   * Zuordnung. Liegen Gruppen vor, wird nichts neu berechnet.
   */
  initialGroups?: ConfirmedGroup[] | null;
}

interface LocalGroup {
  id: string;
  label: string;
  imageIds: string[];
  barcodes: string;
  confidence: number;
  reason: string;
  hint: string;
  checked: boolean;
}

const createId = () =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `g_${Math.random().toString(36).slice(2, 9)}`;

// Grouping only needs low-res images — 1024px JPEG 60% is plenty and reduces
// 25 × 5MB photos (~125MB) to ~25 × 80KB (~2MB), well under Cloud Run's 32MB
// limit. The implementation lives in utils/imageCompress.ts and is shared with
// StepAnalysis (which uses higher-fidelity defaults for actual identify).
const compressForGrouping = (file: File) =>
  compressImageForUpload(file, { maxDim: 1024, quality: 0.6, skipIfSmallerThanBytes: 200_000 });

const ConfidenceBadge: React.FC<{ value: number }> = ({ value }) => (
  <span className={`text-xs px-2 py-0.5 rounded-full ${
    value >= 0.8
      ? "bg-success/10 text-success"
      : value >= 0.6
      ? "bg-warning/10 text-warning"
      : "bg-danger/10 text-danger"
  }`}>
    {Math.round(value * 100)}%
  </span>
);

const StepGrouping: React.FC<StepGroupingProps> = ({ images, barcodes, onConfirm, onBack, initialGroups }) => {
  // Bestätigte Gruppen zurückübersetzen. Die File-Objekte sind dieselben
  // Instanzen wie in `images`, deshalb trägt der Identitätsvergleich.
  const restoredGroups = React.useMemo<LocalGroup[] | null>(() => {
    if (!initialGroups?.length) return null;
    return initialGroups.map((g, idx) => ({
      id: g.id,
      label: g.label || `Produkt ${idx + 1}`,
      imageIds: g.images
        .map((file) => images.find((img) => img.file === file)?.id)
        .filter(Boolean) as string[],
      barcodes: g.barcodes || "",
      confidence: 1,
      reason: "Bereits bestätigt",
      hint: g.hint || "",
      checked: true,
    }));
  }, [initialGroups, images]);

  const [groups, setGroups] = useState<LocalGroup[]>(() => restoredGroups ?? []);
  const [loading, setLoading] = useState(() => !restoredGroups);
  const [error, setError] = useState<string | null>(null);
  const [dragSourceGroup, setDragSourceGroup] = useState<string | null>(null);
  const [dragImageId, setDragImageId] = useState<string | null>(null);
  const [dragOverGroup, setDragOverGroup] = useState<string | null>(null);
  // Sobald der Nutzer Gruppen manuell verändert hat, darf die UI nicht mehr
  // in den Einzelbild-Checklist-Modus springen — der hat keine Gruppen-Controls
  // und wäre eine Sackgasse (Review-Finding).
  // Wiederhergestellte Gruppen gelten als von Hand bestätigt: die Ansicht darf
  // nicht in den Einzelbild-Modus zurückfallen.
  const [manualEdit, setManualEdit] = useState(() => Boolean(restoredGroups));
  const startedRef = useRef(Boolean(restoredGroups));

  const buildLocalGroups = useCallback(
    (apiGroups: ProductGroupProposal[]): LocalGroup[] =>
      apiGroups.map((g: ProductGroupProposal, idx: number) => ({
        id: g.id || createId(),
        label: g.label || `Produkt ${idx + 1}`,
        imageIds: Array.from(
          new Set(g.image_indices.map((i: number) => images[i]?.id).filter(Boolean))
        ) as string[],
        barcodes: g.detected_barcode || "",
        confidence: g.confidence,
        reason: g.reason,
        hint: g.hint || "",
        checked: g.confidence >= 0.6,
      })),
    [images]
  );

  const fallbackGroup = useCallback(
    (reason: string): LocalGroup => ({
      id: createId(),
      label: "Produkt 1",
      imageIds: images.map((img) => img.id),
      barcodes: barcodes || "",
      confidence: 1,
      reason,
      hint: "",
      checked: true,
    }),
    [images, barcodes]
  );

  // Load grouping proposals from backend
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const run = async () => {
      try {
        // Compress images client-side before upload — raw photos can be 5-10MB each,
        // 25 images = 125-250MB which exceeds Cloud Run's 32MB request limit.
        const rawFiles = images.map((img) => img.file);
        const files = await Promise.all(rawFiles.map(compressForGrouping));
        const result = await groupImages(files, barcodes);

        if (!result.ok || !result.data?.groups?.length) {
          console.warn("[StepGrouping] groupImages returned", result.ok ? "empty groups" : `ok:false — ${result.error?.code}: ${result.error?.message}`);
          setGroups([fallbackGroup("Alle Bilder in eine Gruppe")]);
        } else {
          setGroups(buildLocalGroups(result.data.groups));
        }
      } catch (err: any) {
        console.error("[StepGrouping] groupImages threw:", err);
        setError(err?.message || "Gruppierung fehlgeschlagen");
        setGroups([fallbackGroup("Fallback: alle Bilder in eine Gruppe")]);
      } finally {
        setLoading(false);
      }
    };

    run();
  }, [images, barcodes, buildLocalGroups, fallbackGroup]);

  // --- Shared callbacks ---

  const toggleGroupChecked = useCallback((groupId: string) => {
    setGroups((prev) =>
      prev.map((g) => (g.id === groupId ? { ...g, checked: !g.checked } : g))
    );
  }, []);

  const updateGroupBarcodes = useCallback((groupId: string, value: string) => {
    setGroups((prev) =>
      prev.map((g) => (g.id === groupId ? { ...g, barcodes: value } : g))
    );
  }, []);

  const updateGroupLabel = useCallback((groupId: string, value: string) => {
    setGroups((prev) =>
      prev.map((g) => (g.id === groupId ? { ...g, label: value } : g))
    );
  }, []);

  // --- Multi-image grouping callbacks ---

  const resetToOneGroup = useCallback(() => {
    setGroups([fallbackGroup("Manuell: alle in eine Gruppe")]);
  }, [fallbackGroup]);

  const addGroup = useCallback(() => {
    setManualEdit(true);
    setGroups((prev) => [
      ...prev,
      {
        id: createId(),
        label: `Produkt ${prev.length + 1}`,
        imageIds: [],
        barcodes: "",
        confidence: 1,
        reason: "Manuell erstellt",
        hint: "",
        checked: true,
      },
    ]);
  }, []);

  const removeGroup = useCallback((groupId: string) => {
    setManualEdit(true);
    setGroups((prev) => {
      const removed = prev.find((g) => g.id === groupId);
      if (!removed || prev.length <= 1) return prev;
      const remaining = prev.filter((g) => g.id !== groupId);
      // Nur wirklich verwaiste Bilder in die erste Gruppe übernehmen — ein
      // geteiltes Foto lebt evtl. noch in einer anderen Gruppe und würde dem
      // ersten Produkt sonst ein fremdes Foto unterschieben
      const stillReferenced = new Set(remaining.flatMap((g) => g.imageIds));
      const orphans = removed.imageIds.filter((id) => !stillReferenced.has(id));
      if (!orphans.length) return remaining;
      return remaining.map((g, i) =>
        i === 0 ? { ...g, imageIds: [...g.imageIds, ...orphans] } : g
      );
    });
  }, []);

  const copyImageToNewGroup = useCallback((imageId: string) => {
    setManualEdit(true);
    setGroups((prev) => [
      ...prev,
      {
        id: createId(),
        label: `Produkt ${prev.length + 1}`,
        imageIds: [imageId],
        barcodes: "",
        confidence: 1,
        reason: "Weiteres Produkt auf geteiltem Foto",
        hint: "",
        checked: true,
      },
    ]);
  }, []);

  // Drag & drop between groups
  const handleImageDragStart = useCallback((e: React.DragEvent, groupId: string, imageId: string) => {
    setDragSourceGroup(groupId);
    setDragImageId(imageId);
    e.dataTransfer.setData("application/json", JSON.stringify({ groupId, imageId }));
    e.dataTransfer.effectAllowed = "copyMove";
  }, []);

  const handleGroupDrop = useCallback((e: React.DragEvent, targetGroupId: string) => {
    e.preventDefault();
    setDragOverGroup(null);
    try {
      const data = JSON.parse(e.dataTransfer.getData("application/json"));
      const { groupId: sourceGroupId, imageId } = data;
      if (!sourceGroupId || !imageId || sourceGroupId === targetGroupId) return;
      // Alt-/Strg-Drag kopiert: das Foto bleibt in der Quellgruppe (mehrere
      // Produkte auf einem Bild). Strg zusätzlich, weil der Browser-Cursor
      // unter Windows/Linux bei Strg bereits "Kopieren" verspricht.
      const copy = e.altKey || e.ctrlKey;

      setManualEdit(true);
      setGroups((prev) =>
        prev.map((g) => {
          if (g.id === sourceGroupId && !copy) {
            return { ...g, imageIds: g.imageIds.filter((id) => id !== imageId) };
          }
          if (g.id === targetGroupId && !g.imageIds.includes(imageId)) {
            return { ...g, imageIds: [...g.imageIds, imageId] };
          }
          return g;
        })
      );
    } catch {
      // Ignore parse errors
    }
  }, []);

  // --- Confirm ---

  const handleConfirm = useCallback(() => {
    const confirmed: ConfirmedGroup[] = groups
      .filter((g) => g.checked && g.imageIds.length > 0)
      .map((g) => ({
        id: g.id,
        label: g.label,
        images: g.imageIds
          .map((id) => images.find((img) => img.id === id)?.file)
          .filter(Boolean) as File[],
        barcodes: g.barcodes,
        hint: g.hint || undefined,
      }));

    if (!confirmed.length) return;
    onConfirm(confirmed);
  }, [groups, images, onConfirm]);

  const getImage = (id: string) => images.find((img) => img.id === id);

  // --- Derived state ---

  const isSingleImageMultiProduct = images.length === 1 && groups.length > 1 && !manualEdit;
  const checkedCount = groups.filter((g) => g.checked).length;

  // --- Loading state ---

  if (loading) {
    return (
      <Card padding="lg">
        <div className="text-center space-y-4">
          <h2 className="text-lg font-semibold text-txt-primary">
            {images.length === 1
              ? "Bild wird auf mehrere Produkte analysiert..."
              : "Bilder werden analysiert..."}
          </h2>
          <p className="text-sm text-txt-muted">
            KI erkennt automatisch verschiedene Produkte in deinen Bildern.
          </p>
          <ProgressBar value={50} variant="accent" />
        </div>
      </Card>
    );
  }

  // --- Single-image multi-product mode ---

  if (isSingleImageMultiProduct) {
    const image = images[0];

    return (
      <div className="space-y-6">
        {/* Header */}
        <Card padding="sm">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-txt-primary">
                KI hat {groups.length} Produkte auf einem Bild erkannt
              </p>
              <p className="text-xs text-txt-muted mt-0.5">
                Wähle die Produkte, die du erfassen möchtest. Niedrige Konfidenz (&lt;60%) ist deaktiviert.
              </p>
            </div>
            {error && <p className="text-xs text-danger">{error}</p>}
          </div>
        </Card>

        {/* Content: Image + Product list */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Left: Large image */}
          <Card padding="sm">
            <img
              src={image.url}
              alt=""
              className="w-full rounded-lg object-contain max-h-[500px]"
            />
          </Card>

          {/* Right: Product checklist */}
          <div className="space-y-3">
            {groups.map((group) => (
              <Card
                key={group.id}
                padding="sm"
                className={!group.checked ? "opacity-60" : ""}
              >
                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={group.checked}
                    onChange={() => toggleGroupChecked(group.id)}
                    className="mt-1 accent-[var(--color-accent)]"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-medium text-txt-primary truncate">
                        {group.label}
                      </p>
                      <ConfidenceBadge value={group.confidence} />
                    </div>
                    {group.reason && (
                      <p className="text-xs text-txt-muted mt-0.5 truncate">
                        {group.reason}
                      </p>
                    )}
                    <div className="mt-2">
                      <Input
                        value={group.barcodes}
                        onChange={(e) => updateGroupBarcodes(group.id, e.target.value)}
                        placeholder="Barcode / EAN (optional)"
                        className="text-xs"
                      />
                    </div>
                  </div>
                </label>
              </Card>
            ))}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-between">
          <Button variant="secondary" onClick={onBack}>
            Zurück
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={checkedCount === 0}
          >
            {checkedCount} Produkt{checkedCount !== 1 ? "e" : ""} bestätigen
          </Button>
        </div>
      </div>
    );
  }

  // --- Standard multi-image grouping mode ---

  return (
    <div className="space-y-6">
      {/* Header */}
      <Card padding="sm">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold text-txt-primary">
              KI hat {groups.length} Produkt{groups.length !== 1 ? "e" : ""} in {images.length} Bildern erkannt
            </p>
            <p className="text-xs text-txt-muted mt-0.5">
              Prüfe die Zuordnung und korrigiere bei Bedarf. Drag & Drop verschiebt ein Bild, mit gedrückter Alt-/Strg-Taste wird es kopiert. ⧉ legt ein Bild als weiteres Produkt in eine neue Gruppe — ein Foto kann so für mehrere Produkte stehen. Benenne Gruppen möglichst konkret, das hilft der KI-Erkennung.
            </p>
          </div>
          {error && <p className="text-xs text-danger">{error}</p>}
        </div>
      </Card>

      {/* Groups */}
      <div className="space-y-4">
        {groups.map((group) => (
          <Card
            key={group.id}
            padding="sm"
            className={[
              dragOverGroup === group.id ? "ring-2 ring-accent/40" : "",
              !group.checked ? "opacity-60" : "",
            ].filter(Boolean).join(" ")}
          >
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOverGroup(group.id); }}
              onDragLeave={() => setDragOverGroup(null)}
              onDrop={(e) => handleGroupDrop(e, group.id)}
            >
              {/* Group header */}
              <div className="flex items-center justify-between mb-3 gap-3">
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <input
                    type="checkbox"
                    checked={group.checked}
                    onChange={() => toggleGroupChecked(group.id)}
                    title="Gruppe erfassen ja/nein"
                    className="accent-[var(--color-accent)] shrink-0"
                  />
                  <Input
                    value={group.label}
                    onChange={(e) => updateGroupLabel(group.id, e.target.value)}
                    placeholder="Was ist das Produkt?"
                    className="text-sm font-semibold max-w-xs"
                  />
                  <ConfidenceBadge value={group.confidence} />
                  {group.reason && (
                    <span className="text-xs text-txt-muted truncate">{group.reason}</span>
                  )}
                </div>
                {groups.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeGroup(group.id)}
                    className="text-xs text-danger hover:text-danger/80 transition-colors"
                  >
                    Gruppe entfernen
                  </button>
                )}
              </div>

              {/* Images */}
              <div className="flex flex-wrap gap-2 min-h-[60px]">
                {group.imageIds.length === 0 && (
                  <p className="text-xs text-txt-muted italic py-4">
                    Bilder hierher ziehen
                  </p>
                )}
                {group.imageIds.map((imgId) => {
                  const img = getImage(imgId);
                  if (!img) return null;
                  const sharedCount = groups.filter((g) => g.imageIds.includes(imgId)).length;
                  return (
                    <div
                      key={imgId}
                      draggable
                      onDragStart={(e) => handleImageDragStart(e, group.id, imgId)}
                      className="relative w-20 h-20 rounded-lg overflow-hidden border border-app-border cursor-grab active:cursor-grabbing hover:ring-2 hover:ring-accent/30 transition-all"
                    >
                      <img
                        src={img.url}
                        alt=""
                        className="w-full h-full object-cover pointer-events-none select-none"
                      />
                      {sharedCount > 1 && (
                        <span
                          className="absolute top-1 left-1 text-[10px] leading-none px-1 py-0.5 rounded bg-app-surface/90 border border-app-border text-txt-muted"
                          title={`Bild wird von ${sharedCount} Gruppen genutzt`}
                        >
                          ×{sharedCount}
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); copyImageToNewGroup(imgId); }}
                        title="Bild in neue Gruppe kopieren (weiteres Produkt auf diesem Foto)"
                        className="absolute bottom-1 right-1 w-5 h-5 flex items-center justify-center rounded bg-app-surface/90 border border-app-border text-txt-muted hover:text-accent hover:border-accent/50 transition-colors text-xs"
                      >
                        ⧉
                      </button>
                    </div>
                  );
                })}
              </div>

              {/* Barcode input */}
              <div className="mt-3">
                <Input
                  value={group.barcodes}
                  onChange={(e) => updateGroupBarcodes(group.id, e.target.value)}
                  placeholder="Barcode / EAN (optional)"
                  className="text-xs"
                />
              </div>
            </div>
          </Card>
        ))}
      </div>

      {/* Actions */}
      <div className="flex items-center justify-between">
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={addGroup}>
            + Neue Gruppe
          </Button>
          <Button variant="secondary" size="sm" onClick={resetToOneGroup}>
            Alle in eine Gruppe
          </Button>
        </div>
        <div className="flex gap-3">
          <Button variant="secondary" onClick={onBack}>
            Zurück
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={!groups.some((g) => g.checked && g.imageIds.length > 0)}
          >
            Zuordnung bestätigen
          </Button>
        </div>
      </div>
    </div>
  );
};

export default StepGrouping;

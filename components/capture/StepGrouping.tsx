import React, { useState, useEffect, useCallback, useRef } from "react";
import { Card } from "../ui/Card";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { ProgressBar } from "../ui/ProgressBar";
import { groupImages } from "../../api/client";
import type { ProductGroupProposal } from "../../api/client";
import type { ImagePreview, ConfirmedGroup } from "./CaptureView";

interface StepGroupingProps {
  images: ImagePreview[];
  barcodes: string;
  onConfirm: (groups: ConfirmedGroup[]) => void;
  onBack: () => void;
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

const StepGrouping: React.FC<StepGroupingProps> = ({ images, barcodes, onConfirm, onBack }) => {
  const [groups, setGroups] = useState<LocalGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dragSourceGroup, setDragSourceGroup] = useState<string | null>(null);
  const [dragImageId, setDragImageId] = useState<string | null>(null);
  const [dragOverGroup, setDragOverGroup] = useState<string | null>(null);
  const startedRef = useRef(false);

  const buildLocalGroups = useCallback(
    (apiGroups: ProductGroupProposal[]): LocalGroup[] =>
      apiGroups.map((g: ProductGroupProposal, idx: number) => ({
        id: g.id || createId(),
        label: g.label || `Produkt ${idx + 1}`,
        imageIds: g.image_indices.map((i: number) => images[i]?.id).filter(Boolean),
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
        const files = images.map((img) => img.file);
        const result = await groupImages(files, barcodes);

        if (!result.ok || !result.data?.groups?.length) {
          setGroups([fallbackGroup("Alle Bilder in eine Gruppe")]);
        } else {
          setGroups(buildLocalGroups(result.data.groups));
        }
      } catch (err: any) {
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

  // --- Multi-image grouping callbacks ---

  const resetToOneGroup = useCallback(() => {
    setGroups([fallbackGroup("Manuell: alle in eine Gruppe")]);
  }, [fallbackGroup]);

  const addGroup = useCallback(() => {
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
    setGroups((prev) => {
      const removed = prev.find((g) => g.id === groupId);
      if (!removed || prev.length <= 1) return prev;
      const remaining = prev.filter((g) => g.id !== groupId);
      // Move orphaned images to first group
      remaining[0].imageIds = [...remaining[0].imageIds, ...removed.imageIds];
      return remaining;
    });
  }, []);

  // Drag & drop between groups
  const handleImageDragStart = useCallback((e: React.DragEvent, groupId: string, imageId: string) => {
    setDragSourceGroup(groupId);
    setDragImageId(imageId);
    e.dataTransfer.setData("application/json", JSON.stringify({ groupId, imageId }));
    e.dataTransfer.effectAllowed = "move";
  }, []);

  const handleGroupDrop = useCallback((e: React.DragEvent, targetGroupId: string) => {
    e.preventDefault();
    setDragOverGroup(null);
    try {
      const data = JSON.parse(e.dataTransfer.getData("application/json"));
      const { groupId: sourceGroupId, imageId } = data;
      if (!sourceGroupId || !imageId || sourceGroupId === targetGroupId) return;

      setGroups((prev) =>
        prev.map((g) => {
          if (g.id === sourceGroupId) {
            return { ...g, imageIds: g.imageIds.filter((id) => id !== imageId) };
          }
          if (g.id === targetGroupId) {
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

  const isSingleImageMultiProduct = images.length === 1 && groups.length > 1;
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
              Prüfe die Zuordnung und korrigiere bei Bedarf. Bilder per Drag & Drop zwischen Gruppen verschieben.
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
            className={dragOverGroup === group.id ? "ring-2 ring-accent/40" : ""}
          >
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOverGroup(group.id); }}
              onDragLeave={() => setDragOverGroup(null)}
              onDrop={(e) => handleGroupDrop(e, group.id)}
            >
              {/* Group header */}
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold text-txt-primary">{group.label}</p>
                  <ConfidenceBadge value={group.confidence} />
                  {group.reason && (
                    <span className="text-xs text-txt-muted">{group.reason}</span>
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
                  return (
                    <div
                      key={imgId}
                      draggable
                      onDragStart={(e) => handleImageDragStart(e, group.id, imgId)}
                      className="w-20 h-20 rounded-lg overflow-hidden border border-app-border cursor-grab active:cursor-grabbing hover:ring-2 hover:ring-accent/30 transition-all"
                    >
                      <img
                        src={img.url}
                        alt=""
                        className="w-full h-full object-cover pointer-events-none select-none"
                      />
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
            disabled={groups.every((g) => g.imageIds.length === 0)}
          >
            Zuordnung bestätigen
          </Button>
        </div>
      </div>
    </div>
  );
};

export default StepGrouping;

import React, { useState, useCallback, useRef } from "react";
import { Card } from "../ui/Card";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import type { CaptureUploadData, ImagePreview } from "./CaptureView";

interface StepUploadProps {
  onComplete: (data: CaptureUploadData) => void;
  paletteCode?: string;
}

const createId = () =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2, 10);

const MAX_FILES = 10;
const MAX_FILE_SIZE = 8 * 1024 * 1024;
const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp"];

const StepUpload: React.FC<StepUploadProps> = ({ onComplete, paletteCode }) => {
  const [images, setImages] = useState<ImagePreview[]>([]);
  const [barcodes, setBarcodes] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [dragOverImage, setDragOverImage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const addFiles = useCallback((files: FileList | File[]) => {
    setError(null);
    const fileArr = Array.from(files);

    const invalid = fileArr.find((f) => !ACCEPTED_TYPES.includes(f.type));
    if (invalid) {
      setError(`"${invalid.name}" hat ein ungültiges Format. Erlaubt: JPG, PNG, WEBP.`);
      return;
    }
    const tooLarge = fileArr.find((f) => f.size > MAX_FILE_SIZE);
    if (tooLarge) {
      setError(`"${tooLarge.name}" ist zu groß (max. 8 MB).`);
      return;
    }

    setImages((prev) => {
      const total = prev.length + fileArr.length;
      if (total > MAX_FILES) {
        setError(`Maximal ${MAX_FILES} Bilder pro Upload.`);
        return prev;
      }
      return [
        ...prev,
        ...fileArr.map((f) => ({
          id: createId(),
          file: f,
          url: URL.createObjectURL(f),
        })),
      ];
    });
  }, []);

  const removeImage = useCallback((id: string) => {
    setImages((prev) => {
      const img = prev.find((i) => i.id === id);
      if (img) URL.revokeObjectURL(img.url);
      return prev.filter((i) => i.id !== id);
    });
  }, []);

  // Image reordering via drag & drop
  const handleImageDragStart = useCallback((e: React.DragEvent, imageId: string) => {
    e.dataTransfer.setData("text/plain", imageId);
    e.dataTransfer.effectAllowed = "move";
  }, []);

  const handleImageDrop = useCallback((e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    setDragOverImage(null);
    const sourceId = e.dataTransfer.getData("text/plain");
    if (!sourceId || sourceId === targetId) return;
    setImages((prev) => {
      const sourceIdx = prev.findIndex((i) => i.id === sourceId);
      const targetIdx = prev.findIndex((i) => i.id === targetId);
      if (sourceIdx === -1 || targetIdx === -1) return prev;
      const next = [...prev];
      const [moved] = next.splice(sourceIdx, 1);
      next.splice(targetIdx, 0, moved);
      return next;
    });
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
    },
    [addFiles]
  );

  const handleSubmit = useCallback(() => {
    const hasImages = images.length > 0;
    const hasBarcodes = barcodes.trim().length > 0;
    if (!hasImages && !hasBarcodes) {
      setError("Bitte lade mindestens ein Bild hoch oder gib einen Barcode ein.");
      return;
    }
    onComplete({
      groups: [
        {
          id: createId(),
          label: "Produkt 1",
          images: images.map((i) => i.file),
        },
      ],
      barcodes: barcodes.trim(),
      paletteCode: paletteCode || "",
      allImages: images,
    });
  }, [images, barcodes, onComplete, paletteCode]);

  const hasImages = images.length > 0;
  const noPalette = !paletteCode;

  return (
    <div className="space-y-6">
      {/* 2-column layout on lg screens */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6">
        {/* Left: Dropzone + Thumbnails */}
        <div className="space-y-4">
          {/* Drop zone */}
          <Card padding="none">
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`
                flex flex-col items-center justify-center p-6 cursor-pointer
                border-2 border-dashed rounded-2xl transition-all
                ${hasImages ? "min-h-[120px]" : "min-h-[240px]"}
                ${dragOver
                  ? "border-accent bg-accent/5 animate-pulse"
                  : "border-app-border hover:border-accent/50 hover:bg-app-elevated/30"
                }
              `}
            >
              {dragOver ? (
                <p className="text-accent font-medium">Loslassen zum Hochladen</p>
              ) : (
                <>
                  <svg
                    width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
                    className="text-txt-muted mb-3"
                  >
                    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                  <p className="text-txt-primary font-medium mb-1">
                    {hasImages ? "Weitere Bilder hinzufügen" : "Bilder hierher ziehen"}
                  </p>
                  <p className="text-xs text-txt-muted">
                    JPG, PNG, WEBP · max. 8 MB · bis zu {MAX_FILES} Bilder
                  </p>
                </>
              )}
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={ACCEPTED_TYPES.join(",")}
                className="hidden"
                onChange={(e) => {
                  if (e.target.files?.length) addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
            </div>
          </Card>

          {/* Image previews — reorderable */}
          {hasImages && (
            <div className="grid grid-cols-4 md:grid-cols-6 gap-3">
              {images.map((img, idx) => (
                <div
                  key={img.id}
                  draggable
                  onDragStart={(e) => handleImageDragStart(e, img.id)}
                  onDragOver={(e) => { e.preventDefault(); setDragOverImage(img.id); }}
                  onDragLeave={() => setDragOverImage(null)}
                  onDrop={(e) => handleImageDrop(e, img.id)}
                  className={`relative group aspect-square rounded-xl overflow-hidden border bg-app-elevated cursor-grab active:cursor-grabbing transition-all ${
                    dragOverImage === img.id ? "border-accent ring-2 ring-accent/30 scale-105" : "border-app-border"
                  }`}
                >
                  <img
                    src={img.url}
                    alt={img.file.name}
                    className="w-full h-full object-cover pointer-events-none select-none"
                  />
                  {/* First image badge */}
                  {idx === 0 && (
                    <span className="absolute top-1 left-1 px-1.5 py-0.5 text-[10px] font-semibold bg-accent text-white rounded-md">
                      Hauptbild
                    </span>
                  )}
                  {/* Drag handle */}
                  <span className="absolute bottom-1 left-1 opacity-0 group-hover:opacity-70 text-white drop-shadow transition-opacity">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                      <circle cx="9" cy="5" r="1.5"/><circle cx="15" cy="5" r="1.5"/>
                      <circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/>
                      <circle cx="9" cy="19" r="1.5"/><circle cx="15" cy="19" r="1.5"/>
                    </svg>
                  </span>
                  {/* Remove button */}
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); removeImage(img.id); }}
                    className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-black/60 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-danger"
                    aria-label="Bild entfernen"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
                      <path d="M18 6L6 18M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              ))}
              {/* Quick-add button */}
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="aspect-square rounded-xl border-2 border-dashed border-app-border hover:border-accent/50 flex items-center justify-center text-txt-muted hover:text-accent transition-colors"
              >
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </button>
            </div>
          )}
        </div>

        {/* Right sidebar: Barcode + Info */}
        <div className="space-y-4">
          <Card padding="sm">
            <div className="space-y-2">
              <label className="text-sm font-medium text-txt-primary">
                Barcode / EAN (optional)
              </label>
              <Input
                value={barcodes}
                onChange={(e) => setBarcodes(e.target.value)}
                placeholder="z.B. 4006381333931"
                helpText="Mehrere kommagetrennt eingeben."
              />
            </div>
          </Card>

          <Card padding="sm">
            <div className="space-y-2">
              <p className="text-sm font-medium text-txt-primary">Tipps</p>
              <ul className="text-xs text-txt-muted space-y-1.5">
                <li>Bilder von allen Seiten aufnehmen (Front, Rück, Seite, Detail)</li>
                <li>Barcode-Foto beschleunigt die Erkennung</li>
                <li>Erstes Bild = Hauptbild (per Drag umsortieren)</li>
                <li>Mehrere Produkte? Einfach alle Bilder hochladen — KI gruppiert automatisch</li>
              </ul>
            </div>
          </Card>
        </div>
      </div>

      {/* Error */}
      {error && (
        <p className="text-sm text-danger">{error}</p>
      )}

      {/* Actions */}
      <div className="flex justify-end gap-3 items-center">
        {noPalette && (
          <p className="text-sm text-danger">Bitte zuerst Palette auswählen</p>
        )}
        <Button
          onClick={handleSubmit}
          disabled={(images.length === 0 && !barcodes.trim()) || noPalette}
          iconRight={
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M5 12h14M12 5l7 7-7 7" />
            </svg>
          }
        >
          Weiter zur Erkennung
        </Button>
      </div>
    </div>
  );
};

export default StepUpload;

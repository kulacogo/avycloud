import React, { useState, useCallback, useRef } from "react";
import { Card } from "../ui/Card";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import type { CaptureUploadData } from "./CaptureView";

interface StepUploadProps {
  onComplete: (data: CaptureUploadData) => void;
}

interface ImagePreview {
  id: string;
  file: File;
  url: string;
}

const createId = () =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2, 10);

const MAX_FILES = 10;
const MAX_FILE_SIZE = 8 * 1024 * 1024; // 8 MB
const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp"];

const StepUpload: React.FC<StepUploadProps> = ({ onComplete }) => {
  const [images, setImages] = useState<ImagePreview[]>([]);
  const [barcodes, setBarcodes] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const addFiles = useCallback((files: FileList | File[]) => {
    setError(null);
    const fileArr = Array.from(files);

    // Validate
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
        setError(`Maximal ${MAX_FILES} Bilder pro Produkt.`);
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
    });
  }, [images, barcodes, onComplete]);

  return (
    <div className="space-y-6">
      {/* Drop zone */}
      <Card padding="none">
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          className={`
            flex flex-col items-center justify-center min-h-[300px] p-8 cursor-pointer
            border-2 border-dashed rounded-2xl transition-colors
            ${dragOver
              ? "border-accent bg-accent/5"
              : "border-app-border hover:border-accent/50 hover:bg-app-elevated/30"
            }
          `}
        >
          <svg
            width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
            className="text-txt-muted mb-4"
          >
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
          <p className="text-txt-primary font-medium mb-1">
            Bilder hierher ziehen
          </p>
          <p className="text-sm text-txt-muted">
            oder klicken um Dateien auszuwählen
          </p>
          <p className="text-xs text-txt-muted mt-2">
            JPG, PNG, WEBP · max. 8 MB · bis zu {MAX_FILES} Bilder
          </p>
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

      {/* Image previews */}
      {images.length > 0 && (
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3">
          {images.map((img) => (
            <div key={img.id} className="relative group aspect-square rounded-xl overflow-hidden border border-app-border bg-app-elevated">
              <img
                src={img.url}
                alt={img.file.name}
                className="w-full h-full object-cover"
              />
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
        </div>
      )}

      {/* Barcode input */}
      <Card padding="sm">
        <div className="space-y-2">
          <label className="text-sm font-medium text-txt-primary">
            Barcode / EAN (optional)
          </label>
          <Input
            value={barcodes}
            onChange={(e) => setBarcodes(e.target.value)}
            placeholder="z.B. 4006381333931 oder mehrere kommagetrennt"
            helpText="Falls ein Barcode vorhanden ist, beschleunigt das die Erkennung erheblich."
          />
        </div>
      </Card>

      {/* Error */}
      {error && (
        <p className="text-sm text-danger">{error}</p>
      )}

      {/* Actions */}
      <div className="flex justify-end">
        <Button
          onClick={handleSubmit}
          disabled={images.length === 0 && !barcodes.trim()}
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

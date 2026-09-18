import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface Props {
  images: { id: string; url: string; label: string }[];
  selectedId: string;
  onSelect: (id: string) => void;
  onClose: () => void;
}

/** Read-only view of the original upload. Never groups, uploads or edits photos. */
export default function CaptureImagePreview({ images, selectedId, onSelect, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const photo = useRef<HTMLImageElement>(null);
  const [zoom, setZoom] = useState(1);
  const [fitWidth, setFitWidth] = useState(0);
  const [failed, setFailed] = useState(false);
  const index = images.findIndex((image) => image.id === selectedId);
  const image = images[index];

  useEffect(() => {
    const element = dialog.current;
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    element?.showModal();
    document.body.style.overflow = "hidden";
    return () => {
      element?.close();
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  useEffect(() => {
    setZoom(1);
    setFailed(false);
    viewport.current?.scrollTo(0, 0);
  }, [selectedId]);

  const measureFit = () => {
    const area = viewport.current;
    const img = photo.current;
    if (area && img?.naturalWidth && img.naturalHeight) {
      setFitWidth(Math.min(area.clientWidth, area.clientHeight * img.naturalWidth / img.naturalHeight));
    }
  };
  useEffect(() => {
    const observer = new ResizeObserver(measureFit);
    if (viewport.current) observer.observe(viewport.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const area = viewport.current;
    if (area) area.scrollTo((area.scrollWidth - area.clientWidth) / 2, (area.scrollHeight - area.clientHeight) / 2);
  }, [zoom, fitWidth]);

  const move = (direction: number) => {
    const next = images[index + direction];
    if (next) onSelect(next.id);
  };
  const control = "min-h-[44px] min-w-[44px] px-3 rounded-lg border border-app-border bg-app-elevated text-txt-primary disabled:opacity-40";

  return createPortal(
    <dialog
      ref={dialog}
      aria-label="Foto vergrößern"
      className="m-auto w-[94vw] max-w-6xl max-h-[94dvh] overflow-auto rounded-xl border border-app-border bg-app-surface p-4 text-txt-primary shadow-2xl backdrop:bg-black/70"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          move(event.key === "ArrowLeft" ? -1 : 1);
        }
      }}
    >
      <div className="flex items-center justify-between gap-3 mb-3">
        <h3 className="font-semibold break-words">{image?.label || "Foto nicht mehr verfügbar"}</h3>
        <button type="button" autoFocus className={control} onClick={onClose} aria-label="Bildvorschau schließen">×</button>
      </div>
      <div ref={viewport} className="h-[60dvh] overflow-auto rounded-lg bg-app-bg border border-app-border">
        {!image || failed ? (
          <p role="status" className="p-6 text-txt-muted">Das Foto konnte nicht angezeigt werden. Schließe die Vorschau und prüfe den Upload.</p>
        ) : (
          <div className={zoom === 1 ? "h-full flex items-center justify-center" : "min-h-full w-max min-w-full"}>
            <img
              ref={photo}
              key={image.id}
              src={image.url}
              alt={image.label}
              draggable={false}
              onError={() => setFailed(true)}
              onLoad={measureFit}
              className="block object-contain mx-auto"
              style={zoom === 1 ? { maxWidth: "100%", maxHeight: "100%" } : { width: fitWidth * zoom, maxWidth: "none" }}
            />
          </div>
        )}
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button type="button" className={control} disabled={index <= 0} onClick={() => move(-1)} aria-label="Vorheriges Foto">←</button>
          <span className="text-sm tabular-nums">{Math.max(0, index + 1)} / {images.length}</span>
          <button type="button" className={control} disabled={index < 0 || index >= images.length - 1} onClick={() => move(1)} aria-label="Nächstes Foto">→</button>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" className={control} disabled={zoom <= 1 || failed} onClick={() => setZoom((value) => Math.max(1, value - 1))} aria-label="Verkleinern">−</button>
          <button type="button" className={control} onClick={() => setZoom(1)} aria-label="Bild einpassen">{zoom === 1 ? "Einpassen" : `${zoom}×`}</button>
          <button type="button" className={control} disabled={zoom >= 4 || failed} onClick={() => setZoom((value) => Math.min(4, value + 1))} aria-label="Vergrößern">+</button>
        </div>
      </div>
      <p className="mt-2 text-xs text-txt-muted">Zum Korrigieren der Zuordnung die Vorschau schließen und das Foto in die passende Gruppe ziehen.</p>
    </dialog>,
    document.body,
  );
}

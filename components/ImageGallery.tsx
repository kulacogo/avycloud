
import React, { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { ProductImage } from '../types';
import { imageReviewNotice } from '../utils/imageReviewNotice';
import { DownloadIcon } from './icons/Icons';
import { Spinner } from './Spinner';
import { useI18n } from '../i18n';
import { getBackendUrl, fetchApi } from '../api/client';
import { applyPhotoChanges, type PhotoChange } from '../utils/photoEditorSession';
const PhotoEditor = lazy(() => import('./PhotoEditor'));


interface ImageGalleryProps {
  images: ProductImage[];
  resetKey?: string;
  isEditing?: boolean;
  mutationsDisabled?: boolean;
  onProcessingChange?: (processing: boolean) => void;
  productId?: string | null;
  onDeleteImage?: (index: number) => void;
  onReorder?: (fromIndex: number, toIndex: number) => void;
  onRegenerateImage?: (index: number) => void;
  regeneratingIndex?: number | null;
  onUpdateImage?: (index: number, next: ProductImage) => void;
  onAddImage?: (image: ProductImage, afterIndex: number) => void;
  onApplyPhotoChanges?: (changes: PhotoChange[]) => boolean;
}

const ImageGallery: React.FC<ImageGalleryProps> = ({
  images,
  resetKey,
  isEditing = false,
  mutationsDisabled = false,
  onProcessingChange,
  productId = null,
  onDeleteImage,
  onReorder,
  onRegenerateImage,
  regeneratingIndex = null,
  onUpdateImage,
  onAddImage,
  onApplyPhotoChanges,
}) => {
  const { t } = useI18n();
  const [activeIndex, setActiveIndex] = useState(0);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [improving, setImproving] = useState(false);
  const [improveError, setImproveError] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorImages, setEditorImages] = useState<ProductImage[]>([]);
  const contextRef = useRef({ productId, resetKey, images, isEditing, mutationsDisabled });
  contextRef.current = { productId, resetKey, images, isEditing, mutationsDisabled };
  const aliveRef = useRef(true);
  const studioRequestRef = useRef<AbortController | null>(null);
  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; studioRequestRef.current?.abort(); }; }, []);

  useEffect(() => {
    // Reset to the first image when the product changes (caller-provided key)
    setActiveIndex(0);
    setLightboxIndex(null);
    setImproveError(null);
    setEditorOpen(false);
    studioRequestRef.current?.abort();
    setImproving(false);
  }, [resetKey]);

  // Keep the active index in-bounds when images are removed.
  useEffect(() => {
    const max = Math.max(0, (images?.length || 0) - 1);
    setActiveIndex((prev) => Math.max(0, Math.min(prev, max)));
  }, [images?.length]);

  useEffect(() => {
    setImproveError(null);

  }, [activeIndex]);

  // Ensure at least 3 images (pad with placeholders)
  const minImages = 3;
  const ensureList = (arr: (ProductImage | undefined | null)[]) => {
    const result = arr.filter(Boolean) as ProductImage[];
    const placeholder = (i: number): ProductImage => ({
      source: 'web',
      variant: 'other',
      url_or_base64: `https://placehold.co/600x600/1f2937/94a3b8?text=Image+${i+1}`
    });
    while (result.length < minImages) result.push(placeholder(result.length));
    return result;
  };

  const padded = ensureList(images || []);
  const activeImage = padded[activeIndex] || padded[0];
  const originalCount = images?.length || 0;
  const isActiveReal = activeIndex < originalCount;
  const activeRealImage = isActiveReal ? images[activeIndex] : null;
  const resolveSrc = (img: ProductImage | any) => {
    const raw = img?.url_or_base64;
    if (typeof raw === 'string') return raw;
    if (raw && typeof raw === 'object' && typeof raw.url === 'string') return raw.url;
    if (typeof img?.url === 'string') return img.url;
    return '';
  };
  const placeholder = 'https://placehold.co/600x600/1f2937/94a3b8?text=No+Image';

  const openLightbox = (index: number) => {
    setLightboxIndex(index);
  };

  const closeLightbox = () => setLightboxIndex(null);

  const handleDragStart = (index: number) => {
    if (!isEditing || contextRef.current.mutationsDisabled || !onReorder || index >= originalCount) return;
    setDragIndex(index);
  };

  const handleDrop = (index: number) => {
    if (!isEditing || contextRef.current.mutationsDisabled || !onReorder) { setDragIndex(null); return; }
    if (dragIndex === null) {
      setDragIndex(null);
      return;
    }
    const boundedTarget = Math.max(0, Math.min(originalCount - 1, index));
    if (boundedTarget === dragIndex) {
      setDragIndex(null);
      return;
    }
    onReorder(dragIndex, boundedTarget);
    setDragIndex(null);
  };

  // Studio-Foto: serverseitige Gemini-Pipeline (Relight + Studio-Hintergrund +
  // Kontaktschatten). Das Ergebnis wird als NEUES Bild eingefügt — das Original
  // bleibt erhalten und der User entscheidet beim Speichern.
  const handleStudioPhoto = useCallback(async () => {
    if (!isEditing || contextRef.current.mutationsDisabled || studioRequestRef.current || !isActiveReal || !activeRealImage || !productId) return;
    const src = resolveSrc(activeRealImage) || '';
    if (!src) return;

    setImproving(true);
    onProcessingChange?.(true);
    setImproveError(null);
    const controller = new AbortController();
    studioRequestRef.current = controller;
    const requestContext = contextRef.current;
    const expectedImage = activeRealImage;

    try {
      const res = await fetchApi(`${getBackendUrl()}/api/images/studio`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId, image: { url_or_base64: src } }),
      });
      const json = await res.json().catch(() => null);
      const studio = json?.data?.image;
      if (!res.ok || !json?.ok || !studio?.url_or_base64) {
        throw new Error(
          json?.error?.details || json?.error?.message || t('sheet.gallery.improve.error.generic')
        );
      }

      const next: ProductImage = {
        // Gemini-Ergebnis ist ein AI-Re-Render → "generated"; der deterministische
        // Freisteller-Fallback bleibt ein echtes Foto → Original-Source behalten.
        source: json.data.method === 'gemini' ? 'generated' : activeRealImage.source,
        variant: 'front',
        url_or_base64: studio.url_or_base64,
        notes: studio.notes || t('sheet.gallery.improve.note.studio'),
        mimeType: studio.mimeType || null,
        width: studio.width || null,
        height: studio.height || null,
      };

      const latest = contextRef.current;
      if (!aliveRef.current || controller.signal.aborted || latest.productId !== requestContext.productId || latest.resetKey !== requestContext.resetKey || !latest.isEditing || JSON.stringify(latest.images[activeIndex]) !== JSON.stringify(expectedImage)) return;
      if (typeof onAddImage === 'function') {
        onAddImage(next, activeIndex);
        setActiveIndex(activeIndex + 1);
      } else if (typeof onUpdateImage === 'function') {
        onUpdateImage(activeIndex, next);
      }
    } catch (err: any) {
      if (aliveRef.current && !controller.signal.aborted) setImproveError(err?.message ? String(err.message) : t('sheet.gallery.improve.error.generic'));
    } finally {
      onProcessingChange?.(false);
      if (studioRequestRef.current === controller) {
        studioRequestRef.current = null;
        if (aliveRef.current) setImproving(false);
      }
    }
  }, [activeIndex, activeRealImage, isActiveReal, isEditing, onAddImage, onUpdateImage, onProcessingChange, productId, t]);

  const applyEditorChanges = (changes: PhotoChange[]) => {
    if (contextRef.current.mutationsDisabled) throw new Error("Das Produkt wird gerade gespeichert. Bitte danach übernehmen; deine Bildänderungen bleiben geöffnet.");
    if (!contextRef.current.isEditing || !applyPhotoChanges(contextRef.current.images, changes)) {
      throw new Error("Die Bilder wurden zwischenzeitlich geändert. Bildwerkstatt neu öffnen.");
    }
    if (onApplyPhotoChanges) {
      if (!onApplyPhotoChanges(changes)) throw new Error("Das Produkt wurde zwischenzeitlich geändert. Bildwerkstatt neu öffnen.");
    } else {
      changes.forEach(change => onUpdateImage?.(change.index, change.image));
    }
    setEditorOpen(false);
  };

  if (!images || images.length === 0) {
    return (
      <div className="flex items-center justify-center w-full h-48 sm:h-56 bg-app-surface rounded-2xl border border-app-border text-txt-muted text-sm">
        {t('sheet.gallery.empty')}
      </div>
    );
  }


  return (
    <div>
      <div className="relative w-full aspect-[4/3] max-h-[420px] md:max-h-[360px] bg-app-surface rounded-2xl border border-app-border overflow-hidden group">
        <img
          src={resolveSrc(activeImage) || placeholder}
          alt={`Product image ${activeIndex + 1}`}
          className="w-full h-full object-contain"
          onError={(e) => { (e.currentTarget as HTMLImageElement).src = placeholder; }}
          onClick={() => openLightbox(activeIndex)}
        />
        {isEditing && onDeleteImage && isActiveReal && (
          <button
            aria-label="Delete selected image"
            disabled={mutationsDisabled}
            onClick={() => { if (!contextRef.current.mutationsDisabled) onDeleteImage(activeIndex); }}
            className="absolute top-2 left-2 px-2 py-1 text-xs bg-danger text-txt-primary rounded opacity-0 group-hover:opacity-100 transition-opacity"
          >
            Delete
          </button>
        )}
        <div className="absolute top-2 right-2 flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            type="button"
            onClick={() => openLightbox(activeIndex)}
            className="p-2 bg-black/50 text-txt-primary rounded-full"
            aria-label={t('sheet.gallery.open')}
          >
            🔍
          </button>
          <a
            href={resolveSrc(activeImage) || '#'}
            download={`product-image-${activeIndex + 1}`}
            /* Die Bilder liegen auf einer FREMDEN Adresse (GCS). Dort ignoriert
               der Browser `download` und blaettert stattdessen zum Bild — in
               DERSELBEN Registerkarte. Die Anwendung war damit weg, samt
               ungespeicherter Aenderungen im Datenblatt. Mit einem eigenen Tab
               bleibt die Arbeit auf jeden Fall erhalten. */
            target="_blank"
            rel="noopener noreferrer"
            className="p-2 bg-black/50 text-txt-primary rounded-full"
            aria-label={t('sheet.gallery.download')}
          >
            <DownloadIcon />
          </a>
          {typeof onRegenerateImage === 'function' && isActiveReal && (
            <button
              type="button"
              onClick={() => { if (!contextRef.current.mutationsDisabled) onRegenerateImage(activeIndex); }}
              className="px-3 py-1 bg-accent text-xs rounded-full text-txt-primary"
              disabled={mutationsDisabled || regeneratingIndex === activeIndex}
            >
              {regeneratingIndex === activeIndex ? t('sheet.gallery.rerendering') : t('sheet.gallery.rerender')}
            </button>
          )}
        </div>
        {activeImage.source && (
          <span className={`absolute bottom-2 left-2 px-2 py-1 text-[10px] font-semibold rounded ${
            activeImage.source === 'generated' ? 'bg-accent text-txt-primary' :
            activeImage.source === 'upload' ? 'bg-success-dim text-success' :
            activeImage.source === 'web' ? 'bg-warning-dim text-warning' :
            'bg-app-elevated text-txt-secondary'
          }`}>
            {activeImage.source === 'generated' ? 'KI-generiert' :
             activeImage.source === 'upload' ? 'Hochgeladen' :
             activeImage.source === 'web' ? 'Web' :
             activeImage.source}
          </span>
        )}
      </div>
      {imageReviewNotice(activeImage.notes) && (
        <p role="status" className="mt-2 rounded-lg border border-warning/30 bg-warning-dim px-3 py-2 text-sm text-warning">
          {imageReviewNotice(activeImage.notes)}
        </p>
      )}
      {isEditing && isActiveReal && onUpdateImage && <div className="mt-3 rounded-xl border border-app-border bg-app-surface p-3">
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => { if (contextRef.current.mutationsDisabled) return; setEditorImages([...images]); setEditorOpen(true); }} disabled={improving || mutationsDisabled} className="flex-1 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-white hover:bg-accent/90 disabled:opacity-50">Bild bearbeiten</button>
          {productId && <button type="button" onClick={handleStudioPhoto} disabled={improving || mutationsDisabled} className="rounded-lg border border-app-border bg-app-elevated px-3 py-2 text-xs font-semibold text-txt-primary disabled:opacity-50">{improving ? "Studio wird erstellt …" : "KI-Studio-Foto"}</button>}
        </div>
        <div className="mt-2 text-[11px] text-txt-muted">Licht · Freistellen · Zuschnitt · Serienbearbeitung · Rückgängig</div>
        {mutationsDisabled && <p role="status" className="mt-2 text-xs text-txt-muted">Produkt wird gespeichert. Bildbearbeitung ist danach wieder verfügbar.</p>}
        {improving && <div className="mt-2 flex items-center gap-2 text-xs text-txt-muted"><Spinner className="h-4 w-4" />{t('sheet.gallery.improve.status.studio')}</div>}
        {improveError && <div role="alert" className="mt-2 text-xs text-danger">{improveError}</div>}
      </div>}
      {editorOpen && isEditing && <Suspense fallback={<div role="status" className="mt-2 text-sm text-txt-muted">Bildwerkstatt wird geladen …</div>}><PhotoEditor key={`${productId || resetKey}`} images={editorImages} initialIndex={activeIndex} onApply={applyEditorChanges} onClose={() => setEditorOpen(false)} /></Suspense>}
      <div className="grid grid-cols-4 gap-2 mt-2">
        {padded.map((image, index) => {
          const isReal = index < originalCount;
          const sourceText: string = image?.source ?? "";
          return (
          <div
            key={index}
            role="button"
            tabIndex={0}
            onClick={() => setActiveIndex(index)}
            onKeyDown={(e) => e.key === 'Enter' && setActiveIndex(index)}
            className={`relative aspect-square rounded-md overflow-hidden border-2 transition-colors cursor-pointer ${
              index === activeIndex ? 'border-accent' : 'border-transparent hover:border-app-border'
            }`}
            draggable={isEditing && isReal && !mutationsDisabled}
            onDragStart={() => handleDragStart(index)}
            onDragOver={(e) => {
              if (isEditing && isReal && !mutationsDisabled) {
                e.preventDefault();
              }
            }}
            onDrop={(e) => {
              e.preventDefault();
              handleDrop(index);
            }}
            onDragEnd={() => setDragIndex(null)}
          >
            <img
              src={resolveSrc(image) || placeholder}
              alt={`Thumbnail ${index + 1}`}
              className="w-full h-full object-cover"
              onError={(e) => { (e.currentTarget as HTMLImageElement).src = placeholder; }}
            />
            {isReal && image?.source && (
              <span className={`absolute bottom-0.5 left-0.5 px-1 py-px text-[8px] font-semibold rounded ${
                image.source === 'generated' ? 'bg-accent/80 text-txt-primary' :
                image.source === 'upload' ? 'bg-success/80 text-white' :
                image.source === 'web' ? 'bg-warning/80 text-white' :
                'bg-app-elevated/80 text-txt-secondary'
              }`}>
                {image.source === 'generated' ? 'KI' :
                 image.source === 'upload' ? 'UP' :
                 image.source === 'web' ? 'WEB' :
                 sourceText.slice(0, 3).toUpperCase()}
              </span>
            )}
            {isEditing && onDeleteImage && isReal && (
              <span
                role="button"
                tabIndex={mutationsDisabled ? -1 : 0}
                aria-disabled={mutationsDisabled}
                aria-label={t('sheet.gallery.delete')}
                onClick={(e) => {
                  e.stopPropagation();
                  if (!contextRef.current.mutationsDisabled) onDeleteImage(index);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.stopPropagation();
                    if (!contextRef.current.mutationsDisabled) onDeleteImage(index);
                  }
                }}
                className="absolute top-1 right-1 px-1 py-0.5 text-[10px] bg-danger text-txt-primary rounded opacity-0 hover:opacity-100 transition-opacity"
              >
                ×
              </span>
            )}
          </div>
        );})}
      </div>
      {lightboxIndex !== null && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label={`Großansicht ${lightboxIndex + 1}`}
          onKeyDown={(e) => {
            if (e.key === "Escape") { e.preventDefault(); closeLightbox(); }
            if (e.key === "ArrowRight" && lightboxIndex < padded.length - 1) { setLightboxIndex(lightboxIndex + 1); }
            if (e.key === "ArrowLeft" && lightboxIndex > 0) { setLightboxIndex(lightboxIndex - 1); }
          }}
          onClick={(e) => { if (e.target === e.currentTarget) closeLightbox(); }}
          tabIndex={-1}
          ref={(el) => el?.focus()}
        >
          <button
            type="button"
            className="absolute top-4 right-4 px-3 py-1 text-sm rounded-full bg-white/80 text-txt-primary"
            onClick={closeLightbox}
            aria-label="Bildansicht schließen"
          >
            Schließen
          </button>
          <img
            src={resolveSrc(padded[lightboxIndex]) || placeholder}
            alt={`Großansicht ${lightboxIndex + 1}`}
            className="max-h-[85vh] max-w-[90vw] object-contain rounded-lg shadow-2xl"
            onError={(e) => { (e.currentTarget as HTMLImageElement).src = placeholder; }}
          />
        </div>
      )}
    </div>
  );
};

export default ImageGallery;

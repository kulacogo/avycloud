
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ProductImage } from '../types';
import { DownloadIcon } from './icons/Icons';
import { Spinner } from './Spinner';
import { useI18n } from '../i18n';
import { getBackendUrl } from '../api/client';

interface ImageGalleryProps {
  images: ProductImage[];
  resetKey?: string;
  isEditing?: boolean;
  onDeleteImage?: (index: number) => void;
  onReorder?: (fromIndex: number, toIndex: number) => void;
  onRegenerateImage?: (index: number) => void;
  regeneratingIndex?: number | null;
  onUpdateImage?: (index: number, next: ProductImage) => void;
}

type RemoveBackgroundFn = (
  image: ImageData | ArrayBuffer | Uint8Array | Blob | URL | string,
  // The lib supports a Config object; keep unknown here to avoid coupling to version-specific types.
  config?: unknown
) => Promise<Blob>;

const blobToDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Failed to read image blob.'));
    reader.readAsDataURL(blob);
  });

const canvasToBlob = (canvas: HTMLCanvasElement, type = 'image/png', quality?: number) =>
  new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Failed to encode image.'));
      },
      type,
      quality
    );
  });

const clampByte = (v: number) => Math.max(0, Math.min(255, v));

const appendNote = (prevNotes: string | undefined, tag: string) => {
  const prev = (prevNotes || '').trim();
  if (!prev) return tag;
  if (prev.toLowerCase().includes(tag.toLowerCase())) return prev;
  return `${prev} · ${tag}`;
};

const fetchImageBlob = async (src: string) => {
  const trimmed = String(src || '').trim();
  if (!trimmed) {
    throw new Error('Missing image src.');
  }

  // Data URLs are same-origin and safe to fetch directly.
  if (trimmed.startsWith('data:')) {
    const response = await fetch(trimmed);
    if (!response.ok) {
      throw new Error(`Image fetch failed (${response.status}).`);
    }
    return await response.blob();
  }

  // 1) Try direct fetch first (fast path when CORS allows it).
  try {
    const response = await fetch(trimmed, { mode: 'cors' });
    if (response.ok) {
      return await response.blob();
    }
  } catch {
    // ignore and fall back to backend proxy
  }

  // 2) Fallback: use backend proxy to bypass CORS restrictions (public allowlist on backend).
  const proxyUrl = new URL(`${getBackendUrl()}/api/image-proxy`);
  proxyUrl.searchParams.set('url', trimmed);
  const proxyRes = await fetch(proxyUrl.toString(), { mode: 'cors' });
  if (!proxyRes.ok) {
    const body = await proxyRes.text().catch(() => '');
    const hint = body ? ` ${body.slice(0, 160)}` : '';
    throw new Error(`Image proxy failed (${proxyRes.status}).${hint}`);
  }
  return await proxyRes.blob();
};

const loadCanvasSource = async (blob: Blob): Promise<{
  source: CanvasImageSource;
  width: number;
  height: number;
  cleanup: () => void;
}> => {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob);
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      cleanup: () => bitmap.close?.(),
    };
  }

  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Failed to decode image.'));
      el.src = url;
    });
    return {
      source: img,
      width: img.naturalWidth || img.width,
      height: img.naturalHeight || img.height,
      cleanup: () => URL.revokeObjectURL(url),
    };
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
};

const rotateBlob = async (blob: Blob, degrees: 90 | 180) => {
  const { source, width, height, cleanup } = await loadCanvasSource(blob);
  const canvas = document.createElement('canvas');
  if (degrees === 90) {
    canvas.width = height;
    canvas.height = width;
  } else {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    cleanup();
    throw new Error('Canvas is not available in this browser.');
  }
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((degrees * Math.PI) / 180);
  ctx.drawImage(source, -width / 2, -height / 2);
  cleanup();
  return await canvasToBlob(canvas, 'image/png');
};

const brightenBlob = async (blob: Blob, delta: number) => {
  const { source, width, height, cleanup } = await loadCanvasSource(blob);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    cleanup();
    throw new Error('Canvas is not available in this browser.');
  }
  ctx.drawImage(source, 0, 0);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = img.data;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = clampByte(data[i] + delta);
    data[i + 1] = clampByte(data[i + 1] + delta);
    data[i + 2] = clampByte(data[i + 2] + delta);
  }
  ctx.putImageData(img, 0, 0);
  cleanup();
  return await canvasToBlob(canvas, 'image/png');
};

const autoAdjustBlob = async (blob: Blob) => {
  const { source, width, height, cleanup } = await loadCanvasSource(blob);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    cleanup();
    throw new Error('Canvas is not available in this browser.');
  }
  ctx.drawImage(source, 0, 0);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = img.data;

  const histR = new Uint32Array(256);
  const histG = new Uint32Array(256);
  const histB = new Uint32Array(256);
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a === 0) continue;
    histR[data[i]]++;
    histG[data[i + 1]]++;
    histB[data[i + 2]]++;
    count++;
  }

  if (count === 0) {
    cleanup();
    return await canvasToBlob(canvas, 'image/png');
  }

  const percentileIndex = (hist: Uint32Array, pct: number) => {
    const target = count * pct;
    let cum = 0;
    for (let i = 0; i < 256; i++) {
      cum += hist[i];
      if (cum >= target) return i;
    }
    return 255;
  };

  const lowPct = 0.01;
  const highPct = 0.99;
  const lowR = percentileIndex(histR, lowPct);
  const lowG = percentileIndex(histG, lowPct);
  const lowB = percentileIndex(histB, lowPct);
  const highR = percentileIndex(histR, highPct);
  const highG = percentileIndex(histG, highPct);
  const highB = percentileIndex(histB, highPct);

  const scale = (v: number, low: number, high: number) => {
    if (high <= low) return v;
    return clampByte(Math.round(((v - low) * 255) / (high - low)));
  };

  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a === 0) continue;
    data[i] = scale(data[i], lowR, highR);
    data[i + 1] = scale(data[i + 1], lowG, highG);
    data[i + 2] = scale(data[i + 2], lowB, highB);
  }

  ctx.putImageData(img, 0, 0);
  cleanup();
  return await canvasToBlob(canvas, 'image/png');
};

const ImageGallery: React.FC<ImageGalleryProps> = ({
  images,
  resetKey,
  isEditing = false,
  onDeleteImage,
  onReorder,
  onRegenerateImage,
  regeneratingIndex = null,
  onUpdateImage,
}) => {
  const { t } = useI18n();
  const [activeIndex, setActiveIndex] = useState(0);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [improving, setImproving] = useState(false);
  const [improveAction, setImproveAction] = useState<
    null | 'removeBg' | 'auto' | 'rotate90' | 'rotate180' | 'brighten'
  >(null);
  const [improveError, setImproveError] = useState<string | null>(null);
  const [improveStatus, setImproveStatus] = useState<string | null>(null);
  const [improvePercent, setImprovePercent] = useState<number | null>(null);
  const progressThrottleRef = useRef<number>(0);
  const improveStartedAtRef = useRef<number>(0);
  const removeBackgroundFnRef = useRef<RemoveBackgroundFn | null>(null);
  const isCrossOriginIsolated = typeof window !== 'undefined' && (window as any).crossOriginIsolated === true;

  useEffect(() => {
    // Reset to the first image when the product changes (caller-provided key)
    setActiveIndex(0);
    setLightboxIndex(null);
    setImproveError(null);
    setImproveStatus(null);
    setImprovePercent(null);
  }, [resetKey]);

  // Keep the active index in-bounds when images are removed.
  useEffect(() => {
    const max = Math.max(0, (images?.length || 0) - 1);
    setActiveIndex((prev) => Math.max(0, Math.min(prev, max)));
  }, [images?.length]);

  useEffect(() => {
    setImproveError(null);
    setImproveStatus(null);
    setImprovePercent(null);
  }, [activeIndex]);

  if (!images || images.length === 0) {
    return (
      <div className="flex items-center justify-center w-full h-48 sm:h-56 bg-app-surface rounded-2xl border border-app-border text-txt-muted text-sm">
        {t('sheet.gallery.empty')}
      </div>
    );
  }

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
    if (!isEditing || !onReorder || index >= originalCount) return;
    setDragIndex(index);
  };

  const handleDrop = (index: number) => {
    if (!isEditing || !onReorder) return;
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

  const getRemoveBackgroundFn = useCallback(async (): Promise<RemoveBackgroundFn> => {
    if (removeBackgroundFnRef.current) return removeBackgroundFnRef.current;
    const mod = await import('@imgly/background-removal');
    // Note: @imgly/background-removal v1.7.0 ships JS with named exports (removeBackground),
    // while its .d.ts also declares a default export. Resolve both to be robust.
    const fn =
      ((mod as any).removeBackground as RemoveBackgroundFn | undefined) ||
      ((mod as any).default as RemoveBackgroundFn | undefined) ||
      ((mod as any).default?.removeBackground as RemoveBackgroundFn | undefined);
    if (typeof fn !== 'function') {
      throw new Error('Background removal library did not load correctly.');
    }
    removeBackgroundFnRef.current = fn;
    return fn;
  }, []);

  const applyImprove = useCallback(
    async (
      action: NonNullable<typeof improveAction>,
      process: (input: Blob) => Promise<Blob>,
      noteTag: string
    ) => {
      if (!isEditing || !isActiveReal || !activeRealImage || typeof onUpdateImage !== 'function') return;
      const src = resolveSrc(activeRealImage) || '';
      if (!src) return;

      setImproving(true);
      setImproveAction(action);
      setImproveError(null);
      setImproveStatus(null);
      setImprovePercent(null);
      progressThrottleRef.current = 0;
      improveStartedAtRef.current = Date.now();

      try {
        const inputBlob = await fetchImageBlob(src);
        const outBlob = await process(inputBlob);
        const dataUrl = await blobToDataUrl(outBlob);
        const next: ProductImage = {
          ...activeRealImage,
          url_or_base64: dataUrl,
          notes: appendNote(activeRealImage.notes, noteTag),
          mimeType: outBlob.type || activeRealImage.mimeType || null,
        };
        onUpdateImage(activeIndex, next);
      } catch (err: any) {
        const rawMessage = err?.message ? String(err.message) : '';
        const message =
          rawMessage && !/background removal library did not load correctly/i.test(rawMessage)
            ? rawMessage
            : t('sheet.gallery.improve.error.generic');
        // Common failure mode: CORS fetch of external URLs.
        const isCors =
          /cors/i.test(message) ||
          /failed to fetch/i.test(message) ||
          /networkerror/i.test(message) ||
          /tainted/i.test(message);
        setImproveError(isCors ? t('sheet.gallery.improve.error.cors') : message);
      } finally {
        setImproving(false);
        setImproveAction(null);
        setImproveStatus(null);
        setImprovePercent(null);
      }
    },
    [activeIndex, activeRealImage, isActiveReal, isEditing, onUpdateImage, t]
  );

  const handleRemoveBackground = useCallback(() => {
    void applyImprove(
      'removeBg',
      async (inputBlob) => {
        const removeBackground = await getRemoveBackgroundFn();
        setImproveStatus(t('sheet.gallery.improve.status.starting'));
        setImprovePercent(null);

        const progress = (key: string, current: number, total: number) => {
          const now = Date.now();
          if (progressThrottleRef.current && now - progressThrottleRef.current < 180) return;
          progressThrottleRef.current = now;

          const percent = total > 0 ? Math.max(0, Math.min(100, Math.round((current / total) * 100))) : null;
          if (typeof percent === 'number' && Number.isFinite(percent)) {
            setImprovePercent(percent);
          } else {
            setImprovePercent(null);
          }

          const keyStr = String(key || '');
          const asMb = (bytes: number) => `${(Math.max(0, bytes) / (1024 * 1024)).toFixed(1)} MB`;

          if (keyStr.startsWith('fetch:')) {
            const resource = keyStr.slice('fetch:'.length);
            const label =
              resource.includes('/models/')
                ? t('sheet.gallery.improve.status.downloadModel')
                : resource.includes('onnxruntime-web')
                  ? t('sheet.gallery.improve.status.downloadRuntime')
                  : t('sheet.gallery.improve.status.downloading');
            const details = total > 0 ? ` (${asMb(current)} / ${asMb(total)})` : '';
            setImproveStatus(`${label}${details}`);
            return;
          }

          if (keyStr.startsWith('compute:')) {
            const step = keyStr.slice('compute:'.length);
            const label =
              step === 'decode'
                ? t('sheet.gallery.improve.status.decode')
                : step === 'inference'
                  ? t('sheet.gallery.improve.status.inference')
                  : step === 'mask'
                    ? t('sheet.gallery.improve.status.mask')
                    : step === 'encode'
                      ? t('sheet.gallery.improve.status.encode')
                      : t('sheet.gallery.improve.status.processing');
            setImproveStatus(label);
          }
        };

        // Default config works without special headers; COOP/COEP only improves performance (SharedArrayBuffer).
        return await removeBackground(inputBlob, {
          device: 'gpu',
          // Faster + smaller download than medium. Quality is usually sufficient for catalog/gallery usage.
          model: 'small',
          progress,
          output: { format: 'image/png', quality: 0.8 },
        });
      },
      t('sheet.gallery.improve.note.bgRemoved')
    );
  }, [applyImprove, getRemoveBackgroundFn, t]);

  const handleAutoAdjust = useCallback(() => {
    void applyImprove('auto', autoAdjustBlob, t('sheet.gallery.improve.note.autoAdjusted'));
  }, [applyImprove, t]);

  const handleRotate90 = useCallback(() => {
    void applyImprove('rotate90', (b) => rotateBlob(b, 90), t('sheet.gallery.improve.note.rotated90'));
  }, [applyImprove, t]);

  const handleRotate180 = useCallback(() => {
    void applyImprove('rotate180', (b) => rotateBlob(b, 180), t('sheet.gallery.improve.note.rotated180'));
  }, [applyImprove, t]);

  const handleBrighten = useCallback(() => {
    void applyImprove('brighten', (b) => brightenBlob(b, 18), t('sheet.gallery.improve.note.brightened'));
  }, [applyImprove, t]);

  const improveButtons = useMemo(() => {
    if (!isEditing || !isActiveReal || typeof onUpdateImage !== 'function') return null;
    const elapsedSeconds = improving ? Math.max(0, Math.round((Date.now() - improveStartedAtRef.current) / 1000)) : 0;
    return (
      <div className="mt-3 rounded-xl border border-app-border bg-app-surface p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="text-xs font-semibold text-txt-secondary">{t('sheet.gallery.improve.title')}</div>
          {improving ? (
            <div className="flex items-center gap-2 text-xs text-txt-muted">
              <Spinner className="w-4 h-4" />
              <span>{improveStatus || t('sheet.gallery.improve.working')}</span>
              {elapsedSeconds >= 10 ? <span className="text-[11px] text-txt-muted">({elapsedSeconds}s)</span> : null}
            </div>
          ) : null}
        </div>
        {improving && typeof improvePercent === 'number' ? (
          <div className="mt-2">
            <div className="h-1.5 w-full rounded-full bg-app-elevated overflow-hidden">
              <div className="h-full bg-accent" style={{ width: `${improvePercent}%` }} />
            </div>
          </div>
        ) : null}
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={handleRemoveBackground}
            disabled={improving}
            className="px-3 py-1.5 rounded-full text-xs font-semibold bg-app-surface text-txt-primary hover:bg-app-elevated/60 disabled:opacity-50"
            title={t('sheet.gallery.improve.removeBg')}
          >
            {t('sheet.gallery.improve.removeBg')}
          </button>
          <button
            type="button"
            onClick={handleAutoAdjust}
            disabled={improving}
            className="px-3 py-1.5 rounded-full text-xs font-semibold bg-app-surface text-txt-primary hover:bg-app-elevated/60 disabled:opacity-50"
            title={t('sheet.gallery.improve.auto')}
          >
            {t('sheet.gallery.improve.auto')}
          </button>
          <button
            type="button"
            onClick={handleRotate90}
            disabled={improving}
            className="px-3 py-1.5 rounded-full text-xs font-semibold bg-app-surface text-txt-primary hover:bg-app-elevated/60 disabled:opacity-50"
            title={t('sheet.gallery.improve.rotate90')}
          >
            {t('sheet.gallery.improve.rotate90')}
          </button>
          <button
            type="button"
            onClick={handleRotate180}
            disabled={improving}
            className="px-3 py-1.5 rounded-full text-xs font-semibold bg-app-surface text-txt-primary hover:bg-app-elevated/60 disabled:opacity-50"
            title={t('sheet.gallery.improve.rotate180')}
          >
            {t('sheet.gallery.improve.rotate180')}
          </button>
          <button
            type="button"
            onClick={handleBrighten}
            disabled={improving}
            className="px-3 py-1.5 rounded-full text-xs font-semibold bg-app-surface text-txt-primary hover:bg-app-elevated/60 disabled:opacity-50"
            title={t('sheet.gallery.improve.brighten')}
          >
            {t('sheet.gallery.improve.brighten')}
          </button>
        </div>
        {improveError ? <div className="mt-2 text-xs text-danger">{improveError}</div> : null}
        {improving && improveAction === 'removeBg' && !isCrossOriginIsolated ? (
          <div className="mt-2 text-[11px] text-txt-muted">{t('sheet.gallery.improve.hint.performance')}</div>
        ) : null}
        {improving && improveAction === 'removeBg' ? (
          <div className="mt-1 text-[11px] text-txt-muted">{t('sheet.gallery.improve.hint.firstRun')}</div>
        ) : null}
      </div>
    );
  }, [
    improveAction,
    improveError,
    improvePercent,
    improveStatus,
    improving,
    isCrossOriginIsolated,
    isActiveReal,
    isEditing,
    onUpdateImage,
    handleAutoAdjust,
    handleBrighten,
    handleRemoveBackground,
    handleRotate180,
    handleRotate90,
    t,
  ]);

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
            onClick={() => onDeleteImage(activeIndex)}
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
            className="p-2 bg-black/50 text-txt-primary rounded-full"
            aria-label={t('sheet.gallery.download')}
          >
            <DownloadIcon />
          </a>
          {typeof onRegenerateImage === 'function' && isActiveReal && (
            <button
              type="button"
              onClick={() => onRegenerateImage(activeIndex)}
              className="px-3 py-1 bg-accent text-xs rounded-full text-txt-primary"
              disabled={regeneratingIndex === activeIndex}
            >
              {regeneratingIndex === activeIndex ? t('sheet.gallery.rerendering') : t('sheet.gallery.rerender')}
            </button>
          )}
        </div>
        {activeImage.source === 'generated' && (
            <span className="absolute bottom-2 left-2 px-2 py-1 text-xs bg-accent text-txt-primary rounded">{t('sheet.gallery.aiBadge')}</span>
        )}
      </div>
      {improveButtons}
      <div className="grid grid-cols-4 gap-2 mt-2">
        {padded.map((image, index) => {
          const isReal = index < originalCount;
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
            draggable={isEditing && isReal}
            onDragStart={() => handleDragStart(index)}
            onDragOver={(e) => {
              if (isEditing && isReal) {
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
            {isEditing && onDeleteImage && isReal && (
              <span
                role="button"
                tabIndex={0}
                aria-label={t('sheet.gallery.delete')}
                onClick={(e) => {
                  e.stopPropagation();
                  onDeleteImage(index);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.stopPropagation();
                    onDeleteImage(index);
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

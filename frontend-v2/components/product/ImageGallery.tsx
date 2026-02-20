
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ProductImage } from '../../types';
import { DownloadIcon } from '../icons/Icons';
import { Spinner } from '../ui/Spinner';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { useI18n } from '../../i18n';
import { getBackendUrl } from '../../api/client';
import Cropper, { Area, MediaSize, Point, getInitialCropFromCroppedAreaPixels } from 'react-easy-crop';

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

  if (trimmed.startsWith('data:')) {
    const response = await fetch(trimmed);
    if (!response.ok) {
      throw new Error(`Image fetch failed (${response.status}).`);
    }
    return await response.blob();
  }

  try {
    const response = await fetch(trimmed, { mode: 'cors' });
    if (response.ok) {
      return await response.blob();
    }
  } catch {
    // ignore and fall back to backend proxy
  }

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

const getRadianAngle = (degreeValue: number) => (degreeValue * Math.PI) / 180;

const rotateSize = (width: number, height: number, rotation: number) => {
  const rotRad = getRadianAngle(rotation);
  return {
    width: Math.abs(Math.cos(rotRad) * width) + Math.abs(Math.sin(rotRad) * height),
    height: Math.abs(Math.sin(rotRad) * width) + Math.abs(Math.cos(rotRad) * height),
  };
};

const getCropSize = (
  mediaWidth: number,
  mediaHeight: number,
  containerWidth: number,
  containerHeight: number,
  aspect: number,
  rotation = 0
) => {
  const rotated = rotateSize(mediaWidth, mediaHeight, rotation);
  const fittingWidth = Math.min(rotated.width, containerWidth);
  const fittingHeight = Math.min(rotated.height, containerHeight);

  if (fittingWidth > fittingHeight * aspect) {
    return { width: fittingHeight * aspect, height: fittingHeight };
  }
  return { width: fittingWidth, height: fittingWidth / aspect };
};

const cropBlob = async (
  blob: Blob,
  pixelCrop: Area,
  rotation = 0,
  flip: { horizontal: boolean; vertical: boolean } = { horizontal: false, vertical: false }
) => {
  const { source, width, height, cleanup } = await loadCanvasSource(blob);
  try {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas is not available in this browser.');

    const rotRad = getRadianAngle(rotation);
    const bBox = rotateSize(width, height, rotation);
    canvas.width = Math.round(bBox.width);
    canvas.height = Math.round(bBox.height);

    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate(rotRad);
    ctx.scale(flip.horizontal ? -1 : 1, flip.vertical ? -1 : 1);
    ctx.translate(-width / 2, -height / 2);
    ctx.drawImage(source, 0, 0);

    const croppedCanvas = document.createElement('canvas');
    const croppedCtx = croppedCanvas.getContext('2d');
    if (!croppedCtx) throw new Error('Canvas is not available in this browser.');

    croppedCanvas.width = Math.max(1, Math.round(pixelCrop.width));
    croppedCanvas.height = Math.max(1, Math.round(pixelCrop.height));
    croppedCtx.drawImage(
      canvas,
      Math.round(pixelCrop.x),
      Math.round(pixelCrop.y),
      Math.round(pixelCrop.width),
      Math.round(pixelCrop.height),
      0,
      0,
      Math.round(pixelCrop.width),
      Math.round(pixelCrop.height)
    );

    return await canvasToBlob(croppedCanvas, 'image/png');
  } finally {
    cleanup();
  }
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

  const [cropOpen, setCropOpen] = useState(false);
  const [cropLoading, setCropLoading] = useState(false);
  const [cropSaving, setCropSaving] = useState(false);
  const [smartCropping, setSmartCropping] = useState(false);
  const [usedSmartCrop, setUsedSmartCrop] = useState(false);
  const [cropError, setCropError] = useState<string | null>(null);
  const [cropSrcUrl, setCropSrcUrl] = useState<string | null>(null);
  const [cropInputBlob, setCropInputBlob] = useState<Blob | null>(null);

  const cropperContainerRef = useRef<HTMLDivElement | null>(null);
  const [cropperContainerSize, setCropperContainerSize] = useState<{ width: number; height: number } | null>(null);
  const [cropperMediaSize, setCropperMediaSize] = useState<MediaSize | null>(null);

  const [cropPoint, setCropPoint] = useState<Point>({ x: 0, y: 0 });
  const [cropZoom, setCropZoom] = useState(1);
  const [cropRotation, setCropRotation] = useState(0);
  const [aspectMode, setAspectMode] = useState<'original' | '1:1' | '4:3' | '16:9'>('original');
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null);

  useEffect(() => {
    setActiveIndex(0);
    setLightboxIndex(null);
    setImproveError(null);
    setImproveStatus(null);
    setImprovePercent(null);
  }, [resetKey]);

  useEffect(() => {
    const max = Math.max(0, (images?.length || 0) - 1);
    setActiveIndex((prev) => Math.max(0, Math.min(prev, max)));
  }, [images?.length]);

  useEffect(() => {
    setImproveError(null);
    setImproveStatus(null);
    setImprovePercent(null);
  }, [activeIndex]);

  useEffect(() => {
    if (!cropOpen) return;
    const el = cropperContainerRef.current;
    if (!el) return;

    const update = () => {
      const rect = el.getBoundingClientRect();
      const w = Math.max(0, Math.round(rect.width));
      const h = Math.max(0, Math.round(rect.height));
      setCropperContainerSize((prev) => {
        if (prev && prev.width === w && prev.height === h) return prev;
        return { width: w, height: h };
      });
    };

    update();
    if (typeof ResizeObserver === 'undefined') {
      const onResize = () => update();
      window.addEventListener('resize', onResize);
      return () => window.removeEventListener('resize', onResize);
    }

    const ro = new ResizeObserver(() => update());
    ro.observe(el);
    return () => ro.disconnect();
  }, [cropOpen]);

  if (!images || images.length === 0) {
    return (
      <div className="flex items-center justify-center w-full h-48 sm:h-56 bg-[var(--surface-secondary)] rounded-xl border border-[var(--border)] text-[var(--text-tertiary)] text-sm">
        {t('sheet.gallery.empty')}
      </div>
    );
  }

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
  const resolveSrc = (img: ProductImage | any) => (img?.url_or_base64 ? img.url_or_base64 : img?.url ? img.url : '');
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

        return await removeBackground(inputBlob, {
          device: 'gpu',
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

  const closeCrop = useCallback(() => {
    setCropOpen(false);
    setCropError(null);
    setCropSaving(false);
    setSmartCropping(false);
    setCropperMediaSize(null);
    setCropperContainerSize(null);
    setCroppedAreaPixels(null);
    setCropPoint({ x: 0, y: 0 });
    setCropZoom(1);
    setCropRotation(0);
    setAspectMode('original');
    setUsedSmartCrop(false);
    if (cropSrcUrl) {
      URL.revokeObjectURL(cropSrcUrl);
    }
    setCropSrcUrl(null);
    setCropInputBlob(null);
  }, [cropSrcUrl]);

  const openCrop = useCallback(async () => {
    if (!isEditing || !isActiveReal || !activeRealImage || typeof onUpdateImage !== 'function') return;
    const src = resolveSrc(activeRealImage) || '';
    if (!src) return;

    setCropLoading(true);
    setCropError(null);
    try {
      const inputBlob = await fetchImageBlob(src);
      const url = URL.createObjectURL(inputBlob);
      setCropInputBlob(inputBlob);
      setCropSrcUrl(url);
      setCropOpen(true);
      setCropPoint({ x: 0, y: 0 });
      setCropZoom(1);
      setCropRotation(0);
      setAspectMode('original');
      setCroppedAreaPixels(null);
      setUsedSmartCrop(false);
    } catch (err: any) {
      setCropError(err?.message ? String(err.message) : t('sheet.gallery.improve.error.generic'));
    } finally {
      setCropLoading(false);
    }
  }, [activeRealImage, isActiveReal, isEditing, onUpdateImage, t]);

  const cropAspect = useMemo(() => {
    if (aspectMode === '1:1') return 1;
    if (aspectMode === '4:3') return 4 / 3;
    if (aspectMode === '16:9') return 16 / 9;
    const w = cropperMediaSize?.naturalWidth || cropperMediaSize?.width || 4;
    const h = cropperMediaSize?.naturalHeight || cropperMediaSize?.height || 3;
    return w > 0 && h > 0 ? w / h : 4 / 3;
  }, [aspectMode, cropperMediaSize]);

  const cropSize = useMemo(() => {
    if (!cropperMediaSize || !cropperContainerSize) return undefined;
    const base = getCropSize(
      cropperMediaSize.width,
      cropperMediaSize.height,
      cropperContainerSize.width,
      cropperContainerSize.height,
      cropAspect,
      cropRotation
    );
    return { width: Math.max(1, Math.round(base.width)), height: Math.max(1, Math.round(base.height)) };
  }, [cropAspect, cropRotation, cropperContainerSize, cropperMediaSize]);

  const handleSmartCrop = useCallback(async () => {
    if (!cropInputBlob || !cropSrcUrl) return;
    if (!cropperMediaSize || !cropSize) {
      setCropError('Smart Crop ist noch nicht bereit – Bild lädt noch.');
      return;
    }

    setSmartCropping(true);
    setCropError(null);
    try {
      const mod = await import('smartcrop');
      const smartcrop = ((mod as any).default || (mod as any)) as any;
      if (!smartcrop || typeof smartcrop.crop !== 'function') {
        throw new Error('Smart-Crop Bibliothek konnte nicht geladen werden.');
      }

      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error('Bild konnte nicht geladen werden.'));
        el.src = cropSrcUrl;
      });

      const aspect = cropAspect;
      const maxW = Math.max(64, Math.min(1200, img.naturalWidth || img.width || 1200));
      let targetW = Math.round(maxW);
      let targetH = Math.round(targetW / aspect);
      if (targetH > (img.naturalHeight || img.height || targetH)) {
        const maxH = Math.max(64, Math.min(1200, img.naturalHeight || img.height || 1200));
        targetH = Math.round(maxH);
        targetW = Math.round(targetH * aspect);
      }
      targetW = Math.max(32, targetW);
      targetH = Math.max(32, targetH);

      const result = await smartcrop.crop(img, { width: targetW, height: targetH });
      const top = result?.topCrop;
      if (!top) {
        throw new Error('Smart Crop hat kein Ergebnis geliefert.');
      }

      const rect: Area = {
        x: Math.max(0, Math.round(top.x)),
        y: Math.max(0, Math.round(top.y)),
        width: Math.max(1, Math.round(top.width)),
        height: Math.max(1, Math.round(top.height)),
      };

      // Smart crop is computed in natural image coordinates, so we reset rotation.
      setCropRotation(0);
      setCroppedAreaPixels(rect);
      setUsedSmartCrop(true);

      const helperCropSize =
        cropperContainerSize && cropperMediaSize
          ? (() => {
              const base = getCropSize(
                cropperMediaSize.width,
                cropperMediaSize.height,
                cropperContainerSize.width,
                cropperContainerSize.height,
                cropAspect,
                0
              );
              return { width: Math.max(1, Math.round(base.width)), height: Math.max(1, Math.round(base.height)) };
            })()
          : cropSize;

      const { crop, zoom } = getInitialCropFromCroppedAreaPixels(rect, cropperMediaSize, 0, helperCropSize, 1, 6);
      setCropPoint(crop);
      setCropZoom(zoom);
    } catch (err: any) {
      setCropError(err?.message ? String(err.message) : 'Smart Crop fehlgeschlagen.');
    } finally {
      setSmartCropping(false);
    }
  }, [cropAspect, cropInputBlob, cropSize, cropSrcUrl, cropperContainerSize, cropperMediaSize]);

  const applyCrop = useCallback(async () => {
    if (!isEditing || !isActiveReal || !activeRealImage || typeof onUpdateImage !== 'function') return;
    if (!cropInputBlob || !croppedAreaPixels) {
      setCropError('Bitte zuerst einen Ausschnitt wählen.');
      return;
    }

    setCropSaving(true);
    setCropError(null);
    try {
      const outBlob = await cropBlob(cropInputBlob, croppedAreaPixels, cropRotation);
      const dataUrl = await blobToDataUrl(outBlob);
      const noteTag = usedSmartCrop ? t('sheet.gallery.improve.note.smartCropped') : t('sheet.gallery.improve.note.cropped');
      const next: ProductImage = {
        ...activeRealImage,
        url_or_base64: dataUrl,
        notes: appendNote(activeRealImage.notes, noteTag),
        mimeType: outBlob.type || activeRealImage.mimeType || null,
      };
      onUpdateImage(activeIndex, next);
      closeCrop();
    } catch (err: any) {
      setCropError(err?.message ? String(err.message) : t('sheet.gallery.improve.error.generic'));
    } finally {
      setCropSaving(false);
    }
  }, [
    activeIndex,
    activeRealImage,
    closeCrop,
    cropInputBlob,
    cropRotation,
    croppedAreaPixels,
    isActiveReal,
    isEditing,
    onUpdateImage,
    t,
    usedSmartCrop,
  ]);

  const improveButtons = useMemo(() => {
    if (!isEditing || !isActiveReal || typeof onUpdateImage !== 'function') return null;
    const elapsedSeconds = improving ? Math.max(0, Math.round((Date.now() - improveStartedAtRef.current) / 1000)) : 0;
    return (
      <div className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="text-xs font-semibold text-[var(--text-primary)]">{t('sheet.gallery.improve.title')}</div>
          {improving ? (
            <div className="flex items-center gap-2 text-xs text-[var(--text-tertiary)]">
              <Spinner size="sm" />
              <span>{improveStatus || t('sheet.gallery.improve.working')}</span>
              {elapsedSeconds >= 10 ? <span className="text-[11px] text-[var(--text-tertiary)]">({elapsedSeconds}s)</span> : null}
            </div>
          ) : null}
        </div>
        {improving && typeof improvePercent === 'number' ? (
          <div className="mt-2">
            <div className="h-1.5 w-full rounded-full bg-[var(--surface-secondary)] overflow-hidden">
              <div className="h-full bg-[var(--avy-purple)] rounded-full transition-all" style={{ width: `${improvePercent}%` }} />
            </div>
          </div>
        ) : null}
        <div className="mt-2 flex flex-wrap gap-2">
          {[
            { action: 'removeBg', handler: handleRemoveBackground, label: t('sheet.gallery.improve.removeBg') },
            { action: 'auto', handler: handleAutoAdjust, label: t('sheet.gallery.improve.auto') },
            { action: 'rotate90', handler: handleRotate90, label: t('sheet.gallery.improve.rotate90') },
            { action: 'rotate180', handler: handleRotate180, label: t('sheet.gallery.improve.rotate180') },
            { action: 'brighten', handler: handleBrighten, label: t('sheet.gallery.improve.brighten') },
          ].map(({ action, handler, label }) => (
            <button
              key={action}
              type="button"
              onClick={handler}
              disabled={improving || cropOpen || cropLoading || cropSaving}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-[var(--surface-secondary)] text-[var(--text-primary)] border border-[var(--border)] hover:border-[var(--border-hover)] disabled:opacity-50 transition-all"
              title={label}
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => void openCrop()}
            disabled={improving || cropOpen || cropLoading || cropSaving}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-[var(--surface-secondary)] text-[var(--text-primary)] border border-[var(--border)] hover:border-[var(--border-hover)] disabled:opacity-50 transition-all"
            title={t('sheet.gallery.improve.crop')}
          >
            {cropLoading ? t('sheet.gallery.improve.working') : t('sheet.gallery.improve.crop')}
          </button>
        </div>
        {improveError ? <div className="mt-2 text-xs text-[var(--error)]">{improveError}</div> : null}
        {cropError ? <div className="mt-2 text-xs text-[var(--error)]">{cropError}</div> : null}
        {improving && improveAction === 'removeBg' && !isCrossOriginIsolated ? (
          <div className="mt-2 text-[11px] text-[var(--text-tertiary)]">{t('sheet.gallery.improve.hint.performance')}</div>
        ) : null}
        {improving && improveAction === 'removeBg' ? (
          <div className="mt-1 text-[11px] text-[var(--text-tertiary)]">{t('sheet.gallery.improve.hint.firstRun')}</div>
        ) : null}
      </div>
    );
  }, [
    cropError,
    cropLoading,
    cropOpen,
    cropSaving,
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
    openCrop,
    t,
  ]);

  return (
    <div>
      {/* Main image */}
      <div className="relative w-full aspect-[4/3] max-h-[420px] md:max-h-[360px] bg-[var(--surface-secondary)] rounded-xl overflow-hidden border border-[var(--border)] group">
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
            className="absolute top-2 left-2 px-2.5 py-1 text-xs font-semibold bg-[var(--error)] text-white rounded-lg opacity-0 group-hover:opacity-100 transition-opacity"
          >
            Delete
          </button>
        )}
        <div className="absolute top-2 right-2 flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            type="button"
            onClick={() => openLightbox(activeIndex)}
            className="p-2 bg-black/50 text-white rounded-full backdrop-blur-sm"
            aria-label={t('sheet.gallery.open')}
          >
            <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z" clipRule="evenodd" /></svg>
          </button>
          <a
            href={resolveSrc(activeImage) || '#'}
            download={`product-image-${activeIndex + 1}`}
            className="p-2 bg-black/50 text-white rounded-full backdrop-blur-sm"
            aria-label={t('sheet.gallery.download')}
          >
            <DownloadIcon className="w-4 h-4" />
          </a>
          {typeof onRegenerateImage === 'function' && isActiveReal && (
            <button
              type="button"
              onClick={() => onRegenerateImage(activeIndex)}
              className="px-3 py-1 bg-[var(--avy-purple)] text-xs rounded-full text-white font-semibold"
              disabled={regeneratingIndex === activeIndex}
            >
              {regeneratingIndex === activeIndex ? t('sheet.gallery.rerendering') : t('sheet.gallery.rerender')}
            </button>
          )}
        </div>
        {activeImage.source === 'generated' && (
          <span className="absolute bottom-2 left-2 px-2 py-1 text-xs bg-[var(--avy-purple)]/80 text-white rounded-lg font-semibold">{t('sheet.gallery.aiBadge')}</span>
        )}
      </div>

      {/* Image improvement tools */}
      {improveButtons}

      {/* Thumbnails grid */}
      <div className="grid grid-cols-4 gap-2 mt-3">
        {padded.map((image, index) => {
          const isReal = index < originalCount;
          return (
            <div
              key={index}
              role="button"
              tabIndex={0}
              onClick={() => {
                if (cropOpen || cropLoading || cropSaving || smartCropping) return;
                setActiveIndex(index);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  if (cropOpen || cropLoading || cropSaving || smartCropping) return;
                  setActiveIndex(index);
                }
              }}
              className={`relative aspect-square rounded-lg overflow-hidden border-2 transition-all cursor-pointer ${
                index === activeIndex
                  ? 'border-[var(--avy-purple)] shadow-[var(--shadow-focus)]'
                  : 'border-transparent hover:border-[var(--border-hover)]'
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
                  className="absolute top-1 right-1 px-1.5 py-0.5 text-[10px] bg-[var(--error)] text-white rounded opacity-0 hover:opacity-100 transition-opacity"
                >
                  x
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* Lightbox */}
      {lightboxIndex !== null && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <button
            type="button"
            className="absolute top-4 right-4 px-3 py-1.5 text-sm rounded-lg font-semibold bg-white/90 text-gray-900 hover:bg-white transition-colors"
            onClick={closeLightbox}
          >
            Schliessen
          </button>
          <img
            src={resolveSrc(padded[lightboxIndex]) || placeholder}
            alt={`Grossansicht ${lightboxIndex + 1}`}
            className="max-h-[85vh] max-w-[90vw] object-contain rounded-xl shadow-2xl"
            onError={(e) => { (e.currentTarget as HTMLImageElement).src = placeholder; }}
          />
        </div>
      )}

      {/* Crop modal */}
      <Modal
        open={cropOpen}
        onClose={closeCrop}
        title={t('sheet.gallery.improve.cropTitle')}
        className="max-w-[980px] w-[95vw]"
        footer={
          <div className="flex items-center justify-between w-full gap-3">
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void handleSmartCrop()}
                disabled={smartCropping || cropSaving || !cropSrcUrl}
                loading={smartCropping}
              >
                {t('sheet.gallery.improve.smartCrop')}
              </Button>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={closeCrop} disabled={cropSaving || smartCropping}>
                {t('common.cancel')}
              </Button>
              <Button size="sm" onClick={() => void applyCrop()} disabled={cropSaving || smartCropping} loading={cropSaving}>
                {t('common.save')}
              </Button>
            </div>
          </div>
        }
      >
        {cropSrcUrl ? (
          <div className="space-y-3">
            <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
              <div className="lg:col-span-4">
                <div
                  ref={cropperContainerRef}
                  className="relative w-full h-[440px] rounded-xl overflow-hidden border border-[var(--border)] bg-black/40"
                >
                  <Cropper
                    image={cropSrcUrl}
                    crop={cropPoint}
                    zoom={cropZoom}
                    rotation={cropRotation}
                    aspect={cropAspect}
                    cropSize={cropSize}
                    onCropChange={setCropPoint}
                    onZoomChange={setCropZoom}
                    onRotationChange={setCropRotation}
                    onMediaLoaded={(ms) => setCropperMediaSize(ms)}
                    onCropComplete={(_, pixels) => setCroppedAreaPixels(pixels)}
                    showGrid
                  />
                </div>
              </div>
              <div className="lg:col-span-1 space-y-3">
                <div>
                  <div className="text-xs font-semibold text-[var(--text-secondary)] mb-1">
                    {t('sheet.gallery.improve.cropAspect')}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {[
                      { id: 'original', label: t('sheet.gallery.improve.cropAspect.original') },
                      { id: '1:1', label: '1:1' },
                      { id: '4:3', label: '4:3' },
                      { id: '16:9', label: '16:9' },
                    ].map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => setAspectMode(opt.id as any)}
                        disabled={cropSaving || smartCropping}
                        className={`px-2 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                          aspectMode === opt.id
                            ? 'bg-[var(--avy-purple)] text-white border-[var(--avy-purple)]'
                            : 'bg-[var(--surface-secondary)] text-[var(--text-primary)] border-[var(--border)] hover:border-[var(--border-hover)]'
                        } disabled:opacity-50`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <div className="text-xs font-semibold text-[var(--text-secondary)] mb-1">
                    {t('sheet.gallery.improve.cropZoom')}
                  </div>
                  <input
                    type="range"
                    min={1}
                    max={6}
                    step={0.01}
                    value={cropZoom}
                    onChange={(e) => setCropZoom(Number(e.target.value))}
                    disabled={cropSaving || smartCropping}
                    className="w-full"
                  />
                  <div className="mt-1 text-[11px] text-[var(--text-tertiary)]">{cropZoom.toFixed(2)}×</div>
                </div>

                <div>
                  <div className="text-xs font-semibold text-[var(--text-secondary)] mb-1">
                    {t('sheet.gallery.improve.cropRotate')}
                  </div>
                  <input
                    type="range"
                    min={-45}
                    max={45}
                    step={0.1}
                    value={cropRotation}
                    onChange={(e) => setCropRotation(Number(e.target.value))}
                    disabled={cropSaving || smartCropping}
                    className="w-full"
                  />
                  <div className="mt-1 text-[11px] text-[var(--text-tertiary)]">{cropRotation.toFixed(1)}°</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => setCropRotation((v) => Math.max(-45, Math.min(45, v - 0.5)))}
                      disabled={cropSaving || smartCropping}
                      className="px-2 py-1 rounded-lg text-xs font-semibold bg-[var(--surface-secondary)] text-[var(--text-primary)] border border-[var(--border)] hover:border-[var(--border-hover)] disabled:opacity-50"
                    >
                      −0.5°
                    </button>
                    <button
                      type="button"
                      onClick={() => setCropRotation((v) => Math.max(-45, Math.min(45, v + 0.5)))}
                      disabled={cropSaving || smartCropping}
                      className="px-2 py-1 rounded-lg text-xs font-semibold bg-[var(--surface-secondary)] text-[var(--text-primary)] border border-[var(--border)] hover:border-[var(--border-hover)] disabled:opacity-50"
                    >
                      +0.5°
                    </button>
                    <button
                      type="button"
                      onClick={() => setCropRotation(0)}
                      disabled={cropSaving || smartCropping}
                      className="px-2 py-1 rounded-lg text-xs font-semibold bg-[var(--surface-secondary)] text-[var(--text-primary)] border border-[var(--border)] hover:border-[var(--border-hover)] disabled:opacity-50"
                    >
                      0°
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {cropError ? <div className="text-xs text-[var(--error)]">{cropError}</div> : null}
          </div>
        ) : (
          <div className="text-sm text-[var(--text-tertiary)]">{t('sheet.gallery.improve.working')}</div>
        )}
      </Modal>
    </div>
  );
};

export default ImageGallery;

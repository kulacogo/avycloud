
import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { UploadIcon, CameraIcon, BarcodeIcon } from './icons/Icons';
import type { UploadGroupPayload } from '../hooks/useIdentification';
import { useI18n } from '../i18n';
import { normalizeBarcode, summarizeBarcodes } from '../utils/gtin';
import { Notice } from './ui/Notice';

interface ProductInputProps {
  onIdentify: (
    groups: UploadGroupPayload[],
    barcodes: string
  ) => void;
}

interface GroupImage {
  id: string;
  file: File;
  preview: string;
}

interface UploadGroup {
  id: string;
  name: string;
  images: GroupImage[];
}

// iPadOS 13+ reports "Macintosh" in the UA; detect via touch points.
const isIOSDevice =
  typeof navigator !== 'undefined' &&
  (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && (navigator as any).maxTouchPoints > 1));
const supportsBrowserCamera =
  typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

// Backend pipeline expects JPEG/PNG/WebP. iPhone Photos default to HEIC, which decoders cannot
// process — block at upload boundary so users get an actionable hint instead of a silent fail.
const ACCEPTED_IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp'] as const;
const ACCEPT_ATTR = ACCEPTED_IMAGE_MIME.join(',');

const isHeicFile = (file: File): boolean => {
  const type = (file.type || '').toLowerCase();
  if (type === 'image/heic' || type === 'image/heif') return true;
  const name = (file.name || '').toLowerCase();
  return name.endsWith('.heic') || name.endsWith('.heif');
};

const isAcceptedImage = (file: File): boolean => {
  if (isHeicFile(file)) return false;
  const type = (file.type || '').toLowerCase();
  if ((ACCEPTED_IMAGE_MIME as readonly string[]).includes(type)) return true;
  // iOS sometimes leaves type empty — fall back to extension.
  const name = (file.name || '').toLowerCase();
  return /\.(jpe?g|png|webp)$/.test(name);
};

// Map standard MediaDevices DOMException names to actionable user messages. `error.name` is
// stable across browsers per spec; `error.message` is not.
const mapCameraError = (
  error: any,
  t: (key: string) => string
): { title: string; details?: string } => {
  const name = error?.name || '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return {
      title: 'Kamera-Zugriff verweigert',
      details:
        'Bitte den Kamera-Zugriff in den Browser-Einstellungen erlauben. iOS: Einstellungen → Safari → Kamera.',
    };
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return { title: 'Keine Kamera gefunden' };
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return {
      title: 'Kamera ist belegt',
      details: 'Die Kamera wird gerade von einer anderen App genutzt. Bitte schließen und erneut versuchen.',
    };
  }
  if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') {
    return { title: 'Kamera-Einstellungen werden nicht unterstützt' };
  }
  if (name === 'SecurityError') {
    return {
      title: 'Kamera blockiert (HTTPS erforderlich)',
      details: 'Kamera-Zugriff funktioniert nur über HTTPS oder localhost.',
    };
  }
  return { title: t('input.camera.error'), details: error?.message };
};

const createId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2, 10);
};

const createGroup = (index: number, name?: string): UploadGroup => ({
  id: createId(),
  name: name || `Produkt ${index + 1}`,
  images: [],
});

const ProductInput: React.FC<ProductInputProps> = ({ onIdentify }) => {
  const { t } = useI18n();
  const [groups, setGroups] = useState<UploadGroup[]>([createGroup(0, t('input.groups.defaultName', { index: 1 }))]);
  const groupsRef = useRef<UploadGroup[]>(groups);
  const [barcodes, setBarcodes] = useState('');
  const [cameraTargetGroup, setCameraTargetGroup] = useState<string | null>(null);
  const [isCameraOn, setIsCameraOn] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'info' | 'warning' | 'error'; title: string; details?: string } | null>(null);
  const manualBarcodeList = useMemo(
    () =>
      barcodes
        .split(/[\n,;]+/)
        .map((value) => normalizeBarcode(value.trim()))
        .filter(Boolean),
    [barcodes]
  );

  const manualBarcodeSummary = useMemo(
    () => summarizeBarcodes(manualBarcodeList),
    [manualBarcodeList]
  );
  const videoRef = useRef<HTMLVideoElement>(null);
  const groupNameForIndex = useCallback(
    (index: number) => t('input.groups.defaultName', { index: index + 1 }),
    [t]
  );

  const addImagesToGroup = useCallback((groupId: string, files: File[]) => {
    if (!files.length) return;
    setGroups((prev) =>
      prev.map((group) => {
        if (group.id !== groupId) return group;
        const additions = files.map((file) => ({
          id: createId(),
          file,
          preview: URL.createObjectURL(file),
        }));
        return { ...group, images: [...group.images, ...additions] };
      })
    );
  }, []);

  const filterAndNotifyUnsupported = useCallback(
    (files: File[]): File[] => {
      if (!files.length) return [];
      const heic = files.filter(isHeicFile);
      const otherUnsupported = files.filter((f) => !isHeicFile(f) && !isAcceptedImage(f));
      const accepted = files.filter(isAcceptedImage);
      if (heic.length) {
        setNotice({
          tone: 'warning',
          title: 'iPhone HEIC-Format wird nicht unterstützt',
          details:
            'Bitte unter iPhone-Einstellungen → Kamera → Formate „Maximal kompatibel" wählen, oder die Fotos vor dem Upload in JPG umwandeln.',
        });
      } else if (otherUnsupported.length) {
        setNotice({
          tone: 'warning',
          title: 'Nicht unterstütztes Bildformat',
          details: `Bitte JPG, PNG oder WebP nutzen. Übersprungen: ${otherUnsupported
            .map((f) => f.name)
            .slice(0, 3)
            .join(', ')}${otherUnsupported.length > 3 ? ' …' : ''}`,
        });
      }
      return accepted;
    },
    []
  );

  const handleFileChange = (groupId: string, event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files ? Array.from(event.target.files) : [];
    const accepted = filterAndNotifyUnsupported(files);
    if (accepted.length) addImagesToGroup(groupId, accepted);
    event.target.value = '';
  };

  const removeImage = useCallback((groupId: string, imageId: string) => {
    setGroups((prev) =>
      prev.map((group) => {
        if (group.id !== groupId) return group;
        const target = group.images.find((img) => img.id === imageId);
        if (target) {
          URL.revokeObjectURL(target.preview);
        }
        return {
          ...group,
          images: group.images.filter((img) => img.id !== imageId),
        };
      })
    );
  }, []);

  const moveImageBetweenGroups = useCallback(
    (sourceId: string, targetId: string, imageId: string) => {
      if (sourceId === targetId) return;
      setGroups((prev) => {
        let draggedImage: GroupImage | null = null;
        const updated = prev.map((group) => {
          if (group.id === sourceId) {
            const nextImages = group.images.filter((img) => {
              if (img.id === imageId) {
                draggedImage = img;
                return false;
              }
              return true;
            });
            return { ...group, images: nextImages };
          }
          return group;
        });
        if (!draggedImage) {
          return updated;
        }
        return updated.map((group) => {
          if (group.id === targetId) {
            return { ...group, images: [...group.images, draggedImage!] };
          }
          return group;
        });
      });
    },
    []
  );

  const handleDrop = useCallback(
    (groupId: string, event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      const hasFiles = event.dataTransfer.files && event.dataTransfer.files.length > 0;
      if (hasFiles) {
        const accepted = filterAndNotifyUnsupported(Array.from(event.dataTransfer.files));
        if (accepted.length) addImagesToGroup(groupId, accepted);
        return;
      }
      const payload = event.dataTransfer.getData('application/json');
      if (!payload) return;
      try {
        const { sourceGroupId, imageId } = JSON.parse(payload);
        if (sourceGroupId && imageId) {
          moveImageBetweenGroups(sourceGroupId, groupId, imageId);
        }
      } catch {
        // ignore parsing issues
      }
    },
    [addImagesToGroup, filterAndNotifyUnsupported, moveImageBetweenGroups]
  );

  const handleDragStart = (event: React.DragEvent<HTMLDivElement>, groupId: string, imageId: string) => {
    event.dataTransfer.setData(
      'application/json',
      JSON.stringify({ sourceGroupId: groupId, imageId })
    );
  };

  const addGroup = () => {
    setGroups((prev) => [...prev, createGroup(prev.length, groupNameForIndex(prev.length))]);
  };

  const removeGroup = (groupId: string) => {
    if (groups.length === 1) return;
    setGroups((prev) => {
      const target = prev.find((group) => group.id === groupId);
      if (target) {
        target.images.forEach((img) => URL.revokeObjectURL(img.preview));
      }
      return prev.filter((group) => group.id !== groupId);
    });
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    setNotice(null);
    const payload: UploadGroupPayload[] = groups
      .filter((group) => group.images.length > 0)
      .map((group) => ({
        id: group.id,
        label: group.name,
        images: group.images.map((img) => img.file),
      }));
    if (!payload.length && barcodes.trim() === '') {
      setNotice({ tone: 'warning', title: t('input.errors.payloadRequired') });
      return;
    }
    onIdentify(payload, barcodes);
    // Reset groups for the next run
    setGroups([createGroup(0, groupNameForIndex(0))]);
  };

  const toggleCamera = async (groupId: string) => {
    setCameraTargetGroup(groupId);
    if (isCameraOn) {
      const stream = videoRef.current?.srcObject as MediaStream;
      stream?.getTracks().forEach((track) => track.stop());
      setIsCameraOn(false);
      setCameraError(null);
      return;
    }

    let acquiredStream: MediaStream | null = null;
    try {
      if (!supportsBrowserCamera) {
        throw new Error(t('input.camera.unsupported'));
      }
      // `ideal: 'environment'` falls back to any available camera if the rear camera is missing
      // (e.g. external webcams), instead of failing outright.
      acquiredStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
      });
      if (videoRef.current) {
        videoRef.current.srcObject = acquiredStream;
        await videoRef.current.play();
      }
      setIsCameraOn(true);
      setCameraError(null);
    } catch (error: any) {
      // If getUserMedia succeeded but play() threw, the stream is still live — stop it.
      if (acquiredStream) {
        acquiredStream.getTracks().forEach((track) => track.stop());
        if (videoRef.current && videoRef.current.srcObject === acquiredStream) {
          videoRef.current.srcObject = null;
        }
      }
      console.error('Camera error:', error);
      const { title, details } = mapCameraError(error, t);
      setCameraError(title);
      setNotice({ tone: 'error', title, details });
    }
  };

  const handleCameraButtonClick = (groupId: string) => {
    setCameraTargetGroup(groupId);
    toggleCamera(groupId);
  };

  const captureImage = () => {
    if (!videoRef.current || !cameraTargetGroup) return;
      const canvas = document.createElement('canvas');
      canvas.width = videoRef.current.videoWidth;
      canvas.height = videoRef.current.videoHeight;
      canvas.getContext('2d')?.drawImage(videoRef.current, 0, 0);
    canvas.toBlob(
      (blob) => {
        if (blob) {
          const file = new File([blob], `capture-${Date.now()}.png`, { type: 'image/png' });
          addImagesToGroup(cameraTargetGroup, [file]);
        }
      },
      'image/png',
      0.95
    );
    toggleCamera(cameraTargetGroup);
  };

  useEffect(() => {
    groupsRef.current = groups;
  }, [groups]);

  // Cleanup preview object URLs on unmount only (avoid revoking previews during state updates,
  // which can break image loading on slower/mobile browsers).
  useEffect(() => {
    return () => {
      groupsRef.current.forEach((group) => {
        group.images.forEach((image) => URL.revokeObjectURL(image.preview));
      });
    };
  }, []);

  useEffect(() => {
    return () => {
      const stream = videoRef.current?.srcObject as MediaStream | null;
      stream?.getTracks().forEach((track) => track.stop());
  };
  }, []);

  return (
    <div className="w-full p-5 sm:p-8 bg-app-surface rounded-2xl border border-app-border mt-4 space-y-6 pb-16 sm:pb-8 safe-area-bottom">
      {notice ? (
        <Notice tone={notice.tone} title={notice.title} details={notice.details} onDismiss={() => setNotice(null)} />
      ) : null}
      <form onSubmit={handleSubmit} className="space-y-6">
        
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-txt-secondary">
              <CameraIcon className="w-7 h-7" />
              <span className="font-semibold">{t('input.groups.title')}</span>
            </div>
            <button
              type="button"
              onClick={addGroup}
              className="inline-flex items-center gap-2 rounded-xl border border-app-border px-3 py-2 text-sm font-semibold text-txt-primary hover:bg-white/10 transition-colors"
            >
              <span className="text-lg leading-none">＋</span>
              {t('input.groups.add')}
            </button>
          </div>
          <p className="text-xs text-txt-muted">
            Tipp: <span className="text-txt-secondary font-semibold">pro Produkt eine Gruppe</span>. Wenn in einer Gruppe mehrere verschiedene Produkte gemischt sind, kann Identify sie nicht zuverlässig auseinanderhalten.
          </p>
          <div className="space-y-4">
            {groups.map((group, index) => (
              <div key={group.id} className="rounded-2xl border border-app-border bg-app-bg/50 p-4 space-y-4">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-txt-secondary">{group.name}</p>
                  {groups.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeGroup(group.id)}
                      className="text-xs text-danger hover:text-danger transition-colors"
                    >
                      {t('input.groups.remove')}
                    </button>
                  )}
          </div>
          <div
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => handleDrop(group.id, e)}
                  className="flex flex-col gap-4 rounded-xl border-2 border-dashed border-app-border bg-app-bg/40 p-4 transition-colors hover:border-accent"
                >
                  <div className="flex flex-col lg:flex-row gap-3">
                    {/* Mobile-safe file picker: label(htmlFor)+input(sr-only) is the most reliable across iOS/PWA shells */}
                    <input
                      id={`group-files-${group.id}`}
                      type="file"
                      multiple
                      accept={ACCEPT_ATTR}
                      className="sr-only"
                      onChange={(event) => handleFileChange(group.id, event)}
                    />
                    <label
                      htmlFor={`group-files-${group.id}`}
                      className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl bg-app-elevated border border-white/[0.08] px-4 py-3 text-txt-primary font-semibold hover:bg-app-elevated transition-colors cursor-pointer"
                    >
                      <UploadIcon className="w-5 h-5" />
                      {t('input.groups.files')}
                    </label>

                    {/* Camera: on iOS (or when getUserMedia isn't available), use a capture file input. */}
                    {isIOSDevice || !supportsBrowserCamera ? (
                      <>
                        <input
                          id={`group-camera-${group.id}`}
                          type="file"
                          accept={ACCEPT_ATTR}
                          capture="environment"
                          className="sr-only"
                          onChange={(event) => handleFileChange(group.id, event)}
                        />
                        <label
                          htmlFor={`group-camera-${group.id}`}
                          className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl bg-app-elevated border border-white/[0.08] px-4 py-3 text-txt-primary font-semibold hover:bg-app-elevated transition-colors cursor-pointer"
                        >
                          <CameraIcon className="w-5 h-5" />
                          {t('input.groups.cameraOpen')}
                        </label>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={() => handleCameraButtonClick(group.id)}
                        className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl bg-app-elevated border border-white/[0.08] px-4 py-3 text-txt-primary font-semibold hover:bg-app-elevated transition-colors"
                      >
                        <CameraIcon className="w-5 h-5" />
                        {isCameraOn && cameraTargetGroup === group.id
                          ? t('input.groups.cameraClose')
                          : t('input.groups.cameraOpen')}
                      </button>
                    )}
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                    {group.images.map((image) => (
                      <div
                        key={image.id}
                        draggable
                        onDragStart={(event) => handleDragStart(event, group.id, image.id)}
                        className="relative group rounded-xl overflow-hidden border border-app-border"
                      >
                        <img
                          src={image.preview}
                          alt={image.file.name}
                          className="h-28 w-full object-cover pointer-events-none select-none"
                        />
                        <button
                          type="button"
                          onClick={() => removeImage(group.id, image.id)}
                          className="absolute top-2 right-2 rounded-full bg-black/70 text-txt-primary w-6 h-6 flex items-center justify-center text-sm opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          &times;
                        </button>
                      </div>
                    ))}
                    {!group.images.length && (
                      <div className="h-28 rounded-xl border border-app-border border-dashed flex items-center justify-center text-txt-muted text-sm">
                        {t('input.groups.dropHint')}
                      </div>
                    )}
                  </div>
                </div>
                {cameraError && cameraTargetGroup === group.id && (
                  <p className="text-xs text-danger">{cameraError}</p>
                )}
              </div>
            ))}
          </div>
        </div>

          {isCameraOn && !isIOSDevice && (
          <div className="rounded-2xl border border-app-border bg-app-bg/70 p-4 space-y-3">
            <p className="text-sm text-txt-secondary">
              {t('input.camera.active', {
                name: groups.find((g) => g.id === cameraTargetGroup)?.name || t('input.groups.unknown'),
              })}
            </p>
            <div className="relative">
              <video ref={videoRef} className="w-full rounded-xl bg-black" />
              <button
                type="button"
                onClick={captureImage}
                className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-accent px-5 py-2 text-sm font-semibold text-txt-primary shadow-lg hover:bg-accent/80 transition-colors"
              >
                {t('input.camera.capture')}
              </button>
            </div>
            </div>
          )}
          {isIOSDevice && (
          <p className="text-xs text-txt-muted text-center">{t('input.camera.iosNote')}</p>
          )}

        <div>
          <div className="flex items-center mb-2 text-txt-secondary">
            <BarcodeIcon className="w-6 h-6 mr-2" />
            <span className="font-semibold">{t('input.barcodes.label')}</span>
          </div>
          <textarea
            value={barcodes}
            onChange={(e) => setBarcodes(e.target.value)}
            placeholder={t('input.barcodes.placeholder')}
            className="w-full rounded-xl border border-app-border bg-app-bg/60 p-3 text-sm text-txt-primary focus:border-accent focus:ring-2 focus:ring-accent"
            rows={3}
          />
          <p className="text-xs text-txt-muted mt-1">{t('input.barcodes.hint')}</p>
          <div className="text-xs mt-1">
            {manualBarcodeSummary.hasValid ? (
              <span className="text-success">
                {manualBarcodeSummary.gtin
                  ? t('input.barcodes.statusValidGtin', { code: manualBarcodeSummary.gtin })
                  : t('input.barcodes.statusValidEan', { code: manualBarcodeSummary.ean ?? "" })}
              </span>
            ) : (
              <span className="text-amber-300">{t('input.barcodes.statusMissing')}</span>
            )}
          </div>
        </div>

        <div className="text-center pt-2">
          <button
            type="submit"
            className="w-full sm:w-auto px-12 py-4 bg-accent text-txt-primary text-lg font-bold rounded-xl hover:bg-accent/80 transition-transform transform hover:scale-105"
          >
            {t('input.submit')}
          </button>
        </div>
      </form>
    </div>
  );
};

export default ProductInput;

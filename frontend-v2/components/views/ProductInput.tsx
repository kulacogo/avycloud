
import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { UploadIcon, CameraIcon, BarcodeIcon } from '../icons/Icons';
import type { UploadGroupPayload } from '../../hooks/useIdentification';
import { useI18n } from '../../i18n';
import { normalizeBarcode, summarizeBarcodes } from '../../utils/gtin';
import { Notice } from '../shared/Notice';

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

/* ------------------------------------------------------------------ */
/*  Inline SVG helpers (matching the mockup icon style)               */
/* ------------------------------------------------------------------ */

const UploadCloudSvg = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
    <polyline points="17 8 12 3 7 8" />
    <line x1="12" y1="3" x2="12" y2="15" />
  </svg>
);

const GallerySvg = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="2" width="10" height="10" rx="1.5" />
    <circle cx="5" cy="5.5" r="1.5" />
    <path d="M2 10l3-3 2 1.5 3-3 2 2" />
  </svg>
);

const CameraSvg = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="1" y="3.5" width="12" height="9" rx="1.5" />
    <circle cx="7" cy="8" r="2.5" />
    <path d="M4.5 3.5L5.5 2h3l1 1.5" />
  </svg>
);

const CameraCardIcon = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="5" width="16" height="12" rx="2" />
    <circle cx="10" cy="11" r="3" />
    <path d="M6 5l1-2h6l1 2" />
  </svg>
);

const BarcodeCardIcon = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="14" height="12" rx="2" />
    <path d="M6 7v6M8 7v6M10 7v4M12 7v6M14 7v4" />
  </svg>
);

const SearchSvg = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="8" cy="8" r="5" />
    <path d="M13 13l3 3" />
  </svg>
);

const IdentifySvg = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.41 1.41M11.54 11.54l1.41 1.41M3.05 12.95l1.41-1.41M11.54 4.46l1.41-1.41" />
    <circle cx="8" cy="8" r="2.5" />
  </svg>
);

const PlusSvg = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M7 2v10M2 7h10" />
  </svg>
);

const TrashSvg = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" />
  </svg>
);

const ProductInput: React.FC<ProductInputProps> = ({ onIdentify }) => {
  const { t } = useI18n();
  const [groups, setGroups] = useState<UploadGroup[]>([createGroup(0, t('input.groups.defaultName', { index: 1 }))]);
  const groupsRef = useRef<UploadGroup[]>(groups);
  const [barcodes, setBarcodes] = useState('');
  const [cameraTargetGroup, setCameraTargetGroup] = useState<string | null>(null);
  const [isCameraOn, setIsCameraOn] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'info' | 'warning' | 'error'; title: string; details?: string } | null>(null);
  const [dragOverGroup, setDragOverGroup] = useState<string | null>(null);
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

  const handleFileChange = (groupId: string, event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files ? Array.from(event.target.files) : [];
    addImagesToGroup(groupId, files);
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
      setDragOverGroup(null);
      const hasFiles = event.dataTransfer.files && event.dataTransfer.files.length > 0;
      if (hasFiles) {
        addImagesToGroup(groupId, Array.from(event.dataTransfer.files));
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
    [addImagesToGroup, moveImageBetweenGroups]
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

      try {
        if (!supportsBrowserCamera) {
          throw new Error(t('input.camera.unsupported'));
        }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
      });
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        await videoRef.current.play();
        }
        setIsCameraOn(true);
        setCameraError(null);
    } catch (error: any) {
      console.error('Camera error:', error);
      const message = error?.message || t('input.camera.error');
      setCameraError(message);
      setNotice({ tone: 'error', title: 'Kamera Fehler', details: message });
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

  /* ------------------------------------------------------------------ */
  /*  Total image count across all groups (for the submit button label) */
  /* ------------------------------------------------------------------ */
  const totalImages = groups.reduce((sum, g) => sum + g.images.length, 0);

  return (
    <div className="w-full">
      {notice ? (
        <div className="mb-5">
          <Notice tone={notice.tone} title={notice.title} details={notice.details} onDismiss={() => setNotice(null)} />
        </div>
      ) : null}

      <form onSubmit={handleSubmit}>

        {/* ============================================================= */}
        {/*  INPUT GRID  – Three-column card layout (mockup: .input-grid) */}
        {/* ============================================================= */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 mb-8">

          {/* ----------------------------------------------------------- */}
          {/*  CARD 1: Camera / Image Upload                              */}
          {/* ----------------------------------------------------------- */}
          <div className="lg:col-span-2 bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-6 transition-all duration-300 hover:border-[var(--border-hover)] hover:shadow-[0_2px_4px_rgba(0,0,0,0.04),0_8px_24px_rgba(0,0,0,0.06)]">
            {/* Card header */}
            <div className="flex items-center gap-3 mb-5">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 bg-[rgba(99,91,255,0.12)] text-[var(--avy-purple)]">
                <CameraCardIcon />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[15px] font-bold text-[var(--text-primary)]">{t('input.groups.title')}</div>
                <div className="text-xs text-[var(--text-tertiary)]">
                  Tipp: pro Produkt eine Gruppe
                </div>
              </div>
              <button
                type="button"
                onClick={addGroup}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-semibold text-[var(--text-secondary)] hover:border-[var(--border-hover)] hover:text-[var(--text-primary)] hover:shadow-[0_1px_1px_rgba(0,0,0,0.03),0_3px_6px_rgba(0,0,0,0.02)] transition-all duration-200"
              >
                <PlusSvg />
                {t('input.groups.add')}
              </button>
            </div>

            {/* Product groups */}
            <div className="space-y-5">
              {groups.map((group, index) => (
                <div key={group.id} className="space-y-3">
                  {/* Group header */}
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-[var(--text-primary)]">{group.name}</span>
                    {groups.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeGroup(group.id)}
                        className="text-xs font-medium text-[var(--error)] border border-[var(--error-border,#FECACA)] rounded-md px-2 py-0.5 hover:bg-[var(--error-bg)] transition-colors duration-150"
                      >
                        {t('input.groups.remove')}
                      </button>
                    )}
                  </div>

                  {/* Drop zone */}
                  <div
                    onDragOver={(e) => { e.preventDefault(); setDragOverGroup(group.id); }}
                    onDragLeave={() => setDragOverGroup(null)}
                    onDrop={(e) => handleDrop(group.id, e)}
                    className={`
                      border-2 border-dashed rounded-xl p-8 text-center cursor-pointer
                      flex flex-col items-center gap-3 min-h-[180px] justify-center
                      transition-all duration-200
                      ${dragOverGroup === group.id
                        ? 'border-[var(--avy-purple)] bg-[rgba(99,91,255,0.12)] shadow-[inset_0_0_0_1px_rgba(99,91,255,0.1)]'
                        : 'border-[var(--border)] bg-[var(--surface-hover,#FAFBFD)] hover:border-[var(--avy-purple)] hover:bg-[rgba(99,91,255,0.12)]'
                      }
                    `}
                  >
                    {group.images.length === 0 ? (
                      <>
                        <div className="w-12 h-12 rounded-full bg-[rgba(99,91,255,0.12)] text-[var(--avy-purple)] flex items-center justify-center transition-all duration-200">
                          <UploadCloudSvg />
                        </div>
                        <div className="text-[13px] font-semibold text-[var(--text-primary)]">
                          {t('input.groups.dropHint')}
                        </div>
                        <div className="text-xs text-[var(--text-tertiary)]">Max. 10 MB pro Datei</div>
                        <div className="text-[11px] text-[var(--text-tertiary)] mt-1 flex items-center gap-1 flex-wrap justify-center">
                          <span className="px-1.5 py-0.5 bg-[var(--surface-secondary)] rounded font-medium">JPG</span>
                          <span className="px-1.5 py-0.5 bg-[var(--surface-secondary)] rounded font-medium">PNG</span>
                          <span className="px-1.5 py-0.5 bg-[var(--surface-secondary)] rounded font-medium">HEIC</span>
                          <span className="px-1.5 py-0.5 bg-[var(--surface-secondary)] rounded font-medium">WebP</span>
                        </div>
                      </>
                    ) : (
                      /* Image grid when images are present */
                      <div className="w-full grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                        {group.images.map((image) => (
                          <div
                            key={image.id}
                            draggable
                            onDragStart={(event) => handleDragStart(event, group.id, image.id)}
                            className="relative group/img rounded-xl overflow-hidden border border-[var(--border)] bg-[var(--surface-secondary)]"
                          >
                            <img
                              src={image.preview}
                              alt={image.file.name}
                              className="h-[100px] w-full object-cover pointer-events-none select-none"
                            />
                            <button
                              type="button"
                              onClick={() => removeImage(group.id, image.id)}
                              className="absolute top-1.5 right-1.5 w-6 h-6 rounded-md border-none bg-black/60 text-white flex items-center justify-center cursor-pointer opacity-0 group-hover/img:opacity-100 transition-all duration-150 backdrop-blur-sm hover:bg-black/80"
                            >
                              <TrashSvg />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Camera / File picker row */}
                  <div className="flex gap-3">
                    {/* Mobile-safe file picker */}
                    <input
                      id={`group-files-${group.id}`}
                      type="file"
                      multiple
                      accept="image/*"
                      className="sr-only"
                      onChange={(event) => handleFileChange(group.id, event)}
                    />
                    <label
                      htmlFor={`group-files-${group.id}`}
                      className="flex-1 inline-flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg text-xs font-semibold cursor-pointer transition-all duration-200 border border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)] hover:border-[var(--avy-purple)] hover:text-[var(--avy-purple)] hover:bg-[rgba(99,91,255,0.12)]"
                    >
                      <GallerySvg />
                      {t('input.groups.files')}
                    </label>

                    {/* Camera button */}
                    {isIOSDevice || !supportsBrowserCamera ? (
                      <>
                        <input
                          id={`group-camera-${group.id}`}
                          type="file"
                          accept="image/*"
                          capture="environment"
                          className="sr-only"
                          onChange={(event) => handleFileChange(group.id, event)}
                        />
                        <label
                          htmlFor={`group-camera-${group.id}`}
                          className="flex-1 inline-flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg text-xs font-semibold cursor-pointer transition-all duration-200 border border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)] hover:border-[var(--avy-purple)] hover:text-[var(--avy-purple)] hover:bg-[rgba(99,91,255,0.12)]"
                        >
                          <CameraSvg />
                          {t('input.groups.cameraOpen')}
                        </label>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={() => handleCameraButtonClick(group.id)}
                        className="flex-1 inline-flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg text-xs font-semibold cursor-pointer transition-all duration-200 border border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)] hover:border-[var(--avy-purple)] hover:text-[var(--avy-purple)] hover:bg-[rgba(99,91,255,0.12)]"
                      >
                        <CameraSvg />
                        {isCameraOn && cameraTargetGroup === group.id
                          ? t('input.groups.cameraClose')
                          : t('input.groups.cameraOpen')}
                      </button>
                    )}
                  </div>

                  {/* Camera error */}
                  {cameraError && cameraTargetGroup === group.id && (
                    <p className="text-xs text-[var(--error)]">{cameraError}</p>
                  )}

                  {/* Divider between groups */}
                  {index < groups.length - 1 && (
                    <div className="border-t border-[var(--border)] mt-2" />
                  )}
                </div>
              ))}
            </div>

            {/* Camera live view */}
            {isCameraOn && !isIOSDevice && (
              <div className="mt-5 rounded-xl border border-[var(--border)] bg-[var(--surface-secondary)] p-4 space-y-3">
                <p className="text-sm font-medium text-[var(--text-primary)]">
                  {t('input.camera.active', {
                    name: groups.find((g) => g.id === cameraTargetGroup)?.name || t('input.groups.unknown'),
                  })}
                </p>
                <div className="relative">
                  <video ref={videoRef} className="w-full rounded-xl bg-black" />
                  <button
                    type="button"
                    onClick={captureImage}
                    className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-[var(--avy-purple)] px-5 py-2 text-sm font-semibold text-white shadow-lg hover:bg-[var(--avy-purple-hover)] hover:-translate-y-[1px] active:translate-y-0 transition-all duration-200"
                  >
                    {t('input.camera.capture')}
                  </button>
                </div>
              </div>
            )}
            {isIOSDevice && (
              <p className="text-xs text-[var(--text-tertiary)] text-center mt-3">{t('input.camera.iosNote')}</p>
            )}
          </div>

          {/* ----------------------------------------------------------- */}
          {/*  CARD 2: Barcode / EAN Input                                */}
          {/* ----------------------------------------------------------- */}
          <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl p-6 transition-all duration-300 hover:border-[var(--border-hover)] hover:shadow-[0_2px_4px_rgba(0,0,0,0.04),0_8px_24px_rgba(0,0,0,0.06)]">
            {/* Card header */}
            <div className="flex items-center gap-3 mb-5">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 bg-[var(--info-bg,#EFF6FF)] text-[var(--info,#0070F3)]">
                <BarcodeCardIcon />
              </div>
              <div>
                <div className="text-[15px] font-bold text-[var(--text-primary)]">{t('input.barcodes.label')}</div>
                <div className="text-xs text-[var(--text-tertiary)]">Schnelle Produktsuche per Code</div>
              </div>
            </div>

            {/* Barcode textarea */}
            <textarea
              value={barcodes}
              onChange={(e) => setBarcodes(e.target.value)}
              placeholder={t('input.barcodes.placeholder')}
              rows={5}
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 text-[15px] font-semibold text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] placeholder:font-normal placeholder:text-sm outline-none transition-all duration-200 focus:border-[var(--avy-purple)] focus:shadow-[0_0_0_3px_rgba(99,91,255,0.12)] resize-none"
              style={{ fontFamily: "'SF Mono', 'Fira Code', 'Consolas', monospace", letterSpacing: '0.05em' }}
            />

            <p className="text-xs text-[var(--text-tertiary)] mt-2">{t('input.barcodes.hint')}</p>

            {/* Barcode validation status */}
            <div className="mt-2 text-xs">
              {manualBarcodeSummary.hasValid ? (
                <div className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-[var(--success)]" />
                  <span className="text-[var(--success)] font-semibold">
                    {manualBarcodeSummary.gtin
                      ? t('input.barcodes.statusValidGtin', { code: manualBarcodeSummary.gtin })
                      : t('input.barcodes.statusValidEan', { code: manualBarcodeSummary.ean ?? '' })}
                  </span>
                </div>
              ) : (
                <div className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-[var(--warning)]" />
                  <span className="text-[var(--warning)]">{t('input.barcodes.statusMissing')}</span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ============================================================= */}
        {/*  IDENTIFY BUTTON                                              */}
        {/* ============================================================= */}
        <div className="flex justify-center">
          <button
            type="submit"
            className="
              inline-flex items-center gap-2.5 px-10 py-3.5
              bg-[var(--avy-purple)] text-white text-[14px] font-bold rounded-xl
              hover:bg-[var(--avy-purple-hover)] hover:-translate-y-[1px]
              hover:shadow-[0_4px_12px_rgba(99,91,255,0.3)]
              active:translate-y-0
              transition-all duration-200
            "
          >
            <IdentifySvg />
            {t('input.submit')}
            {totalImages > 0 && (
              <span className="ml-1 px-2 py-0.5 rounded-full bg-white/20 text-[11px] font-semibold">
                {totalImages} {totalImages === 1 ? 'Bild' : 'Bilder'}
              </span>
            )}
          </button>
        </div>
      </form>
    </div>
  );
};

export default ProductInput;

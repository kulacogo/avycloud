
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

  return (
    <div>
      {/* Page Header */}
      <div className="page-header">
        <div>
          <h1>Produkt-Identifizierung</h1>
          <div className="page-header-sub">Produkte per Bild, Barcode oder manuell erfassen</div>
        </div>
      </div>

      <div className="content">
        {notice ? (
          <Notice tone={notice.tone} title={notice.title} details={notice.details} onDismiss={() => setNotice(null)} />
        ) : null}

        <form onSubmit={handleSubmit}>

          {/* ---- Image Upload Card ---- */}
          <div className="card" style={{ marginBottom: 'var(--space-6)' }}>
            <div className="card-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <CameraIcon style={{ width: '18px', height: '18px', color: 'var(--avy-purple)' }} />
                <span className="card-title">{t('input.groups.title')}</span>
              </div>
              <button
                type="button"
                onClick={addGroup}
                className="btn btn-secondary btn-sm"
              >
                <span style={{ fontSize: '14px', lineHeight: 1 }}>+</span>
                {t('input.groups.add')}
              </button>
            </div>
            <div className="card-body">
              <p style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginBottom: 'var(--space-4)' }}>
                Tipp: <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>pro Produkt eine Gruppe</span>. Wenn in einer Gruppe mehrere verschiedene Produkte gemischt sind, kann Identify sie nicht zuverlässig auseinanderhalten.
              </p>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
                {groups.map((group, index) => (
                  <div
                    key={group.id}
                    className="card"
                    style={{ borderRadius: 'var(--radius-lg)' }}
                  >
                    <div className="card-header">
                      <span className="card-title">{group.name}</span>
                      {groups.length > 1 && (
                        <button
                          type="button"
                          onClick={() => removeGroup(group.id)}
                          className="btn btn-danger btn-sm"
                        >
                          {t('input.groups.remove')}
                        </button>
                      )}
                    </div>
                    <div className="card-body">
                      <div
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => handleDrop(group.id, e)}
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 'var(--space-4)',
                          borderRadius: 'var(--radius-lg)',
                          border: '2px dashed var(--border)',
                          background: 'var(--surface-hover)',
                          padding: 'var(--space-4)',
                          transition: 'border-color var(--transition)',
                        }}
                      >
                        <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
                          {/* Mobile-safe file picker: label(htmlFor)+input(sr-only) is the most reliable across iOS/PWA shells */}
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
                            className="btn btn-secondary"
                            style={{ flex: 1, justifyContent: 'center', cursor: 'pointer' }}
                          >
                            <UploadIcon style={{ width: '16px', height: '16px' }} />
                            {t('input.groups.files')}
                          </label>

                          {/* Camera: on iOS (or when getUserMedia isn't available), use a capture file input. */}
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
                                className="btn btn-secondary"
                                style={{ flex: 1, justifyContent: 'center', cursor: 'pointer' }}
                              >
                                <CameraIcon style={{ width: '16px', height: '16px' }} />
                                {t('input.groups.cameraOpen')}
                              </label>
                            </>
                          ) : (
                            <button
                              type="button"
                              onClick={() => handleCameraButtonClick(group.id)}
                              className="btn btn-secondary"
                              style={{ flex: 1, justifyContent: 'center' }}
                            >
                              <CameraIcon style={{ width: '16px', height: '16px' }} />
                              {isCameraOn && cameraTargetGroup === group.id
                                ? t('input.groups.cameraClose')
                                : t('input.groups.cameraOpen')}
                            </button>
                          )}
                        </div>

                        {/* Image thumbnails grid */}
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))', gap: 'var(--space-3)' }}>
                          {group.images.map((image) => (
                            <div
                              key={image.id}
                              draggable
                              onDragStart={(event) => handleDragStart(event, group.id, image.id)}
                              style={{
                                position: 'relative',
                                borderRadius: 'var(--radius-md)',
                                overflow: 'hidden',
                                border: '1px solid var(--border)',
                              }}
                            >
                              <img
                                src={image.preview}
                                alt={image.file.name}
                                style={{
                                  height: '112px',
                                  width: '100%',
                                  objectFit: 'cover',
                                  pointerEvents: 'none',
                                  userSelect: 'none',
                                  display: 'block',
                                }}
                              />
                              <button
                                type="button"
                                onClick={() => removeImage(group.id, image.id)}
                                style={{
                                  position: 'absolute',
                                  top: '6px',
                                  right: '6px',
                                  borderRadius: '50%',
                                  background: 'rgba(0,0,0,0.7)',
                                  color: 'white',
                                  width: '24px',
                                  height: '24px',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  fontSize: '14px',
                                  border: 'none',
                                  cursor: 'pointer',
                                  opacity: 0.8,
                                  transition: 'opacity 150ms',
                                }}
                              >
                                &times;
                              </button>
                            </div>
                          ))}
                          {!group.images.length && (
                            <div
                              style={{
                                height: '112px',
                                borderRadius: 'var(--radius-md)',
                                border: '1px dashed var(--border)',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                color: 'var(--text-tertiary)',
                                fontSize: '13px',
                              }}
                            >
                              {t('input.groups.dropHint')}
                            </div>
                          )}
                        </div>
                      </div>

                      {cameraError && cameraTargetGroup === group.id && (
                        <p style={{ fontSize: '12px', color: 'var(--error)', marginTop: 'var(--space-2)' }}>{cameraError}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* ---- Camera Live Preview ---- */}
          {isCameraOn && !isIOSDevice && (
            <div className="card" style={{ marginBottom: 'var(--space-6)' }}>
              <div className="card-header">
                <span className="card-title">
                  {t('input.camera.active', {
                    name: groups.find((g) => g.id === cameraTargetGroup)?.name || t('input.groups.unknown'),
                  })}
                </span>
              </div>
              <div className="card-body" style={{ position: 'relative' }}>
                <video
                  ref={videoRef}
                  style={{
                    width: '100%',
                    borderRadius: 'var(--radius-md)',
                    background: 'black',
                    display: 'block',
                  }}
                />
                <div style={{ marginTop: 'var(--space-3)', textAlign: 'center' }}>
                  <button
                    type="button"
                    onClick={captureImage}
                    className="btn btn-primary"
                  >
                    {t('input.camera.capture')}
                  </button>
                </div>
              </div>
            </div>
          )}
          {isIOSDevice && (
            <p style={{ fontSize: '12px', color: 'var(--text-tertiary)', textAlign: 'center', marginBottom: 'var(--space-4)' }}>
              {t('input.camera.iosNote')}
            </p>
          )}

          {/* ---- Barcode Card ---- */}
          <div className="card" style={{ marginBottom: 'var(--space-6)' }}>
            <div className="card-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <BarcodeIcon style={{ width: '18px', height: '18px', color: 'var(--info)' }} />
                <span className="card-title">{t('input.barcodes.label')}</span>
              </div>
            </div>
            <div className="card-body">
              <div className="form-group">
                <label className="form-label">{t('input.barcodes.label')}</label>
                <textarea
                  value={barcodes}
                  onChange={(e) => setBarcodes(e.target.value)}
                  placeholder={t('input.barcodes.placeholder')}
                  className="form-input"
                  rows={3}
                />
              </div>
              <p style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginBottom: 'var(--space-2)' }}>
                {t('input.barcodes.hint')}
              </p>
              <div style={{ fontSize: '12px' }}>
                {manualBarcodeSummary.hasValid ? (
                  <span style={{ color: 'var(--success)' }}>
                    {manualBarcodeSummary.gtin
                      ? t('input.barcodes.statusValidGtin', { code: manualBarcodeSummary.gtin })
                      : t('input.barcodes.statusValidEan', { code: manualBarcodeSummary.ean })}
                  </span>
                ) : (
                  <span style={{ color: 'var(--warning)' }}>{t('input.barcodes.statusMissing')}</span>
                )}
              </div>
            </div>
          </div>

          {/* ---- Submit ---- */}
          <div style={{ textAlign: 'center', paddingTop: 'var(--space-2)' }}>
            <button
              type="submit"
              className="btn btn-primary btn-lg"
              style={{ minWidth: '200px' }}
            >
              {t('input.submit')}
            </button>
          </div>

        </form>
      </div>
    </div>
  );
};

export default ProductInput;

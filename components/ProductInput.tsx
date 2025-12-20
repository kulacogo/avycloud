
import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { UploadIcon, CameraIcon, BarcodeIcon } from './icons/Icons';
import type { UploadGroupPayload, IdentifyPipeline } from '../hooks/useIdentification';
import { useI18n } from '../i18n';
import { normalizeBarcode, summarizeBarcodes } from '../utils/gtin';

interface ProductInputProps {
  onIdentify: (
    groups: UploadGroupPayload[],
    barcodes: string,
    model: string | undefined,
    pipeline: IdentifyPipeline,
    inventoryId?: string | null,
    inventoryName?: string | null
  ) => void;
}

type ModelOption = 'gpt-5-mini-2025-08-07' | 'gpt-5-mini';

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

const isIOSDevice = typeof navigator !== 'undefined' && /iPad|iPhone|iPod/.test(navigator.userAgent);
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
  const [barcodes, setBarcodes] = useState('');
  const [model, setModel] = useState<ModelOption>('gpt-5-mini-2025-08-07');
  // Force a single default pipeline: Vision + Gemini (SerpAPI-frei)
  const pipeline: IdentifyPipeline = 'v2';
  const [cameraTargetGroup, setCameraTargetGroup] = useState<string | null>(null);
  const [isCameraOn, setIsCameraOn] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
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
  const captureInputRef = useRef<HTMLInputElement>(null);
  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
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
    const payload: UploadGroupPayload[] = groups
      .filter((group) => group.images.length > 0)
      .map((group) => ({
        id: group.id,
        label: group.name,
        images: group.images.map((img) => img.file),
      }));
    if (!payload.length && barcodes.trim() === '') {
      alert(t('input.errors.payloadRequired'));
      return;
    }
    onIdentify(payload, barcodes, model, pipeline);
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
        alert(message);
    }
  };

  const handleCameraButtonClick = (groupId: string) => {
    setCameraTargetGroup(groupId);
    if (isIOSDevice || !supportsBrowserCamera) {
      captureInputRef.current?.click();
      return;
    }
    toggleCamera(groupId);
  };

  const handleCaptureFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files && event.target.files.length > 0) {
      const target = cameraTargetGroup || groups[0].id;
      addImagesToGroup(target, Array.from(event.target.files));
    }
    event.target.value = '';
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
    return () => {
      groups.forEach((group) =>
        group.images.forEach((image) => URL.revokeObjectURL(image.preview))
      );
    };
  }, [groups]);

  useEffect(() => {
    return () => {
      const stream = videoRef.current?.srcObject as MediaStream | null;
      stream?.getTracks().forEach((track) => track.stop());
  };
  }, []);

  return (
    <div className="w-full p-4 sm:p-8 bg-slate-800 rounded-2xl shadow-2xl mt-4 space-y-6 pb-16 sm:pb-8 safe-area-bottom">
      <form onSubmit={handleSubmit} className="space-y-6">
        
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-slate-200">
              <CameraIcon className="w-7 h-7" />
              <span className="font-semibold">{t('input.groups.title')}</span>
            </div>
            <button
              type="button"
              onClick={addGroup}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-600 px-3 py-2 text-sm font-semibold text-slate-100 hover:bg-slate-700 transition-colors"
            >
              <span className="text-lg leading-none">＋</span>
              {t('input.groups.add')}
            </button>
          </div>
          <div className="space-y-4">
            {groups.map((group, index) => (
              <div key={group.id} className="rounded-2xl border border-slate-700 bg-slate-900/50 p-4 space-y-4">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-slate-200">{group.name}</p>
                  {groups.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeGroup(group.id)}
                      className="text-xs text-rose-300 hover:text-rose-100 transition-colors"
                    >
                      {t('input.groups.remove')}
                    </button>
                  )}
          </div>
          <div
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => handleDrop(group.id, e)}
                  className="flex flex-col gap-4 rounded-xl border-2 border-dashed border-slate-600 bg-slate-900/40 p-4 transition-colors hover:border-sky-500"
                >
                  <div className="flex flex-col lg:flex-row gap-3">
              <button
                type="button"
                      onClick={() => fileInputRefs.current[group.id]?.click()}
                      className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl bg-slate-700 px-4 py-3 text-slate-100 font-semibold hover:bg-slate-600 transition-colors"
              >
                      <UploadIcon className="w-5 h-5" />
                      {t('input.groups.files')}
              </button>
              <button
                type="button"
                      onClick={() => handleCameraButtonClick(group.id)}
                      className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl bg-slate-700 px-4 py-3 text-slate-100 font-semibold hover:bg-slate-600 transition-colors"
              >
                      <CameraIcon className="w-5 h-5" />
                      {isCameraOn && cameraTargetGroup === group.id ? t('input.groups.cameraClose') : t('input.groups.cameraOpen')}
              </button>
            </div>
            <input
                    ref={(el) => {
                      fileInputRefs.current[group.id] = el;
                    }}
              type="file"
              multiple
              accept="image/*"
              className="hidden"
                    onChange={(event) => handleFileChange(group.id, event)}
            />
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                    {group.images.map((image) => (
                      <div
                        key={image.id}
                        draggable
                        onDragStart={(event) => handleDragStart(event, group.id, image.id)}
                        className="relative group rounded-xl overflow-hidden border border-slate-600"
                      >
                        <img
                          src={image.preview}
                          alt={image.file.name}
                          className="h-28 w-full object-cover pointer-events-none select-none"
                        />
                        <button
                          type="button"
                          onClick={() => removeImage(group.id, image.id)}
                          className="absolute top-2 right-2 rounded-full bg-black/70 text-white w-6 h-6 flex items-center justify-center text-sm opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          &times;
                        </button>
                      </div>
                    ))}
                    {!group.images.length && (
                      <div className="h-28 rounded-xl border border-slate-600 border-dashed flex items-center justify-center text-slate-500 text-sm">
                        {t('input.groups.dropHint')}
                      </div>
                    )}
                  </div>
                </div>
                {cameraError && cameraTargetGroup === group.id && (
                  <p className="text-xs text-rose-400">{cameraError}</p>
                )}
              </div>
            ))}
          </div>
        </div>

          {isCameraOn && !isIOSDevice && (
          <div className="rounded-2xl border border-slate-700 bg-slate-900/70 p-4 space-y-3">
            <p className="text-sm text-slate-200">
              {t('input.camera.active', {
                name: groups.find((g) => g.id === cameraTargetGroup)?.name || t('input.groups.unknown'),
              })}
            </p>
            <div className="relative">
              <video ref={videoRef} className="w-full rounded-xl bg-black" />
              <button
                type="button"
                onClick={captureImage}
                className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-sky-600 px-5 py-2 text-sm font-semibold text-white shadow-lg hover:bg-sky-500 transition-colors"
              >
                {t('input.camera.capture')}
              </button>
            </div>
            </div>
          )}
          {isIOSDevice && (
          <p className="text-xs text-slate-400 text-center">{t('input.camera.iosNote')}</p>
          )}

        <div>
          <div className="flex items-center mb-2 text-slate-200">
            <BarcodeIcon className="w-6 h-6 mr-2" />
            <span className="font-semibold">{t('input.barcodes.label')}</span>
          </div>
          <textarea
            value={barcodes}
            onChange={(e) => setBarcodes(e.target.value)}
            placeholder={t('input.barcodes.placeholder')}
            className="w-full rounded-xl border border-slate-600 bg-slate-900/60 p-3 text-sm text-slate-100 focus:border-sky-500 focus:ring-2 focus:ring-sky-500"
            rows={3}
          />
          <p className="text-xs text-slate-500 mt-1">{t('input.barcodes.hint')}</p>
          <div className="text-xs mt-1">
            {manualBarcodeSummary.hasValid ? (
              <span className="text-emerald-300">
                {manualBarcodeSummary.gtin
                  ? t('input.barcodes.statusValidGtin', { code: manualBarcodeSummary.gtin })
                  : t('input.barcodes.statusValidEan', { code: manualBarcodeSummary.ean })}
              </span>
            ) : (
              <span className="text-amber-300">{t('input.barcodes.statusMissing')}</span>
            )}
          </div>
        </div>

        <div>
          <div className="mb-3 text-xs font-semibold tracking-wide text-slate-400 uppercase">
            {t('input.model.title')}
          </div>
          <div className="grid grid-cols-2 gap-3">
            {(['gpt-5-mini-2025-08-07', 'gpt-5-mini'] as ModelOption[]).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setModel(option)}
                aria-pressed={model === option}
                className={`w-full px-4 py-2 rounded-xl border text-sm font-semibold transition-all ${
                  model === option
                    ? 'bg-sky-600 border-sky-500 text-white shadow-lg shadow-sky-900/40'
                    : 'bg-slate-700/80 border-slate-600 text-slate-200 hover:bg-slate-600'
                }`}
              >
                {option === 'gpt-5-mini-2025-08-07' ? t('input.model.default') : t('input.model.fallback')}
              </button>
            ))}
          </div>
        </div>

        <div className="text-center pt-2">
          <button
            type="submit"
            className="w-full sm:w-auto px-12 py-4 bg-sky-600 text-white text-lg font-bold rounded-xl hover:bg-sky-500 transition-transform transform hover:scale-105"
          >
            {t('input.submit')}
          </button>
        </div>
        <input
          ref={captureInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={handleCaptureFileChange}
        />
      </form>
    </div>
  );
};

export default ProductInput;

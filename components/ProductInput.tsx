
import React, { useState, useCallback, useRef } from 'react';
import { UploadIcon, BarcodeIcon, CameraIcon } from './icons/Icons';

interface ProductInputProps {
  onIdentify: (images: File[], barcodes: string, model?: string) => void;
}

const isIOSDevice = typeof navigator !== 'undefined' && /iPad|iPhone|iPod/.test(navigator.userAgent);
const supportsBrowserCamera =
  typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

type ModelOption = 'gpt-5-mini-2025-08-07' | 'gpt-5-mini';

const ProductInput: React.FC<ProductInputProps> = ({ onIdentify }) => {
  const [images, setImages] = useState<File[]>([]);
  const [barcodes, setBarcodes] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [model, setModel] = useState<ModelOption>('gpt-5-mini-2025-08-07');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const captureInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isCameraOn, setIsCameraOn] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) {
      setImages(prev => [...prev, ...Array.from(event.target.files!)]);
    }
  };

  const handleDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    if (event.dataTransfer.files && event.dataTransfer.files.length > 0) {
      setImages(prev => [...prev, ...Array.from(event.dataTransfer.files)]);
      event.dataTransfer.clearData();
    }
  }, []);

  const removeImage = (index: number) => {
    setImages(prev => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (images.length === 0 && barcodes.trim() === '') {
      alert('Please provide at least one image or barcode.');
      return;
    }
    onIdentify(images, barcodes, model);
  };

  const toggleCamera = async () => {
    if (isCameraOn) {
      const stream = videoRef.current?.srcObject as MediaStream;
      stream?.getTracks().forEach(track => track.stop());
      setIsCameraOn(false);
      setCameraError(null);
    } else {
      try {
        if (!supportsBrowserCamera) {
          throw new Error('Camera API not available in this browser.');
        }
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play();
        }
        setIsCameraOn(true);
        setCameraError(null);
      } catch (err: any) {
        console.error('Camera access denied:', err);
        const message = err?.message || 'Could not access the camera. Please check permissions.';
        setCameraError(message);
        alert(message);
      }
    }
  };

  const handleCameraButtonClick = () => {
    if (isIOSDevice || !supportsBrowserCamera) {
      if (captureInputRef.current) {
        captureInputRef.current.click();
      } else {
        alert('Camera not available on this device.');
      }
      return;
    }
    toggleCamera();
  };

  const handleCaptureFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files && event.target.files.length > 0) {
      setImages(prev => [...prev, ...Array.from(event.target.files!)]);
    }
    event.target.value = '';
  };

  const captureImage = () => {
    if (videoRef.current) {
      const canvas = document.createElement('canvas');
      canvas.width = videoRef.current.videoWidth;
      canvas.height = videoRef.current.videoHeight;
      canvas.getContext('2d')?.drawImage(videoRef.current, 0, 0);
      canvas.toBlob(blob => {
        if (blob) {
          const file = new File([blob], `capture-${Date.now()}.png`, { type: 'image/png' });
          setImages(prev => [...prev, file]);
        }
      }, 'image/png');
      toggleCamera();
    }
  };

  return (
    <div className="max-w-4xl mx-auto p-4 sm:p-8 bg-slate-800 rounded-2xl shadow-2xl mt-4 space-y-4">
      <form onSubmit={handleSubmit} className="space-y-8">
        <div>
          <div className="flex items-center mb-2 text-slate-200" aria-label="Product Images">
            <CameraIcon className="w-8 h-8" />
            <span className="sr-only">Product Images</span>
          </div>
          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={`relative flex flex-col items-center justify-center w-full p-8 border-2 border-dashed rounded-2xl transition-colors ${
              isDragging ? 'border-sky-400 bg-slate-700' : 'border-slate-600 bg-slate-900/50'
            }`}
          >
            <UploadIcon className="w-12 h-12 text-slate-500 mb-4" />
            <p className="text-slate-400">Drag & drop files here, or</p>
            <div className="mt-4 flex flex-col sm:flex-row gap-3 w-full">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="w-full sm:w-auto px-4 py-3 bg-slate-600 text-white font-semibold rounded-xl hover:bg-slate-500 transition-colors flex items-center justify-center"
              >
                Browse Files
              </button>
              <button
                type="button"
                onClick={handleCameraButtonClick}
                className="w-full sm:w-auto flex items-center justify-center px-4 py-3 bg-slate-600 text-white font-semibold rounded-xl hover:bg-slate-500 transition-colors"
              >
                <CameraIcon className="w-5 h-5 mr-2" />
                {isCameraOn ? 'Close Camera' : 'Use Camera'}
              </button>
            </div>
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileChange}
              multiple
              accept="image/*"
              className="hidden"
            />
            <input
              type="file"
              ref={captureInputRef}
              accept="image/*"
              capture="environment"
              onChange={handleCaptureFileChange}
              className="hidden"
            />
          </div>
          {cameraError && <p className="mt-2 text-sm text-red-400">{cameraError}</p>}
          {isCameraOn && !isIOSDevice && (
            <div className="mt-4 relative">
              <video ref={videoRef} className="w-full rounded-2xl" />
              <button
                type="button"
                onClick={captureImage}
                className="absolute bottom-4 left-1/2 -translate-x-1/2 px-6 py-3 bg-sky-600 text-white font-bold rounded-full hover:bg-sky-500 transition-transform transform hover:scale-105"
              >
                Capture
              </button>
            </div>
          )}
          {isIOSDevice && (
            <p className="mt-3 text-sm text-slate-400 text-center">
              Auf iOS öffnet der Button direkt die native Kamera oder Fotomediathek. Wiederhole den Vorgang
              für weitere Bilder.
            </p>
          )}
          {images.length > 0 && (
            <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
              {images.map((file, index) => (
                <div key={index} className="relative group">
                  <img src={URL.createObjectURL(file)} alt={file.name} className="w-full h-24 object-cover rounded-md" />
                  <button
                    type="button"
                    onClick={() => removeImage(index)}
                    className="absolute top-0 right-0 -mt-2 -mr-2 bg-red-600 text-white rounded-full w-6 h-6 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    &times;
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <div className="flex items-center mb-2 text-slate-200" aria-label="Barcodes (EAN/GTIN/UPC)">
            <BarcodeIcon className="w-8 h-8" />
            <span className="sr-only">Barcodes (EAN/GTIN/UPC)</span>
          </div>
          <textarea
            id="barcodes"
            value={barcodes}
            onChange={(e) => setBarcodes(e.target.value)}
            placeholder="e.g., 4006381333931, 4954628245731"
            className="w-full p-3 bg-slate-700 border border-slate-600 rounded-lg focus:ring-2 focus:ring-sky-500 focus:border-sky-500 transition"
            rows={3}
          />
          <p className="text-sm text-slate-500 mt-1">Enter barcodes separated by commas or new lines.</p>
        </div>

        <div>
          <div className="flex items-center mb-3 text-xs font-semibold tracking-wide text-slate-400 uppercase">
            <span>AI Model</span>
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
                {option === 'gpt-5-mini-2025-08-07' ? 'GPT-5 mini (2025-08-07)' : 'GPT-5 mini'}
              </button>
            ))}
          </div>
        </div>

        <div className="text-center">
          <button
            type="submit"
            className="w-full sm:w-auto px-12 py-4 bg-sky-600 text-white text-lg font-bold rounded-xl hover:bg-sky-500 transition-transform transform hover:scale-105 disabled:bg-slate-500 disabled:cursor-not-allowed"
          >
            Identify Product
          </button>
        </div>
      </form>
    </div>
  );
};

export default ProductInput;

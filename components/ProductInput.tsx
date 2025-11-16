
import React, { useState, useCallback, useRef } from 'react';
import { UploadIcon, BarcodeIcon, CameraIcon } from './icons/Icons';

interface ProductInputProps {
  onIdentify: (images: File[], barcodes: string, model?: string) => void;
}

const MODEL_OPTIONS = [
  { value: 'gpt-5.1', label: 'GPT-5.1 (Standard)' },
  { value: 'gpt-5.1-mini', label: 'GPT-5.1 Mini (experimentell)' },
] as const;

const ProductInput: React.FC<ProductInputProps> = ({ onIdentify }) => {
  const [images, setImages] = useState<File[]>([]);
  const [barcodes, setBarcodes] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isCameraOn, setIsCameraOn] = useState(false);
  const [model, setModel] = useState<typeof MODEL_OPTIONS[number]['value']>('gpt-5.1');

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
    } else {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play();
        }
        setIsCameraOn(true);
      } catch (err) {
        console.error("Camera access denied:", err);
        alert("Could not access the camera. Please check permissions.");
      }
    }
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
      toggleCamera(); // Turn off camera after capture
    }
  };

  return (
    <div className="max-w-4xl mx-auto p-4 sm:p-8 bg-slate-800 rounded-2xl shadow-2xl">
      <h2 className="text-3xl font-bold text-center text-white mb-2">Identify a New Product</h2>
      <p className="text-center text-slate-400 mb-8">Upload images, use your camera, or enter barcodes to get started.</p>
      
      <form onSubmit={handleSubmit} className="space-y-8">
        <div>
          <label className="block text-lg font-medium text-slate-300 mb-2">Product Images</label>
          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={`relative flex flex-col items-center justify-center w-full p-8 border-2 border-dashed rounded-lg transition-colors ${isDragging ? 'border-sky-400 bg-slate-700' : 'border-slate-600 bg-slate-900/50'}`}
          >
            <UploadIcon className="w-12 h-12 text-slate-500 mb-4" />
            <p className="text-slate-400">Drag & drop files here, or</p>
            <div className="mt-4 flex space-x-4">
              <button type="button" onClick={() => fileInputRef.current?.click()} className="px-4 py-2 bg-slate-600 text-white font-semibold rounded-lg hover:bg-slate-500 transition-colors">
                Browse Files
              </button>
              <button type="button" onClick={toggleCamera} className="flex items-center px-4 py-2 bg-slate-600 text-white font-semibold rounded-lg hover:bg-slate-500 transition-colors">
                <CameraIcon className="w-5 h-5 mr-2" />
                {isCameraOn ? 'Close Camera' : 'Use Camera'}
              </button>
            </div>
            <input type="file" ref={fileInputRef} onChange={handleFileChange} multiple accept="image/*" className="hidden" />
          </div>
          {isCameraOn && (
            <div className="mt-4 relative">
              <video ref={videoRef} className="w-full rounded-lg" />
              <button type="button" onClick={captureImage} className="absolute bottom-4 left-1/2 -translate-x-1/2 px-6 py-3 bg-sky-600 text-white font-bold rounded-full hover:bg-sky-500 transition-transform transform hover:scale-105">
                Capture
              </button>
            </div>
          )}
          {images.length > 0 && (
            <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
              {images.map((file, index) => (
                <div key={index} className="relative group">
                  <img src={URL.createObjectURL(file)} alt={file.name} className="w-full h-24 object-cover rounded-md" />
                  <button type="button" onClick={() => removeImage(index)} className="absolute top-0 right-0 -mt-2 -mr-2 bg-red-600 text-white rounded-full w-6 h-6 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">&times;</button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <label htmlFor="barcodes" className="flex items-center text-lg font-medium text-slate-300 mb-2">
            <BarcodeIcon className="w-6 h-6 mr-2 text-slate-400" />
            Barcodes (EAN/GTIN/UPC)
          </label>
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
          <label className="block text-lg font-medium text-slate-300 mb-2">Model</label>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value as typeof MODEL_OPTIONS[number]['value'])}
            className="w-full p-3 bg-slate-700 border border-slate-600 rounded-lg focus:ring-2 focus:ring-sky-500 focus:border-sky-500 transition text-white"
          >
            {MODEL_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <p className="text-sm text-slate-500 mt-1">
            GPT-5.1 liefert die höchste Datenqualität. GPT-5.1&nbsp;Mini ist schneller und günstiger, befindet sich aber noch im Test.
          </p>
        </div>

        <div className="text-center">
          <button type="submit" className="w-full sm:w-auto px-12 py-4 bg-sky-600 text-white text-lg font-bold rounded-lg hover:bg-sky-500 transition-transform transform hover:scale-105 disabled:bg-slate-500 disabled:cursor-not-allowed">
            Identify Product
          </button>
        </div>
      </form>
    </div>
  );
};

export default ProductInput;

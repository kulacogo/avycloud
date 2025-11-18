import React, { useEffect } from 'react';
import { useBarcodeScanner } from '../hooks/useBarcodeScanner';

interface ScannerOverlayProps {
  open: boolean;
  title: string;
  onClose: () => void;
  onDetected: (value: string) => void;
}

export const ScannerOverlay: React.FC<ScannerOverlayProps> = ({ open, title, onClose, onDetected }) => {
  const { videoRef, isSupported, isScanning, error, startScanning, stopScanning } = useBarcodeScanner();

  useEffect(() => {
    if (open) {
      startScanning({ onDetected }).catch(() => {});
    } else {
      stopScanning();
    }
    return () => {
      stopScanning();
    };
  }, [open, onDetected, startScanning, stopScanning]);

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center px-4">
      <div className="bg-slate-900 rounded-2xl shadow-2xl border border-slate-700 w-full max-w-lg">
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-700">
          <h3 className="text-white font-semibold">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-300 hover:text-white text-sm px-3 py-1 border border-slate-600 rounded-full"
          >
            Schließen
          </button>
        </div>
        <div className="p-5 space-y-3 text-center">
          {!isSupported && (
            <p className="text-slate-300 text-sm">
              Dieses Gerät unterstützt die Barcode-Erkennung im Browser nicht. Bitte Wert manuell eingeben.
            </p>
          )}
          {isSupported && (
            <div className="relative bg-black rounded-xl overflow-hidden min-h-[240px]">
              <video ref={videoRef} className="w-full h-full object-cover" muted playsInline />
              <div className="absolute inset-0 border-2 border-sky-500/70 rounded-xl pointer-events-none" />
            </div>
          )}
          {error && <p className="text-rose-300 text-sm">{error}</p>}
          <p className="text-xs text-slate-400">
            {isScanning ? 'Scanner aktiv … bitte Code zentrieren.' : 'Scanner wird gestartet …'}
          </p>
        </div>
      </div>
    </div>
  );
};


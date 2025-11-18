import React, { useEffect } from 'react';
import { useBarcodeScanner } from '../hooks/useBarcodeScanner';

interface ScannerOverlayProps {
  open: boolean;
  title: string;
  onClose: () => void;
  onDetected: (value: string) => void;
  fallbackHint?: string;
  fallbackBusy?: boolean;
  onFallbackCapture?: () => void;
}

export const ScannerOverlay: React.FC<ScannerOverlayProps> = ({
  open,
  title,
  onClose,
  onDetected,
  fallbackHint,
  fallbackBusy = false,
  onFallbackCapture,
}) => {
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
        <div className="p-5 space-y-4 text-center">
          {isSupported ? (
            <div className="relative bg-black rounded-xl overflow-hidden min-h-[240px]">
              <video ref={videoRef} className="w-full h-full object-cover" muted playsInline />
              <div className="absolute inset-0 border-2 border-sky-500/70 rounded-xl pointer-events-none" />
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-slate-300 text-sm">
                Dieses Gerät unterstützt die Barcode-Erkennung per Live-Scanner nicht. Verwende bitte die Kameraaufnahme, um den Code zu erfassen.
              </p>
              {onFallbackCapture && (
                <button
                  type="button"
                  onClick={onFallbackCapture}
                  className="px-4 py-2 rounded-xl bg-sky-600 text-white font-semibold hover:bg-sky-500 disabled:opacity-60"
                  disabled={fallbackBusy}
                >
                  {fallbackBusy ? 'Bild wird ausgewertet …' : 'Foto aufnehmen'}
                </button>
              )}
              {fallbackHint && <p className="text-xs text-slate-400">{fallbackHint}</p>}
            </div>
          )}
          {error && <p className="text-rose-300 text-sm">{error}</p>}
          {isSupported && (
            <p className="text-xs text-slate-400">
              {isScanning ? 'Scanner aktiv … bitte Code zentrieren.' : 'Scanner wird gestartet …'}
            </p>
          )}
        </div>
      </div>
    </div>
  );
};


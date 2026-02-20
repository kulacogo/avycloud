import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useBarcodeScanner } from '../../hooks/useBarcodeScanner';

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
  const [html5Status, setHtml5Status] = useState<'idle' | 'starting' | 'active' | 'error'>('idle');
  const [html5Error, setHtml5Error] = useState<string | null>(null);
  const html5InstanceRef = useRef<any>(null);
  const [html5Id] = useState(() => `html5qr-${Math.random().toString(36).slice(2, 10)}`);

  useEffect(() => {
    if (open) {
      if (isSupported) {
        startScanning({ onDetected }).catch(() => {});
      } else {
        startHtml5Scanner();
      }
    } else {
      stopScanning();
      stopHtml5Scanner();
    }
    return () => {
      stopScanning();
      stopHtml5Scanner();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, onDetected, isSupported, startScanning, stopScanning]);

  const stopHtml5Scanner = useCallback(async () => {
    if (!html5InstanceRef.current) return;
    try {
      await html5InstanceRef.current.stop();
      await html5InstanceRef.current.clear();
    } catch (err) {
      console.warn('html5-qrcode stop failed', err);
    } finally {
      html5InstanceRef.current = null;
      setHtml5Status('idle');
    }
  }, []);

  const startHtml5Scanner = useCallback(async () => {
    if (typeof window === 'undefined' || isSupported) return;
    if (html5InstanceRef.current) {
      setHtml5Status('active');
      return;
    }
    setHtml5Status('starting');
    setHtml5Error(null);
    try {
      const { Html5Qrcode, Html5QrcodeSupportedFormats } = await import('html5-qrcode');
      const instance = new Html5Qrcode(html5Id, {
        formatsToSupport: [
          Html5QrcodeSupportedFormats.QR_CODE,
          Html5QrcodeSupportedFormats.AZTEC,
          Html5QrcodeSupportedFormats.DATA_MATRIX,
          Html5QrcodeSupportedFormats.CODE_128,
          Html5QrcodeSupportedFormats.CODE_39,
          Html5QrcodeSupportedFormats.EAN_13,
          Html5QrcodeSupportedFormats.UPC_A,
        ],
      });
      html5InstanceRef.current = instance;
      await instance.start(
        { facingMode: 'environment' },
        {
          fps: 10,
          qrbox: { width: 240, height: 240 },
        },
        (decodedText: string) => {
          if (decodedText) {
            onDetected(decodedText);
            stopHtml5Scanner();
            onClose();
          }
        },
        () => {
          // ignore decode errors
        }
      );
      setHtml5Status('active');
    } catch (err: any) {
      console.error('html5-qrcode failed', err);
      setHtml5Status('error');
      setHtml5Error(err?.message || 'Kamera konnte nicht gestartet werden.');
    }
  }, [html5Id, isSupported, onClose, onDetected, stopHtml5Scanner]);

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center px-4">
      <div className="bg-[var(--surface)] rounded-xl shadow-lg border border-[var(--border)] w-full max-w-lg">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-[var(--border)]">
          <h3 className="text-sm font-semibold text-[var(--text-primary)] tracking-[-0.01em]">
            {title}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] text-xs font-semibold px-3 py-1.5 border border-[var(--border)] rounded-lg transition-colors duration-150 hover:border-[var(--border-hover)]"
          >
            Schließen
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4 text-center">
          {isSupported ? (
            <div className="relative bg-black rounded-lg overflow-hidden min-h-[240px]">
              <video ref={videoRef} className="w-full h-full object-cover" muted playsInline />
              <div className="absolute inset-0 border-2 border-[var(--avy-purple)]/60 rounded-lg pointer-events-none" />
            </div>
          ) : (
            <div className="space-y-4">
              <div className="relative bg-[var(--bg)] rounded-lg overflow-hidden min-h-[260px] flex items-center justify-center">
                <div id={html5Id} className="w-full h-full" />
                {html5Status === 'starting' && (
                  <div className="absolute inset-0 flex items-center justify-center text-[var(--text-secondary)] text-sm bg-[var(--bg)]/80">
                    Kamera wird initialisiert ...
                  </div>
                )}
                {html5Status === 'error' && (
                  <div className="absolute inset-0 flex items-center justify-center text-[var(--error)] text-sm bg-[var(--bg)]/80 px-4 text-center">
                    {html5Error || 'Scanner nicht verfügbar.'}
                  </div>
                )}
              </div>
              <p className="text-xs text-[var(--text-tertiary)]">
                {html5Status === 'active'
                  ? 'Richte den Code auf den Rahmen aus, er wird automatisch übernommen.'
                  : 'Falls der Live-Scanner nicht startet, kannst du alternativ ein Foto aufnehmen.'}
              </p>
              {onFallbackCapture && (
                <button
                  type="button"
                  onClick={onFallbackCapture}
                  className="px-4 py-2 rounded-lg bg-[var(--avy-purple)] text-white font-semibold hover:bg-[var(--avy-purple-hover)] disabled:opacity-60 transition-colors duration-150"
                  disabled={fallbackBusy}
                >
                  {fallbackBusy ? 'Bild wird ausgewertet ...' : 'Foto aufnehmen'}
                </button>
              )}
              {fallbackHint && (
                <p className="text-xs text-[var(--text-tertiary)]">{fallbackHint}</p>
              )}
            </div>
          )}
          {error && <p className="text-[var(--error)] text-sm">{error}</p>}
          {isSupported && (
            <p className="text-xs text-[var(--text-tertiary)]">
              {isScanning ? 'Scanner aktiv ... bitte Code zentrieren.' : 'Scanner wird gestartet ...'}
            </p>
          )}
        </div>
      </div>
    </div>
  );
};

import { useCallback, useEffect, useRef, useState } from 'react';

interface UseBarcodeScannerOptions {
  formats?: string[];
  onDetected?: (value: string) => void;
}

export const useBarcodeScanner = (defaultOptions?: UseBarcodeScannerOptions) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const detectorRef = useRef<BarcodeDetector | null>(null);
  const onDetectedRef = useRef<((value: string) => void) | undefined>(defaultOptions?.onDetected);

  const [isSupported, setIsSupported] = useState<boolean>(() => typeof BarcodeDetector !== 'undefined');
  const [isScanning, setIsScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    onDetectedRef.current = defaultOptions?.onDetected;
  }, [defaultOptions?.onDetected]);

  const stopScanning = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setIsScanning(false);
  }, []);

  useEffect(() => () => stopScanning(), [stopScanning]);

  const scanFrame = useCallback(async () => {
    if (!detectorRef.current || !videoRef.current) {
      rafRef.current = requestAnimationFrame(scanFrame);
      return;
    }
    try {
      const detections = await detectorRef.current.detect(videoRef.current);
      if (detections?.length) {
        const value = detections[0].rawValue?.trim();
        if (value) {
          onDetectedRef.current?.(value);
          stopScanning();
          return;
        }
      }
    } catch (err) {
      console.warn('Barcode detection failed:', err);
    }
    rafRef.current = requestAnimationFrame(scanFrame);
  }, [stopScanning]);

  const startScanning = useCallback(
    async (options?: UseBarcodeScannerOptions) => {
      const mergedOptions = {
        formats: defaultOptions?.formats || ['qr_code', 'ean_13', 'code_128', 'code_39', 'upc_a', 'upc_e'],
        ...options,
      };
      onDetectedRef.current = mergedOptions.onDetected || defaultOptions?.onDetected;

      if (typeof BarcodeDetector === 'undefined') {
        setIsSupported(false);
        setError('BarcodeDetector wird von diesem Gerät nicht unterstützt.');
        return false;
      }
      try {
        detectorRef.current = new BarcodeDetector({ formats: mergedOptions.formats });
      } catch (err) {
        console.warn('BarcodeDetector init failed:', err);
        setIsSupported(false);
        setError('BarcodeDetector ist nicht verfügbar.');
        return false;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        setError(null);
        setIsScanning(true);
        rafRef.current = requestAnimationFrame(scanFrame);
        return true;
      } catch (err: any) {
        console.error('Camera access failed:', err);
        setError(err?.message || 'Kamera konnte nicht gestartet werden.');
        stopScanning();
        return false;
      }
    },
    [defaultOptions?.formats, defaultOptions?.onDetected, scanFrame, stopScanning]
  );

  return {
    videoRef,
    isSupported,
    isScanning,
    error,
    startScanning,
    stopScanning,
  };
};
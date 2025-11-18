/// <reference types="vite/client" />

declare module '*.png' {
  const src: string;
  export default src;
}

declare module '*.jpg' {
  const src: string;
  export default src;
}

declare module '*.jpeg' {
  const src: string;
  export default src;
}

declare module '*.svg' {
  const src: string;
  export default src;
}

interface BarcodeDetectorOptions {
  formats?: string[];
}

interface BarcodeDetection {
  rawValue: string;
  format: string;
}

declare class BarcodeDetector {
  constructor(options?: BarcodeDetectorOptions);
  detect(source: CanvasImageSource | ImageBitmap | ImageData | HTMLVideoElement | HTMLImageElement | HTMLCanvasElement): Promise<BarcodeDetection[]>;
  static getSupportedFormats(): Promise<string[]>;
}

declare global {
  interface ImportMetaEnv {
    readonly VITE_BACKEND_URL?: string;
    readonly VITE_USE_PRODUCTION_BACKEND?: string;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}


// Client-side image compression for upload-bound flows.
//
// Why this matters: raw camera/iPhone photos are typically 4-12 MB at 4032×3024.
// 5 of them = 25-60 MB, which (a) blows past Cloud Run's 32 MB request body
// limit, (b) takes 20-60s to upload on mobile, (c) makes Gemini Vision
// disproportionately slower because the inline data has to be re-encoded on
// every transport hop. Compressing to 1600 px / JPEG ~78% keeps the visual
// signal Gemini needs (object identity, OCR-able labels, brand visibility) and
// drops total payload by 95%+.
//
// Used by:
//   - components/capture/StepGrouping.tsx  (calls with maxDim=1024, quality=0.6 — grouping doesn't need detail)
//   - components/capture/StepAnalysis.tsx  (calls with maxDim=1600, quality=0.78 — identify needs slightly more detail)
//
// Browser-only (uses HTMLImageElement + Canvas). Falls back to original File
// if decoding fails (HEIC, corrupted upload, etc.).

export interface CompressOptions {
  /** Longest edge after resize. Default 1600. */
  maxDim?: number;
  /** JPEG quality 0..1. Default 0.78. */
  quality?: number;
  /**
   * Skip compression entirely if the file is already small AND its longest
   * edge is below maxDim. Default 200_000 bytes.
   */
  skipIfSmallerThanBytes?: number;
}

const DEFAULT_OPTS: Required<CompressOptions> = {
  maxDim: 1600,
  quality: 0.78,
  skipIfSmallerThanBytes: 200_000,
};

/**
 * Compress a single image File to a JPEG capped at maxDim on its longest edge.
 *
 * Resolves with the original File (no rejection) on any decoding failure so
 * callers can use a simple `Promise.all(...)` without per-file try/catch.
 */
export async function compressImageForUpload(
  file: File,
  options?: CompressOptions
): Promise<File> {
  const opts = { ...DEFAULT_OPTS, ...(options || {}) };
  if (typeof window === "undefined" || !file?.type?.startsWith("image/")) {
    return file;
  }

  return new Promise<File>((resolve) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);

    const cleanup = () => {
      try {
        URL.revokeObjectURL(objectUrl);
      } catch {
        // already revoked
      }
    };

    img.onload = () => {
      let { width, height } = img;
      const longest = Math.max(width, height);

      // Fast-path: already small enough.
      if (longest <= opts.maxDim && file.size < opts.skipIfSmallerThanBytes) {
        cleanup();
        resolve(file);
        return;
      }

      const scale = Math.min(opts.maxDim / longest, 1);
      width = Math.max(1, Math.round(width * scale));
      height = Math.max(1, Math.round(height * scale));

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        cleanup();
        resolve(file);
        return;
      }
      try {
        ctx.drawImage(img, 0, 0, width, height);
      } catch {
        cleanup();
        resolve(file);
        return;
      }

      canvas.toBlob(
        (blob) => {
          cleanup();
          if (!blob) {
            resolve(file);
            return;
          }
          // Only swap if we actually saved bytes — otherwise keep the
          // original (better quality, no extra encoder pass).
          if (blob.size >= file.size) {
            resolve(file);
            return;
          }
          const renamed = file.name.replace(/\.(heic|heif|png|webp)$/i, ".jpg");
          resolve(new File([blob], renamed, { type: "image/jpeg" }));
        },
        "image/jpeg",
        opts.quality
      );
    };
    img.onerror = () => {
      cleanup();
      resolve(file);
    };
    img.src = objectUrl;
  });
}

/**
 * Compress many files in parallel and return a small report so callers can
 * log/show how much they saved.
 */
export async function compressImagesForUpload(
  files: File[],
  options?: CompressOptions
): Promise<{ files: File[]; bytesBefore: number; bytesAfter: number }> {
  const bytesBefore = files.reduce((sum, f) => sum + (f?.size || 0), 0);
  const compressed = await Promise.all(
    files.map((f) => compressImageForUpload(f, options))
  );
  const bytesAfter = compressed.reduce((sum, f) => sum + (f?.size || 0), 0);
  return { files: compressed, bytesBefore, bytesAfter };
}

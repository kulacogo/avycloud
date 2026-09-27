import { getBackendUrl } from "../api/client";

export async function fetchPhotoBlob(src: string, signal?: AbortSignal): Promise<Blob> {
  if (!/^(https?:|data:image\/|blob:)/i.test(src)) throw new Error("Dieses Bildformat kann nicht geladen werden.");
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(abort, 30000);
  try {
    let response: Response | undefined;
    try { response = await fetch(src, { mode: "cors", signal: controller.signal }); } catch (error) {
      if (controller.signal.aborted || !/^https?:/i.test(src)) throw error;
    }
    if (!response?.ok && /^https?:/i.test(src)) {
      const url = new URL(`${getBackendUrl()}/api/image-proxy`);
      url.searchParams.set("url", src);
      response = await fetch(url, { signal: controller.signal });
    }
    if (!response?.ok) throw new Error("Das Original ist nicht erreichbar. Bitte erneut versuchen.");
    const blob = await response.blob();
    if (!blob.size || blob.size > 20 * 1024 * 1024) throw new Error("Das Bild muss kleiner als 20 MB sein.");
    if (blob.type && !blob.type.startsWith("image/")) throw new Error("Die Adresse liefert kein Bild.");
    return blob;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

export async function decodePhoto(blob: Blob): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void }> {
  if (typeof createImageBitmap === "function") {
    let source: ImageBitmap | undefined;
    try { source = await createImageBitmap(blob); } catch { /* Some browser decoders support SVG/AVIF only via an image element. */ }
    if (source) {
      if (source.width * source.height > 64_000_000) { source.close(); throw new Error("Dieses Foto ist zu groß (maximal 64 Megapixel)."); }
      return { source, width: source.width, height: source.height, close: () => source.close() };
    }
  }
  const url = URL.createObjectURL(blob);
  const source = new Image();
  try {
    await new Promise<void>((resolve, reject) => { source.onload = () => resolve(); source.onerror = () => reject(new Error("Das Foto konnte nicht geöffnet werden.")); source.src = url; });
    if (source.naturalWidth * source.naturalHeight > 64_000_000) throw new Error("Dieses Foto ist zu groß (maximal 64 Megapixel).");
    return { source, width: source.naturalWidth, height: source.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch (error) { URL.revokeObjectURL(url); throw error; }
}

export const photoBlobToDataUrl = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(new Error("Das Bild konnte nicht vorbereitet werden."));
  reader.readAsDataURL(blob);
});

export const encodePhoto = (canvas: HTMLCanvasElement, transparent: boolean) => new Promise<Blob>((resolve, reject) => {
  canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Das Bild konnte nicht exportiert werden.")), transparent ? "image/png" : "image/jpeg", 0.95);
});

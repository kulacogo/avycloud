import { preload, segmentForeground } from "@imgly/background-removal";
import type { PhotoBackgroundOrientation } from "./photoBackground";

type Request = { id: number; blob: Blob; quality: "fast" | "best"; orientation?: PhotoBackgroundOrientation; forceCpu?: boolean };
type Model = "isnet" | "isnet_fp16" | "isnet_quint8";
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<Request>) => void) | null;
  postMessage: (message: unknown) => void;
};
let currentId = 0;
let busy = false;
const resources = new Map<string, { current: number; total: number }>();

const progress = (message: string, percent?: number) =>
  scope.postMessage({ id: currentId, type: "progress", progress: { message, percent } });

// Stable callback: IMG.LY memoizes the session by JSON.stringify(config), so a
// callback that captures a request would keep sending progress to the first photo.
const modelProgress = (key: string, current: number, total: number) => {
  if (key.startsWith("compute:")) {
    progress(key === "compute:inference" ? "Produktkonturen erkennen …" : "Freistellung vorbereiten …", 65 + Math.round((current / Math.max(total, 1)) * 28));
    return;
  }
  resources.set(key, { current, total });
  const entries = [...resources.values()];
  const loaded = entries.reduce((sum, entry) => sum + entry.current, 0);
  const size = entries.reduce((sum, entry) => sum + entry.total, 0);
  progress("Freisteller wird geladen · beim ersten Mal etwas länger …", size > 0 ? Math.round((loaded / size) * 60) : undefined);
};

function configuredModel(quality: Request["quality"]): Model {
  const pin = (import.meta.env?.VITE_BG_REMOVAL_MODEL as string | undefined)?.trim();
  const aliases: Record<string, Model> = { large: "isnet", medium: "isnet_fp16", small: "isnet_quint8", isnet: "isnet", isnet_fp16: "isnet_fp16", isnet_quint8: "isnet_quint8" };
  return (pin && aliases[pin]) || (quality === "best" ? "isnet" : "isnet_fp16");
}

async function supportsGpu(): Promise<boolean> {
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter: () => Promise<unknown> } }).gpu;
    return Boolean(gpu && await gpu.requestAdapter());
  } catch { return false; }
}

async function processPhoto(request: Request): Promise<void> {
  let original: ImageBitmap | undefined;
  let mask: ImageBitmap | undefined;
  try {
    if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap === "undefined") {
      throw new Error("Dieser Browser unterstützt das Freistellen nicht. Bitte Chrome, Edge oder Safari aktualisieren.");
    }
    original = await createImageBitmap(request.blob);
    const { width, height } = original;
    if (!width || !height || width * height > 36_000_000 || Math.max(width, height) > 12_000) {
      throw new Error("Dieses Foto ist zu groß zum Freistellen. Bitte eine Version mit höchstens 36 Megapixeln verwenden.");
    }
    const factor = Math.min(1, 2048 / Math.max(width, height));
    const orientation = request.orientation || { rotation: 0, flipX: false, flipY: false };
    const quarterTurn = orientation.rotation === 90 || orientation.rotation === 270;
    const scaledWidth = Math.max(1, Math.round(width * factor));
    const scaledHeight = Math.max(1, Math.round(height * factor));
    const canvas = new OffscreenCanvas(quarterTurn ? scaledHeight : scaledWidth, quarterTurn ? scaledWidth : scaledHeight);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Die Bildverarbeitung ist in diesem Browser nicht verfügbar.");
    // Segment the same primary orientation the operator sees. IS-Net is not
    // rotation invariant: a sideways product can lose complete lids and labels.
    // Match renderPhoto's transform order: rotation × source-axis flips.
    context.translate(canvas.width / 2, canvas.height / 2);
    context.rotate(orientation.rotation * Math.PI / 180);
    context.scale(orientation.flipX ? -1 : 1, orientation.flipY ? -1 : 1);
    context.drawImage(original, -scaledWidth / 2, -scaledHeight / 2, scaledWidth, scaledHeight);
    const inferenceImage = await canvas.convertToBlob({ type: "image/png" });
    const device: "gpu" | "cpu" = !request.forceCpu && await supportsGpu() ? "gpu" : "cpu";
    let alphaMask: Blob;
    try {
      const configuration = {
        model: configuredModel(request.quality), device,
        // We are already in a dedicated worker. IMG.LY's own proxy is unsuitable
        // for CPU and WebGPU in 1.7.0; never move inference onto the UI thread.
        proxyToWorker: false, rescale: true, progress: modelProgress,
        output: { format: "image/png" as const, quality: 1 },
      };
      await preload(configuration);
      progress("Produktkonturen erkennen …", 72);
      // segmentForeground returns white RGB and predicted alpha. It REPLACES
      // source alpha: the renderer must apply original transparency only once.
      alphaMask = await segmentForeground(inferenceImage, configuration);
    } catch (error) {
      if (device === "gpu") {
        scope.postMessage({ id: request.id, type: "retry-cpu" });
        return;
      }
      throw new Error("Der Freisteller konnte nicht geladen oder ausgeführt werden. Bitte die Internetverbindung prüfen und erneut versuchen.");
    }
    progress("Freistellung vorbereiten …", 96);
    mask = await createImageBitmap(alphaMask);
    // This is a segmentation mask, never a product cutout. Multiplying source
    // alpha here would square transparent edges when the renderer applies it.
    const outputFactor = Math.min(1, 4096 / Math.max(width, height));
    canvas.width = Math.max(1, Math.round(width * outputFactor));
    canvas.height = Math.max(1, Math.round(height * outputFactor));
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.globalCompositeOperation = "destination-in";
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    // Mask storage/brush coordinates always refer to the unrotated original.
    // Inverse(rotation × flips) = flips × inverse(rotation).
    context.translate(canvas.width / 2, canvas.height / 2);
    context.scale(orientation.flipX ? -1 : 1, orientation.flipY ? -1 : 1);
    context.rotate(-orientation.rotation * Math.PI / 180);
    const orientedWidth = quarterTurn ? canvas.height : canvas.width;
    const orientedHeight = quarterTurn ? canvas.width : canvas.height;
    context.drawImage(mask, -orientedWidth / 2, -orientedHeight / 2, orientedWidth, orientedHeight);
    const output = await canvas.convertToBlob({ type: "image/png" });
    scope.postMessage({ id: request.id, type: "result", blob: output });
    canvas.width = 1;
    canvas.height = 1;
  } catch (error) {
    scope.postMessage({ id: request.id, type: "error", message: error instanceof Error ? error.message : "Das Foto konnte nicht freigestellt werden." });
  } finally {
    original?.close();
    mask?.close();
  }
}

scope.onmessage = async (event) => {
  if (busy) {
    scope.postMessage({ id: event.data.id, type: "error", message: "Ein anderes Bild wird noch freigestellt." });
    return;
  }
  busy = true;
  currentId = event.data.id;
  resources.clear();
  try { await processPhoto(event.data); } finally { busy = false; }
};

import { adjustPhotoPixels, normalizeRecipe, sharpenPhotoPixels } from "./photoEditor.ts";
import type { PhotoRecipe } from "./photoEditor.ts";

const MAX_EXPORT_EDGE = 4096;

function layout(width: number, height: number, input: Partial<PhotoRecipe>, maxEdge: number) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error("Das Bild hat keine gültige Größe.");
  const recipe = normalizeRecipe(input);
  const cropWidth = Math.max(1, width * recipe.crop.width);
  const cropHeight = Math.max(1, height * recipe.crop.height);
  const radians = (recipe.rotation + recipe.straighten) * Math.PI / 180;
  const cos = Math.abs(Math.cos(radians)), sin = Math.abs(Math.sin(radians));
  const rotatedWidth = cropWidth * cos + cropHeight * sin;
  const rotatedHeight = cropWidth * sin + cropHeight * cos;
  const frameRatio = recipe.frame === "square" ? 1 : recipe.frame === "portrait" ? 4 / 5 : recipe.frame === "landscape" ? 4 / 3 : rotatedWidth / rotatedHeight;
  let outerWidth = rotatedWidth / (1 - 2 * recipe.padding);
  let outerHeight = rotatedHeight / (1 - 2 * recipe.padding);
  if (outerWidth / outerHeight < frameRatio) outerWidth = outerHeight * frameRatio;
  else outerHeight = outerWidth / frameRatio;
  const limit = Number.isFinite(maxEdge) ? Math.max(1, Math.floor(Math.min(MAX_EXPORT_EDGE, maxEdge))) : MAX_EXPORT_EDGE;
  const scale = Math.min(1, limit / Math.max(outerWidth, outerHeight));
  // Rounding removes trig epsilon at quarter turns without dropping pixels at arbitrary angles.
  const rounded = (n: number) => Math.max(1, Math.ceil(n - 1e-7));
  return { recipe, radians, cropWidth, cropHeight, scale,
    width: Math.min(limit, rounded(outerWidth * scale)), height: Math.min(limit, rounded(outerHeight * scale)),
    rotatedWidth: rounded(rotatedWidth * scale), rotatedHeight: rounded(rotatedHeight * scale) };
}

export function getPhotoDimensions(width: number, height: number, recipe: Partial<PhotoRecipe>, maxEdge = MAX_EXPORT_EDGE): { width: number; height: number } {
  const result = layout(width, height, recipe, maxEdge);
  return { width: result.width, height: result.height };
}

function canvas(width: number, height: number): HTMLCanvasElement {
  const result = document.createElement("canvas");
  result.width = Math.max(1, Math.round(width)); result.height = Math.max(1, Math.round(height));
  return result;
}

function context(element: HTMLCanvasElement, read = false): CanvasRenderingContext2D {
  const ctx = element.getContext("2d", read ? { willReadFrequently: true } : undefined);
  if (!ctx) throw new Error("Die Bildbearbeitung wird von diesem Browser nicht unterstützt.");
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
  return ctx;
}

function dimensions(source: CanvasImageSource, fallbackWidth: number, fallbackHeight: number) {
  const value = source as { naturalWidth?: number; naturalHeight?: number; videoWidth?: number; videoHeight?: number; width?: number; height?: number };
  return { width: value.naturalWidth || value.videoWidth || value.width || fallbackWidth,
    height: value.naturalHeight || value.videoHeight || value.height || fallbackHeight };
}

/** The same renderer drives bounded previews and the one-time export from original pixels. */
export function renderPhoto(
  source: CanvasImageSource,
  width: number,
  height: number,
  input: Partial<PhotoRecipe>,
  mask: CanvasImageSource | null = null,
  maxEdge = MAX_EXPORT_EDGE,
): HTMLCanvasElement {
  const geometry = layout(width, height, input, maxEdge);
  const { recipe, cropWidth, cropHeight, scale } = geometry;
  const cropped = canvas(cropWidth * scale, cropHeight * scale);
  const croppedCtx = context(cropped, true);
  const sx = recipe.crop.x * width, sy = recipe.crop.y * height;
  croppedCtx.drawImage(source, sx, sy, cropWidth, cropHeight, 0, 0, cropped.width, cropped.height);

  const pixels = croppedCtx.getImageData(0, 0, cropped.width, cropped.height);
  adjustPhotoPixels(pixels.data, recipe);
  sharpenPhotoPixels(pixels.data, cropped.width, cropped.height, recipe.sharpness);
  croppedCtx.putImageData(pixels, 0, 0);

  const useMask = recipe.background !== "original" && mask !== null;
  if (useMask) {
    const alpha = canvas(cropped.width, cropped.height);
    const alphaCtx = context(alpha);
    const maskSize = dimensions(mask!, width, height);
    alphaCtx.drawImage(mask!, recipe.crop.x * maskSize.width, recipe.crop.y * maskSize.height,
      recipe.crop.width * maskSize.width, recipe.crop.height * maskSize.height, 0, 0, alpha.width, alpha.height);
    // Brush restoration only restores original pixels, never synthesizes missing product detail.
    const scaleX = cropped.width / cropWidth, scaleY = cropped.height / cropHeight;
    alphaCtx.save();
    alphaCtx.scale(scaleX, scaleY);
    alphaCtx.translate(-sx, -sy);
    alphaCtx.lineCap = "round"; alphaCtx.lineJoin = "round";
    alphaCtx.fillStyle = "#fff"; alphaCtx.strokeStyle = "#fff";
    for (const stroke of recipe.maskStrokes) {
      alphaCtx.globalCompositeOperation = stroke.mode === "erase" ? "destination-out" : "source-over";
      const radius = stroke.radius * Math.min(width, height);
      alphaCtx.lineWidth = radius * 2;
      const first = stroke.points[0];
      if (!first) continue;
      alphaCtx.beginPath(); alphaCtx.arc(first.x * width, first.y * height, radius, 0, Math.PI * 2); alphaCtx.fill();
      if (stroke.points.length > 1) {
        alphaCtx.beginPath(); alphaCtx.moveTo(first.x * width, first.y * height);
        for (const point of stroke.points.slice(1)) alphaCtx.lineTo(point.x * width, point.y * height);
        alphaCtx.stroke();
      }
    }
    alphaCtx.restore();
    croppedCtx.globalCompositeOperation = "destination-in";
    croppedCtx.drawImage(alpha, 0, 0);
    croppedCtx.globalCompositeOperation = "source-over";
    alpha.width = 0; alpha.height = 0;
  }

  const rotated = canvas(geometry.rotatedWidth, geometry.rotatedHeight);
  const rotatedCtx = context(rotated);
  rotatedCtx.translate(rotated.width / 2, rotated.height / 2);
  rotatedCtx.rotate(geometry.radians);
  rotatedCtx.scale(recipe.flipX ? -1 : 1, recipe.flipY ? -1 : 1);
  rotatedCtx.drawImage(cropped, -cropped.width / 2, -cropped.height / 2);

  const output = canvas(geometry.width, geometry.height);
  const outputCtx = context(output);
  const opaque = recipe.background === "white" || recipe.background === "studio";
  if (opaque) {
    if (recipe.background === "studio") {
      const gradient = outputCtx.createLinearGradient(0, 0, 0, output.height);
      gradient.addColorStop(0, "#ffffff"); gradient.addColorStop(0.6, "#fafbfc"); gradient.addColorStop(1, "#eceff2");
      outputCtx.fillStyle = gradient;
    } else outputCtx.fillStyle = "#ffffff";
    outputCtx.fillRect(0, 0, output.width, output.height);
  }
  const left = (output.width - rotated.width) / 2, top = (output.height - rotated.height) / 2;
  if (useMask && opaque && recipe.shadow > 0) {
    outputCtx.save();
    outputCtx.shadowColor = `rgba(0,0,0,${recipe.shadow / 100 * 0.32})`;
    outputCtx.shadowBlur = Math.max(1, Math.min(output.width, output.height) * 0.025);
    // Place the source outside the canvas; draw only its shadow. Drawing the source
    // twice would darken translucent product edges when the final image is overlaid.
    outputCtx.shadowOffsetX = output.width * 2;
    outputCtx.shadowOffsetY = Math.max(1, Math.min(output.width, output.height) * 0.012);
    outputCtx.drawImage(rotated, left - output.width * 2, top);
    outputCtx.restore();
  }
  outputCtx.drawImage(rotated, left, top);
  cropped.width = 0; cropped.height = 0; rotated.width = 0; rotated.height = 0;
  return output;
}

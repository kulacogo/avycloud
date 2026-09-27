/** Versioned, non-destructive photo settings. Coordinates always refer to the original. */
export interface PhotoMaskStroke {
  mode: "erase" | "restore";
  radius: number;
  points: Array<{ x: number; y: number }>;
}

export interface PhotoRecipe {
  version: 1;
  exposure: number;
  shadows: number;
  highlights: number;
  contrast: number;
  temperature: number;
  tint: number;
  saturation: number;
  sharpness: number;
  rotation: 0 | 90 | 180 | 270;
  straighten: number;
  flipX: boolean;
  flipY: boolean;
  crop: { x: number; y: number; width: number; height: number };
  background: "original" | "transparent" | "white" | "studio";
  frame: "original" | "square" | "portrait" | "landscape";
  padding: number;
  shadow: number;
  maskStrokes: PhotoMaskStroke[];
}

const clamp = (v: number, low = 0, high = 1) => Math.max(low, Math.min(high, v));
const finite = (v: unknown, fallback = 0) => typeof v === "number" && Number.isFinite(v) ? v : fallback;

export function defaultRecipe(): PhotoRecipe {
  return {
    version: 1, exposure: 0, shadows: 0, highlights: 0, contrast: 0, temperature: 0,
    tint: 0, saturation: 0, sharpness: 0, rotation: 0, straighten: 0, flipX: false,
    flipY: false, crop: { x: 0, y: 0, width: 1, height: 1 }, background: "original",
    frame: "original", padding: 0, shadow: 0, maskStrokes: [],
  };
}

export function normalizeRecipe(input?: Partial<PhotoRecipe> | null): PhotoRecipe {
  const base = defaultRecipe();
  if (!input || typeof input !== "object") return base;
  const crop = input.crop || base.crop;
  const x = clamp(finite(crop.x), 0, 0.999);
  const y = clamp(finite(crop.y), 0, 0.999);
  const rotation = ((Math.round(finite(input.rotation) / 90) * 90) % 360 + 360) % 360;
  const maskStrokes: PhotoMaskStroke[] = [];
  if (Array.isArray(input.maskStrokes)) {
    for (const stroke of input.maskStrokes.slice(0, 30)) {
      if (!stroke || !["erase", "restore"].includes(stroke.mode) || !Array.isArray(stroke.points)) continue;
      const points = stroke.points.filter(p => p && Number.isFinite(p.x) && Number.isFinite(p.y))
        .slice(0, 60).map(p => ({ x: clamp(p.x), y: clamp(p.y) }));
      if (points.length) maskStrokes.push({ mode: stroke.mode, radius: clamp(finite(stroke.radius, 0.025), 0.001, 0.25), points });
    }
  }
  return {
    version: 1,
    exposure: clamp(finite(input.exposure), -2, 2),
    shadows: clamp(finite(input.shadows), -100, 100),
    highlights: clamp(finite(input.highlights), -100, 100),
    contrast: clamp(finite(input.contrast), -100, 100),
    temperature: clamp(finite(input.temperature), -100, 100),
    tint: clamp(finite(input.tint), -100, 100),
    saturation: clamp(finite(input.saturation), -100, 100),
    sharpness: clamp(finite(input.sharpness), 0, 100),
    rotation: rotation as PhotoRecipe["rotation"],
    straighten: clamp(finite(input.straighten), -15, 15),
    flipX: input.flipX === true, flipY: input.flipY === true,
    crop: { x, y, width: clamp(finite(crop.width, 1), 0.001, 1 - x), height: clamp(finite(crop.height, 1), 0.001, 1 - y) },
    background: ["original", "transparent", "white", "studio"].includes(String(input.background)) ? input.background! : "original",
    frame: ["original", "square", "portrait", "landscape"].includes(String(input.frame)) ? input.frame! : "original",
    padding: clamp(finite(input.padding), 0, 0.25), shadow: clamp(finite(input.shadow), 0, 100), maskStrokes,
  };
}

export function recipesEqual(a?: Partial<PhotoRecipe> | null, b?: Partial<PhotoRecipe> | null): boolean {
  return JSON.stringify(normalizeRecipe(a)) === JSON.stringify(normalizeRecipe(b));
}

const SRGB_TO_LINEAR = Float64Array.from({ length: 256 }, (_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
});
const LINEAR_TO_SRGB = Uint8ClampedArray.from({ length: 65536 }, (_, i) => {
  const c = i / 65535;
  return Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055));
});
const encode = (v: number) => LINEAR_TO_SRGB[Math.round(clamp(v) * 65535)];

/** Inverse of the renderer's white-balance gains. Extreme casts remain bounded;
 * a clipped or non-neutral sample cannot reconstruct an objectively correct colour. */
export function neutralPointRecipe(sample: { r: number; g: number; b: number }, existing?: Partial<PhotoRecipe>): PhotoRecipe {
  const recipe = normalizeRecipe(existing);
  if (![sample.r, sample.g, sample.b].every(v => Number.isFinite(v) && v > 0 && v < 255)) return recipe;
  const linear = (value: number) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const red = linear(sample.r), green = linear(sample.g), blue = linear(sample.b);
  return normalizeRecipe({ ...recipe,
    temperature: Math.log(blue / red) / 0.0044,
    tint: Math.log(green / Math.sqrt(red * blue)) / 0.0024,
  });
}

/** One shared luminance curve retains RGB ratios; no per-channel auto stretching. */
export function adjustPhotoPixels(data: Uint8ClampedArray, input: Partial<PhotoRecipe>): void {
  const r = normalizeRecipe(input);
  if (![r.exposure, r.shadows, r.highlights, r.contrast, r.temperature, r.tint, r.saturation].some(Boolean)) return;
  const exposure = Math.pow(2, r.exposure);
  const contrast = Math.pow(2, r.contrast / 100);
  const saturation = 1 + r.saturation / 100;
  const redGain = Math.exp(r.temperature * 0.0022 + r.tint * 0.0008);
  const greenGain = Math.exp(-r.tint * 0.0016);
  const blueGain = Math.exp(-r.temperature * 0.0022 + r.tint * 0.0008);
  const gainNorm = 0.2126 * redGain + 0.7152 * greenGain + 0.0722 * blueGain;
  // The shared curve is looked up per pixel; slider previews avoid millions of powers.
  const tone = new Float64Array(4097);
  for (let i = 1; i < tone.length; i++) {
    const luminance = i / 4096;
    let next = luminance * exposure;
    next += r.shadows / 100 * 0.18 * Math.pow(1 - luminance, 3) * (1 - Math.exp(-luminance * 12));
    next += r.highlights / 100 * 0.5 * luminance * luminance;
    next = Math.max(0, next);
    if (r.contrast) next = 0.18 * Math.pow(next / 0.18, contrast);
    tone[i] = next / luminance;
  }
  tone[0] = tone[1];
  for (let i = 0; i < data.length; i += 4) {
    if (!data[i + 3]) continue;
    let red = SRGB_TO_LINEAR[data[i]], green = SRGB_TO_LINEAR[data[i + 1]], blue = SRGB_TO_LINEAR[data[i + 2]];
    const sourcePeak = Math.max(red, green, blue);
    red *= redGain / gainNorm; green *= greenGain / gainNorm; blue *= blueGain / gainNorm;
    const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    const factor = tone[Math.round(clamp(luminance) * 4096)];
    red *= factor; green *= factor; blue *= factor;
    // Only compress newly brightened highlights; neutral settings never alter the original.
    const peak = Math.max(red, green, blue);
    const knee = Math.max(0.75, sourcePeak);
    if (peak > knee) {
      const headroom = 1 - knee;
      const delta = peak - knee;
      const mapped = headroom < 0.00001 ? 1 : knee + headroom * delta / (headroom + delta);
      const scale = mapped / peak;
      red *= scale; green *= scale; blue *= scale;
    }
    if (r.saturation) {
      const lum = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
      red = lum + (red - lum) * saturation;
      green = lum + (green - lum) * saturation;
      blue = lum + (blue - lum) * saturation;
    }
    data[i] = encode(red); data[i + 1] = encode(green); data[i + 2] = encode(blue);
  }
}

/** Restrained alpha-aware unsharp mask; transparent neighbours cannot create black halos. */
export function sharpenPhotoPixels(data: Uint8ClampedArray, width: number, height: number, amount: number): void {
  if (amount <= 0 || width < 3 || height < 3) return;
  const original = data.slice();
  const strength = clamp(amount / 100) * 0.8;
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const offset = (y * width + x) * 4;
    if (original[offset + 3] < 245) continue;
    let red = 0, green = 0, blue = 0, weight = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const index = ((y + dy) * width + x + dx) * 4;
      const w = (dx === 0 ? 2 : 1) * (dy === 0 ? 2 : 1) * original[index + 3] / 255;
      red += original[index] * w; green += original[index + 1] * w; blue += original[index + 2] * w; weight += w;
    }
    if (!weight) continue;
    const luminance = 0.2126 * original[offset] + 0.7152 * original[offset + 1] + 0.0722 * original[offset + 2];
    const blurred = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / weight;
    const detail = Math.abs(luminance - blurred) < 2 ? 0 : clamp((luminance - blurred) * strength, -18, 18);
    for (let c = 0; c < 3; c++) data[offset + c] = original[offset + c] + detail;
  }
}

type PixelSource = { data: ArrayLike<number>; width?: number; height?: number } | ArrayLike<number>;

/** Conservative exposure suggestion. Product colour cannot establish a neutral white balance. */
export function autoRecipe(source: PixelSource, existing?: Partial<PhotoRecipe>): PhotoRecipe {
  const recipe = normalizeRecipe(existing);
  const data = "data" in source ? source.data : source;
  const histogram = new Uint32Array(256);
  const step = Math.max(1, Math.floor(data.length / 4 / 60000)) * 4;
  let count = 0;
  for (let i = 0; i + 3 < data.length; i += step) {
    if (data[i + 3] < 128) continue;
    const lum = 0.2126 * SRGB_TO_LINEAR[clamp(data[i], 0, 255)] + 0.7152 * SRGB_TO_LINEAR[clamp(data[i + 1], 0, 255)] + 0.0722 * SRGB_TO_LINEAR[clamp(data[i + 2], 0, 255)];
    histogram[encode(lum)]++; count++;
  }
  if (!count) return recipe;
  const percentile = (fraction: number) => {
    let sum = 0;
    for (let i = 0; i < 256; i++) { sum += histogram[i]; if (sum >= count * fraction) return i; }
    return 255;
  };
  const low = percentile(0.05), median = percentile(0.5), high = percentile(0.95);
  // A uniformly black/white item is not evidence of incorrect exposure.
  if (high - low < 28) return recipe;
  const linearHigh = SRGB_TO_LINEAR[high];
  const suggested = high < 205 && median < 150 && linearHigh > 0
    ? clamp(Math.log2(SRGB_TO_LINEAR[215] / linearHigh), 0, 0.7) : 0;
  return normalizeRecipe({ ...recipe, exposure: Math.round(suggested * 100) / 100,
    shadows: median < 95 && high > 180 ? 12 : 0, highlights: high > 245 ? -8 : 0,
    contrast: high - low < 120 ? 5 : 0 });
}

export function findAlphaBounds(image: { data: ArrayLike<number>; width: number; height: number }, threshold = 8): PhotoRecipe["crop"] | null {
  const { data, width, height } = image;
  if (width <= 0 || height <= 0) return null;
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (data[(y * width + x) * 4 + 3] <= threshold) continue;
    left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
  }
  return right < left ? null : { x: left / width, y: top / height, width: (right - left + 1) / width, height: (bottom - top + 1) / height };
}

/** Explicit user-selected repair only: enclosed print and genuine product openings
 * cannot be distinguished reliably by size. Never fill every hole automatically. */
export function restoreEnclosedMaskRegion(data: Uint8ClampedArray, width: number, height: number, xPixel: number, yPixel: number): number {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 ||
    width > 4096 || height > 4096 || data.length !== width * height * 4 ||
    !Number.isFinite(xPixel) || !Number.isFinite(yPixel)) return 0;
  const x = Math.floor(xPixel), y = Math.floor(yPixel);
  if (x < 0 || y < 0 || x >= width || y >= height) return 0;
  const seed = y * width + x;
  if (data[seed * 4 + 3] >= 200) return 0;
  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let read = 0, count = 1;
  queue[0] = seed; visited[seed] = 1;
  const visit = (next: number) => {
    if (visited[next] || data[next * 4 + 3] >= 200) return;
    visited[next] = 1; queue[count++] = next;
  };
  while (read < count) {
    const pixel = queue[read++], px = pixel % width, py = Math.floor(pixel / width);
    // No alpha has been touched yet, so reaching the exterior is a true no-op.
    if (px === 0 || py === 0 || px === width - 1 || py === height - 1) return 0;
    visit(pixel - 1); visit(pixel + 1); visit(pixel - width); visit(pixel + width);
    visit(pixel - width - 1); visit(pixel - width + 1); visit(pixel + width - 1); visit(pixel + width + 1);
  }
  for (let i = 0; i < count; i++) data[queue[i] * 4 + 3] = 255;
  return count;
}

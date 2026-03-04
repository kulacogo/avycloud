const sharp = require('sharp');

const BG_THRESHOLD = parseInt(process.env.BG_REMOVAL_THRESHOLD || '240', 10);
const EDGE_BLUR = parseFloat(process.env.BG_REMOVAL_EDGE_BLUR || '1.5');
const DEFAULT_WIDTH = 1024;
const DEFAULT_HEIGHT = 1024;

/**
 * Creates a studio gradient background image (PNG buffer).
 * Dark products → white gradient, light products → light gray gradient.
 */
async function createGradientBackground(width, height, style = 'white') {
  const topColor = style === 'gray'
    ? { r: 235, g: 235, b: 235 }
    : { r: 255, g: 255, b: 255 };
  const bottomColor = style === 'gray'
    ? { r: 210, g: 210, b: 210 }
    : { r: 240, g: 240, b: 240 };

  // Create a vertical gradient using raw pixel data
  const channels = 3;
  const data = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y++) {
    const ratio = y / (height - 1);
    const r = Math.round(topColor.r + (bottomColor.r - topColor.r) * ratio);
    const g = Math.round(topColor.g + (bottomColor.g - topColor.g) * ratio);
    const b = Math.round(topColor.b + (bottomColor.b - topColor.b) * ratio);
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * channels;
      data[idx] = r;
      data[idx + 1] = g;
      data[idx + 2] = b;
    }
  }

  return sharp(data, { raw: { width, height, channels } })
    .png()
    .toBuffer();
}

/**
 * Removes near-white/light background from a product image using threshold-based
 * alpha masking. Works well for product photos shot on white/neutral backgrounds.
 *
 * @param {Buffer} imageBuffer - Input image buffer
 * @param {Object} options
 * @param {number} options.threshold - Brightness threshold for background detection (0-255, default 240)
 * @param {number} options.edgeBlur - Blur radius for mask edges to avoid harsh cutouts
 * @returns {Promise<{buffer: Buffer, width: number, height: number, hasTransparency: boolean}>}
 */
async function removeBackground(imageBuffer, options = {}) {
  const threshold = options.threshold || BG_THRESHOLD;
  const edgeBlur = options.edgeBlur || EDGE_BLUR;

  const image = sharp(imageBuffer);
  const metadata = await image.metadata();
  const { width, height } = metadata;

  // If already has alpha, just return as-is
  if (metadata.channels === 4 && metadata.hasAlpha) {
    const buf = await image.png().toBuffer();
    return { buffer: buf, width, height, hasTransparency: true };
  }

  // Create grayscale version for mask generation
  const grayscale = await sharp(imageBuffer)
    .grayscale()
    .raw()
    .toBuffer();

  // Build alpha mask: white background → transparent, product → opaque
  const alphaData = Buffer.alloc(width * height);
  let transparentPixels = 0;

  for (let i = 0; i < grayscale.length; i++) {
    if (grayscale[i] >= threshold) {
      alphaData[i] = 0; // Background → transparent
      transparentPixels++;
    } else {
      alphaData[i] = 255; // Product → opaque
    }
  }

  const transparencyRatio = transparentPixels / (width * height);
  // If less than 5% or more than 95% would be removed, skip (probably not a white-bg image)
  if (transparencyRatio < 0.05 || transparencyRatio > 0.95) {
    const buf = await sharp(imageBuffer).png().toBuffer();
    return { buffer: buf, width, height, hasTransparency: false };
  }

  // Blur the alpha mask edges for smoother cutout
  const blurredAlpha = await sharp(alphaData, { raw: { width, height, channels: 1 } })
    .blur(edgeBlur)
    .raw()
    .toBuffer();

  // Extract RGB channels and combine with alpha
  const rgb = await sharp(imageBuffer)
    .removeAlpha()
    .raw()
    .toBuffer();

  const rgbaData = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgbaData[i * 4] = rgb[i * 3];
    rgbaData[i * 4 + 1] = rgb[i * 3 + 1];
    rgbaData[i * 4 + 2] = rgb[i * 3 + 2];
    rgbaData[i * 4 + 3] = blurredAlpha[i];
  }

  const resultBuffer = await sharp(rgbaData, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();

  return { buffer: resultBuffer, width, height, hasTransparency: true };
}

/**
 * Removes background and composites onto a studio gradient.
 *
 * @param {Buffer} imageBuffer - Input product image
 * @param {Object} options
 * @param {string} options.gradientStyle - 'white' or 'gray'
 * @param {number} options.outputWidth - Target width (default 1024)
 * @param {number} options.outputHeight - Target height (default 1024)
 * @param {number} options.padding - Padding percentage around product (0-0.5, default 0.1)
 * @returns {Promise<{buffer: Buffer, width: number, height: number}>}
 */
async function compositeOnGradient(imageBuffer, options = {}) {
  const {
    gradientStyle = 'white',
    outputWidth = DEFAULT_WIDTH,
    outputHeight = DEFAULT_HEIGHT,
    padding = 0.1,
  } = options;

  // Step 1: Remove background
  const foreground = await removeBackground(imageBuffer, options);

  // Step 2: Create gradient background
  const gradient = await createGradientBackground(outputWidth, outputHeight, gradientStyle);

  // Step 3: Resize foreground to fit within padded area
  const padX = Math.round(outputWidth * padding);
  const padY = Math.round(outputHeight * padding);
  const maxW = outputWidth - padX * 2;
  const maxH = outputHeight - padY * 2;

  const resized = await sharp(foreground.buffer)
    .resize(maxW, maxH, { fit: 'inside', withoutEnlargement: false })
    .toBuffer();

  const resizedMeta = await sharp(resized).metadata();

  // Center the product on the gradient
  const left = Math.round((outputWidth - resizedMeta.width) / 2);
  const top = Math.round((outputHeight - resizedMeta.height) / 2);

  // Step 4: Composite
  const result = await sharp(gradient)
    .composite([{ input: resized, left, top }])
    .png({ quality: 92 })
    .toBuffer();

  return { buffer: result, width: outputWidth, height: outputHeight };
}

module.exports = {
  removeBackground,
  compositeOnGradient,
  createGradientBackground,
};

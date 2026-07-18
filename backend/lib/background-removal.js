const sharp = require('sharp');

const BG_THRESHOLD = parseInt(process.env.BG_REMOVAL_THRESHOLD || '240', 10);
const EDGE_BLUR = parseFloat(process.env.BG_REMOVAL_EDGE_BLUR || '1.5');
const DEFAULT_WIDTH = 1024;
const DEFAULT_HEIGHT = 1024;

/**
 * Creates a studio background image (PNG buffer).
 * - 'gray'       → light gray vertical gradient (for shiny/reflective products)
 * - 'white'      → subtle white gradient (#fff → #f0f0f0)
 * - 'flat_white' → PURE flat white (#ffffff, no gradient) — eBay/Google-Shopping
 *                  Hauptbild-Standard (reiner weißer Hintergrund).
 */
async function createGradientBackground(width, height, style = 'white') {
  if (style === 'flat_white') {
    const white = Buffer.alloc(width * height * 3, 255);
    return sharp(white, { raw: { width, height, channels: 3 } }).png().toBuffer();
  }
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
 * Creates a soft elliptical contact shadow (PNG with alpha).
 * The ellipse is rasterized inside a padded canvas so the blur can fall off
 * smoothly instead of clipping at the buffer edge.
 */
async function createContactShadow(width, height, opacity = 0.28) {
  const blurSigma = Math.max(6, Math.round(width * 0.03));
  const pad = blurSigma * 3;
  const canvasW = width + pad * 2;
  const canvasH = height + pad * 2;
  const svg = Buffer.from(
    `<svg width="${canvasW}" height="${canvasH}" xmlns="http://www.w3.org/2000/svg">` +
      `<ellipse cx="${canvasW / 2}" cy="${canvasH / 2}" rx="${width / 2}" ry="${height / 2}" ` +
      `fill="rgb(20,20,22)" fill-opacity="${opacity}"/>` +
      `</svg>`
  );
  const buffer = await sharp(svg).blur(blurSigma).png().toBuffer();
  return { buffer, width: canvasW, height: canvasH };
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
 * @param {boolean} options.shadow - Composite a soft contact shadow under the product
 * @returns {Promise<{buffer: Buffer, width: number, height: number}>}
 */
async function compositeOnGradient(imageBuffer, options = {}) {
  const {
    gradientStyle = 'white',
    outputWidth = DEFAULT_WIDTH,
    outputHeight = DEFAULT_HEIGHT,
    padding = 0.1,
    shadow = false,
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

  const layers = [];

  // Optional soft contact shadow under the product base (grounds the object,
  // avoids the "floating cutout" look of a plain composite).
  if (shadow) {
    const shadowW = Math.round(resizedMeta.width * 0.92);
    const shadowH = Math.max(16, Math.round(outputHeight * 0.05));
    const contact = await createContactShadow(shadowW, shadowH);
    const shadowLeft = Math.round(left + (resizedMeta.width - contact.width) / 2);
    const shadowTop = Math.round(top + resizedMeta.height - contact.height / 2 - shadowH * 0.25);
    layers.push({
      input: contact.buffer,
      left: Math.max(0, Math.min(outputWidth - contact.width, shadowLeft)),
      top: Math.max(0, Math.min(outputHeight - contact.height, shadowTop)),
    });
  }

  layers.push({ input: resized, left, top });

  // Step 4: Composite
  const result = await sharp(gradient)
    .composite(layers)
    .png({ quality: 92 })
    .toBuffer();

  return { buffer: result, width: outputWidth, height: outputHeight };
}

module.exports = {
  removeBackground,
  compositeOnGradient,
  createGradientBackground,
  createContactShadow,
};

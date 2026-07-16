/**
 * Tests für den weichen Kontaktschatten in lib/background-removal.js
 * (Studio-Foto-Fallback: Freisteller auf Verlauf + Schlagschatten).
 */

const sharp = require('sharp');
const { compositeOnGradient, createContactShadow } = require('../lib/background-removal');

async function makeProductOnWhite() {
  // Weißer Hintergrund mit dunklem Produkt-Quadrat in der Mitte —
  // trifft den 5–95%-Transparenz-Korridor der Threshold-Maske.
  const square = await sharp({
    create: { width: 200, height: 200, channels: 3, background: { r: 40, g: 40, b: 45 } },
  })
    .png()
    .toBuffer();
  return sharp({
    create: { width: 400, height: 400, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .composite([{ input: square, left: 100, top: 100 }])
    .png()
    .toBuffer();
}

describe('createContactShadow', () => {
  it('liefert ein PNG mit Alpha, größer als die Ellipse (Blur-Padding)', async () => {
    const shadow = await createContactShadow(300, 40);
    expect(shadow.width).toBeGreaterThan(300);
    expect(shadow.height).toBeGreaterThan(40);
    const meta = await sharp(shadow.buffer).metadata();
    expect(meta.format).toBe('png');
    expect(meta.hasAlpha).toBe(true);
    expect(meta.width).toBe(shadow.width);
    expect(meta.height).toBe(shadow.height);
  });
});

describe('compositeOnGradient mit shadow', () => {
  it('liefert ein gültiges Bild in Zielgröße und unterscheidet sich vom Ergebnis ohne Schatten', async () => {
    const input = await makeProductOnWhite();
    const opts = { gradientStyle: 'white', outputWidth: 512, outputHeight: 512, padding: 0.1 };

    const withShadow = await compositeOnGradient(input, { ...opts, shadow: true });
    const withoutShadow = await compositeOnGradient(input, { ...opts, shadow: false });

    const meta = await sharp(withShadow.buffer).metadata();
    expect(meta.width).toBe(512);
    expect(meta.height).toBe(512);
    expect(withShadow.buffer.equals(withoutShadow.buffer)).toBe(false);
  });
});

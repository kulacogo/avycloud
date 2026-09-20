const sharp = require('sharp');
const { bauePackshot, _internal } = require('../lib/packshot-composite');

async function silhouette(points, width = 500, height = 500) {
  const png = await sharp(Buffer.from(`<svg width="${width}" height="${height}"><rect width="100%" height="100%" fill="white"/><polygon points="${points}" fill="#282828"/></svg>`)).png().toBuffer();
  const { maske, w, h } = await _internal.binarisiere(png);
  return { png, maske, w, h };
}

describe('Standflaeche statt Deckel ausrichten', () => {
  it('kippt einen waagerechten Korpus nicht wegen des schraegen offenen Deckels', async () => {
    const s = await silhouette('70,40 390,40 370,430 430,590 315,590 315,625 250,625 250,590 110,590 110,430', 500, 700);
    // Die fruehere Ganzumriss-Methode verdreht dieses bereits stehende Objekt.
    expect(Math.abs(_internal.winkelMinRechteck(s.maske, s.w, s.h))).toBeGreaterThan(3);
    const result = await bauePackshot(s.png, s.png, { weissabgleich: false, schattenlift: false, reviewResult: async () => ({ action: 'ok' }) });
    expect(result.ok).toBe(true);
    expect(Math.abs(result.info.drehungGrad)).toBeLessThan(0.5);
  });

  it('richtet einen leicht gekippten Korpus trotz abstehendem Griff gerade', async () => {
    const s = await silhouette('80,170 420,200 420,365 290,353 290,375 230,370 230,348 80,335');
    expect(_internal.winkelStandflaeche(s.maske, s.w, s.h)).toBeCloseTo(5, 0);
  });

  it('erhaelt eine bewusst perspektivische Ansicht mit zwei verschiedenen Bodenkanten', async () => {
    const s = await silhouette('70,180 290,140 420,200 420,355 285,400 70,360');
    expect(_internal.winkelStandflaeche(s.maske, s.w, s.h)).toBe(0);
  });

  it('errät bei einer runden oder schmalen Standflaeche keinen Winkel', async () => {
    const png = await sharp(Buffer.from('<svg width="400" height="400"><rect width="400" height="400" fill="white"/><ellipse cx="200" cy="200" rx="130" ry="150" fill="black"/></svg>')).png().toBuffer();
    const s = await _internal.binarisiere(png);
    expect(_internal.winkelStandflaeche(s.maske, s.w, s.h)).toBe(0);
  });

  it('dreht eine schon komponierte KI-Ansicht nicht erneut', async () => {
    const s = await silhouette('80,170 420,200 420,365 80,335');
    const result = await bauePackshot(s.png, s.png, { ausrichten: false, weissabgleich: false, schattenlift: false });
    expect(result.ok).toBe(true);
    expect(result.info.drehungGrad).toBe(0);
  });
});

describe('Sichtbarer weicher Bodenschatten', () => {
  it.each([[700, 220], [330, 700]])('erdet breite und hohe Produkte (%i × %i) mit sichtbarem Schatten', async (w, h) => {
    const product = await sharp({ create: { width: w, height: h, channels: 4, background: '#202020' } }).png().toBuffer();
    const shadow = await _internal.baueKontaktschatten(product, w, h);
    const { data, info } = await sharp(shadow.buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const base = -shadow.dy;
    let visible = 0;
    let near = 0;
    let far = 0;
    for (let x = Math.round(info.width * 0.2); x < info.width * 0.8; x++) {
      near += data[(Math.round(base + w * 0.007) * info.width + x) * 4 + 3];
      far += data[(Math.round(base + w * 0.03) * info.width + x) * 4 + 3];
    }
    for (let y = Math.ceil(base); y < info.height; y++) for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * 4 + 3] > 8) visible++;
    }
    expect(visible).toBeGreaterThan(w * w * 0.012);
    expect(near).toBeGreaterThan(far * 1.5);
    expect(far).toBeGreaterThan(0);
    expect(data[3]).toBe(0);
  });

  it('laesst Materialfarbe und die aeusseren Raender unveraendert', async () => {
    const s = await silhouette('80,190 420,190 420,350 80,350');
    const result = await bauePackshot(s.png, s.png, { weissabgleich: false, schattenlift: false });
    expect(result.ok).toBe(true);
    expect((await _internal.pruefeRand(result.buffer)).ok).toBe(true);
    const { data, info } = await sharp(result.buffer).raw().toBuffer({ resolveWithObject: true });
    const p = (Math.round(info.height * 0.45) * info.width + Math.round(info.width / 2)) * info.channels;
    expect(data[p]).toBeGreaterThanOrEqual(38);
    expect(data[p]).toBeLessThanOrEqual(42);
  });
});

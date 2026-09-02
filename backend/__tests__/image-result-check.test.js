/**
 * Tests für lib/image-result-check.js — Prüfung erzeugter Bilder VOR dem Speichern.
 *
 * `services/image-generation.js` prüfte bis 2026-09-02 gar nichts: was das Modell
 * zurückgab, wurde hochgeladen und an die Galerie gehängt.
 */

const sharp = require('sharp');
const {
  validateGeneratedImage,
  classifyIdentityVerdict,
  judgeProductIdentity,
  identityCheckEnabled,
} = require('../lib/image-result-check');

async function bild({ size = 1024, bg = { r: 255, g: 255, b: 255 }, motiv = true } = {}) {
  const base = sharp({ create: { width: size, height: size, channels: 3, background: bg } });
  if (!motiv) return base.png().toBuffer();
  const inner = await sharp({
    create: { width: Math.round(size / 2), height: Math.round(size / 2), channels: 3, background: { r: 30, g: 80, b: 150 } },
  })
    .png()
    .toBuffer();
  return base
    .composite([{ input: inner, left: Math.round(size / 4), top: Math.round(size / 4) }])
    .png()
    .toBuffer();
}

beforeEach(() => {
  delete process.env.GENERATED_IMAGE_IDENTITY_CHECK;
  delete process.env.GENERATED_IMAGE_IDENTITY_MIN_CONFIDENCE;
  delete process.env.GENERATED_IMAGE_MIN_EDGE;
});

describe('validateGeneratedImage', () => {
  it('nimmt ein brauchbares Studio-Bild an', async () => {
    const v = await validateGeneratedImage(await bild());
    expect(v.ok).toBe(true);
    expect(v.width).toBe(1024);
  });

  it('verwirft eine leere Flaeche — ein weisses Quadrat ist kein Produktfoto', async () => {
    const v = await validateGeneratedImage(await bild({ motiv: false }));
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/leere_flaeche/);
  });

  it('verwirft zu kleine Bilder', async () => {
    const v = await validateGeneratedImage(await bild({ size: 256 }));
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/zu_klein/);
  });

  it('verwirft einen dunklen Hintergrund (kein Studio-Ergebnis)', async () => {
    const v = await validateGeneratedImage(await bild({ bg: { r: 12, g: 12, b: 12 } }));
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/hintergrund_zu_dunkel/);
  });

  it('laesst die Hintergrundpruefung abschalten, ohne die uebrigen zu verlieren', async () => {
    const dunkel = await bild({ bg: { r: 12, g: 12, b: 12 } });
    expect((await validateGeneratedImage(dunkel, { requireBrightBackground: false })).ok).toBe(true);
    const winzig = await bild({ size: 256, bg: { r: 12, g: 12, b: 12 } });
    expect((await validateGeneratedImage(winzig, { requireBrightBackground: false })).ok).toBe(false);
  });

  it('wirft nie — auch nicht bei Muell', async () => {
    expect((await validateGeneratedImage(Buffer.from('kein bild'))).ok).toBe(false);
    expect((await validateGeneratedImage(Buffer.alloc(0))).ok).toBe(false);
    expect((await validateGeneratedImage(null)).ok).toBe(false);
  });
});

describe('classifyIdentityVerdict', () => {
  it('verwirft nur bei einem SICHEREN Nein', () => {
    const v = classifyIdentityVerdict({
      sameItem: false, confidence: 0.9, perspectiveKept: true, markingsKept: true, problems: [],
    });
    expect(v.action).toBe('verwerfen');
    expect(v.reason).toBe('anderer_artikel');
  });

  it('warnt statt zu verwerfen, wenn das Urteil unsicher ist', () => {
    const v = classifyIdentityVerdict({
      sameItem: false, confidence: 0.3, perspectiveKept: true, markingsKept: true, problems: [],
    });
    expect(v.action).toBe('warnen');
    expect(v.warnings[0]).toMatch(/unsicher/i);
  });

  it('behandelt ein fehlendes Urteil als ungeprueft, nicht als in Ordnung', () => {
    expect(classifyIdentityVerdict(null).action).toBe('ungeprueft');
  });

  it('warnt bei entfernten Beschriftungen — genau der Schaden des alten "no text"-Prompts', () => {
    const v = classifyIdentityVerdict({
      sameItem: true, confidence: 0.9, perspectiveKept: true, markingsKept: false,
      problems: ['Typenschild fehlt'],
    });
    expect(v.action).toBe('warnen');
    expect(v.warnings).toContain('Beschriftungen wurden verändert oder entfernt');
    expect(v.warnings).toContain('Typenschild fehlt');
  });

  it('warnt bei gedrehter Perspektive, verwirft aber nicht', () => {
    const v = classifyIdentityVerdict({
      sameItem: true, confidence: 0.9, perspectiveKept: false, markingsKept: true, problems: [],
    });
    expect(v.action).toBe('warnen');
    expect(v.warnings).toContain('Blickwinkel wurde verändert');
  });

  it('meldet ein sauberes Ergebnis ohne Warnung', () => {
    const v = classifyIdentityVerdict({
      sameItem: true, confidence: 0.95, perspectiveKept: true, markingsKept: true, problems: [],
    });
    expect(v.action).toBe('ok');
    expect(v.warnings).toHaveLength(0);
  });

  it('respektiert eine strengere Schwelle aus der Konfiguration', () => {
    process.env.GENERATED_IMAGE_IDENTITY_MIN_CONFIDENCE = '0.95';
    const v = classifyIdentityVerdict({
      sameItem: false, confidence: 0.9, perspectiveKept: true, markingsKept: true, problems: [],
    });
    expect(v.action).toBe('warnen');
  });
});

describe('Betriebsschalter', () => {
  it('ist per Default an', () => {
    expect(identityCheckEnabled()).toBe(true);
  });

  it('schaltet NUR beim exakten Wert off ab', () => {
    process.env.GENERATED_IMAGE_IDENTITY_CHECK = 'false';
    expect(identityCheckEnabled()).toBe(true);
    process.env.GENERATED_IMAGE_IDENTITY_CHECK = 'off';
    expect(identityCheckEnabled()).toBe(false);
  });

  it('fragt kein Modell, wenn er aus ist', async () => {
    process.env.GENERATED_IMAGE_IDENTITY_CHECK = 'off';
    const urteil = await judgeProductIdentity([{ inlineData: { data: 'x', mimeType: 'image/png' } }], {
      data: 'y', mimeType: 'image/png',
    });
    expect(urteil).toBeNull();
  });

  it('liefert null statt zu werfen, wenn Referenzen oder Kandidat fehlen', async () => {
    expect(await judgeProductIdentity([], { data: 'y' })).toBeNull();
    expect(await judgeProductIdentity([{ inlineData: {} }], null)).toBeNull();
  });
});

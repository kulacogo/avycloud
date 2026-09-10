/**
 * Tests für services/image-generation.js — die Angebotsgalerie.
 *
 * Betreiber-Auftrag 2026-09-10: alle vorhandenen Produktfotos auswerten und
 * daraus MINDESTENS VIER Studio-Ansichten plus ZWEI optionale Anwendungsszenen
 * erzeugen.
 *
 * Diese Datei hielt vorher das Gegenteil fest (nur belegte Ansichten aufbereiten,
 * nichts ableiten). Diese Vorgabe wurde am 10.09. ausdrücklich WIDERRUFEN — siehe
 * Kopfkommentar von `services/image-generation.js`. Was bleibt und hier weiter
 * geprüft wird: Kennzeichnung erzeugter Bilder, keine Kopie-einer-Kopie,
 * Ergebnisprüfung, Zeitbudget, ehrlicher Bericht.
 *
 * CJS-Test — require.cache-Patching (kein vi.mock für CJS).
 */


const path = require('path');
const sharp = require('sharp');

require('./api/_patchGcp');

function patchLocalModule(modulePath, mockExports) {
  const resolvedPath = require.resolve(modulePath);
  require.cache[resolvedPath] = {
    id: resolvedPath,
    filename: resolvedPath,
    loaded: true,
    exports: mockExports,
    children: [],
    paths: [],
  };
}

const generateSpy = vi.fn();
const uploadSpy = vi.fn();
const classifySpy = vi.fn();
const judgeSpy = vi.fn();

// Echte Planungs-Logik behalten, nur den Modell-Aufruf ersetzen.
const echtesViewpoint = require('../lib/image-viewpoint');
const echtesResultCheck = require('../lib/image-result-check');

patchLocalModule(path.resolve(__dirname, '../lib/vertex-ai.js'), {
  generateProductImagesWithReport: generateSpy,
  generateProductImages: vi.fn(),
  GeminiImageError: class GeminiImageError extends Error {},
});
patchLocalModule(path.resolve(__dirname, '../lib/storage.js'), { uploadBase64Image: uploadSpy });
patchLocalModule(path.resolve(__dirname, '../lib/web-unlocker.js'), { fetchWithUnlocker: vi.fn() });
patchLocalModule(path.resolve(__dirname, '../lib/image-viewpoint.js'), {
  ...echtesViewpoint,
  classifyViewpointParts: classifySpy,
});
patchLocalModule(path.resolve(__dirname, '../lib/image-result-check.js'), {
  ...echtesResultCheck,
  judgeProductIdentity: judgeSpy,
});

const { generateImagesForProduct, collectReferenceCandidates, isLikelyAiImage } =
  require('../services/image-generation');

let studioPng;

beforeAll(async () => {
  const inner = await sharp({
    create: { width: 512, height: 512, channels: 3, background: { r: 30, g: 80, b: 150 } },
  })
    .png()
    .toBuffer();
  studioPng = await sharp({
    create: { width: 1024, height: 1024, channels: 3, background: { r: 252, g: 252, b: 252 } },
  })
    .composite([{ input: inner, left: 256, top: 256 }])
    .png()
    .toBuffer();
});

function produkt(bilder) {
  return {
    id: 'p1',
    identification: { brand: 'Bosch', name: 'GSR 12V' },
    details: { images: bilder, attributes: { Material: 'Kunststoff' } },
  };
}

const PRODUKT = {
  wasEsIst: 'non-slip bathtub mat made of soft white plastic',
  material: 'soft PVC',
  woBenutzt: 'inside a bathtub or shower tray',
  wieBenutzt: 'laid flat on the tub floor, a person stands barefoot on it',
  werBenutzt: 'an adult',
  schluesselbereich: 'the suction cups on the underside',
  szeneA: 'a bare foot stepping onto the wet mat inside a bathtub',
  szeneB: 'a person standing in a bright modern bathroom bathtub on the mat',
  lifestyleSinnvoll: true,
};

function klassifikation(views, produkt = PRODUKT) {
  return { views, sameProductThroughout: true, produkt, model: 'test' };
}

const V = (index, viewpoint, extra = {}) => ({
  index,
  viewpoint,
  showsProduct: true,
  fullyVisible: true,
  usableAsReference: true,
  confidence: 0.95,
  ...extra,
});

beforeEach(async () => {
  vi.clearAllMocks();
  delete process.env.IMAGE_VARIANTS_MODE;

  const echtesFoto = await sharp({
    create: { width: 800, height: 800, channels: 3, background: { r: 200, g: 200, b: 200 } },
  })
    .jpeg()
    .toBuffer();

  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'image/jpeg' },
    arrayBuffer: async () =>
      echtesFoto.buffer.slice(echtesFoto.byteOffset, echtesFoto.byteOffset + echtesFoto.byteLength),
  }));

  generateSpy.mockResolvedValue({
    images: [{ base64: studioPng.toString('base64'), mimeType: 'image/png' }],
    model: 'gemini-3-pro-image',
    attempts: [],
    referenceCount: 1,
  });
  uploadSpy.mockImplementation(async (_d, _p, variant) => ({
    url: `https://gcs/${variant}.png`,
    mimeType: 'image/png',
    width: 1200,
    height: 1200,
  }));
  judgeSpy.mockResolvedValue(null); // ungeprüft — darf nicht als "verwerfen" gelten
});

describe('Serie: mindestens 4 Studio + 2 Szenen', () => {
  const einFoto = [{ url_or_base64: 'https://x/1.jpg' }];

  it('erzeugt aus EINEM Foto vier Studio-Ansichten und zwei Szenen', async () => {
    classifySpy.mockResolvedValue(klassifikation([V(0, 'front')]));

    const res = await generateImagesForProduct(produkt(einFoto), {
      referenceImage: { url_or_base64: 'https://x/1.jpg' },
    });

    expect(res.report.studioProduced).toBeGreaterThanOrEqual(4);
    expect(res.report.lifestyleProduced).toBe(2);
    expect(new Set(res.images.map((i) => i.variant)).size).toBe(res.images.length);
  });

  it('nimmt fuer eine Ansicht das ECHTE Foto, wenn es eines gibt', async () => {
    classifySpy.mockResolvedValue(klassifikation([V(0, 'front'), V(1, 'side'), V(2, 'back')]));

    const res = await generateImagesForProduct(
      produkt([
        { url_or_base64: 'https://x/1.jpg' },
        { url_or_base64: 'https://x/2.jpg' },
        { url_or_base64: 'https://x/3.jpg' },
      ]),
      { referenceImage: { url_or_base64: 'https://x/1.jpg' } }
    );

    const front = res.images.find((i) => i.variant === 'studio_front');
    const side = res.images.find((i) => i.variant === 'studio_side');
    expect(front.ausEchtemFoto).toBe(true);
    expect(front.derivedFrom).toBe('https://x/1.jpg');
    expect(side.ausEchtemFoto).toBe(true);
    expect(side.derivedFrom).toBe('https://x/2.jpg');
    expect(res.report.ausEchtemFoto).toBeGreaterThanOrEqual(3);
  });

  it('kennzeichnet abgeleitete Ansichten ehrlich als NICHT aus echtem Foto', async () => {
    classifySpy.mockResolvedValue(klassifikation([V(0, 'front')]));
    const res = await generateImagesForProduct(produkt(einFoto), {
      referenceImage: { url_or_base64: 'https://x/1.jpg' },
    });
    const abgeleitet = res.images.filter((i) => i.art === 'studio' && !i.ausEchtemFoto);
    expect(abgeleitet.length).toBeGreaterThan(0);
  });

  it('trennt Studio von Anwendungsszene', async () => {
    classifySpy.mockResolvedValue(klassifikation([V(0, 'front')]));
    const res = await generateImagesForProduct(produkt(einFoto), {
      referenceImage: { url_or_base64: 'https://x/1.jpg' },
    });
    for (const bild of res.images) expect(['studio', 'lifestyle']).toContain(bild.art);
    expect(res.images.filter((i) => i.art === 'lifestyle').map((i) => i.variant).sort())
      .toEqual(['lifestyle_inuse', 'lifestyle_scene']);
  });

  it('laesst die Szenen weg, wenn der Artikel sie nicht hergibt', async () => {
    classifySpy.mockResolvedValue(
      klassifikation([V(0, 'front')], { ...PRODUKT, lifestyleSinnvoll: false })
    );
    const res = await generateImagesForProduct(produkt(einFoto), {
      referenceImage: { url_or_base64: 'https://x/1.jpg' },
    });
    expect(res.report.lifestyleProduced).toBe(0);
    expect(res.skipped.some((x) => x.reason === 'nicht_sinnvoll_darstellbar')).toBe(true);
  });

  it('laesst die Szenen auf Wunsch des Aufrufers weg', async () => {
    classifySpy.mockResolvedValue(klassifikation([V(0, 'front')]));
    const res = await generateImagesForProduct(produkt(einFoto), {
      referenceImage: { url_or_base64: 'https://x/1.jpg' },
      lifestyle: false,
    });
    expect(res.report.lifestyleProduced).toBe(0);
    expect(res.report.studioProduced).toBeGreaterThanOrEqual(4);
  });

  it('meldet fehlende Produkterkennung, statt Szenen zu raten', async () => {
    classifySpy.mockResolvedValue(klassifikation([V(0, 'front')], null));
    const res = await generateImagesForProduct(produkt(einFoto), {
      referenceImage: { url_or_base64: 'https://x/1.jpg' },
    });
    expect(res.report.lifestyleProduced).toBe(0);
    expect(res.skipped.some((x) => x.reason === 'produkt_nicht_erkannt')).toBe(true);
  });
});

describe('alle echten Fotos gehen als Referenz mit', () => {
  // Hier geht es um den RENDER-Weg und seine Referenzen. Der pixeltreue Weg
  // schickt bewusst nur EIN Bild (die Vorlage) und wuerde diese Frage gar nicht
  // beruehren — deshalb wird er hier ausdruecklich abgeschaltet, statt dass der
  // Test still misst, was er nicht meint.
  beforeEach(() => {
    process.env.GALLERY_PIXEL_FAITHFUL = 'off';
  });
  afterEach(() => {
    delete process.env.GALLERY_PIXEL_FAITHFUL;
  });

  it('sendet ALLE echten Fotos als Referenz mit', async () => {
    // KEHRTWENDE zum 04.09.: damals genau EIN Bild, weil nur geputzt wurde.
    // Jetzt werden Ansichten ABGELEITET — dafuer braucht das Modell alle Seiten.
    classifySpy.mockResolvedValue(klassifikation([V(0, 'front')]));

    await generateImagesForProduct(
      produkt([
        { url_or_base64: 'https://x/1.jpg' },
        { url_or_base64: 'https://x/2.jpg' },
        { url_or_base64: 'https://x/3.jpg' },
      ]),
      { referenceImage: { url_or_base64: 'https://x/1.jpg' } }
    );

    expect(generateSpy.mock.calls[0][0].referenceImages).toHaveLength(3);
  });

  it('laesst sich per Notbremse auf ein einziges Referenzbild zurueckstellen', async () => {
    process.env.VARIANT_SIBLING_ANCHORS = 'off';
    classifySpy.mockResolvedValue(klassifikation([V(0, 'front')]));
    await generateImagesForProduct(
      produkt([{ url_or_base64: 'https://x/1.jpg' }, { url_or_base64: 'https://x/2.jpg' }]),
      { referenceImage: { url_or_base64: 'https://x/1.jpg' } }
    );
    expect(generateSpy.mock.calls[0][0].referenceImages).toHaveLength(1);
    delete process.env.VARIANT_SIBLING_ANCHORS;
  });

  it('stellt die Vorlage der jeweiligen Ansicht an die ERSTE Stelle', async () => {
    classifySpy.mockResolvedValue(klassifikation([V(0, 'side'), V(1, 'front')]));

    const res = await generateImagesForProduct(
      produkt([{ url_or_base64: 'https://x/1.jpg' }, { url_or_base64: 'https://x/2.jpg' }]),
      { referenceImage: { url_or_base64: 'https://x/1.jpg' } }
    );

    // Die Frontansicht sitzt auf Foto 2 (Index 1), die Seitenansicht auf Foto 1.
    expect(res.images.find((i) => i.variant === 'studio_front').derivedFrom).toBe('https://x/2.jpg');
    expect(res.images.find((i) => i.variant === 'studio_side').derivedFrom).toBe('https://x/1.jpg');
  });

  it('nimmt bereits erzeugte Bilder NIE als Referenz (keine Kopie einer Kopie)', () => {
    const p = produkt([
      { url_or_base64: 'https://x/echt.jpg' },
      { url_or_base64: 'https://x/ki.png', generatedByAi: true },
      { url_or_base64: 'https://x/alt.png', variant: 'studio_front' },
    ]);
    const kandidaten = collectReferenceCandidates(p, null).map((i) => i.url_or_base64);
    expect(kandidaten).toEqual(['https://x/echt.jpg']);
  });

  it('erkennt erzeugte Bilder an mehreren Merkmalen', () => {
    expect(isLikelyAiImage({ generatedByAi: true })).toBe(true);
    expect(isLikelyAiImage({ source: 'generated' })).toBe(true);
    expect(isLikelyAiImage({ variant: 'studio_back' })).toBe(true);
    expect(isLikelyAiImage({ source: 'upload', variant: 'main' })).toBe(false);
  });
});

describe('Ergebnisse werden geprueft', () => {
  // Ergebnispruefung und Identitaets-Zweitmeinung gehoeren zum RENDER-Weg. Der
  // pixeltreue Weg braucht beides nicht (Originalpixel), also wuerde er diese
  // Tests leerlaufen lassen — er wird deshalb hier abgeschaltet.
  beforeEach(() => {
    process.env.GALLERY_PIXEL_FAITHFUL = 'off';
  });
  afterEach(() => {
    delete process.env.GALLERY_PIXEL_FAITHFUL;
  });

  it('verwirft ein leeres Modellergebnis statt es in die Galerie zu haengen', async () => {
    const leer = await sharp({
      create: { width: 1024, height: 1024, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .png()
      .toBuffer();
    generateSpy.mockResolvedValue({
      images: [{ base64: leer.toString('base64'), mimeType: 'image/png' }],
      model: 'gemini-3-pro-image',
      attempts: [],
      referenceCount: 1,
    });
    classifySpy.mockResolvedValue(
      klassifikation([
        { index: 0, viewpoint: 'front', showsProduct: true, fullyVisible: true, usableAsReference: true, confidence: 0.95 },
      ])
    );

    const res = await generateImagesForProduct(produkt([{ url_or_base64: 'https://x/1.jpg' }]), {
      referenceImage: { url_or_base64: 'https://x/1.jpg' },
    });

    expect(res.images).toHaveLength(0);
    expect(uploadSpy).not.toHaveBeenCalled();
    expect(res.skipped.some((s) => s.reason === 'erzeugung_fehlgeschlagen')).toBe(true);
  });

  it('verwirft ein Ergebnis, das einen anderen Artikel zeigt', async () => {
    judgeSpy.mockResolvedValue({
      sameItem: false, confidence: 0.95, perspectiveKept: true, markingsKept: true, problems: ['anderes Gehaeuse'],
    });
    classifySpy.mockResolvedValue(
      klassifikation([
        { index: 0, viewpoint: 'front', showsProduct: true, fullyVisible: true, usableAsReference: true, confidence: 0.95 },
      ])
    );

    const res = await generateImagesForProduct(produkt([{ url_or_base64: 'https://x/1.jpg' }]), {
      referenceImage: { url_or_base64: 'https://x/1.jpg' },
    });

    expect(res.images).toHaveLength(0);
    expect(uploadSpy).not.toHaveBeenCalled();
  });

  it('behaelt ein Bild mit Warnung, verwirft es aber nicht', async () => {
    judgeSpy.mockResolvedValue({
      sameItem: true, confidence: 0.9, perspectiveKept: true, markingsKept: false, problems: ['Typenschild unscharf'],
    });
    classifySpy.mockResolvedValue(klassifikation([V(0, 'front')]));

    const res = await generateImagesForProduct(produkt([{ url_or_base64: 'https://x/1.jpg' }]), {
      referenceImage: { url_or_base64: 'https://x/1.jpg' },
    });

    expect(res.images.length).toBeGreaterThan(0);
    for (const bild of res.images) expect(bild.warnings).toContain('Typenschild unscharf');
  });
});

describe('Zeitbudget und Nebenlaeufigkeit', () => {
  beforeEach(() => {
    classifySpy.mockResolvedValue(
      klassifikation([
        { index: 0, viewpoint: 'front', showsProduct: true, fullyVisible: true, usableAsReference: true, confidence: 0.95 },
        { index: 1, viewpoint: 'back', showsProduct: true, fullyVisible: true, usableAsReference: true, confidence: 0.9 },
        { index: 2, viewpoint: 'side', showsProduct: true, fullyVisible: true, usableAsReference: true, confidence: 0.9 },
      ])
    );
  });
  afterEach(() => {
    delete process.env.IMAGE_VARIANTS_TOTAL_TIMEOUT_MS;
    delete process.env.IMAGE_VARIANTS_CONCURRENCY;
  });

  const dreiBilder = [
    { url_or_base64: 'https://x/1.jpg' },
    { url_or_base64: 'https://x/2.jpg' },
    { url_or_base64: 'https://x/3.jpg' },
  ];

  it('rendert Ansichten nebenlaeufig statt nacheinander', async () => {
    let gleichzeitig = 0;
    let hoechstwert = 0;
    generateSpy.mockImplementation(async () => {
      gleichzeitig += 1;
      hoechstwert = Math.max(hoechstwert, gleichzeitig);
      await new Promise((r) => setTimeout(r, 30));
      gleichzeitig -= 1;
      return {
        images: [{ base64: studioPng.toString('base64'), mimeType: 'image/png' }],
        model: 'gemini-3-pro-image',
        attempts: [],
        referenceCount: 1,
      };
    });

    await generateImagesForProduct(produkt(dreiBilder), {
      referenceImage: { url_or_base64: 'https://x/1.jpg' },
    });
    expect(hoechstwert).toBeGreaterThan(1);
  });

  it('bricht bei erschoepftem Zeitbudget EHRLICH ab statt in den Cloud-Run-Timeout zu laufen', async () => {
    process.env.IMAGE_VARIANTS_TOTAL_TIMEOUT_MS = '1';
    process.env.IMAGE_VARIANTS_CONCURRENCY = '1';

    const res = await generateImagesForProduct(produkt(dreiBilder), {
      referenceImage: { url_or_base64: 'https://x/1.jpg' },
    });

    expect(res.skipped.some((s) => s.reason === 'zeitbudget_erschoepft')).toBe(true);
    expect(res.report.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('haelt die Zuordnung Ansicht -> Ergebnis auch nebenlaeufig ein', async () => {
    const res = await generateImagesForProduct(produkt(dreiBilder), {
      referenceImage: { url_or_base64: 'https://x/1.jpg' },
    });
    for (const bild of res.images) {
      // Studio-Ansichten heissen studio_<key>, Szenen lifestyle_<key>.
      const praefix = bild.art === 'lifestyle' ? 'lifestyle' : 'studio';
      expect(bild.variant).toBe(`${praefix}_${bild.viewpoint}`);
    }
  });
});

describe('kein Weg zurueck zum Erfinden', () => {
  afterEach(() => {
    delete process.env.IMAGE_VARIANTS_MODE;
  });

  it('IMAGE_VARIANTS_MODE hat KEINE Wirkung mehr — auch nicht mit dem alten Wert legacy', async () => {
    // Der Schalter erzeugte mit den Erhaltungs-Prompts vier IDENTISCHE Bilder und
    // etikettierte sie als vier verschiedene Ansichten. Er wurde entfernt.
    process.env.IMAGE_VARIANTS_MODE = 'legacy';
    classifySpy.mockResolvedValue(
      klassifikation([
        { index: 0, viewpoint: 'front', showsProduct: true, fullyVisible: true, usableAsReference: true, confidence: 0.95 },
      ])
    );

    const res = await generateImagesForProduct(produkt([{ url_or_base64: 'https://x/1.jpg' }]), {
      referenceImage: { url_or_base64: 'https://x/1.jpg' },
    });

    expect(res.report.mode).toBe('faithful');
    expect(res.report.studioProduced).toBeGreaterThanOrEqual(4);
  });

  it('vergibt jedes ECHTE Quellfoto nur einmal', async () => {
    // Abgeleitete Ansichten teilen sich zwangslaeufig dieselbe beste Vorlage —
    // aber zwei Ansichten duerfen nicht dasselbe ECHTE Foto beanspruchen.
    classifySpy.mockResolvedValue(klassifikation([V(0, 'front'), V(1, 'back')]));
    const res = await generateImagesForProduct(
      produkt([{ url_or_base64: 'https://x/1.jpg' }, { url_or_base64: 'https://x/2.jpg' }]),
      { referenceImage: { url_or_base64: 'https://x/1.jpg' } }
    );
    const echte = res.images.filter((i) => i.ausEchtemFoto).map((i) => i.derivedFrom);
    expect(new Set(echte).size).toBe(echte.length);
  });
});

describe('Kennzeichnung und Bericht', () => {
  beforeEach(() => {
    classifySpy.mockResolvedValue(
      klassifikation([
        { index: 0, viewpoint: 'front', showsProduct: true, fullyVisible: true, usableAsReference: true, confidence: 0.95 },
      ])
    );
  });

  it('markiert jedes erzeugte Bild eindeutig als KI-Bild', async () => {
    const res = await generateImagesForProduct(produkt([{ url_or_base64: 'https://x/1.jpg' }]), {
      referenceImage: { url_or_base64: 'https://x/1.jpg' },
    });
    expect(res.images[0].generatedByAi).toBe(true);
    expect(res.images[0].derivedFrom).toBe('https://x/1.jpg');
  });

  it('schreibt NIE undefined in ein Bildobjekt — Firestore laeuft ohne ignoreUndefinedProperties', async () => {
    // Ein einziges undefined-Feld laesst den gesamten Produkt-Schreibvorgang
    // scheitern, nicht nur dieses Bild.
    const res = await generateImagesForProduct(produkt([{ url_or_base64: 'https://x/1.jpg' }]), {
      referenceImage: { url_or_base64: 'https://x/1.jpg' },
    });
    for (const bild of res.images) {
      for (const [key, value] of Object.entries(bild)) {
        expect(value, `Feld ${key} ist undefined`).not.toBeUndefined();
      }
    }
    // Ohne Warnungen fehlt der Schluessel ganz, statt undefined zu tragen.
    expect(Object.prototype.hasOwnProperty.call(res.images[0], 'warnings')).toBe(false);
  });

  it('meldet Beleglage und Ergebniszahlen an die Oberflaeche', async () => {
    const res = await generateImagesForProduct(produkt([{ url_or_base64: 'https://x/1.jpg' }]), {
      referenceImage: { url_or_base64: 'https://x/1.jpg' },
    });
    expect(res.evidence.belegt).toEqual(['front']);
    expect(res.evidence.belegtLabels).toEqual(['Vorderansicht']);
    expect(res.evidence.produkt.wasEsIst).toMatch(/bathtub mat/);
    expect(res.report.producedVariants).toBeGreaterThanOrEqual(6);
    expect(res.report.mode).toBe('faithful');
  });

  it('wirft ohne jedes echte Referenzbild', async () => {
    await expect(
      generateImagesForProduct(produkt([{ url_or_base64: 'https://x/ki.png', generatedByAi: true }]), {})
    ).rejects.toThrow(/reference image is required/i);
  });
});

/**
 * PIXELTREUER WEG — Ansichten mit echtem Foto bestehen aus ORIGINALPIXELN.
 *
 * Der Anlass, gemessen am 10.09.2026: ein Bildmodell rendert IMMER alles neu.
 * Grosse Schrift uebersteht das, KLEINDRUCK nicht — auf der Rueckansicht des
 * Marstek-Speichers wurde aus "OUT CAN'T CONNECT SOLAR PANELS" ein "CUT CONT
 * CONNECT SPLAR PANLS". Deshalb liefert das Modell hier nur noch die SILHOUETTE;
 * ins Endbild gehen die Pixel des echten Fotos.
 */
describe('pixeltreuer Weg', () => {
  it('nimmt fuer eine Ansicht mit echtem Foto die ORIGINALPIXEL statt neu zu zeichnen', async () => {
    classifySpy.mockResolvedValue(klassifikation([V(0, 'front')]));

    const res = await generateImagesForProduct(produkt([{ url_or_base64: 'https://x/1.jpg' }]), {
      referenceImage: { url_or_base64: 'https://x/1.jpg' },
    });

    const front = res.images.find((b) => b.variant === 'studio_front');
    expect(front.pixeltreu).toBe(true);
    expect(front.ausEchtemFoto).toBe(true);
    expect(front.notes).toMatch(/ORIGINALPIXELN/);
    // Abgeleitete Ansichten koennen es bauartbedingt NICHT sein.
    expect(res.images.find((b) => b.variant === 'studio_hero').pixeltreu).toBe(false);
    expect(res.report.pixeltreu).toBe(1);
  });

  it('schickt fuer die Maske nur EIN Bild und den Masken-Prompt', async () => {
    classifySpy.mockResolvedValue(klassifikation([V(0, 'front')]));

    await generateImagesForProduct(
      produkt([{ url_or_base64: 'https://x/1.jpg' }, { url_or_base64: 'https://x/2.jpg' }]),
      { referenceImage: { url_or_base64: 'https://x/1.jpg' } }
    );

    const maskenAufruf = generateSpy.mock.calls.find((c) => /Remove the background/.test(c[0].prompt));
    expect(maskenAufruf).toBeTruthy();
    // Weitere Fotos wuerden das Modell zu einer ANDEREN Ansicht verleiten —
    // dann passte die Maske nicht mehr auf das Originalfoto.
    expect(maskenAufruf[0].referenceImages).toHaveLength(1);
  });

  it('kostet weniger als ein voller Render — billiges Modell, kleine Groesse', async () => {
    classifySpy.mockResolvedValue(klassifikation([V(0, 'front')]));

    const res = await generateImagesForProduct(produkt([{ url_or_base64: 'https://x/1.jpg' }]), {
      referenceImage: { url_or_base64: 'https://x/1.jpg' },
    });

    // BESTELLT wird das billigste Modell in kleiner Groesse. Gebucht wird
    // spaeter das vom Dienst GEMELDETE Modell — abgerechnet wird, was wirklich
    // lief, nicht was man wollte.
    const maskenAufruf = generateSpy.mock.calls.find((c) => /Remove the background/.test(c[0].prompt));
    expect(maskenAufruf[0].model).toBe('gemini-3.1-flash-lite-image');
    expect(maskenAufruf[0].imageSize).toBe('1K');

    const maske = res.report.kosten.posten.find((p) => /maske/.test(p.zweck || ''));
    expect(maske.imageSize).toBe('1K');
  });

  it('FAELLT AUF DEN RENDER-WEG ZURUECK, wenn die Maske unbrauchbar ist', async () => {
    classifySpy.mockResolvedValue(klassifikation([V(0, 'front')]));

    // Eine reinweisse Maske hat keine Silhouette — die Waechter in
    // packshot-composite.js sind fail-closed und lehnen ab. Lieber ein
    // gerendertes Bild als ein zerfallenes Produkt (Incident 2026-07-18).
    const leer = await sharp({
      create: { width: 1024, height: 1024, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .png()
      .toBuffer();

    // Am PROMPT unterscheiden, nicht an der Aufrufreihenfolge: die Ansichten
    // laufen nebenlaeufig, "der erste Aufruf" ist damit nicht bestimmbar.
    generateSpy.mockImplementation(async (args) => {
      const istMaske = /Remove the background/.test(args.prompt);
      return {
        model: 'gemini-3.1-flash-image',
        images: [{ base64: (istMaske ? leer : studioPng).toString('base64'), mimeType: 'image/png' }],
      };
    });

    const res = await generateImagesForProduct(produkt([{ url_or_base64: 'https://x/1.jpg' }]), {
      referenceImage: { url_or_base64: 'https://x/1.jpg' },
    });

    const front = res.images.find((b) => b.variant === 'studio_front');
    expect(front).toBeTruthy();
    expect(front.pixeltreu).toBe(false);
  });

  it('laesst sich per Notbremse abschalten', async () => {
    process.env.GALLERY_PIXEL_FAITHFUL = 'off';
    classifySpy.mockResolvedValue(klassifikation([V(0, 'front')]));

    const res = await generateImagesForProduct(produkt([{ url_or_base64: 'https://x/1.jpg' }]), {
      referenceImage: { url_or_base64: 'https://x/1.jpg' },
    });

    expect(res.images.every((b) => b.pixeltreu === false)).toBe(true);
    delete process.env.GALLERY_PIXEL_FAITHFUL;
  });
});


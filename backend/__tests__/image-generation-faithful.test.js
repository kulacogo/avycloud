/**
 * Tests für services/image-generation.js — Ansichten werden AUFBEREITET, nicht erfunden.
 *
 * Vorfall 2026-09-02: der Dienst verlangte vier feste Perspektiven (3/4-Front,
 * 45-Grad-Seite, Makro-Detail, RÜCKANSICHT) und schickte dem Modell dazu genau
 * EIN Foto — er sammelte bis zu vier echte Bilder und nutzte `referenceDataUrls[0]`.
 * Drei der vier Ansichten hatte nie jemand fotografiert.
 *
 * Diese Datei hält fest, dass das nicht wiederkommt.
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

function klassifikation(views) {
  return { views, sameProductThroughout: true, model: 'test' };
}

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

describe('erfindet keine Ansichten mehr', () => {
  it('erzeugt KEINE Rueckansicht, wenn nur die Vorderseite fotografiert ist', async () => {
    classifySpy.mockResolvedValue(
      klassifikation([
        { index: 0, viewpoint: 'front', showsProduct: true, fullyVisible: true, usableAsReference: true, confidence: 0.95 },
      ])
    );

    const res = await generateImagesForProduct(produkt([{ url_or_base64: 'https://x/1.jpg' }]), {
      referenceImage: { url_or_base64: 'https://x/1.jpg' },
    });

    expect(res.images.map((i) => i.viewpoint)).toEqual(['front']);
    const back = res.skipped.find((s) => s.viewpoint === 'back');
    expect(back.reason).toBe('kein_foto');
    expect(generateSpy).toHaveBeenCalledTimes(1);
  });

  it('erzeugt die Rueckansicht, SOBALD ein echtes Rueckfoto vorliegt', async () => {
    classifySpy.mockResolvedValue(
      klassifikation([
        { index: 0, viewpoint: 'front', showsProduct: true, fullyVisible: true, usableAsReference: true, confidence: 0.95 },
        { index: 1, viewpoint: 'back', showsProduct: true, fullyVisible: true, usableAsReference: true, confidence: 0.9 },
      ])
    );

    const res = await generateImagesForProduct(
      produkt([{ url_or_base64: 'https://x/1.jpg' }, { url_or_base64: 'https://x/2.jpg' }]),
      { referenceImage: { url_or_base64: 'https://x/1.jpg' } }
    );

    expect(res.images.map((i) => i.viewpoint).sort()).toEqual(['back', 'front']);
  });

  it('bereitet ohne Ansichtserkennung NUR das gewaehlte Foto auf', async () => {
    classifySpy.mockResolvedValue(null);

    const res = await generateImagesForProduct(
      produkt([{ url_or_base64: 'https://x/1.jpg' }, { url_or_base64: 'https://x/2.jpg' }]),
      { referenceImage: { url_or_base64: 'https://x/1.jpg' } }
    );

    expect(res.images).toHaveLength(1);
    expect(res.skipped.some((s) => s.reason === 'keine_ansichtserkennung')).toBe(true);
  });
});

describe('alle echten Fotos gehen als Referenz mit', () => {
  it('sendet GENAU EIN Referenzbild je Ansicht — keine Identitaetsanker', async () => {
    // Korrektur 2026-09-04: zusaetzliche Fotos als "Anker" liessen das Modell die
    // Vorlagen mischen; das Ergebnis zeigte ein Produkt, das keinem Foto entsprach.
    // Eine Ansicht wird aus GENAU EINEM echten Foto aufbereitet.
    classifySpy.mockResolvedValue(
      klassifikation([
        { index: 0, viewpoint: 'front', showsProduct: true, fullyVisible: true, usableAsReference: true, confidence: 0.95 },
      ])
    );

    await generateImagesForProduct(
      produkt([
        { url_or_base64: 'https://x/1.jpg' },
        { url_or_base64: 'https://x/2.jpg' },
        { url_or_base64: 'https://x/3.jpg' },
      ]),
      { referenceImage: { url_or_base64: 'https://x/1.jpg' } }
    );

    expect(generateSpy.mock.calls[0][0].referenceImages).toHaveLength(1);
  });

  it('nimmt fuer jede Ansicht IHR eigenes Quellfoto', async () => {
    classifySpy.mockResolvedValue(
      klassifikation([
        { index: 0, viewpoint: 'side', showsProduct: true, fullyVisible: true, usableAsReference: true, confidence: 0.9 },
        { index: 1, viewpoint: 'front', showsProduct: true, fullyVisible: true, usableAsReference: true, confidence: 0.95 },
      ])
    );

    const res = await generateImagesForProduct(
      produkt([{ url_or_base64: 'https://x/1.jpg' }, { url_or_base64: 'https://x/2.jpg' }]),
      { referenceImage: { url_or_base64: 'https://x/1.jpg' } }
    );

    const front = res.images.find((i) => i.viewpoint === 'front');
    const side = res.images.find((i) => i.viewpoint === 'side');
    expect(front.derivedFrom).toBe('https://x/2.jpg');
    expect(side.derivedFrom).toBe('https://x/1.jpg');
    // Jeder Aufruf traegt genau eine Vorlage.
    for (const call of generateSpy.mock.calls) {
      expect(call[0].referenceImages).toHaveLength(1);
    }
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
    classifySpy.mockResolvedValue(
      klassifikation([
        { index: 0, viewpoint: 'front', showsProduct: true, fullyVisible: true, usableAsReference: true, confidence: 0.95 },
      ])
    );

    const res = await generateImagesForProduct(produkt([{ url_or_base64: 'https://x/1.jpg' }]), {
      referenceImage: { url_or_base64: 'https://x/1.jpg' },
    });

    expect(res.images).toHaveLength(1);
    expect(res.images[0].warnings).toContain('Typenschild unscharf');
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
      expect(bild.variant).toBe(`studio_${bild.viewpoint}`);
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
    expect(res.plan.map((p) => p.viewpoint)).toEqual(['front']);
  });

  it('erzeugt nie zwei Ansichten aus derselben Vorlage', async () => {
    classifySpy.mockResolvedValue(
      klassifikation([
        { index: 0, viewpoint: 'front', showsProduct: true, fullyVisible: true, usableAsReference: true, confidence: 0.95 },
        { index: 1, viewpoint: 'back', showsProduct: true, fullyVisible: true, usableAsReference: true, confidence: 0.9 },
      ])
    );
    const res = await generateImagesForProduct(
      produkt([{ url_or_base64: 'https://x/1.jpg' }, { url_or_base64: 'https://x/2.jpg' }]),
      { referenceImage: { url_or_base64: 'https://x/1.jpg' } }
    );
    const quellen = res.images.map((i) => i.derivedFrom);
    expect(new Set(quellen).size).toBe(quellen.length);
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
    expect(res.report.producedVariants).toBe(1);
    expect(res.report.mode).toBe('faithful');
  });

  it('wirft ohne jedes echte Referenzbild', async () => {
    await expect(
      generateImagesForProduct(produkt([{ url_or_base64: 'https://x/ki.png', generatedByAi: true }]), {})
    ).rejects.toThrow(/reference image is required/i);
  });
});

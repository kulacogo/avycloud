/**
 * Tests fuer die Laufzeit-Aufloesung der Bild-Kantenziele in lib/storage.js.
 *
 * Vorher wurden MIN_/MAX_IMAGE_LONGEST_EDGE BEIM MODUL-LADEN gelesen. Jetzt
 * loest resolveEdgeTargets() zur Laufzeit auf, gespeist aus der neuen ENV
 * IMAGE_TARGET_LONGEST_EDGE (Default = heutiger Wert -> byte-identisch) und
 * IMAGE_UPSCALE_MODE ('on' = heute/Default, 'off' = nicht hochskalieren).
 *
 * CJS: require.cache-Patching statt vi.mock().
 */

require('../api/_patchGcp');

const sharp = require('sharp');
const { resolveEdgeTargets, normalizeImageBuffer } = require('../../lib/storage');

const ENV_KEYS = [
  'IMAGE_TARGET_LONGEST_EDGE',
  'IMAGE_UPSCALE_MODE',
  'MIN_IMAGE_LONGEST_EDGE',
  'MAX_IMAGE_LONGEST_EDGE',
];

let saved;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function makeJpeg(width, height) {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 200, g: 120, b: 40 },
    },
  })
    .jpeg({ quality: 90 })
    .toBuffer();
}

describe('resolveEdgeTargets — ohne ENV (heutiges Verhalten)', () => {
  it('liefert 1200/2000 und Upscale an', () => {
    expect(resolveEdgeTargets()).toEqual({ minEdge: 1200, maxEdge: 2000, upscale: true });
  });

  it('respektiert eine explizit uebergebene env-Map', () => {
    expect(resolveEdgeTargets({})).toEqual({ minEdge: 1200, maxEdge: 2000, upscale: true });
  });
});

describe('resolveEdgeTargets — mit ENV', () => {
  it('IMAGE_TARGET_LONGEST_EDGE hebt die Zielkante an', () => {
    process.env.IMAGE_TARGET_LONGEST_EDGE = '1600';
    expect(resolveEdgeTargets().minEdge).toBe(1600);
  });

  it('faellt ohne IMAGE_TARGET_LONGEST_EDGE auf MIN_IMAGE_LONGEST_EDGE zurueck', () => {
    process.env.MIN_IMAGE_LONGEST_EDGE = '1000';
    expect(resolveEdgeTargets().minEdge).toBe(1000);
  });

  it('IMAGE_TARGET_LONGEST_EDGE gewinnt gegen MIN_IMAGE_LONGEST_EDGE', () => {
    process.env.MIN_IMAGE_LONGEST_EDGE = '1000';
    process.env.IMAGE_TARGET_LONGEST_EDGE = '1600';
    expect(resolveEdgeTargets().minEdge).toBe(1600);
  });

  it('MAX_IMAGE_LONGEST_EDGE bleibt steuerbar', () => {
    process.env.MAX_IMAGE_LONGEST_EDGE = '2400';
    expect(resolveEdgeTargets().maxEdge).toBe(2400);
  });

  it('ignoriert Muell-Werte und faellt auf die Defaults zurueck', () => {
    process.env.IMAGE_TARGET_LONGEST_EDGE = 'abc';
    process.env.MAX_IMAGE_LONGEST_EDGE = '';
    expect(resolveEdgeTargets()).toEqual({ minEdge: 1200, maxEdge: 2000, upscale: true });
  });

  it('wird zur LAUFZEIT gelesen, nicht beim Modul-Laden', () => {
    expect(resolveEdgeTargets().minEdge).toBe(1200);
    process.env.IMAGE_TARGET_LONGEST_EDGE = '1800';
    expect(resolveEdgeTargets().minEdge).toBe(1800);
    delete process.env.IMAGE_TARGET_LONGEST_EDGE;
    expect(resolveEdgeTargets().minEdge).toBe(1200);
  });
});

describe('resolveEdgeTargets — IMAGE_UPSCALE_MODE', () => {
  it("Default und 'on' erlauben Hochskalieren", () => {
    expect(resolveEdgeTargets().upscale).toBe(true);
    process.env.IMAGE_UPSCALE_MODE = 'on';
    expect(resolveEdgeTargets().upscale).toBe(true);
  });

  it("'off' (case-insensitive, getrimmt) verbietet Hochskalieren", () => {
    for (const v of ['off', 'OFF', ' Off ']) {
      process.env.IMAGE_UPSCALE_MODE = v;
      expect(resolveEdgeTargets().upscale).toBe(false);
    }
  });

  it('unbekannte Werte bleiben beim heutigen Verhalten', () => {
    process.env.IMAGE_UPSCALE_MODE = 'vielleicht';
    expect(resolveEdgeTargets().upscale).toBe(true);
  });
});

describe('normalizeImageBuffer — Kantenziel + Upscale-Modus', () => {
  it('skaliert ohne ENV wie bisher auf 1200 hoch', async () => {
    const buf = await makeJpeg(600, 400);
    const out = await normalizeImageBuffer(buf, 'image/jpeg');
    expect(out.width).toBe(1200);
    expect(out.upscaled).toBe(true);
    expect(out.sourceWidth).toBe(600);
    expect(out.sourceHeight).toBe(400);
    expect(out.mimeType).toBe('image/jpeg');
    expect(Buffer.isBuffer(out.buffer)).toBe(true);
  });

  it('IMAGE_TARGET_LONGEST_EDGE=1600 skaliert auf 1600', async () => {
    process.env.IMAGE_TARGET_LONGEST_EDGE = '1600';
    const buf = await makeJpeg(600, 400);
    const out = await normalizeImageBuffer(buf, 'image/jpeg');
    expect(out.width).toBe(1600);
    expect(out.upscaled).toBe(true);
  });

  it('IMAGE_UPSCALE_MODE=off laesst kleine Bilder unangetastet', async () => {
    process.env.IMAGE_TARGET_LONGEST_EDGE = '1600';
    process.env.IMAGE_UPSCALE_MODE = 'off';
    const buf = await makeJpeg(600, 400);
    const out = await normalizeImageBuffer(buf, 'image/jpeg');
    expect(out.width).toBe(600);
    expect(out.height).toBe(400);
    expect(out.upscaled).toBe(false);
  });

  it('IMAGE_UPSCALE_MODE=off verkleinert zu grosse Bilder weiterhin', async () => {
    process.env.IMAGE_UPSCALE_MODE = 'off';
    process.env.MAX_IMAGE_LONGEST_EDGE = '800';
    const buf = await makeJpeg(1600, 900);
    const out = await normalizeImageBuffer(buf, 'image/jpeg');
    expect(out.width).toBe(800);
    expect(out.upscaled).toBe(false);
    expect(out.sourceWidth).toBe(1600);
  });

  it('laesst Bilder im Zielkorridor unveraendert', async () => {
    const buf = await makeJpeg(1500, 1000);
    const out = await normalizeImageBuffer(buf, 'image/jpeg');
    expect(out.width).toBe(1500);
    expect(out.height).toBe(1000);
    expect(out.upscaled).toBe(false);
  });

  it('behaelt bei Hochkant-Bildern die Hoehe als Zielkante', async () => {
    const buf = await makeJpeg(400, 600);
    const out = await normalizeImageBuffer(buf, 'image/jpeg');
    expect(out.height).toBe(1200);
    expect(out.upscaled).toBe(true);
  });

  it('faellt bei kaputtem Buffer auf den Originalpuffer zurueck', async () => {
    const junk = Buffer.from('kein bild');
    const out = await normalizeImageBuffer(junk, 'image/jpeg');
    expect(out.buffer).toBe(junk);
    expect(out.width).toBe(null);
    expect(out.upscaled).toBe(false);
    expect(out.sourceWidth).toBe(null);
  });
});

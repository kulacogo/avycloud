'use strict';

// Snapshot baseline test for Stage4 SOURCE_WEIGHTS migration (Phase A.1).
// Captures the SHA-256 of `runStage4Validation()` output across 5 fixtures to
// guarantee value-preserving migration from local SOURCE_BASE_SCORES to the
// central SOURCE_WEIGHTS map in lib/confidence-scoring.js.
//
// If a drift is introduced (e.g. by overriding values for keys present in
// central with different values), this test fails LOUDLY — STOP and report.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Patch dependencies before loading the module under test
const evaluateEbayReadyMock = vi.fn(() => ({
  ok: true,
  issues: [],
  issuesDetailed: [],
  snapshot: { fingerprint: 'static-for-snapshot' },
}));
const scoreGpsrMock = vi.fn(() => 8);

const dsqPath = require.resolve('../../lib/datasheet-quality');
require(dsqPath);
require.cache[dsqPath] = {
  id: dsqPath,
  filename: dsqPath,
  loaded: true,
  exports: { evaluateEbayReady: evaluateEbayReadyMock },
};

const gpsrPath = require.resolve('../../lib/gpsr-manufacturer-registry');
require(gpsrPath);
require.cache[gpsrPath] = {
  id: gpsrPath,
  filename: gpsrPath,
  loaded: true,
  exports: { scoreGpsr: scoreGpsrMock, getManufacturerGpsrByName: vi.fn() },
};

const { runStage4Validation } = require('../../lib/identify-v3-stage4');

const SNAPSHOT_DIR = path.join(__dirname, '..', '__snapshots__');
const SNAPSHOT_FILE = path.join(SNAPSHOT_DIR, 'identify-v3-stage4-snapshot.snap');

function sha256(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex');
}

function readSnapshots() {
  if (!fs.existsSync(SNAPSHOT_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeSnapshots(snapshots) {
  if (!fs.existsSync(SNAPSHOT_DIR)) fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshots, null, 2) + '\n', 'utf8');
}

// ----- Fixtures -----

const FIXTURES = {
  // Fixture 1: Full happy path — branded electronics with multi-source agreement.
  full_happy_path: {
    stage1: {
      identity: { brand: 'Sony', internalCategory: 'Elektronik > Kopfhoerer', mpn: 'WH1000XM5' },
      barcodes: { ean: '4548736132610', gtin: '', upc: '', ranked: [{ code: '4548736132610' }] },
      eanLookup: { brand: 'Sony' },
      ocrPayload: { barcodes: ['4548736132610'] },
    },
    stage2: {
      category: { ebayId: '112529', ebayBreadcrumb: 'TV, Video & Audio > Kopfhoerer' },
      pricing: { amount: 289, currency: 'EUR', via: 'web', sources: [] },
      gpsr: { found: true, data: { manufacturer_name: 'Sony Europe B.V.', manufacturer_address: 'Berlin' } },
      barcodeConfirmation: { confirmed: true },
      requiredAspects: ['Marke', 'Modell', 'Farbe'],
    },
    stage3: {
      title_ebay: 'Sony WH-1000XM5 Bluetooth Kopfhoerer Schwarz',
      title_kaufland: 'Sony WH-1000XM5 Noise-Cancelling Kopfhoerer',
      description_ebay: '<p>Premium Kopfhoerer</p>',
      description_kaufland: '<p>Premium Kopfhoerer</p>',
      item_specifics: [
        { key: 'Marke', value: 'Sony' },
        { key: 'Modell', value: 'WH-1000XM5' },
        { key: 'Farbe', value: 'Schwarz' },
      ],
      key_features: ['Noise-Cancelling', 'Bluetooth 5.2'],
    },
    product: {
      identification: { name: 'Sony WH-1000XM5', brand: 'Sony', category: 'Kopfhoerer' },
      details: {
        attributes: { Marke: 'Sony' },
        images: [{ url_or_base64: 'https://example.com/img.jpg' }],
        pricing: { lowest_price: { amount: 289, currency: 'EUR', sources: [{ url: 'https://x.com' }] } },
        gpsr: { manufacturer_name: 'Sony Europe B.V.' },
      },
    },
  },

  // Fixture 2: Single-source path — only grounding agrees, no multi-source boost.
  single_source: {
    stage1: {
      identity: { brand: 'Acme', internalCategory: 'Haushalt' },
      barcodes: { ean: '', gtin: '', upc: '', ranked: [] },
      eanLookup: null,
      ocrPayload: { barcodes: [] },
    },
    stage2: {
      category: { ebayId: '', ebayBreadcrumb: '' },
      pricing: { amount: 19, currency: 'EUR', via: 'web' },
      gpsr: { found: false, data: null },
      barcodeConfirmation: { confirmed: false },
      requiredAspects: ['Marke'],
    },
    stage3: {
      title_ebay: 'Acme Haushaltsartikel',
      title_kaufland: 'Acme Haushaltsartikel',
      description_ebay: '',
      description_kaufland: '',
      item_specifics: [{ key: 'Marke', value: 'Acme' }],
      key_features: [],
    },
    product: {
      identification: { name: 'Acme', brand: 'Acme' },
      details: { attributes: { Marke: 'Acme' }, images: [], pricing: {}, gpsr: null },
    },
  },

  // Fixture 3: Disagreement — stage1.identity disagrees with eanLookup brand.
  disagreement: {
    stage1: {
      identity: { brand: 'Sony' },
      barcodes: { ean: '4006381333931' },
      eanLookup: { brand: 'Samsung' }, // disagrees
      ocrPayload: { barcodes: ['4006381333931'] },
    },
    stage2: {
      category: { ebayId: '999', ebayBreadcrumb: 'A > B' },
      pricing: { amount: 50, currency: 'EUR', via: 'grounding' },
      gpsr: { found: false, data: null },
      barcodeConfirmation: { confirmed: false },
      requiredAspects: [],
    },
    stage3: {
      title_ebay: 'Mystery Box',
      title_kaufland: '',
      description_ebay: '',
      description_kaufland: '',
      item_specifics: [],
      key_features: [],
    },
    product: { identification: {}, details: {} },
  },

  // Fixture 4: Empty/minimal data — exercises `|| 0.5` fallback paths.
  empty_minimal: {
    stage1: { identity: {}, barcodes: {}, eanLookup: null, ocrPayload: {} },
    stage2: { category: {}, pricing: {}, gpsr: {}, barcodeConfirmation: {}, requiredAspects: [] },
    stage3: {},
    product: { identification: {}, details: {} },
  },

  // Fixture 5: Pricing via OCR — exercises stage2.pricing.via='ocr' path
  // which currently maps to SOURCE_BASE_SCORES.ocr=0.6 (drift candidate).
  pricing_via_ocr: {
    stage1: {
      identity: { brand: 'Bosch' },
      barcodes: { ean: '4242002889771' },
      eanLookup: { brand: 'Bosch' },
      ocrPayload: { barcodes: ['4242002889771'] },
    },
    stage2: {
      category: { ebayId: '20710', ebayBreadcrumb: 'Heimwerker > Werkzeug' },
      pricing: { amount: 199.5, currency: 'EUR', via: 'ocr' },
      gpsr: { found: true, data: { manufacturer_name: 'Robert Bosch GmbH', manufacturer_address: 'Stuttgart' } },
      barcodeConfirmation: { confirmed: true },
      requiredAspects: ['Marke', 'Modell'],
    },
    stage3: {
      title_ebay: 'Bosch Akkuschrauber GSR 12V',
      title_kaufland: 'Bosch Akkuschrauber',
      description_ebay: '<p>Profi-Akkuschrauber</p>',
      description_kaufland: '<p>Profi-Akkuschrauber</p>',
      item_specifics: [
        { key: 'Marke', value: 'Bosch' },
        { key: 'Modell', value: 'GSR 12V' },
      ],
      key_features: ['12V Lithium-Ionen'],
    },
    product: {
      identification: { name: 'Bosch GSR 12V', brand: 'Bosch' },
      details: {
        attributes: { Marke: 'Bosch' },
        images: [{ url_or_base64: 'https://example.com/bosch.jpg' }],
        pricing: { lowest_price: { amount: 199.5, currency: 'EUR' } },
        gpsr: { manufacturer_name: 'Robert Bosch GmbH' },
      },
    },
  },
};

// ----- Tests -----

describe('identify-v3-stage4 snapshot baseline (SOURCE_WEIGHTS migration)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-10T00:00:00Z'));
    vi.clearAllMocks();
    evaluateEbayReadyMock.mockReturnValue({
      ok: true,
      issues: [],
      issuesDetailed: [],
      snapshot: { fingerprint: 'static-for-snapshot' },
    });
    scoreGpsrMock.mockReturnValue(8);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const updateMode = process.env.UPDATE_SNAPSHOT === '1';

  for (const [name, fx] of Object.entries(FIXTURES)) {
    it(`output hash for fixture "${name}" is stable`, () => {
      const result = runStage4Validation(fx.stage1, fx.stage2, fx.stage3, fx.product);
      const hash = sha256(result);

      const snapshots = readSnapshots();
      const previous = snapshots[name];

      if (!previous || updateMode) {
        snapshots[name] = hash;
        writeSnapshots(snapshots);
        // First run records the baseline; nothing to assert besides stability.
        expect(hash).toMatch(/^[a-f0-9]{64}$/);
        return;
      }

      expect(hash).toBe(previous);
    });
  }

  it('all 5 fixtures produce distinct hashes (sanity)', () => {
    const hashes = new Set();
    for (const [, fx] of Object.entries(FIXTURES)) {
      const result = runStage4Validation(fx.stage1, fx.stage2, fx.stage3, fx.product);
      hashes.add(sha256(result));
    }
    expect(hashes.size).toBe(Object.keys(FIXTURES).length);
  });

  // Guard: ensure no central key was overridden when adding stage4 aliases.
  it('SOURCE_WEIGHTS has all stage4 aliases plus pre-existing central keys', () => {
    const { SOURCE_WEIGHTS } = require('../../lib/confidence-scoring');
    const keys = Object.keys(SOURCE_WEIGHTS);

    // 14 pre-existing central keys + 6 stage4 aliases = 20
    expect(keys.length).toBe(20);

    // Stage4 aliases present
    expect(SOURCE_WEIGHTS.grounding).toBe(0.70);
    expect(SOURCE_WEIGHTS.barcode_confirm).toBe(0.90);
    expect(SOURCE_WEIGHTS.ebay_browse).toBe(0.70);
    expect(SOURCE_WEIGHTS.registry).toBe(0.85);
    expect(SOURCE_WEIGHTS.llm_generated).toBe(0.65);
    expect(SOURCE_WEIGHTS.web).toBe(0.60);

    // Pre-existing central keys untouched
    expect(SOURCE_WEIGHTS.ebay_catalog).toBe(0.95);
    expect(SOURCE_WEIGHTS.gs1_verified).toBe(0.98);
    expect(SOURCE_WEIGHTS.ean_db).toBe(0.85);
    expect(SOURCE_WEIGHTS.ocr).toBe(0.65);
  });
});

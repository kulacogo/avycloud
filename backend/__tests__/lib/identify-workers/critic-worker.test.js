'use strict';

/**
 * Tests for backend/lib/identify-workers/critic-worker.js
 *
 * Strategy:
 *   - Patch ../../../lib/datasheet-quality via require.cache (we want to drive
 *     baseReport.ok/issues deterministically without pulling rulebook config).
 *   - Patch ../../../lib/ebay-taxonomy to control required aspects for
 *     scenarios without a real categoryId lookup.
 *   - Inject a fake aiClient into context for Flash-Call tests.
 *
 * CommonJS + Vitest 4.x (globals: true).
 */

const path = require('path');

const datasheetQualityPath = require.resolve('../../../lib/datasheet-quality');
const ebayTaxonomyPath = require.resolve('../../../lib/ebay-taxonomy');
const criticWorkerPath = require.resolve('../../../lib/identify-workers/critic-worker');

const ORIGINAL_ENV = { ...process.env };

let evaluateEbayReadyMock;
let getRequiredAspectsMock;

function installModuleStubs() {
  // Patch datasheet-quality
  require.cache[datasheetQualityPath] = {
    id: datasheetQualityPath,
    filename: datasheetQualityPath,
    loaded: true,
    exports: {
      evaluateEbayReady: (...args) => evaluateEbayReadyMock(...args),
    },
  };
  // Patch ebay-taxonomy (only getRequiredAspects matters here)
  require.cache[ebayTaxonomyPath] = {
    id: ebayTaxonomyPath,
    filename: ebayTaxonomyPath,
    loaded: true,
    exports: {
      getRequiredAspects: (...args) => getRequiredAspectsMock(...args),
    },
  };
}

function resetEnv() {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.IDENTIFY_V4_CRITIC_FLASH;
  delete process.env.QUALITY_GATE_ENABLED;
}

function loadCritic() {
  delete require.cache[criticWorkerPath];
  return require('../../../lib/identify-workers/critic-worker');
}

function baseProduct(overrides = {}) {
  return {
    identification: {
      name: 'Sony WH-1000XM5 Wireless Noise-Cancelling Kopfhörer Schwarz Bluetooth Over-Ear Headphones',
      category: 'Elektronik > Audio > Kopfhörer',
    },
    details: {
      description:
        'Der Sony WH-1000XM5 bietet branchenführende Geräuschunterdrückung und erstklassigen Klang. Mit bis zu 30 Stunden Akkulaufzeit, adaptivem Sound-Control und Multipoint-Bluetooth-Verbindung ist er der perfekte Kopfhörer für den Alltag. Inklusive USB-C-Schnellladung. Perfekt für Reisen, Pendeln und konzentriertes Arbeiten.',
      short_description: 'Wireless NC Kopfhörer',
      categoryId: '112529',
      key_features: ['30h Akku', 'NC', 'Bluetooth', 'USB-C', 'Multipoint'],
      attributes: {
        Marke: 'Sony',
        Modell: 'WH-1000XM5',
        Farbe: 'Schwarz',
        Konnektivität: 'Bluetooth',
        Typ: 'Over-Ear',
      },
      images: [
        { url: 'https://example.com/img1.jpg' },
        { url: 'https://example.com/img2.jpg' },
        { url: 'https://example.com/img3.jpg' },
      ],
      pricing: {
        lowest_price: {
          amount: 299.99,
          sources: [{ url: 'https://example.com/source' }],
        },
      },
      gpsr: {
        manufacturer_name: 'Sony Europe B.V.',
        manufacturer_address: 'The Heights, Brooklands, Weybridge, Surrey, KT13 0XW, UK',
      },
    },
    ops: {
      image_quality: {
        items: [
          { meetsMinResolution: true },
          { meetsMinResolution: true },
          { meetsMinResolution: true },
        ],
      },
    },
    ...overrides,
  };
}

describe('critic-worker', () => {
  beforeEach(() => {
    resetEnv();
    evaluateEbayReadyMock = () => ({
      ok: true,
      issues: [],
      issuesDetailed: [],
      missingRequiredAspects: [],
      snapshot: {},
    });
    getRequiredAspectsMock = () => [];
    installModuleStubs();
  });

  afterAll(() => {
    delete require.cache[datasheetQualityPath];
    delete require.cache[ebayTaxonomyPath];
    delete require.cache[criticWorkerPath];
    process.env = { ...ORIGINAL_ENV };
  });

  it('returns ok:true and shape = { resolved, confidence, sources, retriesRequested, meta }', async () => {
    const { runCriticWorker } = loadCritic();
    const result = await runCriticWorker({ product: baseProduct() });
    expect(result.ok).toBe(true);
    expect(result.domain).toBe('critic');
    expect(result.resolved).toBeDefined();
    expect(result.resolved.critiqued).toBe(true);
    expect(Array.isArray(result.resolved.issues)).toBe(true);
    expect(Array.isArray(result.resolved.fix_hints)).toBe(true);
    expect(Array.isArray(result.resolved.refinement_needed_workers)).toBe(true);
    expect(typeof result.resolved.ebay_ready_score).toBe('number');
    expect(typeof result.resolved.aspect_cap_applied).toBe('boolean');
    expect(result.confidence).toHaveProperty('ebay_ready');
    expect(Array.isArray(result.sources)).toBe(true);
    expect(Array.isArray(result.retriesRequested)).toBe(true);
    expect(result.meta).toHaveProperty('durationMs');
    expect(result.meta).toHaveProperty('geminiCalls');
  });

  it('1. Perfect product: valid GTIN, 5+ images, all fields → score >= 0.95, empty issues', async () => {
    const { runCriticWorker } = loadCritic();
    const product = baseProduct();
    product.identification.ean = '4548736133686'; // valid EAN-13
    product.details.images = Array.from({ length: 5 }).map((_, i) => ({ url: `https://img/${i}.jpg` }));
    product.ops.image_quality.items = Array.from({ length: 5 }).map(() => ({ meetsMinResolution: true }));
    const result = await runCriticWorker({ product, requiredAspects: ['Marke', 'Modell', 'Farbe'] });
    expect(result.ok).toBe(true);
    expect(result.resolved.issues).toEqual([]);
    expect(result.resolved.ebay_ready_score).toBeGreaterThanOrEqual(0.95);
    expect(result.resolved.refinement_needed_workers).toEqual([]);
  });

  it('2. Invalid GTIN → severity=error, refinement_needed_workers includes "identity"', async () => {
    const { runCriticWorker } = loadCritic();
    const product = baseProduct();
    product.identification.ean = '4548736133687'; // wrong check digit
    const result = await runCriticWorker({ product, requiredAspects: [] });
    const gtinIssue = result.resolved.issues.find((i) => i.field === 'ean');
    expect(gtinIssue).toBeDefined();
    expect(gtinIssue.severity).toBe('error');
    expect(result.resolved.refinement_needed_workers).toContain('identity');
  });

  it('3. Missing required aspects → issue + refinement_needed_workers=["attributes"]', async () => {
    const { runCriticWorker } = loadCritic();
    const product = baseProduct();
    product.details.attributes = { Farbe: 'Schwarz' };
    const result = await runCriticWorker({
      product,
      requiredAspects: ['Marke', 'Modell', 'Typ', 'Konnektivität'],
    });
    const requiredIssue = result.resolved.issues.find((i) => i.field === 'required_aspects');
    expect(requiredIssue).toBeDefined();
    expect(requiredIssue.severity).toBe('error');
    expect(result.resolved.refinement_needed_workers).toContain('attributes');
  });

  it('4. Aspect-cap triggered (>45 aspects) → aspect_cap_applied=true', async () => {
    const { runCriticWorker } = loadCritic();
    const product = baseProduct();
    const manyAttrs = {};
    for (let i = 0; i < 60; i += 1) manyAttrs[`Aspect${i}`] = `value${i}`;
    product.details.attributes = manyAttrs;
    const result = await runCriticWorker({ product, requiredAspects: [] });
    expect(result.resolved.aspect_cap_applied).toBe(true);
  });

  it('5. Missing GPSR → severity=warning, refinement_needed_workers includes "gpsr"', async () => {
    const { runCriticWorker } = loadCritic();
    const product = baseProduct();
    delete product.details.gpsr;
    const result = await runCriticWorker({ product, requiredAspects: [] });
    const gpsrIssue = result.resolved.issues.find((i) => i.field === 'gpsr');
    expect(gpsrIssue).toBeDefined();
    expect(gpsrIssue.severity).toBe('warning');
    expect(result.resolved.refinement_needed_workers).toContain('gpsr');
  });

  it('6. Missing images → issue, refinement_needed_workers includes "image"', async () => {
    const { runCriticWorker } = loadCritic();
    const product = baseProduct();
    product.details.images = [];
    product.ops.image_quality = { items: [] };
    const result = await runCriticWorker({ product, requiredAspects: [] });
    const imgIssue = result.resolved.issues.find((i) => i.field === 'images');
    expect(imgIssue).toBeDefined();
    expect(result.resolved.refinement_needed_workers).toContain('image');
  });

  it('7. Multiple issues → refinement_needed_workers is deduped', async () => {
    const { runCriticWorker } = loadCritic();
    // 2 attributes issues + 2 seo issues — should dedupe to one each
    evaluateEbayReadyMock = () => ({
      ok: false,
      issues: [],
      issuesDetailed: [
        { field: 'title', severity: 'error', message: 'title_too_short', code: 'title_too_short' },
        { field: 'description', severity: 'error', message: 'desc_too_short', code: 'description_too_short' },
        { field: 'required_aspects', severity: 'error', message: 'missing x', code: 'missing_required_aspects' },
      ],
      missingRequiredAspects: ['Foo'],
    });
    const product = baseProduct();
    delete product.details.gpsr; // adds another worker
    const result = await runCriticWorker({
      product,
      requiredAspects: ['Foo'],
    });
    const workers = result.resolved.refinement_needed_workers;
    const unique = Array.from(new Set(workers));
    expect(workers.length).toBe(unique.length);
    expect(workers).toEqual(expect.arrayContaining(['seo', 'attributes', 'gpsr']));
  });

  it('8. Score correctly weighted: 3 errors → ~0.55', async () => {
    const { runCriticWorker } = loadCritic();
    evaluateEbayReadyMock = () => ({
      ok: false,
      issues: [],
      issuesDetailed: [
        { field: 'title', severity: 'error', message: 'title_err', code: 'title_x' },
        { field: 'description', severity: 'error', message: 'desc_err', code: 'desc_x' },
        { field: 'price', severity: 'error', message: 'price_err', code: 'price_missing' },
      ],
    });
    // Keep a clean product (GTIN ok, GPSR ok, images ok) so ONLY mocked errors count.
    const product = baseProduct();
    product.identification.ean = '4548736133686';
    const result = await runCriticWorker({ product, requiredAspects: [] });
    // 1.0 - 3 * 0.15 = 0.55
    expect(result.resolved.ebay_ready_score).toBeCloseTo(0.55, 2);
  });

  it('9. ok:true even when 20 issues present (non-blocking)', async () => {
    const { runCriticWorker } = loadCritic();
    const many = Array.from({ length: 20 }).map((_, i) => ({
      field: 'title',
      severity: 'error',
      message: `issue_${i}`,
      code: `title_${i}`,
    }));
    evaluateEbayReadyMock = () => ({
      ok: false,
      issues: [],
      issuesDetailed: many,
    });
    const result = await runCriticWorker({ product: baseProduct(), requiredAspects: [] });
    expect(result.ok).toBe(true);
    expect(result.resolved.issues.length).toBeGreaterThanOrEqual(20);
    // Score clamped at 0 — never negative.
    expect(result.resolved.ebay_ready_score).toBe(0);
  });

  it('10. Flash-Call: mocked aiClient returns JSON → fix_hints populated', async () => {
    const { runCriticWorker } = loadCritic();
    evaluateEbayReadyMock = () => ({
      ok: false,
      issues: [],
      issuesDetailed: [
        { field: 'title', severity: 'error', message: 'title_short', code: 'title_too_short' },
      ],
    });
    const fakeClient = {
      models: {
        generateContent: async () => ({
          text: JSON.stringify([
            { worker: 'seo', suggestion: 'Titel auf mindestens 65 Zeichen erweitern' },
            { worker: 'attributes', suggestion: 'Marke hinzufügen' },
          ]),
        }),
      },
    };
    const result = await runCriticWorker({
      product: baseProduct(),
      aiClient: fakeClient,
      requiredAspects: [],
    });
    expect(result.resolved.fix_hints.length).toBe(2);
    expect(result.resolved.fix_hints[0]).toEqual({
      worker: 'seo',
      suggestion: 'Titel auf mindestens 65 Zeichen erweitern',
    });
    expect(result.meta.geminiCalls).toBe(1);
  });

  it('11. Flash-Call error → fix_hints empty, no crash', async () => {
    const { runCriticWorker } = loadCritic();
    evaluateEbayReadyMock = () => ({
      ok: false,
      issues: [],
      issuesDetailed: [
        { field: 'title', severity: 'error', message: 'title_short', code: 'title_too_short' },
      ],
    });
    const fakeClient = {
      models: {
        generateContent: async () => {
          throw new Error('gemini_flash_timeout');
        },
      },
    };
    const result = await runCriticWorker({
      product: baseProduct(),
      aiClient: fakeClient,
      requiredAspects: [],
    });
    expect(result.ok).toBe(true);
    expect(result.resolved.fix_hints).toEqual([]);
    expect(result.meta.error).toMatch(/flash|timeout/i);
  });

  it('12. IDENTIFY_V4_CRITIC_FLASH=false → no Flash call made', async () => {
    process.env.IDENTIFY_V4_CRITIC_FLASH = 'false';
    const { runCriticWorker } = loadCritic();
    evaluateEbayReadyMock = () => ({
      ok: false,
      issues: [],
      issuesDetailed: [
        { field: 'title', severity: 'error', message: 'title_short', code: 'title_too_short' },
      ],
    });
    let called = 0;
    const fakeClient = {
      models: {
        generateContent: async () => {
          called += 1;
          return { text: '[]' };
        },
      },
    };
    const result = await runCriticWorker({
      product: baseProduct(),
      aiClient: fakeClient,
      requiredAspects: [],
    });
    expect(called).toBe(0);
    expect(result.resolved.fix_hints).toEqual([]);
    expect(result.meta.geminiCalls).toBe(0);
  });

  it('13. Flash-Call with malformed JSON response → fix_hints empty, ok still true', async () => {
    const { runCriticWorker } = loadCritic();
    evaluateEbayReadyMock = () => ({
      ok: false,
      issues: [],
      issuesDetailed: [
        { field: 'title', severity: 'error', message: 'bad', code: 'title_x' },
      ],
    });
    const fakeClient = {
      models: {
        generateContent: async () => ({ text: 'not-valid-json{' }),
      },
    };
    const result = await runCriticWorker({
      product: baseProduct(),
      aiClient: fakeClient,
      requiredAspects: [],
    });
    expect(result.ok).toBe(true);
    expect(result.resolved.fix_hints).toEqual([]);
    expect(result.meta.geminiCalls).toBe(1);
  });

  it('14. Critic never throws even if evaluateEbayReady blows up', async () => {
    const { runCriticWorker } = loadCritic();
    evaluateEbayReadyMock = () => {
      throw new Error('boom');
    };
    const result = await runCriticWorker({ product: baseProduct() });
    expect(result.ok).toBe(true);
    expect(result.meta.error).toMatch(/boom|evaluate_error/);
  });

  it('15. No GTIN present → no identity worker added', async () => {
    const { runCriticWorker } = loadCritic();
    const product = baseProduct();
    // Ensure no gtin/ean/upc
    delete product.identification.ean;
    delete product.identification.gtin;
    delete product.identification.upc;
    delete product.details.ean;
    delete product.details.gtin;
    delete product.details.upc;
    const result = await runCriticWorker({ product, requiredAspects: [] });
    expect(result.resolved.refinement_needed_workers).not.toContain('identity');
  });
});

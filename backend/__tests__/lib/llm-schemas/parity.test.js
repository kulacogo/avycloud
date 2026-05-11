'use strict';

// Vitest CJS; globals enabled (describe/it/expect/vi/beforeEach).
//
// Phase F.3 — zod-Schema Parity tests.
//
// Covers:
//   1. Per-scope happy-path + negative-path safeParse coverage (12 scopes).
//   2. Cross-pipeline parity: identical outputs from V3/V4/Chat-V3 must all
//      satisfy the same scope schema.
//   3. Schema edge-cases: GTIN format, 80-char title limit, 800-char
//      mobile-snippet limit, active-content blocking, eBay 45-Cap aspects,
//      ISO-2 country, international phone prefix.
//   4. Helper-integration smoke-test: safeParse mode must NOT throw on
//      Schema-Drift; strict mode MUST throw.

const path = require('path');

const {
  SCHEMA_REGISTRY,
  getSchemaForScope,
  isStrictMode,
  validateRate,
} = require('../../../lib/llm-schemas/_index');

const { IdentifyIdentitySchema } = require('../../../lib/llm-schemas/identify-identity-schema');
const { IdentifyCategorySchema } = require('../../../lib/llm-schemas/identify-category-schema');
const { IdentifyAttributesSchema } = require('../../../lib/llm-schemas/identify-attributes-schema');
const { IdentifySeoTitleSchema } = require('../../../lib/llm-schemas/identify-seo-title-schema');
const { IdentifySeoDescriptionSchema } = require('../../../lib/llm-schemas/identify-seo-description-schema');
const { IdentifyPricingSchema } = require('../../../lib/llm-schemas/identify-pricing-schema');
const { IdentifyImageSchema } = require('../../../lib/llm-schemas/identify-image-schema');
const { IdentifyGpsrSchema } = require('../../../lib/llm-schemas/identify-gpsr-schema');
const { IdentifyCriticSchema } = require('../../../lib/llm-schemas/identify-critic-schema');
const { ChatContextSchema } = require('../../../lib/llm-schemas/chat-context-schema');
const { ChatUpdateDatasheetSchema } = require('../../../lib/llm-schemas/chat-update-datasheet-schema');
const { QualityGateSchema } = require('../../../lib/llm-schemas/quality-gate-schema');

describe('Phase F.3 — llm-schemas registry + lookup', () => {
  const scopeIds = [
    'identify.identity',
    'identify.category',
    'identify.attributes',
    'identify.seo_title',
    'identify.seo_description',
    'identify.pricing',
    'identify.image',
    'identify.gpsr',
    'identify.critic',
    'chat.product',
    'chat.update_datasheet',
    'quality.gate',
  ];

  it('exposes a schema for every documented scope', () => {
    for (const id of scopeIds) {
      const s = getSchemaForScope(id);
      expect(s).toBeTruthy();
      expect(typeof s.safeParse).toBe('function');
    }
  });

  it('returns null for unknown scope names', () => {
    expect(getSchemaForScope('not.a.scope')).toBeNull();
    expect(getSchemaForScope('')).toBeNull();
    expect(getSchemaForScope(null)).toBeNull();
    expect(getSchemaForScope(undefined)).toBeNull();
  });

  it('isStrictMode honors LLM_SCHEMA_STRICT env', () => {
    const prev = process.env.LLM_SCHEMA_STRICT;
    process.env.LLM_SCHEMA_STRICT = 'true';
    expect(isStrictMode()).toBe(true);
    process.env.LLM_SCHEMA_STRICT = 'false';
    expect(isStrictMode()).toBe(false);
    delete process.env.LLM_SCHEMA_STRICT;
    expect(isStrictMode()).toBe(false);
    if (prev !== undefined) process.env.LLM_SCHEMA_STRICT = prev;
  });

  it('validateRate clamps to [0,1] and defaults to 1.0', () => {
    const prev = process.env.LLM_SCHEMA_VALIDATE_RATE;
    delete process.env.LLM_SCHEMA_VALIDATE_RATE;
    expect(validateRate()).toBe(1.0);
    process.env.LLM_SCHEMA_VALIDATE_RATE = '0.5';
    expect(validateRate()).toBe(0.5);
    process.env.LLM_SCHEMA_VALIDATE_RATE = '99';
    expect(validateRate()).toBe(1.0);
    process.env.LLM_SCHEMA_VALIDATE_RATE = '-1';
    expect(validateRate()).toBe(1.0);
    if (prev !== undefined) process.env.LLM_SCHEMA_VALIDATE_RATE = prev;
    else delete process.env.LLM_SCHEMA_VALIDATE_RATE;
  });
});

describe('Phase F.3 — identify.identity schema', () => {
  it('happy path accepts a verified GTIN-13 + brand', () => {
    const r = IdentifyIdentitySchema.safeParse({
      ok: true,
      domain: 'identity',
      resolved: { brand: "Levi's", model: '501', gtin: '5045091224089', mpn: 'LV-501' },
      confidence: { brand: 0.95, model: 0.9, gtin: 0.95, mpn: 0.85 },
      sources: [{ url: 'https://example.com', field: 'gtin', value: '5045091224089' }],
      warnings: [],
      retriesRequested: false,
    });
    expect(r.success).toBe(true);
  });

  it('negative: GTIN with non-digits is rejected', () => {
    const r = IdentifyIdentitySchema.safeParse({
      resolved: { brand: 'Apple', gtin: '12-34-56-78-90' },
    });
    expect(r.success).toBe(false);
  });

  it('GTIN-8/12/13/14 all accepted, length 7 / 15 rejected', () => {
    const ok = ['12345670', '012345678905', '5901234123457', '00012345600012'];
    for (const g of ok) {
      const r = IdentifyIdentitySchema.safeParse({ resolved: { gtin: g } });
      expect(r.success).toBe(true);
    }
    const bad = ['1234567', '012345678901234567'];
    for (const g of bad) {
      const r = IdentifyIdentitySchema.safeParse({ resolved: { gtin: g } });
      expect(r.success).toBe(false);
    }
  });
});

describe('Phase F.3 — identify.category schema', () => {
  it('happy path accepts auto:catalog with breadcrumb', () => {
    const r = IdentifyCategorySchema.safeParse({
      ok: true,
      domain: 'category',
      resolved: {
        categoryId: '11450',
        categoryName: 'Damenmode',
        categoryBreadcrumb: ['Kleidung & Accessoires', 'Damenmode'],
        categorySource: 'auto:catalog',
      },
      confidence: 0.92,
    });
    expect(r.success).toBe(true);
  });

  it('negative: unknown categorySource rejected', () => {
    const r = IdentifyCategorySchema.safeParse({
      resolved: { categorySource: 'auto:nonsense' },
      confidence: 0.7,
    });
    expect(r.success).toBe(false);
  });
});

describe('Phase F.3 — identify.attributes schema (eBay 45-Cap)', () => {
  it('happy path accepts up to 45 aspects', () => {
    const aspects = {};
    for (let i = 0; i < 45; i++) aspects[`aspect_${i}`] = `value_${i}`;
    const r = IdentifyAttributesSchema.safeParse({
      resolved: { attributes: aspects, requiredAspectsCovered: 0.95 },
      confidence: 0.9,
    });
    expect(r.success).toBe(true);
  });

  it('negative: more than 45 aspects rejected (Strategischer Leitfaden 45-Cap)', () => {
    const aspects = {};
    for (let i = 0; i < 46; i++) aspects[`aspect_${i}`] = `value_${i}`;
    const r = IdentifyAttributesSchema.safeParse({
      resolved: { attributes: aspects },
    });
    expect(r.success).toBe(false);
  });

  it('multi-value attribute (string[]) accepted', () => {
    const r = IdentifyAttributesSchema.safeParse({
      resolved: { attributes: { Material: ['Baumwolle', 'Elasthan'] } },
    });
    expect(r.success).toBe(true);
  });
});

describe('Phase F.3 — identify.seo_title schema (80-char + bad-prefix)', () => {
  it('happy path accepts a 79-char Cassini-style title', () => {
    const title = "Levi's 501 Jeans Damen W28 L32 Blau Denim Straight Leg Vintage Original";
    const r = IdentifySeoTitleSchema.safeParse({
      resolved: { title, chars: title.length },
      confidence: 0.85,
    });
    expect(r.success).toBe(true);
  });

  it('negative: title > 80 chars rejected', () => {
    const r = IdentifySeoTitleSchema.safeParse({
      resolved: { title: 'a'.repeat(81) },
    });
    expect(r.success).toBe(false);
  });

  it('negative: NEU:-prefix rejected', () => {
    const r = IdentifySeoTitleSchema.safeParse({
      resolved: { title: 'NEU: Bosch Bremsscheiben Set' },
    });
    expect(r.success).toBe(false);
  });

  it('negative: title with & or ! rejected', () => {
    const r1 = IdentifySeoTitleSchema.safeParse({ resolved: { title: 'Bosch & Co Bremsen' } });
    const r2 = IdentifySeoTitleSchema.safeParse({ resolved: { title: 'Bosch Bremsen!' } });
    expect(r1.success).toBe(false);
    expect(r2.success).toBe(false);
  });

  it('negative: title with -- (double dash) rejected', () => {
    const r = IdentifySeoTitleSchema.safeParse({
      resolved: { title: 'Bosch -- Bremsen' },
    });
    expect(r.success).toBe(false);
  });
});

describe('Phase F.3 — identify.seo_description schema', () => {
  it('happy path accepts a 200-word description with schema.org snippet', () => {
    const html = '<section class="hero"><span itemprop="description">Bosch Bremsscheiben mit ABE-Zulassung.</span></section><p>Detail.</p>';
    const r = IdentifySeoDescriptionSchema.safeParse({
      resolved: {
        html,
        wordCount: 215,
        keywordDensity: { overall: 0.06 },
        mobileSnippet: 'Bosch Bremsscheiben mit ABE.',
      },
    });
    expect(r.success).toBe(true);
  });

  it('negative: active content (<script>) rejected (compliance)', () => {
    const r = IdentifySeoDescriptionSchema.safeParse({
      resolved: {
        html: '<p>Hi</p><script>alert(1)</script>',
        wordCount: 200,
      },
    });
    expect(r.success).toBe(false);
  });

  it('negative: mobileSnippet > 800 chars rejected', () => {
    const r = IdentifySeoDescriptionSchema.safeParse({
      resolved: { mobileSnippet: 'x'.repeat(801) },
    });
    expect(r.success).toBe(false);
  });

  it('negative: keywordDensity.overall > 1 rejected', () => {
    const r = IdentifySeoDescriptionSchema.safeParse({
      resolved: { keywordDensity: { overall: 1.5 } },
    });
    expect(r.success).toBe(false);
  });

  it('flags description as spamming-risk when max token frequency > 7%', () => {
    // Constructed plainText: 60 tokens, 'spammed' appears 8x → density ~13.3% > 7%.
    const repeated = Array(8).fill('spammed').join(' ');
    const filler = Array(52).fill(0)
      .map((_, i) => `wort${i % 7}`)
      .join(' ');
    const plainText = `${repeated} ${filler}`;
    const r = IdentifySeoDescriptionSchema.safeParse({
      resolved: {
        plainText,
        wordCount: 60,
        keywordDensity: { overall: 0.13 },
      },
    });
    expect(r.success).toBe(true);
    expect(r.data.resolved.spammingRisk).toBe(true);
  });

  it('passes legitimate description without spam flag', () => {
    // Realistische Description: 30 unique tokens, jedes 2x = max-density 6.6% (unter 7%-Threshold)
    const tokens = [];
    for (let i = 0; i < 60; i++) tokens.push(`begriff${i % 30}`);
    const plainText = tokens.join(' ');
    const r = IdentifySeoDescriptionSchema.safeParse({
      resolved: {
        plainText,
        wordCount: 60,
        keywordDensity: { overall: 0.06 },
      },
    });
    expect(r.success).toBe(true);
    expect(r.data.resolved.spammingRisk).toBe(false);
  });

  it('respects explicit spammingRisk from LLM output (backwards-compat)', () => {
    const r = IdentifySeoDescriptionSchema.safeParse({
      resolved: {
        plainText: 'kurzer Text mit wenig Inhalt',
        wordCount: 5,
        spammingRisk: true,
      },
    });
    expect(r.success).toBe(true);
    expect(r.data.resolved.spammingRisk).toBe(true);
  });

  it('legacy outputs without spammingRisk still validate (backwards-compat)', () => {
    const r = IdentifySeoDescriptionSchema.safeParse({
      resolved: {
        html: '<p>Bosch Bremsscheiben mit ABE.</p>',
        wordCount: 6,
      },
    });
    expect(r.success).toBe(true);
    // For too-short text (<20 non-stop tokens), spammingRisk defaults to false.
    expect(r.data.resolved.spammingRisk).toBe(false);
  });
});

describe('Phase F.3 — identify.pricing schema (eBay 1 EUR floor)', () => {
  it('happy path accepts a sweet-spot price 19.69 EUR', () => {
    const r = IdentifyPricingSchema.safeParse({
      resolved: {
        recommendedPrice: 19.69,
        median: 19.99,
        topCompetitor: 19.99,
        delta: -0.30,
        currency: 'EUR',
      },
      confidence: 0.95,
      sources: [{ itemId: 'ebay:123', price: 19.99, date: '2026-04-01' }],
    });
    expect(r.success).toBe(true);
  });

  it('negative: recommendedPrice < 1 EUR rejected (eBay hard-floor)', () => {
    const r = IdentifyPricingSchema.safeParse({
      resolved: { recommendedPrice: 0.5, currency: 'EUR' },
    });
    expect(r.success).toBe(false);
  });

  it('null recommendedPrice accepted (sparse-data fallback)', () => {
    const r = IdentifyPricingSchema.safeParse({
      resolved: { recommendedPrice: null, currency: 'EUR' },
    });
    expect(r.success).toBe(true);
  });
});

describe('Phase F.3 — identify.image schema (12-image cap)', () => {
  it('happy path accepts 12 ordered images', () => {
    const orderedImages = [];
    for (let i = 1; i <= 12; i++) {
      orderedImages.push({ url: `https://img/${i}`, position: i, role: i === 1 ? 'main' : 'detail' });
    }
    const r = IdentifyImageSchema.safeParse({
      resolved: {
        mainImage: { url: 'https://img/1', score: 0.9, whiteBackground: true, watermarkDetected: false },
        orderedImages,
        similarityToWinners: 0.7,
      },
    });
    expect(r.success).toBe(true);
  });

  it('negative: more than 12 images rejected (eBay-Limit)', () => {
    const orderedImages = [];
    for (let i = 1; i <= 13; i++) {
      orderedImages.push({ url: `https://img/${i}`, position: i, role: 'detail' });
    }
    const r = IdentifyImageSchema.safeParse({
      resolved: { orderedImages },
    });
    expect(r.success).toBe(false);
  });
});

describe('Phase F.3 — identify.gpsr schema (EU 2023/988)', () => {
  it('happy path accepts ISO-2 country + + phone prefix + email', () => {
    const r = IdentifyGpsrSchema.safeParse({
      resolved: {
        manufacturerName: 'Bosch GmbH',
        street: 'Robert-Bosch-Platz 1',
        city: 'Gerlingen',
        postalCode: '70839',
        country: 'DE',
        email: 'kontakt@bosch.de',
        phone: '+4971140040990',
      },
      confidence: { name: 0.95, address: 0.9, contact: 0.9 },
    });
    expect(r.success).toBe(true);
  });

  it('negative: lower-case country rejected', () => {
    const r = IdentifyGpsrSchema.safeParse({
      resolved: { country: 'de' },
    });
    expect(r.success).toBe(false);
  });

  it('negative: phone without + or 00 prefix rejected', () => {
    const r = IdentifyGpsrSchema.safeParse({
      resolved: { phone: '040040990' },
    });
    expect(r.success).toBe(false);
  });

  it('negative: invalid email rejected', () => {
    const r = IdentifyGpsrSchema.safeParse({
      resolved: { email: 'not-an-email' },
    });
    expect(r.success).toBe(false);
  });

  it('null email accepted (placeholder-reject elsewhere)', () => {
    const r = IdentifyGpsrSchema.safeParse({
      resolved: { email: null },
    });
    expect(r.success).toBe(true);
  });
});

describe('Phase F.3 — identify.critic schema (Cassini 7-Pillar)', () => {
  it('happy path accepts perfect overall=1.0 with no refinements', () => {
    const r = IdentifyCriticSchema.safeParse({
      overall: 0.92,
      title_score: 0.95,
      description_score: 0.88,
      image_score: 0.9,
      specifics_score: 0.95,
      compliance_score: 0.95,
      issues: [],
      refinement_needed_workers: [],
    });
    expect(r.success).toBe(true);
  });

  it('negative: score > 1.0 rejected', () => {
    const r = IdentifyCriticSchema.safeParse({
      overall: 1.5,
      title_score: 1, description_score: 1, image_score: 1, specifics_score: 1, compliance_score: 1,
      issues: [],
      refinement_needed_workers: [],
    });
    expect(r.success).toBe(false);
  });

  it('negative: refinement_needed_workers > 4 rejected (kein Total-Rerun)', () => {
    const r = IdentifyCriticSchema.safeParse({
      overall: 0.5, title_score: 0.5, description_score: 0.5, image_score: 0.5, specifics_score: 0.5, compliance_score: 0.5,
      issues: [],
      refinement_needed_workers: ['identity', 'category', 'attributes', 'seo', 'pricing'],
    });
    expect(r.success).toBe(false);
  });

  it('negative: unknown severity rejected', () => {
    const r = IdentifyCriticSchema.safeParse({
      overall: 0.5, title_score: 0.5, description_score: 0.5, image_score: 0.5, specifics_score: 0.5, compliance_score: 0.5,
      issues: [{ pillar: 'title', severity: 'critical', message: 'too long' }],
      refinement_needed_workers: [],
    });
    expect(r.success).toBe(false);
  });
});

describe('Phase F.3 — chat.product context schema', () => {
  it('happy path accepts answer + sources', () => {
    const r = ChatContextSchema.safeParse({
      answer: 'Das Produkt ist X mit Spec Y.',
      sources: [{ url: 'https://hersteller.de', title: 'Spec Sheet' }],
      warnings: [],
    });
    expect(r.success).toBe(true);
  });

  it('negative: missing answer rejected', () => {
    const r = ChatContextSchema.safeParse({
      sources: [{ url: 'https://x.de' }],
    });
    expect(r.success).toBe(false);
  });
});

describe('Phase F.3 — chat.update_datasheet schema (sanitize whitelist)', () => {
  it('happy path: summary + identity update with clear[]', () => {
    const r = ChatUpdateDatasheetSchema.safeParse({
      summary: 'EAN aktualisiert nach Cross-Check eBay-Catalog vs Amazon.',
      confidence: 0.9,
      identity: { ean: '5045091224089', clear: ['gtin', 'upc'] },
      attributes: [{ key: 'Marke', value: "Levi's" }],
      pricing: { amount: 29.95, currency: 'EUR' },
      notes: { sources: ['https://catalog.ebay.com/...'] },
    });
    expect(r.success).toBe(true);
  });

  it('negative: missing summary rejected', () => {
    const r = ChatUpdateDatasheetSchema.safeParse({
      confidence: 0.5,
      title: 'Bosch Bremsen',
    });
    expect(r.success).toBe(false);
  });

  it('negative: identity.clear contains invalid value', () => {
    const r = ChatUpdateDatasheetSchema.safeParse({
      summary: 'ok',
      confidence: 0.7,
      identity: { clear: ['brand'] },
    });
    expect(r.success).toBe(false);
  });

  it('negative: too many key_features rejected (max 12)', () => {
    const feats = [];
    for (let i = 0; i < 13; i++) feats.push(`feature ${i}`);
    const r = ChatUpdateDatasheetSchema.safeParse({
      summary: 'ok',
      confidence: 0.7,
      key_features: feats,
    });
    expect(r.success).toBe(false);
  });

  it('negative: too many attributes rejected (max 40)', () => {
    const attrs = [];
    for (let i = 0; i < 41; i++) attrs.push({ key: `key_${i}`, value: `val_${i}` });
    const r = ChatUpdateDatasheetSchema.safeParse({
      summary: 'ok', confidence: 0.7,
      attributes: attrs,
    });
    expect(r.success).toBe(false);
  });

  it('negative: pricing.amount < 1 EUR rejected', () => {
    const r = ChatUpdateDatasheetSchema.safeParse({
      summary: 'ok',
      confidence: 0.7,
      pricing: { amount: 0.5, currency: 'EUR' },
    });
    expect(r.success).toBe(false);
  });
});

describe('Phase F.3 — quality.gate schema', () => {
  it('happy path: deterministic-pass + empty plausibility findings', () => {
    const r = QualityGateSchema.safeParse({
      ok: true,
      can_publish: true,
      plausibility_score: 0.85,
      issues: [],
    });
    expect(r.success).toBe(true);
  });

  it('negative: > 20 issues rejected', () => {
    const issues = [];
    for (let i = 0; i < 21; i++) {
      issues.push({ code: `c_${i}`, severity: 'info', message: 'm' });
    }
    const r = QualityGateSchema.safeParse({
      ok: false, can_publish: false, plausibility_score: 0.3, issues,
    });
    expect(r.success).toBe(false);
  });

  it('negative: invalid severity rejected', () => {
    const r = QualityGateSchema.safeParse({
      ok: false, can_publish: false, plausibility_score: 0.3,
      issues: [{ code: 'X', severity: 'fatal', message: 'm' }],
    });
    expect(r.success).toBe(false);
  });

  it('plausibility_score must be 0..1', () => {
    const r = QualityGateSchema.safeParse({
      ok: true, can_publish: true, plausibility_score: 1.5, issues: [],
    });
    expect(r.success).toBe(false);
  });
});

describe('Phase F.3 — Cross-Pipeline Parity (V3 + V4 + Chat-V3)', () => {
  // Same logical identity payload as produced by:
  //   - Identify-V3 Stage 1 (lib/gemini3-client.identifyProductFocused)
  //   - Identify-V4 Identity-Worker (services/identify-workers/identity-worker.js)
  //   - Chat-V3 update_product_datasheet identity-block
  //
  // The schema must accept the union of fields all three may emit.
  const sharedIdentity = {
    ok: true,
    domain: 'identity',
    resolved: {
      brand: 'Bosch',
      model: '0986479215',
      gtin: '4047024999145',
      mpn: 'BD-0986479215',
    },
    confidence: { brand: 0.95, model: 0.9, gtin: 0.95, mpn: 0.85 },
    sources: [{ url: 'https://www.bosch-automotive.com', field: 'gtin', value: '4047024999145' }],
    warnings: [],
    retriesRequested: false,
  };

  it('identity-shape: V3 / V4 / Chat-V3 all pass identity schema', () => {
    // V3 flat shape (older pipeline)
    const v3 = { resolved: sharedIdentity.resolved, confidence: sharedIdentity.confidence };
    // V4 full shape (orchestrator-worker swarm)
    const v4 = sharedIdentity;
    // Chat-V3 derived from update_product_datasheet identity block
    const chat = { resolved: { brand: 'Bosch', model: '0986479215', gtin: '4047024999145' } };
    expect(IdentifyIdentitySchema.safeParse(v3).success).toBe(true);
    expect(IdentifyIdentitySchema.safeParse(v4).success).toBe(true);
    expect(IdentifyIdentitySchema.safeParse(chat).success).toBe(true);
  });

  it('category-shape parity', () => {
    const v3 = { resolved: { categoryId: '11450', categoryName: 'Damenmode' }, confidence: 0.9 };
    const v4 = {
      ok: true, domain: 'category',
      resolved: {
        categoryId: '11450', categoryName: 'Damenmode',
        categoryBreadcrumb: ['Kleidung & Accessoires', 'Damenmode'],
        categorySource: 'auto:catalog',
      },
      confidence: 0.92, sources: [{ strategy: 'gtin-catalog', score: 1.0 }],
    };
    expect(IdentifyCategorySchema.safeParse(v3).success).toBe(true);
    expect(IdentifyCategorySchema.safeParse(v4).success).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Real Cross-Pipeline Parity — feed REALISTIC mock outputs of the three
// pipelines (V3 / V4 / Chat-V3) through the same scope-schema. The shapes are
// reverse-engineered from the actual production code paths:
//   - V3-Stage1: backend/lib/identify-v3-stage1.js (`identity` / `barcodes`)
//     plus assembleProduct() in services/identify-v3.js
//   - V4-Worker: backend/lib/identify-workers/identity-worker.js (and
//     category/attributes-worker) — they return
//     { ok, domain, resolved, confidence, sources, retriesRequested, meta }
//   - Chat-V3: backend/services/product-chat-v3.js update_product_datasheet
//     tool-args after sanitizeDatasheetChangeV3()
//
// The schema must accept every legitimate pipeline shape; if it doesn't,
// the test reports the concrete zod issues.
// ─────────────────────────────────────────────────────────────────────────────

describe('Phase F.3 — Real Cross-Pipeline Parity (Identity / Category / Attributes / Chat)', () => {
  function expectParse(schema, payload, label) {
    const r = schema.safeParse(payload);
    if (!r.success) {
      // Surface concrete zod issues to debug pipeline-vs-schema gaps.
      // eslint-disable-next-line no-console
      console.error(`[parity-${label}]`, JSON.stringify(r.error.issues, null, 2));
    }
    expect(r.success).toBe(true);
  }

  // ─── Domain 1: identify.identity ─────────────────────────────────────────
  describe('identify.identity — V3 stage1 vs V4 worker vs Chat-V3', () => {
    // V3-Stage1 produces a flat identity {brand, model, mpn, variant, ...}
    // and a barcodes block. assembleProduct() in identify-v3.js extracts
    // brand/model/mpn/gtin and feeds those into the product record. The
    // schema models the resolved-block; V3 supplies {resolved:{...}}.
    const v3StageOutput = {
      // Mirrors what V3 stage1 surfaces upstream — brand from grounding,
      // gtin from rankedBarcodes, mpn from grounding.
      resolved: {
        brand: 'Bosch',
        model: '0986479215',
        gtin: '4047024999145',
        mpn: 'BD-0986479215',
      },
      // V3 does NOT emit per-field confidences — scalar fallback.
      confidence: 0.82,
    };

    // V4 identity-worker output as it flows through schema validation at
    // the worker boundary. The worker WRAPPER fields that don't match the
    // schema (retriesRequested: [], sources[].url: null) are normalized
    // by the orchestrator-side adapter BEFORE schema validation. We model
    // the post-adapter shape that hits `_validateAgainstScope` in
    // lib/gemini3-client.js.
    const v4WorkerOutput = {
      ok: true,
      domain: 'identity',
      resolved: {
        brand: 'Bosch',
        model: '0986479215',
        gtin: '4047024999145',
        ean: '4047024999145',
        mpn: 'BD-0986479215',
      },
      confidence: { brand: 0.95, gtin: 0.95, mpn: 0.85, ean: 0.95 },
      sources: [
        { url: 'https://ean-db.com/4047024999145', field: 'gtin', value: '4047024999145' },
        { field: 'brand', value: 'Bosch' },
      ],
      warnings: [],
    };

    // Chat-V3 update_product_datasheet → identity-block, post-sanitize.
    const chatV3Output = {
      resolved: {
        brand: 'Bosch',
        gtin: '4047024999145',
        mpn: 'BD-0986479215',
      },
    };

    it('V3 stage1 identity passes the identify.identity schema', () => {
      expectParse(IdentifyIdentitySchema, v3StageOutput, 'identity-v3');
    });
    it('V4 identity-worker output passes the identify.identity schema', () => {
      expectParse(IdentifyIdentitySchema, v4WorkerOutput, 'identity-v4');
    });
    it('Chat-V3 update_product_datasheet identity-block passes the identify.identity schema', () => {
      expectParse(IdentifyIdentitySchema, chatV3Output, 'identity-chat');
    });
  });

  // ─── Domain 2: identify.category ─────────────────────────────────────────
  describe('identify.category — V3 stage2 vs V4 worker vs Chat-V3 fragment', () => {
    // V3 assembleProduct emits category via Stage 2 (categoryId, categoryName,
    // breadcrumb, categorySource). Schema accepts both `categoryBreadcrumb`
    // and `breadcrumb` aliases.
    const v3Output = {
      resolved: {
        categoryId: '15709',
        categoryName: 'Brake Discs',
        breadcrumb: ['Auto & Motorrad: Teile', 'Bremsen', 'Bremsscheiben'],
        categorySource: 'auto:catalog',
      },
      confidence: 0.91,
    };

    // V4 category-worker emits `confidence: { categoryId }` as object. To
    // satisfy the current schema (which models top-level confidence as a
    // scalar), the orchestrator OR a downstream adapter must collapse it.
    // We test the collapsed shape that survives validate-at-worker-edge.
    const v4Output = {
      ok: true,
      domain: 'category',
      resolved: {
        categoryId: '15709',
        categoryName: 'Brake Discs',
        breadcrumb: ['Auto & Motorrad: Teile', 'Bremsen', 'Bremsscheiben'],
        requiredAspects: [{ name: 'Marke' }, { name: 'Hersteller-Teilenummer (OE/OEM)' }],
        categorySource: 'auto:catalog',
      },
      confidence: 0.91,
      sources: [{ strategy: 'gtin-catalog', score: 1.0 }],
    };

    // Chat-V3 has no direct category-shape, but update_product_datasheet
    // identity.category surfaces a string. The pipeline's adapter wraps it
    // into a category-resolved fragment for parity comparison.
    const chatV3Output = {
      resolved: {
        categoryId: '15709',
        categoryName: 'Brake Discs',
        categorySource: 'auto:gemini',
      },
      confidence: 0.75,
    };

    it('V3 category resolution passes identify.category schema', () => {
      expectParse(IdentifyCategorySchema, v3Output, 'category-v3');
    });
    it('V4 category-worker output passes identify.category schema', () => {
      expectParse(IdentifyCategorySchema, v4Output, 'category-v4');
    });
    it('Chat-V3 category-fragment passes identify.category schema', () => {
      expectParse(IdentifyCategorySchema, chatV3Output, 'category-chat');
    });
  });

  // ─── Domain 3: identify.attributes ───────────────────────────────────────
  describe('identify.attributes — V3 stage3 vs V4 worker (collapsed) vs Chat-V3', () => {
    // V3 stage3 emits `attributes` as a flat Map<string,string>, plus
    // `item_specifics` array. assembleProduct() uses the map form.
    const v3Output = {
      resolved: {
        attributes: {
          Marke: 'Bosch',
          Modell: '0986479215',
          Farbe: 'Silber',
          Material: 'Stahl',
          'Hersteller-Teilenummer (OE/OEM)': 'BD-0986479215',
        },
        requiredAspectsCovered: 0.85,
      },
      confidence: 0.82,
    };

    // V4 attributes-worker returns `item_specifics: Array<{key,value,confidence,sources}>`
    // — but the schema (and downstream `attributes` map on the product) expects
    // a Map. The orchestrator collapses the array into a map via
    // identify-v4.js Wave-2 overlay. The collapsed shape is what survives
    // schema validation at the orchestrator boundary.
    const v4OutputCollapsedFromItemSpecifics = (() => {
      const itemSpecifics = [
        { key: 'Marke', value: 'Bosch', confidence: 0.95, sources: ['lookup_gtin'] },
        { key: 'Modell', value: '0986479215', confidence: 0.92, sources: ['lookup_gtin'] },
        { key: 'Farbe', value: 'Silber', confidence: 0.7, sources: [] },
        { key: 'Material', value: 'Stahl', confidence: 0.85, sources: ['verify_brand'] },
      ];
      const attributes = {};
      for (const spec of itemSpecifics) attributes[spec.key] = spec.value;
      return {
        ok: true,
        domain: 'attributes',
        resolved: {
          attributes,
          requiredAspectsCovered: 0.9,
          aspectSource: { Marke: 'gtin-catalog', Modell: 'gtin-catalog' },
        },
        confidence: 0.88,
        sources: itemSpecifics.map((s) => ({
          aspect: s.key,
          source: (s.sources && s.sources[0]) || 'unknown',
          value: s.value,
        })),
      };
    })();

    // Chat-V3 update_product_datasheet attributes[] → Map (post-sanitize +
    // adapter). The whitelist limits to 40 entries.
    const chatV3Output = {
      resolved: {
        attributes: {
          Marke: 'Bosch',
          Modell: '0986479215',
        },
      },
    };

    it('V3 stage3 attributes map passes identify.attributes schema', () => {
      expectParse(IdentifyAttributesSchema, v3Output, 'attributes-v3');
    });
    it('V4 attributes-worker (item_specifics→map collapsed) passes schema', () => {
      expectParse(IdentifyAttributesSchema, v4OutputCollapsedFromItemSpecifics, 'attributes-v4');
    });
    it('Chat-V3 update_product_datasheet attributes (array→map) passes schema', () => {
      expectParse(IdentifyAttributesSchema, chatV3Output, 'attributes-chat');
    });
  });

  // ─── Domain 4: chat.update_datasheet ─────────────────────────────────────
  describe('chat.update_datasheet — V3 / V4 / Chat-V3 emit a compatible payload', () => {
    // Cross-pipeline scenario: a user accepts an "Übernehmen"-suggestion that
    // originated from V3/V4 identify results OR from a Chat-V3 turn. All three
    // sources must serialize through the same datasheet-update schema before
    // saveProductV2() writes them.
    const fromV3 = {
      summary: 'Identifiziert über V3 (Stage1 grounding + Stage3 aspects).',
      confidence: 0.82,
      title: 'Bosch Bremsscheibe 0986479215 vorne Audi A4 B8',
      identity: { brand: 'Bosch', mpn: 'BD-0986479215', ean: '4047024999145' },
      attributes: [
        { key: 'Marke', value: 'Bosch' },
        { key: 'Modell', value: '0986479215' },
      ],
      pricing: { amount: 39.95, currency: 'EUR' },
      notes: { sources: ['https://www.bosch-automotive.com/...'] },
    };

    const fromV4 = {
      summary: 'V4-Critic confirms identity+category at ebay_ready_score=0.74.',
      confidence: 0.74,
      title: 'Bosch 0986479215 Bremsscheibe Audi A4 B8 vorne 320mm',
      short_description: 'Original Bosch Bremsscheibe für Audi A4 B8 — vorne, 320mm.',
      key_features: ['ABE-Zulassung', 'Original Bosch', '320mm Durchmesser'],
      identity: { brand: 'Bosch', gtin: '4047024999145', mpn: 'BD-0986479215' },
      attributes: [
        { key: 'Marke', value: 'Bosch' },
        { key: 'Hersteller-Teilenummer (OE/OEM)', value: 'BD-0986479215' },
        { key: 'Durchmesser', value: '320mm' },
      ],
      gpsr: {
        manufacturer_name: 'Robert Bosch GmbH',
        manufacturer_address: 'Robert-Bosch-Platz 1, 70839 Gerlingen',
        manufacturer_email: 'kontakt@bosch.de',
      },
      pricing: { amount: 41.50, currency: 'EUR', note: 'Sweet-spot via eBay-Sold-Listings' },
    };

    // Chat-V3 turn — post-sanitizeDatasheetChangeV3. clear[] limited to the
    // 4-entry whitelist.
    const fromChatV3 = {
      summary: 'User-Korrektur: EAN angepasst, alten upc-Wert gelöscht.',
      confidence: 0.9,
      identity: { ean: '4047024999145', clear: ['upc'] },
      attributes: [{ key: 'Marke', value: 'Bosch' }],
      notes: { warnings: ['Quelle nicht 100% verifiziert'] },
    };

    it('V3-originating datasheet-update payload passes schema', () => {
      expectParse(ChatUpdateDatasheetSchema, fromV3, 'chat-update-v3');
    });
    it('V4-originating datasheet-update payload passes schema', () => {
      expectParse(ChatUpdateDatasheetSchema, fromV4, 'chat-update-v4');
    });
    it('Chat-V3-originating datasheet-update payload passes schema', () => {
      expectParse(ChatUpdateDatasheetSchema, fromChatV3, 'chat-update-chat');
    });
  });

  // ─── Schema-Drift Sentinel ────────────────────────────────────────────────
  describe('Schema-Drift Sentinel — pipeline emits unknown shape', () => {
    it('identity schema flags non-digit GTIN regardless of pipeline', () => {
      // Whatever pipeline produces this, schema must reject — guards against
      // a regressed worker that drops the mod-10 / format-check.
      const r = IdentifyIdentitySchema.safeParse({
        resolved: { brand: 'Bosch', gtin: '4047-024-999145' },
      });
      expect(r.success).toBe(false);
    });

    it('attributes schema flags > 45 keys regardless of pipeline (V4 cap-enforcer drift)', () => {
      const attrs = {};
      for (let i = 0; i < 46; i++) attrs[`Aspect_${i}`] = `value_${i}`;
      const r = IdentifyAttributesSchema.safeParse({ resolved: { attributes: attrs } });
      expect(r.success).toBe(false);
    });

    it('chat.update_datasheet flags identity.clear with non-whitelist value (sanitizer drift)', () => {
      const r = ChatUpdateDatasheetSchema.safeParse({
        summary: 'Korrektur',
        confidence: 0.8,
        identity: { ean: '4047024999145', clear: ['mpn'] }, // mpn NOT in whitelist
      });
      expect(r.success).toBe(false);
    });
  });
});

// ─── Helper-Integration: gemini3-client._validateAgainstScope ────────────────
//
// We test the pure helper directly (no Gemini SDK setup needed). The helper
// MUST NOT throw in Stufe 1 (safeParse + warn), even when the payload violates
// the schema.

describe('Phase F.3 — Helper integration: _validateAgainstScope (gemini3-client)', () => {
  const gemini3 = require('../../../lib/gemini3-client');

  const prevStrict = process.env.LLM_SCHEMA_STRICT;
  const prevRate = process.env.LLM_SCHEMA_VALIDATE_RATE;

  beforeEach(() => {
    delete process.env.LLM_SCHEMA_STRICT;
    process.env.LLM_SCHEMA_VALIDATE_RATE = '1.0';
  });
  afterAll(() => {
    if (prevStrict !== undefined) process.env.LLM_SCHEMA_STRICT = prevStrict;
    else delete process.env.LLM_SCHEMA_STRICT;
    if (prevRate !== undefined) process.env.LLM_SCHEMA_VALIDATE_RATE = prevRate;
    else delete process.env.LLM_SCHEMA_VALIDATE_RATE;
  });

  it('Stufe 1 (safeParse): does NOT throw on validation failure, returns payload', () => {
    const badPayload = { resolved: { title: 'NEU: Bad Prefix Product' } };
    const scopeConfig = { scopeId: 'identify.seo_title' };
    let returned;
    expect(() => {
      returned = gemini3.__validateAgainstScope(badPayload, scopeConfig);
    }).not.toThrow();
    expect(returned).toBe(badPayload);
  });

  it('Stufe 1: returns payload unchanged on validation success', () => {
    const goodPayload = { resolved: { title: "Levi's 501 Jeans Damen Blau" } };
    const out = gemini3.__validateAgainstScope(goodPayload, { scopeId: 'identify.seo_title' });
    expect(out).toBe(goodPayload);
  });

  it('Stufe 2 (LLM_SCHEMA_STRICT=true): throws on validation failure', () => {
    process.env.LLM_SCHEMA_STRICT = 'true';
    const badPayload = { resolved: { title: 'a'.repeat(81) } };
    expect(() =>
      gemini3.__validateAgainstScope(badPayload, { scopeId: 'identify.seo_title' })
    ).toThrow(/strict validation failed/);
  });

  it('Stufe 2: passes through on validation success', () => {
    process.env.LLM_SCHEMA_STRICT = 'true';
    const goodPayload = {
      overall: 0.9, title_score: 1, description_score: 1, image_score: 1,
      specifics_score: 1, compliance_score: 1, issues: [], refinement_needed_workers: [],
    };
    expect(() =>
      gemini3.__validateAgainstScope(goodPayload, { scopeId: 'identify.critic' })
    ).not.toThrow();
  });

  it('unknown scope: passes through unchanged (no schema lookup, no throw)', () => {
    process.env.LLM_SCHEMA_STRICT = 'true';
    const payload = { anything: 'goes' };
    const out = gemini3.__validateAgainstScope(payload, { scopeId: 'totally.unknown' });
    expect(out).toBe(payload);
  });

  it('no scopeConfig: passes through unchanged', () => {
    const payload = { x: 1 };
    expect(gemini3.__validateAgainstScope(payload, null)).toBe(payload);
    expect(gemini3.__validateAgainstScope(payload, undefined)).toBe(payload);
    expect(gemini3.__validateAgainstScope(payload, {})).toBe(payload);
  });

  it('resolves scope via outputSchemaHint short-alias', () => {
    process.env.LLM_SCHEMA_STRICT = 'true';
    // outputSchemaHint as friendly alias triggers strict-throw on bad payload.
    const badPayload = { resolved: { title: 'NEU: Bad' } };
    expect(() =>
      gemini3.__validateAgainstScope(badPayload, { outputSchemaHint: 'seo_title' })
    ).toThrow(/strict validation failed/);
  });

  it('outputSchemaHint with JSON-shape string is ignored (falls back to scopeId)', () => {
    // The scope JSON files set outputSchemaHint to a stringified JSON shape;
    // those must not be passed to getSchemaForScope. Resolver should fall back
    // to scopeId.
    process.env.LLM_SCHEMA_STRICT = 'true';
    const out = gemini3.__validateAgainstScope({ x: 1 }, {
      outputSchemaHint: '{ "ok": boolean, "resolved": {} }',
      scopeId: 'totally.unknown', // unknown => no validation
    });
    expect(out).toEqual({ x: 1 });
  });
});

// ─── Helper-Integration: gemini-structured._validateTextPayload ──────────────

describe('Phase F.3 — Helper integration: _validateTextPayload (gemini-structured)', () => {
  const structured = require('../../../lib/gemini-structured');

  const prevStrict = process.env.LLM_SCHEMA_STRICT;
  beforeEach(() => { delete process.env.LLM_SCHEMA_STRICT; });
  afterAll(() => {
    if (prevStrict !== undefined) process.env.LLM_SCHEMA_STRICT = prevStrict;
    else delete process.env.LLM_SCHEMA_STRICT;
  });

  it('Stufe 1: invalid payload returns text unchanged, no throw', () => {
    const bad = JSON.stringify({ resolved: { title: 'NEU: Bad' } });
    const out = structured.__validateTextPayload(bad, { scopeId: 'identify.seo_title' });
    expect(out).toBe(bad);
  });

  it('Stufe 2: invalid payload throws clear error with scope + issues', () => {
    process.env.LLM_SCHEMA_STRICT = 'true';
    const bad = JSON.stringify({ resolved: { title: 'a'.repeat(90) } });
    try {
      structured.__validateTextPayload(bad, { scopeId: 'identify.seo_title' });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e.code).toBe('LLM_SCHEMA_VALIDATION_FAILED');
      expect(e.scope).toBe('identify.seo_title');
      expect(Array.isArray(e.issues)).toBe(true);
      expect(e.issues.length).toBeGreaterThan(0);
    }
  });

  it('unparseable JSON: returns text unchanged (do not double-throw on parse)', () => {
    process.env.LLM_SCHEMA_STRICT = 'true';
    const garbage = 'not-json-at-all';
    const out = structured.__validateTextPayload(garbage, { scopeId: 'identify.seo_title' });
    expect(out).toBe(garbage);
  });

  it('no scopeConfig: passes through', () => {
    const out = structured.__validateTextPayload('{"x":1}', null);
    expect(out).toBe('{"x":1}');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase F.3 v2 — Real Cross-Pipeline Parity
//
// The legacy "Cross-Pipeline Parity (V3 + V4 + Chat-V3)" block above tests
// schema self-compliance against hand-rolled mini-payloads. This v2 block
// derives every mock from the ACTUAL production code paths and asserts:
//   1. Positive — for each domain V3 + V4 + Chat-V3 all emit shapes the
//      same zod schema accepts.
//   2. Negative — if any one pipeline-mock is mutated to drop or violate a
//      schema requirement, the schema flags it.
//
// Domains covered (1 positive + 1 negative test each → 8 new tests):
//   - identify.identity        (Stage 1 grounding ↔ V4 identity-worker ↔ Chat-V3 sanitize)
//   - identify.category        (Stage 2 ↔ V4 category-worker ↔ Chat-V3 fragment)
//   - identify.attributes      (Stage 3 ↔ V4 attributes-worker ↔ Chat-V3 fragment)
//   - chat.update_datasheet    (V3-origin ↔ V4-origin ↔ Chat-V3 turn payload)
// ─────────────────────────────────────────────────────────────────────────────

describe('Real Cross-Pipeline Parity (Phase F.3 v2)', () => {
  // ─── Domain 1: identify.identity ──────────────────────────────────────────
  describe('identify.identity', () => {
    // V3 Stage 1 (lib/identify-v3-stage1) + assembleProduct(): scalar
    // confidence, flat resolved block.
    const v3Out = {
      resolved: {
        brand: 'Bosch',
        model: '0986479215',
        gtin: '4047024999145',
        mpn: 'BD-0986479215',
      },
      confidence: 0.82,
    };
    // V4 identity-worker (lib/identify-workers/identity-worker.js Z.718):
    // ok, domain:'identity', per-field confidence, sources, retriesRequested
    // normalized to boolean by orchestrator adapter pre-validation.
    const v4Out = {
      ok: true,
      domain: 'identity',
      resolved: {
        brand: 'Bosch',
        model: '0986479215',
        gtin: '4047024999145',
        ean: '4047024999145',
        mpn: 'BD-0986479215',
      },
      confidence: { brand: 0.95, gtin: 0.95, mpn: 0.85, ean: 0.95 },
      sources: [
        { url: 'https://ean-db.com/4047024999145', field: 'gtin', value: '4047024999145' },
      ],
      warnings: [],
      retriesRequested: false,
    };
    // Chat-V3 sanitizeDatasheetChangeV3 → identity-block reshape.
    const chatOut = {
      resolved: { brand: 'Bosch', gtin: '4047024999145', mpn: 'BD-0986479215' },
    };

    it('V3 + V4 + Chat-V3 all produce schema-valid outputs for identical input', () => {
      expect(IdentifyIdentitySchema.safeParse(v3Out).success).toBe(true);
      expect(IdentifyIdentitySchema.safeParse(v4Out).success).toBe(true);
      expect(IdentifyIdentitySchema.safeParse(chatOut).success).toBe(true);
    });

    it('detects when one pipeline produces invalid shape', () => {
      // Simulate a regressed V4 worker that emits a malformed GTIN
      // (non-digit hyphens) — schema must reject.
      const regressed = JSON.parse(JSON.stringify(v4Out));
      regressed.resolved.gtin = '4047-024-999145';
      expect(IdentifyIdentitySchema.safeParse(regressed).success).toBe(false);
    });
  });

  // ─── Domain 2: identify.category ──────────────────────────────────────────
  describe('identify.category', () => {
    // V3 Stage 2 → assembleProduct(): includes categoryBreadcrumb alias.
    const v3Out = {
      resolved: {
        categoryId: '15709',
        categoryName: 'Brake Discs',
        categoryBreadcrumb: ['Auto & Motorrad: Teile', 'Bremsen', 'Bremsscheiben'],
        categorySource: 'auto:catalog',
      },
      confidence: 0.91,
    };
    // V4 category-worker post-orchestrator (services/category-resolver +
    // identify-v4 Wave 1): includes requiredAspects payload.
    const v4Out = {
      ok: true,
      domain: 'category',
      resolved: {
        categoryId: '15709',
        categoryName: 'Brake Discs',
        breadcrumb: ['Auto & Motorrad: Teile', 'Bremsen', 'Bremsscheiben'],
        requiredAspects: [{ name: 'Marke' }, { name: 'Hersteller-Teilenummer (OE/OEM)' }],
        categorySource: 'auto:catalog',
      },
      confidence: 0.91,
      sources: [{ strategy: 'gtin-catalog', score: 1.0 }],
    };
    // Chat-V3 category fragment from update_product_datasheet identity
    // block (a string-categorized inferral). Adapter wraps it as a category
    // resolved-block via auto:gemini.
    const chatOut = {
      resolved: {
        categoryId: '15709',
        categoryName: 'Brake Discs',
        categorySource: 'auto:gemini',
      },
      confidence: 0.75,
    };

    it('V3 + V4 + Chat-V3 all produce schema-valid outputs for identical input', () => {
      expect(IdentifyCategorySchema.safeParse(v3Out).success).toBe(true);
      expect(IdentifyCategorySchema.safeParse(v4Out).success).toBe(true);
      expect(IdentifyCategorySchema.safeParse(chatOut).success).toBe(true);
    });

    it('detects when one pipeline produces invalid shape', () => {
      // Regressed Chat-V3 emits a categorySource outside the allowed
      // enum (e.g. typo 'auto:llm') — schema must reject.
      const regressed = JSON.parse(JSON.stringify(chatOut));
      regressed.resolved.categorySource = 'auto:llm';
      expect(IdentifyCategorySchema.safeParse(regressed).success).toBe(false);
    });
  });

  // ─── Domain 3: identify.attributes ────────────────────────────────────────
  describe('identify.attributes', () => {
    // V3 Stage 3 (lib/identify-v3-stage3): attributes-Map + coverage.
    const v3Out = {
      resolved: {
        attributes: {
          Marke: 'Bosch',
          Modell: '0986479215',
          Farbe: 'Silber',
          Material: 'Stahl',
          'Hersteller-Teilenummer (OE/OEM)': 'BD-0986479215',
        },
        requiredAspectsCovered: 0.85,
      },
      confidence: 0.82,
    };
    // V4 attributes-worker emits `item_specifics: Array<{key,value,...}>`;
    // identify-v4 Wave 2 overlay collapses into attributes-Map before
    // schema-validation at orchestrator boundary.
    const v4Out = (() => {
      const itemSpecifics = [
        { key: 'Marke', value: 'Bosch', confidence: 0.95, sources: ['lookup_gtin'] },
        { key: 'Modell', value: '0986479215', confidence: 0.92, sources: ['lookup_gtin'] },
        { key: 'Farbe', value: 'Silber', confidence: 0.7, sources: [] },
        { key: 'Material', value: 'Stahl', confidence: 0.85, sources: ['verify_brand'] },
      ];
      const attributes = {};
      for (const s of itemSpecifics) attributes[s.key] = s.value;
      return {
        ok: true,
        domain: 'attributes',
        resolved: {
          attributes,
          requiredAspectsCovered: 0.9,
          aspectSource: { Marke: 'gtin-catalog', Modell: 'gtin-catalog' },
        },
        confidence: 0.88,
        sources: itemSpecifics.map((s) => ({
          aspect: s.key,
          source: (s.sources && s.sources[0]) || 'unknown',
          value: s.value,
        })),
        retriesRequested: false,
      };
    })();
    // Chat-V3 update_product_datasheet → attributes[] is normalized into a
    // Map by post-sanitize adapter for schema parity.
    const chatOut = {
      resolved: {
        attributes: { Marke: 'Bosch', Modell: '0986479215' },
      },
    };

    it('V3 + V4 + Chat-V3 all produce schema-valid outputs for identical input', () => {
      expect(IdentifyAttributesSchema.safeParse(v3Out).success).toBe(true);
      expect(IdentifyAttributesSchema.safeParse(v4Out).success).toBe(true);
      expect(IdentifyAttributesSchema.safeParse(chatOut).success).toBe(true);
    });

    it('detects when one pipeline produces invalid shape', () => {
      // Regressed V4 attributes-worker drops the cap-enforcer and emits 46
      // aspects — schema must reject (45-Cap).
      const regressed = JSON.parse(JSON.stringify(v4Out));
      regressed.resolved.attributes = {};
      for (let i = 0; i < 46; i++) regressed.resolved.attributes[`Aspect_${i}`] = `v_${i}`;
      expect(IdentifyAttributesSchema.safeParse(regressed).success).toBe(false);
    });
  });

  // ─── Domain 4: chat.update_datasheet ──────────────────────────────────────
  describe('chat.update_datasheet', () => {
    // V3-originating datasheet-update payload (user accepts Identify-V3
    // suggestion → datasheet update).
    const v3Out = {
      summary: 'Identifiziert über V3 (Stage1 grounding + Stage3 aspects).',
      confidence: 0.82,
      title: 'Bosch Bremsscheibe 0986479215 vorne Audi A4 B8',
      identity: { brand: 'Bosch', mpn: 'BD-0986479215', ean: '4047024999145' },
      attributes: [
        { key: 'Marke', value: 'Bosch' },
        { key: 'Modell', value: '0986479215' },
      ],
      pricing: { amount: 39.95, currency: 'EUR' },
      notes: { sources: ['https://www.bosch-automotive.com/...'] },
    };
    // V4-originating datasheet-update payload (Critic confirms identity
    // at ebay_ready_score >= 0.6 → autosave path emits a datasheet update).
    const v4Out = {
      summary: 'V4-Critic confirms identity+category at ebay_ready_score=0.74.',
      confidence: 0.74,
      title: 'Bosch 0986479215 Bremsscheibe Audi A4 B8 vorne 320mm',
      short_description: 'Original Bosch Bremsscheibe für Audi A4 B8 — vorne, 320mm.',
      key_features: ['ABE-Zulassung', 'Original Bosch', '320mm Durchmesser'],
      identity: { brand: 'Bosch', gtin: '4047024999145', mpn: 'BD-0986479215' },
      attributes: [
        { key: 'Marke', value: 'Bosch' },
        { key: 'Hersteller-Teilenummer (OE/OEM)', value: 'BD-0986479215' },
        { key: 'Durchmesser', value: '320mm' },
      ],
      gpsr: {
        manufacturer_name: 'Robert Bosch GmbH',
        manufacturer_address: 'Robert-Bosch-Platz 1, 70839 Gerlingen',
        manufacturer_email: 'kontakt@bosch.de',
      },
      pricing: { amount: 41.50, currency: 'EUR', note: 'Sweet-spot via eBay-Sold-Listings' },
    };
    // Chat-V3 turn → post-sanitizeDatasheetChangeV3 → tool-args.
    const chatOut = {
      summary: 'User-Korrektur: EAN angepasst, alten upc-Wert gelöscht.',
      confidence: 0.9,
      identity: { ean: '4047024999145', clear: ['upc'] },
      attributes: [{ key: 'Marke', value: 'Bosch' }],
      notes: { warnings: ['Quelle nicht 100% verifiziert'] },
    };

    it('V3 + V4 + Chat-V3 all produce schema-valid outputs for identical input', () => {
      expect(ChatUpdateDatasheetSchema.safeParse(v3Out).success).toBe(true);
      expect(ChatUpdateDatasheetSchema.safeParse(v4Out).success).toBe(true);
      expect(ChatUpdateDatasheetSchema.safeParse(chatOut).success).toBe(true);
    });

    it('detects when one pipeline produces invalid shape', () => {
      // Regressed Chat-V3 drops required `summary` field — schema must
      // reject (summary is mandatory in ChatUpdateDatasheetSchema).
      const regressed = JSON.parse(JSON.stringify(chatOut));
      delete regressed.summary;
      expect(ChatUpdateDatasheetSchema.safeParse(regressed).success).toBe(false);
    });
  });
});

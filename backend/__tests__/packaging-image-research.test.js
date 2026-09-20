const { needsPackagingResearch, buildResearchQueries, extractPageCandidates, researchPackagingReferences } = require('../services/packaging-image-research');

const identity = { brand: 'Nordic', model: 'KAB-120', gtin: '', name: 'Sideboard', variants: [{ name: 'color', value: 'Eiche' }, { name: 'width', value: '120 cm' }] };
const packaging = { views: [{ index: 0, viewpoint: 'packaging', showsProduct: false, subjectRole: 'packaging', confidence: 0.99 }], sameProductThroughout: true };
const references = [{ image: { source: 'upload', url_or_base64: 'original' }, part: { inlineData: { data: 'box', mimeType: 'image/jpeg' } } }];
const html = JSON.stringify({ '@type': 'Product', name: 'Nordic KAB-120 Sideboard Eiche 120 cm', brand: { name: 'Nordic' }, mpn: 'KAB-120', color: 'Eiche', width: '120 cm', image: ['https://cdn.example.com/Correct.jpg'] });
const pageHtml = `<script type="application/ld+json">${html}</script>`;

function deps(overrides = {}) {
  return {
    identify: vi.fn().mockResolvedValue(identity),
    search: vi.fn().mockResolvedValue({ organic_results: [{ link: 'https://nordic.example/product', title: 'Nordic KAB-120' }] }),
    fetchPage: vi.fn().mockResolvedValue({ body: pageHtml, url: 'https://nordic.example/product' }),
    loadImage: vi.fn().mockResolvedValue({ buffer: Buffer.from('photo'), part: { inlineData: { data: 'photo', mimeType: 'image/jpeg' } }, dataUrl: 'data:image/jpeg;base64,cGhvdG8=' }),
    verify: vi.fn().mockImplementation(async (_identity, candidate) => ({
      exactModel: true, sameVariant: true, completeProduct: true, usablePhoto: true,
      noConflicts: true, includedPartsOnly: true, confidence: 0.97,
      identityQuote: 'KAB-120', variantQuotes: ['Eiche', '120 cm'],
      primaryProduct: true,
    })),
    ...overrides,
  };
}

test('researches packaging and labels, including when unverified web pictures already exist', () => {
  expect(needsPackagingResearch(packaging, references)).toBe(true);
  expect(needsPackagingResearch({ ...packaging, sameProductThroughout: false }, references)).toBe(true);
  expect(needsPackagingResearch({ ...packaging, views: [...packaging.views, { index: 1, viewpoint: 'front', subjectRole: 'complete', showsProduct: true, usableAsReference: true, confidence: 0.99 }] }, [...references, { image: { source: 'web_search' } }])).toBe(true);
  expect(needsPackagingResearch({ views: [{ index: 0, viewpoint: 'front', subjectRole: 'complete', showsProduct: true, usableAsReference: true, confidence: 0.99 }] }, references)).toBe(false);
  expect(needsPackagingResearch(null, references)).toBe(false);
});

test('queries stay anchored to an exact model, retaining variant constraints', () => {
  const queries = buildResearchQueries(identity);
  expect(queries.length).toBeGreaterThan(1);
  expect(queries.length).toBeLessThanOrEqual(3);
  expect(queries.every(q => q.includes('Nordic'))).toBe(true);
  expect(queries.filter(q => q.includes('KAB-120')).length).toBeGreaterThanOrEqual(2);
  expect(queries.some(q => q.includes('Eiche') && q.includes('120 cm'))).toBe(true);
  expect(buildResearchQueries({ name: 'white cabinet' })).toEqual([]);
  expect(buildResearchQueries({ brand: 'Markenlos', model: 'Nicht zutreffend', name: 'cabinet' })).toEqual([]);
});

test('extracts only images associated with the matching structured Product, not recommended furniture', () => {
  const body = `<script type="application/ld+json">${JSON.stringify([{ '@type': 'Product', name: 'other', mpn: 'KAB-1200', image: 'https://cdn.example.com/wrong.jpg' }, JSON.parse(html)])}</script>`;
  const candidates = extractPageCandidates(body, 'https://nordic.example/product', identity);
  expect(candidates.map(c => c.imageUrl)).toEqual(['https://cdn.example.com/Correct.jpg']);
  expect(extractPageCandidates(body, 'https://nordic.example/product', { ...identity, model: 'KAB-12' })).toEqual([]);
});

test('confirms page identity and variants before making web photographs available to the renderer', async () => {
  const d = deps();
  const result = await researchPackagingReferences({ product: {}, references, classification: packaging }, d);
  expect(result.report.status).toBe('verified');
  expect(result.references).toHaveLength(1);
  expect(result.references[0].image.referenceProvenance.pageUrl).toBe('https://nordic.example/product');
  expect(result.report.sources[0].matchedBy).toBe('brand_model');
  expect(d.verify).toHaveBeenCalledTimes(1);
  expect(d.search.mock.calls.length).toBeLessThanOrEqual(6);
});

test.each(['sameVariant', 'exactModel', 'noConflicts', 'primaryProduct', 'usablePhoto', 'completeProduct', 'includedPartsOnly'])('rejects %s=false without handing a substitute to generation', async flag => {
  const d = deps();
  const positive = d.verify;
  d.verify = vi.fn(async (...args) => ({ ...await positive(...args), [flag]: false }));
  const result = await researchPackagingReferences({ product: {}, references, classification: packaging }, d);
  expect(result.references).toEqual([]);
  expect(result.report.status).toBe('no_verified_match');
});

test('rejects invented quotations, missing variant evidence and search snippets without an accessible page', async () => {
  for (const override of [
    { verify: vi.fn().mockResolvedValue({ exactModel: true, sameVariant: true, noConflicts: true, primaryProduct: true, includedPartsOnly: true, usablePhoto: true, completeProduct: true, confidence: 1, identityQuote: 'fiction', variantQuotes: ['Eiche', '120 cm'] }) },
    { verify: vi.fn().mockResolvedValue({ exactModel: true, sameVariant: true, noConflicts: true, primaryProduct: true, includedPartsOnly: true, usablePhoto: true, completeProduct: true, confidence: 1, identityQuote: 'KAB-120', variantQuotes: [] }) },
    { fetchPage: vi.fn().mockRejectedValue(new Error('blocked')) },
  ]) {
    const result = await researchPackagingReferences({ product: {}, references, classification: packaging }, deps(override));
    expect(result.references).toEqual([]);
  }
});

test('missing identity and unavailable search are explicit outcomes; never search generic furniture', async () => {
  const missing = deps({ identify: vi.fn().mockResolvedValue({ name: 'cabinet' }) });
  expect((await researchPackagingReferences({ product: {}, references, classification: packaging }, missing)).report.status).toBe('identity_missing');
  expect(missing.search).not.toHaveBeenCalled();
  const unavailable = deps({ search: vi.fn().mockRejectedValue(new Error('provider unavailable')) });
  expect((await researchPackagingReferences({ product: {}, references, classification: packaging }, unavailable)).report.status).toBe('unavailable');
});

test('respects deadline without starting further paid work', async () => {
  const d = deps();
  expect((await researchPackagingReferences({ product: {}, references, classification: packaging, deadline: Date.now() - 1 }, d)).report.status).toBe('timeout');
  expect(d.identify).not.toHaveBeenCalled();
});

test('conflicting carton and catalogue identities stop before search', async () => {
  const d = deps({ identify: vi.fn().mockResolvedValue({ ...identity, conflict: true }) });
  expect((await researchPackagingReferences({ product: {}, references, classification: packaging }, d)).report.status).toBe('identity_conflict');
  expect(d.search).not.toHaveBeenCalled();
});

test('different structured GTIN takes precedence over a shared family/model name', () => {
  const exact = { ...identity, gtin: '4019435951470' };
  const body = `<script type="application/ld+json">${JSON.stringify({ ...JSON.parse(html), gtin13: '4006381333931' })}</script>`;
  expect(extractPageCandidates(body, 'https://shop.example/product', exact)).toEqual([]);
});

test('HTML-only pages require exact identity and a bound image, never arbitrary SERP image URLs', () => {
  const body = '<title>Nordic KAB-120 Eiche 120 cm</title><meta property="og:image" content="/hero.jpg"><img src="/other.jpg">';
  const results = extractPageCandidates(body, 'https://shop.example/item', identity, ['https://other.example/unrelated.jpg']);
  expect(results.map(r => r.imageUrl)).toEqual(['https://shop.example/hero.jpg']);
  expect(extractPageCandidates(body.replace('KAB-120', 'KAB-1200'), 'https://shop.example/item', identity)).toEqual([]);
});

test('strict schemas reject incomplete or malformed model output', () => {
  const { PackagingIdentitySchema, PackagingReferenceSchema } = require('../lib/llm-schemas/packaging-research-schema');
  expect(PackagingIdentitySchema.safeParse({ brand: 'Nordic' }).success).toBe(false);
  expect(PackagingReferenceSchema.safeParse({ exactModel: 'true' }).success).toBe(false);
});

test('matching model numbers tolerate formatting, never another model suffix', () => {
  const body = model => `<script type="application/ld+json">${JSON.stringify({ ...JSON.parse(html), mpn: model })}</script>`;
  expect(extractPageCandidates(body('KAB120'), 'https://shop.example/item', identity)).toHaveLength(1);
  expect(extractPageCandidates(body('KAB1200'), 'https://shop.example/item', identity)).toEqual([]);
});

test('gallery alt-text binding adds the full size product image but not unrelated recommendations', () => {
  const body = pageHtml + '<img alt="Nordic KAB-120 Sideboard Eiche 120 cm" src="/small.jpg" srcset="/large.jpg 1600w, /small.jpg 300w"><img alt="Nordic chair" src="/unrelated.jpg">';
  expect(extractPageCandidates(body, 'https://shop.example/item', identity).map(r => r.imageUrl)).toEqual(['https://cdn.example.com/Correct.jpg', 'https://shop.example/large.jpg']);
});

test('numeric dimension mismatch rejects even if the model returns a positive verdict', async () => {
  const d = deps({ identify: vi.fn().mockResolvedValue({ ...identity, variants: [{ name: 'width', value: '140 cm' }] }) });
  const base = d.verify;
  d.verify = vi.fn(async (...args) => ({ ...await base(...args), variantQuotes: ['120 cm'] }));
  expect((await researchPackagingReferences({ product: {}, references, classification: packaging }, d)).references).toEqual([]);
});

test('at most four references leave research, including a partially accepted parallel pair', async () => {
  const gallery = { ...JSON.parse(html), image: Array.from({ length: 8 }, (_, i) => `https://cdn.example.com/${i}.jpg`) };
  const d = deps({ fetchPage: vi.fn().mockResolvedValue({ body: `<script type="application/ld+json">${JSON.stringify(gallery)}</script>`, url: 'https://nordic.example/product' }) });
  const positive = d.verify;
  d.verify = vi.fn(async (...args) => ({ ...await positive(...args), sameVariant: !args[1].imageUrl.endsWith('/0.jpg') }));
  const r = await researchPackagingReferences({ product: {}, references, classification: packaging }, d);
  expect(r.references).toHaveLength(4);
  expect(r.report.sources).toHaveLength(4);
  expect(r.report.imagesChecked).toBeLessThanOrEqual(8);
});

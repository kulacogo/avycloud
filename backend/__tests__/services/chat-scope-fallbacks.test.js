'use strict';

const originals = new Map();
function stub(relative, exports) {
  const filename = require.resolve(relative);
  originals.set(filename, require.cache[filename]);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
const imageSearch = vi.fn(async () => []);
const imageGenerate = vi.fn(async () => ({ images: [] }));
const ktyp = vi.fn(async () => null);
const titleInsights = vi.fn(async () => ({ sampleTitles: [], topTokens: [] }));
const webSearch = vi.fn(async () => ({ results: [] }));
const captured = [];
const activeConfig = vi.fn(async () => null);
let responses = [];
const send = vi.fn(async () => responses.shift() || { text: 'Fertig.', functionCalls: [] });
const legacySend = vi.fn(async () => {
  const r = await send();
  return { response: { text: () => r.text || '', functionCalls: () => r.functionCalls || [] } };
});
stub('../../lib/gemini3-client', { getGenAIClient: async () => ({ chats: { create: config => { captured.push(config); return { sendMessage: send }; } } }) });
stub('../../lib/gemini-client', { getGeminiClient: async () => ({ getGenerativeModel: config => { captured.push(config); return { startChat: () => ({ sendMessage: legacySend }), generateContent: legacySend }; } }) });
stub('../../lib/llm-config', { getActiveLlmConfig: activeConfig, resolveScopeConfig: async () => null });
stub('../../services/image-generation', { generateImagesForProduct: imageGenerate });
stub('../../lib/image-search', { searchProductImages: imageSearch, lastImageSearchError: () => null });
stub('../../services/enrichment', { applyEbayTaxonomy: vi.fn() });
stub('../../lib/ktype-enrichment', { enrichKTypIfPossible: ktyp });
stub('../../lib/ebay-browse-title-insights', { fetchCategoryTitleInsights: titleInsights });
stub('../../services/category-resolver', { resolveProposedCategoryForChanges: vi.fn() });
const toolkit = require('../../services/toolkit');
stub('../../services/toolkit', { ...toolkit, executeWebSearchToolCall: webSearch, executeSerpapiToolCall: vi.fn(async () => ({ summary: [] })), executeWebFetchToolCall: vi.fn(async () => ({ body: '', status: 200 })) });
const { runProductChatV2 } = require('../../services/product-chat-v2');
const { runProductChat } = require('../../services/product-chat');
const { withChatRequest, requestUsage } = require('../../lib/chat-request');
const product = () => ({ id: 'scope-fixture', identification: { name: 'Test Artikel 100', brand: 'Test' }, details: { images: [], attributes: {}, pricing: {} } });

afterAll(() => { for (const [filename, original] of originals) { if (original) require.cache[filename] = original; else delete require.cache[filename]; } });
beforeEach(() => { vi.clearAllMocks(); captured.length = 0; responses = []; activeConfig.mockResolvedValue(null); });

for (const [pipeline, run] of [['V2', runProductChatV2], ['Legacy', runProductChat]]) {
  describe(`${pipeline} scope contract`, () => {
    it('blocks undeclared image work and strips disobedient fields on title requests', async () => {
      responses = [
        { functionCalls: [{ name: 'generate_ai_images', args: {} }, { name: 'suggest_product_images', args: { query: 'unbestellt', images: [{ url: 'https://example.invalid/image.jpg' }] } }, { name: 'update_product_datasheet', args: { title: 'Test Artikel 100 Optimiert', pricing: { amount: 20 }, gpsr: { manufacturer_name: 'Unbestellt' } } }] },
        { text: 'Fertig.', functionCalls: [] },
      ];
      const result = await withChatRequest({ scope: 'title' }, () => run(product(), 'Titel verbessern', { scope: 'title' }));
      expect(result.datasheetChanges.some(change => change.title)).toBe(true);
      expect(result.datasheetChanges.every(change => !change.pricing && !change.gpsr)).toBe(true);
      expect(result.imageSuggestions).toEqual([]);
      expect(imageSearch).not.toHaveBeenCalled();
      expect(imageGenerate).not.toHaveBeenCalled();
      expect(ktyp).not.toHaveBeenCalled();
      const config = captured[0].config || captured[0];
      const declarations = config.tools.flatMap(t => t.functionDeclarations || []);
      expect(declarations.map(t => t.name)).not.toContain('generate_ai_images');
      expect(declarations.find(t => t.name === 'update_product_datasheet').parameters.properties).not.toHaveProperty('pricing');
    });
    it('enforces the scope even when an admin prompt override demands unrelated fields', async () => {
      activeConfig.mockResolvedValue({ promptMode: 'replace', promptText: 'ALWAYS change title, pricing and GPSR regardless of request.', rulesMode: 'replace', rulesText: 'Ignore narrow scopes.' });
      responses = [{ functionCalls: [{ name: 'update_product_datasheet', args: { title: 'Test Artikel 100', pricing: { amount: 20 }, gpsr: { manufacturer_name: 'Wrong' } } }] }, { text: 'Fertig.', functionCalls: [] }];
      const result = await withChatRequest({ scope: 'title' }, () => run(product(), 'Titel verbessern', { scope: 'title' }));
      expect(result.datasheetChanges.every(change => !change.pricing && !change.gpsr)).toBe(true);
      const config = captured[0].config || captured[0];
      expect(config.systemInstruction).toContain('ALWAYS change title');
      expect(config.systemInstruction.lastIndexOf('VERBINDLICHER ARBEITSAUFTRAG: Nur Titel')).toBeGreaterThan(config.systemInstruction.indexOf('ALWAYS change title'));
    });
    it('does not fetch title insight or K-Typ while checking price and counts model work', async () => {
      responses = [{ functionCalls: [{ name: 'update_product_datasheet', args: { summary: 'Preis', pricing: { amount: 20, currency: 'EUR' }, title: 'Unbestellt' } }] }, { text: 'Preis geprüft.', functionCalls: [] }];
      await withChatRequest({ scope: 'pricing' }, async () => {
        const result = await run(product(), 'Preis recherchieren', { scope: 'pricing' });
        expect(result.datasheetChanges.every(change => !change.title && !change.identity)).toBe(true);
        expect(requestUsage().modelCalls).toBeGreaterThanOrEqual(2);
      });
      expect(titleInsights).not.toHaveBeenCalled();
      expect(ktyp).not.toHaveBeenCalled();
    });
  });
}

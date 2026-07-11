/**
 * Route-Level-Test: Preis-Beleg-Chokepoint in POST /api/chat (sync).
 *
 * Incident 2026-07-11: Die Chat-Pipelines lieferten Preis-Vorschläge mit
 * MODELL-ERFUNDENEN Quell-URLs (eBay-SUCH-Links, 404-Herstellerseiten) und
 * price_confidence 0.9. routes/identify.js validateChatPricing() muss VOR dem
 * Emit für alle Pipelines validieren: Such-URLs fliegen strukturell raus,
 * Kandidaten werden geladen; ohne verifizierte Quelle → sources=[],
 * confidence<=0.3 und eine ehrliche ⚠️-Warnung in der Chat-Antwort.
 *
 * Echter Route-Weg (kein Harness): supertest gegen routes/identify mit
 * gemockter V3-Pipeline und gemocktem Seiten-Abruf. Die Beleg-Validierung
 * selbst (lib/price-evidence.js) läuft UNGEMOCKT.
 *
 * CJS test file — nutzt require.cache-Patching (kein vi.mock für CJS).
 */

const request = require('supertest');
const path = require('path');

// ─── 1) GCP packages must be patched BEFORE any lib module loads ─────────────
require('./_patchGcp');

// ─── 2) Patch local modules before the route loads ───────────────────────────

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

// Rate limiter bypass.
patchLocalModule(path.resolve(__dirname, '../../lib/rate-limit.js'), {
  identifyLimiter: (req, res, next) => next(),
  generalLimiter: (req, res, next) => next(),
});

// Chat-Pipelines: V3 liefert den Incident-Payload, V2/Legacy dürfen nie laufen.
const chatV3Spy = vi.fn();
patchLocalModule(path.resolve(__dirname, '../../services/product-chat-v3.js'), {
  runProductChatV3: chatV3Spy,
  chatV3Enabled: () => true,
});
const chatV2Spy = vi.fn();
patchLocalModule(path.resolve(__dirname, '../../services/product-chat-v2.js'), {
  runProductChatV2: chatV2Spy,
});
const chatLegacySpy = vi.fn();
patchLocalModule(path.resolve(__dirname, '../../services/product-chat.js'), {
  runProductChat: chatLegacySpy,
});

// Chat sessions — noop stubs.
patchLocalModule(path.resolve(__dirname, '../../lib/chat-sessions.js'), {
  buildSessionId: (u, p) => `${u || 'u'}__${p || 'p'}`,
  getSession: vi.fn().mockResolvedValue(null),
  appendMessages: vi.fn().mockResolvedValue(),
  clearSession: vi.fn().mockResolvedValue(),
  getGeminiHistory: () => [],
});

// Seiten-Abruf: price-evidence.js lazy-required fetchText/htmlToText aus
// web-search-html — hier kontrollierbar gemockt (kein echtes Netz).
const fetchTextMock = vi.fn();
patchLocalModule(path.resolve(__dirname, '../../lib/web-search-html.js'), {
  searchWeb: vi.fn().mockResolvedValue([]),
  fetchPageText: vi.fn().mockResolvedValue({ ok: false, status: 404, text: '' }),
  fetchText: fetchTextMock,
  htmlToText: (html) => String(html || ''),
  decodeHtmlEntities: (t) => String(t || ''),
  normalizeSpaces: (t) => String(t || '').replace(/\s+/g, ' ').trim(),
  safeString: (v) => (v == null ? '' : String(v)),
  DOMAIN_BLOCKLIST: [],
});

// ─── 3) Load shared mocks + route ─────────────────────────────────────────────
require('./_patchLocalModules');
const { spies: firebaseSpies } = require('./_setupMocks');
const { createTestApp } = require('./_createApp');
const identifyRouter = require('../../routes/identify');

const app = createTestApp(identifyRouter);

// ─── 4) Fixtures ──────────────────────────────────────────────────────────────

const SAMPLE_PRODUCT = {
  id: 'SKU-PRICE-EVIDENCE',
  identification: {
    name: 'HOMEDEMO Klemmmarkise 300x150cm Anthrazit Balkonmarkise',
    brand: 'HOMEDEMO',
    sku: 'SKU-PRICE-EVIDENCE',
  },
  details: { identifiers: { mpn: '65858' } },
};

const SEARCH_URL = 'https://www.ebay.de/sch/i.html?_nkw=test';
const FAKE_CANDIDATE_URL = 'https://homedemo.de/products/fake';

// Frisches Ergebnis pro Call — die Route mutiert datasheetChanges in place.
function buildV3ResultWithPricing() {
  return {
    message: 'Preis recherchiert',
    datasheetChanges: [
      {
        summary: 'x',
        pricing: {
          lowest_price: {
            amount: 61.99,
            currency: 'EUR',
            sources: [
              { url: SEARCH_URL, price: 59.79 },
              { url: FAKE_CANDIDATE_URL, price: 61.99 },
            ],
          },
          price_confidence: 0.9,
        },
      },
    ],
  };
}

// Seite mit Marke + behauptetem Preis (>=200 Zeichen inkl. Padding).
const VERIFIED_PAGE_HTML =
  '<h1>HOMEDEMO Klemmmarkise 300x150 cm Anthrazit</h1>' +
  '<p>Balkonmarkise ohne Bohren, mit einstellbarer Handkurbel. Artikelnummer 65858.</p>' +
  '<p>Preis: 61,99 EUR inkl. MwSt.</p>' +
  '<p>Ausführliche Hinweise zur Montage, Pflege und Bedienung der Markise folgen weiter unten auf dieser Produktseite.</p>'.repeat(3);

describe('POST /api/chat — Preis-Beleg-Chokepoint (validateChatPricing)', () => {
  beforeEach(() => {
    chatV3Spy.mockReset();
    chatV2Spy.mockReset();
    chatLegacySpy.mockReset();
    fetchTextMock.mockReset();
    firebaseSpies.getProduct?.mockReset();
    firebaseSpies.getProduct?.mockResolvedValue(SAMPLE_PRODUCT);
    process.env.CHAT_GROUNDING = 'true';
    // price-evidence fällt bei fetchText-Fehlschlag auf einen direkten
    // globalen fetch() zurück — im Test hart auf 404 stubben (kein Netz).
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, text: async () => '' })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('unbelegter Preis (404-Quelle + Such-URL) → sources leer, confidence<=0.3, ⚠️ in der Antwort', async () => {
    chatV3Spy.mockImplementation(async () => buildV3ResultWithPricing());
    fetchTextMock.mockResolvedValue({ ok: false, status: 404, body: '', via: 'test' });

    const res = await request(app)
      .post('/api/chat')
      .send({ productId: SAMPLE_PRODUCT.id, message: 'Preis recherchieren' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.pipeline).toBe('v3');

    const pricing = res.body.data.datasheetChanges[0].pricing;
    expect(pricing.lowest_price.sources).toEqual([]);
    expect(pricing.price_confidence).toBeLessThanOrEqual(0.3);
    expect(pricing.lowest_price.evidence_check).toBeTruthy();
    expect(pricing.lowest_price.evidence_check.verified).toBe(0);
    expect(pricing.lowest_price.evidence_check.dropped).toBe(2);
    expect(pricing.lowest_price.evidence_check.dropped_reasons).toContain('search:search_or_category_page');

    // Ehrliche Warnung statt "wurde aktualisiert".
    expect(res.body.data.message).toContain('⚠️');
    expect(res.body.data.message).toContain('UNBELEGT');

    // amount bleibt unangetastet.
    expect(pricing.lowest_price.amount).toBe(61.99);

    // Nur die Kandidaten-URL wird geladen — die Such-URL fliegt strukturell raus.
    const fetchedUrls = fetchTextMock.mock.calls.map((c) => c[0]);
    expect(fetchedUrls).toContain(FAKE_CANDIDATE_URL);
    expect(fetchedUrls).not.toContain(SEARCH_URL);
  });

  it('verifizierte Kandidaten-Quelle bleibt erhalten (verified:true), Such-URL wird trotzdem verworfen', async () => {
    chatV3Spy.mockImplementation(async () => buildV3ResultWithPricing());
    fetchTextMock.mockResolvedValue({ ok: true, status: 200, body: VERIFIED_PAGE_HTML, via: 'test' });

    const res = await request(app)
      .post('/api/chat')
      .send({ productId: SAMPLE_PRODUCT.id, message: 'Preis recherchieren' });

    expect(res.status).toBe(200);
    const pricing = res.body.data.datasheetChanges[0].pricing;
    expect(pricing.lowest_price.sources).toHaveLength(1);
    expect(pricing.lowest_price.sources[0].url).toBe(FAKE_CANDIDATE_URL);
    expect(pricing.lowest_price.sources[0].verified).toBe(true);
    expect(pricing.lowest_price.evidence_check.verified).toBe(1);
    // Confidence bleibt — es gibt einen echten Beleg.
    expect(pricing.price_confidence).toBe(0.9);
    // Die verworfene Such-URL wird ehrlich vermerkt.
    expect(res.body.data.message).toContain('1 von 2');
  });

  it('Chat ohne pricing-Änderungen → Validator greift nicht, Antwort unverändert', async () => {
    chatV3Spy.mockResolvedValue({
      message: 'Nur eine Info-Antwort',
      datasheetChanges: [{ summary: 'Titel angepasst', identification: { name: 'Neuer Titel' } }],
    });

    const res = await request(app)
      .post('/api/chat')
      .send({ productId: SAMPLE_PRODUCT.id, message: 'Info bitte' });

    expect(res.status).toBe(200);
    expect(res.body.data.message).toBe('Nur eine Info-Antwort');
    expect(res.body.data.message).not.toContain('⚠️');
    expect(fetchTextMock).not.toHaveBeenCalled();
  });
});

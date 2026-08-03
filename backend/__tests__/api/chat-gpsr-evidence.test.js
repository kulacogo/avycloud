/**
 * Route-Level-Test: GPSR-Beleg-Chokepoint in POST /api/chat (sync).
 *
 * AUDIT 2026-07-16: Die Chat-Pipelines durften Hersteller-/GPSR-Felder OHNE
 * jede Validierung ändern (okopp@apple.com als Apple-Kontakt, Telefon
 * "+496105456789") — exakt das Muster des Preis-Halluzinations-Incidents.
 * routes/identify.js validateChatGpsr() muss VOR dem Emit für alle Pipelines
 * validieren: unbelegbare/fake gpsr-Änderungen fliegen aus den Change-Cards
 * + ⚠️-Warnung; verified bleibt mit gpsr_evidence_check an der Card.
 *
 * Echter Route-Weg (kein Harness): supertest gegen routes/identify mit
 * gemockter V3-Pipeline und gemocktem Seiten-Abruf. Die Beleg-Validierung
 * selbst (services/chat-enricher.js + lib/gpsr-evidence.js) läuft UNGEMOCKT.
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

// Chat-Pipelines: V3 liefert den Payload, V2/Legacy dürfen nie laufen.
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

// Seiten-Abruf: gpsr-evidence nutzt fetchPageForVerification aus
// price-evidence, das fetchText/htmlToText lazy aus web-search-html zieht —
// hier kontrollierbar gemockt (kein echtes Netz).
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
  id: 'SKU-GPSR-EVIDENCE',
  identification: {
    name: 'ACME Messgerät Digital 2000',
    brand: 'ACME',
    sku: 'SKU-GPSR-EVIDENCE',
  },
  details: { gpsr: {} },
};

// Frisches Ergebnis pro Call — die Route mutiert datasheetChanges in place.
function buildV3ResultWithGpsr(extraGpsr = {}) {
  return {
    message: 'GPSR-Daten recherchiert und übernommen.',
    datasheetChanges: [
      {
        summary: 'GPSR ergänzt',
        gpsr: {
          manufacturer_name: 'ACME Instruments GmbH',
          manufacturer_address: 'Hauptstr. 12',
          manufacturer_city: 'Berlin',
          manufacturer_postalcode: '10115',
          entity_country: 'Germany',
          url: 'https://www.acme-example.de',
          ...extraGpsr,
        },
      },
    ],
  };
}

// Impressum-Seite mit Name + Adress-Kern (>=200 Zeichen).
const VERIFIED_PAGE_HTML = [
  '<h1>Impressum</h1>',
  '<p>ACME Instruments GmbH</p>',
  '<p>Hauptstraße 12</p>',
  '<p>10115 Berlin, Deutschland</p>',
  '<p>Vertreten durch die Geschäftsführung. Registergericht Berlin-Charlottenburg, HRB 123456.</p>',
  '<p>Umsatzsteuer-Identifikationsnummer gemäß §27a UStG: DE123456789.</p>',
].join('\n');

describe('POST /api/chat — GPSR-Beleg-Chokepoint (validateChatGpsr)', () => {
  beforeEach(() => {
    chatV3Spy.mockReset();
    chatV2Spy.mockReset();
    chatLegacySpy.mockReset();
    fetchTextMock.mockReset();
    firebaseSpies.getProduct?.mockReset();
    firebaseSpies.getProduct?.mockResolvedValue(SAMPLE_PRODUCT);
    process.env.CHAT_GROUNDING = 'true';
    // gpsr-evidence fällt bei fetchText-Fehlschlag auf einen direkten
    // globalen fetch() zurück — im Test hart auf 404 stubben (kein Netz).
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, text: async () => '' })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('unbelegte GPSR-Änderung (404-Quelle) → Card bleibt als UNBESTÄTIGT sichtbar + ⚠️ (seit 2026-08-04)', async () => {
    // Verhalten geändert (Incident SKU-2834170242): Im interaktiven Chat wird
    // ein unbelegbarer Vorschlag nicht mehr GELÖSCHT (der User sah die Werte
    // nie), sondern als unbestätigte Karte behalten — der Mensch entscheidet.
    chatV3Spy.mockImplementation(async () => buildV3ResultWithGpsr());
    fetchTextMock.mockResolvedValue({ ok: false, status: 404, body: '', via: 'test' });

    const res = await request(app)
      .post('/api/chat')
      .send({ productId: SAMPLE_PRODUCT.id, message: 'GPSR recherchieren' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.pipeline).toBe('v3');

    // Die Card bleibt sichtbar, ist aber als unverified markiert.
    const gpsrCards = (res.body.data.datasheetChanges || []).filter((c) => c && c.gpsr);
    expect(gpsrCards).toHaveLength(1);
    expect(gpsrCards[0].gpsr_evidence_check.outcome).toBe('unverified');

    // Ehrliche Warnung statt "wurde übernommen".
    expect(res.body.data.message).toContain('⚠️');
    expect(res.body.data.message).toContain('UNBESTÄTIGT');
  });

  it('Kill-Switch GPSR_GATE_KEEP_UNVERIFIED=off: unbelegte Card wird wie früher entfernt + Widerruf', async () => {
    process.env.GPSR_GATE_KEEP_UNVERIFIED = 'off';
    try {
      chatV3Spy.mockImplementation(async () => buildV3ResultWithGpsr());
      fetchTextMock.mockResolvedValue({ ok: false, status: 404, body: '', via: 'test' });

      const res = await request(app)
        .post('/api/chat')
        .send({ productId: SAMPLE_PRODUCT.id, message: 'GPSR recherchieren' });

      expect(res.status).toBe(200);
      const gpsrCards = (res.body.data.datasheetChanges || []).filter((c) => c && c.gpsr);
      expect(gpsrCards).toHaveLength(0);
      expect(res.body.data.message).toContain('UNBELEGT');
      expect(res.body.data.message).toContain('NICHT bestätigt');
    } finally {
      delete process.env.GPSR_GATE_KEEP_UNVERIFIED;
    }
  });

  it('verifizierte GPSR-Änderung bleibt erhalten und trägt gpsr_evidence_check', async () => {
    chatV3Spy.mockImplementation(async () => buildV3ResultWithGpsr());
    fetchTextMock.mockResolvedValue({ ok: true, status: 200, body: VERIFIED_PAGE_HTML, via: 'test' });

    const res = await request(app)
      .post('/api/chat')
      .send({ productId: SAMPLE_PRODUCT.id, message: 'GPSR recherchieren' });

    expect(res.status).toBe(200);
    const cards = res.body.data.datasheetChanges || [];
    const gpsrCard = cards.find((c) => c && c.gpsr);
    expect(gpsrCard).toBeTruthy();
    expect(gpsrCard.gpsr.manufacturer_name).toBe('ACME Instruments GmbH');
    expect(gpsrCard.gpsr_evidence_check).toBeTruthy();
    expect(gpsrCard.gpsr_evidence_check.outcome).toBe('verified');
    expect(gpsrCard.gpsr_evidence_check.url).toBe('https://www.acme-example.de/');
    expect(res.body.data.message).not.toContain('NICHT bestätigt');
  });

  it('Fake-Telefon im Vorschlag (+496105456789) → Card entfernt, auch wenn die Seite Name+Adresse belegt', async () => {
    chatV3Spy.mockImplementation(async () => buildV3ResultWithGpsr({ manufacturer_phone: '+496105456789' }));
    fetchTextMock.mockResolvedValue({ ok: true, status: 200, body: VERIFIED_PAGE_HTML, via: 'test' });

    const res = await request(app)
      .post('/api/chat')
      .send({ productId: SAMPLE_PRODUCT.id, message: 'GPSR recherchieren' });

    expect(res.status).toBe(200);
    const gpsrCards = (res.body.data.datasheetChanges || []).filter((c) => c && c.gpsr);
    expect(gpsrCards).toHaveLength(0);
    expect(res.body.data.message).toContain('⚠️');
    expect(res.body.data.message).toMatch(/Platzhalter|Halluzination/);
  });

  it('Chat ohne gpsr-Änderungen → Validator greift nicht, Antwort unverändert', async () => {
    chatV3Spy.mockResolvedValue({
      message: 'Nur eine Info-Antwort',
      datasheetChanges: [{ summary: 'Titel angepasst', title: 'Neuer Titel' }],
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

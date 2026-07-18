'use strict';

// Vitest globals (globals:true). Chat-V3 sendet die eigenen Produktbilder ans
// Modell (Incident 2026-07-17: V3 war blind fürs Verpackungs-Etikett → GPSR
// geraten). Kein echter Gemini-Call — aiClient injiziert; global.fetch stubben.

const path = require('path');
const chatV3Path = path.join(__dirname, '..', '..', 'services', 'product-chat-v3.js');
const chatV3 = require(chatV3Path);
const { runProductChatV3, _testables } = chatV3;

function mkFakeResponse({ functionCalls = [], text = '' } = {}) {
  const parts = [];
  if (text) parts.push({ text });
  return { text, functionCalls, candidates: [{ content: { parts } }] };
}

function mkFakeAiClient(scripted = []) {
  const calls = { sendMessage: [] };
  const queue = [...scripted];
  const chat = {
    sendMessage: vi.fn(async (args) => {
      calls.sendMessage.push(args);
      if (!queue.length) return mkFakeResponse({ text: 'done.' });
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next;
    }),
  };
  return { chats: { create: vi.fn(() => chat) }, __chat: chat, __calls: calls };
}

function productWithImage(url) {
  return {
    id: 'p_img',
    identification: { name: 'Gr4tec Deckenstrahler', brand: 'Gr4tec', barcodes: [] },
    details: { identifiers: {}, attributes: {}, images: [{ url_or_base64: url, variant: 'label' }] },
  };
}

describe('chat-v3 suggest_product_images führt echte Bildsuche aus (Incident 2026-07-18)', () => {
  const imageSearch = require(path.join(__dirname, '..', '..', 'lib', 'image-search'));
  let origSearch;
  let origFetch;
  beforeEach(() => { origSearch = imageSearch.searchProductImages; origFetch = global.fetch; global.fetch = vi.fn(async () => { throw new Error('no-img'); }); });
  afterEach(() => { imageSearch.searchProductImages = origSearch; global.fetch = origFetch; });

  it('ruft searchProductImages und liefert aufgelöste Bilder in imageSuggestions (nicht nur "queued")', async () => {
    imageSearch.searchProductImages = vi.fn(async () => ([
      { url: 'https://shop.example/img1.jpg', source: 'google_images', title: 'Bauer Vapor X5' },
      { url: 'https://shop.example/img2.jpg', source: 'google_images', title: 'Bauer Vapor X5 seitlich' },
    ]));
    const aiClient = mkFakeAiClient([
      mkFakeResponse({ functionCalls: [{ name: 'suggest_product_images', args: { query: 'Bauer Vapor X5 Pro', rationale: 'Nutzer will Bilder' } }] }),
      mkFakeResponse({ text: 'Ich habe 2 Produktbilder gefunden.' }),
    ]);
    const result = await runProductChatV3({
      product: { id: 'p1', identification: { name: 'Bauer Vapor X5', brand: 'Bauer', barcodes: [] }, details: { images: [] } },
      message: 'finde produktbilder',
      aiClient,
    });
    expect(imageSearch.searchProductImages).toHaveBeenCalledTimes(1);
    expect(imageSearch.searchProductImages.mock.calls[0][1]).toMatchObject({ query: 'Bauer Vapor X5 Pro', limit: 6 });
    expect(Array.isArray(result.imageSuggestions)).toBe(true);
    expect(result.imageSuggestions).toHaveLength(1);
    expect(result.imageSuggestions[0].images).toHaveLength(2);
    expect(result.imageSuggestions[0].images[0].url_or_base64).toBe('https://shop.example/img1.jpg');
  });

  it('leere Suche → kein Vorschlag (kein leerer Karten-Stub)', async () => {
    imageSearch.searchProductImages = vi.fn(async () => ([]));
    const aiClient = mkFakeAiClient([
      mkFakeResponse({ functionCalls: [{ name: 'suggest_product_images', args: { query: 'ObskuresProdukt' } }] }),
      mkFakeResponse({ text: 'Leider keine Bilder gefunden.' }),
    ]);
    const result = await runProductChatV3({
      product: { id: 'p2', identification: { name: 'X', brand: 'Y', barcodes: [] }, details: { images: [] } },
      message: 'finde produktbilder',
      aiClient,
    });
    expect(imageSearch.searchProductImages).toHaveBeenCalledTimes(1);
    expect(result.imageSuggestions).toHaveLength(0);
  });
});

describe('chat-v3 fetchProductImageParts', () => {
  let origFetch;
  beforeEach(() => { origFetch = global.fetch; });
  afterEach(() => { global.fetch = origFetch; });

  it('lädt http-Bilder als inlineData-Parts', async () => {
    const buf = Buffer.alloc(1024, 1);
    global.fetch = vi.fn(async () => ({
      ok: true,
      headers: { get: () => 'image/jpeg' },
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    }));
    const parts = await _testables.fetchProductImageParts(productWithImage('https://x/label.jpg'));
    expect(parts).toHaveLength(1);
    expect(parts[0].inlineData.mimeType).toBe('image/jpeg');
    expect(typeof parts[0].inlineData.data).toBe('string');
  });

  it('gibt [] zurück ohne http-Bilder (nie werfen)', async () => {
    const parts = await _testables.fetchProductImageParts({ details: { images: [{ url_or_base64: 'data:...' }] } });
    expect(parts).toEqual([]);
  });

  it('verwirft fehlgeschlagene Abrufe pro Bild, wirft nie', async () => {
    global.fetch = vi.fn(async () => { throw new Error('network'); });
    const parts = await _testables.fetchProductImageParts(productWithImage('https://x/label.jpg'));
    expect(parts).toEqual([]);
  });
});

describe('runProductChatV3 — Produktbilder in initialer User-Message', () => {
  let origFetch;
  beforeEach(() => { origFetch = global.fetch; });
  afterEach(() => { global.fetch = origFetch; });

  it('sendet Produktbild-Parts (nach Text, vor Attachments) + meldet productImagesSent', async () => {
    const buf = Buffer.alloc(2048, 2);
    global.fetch = vi.fn(async () => ({
      ok: true,
      headers: { get: () => 'image/png' },
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    }));
    const aiClient = mkFakeAiClient([
      mkFakeResponse({ functionCalls: [{ id: 'c1', name: 'update_product_datasheet', args: { summary: 'ok', identity: { brand: 'Gr4tec' } } }] }),
      mkFakeResponse({ text: 'Fertig.' }),
    ]);
    const result = await runProductChatV3({
      product: productWithImage('https://x/label.jpg'),
      message: 'GPSR-Daten vom Etikett bitte',
      aiClient,
    });
    expect(result.productImagesSent).toBe(1);
    const firstMsg = aiClient.__calls.sendMessage[0].message;
    expect(Array.isArray(firstMsg)).toBe(true);
    // Reihenfolge: [text, inlineData]
    expect(firstMsg[0].text).toContain('GPSR');
    expect(firstMsg[1].inlineData.mimeType).toBe('image/png');
  });

  it('productImagesSent=0 wenn keine Bilder ladbar', async () => {
    global.fetch = vi.fn(async () => { throw new Error('down'); });
    const aiClient = mkFakeAiClient([
      mkFakeResponse({ functionCalls: [{ id: 'c1', name: 'update_product_datasheet', args: { summary: 'ok' } }] }),
      mkFakeResponse({ text: 'Fertig.' }),
    ]);
    const result = await runProductChatV3({
      product: productWithImage('https://x/label.jpg'),
      message: 'test',
      aiClient,
    });
    expect(result.productImagesSent).toBe(0);
  });
});

describe('chat-v3 gpsr source-Marker Sanitizer', () => {
  it('behält source=product_image, verwirft andere source-Werte', () => {
    const kept = _testables.sanitizeDatasheetChangeV3({ gpsr: { manufacturer_name: 'X', source: 'product_image' } });
    expect(kept.gpsr.source).toBe('product_image');
    const dropped = _testables.sanitizeDatasheetChangeV3({ gpsr: { manufacturer_name: 'X', source: 'web' } });
    expect('source' in dropped.gpsr).toBe(false);
  });
});

// Vorfall 2026-10-11 (SKU-5078187818, Eucerin): Kaufland vergibt eine id_offer
// nur EINMAL ueber alle Laender. Das deutsche Angebot war verschwunden, die
// Kopien aus dem Laenderuebergreifend-Verkauf (CZ/SK/PL, 03.10.) blieben stehen
// und blockierten jedes neue deutsche Angebot mit dem englischen
// "A unit with the id_offer ... already exists." — fuer den Bediener nicht
// aufloesbar. Gemessen: POST cz mit einer nur in DE vergebenen SKU liefert
// dieselbe Meldung, die Sperre gilt also laenderuebergreifend.
// Erwartung: die Meldung nennt Land + Angebots-ID; es wird NICHTS geloescht.
function patch(p, exports) { const id = require.resolve(p); require.cache[id] = { id, filename: id, loaded: true, exports }; }
const calls = [];
let unitsByStorefront = {};
let lookupFails = false;
patch('../services/integration-store', { resolveProviderCredentials: async () => ({ clientKey: 'test', secretKey: 'test' }) });
patch('node-fetch', async (url, opts) => {
  const u = new URL(url);
  const sf = u.searchParams.get('storefront');
  calls.push({ method: opts.method, path: u.pathname, sf });
  const reply = (status, json) => ({ ok: status < 400, status, text: async () => JSON.stringify(json), headers: { get: () => null } });
  if (opts.method === 'POST' && u.pathname.endsWith('/units')) {
    return reply(400, { message: 'A unit with the id_offer SKU-WAISE already exists.' });
  }
  if (opts.method === 'GET' && u.pathname.endsWith('/units')) {
    if (lookupFails && sf !== 'de') return reply(503, { message: 'down' });
    return reply(200, { data: unitsByStorefront[sf] || [] });
  }
  return reply(200, { data: {} });
});
patch('../lib/marketplace-stock-quantity', { resolveMarketplaceQuantity: () => 3, readMarketplaceQuantity: async () => 3 });
const { createUnit } = require('../lib/kaufland-api');
const product = { id: 'p1', tenantId: 'default', identification: { sku: 'SKU-WAISE' }, inventory: { quantity: 3 }, storageBins: [{ code: 'A-01', quantity: 3 }], details: { identifiers: { ean: '4006633144780' }, pricing: { sellPrice: 29 } } };
const publish = () => createUnit(product, { manualActivation: true, autoCreateProductData: false }).catch(e => e);
beforeEach(() => { calls.length = 0; unitsByStorefront = {}; lookupFails = false; });

it('SKU nur noch im Ausland vergeben: Meldung nennt Laender und Angebots-IDs', async () => {
  unitsByStorefront = {
    cz: [{ id_unit: 111, id_offer: 'SKU-WAISE', status: 'AVAILABLE', amount: 20 }],
    pl: [{ id_unit: 333, id_offer: 'SKU-WAISE', status: 'AVAILABLE', amount: 20 }],
  };
  const err = await publish();
  expect(err.code).toBe('KAUFLAND_ID_OFFER_TAKEN_OTHER_STOREFRONT');
  expect(err.message).toMatch(/CZ \(Angebot 111\)/);
  expect(err.message).toMatch(/PL \(Angebot 333\)/);
  expect(err.message).toMatch(/Kaufland-Händlerportal/);
  expect(err.storefronts).toEqual(['cz', 'pl']);
});

it('niemals destruktiv: kein DELETE, nur lesende Abfragen', async () => {
  unitsByStorefront = { sk: [{ id_unit: 222, id_offer: 'SKU-WAISE', status: 'AVAILABLE', amount: 1 }] };
  await publish();
  expect(calls.filter(c => c.method === 'DELETE' || c.method === 'PATCH')).toHaveLength(0);
  expect(calls.filter(c => c.method === 'POST')).toHaveLength(1);
});

it('nirgends gefunden: Kauflands Originalmeldung bleibt', async () => {
  const err = await publish();
  expect(err.message).toBe('A unit with the id_offer SKU-WAISE already exists.');
  expect(err.code).toBe('KAUFLAND_HTTP_400');
});

it('Nachschlagen scheitert: Originalmeldung bleibt, kein Absturz', async () => {
  lookupFails = true;
  const err = await publish();
  expect(err.message).toBe('A unit with the id_offer SKU-WAISE already exists.');
});

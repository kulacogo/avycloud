// Vorfall 2026-09-27: POST /units lehnt jedes Feld ausser dem Einheiten-Schema
// mit HTTP 400 ab — live gemessen:
//   {"field":"parameters.status","message":"\"status\" is an excess property and therefore is not allowed"}
// createUnit hatte nach der Bestands-Nachpruefung `status` in den POST-Koerper
// gelegt. Folge: KEIN neues Kaufland-Angebot mit Bestand liess sich mehr anlegen,
// der Bediener sah nur "Validation Failed". Der Status darf nur im Rueckgabewert
// stehen (fuer den optimistischen Spiegel), nie im Anlege-Aufruf.
function patch(p, exports) { const id = require.resolve(p); require.cache[id] = { id, filename: id, loaded: true, exports }; }
const calls = [];
let stock = 2;
let postRejection = null;
patch('../services/integration-store', { resolveProviderCredentials: async () => ({ clientKey: 'test', secretKey: 'test' }) });
patch('node-fetch', async (url, opts) => {
  calls.push({ url, method: opts.method, body: opts.body ? JSON.parse(opts.body) : null });
  if (opts.method === 'POST' && postRejection) {
    return { ok: false, status: 400, text: async () => JSON.stringify(postRejection), headers: { get: () => null } };
  }
  // GET /units (Bestandsangebot suchen) → keines vorhanden; POST /units → angelegt.
  const data = opts.method === 'GET' ? [] : { id_unit: 555 };
  return { ok: true, status: 200, text: async () => JSON.stringify({ data }), headers: { get: () => null } };
});
patch('../lib/marketplace-stock-quantity', { resolveMarketplaceQuantity: () => 2, readMarketplaceQuantity: async () => stock });
const { createUnit } = require('../lib/kaufland-api');
const product = { id: 'p1', tenantId: 'default', identification: { sku: 'SKU-NEU' }, inventory: { quantity: 2 }, storageBins: [{ code: 'A-01', quantity: 2 }], details: { identifiers: { ean: '4006633144780' }, pricing: { sellPrice: 29 } } };
beforeEach(() => { calls.length = 0; stock = 2; postRejection = null; });

it('neues Angebot mit Bestand: POST /units traegt kein status-Feld', async () => {
  const result = await createUnit(product, { manualActivation: true, autoCreateProductData: false });
  const post = calls.find(c => c.method === 'POST');
  expect(post.body).toMatchObject({ id_offer: 'SKU-NEU', amount: 2 });
  expect(post.body).not.toHaveProperty('status');
  expect(result).toMatchObject({ created: true, id_unit: 555, amount: 2, status: 'AVAILABLE' });
});

it('Bestand verschwindet waehrend der Katalog-Vorbereitung: Menge 0, trotzdem kein status-Feld', async () => {
  stock = 0;
  const result = await createUnit(product, { manualActivation: true, autoCreateProductData: false });
  const post = calls.find(c => c.method === 'POST');
  expect(post.body.amount).toBe(0);
  expect(post.body).not.toHaveProperty('status');
  expect(result).toMatchObject({ created: true, amount: 0, status: 'ONHOLD' });
});

// Der Bediener sah nur "Validation Failed" — Kauflands Begruendung steht aber
// im Antwortkoerper und muss in der Meldung ankommen, sonst ist jeder
// kuenftige Schema-Fehler wieder unsichtbar.
it('Ablehnung durch Kaufland: die Meldung nennt Feld und Grund statt nur "Validation Failed"', async () => {
  postRejection = {
    type: '/problems/validation-error',
    message: 'Validation Failed',
    errors: [{ field: 'parameters.status', message: '"status" is an excess property and therefore is not allowed' }],
  };
  const err = await createUnit(product, { manualActivation: true, autoCreateProductData: false }).catch(e => e);
  expect(err.message).toMatch(/Validation Failed/);
  expect(err.message).toMatch(/status: "status" is an excess property/);
  expect(err.message).not.toMatch(/parameters\./);
  expect(err).toMatchObject({ code: 'KAUFLAND_UNIT_VALIDATION_FAILED', status: 400 });
});

it('Ablehnung ohne Feldliste bleibt unveraendert', async () => {
  postRejection = { message: 'Parameter [warehouse] is missing or has wrong value' };
  const err = await createUnit(product, { manualActivation: true, autoCreateProductData: false }).catch(e => e);
  expect(err.message).toBe('Parameter [warehouse] is missing or has wrong value');
  expect(err.code).toBe('KAUFLAND_HTTP_400');
});

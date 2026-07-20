// globals: true in vitest.config.js — describe/it/expect/vi are global
//
// REGRESSION GUARD — Incident 2026-07-20 (~68 Duplikat-Rechnungen ≈ 3.188 €
// Phantom-Umsatz, Wiederholung von Incident 2026-05-31).
//
// generateInvoice prägte die SevDesk-Rechnung (saveInvoice), konnte aber die
// Rechnungsnummer aus der sendBy-Antwort nicht mehr parsen (SevDesk-Shape-
// Drift: starrer Zugriff `sd?.objects?.invoiceNumber`) → warf NACH dem
// Anlegen, OHNE die sevdeskId zu persistieren. Jeder Retry (Ship-Trigger,
// [complete]-Handler, 24h-Cron) prägte eine weitere ECHTE SevDesk-Rechnung —
// Order ebay__14-14913-05266 bekam VIER (RE-1194/1196/1197/1198) an einem
// Morgen. Steuerrelevante Dokumente + doppelte offene Forderungen.
//
// Fix-Verhalten:
//  1. extractSevdeskInvoiceNumber toleriert alle bekannten Response-Shapes.
//  2. sevdeskId wird SOFORT nach saveInvoice am Order-Doc persistiert.
//  3. Retry mit order.invoiceSevdeskId prägt NIE neu (kein saveInvoice-Call),
//     sondern finalisiert/liest die bestehende Rechnung.
//  4. Fehlt die Nummer nach sendBy, wird sie per GET /Invoice/{id} nachgelesen.

function patchCjsModule(modulePath, mockExports) {
  const resolvedPath = require.resolve(modulePath);
  require.cache[resolvedPath] = {
    id: resolvedPath, filename: resolvedPath, loaded: true,
    exports: mockExports, children: [], paths: [],
  };
}

patchCjsModule('@google-cloud/firestore', {
  Firestore: function () { return { collection: () => ({ doc: () => ({}) }) }; },
  FieldValue: {},
});
patchCjsModule('@google-cloud/storage', { Storage: function () { return {}; } });
patchCjsModule('../services/integration-store', {
  getIntegrationSecret: vi.fn(async () => 'sevdesk-token'),
});

const { extractSevdeskInvoiceNumber } = require('../services/invoice-engine');

describe('extractSevdeskInvoiceNumber — Shape-tolerant (der Parse-Bug hinter den Duplikaten)', () => {
  it('liest das legacy sendBy-Shape objects.invoiceNumber', () => {
    expect(extractSevdeskInvoiceNumber({ objects: { invoiceNumber: 'RE-1201' } })).toBe('RE-1201');
  });

  it('liest das verschachtelte Shape objects.invoice.invoiceNumber', () => {
    expect(extractSevdeskInvoiceNumber({ objects: { invoice: { invoiceNumber: 'RE-1202' } } })).toBe('RE-1202');
  });

  it('liest das GET /Invoice/{id}-Shape objects[0].invoiceNumber', () => {
    expect(extractSevdeskInvoiceNumber({ objects: [{ invoiceNumber: 'RE-1203' }] })).toBe('RE-1203');
  });

  it('toleriert numerische Nummern', () => {
    expect(extractSevdeskInvoiceNumber({ objects: { invoiceNumber: 1204 } })).toBe('1204');
  });

  it('liefert null bei leerer/fehlender Nummer (→ Deferral, NIE lokale Ersatznummer)', () => {
    expect(extractSevdeskInvoiceNumber({ objects: {} })).toBe(null);
    expect(extractSevdeskInvoiceNumber({ objects: { invoiceNumber: '   ' } })).toBe(null);
    expect(extractSevdeskInvoiceNumber(null)).toBe(null);
    expect(extractSevdeskInvoiceNumber({})).toBe(null);
  });
});

describe('Mint-once-Invariante (statische Absicherung des Codepfads)', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../services/invoice-engine.js'), 'utf8');

  it('saveInvoice wird in generateInvoice nur hinter dem priorSevdeskId-Reuse-Guard aufgerufen', () => {
    // Scope: nur der generateInvoice-Body (exportToSevDesk/createCorrection-
    // Invoice haben eigene, legitime saveInvoice-Aufrufe mit eigener
    // Idempotenz). Verhindert, dass ein Refactor den Duplikat-Prägepfad
    // wieder öffnet.
    const start = src.indexOf('async function generateInvoice');
    const end = src.indexOf('async function generateDeliveryNote');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);
    const saveInvoiceCalls = body.match(/Invoice\/Factory\/saveInvoice/g) || [];
    expect(saveInvoiceCalls.length).toBe(1);
    const guardIdx = body.indexOf('priorSevdeskId');
    const mintIdx = body.indexOf('Invoice/Factory/saveInvoice');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(mintIdx);
  });

  it('sevdeskId wird direkt nach dem Mint am Order-Doc persistiert (invoiceSevdeskId)', () => {
    const mintIdx = src.indexOf('Invoice/Factory/saveInvoice');
    const persistIdx = src.indexOf('invoiceSevdeskId: String(sevdeskId)');
    expect(persistIdx).toBeGreaterThan(mintIdx);
    // ... und zwar VOR dem Deferral-Throw (SevDesk hat keine Rechnungsnummer)
    const throwIdx = src.indexOf('SevDesk hat keine Rechnungsnummer vergeben');
    expect(persistIdx).toBeLessThan(throwIdx);
  });

  it('Nummer-Fallback: GET /Invoice/{id} wird nachgelesen wenn sendBy keine Nummer liefert', () => {
    expect(src).toMatch(/api\/v1\/Invoice\/\$\{sevdeskId\}`, \{ headers \}/);
  });
});

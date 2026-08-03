'use strict';

// GPSR-Gate-Härtung (Incident 2026-08-04, SKU-2834170242):
// Das Gate verifizierte NUR über gpsr.url aus dem Vorschlag — ohne URL wurde
// jeder Hersteller-Vorschlag ohne einen einzigen Netz-Request als "unbelegt"
// GELÖSCHT, und der User sah die verworfenen Werte nie. Neu:
//   1. Fehlt die URL, sucht das Gate selbst (Registry → Web-Suche) eine
//      Impressum-Kandidaten-URL und verifiziert dagegen.
//   2. Im interaktiven Chat (failMode 'open') bleibt ein unbelegter Vorschlag
//      als UNBESTÄTIGTE Karte sichtbar statt gelöscht zu werden — der Mensch
//      entscheidet. Bulk (failMode 'closed') verwirft weiterhin hart.
//   3. Fake-Gates (Fake-Telefon/suspekte E-Mail) löschen IMMER — auch im Chat.

const { validateGpsrDatasheetChanges } = require('../services/chat-enricher');

const IMPRESSUM_URL = 'https://www.fjallraven.com/de/de-de';
const IMPRESSUM_PAGE = [
  'Impressum — Angaben gemäß § 5 TMG',
  'Fjällräven International AB',
  'Batterivägen 4',
  '55111 Jönköping',
  'Schweden',
  'Vertreten durch die Geschäftsführung. Kontakt: Telefon und E-Mail siehe Kontaktseite.',
  'Registergericht: Bolagsverket. Umsatzsteuer-Identifikationsnummer gemäß § 27 a Umsatzsteuergesetz.',
  'Verantwortlich für den Inhalt nach § 55 Abs. 2 RStV: Fjällräven International AB, Jönköping.',
].join('\n');

function makeProduct() {
  return {
    id: 'p1',
    identification: { brand: 'FJALLRAVEN' },
    details: { gpsr: { manufacturer_name: 'FJALLRAVEN' } },
  };
}

function makeChange() {
  return {
    summary: 'GPSR recherchiert',
    gpsr: {
      manufacturer_name: 'Fjällräven International AB',
      manufacturer_address: 'Batterivägen 4, 55111 Jönköping, Schweden',
    },
  };
}

const fetchOk = async () => ({ ok: true, status: 200, text: IMPRESSUM_PAGE, html: IMPRESSUM_PAGE, via: 'direct' });
const fetch404 = async () => ({ ok: false, status: 404, text: '', html: '', via: 'direct' });

// vitest.setup.js schaltet die Selbstsuche global aus (kein Netz/Firestore in
// fremden Tests) — hier wird sie explizit aktiviert und komplett injiziert.
beforeEach(() => { process.env.GPSR_GATE_SELF_SEARCH = 'on'; });
afterEach(() => { process.env.GPSR_GATE_SELF_SEARCH = 'off'; });

describe('GPSR-Gate: Selbstsuche der Impressum-URL', () => {
  it('findet die Hersteller-URL per Web-Suche wenn der Vorschlag keine URL hat und verifiziert dagegen', async () => {
    const searchCalls = [];
    const result = await validateGpsrDatasheetChanges({
      product: makeProduct(),
      changes: [makeChange()],
      failMode: 'open',
      fetchImpl: fetchOk,
      searchImpl: async (query) => {
        searchCalls.push(query);
        return { ok: true, results: [{ title: 'Impressum', url: IMPRESSUM_URL, snippet: '' }] };
      },
      registryLookupImpl: async () => null,
    });

    expect(searchCalls.length).toBeGreaterThan(0);
    expect(result.removed).toBe(0);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].gpsr_evidence_check.outcome).toBe('verified');
    // Die selbst gefundene, verifizierte URL wandert in den Vorschlag,
    // damit künftige Prüfungen deterministisch sind.
    expect(result.changes[0].gpsr.url).toContain('fjallraven.com');
  });

  it('konsultiert zuerst die Hersteller-Registry als URL-Quelle', async () => {
    let searched = false;
    const result = await validateGpsrDatasheetChanges({
      product: makeProduct(),
      changes: [makeChange()],
      failMode: 'open',
      fetchImpl: fetchOk,
      searchImpl: async () => { searched = true; return { ok: false, results: [] }; },
      registryLookupImpl: async () => ({ url: IMPRESSUM_URL }),
    });

    expect(searched).toBe(false);
    expect(result.changes[0].gpsr_evidence_check.outcome).toBe('verified');
  });

  it('wertet eine selbst gefundene URL mit reinem Namens-Treffer NICHT als Beleg (partial nur bei Vorschlags-URL)', async () => {
    // Seite enthält nur den Markennamen (wie jede Händler-Seite) — ohne Adresse
    // darf eine SELBST gesuchte URL kein "partial"-Durchwinken erzeugen.
    const nameOnlyFetch = async () => ({ ok: true, status: 200, text: 'Fjällräven International AB Shop', html: '', via: 'direct' });
    const result = await validateGpsrDatasheetChanges({
      product: makeProduct(),
      changes: [makeChange()],
      failMode: 'open',
      fetchImpl: nameOnlyFetch,
      searchImpl: async () => ({ ok: true, results: [{ title: 'x', url: IMPRESSUM_URL, snippet: '' }] }),
      registryLookupImpl: async () => null,
    });

    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].gpsr_evidence_check.outcome).toBe('unverified');
  });
});

describe('GPSR-Gate: Unbestätigt behalten statt löschen (failMode open)', () => {
  it('behält den unbelegbaren Vorschlag als unbestätigte Karte mit Warnung', async () => {
    const result = await validateGpsrDatasheetChanges({
      product: makeProduct(),
      changes: [makeChange()],
      failMode: 'open',
      fetchImpl: fetch404,
      searchImpl: async () => ({ ok: false, results: [] }),
      registryLookupImpl: async () => null,
    });

    expect(result.removed).toBe(0);
    expect(result.unverifiedKept).toBe(1);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].gpsr.manufacturer_name).toBe('Fjällräven International AB');
    expect(result.changes[0].gpsr_evidence_check.outcome).toBe('unverified');
    expect(result.notes.join(' ')).toMatch(/UNBESTÄTIGT/i);
  });

  it('verwirft im Bulk-Modus (failMode closed) weiterhin hart', async () => {
    const result = await validateGpsrDatasheetChanges({
      product: makeProduct(),
      changes: [makeChange()],
      failMode: 'closed',
      fetchImpl: fetch404,
      searchImpl: async () => ({ ok: false, results: [] }),
      registryLookupImpl: async () => null,
    });

    expect(result.removed).toBe(1);
    expect(result.changes).toHaveLength(0);
  });

  it('Fake-Telefon löscht auch im Chat-Modus weiterhin die ganze Änderung', async () => {
    const change = makeChange();
    change.gpsr.manufacturer_phone = '+49123456789';
    const result = await validateGpsrDatasheetChanges({
      product: makeProduct(),
      changes: [change],
      failMode: 'open',
      fetchImpl: fetch404,
      searchImpl: async () => ({ ok: false, results: [] }),
      registryLookupImpl: async () => null,
    });

    expect(result.removed).toBe(1);
    expect(result.changes).toHaveLength(0);
  });

  it('Kill-Switch GPSR_GATE_KEEP_UNVERIFIED=off stellt das alte Lösch-Verhalten wieder her', async () => {
    process.env.GPSR_GATE_KEEP_UNVERIFIED = 'off';
    try {
      const result = await validateGpsrDatasheetChanges({
        product: makeProduct(),
        changes: [makeChange()],
        failMode: 'open',
        fetchImpl: fetch404,
        searchImpl: async () => ({ ok: false, results: [] }),
        registryLookupImpl: async () => null,
      });
      expect(result.removed).toBe(1);
      expect(result.changes).toHaveLength(0);
    } finally {
      delete process.env.GPSR_GATE_KEEP_UNVERIFIED;
    }
  });

  it('Kill-Switch GPSR_GATE_SELF_SEARCH=off unterbindet die Selbstsuche', async () => {
    process.env.GPSR_GATE_SELF_SEARCH = 'off';
    try {
      let searched = false;
      await validateGpsrDatasheetChanges({
        product: makeProduct(),
        changes: [makeChange()],
        failMode: 'open',
        fetchImpl: fetch404,
        searchImpl: async () => { searched = true; return { ok: false, results: [] }; },
        registryLookupImpl: async () => null,
      });
      expect(searched).toBe(false);
    } finally {
      delete process.env.GPSR_GATE_SELF_SEARCH;
    }
  });
});

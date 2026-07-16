'use strict';

/**
 * GPSR-Beleg-Validierung im Bulk-Chat-Enricher (AUDIT 2026-07-16):
 * services/chat-enricher.js validateGpsrDatasheetChanges laeuft VOR dem Apply
 * (Bulk = KEIN Human-Review, daher fail-closed):
 *   - Fake-Muster (Fake-Telefon/suspekte E-Mail) → gpsr-Aenderung fliegt raus
 *   - unverifiable → gpsr-Aenderung fliegt raus
 *   - infra_blocked → durchlassen mit Flag (Netz-Probleme blocken nicht)
 *   - verified/partial → durchlassen, Beleg landet als details.gpsr.evidence
 * Seiten-Abruf via fetchImpl injiziert (kein Netz). Chat via deps injiziert.
 */

const { enrichViaChatV3, validateGpsrDatasheetChanges } = require('../../services/chat-enricher');

const VERIFIED_PAGE_TEXT = [
  'Impressum',
  'ACME Instruments GmbH',
  'Hauptstraße 12',
  '10115 Berlin',
  'Deutschland',
  'Vertreten durch die Geschäftsführung. Registergericht Berlin-Charlottenburg, HRB 123456.',
  'Umsatzsteuer-Identifikationsnummer gemäß §27a UStG: DE123456789.',
  'Verantwortlich für den Inhalt nach § 55 Abs. 2 RStV: Max Beispiel.',
].join('\n');

const UNRELATED_PAGE_TEXT = (
  'Lorem ipsum dolor sit amet, consetetur sadipscing elitr, sed diam nonumy ' +
  'eirmod tempor invidunt ut labore et dolore magna aliquyam erat, sed diam voluptua. '
).repeat(3);

const GPSR_PROPOSAL = {
  manufacturer_name: 'ACME Instruments GmbH',
  manufacturer_address: 'Hauptstr. 12',
  manufacturer_city: 'Berlin',
  manufacturer_postalcode: '10115',
  entity_country: 'Germany',
  url: 'https://www.acme-example.de',
};

function product() {
  return {
    id: 'p1',
    identification: { sku: 'SKU-1', name: 'ACME Messgerät', brand: 'ACME' },
    inventory: { quantity: 2 },
    details: { attributes: {}, gpsr: {} },
    ops: {},
  };
}

const fetchOk = (text) => vi.fn(async () => ({ ok: true, status: 200, text, html: '', via: 'test' }));
const fetchFail = (status) => vi.fn(async () => ({ ok: false, status, text: '', html: '', via: 'test' }));

describe('validateGpsrDatasheetChanges', () => {
  it('entfernt eine gpsr-Aenderung mit Fake-Telefonnummer (Audit-Muster +496105456789)', async () => {
    const changes = [{
      summary: 'GPSR ergänzt',
      gpsr: { ...GPSR_PROPOSAL, manufacturer_phone: '+496105456789' },
    }];
    const out = await validateGpsrDatasheetChanges({
      product: product(),
      changes,
      fetchImpl: fetchOk(VERIFIED_PAGE_TEXT),
    });
    expect(out.removed).toBe(1);
    // Card hatte nur gpsr → komplett verworfen
    expect(out.changes).toHaveLength(0);
    expect(out.notes.some((n) => /Platzhalter|Halluzination/i.test(n))).toBe(true);
  });

  it('entfernt eine unbelegbare gpsr-Aenderung, behaelt aber den Rest der Card (z.B. Titel)', async () => {
    const changes = [{
      title: 'ACME Messgerät Digital 2000',
      gpsr: { ...GPSR_PROPOSAL },
    }];
    const out = await validateGpsrDatasheetChanges({
      product: product(),
      changes,
      fetchImpl: fetchOk(UNRELATED_PAGE_TEXT),
    });
    expect(out.removed).toBe(1);
    expect(out.changes).toHaveLength(1);
    expect(out.changes[0].gpsr).toBeUndefined();
    expect(out.changes[0].title).toBe('ACME Messgerät Digital 2000');
    expect(out.notes.some((n) => /UNBELEGT/.test(n))).toBe(true);
  });

  it('laesst infra_blocked durch, flaggt aber ehrlich (kein Block bei Netz-Problemen)', async () => {
    const changes = [{ gpsr: { ...GPSR_PROPOSAL } }];
    const out = await validateGpsrDatasheetChanges({
      product: product(),
      changes,
      fetchImpl: fetchFail(503),
    });
    expect(out.removed).toBe(0);
    expect(out.infraFlagged).toBe(true);
    expect(out.changes).toHaveLength(1);
    expect(out.changes[0].gpsr).toBeTruthy();
    expect(out.changes[0].gpsr_evidence_check.outcome).toBe('fetch_infrastructure_failure');
  });

  it('laesst verified durch und dokumentiert den Beleg an der Card', async () => {
    const changes = [{ gpsr: { ...GPSR_PROPOSAL } }];
    const out = await validateGpsrDatasheetChanges({
      product: product(),
      changes,
      fetchImpl: fetchOk(VERIFIED_PAGE_TEXT),
    });
    expect(out.removed).toBe(0);
    expect(out.changes[0].gpsr_evidence_check.outcome).toBe('verified');
    expect(out.changes[0].gpsr_evidence_check.url).toBe('https://www.acme-example.de/');
    expect(out.verifiedEvidence.status).toBe('verified');
  });

  it('Altlasten im Bestand blocken fremde Aenderungen nicht (Fake-Telefon NUR im Bestand)', async () => {
    const p = product();
    p.details.gpsr = { ...GPSR_PROPOSAL, manufacturer_phone: '+496105456789' };
    // Vorschlag aendert nur die E-Mail — das Bestands-Fake-Telefon darf die
    // Aenderung nicht als Fake-Vorschlag verwerfen (Verdikt haengt am Netz-Urteil).
    const changes = [{ gpsr: { email: 'info@acme-example.de' } }];
    const out = await validateGpsrDatasheetChanges({
      product: p,
      changes,
      fetchImpl: fetchOk(VERIFIED_PAGE_TEXT),
    });
    expect(out.removed).toBe(0);
    expect(out.changes[0].gpsr_evidence_check.outcome).toBe('verified');
  });
});

describe('enrichViaChatV3 — GPSR-Validierung vor dem Bulk-Apply', () => {
  it('wendet verified gpsr an und schreibt evidence ins Datenblatt', async () => {
    const runProductChatV3 = async () => ({
      datasheetChanges: [{ gpsr: { ...GPSR_PROPOSAL } }],
      confidence: { overall: 0.9 },
      model: 'gemini-3.1-pro-preview-customtools',
    });
    const res = await enrichViaChatV3(product(), {
      deps: { runProductChatV3 },
      gpsrFetchImpl: fetchOk(VERIFIED_PAGE_TEXT),
    });
    expect(res.changed).toContain('gpsr');
    expect(res.product.details.gpsr.manufacturer_name).toBe('ACME Instruments GmbH');
    expect(res.product.details.gpsr.evidence).toEqual(expect.objectContaining({
      status: 'verified',
      source: 'chat-enricher',
    }));
    expect(res.gpsrChangesRemoved).toBe(0);
  });

  it('verwirft unbelegbare gpsr-Vorschlaege VOR dem Apply (Bulk = kein Human-Review)', async () => {
    const runProductChatV3 = async () => ({
      datasheetChanges: [
        { title: 'ACME Messgerät Digital 2000 Profi Edition Labor Werkstatt Industrie' },
        { gpsr: { ...GPSR_PROPOSAL } },
      ],
    });
    const res = await enrichViaChatV3(product(), {
      deps: { runProductChatV3 },
      gpsrFetchImpl: fetchOk(UNRELATED_PAGE_TEXT),
    });
    expect(res.changed).toContain('title');
    expect(res.changed).not.toContain('gpsr');
    expect(res.product.details.gpsr.manufacturer_name).toBeUndefined();
    expect(res.gpsrChangesRemoved).toBe(1);
    expect(res.gpsrWarnings.some((n) => /UNBELEGT/.test(n))).toBe(true);
  });

  it('infra_blocked: wendet an, markiert das Datenblatt aber als unverified', async () => {
    const runProductChatV3 = async () => ({
      datasheetChanges: [{ gpsr: { ...GPSR_PROPOSAL } }],
    });
    const res = await enrichViaChatV3(product(), {
      deps: { runProductChatV3 },
      gpsrFetchImpl: fetchFail(503),
    });
    expect(res.changed).toContain('gpsr');
    expect(res.product.details.gpsr.evidence).toEqual(expect.objectContaining({
      status: 'unverified',
      reason: 'fetch_infrastructure_failure',
      source: 'chat-enricher',
    }));
  });

  it('ohne gpsr-Aenderungen laeuft kein Verifikations-Fetch (No-op)', async () => {
    const fetchSpy = fetchOk(VERIFIED_PAGE_TEXT);
    const runProductChatV3 = async () => ({
      datasheetChanges: [{ attributes: { Produktart: 'Messgerät' } }],
    });
    const res = await enrichViaChatV3(product(), {
      deps: { runProductChatV3 },
      gpsrFetchImpl: fetchSpy,
    });
    expect(res.changed).toContain('attributes');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(res.gpsrWarnings).toEqual([]);
  });
});

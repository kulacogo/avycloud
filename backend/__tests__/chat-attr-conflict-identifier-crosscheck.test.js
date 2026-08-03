'use strict';

// Attribut-Konflikt-Härtung (Incident 2026-08-04, SKU-2834170242):
// conflict_with_existing verwarf JEDEN abweichenden Wert auf einem bestehenden
// Attribut-Key — ohne Quercheck gegen details.identifiers. Damit war der
// nachweislich falsche Altwert (Herstellernummer F23200285) gegen die korrekte
// Chat-Korrektur (F23200283 == identifiers.mpn) immunisiert, und der Verwurf
// passierte STILL. Neu:
//   1. Bestätigt ein Identifier (mpn) den Vorschlag → Korrektur wird akzeptiert.
//   2. Andere Abweichungen bleiben als sichtbarer Vorschlag in der Karte
//      (Mensch entscheidet beim Übernehmen) statt still zu verschwinden.
//   3. Kill-Switch CHAT_ATTR_CONFLICT_MODE=block stellt das alte Verhalten her.

const { _testables } = require('../services/product-chat');

const { sanitizeDatasheetChange } = _testables;

function makeProduct() {
  return {
    id: 'p1',
    identification: { name: 'Fjällräven Färden Duffel 80', brand: 'FJALLRAVEN' },
    details: {
      attributes: {
        Marke: 'FJALLRAVEN',
        Herstellernummer: 'F23200285',
        Farbe: 'Coal Black',
      },
      identifiers: { mpn: 'F23200283', ean: '7323451061820' },
    },
  };
}

describe('sanitizeDatasheetChange — Attribut-Konflikte', () => {
  it('akzeptiert eine Korrektur, die durch identifiers.mpn bestätigt ist', () => {
    const { change, policyIssues } = sanitizeDatasheetChange(
      { attributes: { Herstellernummer: 'F23200283' } },
      makeProduct()
    );

    expect(change.attributes).toBeTruthy();
    expect(change.attributes.Herstellernummer).toBe('F23200283');
    expect(policyIssues).toContain('attributes:corrected_via_identifiers:Herstellernummer');
    expect(policyIssues.join(' ')).not.toContain('conflict_with_existing');
  });

  it('behält andere abweichende Werte als sichtbaren Vorschlag statt still zu verwerfen', () => {
    const { change, policyIssues } = sanitizeDatasheetChange(
      { attributes: { Farbe: 'Terracotta Brown' } },
      makeProduct()
    );

    expect(change.attributes).toBeTruthy();
    expect(change.attributes.Farbe).toBe('Terracotta Brown');
    expect(policyIssues).toContain('attributes:override_existing:Farbe');
    expect(policyIssues.join(' ')).not.toContain('conflict_with_existing');
  });

  it('identische Werte passieren weiterhin ohne Issue', () => {
    const { change, policyIssues } = sanitizeDatasheetChange(
      { attributes: { Marke: 'FJALLRAVEN' } },
      makeProduct()
    );

    expect(change.attributes.Marke).toBe('FJALLRAVEN');
    expect(policyIssues.filter((i) => String(i).startsWith('attributes:'))).toHaveLength(0);
  });

  it('Kill-Switch CHAT_ATTR_CONFLICT_MODE=block stellt das alte Verwerfen wieder her', () => {
    process.env.CHAT_ATTR_CONFLICT_MODE = 'block';
    try {
      const { change, policyIssues } = sanitizeDatasheetChange(
        { attributes: { Farbe: 'Terracotta Brown' } },
        makeProduct()
      );

      expect(change.attributes).toBeUndefined();
      expect(policyIssues).toContain('attributes:conflict_with_existing:Farbe');
    } finally {
      delete process.env.CHAT_ATTR_CONFLICT_MODE;
    }
  });

  it('auch im block-Modus gewinnt die Identifier-bestätigte Korrektur', () => {
    process.env.CHAT_ATTR_CONFLICT_MODE = 'block';
    try {
      const { change, policyIssues } = sanitizeDatasheetChange(
        { attributes: { Herstellernummer: 'F23200283' } },
        makeProduct()
      );

      expect(change.attributes.Herstellernummer).toBe('F23200283');
      expect(policyIssues).toContain('attributes:corrected_via_identifiers:Herstellernummer');
    } finally {
      delete process.env.CHAT_ATTR_CONFLICT_MODE;
    }
  });
});

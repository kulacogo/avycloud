'use strict';

/**
 * Platzhalter-"Marken" dürfen keinen GPSR-Registry-Eintrag ziehen.
 *
 * Befund 2026-08-10 (Produktionsdaten): `gpsrManufacturers/markenlos` trug
 *
 *   manufacturer_name: "Markenlos"
 *   manufacturer_address: "78 avenue des Champs Elysees Bureau 326", Paris
 *   manufacturer_state_province: "Zhejiang"      <- CN-Provinz in Pariser Adresse
 *   email: "mjcm190928@gmail.com"                <- Freemail als Herstellerkontakt
 *   eu_responsible_name: "Geaplan GmbH"          <- unbeteiligte fremde Firma
 *   confidence: 0, sources: []
 *
 * "Markenlos" ist keine Marke, sondern das Fehlen einer Marke. Der Eintrag
 * wurde über `getManufacturerGpsrByName(brand)` bei JEDEM Lesen und JEDEM
 * Speichern auf jedes Produkt mit dieser "Marke" angewendet — gemessen auf
 * 32 Live-Angeboten mit zeichengleichem Block.
 *
 * Zwei unabhängige Sperren, beide fail-safe:
 *   1. Platzhalter-Namen keyen nie einen Registry-Lookup.
 *   2. Ein Eintrag ohne jeden Beleg (confidence 0 UND keine Quellen) wird
 *      nicht durchgesetzt.
 */

const {
  isPlaceholderBrand,
  isEnforceableRegistryEntry,
} = require('../lib/gpsr-registry-guard');

describe('isPlaceholderBrand', () => {
  it('erkennt die deutschen und englischen Platzhalter', () => {
    for (const name of [
      'Markenlos', 'markenlos', 'MARKENLOS', ' Markenlos ',
      'Unbekannt', 'unbekannt',
      'No Name', 'NoName', 'no-name', 'Noname',
      'Unbranded', 'unbranded',
      'Generic', 'generic',
      'Marke unbekannt',
      'ohne Marke',
      'n/a', 'N/A', 'k.A.', 'kA',
      '-', '–', '—',
    ]) {
      expect(isPlaceholderBrand(name)).toBe(true);
    }
  });

  it('lässt echte Marken unangetastet', () => {
    for (const name of [
      'Bosch', 'EUHOMY', 'Funko', 'ATE', 'Nike Inc.', 'PME Legend',
      'Apple', 'Dyson', 'STOOLINK', 'BelleMax',
      // Grenzfälle, die NICHT geblockt werden dürfen:
      'Generic Electric AB', 'Namensberg GmbH', 'Nova',
    ]) {
      expect(isPlaceholderBrand(name)).toBe(false);
    }
  });

  it('behandelt leere Eingaben als Platzhalter', () => {
    expect(isPlaceholderBrand('')).toBe(true);
    expect(isPlaceholderBrand(null)).toBe(true);
    expect(isPlaceholderBrand(undefined)).toBe(true);
  });
});

describe('isEnforceableRegistryEntry', () => {
  it('lehnt den realen markenlos-Eintrag ab (confidence 0, keine Quellen)', () => {
    const reg = {
      manufacturer_name: 'Markenlos',
      confidence: 0,
      sources: [],
      gpsr: { manufacturer_name: 'Markenlos', email: 'mjcm190928@gmail.com' },
    };
    expect(isEnforceableRegistryEntry(reg)).toBe(false);
  });

  it('akzeptiert einen Eintrag mit Quellen, auch ohne Confidence-Wert', () => {
    const reg = {
      confidence: 0,
      sources: ['https://www.bosch-professional.com/de/de/impressum/'],
      gpsr: { manufacturer_name: 'Robert Bosch Power Tools GmbH' },
    };
    expect(isEnforceableRegistryEntry(reg)).toBe(true);
  });

  it('akzeptiert einen Eintrag mit Confidence, auch ohne Quellenliste', () => {
    expect(isEnforceableRegistryEntry({ confidence: 0.9, sources: [], gpsr: { manufacturer_name: 'X' } })).toBe(true);
  });

  it('akzeptiert einen Eintrag mit Beleg-Metadaten', () => {
    const reg = { confidence: 0, sources: [], evidence: { status: 'verified' }, gpsr: { manufacturer_name: 'X' } };
    expect(isEnforceableRegistryEntry(reg)).toBe(true);
  });

  it('lehnt leere/kaputte Einträge ab', () => {
    expect(isEnforceableRegistryEntry(null)).toBe(false);
    expect(isEnforceableRegistryEntry({})).toBe(false);
    expect(isEnforceableRegistryEntry({ gpsr: {} })).toBe(false);
  });
});

describe('Zusammenspiel: der reale Schadensfall', () => {
  it('blockt den markenlos-Eintrag doppelt — über den Namen UND über den fehlenden Beleg', () => {
    expect(isPlaceholderBrand('Markenlos')).toBe(true);
    expect(isEnforceableRegistryEntry({ confidence: 0, sources: [], gpsr: { manufacturer_name: 'Markenlos' } }))
      .toBe(false);
  });
});

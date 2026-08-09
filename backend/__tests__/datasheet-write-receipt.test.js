'use strict';

/**
 * Schreib-Quittung: Vergleich "was gesendet wurde" gegen "was wirklich im
 * Dokument steht".
 *
 * Hintergrund (Vorfall 2026-08-10): An KEINER Stelle der Kette wurde geprüft,
 * ob das Gewollte auch passiert ist. Der Chat meldete Erfolg, die Karte
 * verschwand, das Datenblatt zeigte die neuen Werte — geschrieben wurde
 * nichts. Diese Quittung ist bewusst GENERISCH: sie kennt die konkreten
 * Fehler nicht, sondern meldet jedes Feld, das mit Inhalt gesendet wurde und
 * anschließend leer ist. Damit fängt sie auch Lücken, die wir noch nicht
 * kennen.
 *
 * Bewusst NICHT gemeldet werden Wert-Umformungen (Marken-Schreibweise,
 * Attribut-Kanonisierung, Barcode-Validierung). Sie sind legitim und im
 * Datenblatt sichtbar; sie zu melden würde die echten Verluste im Rauschen
 * ertränken.
 */

const { buildWriteReceipt, WATCHED_PATHS } = require('../lib/datasheet-write-receipt');

function product(overrides = {}) {
  return {
    id: 'p1',
    identification: { name: 'Titel', brand: 'ACME', sku: 'SKU-1' },
    details: {
      identifiers: {},
      gpsr: {},
      ...overrides.details,
    },
    ...overrides,
  };
}

describe('buildWriteReceipt — meldet echten Verlust', () => {
  it('meldet den EU-Verantwortlichen, wenn er gesendet wurde und nicht ankam', () => {
    const intended = product({
      details: {
        identifiers: {},
        gpsr: { manufacturer_name: 'Ningbo Shuaifan', eu_responsible_name: 'SUCCESS COURIER S.L.' },
      },
    });
    const persisted = product({
      details: { identifiers: {}, gpsr: { manufacturer_name: 'Ningbo Shuaifan' } },
    });

    const receipt = buildWriteReceipt(intended, persisted);
    expect(receipt.ok).toBe(false);
    expect(receipt.missing).toHaveLength(1);
    expect(receipt.missing[0].path).toBe('details.gpsr.eu_responsible_name');
    expect(receipt.missing[0].label).toBe('EU-Verantwortlicher / Firma');
    expect(receipt.missing[0].wanted).toBe('SUCCESS COURIER S.L.');
  });

  it('meldet die Herstellernummer, wenn sie nicht ankam', () => {
    const intended = product({ details: { identifiers: { mpn: 'OL-A016FF20N2' }, gpsr: {} } });
    const persisted = product({ details: { identifiers: {}, gpsr: {} } });

    const receipt = buildWriteReceipt(intended, persisted);
    expect(receipt.missing.map((m) => m.path)).toEqual(['details.identifiers.mpn']);
    expect(receipt.missing[0].label).toBe('Herstellernummer (MPN)');
  });

  it('meldet mehrere verlorene Felder auf einmal', () => {
    const intended = product({
      details: {
        identifiers: { mpn: 'X1' },
        gpsr: { eu_responsible_name: 'Rep SL', eu_responsible_city: 'Madrid' },
      },
    });
    const persisted = product({ details: { identifiers: {}, gpsr: {} } });

    const receipt = buildWriteReceipt(intended, persisted);
    expect(receipt.missing).toHaveLength(3);
    expect(receipt.ok).toBe(false);
  });
});

describe('buildWriteReceipt — meldet KEIN falsches Positiv', () => {
  it('ist still, wenn alles angekommen ist', () => {
    const same = product({
      details: { identifiers: { mpn: 'X1' }, gpsr: { eu_responsible_name: 'Rep SL' } },
    });
    const receipt = buildWriteReceipt(same, JSON.parse(JSON.stringify(same)));
    expect(receipt.ok).toBe(true);
    expect(receipt.missing).toEqual([]);
  });

  it('meldet legitime Wert-Umformungen nicht (Marken-Schreibweise)', () => {
    const intended = product({ identification: { name: 'T', brand: 'acme gmbh', sku: 'S' } });
    const persisted = product({ identification: { name: 'T', brand: 'ACME GmbH', sku: 'S' } });
    const receipt = buildWriteReceipt(intended, persisted);
    expect(receipt.missing).toEqual([]);
  });

  it('meldet nichts, wenn das Feld schon vorher leer gesendet wurde', () => {
    const intended = product({ details: { identifiers: { mpn: '' }, gpsr: {} } });
    const persisted = product({ details: { identifiers: {}, gpsr: {} } });
    expect(buildWriteReceipt(intended, persisted).missing).toEqual([]);
  });

  it('meldet nichts, wenn der Server-Stand nicht gelesen werden konnte', () => {
    // Fail-open: eine fehlende Vergleichsbasis darf NIE als Datenverlust
    // erscheinen, sonst warnt die Quittung bei jeder Netzstörung falsch.
    const intended = product({ details: { identifiers: { mpn: 'X1' }, gpsr: {} } });
    const receipt = buildWriteReceipt(intended, null);
    expect(receipt.ok).toBe(true);
    expect(receipt.missing).toEqual([]);
    expect(receipt.skipped).toBe(true);
  });

  it('behandelt Barcode-Listen als Liste, nicht als String', () => {
    const intended = product({ identification: { name: 'T', brand: 'B', sku: 'S', barcodes: ['4006381333931'] } });
    const persistedOk = product({ identification: { name: 'T', brand: 'B', sku: 'S', barcodes: ['4006381333931'] } });
    const persistedLost = product({ identification: { name: 'T', brand: 'B', sku: 'S', barcodes: [] } });
    expect(buildWriteReceipt(intended, persistedOk).missing).toEqual([]);
    expect(buildWriteReceipt(intended, persistedLost).missing.map((m) => m.path))
      .toEqual(['identification.barcodes']);
  });
});

describe('WATCHED_PATHS', () => {
  it('überwacht beide GPSR-Rollen vollständig', () => {
    const contract = require('../lib/chat-datasheet-contract');
    for (const f of contract.GPSR_FIELDS) {
      expect(WATCHED_PATHS).toContain(`details.gpsr.${f}`);
    }
  });

  it('überwacht die Identifikatoren inklusive MPN', () => {
    expect(WATCHED_PATHS).toContain('details.identifiers.mpn');
    expect(WATCHED_PATHS).toContain('identification.barcodes');
  });
});

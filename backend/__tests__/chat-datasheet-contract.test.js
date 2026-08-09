'use strict';

/**
 * Kontrakt der Chat-Änderungskarte — EINE Quelle für alle Pipelines.
 *
 * Hintergrund (Vorfall 2026-08-10, SKU-3154363905 / eBay 800481892205):
 * Die Feldliste der Änderungskarte existierte als ~17 handgepflegte Kopien.
 * Die 9 `eu_responsible_*`-Felder wurden am 2026-06-01 NUR in V3 ergänzt; V2
 * und Legacy bekamen sie nie. Als die Gemini-2.5-Politik V3 unerreichbar
 * machte, konnte der Chat den EU-Verantwortlichen schlagartig nicht mehr
 * schreiben — ohne dass irgendetwas es meldete.
 *
 * Der eigentliche Formfehler: alle Sanitizer iterierten über die WHITELIST
 * statt über die EINGABE. Eine Projektion kann bauartbedingt nicht wissen,
 * was sie fallen lässt — der Verlust war im Code nicht repräsentiert.
 * `pickWithRest()` macht daraus eine Partition: was wegfällt, ist ein Wert.
 */

const contract = require('../lib/chat-datasheet-contract');

describe('chat-datasheet-contract — Feldlisten', () => {
  it('führt alle 10 Hersteller- UND alle 9 EU-Verantwortlichen-Felder', () => {
    expect(contract.GPSR_MANUFACTURER_FIELDS).toEqual([
      'entity_country',
      'country_code',
      'manufacturer_name',
      'manufacturer_address',
      'manufacturer_city',
      'manufacturer_postalcode',
      'manufacturer_state_province',
      'email',
      'manufacturer_phone',
      'url',
    ]);
    expect(contract.GPSR_EU_REP_FIELDS).toEqual([
      'eu_responsible_name',
      'eu_responsible_address',
      'eu_responsible_city',
      'eu_responsible_postalcode',
      'eu_responsible_state_province',
      'eu_responsible_country',
      'eu_responsible_country_code',
      'eu_responsible_email',
      'eu_responsible_phone',
    ]);
    expect(contract.GPSR_FIELDS).toHaveLength(19);
  });

  it('führt mpn in den Identity-Feldern (fehlte in V2 und Legacy)', () => {
    expect(contract.IDENTITY_FIELDS).toContain('mpn');
    expect(contract.IDENTITY_FIELDS).toContain('barcodes');
    expect(contract.IDENTITY_CLEARABLE).toEqual(['barcodes', 'ean', 'gtin', 'upc']);
  });

  it('kennt für jedes GPSR-Feld ein deutsches Label und trennt die beiden Rollen', () => {
    for (const f of contract.GPSR_FIELDS) {
      const label = contract.fieldLabel(`details.gpsr.${f}`);
      expect(typeof label).toBe('string');
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toBe(`details.gpsr.${f}`);
    }
    // Die beiden Rollen dürfen NIE unter einem Sammel-Label "GPSR" verschmelzen —
    // genau daran scheiterte die menschliche Kontrolle (MessageBubble.tsx:97).
    expect(contract.fieldLabel('details.gpsr.manufacturer_name')).toMatch(/Hersteller/i);
    expect(contract.fieldLabel('details.gpsr.eu_responsible_name')).toMatch(/EU-Verantwortlich/i);
  });
});

describe('pickWithRest — Partition statt Projektion', () => {
  it('behält bekannte Felder und meldet unbekannte MIT Inhalt als Rest', () => {
    const { kept, droppedKeys } = contract.pickWithRest(
      { manufacturer_name: 'ACME', eu_responsible_name: 'Rep SL', foo: 'x', baz: 'y' },
      contract.GPSR_FIELDS
    );
    expect(kept).toEqual({ manufacturer_name: 'ACME', eu_responsible_name: 'Rep SL' });
    expect(droppedKeys.sort()).toEqual(['baz', 'foo']);
  });

  it('meldet einen unbekannten Schlüssel OHNE Inhalt nicht als Verlust', () => {
    // Sonst erzeugt jede Karte Rauschen und die echten Meldungen gehen unter.
    const { droppedKeys } = contract.pickWithRest(
      { manufacturer_name: 'ACME', leeresFeld: '' },
      contract.GPSR_FIELDS
    );
    expect(droppedKeys).toEqual([]);
  });

  it('meldet einen leeren Rest, wenn alles bekannt ist', () => {
    const { kept, droppedKeys } = contract.pickWithRest(
      { manufacturer_name: 'ACME' },
      contract.GPSR_FIELDS
    );
    expect(kept).toEqual({ manufacturer_name: 'ACME' });
    expect(droppedKeys).toEqual([]);
  });

  it('verwirft leere Werte, ohne sie als Verlust zu melden', () => {
    const { kept, droppedKeys } = contract.pickWithRest(
      { manufacturer_name: '   ', eu_responsible_name: 'Rep SL' },
      contract.GPSR_FIELDS
    );
    expect(kept).toEqual({ eu_responsible_name: 'Rep SL' });
    // Ein bekanntes Feld mit leerem Wert ist kein Datenverlust — nichts zu melden.
    expect(droppedKeys).toEqual([]);
  });

  it('ist robust gegen Nicht-Objekte', () => {
    expect(contract.pickWithRest(null, contract.GPSR_FIELDS)).toEqual({ kept: {}, droppedKeys: [] });
    expect(contract.pickWithRest('nope', contract.GPSR_FIELDS)).toEqual({ kept: {}, droppedKeys: [] });
  });
});

describe('buildGpsrToolProperties — eine Liste, drei Dialekte', () => {
  it('erzeugt Großschreibung für V2/V3 und Kleinschreibung für Legacy', () => {
    const v2 = contract.buildGpsrToolProperties('UPPER');
    const legacy = contract.buildGpsrToolProperties('lower');
    expect(Object.keys(v2)).toHaveLength(19);
    expect(Object.keys(legacy)).toHaveLength(19);
    expect(v2.eu_responsible_name).toEqual({ type: 'STRING' });
    expect(legacy.eu_responsible_name).toEqual({ type: 'string' });
  });

  it('enthält in beiden Dialekten den EU-Verantwortlichen', () => {
    for (const dialect of ['UPPER', 'lower']) {
      const props = contract.buildGpsrToolProperties(dialect);
      for (const f of contract.GPSR_EU_REP_FIELDS) {
        expect(props[f]).toBeTruthy();
      }
    }
  });
});

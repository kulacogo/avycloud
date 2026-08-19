'use strict';

/**
 * Die Rueckfall-Liste darf keine Zustaende anbieten, die das Konto nicht setzen kann.
 *
 * Gemessen 20.08.2026 ueber einen Vollabruf der eBay-Metadata-API (alle 14.917
 * Kategorien, 5.070.692 Bytes): die Refurbished-Zustaende kommen fuer dieses
 * Konto KEIN EINZIGES Mal vor.
 *
 *   1000=13.025 · 1500=9.707 · 1750=1.071 · 1900=16 · 2500=5.934 · 2750=103
 *   2990=339 · 3000=12.493 · 3010=339 · 4000=103 · 5000=100 · 6000=100 · 7000=8.292
 *   2000=0 · 2010=0 · 2020=0 · 2030=0
 *
 * eBays Doku: "sellers must go through an application and qualification process
 * to become eligible to list with this item condition" und "Restricted item
 * conditions will not be returned ... if any seller is not eligible".
 *
 * GENERIC_CONDITION_NAMES ist der Rueckfall fuer Kategorien, die nicht im
 * Katalog stehen. Bot es "Zertifiziert generalueberholt" (2000) an, konnte der
 * Bediener einen Zustand waehlen, den eBay garantiert zurueckweist — ein
 * vermeidbarer Fehlversuch beim Einstellen.
 *
 * Die NAMEN bleiben vollstaendig: resolveConditionName() beschriftet damit auch
 * Altbestaende, in denen ein solcher Wert noch steht.
 */

const {
  GENERIC_CONDITION_NAMES,
  getGenericConditionOptions,
  resolveConditionName,
} = require('../lib/ebay-conditions');

const NICHT_FREIGESCHALTET = ['2000', '2010', '2020', '2030'];

describe('Rueckfall-Auswahl', () => {
  it('bietet keinen Refurbished-Zustand an', () => {
    const ids = getGenericConditionOptions().map((o) => String(o.id));
    for (const id of NICHT_FREIGESCHALTET) {
      expect(ids).not.toContain(id);
    }
  });

  it('bietet die nutzbaren Zustaende weiterhin an', () => {
    const ids = getGenericConditionOptions().map((o) => String(o.id));
    for (const id of ['1000', '1500', '2500', '3000', '7000']) {
      expect(ids).toContain(id);
    }
  });

  it('jede Option hat einen Namen', () => {
    for (const o of getGenericConditionOptions()) {
      expect(typeof o.name).toBe('string');
      expect(o.name.length).toBeGreaterThan(0);
    }
  });
});

describe('Beschriftung bleibt vollstaendig', () => {
  it('benennt auch gesperrte Zustaende — fuer Altbestaende', () => {
    // Steht in einem alten Datenblatt noch 2000, muss die Anzeige einen Namen
    // zeigen und nicht die nackte Zahl.
    // Signatur: (categoryId, conditionId) — eine unbekannte Kategorie faellt
    // auf die vollstaendige Namensliste zurueck.
    expect(resolveConditionName('', '2000')).toBe('Zertifiziert generalüberholt');
    expect(GENERIC_CONDITION_NAMES[2000]).toBeTruthy();
  });
});

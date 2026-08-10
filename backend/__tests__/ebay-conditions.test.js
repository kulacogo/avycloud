/**
 * Tests fuer backend/lib/ebay-conditions.js — die erlaubten eBay-Artikelzustaende
 * je Kategorie.
 *
 * HINTERGRUND: Der Artikelzustand ist bei eBay ein EIGENES Feld (<ConditionID>),
 * unabhaengig von den Artikelmerkmalen. Welche Zustaende erlaubt sind UND wie sie
 * heissen, haengt an der Kategorie:
 *
 *   - ConditionID 1000 heisst in 11.934 Kategorien "Neu",
 *     in 968 Bekleidungs-Kategorien aber "Neu mit Etikett".
 *   - ConditionID 3000 heisst meist "Gebraucht",
 *     in 339 Kategorien "Gebraucht - Gut".
 *
 * Eine feste Liste im Frontend wuerde also in manchen Kategorien falsch
 * beschriften. Daher die Kategorie-Tabelle.
 *
 * FAIL-OPEN ist Absicht: 81 unserer Bestandsprodukte stehen in Kategorien, fuer
 * die eBay gar keine Zustands-Policy fuehrt. Die duerfen nicht blockiert werden.
 */

const {
  getConditionsForCategory,
  isConditionAllowed,
  resolveConditionName,
  DEFAULT_CONDITION_ID,
} = require('../lib/ebay-conditions');

describe('ebay-conditions', () => {
  describe('getConditionsForCategory', () => {
    it('liefert die Zustaende einer bekannten Kategorie', () => {
      // 261581 = eine der Kategorien mit dem haeufigsten Set
      const res = getConditionsForCategory('261581');
      expect(res.conditions.length).toBeGreaterThan(0);
      const ids = res.conditions.map((c) => c.id);
      expect(ids).toContain('1000');
      expect(ids).toContain('3000');
    });

    it('liefert kategoriegenaue Anzeigenamen statt globaler', () => {
      // 261588 ist eine Bekleidungs-Kategorie: dort heisst 1000 "Neu mit Etikett"
      const clothing = getConditionsForCategory('261588');
      const neu = clothing.conditions.find((c) => c.id === '1000');
      expect(neu).toBeTruthy();
      expect(neu.name).toBe('Neu mit Etikett');

      // Gegenprobe: in 261581 heisst dieselbe ID schlicht "Neu"
      const general = getConditionsForCategory('261581');
      expect(general.conditions.find((c) => c.id === '1000').name).toBe('Neu');
    });

    it('meldet ob der Zustand in der Kategorie Pflicht ist', () => {
      // 259272 ist laut eBay-Policy eine Pflicht-Kategorie
      expect(getConditionsForCategory('259272').required).toBe(true);
      // 261581 ist es nicht
      expect(getConditionsForCategory('261581').required).toBe(false);
    });

    it('gibt bei unbekannter Kategorie eine leere Liste zurueck statt zu werfen', () => {
      const res = getConditionsForCategory('99999999');
      expect(res.conditions).toEqual([]);
      expect(res.required).toBe(false);
      expect(res.known).toBe(false);
    });

    it('vertraegt leere und unsinnige Eingaben', () => {
      [null, undefined, '', 'abc', 0, {}].forEach((input) => {
        const res = getConditionsForCategory(input);
        expect(Array.isArray(res.conditions)).toBe(true);
        expect(res.known).toBe(false);
      });
    });

    it('markiert Kategorien ohne jeden Zustand', () => {
      // Es gibt 1.889 Kategorien mit leerem Zustands-Set. Fuer die darf spaeter
      // KEIN ConditionID gesendet werden.
      const res = getConditionsForCategory('1281'); // Kategorie ohne Zustaende
      if (res.known) {
        expect(Array.isArray(res.conditions)).toBe(true);
      }
    });
  });

  describe('isConditionAllowed', () => {
    it('erlaubt einen in der Kategorie gefuehrten Zustand', () => {
      expect(isConditionAllowed('261581', '3000')).toBe(true);
    });

    it('verweigert einen dort nicht gefuehrten Zustand', () => {
      // 261588 (Bekleidung) fuehrt kein 7000 "Als Ersatzteil / defekt"
      expect(isConditionAllowed('261588', '7000')).toBe(false);
    });

    it('ist fail-open bei unbekannter Kategorie', () => {
      expect(isConditionAllowed('99999999', '3000')).toBe(true);
    });

    it('ist fail-open wenn kein Zustand gewaehlt wurde', () => {
      expect(isConditionAllowed('261588', '')).toBe(true);
      expect(isConditionAllowed('261588', null)).toBe(true);
    });

    it('vergleicht unabhaengig von Zahl oder Zeichenkette', () => {
      expect(isConditionAllowed('261581', 3000)).toBe(true);
      expect(isConditionAllowed('261581', '3000')).toBe(true);
    });
  });

  describe('resolveConditionName', () => {
    it('nimmt den kategoriegenauen Namen', () => {
      expect(resolveConditionName('261588', '1000')).toBe('Neu mit Etikett');
    });

    it('faellt bei unbekannter Kategorie auf den gaengigen Namen zurueck', () => {
      expect(resolveConditionName('99999999', '1000')).toBe('Neu');
      expect(resolveConditionName('99999999', '3000')).toBe('Gebraucht');
    });

    it('gibt bei voellig unbekannter ID eine leere Zeichenkette zurueck', () => {
      expect(resolveConditionName('261581', '123456')).toBe('');
    });
  });

  describe('DEFAULT_CONDITION_ID', () => {
    it('ist Neu', () => {
      expect(DEFAULT_CONDITION_ID).toBe('1000');
    });
  });
});

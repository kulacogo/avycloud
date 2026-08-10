/**
 * eBay-Fehler 21555 "Ungueltige Kategorie" bei Zustands-Konflikt.
 *
 * VORFALL 2026-08-10 (SKU-6227938675, Mobile Klimaanlage):
 *   Der Bediener waehlte im Datenblatt "Vom Verkaeufer generalueberholt"
 *   (2500). Das Listing schlug fehl mit "Sie haben in dieser Anfrage keine
 *   gueltige Kategorie angeben." — obwohl die Kategorie 185112 voellig in
 *   Ordnung ist.
 *
 * GEMESSEN (VerifyAddFixedPriceItem gegen die echte eBay-API):
 *   Kategorie 185112 + Zustand 1000/1500/3000/7000 -> Ack Warning (geht)
 *   Kategorie 185112 + Zustand 2500                -> Fehler 21555
 *   Kategorie 183994 + Zustand 2500                -> Ack Warning (geht!)
 *   Kategorie  78707 + Zustand 2500                -> Ack Warning (geht!)
 *
 * Die Metadaten-Rohdaten der drei Kategorien sind Zeichen fuer Zeichen
 * identisch. eBay gibt also KEIN Merkmal heraus, an dem man das vorher
 * erkennen koennte — die Angebots-API ist die einzige verlaessliche Quelle.
 * Deshalb: bewiesene Ablehnungen merken statt raten.
 */

require('./api/_patchGcp');
require('./api/_patchLocalModules');

const {
  isMisleadingCategoryError,
  MISLEADING_CATEGORY_ERROR_CODE,
} = require('../lib/ebay-condition-rejections');

describe('Fehler 21555 erkennen', () => {
  it('erkennt den Code in der eBay-Fehlerliste', () => {
    const errors = [{ code: '21555', shortMessage: 'Ungültige Kategorie.' }];
    expect(isMisleadingCategoryError(errors)).toBe(true);
  });

  it('erkennt ihn auch unter dem Feldnamen errorCode', () => {
    expect(isMisleadingCategoryError([{ errorCode: '21555' }])).toBe(true);
  });

  it('springt bei anderen Fehlern nicht an', () => {
    expect(isMisleadingCategoryError([{ code: '240' }])).toBe(false);
    expect(isMisleadingCategoryError([])).toBe(false);
    expect(isMisleadingCategoryError(null)).toBe(false);
  });

  it('haelt den Code als benannte Konstante fest', () => {
    expect(MISLEADING_CATEGORY_ERROR_CODE).toBe('21555');
  });
});

describe('Zustand 2500 ist NICHT pauschal verboten', () => {
  // Schutz gegen die naheliegende Fehlreparatur: "2500 einfach global sperren".
  // Das waere falsch — in 183994 und 78707 wird es nachweislich akzeptiert.
  const { getConditionsForCategory } = require('../lib/ebay-conditions');

  it('wird von der Kategorie-Tabelle weiterhin angeboten, wo eBay es fuehrt', () => {
    ['183994', '78707'].forEach((cat) => {
      const ids = getConditionsForCategory(cat).conditions.map((c) => c.id);
      expect(ids).toContain('2500');
    });
  });
});

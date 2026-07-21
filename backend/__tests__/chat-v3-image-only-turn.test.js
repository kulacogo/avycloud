/**
 * Regression: Chat-V3 erzeugte bei einer REINEN Bildsuche (0 Treffer) eine
 * sinnlose "Übernehmen"-Änderungskarte. Ursache: die Force-Finalization
 * (softForce/atLastIter) und der Ultimate-Fallback zwangen JEDEN Turn in einen
 * update_product_datasheet-Write — auch wenn der User nur Bilder suchen wollte.
 * Das Modell fabrizierte dann eine No-Op-Karte ("… 0 Bilder gefunden").
 *
 * computeImageOnlyTurn(trace) ist die reine Entscheidungsfunktion, die alle drei
 * Force-Pfade gatet: ein reiner Bild-Turn (nur suggest_product_images, kein
 * Write, kein anderes Tool) darf NIE in einen Datenblatt-Write gezwungen werden.
 *
 * CJS-Test — globals via vitest.config.js.
 */

require('./api/_patchGcp');

const { _testables } = require('../services/product-chat-v3');
const { computeImageOnlyTurn } = _testables;

describe('computeImageOnlyTurn', () => {
  it('true: nur Bildsuche gelaufen (kein Write, kein anderes Tool) → reiner Bild-Turn', () => {
    expect(
      computeImageOnlyTurn({ sawImageSearch: true, sawNonImageTool: false, sawWriteCall: false })
    ).toBe(true);
  });

  it('false: Bildsuche + datenblatt-relevantes Tool (z. B. verify_brand) → normaler Turn, Force erlaubt', () => {
    expect(
      computeImageOnlyTurn({ sawImageSearch: true, sawNonImageTool: true, sawWriteCall: false })
    ).toBe(false);
  });

  it('false: Bildsuche + Datenblatt-Write → echte Änderung, kein reiner Bild-Turn', () => {
    expect(
      computeImageOnlyTurn({ sawImageSearch: true, sawNonImageTool: false, sawWriteCall: true })
    ).toBe(false);
  });

  it('false: gar keine Bildsuche (normale Optimierung) → Force-Machinerie bleibt aktiv', () => {
    expect(
      computeImageOnlyTurn({ sawImageSearch: false, sawNonImageTool: false, sawWriteCall: false })
    ).toBe(false);
  });

  it('robust gegen fehlenden/ungültigen trace', () => {
    expect(computeImageOnlyTurn(null)).toBe(false);
    expect(computeImageOnlyTurn(undefined)).toBe(false);
    expect(computeImageOnlyTurn({})).toBe(false);
  });
});

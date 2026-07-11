'use strict';

/**
 * isItemNotIndexedUnitError (lib/kaufland-api.js) — entscheidet, ob ein
 * POST-/units-Fehler als KAUFLAND_PRODUCT_DATA_PENDING (Katalog-Produkt noch
 * nicht indexiert, Self-Heal wartet) gilt oder als ECHTER Fehler durchgereicht
 * wird (Fehler-Cockpit).
 *
 * Hintergrund (Incident 2026-07-11): nach dem Kaufland-Konto-Wechsel zeigten
 * die Publish-Defaults noch auf Versandgruppe/Lager des Alt-Kontos. Kaufland
 * antwortete "Parameter [warehouse] is missing or has wrong value" — createUnit
 * maskierte das als PENDING und der Self-Heal-Loop wartete endlos (attempts=9)
 * statt den Konfigurationsfehler sichtbar zu machen.
 */

const { isItemNotIndexedUnitError } = require('../../lib/kaufland-api');

describe('isItemNotIndexedUnitError', () => {
  it('erkennt Kauflands Item-nicht-indexiert-Signatur → PENDING zulässig', () => {
    expect(isItemNotIndexedUnitError('parameter [item] is missing or has wrong value')).toBe(true);
    expect(isItemNotIndexedUnitError('Parameter [item] is missing or has wrong value'.toLowerCase())).toBe(true);
    expect(isItemNotIndexedUnitError('item with ean 123 not found')).toBe(true);
  });

  it('Konfigurationsfehler sind KEIN PENDING (Live-Fall: Alt-Konto-Warehouse)', () => {
    expect(isItemNotIndexedUnitError('parameter [warehouse] is missing or has wrong value')).toBe(false);
    expect(isItemNotIndexedUnitError('parameter [id_shipping_group] is missing or has wrong value')).toBe(false);
    expect(isItemNotIndexedUnitError('parameter [listing_price] is missing or has wrong value')).toBe(false);
    expect(isItemNotIndexedUnitError('unauthorized')).toBe(false);
  });

  it('leere/fehlende Messages sind kein PENDING', () => {
    expect(isItemNotIndexedUnitError('')).toBe(false);
    expect(isItemNotIndexedUnitError(null)).toBe(false);
    expect(isItemNotIndexedUnitError(undefined)).toBe(false);
  });
});

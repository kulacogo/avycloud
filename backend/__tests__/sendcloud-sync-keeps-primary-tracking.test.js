// globals: true in vitest.config.js
'use strict';

/**
 * Regression 2026-09-26 (15 Auftraege in 45 Tagen, zuletzt ebay__20-15189-76007):
 * ein bei SendCloud verwaistes Paket OHNE Sendungsnummer (gescheiterte
 * Transporteur-Anmeldung, Status "problem") wurde vom Abgleich als neue
 * Primaer-Sendung auf den Auftrag geschrieben — trackingNumber: null.
 * Die echte Sendungsnummer verschwand, die Zustellungs-Abfrage fand nichts
 * mehr, und ein gescheiterter eBay-Push war nicht mehr nachholbar.
 */

const { buildSyncOrderTrackingUpdate } = require('../services/shipping-engine');

describe('SendCloud-Abgleich: Primaer-Sendung nie mit einem Paket ohne Sendungsnummer ueberschreiben', () => {
  it('Paket ohne Sendungsnummer → kein Update am Auftrag', () => {
    expect(buildSyncOrderTrackingUpdate({ trackingNumber: null, trackingUrl: null, carrier: 'dpd', shipmentId: 'problem-doc' })).toBeNull();
    expect(buildSyncOrderTrackingUpdate({ trackingNumber: '', carrier: 'dhl_de', shipmentId: 'x' })).toBeNull();
  });

  it('Paket mit Sendungsnummer → bisheriges Verhalten (Primaer-Felder werden gesetzt)', () => {
    expect(buildSyncOrderTrackingUpdate({
      trackingNumber: '00340434889170702545',
      trackingUrl: 'https://track/x',
      carrier: 'dhl_de',
      shipmentId: 'S1',
      nowIso: '2026-09-26T00:00:00.000Z',
    })).toEqual({
      trackingNumber: '00340434889170702545',
      trackingUrl: 'https://track/x',
      shippingService: 'dhl_de',
      shipmentId: 'S1',
      updatedAt: '2026-09-26T00:00:00.000Z',
    });
  });
});

describe('Altbestand-Reparatur: pickRestorableShipment', () => {
  const { pickRestorableShipment, buildRestoreUpdate } = require('../scripts/repair-order-tracking-from-shipments');
  const good = { id: 'FoH', data: { status: 'ausstehend', trackingNumber: '00340434889170702545', carrier: 'dhl_de', carrierName: 'dhl_de', createdAt: '2026-09-25T06:34:06.953Z' } };
  const problem = { id: 'YCE', data: { status: 'problem', trackingNumber: null, carrier: 'DHL', source: 'sendcloud_sync', createdAt: '2026-09-25T06:34:13.579Z' } };

  it('der echte Vorfall ebay__20-15189-76007: stellt die Etikett-Sendung wieder her', () => {
    const order = { trackingNumber: null, shipmentId: 'YCE' };
    const { shipment, reason } = pickRestorableShipment(order, [good, problem]);
    expect(reason).toBe('restorable');
    expect(shipment.id).toBe('FoH');
    const upd = buildRestoreUpdate(order, shipment, '2026-09-26T00:00:00.000Z');
    expect(upd).toMatchObject({ trackingNumber: '00340434889170702545', shippingService: 'dhl_de', shipmentId: 'FoH' });
    expect(upd['ops.trackingRestored']).toMatchObject({ fromShipmentId: 'YCE', toShipmentId: 'FoH' });
    expect(upd).not.toHaveProperty('omsStatus');
  });

  it('bevorzugt das Etikett-Doc vor einem Abgleich-Duplikat derselben Nummer', () => {
    const dup = { id: 'DUP', data: { ...good.data, source: 'sendcloud_sync', createdAt: '2026-09-25T06:35:00Z' } };
    expect(pickRestorableShipment({ shipmentId: 'YCE' }, [dup, good, problem]).shipment.id).toBe('FoH');
  });

  it('rührt nichts an bei stornierter Sendung, Zusatz-Label, mehrdeutigen Nummern oder vorhandener Nummer', () => {
    const cancelled = { id: 'C', data: { ...good.data, status: 'cancelled' } };
    const extra = { id: 'X', data: { ...good.data, additionalLabel: true } };
    const other = { id: 'O', data: { ...good.data, trackingNumber: 'ANDERE' } };
    expect(pickRestorableShipment({ shipmentId: 'YCE' }, [cancelled, problem]).shipment).toBeNull();
    expect(pickRestorableShipment({ shipmentId: 'YCE' }, [extra, problem]).shipment).toBeNull();
    expect(pickRestorableShipment({ shipmentId: 'YCE' }, [good, other, problem]).reason).toBe('ambiguous_multiple_tracking_numbers');
    expect(pickRestorableShipment({ trackingNumber: 'T' }, [good]).reason).toBe('order_has_tracking');
  });
});

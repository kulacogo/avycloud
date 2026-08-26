'use strict';

/**
 * Schreibschicht: Marktplatz-Erstattungen landen am Auftrag.
 *
 * Der Service nimmt seinen Firestore-Client als Parameter (`db`) — deshalb
 * genuegt hier ein einfacher Doppelgaenger, kein require.cache-Patching.
 */

const { recordMarketplaceRefund } = require('../../services/order-financials');

/** Minimaler Firestore-Doppelgaenger mit Transaktion. */
function fakeDb(docs) {
  const store = { ...docs };
  const refFor = (id) => ({ _id: id });
  return {
    _store: store,
    collection: () => ({ doc: (id) => refFor(id) }),
    runTransaction: async (fn) => fn({
      get: async (ref) => ({
        exists: store[ref._id] !== undefined,
        data: () => store[ref._id],
      }),
      set: (ref, data) => { store[ref._id] = { ...(store[ref._id] || {}), ...data }; },
    }),
  };
}

const ERSTATTUNG = { refundId: 'kaufland:M63HGK5:49.90', marketplace: 'kaufland', amount: 49.9, date: '2026-08-26' };

describe('recordMarketplaceRefund', () => {
  it('traegt die Erstattung ein und rechnet den Auftrag neu', async () => {
    const db = fakeDb({ o1: { tenantId: 'default', totalAmount: 499, omsStatus: 'shipped' } });
    const res = await recordMarketplaceRefund({ orderId: 'o1', tenantId: 'default', refund: ERSTATTUNG, db });
    expect(res.changed).toBe(true);
    expect(db._store.o1.refundedTotal).toBe(49.9);
    expect(db._store.o1.netAmount).toBe(449.1);
    expect(db._store.o1.marketplaceRefunds).toHaveLength(1);
  });

  it('ist idempotent — ein zweiter Lauf addiert NICHT nochmal', async () => {
    // Der Buchungsbericht wird alle 6 h neu gelesen. Ohne diesen Schutz
    // faellt der Umsatz mit jedem Lauf weiter.
    const db = fakeDb({ o1: { tenantId: 'default', totalAmount: 499, omsStatus: 'shipped' } });
    await recordMarketplaceRefund({ orderId: 'o1', tenantId: 'default', refund: ERSTATTUNG, db });
    const zweit = await recordMarketplaceRefund({ orderId: 'o1', tenantId: 'default', refund: ERSTATTUNG, db });
    expect(zweit.changed).toBe(false);
    expect(db._store.o1.refundedTotal).toBe(49.9);
    expect(db._store.o1.marketplaceRefunds).toHaveLength(1);
  });

  it('markiert eine BEREITS erstellte Rechnung als korrekturbeduerftig', async () => {
    // Der Normalfall: die Buchung kommt Tage bis Wochen nach dem Versand,
    // die Rechnung existiert also schon.
    const db = fakeDb({ o1: { tenantId: 'default', totalAmount: 499, omsStatus: 'shipped', invoiceNumber: 'RE-2026-0006', invoiceId: 'i1' } });
    const res = await recordMarketplaceRefund({ orderId: 'o1', tenantId: 'default', refund: ERSTATTUNG, db });
    expect(res.invoiceNeedsCorrection).toBe(true);
    expect(db._store.o1.invoiceNeedsCorrection).toBe(true);
    expect(db._store.o1.invoiceCorrectionReason).toMatch(/49\.90|49,90/);
  });

  it('ohne Rechnung wird auch keine Korrektur verlangt', async () => {
    const db = fakeDb({ o1: { tenantId: 'default', totalAmount: 499, omsStatus: 'shipped' } });
    const res = await recordMarketplaceRefund({ orderId: 'o1', tenantId: 'default', refund: ERSTATTUNG, db });
    expect(res.invoiceNeedsCorrection).toBe(false);
    expect(db._store.o1.invoiceNeedsCorrection).toBeUndefined();
  });

  it('ein stornierter Auftrag hat netto 0', async () => {
    // MTZXSS5: storniert, 109,95 €, 25,95 € erstattet.
    const db = fakeDb({ o1: { tenantId: 'default', totalAmount: 109.95, omsStatus: 'cancelled' } });
    await recordMarketplaceRefund({ orderId: 'o1', tenantId: 'default', refund: { refundId: 'x', amount: 25.95 }, db });
    expect(db._store.o1.netAmount).toBe(0);
  });

  it('fasst einen fremden Mandanten NICHT an', async () => {
    const db = fakeDb({ o1: { tenantId: 'fremd', totalAmount: 499 } });
    const res = await recordMarketplaceRefund({ orderId: 'o1', tenantId: 'default', refund: ERSTATTUNG, db });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('tenant_mismatch');
    expect(db._store.o1.refundedTotal).toBeUndefined();
  });

  it('meldet einen fehlenden Auftrag, statt ihn anzulegen', async () => {
    const db = fakeDb({});
    const res = await recordMarketplaceRefund({ orderId: 'gibtsnicht', tenantId: 'default', refund: ERSTATTUNG, db });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('order_not_found');
  });

  it('dryRun rechnet, schreibt aber nicht', async () => {
    const db = fakeDb({ o1: { tenantId: 'default', totalAmount: 499, omsStatus: 'shipped' } });
    const res = await recordMarketplaceRefund({ orderId: 'o1', tenantId: 'default', refund: ERSTATTUNG, db, dryRun: true });
    expect(res.changed).toBe(true);
    expect(res.financials.netAmount).toBe(449.1);
    expect(db._store.o1.refundedTotal).toBeUndefined();
  });
});

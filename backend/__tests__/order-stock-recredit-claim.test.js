/**
 * Unit test — Order-Stock-Recredit-Claim (WP4, symmetric re-credit).
 *
 * `lib/order-stock-recredit-claim.js` ist der inverse Spiegel von
 * `lib/order-stock-claim.js`: derselbe atomare Idempotency-Marker, aber
 * fuer die RUECK-Gutschrift (cancel / return / label-cancel) statt fuer den
 * Decrement.
 *
 * Diese Tests bilden die Idempotency-Gate-Semantik ab, auf der die gesamte
 * WP4-Oversell-Safety-Beweisfuehrung ruht:
 *   - claim NUR wenn dekrementiert && noch nicht re-credited
 *   - 'never-decremented' wenn `stockDecrementedAt` unset (nichts gutzuschreiben)
 *   - idempotent: ein zweiter cancel/return-Event darf nicht doppelt gutschreiben
 *   - Check-and-Set gegen den IN DERSELBEN Tx gelesenen Wert → genau einer gewinnt
 *
 * Reiner Unit-Test: das Modul haengt nur von `tx` + `orderRef` ab, keine
 * GCP-/Firestore-Imports → kein require.cache-Patching noetig.
 */

'use strict';

const {
  readOrderRecreditStateInTx,
  writeOrderRecreditClaimInTx,
  claimOrderStockRecreditInTx,
} = require('../lib/order-stock-recredit-claim');

// ─── Mock-Tx ────────────────────────────────────────────────────────────────
// Simuliert eine Firestore-Tx: `get` liefert das geseedete Snapshot,
// `update` wird aufgezeichnet. Reicht fuer die phasen-getrennte Read/Write-API.

function makeTx({ snapData = null, exists = true } = {}) {
  const updates = [];
  return {
    get: vi.fn(async () => ({
      exists,
      data: () => snapData || {},
    })),
    update: vi.fn((ref, patch) => {
      updates.push({ ref, patch });
    }),
    __updates: updates,
  };
}

const ORDER_REF = { __id: 'orders/ORDER-RC-1', id: 'ORDER-RC-1' };
const NOW_ISO = '2026-06-28T12:00:00.000Z';

// Order die regulaer dekrementiert wurde, aber noch nicht re-credited.
const DECREMENTED_NOT_RECREDITED = {
  tenantId: 'default',
  stockDecrementedAt: '2026-06-20T10:00:00.000Z',
  stockDecrementedBy: 'ship',
  stockDecrementedSkus: ['SKU-RC-001', 'SKU-RC-002'],
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('order-stock-recredit-claim', () => {
  describe('claimOrderStockRecreditInTx — claims only when decremented && !alreadyRecredited', () => {
    it('claimed:true und setzt stockRecreditedAt/By/Skus, wenn dekrementiert und noch nicht re-credited', async () => {
      const tx = makeTx({ snapData: DECREMENTED_NOT_RECREDITED });

      const res = await claimOrderStockRecreditInTx({
        tx,
        orderRef: ORDER_REF,
        by: 'cancel',
        skus: ['SKU-RC-001', 'SKU-RC-002'],
        nowIso: NOW_ISO,
      });

      expect(res.claimed).toBe(true);
      expect(res.alreadyRecredited).toBe(false);
      expect(res.at).toBe(NOW_ISO);
      expect(res.by).toBe('cancel');

      expect(tx.update).toHaveBeenCalledTimes(1);
      expect(tx.__updates[0].ref).toBe(ORDER_REF);
      expect(tx.__updates[0].patch).toMatchObject({
        stockRecreditedAt: NOW_ISO,
        stockRecreditedBy: 'cancel',
        stockRecreditedSkus: ['SKU-RC-001', 'SKU-RC-002'],
      });
    });

    it('akzeptiert alle erlaubten by-Werte (cancel|return|label-cancel)', async () => {
      for (const by of ['cancel', 'return', 'label-cancel']) {
        const tx = makeTx({ snapData: DECREMENTED_NOT_RECREDITED });
        const res = await claimOrderStockRecreditInTx({
          tx,
          orderRef: ORDER_REF,
          by,
          skus: ['SKU-RC-001'],
          nowIso: NOW_ISO,
        });
        expect(res.claimed).toBe(true);
        expect(res.by).toBe(by);
        expect(tx.update).toHaveBeenCalledTimes(1);
      }
    });
  });

  describe("never-decremented gate", () => {
    it("claimed:false, reason:'never-decremented' wenn stockDecrementedAt unset → KEIN tx.update", async () => {
      const tx = makeTx({ snapData: { tenantId: 'default' } }); // kein stockDecrementedAt

      const res = await claimOrderStockRecreditInTx({
        tx,
        orderRef: ORDER_REF,
        by: 'cancel',
        skus: ['SKU-RC-001'],
        nowIso: NOW_ISO,
      });

      expect(res.claimed).toBe(false);
      expect(res.reason).toBe('never-decremented');
      expect(tx.update).not.toHaveBeenCalled();
    });
  });

  describe('idempotency gate (alreadyRecredited)', () => {
    it('claimed:false, alreadyRecredited:true wenn stockRecreditedAt bereits gesetzt → KEIN tx.update', async () => {
      const tx = makeTx({
        snapData: {
          ...DECREMENTED_NOT_RECREDITED,
          stockRecreditedAt: '2026-06-25T09:00:00.000Z',
          stockRecreditedBy: 'return',
          stockRecreditedSkus: ['SKU-RC-001', 'SKU-RC-002'],
        },
      });

      const res = await claimOrderStockRecreditInTx({
        tx,
        orderRef: ORDER_REF,
        by: 'cancel',
        skus: ['SKU-RC-001'],
        nowIso: NOW_ISO,
      });

      expect(res.claimed).toBe(false);
      expect(res.alreadyRecredited).toBe(true);
      expect(res.at).toBe('2026-06-25T09:00:00.000Z');
      expect(res.by).toBe('return');
      expect(tx.update).not.toHaveBeenCalled();
    });
  });

  describe('input validation', () => {
    it('wirft bei ungueltigem by-Wert', async () => {
      const tx = makeTx({ snapData: DECREMENTED_NOT_RECREDITED });
      await expect(
        claimOrderStockRecreditInTx({ tx, orderRef: ORDER_REF, by: 'ship', skus: [], nowIso: NOW_ISO })
      ).rejects.toThrow(/invalid by/i);
      expect(tx.update).not.toHaveBeenCalled();
    });

    it('wirft bei fehlendem tx', async () => {
      await expect(
        claimOrderStockRecreditInTx({ orderRef: ORDER_REF, by: 'cancel', skus: [], nowIso: NOW_ISO })
      ).rejects.toThrow(/invalid tx/i);
    });

    it('wirft bei fehlendem orderRef', async () => {
      const tx = makeTx({ snapData: DECREMENTED_NOT_RECREDITED });
      await expect(
        claimOrderStockRecreditInTx({ tx, by: 'cancel', skus: [], nowIso: NOW_ISO })
      ).rejects.toThrow(/orderRef missing/i);
    });

    it('writeOrderRecreditClaimInTx wirft bei ungueltigem by', () => {
      const tx = makeTx({ snapData: DECREMENTED_NOT_RECREDITED });
      expect(() =>
        writeOrderRecreditClaimInTx({ tx, orderRef: ORDER_REF, by: 'nope', skus: [], nowIso: NOW_ISO })
      ).toThrow(/invalid by/i);
    });

    it('readOrderRecreditStateInTx wirft bei fehlendem orderRef', async () => {
      const tx = makeTx({ snapData: DECREMENTED_NOT_RECREDITED });
      await expect(readOrderRecreditStateInTx({ tx })).rejects.toThrow(/orderRef missing/i);
    });
  });

  describe('concurrent-claim semantics (serialize on the tx-read value)', () => {
    it('zweiter Claim, der den post-write-State liest, liefert alreadyRecredited (kein Doppel-Credit)', async () => {
      // Erster Claim gewinnt: Order ist dekrementiert, noch nicht re-credited.
      const txA = makeTx({ snapData: DECREMENTED_NOT_RECREDITED });
      const resA = await claimOrderStockRecreditInTx({
        tx: txA,
        orderRef: ORDER_REF,
        by: 'cancel',
        skus: ['SKU-RC-001', 'SKU-RC-002'],
        nowIso: NOW_ISO,
      });
      expect(resA.claimed).toBe(true);

      // Den vom ersten Claim geschriebenen Marker auf den Snapshot anwenden —
      // so wuerde eine zweite, serialisierte Tx den Order-State sehen.
      const afterWrite = { ...DECREMENTED_NOT_RECREDITED, ...txA.__updates[0].patch };

      // Zweiter Claim liest den aktualisierten Snapshot → muss verlieren.
      const txB = makeTx({ snapData: afterWrite });
      const resB = await claimOrderStockRecreditInTx({
        tx: txB,
        orderRef: ORDER_REF,
        by: 'return',
        skus: ['SKU-RC-001', 'SKU-RC-002'],
        nowIso: '2026-06-28T13:00:00.000Z',
      });

      expect(resB.claimed).toBe(false);
      expect(resB.alreadyRecredited).toBe(true);
      expect(resB.at).toBe(NOW_ISO); // der Marker des ERSTEN Claims bleibt
      expect(txB.update).not.toHaveBeenCalled();
    });
  });

  describe('phase-separated API (read-before-write)', () => {
    it('readOrderRecreditStateInTx liefert decremented/alreadyRecredited/skus ohne Write', async () => {
      const tx = makeTx({ snapData: DECREMENTED_NOT_RECREDITED });
      const state = await readOrderRecreditStateInTx({ tx, orderRef: ORDER_REF });

      expect(state.exists).toBe(true);
      expect(state.decremented).toBe(true);
      expect(state.decrementedSkus).toEqual(['SKU-RC-001', 'SKU-RC-002']);
      expect(state.alreadyRecredited).toBe(false);
      expect(tx.update).not.toHaveBeenCalled();
    });

    it('readOrderRecreditStateInTx liefert exists:false fuer fehlende Order', async () => {
      const tx = makeTx({ exists: false });
      const state = await readOrderRecreditStateInTx({ tx, orderRef: ORDER_REF });
      expect(state.exists).toBe(false);
      expect(state.decremented).toBe(false);
      expect(state.alreadyRecredited).toBe(false);
    });

    it('writeOrderRecreditClaimInTx schreibt den Marker (reine Write-Phase)', () => {
      const tx = makeTx({ snapData: DECREMENTED_NOT_RECREDITED });
      const written = writeOrderRecreditClaimInTx({
        tx,
        orderRef: ORDER_REF,
        by: 'label-cancel',
        skus: ['SKU-RC-001'],
        nowIso: NOW_ISO,
      });
      expect(written.claimed).toBe(true);
      expect(written.at).toBe(NOW_ISO);
      expect(written.by).toBe('label-cancel');
      expect(tx.__updates[0].patch).toMatchObject({
        stockRecreditedAt: NOW_ISO,
        stockRecreditedBy: 'label-cancel',
        stockRecreditedSkus: ['SKU-RC-001'],
      });
    });
  });

  describe('order-not-found path', () => {
    it("claimed:false, reason:'order-not-found' wenn Order nicht existiert → KEIN tx.update", async () => {
      const tx = makeTx({ exists: false });
      const res = await claimOrderStockRecreditInTx({
        tx,
        orderRef: ORDER_REF,
        by: 'cancel',
        skus: ['SKU-RC-001'],
        nowIso: NOW_ISO,
      });
      expect(res.claimed).toBe(false);
      expect(res.reason).toBe('order-not-found');
      expect(tx.update).not.toHaveBeenCalled();
    });
  });
});

'use strict';

/**
 * order-financials.js — Marktplatz-Finanzvorgaenge auf den Auftrag schreiben.
 *
 * Das war die fehlende Schicht (Vorfall Kaufland M63HGK5, 2026-08-18): der
 * Marktplatz kennt Erstattungen, AvyCloud nicht. syncRefunds erkannte sie und
 * legte eine Glocken-Meldung an — auf orders/{id} landete nie ein Betrag.
 * Damit konnte generateInvoice die Erstattung strukturell nicht sehen.
 *
 * NICHT GEGATET durch AUTO_INVOICE. Das Festhalten einer TATSACHE ist etwas
 * anderes als das Ausstellen einer Rechnung. Der Auftrag muss den aktuellen
 * Betrag auch dann kennen, wenn nie eine Rechnung entsteht — das Finanz-
 * Dashboard liest ihn ebenfalls.
 *
 * Additiv: es werden nur neue Felder geschrieben, nie bestehende entfernt.
 */

const { Firestore, FieldValue } = require('@google-cloud/firestore');
const { mergeRefund, computeOrderFinancials } = require('../lib/order-financials');

const ORDERS = 'orders';
let _db;
function getDb() {
  if (!_db) _db = new Firestore();
  return _db;
}

const CANCELLED_STATUSES = new Set(['cancelled', 'storniert']);

/**
 * Traegt EINE Marktplatz-Erstattung am Auftrag ein.
 *
 * Laeuft in einer Firestore-Transaktion: zwei gleichzeitige Sync-Laeufe
 * duerfen denselben Betrag nicht zweimal addieren. Die fachliche Idempotenz
 * haengt zusaetzlich an der refundId (lib/order-financials.js mergeRefund).
 *
 * @param {{orderId: string, tenantId?: string, refund: object, db?: object}} opts
 * @returns {Promise<{ok: boolean, changed: boolean, reason?: string, financials?: object}>}
 */
async function recordMarketplaceRefund({ orderId, tenantId = 'default', refund, db = null, dryRun = false }) {
  const store = db || getDb();
  const ref = store.collection(ORDERS).doc(String(orderId));

  return store.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { ok: false, changed: false, reason: 'order_not_found' };
    const order = snap.data() || {};

    if (order.tenantId && tenantId && order.tenantId !== tenantId) {
      return { ok: false, changed: false, reason: 'tenant_mismatch' };
    }

    const zusammen = mergeRefund(order.marketplaceRefunds || [], refund);
    if (!zusammen.changed) {
      return { ok: true, changed: false, reason: 'already_recorded' };
    }

    const f = computeOrderFinancials({
      totalAmount: order.totalAmount,
      refunds: zusammen.refunds,
      cancelled: CANCELLED_STATUSES.has(String(order.omsStatus || '')),
    });

    const update = {
      marketplaceRefunds: zusammen.refunds,
      refundedTotal: f.refundedTotal,
      netAmount: f.netAmount,
      grossAmount: f.grossAmount,
      financialsUpdatedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    if (f.overRefunded) update.financialsOverRefunded = true;

    // Existiert bereits eine Rechnung, ist sie ab jetzt VERALTET. Sie wurde
    // beim Versand ausgestellt, die Erstattungsbuchung kommt Tage bis Wochen
    // spaeter — das ist der Normalfall, kein Ausnahmefall. Der Auftrag traegt
    // den Hinweis, damit die Korrektur sichtbar wird statt still zu fehlen.
    if (order.invoiceId || order.invoiceNumber) {
      update.invoiceNeedsCorrection = true;
      update.invoiceCorrectionReason = `Erstattung ${f.refundedTotal.toFixed(2)} € nach Rechnungsstellung`;
    }

    if (!dryRun) tx.set(ref, update, { merge: true });
    return { ok: true, changed: true, dryRun, financials: f, invoiceNeedsCorrection: !!update.invoiceNeedsCorrection };
  });
}

/**
 * Findet den Auftrag zu einer Marktplatz-Bestellnummer.
 * Die Doc-ID ist ueblicherweise `<marktplatz>__<nummer>`, aber darauf wird
 * NICHT gebaut — ein Alt-Auftrag kann anders heissen.
 */
async function findOrderByMarketplaceNumber({ nummer, tenantId = 'default', db = null }) {
  const store = db || getDb();
  const n = String(nummer || '').trim();
  if (!n) return null;

  for (const feld of ['marketplaceOrderId', 'orderId', 'number']) {
    const s = await store.collection(ORDERS)
      .where('tenantId', '==', tenantId).where(feld, '==', n).limit(1).get();
    if (!s.empty) return s.docs[0];
  }
  return null;
}

/**
 * Holt die Erstattungen der Marktplaetze und traegt sie an den Auftraegen ein.
 *
 * @param {{tenantId?: string, from?: string, to?: string, lookbackDays?: number, db?: object}} opts
 */
async function syncMarketplaceFinancials({ tenantId = 'default', from = null, to = null, lookbackDays = 60, db = null, dryRun = false } = {}) {
  const store = db || getDb();
  const bis = to || new Date().toISOString().split('T')[0];
  const von = from || new Date(Date.now() - lookbackDays * 864e5).toISOString().split('T')[0];

  const ergebnis = { from: von, to: bis, gefunden: 0, eingetragen: 0, schonBekannt: 0, ohneAuftrag: 0, fehler: [] };
  const erstattungen = [];

  // Kaufland: der Buchungsbericht ist die einzige Quelle mit echten Betraegen
  // (die Retouren-API gibt keinen Erstattungsbetrag heraus — live geprueft).
  //
  // BEWUSST NICHT getKauflandRefunds(): dessen Filter ist zu weit. Er wertet
  // "Storno Freigabe Verkaufserloes" als Erstattung — das ist aber kein
  // Kundengeld, sondern eine zurueckgenommene Erloes-Freigabe (gemessen
  // 18.08.2026: 3 Buchungen, 97,23 €, die den Umsatz faelschlich gemindert
  // haetten). Ausserdem verlangt er ein gefuelltes Feld `order_id` und verlor
  // damit eine echte Erstattung ueber 14,95 €, deren Nummer nur im Text steht.
  try {
    const { getBookings } = require('../lib/kaufland-api');
    const { extractCustomerRefunds } = require('../lib/kaufland-refund-bookings');
    const { bookings } = await getBookings({ from: von, to: bis, storefront: 'de' });
    for (const r of extractCustomerRefunds(bookings)) {
      erstattungen.push({ ...r, marketplace: 'kaufland', source: 'kaufland_booking' });
    }
  } catch (err) {
    ergebnis.fehler.push({ quelle: 'kaufland', error: err.message });
  }

  try {
    const { getEbayRefunds } = require('../lib/ebay-finances');
    const eb = await getEbayRefunds(von, bis);
    for (const r of (eb || [])) {
      const betrag = r.buyerRefund ?? r.amount ?? r.sellerNetRefund ?? null;
      if (betrag) erstattungen.push({ ...r, amount: betrag, marketplace: 'ebay', source: 'ebay_finances' });
    }
  } catch (err) {
    ergebnis.fehler.push({ quelle: 'ebay', error: err.message });
  }

  ergebnis.gefunden = erstattungen.length;

  for (const r of erstattungen) {
    try {
      const doc = await findOrderByMarketplaceNumber({ nummer: r.orderId, tenantId, db: store });
      if (!doc) { ergebnis.ohneAuftrag++; continue; }
      const res = await recordMarketplaceRefund({
        orderId: doc.id,
        tenantId,
        db: store,
        dryRun,
        refund: {
          refundId: r.refundId,
          marketplace: r.marketplace,
          amount: r.amount,
          date: r.date || null,
          source: r.source || null,
        },
      });
      if (res.changed) {
        ergebnis.eingetragen++;
        ergebnis.details = ergebnis.details || [];
        ergebnis.details.push({ auftrag: doc.id, nummer: r.orderId, betrag: r.amount, netto: res.financials?.netAmount, rechnungKorrekturNoetig: !!res.invoiceNeedsCorrection });
      } else ergebnis.schonBekannt++;
    } catch (err) {
      ergebnis.fehler.push({ refundId: r.refundId, error: err.message });
    }
  }

  console.log(`[order-financials] tenant=${tenantId} ${von}–${bis}: gefunden=${ergebnis.gefunden} eingetragen=${ergebnis.eingetragen} schonBekannt=${ergebnis.schonBekannt} ohneAuftrag=${ergebnis.ohneAuftrag} fehler=${ergebnis.fehler.length}`);
  return ergebnis;
}

module.exports = { recordMarketplaceRefund, syncMarketplaceFinancials, findOrderByMarketplaceNumber };

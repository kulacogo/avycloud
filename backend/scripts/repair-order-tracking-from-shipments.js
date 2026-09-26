#!/usr/bin/env node
/**
 * Stellt die Sendungsnummer an Auftraegen wieder her, die der SendCloud-
 * Abgleich mit einem Paket OHNE Sendungsnummer ueberschrieben hat.
 *
 * BEFUND 2026-09-26 (read-only gemessen): 15 von 907 versendeten Auftraegen der
 * letzten 45 Tage hatten `trackingNumber: null`, obwohl ihr Etikett eine
 * Sendungsnummer trug. Muster jedes Mal gleich: Sekunden nach dem echten
 * Etikett (shipments-Doc aus createParcel, mit Nummer) legte der Abgleich ein
 * zweites Doc fuer ein bei SendCloud verwaistes Paket an (gescheiterte
 * Transporteur-Anmeldung, Status "problem", keine Nummer) und schrieb es als
 * Primaer-Sendung auf den Auftrag. Die Ursache ist im Code behoben
 * (services/shipping-engine.js buildSyncOrderTrackingUpdate); dieses Script
 * raeumt den Altbestand auf.
 *
 * Wiederhergestellt wird NUR, wenn es genau eine eindeutige Quelle gibt:
 * die juengste nicht stornierte Sendung desselben Auftrags MIT Nummer, die
 * kein Zusatz-Label ist. Der Auftragsstatus wird nie angefasst.
 *
 * Aufruf (read-only ist Default, schreibt NIE ohne beides):
 *   node backend/scripts/repair-order-tracking-from-shipments.js
 *   node backend/scripts/repair-order-tracking-from-shipments.js --days 90
 *   node backend/scripts/repair-order-tracking-from-shipments.js --apply --confirm RESTORE_TRACKING_V1
 */

'use strict';

const CONFIRM_TOKEN = 'RESTORE_TRACKING_V1';
const SHIPPED_STATUSES = ['shipped', 'delivered', 'completed'];
const DEAD_SHIPMENT_STATUSES = new Set(['cancelled', 'storniert']);

function toMs(v) {
  if (!v) return 0;
  if (typeof v.toDate === 'function') return v.toDate().getTime();
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Rein: welche Sendung ist die echte Primaer-Sendung eines Auftrags ohne
 * Nummer? null = keine eindeutige Quelle → nichts tun.
 *
 * @param {object} order — Auftragsdaten (mit trackingNumber/shipmentId)
 * @param {Array<{id: string, data: object}>} shipments
 * @returns {{ shipment: {id: string, data: object}, reason: string } | { shipment: null, reason: string }}
 */
function pickRestorableShipment(order, shipments) {
  if (order?.trackingNumber) return { shipment: null, reason: 'order_has_tracking' };
  const current = shipments.find((s) => s.id === order?.shipmentId);
  if (current?.data?.trackingNumber) return { shipment: null, reason: 'primary_has_tracking' };

  const usable = shipments
    .filter((s) => s.data?.trackingNumber)
    .filter((s) => !s.data.additionalLabel)
    .filter((s) => !DEAD_SHIPMENT_STATUSES.has(String(s.data.status || '').toLowerCase()));
  if (usable.length === 0) return { shipment: null, reason: 'no_tracked_shipment' };

  const distinct = new Set(usable.map((s) => s.data.trackingNumber));
  if (distinct.size > 1) return { shipment: null, reason: 'ambiguous_multiple_tracking_numbers' };

  // Mehrere Docs derselben Nummer (Etikett + Abgleich-Duplikat): das aus
  // createParcel bevorzugen — es traegt shippingOptionCode und das Etikett.
  usable.sort((a, b) => {
    const aOwn = a.data.source === 'sendcloud_sync' ? 1 : 0;
    const bOwn = b.data.source === 'sendcloud_sync' ? 1 : 0;
    if (aOwn !== bOwn) return aOwn - bOwn;
    return toMs(b.data.createdAt) - toMs(a.data.createdAt);
  });
  return { shipment: usable[0], reason: 'restorable' };
}

function buildRestoreUpdate(order, shipment, nowIso = new Date().toISOString()) {
  const d = shipment.data;
  return {
    trackingNumber: d.trackingNumber,
    trackingUrl: d.trackingUrl || null,
    shippingService: d.carrierName || (d.carrier ? String(d.carrier).toLowerCase() : null),
    shipmentId: shipment.id,
    updatedAt: nowIso,
    'ops.trackingRestored': {
      at: nowIso,
      by: 'repair-order-tracking-from-shipments',
      fromShipmentId: order.shipmentId || null,
      toShipmentId: shipment.id,
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const confirm = args[args.indexOf('--confirm') + 1];
  const daysIdx = args.indexOf('--days');
  const days = daysIdx >= 0 ? parseInt(args[daysIdx + 1], 10) || 60 : 60;
  const projectId = process.env.GOOGLE_CLOUD_PROJECT || 'avycloud';

  if (apply && confirm !== CONFIRM_TOKEN) {
    console.error(`--apply verlangt --confirm ${CONFIRM_TOKEN}`);
    process.exit(2);
  }

  const { Firestore } = require('@google-cloud/firestore');
  const db = new Firestore({ projectId });
  console.log(`Projekt: ${projectId} · Modus: ${apply ? 'APPLY' : 'Trockenlauf'} · Fenster: ${days} Tage`);

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const rows = [];
  for (const status of SHIPPED_STATUSES) {
    const snap = await db.collection('orders').where('omsStatus', '==', status).where('updatedAt', '>=', cutoff).get();
    for (const doc of snap.docs) {
      const order = doc.data();
      if (order.trackingNumber) continue;
      const shipSnap = await db.collection('shipments').where('orderId', '==', doc.id).get();
      const shipments = shipSnap.docs.map((s) => ({ id: s.id, data: s.data() }));
      const { shipment, reason } = pickRestorableShipment(order, shipments);
      rows.push({ id: doc.id, status, marketplace: order.marketplace || '-', push: order.marketplacePush?.status || '-', reason, shipment, order, ref: doc.ref });
    }
  }

  let restored = 0;
  for (const r of rows) {
    const target = r.shipment ? `${r.shipment.id} ${r.shipment.data.trackingNumber} (${r.shipment.data.carrierName || r.shipment.data.carrier})` : '-';
    console.log(`${r.id.padEnd(26)} ${r.status.padEnd(10)} ${r.marketplace.padEnd(9)} push=${r.push.padEnd(8)} ${r.reason.padEnd(36)} → ${target}`);
    if (apply && r.shipment) {
      await r.ref.update(buildRestoreUpdate(r.order, r.shipment));
      restored++;
    }
  }
  const restorable = rows.filter((r) => r.shipment).length;
  console.log(`\nAuftraege ohne Sendungsnummer: ${rows.length} · wiederherstellbar: ${restorable} · ${apply ? `wiederhergestellt: ${restored}` : 'nichts geschrieben (Trockenlauf)'}`);
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { pickRestorableShipment, buildRestoreUpdate, CONFIRM_TOKEN };

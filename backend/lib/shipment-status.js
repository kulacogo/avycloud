'use strict';

/**
 * Wann gilt eine Sendung als LEBENDIG?
 *
 * Der Duplikat-Schutz in services/shipping-engine.js kannte drei Status:
 * 'ausstehend', 'in_zustellung', 'zugestellt'. In der echten Sammlung stehen
 * aber die SendCloud-Rohtexte (Messung 2026-08-17 über 562 Sendungen):
 *
 *   Delivered 334 · ausstehend 134 · cancelled 58 · Awaiting customer pickup 27 · problem 9
 *
 * 'zugestellt' und 'in_zustellung' kamen KEIN EINZIGES MAL vor — der Schutz
 * hing an Werten, die es nicht gibt. Für 361 von 562 Sendungen (64 %) war er
 * blind: ein zweiter Frankier-Versuch hätte ein zweites Label gekauft.
 *
 * Deshalb hier: Normalisieren (Kleinschreibung, Leerzeichen) und die
 * englischen SendCloud-Zustände mitführen.
 *
 * TOT sind nur 'problem' (Ankündigung fehlgeschlagen, Parcel unbrauchbar) und
 * 'cancelled' — nur dort darf neu frankiert werden.
 */

/** Zustände, die einen erneuten Frankier-Versuch blockieren. */
const AKTIVE_SENDUNGS_STATUS = new Set([
  // eigene Schreibweisen
  'ausstehend',
  'in_zustellung',
  'zugestellt',
  // SendCloud (englisch) — das ist, was real in der Sammlung steht
  'created',
  'ready_to_send',
  'announced',
  'shipped',
  'in_transit',
  'at_sorting_centre',
  'en_route_to_sorting_center',
  'out_for_delivery',
  'driver_en_route',
  'delivered',
  'awaiting_customer_pickup',
  'at_pickup_point',
  'delivery_attempt_failed',
]);

function normalizeShipmentStatus(raw) {
  return String(raw == null ? '' : raw)
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

/**
 * Hat diese Sendung ein lebendiges Label?
 *
 * Fail-CLOSED: ein unbekannter Status gilt als lebendig. Ein faelschlich
 * blockierter Neu-Versand kostet einen Klick und eine Rueckfrage; ein
 * faelschlich erlaubter kostet ein zweites Label und echtes Geld.
 */
function istAktiveSendung(status) {
  const s = normalizeShipmentStatus(status);
  if (!s) return false;
  if (s === 'problem' || s === 'cancelled' || s === 'storniert') return false;
  if (AKTIVE_SENDUNGS_STATUS.has(s)) return true;
  return true;
}

module.exports = { istAktiveSendung, normalizeShipmentStatus, AKTIVE_SENDUNGS_STATUS };

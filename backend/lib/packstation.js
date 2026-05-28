'use strict';

/**
 * DHL Packstation / Postfiliale address parsing.
 *
 * Locker (Packstation) and retail-outlet (Postfiliale) deliveries require the
 * recipient's personal DHL "Postnummer" (6–10 digits) IN ADDITION to the
 * station number. Without it SendCloud rejects parcel creation with HTTP 400
 * "Die Postnummer des Empfängers fehlt oder ist ungültig" (category
 * receiver_address).
 *
 * Marketplaces deliver these inconsistently: the Postnummer may appear BEFORE
 * the station token ("1818519, Packstation 514"), AFTER it (eBay joins
 * Street1+Street2 → "Packstation 142, 12345678"), or only in a dedicated
 * customer field. This module normalises all of those into one shape.
 *
 * SendCloud parcel mapping (see services/shipping-engine.js):
 *   address        = "PACKSTATION 142"
 *   house_number   = "142"
 *   to_post_number = <Postnummer>
 */

// Station token + its number. Optional leading "DHL ". Postfiliale must be
// listed before the bare "filiale" alternative so it wins.
const STATION_RE = /(?:dhl\s+)?(packstation|postfiliale|filiale)\s+(\d+)/i;

/**
 * Parse a free-text address line for Packstation/Postfiliale info.
 *
 * @param {string} addressLine
 * @returns {{ isPackstation: boolean, kind: 'packstation'|'postfiliale'|null,
 *             stationNumber: string, postNumber: string }}
 */
function parsePackstation(addressLine) {
  const raw = String(addressLine || '');
  const stationMatch = raw.match(STATION_RE);
  if (!stationMatch) {
    return { isPackstation: false, kind: null, stationNumber: '', postNumber: '' };
  }

  const kind = stationMatch[1].toLowerCase().startsWith('packstation')
    ? 'packstation'
    : 'postfiliale';
  const stationNumber = stationMatch[2];

  // Postnummer = the first 6–10 digit run that is NOT the station number.
  // Scanning the whole string makes position (before/after) irrelevant.
  let postNumber = '';
  const re = /\b(\d{6,10})\b/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    if (m[1] !== stationNumber) {
      postNumber = m[1];
      break;
    }
  }

  return { isPackstation: true, kind, stationNumber, postNumber };
}

/**
 * Resolve the final Postnummer to send to SendCloud.
 * An explicit customer field (entered by an operator) always wins over a value
 * scraped from the free-text address.
 *
 * @param {{ postNumber?: string }} parsed - result of parsePackstation()
 * @param {object} customer - order.customer
 * @returns {string} digits-only Postnummer, or '' if none available
 */
function resolvePostNumber(parsed, customer = {}) {
  const explicit = String(
    customer.postNumber || customer.post_number || customer.postnummer || ''
  ).replace(/\D/g, '');
  if (explicit) return explicit;
  return parsed && parsed.postNumber ? parsed.postNumber : '';
}

module.exports = { parsePackstation, resolvePostNumber };

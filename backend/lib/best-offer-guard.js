/**
 * best-offer-guard.js — WP2 / F0.X Best-Offer price protection (pure).
 *
 * eBay lehnt ein Revise ab, wenn die Best-Offer-Auto-Ablehnungsschwelle
 * (`ListingDetails.MinimumBestOfferPrice`) ≥ dem Sofortkaufpreis (BIN/StartPrice)
 * liegt → das Listing wird un-änderbar (Incident 2026-06-16). Diese Funktion
 * entscheidet rein, ob ein neuer Preis sicher gepusht werden darf.
 *
 * Invariante: ein BIN ≤ Auto-Ablehnungsschwelle wird als UNSICHER gemeldet.
 * Was eBay nie erreicht, kann das Listing nicht lähmen. Bei unbekannter Schwelle
 * oder ungültigem Preis wird NICHT blind blockiert (safe=true, aber `reason`
 * markiert den Grund) — der Guard darf legitime Pushes nie grundlos verhindern.
 */

'use strict';

// Minimaler Sicherheitsabstand über der Schwelle (EUR). minSafePrice = Schwelle + margin.
const DEFAULT_BEST_OFFER_MARGIN = 0.01;

/**
 * @param {Object} params
 * @param {number} params.newPrice - geplanter Sofortkaufpreis (BIN)
 * @param {number|null} params.autoDeclineThreshold - eBay MinimumBestOfferPrice ("observed")
 * @param {number} [params.margin=DEFAULT_BEST_OFFER_MARGIN]
 * @returns {{safe:boolean, reason:string, newPrice:number|null, threshold:number|null, minSafePrice:number|null, margin:number}}
 */
function guardListingPrice({ newPrice, autoDeclineThreshold, margin = DEFAULT_BEST_OFFER_MARGIN } = {}) {
  const m = Number.isFinite(Number(margin)) ? Number(margin) : DEFAULT_BEST_OFFER_MARGIN;
  const threshold = Number(autoDeclineThreshold);

  // No usable Best-Offer threshold (none configured / not yet observed) → can't guard.
  if (!Number.isFinite(threshold) || threshold <= 0) {
    return { safe: true, reason: 'no-threshold-known', newPrice: toNumOrNull(newPrice), threshold: null, minSafePrice: null, margin: m };
  }

  // Number(null) === 0 (finite!), so guard null/empty explicitly; a non-positive
  // price is not a real BIN either → not evaluable.
  const price = Number(newPrice);
  if (newPrice == null || newPrice === '' || !Number.isFinite(price) || price <= 0) {
    return { safe: true, reason: 'no-price', newPrice: null, threshold, minSafePrice: round2(threshold + m), margin: m };
  }

  const minSafePrice = round2(threshold + m);
  if (price <= threshold) {
    return { safe: false, reason: 'price-at-or-below-auto-decline', newPrice: price, threshold, minSafePrice, margin: m };
  }
  return { safe: true, reason: 'above-threshold', newPrice: price, threshold, minSafePrice, margin: m };
}

function toNumOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { guardListingPrice, DEFAULT_BEST_OFFER_MARGIN };

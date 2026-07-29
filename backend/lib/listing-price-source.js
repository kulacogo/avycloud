/**
 * Woher käme der Angebotspreis eines Produkts?
 *
 * Reine Auswertung, kein I/O. Bildet die bestehende Preis-Kette aus
 * `mapProductToEbayItem` und `validatePublishReadiness` (lib/ebay-direct.js) EXAKT nach
 * und benennt zusätzlich die Quelle:
 *
 *   override           — der Aufrufer hat einen Preis mitgegeben (bewusst)
 *   sellPrice          — details.pricing.sellPrice > 0 (bewusst gepflegt)
 *   lowest_price       — details.pricing.lowest_price.amount (NUR recherchierter Marktpreis!)
 *   marketplace_mirror — marketplace.ebay.price (Spiegel des Live-Angebots)
 *   none               — gar kein Preis
 *
 * Hintergrund (Audit 2026-07-29): 438 von 765 Bestandsprodukten haben keinen sellPrice.
 * Bei 408 davon geht damit still der recherchierte Marktpreis als Verkaufspreis online —
 * ein Preis, den niemand bewusst entschieden hat. Diese Bibliothek macht den Unterschied
 * sichtbar, ändert aber selbst NICHTS am Preis.
 */

/** Quellen, die eine bewusste menschliche/kaufmännische Entscheidung darstellen. */
const EXPLICIT_SOURCES = new Set(['override', 'sellPrice']);

function toPositiveNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(num) || num <= 0) return null;
  return num;
}

/**
 * @param {object} product   products_v2-Dokument
 * @param {object} overrides dieselben Overrides wie bei mapProductToEbayItem
 * @returns {{price: number|null, source: string, explicit: boolean}}
 */
function resolveListingPrice(product, overrides = {}) {
  const opts = overrides && typeof overrides === 'object' ? overrides : {};
  const details = product?.details && typeof product.details === 'object' ? product.details : {};
  const pricing = details?.pricing && typeof details.pricing === 'object' ? details.pricing : {};
  const lowest = pricing?.lowest_price && typeof pricing.lowest_price === 'object' ? pricing.lowest_price : {};

  const candidates = [
    ['override', opts.startPrice ?? opts.price],
    ['sellPrice', pricing?.sellPrice],
    ['lowest_price', lowest?.amount],
    ['marketplace_mirror', product?.marketplace?.ebay?.price],
  ];

  for (const [source, raw] of candidates) {
    const price = toPositiveNumber(raw);
    if (price !== null) {
      return { price, source, explicit: EXPLICIT_SOURCES.has(source) };
    }
  }

  return { price: null, source: 'none', explicit: false };
}

/** Gilt diese Quelle als bewusst entschiedener Verkaufspreis? */
function isExplicitPriceSource(source) {
  return EXPLICIT_SOURCES.has(String(source || ''));
}

/**
 * Dasselbe für Kaufland. Die Kette dort ist eine andere (lib/kaufland-api.js pickUnitData):
 * sellPrice → kanalspezifischer Kaufland-Preis → pricing.sellPrice → Marktpreis → amount.
 * Die ersten drei Stufen sind bewusst gepflegte Preise, die letzten beiden nicht.
 */
function resolveKauflandPrice(product) {
  const details = product?.details && typeof product.details === 'object' ? product.details : {};
  const pricing = details?.pricing && typeof details.pricing === 'object' ? details.pricing : {};
  const lowest = pricing?.lowest_price && typeof pricing.lowest_price === 'object' ? pricing.lowest_price : {};

  const candidates = [
    ['sellPrice', pricing?.sellPrice, true],
    ['kaufland_channel', product?.pricing?.kaufland?.price, true],
    ['root_sellPrice', product?.pricing?.sellPrice, true],
    ['lowest_price', lowest?.amount, false],
    ['amount', pricing?.amount, false],
  ];

  for (const [source, raw, explicit] of candidates) {
    const price = toPositiveNumber(raw);
    if (price !== null) return { price, source, explicit };
  }

  return { price: null, source: 'none', explicit: false };
}

/**
 * Liest den Modus des Preis-Gates.
 * 'off' (Default) = exakt heutiges Verhalten, kein Blocker, keine Warnung.
 */
function resolveExplicitPriceMode() {
  const raw = String(process.env.REQUIRE_EXPLICIT_SELLPRICE || '').trim().toLowerCase();
  if (raw === 'warn' || raw === 'block') return raw;
  return 'off';
}

module.exports = {
  resolveListingPrice,
  resolveKauflandPrice,
  isExplicitPriceSource,
  resolveExplicitPriceMode,
  EXPLICIT_SOURCES,
};

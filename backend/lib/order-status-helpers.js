'use strict';

/**
 * order-status-helpers — HARDEN-Wave-7 (2026-05-22).
 *
 * Zentrale Quelle für OMS-Status-Konstanten und Helfer die vorher in mehreren
 * Files dupliziert waren:
 *  - EXCLUDED_ORDER_STATUSES (routes/products.js + services/batch-optimize.js)
 *  - SHIPPED_ORDER_STATUSES   (routes/products.js + services/batch-optimize.js)
 *  - RESERVED_ORDER_STATUSES  (routes/products.js)
 *  - normalizeSkuKey          (routes/products.js + services/batch-optimize.js)
 *  - statusOrder              (routes/webhooks.js inline mit cancelled=99/on_hold=98)
 *  - OMS_RANK                 (services/order-intake-ebay.js inline)
 *
 * Die zwei Rank-Varianten sind absichtlich getrennt:
 *  - getOmsSortOrder:    UI/Pipeline-Sortierung; spiegelt ORDER_STATUSES.sortOrder
 *                        aus services/order-state-machine.js (Single Source of Truth)
 *  - getOmsForwardRank:  "Darf ein neuer Status den aktuellen überschreiben?"
 *                        Terminal-States (cancelled, on_hold) bekommen einen hohen
 *                        Rank damit späte Webhooks sie nicht versehentlich
 *                        überschreiben.
 *
 * Keine Mutationen, keine I/O — nur Konstanten und reine Funktionen.
 */

const EXCLUDED_ORDER_STATUSES = new Set(['cancelled', 'returned']);
const SHIPPED_ORDER_STATUSES = new Set(['shipped', 'delivered', 'completed']);
const RESERVED_ORDER_STATUSES = new Set([
  'new', 'pending', 'confirmed', 'picking', 'picked', 'packing', 'packed', 'on_hold',
]);

/**
 * Normalisiert einen SKU/Product-Key auf eine vergleichbare Form.
 * Beispiel: "  SKU-1234  " -> "1234", "Sku 9999" -> "9999".
 */
function normalizeSkuKey(val) {
  return (val || '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/^sku[-_\s]*/i, '')
    .replace(/\s+/g, '');
}

/**
 * Sortierreihenfolge fuer UI-Pipeline. Liest aus order-state-machine.ORDER_STATUSES
 * mit fallback auf hardcoded map (damit dieser helper isoliert testbar bleibt und
 * keinen require-Zyklus erzeugt).
 */
const SORT_ORDER_FALLBACK = {
  pending: 0, confirmed: 1, picking: 2, picked: 3,
  packing: 4, packed: 5, shipped: 6, delivered: 7,
  completed: 8, cancelled: 9, returned: 10, on_hold: 11,
};

let _cachedSortOrder = null;
function getOmsSortOrder(status) {
  if (!_cachedSortOrder) {
    try {
      // Lazy-require um Circular-Dependency zu vermeiden.
      const { ORDER_STATUSES } = require('../services/order-state-machine');
      const map = {};
      for (const [k, v] of Object.entries(ORDER_STATUSES || {})) {
        if (v && Number.isFinite(v.sortOrder)) map[k] = v.sortOrder;
      }
      _cachedSortOrder = Object.keys(map).length > 0 ? map : SORT_ORDER_FALLBACK;
    } catch (_) {
      _cachedSortOrder = SORT_ORDER_FALLBACK;
    }
  }
  const rank = _cachedSortOrder[status];
  return Number.isFinite(rank) ? rank : -1;
}

/**
 * Forward-Progression-Rank fuer Webhook-Updates.
 * Terminal-States (cancelled, on_hold) bekommen einen sehr hohen Rank damit
 * spaete Webhooks (z.B. "delivered" aus einer alten Cache-Queue) den
 * Stornierungs-Status nicht "ueberschreiben" koennen.
 *
 * "returned" ist hier explizit forward-rank 9 (nicht terminal-blocker) da
 * SendCloud auch Retouren-Status-Meldungen verschicken kann; die sollen den
 * normalen shipped/delivered-Pfad ergaenzen koennen.
 */
const FORWARD_RANK = {
  pending: 0, confirmed: 1, picking: 2, picked: 3,
  packing: 4, packed: 5, shipped: 6, delivered: 7,
  completed: 8, returned: 9,
  on_hold: 98, cancelled: 99,
};

function getOmsForwardRank(status) {
  const rank = FORWARD_RANK[status];
  return Number.isFinite(rank) ? rank : -1;
}

module.exports = {
  EXCLUDED_ORDER_STATUSES,
  SHIPPED_ORDER_STATUSES,
  RESERVED_ORDER_STATUSES,
  normalizeSkuKey,
  getOmsSortOrder,
  getOmsForwardRank,
  // Maps explizit exportieren fuer call-sites die das ganze Mapping brauchen.
  FORWARD_RANK_MAP: FORWARD_RANK,
};

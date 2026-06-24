'use strict';

/**
 * COGS (Wareneinsatz) + Bestandswert-Mathematik für den Admin-Finanzbericht.
 *
 * Wahrheits-Prinzip: Aufträge speichern KEINEN Einkaufspreis zum Verkaufszeitpunkt.
 * Der Wareneinsatz wird daher über den HEUTIGEN `details.pricing.buyPrice` je
 * verkauftem Artikel berechnet (SKU-Match, EAN-Fallback) — "kalkulatorisch".
 * `lowest_price` (Marktpreis) darf NIE als Kostenbasis für COGS dienen; es ist
 * nur ein Verkaufs-/Valuierungs-Proxy. Die Daten-Abdeckung (matchedRevenue /
 * totalItemRevenue) macht sichtbar, wie viel des Umsatzes echte Kostendaten hat.
 *
 * Reine Funktionen ohne Firestore — vollständig unit-getestet (cogs.test.js).
 */

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function round2(x) {
  return Math.round((num(x) + Number.EPSILON) * 100) / 100;
}

function key(x) {
  if (x == null) return '';
  return String(x).trim();
}

/**
 * Baut einen In-Memory-Index sku/ean/barcode → { buyPrice, sellPrice, lowestPrice }.
 * Einmal pro Report-Request über den gesamten Produktkatalog — vermeidet N+1-Reads.
 */
function buildProductCostIndex(products) {
  const index = new Map();
  for (const p of products || []) {
    const pricing = (p && p.details && p.details.pricing) || {};
    const entry = {
      buyPrice: num(pricing.buyPrice),
      sellPrice: num(pricing.sellPrice),
      lowestPrice: num(pricing.lowest_price && pricing.lowest_price.amount),
    };

    const ident = (p && p.identification) || {};
    const identifiers = (p && p.details && p.details.identifiers) || {};
    const candidates = [
      ident.sku,
      identifiers.sku,
      identifiers.ean,
      identifiers.gtin,
      identifiers.upc,
      ...(Array.isArray(ident.barcodes) ? ident.barcodes : []),
    ];

    for (const c of candidates) {
      const k = key(c);
      if (k && !index.has(k)) index.set(k, entry);
    }
  }
  return index;
}

/**
 * COGS eines Auftrags. `item.priceBrutto` ist der Stückpreis; Zeilenumsatz = qty × priceBrutto.
 * Ein Posten zählt nur dann zur Kostendeckung, wenn ein Produkt MIT echtem buyPrice (> 0)
 * gefunden wurde — sonst unmatched (ehrliche Abdeckung).
 */
function computeOrderCogs(order, index) {
  const items = (order && Array.isArray(order.items)) ? order.items : [];
  let cogs = 0;
  let matchedRevenue = 0;
  let totalItemRevenue = 0;
  let matchedItemCount = 0;
  let unmatchedItemCount = 0;

  for (const item of items) {
    const qty = Math.max(0, num(item && item.quantity));
    const unitPrice = num(item && item.priceBrutto);
    const lineRevenue = qty * unitPrice;
    totalItemRevenue += lineRevenue;

    const entry = index.get(key(item && item.sku)) || index.get(key(item && item.ean));
    if (entry && entry.buyPrice > 0) {
      cogs += qty * entry.buyPrice;
      matchedRevenue += lineRevenue;
      matchedItemCount += 1;
    } else {
      unmatchedItemCount += 1;
    }
  }

  return {
    cogs: round2(cogs),
    matchedRevenue: round2(matchedRevenue),
    totalItemRevenue: round2(totalItemRevenue),
    matchedItemCount,
    unmatchedItemCount,
  };
}

/**
 * Bestandswert (Stichtag heute) über den Produktkatalog.
 * - capitalAtCost: gebundenes Kapital = Σ qty × buyPrice — NUR echter Einkaufspreis.
 *   `lowest_price` ist ein Markt-/Verkaufspreis, KEINE Kostenbasis; ihn als Kapital
 *   zu nutzen würde Kosten erfinden, die der Händler nie hatte. Darum kein Fallback.
 * - potentialRevenue: potenzieller Umsatz = Σ qty × (sellPrice || lowest_price) —
 *   hier ist der lowest_price-Fallback legitim (effektiver Listenpreis).
 * - articlesWithCost: wie viele bestandsführende Artikel überhaupt einen buyPrice haben
 *   (Abdeckung — macht sichtbar, wie aussagekräftig das gebundene Kapital ist).
 */
function computeInventoryValue(products) {
  let capitalAtCost = 0;
  let potentialRevenue = 0;
  let articleCount = 0;
  let articlesWithCost = 0;
  let unitCount = 0;

  for (const p of products || []) {
    const qty = Math.max(0, num(p && p.inventory && p.inventory.quantity));
    if (qty <= 0) continue;

    const pricing = (p && p.details && p.details.pricing) || {};
    const lowest = num(pricing.lowest_price && pricing.lowest_price.amount);
    const buy = num(pricing.buyPrice); // cost only — no lowest fallback
    const sell = num(pricing.sellPrice) || lowest;

    if (buy > 0) {
      capitalAtCost += qty * buy;
      articlesWithCost += 1;
    }
    potentialRevenue += qty * sell;
    unitCount += qty;
    articleCount += 1;
  }

  return {
    capitalAtCost: round2(capitalAtCost),
    potentialRevenue: round2(potentialRevenue),
    articleCount,
    articlesWithCost,
    unitCount,
  };
}

module.exports = {
  buildProductCostIndex,
  computeOrderCogs,
  computeInventoryValue,
};

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
function buildProductCostIndex(products, lotCosts) {
  const index = new Map();
  for (const p of products || []) {
    const pricing = (p && p.details && p.details.pricing) || {};
    const entry = {
      buyPrice: num(pricing.buyPrice),
      sellPrice: num(pricing.sellPrice),
      lowestPrice: num(pricing.lowest_price && pricing.lowest_price.amount),
      // Einkaufspreis aus dem Los (Los-Betrag / Einheiten im Los). Kein Produkt
      // hat einen eigenen buyPrice — ohne das hier bleibt nur die Pauschale,
      // und die liegt je Los um bis zu Faktor 24 daneben.
      lotCostNetto: 0,
      // Geht die Mengen-Bilanz des Loses auf? Nur dann darf sein Stueckpreis
      // als "exakt" gelten. Default true = Verhalten der Alt-Quelle, die keine
      // Selbstauskunft mitliefert.
      lotStimmig: true,
      sourceLot: String((p && p.ops && p.ops.sourceLot) || '').trim() || null,
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

    if (entry.sourceLot && lotCosts instanceof Map) {
      const lot = lotCosts.get(entry.sourceLot);
      if (lot && lot.netto > 0) {
        entry.lotCostNetto = lot.netto;
        if (lot.stimmig === false) entry.lotStimmig = false;
      }
    }

    for (const c of candidates) {
      const k = key(c);
      if (k && !index.has(k)) index.set(k, entry);
    }
  }
  return index;
}

/**
 * COGS eines Auftrags. `item.priceBrutto` ist der Stückpreis; Zeilenumsatz = qty × priceBrutto.
 * Kostenquelle je Posten, in Priorität:
 *   1. echter `buyPrice` am Produkt (> 0)   → exakt
 *   2. Los-Preis (Einkaufsbetrag des Loses ÷ dort erfasste Einheiten)
 *      → exakt, wenn die Mengen-Bilanz des Loses aufgeht, sonst geschätzt
 *   3. sonst                                → unmatched (keine Kostendaten)
 *
 * Es gibt KEINE dritte, geschätzte Quelle mehr. Die frühere Paletten-Pauschale
 * (Palettenpreis ÷ Einheiten je Palette) ist als Kostenquelle abgeschafft —
 * Betreiber-Anweisung 31.08.2026: beide Zahlen sind dem Betrieb unbekannt, der
 * daraus abgeleitete Stückpreis war erfunden. `costModel` wird nur noch für die
 * Gebührensätze durchgereicht und fließt in keine Kostenrechnung mehr ein.
 *
 * `matchedRevenue` = Umsatz der Posten mit irgendeiner Kostenbasis (für die Abdeckung).
 */
function computeOrderCogs(order, index, costModel) {
  const items = (order && Array.isArray(order.items)) ? order.items : [];
  let cogs = 0;
  let matchedRevenue = 0;
  let totalItemRevenue = 0;
  let exactItemCount = 0;
  let estimatedItemCount = 0;
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
      exactItemCount += 1;
    } else if (entry && entry.lotCostNetto > 0) {
      // Los-Preis: aus dem, was der Betreiber fuer dieses Los wirklich bezahlt
      // hat. Schlaegt jede Pauschale, weil er je Los gemessen ist.
      cogs += qty * entry.lotCostNetto;
      matchedRevenue += lineRevenue;
      // "Exakt" nur, wenn die Mengen-Bilanz des Loses aufgeht. Sonst ist die
      // Bezugsmenge selbst unsicher und der Stueckpreis eine Schaetzung — er
      // gehoert dann nicht in dieselbe Schublade wie ein am Produkt erfasster
      // Einkaufspreis.
      if (entry.lotStimmig === false) estimatedItemCount += 1;
      else exactItemCount += 1;
    } else {
      // KEINE Paletten-Pauschale mehr (Betreiber-Anweisung 31.08.2026): "wir
      // koennen nur auf Grundlage der erfassten Einheiten je Los rechnen".
      // Der Palettenpreis und die Einheiten je Palette sind Zahlen, die der
      // Betrieb gar nicht kennt — eine daraus geschaetzte Kostenbasis war
      // erfunden. Ein Posten ohne Los-Preis zaehlt jetzt als NICHT bepreist
      // und faellt sichtbar in die Abdeckungsquote, statt still einen
      // Fantasiewert in den Wareneinsatz zu tragen.
      unmatchedItemCount += 1;
    }
  }

  return {
    cogs: round2(cogs),
    matchedRevenue: round2(matchedRevenue),
    totalItemRevenue: round2(totalItemRevenue),
    exactItemCount,
    estimatedItemCount,
    // Posten mit irgendeiner Kostenbasis (exakt ODER geschätzt).
    matchedItemCount: exactItemCount + estimatedItemCount,
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
 * - articlesFromLot: über den Los-Preis bewertet — heute der Regelfall.
 * - articlesEstimated: OHNE jede Kostenbasis (weder buyPrice noch Los-Preis).
 *   Der Name ist historisch; eine Schätzung findet nicht mehr statt.
 */
function computeInventoryValue(products, costModel, lotCosts) {
  let capitalAtCost = 0;
  let potentialRevenue = 0;
  let articleCount = 0;
  let articlesWithCost = 0;
  let articlesEstimated = 0;
  let articlesFromLot = 0;
  let unitCount = 0;

  const hatLose = lotCosts instanceof Map && lotCosts.size > 0;

  for (const p of products || []) {
    const qty = Math.max(0, num(p && p.inventory && p.inventory.quantity));
    if (qty <= 0) continue;

    const pricing = (p && p.details && p.details.pricing) || {};
    const lowest = num(pricing.lowest_price && pricing.lowest_price.amount);
    const buy = num(pricing.buyPrice); // real cost only — never lowest as cost
    const sell = num(pricing.sellPrice) || lowest;

    // Los-Preis, falls bekannt. OHNE diesen Zweig bewertet der Bericht dieselbe
    // Ware an zwei Stellen unterschiedlich: der Wareneinsatz mit dem Los-Preis,
    // das gebundene Kapital mit der Paletten-Pauschale. Gemessen 30.08.2026 war
    // das gebundene Kapital dadurch 23.394,80 € statt rund 14.000 € — die
    // Pauschale (7,15 €/Einheit netto) liegt weit ueber dem echten Los-Preis.
    const losCode = hatLose ? String((p && p.ops && p.ops.sourceLot) || '').trim() : '';
    const los = losCode ? lotCosts.get(losCode) : null;

    if (buy > 0) {
      capitalAtCost += qty * buy;
      articlesWithCost += 1;
    } else if (los && los.netto > 0) {
      capitalAtCost += qty * los.netto;
      articlesFromLot += 1;
    } else {
      // Kein Los-Preis, kein Einkaufspreis am Produkt -> KEIN Wert. Die
      // Paletten-Pauschale ist als Kostenquelle abgeschafft (siehe
      // computeOrderCogs). `articlesEstimated` bleibt als Feld erhalten, damit
      // Alt-Aufrufer und die Oberflaeche nicht brechen — es zaehlt jetzt die
      // Artikel OHNE Kostenbasis.
      if (qty > 0) articlesEstimated += 1;
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
    articlesFromLot,
    articlesEstimated,
    unitCount,
  };
}

module.exports = {
  buildProductCostIndex,
  computeOrderCogs,
  computeInventoryValue,
};

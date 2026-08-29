/**
 * Woher kaeme der Verkaufspreis eines Produkts?
 *
 * Spiegelt die Kette, die der Marktplatz beim Einstellen wirklich benutzt
 * (`backend/lib/listing-price-source.js resolveListingPrice`):
 *
 *   confirmed — details.pricing.sellPrice > 0, kaufmaennisch entschieden
 *   market    — details.pricing.lowest_price.amount, NUR recherchierter Marktpreis
 *   missing   — gar kein Preis
 *
 * `market` ist ein echter Verkaufspreis — mit ihm geht der Artikel online —, aber
 * kein entschiedener. Wer beide gleich behandelt, verliert genau die
 * Unterscheidung, die man zum Nachpflegen braucht.
 *
 * Eigene Datei, obwohl klein: Produkttabelle, Filter-Registry und CSV-Export
 * haengen daran. Laege sie in einem dieser drei, muessten die anderen beiden das
 * ganze Modul mitziehen — genau so entstehen die Kopien, die auseinanderlaufen.
 * Frei von React und ohne Abhaengigkeiten, damit `node --test` sie direkt laedt.
 */
import type { Product } from "../types.ts";

export type SellPriceSource = "confirmed" | "market" | "missing";

export function resolveSellPrice(p: Product): { amount: number | null; source: SellPriceSource } {
  const pricing = p.details?.pricing;
  const sell = Number(pricing?.sellPrice);
  if (Number.isFinite(sell) && sell > 0) return { amount: sell, source: "confirmed" };
  const market = Number(pricing?.lowest_price?.amount);
  if (Number.isFinite(market) && market > 0) return { amount: market, source: "market" };
  return { amount: null, source: "missing" };
}

/** Effektiver Verkaufspreis: sellPrice gewinnt, sonst recherchierter Marktpreis. */
export function effectiveSellPrice(p: Product): number | null {
  return resolveSellPrice(p).amount;
}

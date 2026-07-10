/**
 * Regression (Incident 2026-07-10, SONAX 18,95 €): Der Chat sagte "Preis im
 * Datenblatt aktualisiert", schrieb aber nur pricing.lowest_price (Recherche-
 * Doku) — pricing.sellPrice (DER Angebotspreis, eBay/Kaufland-Sync) existierte
 * im update_datasheet-Tool-Schema von V2/Legacy gar nicht. Das Modell KONNTE
 * die Preisempfehlung nirgends hinschreiben.
 *
 * Grep-Style-Invariante (wie oversell-invariant.test.js): jede Chat-Pipeline
 * muss im pricing-Schema einen Weg haben, den Verkaufspreis auszudrücken —
 * V2/Legacy via `sellPrice`, V3 via flachem `amount` (Frontend mappt auf
 * sellPrice, siehe GeminiChat.tsx normalizeIncoming).
 */

const fs = require('fs');
const path = require('path');

function pricingBlock(file) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', file), 'utf8');
  // Grab a window after each `pricing: {` occurrence — enough to cover the schema props.
  const blocks = [];
  let idx = src.indexOf('pricing: {');
  while (idx !== -1) {
    blocks.push(src.slice(idx, idx + 1500));
    idx = src.indexOf('pricing: {', idx + 1);
  }
  return blocks.join('\n---\n');
}

describe('Chat-Pipelines: pricing-Schema kann den VERKAUFSPREIS ausdrücken', () => {
  it('V2 update_datasheet-Schema enthält sellPrice', () => {
    expect(pricingBlock('product-chat-v2.js')).toMatch(/sellPrice/);
  });

  it('Legacy update_datasheet-Schema enthält sellPrice (additionalProperties:false würde es sonst ablehnen)', () => {
    expect(pricingBlock('product-chat.js')).toMatch(/sellPrice/);
  });

  it('V3 pricing-Schema hat den flachen amount (Frontend mappt auf sellPrice)', () => {
    expect(pricingBlock('product-chat-v3.js')).toMatch(/amount/);
  });
});

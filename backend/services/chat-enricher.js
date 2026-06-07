'use strict';

/**
 * chat-enricher.js — enrich a product's FULL datasheet using the same research-
 * grounded chat pipeline the assistant uses (runProductChatV3), then apply ALL
 * proposals via applyChatChangesToProduct.
 *
 * This is the parity path the user asked for: the bulk veredler reaches chat
 * quality on EVERYTHING (title, price, gpsr, attributes, description, weight) so
 * the chat is rarely needed afterwards. Content only — never inventory/sku/storage,
 * never category, never marketplace publish. Returns proposals applied to a CLONE
 * (caller persists via saveProductV2). runProductChatV3 is injectable for tests.
 */

const { applyChatChangesToProduct } = require('../lib/apply-chat-changes');

const FULL_ENRICH_MESSAGE = [
  'Reichere das KOMPLETTE Datenblatt dieses Produkts auf eBay-/Kaufland-Listing-Standard an.',
  'Recherchiere fehlende ODER falsche Daten aktiv (googleSearch, urlContext, lookup_gtin, search_ebay_catalog, search_amazon_product, search_manufacturer_site, fetch_url_content) und KORRIGIERE sie. Cross-referenziere mindestens 2 Quellen.',
  'Fülle/korrigiere: Titel (MARKE ZUERST, 70–80 Zeichen), Beschreibung, Key-Features, ALLE eBay-Pflicht-Merkmale (Maße/Material/Farbe/Anwendung — verifiziert!), GPSR (Hersteller bzw. EU-Verantwortlicher), Gewicht, Preis (mit Quellen-URL).',
  'Ändere NICHT die Kategorie. Erfinde nichts — nur belegte Fakten; bei Unsicherheit confidence < 0.7 und Feld weglassen.',
  'Gib alle Änderungen über update_product_datasheet zurück, inkl. Quellen.',
].join('\n');

async function enrichViaChatV3(product, opts = {}) {
  const deps = opts.deps || {};
  const runChat = deps.runProductChatV3 || require('./product-chat-v3').runProductChatV3;

  let result;
  try {
    result = await runChat({
      product,
      message: FULL_ENRICH_MESSAGE,
      tenantId: opts.tenantId || null,
      userId: opts.userId || 'bulk-veredler',
    });
  } catch (e) {
    return { product, changed: [], datasheetChanges: [], evidence: [], confidence: null, model: null, error: (e && e.message) || String(e) };
  }

  const datasheetChanges = Array.isArray(result && result.datasheetChanges) ? result.datasheetChanges : [];
  const { product: merged, changed } = applyChatChangesToProduct(product, datasheetChanges, { nowIso: opts.nowIso });

  return {
    product: merged,
    changed,
    datasheetChanges,
    evidence: Array.isArray(result && result.evidence) ? result.evidence : [],
    confidence: result && result.confidence && typeof result.confidence.overall === 'number' ? result.confidence.overall : null,
    model: (result && result.model) || null,
  };
}

module.exports = { enrichViaChatV3, FULL_ENRICH_MESSAGE };

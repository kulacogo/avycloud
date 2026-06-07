'use strict';

/**
 * title-optimizer.js — generate a chat-quality eBay title by REUSING the same
 * research-grounded pipeline the chat assistant uses (runProductChatV3).
 *
 * The chat does the right thing already: it researches (googleSearch + urlContext
 * + atomic-tools), verifies/corrects facts (e.g. measurements), follows the title
 * rules, and uses the correct model + drift-safe params (gemini-3.1-pro-preview-
 * customtools, temperature 1.0, thinkingLevel high, NO mediaResolution/thinkingBudget).
 * It returns PROPOSALS only (datasheetChanges) — nothing is saved.
 *
 * We take its proposed title, apply a hard BRAND-FIRST safety net (prod incident
 * 2026-06-07), and return it together with the research evidence + confidence so
 * the operator can review quality before anything is applied.
 *
 * runProductChatV3 is injectable via opts.deps for offline tests.
 */

const TITLE_MESSAGE = [
  'Optimiere AUSSCHLIESSLICH den eBay-Titel dieses Produkts. Befolge die Regeln strikt:',
  '1. Die MARKE muss das ERSTE Wort des Titels sein.',
  '2. Reihenfolge: [Marke] [Produktart] [wichtigste Merkmale: Maße, Farbe, Material, Anwendung].',
  '3. Länge 70–80 Zeichen, niemals über 80. Größen-Kürzel (XL, XXL) GROSSBUCHSTABEN.',
  '4. Keine Marketing-Floskeln, keine Emojis, keine EAN/GTIN/SKU, keine Wörter aus falschen Kategorien (z. B. "Zubehör", wenn es das ganze Produkt ist).',
  '5. Prüfe die MASSE (Breite/Höhe/Tiefe) per Recherche (lookup_gtin, search_amazon_product, search_manufacturer_site, fetch_url_content, googleSearch) und KORRIGIERE falsche Werte. Cross-referenziere mindestens 2 Quellen.',
  '6. Nur wahre, belegte Fakten. Bei Unsicherheit confidence < 0.7.',
  'Gib das Ergebnis über update_product_datasheet zurück (Feld "title"), mit Quellen.',
].join('\n');

function safeStr(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function optimizeTitle(product, opts = {}) {
  const deps = opts.deps || {};
  const runChat = deps.runProductChatV3 || require('../services/product-chat-v3').runProductChatV3;

  const brand = safeStr(product && product.identification && product.identification.brand);
  if (!brand) return null; // never risk a brandless title

  let result;
  try {
    result = await runChat({
      product,
      message: TITLE_MESSAGE,
      tenantId: opts.tenantId || null,
      userId: opts.userId || 'bulk-veredler',
    });
  } catch (e) {
    return null; // never crash the bulk on a single product
  }

  const changes = Array.isArray(result && result.datasheetChanges) ? result.datasheetChanges : [];
  const titled = changes.filter((c) => c && safeStr(c.title));
  let title = titled.length ? safeStr(titled[titled.length - 1].title) : '';
  if (!title) return null;

  // BRAND-FIRST safety net
  const b = brand.toLowerCase();
  if (!title.toLowerCase().startsWith(b)) {
    const stripped = title.replace(new RegExp('\\b' + escapeRe(brand) + '\\b', 'ig'), '').replace(/\s+/g, ' ').trim();
    title = `${brand} ${stripped}`.replace(/\s+/g, ' ').trim();
  }
  if (!title.toLowerCase().includes(b)) return null; // hard fail-safe

  if (title.length > 80) title = title.slice(0, 80).replace(/\s+\S*$/, '').trim();

  return {
    title,
    evidence: Array.isArray(result && result.evidence) ? result.evidence : [],
    confidence: result && result.confidence && typeof result.confidence.overall === 'number' ? result.confidence.overall : null,
    model: (result && result.model) || null,
  };
}

module.exports = { optimizeTitle, TITLE_MESSAGE };

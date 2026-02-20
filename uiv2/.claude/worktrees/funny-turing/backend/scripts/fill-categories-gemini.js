/**
 * Versucht, fehlende eBay- und Kaufland-Kategorien mit Gemini (default: Gemini 3 Pro preview) zu bestimmen.
 *
 * Nutzung:
 *   GOOGLE_API_KEY=... NODE_PATH=backend/node_modules node backend/scripts/fill-categories-gemini.js
 *
 * Ablauf:
 *  - Lädt alle Produkte mit Bestand (inventory.quantity + BIN-Menge > 0)
 *  - Für Produkte ohne ebayCategoryId oder kauflandCategoryId:
 *      * fragt Gemini nach passenden Kategorie-Pfaden (Text), getrennt für eBay/Kaufland
 *      * mappt den Pfad via MarketplaceLookup auf eine gültige ID
 *      * schreibt IDs + Pfade in details / attributes
 *
 * Sicherheit:
 *  - Keine Überschreibung vorhandener gültiger IDs
 *  - Loggt Erfolge/Fehlschläge
 */

const path = require('path');
const { Firestore } = require('@google-cloud/firestore');
const { getGeminiClient } = require('../lib/gemini-client');
const { resolveModel } = require('../lib/model-select');
const { MarketplaceLookup } = require('../lib/marketplace-lookup');

const db = new Firestore({ projectId: process.env.GOOGLE_CLOUD_PROJECT || 'avycloud' });
const lookup = new MarketplaceLookup({
  ebayCsvPath: path.join(__dirname, '..', 'ebay', 'DE_New_Structure_(May2023).csv'),
  kauflandCsvPath: path.join(__dirname, '..', 'kaufland', 'category_tree_all_languages.csv'),
  ebayPathColumn: 'category_path',
  kauflandPathColumn: 'category_path',
});

function mapAttrs(attrs = {}) {
  return Object.entries(attrs)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
    .join(' | ');
}

function buildPrompt(product) {
  const name = product?.identification?.name || '';
  const brand = product?.identification?.brand || '';
  const cat = product?.identification?.category || '';
  const desc = product?.details?.description || product?.details?.short_description || '';
  const attrs = mapAttrs(product?.details?.attributes || {});
  const sku = product?.details?.identifiers?.sku || product?.identification?.sku || product?.id;

  return `
Du bist ein Kategorisierungs-Assistent. Finde jeweils einen passenden Kategorie-PFAD (deutsch)
für eBay (inventory 85403) und Kaufland (inventory 85404). Liefere NUR ein JSON-Objekt:
{ "ebay_path": "...", "kaufland_path": "..." }

Regeln:
- Nutze realistische, präzise Pfade (deutsch) entsprechend dem Marktplatz.
- Wenn unsicher, nimm den spezifischsten sinnvollen Pfad (kein "Sonstiges").
- Keine IDs ausdenken – nur Pfade textuell zurückgeben.

Daten:
SKU: ${sku}
Name: ${name}
Marke: ${brand}
Kategorie (frei): ${cat}
Beschreibung: ${desc}
Attribute: ${attrs}
  `.trim();
}

async function classifyWithGemini(prompt) {
  const client = await getGeminiClient();
  const modelName = resolveModel(null, 'FILL_MARKETPLACE_CATEGORIES_MODEL', 'gemini-3-pro-preview');
  const model = client.getGenerativeModel({ model: modelName });
  const resp = await model.generateContent(prompt);
  const text = resp?.response?.text() || '';
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return {};
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.warn('Failed to parse Gemini response', e.message, text.slice(0, 200));
    return {};
  }
}

async function main() {
  await lookup.ensureEbay();
  await lookup.ensureKaufland();

  const snap = await db.collection('products').get();
  let processed = 0;
  let updated = 0;
  const missingE = [];
  const missingK = [];

  for (const doc of snap.docs) {
    const data = doc.data() || {};
    const qty = data.inventory?.quantity || 0;
    const binQty = Array.isArray(data.storageBins)
      ? data.storageBins.reduce((s, b) => s + (b.quantity || 0), 0)
      : 0;
    if (qty + binQty <= 0) continue; // only products with stock

    const attrs = { ...(data.details?.attributes || {}) };
    let ebayId = data.details?.ebayCategoryId;
    let kauflandId = data.details?.kauflandCategoryId;

    const needE = !ebayId || !lookup.isValidEbayId(String(ebayId));
    const needK = !kauflandId || !lookup.isValidKauflandId(String(kauflandId));
    if (!needE && !needK) continue;

    processed++;
    const prompt = buildPrompt(data);
    const res = await classifyWithGemini(prompt);

    // Map returned paths to IDs via lookup
    if (needE && res.ebay_path) {
      const id = lookup.lookupEbay(res.ebay_path);
      if (id) {
        ebayId = String(id);
        attrs.ebay_category_id = ebayId;
        attrs.ebay_category_path = res.ebay_path;
      } else {
        missingE.push({ id: doc.id, sku: data.details?.identifiers?.sku, path: res.ebay_path });
      }
    }
    if (needK && res.kaufland_path) {
      const id = lookup.lookupKaufland(res.kaufland_path);
      if (id) {
        kauflandId = String(id);
        attrs.kaufland_category_id = kauflandId;
        attrs.kaufland_category_path = res.kaufland_path;
      } else {
        missingK.push({ id: doc.id, sku: data.details?.identifiers?.sku, path: res.kaufland_path });
      }
    }

    const patch = {};
    if (ebayId && lookup.isValidEbayId(String(ebayId))) {
      patch.details = patch.details || {};
      patch.details.ebayCategoryId = ebayId;
      patch.details.ebayCategoryPath = attrs.ebay_category_path || data.details?.ebayCategoryPath || '';
    }
    if (kauflandId && lookup.isValidKauflandId(String(kauflandId))) {
      patch.details = patch.details || {};
      patch.details.kauflandCategoryId = kauflandId;
      patch.details.kauflandCategoryPath =
        attrs.kaufland_category_path || data.details?.kauflandCategoryPath || '';
    }
    if (Object.keys(attrs).length) {
      patch.details = patch.details || {};
      patch.details.attributes = { ...(data.details?.attributes || {}), ...attrs };
    }
    if (patch.details) {
      patch.ops = { ...(data.ops || {}), last_saved_iso: new Date().toISOString() };
      await doc.ref.set(patch, { merge: true });
      updated++;
    }
  }

  console.log(
    JSON.stringify(
      {
        processed,
        updated,
        missingE: missingE.length,
        missingK: missingK.length,
        sampleMissingE: missingE.slice(0, 10),
        sampleMissingK: missingK.slice(0, 10),
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

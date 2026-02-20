/**
 * Fill missing eBay / Kaufland category IDs on products.
 *
 * Usage:
 *   GOOGLE_CLOUD_PROJECT=avycloud NODE_PATH=backend/node_modules node backend/scripts/fill-missing-categories.js
 *
 * Logic:
 *  - Load all products from Firestore
 *  - If details.ebayCategoryId missing: try direct numeric ID from attributes; otherwise lookup via path (attributes.ebay_category_path, ebay_category, identification.category)
 *  - If details.kauflandCategoryId missing: try direct numeric ID from attributes; otherwise lookup via path (details.kauflandCategoryPath, attributes.kaufland_category_path, kaufland_category, Kategorie, identification.category)
 *  - Validate IDs against marketplace-lookup ID sets
 *  - Write updates back (details.ebayCategoryId, details.ebayCategoryPath, attributes.ebay_category_id/path, details.kauflandCategoryId, details.kauflandCategoryPath, attributes.kaufland_category_id/path)
 *  - No overwriting of existing IDs
 */

const path = require('path');
const { Firestore } = require('@google-cloud/firestore');
const { MarketplaceLookup } = require('../lib/marketplace-lookup');

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || 'avycloud';
const db = new Firestore({ projectId: PROJECT_ID });

const EBAY_CATEGORY_CSV = path.join(__dirname, '..', 'ebay', 'DE_New_Structure_(May2023).csv');
const KAUFLAND_CATEGORY_CSV = path.join(__dirname, '..', 'kaufland', 'category_tree_all_languages.csv');

const lookup = new MarketplaceLookup({
  ebayCsvPath: EBAY_CATEGORY_CSV,
  kauflandCsvPath: KAUFLAND_CATEGORY_CSV,
  ebayPathColumn: 'category_path',
  kauflandPathColumn: 'category_path',
});

function isNumericId(id) {
  return id !== undefined && id !== null && /^\d+$/.test(String(id).trim());
}

function normalizePath(value) {
  if (!value) return null;
  return value.toString().trim();
}

async function main() {
  const snap = await db.collection('products').get();
  console.log(`Loaded products: ${snap.size}`);

  let batch = db.batch();
  let count = 0;
  let updates = 0;

  const commit = async () => {
    if (count === 0) return;
    await batch.commit();
    console.log(`Committed batch of ${count}`);
    batch = db.batch();
    count = 0;
  };

  snap.forEach((doc) => {
    const data = doc.data() || {};
    const details = data.details || {};
    const attrs = details.attributes || {};

    const update = {};
    // eBay
    const existingEbayId = details.ebayCategoryId;
    const ebayIdOk = existingEbayId && lookup.isValidEbayId(String(existingEbayId).trim());
    if (!ebayIdOk) {
      const directId =
        details.ebayCategoryId ||
        attrs.ebay_category_id ||
        attrs.ebayCategoryId ||
        attrs['ebay.category_id'] ||
        null;
      const directPath =
        details.ebayCategoryPath ||
        attrs.ebay_category_path ||
        attrs.ebay_category ||
        details.ebayCategory ||
        attrs.Kategorie ||
        attrs.category ||
        data.identification?.category ||
        null;

      let ebayId = null;
      if (isNumericId(directId) && lookup.isValidEbayId(String(directId).trim())) {
        ebayId = String(directId).trim();
      } else {
        const sourcePath = normalizePath(directPath || data.identification?.category);
        if (sourcePath) {
          ebayId = lookup.lookupEbay(sourcePath);
        }
      }

      if (ebayId) {
        update['details.ebayCategoryId'] = ebayId;
        const pathStr = normalizePath(directPath) || normalizePath(data.identification?.category) || '';
        update['details.ebayCategoryPath'] = pathStr || `ID:${ebayId}`;
        update['details.attributes.ebay_category_id'] = ebayId;
        update['details.attributes.ebay_category_path'] = pathStr || `ID:${ebayId}`;
      }
    }

    // Kaufland
    const existingKaufId = details.kauflandCategoryId;
    const kaufIdOk = existingKaufId && lookup.isValidKauflandId(String(existingKaufId).trim());
    if (!kaufIdOk) {
      const directId =
        details.kauflandCategoryId ||
        attrs.kaufland_category_id ||
        attrs.kauflandCategoryId ||
        attrs['kaufland.category_id'] ||
        null;

      let kaufId = null;
      if (isNumericId(directId) && lookup.isValidKauflandId(String(directId).trim())) {
        kaufId = String(directId).trim();
      } else {
        const pathCandidate =
          normalizePath(details.kauflandCategoryPath) ||
          normalizePath(attrs.kaufland_category_path) ||
          normalizePath(attrs.kaufland_category) ||
          normalizePath(attrs.Kategorie) ||
          normalizePath(attrs.category) ||
          normalizePath(data.identification?.category);
        if (pathCandidate) {
          kaufId = lookup.lookupKaufland(pathCandidate);
        }
      }

      if (kaufId) {
        update['details.kauflandCategoryId'] = kaufId;
        const pathStr =
          normalizePath(details.kauflandCategoryPath) ||
          normalizePath(attrs.kaufland_category_path) ||
          normalizePath(attrs.kaufland_category) ||
          normalizePath(attrs.Kategorie) ||
          normalizePath(attrs.category) ||
          normalizePath(data.identification?.category) ||
          `ID:${kaufId}`;
        update['details.kauflandCategoryPath'] = pathStr;
        update['details.attributes.kaufland_category_id'] = kaufId;
        update['details.attributes.kaufland_category_path'] = pathStr;
      }
    }

    if (Object.keys(update).length > 0) {
      const docRef = db.collection('products').doc(doc.id);
      batch.update(docRef, update);
      count += 1;
      updates += 1;
      if (count >= 400) {
        // Firestore batch limit is 500; keep some margin
        commit().catch((err) => {
          console.error('Commit failed:', err);
        });
      }
    }
  });

  await commit();
  console.log(`Updated products: ${updates}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

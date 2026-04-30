#!/usr/bin/env node
/**
 * Read-only Diagnose-Script für eBay-Listing-Fehler ("EAN fehlt", Catalog-Konflikt, …).
 *
 * Lädt das Produkt aus Firestore, durchläuft `mapProductToEbayItem` und baut das
 * tatsächliche Trading-API-XML. Druckt eine kompakte Diagnose mit den relevanten
 * Feldern (catalogMode, ean, itemSpecifics.EAN, ProductListingDetails-Block aus dem
 * XML). Damit lässt sich ohne Live-Publish exakt sehen, was eBay sehen würde.
 *
 * Aufruf:
 *   node backend/scripts/diagnose-ebay-listing.js --sku SKU-2772792498
 *   node backend/scripts/diagnose-ebay-listing.js --productId 2772792498
 *
 * Hinweis: nutzt produktive Firestore-Credentials (gleiche wie das Backend).
 * Schreibt nichts. Sicher in Produktion lauffähig.
 */

'use strict';

const path = require('path');

function parseArgs(argv) {
  const out = { sku: null, productId: null };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === '--sku' && v) { out.sku = v; i += 1; }
    else if (a === '--productId' && v) { out.productId = v; i += 1; }
  }
  return out;
}

function safe(value) {
  if (value === undefined) return '<undefined>';
  if (value === null) return '<null>';
  if (typeof value === 'string') return value === '' ? '<empty>' : value;
  return value;
}

function header(title) {
  console.log('');
  console.log('='.repeat(80));
  console.log(title);
  console.log('='.repeat(80));
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.sku && !args.productId) {
    console.error('USAGE: node backend/scripts/diagnose-ebay-listing.js --sku <SKU> [--productId <ID>]');
    process.exit(1);
  }

  // Load lazily so the script fails gracefully without GCP creds in early checks.
  const { firestore, getProduct, findProductByStrictIdentifier, PRODUCTS_COLLECTION } =
    require('../lib/firestore');
  const { mapProductToEbayItem } = require('../lib/ebay-direct');

  let product = null;
  if (args.productId) {
    product = await getProduct(args.productId);
  } else {
    product = await findProductByStrictIdentifier({ sku: args.sku });
  }
  if (!product) {
    console.error(`Produkt nicht gefunden: ${args.productId || args.sku}`);
    process.exit(2);
  }

  header(`Produkt aus Firestore: ${product.id}`);
  console.log(`Collection:                     ${PRODUCTS_COLLECTION}`);
  console.log(`SKU:                            ${safe(product?.identification?.sku || product?.sku)}`);
  console.log(`Name:                           ${safe(product?.identification?.name)}`);
  console.log(`Kategorie:                      ${safe(product?.identification?.category)}`);
  console.log(`details.categoryId:             ${safe(product?.details?.categoryId)}`);

  header('EAN/Identifier-Felder (Quellen)');
  console.log(`identification.barcodes:        ${JSON.stringify(product?.identification?.barcodes || [])}`);
  console.log(`details.identifiers.ean:        ${safe(product?.details?.identifiers?.ean)}`);
  console.log(`details.identifiers.gtin:       ${safe(product?.details?.identifiers?.gtin)}`);
  console.log(`details.identifiers.upc:        ${safe(product?.details?.identifiers?.upc)}`);
  console.log(`details.identifiers.mpn:        ${safe(product?.details?.identifiers?.mpn)}`);
  console.log(`details.attributes.EAN:         ${safe(product?.details?.attributes?.EAN)}`);
  console.log(`details.attributes.GTIN:        ${safe(product?.details?.attributes?.GTIN)}`);

  header('Catalog-Mode-Indikatoren');
  const skipFlag = product?.details?.skipEbayCatalogLookup === true;
  console.log(`details.skipEbayCatalogLookup:  ${skipFlag ? 'TRUE  ← Produkt wurde von Auto-Fix markiert' : safe(product?.details?.skipEbayCatalogLookup)}`);

  let item;
  try {
    item = mapProductToEbayItem(product, {});
  } catch (err) {
    console.error(`mapProductToEbayItem() failed: ${err?.message}`);
    process.exit(3);
  }

  header('Resultat: mapProductToEbayItem()');
  console.log(`item.catalogMode:               ${safe(item.catalogMode)}`);
  console.log(`item.skipProductListingDetails: ${item.skipProductListingDetails}`);
  console.log(`item.ean:                       ${safe(item.ean)}`);
  console.log(`item.isbn:                      ${safe(item.isbn)}`);
  console.log(`item.mpn:                       ${safe(item.mpn)}`);
  console.log(`item.brand:                     ${safe(item.brand)}`);
  console.log(`item.primaryCategoryId:         ${safe(item.primaryCategoryId)}`);
  console.log(`item.itemCompatibilityList:     ${item.itemCompatibilityList === null ? '<null>' : JSON.stringify(item.itemCompatibilityList).slice(0, 200)}`);

  header('Resultat: ItemSpecifics (eBay Artikelmerkmale, nach Filterung + Cap)');
  const eanLikeKeys = Object.keys(item.itemSpecifics || {}).filter((k) =>
    ['ean', 'gtin', 'upc', 'isbn', 'mpn'].includes(k.toLowerCase()),
  );
  if (eanLikeKeys.length === 0) {
    console.log('⚠️  KEIN EAN/GTIN/UPC/MPN-Artikelmerkmal in ItemSpecifics!');
  } else {
    eanLikeKeys.forEach((k) => {
      console.log(`  ${k}: ${JSON.stringify(item.itemSpecifics[k])}`);
    });
  }
  const allKeys = Object.keys(item.itemSpecifics || {});
  console.log(`(insgesamt ${allKeys.length} ItemSpecifics)`);

  // Build the actual XML so we can see exactly what eBay would see.
  let xmlSnippet = '<unavailable>';
  try {
    const { buildAddFixedPriceItemXml } = require('../lib/ebay-trading-api');
    if (typeof buildAddFixedPriceItemXml === 'function') {
      const fakeCfg = { userToken: 'DRY-RUN', compatibilityLevel: '1217' };
      const xml = buildAddFixedPriceItemXml(item, fakeCfg);
      // Extract just the ProductListingDetails fragment for readability.
      const pldMatch = xml.match(/<ProductListingDetails>[\s\S]*?<\/ProductListingDetails>/);
      const eanSpecificMatch = xml.match(
        /<NameValueList>\s*<Name>(?:EAN|GTIN|UPC)<\/Name>[\s\S]*?<\/NameValueList>/i,
      );
      xmlSnippet = '';
      xmlSnippet += pldMatch
        ? `\n  ${pldMatch[0]}`
        : '\n  ⚠️  KEIN <ProductListingDetails>-Block im XML — EAN wird in PLD nicht gesendet!';
      xmlSnippet += eanSpecificMatch
        ? `\n  ${eanSpecificMatch[0].replace(/\s+/g, ' ').trim()}`
        : '\n  (Kein EAN/GTIN/UPC als ItemSpecific im XML)';
    } else {
      xmlSnippet = '⚠️  buildAddFixedPriceItemXml ist NICHT exportiert — der laufende Backend-Code ist veraltet!';
    }
  } catch (err) {
    xmlSnippet = `Fehler beim XML-Build: ${err?.message}`;
  }

  header('Resultierendes Trading-API-XML (relevante Fragmente)');
  console.log(xmlSnippet);

  header('Diagnose');
  const eanExpected = item.ean;
  const eanInPld = (xmlSnippet || '').includes(`<EAN>${eanExpected}</EAN>`);
  const eanInSpecific = eanLikeKeys.length > 0;
  const pldOmitted = !(xmlSnippet || '').includes('<ProductListingDetails>');

  if (!eanExpected) {
    console.log('❌ KEINE EAN in item.ean aufgelöst.');
    console.log('   → Produkt-Daten prüfen: barcodes/identifiers/attributes-Werte sind alle leer ODER ungültige Prüfziffer.');
  } else if (pldOmitted) {
    console.log('❌ <ProductListingDetails>-Block fehlt komplett im XML.');
    console.log('   → catalogMode wahrscheinlich \'omit\' oder skipProductListingDetails=true.');
    console.log('   → Backend-Code ist veraltet (alte Auto-Fix-Logik). Cloud Run Deploy prüfen!');
  } else if (eanInPld && eanInSpecific) {
    console.log('✅ EAN ist sowohl in <ProductListingDetails><EAN> als auch in ItemSpecifics.');
    console.log('   → eBay sollte die "EAN fehlt"-Meldung NICHT mehr werfen.');
    console.log('   → Wenn doch: deploy-state prüfen (läuft Cloud Run schon mit dem neuen Code?).');
  } else if (eanInPld) {
    console.log('✅ EAN ist in <ProductListingDetails><EAN> vorhanden.');
    console.log('   → Aber FEHLT als ItemSpecific. Bei manchen Kategorien problematisch.');
  } else if (eanInSpecific) {
    console.log('✅ EAN ist in ItemSpecifics vorhanden, aber NICHT in PLD.');
    console.log('   → catalogMode=\'omit\'? Sollte auf identify-only.');
  } else {
    console.log('❌ EAN ist im finalen XML NIRGENDS — weder in PLD noch in ItemSpecifics.');
    console.log('   → eBay wirft "Das Feld EAN fehlt" zurecht. Bug-Hotspot.');
  }

  // Sentinel-Check: ist der laufende Code-Stand neu genug?
  const hasNewExports = (() => {
    try {
      const trading = require('../lib/ebay-trading-api');
      return typeof trading.buildAddFixedPriceItemXml === 'function';
    } catch {
      return false;
    }
  })();
  console.log('');
  console.log(`Sentinel: buildAddFixedPriceItemXml exportiert? ${hasNewExports ? 'JA' : 'NEIN — Code-Stand veraltet!'}`);
  console.log(`Sentinel: item.catalogMode definiert?           ${typeof item.catalogMode === 'string' ? 'JA' : 'NEIN — alte mapProductToEbayItem!'}`);

  process.exit(0);
}

main().catch((err) => {
  console.error('FATAL:', err?.stack || err?.message || err);
  process.exit(99);
});

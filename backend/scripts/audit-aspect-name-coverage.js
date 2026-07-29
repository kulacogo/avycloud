'use strict';
/**
 * audit-aspect-name-coverage.js — STRIKT READ-ONLY.
 *
 * Misst, wie viele der an eBay gesendeten Artikelmerkmale einen Namen tragen,
 * den eBay in der jeweiligen ZIELKATEGORIE ueberhaupt kennt. Nur bekannte Namen
 * erzeugen einen Filter in der eBay-Suchleiste — unbekannte Namen stehen zwar im
 * Angebot, sind aber fuer Suche/Ranking wertlos.
 *
 * Ausgabe:
 *   1. Abdeckung gesamt (bekannt / unbekannt) und je Kategorie (schlechteste zuerst)
 *   2. Top-Liste der unbekannten Merkmalsnamen mit Anzahl
 *   3. Wirkung der Synonymtabelle (data/ebay-aspect-synonyms.json):
 *      wie viel Prozent der unbekannten Vorkommen sie heilen wuerde
 *
 * Es wird NICHTS geschrieben: kein Firestore-Write, kein eBay-Call, keine Datei.
 *
 * Nutzung:
 *   node backend/scripts/audit-aspect-name-coverage.js
 *   node backend/scripts/audit-aspect-name-coverage.js --instock          # nur Bestand > 0
 *   node backend/scripts/audit-aspect-name-coverage.js --top 30
 *   node backend/scripts/audit-aspect-name-coverage.js --categories 20
 *   node backend/scripts/audit-aspect-name-coverage.js --tenant default
 *   node backend/scripts/audit-aspect-name-coverage.js --json             # Maschinen-Ausgabe
 *
 * WARNUNG: der Aspektkatalog (backend/ebay-data/aspects-full.json) ist ein
 * Snapshot. Vor Entscheidungen auf Basis dieses Audits das Snapshot-Datum unten
 * pruefen und ggf. scripts/sync-ebay-required-aspects-full.js laufen lassen.
 */

const path = require('path');
const fs = require('fs');
const { Firestore } = require('@google-cloud/firestore');
const { getCategoryAspectCatalog } = require('../lib/ebay-taxonomy');
const {
  normalizeAspectToken,
  buildCatalogNameIndex,
  buildSynonymIndex,
  getSynonymTable,
  IGNORED_TOKENS,
} = require('../lib/ebay-aspect-name-normalizer');

function argValue(flag, fallback) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx === process.argv.length - 1) return fallback;
  return process.argv[idx + 1];
}

const TENANT = argValue('--tenant', process.env.TENANT_ID || 'default');
const IN_STOCK_ONLY = process.argv.includes('--instock');
const AS_JSON = process.argv.includes('--json');
const TOP = Number.parseInt(argValue('--top', '25'), 10) || 25;
const TOP_CATEGORIES = Number.parseInt(argValue('--categories', '15'), 10) || 15;

function catalogMetaLine() {
  try {
    const metaPath = path.join(__dirname, '..', 'ebay-data', 'required-aspects-full-meta.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const days = meta.generatedAt
      ? Math.round((Date.now() - Date.parse(meta.generatedAt)) / 86400000)
      : null;
    return `Katalog-Snapshot: ${meta.generatedAt || 'unbekannt'} (${meta.marketplaceId || '?'}, ${
      meta.totalAspectEntries || '?'
    } Kategorien)${days !== null ? ` — ${days} Tage alt` : ''}`;
  } catch (_e) {
    return 'Katalog-Snapshot: unbekannt';
  }
}

function extractCategoryId(product) {
  const det = product && product.details ? product.details : {};
  const raw = det.categoryId || det.primaryCategoryId || product.primaryCategoryId || '';
  const str = String(raw || '').trim();
  return /^\d+$/.test(str) ? str : '';
}

function extractAttributes(product) {
  const det = product && product.details ? product.details : {};
  const attrs = det.attributes;
  if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs)) return {};
  return attrs;
}

const catalogCache = new Map();
function catalogIndexFor(categoryId) {
  if (catalogCache.has(categoryId)) return catalogCache.get(categoryId);
  let index = null;
  try {
    const catalog = getCategoryAspectCatalog(categoryId);
    const names = Array.isArray(catalog && catalog.aspects) && catalog.aspects.length
      ? catalog.aspects
      : (catalog && catalog.allAspects) || [];
    index = names.length ? buildCatalogNameIndex(names) : null;
  } catch (_e) {
    index = null;
  }
  catalogCache.set(categoryId, index);
  return index;
}

async function main() {
  const db = new Firestore();
  const snap = await db.collection('products_v2').where('tenantId', '==', TENANT).get();

  const synonymIndex = buildSynonymIndex(getSynonymTable());

  const stats = {
    tenant: TENANT,
    inStockOnly: IN_STOCK_ONLY,
    products: snap.size,
    productsScanned: 0,
    productsWithoutCategory: 0,
    productsWithoutCatalogEntry: 0,
    specifics: 0,
    known: 0,
    unknown: 0,
    healable: 0,
    ignored: 0,
  };

  const unknownByName = new Map(); // name -> { count, healableCount, targets:Map }
  const byCategory = new Map(); // categoryId -> { known, unknown, healable, products }

  snap.docs.forEach((doc) => {
    const product = doc.data() || {};
    const qty = Number((product.inventory && product.inventory.quantity) || 0);
    if (IN_STOCK_ONLY && !(qty > 0)) return;

    const categoryId = extractCategoryId(product);
    if (!categoryId) {
      stats.productsWithoutCategory += 1;
      return;
    }
    const index = catalogIndexFor(categoryId);
    if (!index) {
      stats.productsWithoutCatalogEntry += 1;
      return;
    }
    stats.productsScanned += 1;

    let cat = byCategory.get(categoryId);
    if (!cat) {
      cat = { known: 0, unknown: 0, healable: 0, products: 0 };
      byCategory.set(categoryId, cat);
    }
    cat.products += 1;

    Object.keys(extractAttributes(product)).forEach((rawName) => {
      const name = String(rawName || '');
      const token = normalizeAspectToken(name);
      if (!token || IGNORED_TOKENS.has(token)) {
        stats.ignored += 1;
        return;
      }
      stats.specifics += 1;
      if (index.has(token)) {
        stats.known += 1;
        cat.known += 1;
        return;
      }
      stats.unknown += 1;
      cat.unknown += 1;

      let rec = unknownByName.get(name);
      if (!rec) {
        rec = { count: 0, healableCount: 0, targets: new Map() };
        unknownByName.set(name, rec);
      }
      rec.count += 1;

      const targets = synonymIndex.get(token);
      if (!targets) return;
      for (const candidate of targets) {
        const candToken = normalizeAspectToken(candidate);
        if (candToken && index.has(candToken)) {
          const resolved = index.get(candToken);
          stats.healable += 1;
          cat.healable += 1;
          rec.healableCount += 1;
          rec.targets.set(resolved, (rec.targets.get(resolved) || 0) + 1);
          break;
        }
      }
    });
  });

  const pct = (a, b) => (b > 0 ? Number(((a / b) * 100).toFixed(1)) : 0);
  const topUnknown = [...unknownByName.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([name, rec]) => ({
      name,
      count: rec.count,
      healable: rec.healableCount,
      targets: [...rec.targets.entries()].sort((a, b) => b[1] - a[1]).map(([t, c]) => `${t} (${c})`),
    }));

  const worstCategories = [...byCategory.entries()]
    .map(([categoryId, c]) => ({
      categoryId,
      products: c.products,
      known: c.known,
      unknown: c.unknown,
      healable: c.healable,
      unknownPct: pct(c.unknown, c.known + c.unknown),
    }))
    .filter((c) => c.known + c.unknown >= 10)
    .sort((a, b) => b.unknown - a.unknown);

  const summary = {
    ...stats,
    unknownPct: pct(stats.unknown, stats.specifics),
    knownPct: pct(stats.known, stats.specifics),
    synonymHealPctOfUnknown: pct(stats.healable, stats.unknown),
    synonymHealPctOfAll: pct(stats.healable, stats.specifics),
    distinctUnknownNames: unknownByName.size,
    synonymEntries: synonymIndex.size,
  };

  if (AS_JSON) {
    console.log(JSON.stringify({ summary, topUnknown: topUnknown.slice(0, TOP), worstCategories: worstCategories.slice(0, TOP_CATEGORIES) }, null, 2));
    return;
  }

  console.log('=== Abdeckungs-Audit Merkmalsnamen (read-only) ===');
  console.log(catalogMetaLine());
  console.log(`Tenant: ${TENANT}${IN_STOCK_ONLY ? ' — nur Bestand > 0' : ''}`);
  console.log('');
  console.log(`Produkte gesamt:                 ${stats.products}`);
  console.log(`  davon ausgewertet:             ${stats.productsScanned}`);
  console.log(`  ohne eBay-Kategorie:           ${stats.productsWithoutCategory}`);
  console.log(`  Kategorie nicht im Katalog:    ${stats.productsWithoutCatalogEntry}`);
  console.log('');
  console.log(`Artikelmerkmale gesamt:          ${stats.specifics}`);
  console.log(`  im Katalog bekannt (Filter!):  ${stats.known} (${summary.knownPct} %)`);
  console.log(`  eBay unbekannt (kein Filter):  ${stats.unknown} (${summary.unknownPct} %)`);
  console.log(`  technisch ignoriert:           ${stats.ignored}`);
  console.log(`  verschiedene unbekannte Namen: ${unknownByName.size}`);
  console.log('');
  console.log(`Synonymtabelle (${synonymIndex.size} Eintraege) wuerde heilen:`);
  console.log(`  ${stats.healable} von ${stats.unknown} unbekannten Vorkommen = ${summary.synonymHealPctOfUnknown} % der unbekannten / ${summary.synonymHealPctOfAll} % aller Merkmale`);
  console.log('');
  console.log(`--- Top ${TOP} unbekannte Merkmalsnamen ---`);
  console.log('  #  Anzahl  heilbar  Name / Zielnamen');
  topUnknown.slice(0, TOP).forEach((u, i) => {
    const t = u.targets.length ? `  ->  ${u.targets.join(', ')}` : '';
    console.log(`${String(i + 1).padStart(3)}. ${String(u.count).padStart(6)}  ${String(u.healable).padStart(7)}  ${u.name}${t}`);
  });
  console.log('');
  console.log(`--- Kategorien mit den meisten unbekannten Merkmalen (min. 10 Merkmale) ---`);
  console.log('  Kategorie   Produkte  bekannt  unbekannt  unbek.%  heilbar');
  worstCategories.slice(0, TOP_CATEGORIES).forEach((c) => {
    console.log(
      `  ${c.categoryId.padEnd(10)}  ${String(c.products).padStart(8)}  ${String(c.known).padStart(7)}  ${String(c.unknown).padStart(9)}  ${String(c.unknownPct).padStart(6)}%  ${String(c.healable).padStart(7)}`
    );
  });
  console.log('');
  console.log('Hinweis: dieses Skript schreibt nichts. Der Normalisierer');
  console.log('(lib/ebay-aspect-name-normalizer.js) ist noch NICHT verdrahtet.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[audit-aspect-name-coverage] FEHLER:', err && err.message ? err.message : err);
    process.exit(1);
  });

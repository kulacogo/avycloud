#!/usr/bin/env node
/**
 * Operator-Skript: Regulatory-Block (GPSR Manufacturer + EUResponsiblePerson)
 * auf BESTEHENDE eBay-Listings nachschieben.
 *
 * Hintergrund (Audit 2026-07-16): eBay-Regulatory wurde bisher NUR beim
 * Publish gesendet — reviseListingFromProduct übergab gpsr/responsiblePerson
 * nicht, GPSR-Korrekturen erreichten bestehende Listings also NIE. Der
 * Laufzeit-Fix sitzt in lib/ebay-direct.js (reviseListingFromProduct-Patch);
 * dieses Skript schiebt den korrigierten Regulatory-Block für den BESTAND nach.
 *
 * Es werden AUSSCHLIESSLICH Produkte gepusht, deren GPSR-Daten den
 * Beleg-Status 'verified' tragen (details.gpsr.evidence.status, gesetzt vom
 * GPSR-Evidence-Audit auf Basis von lib/gpsr-evidence.js). Zusätzlich laufen
 * die PUREN Fake-Gates aus lib/gpsr-evidence.js als letzte Verteidigungslinie:
 * ein Datensatz, der looksLikeFakePhone/looksLikeSuspectEmail auslöst, wird
 * NIE gepusht (Skip + Report), egal was der Evidence-Status behauptet.
 *
 * Aufruf:
 *   # Dry-Run (default) — schreibt nichts zu eBay, Report nach /tmp:
 *   node backend/scripts/ebay-repush-regulatory.js
 *
 *   # Anderer Tenant:
 *   node backend/scripts/ebay-repush-regulatory.js --tenant trendocean
 *
 *   # Apply (Opt-in) — max 20 Revisen (Erstlauf-Sicherung):
 *   node backend/scripts/ebay-repush-regulatory.js --apply
 *
 *   # Apply ohne 20er-Cap (erst nach erfolgreichem Erstlauf!):
 *   node backend/scripts/ebay-repush-regulatory.js --apply --no-cap
 *
 *   # Kandidaten-Limit (wirkt auch im Dry-Run):
 *   node backend/scripts/ebay-repush-regulatory.js --limit 50
 *
 * Minimal-Patch-Garantie:
 *   - ReviseFixedPriceItem mit NUR { itemId, gpsr, responsiblePerson }.
 *   - buildReviseItemRequestXml emittiert dann ausschließlich <ItemID> +
 *     <Regulatory> — KEIN Titel, KEIN Preis, KEINE Menge, KEINE Bilder.
 *   - Ableitung EXAKT wie beim Publish (mapProductToEbayItem):
 *     gpsr = details.gpsr, responsiblePerson = buildResponsiblePersonFromGpsr
 *     + ENV-Fallback + Kontaktweg-Guard.
 *
 * HARTE GUARDS (CLAUDE.md Nicht-verhandelbar Punkt 14):
 *   - Dieses Skript importiert endItem/endFixedPriceItem NICHT und ruft sie
 *     NIE auf. Kein Fehlerpfad beendet, löscht oder deaktiviert ein Listing.
 *   - Fehler werden klassifikationsfrei GESAMMELT (Report) und der Lauf geht
 *     mit dem nächsten Kandidaten weiter.
 *   - Keine products_v2-Writes (rein lesend auf Firestore).
 *   - Rate-Limit: 1 Revise / 2 Sekunden.
 */

'use strict';

// Kanonische Collection ist products_v2 (Production: USE_PRODUCTS_V2=true).
// MUSS vor allen lib-Requires gesetzt sein.
process.env.USE_PRODUCTS_V2 = process.env.USE_PRODUCTS_V2 || 'true';

const fs = require('fs');
const path = require('path');

const { firestore, PRODUCTS_COLLECTION, getAllProductsForTenant } = require('../lib/firestore');
// Bewusst NUR reviseFixedPriceItem + buildRegulatoryXml — endItem/
// endFixedPriceItem werden absichtlich NICHT importiert (CLAUDE.md Punkt 14).
const { reviseFixedPriceItem, buildRegulatoryXml } = require('../lib/ebay-trading-api');
const { buildResponsiblePersonFromGpsr } = require('../lib/gpsr-eu-rep');
const { looksLikeFakePhone, looksLikeSuspectEmail } = require('../lib/gpsr-evidence');

const EBAY_LISTINGS_COLLECTION = 'ebayListingsLive';
const DEFAULT_APPLY_CAP = 20;
const REVISE_DELAY_MS = 2000;

function safeString(v) {
  return v == null ? '' : String(v).trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const out = {
    apply: false,
    noCap: false,
    tenantId: process.env.TENANT_ID || 'default',
    limit: null,
    outDir: '/tmp',
    idsFile: null,
    help: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--apply') out.apply = true;
    else if (t === '--no-cap') out.noCap = true;
    else if (t === '--tenant') { out.tenantId = argv[i + 1] || out.tenantId; i += 1; }
    else if (t === '--out') { out.outDir = argv[i + 1] || out.outDir; i += 1; }
    else if (t === '--ids-file') { out.idsFile = argv[i + 1] || null; i += 1; }
    else if (t === '--limit') {
      const n = Number(argv[i + 1]);
      if (Number.isFinite(n) && n > 0) out.limit = Math.floor(n);
      i += 1;
    } else if (t === '--help' || t === '-h') out.help = true;
  }
  return out;
}

function printHelp() {
  console.log(`ebay-repush-regulatory.js — GPSR-Regulatory-Block auf bestehende eBay-Listings nachschieben.

  Nur Produkte mit details.gpsr.evidence.status ∈ {'verified','product_image'}
  UND aktivem Listing in ${EBAY_LISTINGS_COLLECTION}. Minimal-Patch (nur
  Regulatory), nie EndItem.

  Optionen:
    --apply          Revisen wirklich senden (default: Dry-Run)
    --no-cap         20er-Cap im Apply-Lauf aufheben
    --tenant <id>    Tenant (default: TENANT_ID env oder 'default')
    --limit <n>      Max. Kandidaten verarbeiten (auch im Dry-Run)
    --ids-file <f>   Nur diese Produkt-Doc-IDs pushen (1 ID/Zeile)
    --out <dir>      Report-Verzeichnis (default: /tmp)
`);
}

/**
 * Regulatory-Ableitung EXAKT wie mapProductToEbayItem (lib/ebay-direct.js):
 * gpsr = details.gpsr; responsiblePerson = buildResponsiblePersonFromGpsr mit
 * ENV-Fallback; Include-Guard: companyName + mindestens ein Kontaktweg.
 * PURE — kein I/O.
 *
 * @returns {{ gpsr: object|undefined, responsiblePerson: object|undefined }}
 */
function deriveRegulatoryFromProduct(product) {
  const gpsr = product?.details?.gpsr || null;

  const envResponsibleFallback = {
    companyName: safeString(process.env.EBAY_RESPONSIBLE_PERSON_NAME) || undefined,
    street: safeString(process.env.EBAY_RESPONSIBLE_PERSON_STREET) || undefined,
    city: safeString(process.env.EBAY_RESPONSIBLE_PERSON_CITY) || undefined,
    postalCode: safeString(process.env.EBAY_RESPONSIBLE_PERSON_ZIP) || undefined,
    countryCode: safeString(process.env.EBAY_RESPONSIBLE_PERSON_COUNTRY) || undefined,
    phone: safeString(process.env.EBAY_RESPONSIBLE_PERSON_PHONE) || undefined,
    email: safeString(process.env.EBAY_RESPONSIBLE_PERSON_EMAIL) || undefined,
  };
  const fromProduct = buildResponsiblePersonFromGpsr(gpsr, envResponsibleFallback);
  const responsiblePerson = fromProduct || {
    companyName: envResponsibleFallback.companyName || 'TrendOcean',
    street: envResponsibleFallback.street,
    city: envResponsibleFallback.city,
    postalCode: envResponsibleFallback.postalCode,
    countryCode: envResponsibleFallback.countryCode || 'DE',
    phone: envResponsibleFallback.phone,
    email: envResponsibleFallback.email,
  };
  const hasResponsiblePerson = Boolean(
    responsiblePerson.companyName
      && (responsiblePerson.street || responsiblePerson.email || responsiblePerson.phone)
  );

  return {
    gpsr: gpsr || undefined,
    responsiblePerson: hasResponsiblePerson ? responsiblePerson : undefined,
  };
}

/**
 * Fake-Gates aus lib/gpsr-evidence.js als letzte Verteidigungslinie vor dem
 * Push: ein Datensatz mit erkennbarer Fake-Telefonnummer oder verdächtiger
 * E-Mail wird NIE zu eBay geschoben — egal was evidence.status behauptet.
 * PURE — kein I/O.
 *
 * @returns {string[]} Liste der ausgelösten Gates (leer = sauber)
 */
function fakeGateIssues(product) {
  const gpsr = product?.details?.gpsr || {};
  const issues = [];
  const phone = safeString(gpsr.manufacturer_phone) || safeString(gpsr.phone);
  if (phone && looksLikeFakePhone(phone)) issues.push(`fake_phone:${phone}`);
  const email = safeString(gpsr.email);
  if (email) {
    const check = looksLikeSuspectEmail(email, {
      manufacturerUrl: gpsr.url,
      brand: safeString(product?.identification?.brand) || safeString(gpsr.manufacturer_name),
    });
    if (check.suspect) issues.push(`suspect_email:${check.reason}:${email}`);
  }
  return issues;
}

async function loadActiveListing(itemId) {
  const snap = await firestore.collection(EBAY_LISTINGS_COLLECTION).doc(String(itemId)).get();
  if (!snap.exists) return null;
  return snap.data() || {};
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }

  const startedAt = new Date().toISOString();
  console.log(`[ebay-repush-regulatory] Modus=${args.apply ? 'APPLY' : 'DRY-RUN'} tenant=${args.tenantId} cap=${args.apply && !args.noCap ? DEFAULT_APPLY_CAP : 'aus'} limit=${args.limit ?? '-'}`);

  // Legacy-Compat: getAllProductsForTenant liefert (für 'default') auch Docs OHNE
  // tenantId-Feld — ein reiner where('tenantId'==...)-Filter würde die Mehrheit
  // des Bestands (und damit label-korrigierte Produkte) verpassen.
  let products = await getAllProductsForTenant(args.tenantId);
  console.log(`[ebay-repush-regulatory] ${products.length} Produkte geladen (${PRODUCTS_COLLECTION}, tenant=${args.tenantId})`);

  // Optionaler ID-Filter: nur die vom GPSR-Backfill als MATERIELL geänderten
  // Produkte anfassen (kein No-op-Revise auf unveränderte Listings).
  if (args.idsFile) {
    const wanted = new Set(
      fs.readFileSync(args.idsFile, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean),
    );
    const before = products.length;
    products = products.filter((p) => wanted.has(String(p.id)));
    console.log(`[ebay-repush-regulatory] --ids-file: ${wanted.size} IDs -> ${products.length}/${before} Produkte gefiltert`);
  }

  const skipped = [];
  const candidates = [];

  // SKU -> aktive itemId aus ebayListingsLive (die Wahrheit über aktive
  // Angebote). ops.ebay.itemId wird nur vom stock-sync-dispatcher befüllt und
  // ist für den Bestand oft leer — die SKU-Auflösung ist der robuste Weg.
  const skuToItemId = new Map();
  const liveSnap = await firestore.collection(EBAY_LISTINGS_COLLECTION).get();
  liveSnap.forEach((d) => {
    const x = d.data() || {};
    if (x.active === true && x.sku) skuToItemId.set(String(x.sku), d.id);
  });
  console.log(`[ebay-repush-regulatory] ${skuToItemId.size} aktive Listings per SKU aus ${EBAY_LISTINGS_COLLECTION} indiziert`);

  // Deterministische Reihenfolge — der gecappte Erstlauf ist reproduzierbar.
  products.sort((a, b) => String(a.id).localeCompare(String(b.id)));

  for (const product of products) {
    const sku = safeString(product?.identification?.sku) || null;
    const itemId = safeString(product?.ops?.ebay?.itemId) || (sku ? safeString(skuToItemId.get(sku)) : '');
    if (!itemId) continue; // kein aktives eBay-Listing — kein Report-Rauschen

    const gpsr = product?.details?.gpsr;
    if (!gpsr || typeof gpsr !== 'object') {
      skipped.push({ productId: product.id, sku, itemId, reason: 'no_gpsr_data' });
      continue;
    }
    const evidenceStatus = safeString(gpsr?.evidence?.status);
    // 'verified' = GPSR-Evidence-Audit (Web-Beleg). 'product_image' = physisches
    // Verpackungs-Etikett (lib/gpsr-image-extract.js) — die autoritativste Quelle
    // überhaupt. Beide sind belegt und pushbar; alles andere wird geskippt.
    if (evidenceStatus !== 'verified' && evidenceStatus !== 'product_image') {
      skipped.push({ productId: product.id, sku, itemId, reason: 'not_pushable_evidence', evidenceStatus: evidenceStatus || null });
      continue;
    }

    const gateIssues = fakeGateIssues(product);
    if (gateIssues.length) {
      skipped.push({ productId: product.id, sku, itemId, reason: 'fake_gate', issues: gateIssues });
      continue;
    }

    const { gpsr: gpsrOut, responsiblePerson } = deriveRegulatoryFromProduct(product);
    // Ohne emittierbaren Regulatory-Block würde buildReviseItemRequestXml mit
    // EBAY_REVISE_FIELDS_MISSING werfen — vorab prüfen und sauber skippen.
    const regulatoryXml = buildRegulatoryXml({ gpsr: gpsrOut, responsiblePerson });
    if (!regulatoryXml) {
      skipped.push({ productId: product.id, sku, itemId, reason: 'no_regulatory_payload' });
      continue;
    }

    candidates.push({ product, sku, itemId, gpsr: gpsrOut, responsiblePerson });
    if (args.limit && candidates.length >= args.limit) break;
  }

  console.log(`[ebay-repush-regulatory] ${candidates.length} Kandidaten (verified + Regulatory-Payload), ${skipped.length} geskippt`);

  const results = [];
  const errors = [];
  let revised = 0;
  let wouldRevise = 0;
  const applyCap = args.apply && !args.noCap ? DEFAULT_APPLY_CAP : Infinity;

  for (const cand of candidates) {
    // Aktives Listing ist Pflicht — beendete/unbekannte Listings nicht anfassen.
    let listing;
    try {
      listing = await loadActiveListing(cand.itemId);
    } catch (err) {
      errors.push({ productId: cand.product.id, sku: cand.sku, itemId: cand.itemId, stage: 'listing_lookup', error: err?.message || String(err) });
      continue;
    }
    if (!listing || listing.active !== true) {
      skipped.push({ productId: cand.product.id, sku: cand.sku, itemId: cand.itemId, reason: 'no_active_listing' });
      continue;
    }
    // Nur Festpreis — ReviseFixedPriceItem passt nicht auf Auktionsformate.
    const listingType = safeString(listing.listingType);
    if (listingType && /chinese|auction/i.test(listingType)) {
      skipped.push({ productId: cand.product.id, sku: cand.sku, itemId: cand.itemId, reason: 'not_fixed_price', listingType });
      continue;
    }

    if (!args.apply) {
      wouldRevise += 1;
      results.push({
        productId: cand.product.id,
        sku: cand.sku,
        itemId: cand.itemId,
        action: 'would_revise',
        manufacturer: safeString(cand.gpsr?.manufacturer_name) || null,
        responsiblePerson: cand.responsiblePerson?.companyName || null,
      });
      continue;
    }

    if (revised >= applyCap) {
      skipped.push({ productId: cand.product.id, sku: cand.sku, itemId: cand.itemId, reason: 'apply_cap_reached', cap: DEFAULT_APPLY_CAP });
      continue;
    }

    // Rate-Limit: 1 Revise / 2s.
    if (revised > 0) await sleep(REVISE_DELAY_MS);

    try {
      // Minimal-Patch: NUR itemId + Regulatory-Quellfelder. buildReviseItemRequestXml
      // emittiert daraus ausschließlich <ItemID> + <Regulatory> — Titel/Preis/
      // Menge/Bilder bleiben unangetastet.
      const response = await reviseFixedPriceItem({
        itemId: cand.itemId,
        gpsr: cand.gpsr,
        responsiblePerson: cand.responsiblePerson,
      });
      revised += 1;
      results.push({
        productId: cand.product.id,
        sku: cand.sku,
        itemId: cand.itemId,
        action: 'revised',
        ack: response?.ack || null,
        manufacturer: safeString(cand.gpsr?.manufacturer_name) || null,
        responsiblePerson: cand.responsiblePerson?.companyName || null,
      });
      console.log(`[ebay-repush-regulatory] OK itemId=${cand.itemId} sku=${cand.sku || '-'} ack=${response?.ack || '?'} (${revised}${Number.isFinite(applyCap) ? `/${applyCap}` : ''})`);
    } catch (err) {
      // GUARD (CLAUDE.md Punkt 14): NIE EndItem, NIE deaktivieren — Fehler nur
      // sammeln und weitermachen. Das Listing bleibt unverändert auf eBay.
      errors.push({ productId: cand.product.id, sku: cand.sku, itemId: cand.itemId, stage: 'revise', error: err?.message || String(err), code: err?.code || null });
      console.warn(`[ebay-repush-regulatory] FEHLER itemId=${cand.itemId} sku=${cand.sku || '-'}: ${err?.message}`);
    }
  }

  const skippedByReason = {};
  for (const s of skipped) skippedByReason[s.reason] = (skippedByReason[s.reason] || 0) + 1;

  const report = {
    script: 'ebay-repush-regulatory',
    mode: args.apply ? 'apply' : 'dry-run',
    tenantId: args.tenantId,
    startedAt,
    finishedAt: new Date().toISOString(),
    params: { limit: args.limit, noCap: args.noCap, applyCap: Number.isFinite(applyCap) ? applyCap : null },
    counts: {
      productsTotal: products.length,
      candidates: candidates.length,
      revised,
      wouldRevise,
      failed: errors.length,
      skipped: skipped.length,
      skippedByReason,
    },
    results,
    errors,
    skipped,
  };

  const outFile = path.join(args.outDir, `ebay-repush-regulatory-${startedAt.replace(/[:.]/g, '-')}.json`);
  try {
    fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
    console.log(`[ebay-repush-regulatory] Report: ${outFile}`);
  } catch (err) {
    console.warn(`[ebay-repush-regulatory] Report-Write fehlgeschlagen: ${err?.message}`);
  }

  console.log(`[ebay-repush-regulatory] Fertig — ${args.apply ? `revised=${revised}` : `would_revise=${wouldRevise}`} failed=${errors.length} skipped=${skipped.length} (${Object.entries(skippedByReason).map(([k, v]) => `${k}=${v}`).join(', ') || '-'})`);
  if (args.apply && !args.noCap && revised >= DEFAULT_APPLY_CAP) {
    console.log(`[ebay-repush-regulatory] Cap von ${DEFAULT_APPLY_CAP} erreicht. Nach Prüfung des Reports: erneut mit --apply --no-cap laufen lassen.`);
  }
  if (errors.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`[ebay-repush-regulatory] Abbruch: ${err?.message}`, err);
  process.exitCode = 1;
});

#!/usr/bin/env node
/**
 * Bestand-Audit: GPSR-/Hersteller-Daten gegen echte Belege pruefen.
 *
 * Hintergrund (Audit 2026-07-16): 1353 von 1600 Produkten tragen "volle"
 * GPSR-Daten, aber KEIN einziges hat Beleg-Metadaten. Stichproben zeigen
 * Halluzinationen (okopp@apple.com als Apple-Kontakt, Telefon-Platzhalter
 * "+496105456789"). Die Laufzeit-Verifikation sitzt in lib/gpsr-evidence.js;
 * dieses Script prueft die BESTANDSDATEN brand-gruppiert und stempelt bei
 * --apply Beleg-Metadaten + bereinigt eindeutige Fake-Kontakte.
 *
 * Verifikation pro Marke via lib/gpsr-evidence.js getOrVerifyBrandGpsr():
 *   verified      — Name + Adresse auf einer Hersteller-Seite belegt
 *   partial       — nur der Name belegt
 *   unverifiable  — Seiten geladen (oder 404/410), Beleg nicht gefunden
 *   infra_blocked — Abrufe scheiterten an Infrastruktur → ehrlich "konnten
 *                   nicht pruefen"; wird NIE gestempelt und NIE gecacht
 *   no_gpsr_data  — kein Produkt der Marke hat einen manufacturer_name
 *
 * Aufruf (read-only Audit ist der Default, schreibt NIE):
 *   # Nur Marken mit aktiven eBay-/Kaufland-Listings (dringendster Scope):
 *   node backend/scripts/audit-gpsr-evidence.js --live-only
 *
 *   # Nur Produkte mit Bestand (inventory.quantity > 0):
 *   node backend/scripts/audit-gpsr-evidence.js --sellable
 *
 *   # Alle Produkte:
 *   node backend/scripts/audit-gpsr-evidence.js --all
 *
 *   # Einzelmarke (impliziert --all-Scope fuer diese Marke):
 *   node backend/scripts/audit-gpsr-evidence.js --brand "Bosch"
 *
 *   # Nur die ersten N Marken (nach Live-/Produktzahl absteigend):
 *   node backend/scripts/audit-gpsr-evidence.js --live-only --limit 25
 *
 *   # Apply (Opt-in, Confirm-Token Pflicht):
 *   node backend/scripts/audit-gpsr-evidence.js --live-only --apply --confirm GPSR_EVIDENCE_AUDIT_V1
 *
 * Apply-Verhalten pro Produkt der Marke (Schreiben NUR via saveProductV2,
 * source:'gpsr-evidence-audit', skipStockEvent:true):
 *   (a) details.gpsr.evidence = { status, url, checked_at } — Beleg-Status der
 *       Marken-Verifikation. NICHT bei infra_blocked/no_gpsr_data (nichts
 *       festgestellt → nichts stempeln, naechster Lauf prueft erneut).
 *   (b) Eindeutige Fake-Kontakte laut lib/gpsr-evidence (looksLikeFakePhone /
 *       looksLikeSuspectEmail) werden auf NULL gesetzt und im Report
 *       ausgewiesen. Post-Save-Read prueft, ob die Nullung den Save-Boundary
 *       (gpsrRegistryEnforce-Amplifikator) ueberlebt hat → Report-Feld
 *       nullSurvived.
 *   (c) Namen/Adressen werden NIEMALS automatisch ersetzt — nur Beleg-Status
 *       + Fake-Bereinigung. Ersatz waere ein neues Halluzinations-Risiko.
 *   (d) unverifiable → ops.data_quality.gpsr_evidence='unverifiable' Marker
 *       (Operator-Liste). Ein bereits gesetzter, veralteter Marker wird bei
 *       verified/partial auf den neuen Status geheilt.
 *
 * Sicherheits-Mechanismen (Muster: scripts/repair-price-evidence.js):
 *   - Default read-only; --apply nur mit --confirm GPSR_EVIDENCE_AUDIT_V1.
 *   - Rate-Limit: max 2 Seiten-Abrufe/Sekunde (Firestore-Cache der Lib
 *     TTL 30d greift automatisch, infra_blocked wird nie gecacht).
 *   - Frischer Doc-Read direkt vor jeder Mutation; idempotent (gleicher
 *     Beleg-Status + keine Fakes → skipped_already_stamped).
 *   - Save mit allowWarehouseFields:false → Bestand wird NIE angefasst.
 *   - Einzelmarken-Fehler werden gefangen und geloggt — Report bleibt
 *     vollstaendig.
 *   - JSON-Report immer nach /tmp (bzw. --out <dir>).
 */

'use strict';

// Kanonische Collection ist products_v2 (Production: USE_PRODUCTS_V2=true).
// MUSS vor allen lib-Requires gesetzt sein, sonst zielen get/saveProductV2
// auf die Legacy-Collection `products`.
process.env.USE_PRODUCTS_V2 = process.env.USE_PRODUCTS_V2 || 'true';

const fs = require('fs');
const path = require('path');
// Alle Module-Level-Requires hier sind ohne Firestore-Client-Instanziierung
// (gpsr-evidence lazy-lädt Firestore erst beim Cache-Zugriff) — der Require
// dieses Scripts in Tests bleibt damit I/O-frei.
const {
  getOrVerifyBrandGpsr,
  looksLikeFakePhone,
  looksLikeSuspectEmail,
  brandCacheKey,
} = require('../lib/gpsr-evidence');
const { fetchPageForVerification } = require('../lib/price-evidence');
const { isRetiredKauflandUnit } = require('../lib/kaufland-unit-status');

const CONFIRM_TOKEN = 'GPSR_EVIDENCE_AUDIT_V1';
const MAX_FETCHES_PER_SECOND = 2;
const BRAND_OUTPUT_CAP = 60;
const FAKE_FINDINGS_PER_BRAND_CAP = 20;

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {
    mode: null, // 'live-only' | 'sellable' | 'all'
    brand: null,
    limit: null,
    apply: false,
    confirm: null,
    tenantId: process.env.TENANT_ID || 'default',
    outDir: '/tmp',
    noCache: false,
    help: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--live-only') out.mode = 'live-only';
    else if (t === '--sellable') out.mode = 'sellable';
    else if (t === '--all') out.mode = 'all';
    else if (t === '--brand') { out.brand = argv[i + 1] || null; i += 1; }
    else if (t === '--limit') {
      const n = Number(argv[i + 1]);
      if (Number.isFinite(n) && n > 0) out.limit = Math.floor(n);
      i += 1;
    } else if (t === '--apply') out.apply = true;
    else if (t === '--confirm') { out.confirm = argv[i + 1] || null; i += 1; }
    else if (t === '--tenant') { out.tenantId = argv[i + 1] || out.tenantId; i += 1; }
    else if (t === '--out') { out.outDir = argv[i + 1] || out.outDir; i += 1; }
    else if (t === '--no-cache') out.noCache = true;
    else if (t === '--help' || t === '-h') out.help = true;
  }
  // --brand ohne expliziten Modus: alle Produkte dieser Marke.
  if (!out.mode && out.brand) out.mode = 'all';
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure Helpers (exportiert fuer Tests)
// ─────────────────────────────────────────────────────────────────────────────

function pickBrand(data) {
  return safeString(data?.identification?.brand) || safeString(data?.details?.brand) || '';
}

function productSku(data) {
  return safeString(data?.identification?.sku) || safeString(data?.details?.identifiers?.sku) || '';
}

function productEan(data) {
  return safeString(data?.identification?.ean) || safeString(data?.details?.identifiers?.ean) || '';
}

function pickGpsrObj(data) {
  const g = data?.details?.gpsr;
  return g && typeof g === 'object' && !Array.isArray(g) ? g : {};
}

/**
 * Live-SKU-/EAN-Sets aus den Marktplatz-Spiegel-Docs. PURE — nimmt bereits
 * geladene Doc-Daten. Kaufland-Tombstones (STALE/NOT_FOUND) zaehlen NIE als
 * live (lib/kaufland-unit-status.js, Incident 2026-07-09).
 *
 * @param {Array<object>} ebayDocs     ebayListingsLive-Docs (active==true vorgefiltert)
 * @param {Array<object>} kauflandDocs kauflandUnitsLive-Docs (active==true vorgefiltert)
 * @returns {{ skus: Set<string>, eans: Set<string> }}
 */
function buildLiveSets(ebayDocs, kauflandDocs) {
  const skus = new Set();
  const eans = new Set();
  for (const d of Array.isArray(ebayDocs) ? ebayDocs : []) {
    if (!d || d.active !== true) continue;
    const sku = safeString(d.sku);
    if (sku) skus.add(sku);
  }
  for (const d of Array.isArray(kauflandDocs) ? kauflandDocs : []) {
    if (!d || d.active !== true) continue;
    if (isRetiredKauflandUnit(d)) continue;
    const sku = safeString(d.id_offer);
    if (sku) skus.add(sku);
    const ean = safeString(d.ean);
    if (ean) eans.add(ean);
  }
  return { skus, eans };
}

function isLiveProduct(data, liveSets) {
  if (!liveSets) return false;
  const sku = productSku(data);
  if (sku && liveSets.skus.has(sku)) return true;
  const ean = productEan(data);
  return !!(ean && liveSets.eans.has(ean));
}

function isSellableProduct(data) {
  return (Number(data?.inventory?.quantity) || 0) > 0;
}

const GPSR_SCORE_WEIGHTS = [
  ['manufacturer_name', 4],
  ['manufacturer_address', 3],
  ['url', 3],
  ['manufacturer_postalcode', 1],
  ['manufacturer_city', 1],
  ['email', 1],
  ['manufacturer_phone', 1],
  ['phone', 1],
  ['entity_country', 1],
];

/** Vollstaendigkeits-Score eines GPSR-Records. PURE. */
function gpsrCompletenessScore(gpsr) {
  const g = gpsr && typeof gpsr === 'object' ? gpsr : {};
  let score = 0;
  for (const [key, weight] of GPSR_SCORE_WEIGHTS) {
    if (safeString(g[key])) score += weight;
  }
  return score;
}

/**
 * Repraesentativstes GPSR einer Marke: der VOLLSTAENDIGSTE Record mit
 * manufacturer_name. PURE.
 *
 * @param {Array<{sku:string, gpsr:object}>} entries
 * @returns {null|{ gpsr: object, sku: string, score: number }}
 */
function pickRepresentativeGpsr(entries) {
  let best = null;
  for (const e of Array.isArray(entries) ? entries : []) {
    const g = e && e.gpsr && typeof e.gpsr === 'object' ? e.gpsr : null;
    if (!g || !safeString(g.manufacturer_name)) continue;
    const score = gpsrCompletenessScore(g);
    if (!best || score > best.score) best = { gpsr: g, sku: safeString(e.sku), score };
  }
  return best;
}

/**
 * Kern-Signatur (Name + Adresse) zum Divergenz-Vergleich Produkt ↔
 * repraesentativer Record. PURE. Diakritik-/Interpunktions-tolerant.
 */
function gpsrCoreKey(gpsr) {
  const g = gpsr && typeof gpsr === 'object' ? gpsr : {};
  const norm = (s) => safeString(s)
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return `${norm(g.manufacturer_name)}|${norm(g.manufacturer_address)}`;
}

/**
 * Eindeutige Fake-Kontakte eines GPSR-Records laut lib/gpsr-evidence:
 * fake phone (beide Keys manufacturer_phone/phone) + suspect email.
 * PURE — kein I/O, konservativ (nur eindeutige Faelle).
 *
 * @param {object} gpsr
 * @param {{ brand?: string, fallbackUrl?: string }} [ctx]
 * @returns {Array<{ field: string, value: string, reason: string }>}
 */
function findFakeContacts(gpsr, ctx = {}) {
  const g = gpsr && typeof gpsr === 'object' ? gpsr : {};
  const findings = [];
  for (const key of ['manufacturer_phone', 'phone']) {
    const val = safeString(g[key]);
    if (val && looksLikeFakePhone(val)) {
      findings.push({ field: key, value: val, reason: 'fake_phone_pattern' });
    }
  }
  const email = safeString(g.email);
  if (email) {
    const check = looksLikeSuspectEmail(email, {
      manufacturerUrl: safeString(g.url) || safeString(ctx.fallbackUrl) || undefined,
      brand: ctx.brand,
    });
    if (check.suspect) {
      findings.push({ field: 'email', value: email, reason: `suspect_email:${check.reason}` });
    }
  }
  return findings;
}

/**
 * Baut die Apply-Aenderung fuer EIN Produkt aus dem Marken-Verdict. PURE —
 * mutiert die Eingabe nicht.
 *
 * Regeln:
 *   - Fake-Kontakte (Lib-Gates) → Feld null. Laeuft IMMER, auch wenn kein
 *     Beleg-Status gestempelt wird (Gates sind netz-unabhaengig).
 *   - stampEvidence=true → details.gpsr.evidence={status,url,checked_at};
 *     idempotent: gleicher status+url wie vorhanden → kein Re-Write.
 *   - status unverifiable → ops.data_quality.gpsr_evidence='unverifiable';
 *     ein VORHANDENER, abweichender Marker wird bei verified/partial auf den
 *     neuen Status geheilt (sonst bliebe ein verifizierter Bestand fuer immer
 *     auf der Operator-Liste). Namen/Adressen werden NIE ersetzt.
 *
 * @param {object} data Produkt-Doc-Daten (frisch gelesen)
 * @param {{ status: string, evidenceUrl: string|null, checkedAt: string,
 *   brand?: string, fallbackUrl?: string, stampEvidence: boolean }} verdict
 * @returns {{ changed: boolean, gpsr: object, nulled: Array, evidenceSet: boolean,
 *   markerSet: boolean, nextMarker: string|undefined }}
 */
// Nur EINDEUTIGE Fake-Klassen werden hart gelöscht. 'foreign_domain' erzeugt
// False-Positives bei legitimen Vertriebs-/Konzern-Kontakten (Live-Beispiele:
// info@sct-germany.de für MANNOL — SCT ist der Mutterkonzern; Imoshion↔
// smartphonehoesjes.nl) — solche Funde bleiben Report-only.
const HARD_FAKE_REASONS = new Set([
  'fake_phone_pattern',
  'suspect_email:personal_freemail',
]);

function buildProductApply(data, verdict) {
  const gpsr = JSON.parse(JSON.stringify(pickGpsrObj(data)));
  let changed = false;
  const nulled = [];

  for (const finding of findFakeContacts(gpsr, { brand: verdict.brand, fallbackUrl: verdict.fallbackUrl })) {
    if (!HARD_FAKE_REASONS.has(finding.reason)) continue; // Report-only-Klasse
    gpsr[finding.field] = null;
    nulled.push(finding);
    changed = true;
  }

  let evidenceSet = false;
  if (verdict.stampEvidence) {
    const prev = gpsr.evidence && typeof gpsr.evidence === 'object' ? gpsr.evidence : null;
    const nextUrl = verdict.evidenceUrl || null;
    const same = !!prev && prev.status === verdict.status && (prev.url || null) === nextUrl;
    if (!same) {
      gpsr.evidence = { status: verdict.status, url: nextUrl, checked_at: verdict.checkedAt };
      evidenceSet = true;
      changed = true;
    }
  }

  let markerSet = false;
  let nextMarker;
  const prevMarker = data?.ops?.data_quality?.gpsr_evidence;
  if (verdict.status === 'unverifiable') {
    if (prevMarker !== 'unverifiable') { nextMarker = 'unverifiable'; markerSet = true; changed = true; }
  } else if (verdict.stampEvidence && prevMarker != null && prevMarker !== verdict.status) {
    nextMarker = verdict.status;
    markerSet = true;
    changed = true;
  }

  return { changed, gpsr, nulled, evidenceSet, markerSet, nextMarker };
}

/**
 * Rate-Limiter um einen Seiten-Fetcher: reserviert Zeit-Slots, max
 * `perSecond` Abrufe/Sekunde — auch bei parallelen Aufrufen. Cache-Hits der
 * Lib erreichen den Fetcher nie und bleiben ungebremst.
 */
function makeRateLimitedFetch(baseFetch, perSecond = MAX_FETCHES_PER_SECOND) {
  const minIntervalMs = Math.ceil(1000 / Math.max(1, perSecond));
  let nextSlotAt = 0;
  return async (url, opts) => {
    const now = Date.now();
    const waitMs = nextSlotAt - now;
    nextSlotAt = Math.max(now, nextSlotAt) + minIntervalMs;
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    return baseFetch(url, opts);
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Firestore-Zugriff (nur in main-Pfaden — Module-Export bleibt I/O-frei)
// ─────────────────────────────────────────────────────────────────────────────

async function loadProjectedProducts(firestore, collectionName, tenantId) {
  // Projektion haelt den Scan billig. Regel 8: Queries mit tenantId — fuer
  // 'default' geht das NICHT als where-Klausel (Bestands-Docs tragen kein
  // tenantId-Feld, D.0b-Realitaet) → in-memory filtern.
  let ref = firestore.collection(collectionName);
  if (tenantId !== 'default') ref = ref.where('tenantId', '==', tenantId);
  ref = ref.select(
    'identification.sku',
    'identification.ean',
    'identification.brand',
    'details.brand',
    'details.identifiers.sku',
    'details.identifiers.ean',
    'details.gpsr',
    'inventory.quantity',
    'tenantId'
  );
  const snap = await ref.get();
  const docs = [];
  snap.forEach((d) => {
    const data = d.data() || {};
    if (tenantId === 'default' && data.tenantId && data.tenantId !== 'default') return;
    docs.push({ id: d.id, data });
  });
  return docs;
}

async function loadLiveSets(firestore) {
  const [ebaySnap, kauflandSnap] = await Promise.all([
    firestore.collection('ebayListingsLive').where('active', '==', true).select('sku', 'active').get(),
    firestore.collection('kauflandUnitsLive').where('active', '==', true)
      .select('id_offer', 'ean', 'status', 'active').get(),
  ]);
  return buildLiveSets(
    ebaySnap.docs.map((d) => d.data() || {}),
    kauflandSnap.docs.map((d) => d.data() || {})
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(fs.readFileSync(__filename, 'utf-8').split('\n').slice(0, 66).join('\n'));
    return;
  }
  if (!args.mode) {
    throw new Error('Scope waehlen: --live-only | --sellable | --all (oder --brand "X"). Siehe --help.');
  }
  if (args.apply && args.confirm !== CONFIRM_TOKEN) {
    throw new Error(`--apply braucht --confirm ${CONFIRM_TOKEN}`);
  }
  if (process.env.USE_PRODUCTS_V2 !== 'true') {
    throw new Error('USE_PRODUCTS_V2=true erforderlich (wie Production) — sonst liest/schreibt das Script die Legacy-Collection.');
  }

  // Lazy requires: erst NACH dem ENV-Setup, und nur wenn main() laeuft.
  const { firestore } = require('../lib/firestore');
  const { saveProductV2, getCollection } = require('../lib/product-store');
  const collectionName = getCollection(); // 'products_v2' bei USE_PRODUCTS_V2=true

  const startedAt = new Date().toISOString();
  const report = {
    script: 'audit-gpsr-evidence',
    confirmToken: CONFIRM_TOKEN,
    startedAt,
    action: args.apply ? 'apply' : 'audit',
    mode: args.mode,
    brandFilter: args.brand || null,
    tenantId: args.tenantId,
    limit: args.limit,
    summary: {
      productsScanned: 0,
      productsWithoutBrand: 0,
      productsInScope: 0,
      liveProductsInScope: 0,
      brandsInScope: 0,
      brandsVerified: 0,
      cacheHits: 0,
      byStatus: { verified: 0, partial: 0, unverifiable: 0, infra_blocked: 0, no_gpsr_data: 0 },
      productsByStatus: { verified: 0, partial: 0, unverifiable: 0, infra_blocked: 0, no_gpsr_data: 0 },
      fakeContactFindings: 0,
      productsWithFakeContacts: 0,
    },
    brands: [],
    actions: [],
    errors: [],
  };

  console.error(`[audit-gpsr-evidence] starte (action=${report.action} mode=${args.mode}) tenant=${args.tenantId} collection=${collectionName}`);

  // ── Scope aufbauen ──────────────────────────────────────────────────────────
  const liveSets = await loadLiveSets(firestore);
  console.error(`[audit-gpsr-evidence] live: ${liveSets.skus.size} SKUs + ${liveSets.eans.size} EANs (eBay aktiv + Kaufland aktiv ohne Tombstones)`);

  const allDocs = await loadProjectedProducts(firestore, collectionName, args.tenantId);
  report.summary.productsScanned = allDocs.length;

  const brandFilterKey = args.brand ? brandCacheKey(args.brand) : '';
  const byBrand = new Map(); // brandKey -> { brand, products: [] }

  for (const { id, data } of allDocs) {
    const brand = pickBrand(data);
    if (!brand) {
      report.summary.productsWithoutBrand += 1;
      continue;
    }
    const key = brandCacheKey(brand);
    if (!key) {
      report.summary.productsWithoutBrand += 1;
      continue;
    }
    if (brandFilterKey && key !== brandFilterKey) continue;

    const live = isLiveProduct(data, liveSets);
    const sellable = isSellableProduct(data);
    if (args.mode === 'live-only' && !live) continue;
    if (args.mode === 'sellable' && !sellable) continue;

    const entry = byBrand.get(key) || { brand, key, products: [] };
    if (!entry.brand) entry.brand = brand;
    entry.products.push({ id, sku: productSku(data), gpsr: pickGpsrObj(data), live, sellable });
    byBrand.set(key, entry);
    report.summary.productsInScope += 1;
    if (live) report.summary.liveProductsInScope += 1;
  }

  report.summary.brandsInScope = byBrand.size;

  // Deterministische Reihenfolge: dringendste Marken zuerst (live, dann groesste).
  const brandEntries = [...byBrand.values()].sort((a, b) => {
    const liveA = a.products.filter((p) => p.live).length;
    const liveB = b.products.filter((p) => p.live).length;
    if (liveB !== liveA) return liveB - liveA;
    if (b.products.length !== a.products.length) return b.products.length - a.products.length;
    return a.key < b.key ? -1 : 1;
  });
  const targets = args.limit ? brandEntries.slice(0, args.limit) : brandEntries;

  console.error(`[audit-gpsr-evidence] Scope: ${report.summary.productsInScope} Produkte in ${byBrand.size} Marken — verifiziere ${targets.length} Marken (limit=${args.limit || 'kein'})`);

  const rateLimitedFetch = makeRateLimitedFetch(fetchPageForVerification, MAX_FETCHES_PER_SECOND);

  // ── Pro Marke: verifizieren + Fake-Gates ────────────────────────────────────
  for (const entry of targets) {
    try {
      const representative = pickRepresentativeGpsr(entry.products);
      let verdict;
      if (!representative) {
        verdict = { status: 'no_gpsr_data', evidence: null, issues: ['no_manufacturer_name_on_any_product'], cached: false };
      } else {
        verdict = await getOrVerifyBrandGpsr({
          brand: entry.brand,
          gpsr: representative.gpsr,
          fetchImpl: rateLimitedFetch,
          useCache: !args.noCache,
        });
        if (!verdict) verdict = { status: 'unverifiable', evidence: null, issues: ['verify_returned_null'], cached: false };
      }

      const repCore = representative ? gpsrCoreKey(representative.gpsr) : null;
      const fallbackUrl = representative ? safeString(representative.gpsr.url) : '';
      const fakeFindings = [];
      let divergentProducts = 0;
      for (const p of entry.products) {
        const findings = findFakeContacts(p.gpsr, { brand: entry.brand, fallbackUrl });
        for (const f of findings) fakeFindings.push({ sku: p.sku || p.id, field: f.field, value: f.value, reason: f.reason });
        if (findings.length) report.summary.productsWithFakeContacts += 1;
        if (repCore && safeString(p.gpsr?.manufacturer_name) && gpsrCoreKey(p.gpsr) !== repCore) divergentProducts += 1;
      }

      const liveCount = entry.products.filter((p) => p.live).length;
      const brandRow = {
        brand: entry.brand,
        brandKey: entry.key,
        status: verdict.status,
        cached: !!verdict.cached,
        issues: Array.isArray(verdict.issues) ? verdict.issues : [],
        evidenceUrl: verdict.evidence?.url || null,
        products: entry.products.length,
        liveProducts: liveCount,
        sellableProducts: entry.products.filter((p) => p.sellable).length,
        divergentProducts,
        representativeSku: representative ? representative.sku : null,
        fakeFindingsTotal: fakeFindings.length,
        fakeFindings: fakeFindings.slice(0, FAKE_FINDINGS_PER_BRAND_CAP),
      };
      report.brands.push(brandRow);
      report.summary.brandsVerified += 1;
      if (verdict.cached) report.summary.cacheHits += 1;
      report.summary.byStatus[verdict.status] = (report.summary.byStatus[verdict.status] || 0) + 1;
      report.summary.productsByStatus[verdict.status] =
        (report.summary.productsByStatus[verdict.status] || 0) + entry.products.length;
      report.summary.fakeContactFindings += fakeFindings.length;

      console.error(
        `[audit-gpsr-evidence] ${verdict.status.padEnd(13)} ${entry.brand} — produkte:${entry.products.length} live:${liveCount}` +
        `${fakeFindings.length ? ` fakes:${fakeFindings.length}` : ''}${verdict.cached ? ' (cache)' : ''}`
      );

      // ── APPLY pro Produkt dieser Marke ──────────────────────────────────────
      if (args.apply) {
        // infra_blocked/no_gpsr_data: nichts festgestellt → kein Beleg-Stempel,
        // kein Marker. Die netz-unabhaengige Fake-Bereinigung laeuft trotzdem.
        const stampEvidence = verdict.status !== 'infra_blocked' && verdict.status !== 'no_gpsr_data';
        const checkedAt = verdict.evidence?.checked_at || new Date().toISOString();

        // Registry-Wurzel mitbereinigen: der gpsrRegistryEnforce am
        // Save-Boundary spielt Registry-Werte bei JEDEM Save zurück aufs
        // Produkt — eine Produkt-Bereinigung ohne Registry-Bereinigung ist
        // wirkungslos (Live-Befund erster Apply-Lauf). Nur harte
        // Fake-Klassen, einmal pro Marke.
        try {
          const { manufacturerKeyCandidates } = require('../lib/gpsr-manufacturer-registry');
          const { FieldValue } = require('@google-cloud/firestore');
          const regNames = [representative?.gpsr?.manufacturer_name, entry.brand].filter(Boolean);
          let regRef = null; let regData = null;
          outerReg: for (const rn of regNames) {
            for (const key of manufacturerKeyCandidates(rn)) {
              const rs = await firestore.collection('gpsrManufacturers').doc(key).get();
              if (rs.exists) { regRef = rs.ref; regData = rs.data(); break outerReg; }
            }
          }
          if (regRef && regData) {
            const regUpdates = {};
            for (const finding of findFakeContacts(regData, { brand: entry.brand, fallbackUrl })) {
              if (!HARD_FAKE_REASONS.has(finding.reason)) continue;
              regUpdates[finding.field] = FieldValue.delete();
            }
            if (stampEvidence && !regData.evidence) {
              regUpdates.evidence = { status: verdict.status, url: verdict.evidence?.url || null, checked_at: checkedAt, by: 'gpsr-evidence-audit' };
            }
            if (Object.keys(regUpdates).length) {
              await regRef.update(regUpdates);
              report.actions.push({ brand: entry.brand, registry: regRef.id, status: 'registry_updated', fields: Object.keys(regUpdates) });
            }
          }
        } catch (regErr) {
          console.warn(`  [apply] Registry-Bereinigung ${entry.brand} fehlgeschlagen: ${regErr?.message}`);
        }

        for (const p of entry.products) {
          try {
            // Frischer Read direkt vor der Mutation — Scan-Snapshot kann alt sein.
            const snap = await firestore.collection(collectionName).doc(p.id).get();
            if (!snap.exists) {
              report.actions.push({ id: p.id, sku: p.sku, brand: entry.brand, status: 'skipped_not_found' });
              continue;
            }
            const product = { id: snap.id, ...snap.data() };
            const built = buildProductApply(product, {
              status: verdict.status,
              evidenceUrl: verdict.evidence?.url || null,
              checkedAt,
              brand: entry.brand,
              fallbackUrl,
              stampEvidence,
            });
            if (!built.changed) {
              report.actions.push({ id: p.id, sku: p.sku, brand: entry.brand, status: 'skipped_already_stamped' });
              continue;
            }

            product.details = product.details || {};
            product.details.gpsr = built.gpsr;
            if (built.markerSet) {
              product.ops = product.ops || {};
              product.ops.data_quality = product.ops.data_quality || {};
              product.ops.data_quality.gpsr_evidence = built.nextMarker;
            }

            await saveProductV2(product, {
              source: 'gpsr-evidence-audit',
              skipStockEvent: true,
              overwriteTextFields: false,
              replaceAttributes: false,
              allowCategoryChange: false,
              allowWarehouseFields: false,
              skipTitlePolicy: true,
              skipKeyFeaturesNormalize: true,
            });

            // saveProductV2 ist ein MERGE — Map-Keys werden dadurch NIE
            // gelöscht und die Save-Pipeline (Registry-Enforce) kann gpsr
            // ersetzen (Live-Befund: Nullung + Beleg-Stempel überlebten den
            // ersten Apply-Lauf nicht). Deshalb direkt danach ein gezieltes
            // update(): FieldValue.delete() für Fake-Felder + Beleg-Stempel
            // als Dot-Path. (Ein späterer Save kann Registry-Werte erneut
            // enforc-en — dafür wird der Registry-Eintrag unten pro Marke
            // mitbereinigt.)
            {
              const { FieldValue } = require('@google-cloud/firestore');
              const directUpdates = {};
              for (const n of built.nulled) {
                directUpdates[`details.gpsr.${n.field}`] = FieldValue.delete();
              }
              if (built.evidenceSet && built.gpsr.evidence) {
                directUpdates['details.gpsr.evidence'] = built.gpsr.evidence;
              }
              if (Object.keys(directUpdates).length) {
                await firestore.collection(collectionName).doc(p.id).update(directUpdates).catch((e) => {
                  console.warn(`  [apply] direct update ${p.sku || p.id} fehlgeschlagen: ${e?.message}`);
                });
              }
            }

            // Ehrlichkeits-Check: hat die Fake-Nullung den Save-Boundary
            // (gpsrRegistryEnforce-Amplifikator) ueberlebt?
            let nullSurvived = null;
            if (built.nulled.length) {
              try {
                const postSnap = await firestore.collection(collectionName).doc(p.id).get();
                const postGpsr = pickGpsrObj(postSnap.exists ? postSnap.data() : {});
                nullSurvived = built.nulled.every((n) => !safeString(postGpsr[n.field]));
              } catch (_) { /* best-effort */ }
            }

            report.actions.push({
              id: p.id,
              sku: p.sku,
              brand: entry.brand,
              status: 'applied',
              evidenceSet: built.evidenceSet,
              evidenceStatus: stampEvidence ? verdict.status : null,
              markerSet: built.markerSet,
              nulled: built.nulled,
              nullSurvived,
            });
            if (built.nulled.length) {
              console.error(
                `[audit-gpsr-evidence] bereinigt ${p.sku || p.id}: ${built.nulled.map((n) => `${n.field}(${n.reason})`).join(', ')}` +
                `${nullSurvived === false ? ' — WARNUNG: Nullung vom Save-Boundary ueberschrieben!' : ''}`
              );
            }
          } catch (err) {
            report.errors.push({ scope: 'product', id: p.id, sku: p.sku, brand: entry.brand, error: err.message });
            console.error(`[audit-gpsr-evidence] FEHLER Produkt ${p.sku || p.id}: ${err.message}`);
          }
        }
      }
    } catch (err) {
      report.errors.push({ scope: 'brand', brand: entry.brand, brandKey: entry.key, error: err.message });
      console.error(`[audit-gpsr-evidence] FEHLER Marke ${entry.brand}: ${err.message}`);
    }
  }

  // ── Aggregat ────────────────────────────────────────────────────────────────
  const s = report.summary;
  console.log(`[audit-gpsr-evidence] Produkte gescannt: ${s.productsScanned} (tenant=${args.tenantId}, ohne Marke: ${s.productsWithoutBrand})`);
  console.log(`  Scope (${args.mode}${args.brand ? `, brand="${args.brand}"` : ''}): ${s.productsInScope} Produkte in ${s.brandsInScope} Marken, davon live: ${s.liveProductsInScope}`);
  console.log(`  Marken verifiziert: ${s.brandsVerified} (Cache-Hits: ${s.cacheHits})`);
  console.log(
    `  Status (Marken): verified:${s.byStatus.verified} partial:${s.byStatus.partial}` +
    ` unverifiable:${s.byStatus.unverifiable} infra_blocked:${s.byStatus.infra_blocked} no_gpsr_data:${s.byStatus.no_gpsr_data}`
  );
  console.log(
    `  Status (Produkte): verified:${s.productsByStatus.verified} partial:${s.productsByStatus.partial}` +
    ` unverifiable:${s.productsByStatus.unverifiable} infra_blocked:${s.productsByStatus.infra_blocked} no_gpsr_data:${s.productsByStatus.no_gpsr_data}`
  );
  console.log(`  Fake-Kontakt-Funde: ${s.fakeContactFindings} auf ${s.productsWithFakeContacts} Produkten`);

  const problem = report.brands.filter((b) => b.status !== 'verified');
  if (problem.length) {
    const shown = problem.slice(0, BRAND_OUTPUT_CAP);
    console.log(`  Nicht-verifizierte Marken (${shown.length}/${problem.length} angezeigt):`);
    for (const b of shown) {
      console.log(
        `    ${b.status.padEnd(13)} ${b.brand} — produkte:${b.products} live:${b.liveProducts}` +
        `${b.fakeFindingsTotal ? ` fakes:${b.fakeFindingsTotal}` : ''}` +
        `${b.divergentProducts ? ` divergent:${b.divergentProducts}` : ''}` +
        `${b.issues.length ? ` issues:[${b.issues.slice(0, 4).join(',')}]` : ''}`
      );
    }
  }

  if (args.apply) {
    const applied = report.actions.filter((a) => a.status === 'applied').length;
    const cleaned = report.actions.filter((a) => a.status === 'applied' && a.nulled && a.nulled.length).length;
    const overwritten = report.actions.filter((a) => a.nullSurvived === false).length;
    console.log(`[audit-gpsr-evidence] APPLY fertig: ${applied} Produkte gestempelt, ${cleaned} Fake-Bereinigungen, ${report.errors.length} Fehler.`);
    if (overwritten) {
      console.log(`  WARNUNG: bei ${overwritten} Produkten hat der Save-Boundary die Fake-Nullung ueberschrieben (gpsrRegistryEnforce) — Registry-Eintrag der Marke pruefen!`);
    }
  } else {
    console.log(`[audit-gpsr-evidence] AUDIT-Modus — nichts geschrieben. Zum Anwenden: --apply --confirm ${CONFIRM_TOKEN} [--limit N]`);
  }

  // ── Report persistieren (immer, beide Modi) ─────────────────────────────────
  const stamp = startedAt.replace(/[:.]/g, '-');
  const outPath = path.join(args.outDir, `audit-gpsr-evidence-${stamp}.json`);
  try {
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log(`[audit-gpsr-evidence] Report: ${outPath}`);
  } catch (err) {
    console.error(`[audit-gpsr-evidence] Report konnte nicht geschrieben werden: ${err.message}`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[audit-gpsr-evidence] FATAL:', err.message);
    process.exit(1);
  });
}

// Pure Helpers fuer Tests exportieren (kein Firestore-Client beim Require).
module.exports = {
  parseArgs,
  pickBrand,
  productSku,
  productEan,
  pickGpsrObj,
  buildLiveSets,
  isLiveProduct,
  isSellableProduct,
  gpsrCompletenessScore,
  pickRepresentativeGpsr,
  gpsrCoreKey,
  findFakeContacts,
  buildProductApply,
  makeRateLimitedFetch,
  CONFIRM_TOKEN,
};

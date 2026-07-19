#!/usr/bin/env node
/**
 * Operator-Skript: Realistisches VERSANDGEWICHT für alle Produkte mit
 * Lagerbestand ≥ 1 auffüllen (Owner-Auftrag 2026-07-19: jedes aktive
 * eBay-Angebot braucht asap ein mehr oder weniger korrektes Gewicht).
 *
 * Befund (Datenprobe 2026-07-19): 770 Produkte Bestand≥1, davon 262 ohne
 * numerisch lesbares Gewicht (kanonische Kette details.weight ->
 * attributes.weight -> 'Gewicht (kg)' -> 'Gewicht', Numbers only).
 *
 * Ableitungs-Kaskade pro Produkt (erste Stufe mit Treffer gewinnt):
 *   1. attr_parse    — Gewichts-Attribut mit String ('ca. 16 kg') lenient parsen
 *   2. title_weight  — Inhaltsgewicht im Titel ('Creme 100g') + Verpackungsaufschlag
 *   3. volume        — Volumen-Literal (Attribut 'Inhalt'/Titel '20L') × Dichte
 *   4. area_weight   — Flächengewicht g/m² × Maße (Sichtschutz etc.)
 *   5. web           — lib/weight-web-lookup (SerpAPI-Snippets, confidence ≥ 0.6)
 *   6. gemini        — Gemini-3-Pro-Schätzung aus Titel/Marke/Kategorie/Attributen
 * Alles läuft durch clampShippingKg (0.02..50 kg) — Werte > 50 kg werden NIE
 * geschrieben (parseWeightKg-Gramm-Falle, siehe lib/weight-derive.js).
 *
 * Writes AUSSCHLIESSLICH via saveProductV2 (CLAUDE.md Regel 7) mit
 * allowWarehouseFields:false — Bestand/inventory wird NIE angefasst.
 * Bestehende plausible Gewichte werden NIE überschrieben.
 *
 * Aufruf:
 *   node backend/scripts/backfill-weights-instock.js                  # Dry-Run
 *   node backend/scripts/backfill-weights-instock.js --limit 20       # Probe
 *   node backend/scripts/backfill-weights-instock.js --apply          # Schreiben
 *   node backend/scripts/backfill-weights-instock.js --apply --no-gemini
 *   node backend/scripts/backfill-weights-instock.js --tenant default --out /tmp
 */

'use strict';

process.env.USE_PRODUCTS_V2 = process.env.USE_PRODUCTS_V2 || 'true';

const fs = require('fs');
const path = require('path');

const {
  readCanonicalWeightKg,
  isPlausibleShippingKg,
  clampShippingKg,
  deriveWeightHeuristic,
  isWeightAliasKey,
} = require('../lib/weight-derive');

const WEB_MIN_CONFIDENCE = 0.6;
const GEMINI_TIMEOUT_MS = parseInt(process.env.WEIGHT_GEMINI_TIMEOUT_MS || '', 10) || 25000;
const GEMINI_SLEEP_MS = 300;
const DEFAULT_CONCURRENCY = 4;

function safeString(v) {
  return v == null ? '' : String(v).trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const out = {
    apply: false,
    tenantId: process.env.TENANT_ID || 'default',
    limit: null,
    outDir: process.env.SCRATCHPAD_DIR || '/tmp',
    // Web-Snippet-Lookup ist OPT-IN: Stichprobe 2026-07-19 lieferte Instagram-/
    // Foren-Snippets als "Beleg" (Schmutzfangmatte 0,12 kg statt ~2,5 kg).
    // Gemini-3-Pro war durchweg plausibler — Web nur bewusst zuschalten.
    web: false,
    noGemini: false,
    concurrency: DEFAULT_CONCURRENCY,
    onlySkus: null,
    fromJsonl: null,
    help: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--apply') out.apply = true;
    else if (t === '--web') out.web = true;
    else if (t === '--no-web') out.web = false;
    else if (t === '--no-gemini') out.noGemini = true;
    else if (t === '--tenant') { out.tenantId = argv[i + 1] || out.tenantId; i += 1; }
    else if (t === '--out') { out.outDir = argv[i + 1] || out.outDir; i += 1; }
    else if (t === '--from-jsonl') { out.fromJsonl = argv[i + 1] || null; i += 1; }
    else if (t === '--only-sku') {
      out.onlySkus = new Set(safeString(argv[i + 1]).split(',').map((s) => s.trim()).filter(Boolean));
      i += 1;
    } else if (t === '--limit') {
      const n = Number(argv[i + 1]);
      if (Number.isFinite(n) && n > 0) out.limit = Math.floor(n);
      i += 1;
    } else if (t === '--concurrency') {
      const n = Number(argv[i + 1]);
      if (Number.isFinite(n) && n > 0) out.concurrency = Math.min(8, Math.floor(n));
      i += 1;
    } else if (t === '--help' || t === '-h') out.help = true;
  }
  return out;
}

function printHelp() {
  console.log(`backfill-weights-instock.js — Versandgewicht für Bestand≥1-Produkte auffüllen.

  Optionen:
    --apply           Wirklich schreiben (default: Dry-Run, voller Report)
    --tenant <id>     Tenant (default: TENANT_ID env oder 'default')
    --limit <n>       Max. Kandidaten verarbeiten (auch im Dry-Run)
    --only-sku <a,b>  Nur diese SKUs
    --web             Web-Snippet-Lookup zuschalten (default AUS — unzuverlässige Quellen)
    --no-gemini       Gemini-Schätz-Stufe überspringen
    --concurrency <n> Parallele Lookups (default ${DEFAULT_CONCURRENCY}, max 8)
    --from-jsonl <f>  Ableitungen aus früherem Dry-Run-JSONL übernehmen statt
                      neu abzuleiten (geprüfte Werte; Apply macht trotzdem
                      frischen Doc-Read + Re-Check pro Produkt)
    --out <dir>       Report-Verzeichnis (default: SCRATCHPAD_DIR oder /tmp)
`);
}

/**
 * Kompakter Produkt-Kontext für den Gemini-Prompt. PURE.
 */
function buildGeminiPrompt(product) {
  const ident = product?.identification || {};
  const details = product?.details || {};
  const attrs = (details.attributes && typeof details.attributes === 'object') ? details.attributes : {};
  const attrPairs = Object.entries(attrs)
    .filter(([, v]) => v != null && String(v).trim() !== '')
    .slice(0, 30)
    .map(([k, v]) => `${k}: ${String(v).slice(0, 80)}`)
    .join('\n');

  return `Du bist Logistik-Experte eines eBay-Händlers. Schätze das realistische VERSANDGEWICHT der folgenden VERKAUFSEINHEIT (Produkt wie im Titel beschrieben, inkl. Produktverpackung — OHNE Versandkarton-Aufschlag).

PRODUKT:
Titel: ${safeString(ident.name) || '-'}
Marke: ${safeString(ident.brand) || '-'}
MPN: ${safeString(ident.mpn) || safeString(attrs['Herstellernummer']) || '-'}
EAN: ${safeString(ident.ean) || safeString(ident.gtin) || '-'}
Kategorie: ${safeString(ident.category) || '-'}

ATTRIBUTE:
${attrPairs || '-'}

REGELN:
- Nutze dein Produktwissen: Herstellerangaben, typische Gewichte vergleichbarer Artikel.
- "Set"/"2x"/Stückzahl im Titel = Gewicht des GESAMTEN Sets (eine Verkaufseinheit).
- Flüssigkeiten: Volumen × Dichte + Gebinde (20L Kanister Kühlmittel ≈ 21500 g).
- NIE 0 oder fehlend — im Zweifel konservative, kategorie-typische Schätzung.
- Antwort in GANZZAHLIGEN GRAMM.`;
}

const GEMINI_SCHEMA = {
  type: 'object',
  properties: {
    weight_grams: {
      type: 'integer',
      description: 'Realistisches Versandgewicht der Verkaufseinheit in Gramm, Ganzzahl > 0. Nie 0, nie null.',
    },
    confidence: {
      type: 'number',
      description: '0..1 — 0.9 = Herstellerangabe bekannt, 0.6 = fundierte Ableitung aus vergleichbaren Produkten, 0.3 = grobe Kategorie-Schätzung',
    },
    basis: {
      type: 'string',
      description: 'Ein Satz: woraus abgeleitet (Herstellerdaten / Vergleichsprodukt / Kategorie-typisch)',
    },
  },
  required: ['weight_grams', 'confidence', 'basis'],
};

/**
 * Gewichts-Kaskade für EIN Produkt. Liefert immer ein Resultat-Objekt
 * (resolved oder unresolved), wirft nie.
 */
async function deriveWeightForProduct(product, deps, opts) {
  const sku = safeString(product?.identification?.sku) || product.id;
  const base = { id: product.id, sku, title: safeString(product?.identification?.name).slice(0, 90) };

  // Tiers 1-4: deterministisch, pure.
  const heuristic = deriveWeightHeuristic(product);
  if (heuristic) {
    const kg = clampShippingKg(heuristic.kg);
    if (kg != null) {
      return { ...base, status: 'resolved', kg, method: heuristic.method, confidence: 0.8, detail: heuristic.detail };
    }
  }

  // Tier 5 (OPT-IN via --web): Web-Lookup (SerpAPI-Snippets). Soft-fail.
  if (opts.web && deps.lookupWeightFromWeb) {
    try {
      const ident = product?.identification || {};
      const identity = {
        brand: safeString(ident.brand) || null,
        model: safeString(ident.mpn) || safeString(ident.model) || null,
        ean: safeString(ident.ean) || safeString(ident.gtin) || null,
      };
      if (identity.brand || identity.ean) {
        const web = await deps.lookupWeightFromWeb(identity, { timeout: 8000 });
        if (web && web.weight_grams && web.confidence >= WEB_MIN_CONFIDENCE) {
          const kg = clampShippingKg(web.weight_grams / 1000);
          if (kg != null) {
            return {
              ...base, status: 'resolved', kg, method: 'web', confidence: web.confidence,
              detail: (web.sources || []).slice(0, 2).join(' '),
            };
          }
        }
      }
    } catch (err) {
      // Web-Stufe ist best-effort — weiter zur Gemini-Stufe.
      console.error(`[backfill-weights] web-lookup Fehler ${sku}: ${err?.message}`);
    }
  }

  // Tier 6: Gemini-Schätzung (Gemini 3 Pro, JSON-Mode).
  if (!opts.noGemini && deps.gemini3GenerateJSON) {
    try {
      const parsed = await deps.gemini3GenerateJSON({
        prompt: buildGeminiPrompt(product),
        schema: GEMINI_SCHEMA,
        model: process.env.WEIGHT_GEMINI_MODEL || undefined,
        temperature: 0.2,
        maxOutputTokens: 2048,
        timeoutMs: GEMINI_TIMEOUT_MS,
      });
      const grams = Number(parsed?.weight_grams);
      if (Number.isFinite(grams) && grams > 0) {
        const kg = clampShippingKg(grams / 1000);
        if (kg != null) {
          return {
            ...base, status: 'resolved', kg, method: 'gemini',
            confidence: Number.isFinite(parsed?.confidence) ? parsed.confidence : 0.3,
            detail: safeString(parsed?.basis).slice(0, 200),
          };
        }
        return { ...base, status: 'unresolved', reason: 'gemini_out_of_range', grams };
      }
      return { ...base, status: 'unresolved', reason: 'gemini_no_weight' };
    } catch (err) {
      return { ...base, status: 'unresolved', reason: 'gemini_error', error: err?.message || String(err) };
    } finally {
      await sleep(GEMINI_SLEEP_MS);
    }
  }

  return { ...base, status: 'unresolved', reason: 'no_signal' };
}

/**
 * Simpler Worker-Pool (Muster gpsr-backfill-web-instock.js). PURE bis auf worker.
 */
async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function lane() {
    while (next < items.length) {
      const idx = next;
      next += 1;
      results[idx] = await worker(items[idx], idx);
    }
  }
  const lanes = [];
  for (let i = 0; i < Math.max(1, concurrency); i += 1) lanes.push(lane());
  await Promise.all(lanes);
  return results;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }

  if (process.env.USE_PRODUCTS_V2 !== 'true') {
    throw new Error('USE_PRODUCTS_V2=true erforderlich (Legacy-Collection wäre falsches Ziel)');
  }

  // Lazy Requires — Firestore/Gemini erst hier, damit die pure Helpers
  // testbar bleiben (require ohne Client-Init).
  const { PRODUCTS_COLLECTION, getAllProductsForTenant, firestore } = require('../lib/firestore');
  const { saveProductV2, getCollection } = require('../lib/product-store');
  let lookupWeightFromWeb = null;
  if (args.web) {
    try { ({ lookupWeightFromWeb } = require('../lib/weight-web-lookup')); } catch (err) {
      console.error(`[backfill-weights] weight-web-lookup nicht ladbar (${err?.message}) — Web-Stufe aus`);
    }
  }
  let gemini3GenerateJSON = null;
  if (!args.noGemini) {
    ({ gemini3GenerateJSON } = require('../lib/gemini3-client'));
  }

  const startedAt = new Date().toISOString();
  console.log(`[backfill-weights] Modus=${args.apply ? 'APPLY' : 'DRY-RUN'} tenant=${args.tenantId} limit=${args.limit ?? '-'} web=${args.web} gemini=${!args.noGemini}`);

  const products = await getAllProductsForTenant(args.tenantId);
  console.log(`[backfill-weights] ${products.length} Produkte geladen (${PRODUCTS_COLLECTION}, tenant=${args.tenantId})`);

  // Kandidaten: Bestand ≥ 1 UND kein plausibles numerisches Gewicht.
  const skippedHaveWeight = [];
  const skippedOver50 = [];
  let candidates = [];
  for (const product of products) {
    const qty = Number(product?.inventory?.quantity);
    if (!Number.isFinite(qty) || qty < 1) continue;
    const sku = safeString(product?.identification?.sku);
    if (args.onlySkus && !args.onlySkus.has(sku)) continue;
    const existing = readCanonicalWeightKg(product);
    if (existing != null && isPlausibleShippingKg(existing)) {
      skippedHaveWeight.push({ id: product.id, sku, kg: existing });
      continue;
    }
    if (existing != null && existing > 50) {
      // Nicht anfassen — könnte echte Speditionsware sein; nur reporten.
      skippedOver50.push({ id: product.id, sku, kg: existing });
      continue;
    }
    candidates.push(product);
  }
  candidates.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  if (args.limit) candidates = candidates.slice(0, args.limit);

  console.log(`[backfill-weights] Bestand≥1 mit Gewicht: ${skippedHaveWeight.length} | >50kg (unangetastet): ${skippedOver50.length} | Kandidaten ohne Gewicht: ${candidates.length}`);

  const deps = { lookupWeightFromWeb, gemini3GenerateJSON };
  const jsonlPath = path.join(args.outDir, `backfill-weights-${startedAt.replace(/[:.]/g, '-')}.jsonl`);
  const jsonlStream = fs.createWriteStream(jsonlPath, { flags: 'a' });

  let derivations;
  if (args.fromJsonl) {
    // Geprüfte Ableitungen aus früherem Lauf übernehmen — nur für Produkte,
    // die JETZT noch Kandidaten sind (Bestand + fehlendes Gewicht re-gecheckt).
    const candidateIds = new Set(candidates.map((p) => p.id));
    derivations = fs.readFileSync(args.fromJsonl, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((r) => candidateIds.has(r.id));
    console.log(`[backfill-weights] --from-jsonl: ${derivations.length} Ableitungen übernommen (${args.fromJsonl})`);
  } else {
    let done = 0;
    derivations = await runPool(candidates, args.concurrency, async (product) => {
      const result = await deriveWeightForProduct(product, deps, args);
      done += 1;
      jsonlStream.write(`${JSON.stringify(result)}\n`);
      if (done % 10 === 0 || done === candidates.length) {
        console.error(`[backfill-weights] ${done}/${candidates.length} abgeleitet`);
      }
      return result;
    });
  }

  const resolved = derivations.filter((d) => d.status === 'resolved');
  const unresolved = derivations.filter((d) => d.status !== 'resolved');
  const byMethod = {};
  for (const r of resolved) byMethod[r.method] = (byMethod[r.method] || 0) + 1;

  // ── APPLY ──────────────────────────────────────────────────────────────────
  const actions = [];
  const errors = [];
  if (args.apply) {
    const collectionName = getCollection();
    for (const r of resolved) {
      try {
        // Frischer Read direkt vor der Mutation — Snapshot kann alt sein.
        const snap = await firestore.collection(collectionName).doc(r.id).get();
        if (!snap.exists) {
          actions.push({ id: r.id, sku: r.sku, status: 'skipped_not_found' });
          continue;
        }
        const product = { id: snap.id, ...snap.data() };
        const existing = readCanonicalWeightKg(product);
        if (existing != null && isPlausibleShippingKg(existing)) {
          actions.push({ id: r.id, sku: r.sku, status: 'skipped_already_has_weight', kg: existing });
          continue;
        }

        product.details = product.details || {};
        product.details.weight = r.kg;
        // Alte Müll-Strings in Gewichts-Alias-Keys ('ca. 16 kg', '14 Unzen')
        // explizit mit dem numerischen kg-Wert überschreiben — enforceEbayAspects
        // behält sonst den vorhandenen Aspect-Wert (existingEmpty-Guard).
        const attrs = product.details.attributes;
        if (attrs && typeof attrs === 'object') {
          for (const key of Object.keys(attrs)) {
            if (isWeightAliasKey(key)) attrs[key] = r.kg;
          }
        }
        product.ops = product.ops || {};
        product.ops.data_quality = product.ops.data_quality || {};
        product.ops.data_quality.weight_backfill_v1 = {
          at_iso: new Date().toISOString(),
          method: r.method,
          weight_kg: r.kg,
          confidence: r.confidence ?? null,
          detail: (r.detail || '').slice(0, 300),
        };

        await saveProductV2(product, {
          source: 'script:backfill-weights',
          overwriteTextFields: false,
          replaceAttributes: false,
          allowCategoryChange: false,
          allowWarehouseFields: false,
          skipTitlePolicy: true,
          skipKeyFeaturesNormalize: true,
        });
        actions.push({ id: r.id, sku: r.sku, status: 'applied', kg: r.kg, method: r.method });
        console.error(`[backfill-weights] gesetzt ${r.sku}: ${r.kg} kg (${r.method})`);
      } catch (err) {
        errors.push({ id: r.id, sku: r.sku, error: err?.message || String(err) });
        console.error(`[backfill-weights] FEHLER ${r.sku}: ${err?.message}`);
      }
    }
  }

  jsonlStream.end();

  const report = {
    script: 'backfill-weights-instock',
    mode: args.apply ? 'apply' : 'dry-run',
    tenantId: args.tenantId,
    startedAt,
    finishedAt: new Date().toISOString(),
    counts: {
      productsTotal: products.length,
      alreadyHaveWeight: skippedHaveWeight.length,
      over50Untouched: skippedOver50.length,
      candidates: candidates.length,
      resolved: resolved.length,
      unresolved: unresolved.length,
      byMethod,
      applied: actions.filter((a) => a.status === 'applied').length,
      errors: errors.length,
    },
    over50Untouched: skippedOver50,
    unresolved,
    actions,
    errors,
  };
  const outFile = path.join(args.outDir, `backfill-weights-report-${startedAt.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));

  console.log(`[backfill-weights] Fertig — resolved=${resolved.length}/${candidates.length} (${Object.entries(byMethod).map(([k, v]) => `${k}=${v}`).join(', ') || '-'}) unresolved=${unresolved.length}${args.apply ? ` applied=${report.counts.applied} errors=${errors.length}` : ''}`);
  console.log(`[backfill-weights] Ableitungen: ${jsonlPath}`);
  console.log(`[backfill-weights] Report: ${outFile}`);
  if (errors.length) process.exitCode = 1;
}

module.exports = {
  parseArgs,
  buildGeminiPrompt,
  deriveWeightForProduct,
  runPool,
  GEMINI_SCHEMA,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(`[backfill-weights] Abbruch: ${err?.message}`, err);
    process.exitCode = 1;
  });
}

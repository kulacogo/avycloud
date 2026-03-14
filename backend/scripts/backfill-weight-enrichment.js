/* eslint-disable no-console */
/**
 * backfill-weight-enrichment.js
 *
 * Enriches all products with inventory (quantity > 0) that have no weight set.
 * Uses Gemini (structured output) to estimate weight based on product data.
 *
 * Priority hierarchy for weight:
 *   1. Already present in product data (skip)
 *   2. Extractable from existing attributes/description (parse first)
 *   3. LLM estimate via Gemini (last resort)
 *
 * Usage:
 *   # Dry-run (default) — only shows what would be updated
 *   node backend/scripts/backfill-weight-enrichment.js
 *
 *   # Apply changes
 *   node backend/scripts/backfill-weight-enrichment.js --apply
 *
 *   # Limit to N products
 *   node backend/scripts/backfill-weight-enrichment.js --apply --limit 50
 *
 *   # Debug mode (verbose logging)
 *   node backend/scripts/backfill-weight-enrichment.js --apply --debug
 *
 * Requires:
 *   - GOOGLE_CLOUD_PROJECT or default 'avycloud'
 *   - GEMINI_API_KEY or GOOGLE_GENAI_API_KEY (env or Secret Manager)
 *   - USE_PRODUCTS_V2=true (for dual-write to products_v2)
 */

const { getAllProducts, saveProduct } = require('../lib/firestore');
const { saveProductV2 } = require('../lib/product-store');
const { gemini3GenerateJSON } = require('../lib/gemini3-client');

// ---------------------------------------------------------------------------
// Weight parsing (copied from firestore.js — not exported there)
// ---------------------------------------------------------------------------
function parseWeightKg(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    return value > 50 ? value / 1000 : value;
  }
  const raw = String(value).trim();
  if (!raw) return null;
  const match = raw.match(/([\d.,]+)\s*(kg|g|gramm|grams?|kilogramm|kilograms?)?/i);
  if (!match) return null;
  const num = Number(match[1].replace(',', '.'));
  if (!Number.isFinite(num) || num <= 0) return null;
  const unit = (match[2] || '').toLowerCase();
  if (unit) {
    if (unit === 'g' || unit.startsWith('gram')) return num / 1000;
    if (unit === 'kg' || unit.startsWith('kilo')) return num;
  }
  return num > 50 ? num / 1000 : num;
}

function normalizeWeightKgNumber(value) {
  const kg = parseWeightKg(value);
  if (kg === null) return null;
  if (!Number.isFinite(kg) || kg <= 0) return null;
  const rounded = Math.round(kg * 100) / 100;
  if (!Number.isFinite(rounded) || rounded <= 0) return null;
  if (Number.isInteger(rounded)) return rounded;
  return Number(rounded.toFixed(2));
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const DEBUG = args.includes('--debug');
const LIMIT = (() => {
  const idx = args.indexOf('--limit');
  return idx >= 0 && args[idx + 1] ? Number(args[idx + 1]) : Infinity;
})();

// ---------------------------------------------------------------------------
// Weight aliases — same as firestore.js normalizeAttributes
// ---------------------------------------------------------------------------
const WEIGHT_ALIASES = [
  'weight', 'gewicht', 'gewicht(kg)', 'bruttogewicht', 'nettogewicht',
  'eigengewicht', 'eigengewicht (kg)', 'artikelgewicht', 'gross weight',
  'net weight', 'shipping weight', 'paketgewicht', 'productweight',
  'item weight', 'package weight', 'Gewicht',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Try to extract weight from product data (attributes, description, title).
 * Returns { weightKg: number, source: string } or null.
 */
function tryExtractWeightFromProduct(product) {
  const attrs = product?.details?.attributes || {};

  // 1. Check all known weight aliases in attributes
  for (const alias of WEIGHT_ALIASES) {
    const val = attrs[alias] ?? attrs[alias.toLowerCase()];
    if (val !== undefined && val !== null && val !== '' && val !== 'N/A') {
      const kg = normalizeWeightKgNumber(val);
      if (kg !== null && kg > 0) {
        return { weightKg: kg, source: `attribute:${alias}` };
      }
    }
  }

  // 2. Check details.weight directly
  if (product?.details?.weight) {
    const kg = normalizeWeightKgNumber(product.details.weight);
    if (kg !== null && kg > 0) {
      return { weightKg: kg, source: 'details.weight' };
    }
  }

  // 3. Check ops.weight
  if (product?.ops?.weight) {
    const kg = normalizeWeightKgNumber(product.ops.weight);
    if (kg !== null && kg > 0) {
      return { weightKg: kg, source: 'ops.weight' };
    }
  }

  // 4. Try to extract from description text
  const desc = product?.details?.description || '';
  const highlights = Array.isArray(product?.details?.highlights)
    ? product.details.highlights.join(' ')
    : '';
  const textBlob = `${desc} ${highlights}`;

  const kgMatch = textBlob.match(/(\d+(?:[.,]\d+)?)\s*(?:kg|kilogramm|kilograms?)\b/i);
  if (kgMatch) {
    const kg = normalizeWeightKgNumber(kgMatch[1].replace(',', '.'));
    if (kg !== null && kg > 0 && kg < 200) {
      return { weightKg: kg, source: 'description:regex_kg' };
    }
  }

  const gMatch = textBlob.match(/(\d+(?:[.,]\d+)?)\s*(?:g|gramm|grams?)\b/i);
  if (gMatch) {
    const grams = parseFloat(gMatch[1].replace(',', '.'));
    if (Number.isFinite(grams) && grams > 0 && grams < 200000) {
      const kg = normalizeWeightKgNumber(grams / 1000);
      if (kg !== null && kg > 0) {
        return { weightKg: kg, source: 'description:regex_g' };
      }
    }
  }

  return null;
}

/**
 * Build a Gemini prompt to estimate product weight.
 */
function buildWeightPrompt(product) {
  const title = product?.identification?.name || '';
  const brand = product?.identification?.brand || '';
  const category = product?.details?.categoryPath || product?.details?.categoryId || product?.identification?.category || '';
  const ean = product?.details?.identifiers?.ean || product?.details?.identifiers?.gtin || (Array.isArray(product?.identification?.barcodes) ? product.identification.barcodes[0] : '') || '';
  const desc = (product?.details?.short_description || product?.details?.description || '').replace(/<[^>]*>/g, '').slice(0, 500);
  const keyFeatures = Array.isArray(product?.details?.key_features) ? product.details.key_features.join('; ') : '';
  const attrs = product?.details?.attributes || {};
  const dimensions = attrs.dimensions || attrs.Abmessungen || attrs.Maße || attrs.Produktmaße || '';
  const material = attrs.material || attrs.Material || '';
  const produktart = attrs.Produktart || '';

  return `Du bist ein Produktdaten-Experte. Schätze das Gewicht des folgenden Produkts in Kilogramm.

Produktdaten:
- Titel: ${title}
- Marke: ${brand}
- Kategorie: ${category}
- Produktart: ${produktart}
- EAN: ${ean}
- Material: ${material}
- Abmessungen: ${dimensions}
- Key Features: ${keyFeatures}
- Beschreibung: ${desc}

REGELN:
1. Gib das Gewicht in kg zurück (nur die Zahl, z.B. 0.35 für 350g)
2. Berücksichtige typische Gewichte für diese Produktkategorie
3. Wenn du dir unsicher bist, gib eine konservative Schätzung
4. Gewicht muss > 0 und realistisch sein (Minimum 0.01 kg = 10g)
5. Runde auf 2 Dezimalstellen
6. Gib an, wie sicher du dir bist (high/medium/low)`;
}

const WEIGHT_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    weightKg: {
      type: 'number',
      description: 'Geschätztes Gewicht in Kilogramm',
    },
    confidence: {
      type: 'string',
      description: 'Konfidenz der Schätzung: high, medium oder low',
    },
    reasoning: {
      type: 'string',
      description: 'Kurze Begründung (max 100 Zeichen)',
    },
  },
  required: ['weightKg', 'confidence', 'reasoning'],
};

/**
 * Call Gemini 3 Pro to estimate weight via central gemini3-client.
 */
async function estimateWeightViaGemini(product) {
  const prompt = buildWeightPrompt(product);

  const parsed = await gemini3GenerateJSON({
    prompt,
    schema: WEIGHT_RESPONSE_SCHEMA,
    temperature: 0.1,
    maxOutputTokens: 2048,
  });

  if (DEBUG) {
    console.log('    [gemini3] response:', JSON.stringify(parsed).slice(0, 120));
  }

  const weightKg = normalizeWeightKgNumber(parsed.weightKg);

  if (!weightKg || weightKg <= 0 || weightKg > 500) {
    return null;
  }

  return {
    weightKg,
    confidence: parsed.confidence || 'low',
    reasoning: parsed.reasoning || '',
    source: 'gemini:estimate',
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run() {
  console.log('='.repeat(70));
  console.log('Weight Enrichment Backfill');
  console.log(`Mode: ${APPLY ? 'APPLY (writing changes)' : 'DRY-RUN (no changes)'}`);
  console.log(`Limit: ${LIMIT === Infinity ? 'all' : LIMIT}`);
  console.log('='.repeat(70));

  // 1. Load all products
  console.log('\nLoading products from Firestore...');
  const allProducts = await getAllProducts();
  console.log(`Total products loaded: ${allProducts.length}`);

  // 2. Filter: only products with stock > 0 AND no weight
  const candidates = allProducts.filter((p) => {
    // Check stock
    const qty =
      p?.inventory?.quantity ??
      p?.warehouse?.storageBins?.reduce((sum, bin) => sum + (bin.quantity || 0), 0) ??
      0;
    if (qty <= 0) return false;

    // Check if weight already exists
    const existing = tryExtractWeightFromProduct(p);
    if (existing && existing.weightKg > 0) {
      // Weight exists but may not be properly stored — we'll handle this
      const storedWeight = normalizeWeightKgNumber(
        p?.details?.attributes?.weight ?? p?.details?.weight
      );
      if (storedWeight && storedWeight > 0) {
        return false; // Already properly stored
      }
      // Weight extractable but not stored — include for fix
      return true;
    }
    return true; // No weight found
  });

  const toProcess = candidates.slice(0, LIMIT);
  console.log(`Products with stock and missing weight: ${candidates.length}`);
  console.log(`Processing: ${toProcess.length}`);

  if (toProcess.length === 0) {
    console.log('\nNo products to process. All products with stock have weights.');
    return;
  }

  // 3. Process each product
  const results = {
    extracted: 0,
    estimated: 0,
    failed: 0,
    skipped: 0,
    total: toProcess.length,
  };

  const BATCH_SIZE = 5; // Process in small batches to not overwhelm Gemini
  const DELAY_BETWEEN_CALLS_MS = 500; // Rate limiting

  for (let i = 0; i < toProcess.length; i++) {
    const product = toProcess[i];
    const sku = product?.identification?.sku || product?.details?.identifiers?.sku || product.id;
    const title = (product?.details?.title || '').slice(0, 60);

    try {
      // Step A: Try to extract from existing data first
      let weightResult = tryExtractWeightFromProduct(product);

      // Step B: If no extraction possible, use Gemini
      if (!weightResult) {
        await sleep(DELAY_BETWEEN_CALLS_MS);
        weightResult = await estimateWeightViaGemini(product);
      }

      if (!weightResult || !weightResult.weightKg) {
        console.log(`  [${i + 1}/${toProcess.length}] SKIP ${sku} — "${title}" — could not determine weight`);
        results.skipped++;
        continue;
      }

      const { weightKg, source, confidence, reasoning } = weightResult;
      const isEstimate = source === 'gemini:estimate';

      if (isEstimate) {
        results.estimated++;
      } else {
        results.extracted++;
      }

      const logPrefix = isEstimate
        ? `EST [${confidence}]`
        : `EXT [${source}]`;

      console.log(
        `  [${i + 1}/${toProcess.length}] ${logPrefix} ${sku} — "${title}" → ${weightKg} kg` +
          (reasoning ? ` (${reasoning.slice(0, 60)})` : '')
      );

      if (DEBUG) {
        console.log(`    source=${source} confidence=${confidence || 'n/a'}`);
      }

      // Step C: Write to product
      if (APPLY) {
        product.details = product.details || {};
        product.details.attributes = product.details.attributes || {};
        product.details.attributes.weight = weightKg;
        product.details.attributes.Gewicht = weightKg;
        product.details.weight = weightKg;

        // Track enrichment metadata
        product.ops = product.ops || {};
        product.ops.weightEnrichment = {
          weightKg,
          source,
          confidence: confidence || 'extracted',
          enrichedAt: new Date().toISOString(),
          script: 'backfill-weight-enrichment',
        };

        await saveProductV2(product, {
          source: 'script:backfill-weight-enrichment',
          skipTitlePolicy: true,
          skipKeyFeaturesNormalize: true,
          allowWarehouseFields: false,
        });
      }
    } catch (err) {
      results.failed++;
      console.error(`  [${i + 1}/${toProcess.length}] FAIL ${sku} — ${err.message}`);
      if (DEBUG) {
        console.error('    ', err.stack?.split('\n').slice(0, 3).join('\n    '));
      }
    }
  }

  // 4. Summary
  console.log('\n' + '='.repeat(70));
  console.log('SUMMARY');
  console.log('='.repeat(70));
  console.log(`Total processed: ${results.total}`);
  console.log(`  Extracted from existing data: ${results.extracted}`);
  console.log(`  Estimated via Gemini:         ${results.estimated}`);
  console.log(`  Failed:                       ${results.failed}`);
  console.log(`  Skipped (no result):          ${results.skipped}`);
  console.log(`Mode: ${APPLY ? 'APPLIED' : 'DRY-RUN (use --apply to write)'}`);
  console.log('='.repeat(70));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

run().catch((err) => {
  console.error('Weight enrichment script failed:', err);
  process.exit(1);
});

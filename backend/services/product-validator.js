'use strict';

/**
 * product-validator.js — Fast batch validation + correction for product data.
 *
 * Uses gemini3GenerateJSON (structured output, NO search grounding, NO chat)
 * for speed (~3-5s per product instead of ~45s with full chat pipeline).
 *
 * Validates & corrects:
 *   1. Titel → eBay-ready (wahrheitsgemäß, 70-80 Zeichen)
 *   2. Kategorie → korrekte eBay-Produktkategorie (plausibel)
 *   3. Preis → Marktpreis im unteren Bereich (DACH-Raum)
 *   4. Attribute → max 45, keine Duplikate, deutsche Keys
 *
 * Auto-applies corrections via saveProductV2().
 */

const { gemini3GenerateJSON } = require('../lib/gemini3-client');
const { saveProductV2 } = require('../lib/product-store');
const { getProduct } = require('../lib/firestore');
const { normalizeDigits, isValidGtin } = require('../lib/gtin');
const { coerceTitleToPolicy } = require('../lib/title-policy');
const {
  canonicalizeAttributeKey,
  isBlockedAttributeKey,
} = require('../lib/attribute-policy');

const MAX_ATTRIBUTES = 45;

// Delay between products (Gemini rate limit)
const DELAY_MS = parseInt(process.env.VALIDATOR_DELAY_MS || '2000', 10);

// ---------------------------------------------------------------------------
// Gemini Schema for structured validation response
// ---------------------------------------------------------------------------

const VALIDATION_SCHEMA = {
  type: 'OBJECT',
  properties: {
    title: {
      type: 'OBJECT',
      properties: {
        ok: { type: 'BOOLEAN', description: 'true wenn Titel korrekt ist' },
        corrected: { type: 'STRING', description: 'Korrigierter Titel (70-80 Zeichen), leer wenn ok=true' },
        reason: { type: 'STRING', description: 'Begründung der Korrektur' },
      },
      required: ['ok'],
    },
    category: {
      type: 'OBJECT',
      properties: {
        ok: { type: 'BOOLEAN', description: 'true wenn Kategorie plausibel' },
        correctedPath: { type: 'STRING', description: 'Korrigierte Kategorie (eBay Breadcrumb), leer wenn ok=true' },
        correctedId: { type: 'STRING', description: 'Korrigierte eBay Category ID, leer wenn ok=true' },
        reason: { type: 'STRING', description: 'Begründung' },
      },
      required: ['ok'],
    },
    price: {
      type: 'OBJECT',
      properties: {
        ok: { type: 'BOOLEAN', description: 'true wenn Preis im unteren Marktbereich liegt' },
        suggestedPrice: { type: 'NUMBER', description: 'Empfohlener Preis in EUR (unterer Bereich), 0 wenn ok' },
        marketRange: { type: 'STRING', description: 'Geschätzter Marktpreis-Bereich z.B. "15-25 EUR"' },
        reason: { type: 'STRING', description: 'Begründung' },
      },
      required: ['ok'],
    },
    attributes: {
      type: 'OBJECT',
      properties: {
        ok: { type: 'BOOLEAN', description: 'true wenn Attribute korrekt (keine Duplikate, max 45)' },
        corrected: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              key: { type: 'STRING' },
              value: { type: 'STRING' },
            },
            required: ['key', 'value'],
          },
          description: 'Korrigierte Attribut-Liste (max 45, dedupliziert, deutsche Keys). Leer wenn ok=true.',
        },
        removed: {
          type: 'ARRAY',
          items: { type: 'STRING' },
          description: 'Entfernte Duplikat-/ungültige Keys',
        },
        reason: { type: 'STRING' },
      },
      required: ['ok'],
    },
  },
  required: ['title', 'category', 'price', 'attributes'],
};

// ---------------------------------------------------------------------------
// Build validation prompt
// ---------------------------------------------------------------------------

function buildValidationPrompt(product) {
  const id = product?.identification || {};
  const det = product?.details || {};
  const attrs = det.attributes || {};
  const attrList = Object.entries(attrs).map(([k, v]) => `${k}: ${v}`).join('\n  ');
  const price = det.pricing?.lowest_price?.amount || det.pricing?.sellPrice || null;
  const barcodes = (id.barcodes || []).join(', ');
  const categoryId = det.categoryId || det.ebayCategoryId || '';

  return `Du bist ein strenger E-Commerce-Qualitätsprüfer für eBay.de und Kaufland.de.
Deine Aufgabe: Fehler FINDEN und KORRIGIEREN. Sei kritisch — im Zweifel korrigieren, nicht durchlassen.
Antworte AUSSCHLIESSLICH mit dem JSON-Schema.

PRODUKT:
  ID: ${product.id}
  Titel: ${id.name || '(leer)'}
  Marke: ${id.brand || '(unbekannt)'}
  Kategorie: ${id.category || '(leer)'}
  eBay Category ID: ${categoryId}
  EAN/Barcodes: ${barcodes || '(keine)'}
  Preis (aktuell): ${price ? `${price} EUR` : '(kein Preis)'}
  Attribute (${Object.keys(attrs).length}):
  ${attrList || '(keine)'}

REGELN — STRENG PRÜFEN:

1. TITEL:
   - 70-80 Zeichen, eBay-optimiert, wahrheitsgemäß
   - Nur belegbare Fakten (Marke, Modell, Farbe, Größe, relevante Specs)
   - Keine Marketing-Floskeln, keine EAN/SKU, keine Sonderzeichen-Spam
   - Wenn Titel ok → ok=true, corrected=""

2. KATEGORIE — BESONDERS KRITISCH PRÜFEN:
   - Analysiere den Produktnamen Wort für Wort. Was IST dieses Produkt wirklich?
   - Passt JEDES Level des Kategorie-Breadcrumbs zum tatsächlichen Produkt?
   - Häufiger Fehler: Produkte werden in semantisch ähnliche aber FALSCHE Kategorien einsortiert.
     Beispiele: "Kugelhahn für Wärmezähler" ist KEIN Küchenartikel, sondern Heizungstechnik.
     "Anker Powerbank" gehört nicht in "Bootsport > Anker", sondern in Elektronik.
   - Frage dich: Wenn ein Käufer in dieser Kategorie auf eBay.de sucht, erwartet er DIESES Produkt?
   - Wenn die Kategorie LEER ist oder fehlt → ok=false. Du MUSST eine korrekte Kategorie vorschlagen.
   - Wenn die Kategorie auch nur ansatzweise nicht passt → ok=false + korrekte Kategorie vorschlagen.
   - Verwende echte eBay.de Kategorie-Pfade als Breadcrumb.
   - Im Zweifel IMMER korrigieren. Falsche Kategorie = Produkt wird nicht gefunden.

3. PREIS:
   - Schätze den Marktpreis im deutschsprachigen Raum (eBay, Amazon, idealo, etc.)
   - Empfehle einen konkurrenzfähigen Preis im UNTEREN Bereich
   - Wenn aktueller Preis im unteren Bereich liegt → ok=true

4. ATTRIBUTE:
   - Max 45 Attribute (eBay-Limit)
   - Keine Duplikate (gleicher Key mehrfach oder semantisch identisch)
   - Deutsche Keys (z.B. "Farbe", nicht "Color")
   - Keine leeren Werte, keine Marketplace-Keys (eBay/Kaufland)
   - Keine Barcodes als Attribute (EAN, GTIN, UPC gehören nicht zu Attributen)
   - Wenn alles ok → ok=true, corrected=[]

WICHTIG: Dein Ziel ist QUALITÄT. Lieber einmal zu viel korrigieren als einen Fehler durchlassen.`;
}

// ---------------------------------------------------------------------------
// Apply validation results to product
// ---------------------------------------------------------------------------

function applyValidationResult(product, result) {
  const next = JSON.parse(JSON.stringify(product));
  next.identification = next.identification || {};
  next.details = next.details || {};
  const changes = [];

  // 1. Title
  if (!result.title?.ok && result.title?.corrected) {
    const coerced = coerceTitleToPolicy(next, result.title.corrected, {
      minLen: 0,
      maxLen: 80,
      softMaxLen: 80,
      forcePolicy: false,
    });
    next.identification.name = coerced || result.title.corrected.slice(0, 80);
    changes.push('title');
  }

  // 2. Category
  // Force ok=false when category is empty — Gemini sometimes returns ok=true for missing categories
  const categoryMissing = !next.identification.category && !next.details.categoryId;
  const categoryNeedsfix = !result.category?.ok || categoryMissing;
  if (categoryNeedsfix) {
    if (result.category?.correctedPath) {
      next.identification.category = result.category.correctedPath;
      changes.push('category');
    }
    if (result.category?.correctedId) {
      next.details.categoryId = String(result.category.correctedId).replace(/\D+/g, '');
      if (!changes.includes('category')) changes.push('category');
    }
  }

  // 3. Price
  if (!result.price?.ok && result.price?.suggestedPrice > 0) {
    next.details.pricing = next.details.pricing || {};
    next.details.pricing.lowest_price = {
      ...(next.details.pricing.lowest_price || {}),
      amount: result.price.suggestedPrice,
      currency: 'EUR',
      source: 'validator',
      last_checked_iso: new Date().toISOString(),
    };
    changes.push('price');
  }

  // 4. Attributes
  if (!result.attributes?.ok && Array.isArray(result.attributes?.corrected) && result.attributes.corrected.length > 0) {
    const cleaned = {};
    const seen = new Set();
    for (const attr of result.attributes.corrected.slice(0, MAX_ATTRIBUTES)) {
      const key = String(attr.key || '').trim();
      const value = String(attr.value || '').trim();
      if (!key || !value) continue;
      if (isBlockedAttributeKey(key)) continue;
      const canonical = canonicalizeAttributeKey(key);
      const dedupeKey = canonical.toLowerCase();
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      // Skip barcode-like keys
      if (/^(ean|gtin|upc|barcode)/i.test(dedupeKey)) continue;
      // Skip marketplace keys
      if (/ebay|kaufland/i.test(dedupeKey)) continue;
      cleaned[canonical] = value.slice(0, 65);
    }
    if (Object.keys(cleaned).length > 0) {
      next.details.attributes = cleaned;
      changes.push('attributes');
    }
  }

  return { product: next, changes };
}

// ---------------------------------------------------------------------------
// Rule-based pre-check (instant, no LLM)
// ---------------------------------------------------------------------------

function runRuleCheck(product) {
  const issues = [];
  const det = product?.details || {};
  const id = product?.identification || {};
  const attrs = det.attributes || {};
  const attrKeys = Object.keys(attrs);

  // Title length
  const title = id.name || '';
  if (title.length < 20) issues.push('title_too_short');
  if (title.length > 80) issues.push('title_too_long');

  // Category missing
  if (!id.category && !det.categoryId) issues.push('category_missing');

  // Price missing
  const price = det.pricing?.lowest_price?.amount || det.pricing?.sellPrice;
  if (!price || price <= 0) issues.push('price_missing');

  // Attributes: duplicates
  const lowerKeys = new Set();
  for (const k of attrKeys) {
    const lower = k.toLowerCase().trim();
    if (lowerKeys.has(lower)) {
      issues.push('attribute_duplicate');
      break;
    }
    lowerKeys.add(lower);
  }

  // Attributes: over limit
  if (attrKeys.length > MAX_ATTRIBUTES) issues.push('attributes_over_limit');

  return issues;
}

// ---------------------------------------------------------------------------
// Validate single product
// ---------------------------------------------------------------------------

async function validateProduct(product) {
  const ruleIssues = runRuleCheck(product);

  // Run Gemini validation (structured JSON, no search, fast)
  const prompt = buildValidationPrompt(product);
  const result = await gemini3GenerateJSON({
    prompt,
    schema: VALIDATION_SCHEMA,
    model: 'gemini-3-flash-preview', // Fast model — no search needed
    temperature: 0.1,
    maxOutputTokens: 8192,
  });

  return {
    ruleIssues,
    validation: result,
  };
}

// ---------------------------------------------------------------------------
// Batch validate + auto-correct
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {string[]} opts.productIds - Product IDs to validate
 * @param {boolean} [opts.dryRun=false]
 * @param {Function} [opts.onProgress]
 * @returns {Promise<object>}
 */
async function runBatchValidate({
  productIds,
  dryRun = false,
  onProgress = null,
} = {}) {
  if (!Array.isArray(productIds) || !productIds.length) {
    throw new Error('productIds required');
  }

  const startedAt = Date.now();
  const results = [];
  let saved = 0;
  let errors = 0;
  let unchanged = 0;

  console.log(`[product-validator] Starting batch: ${productIds.length} products, dryRun=${dryRun}`);

  for (let i = 0; i < productIds.length; i++) {
    const pid = productIds[i];
    const logPrefix = `[product-validator] [${i + 1}/${productIds.length}]`;

    onProgress?.({ current: i + 1, total: productIds.length, productId: pid, status: 'validating' });

    try {
      const product = await getProduct(pid);
      if (!product) {
        results.push({ productId: pid, status: 'not_found' });
        errors++;
        continue;
      }

      const productName = product?.identification?.name || pid;
      console.log(`${logPrefix} Validating: ${productName}`);

      const { ruleIssues, validation } = await validateProduct(product);

      // Force category fix when category is missing — Gemini sometimes returns ok=true for empty categories
      const catMissing = !product.identification?.category && !product.details?.categoryId;
      if (catMissing && validation.category) {
        validation.category.ok = false;
      }

      // Check what needs fixing
      const needsFix =
        !validation.title?.ok ||
        !validation.category?.ok ||
        !validation.price?.ok ||
        !validation.attributes?.ok;

      if (!needsFix) {
        console.log(`${logPrefix} ✅ All checks passed`);
        unchanged++;
        results.push({
          productId: pid,
          productName,
          status: 'ok',
          ruleIssues,
          checks: {
            title: true,
            category: true,
            price: true,
            attributes: true,
          },
        });
        continue;
      }

      // Apply corrections
      const { product: corrected, changes } = applyValidationResult(product, validation);

      if (changes.length === 0) {
        unchanged++;
        results.push({ productId: pid, productName, status: 'ok', ruleIssues });
        continue;
      }

      if (dryRun) {
        console.log(`${logPrefix} 🔵 DRY-RUN would fix: ${changes.join(', ')}`);
        results.push({
          productId: pid,
          productName,
          status: 'dry_run',
          changes,
          ruleIssues,
          corrections: {
            title: validation.title?.ok ? null : { corrected: validation.title?.corrected, reason: validation.title?.reason },
            category: validation.category?.ok ? null : { corrected: validation.category?.correctedPath, reason: validation.category?.reason },
            price: validation.price?.ok ? null : { suggested: validation.price?.suggestedPrice, range: validation.price?.marketRange, reason: validation.price?.reason },
            attributes: validation.attributes?.ok ? null : { removed: validation.attributes?.removed, reason: validation.attributes?.reason },
          },
        });
        saved++;
      } else {
        await saveProductV2(corrected, { source: 'admin-bulk-validate', allowCategoryChange: true });
        console.log(`${logPrefix} ✅ Saved: ${changes.join(', ')}`);
        saved++;
        results.push({
          productId: pid,
          productName,
          status: 'corrected',
          changes,
          ruleIssues,
        });
      }

      onProgress?.({ current: i + 1, total: productIds.length, productId: pid, status: 'done', changes });

    } catch (err) {
      console.error(`${logPrefix} ❌ Error for ${pid}: ${err.message}`);
      errors++;
      results.push({ productId: pid, status: 'error', error: err.message?.slice(0, 300) });
    }

    // Rate limit
    if (i < productIds.length - 1) {
      await new Promise(r => setTimeout(r, DELAY_MS));
    }
  }

  const elapsedMs = Date.now() - startedAt;

  // Format matching bulk-job UI expectations:
  // job.result.summary → displayed in notice details
  // job.result.samples → shown as failedSamples if status=error
  const summary = {
    total: productIds.length,
    corrected: saved,
    unchanged,
    failed: errors,
    dryRun,
    elapsedMs,
    elapsedFormatted: `${Math.round(elapsedMs / 1000)}s`,
  };

  const samples = results.map(r => ({
    id: r.productId,
    sku: r.productName || r.productId,
    status: r.status === 'error' ? 'error' : 'ok',
    message: r.changes?.length
      ? `Korrigiert: ${r.changes.join(', ')}`
      : r.status === 'ok'
        ? 'Keine Korrekturen nötig'
        : r.error || r.status,
    changes: r.changes || [],
  }));

  console.log(`[product-validator] Done in ${summary.elapsedFormatted}: ${saved} corrected, ${unchanged} ok, ${errors} errors`);
  return { summary, samples };
}

module.exports = {
  validateProduct,
  runBatchValidate,
  applyValidationResult,
  runRuleCheck,
  buildValidationPrompt,
  MAX_ATTRIBUTES,
};

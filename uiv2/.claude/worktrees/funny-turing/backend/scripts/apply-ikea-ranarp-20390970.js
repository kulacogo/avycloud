/* eslint-disable no-console */
/**
 * Apply official IKEA product data for:
 * - RANARP Hängeleuchte, elfenbeinweiß, 38 cm
 * - Artikelnummer: 203.909.70
 * Source: https://www.ikea.com/de/de/p/ranarp-haengeleuchte-elfenbeinweiss-20390970/
 *
 * Usage:
 *   NODE_PATH=backend/node_modules GOOGLE_CLOUD_PROJECT=avycloud node backend/scripts/apply-ikea-ranarp-20390970.js --sku SKU-8310896573 --apply
 *
 * Default is dry-run (no write) unless --apply is provided.
 */

const { getAllProducts, saveProduct } = require('../lib/firestore');
const { coerceTitleToPolicy, inferTitleCategory, validateTitleToPolicy } = require('../lib/title-policy');
const { getRulebookConfigCached } = require('../lib/rulebook-config');

const SOURCE_URL = 'https://www.ikea.com/de/de/p/ranarp-haengeleuchte-elfenbeinweiss-20390970/';
const IKEA_ARTICLE_NUMBER = '203.909.70';

const safeString = (v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function mergeAttributes(base = {}, patch = {}) {
  const out = { ...(base && typeof base === 'object' ? base : {}) };
  Object.entries(patch || {}).forEach(([k, v]) => {
    if (!k) return;
    const val = v == null ? '' : String(v).trim();
    if (!val) return;
    out[k] = val;
  });
  return out;
}

function buildIkeaPatch() {
  // Only factual data from the IKEA page.
  return {
    identification: {
      brand: 'IKEA',
    },
    details: {
      identifiers: {
        // We treat IKEA Artikelnummer as manufacturer part number.
        mpn: IKEA_ARTICLE_NUMBER,
      },
      short_description: 'Gerichtetes Licht; gut zum Beleuchten von Esstisch oder Frühstücksbar.',
      attributes: {
        Marke: 'IKEA',
        Hersteller: 'IKEA',
        Produktart: 'Hängeleuchte',
        Modell: 'RANARP',
        Farbe: 'elfenbeinweiß',
        // Keep title tokens compact (avoid parentheses).
        Material: 'Stahl pulverbeschichtet',
        'Durchmesser': '38 cm',
        'Kabellänge': '1.6 m',
        Leistung: 'max. 22 W',
        Fassung: 'E27 (IKEA Empfehlung: LED-Lampe E27)',
        Merkmal: 'Messingdetails, Textilkabel',
        // Keep application short; long commentary in parentheses gets removed anyway.
        Anwendung: 'Esstisch/Frühstücksbar',
      },
      pricing: {
        lowest_price: {
          amount: 29.99,
          currency: 'EUR',
          sources: [
            {
              name: 'IKEA',
              url: SOURCE_URL,
              price: 29.99,
              shipping: null,
              checked_at: new Date().toISOString(),
            },
          ],
          last_checked_iso: new Date().toISOString(),
        },
        price_confidence: 0.9,
      },
      sources: [
        {
          kind: 'manufacturer',
          name: 'IKEA',
          url: SOURCE_URL,
          note: `Artikelnummer ${IKEA_ARTICLE_NUMBER}`,
          fetched_at: new Date().toISOString(),
        },
      ],
    },
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const sku = safeString(args.sku || 'SKU-8310896573');
  const apply = Boolean(args.apply);

  const products = await getAllProducts();
  const product =
    (products || []).find(
      (p) =>
        safeString(p?.identification?.sku) === sku || safeString(p?.details?.identifiers?.sku) === sku
    ) || null;

  if (!product) {
    console.error(JSON.stringify({ error: 'product_not_found', sku, total: (products || []).length }, null, 2));
    process.exit(1);
  }

  const patch = buildIkeaPatch();
  const next = {
    ...product,
    identification: {
      ...(product.identification || {}),
      ...(patch.identification || {}),
    },
    details: {
      ...(product.details || {}),
      ...(patch.details || {}),
      identifiers: {
        ...(product.details?.identifiers || {}),
        ...(patch.details?.identifiers || {}),
      },
      attributes: mergeAttributes(product.details?.attributes || {}, patch.details?.attributes || {}),
      sources: Array.isArray(product.details?.sources)
        ? [...product.details.sources, ...(patch.details?.sources || [])]
        : patch.details?.sources || [],
    },
    ops: {
      ...(product.ops || {}),
      last_manual_enrich_iso: new Date().toISOString(),
    },
  };

  // Compute a deterministic policy title with current rulebook bucket lengths
  const cfg = getRulebookConfigCached();
  const bucket = inferTitleCategory(next);
  const rule = (cfg?.title?.rulesBySchema && cfg.title.rulesBySchema[bucket]) || cfg?.title || {};
  const minLen = Number(rule?.minLen || 65);
  const maxLen = Number(rule?.maxLen || 80);
  const mobileMaxLen = Number(rule?.mobileMaxLen || 60);
  const softMaxLen = Number(rule?.softMaxLen || 75);

  // Use a deterministic, template-like seed so the output matches Titel_Regeln.csv ordering:
  // [Produktart] [Material/Merkmal] [Maße/Menge] [Anwendung] [Marke]
  const attrs = next?.details?.attributes && typeof next.details.attributes === 'object' ? next.details.attributes : {};
  const seedTitle = [
    attrs.Produktart,
    attrs.Material,
    attrs.Durchmesser,
    attrs.Anwendung,
    next?.identification?.brand,
  ]
    .map((x) => safeString(x))
    .filter(Boolean)
    .join(' ');

  const coercedTitle = coerceTitleToPolicy(next, seedTitle || safeString(next?.identification?.name), {
    minLen,
    maxLen,
    softMaxLen,
  });

  const titleIssues = validateTitleToPolicy(next, coercedTitle, { minLen, maxLen, mobileMaxLen });

  const preview = {
    sku,
    product_id: next.id,
    bucket,
    apply,
    patch: {
      brand: next.identification?.brand,
      mpn: next.details?.identifiers?.mpn,
      short_description: next.details?.short_description,
      attributes: Object.fromEntries(
        Object.entries(next.details?.attributes || {}).filter(([k]) =>
          [
            'Marke',
            'Hersteller',
            'Produktart',
            'Modell',
            'Farbe',
            'Material',
            'Durchmesser',
            'Kabellänge',
            'Leistung',
            'Fassung',
            'Merkmal',
            'Anwendung',
          ].includes(k)
        )
      ),
      pricing: next.details?.pricing?.lowest_price,
      sources_tail: Array.isArray(next.details?.sources) ? next.details.sources.slice(-2) : [],
    },
    title: {
      current: safeString(product?.identification?.name),
      coerced: coercedTitle,
      coercedLen: coercedTitle.length,
      issues: titleIssues,
    },
  };

  console.log(JSON.stringify(preview, null, 2));

  if (!apply) {
    console.log('Dry-run only. Pass --apply to persist.');
    return;
  }

  // Persist: also store coerced title as the product name (single source in UI)
  next.identification = { ...(next.identification || {}), name: coercedTitle };
  await saveProduct(next, { source: 'ikea-manual' });
  console.log('Saved.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});


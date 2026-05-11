/* eslint-disable no-console */
/**
 * D.0b-Migration 2026-05-10: Migrated to getAllProductsForTenant().
 * See /Users/oguz/.claude/plans/sieht-ziemlich-komplex-unstrukturiert-woolly-tulip.md (Phase D.0)
 * D.0b-Migration: Default to avycloud. Override via TENANT_ID env var.
 */
/**
 * Recategorize products that are currently assigned to DISALLOWED eBay category roots.
 *
 * Strict rule: these roots must not be used in AvyCloud.
 * This script moves affected products to a plausible, allowed eBay category (best-effort, deterministic rules),
 * and writes via saveProduct(..., { allowCategoryChange: true }).
 *
 * Usage:
 *   node backend/scripts/recategorize-disallowed-ebay-roots.js --dry-run
 *   node backend/scripts/recategorize-disallowed-ebay-roots.js --apply --expected-count 774
 */

const { findEbayCategory } = require('../lib/ebay-taxonomy');
const { getAllProductsForTenant, saveProduct } = require('../lib/firestore');

// D.0b-Hardening 2026-05-11: mandatory TENANT_ID for write scripts (prevents silent cross-tenant writes)
const TENANT_ID = process.env.TENANT_ID;
if (!TENANT_ID) {
  console.error('TENANT_ID env var required. Example: TENANT_ID=avycloud node <script>.js');
  process.exit(1);
}
console.warn(`[D.0b-Hardening] Running for tenantId='${TENANT_ID}'.`);
const {
  BANNED_EBAY_CATEGORY_ROOTS,
  isBannedEbayBreadcrumb,
  getEbayCategoryBreadcrumbRoot,
} = require('../lib/ebay-category-governance');

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function normalize(text = '') {
  return safeString(text)
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[\u2010-\u2015-]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksLikeIsbn13(ean = '') {
  const digits = safeString(ean).replace(/[^\d]/g, '');
  if (digits.length !== 13) return false;
  return digits.startsWith('978') || digits.startsWith('979');
}

function isBannedCategoryId(categoryId = '') {
  const cat = findEbayCategory(safeString(categoryId));
  const breadcrumb = safeString(cat?.breadcrumb);
  if (!breadcrumb) return false;
  return isBannedEbayBreadcrumb(breadcrumb);
}

function validateAllowedCategoryId(categoryId = '') {
  const id = safeString(categoryId);
  if (!id) return { ok: false, reason: 'empty' };
  const cat = findEbayCategory(id);
  const breadcrumb = safeString(cat?.breadcrumb);
  if (!breadcrumb) return { ok: false, reason: 'unknown_id' };
  if (isBannedEbayBreadcrumb(breadcrumb)) {
    return { ok: false, reason: `banned_root:${getEbayCategoryBreadcrumbRoot(breadcrumb)}` };
  }
  return { ok: true, breadcrumb, root: getEbayCategoryBreadcrumbRoot(breadcrumb) };
}

function pickReplacementCategoryId(product) {
  const name = safeString(product?.identification?.name);
  const brand = safeString(product?.identification?.brand);
  const ids = product?.details?.identifiers || {};
  const attrs = product?.details?.attributes && typeof product.details.attributes === 'object' ? product.details.attributes : {};

  const ean = safeString(ids.ean) || safeString(ids.gtin) || safeString(ids.upc) || '';
  const productType = safeString(attrs.Produktart || attrs.Produkttyp || attrs['Produkttyp (Produktart)'] || '');
  const model = safeString(attrs.Modell || attrs.Model || attrs['Model Number'] || '');
  const hint = normalize(`${brand} ${name} ${productType} ${model}`);

  // Books (ISBN)
  if (looksLikeIsbn13(ean) || /\b(hardcover|gebundene ausgabe|taschenbuch|isbn)\b/i.test(`${name} ${productType}`)) {
    return '261186'; // Bücher & Zeitschriften > Bücher
  }

  // PC power supplies
  if (/\b(pc|computer)\b/.test(hint) && /\bnetzteil\b/.test(hint)) {
    return '42017'; // Computer-Komponenten & -Teile > Netzteile
  }

  // Vacuums / floor cleaners
  if (/\b(tineco)\b/.test(hint) || /\b(staubsauger|bodenreiniger|hartbodenreiniger|wisch)\b/.test(hint)) {
    return '20614'; // Haushaltsgeräte > Staubsauger & Zubehör > Staubsauger
  }

  // Hedge trimmers
  if (/\bheckenschere(n)?\b/.test(hint)) {
    return '71268'; // Garten & Terrasse > ... > Heckenscheren
  }

  // Glassware
  if (/\b(glas|glaeser|glaeser-set|trinkglas|wasserglaeser)\b/.test(hint)) {
    return '20696'; // Möbel & Wohnen > Kochen & Genießen > Gläser & Glaswaren
  }

  // Tablecloths
  if (/(tischdecke|tischdecken)/.test(hint)) {
    return '20663'; // Möbel & Wohnen > Kochen & Genießen > Gedeckter Tisch > Tischdecken
  }

  // Inhalators / nebulizers
  if (/\b(inhalator|vernebler)\b/.test(hint)) {
    return '155667'; // Beauty & Gesundheit > ... > Inhalatoren
  }

  // Baby changing pads
  if (/\bwickel(auflage|unterlage|auflagen)\b/.test(hint) || /\bwickel\b/.test(hint)) {
    return '66674'; // Baby > Möbel > Wickeltische & Zubehör > Auflagen
  }

  // Safety vests
  if (/\bwarnweste(n)?\b/.test(hint)) {
    return '99404'; // Auto & Motorrad: Teile > ... > Sicherheitsjacken & -westen
  }

  // Work gloves
  if (
    (hint.includes('handschuh') && (hint.includes('arbeit') || hint.includes('arbeits'))) ||
    /\barbeit(s)?handschuh/.test(hint)
  ) {
    return '43616'; // Heimwerker > ... > Handschuhe & Kniepolster
  }

  // SodaStream / CO2 cylinders (consumer-safe fallback category)
  if (/(sodastream|kohlensaeure|co2)/.test(hint) && /(zylinder|flasche)/.test(hint)) {
    return '54146'; // Möbel & Wohnen > ... > Trinkwassersprudler > Sonstige
  }

  // Solar/offgrid busbars (fallback into solar accessories)
  if (/\b(sammelschiene|bus\\s*bar|busbar)\b/.test(hint) || /\bsolaranlagen?\b/.test(hint)) {
    return '259288'; // Heimwerker > Erneuerbare Energie > Solarenergie > Solarenergie-Zubehör
  }

  // Single-board computers / Raspberry Pi (no perfect non-B&I category exists; use safe "Sonstige Komponenten")
  if (/\bras(p)?berry\b/.test(hint) || /\beinplatinen\b/.test(hint)) {
    return '16145'; // Computer-Komponenten & -Teile > Sonstige
  }

  // Microphone stands
  if (hint.includes('mikrofon') && (hint.includes('staender') || hint.includes('stander') || hint.includes('stativ'))) {
    return '29948'; // Musikinstrumente > Pro-Audio Equipment > Ständer & Stützen
  }

  // Hoverboards / balance boards
  if (/\bhoverboard\b/.test(hint) || /\bbalance\\s*board\b/.test(hint)) {
    return '47349'; // Sport > Funsport > Elektro-Scooter
  }

  // Chafing dishes / food warmers (non-B&I fallback)
  if (/\b(chafing|speisenwaermer|speisewaermer|bain\\s*marie|warmhalte)\b/.test(hint)) {
    return '20685'; // Haushaltsgeräte > Kleingeräte Küche > Sonstige
  }

  // Gastronorm containers (B&I-only leaf exists; pick consumer storage containers)
  if (/\bgastronorm\b/.test(hint)) {
    return '20654'; // Möbel & Wohnen > ... > Vorratsgefäße & -gläser
  }

  // Blazers (B&I has direct category, but it's disallowed; pick "Damen Anzüge & Anzugteile")
  if (/\bblazer\b/.test(hint)) {
    return '63865'; // Kleidung & Accessoires > Damen > Damenmode > Anzüge & Anzugteile
  }

  // Winches / cable pullers
  if (/\b(seilzug|handseilzug|seilwinde|winde|winden)\b/.test(hint)) {
    return '66796'; // Heimwerker > Werkzeuge > Handwerkzeuge > Winden
  }

  return '';
}

function parseArgs(argv) {
  const args = {
    dryRun: true,
    apply: false,
    expectedCount: 774,
    limit: 0,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--apply') {
      args.apply = true;
      args.dryRun = false;
    }
    if (t === '--dry-run') {
      args.dryRun = true;
      args.apply = false;
    }
    if (t === '--expected-count') {
      args.expectedCount = Number(argv[i + 1]);
      i += 1;
    }
    if (t === '--limit') {
      args.limit = Number(argv[i + 1]);
      i += 1;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  console.log(`[recategorize-disallowed-roots] mode=${args.apply ? 'APPLY' : 'DRY_RUN'}`);
  console.log(`[recategorize-disallowed-roots] bannedRoots=${BANNED_EBAY_CATEGORY_ROOTS.join(' | ')}`);

  const products = await getAllProductsForTenant(TENANT_ID);
  const preCount = products.length;
  console.log(`[recategorize-disallowed-roots] preCount=${preCount}`);
  if (args.apply && preCount !== Number(args.expectedCount || 0)) {
    throw new Error(`[recategorize-disallowed-roots] ABORT expectedCount=${args.expectedCount} got=${preCount}`);
  }

  const targetsAll = products.filter((p) => {
    const id = safeString(p?.details?.categoryId);
    if (!id) return false;
    if (!isBannedCategoryId(id)) return false;
    return true;
  });

  const targets = args.limit > 0 ? targetsAll.slice(0, args.limit) : targetsAll;
  console.log(`[recategorize-disallowed-roots] targets=${targetsAll.length} processing=${targets.length}`);

  const report = [];
  let updated = 0;
  let skipped = 0;

  for (const product of targets) {
    const sku = safeString(product?.identification?.sku) || safeString(product?.details?.identifiers?.sku) || safeString(product?.id);
    const currentId = safeString(product?.details?.categoryId);
    const current = safeString(findEbayCategory(currentId)?.breadcrumb);

    const nextId = pickReplacementCategoryId(product);
    const validation = validateAllowedCategoryId(nextId);
    if (!validation.ok) {
      skipped += 1;
      report.push({
        sku,
        productId: safeString(product?.id),
        status: 'skip',
        reason: validation.reason || 'no_replacement',
        currentId,
        current,
        proposedId: safeString(nextId) || null,
      });
      continue;
    }

    report.push({
      sku,
      productId: safeString(product?.id),
      status: args.apply ? 'update' : 'would_update',
      currentId,
      current,
      proposedId: safeString(nextId),
      proposed: validation.breadcrumb,
      proposedRoot: validation.root,
    });

    if (!args.apply) continue;

    const next = JSON.parse(JSON.stringify(product));
    next.details = next.details || {};
    next.details.categoryId = safeString(nextId);
    next.ops = next.ops || {};
    next.ops.data_quality = {
      ...(next.ops.data_quality || {}),
      category_disallowed_root_repaired_v1: {
        at_iso: new Date().toISOString(),
        from: current || null,
        to: validation.breadcrumb || null,
        fromId: currentId || null,
        toId: safeString(nextId) || null,
      },
    };
    await saveProduct(next, { source: 'recategorize-disallowed-roots', allowCategoryChange: true });
    updated += 1;
  }

  const summary = {
    preCount,
    targets: targetsAll.length,
    processed: targets.length,
    would_update: report.filter((r) => r.status === 'would_update').length,
    update: report.filter((r) => r.status === 'update').length,
    skip: report.filter((r) => r.status === 'skip').length,
    skipReasons: {},
  };
  report
    .filter((r) => r.status === 'skip')
    .forEach((r) => {
      summary.skipReasons[r.reason] = (summary.skipReasons[r.reason] || 0) + 1;
    });

  console.log(`[recategorize-disallowed-roots] summary update=${updated} skip=${skipped}`);
  console.log(JSON.stringify(summary, null, 2));
  if (!args.apply) {
    const skips = report.filter((r) => r.status === 'skip');
    if (skips.length) {
      console.log('[recategorize-disallowed-roots] skip_samples:');
      console.log(JSON.stringify(skips.slice(0, 50), null, 2));
    }
  }

  // Final safety check (apply mode): ensure no product remains in banned roots.
  if (args.apply) {
    const after = await getAllProductsForTenant(TENANT_ID);
    const stillBanned = after.filter((p) => isBannedCategoryId(safeString(p?.details?.categoryId)));
    console.log(`[recategorize-disallowed-roots] stillBanned=${stillBanned.length}`);
    if (stillBanned.length) {
      console.log(
        JSON.stringify(
          stillBanned.slice(0, 30).map((p) => ({
            sku: safeString(p?.identification?.sku) || safeString(p?.details?.identifiers?.sku) || safeString(p?.id),
            id: safeString(p?.id),
            categoryId: safeString(p?.details?.categoryId),
            breadcrumb: safeString(findEbayCategory(safeString(p?.details?.categoryId))?.breadcrumb),
          })),
          null,
          2
        )
      );
      throw new Error('[recategorize-disallowed-roots] Some products still have disallowed roots after apply.');
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


/* eslint-disable no-console */
/**
 * Generate draft Category Profiles (per eBay categoryId) from an existing attribute audit file.
 *
 * This does NOT hard-restrict attributes. It only proposes:
 * - canonicalAttributes: a non-exhaustive list of "preferred keys" (required aspects + common keys)
 * - attributeAliases: alias -> canonical to prevent duplicate-purpose keys from being created
 *
 * Usage:
 *   node backend/scripts/generate-category-profiles-draft-from-audit.js \
 *     --audit exports/reconciliation/attribute-keys-audit_YYYYMMDD-HHMMSS.json
 *
 * Optional:
 *   --out exports/reconciliation/category-profiles-draft_YYYYMMDD-HHMMSS.json
 */

const fs = require('fs');
const path = require('path');

const ASPECTS_BY_CATEGORY = require('../ebay-data/required-aspects.json');

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function parseArgs(argv) {
  const args = { audit: null, out: null, limitCategories: null };
  for (let i = 2; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--audit') {
      args.audit = argv[i + 1];
      i += 1;
    } else if (t === '--out') {
      args.out = argv[i + 1];
      i += 1;
    } else if (t === '--limit-categories') {
      const n = Number(argv[i + 1]);
      if (Number.isFinite(n) && n > 0) args.limitCategories = Math.floor(n);
      i += 1;
    }
  }
  return args;
}

function isAttributeKey(key) {
  const k = safeString(key);
  if (!k) return false;
  // Keep only real attribute keys (exclude gpsr.* and identifiers.* from alias mapping)
  if (k.startsWith('gpsr.')) return false;
  if (k.startsWith('identifiers.')) return false;
  return true;
}

function normalizeKeyForMap(key) {
  return safeString(key).replace(/\s+/g, ' ').trim();
}

function pickStableCommonKeys() {
  // Non-exhaustive "common" keys we want to keep consistent across categories.
  return [
    'Marke',
    'Hersteller',
    'Produktart',
    'Zustand',
    'Farbe',
    'Material',
    'Modell',
    'Herstellernummer',
    'Referenznummer(n) OEM',
    'K-Typ',
    'Gewicht (kg)',
    'Spülmaschinengeeignet',
    'Verwendungszweck',
  ];
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.audit) {
    throw new Error('Missing --audit <path-to-attribute-keys-audit.json>');
  }
  const auditPath = path.isAbsolute(args.audit) ? args.audit : path.join(process.cwd(), args.audit);
  const raw = JSON.parse(fs.readFileSync(auditPath, 'utf8'));

  const usedCategoryIds = Array.isArray(raw.used_category_ids) ? raw.used_category_ids.map(String) : [];
  const categories = args.limitCategories ? usedCategoryIds.slice(0, args.limitCategories) : usedCategoryIds;

  // Build lookup: key -> stats (includes categories counts)
  const keyStats = {};
  (Array.isArray(raw.keys) ? raw.keys : []).forEach((k) => {
    if (!k || typeof k !== 'object') return;
    const key = safeString(k.key);
    if (!key) return;
    keyStats[key] = k;
  });

  // Proposed cluster mapping from audit (cluster -> canonical + aliases)
  const proposed = Array.isArray(raw.proposed_canonical_by_cluster) ? raw.proposed_canonical_by_cluster : [];

  // For each category: build alias map from clusters that actually appear in that category.
  const profiles = {};
  const commonKeys = pickStableCommonKeys();

  for (const categoryId of categories) {
    const required = Array.isArray(ASPECTS_BY_CATEGORY?.[String(categoryId)])
      ? ASPECTS_BY_CATEGORY[String(categoryId)].map(safeString).filter(Boolean)
      : [];

    const canonicalAttributes = Array.from(new Set([...required, ...commonKeys])).filter(Boolean);

    const attributeAliases = {};
    for (const cluster of proposed) {
      const canonical = safeString(cluster?.canonical);
      const aliases = Array.isArray(cluster?.aliases) ? cluster.aliases.map(safeString).filter(Boolean) : [];
      if (!canonical || !aliases.length) continue;
      if (!isAttributeKey(canonical)) continue;

      // Only include if canonical appears in this category OR is a required aspect for this category.
      const canonicalAppears = Boolean(keyStats[canonical]?.categories?.[String(categoryId)]);
      const canonicalRequired = required.some((r) => r.toLowerCase() === canonical.toLowerCase());
      if (!canonicalAppears && !canonicalRequired) continue;

      for (const alias of aliases) {
        if (!alias) continue;
        if (!isAttributeKey(alias)) continue;
        // Only include alias if it appears in this category.
        const aliasAppears = Boolean(keyStats[alias]?.categories?.[String(categoryId)]);
        if (!aliasAppears) continue;
        const a = normalizeKeyForMap(alias);
        const c = normalizeKeyForMap(canonical);
        if (!a || !c) continue;
        if (a === c) continue;
        // Don't overwrite existing mapping; first-win keeps it stable.
        if (attributeAliases[a]) continue;
        attributeAliases[a] = c;
      }
    }

    profiles[String(categoryId)] = {
      id: String(categoryId),
      enabled: false, // drafts start disabled; enable after review
      canonicalAttributes,
      attributeAliases,
      notes: `Draft generated from ${path.basename(auditPath)}; non-exhaustive canonical list; aliases prevent duplicate-purpose keys.`,
      updatedAtIso: new Date().toISOString(),
    };
  }

  const outDir = path.join(process.cwd(), 'exports', 'reconciliation');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = nowStamp();
  const outPath = args.out
    ? (path.isAbsolute(args.out) ? args.out : path.join(process.cwd(), args.out))
    : path.join(outDir, `category-profiles-draft_${stamp}.json`);

  const payload = {
    at_iso: new Date().toISOString(),
    audit_source: auditPath,
    category_count: Object.keys(profiles).length,
    profiles,
  };

  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');
  console.log('[category-profiles-draft] wrote:', outPath);
  console.log(JSON.stringify({ categories: Object.keys(profiles).length }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


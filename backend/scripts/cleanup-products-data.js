/* eslint-disable no-console */
/**
 * Safe cleanup for Firestore `products` documents.
 *
 * Invariants:
 * - NEVER create or delete product documents.
 * - Only update existing docs via update() / BulkWriter.update().
 * - Preserve inventory/storage fields (not touched).
 * - Ensure product count remains unchanged (guardrails in apply mode).
 *
 * What this script does (SAFE phase):
 * - Removes placeholder/template/price sentences from stored descriptions.
 * - Deletes legacy `details.description` if it's placeholder/template; may migrate it into `details.short_description`.
 * - Cleans highlights (removes price/packaging placeholders; dedupe).
 * - Moves technical/meta attribute keys out of `details.attributes` into `details.attributes_extra`.
 * - Moves attribute key "SKU" (and obvious ID keys) to attributes_extra (prevents wrong SKU in params).
 * - Records a minimal data quality marker under ops.data_quality.last_cleanup_iso and ops.data_quality.cleanup_v1.
 *
 * Usage:
 *   node backend/scripts/cleanup-products-data.js --dry-run
 *   node backend/scripts/cleanup-products-data.js --apply
 *
 * Output:
 *   exports/cleanup/<timestamp>/(dryrun_report.json|dryrun_summary.json|apply_report.json)
 */

const fs = require('fs');
const path = require('path');
const { Firestore, FieldValue } = require('@google-cloud/firestore');

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || 'avycloud';
const firestore = new Firestore({ projectId: PROJECT_ID });

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function normalizeSpaces(v) {
  return safeString(v).replace(/\s+/g, ' ').trim();
}

// Detect common placeholder / unwanted phrases from UI + earlier pipelines
const PLACEHOLDER_RE = /(beschreibung folgt|unbekanntes produkt|für dieses produkt liegt noch keine ausführliche beschreibung vor|^produkt\s*\d+\s*[–-]\s*beschreibung folgt|^ürün\s*\d+\s*[–-]\s*beschreibung folgt)/i;
const UI_TEMPLATE_RE = /bringt moderne küchentechnik und komfortable bedienung zusammen\.?/i;
const PRICE_RE = /(?:€|\beur\b|\bpreis(?:orientierung|empfehlung|:)?\b|\bprice\b)/i;

const PACKAGING_RE = /(etikett|karton|verpackung|sichtbar)/i;

function splitSentences(text) {
  // Best-effort sentence split (keeps punctuation).
  return (text.match(/[^.!?]+[.!?]?/g) || []).map((s) => s.trim()).filter(Boolean);
}

function cleanTextBlock(text) {
  if (typeof text !== 'string') return '';
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!normalized) return '';

  // Drop entire text if it's clearly placeholder
  if (PLACEHOLDER_RE.test(normalized)) {
    // Might still contain useful text in multi-sentence strings; don't blanket drop yet.
    // We'll filter sentence-wise below.
  }

  const paras = normalized.split(/\n\s*\n/);
  const cleanedParas = [];

  for (const para of paras) {
    const sentences = splitSentences(para);
    const kept = [];
    for (const sentence of sentences) {
      const s = normalizeSpaces(sentence);
      if (!s) continue;
      if (PLACEHOLDER_RE.test(s)) continue;
      if (UI_TEMPLATE_RE.test(s)) continue;
      if (PRICE_RE.test(s)) continue;
      kept.push(s);
    }
    const rebuilt = normalizeSpaces(kept.join(' '));
    if (rebuilt) cleanedParas.push(rebuilt);
  }

  return cleanedParas.join('\n\n').trim();
}

function isPlaceholderLike(text) {
  const t = safeString(text);
  if (!t) return true;
  if (PLACEHOLDER_RE.test(t)) return true;
  if (UI_TEMPLATE_RE.test(t)) return true;
  return false;
}

function cleanHighlights(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const v = normalizeSpaces(raw);
    if (!v) continue;
    if (v.length < 8) continue;
    if (PLACEHOLDER_RE.test(v)) continue;
    if (UI_TEMPLATE_RE.test(v)) continue;
    if (PRICE_RE.test(v)) continue;
    if (PACKAGING_RE.test(v)) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isMetaAttributeKey(key) {
  const k = String(key || '').trim();
  if (!k) return false;
  const lower = k.toLowerCase();
  if (lower === 'sku' || lower === 'product_id' || lower === 'product id' || lower === 'id') return true;
  if (lower.includes('|de|')) return true;
  if (lower.startsWith('text_')) return true;
  if (lower.startsWith('features|')) return true;
  if (/_id$/i.test(k)) return true;
  if (lower.includes('ebay') || lower.includes('kaufland')) return true;
  if (lower.includes('category_id') || lower.includes('categoryid')) return true;
  return false;
}

const PLACEHOLDER_ATTR_VALUES = [
  'not provided, eu',
  'info@example.com',
  'info@example.example.com',
  'info@example.de',
  'example.com',
  'n/a',
  'na',
  'unknown',
  'unbekannt',
];

function isPlaceholderValue(value) {
  if (value === null || value === undefined) return false;
  const v = safeString(value).toLowerCase();
  if (!v) return true;
  return PLACEHOLDER_ATTR_VALUES.some((p) => v === p || v.includes(p));
}

function moveToExtra(extra, key, value) {
  const out = isPlainObject(extra) ? { ...extra } : {};
  const rawKey = String(key || '').trim();
  if (!rawKey) return out;
  if (!Object.prototype.hasOwnProperty.call(out, rawKey)) {
    out[rawKey] = value;
    return out;
  }
  // avoid overwriting: store under a namespaced key
  let idx = 1;
  while (idx < 50) {
    const alt = `_moved_${idx}:${rawKey}`;
    if (!Object.prototype.hasOwnProperty.call(out, alt)) {
      out[alt] = value;
      break;
    }
    idx += 1;
  }
  return out;
}

function computePatch(product) {
  const updates = {};
  const flags = [];
  const notes = [];

  const details = isPlainObject(product?.details) ? product.details : {};
  const attrs = isPlainObject(details?.attributes) ? details.attributes : {};
  const extra = isPlainObject(details?.attributes_extra) ? details.attributes_extra : {};

  // --- Text fields ---
  const shortRaw = typeof details.short_description === 'string' ? details.short_description : '';
  const descRaw = typeof details.description === 'string' ? details.description : '';
  const shortHasBanned =
    Boolean(shortRaw) && (PLACEHOLDER_RE.test(shortRaw) || UI_TEMPLATE_RE.test(shortRaw) || PRICE_RE.test(shortRaw));
  const descHasBanned =
    Boolean(descRaw) && (PLACEHOLDER_RE.test(descRaw) || UI_TEMPLATE_RE.test(descRaw) || PRICE_RE.test(descRaw));

  if (shortHasBanned) flags.push('short_description_had_banned_content');
  if (descHasBanned) flags.push('description_had_banned_content');

  const shortClean = shortHasBanned ? cleanTextBlock(shortRaw) : shortRaw.trim();
  const descClean = descHasBanned ? cleanTextBlock(descRaw) : descRaw.trim();

  // Migration rule (conservative):
  // Only migrate legacy `details.description` -> `details.short_description` when:
  // - short_description is missing or placeholder-like
  // - and description contains usable content after cleaning (>= 120 chars)
  // This avoids rewriting good descriptions unnecessarily.
  const shortMissingOrPlaceholder = !shortRaw || isPlaceholderLike(shortRaw);
  const descUsable = descClean.length >= 120 && !isPlaceholderLike(descClean);

  if (shortMissingOrPlaceholder && descUsable) {
    updates['details.short_description'] = descClean;
    updates['details.description'] = FieldValue.delete();
    flags.push('migrated_description_to_short_description');
  } else {
    // Only touch stored text if it actually had banned content.
    if (shortHasBanned) {
      if (!shortClean || isPlaceholderLike(shortClean)) {
        updates['details.short_description'] = FieldValue.delete();
        flags.push('deleted_short_description_placeholder');
      } else if (shortClean !== shortRaw.trim()) {
        updates['details.short_description'] = shortClean;
        flags.push('cleaned_short_description');
      }
    }

    if (descHasBanned) {
      if (!descClean || isPlaceholderLike(descClean)) {
        updates['details.description'] = FieldValue.delete();
        flags.push('deleted_description_placeholder');
      } else if (descClean !== descRaw.trim()) {
        updates['details.description'] = descClean;
        flags.push('cleaned_description');
      }
    } else if (descRaw && isPlaceholderLike(descRaw)) {
      // Defensive: delete legacy description if it is clearly placeholder-like, even if regex didn't catch it.
      updates['details.description'] = FieldValue.delete();
      flags.push('deleted_description_placeholder');
    }
  }

  // --- Highlights ---
  const keyFeaturesRaw = details?.key_features;
  const cleanedHighlights = cleanHighlights(keyFeaturesRaw);
  if (cleanedHighlights && Array.isArray(keyFeaturesRaw)) {
    const rawNorm = keyFeaturesRaw.map((x) => (typeof x === 'string' ? normalizeSpaces(x) : '')).filter(Boolean);
    const sameLen = rawNorm.length === cleanedHighlights.length;
    const sameOrder = sameLen && rawNorm.every((v, i) => v === cleanedHighlights[i]);
    if (!sameOrder) {
      updates['details.key_features'] = cleanedHighlights;
      flags.push('cleaned_highlights');
    }
  }

  // --- Attributes map cleanup ---
  let nextAttrs = { ...(attrs || {}) };
  let nextExtra = { ...(extra || {}) };
  const removedKeys = [];

  for (const [k, v] of Object.entries(attrs || {})) {
    const key = String(k || '').trim();
    if (!key) {
      delete nextAttrs[k];
      continue;
    }
    const lower = key.toLowerCase();

    // Remove obvious meta keys and the SKU-leak attribute key.
    if (isMetaAttributeKey(key) || lower === 'sku') {
      nextExtra = moveToExtra(nextExtra, key, v);
      delete nextAttrs[k];
      removedKeys.push(key);
      continue;
    }

    // Move non-primitive values out to keep UI stable.
    if (v && typeof v === 'object') {
      nextExtra = moveToExtra(nextExtra, key, v);
      delete nextAttrs[k];
      removedKeys.push(key);
      continue;
    }

    // Remove placeholder values (but keep in extra for forensics)
    if (isPlaceholderValue(v)) {
      nextExtra = moveToExtra(nextExtra, key, v);
      delete nextAttrs[k];
      removedKeys.push(key);
      continue;
    }
  }

  // If we removed keys or changed attrs materially, update both maps.
  const attrsChanged = removedKeys.length > 0 || Object.keys(nextAttrs).length !== Object.keys(attrs || {}).length;
  if (attrsChanged) {
    updates['details.attributes'] = nextAttrs;
    updates['details.attributes_extra'] = Object.keys(nextExtra).length ? nextExtra : FieldValue.delete();
    flags.push('cleaned_attributes_meta_keys');
    if (removedKeys.length) notes.push(`Moved ${removedKeys.length} attribute keys to attributes_extra.`);
  }

  // Minimal audit marker
  if (flags.length) {
    updates['ops.data_quality.last_cleanup_iso'] = new Date().toISOString();
    updates['ops.data_quality.cleanup_v1'] = {
      flags: Array.from(new Set(flags)),
      note: notes.join(' '),
    };
  }

  return { updates, flags: Array.from(new Set(flags)), notes };
}

function parseArgs(argv) {
  const args = { dryRun: true, apply: false, expectedCount: null };
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
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const stamp = nowStamp();
  const outDir = path.join(process.cwd(), 'exports', 'cleanup', stamp);
  ensureDir(outDir);

  console.log(`[cleanup] project=${PROJECT_ID} mode=${args.apply ? 'APPLY' : 'DRY_RUN'} out=${outDir}`);

  const snap = await firestore.collection('products').get();
  const preCount = snap.size;
  console.log(`[cleanup] preCount=${preCount}`);

  if (args.apply) {
    const expected = Number.isFinite(args.expectedCount) ? args.expectedCount : 420;
    if (preCount !== expected) {
      throw new Error(`[cleanup] ABORT: expected preCount=${expected} but got ${preCount}`);
    }
  }

  const report = [];
  const summary = {
    preCount,
    total: preCount,
    touched: 0,
    flags: {},
    changedFields: {},
  };

  for (const doc of snap.docs) {
    const data = doc.data() || {};
    const patch = computePatch(data);
    const keys = Object.keys(patch.updates || {});
    if (!keys.length) continue;

    summary.touched += 1;
    patch.flags.forEach((f) => {
      summary.flags[f] = (summary.flags[f] || 0) + 1;
    });
    keys.forEach((k) => {
      summary.changedFields[k] = (summary.changedFields[k] || 0) + 1;
    });

    report.push({
      docId: doc.id,
      sku: safeString(data?.identification?.sku) || safeString(data?.details?.identifiers?.sku) || doc.id,
      changed: keys,
      flags: patch.flags,
      notes: patch.notes,
      updates: args.apply ? undefined : patch.updates, // include full patch only in dry-run
    });
  }

  fs.writeFileSync(
    path.join(outDir, args.apply ? 'apply_report.json' : 'dryrun_report.json'),
    JSON.stringify(report, null, 2),
    'utf8'
  );
  fs.writeFileSync(
    path.join(outDir, args.apply ? 'apply_summary.json' : 'dryrun_summary.json'),
    JSON.stringify(summary, null, 2),
    'utf8'
  );

  console.log(`[cleanup] touched=${summary.touched}`);

  if (!args.apply) {
    console.log('[cleanup] Dry-run complete. No writes performed.');
    console.log(`[cleanup] Report: ${path.join(outDir, 'dryrun_report.json')}`);
    return;
  }

  console.log('[cleanup] Applying updates via BulkWriter...');
  const bulkWriter = firestore.bulkWriter({
    throttling: { initialOpsPerSecond: 50, maxOpsPerSecond: 300 },
  });

  bulkWriter.onWriteError((error) => {
    console.error('[cleanup] write error', error.documentRef.path, error.message);
    // Retry transient errors
    if (error.code === 'unavailable' && error.failedAttempts < 6) return true;
    return false;
  });

  for (const item of report) {
    const docRef = firestore.collection('products').doc(item.docId);
    // Recompute patch to get FieldValue objects (they were stripped in report when apply=true).
    const data = snap.docs.find((d) => d.id === item.docId)?.data() || {};
    const patch = computePatch(data);
    if (!Object.keys(patch.updates || {}).length) continue;
    bulkWriter.update(docRef, patch.updates);
  }

  await bulkWriter.close();
  console.log('[cleanup] Apply done. Verifying count...');
  const postSnap = await firestore.collection('products').get();
  const postCount = postSnap.size;
  console.log(`[cleanup] postCount=${postCount}`);
  if (postCount !== preCount) {
    throw new Error(`[cleanup] COUNT MISMATCH: pre=${preCount} post=${postCount}`);
  }

  console.log(`[cleanup] SUCCESS. Reports in ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});



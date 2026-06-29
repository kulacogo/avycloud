#!/usr/bin/env node
'use strict';

/**
 * repair-description-literal-escapes.js
 *
 * One-time, content-only repair for product descriptions corrupted by an LLM
 * over-escaping newlines (literal backslash-n) — Incident 2026-06-29
 * (first seen on SKU-6717172932, Funko Freddie Mercury #184). The literal
 * "\n" sequences rendered as visible garbage inside the stored short_description,
 * which was also frozen as a stale pre-prose-fix bullet list.
 *
 * What it does (per affected product):
 *   1. Convert the stored HTML to block-aware text: closing block tags become a
 *      single newline, inline tags are dropped. This keeps the model's INTENDED
 *      paragraph breaks (the over-escaped "\n\n", de-literalized by the prose
 *      sanitizer) while letting bullet sentences flow back together — healing
 *      mid-sentence splits like "Neben der ca." | "10 cm ...".
 *   2. Re-run sanitizeDescriptionProse() (now hardened to de-literalize "\n").
 *      Result: clean Fließtext, no bullets, no literal escapes. Highlights stay
 *      in the separate key_features field (datasheet standard).
 *
 * SAFETY:
 *   - Dry-run by DEFAULT. Writes only with --apply.
 *   - Content-only: touches ONLY details.short_description. Never inventory /
 *     sku / storage / category (saveProductV2 + options enforce this).
 *   - Never blanks a description: if the repair would yield empty, the product
 *     is SKIPPED (left untouched).
 *   - Idempotent: re-running finds nothing to do.
 *
 * Usage:
 *   node backend/scripts/repair-description-literal-escapes.js                 # dry-run, all tenant=default
 *   node backend/scripts/repair-description-literal-escapes.js --id <docId>    # dry-run a single product
 *   node backend/scripts/repair-description-literal-escapes.js --apply         # write
 *   node backend/scripts/repair-description-literal-escapes.js --id <docId> --apply
 */

const { Firestore } = require('@google-cloud/firestore');
const { sanitizeDescriptionProse } = require('../lib/listing-sanitize');
const { getProduct } = require('../lib/firestore');
const { saveProductV2 } = require('../lib/product-store');

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || 'avycloud';
const TENANT_ID = process.env.TENANT_ID || 'default';
const db = new Firestore({ projectId: PROJECT_ID });

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const LITERAL_BACKSLASH_N = '\\n'; // two chars: backslash, n

function hasLiteralEscape(s) {
  return typeof s === 'string' && s.includes(LITERAL_BACKSLASH_N);
}

/**
 * Block-aware HTML → text: closing block tags become a single newline so list
 * items flow back into sentences; inline/opening tags are dropped to spaces.
 * The model's intended paragraph breaks (over-escaped "\n\n") survive as text
 * and are restored to real breaks by sanitizeDescriptionProse downstream.
 */
function htmlToBlockText(html = '') {
  return String(html)
    .replace(/<\/(p|div|ul|ol|li|section|article|blockquote|h[1-6]|tr)\s*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
}

function repairDescription(stored) {
  return sanitizeDescriptionProse(htmlToBlockText(stored), { maxLen: 3000 });
}

function preview(s, n = 240) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
}

async function collectCandidates(singleId) {
  if (singleId) {
    const snap = await db.collection('products_v2').doc(String(singleId)).get();
    if (!snap.exists) return [];
    return [{ id: snap.id, data: snap.data() }];
  }
  const snap = await db
    .collection('products_v2')
    .where('tenantId', '==', TENANT_ID)
    .get();
  const out = [];
  snap.forEach((doc) => {
    const d = doc.data();
    if (hasLiteralEscape(d?.details?.short_description)) out.push({ id: doc.id, data: d });
  });
  return out;
}

(async () => {
  const apply = Boolean(arg('apply', false));
  const singleId = arg('id', '');

  const candidates = await collectCandidates(singleId === true ? '' : singleId);
  console.log(
    `[repair-desc] project=${PROJECT_ID} tenant=${TENANT_ID} apply=${apply} candidates=${candidates.length}`,
  );
  if (!apply) console.log('[repair-desc] DRY-RUN — nothing will be written.\n');

  let fixed = 0;
  let skippedEmpty = 0;
  let skippedNoop = 0;
  let failed = 0;

  for (const { id, data } of candidates) {
    const sku = data?.identification?.sku || '(no-sku)';
    const stored = data?.details?.short_description || '';
    const repaired = repairDescription(stored);

    if (!repaired) {
      skippedEmpty++;
      console.log(`⚠ SKIP (would blank) ${id} ${sku}`);
      continue;
    }
    if (repaired === stored) {
      skippedNoop++;
      continue;
    }

    console.log(`↻ ${id} ${sku}`);
    console.log(`   vorher: ${preview(stored)}`);
    console.log(`   nachher:${preview(repaired)}`);
    console.log(`   literal-\\n entfernt: ${hasLiteralEscape(stored)} → ${hasLiteralEscape(repaired)}\n`);

    if (apply) {
      try {
        const cur = await getProduct(String(id));
        if (!cur) {
          failed++;
          console.log(`✖ ${id} nicht (mehr) gefunden`);
          continue;
        }
        cur.details = { ...(cur.details || {}), short_description: repaired };
        cur.ops = cur.ops || {};
        cur.ops.last_saved_source = 'desc-repair-literal-n';
        cur.ops.last_saved_iso = new Date().toISOString();
        await saveProductV2(cur, {
          source: 'desc-repair-literal-n',
          skipStockEvent: true,
          overwriteTextFields: true,
          skipTitlePolicy: true,
          skipKeyFeaturesNormalize: true,
        });
        fixed++;
      } catch (e) {
        failed++;
        console.log(`✖ ${id}: ${(e && e.message) || e}`);
      }
    }
  }

  console.log(
    `\n[repair-desc] done. fixed=${fixed} skipped(empty)=${skippedEmpty} skipped(noop)=${skippedNoop} failed=${failed} apply=${apply}`,
  );
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('[repair-desc] FAILED:', (e && e.stack) || e);
  process.exit(1);
});

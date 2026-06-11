#!/usr/bin/env node
'use strict';

/**
 * migrate-readiness-ki.js — one-off: set datasheet status to "In Bearbeitung"
 * with editor "KI" for products that were already KI-enriched (carry
 * ops.autoImprove) but whose readiness was never updated. Content-only.
 *
 * Usage:
 *   node backend/scripts/migrate-readiness-ki.js --idsFile /tmp/ids.txt          # dry-run
 *   node backend/scripts/migrate-readiness-ki.js --idsFile /tmp/ids.txt --apply
 */

const fs = require('fs');
const { getProduct } = require('../lib/firestore');
const { saveProductV2 } = require('../lib/product-store');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

(async () => {
  const apply = Boolean(arg('apply', false));
  const idsFile = arg('idsFile', '');
  if (!idsFile || idsFile === true) { console.error('need --idsFile'); process.exit(1); }
  const ids = fs.readFileSync(String(idsFile), 'utf8').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  console.log(`[migrate-readiness] apply=${apply}  ids=${ids.length}`);

  let changed = 0;
  let skipped = 0;
  for (const id of ids) {
    const cur = await getProduct(String(id));
    if (!cur) { skipped++; continue; }
    const wasKi = Boolean(cur.ops && cur.ops.autoImprove);
    const readiness = cur.ops && cur.ops.readiness;
    if (!wasKi || readiness === 'ready' || readiness === 'in_progress') { skipped++; continue; }
    console.log(`↪ ${cur.identification && cur.identification.sku || id}: "${readiness || '(leer)'}" → In Bearbeitung (KI)`);
    if (apply) {
      cur.ops = cur.ops || {};
      cur.ops.readiness = 'in_progress';
      cur.ops.readiness_editor = 'KI';
      cur.ops.readiness_set_at = new Date().toISOString();
      await saveProductV2(cur, { source: 'content-enrich', skipStockEvent: true, overwriteTextFields: true, skipTitlePolicy: true, skipKeyFeaturesNormalize: true });
      changed++;
    } else {
      changed++;
    }
  }
  console.log(`\n[migrate-readiness] ${apply ? 'geändert' : 'würde ändern'}=${changed}  übersprungen=${skipped}`);
  process.exit(0);
})().catch((e) => { console.error('FAILED:', (e && e.stack) || e); process.exit(1); });

#!/usr/bin/env node
'use strict';

/**
 * restore-titles.js — restore identification.name (title) from a backup map and
 * clear the auto-improve marker. Content-only, no warehouse, no publish.
 *
 * Usage:
 *   node backend/scripts/restore-titles.js --map /tmp/titles.json            # dry-run (shows diffs)
 *   node backend/scripts/restore-titles.js --map /tmp/titles.json --apply    # write
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
  const mapFile = arg('map', '');
  if (!mapFile || mapFile === true) {
    console.error('need --map <jsonfile of id->title>');
    process.exit(1);
  }
  const map = JSON.parse(fs.readFileSync(String(mapFile), 'utf8'));
  const ids = Object.keys(map);
  console.log(`[restore] apply=${apply}  ids=${ids.length}`);
  if (!apply) console.log('[restore] DRY-RUN — nothing written.\n');

  let restored = 0;
  let skipped = 0;
  let failed = 0;
  for (const id of ids) {
    const orig = map[id];
    try {
      const cur = await getProduct(String(id));
      if (!cur) {
        skipped++;
        console.log(`? ${id} nicht gefunden`);
        continue;
      }
      const now = (cur.identification && cur.identification.name) || '';
      if (now === orig) {
        skipped++;
        continue;
      }
      console.log(`↩ ${id}\n   jetzt:  ${now}\n   zurück: ${orig}`);
      if (apply) {
        cur.identification = { ...(cur.identification || {}), name: orig };
        cur.ops = cur.ops || {};
        cur.ops.autoImprove = null;
        cur.ops.last_saved_source = 'content-enrich-revert';
        cur.ops.last_saved_iso = new Date().toISOString();
        await saveProductV2(cur, {
          source: 'content-enrich-revert',
          skipStockEvent: true,
          overwriteTextFields: true,
          skipTitlePolicy: true,
          skipKeyFeaturesNormalize: true,
        });
        restored++;
      }
    } catch (e) {
      failed++;
      console.log(`✖ ${id}: ${(e && e.message) || e}`);
    }
  }
  console.log(`\n[restore] restored=${restored}  skipped(already-original)=${skipped}  failed=${failed}  (apply=${apply})`);
  process.exit(0);
})().catch((e) => {
  console.error('[restore] FAILED:', (e && e.stack) || e);
  process.exit(1);
});

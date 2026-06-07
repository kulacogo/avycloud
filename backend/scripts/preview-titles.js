#!/usr/bin/env node
'use strict';

/**
 * preview-titles.js — show before -> after eBay titles using the SAME chat
 * pipeline (research + correct model). READ-ONLY: never writes.
 *
 * Usage:
 *   node backend/scripts/preview-titles.js --idsFile /tmp/ids.txt --limit 3
 *   node backend/scripts/preview-titles.js --ids id1,id2
 */

const fs = require('fs');
const { getProduct } = require('../lib/firestore');
const { optimizeTitle } = require('../lib/title-optimizer');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

(async () => {
  const idsFile = arg('idsFile', '');
  const idsArg = arg('ids', '');
  const limit = Number(arg('limit', 0)) || 0;
  let ids = [];
  if (idsFile && idsFile !== true) ids = fs.readFileSync(String(idsFile), 'utf8').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  else if (idsArg && idsArg !== true) ids = String(idsArg).split(',').map((s) => s.trim()).filter(Boolean);
  if (!ids.length) { console.error('need --idsFile or --ids'); process.exit(1); }
  if (limit > 0) ids = ids.slice(0, limit);

  console.log(`[preview-titles] ${ids.length} Produkte — Chat-Recherche, READ-ONLY (kein Speichern)\n`);
  let ok = 0;
  let failed = 0;
  for (const id of ids) {
    try {
      const p = await getProduct(String(id));
      if (!p) { console.log(`? ${id} nicht gefunden\n`); continue; }
      const sku = (p.identification && p.identification.sku) || id;
      const before = (p.identification && p.identification.name) || '';
      const t0 = Date.now();
      const res = await optimizeTitle(p);
      const secs = ((Date.now() - t0) / 1000).toFixed(0);
      if (!res || !res.title) {
        failed++;
        console.log(`✖ ${sku} — kein Vorschlag (${secs}s)\n   alt: ${before}\n`);
        continue;
      }
      ok++;
      console.log(`━━━ ${sku}  (${res.title.length} Z., ${secs}s, conf=${res.confidence ?? '?'}, ${res.model || '?'})`);
      console.log(`   ALT: ${before}`);
      console.log(`   NEU: ${res.title}`);
      const ev = (res.evidence || []).slice(0, 3).map((e) => e && (e.url || e.title)).filter(Boolean);
      if (ev.length) console.log(`   Quellen: ${ev.join('  |  ')}`);
      console.log('');
    } catch (e) {
      failed++;
      console.log(`✖ ${id}: ${(e && e.message) || e}\n`);
    }
  }
  console.log(`[preview-titles] vorgeschlagen=${ok}  ohne-Vorschlag=${failed}`);
  process.exit(0);
})().catch((e) => { console.error('FAILED:', (e && e.stack) || e); process.exit(1); });

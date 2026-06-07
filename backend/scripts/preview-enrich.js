#!/usr/bin/env node
'use strict';

/**
 * preview-enrich.js — FULL datasheet before/after via the chat pipeline.
 * READ-ONLY: never writes. For reviewing quality before any apply.
 *
 * Usage:
 *   node backend/scripts/preview-enrich.js --idsFile /tmp/ids.txt --limit 3
 */

const fs = require('fs');
const { getProduct } = require('../lib/firestore');
const { enrichViaChatV3 } = require('../services/chat-enricher');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
function low(p) { return (p && p.details && p.details.pricing && (p.details.pricing.sellPrice ?? (p.details.pricing.lowest_price && p.details.pricing.lowest_price.amount))) ?? '—'; }
function attrKeys(p) { const a = (p && p.details && p.details.attributes) || {}; return Object.keys(a); }

(async () => {
  const idsFile = arg('idsFile', '');
  const idsArg = arg('ids', '');
  const limit = Number(arg('limit', 0)) || 0;
  let ids = [];
  if (idsFile && idsFile !== true) ids = fs.readFileSync(String(idsFile), 'utf8').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  else if (idsArg && idsArg !== true) ids = String(idsArg).split(',').map((s) => s.trim()).filter(Boolean);
  if (!ids.length) { console.error('need --idsFile or --ids'); process.exit(1); }
  if (limit > 0) ids = ids.slice(0, limit);

  console.log(`[preview-enrich] ${ids.length} Produkte — VOLLE Anreicherung via Chat, READ-ONLY\n`);
  for (const id of ids) {
    try {
      const p = await getProduct(String(id));
      if (!p) { console.log(`? ${id} nicht gefunden\n`); continue; }
      const sku = (p.identification && p.identification.sku) || id;
      const beforeAttrs = attrKeys(p);
      const t0 = Date.now();
      const res = await enrichViaChatV3(p);
      const secs = ((Date.now() - t0) / 1000).toFixed(0);
      const np = res.product;
      console.log(`━━━━━━ ${sku}  (${secs}s, conf=${res.confidence ?? '?'}, geändert: ${res.changed.join(', ') || 'nichts'})`);
      if (res.error) console.log(`   FEHLER: ${res.error}`);

      if (res.changed.includes('title')) {
        console.log(`  TITEL  alt: ${p.identification.name}`);
        console.log(`         neu: ${np.identification.name}`);
      }
      if (res.changed.includes('pricing')) console.log(`  PREIS  alt: ${low(p)}  →  neu: ${low(np)}  (${(np.details.pricing.lowest_price.sources || []).map((s) => s.url).filter(Boolean)[0] || 'ohne Quelle'})`);
      if (res.changed.includes('description')) console.log(`  BESCHR alt: ${(p.details.short_description || '').length} Z.  →  neu: ${(np.details.short_description || '').length} Z.`);
      if (res.changed.includes('attributes')) {
        const added = attrKeys(np).filter((k) => !beforeAttrs.includes(k));
        console.log(`  MERKM. +${added.length} neu: ${added.slice(0, 12).join(', ')}`);
      }
      if (res.changed.includes('gpsr')) console.log(`  GPSR   ${JSON.stringify(np.details.gpsr)}`);
      if (res.changed.includes('weight')) console.log(`  GEWICHT neu: ${np.details.weight} kg`);
      const ev = (res.evidence || []).slice(0, 3).map((e) => e && (e.url || e.title)).filter(Boolean);
      if (ev.length) console.log(`  Quellen: ${ev.join('  |  ')}`);
      console.log('');
    } catch (e) {
      console.log(`✖ ${id}: ${(e && e.message) || e}\n`);
    }
  }
  process.exit(0);
})().catch((e) => { console.error('FAILED:', (e && e.stack) || e); process.exit(1); });

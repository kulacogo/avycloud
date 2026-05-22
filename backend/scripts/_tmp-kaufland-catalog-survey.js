#!/usr/bin/env node
'use strict';
process.env.GOOGLE_CLOUD_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'avycloud';

const { firestore } = require('../lib/firestore');
const { kauflandRequest } = require('../lib/kaufland-api');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  console.log('Lade alle kauflandUnitsLive…');
  const snap = await firestore.collection('kauflandUnitsLive').get();
  console.log(`Gesamt: ${snap.size} Units im Cache.`);

  // Sammle eindeutige id_product Werte mit sku/active/status
  const unitsByIdProduct = new Map();
  snap.forEach((d) => {
    const x = d.data();
    const idp = Number(x.id_product || 0);
    if (!idp) return;
    if (!unitsByIdProduct.has(idp)) {
      unitsByIdProduct.set(idp, { id_product: idp, units: [], anyActive: false });
    }
    const e = unitsByIdProduct.get(idp);
    e.units.push({ id_offer: x.id_offer_normalized || x.id_offer, active: x.active, status: x.status });
    if (x.active) e.anyActive = true;
  });

  const total = unitsByIdProduct.size;
  console.log(`Unique id_product Werte: ${total}`);

  // Fetch catalog info for each id_product (5/sec rate limit)
  const results = [];
  let i = 0;
  for (const [idp, info] of unitsByIdProduct) {
    i++;
    try {
      const r = await kauflandRequest('GET', `/products/${idp}`, { query: { storefront: 'de' } });
      const d = r?.data?.data || {};
      results.push({
        id_product: idp,
        id_category: d.id_category || 0,
        is_valid: !!d.is_valid,
        title: d.title || '',
        manufacturer: d.manufacturer || '',
        anyActive: info.anyActive,
        unitCount: info.units.length,
      });
    } catch (e) {
      results.push({
        id_product: idp,
        id_category: 'ERR_' + (e.code || e.message),
        is_valid: null,
        title: '',
        manufacturer: '',
        anyActive: info.anyActive,
        unitCount: info.units.length,
      });
    }
    if (i % 25 === 0) {
      console.log(`  …${i}/${total}`);
      await sleep(800);
    } else {
      await sleep(80);
    }
  }

  // Aggregate
  const buckets = { stub_46001: 0, valid_other: 0, invalid_other: 0, errored: 0 };
  const stub46001Active = []; const invalidOtherActive = [];
  const catCounts = new Map();
  results.forEach((r) => {
    if (typeof r.id_category === 'string' && r.id_category.startsWith('ERR_')) { buckets.errored++; return; }
    catCounts.set(r.id_category, (catCounts.get(r.id_category) || 0) + 1);
    if (r.id_category === 46001) {
      buckets.stub_46001++;
      if (r.anyActive) stub46001Active.push(r);
    } else if (r.is_valid) {
      buckets.valid_other++;
    } else {
      buckets.invalid_other++;
      if (r.anyActive) invalidOtherActive.push(r);
    }
  });

  console.log('\n========== AGGREGATION ==========');
  console.log(`Insgesamt analysiert: ${results.length}`);
  console.log(`├─ 46001 "Sonstiges-Sonstiges" Stub:  ${buckets.stub_46001}  (davon "active" in Cache: ${stub46001Active.length})`);
  console.log(`├─ Andere Kategorie & is_valid=true:   ${buckets.valid_other}`);
  console.log(`├─ Andere Kategorie & is_valid=false:  ${buckets.invalid_other}  (davon active: ${invalidOtherActive.length})`);
  console.log(`└─ Fehler bei Lookup:                  ${buckets.errored}`);

  console.log('\nTop 10 Kategorien:');
  const sorted = [...catCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  sorted.forEach(([cat, n]) => console.log(`  cat=${cat}  →  ${n} Produkte`));

  console.log('\nSample "active aber 46001-Stub" (kaputt-aktiv):');
  stub46001Active.slice(0, 10).forEach((r) => console.log(`  id_product=${r.id_product}, ${r.unitCount} units`));

  // Speichere full report in Firestore
  await firestore.collection('kaufland_diagnostics').doc('catalog_survey_' + Date.now()).set({
    tenantId: 'default',
    createdAt: new Date().toISOString(),
    summary: { total: results.length, ...buckets, stub46001Active: stub46001Active.length, invalidOtherActive: invalidOtherActive.length },
    topCategories: sorted,
    stub46001Sample: stub46001Active.slice(0, 50).map((r) => ({ id_product: r.id_product, unitCount: r.unitCount })),
  });
  console.log('\nReport in Firestore kaufland_diagnostics/ gespeichert.');
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });

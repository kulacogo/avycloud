#!/usr/bin/env node
/**
 * Repair: Aufträge ohne `tenantId` (Orphans) → additiv `tenantId='default'` setzen.
 *
 * Hintergrund: Alle Prod-Daten gehören zu tenantId='default'. Eine Altlast aus
 * Jan–Mär 2026 (Kaufland-Intake vor der tenantId-Härtung) liegt OHNE tenantId-Feld
 * vor. Dashboard/OMS/Finanzbericht filtern hart `where tenantId=='default'` → diese
 * Aufträge sind UNSICHTBAR (Kaufland-Untererfassung ~4.7k€, „leere" Frühmonate).
 *
 * ADDITIV (CLAUDE.md #2): setzt nur ein fehlendes Feld auf den korrekten Wert,
 * ändert KEINEN Order-State, kein Stock, keine Beträge.
 *
 * Aufruf:
 *   # Read-only Audit (schreibt nichts):
 *   node backend/scripts/repair-orphan-order-tenant.js
 *
 *   # Apply (Opt-in, schreibt tenantId='default'):
 *   node backend/scripts/repair-orphan-order-tenant.js --apply --confirm REPAIR_TENANT_2026_06
 */
'use strict';

process.env.USE_PRODUCTS_V2 = process.env.USE_PRODUCTS_V2 || 'true';
const { firestore } = require('../lib/firestore');

const APPLY = process.argv.includes('--apply');
const CONFIRM = process.argv.includes('--confirm') ? process.argv[process.argv.indexOf('--confirm') + 1] : null;
const REQUIRED_CONFIRM = 'REPAIR_TENANT_2026_06';

function isCancelled(o) {
  return /cancel|storn/.test(`${o.omsStatus || ''} ${o.status || ''} ${o.statusLabel || ''}`.toLowerCase());
}

(async () => {
  const snap = await firestore.collection('orders').get();
  const orphans = [];
  for (const d of snap.docs) {
    const o = d.data();
    if (o.tenantId == null || o.tenantId === '') orphans.push({ id: d.id, ref: d.ref, o });
  }

  const byMk = {};
  const byMonth = {};
  let liveSum = 0;
  let liveCount = 0;
  for (const { o } of orphans) {
    const mk = `${o.marketplace || ''}`.toLowerCase().includes('kaufland') ? 'kaufland'
      : `${o.marketplace || ''}`.toLowerCase().includes('ebay') ? 'ebay' : 'other';
    byMk[mk] = (byMk[mk] || 0) + 1;
    const mo = (o.createdAt || '').slice(0, 7);
    byMonth[mo] = (byMonth[mo] || 0) + 1;
    if (!isCancelled(o)) { liveCount++; liveSum += Number(o.totalAmount || 0) || 0; }
  }

  console.log('─────────────────────────────────────────────');
  console.log(`Orphan-Aufträge (ohne tenantId): ${orphans.length}`);
  console.log(`  nach Marktplatz:`, JSON.stringify(byMk));
  console.log(`  nach Monat:`, JSON.stringify(byMonth));
  console.log(`  davon live (nicht storniert): ${liveCount} · Umsatz ${liveSum.toFixed(2)}€`);
  console.log('─────────────────────────────────────────────');

  if (!APPLY) {
    console.log('READ-ONLY (Audit). Zum Schreiben: --apply --confirm ' + REQUIRED_CONFIRM);
    process.exit(0);
  }
  if (CONFIRM !== REQUIRED_CONFIRM) {
    console.error(`❌ --apply braucht --confirm ${REQUIRED_CONFIRM}`);
    process.exit(1);
  }

  let batch = firestore.batch();
  let n = 0;
  let written = 0;
  for (const { ref } of orphans) {
    batch.set(ref, { tenantId: 'default' }, { merge: true });
    n++;
    if (n >= 400) { await batch.commit(); written += n; batch = firestore.batch(); n = 0; }
  }
  if (n > 0) { await batch.commit(); written += n; }
  console.log(`✅ tenantId='default' gesetzt auf ${written} Aufträge.`);
  process.exit(0);
})().catch((err) => { console.error('FEHLER:', err.message); process.exit(1); });

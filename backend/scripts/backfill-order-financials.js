'use strict';

/**
 * backfill-order-financials.js — Traegt zurueckliegende Marktplatz-
 * Erstattungen an den Auftraegen nach.
 *
 * Anlass (2026-08-18): Kaufland M63HGK5, 499 € verkauft, 49,90 € erstattet —
 * die Rechnung wies 499 € aus, weil auf dem Auftrag von der Erstattung nichts
 * stand. Gemessen ueber 01.05.–30.09.2026: 4 Bestellungen, 95,83 €, KEINE
 * davon in AvyCloud bekannt, alle vier mit Rechnung.
 *
 * Rein ADDITIV: es entstehen nur neue Felder (marketplaceRefunds,
 * refundedTotal, netAmount, grossAmount, ggf. invoiceNeedsCorrection).
 * Nichts wird geloescht, nichts ueberschrieben. Idempotent ueber die
 * refundId — ein zweiter Lauf addiert nicht nochmal.
 *
 *   node backend/scripts/backfill-order-financials.js                 # trocken
 *   node backend/scripts/backfill-order-financials.js --apply
 *   … --from 2026-05-01 --to 2026-09-30 --tenant default
 */

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
function value(n, fb = null) {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fb;
}

const APPLY = flag('apply');
const TENANT = value('tenant', process.env.TENANT_ID || 'default');
const FROM = value('from', '2026-05-01');
const TO = value('to', new Date().toISOString().split('T')[0]);

// MUSS vor dem ersten require der Firestore-nutzenden Module stehen — sonst
// landet der Lauf im fremden GCP-Projekt (gcloud zeigt lokal auf kalima-503608).
const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || 'avycloud';
process.env.GOOGLE_CLOUD_PROJECT = PROJECT_ID;
process.env.GCLOUD_PROJECT = PROJECT_ID;

(async () => {
  console.log('═'.repeat(70));
  console.log(`  ERSTATTUNGEN NACHTRAGEN — ${APPLY ? 'APPLY' : 'TROCKENLAUF'}`);
  console.log('═'.repeat(70));
  console.log(`  Projekt: ${PROJECT_ID} · Mandant: ${TENANT} · Zeitraum: ${FROM} – ${TO}\n`);

  const { syncMarketplaceFinancials } = require('../services/order-financials');
  const r = await syncMarketplaceFinancials({ tenantId: TENANT, from: FROM, to: TO, dryRun: !APPLY });

  console.log(`\n  gefunden ${r.gefunden} · ${APPLY ? 'eingetragen' : 'einzutragen'} ${r.eingetragen} · schon bekannt ${r.schonBekannt} · ohne Auftrag ${r.ohneAuftrag} · Fehler ${r.fehler.length}`);
  for (const d of (r.details || [])) {
    console.log(`    ${String(d.nummer).padEnd(10)} ${String(d.betrag).padStart(7)} €  → netto ${String(d.netto).padStart(8)} €  ${d.rechnungKorrekturNoetig ? '· Rechnung korrekturbeduerftig' : ''}`);
  }
  for (const f of r.fehler) console.log(`    ! ${JSON.stringify(f)}`);
  if (!APPLY) console.log('\n  TROCKENLAUF — nichts geschrieben. Mit --apply ausfuehren.');
  console.log('═'.repeat(70));
})().catch((e) => { console.error(`ABBRUCH: ${e.message}`); process.exit(1); });

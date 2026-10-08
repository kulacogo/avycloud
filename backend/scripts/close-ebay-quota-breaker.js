#!/usr/bin/env node
'use strict';

/**
 * close-ebay-quota-breaker.js — schliesst den GETEILTEN eBay-Quota-Breaker
 * (Firestore system/ebay_quota_breaker) von Hand.
 *
 * Wann: der Breaker steht bis zum Reset offen (Budget meldete „erschoepft"),
 * eBay hat aber inzwischen das Limit angehoben (Application Growth Check) oder
 * der Zaehlerstand war falsch. Die Worker-Messung schliesst ihn normalerweise
 * selbst, sobald sie wieder Rest sieht (alle 15 min) — dieses Script ist der
 * sofortige Weg.
 *
 * Aufruf:  GOOGLE_CLOUD_PROJECT=avycloud node backend/scripts/close-ebay-quota-breaker.js            (zeigt nur an)
 *          GOOGLE_CLOUD_PROJECT=avycloud node backend/scripts/close-ebay-quota-breaker.js --apply    (schliesst)
 *
 * Laufende Instanzen pruefen den geteilten Zustand bei jedem Aufruf erneut
 * (10-s-Cache) — ein Neustart ist nicht noetig.
 */

if (!process.env.GOOGLE_CLOUD_PROJECT) process.env.GOOGLE_CLOUD_PROJECT = 'avycloud';

async function main() {
  const breaker = require('../lib/ebay-quota-breaker');
  const state = await breaker.getEbayQuotaBreakerState({ force: true });
  console.log(`Projekt ${process.env.GOOGLE_CLOUD_PROJECT}: Breaker ${state.open ? `OFFEN bis ${state.openUntil} (noch ${Math.round(state.remainingMs / 60000)} min)` : 'geschlossen'}`);
  if (!process.argv.includes('--apply')) {
    console.log('Trockenlauf — mit --apply schliessen.');
    return;
  }
  if (!state.open) {
    console.log('Nichts zu tun.');
    return;
  }
  await breaker.closeEbayQuotaBreaker({});
  const after = await breaker.getEbayQuotaBreakerState({ force: true });
  console.log(`Danach: ${after.open ? 'IMMER NOCH OFFEN' : 'geschlossen'}`);
}

main().catch((err) => {
  console.error('ERR', err && err.message ? err.message : err);
  process.exit(1);
});

'use strict';

/**
 * enrichment-race.js — Budget-Race für In-Place-Anreicherungen (Erfassen).
 *
 * Incident 2026-08-04: Die Identify-Sicherheitsnetze (Preis/Beschreibung)
 * racen ihre Anreicherung gegen einen RESOLVENDEN Timer. Verliert die
 * Anreicherung das Race, läuft sie weiter und mutiert das product-Objekt
 * NACH dem saveProductV2 — die fertig berechneten Daten verschwinden still
 * (mal persistiert, mal nicht, je nach Timing). Dieser Helper macht das
 * Race-Ergebnis EHRLICH: der Caller erfährt, ob die Anreicherung innerhalb
 * des Budgets fertig wurde, und bekommt ein `tracked`-Promise, um spät
 * fertige Ergebnisse nachträglich zu persistieren (Late-Save) statt sie zu
 * verlieren.
 *
 * Der Timer wird immer aufgeräumt (kein offener Handle), `tracked` rejected
 * nie (Fehler werden als { ok:false, error } gemeldet).
 */

/**
 * @param {Promise|any} promise — die Anreicherung (darf werfen)
 * @param {number} budgetMs — Race-Budget in Millisekunden
 * @returns {Promise<{ settledInBudget: boolean, tracked: Promise<{ok: boolean, value?: any, error?: any}> }>}
 */
async function raceEnrichmentWithTracking(promise, budgetMs) {
  let settled = false;
  const tracked = Promise.resolve(promise).then(
    (value) => { settled = true; return { ok: true, value }; },
    (error) => { settled = true; return { ok: false, error }; }
  );
  let timer = null;
  await Promise.race([
    tracked,
    new Promise((resolve) => { timer = setTimeout(resolve, Math.max(0, Number(budgetMs) || 0)); }),
  ]);
  if (timer) clearTimeout(timer);
  return { settledInBudget: settled, tracked };
}

module.exports = { raceEnrichmentWithTracking };

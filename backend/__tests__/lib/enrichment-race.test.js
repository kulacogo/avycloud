'use strict';

// Incident 2026-08-04: Die Identify-Sicherheitsnetze racen Preis-/
// Beschreibungs-Anreicherung gegen RESOLVENDE Timer — verliert die
// Anreicherung, mutiert sie das product-Objekt NACH dem Save und die Daten
// verschwinden still. Der Helper macht das Race-Ergebnis ehrlich, damit der
// Route-Handler spät fertige Anreicherungen per Late-Save nachpersistiert.

const { raceEnrichmentWithTracking } = require('../../lib/enrichment-race');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('raceEnrichmentWithTracking', () => {
  it('meldet settledInBudget=true wenn die Anreicherung im Budget fertig wird', async () => {
    const { settledInBudget, tracked } = await raceEnrichmentWithTracking(
      sleep(10).then(() => 'preis'),
      500
    );
    expect(settledInBudget).toBe(true);
    await expect(tracked).resolves.toEqual({ ok: true, value: 'preis' });
  });

  it('meldet settledInBudget=false wenn das Budget vorher abläuft — tracked liefert das späte Ergebnis', async () => {
    const { settledInBudget, tracked } = await raceEnrichmentWithTracking(
      sleep(80).then(() => 'spät'),
      10
    );
    expect(settledInBudget).toBe(false);
    await expect(tracked).resolves.toEqual({ ok: true, value: 'spät' });
  });

  it('rejected nie — Fehler der Anreicherung kommen als { ok:false, error }', async () => {
    const boom = new Error('enrichment kaputt');
    const { settledInBudget, tracked } = await raceEnrichmentWithTracking(
      Promise.reject(boom),
      100
    );
    expect(settledInBudget).toBe(true);
    await expect(tracked).resolves.toEqual({ ok: false, error: boom });
  });

  it('akzeptiert Budget 0/ungültig ohne zu hängen', async () => {
    const { settledInBudget, tracked } = await raceEnrichmentWithTracking(
      sleep(30).then(() => 'x'),
      0
    );
    expect(settledInBudget).toBe(false);
    await expect(tracked).resolves.toEqual({ ok: true, value: 'x' });
  });
});

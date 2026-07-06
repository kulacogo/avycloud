'use strict';

/**
 * Backfill: Bestand-Produkte (mit Lagerplatz) ohne gespeicherten Status bekommen
 * explizit "Ausstehend" (pending). Die Anzeige zeigt sie ohnehin schon so
 * (normalizeReadiness), das schreibt den Wert fest in die Daten. Nicht-Bestand-
 * Produkte und bereits gültige Status bleiben unangetastet.
 */

const { needsReadinessBackfill, runBackfill } = require('../../scripts/backfill-readiness-inventory');

describe('needsReadinessBackfill', () => {
  it('true: hat Lagerplatz/Bestand + kein/ungültiger Status', () => {
    expect(needsReadinessBackfill({ storageBins: [{ code: 'A1' }] })).toBe(true);
    expect(needsReadinessBackfill({ inventory: { quantity: 3 }, ops: { readiness: null } })).toBe(true);
    expect(needsReadinessBackfill({ storage: { binCode: 'B2' } })).toBe(true);
    expect(needsReadinessBackfill({ storageBins: [{ code: 'A1' }], ops: { readiness: 'weird' } })).toBe(true);
  });

  it('false: bereits gültiger Status', () => {
    expect(needsReadinessBackfill({ storageBins: [{ code: 'A1' }], ops: { readiness: 'pending' } })).toBe(false);
    expect(needsReadinessBackfill({ inventory: { quantity: 3 }, ops: { readiness: 'ready' } })).toBe(false);
    expect(needsReadinessBackfill({ storage: { binCode: 'B2' }, ops: { readiness: 'in_progress' } })).toBe(false);
  });

  it('false: nicht im Bestand (kein Lagerplatz, keine Menge)', () => {
    expect(needsReadinessBackfill({ ops: { readiness: null } })).toBe(false);
    expect(needsReadinessBackfill({ inventory: { quantity: 0 }, storageBins: [] })).toBe(false);
  });
});

describe('runBackfill', () => {
  it('apply: setzt Ausstehend nur bei betroffenen Produkten', async () => {
    const saved = [];
    const products = [
      { id: 'p1', storageBins: [{ code: 'A1' }], ops: {} },                 // betroffen
      { id: 'p2', inventory: { quantity: 5 }, ops: { readiness: 'ready' } }, // gültig → skip
      { id: 'p3', ops: { readiness: null } },                                // kein Bestand → skip
    ];
    const res = await runBackfill({ products, saveProduct: async (p) => saved.push(p), apply: true, nowIso: 'X' });
    expect(res.scanned).toBe(3);
    expect(res.backfilled).toBe(1);
    expect(saved.map((p) => p.id)).toEqual(['p1']);
    expect(saved[0].ops.readiness).toBe('pending');
  });

  it('dry-run: schreibt nichts, zählt aber', async () => {
    const saved = [];
    const products = [{ id: 'p1', storageBins: [{ code: 'A1' }], ops: {} }];
    const res = await runBackfill({ products, saveProduct: async (p) => saved.push(p), apply: false, nowIso: 'X' });
    expect(saved).toEqual([]);
    expect(res.backfilled).toBe(1);
  });
});

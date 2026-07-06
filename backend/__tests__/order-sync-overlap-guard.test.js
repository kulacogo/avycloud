'use strict';

/**
 * REGRESSION GUARDS — Order-Sync darf sich nicht selbst überlappen (2026-07-06).
 *
 * (A) index.js backgroundSyncOrders: der In-Flight-Guard wurde von einem 8s-Timer
 *     freigegeben, während der Voll-Sync Minuten läuft — jeder Trigger ≥60s später
 *     startete einen ZWEITEN parallelen Sync (Trigger sitzen auf GET /orders,
 *     /dashboard/metrics, /dashboard/ops). Jetzt: Watchdog (Default 10 min) +
 *     Generation-Token, Freigabe primär im .finally().
 *
 * (B) sync-event-bus: die Debounce-Maps löschten ihren Eintrag am Callback-START —
 *     gedrosselt wurde nur das Scheduling, nie die Ausführung. Jetzt: Eintrag wird
 *     erst im finally nach Abschluss der awaited Syncs gelöscht ('running'-Marker).
 *
 * Source-contract tests (Muster HARDEN Wave 2) — robust unter CJS-Test-Isolation.
 */

const fs = require('fs');
const path = require('path');
const read = (rel) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');

describe('index.js: backgroundSyncOrders Watchdog statt 8s-Selbstfreigabe', () => {
  const src = read('index.js');

  it('Default-Watchdog ist minutenlang, nicht 8s', () => {
    expect(src).not.toMatch(/ORDER_SYNC_TIMEOUT_MS\s*\|\|\s*'8000'/);
    expect(src).toMatch(/ORDER_SYNC_TIMEOUT_MS\s*\|\|\s*String\(10 \* 60 \* 1000\)/);
  });

  it('Guard-Freigabe läuft über Generation-Token im finally', () => {
    const fnMatch = src.match(/function backgroundSyncOrders[\s\S]+?\n\}/);
    expect(fnMatch).not.toBeNull();
    const body = fnMatch[0];
    expect(body).toMatch(/\+\+ordersSyncGeneration/);
    expect(body).toMatch(/finally[\s\S]{0,200}ordersSyncGeneration === generation[\s\S]{0,120}ordersSyncInFlight = false/);
  });
});

describe('sync-event-bus: Debounce entdoppelt die AUSFÜHRUNG, nicht nur das Scheduling', () => {
  const src = read('services/sync-event-bus.js');

  it('_debouncedMarketplaceOrderSync löscht den Map-Eintrag erst im finally', () => {
    const fnMatch = src.match(/function _debouncedMarketplaceOrderSync[\s\S]+?\n\}/);
    expect(fnMatch).not.toBeNull();
    const body = fnMatch[0];
    // Alter Bug: delete direkt am Callback-Start.
    expect(body).not.toMatch(/setTimeout\(async \(\) => \{\s*\n\s*_marketplaceSyncTimers\.delete/);
    // Neu: 'running'-Marker + delete im finally.
    expect(body).toMatch(/_marketplaceSyncTimers\.set\(tenant, 'running'\)/);
    expect(body).toMatch(/finally\s*\{\s*\n?\s*_marketplaceSyncTimers\.delete\(tenant\)/);
  });

  it('_debouncedReturnSync folgt demselben Muster', () => {
    const fnMatch = src.match(/function _debouncedReturnSync[\s\S]+?\n\}/);
    expect(fnMatch).not.toBeNull();
    const body = fnMatch[0];
    expect(body).toMatch(/_returnSyncTimers\.set\(tenant, 'running'\)/);
    expect(body).toMatch(/finally\s*\{\s*\n?\s*_returnSyncTimers\.delete\(tenant\)/);
  });
});

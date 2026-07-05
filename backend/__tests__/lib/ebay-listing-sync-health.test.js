'use strict';

/**
 * Fix 4 (2026-07-05): Ehrlicher eBay-Listing-Sync-Status.
 *
 * Hintergrund: Der Sync fiel 5 Tage lang alle 15 Minuten mit ungültigem Token
 * aus — aber der Runner stempelte weiter frische lastSyncAt auf die Produkte,
 * die UI sah "frisch synchronisiert" aus. getEbayListingSyncHealth liest den
 * Lauf-Zustand aus ops/ebayLightSync und klassifiziert ihn ehrlich.
 */

require('../api/_patchGcp');
require('../api/_patchLocalModules');

const { getEbayListingSyncHealth } = require('../../lib/ebay-direct');
const firestoreModule = require('../../lib/firestore');

function installLockDoc(doc) {
  firestoreModule.firestore.collection = (name) => {
    if (name !== 'ops') throw new Error(`unexpected collection ${name}`);
    return {
      doc: (id) => {
        if (id !== 'ebayLightSync') throw new Error(`unexpected doc ${id}`);
        return { get: async () => ({ exists: Boolean(doc), data: () => doc }) };
      },
    };
  };
}

const minutesAgoIso = (m) => new Date(Date.now() - m * 60_000).toISOString();

describe('getEbayListingSyncHealth — ehrlicher Sync-Zustand', () => {
  it('healthy: junger Erfolg, kein Fehler danach', async () => {
    installLockDoc({
      lastCompletedAtIso: minutesAgoIso(10),
      lastError: null,
    });
    const h = await getEbayListingSyncHealth();
    expect(h.healthy).toBe(true);
    expect(h.failingSinceIso).toBeNull();
    expect(h.staleMinutes).toBeGreaterThanOrEqual(9);
  });

  it('unhealthy: Fehler NACH dem letzten Erfolg (Token-Ausfall-Szenario)', async () => {
    installLockDoc({
      lastCompletedAtIso: minutesAgoIso(5 * 24 * 60), // Erfolg vor 5 Tagen
      lastError: {
        message: 'Die Validierung des Authentifizierungs-Tokens in der API-Anforderung ist fehlgeschlagen.',
        atIso: minutesAgoIso(3),
      },
    });
    const h = await getEbayListingSyncHealth();
    expect(h.healthy).toBe(false);
    expect(h.failingSinceIso).toBeTruthy();
    expect(h.lastError.message).toContain('Authentifizierungs-Tokens');
    expect(h.staleMinutes).toBeGreaterThan(60);
  });

  it('unhealthy: Erfolg zu lange her, auch ohne protokollierten Fehler', async () => {
    installLockDoc({
      lastCompletedAtIso: minutesAgoIso(240),
      lastError: null,
    });
    const h = await getEbayListingSyncHealth();
    expect(h.healthy).toBe(false);
  });

  it('healthy: alter Fehler VOR dem letzten Erfolg zählt nicht', async () => {
    installLockDoc({
      lastCompletedAtIso: minutesAgoIso(10),
      lastError: { message: 'transient', atIso: minutesAgoIso(60) },
    });
    const h = await getEbayListingSyncHealth();
    expect(h.healthy).toBe(true);
    expect(h.failingSinceIso).toBeNull();
  });

  it('unknown: kein Lock-Doc → nicht healthy, aber auch kein Fehler', async () => {
    installLockDoc(null);
    const h = await getEbayListingSyncHealth();
    expect(h.healthy).toBe(false);
    expect(h.lastSuccessAtIso).toBeNull();
    expect(h.lastError).toBeNull();
  });

  it('meldet eine blockierte Deaktivierung aus dem letzten Lauf', async () => {
    installLockDoc({
      lastCompletedAtIso: minutesAgoIso(10),
      lastError: null,
      lastSummary: { deactivation: { blocked: true, reason: 'awaiting_second_complete_ingest_confirmation' } },
      pendingLargeDeactivation: { activeSetSize: 0, atMs: Date.now() },
    });
    const h = await getEbayListingSyncHealth();
    expect(h.healthy).toBe(true);
    expect(h.blockedReason).toBe('awaiting_second_complete_ingest_confirmation');
    expect(h.pendingConfirmation).toBe(true);
  });
});

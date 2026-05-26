'use strict';

/**
 * Regression test for the eBay listing-deactivation safety guard in
 * lib/ebay-direct.js (`deactivateListingsMissingFromActiveSet`).
 *
 * PRODUCTION INCIDENT (2026-05-26): AvyCloud showed 630 active eBay listings
 * while eBay actually had 454. A full, verifiably-complete Trading-API ingest
 * (pagesFetched === totalPages) returned all 454 live items, so 176 stale
 * docs in `ebayListingsLive` should have been deactivated. They were not:
 * the old fixed 20% ratio guard refused because 176/630 = 28% > 20%, even
 * though the fetch was authoritative. The guard could not tell genuine
 * accumulated drift from a partial/broken API response, so it froze the
 * stale count in place — a self-reinforcing deadlock.
 *
 * The smart guard:
 *   - blocks only a SUSPECT fetch (empty active set, or catastrophic collapse),
 *   - trusts a verifiably-complete ingest even when drift exceeds 20%,
 *   - keeps the conservative 20% cap when the ingest is NOT complete.
 *
 * Pure unit test: we override the shared `firestore` instance methods so the
 * guard math runs against in-memory fixtures (no real Firestore).
 */

require('../api/_patchGcp');
require('../api/_patchLocalModules');

const { deactivateListingsMissingFromActiveSet } = require('../../lib/ebay-direct');
const firestoreModule = require('../../lib/firestore');

const COLLECTION = 'ebayListingsLive';

/**
 * Installs a fake Firestore backend on the shared `firestore` instance that
 * lib/ebay-direct.js captured at module load. Returns the list of itemIds the
 * code committed as deactivated.
 *
 * @param {string[]} activeDocIds — ids currently marked active in Firestore.
 */
function installFirestoreFake(activeDocIds) {
  const deactivatedIds = [];
  const docs = activeDocIds.map((id) => ({ id, data: () => ({ active: true }) }));

  const fakeQuery = { get: async () => ({ docs }) };
  const fakeCollection = {
    where: () => fakeQuery,
    doc: (id) => ({ __id: id }),
  };

  firestoreModule.firestore.collection = (name) => {
    if (name !== COLLECTION) throw new Error(`unexpected collection ${name}`);
    return fakeCollection;
  };
  firestoreModule.firestore.batch = () => ({
    set: (ref) => { if (ref && ref.__id) deactivatedIds.push(ref.__id); },
    commit: async () => [],
  });

  return deactivatedIds;
}

const ids = (from, to) => {
  const out = [];
  for (let i = from; i <= to; i += 1) out.push(String(i));
  return out;
};

describe('deactivateListingsMissingFromActiveSet — smart safety guard', () => {
  it('deactivates genuine drift (176/630 = 28%) when the ingest is complete', async () => {
    // Production incident: 630 active docs, eBay returns 454 → 176 must go.
    const committed = installFirestoreFake(ids(1, 630));
    const activeItemIds = ids(1, 454); // what eBay's complete active list returned

    const result = await deactivateListingsMissingFromActiveSet({
      activeItemIds,
      ingestComplete: true,
    });

    expect(result.blocked).toBeFalsy();
    expect(result.deactivated).toBe(176);
    expect(result.keptActive).toBe(454);
    expect(committed.length).toBe(176);
  });

  it('blocks when the active set is empty (auth/API failure, not real drift)', async () => {
    const committed = installFirestoreFake(ids(1, 630));

    const result = await deactivateListingsMissingFromActiveSet({
      activeItemIds: [],
      ingestComplete: true,
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('empty_active_set');
    expect(result.deactivated).toBe(0);
    expect(committed.length).toBe(0);
  });

  it('blocks a catastrophic collapse even when the ingest claims complete', async () => {
    // eBay reported "complete" but returned only 10 of ~630 → almost certainly
    // a silently-truncated/broken fetch, not 98% of listings ending at once.
    const committed = installFirestoreFake(ids(1, 630));

    const result = await deactivateListingsMissingFromActiveSet({
      activeItemIds: ids(1, 10),
      ingestComplete: true,
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('catastrophic_collapse_suspected');
    expect(result.deactivated).toBe(0);
    expect(committed.length).toBe(0);
  });

  it('keeps the conservative 20% cap when the ingest is NOT complete', async () => {
    const committed = installFirestoreFake(ids(1, 630));

    const result = await deactivateListingsMissingFromActiveSet({
      activeItemIds: ids(1, 454), // 28% drift — over the conservative cap
      ingestComplete: false,
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('safety_threshold_exceeded');
    expect(result.deactivated).toBe(0);
    expect(committed.length).toBe(0);
  });
});

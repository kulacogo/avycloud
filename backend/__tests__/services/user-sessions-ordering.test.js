'use strict';

/**
 * Regression (2026-07): querySessions()/getActiveSessions() queried by tenantId
 * with .limit(1000) but WITHOUT orderBy → Firestore ordered by __name__ (random
 * add-IDs), so beyond 1000 docs a RANDOM slice came back instead of the newest
 * sessions. Fix: server-side orderBy('loginAt','desc') with a graceful fallback
 * to the old single-field query on a missing composite index (FAILED_PRECONDITION).
 *
 * Pattern: require.cache patching (no vi.mock for CJS).
 */

let sessionsData = {};
let failOnComposite = false;
let calls;

function patchCache(name, exportsObj) {
  const key = require.resolve(name);
  require.cache[key] = { id: key, filename: key, loaded: true, exports: exportsObj, children: [], paths: [] };
}

function makeFakeFirestore() {
  function build(filters, ordered) {
    return {
      where: (field, _op, val) => build([...filters, { field, val }], ordered),
      orderBy: (field, dir) => {
        calls.orderBy.push({ field, dir });
        return build(filters, { field, dir });
      },
      limit: () => build(filters, ordered),
      get: async () => {
        calls.gets.push({ filters: filters.map((f) => f.field), ordered: !!ordered });
        if (ordered && failOnComposite) {
          const err = new Error('The query requires an index. FAILED_PRECONDITION: missing composite index');
          err.code = 9;
          throw err;
        }
        let ids = Object.keys(sessionsData).filter((id) =>
          filters.every((f) => sessionsData[id][f.field] === f.val)
        );
        if (ordered) {
          ids.sort((a, b) => {
            const av = sessionsData[a][ordered.field] || '';
            const bv = sessionsData[b][ordered.field] || '';
            return ordered.dir === 'desc' ? bv.localeCompare(av) : av.localeCompare(bv);
          });
        }
        const docs = ids.map((id) => ({ id, data: () => sessionsData[id], ref: { update: async () => {} } }));
        return { docs, empty: docs.length === 0 };
      },
    };
  }
  return { collection: () => ({ where: (field, _op, val) => build([{ field, val }], null) }) };
}

patchCache('../../lib/firestore', { firestore: makeFakeFirestore() });

const { querySessions, getActiveSessions } = require('../../services/user-sessions');

const NOW = new Date().toISOString();

beforeEach(() => {
  failOnComposite = false;
  calls = { orderBy: [], gets: [] };
  // Insert in NON-sorted key order to prove ordering is applied, not incidental.
  sessionsData = {
    'z-oldest': { tenantId: 'default', status: 'active', loginAt: '2026-01-01T00:00:00Z', lastActiveAt: NOW },
    'a-newest': { tenantId: 'default', status: 'active', loginAt: '2026-07-01T00:00:00Z', lastActiveAt: NOW },
    'm-middle': { tenantId: 'default', status: 'offline', loginAt: '2026-04-01T00:00:00Z', lastActiveAt: NOW },
    'other-tenant': { tenantId: 'trendocean', status: 'active', loginAt: '2026-08-01T00:00:00Z', lastActiveAt: NOW },
  };
});

describe('querySessions ordering', () => {
  it('uses server-side orderBy(loginAt desc) and returns newest first', async () => {
    const res = await querySessions({ tenantId: 'default' });

    expect(calls.orderBy).toContainEqual({ field: 'loginAt', dir: 'desc' });
    // tenantId filter honored (no trendocean), newest first
    expect(res.map((s) => s.id)).toEqual(['a-newest', 'm-middle', 'z-oldest']);
  });

  it('falls back to the single-field query (no crash) when the composite index is missing', async () => {
    failOnComposite = true;

    const res = await querySessions({ tenantId: 'default' });

    // Two get() attempts: ordered (threw) then unordered fallback.
    expect(calls.gets.length).toBe(2);
    expect(calls.gets[0].ordered).toBe(true);
    expect(calls.gets[1].ordered).toBe(false);
    // Client-side sort still yields newest-first, no throw.
    expect(res.map((s) => s.id)).toEqual(['a-newest', 'm-middle', 'z-oldest']);
  });
});

describe('getActiveSessions ordering', () => {
  it('queries status==active + orderBy(loginAt desc) and excludes other tenants', async () => {
    const res = await getActiveSessions({ tenantId: 'default' });

    expect(calls.orderBy).toContainEqual({ field: 'loginAt', dir: 'desc' });
    const ids = res.map((s) => s.id);
    expect(ids).toContain('a-newest');
    expect(ids).toContain('z-oldest');
    expect(ids).not.toContain('m-middle'); // offline
    expect(ids).not.toContain('other-tenant');
  });

  it('falls back gracefully and still filters status client-side on missing index', async () => {
    failOnComposite = true;

    const res = await getActiveSessions({ tenantId: 'default' });

    expect(calls.gets.length).toBe(2);
    expect(calls.gets[1].ordered).toBe(false);
    const ids = res.map((s) => s.id);
    expect(ids).toContain('a-newest');
    expect(ids).not.toContain('m-middle'); // offline filtered client-side in fallback
  });
});

'use strict';

/**
 * Tests for scripts/reset-books-gmbh.js
 *
 * Wipes the BOOKS collections (orders/invoices/returns/shipments/mirrors/…) for
 * a tenant and resets number sequences to zero — for the TrendOcean-GmbH cutover.
 *
 * GOLDENE REGEL: production stock must NEVER be corrupted. The load-bearing test
 * here is the protected-collection guard: even if a stock/product collection is
 * (mis)configured into the wipe list, runReset must REFUSE and delete nothing.
 *
 * Vitest CJS — globals enabled. Pure functions + runReset(deps) are require-able
 * without touching real Firestore (heavy requires deferred to the CLI entry).
 */

const {
  assertSafeToWipe,
  assertArchivePresent,
  numberSequenceResetDoc,
  runReset,
  WIPE_COLLECTIONS,
  PROTECTED_COLLECTIONS,
} = require('../../scripts/reset-books-gmbh');

describe('tenant-scoping matches the actual writers (books-truly-zero)', () => {
  const byName = Object.fromEntries(WIPE_COLLECTIONS.map((c) => [c.name, c]));

  it('collections whose writers omit tenantId are wiped whole (tenantScoped:false)', () => {
    // return_events (returns-engine.js .add — no tenantId) and stock_reconciliation_log
    // (stock-reconciliation.js spreads ...result — no tenantId) would be MISSED by a
    // tenantId filter, leaving the old books non-empty.
    expect(byName['return_events'].tenantScoped).toBe(false);
    expect(byName['stock_reconciliation_log'].tenantScoped).toBe(false);
  });

  it('includes stock_sync_failures (dual-write sibling of stock_operation_failures, carries tenantId)', () => {
    expect(byName['stock_sync_failures']).toBeDefined();
    expect(byName['stock_sync_failures'].tenantScoped).toBe(true);
  });

  it('runReset wipes tenantId-less docs when the collection is tenantScoped:false', async () => {
    const deleted = [];
    const fs = {
      collection(name) {
        const docs = name === 'return_events' ? [{ id: 're1' }, { id: 're2' }] : []; // no tenantId
        const snap = { size: docs.length, docs: docs.map((d) => ({ id: d.id, data: () => d, ref: { delete: async () => { deleted.push(`${name}/${d.id}`); } } })) };
        return { where() { return { async get() { return { size: 0, docs: [] }; } }; }, async get() { return snap; }, doc() { return { async set() {} }; } };
      },
    };
    await runReset({
      firestore: fs, tenantId: 'default', apply: true, currentYear: 2026,
      wipeCollections: [{ name: 'return_events', tenantScoped: false }], sequenceTypes: [],
    });
    expect(deleted).toEqual(['return_events/re1', 'return_events/re2']);
  });
});

describe('assertArchivePresent (GoBD gate before irreversible wipe)', () => {
  it('throws when there is no archive manifest', () => {
    expect(() => assertArchivePresent(null)).toThrow();
  });
  it('throws when the archive is not verified ok', () => {
    expect(() => assertArchivePresent({ ok: false, count: 3 })).toThrow();
  });
  it('passes when the archive manifest reports ok', () => {
    expect(assertArchivePresent({ ok: true, count: 3 })).toBe(true);
  });
});

describe('stock_locks defense-in-depth', () => {
  it('protects stock_locks from being wiped', () => {
    expect(PROTECTED_COLLECTIONS).toContain('stock_locks');
    expect(() => assertSafeToWipe('stock_locks')).toThrow();
  });
});

describe('assertSafeToWipe (GOLDENE REGEL guard)', () => {
  it('throws for the stock/product/company collections that must NEVER be wiped', () => {
    for (const name of ['products_v2', 'products', 'warehouseBins', 'warehouseEvents', 'company_settings', 'number_sequences']) {
      expect(() => assertSafeToWipe(name)).toThrow();
    }
  });

  it('allows a whitelisted books collection', () => {
    expect(assertSafeToWipe('orders')).toBe(true);
    expect(assertSafeToWipe('invoices')).toBe(true);
  });
});

describe('wipe/protected invariant', () => {
  it('no protected collection appears in the wipe whitelist', () => {
    const wipeNames = WIPE_COLLECTIONS.map((c) => c.name);
    const overlap = wipeNames.filter((n) => PROTECTED_COLLECTIONS.includes(n));
    expect(overlap).toEqual([]);
  });

  it('the load-bearing stock collections are explicitly protected', () => {
    for (const n of ['products_v2', 'warehouseBins', 'warehouseEvents']) {
      expect(PROTECTED_COLLECTIONS).toContain(n);
    }
  });
});

describe('numberSequenceResetDoc', () => {
  it('produces a zeroed counter carrying the current year', () => {
    expect(numberSequenceResetDoc({ tenantId: 'default', type: 'order', year: 2026 }))
      .toMatchObject({ tenantId: 'default', type: 'order', year: 2026, currentNumber: 0 });
  });
});

describe('runReset (orchestration with an injected fake firestore)', () => {
  function makeFirestore(data) {
    const deleted = [];
    const setCalls = [];
    const fs = {
      _deleted: deleted,
      _setCalls: setCalls,
      collection(name) {
        const docs = data[name] || [];
        const snap = (arr) => ({
          size: arr.length,
          docs: arr.map((d) => ({
            id: d.id,
            data: () => d,
            ref: { delete: async () => { deleted.push(`${name}/${d.id}`); } },
          })),
        });
        return {
          where(field, op, val) {
            return { async get() { return snap(docs.filter((d) => d[field] === val)); } };
          },
          async get() { return snap(docs); },
          doc(id) {
            return { async set(payload) { setCalls.push({ coll: name, id, payload }); } };
          },
        };
      },
    };
    return fs;
  }

  it('dry-run: counts docs but deletes nothing and resets nothing', async () => {
    const fs = makeFirestore({
      orders: [{ id: 'o1', tenantId: 'default' }, { id: 'o2', tenantId: 'default' }],
      ebayListingsLive: [{ id: 'e1' }],
    });
    const res = await runReset({
      firestore: fs, tenantId: 'default', apply: false, currentYear: 2026,
      wipeCollections: [{ name: 'orders', tenantScoped: true }, { name: 'ebayListingsLive', tenantScoped: false }],
      sequenceTypes: ['order'],
    });
    expect(fs._deleted).toEqual([]);
    expect(fs._setCalls).toEqual([]);
    expect(res.wiped.find((w) => w.name === 'orders').count).toBe(2);
    expect(res.wiped.find((w) => w.name === 'ebayListingsLive').count).toBe(1);
  });

  it('apply: deletes whitelisted docs (tenant-scoped preserves other tenants) and resets sequences', async () => {
    const fs = makeFirestore({
      orders: [{ id: 'o1', tenantId: 'default' }],
      invoices: [{ id: 'i1', tenantId: 'default' }, { id: 'i2', tenantId: 'other' }],
    });
    const res = await runReset({
      firestore: fs, tenantId: 'default', apply: true, currentYear: 2026,
      wipeCollections: [{ name: 'orders', tenantScoped: true }, { name: 'invoices', tenantScoped: true }],
      sequenceTypes: ['order', 'invoice'],
    });
    expect(fs._deleted).toContain('orders/o1');
    expect(fs._deleted).toContain('invoices/i1');
    expect(fs._deleted).not.toContain('invoices/i2'); // other tenant preserved
    const seqIds = fs._setCalls.map((c) => c.id).sort();
    expect(seqIds).toEqual(['default__invoice', 'default__order']);
    expect(fs._setCalls.find((c) => c.id === 'default__order').payload.currentNumber).toBe(0);
    expect(fs._setCalls.find((c) => c.id === 'default__order').payload.year).toBe(2026);
    expect(res.wiped.find((w) => w.name === 'orders').deleted).toBe(1);
  });

  it('REFUSES to wipe a protected collection even if injected into the wipe list — deletes nothing', async () => {
    const fs = makeFirestore({ warehouseEvents: [{ id: 'w1' }, { id: 'w2' }] });
    await expect(runReset({
      firestore: fs, tenantId: 'default', apply: true, currentYear: 2026,
      wipeCollections: [{ name: 'warehouseEvents', tenantScoped: false }],
      sequenceTypes: [],
    })).rejects.toThrow(/protected|refuse|warehouseEvents/i);
    expect(fs._deleted).toEqual([]);
  });
});

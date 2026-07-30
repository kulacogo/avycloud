'use strict';

/**
 * D.5 — Tests for scripts/cassini-backfill.js
 *
 * Plan: /Users/oguz/.claude/plans/sieht-ziemlich-komplex-unstrukturiert-woolly-tulip.md
 *
 * Vitest CJS — globals enabled (describe/it/expect/vi).
 *
 * Three-stage stubbing pattern (per CLAUDE.md / backend rules):
 *   1. require.cache-patch @google-cloud/firestore so SDK loaders don't crash.
 *   2. require.cache-patch lib/firestore so the script's require picks up an
 *      in-memory stub.
 *   3. require.cache-patch lib/cassini-scorer so we control score outputs.
 *
 * NOTE: We mostly call `runBackfill()` directly (exported from the script) with
 * the in-memory firestore stub + scorer mock. This keeps tests deterministic
 * and free of subprocess + filesystem dependencies.
 */

const path = require('path');

// Feste Uhr fuer alle runBackfill-Aufrufe.
//
// ZEITZUENDER (aufgefallen 2026-07-30): Die Testdaten stehen auf
// identifyCheckedAtIso '2026-05-01T00:00:00.000Z', das Standardfenster des Skripts
// ist 90 Tage rueckwaerts ab Date.now(). Am 2026-07-29 lagen die Daten knapp INNERHALB
// des Fensters, am 2026-07-30 knapp AUSSERHALB — die Tests kippten also ueber Nacht
// von gruen auf rot, ohne dass sich eine Zeile Code geaendert hatte (processed 0 statt 3).
// Das Skript unterstuetzt Uhr-Injektion ausdruecklich ("optional clock injection for
// deterministic cutoff"), der Test nutzte sie nur nicht. Jetzt schon.
const FESTE_UHR = () => Date.parse('2026-06-15T12:00:00.000Z');

// ─── 1. Stub @google-cloud/firestore ──────────────────────────────────────
const gcpFsPath = require.resolve('@google-cloud/firestore');
try { require(gcpFsPath); } catch (_) {}
require.cache[gcpFsPath] = {
  id: gcpFsPath,
  filename: gcpFsPath,
  loaded: true,
  exports: {
    FieldValue: { serverTimestamp: () => 'TS', delete: () => null },
    Firestore: function () {},
    Timestamp: { now: () => ({}) },
  },
};

// ─── 2. In-memory firestore stub ──────────────────────────────────────────

function makeFirestoreStub({
  productsByTenant = new Map(),
  cursorDocs = new Map(),
  failures = {},
} = {}) {
  // productsByTenant: Map<tenantId, Array<{ id, data }>> (already ordered by identifyCheckedAtIso asc)
  // cursorDocs: Map<tenantId, object>
  // failures.queryShouldThrow / failures.writeShouldThrow / failures.writeForIds Set<string>
  const writtenUpdates = []; // { id, payload }
  const commits = [];

  function tenantQuery(tenantId, cutoffIso) {
    const all = productsByTenant.get(tenantId) || [];
    const filtered = all.filter((p) => {
      const v = p && p.data && p.data.identifyCheckedAtIso;
      if (!v) return false;
      return v >= cutoffIso;
    });
    return filtered;
  }

  function makeDocSnap(entry) {
    return {
      id: entry.id,
      exists: true,
      data: () => entry.data,
    };
  }

  function makeQuery(state) {
    return {
      _state: state,
      where(field, op, value) {
        const next = { ...state };
        if (field === 'tenantId' && op === '==') next.tenantId = value;
        if (field === 'identifyCheckedAtIso' && op === '>=') next.cutoffIso = value;
        return makeQuery(next);
      },
      orderBy(_field, _dir) {
        return makeQuery(state);
      },
      limit(n) {
        return makeQuery({ ...state, limit: n });
      },
      startAfter(snap) {
        return makeQuery({ ...state, startAfter: snap });
      },
      async get() {
        if (failures.queryShouldThrow) {
          throw new Error('simulated query failure');
        }
        const all = tenantQuery(state.tenantId, state.cutoffIso || '0000');
        let startIdx = 0;
        if (state.startAfter && state.startAfter.id) {
          const idx = all.findIndex((e) => e.id === state.startAfter.id);
          startIdx = idx >= 0 ? idx + 1 : 0;
        }
        const lim = Number.isFinite(state.limit) && state.limit > 0 ? state.limit : all.length;
        const slice = all.slice(startIdx, startIdx + lim);
        return { docs: slice.map(makeDocSnap), size: slice.length };
      },
    };
  }

  function productDocRef(id) {
    return {
      id,
      path: `products_v2/${id}`,
      async get() {
        for (const list of productsByTenant.values()) {
          const found = list.find((e) => e.id === id);
          if (found) return makeDocSnap(found);
        }
        return { exists: false, id, data: () => null };
      },
      async update(payload) {
        if (failures.writeForIds && failures.writeForIds.has(id)) {
          throw new Error(`simulated write failure ${id}`);
        }
        writtenUpdates.push({ id, payload });
      },
    };
  }

  function cursorDocRef(tenantId) {
    return {
      id: tenantId,
      async get() {
        const data = cursorDocs.get(tenantId);
        if (!data) return { exists: false, id: tenantId, data: () => null };
        return { exists: true, id: tenantId, data: () => data };
      },
      async set(payload, _opts) {
        const prev = cursorDocs.get(tenantId) || {};
        cursorDocs.set(tenantId, { ...prev, ...payload });
      },
    };
  }

  function batchInstance() {
    const ops = [];
    return {
      update: (ref, payload) => {
        ops.push({ ref, payload });
      },
      async commit() {
        for (const op of ops) {
          if (failures.writeShouldThrow) throw new Error('simulated batch commit failure');
          await op.ref.update(op.payload);
        }
        commits.push({ count: ops.length });
      },
    };
  }

  const firestore = {
    collection(name) {
      if (name === 'products_v2') {
        return {
          doc: (id) => productDocRef(id),
          where: (...args) => makeQuery({}).where(...args),
        };
      }
      if (name === 'system') {
        return {
          doc: (_sub) => ({
            collection: (_subname) => ({
              doc: (tenantId) => cursorDocRef(tenantId),
            }),
          }),
        };
      }
      return { doc: () => ({ get: async () => ({ exists: false, data: () => null }) }) };
    },
    batch: () => batchInstance(),
    // No bulkWriter — forces fallback to batch() path.
    _state: { productsByTenant, cursorDocs, writtenUpdates, commits, failures },
  };

  return firestore;
}

// ─── 3. Patch lib/firestore so script's require resolves to our stub on demand
const firestoreModulePath = require.resolve('../../lib/firestore');

function installFirestoreModuleStub(firestoreStub) {
  try { require(firestoreModulePath); } catch (_) {}
  require.cache[firestoreModulePath] = {
    id: firestoreModulePath,
    filename: firestoreModulePath,
    loaded: true,
    exports: { firestore: firestoreStub, FieldValue: { serverTimestamp: () => 'TS' } },
  };
}

// ─── 4. Patch cassini-scorer ──────────────────────────────────────────────
const scorerModulePath = require.resolve('../../lib/cassini-scorer');

function installScorerStub(scoreFn) {
  try { require(scorerModulePath); } catch (_) {}
  require.cache[scorerModulePath] = {
    id: scorerModulePath,
    filename: scorerModulePath,
    loaded: true,
    exports: { scoreProductCassini: scoreFn },
  };
}

// ─── 5. Load module under test fresh for each test ────────────────────────
function loadScript() {
  delete require.cache[require.resolve('../../scripts/cassini-backfill')];
  return require('../../scripts/cassini-backfill');
}

// ─── 6. Fixtures ──────────────────────────────────────────────────────────

function buildProduct(id, overrides = {}) {
  return {
    id,
    data: {
      id,
      tenantId: 'avycloud',
      identifyCheckedAtIso: '2026-05-01T00:00:00.000Z',
      identification: { name: `Product ${id}` },
      details: { description: '<p>desc</p>', images: [{ width: 1000, height: 1000 }] },
      ops: { data_quality: { identify_v4: { confidence: { aggregate: 0.8 } } } },
      ...overrides,
    },
  };
}

function fakeScorer() {
  return {
    overall: 0.75,
    title_score: 0.8,
    description_score: 0.7,
    image_score: 0.9,
    specifics_score: 0.6,
    compliance_score: 0.95,
    issues: [{ rule: 'mock', severity: 'info', message: 'm' }],
  };
}

// ─── Pure-helper tests ────────────────────────────────────────────────────

describe('cassini-backfill — parseArgs', () => {
  it('defaults to dry-run + 90 days + batchSize 500', () => {
    const script = loadScript();
    const a = script.parseArgs(['node', 's', '--tenant', 'avycloud']);
    expect(a.tenantId).toBe('avycloud');
    expect(a.dryRun).toBe(true);
    expect(a.apply).toBe(false);
    expect(a.batchSize).toBe(500);
    expect(a.days).toBe(90);
    expect(a.resume).toBe(false);
  });

  it('--apply sets apply=true, dryRun=false', () => {
    const script = loadScript();
    const a = script.parseArgs(['node', 's', '--tenant', 'avycloud', '--apply']);
    expect(a.apply).toBe(true);
    expect(a.dryRun).toBe(false);
  });

  it('parses --batch-size, --days, --resume', () => {
    const script = loadScript();
    const a = script.parseArgs([
      'node', 's', '--tenant', 'trendocean',
      '--batch-size', '250', '--days', '30', '--resume',
    ]);
    expect(a.tenantId).toBe('trendocean');
    expect(a.batchSize).toBe(250);
    expect(a.days).toBe(30);
    expect(a.resume).toBe(true);
  });

  it('supports --flag=value syntax', () => {
    const script = loadScript();
    const a = script.parseArgs(['node', 's', '--tenant=x', '--batch-size=100', '--days=7']);
    expect(a.tenantId).toBe('x');
    expect(a.batchSize).toBe(100);
    expect(a.days).toBe(7);
  });
});

describe('cassini-backfill — pickPipelineKey + alreadyHasCassini', () => {
  it('prefers identify_v4 when v4 metadata present', () => {
    const script = loadScript();
    const p = { ops: { data_quality: { identify_v4: {}, identify_v3: {} } } };
    expect(script.pickPipelineKey(p)).toBe('identify_v4');
  });

  it('falls back to identify_v3 if only v3 present', () => {
    const script = loadScript();
    const p = { ops: { data_quality: { identify_v3: {} } } };
    expect(script.pickPipelineKey(p)).toBe('identify_v3');
  });

  it('defaults to identify_v4 if neither present', () => {
    const script = loadScript();
    expect(script.pickPipelineKey({})).toBe('identify_v4');
    expect(script.pickPipelineKey({ ops: {} })).toBe('identify_v4');
  });

  it('alreadyHasCassini detects v4.cassini and v3.cassini', () => {
    const script = loadScript();
    expect(script.alreadyHasCassini({})).toBe(false);
    expect(script.alreadyHasCassini({ ops: { data_quality: { identify_v4: {} } } })).toBe(false);
    expect(script.alreadyHasCassini({ ops: { data_quality: { identify_v4: { cassini: {} } } } })).toBe(true);
    expect(script.alreadyHasCassini({ ops: { data_quality: { identify_v3: { cassini: { overall: 0.5 } } } } })).toBe(true);
  });
});

describe('cassini-backfill — buildUpdateForProduct', () => {
  it('produces correct updatePath + payload shape', () => {
    const script = loadScript();
    const product = { ops: { data_quality: { identify_v4: {} } } };
    const out = script.buildUpdateForProduct(product, fakeScorer);
    expect(out.pipelineKey).toBe('identify_v4');
    expect(out.updatePath).toBe('ops.data_quality.identify_v4.cassini');
    expect(out.cassiniPayload.overall).toBe(0.75);
    expect(out.cassiniPayload.scored_at_iso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(out.cassiniPayload.backfill_version).toBe('d5-v1');
    expect(Array.isArray(out.cassiniPayload.issues)).toBe(true);
  });
});

// ─── Integration tests via runBackfill ────────────────────────────────────

describe('cassini-backfill — runBackfill (dry-run)', () => {
  it('reports processed count without writing', async () => {
    const products = [
      buildProduct('p1'),
      buildProduct('p2'),
      buildProduct('p3'),
    ];
    const firestore = makeFirestoreStub({
      productsByTenant: new Map([['avycloud', products]]),
    });
    installFirestoreModuleStub(firestore);
    installScorerStub(fakeScorer);
    const script = loadScript();

    const args = script.parseArgs(['node', 's', '--tenant', 'avycloud', '--days', '90']);
    const summary = await script.runBackfill({
      firestore,
      scoreProductCassini: fakeScorer,
      args,
      sleepFn: () => Promise.resolve(),
      now: FESTE_UHR,
    });

    expect(summary.dryRun).toBe(true);
    expect(summary.processed).toBe(3);
    expect(summary.skipped).toBe(0);
    expect(summary.errors).toBe(0);
    expect(firestore._state.writtenUpdates.length).toBe(0);
  });
});

describe('cassini-backfill — runBackfill (apply)', () => {
  it('writes cassini scores to identify_v4.cassini path', async () => {
    const products = [buildProduct('p1'), buildProduct('p2')];
    const firestore = makeFirestoreStub({
      productsByTenant: new Map([['avycloud', products]]),
    });
    installFirestoreModuleStub(firestore);
    installScorerStub(fakeScorer);
    const script = loadScript();

    const args = script.parseArgs(['node', 's', '--tenant', 'avycloud', '--apply']);
    const summary = await script.runBackfill({
      firestore,
      scoreProductCassini: fakeScorer,
      args,
      sleepFn: () => Promise.resolve(),
      now: FESTE_UHR,
    });

    expect(summary.dryRun).toBe(false);
    expect(summary.processed).toBe(2);
    expect(summary.errors).toBe(0);
    expect(firestore._state.writtenUpdates.length).toBe(2);

    const u0 = firestore._state.writtenUpdates[0];
    expect(Object.keys(u0.payload)).toEqual(['ops.data_quality.identify_v4.cassini']);
    expect(u0.payload['ops.data_quality.identify_v4.cassini'].overall).toBe(0.75);

    // cursor doc must have been written.
    const cur = firestore._state.cursorDocs.get('avycloud');
    expect(cur).toBeTruthy();
    expect(cur.lastDocId).toBe('p2');
    expect(cur.processedCount).toBe(2);
    expect(cur.completedAtIso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('cassini-backfill — idempotency', () => {
  it('skips products that already have ops.data_quality.identify_v4.cassini', async () => {
    const products = [
      buildProduct('p1', {
        ops: {
          data_quality: {
            identify_v4: { cassini: { overall: 0.9, scored_at_iso: '2026-04-01T00:00:00Z' } },
          },
        },
      }),
      buildProduct('p2'),
      buildProduct('p3', {
        ops: { data_quality: { identify_v3: { cassini: { overall: 0.5 } } } },
      }),
    ];
    const firestore = makeFirestoreStub({
      productsByTenant: new Map([['avycloud', products]]),
    });
    installFirestoreModuleStub(firestore);
    installScorerStub(fakeScorer);
    const script = loadScript();

    const args = script.parseArgs(['node', 's', '--tenant', 'avycloud', '--apply']);
    const summary = await script.runBackfill({
      firestore,
      scoreProductCassini: fakeScorer,
      args,
      sleepFn: () => Promise.resolve(),
      now: FESTE_UHR,
    });

    expect(summary.processed).toBe(1); // only p2
    expect(summary.skipped).toBe(2);
    expect(firestore._state.writtenUpdates.length).toBe(1);
    expect(firestore._state.writtenUpdates[0].id).toBe('p2');
  });
});

describe('cassini-backfill — resume from cursor', () => {
  it('starts after cursor.lastDocId', async () => {
    const products = [
      buildProduct('p1'),
      buildProduct('p2'),
      buildProduct('p3'),
      buildProduct('p4'),
    ];
    const cursor = new Map([['avycloud', { lastDocId: 'p2', processedCount: 2, tenantId: 'avycloud' }]]);
    const firestore = makeFirestoreStub({
      productsByTenant: new Map([['avycloud', products]]),
      cursorDocs: cursor,
    });
    installFirestoreModuleStub(firestore);
    installScorerStub(fakeScorer);
    const script = loadScript();

    const args = script.parseArgs(['node', 's', '--tenant', 'avycloud', '--apply', '--resume']);
    const summary = await script.runBackfill({
      firestore,
      scoreProductCassini: fakeScorer,
      args,
      sleepFn: () => Promise.resolve(),
      now: FESTE_UHR,
    });

    // p3 + p4 should be processed; p1+p2 carried over from cursor.processedCount.
    expect(summary.processed).toBe(2 + 2); // resumed-carry + new
    const writtenIds = firestore._state.writtenUpdates.map((w) => w.id);
    expect(writtenIds.sort()).toEqual(['p3', 'p4']);
    expect(summary.last_doc_id).toBe('p4');
  });
});

describe('cassini-backfill — batch-size flag', () => {
  it('respects --batch-size and paginates correctly', async () => {
    const products = Array.from({ length: 5 }, (_, i) =>
      buildProduct(`p${i + 1}`, { identifyCheckedAtIso: `2026-05-0${i + 1}T00:00:00.000Z` })
    );
    const firestore = makeFirestoreStub({
      productsByTenant: new Map([['avycloud', products]]),
    });
    installFirestoreModuleStub(firestore);
    installScorerStub(fakeScorer);
    const script = loadScript();

    const args = script.parseArgs(['node', 's', '--tenant', 'avycloud', '--apply', '--batch-size', '2']);
    const summary = await script.runBackfill({
      firestore,
      scoreProductCassini: fakeScorer,
      args,
      sleepFn: () => Promise.resolve(),
      now: FESTE_UHR,
    });

    // 5 docs, batchSize 2 → 3 pages (2 + 2 + 1).
    expect(summary.processed).toBe(5);
    expect(summary.pages).toBe(3);
    expect(firestore._state.writtenUpdates.length).toBe(5);
  });
});

describe('cassini-backfill — error handling', () => {
  it('continues after individual doc write failure', async () => {
    const products = [buildProduct('p1'), buildProduct('p2'), buildProduct('p3')];
    const firestore = makeFirestoreStub({
      productsByTenant: new Map([['avycloud', products]]),
      failures: { writeForIds: new Set(['p2']) },
    });
    installFirestoreModuleStub(firestore);
    installScorerStub(fakeScorer);
    const script = loadScript();

    const args = script.parseArgs(['node', 's', '--tenant', 'avycloud', '--apply']);
    const summary = await script.runBackfill({
      firestore,
      scoreProductCassini: fakeScorer,
      args,
      sleepFn: () => Promise.resolve(),
      now: FESTE_UHR,
    });

    // p2 write throws via batch commit → batch-error counted once; the rest still tried.
    expect(summary.errors).toBeGreaterThanOrEqual(1);
    // Other ids still processed-counted (batch-mode counts ops at queue-time).
    expect(summary.processed).toBeGreaterThanOrEqual(2);
  });

  it('continues after scorer throws for a doc', async () => {
    const products = [buildProduct('p1'), buildProduct('p2')];
    const firestore = makeFirestoreStub({
      productsByTenant: new Map([['avycloud', products]]),
    });
    installFirestoreModuleStub(firestore);
    const flakyScorer = (p) => {
      if (p && p.id === 'p1') throw new Error('boom');
      return fakeScorer();
    };
    installScorerStub(flakyScorer);
    const script = loadScript();

    const args = script.parseArgs(['node', 's', '--tenant', 'avycloud', '--apply']);
    const summary = await script.runBackfill({
      firestore,
      scoreProductCassini: flakyScorer,
      args,
      sleepFn: () => Promise.resolve(),
      now: FESTE_UHR,
    });

    expect(summary.errors).toBe(1);
    expect(summary.processed).toBe(1); // only p2 succeeded
    expect(firestore._state.writtenUpdates.length).toBe(1);
    expect(firestore._state.writtenUpdates[0].id).toBe('p2');
  });
});

describe('cassini-backfill — graceful stub-mode', () => {
  it('returns stub summary when firestore/scorer are null', async () => {
    const script = loadScript();
    const args = script.parseArgs(['node', 's', '--tenant', 'avycloud']);
    const summary = await script.runBackfill({
      firestore: null,
      scoreProductCassini: null,
      args,
      sleepFn: () => Promise.resolve(),
      now: FESTE_UHR,
    });
    expect(summary.stub_mode).toBe(true);
    expect(summary.processed).toBe(0);
    expect(summary.errors).toBe(0);
    expect(summary.completed_at).toBeTruthy();
  });
});

describe('cassini-backfill — CLI subprocess (tenant guard)', () => {
  it('exits 1 when --tenant is missing', () => {
    const { spawnSync } = require('child_process');
    const SCRIPT = path.resolve(__dirname, '..', '..', 'scripts', 'cassini-backfill.js');
    const res = spawnSync('node', [SCRIPT, '--dry-run'], { encoding: 'utf8' });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/tenant.*mandatory/i);
  });
});

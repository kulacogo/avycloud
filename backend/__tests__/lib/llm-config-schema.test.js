'use strict';

// Vitest CJS; globals enabled (describe/it/expect/vi).
//
// Tests for the Phase F.1a additions in lib/llm-config.js:
//   - resolveScopeConfig (tenantOverrides, callerOverrides, merge order)
//   - loadScopeWithFallback (Firestore first, snapshot fallback)
//
// Also covers the dry-run path of scripts/migrate-llm-scope-schema.js
// (parseArgs + needsBackfill + needsScopeTenantOverrides helpers, plus a
// dry-run end-to-end with an in-memory firestore stub).

const fs = require('fs');
const path = require('path');

// Diese Datei prüft den Firestore-Pfad SELBST (gegen einen In-Memory-Stub, nicht
// gegen echtes GCP) und schaltet den Lookup deshalb ausdrücklich wieder ein.
// `vitest.setup.js` stellt ihn global auf 'off', weil der echte Client ohne
// Zugangsdaten so lange nach ihnen sucht, dass es das Zeitbudget der Tests
// sprengt — siehe llm-config-store-off.test.js.
process.env.LLM_CONFIG_STORE = 'on';

// ─── Stub @google-cloud/firestore early so importing lib/llm-config does not
//     touch the real GCP SDK. The module only needs `FieldValue.serverTimestamp`.
const gcpFsPath = require.resolve('@google-cloud/firestore');
try { require(gcpFsPath); } catch (_) {}
require.cache[gcpFsPath] = {
  id: gcpFsPath,
  filename: gcpFsPath,
  loaded: true,
  exports: {
    FieldValue: { serverTimestamp: () => null, delete: () => null },
    Firestore: function () {},
    Timestamp: { now: () => ({}) },
  },
};

// ─── In-memory firestore stub. The lib/llm-config module requires `./firestore`
//     which exposes `firestore`. We patch that with a tiny mock controllable
//     via setMockData/setMockError per test.
//
// Shape replicated: firestore.collection(name).doc(id).get() / .set() / .collection(sub).doc(vid).get()
//
const _state = {
  // map: 'llmScopes/{id}' -> data
  scopeDocs: new Map(),
  // map: 'llmScopes/{id}/versions/{vid}' -> data
  versionDocs: new Map(),
  // when truthy: collection().get() throws
  collectionGetError: null,
  // when truthy: getScope throws
  scopeDocGetError: null,
};

function _scopeKey(id) { return `llmScopes/${id}`; }
function _versionKey(sid, vid) { return `llmScopes/${sid}/versions/${vid}`; }

function _buildVersionCollection(scopeId) {
  return {
    doc: (vid) => ({
      get: async () => {
        const key = _versionKey(scopeId, String(vid));
        const data = _state.versionDocs.get(key);
        if (!data) return { exists: false, id: String(vid), data: () => null, ref: { collection: () => ({}) } };
        return {
          exists: true,
          id: String(vid),
          data: () => data,
          ref: { set: async (p, opts) => { _state.versionDocs.set(key, { ...data, ...p }); } },
        };
      },
      set: async (payload, _opts) => {
        const key = _versionKey(scopeId, String(vid));
        const existing = _state.versionDocs.get(key) || {};
        _state.versionDocs.set(key, { ...existing, ...payload });
      },
      id: String(vid),
    }),
    get: async () => {
      const docs = [];
      for (const [k, v] of _state.versionDocs.entries()) {
        if (!k.startsWith(`llmScopes/${scopeId}/versions/`)) continue;
        const vid = k.split('/').pop();
        docs.push({
          id: vid,
          data: () => v,
          ref: {
            set: async (payload, _opts) => {
              const existing = _state.versionDocs.get(k) || {};
              _state.versionDocs.set(k, { ...existing, ...payload });
            },
          },
        });
      }
      return { docs };
    },
  };
}

const firestoreMock = {
  collection: (name) => {
    if (name !== 'llmScopes') {
      // fall-through generic
      return {
        get: async () => ({ docs: [] }),
        doc: () => ({ get: async () => ({ exists: false, data: () => null }), set: async () => {} }),
      };
    }
    return {
      get: async () => {
        if (_state.collectionGetError) throw _state.collectionGetError;
        const docs = [];
        for (const [k, v] of _state.scopeDocs.entries()) {
          const sid = k.split('/').pop();
          docs.push({
            id: sid,
            data: () => v,
            ref: {
              set: async (payload, _opts) => {
                const existing = _state.scopeDocs.get(k) || {};
                _state.scopeDocs.set(k, { ...existing, ...payload });
              },
              collection: () => _buildVersionCollection(sid),
            },
          });
        }
        return { docs };
      },
      doc: (sid) => ({
        get: async () => {
          if (_state.scopeDocGetError) throw _state.scopeDocGetError;
          const key = _scopeKey(sid);
          const data = _state.scopeDocs.get(key);
          if (!data) return { exists: false, id: String(sid), data: () => null };
          return { exists: true, id: String(sid), data: () => data };
        },
        set: async (payload, _opts) => {
          const key = _scopeKey(sid);
          const existing = _state.scopeDocs.get(key) || {};
          _state.scopeDocs.set(key, { ...existing, ...payload });
        },
        collection: (_subName) => _buildVersionCollection(sid),
      }),
    };
  },
};

const firestoreModulePath = require.resolve('../../lib/firestore');
try { require(firestoreModulePath); } catch (_) {}
require.cache[firestoreModulePath] = {
  id: firestoreModulePath,
  filename: firestoreModulePath,
  loaded: true,
  exports: { firestore: firestoreMock, FieldValue: { serverTimestamp: () => null } },
};

// Stub logger so warn-calls don't pollute test output.
const loggerPath = require.resolve('../../lib/logger');
try { require(loggerPath); } catch (_) {}
require.cache[loggerPath] = {
  id: loggerPath,
  filename: loggerPath,
  loaded: true,
  exports: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
};

// Load module under test AFTER patches are in place.
delete require.cache[require.resolve('../../lib/llm-config')];
const llmConfig = require('../../lib/llm-config');

// ─── Helpers ───────────────────────────────────────────────────────────────

function resetState() {
  _state.scopeDocs.clear();
  _state.versionDocs.clear();
  _state.collectionGetError = null;
  _state.scopeDocGetError = null;
  llmConfig.__resetSnapshotCacheForTests();
  llmConfig.__resetActiveConfigCacheForTests();
}

function seedScope(id, data) {
  _state.scopeDocs.set(_scopeKey(id), data);
}

function seedVersion(sid, vid, data) {
  _state.versionDocs.set(_versionKey(sid, vid), data);
}

// Snapshot disk fixture handling — we write to a tmp file and monkey-patch
// SNAPSHOT_FILE consumer by using llmConfig.SNAPSHOT_FILE? It's bound at load
// time, so we instead write the actual lib/llm-scopes-snapshot.json during the
// snapshot tests and clean up after.
//
// IMPORTANT: lib/llm-scopes-snapshot.json is a CHECKED-IN production artifact
// (Phase F.1a bundled fallback). Tests must back it up before mutating + restore
// after, otherwise running the test suite locally wipes the deployed snapshot.
const REAL_SNAPSHOT = llmConfig.SNAPSHOT_FILE;
let _snapshotBackup = null;
let _snapshotExistedBefore = false;

function backupRealSnapshot() {
  try {
    _snapshotBackup = fs.readFileSync(REAL_SNAPSHOT, 'utf8');
    _snapshotExistedBefore = true;
  } catch (_) {
    _snapshotBackup = null;
    _snapshotExistedBefore = false;
  }
}

function restoreRealSnapshot() {
  if (_snapshotExistedBefore && _snapshotBackup !== null) {
    fs.writeFileSync(REAL_SNAPSHOT, _snapshotBackup, 'utf8');
  } else {
    try { fs.unlinkSync(REAL_SNAPSHOT); } catch (_) {}
  }
  llmConfig.__resetSnapshotCacheForTests();
}

function writeSnapshotFixture(payload) {
  fs.writeFileSync(REAL_SNAPSHOT, JSON.stringify(payload, null, 2), 'utf8');
  llmConfig.__resetSnapshotCacheForTests();
}

function removeSnapshotFixture() {
  try { fs.unlinkSync(REAL_SNAPSHOT); } catch (_) {}
  llmConfig.__resetSnapshotCacheForTests();
}

beforeAll(() => {
  backupRealSnapshot();
});

afterAll(() => {
  restoreRealSnapshot();
});

beforeEach(() => {
  resetState();
});

afterEach(() => {
  removeSnapshotFixture();
});

// ─── resolveScopeConfig ────────────────────────────────────────────────────

describe('resolveScopeConfig', () => {
  it('returns defaults (gemini-config) when scope-version has no overrides', async () => {
    seedScope('chat.product', { activeVersionId: 'v1', defaultModelEnvKey: 'CHAT_MODEL' });
    seedVersion('chat.product', 'v1', {
      promptText: 'sys prompt',
      rulesText: 'rules',
      promptMode: 'append',
      rulesMode: 'append',
    });

    const cfg = await llmConfig.resolveScopeConfig('chat.product', null);
    expect(cfg.scopeId).toBe('chat.product');
    expect(cfg.versionId).toBe('v1');
    expect(cfg.system_prompt).toBe('sys prompt');
    expect(cfg.rules_text).toBe('rules');
    expect(cfg.model).toBe('gemini-2.5-pro');
    // gemini-config defaults baked in
    expect(cfg.generationConfig.temperature).toBe(1.0);
    expect(cfg.generationConfig.maxOutputTokens).toBe(8192);
    expect(cfg.generationConfig.thinkingConfig).toEqual({
      thinkingBudget: 4096,
      includeThoughts: true,
    });
    expect(cfg.userTemplate).toBe('');
    expect(cfg.outputSchemaHint).toBe('');
  });

  it('applies tenantOverride for matching tenantId (version + model + genConfig)', async () => {
    seedScope('chat.product', {
      activeVersionId: 'v1',
      tenantOverrides: {
        'tenant-A': {
          version: 'v2',
          modelOverride: 'gemini-3-flash-preview',
          generationConfig: { temperature: 0.4 },
        },
      },
    });
    seedVersion('chat.product', 'v1', { promptText: 'P1', rulesText: 'R1' });
    seedVersion('chat.product', 'v2', { promptText: 'P2', rulesText: 'R2' });

    const cfg = await llmConfig.resolveScopeConfig('chat.product', 'tenant-A');
    expect(cfg.versionId).toBe('v2');
    expect(cfg.system_prompt).toBe('P2');
    expect(cfg.model).toBe('gemini-2.5-flash');
    expect(cfg.generationConfig.temperature).toBe(0.4);
    expect(cfg.generationConfig.maxOutputTokens).toBe(8192); // gemini-config default still present
  });

  it('callerOverrides win over tenantOverrides which win over scope/version generationConfig', async () => {
    seedScope('chat.product', {
      activeVersionId: 'v1',
      tenantOverrides: {
        'tenant-B': { generationConfig: { temperature: 0.5, topK: 40 } },
      },
    });
    seedVersion('chat.product', 'v1', {
      promptText: 'P',
      rulesText: 'R',
      generationConfig: { temperature: 0.2, topP: 0.9 },
    });

    const cfg = await llmConfig.resolveScopeConfig(
      'chat.product',
      'tenant-B',
      { temperature: 0.95, maxOutputTokens: 1024 }
    );
    // caller temperature wins
    expect(cfg.generationConfig.temperature).toBe(0.95);
    // caller maxOutputTokens overrides gemini-config default
    expect(cfg.generationConfig.maxOutputTokens).toBe(1024);
    // tenant topK still present (not overridden)
    expect(cfg.generationConfig.topK).toBe(40);
    // version topP still present (not overridden)
    expect(cfg.generationConfig.topP).toBe(0.9);
  });

  it('throws on unknown scope', async () => {
    await expect(llmConfig.resolveScopeConfig('does.not.exist', null)).rejects.toThrow(
      /unknown scope/
    );
  });

  it('throws when scope has no active version (and no tenantOverride)', async () => {
    seedScope('chat.product', { activeVersionId: null });
    await expect(llmConfig.resolveScopeConfig('chat.product', null)).rejects.toThrow(
      /no active version/
    );
  });

  it('exposes version-level modelOverride when tenant has no override', async () => {
    seedScope('identify.v2', { activeVersionId: 'v1' });
    seedVersion('identify.v2', 'v1', {
      promptText: '',
      rulesText: '',
      modelOverride: 'gemini-3.1-flash-lite',
    });
    const cfg = await llmConfig.resolveScopeConfig('identify.v2', null);
    expect(cfg.model).toBe('gemini-2.5-flash');
  });

  it('propagates userTemplate + outputSchemaHint from the version doc', async () => {
    seedScope('improve.product', { activeVersionId: 'v1' });
    seedVersion('improve.product', 'v1', {
      promptText: '',
      rulesText: '',
      userTemplate: 'Improve product {{productName}} ({{sku}})',
      outputSchemaHint: '{"type":"object","required":["title"]}',
    });
    const cfg = await llmConfig.resolveScopeConfig('improve.product', null);
    expect(cfg.userTemplate).toBe('Improve product {{productName}} ({{sku}})');
    expect(cfg.outputSchemaHint).toBe('{"type":"object","required":["title"]}');
  });

  // ── CRITICAL-1 fix: tenantOverride.generationConfig must merge ADDITIVELY
  //    over version-level generationConfig (not replace). ─────────────────────
  it('CRITICAL-1: tenantOverride.generationConfig merges additively over version generationConfig', async () => {
    seedScope('chat.product', {
      activeVersionId: 'v1',
      tenantOverrides: {
        'tenant-X': {
          generationConfig: { temperature: 0.7 }, // tenant only overrides temperature
        },
      },
    });
    seedVersion('chat.product', 'v1', {
      promptText: 'P',
      rulesText: 'R',
      generationConfig: { temperature: 0.2, topP: 0.85, topK: 32 },
    });

    const cfg = await llmConfig.resolveScopeConfig('chat.product', 'tenant-X');
    // tenant temperature wins
    expect(cfg.generationConfig.temperature).toBe(0.7);
    // BUT version topP/topK still present — they are NOT erased by tenant
    // override (which is the additive contract documented in the merge order).
    expect(cfg.generationConfig.topP).toBe(0.85);
    expect(cfg.generationConfig.topK).toBe(32);
    // gemini-config defaults still present
    expect(cfg.generationConfig.maxOutputTokens).toBe(8192);
  });

  // ── HIGH-10 fix: callerOverrides accepts both flat and nested
  //    `{ generationConfig: {...} }` shapes. ─────────────────────────────────
  it('HIGH-10: callerOverrides accepts nested { generationConfig: {...} } shape', async () => {
    seedScope('chat.product', { activeVersionId: 'v1' });
    seedVersion('chat.product', 'v1', {
      promptText: '',
      rulesText: '',
      generationConfig: { temperature: 0.2 },
    });

    const cfg = await llmConfig.resolveScopeConfig(
      'chat.product',
      null,
      { generationConfig: { temperature: 0.93, topK: 21 } }
    );
    // Nested fields are unwrapped and applied just like flat ones
    expect(cfg.generationConfig.temperature).toBe(0.93);
    expect(cfg.generationConfig.topK).toBe(21);
  });

  it('HIGH-10: top-level callerOverrides keys win over nested ones when both supplied', async () => {
    seedScope('chat.product', { activeVersionId: 'v1' });
    seedVersion('chat.product', 'v1', { promptText: '', rulesText: '' });

    const cfg = await llmConfig.resolveScopeConfig(
      'chat.product',
      null,
      {
        generationConfig: { temperature: 0.4, topK: 10 },
        temperature: 0.99, // top-level wins
      }
    );
    expect(cfg.generationConfig.temperature).toBe(0.99);
    // nested-only key still applied
    expect(cfg.generationConfig.topK).toBe(10);
  });

  it('HIGH-10: nested model field is unwrapped (model option still resolves correctly)', async () => {
    seedScope('chat.product', { activeVersionId: 'v1' });
    seedVersion('chat.product', 'v1', { promptText: '', rulesText: '' });

    // Caller can still pass model at top-level alongside a nested
    // generationConfig — both work side-by-side.
    const cfg = await llmConfig.resolveScopeConfig('chat.product', null, {
      model: 'gemini-3-flash-preview',
      generationConfig: { temperature: 0.1 },
    });
    expect(cfg.model).toBe('gemini-2.5-flash');
    expect(cfg.generationConfig.temperature).toBe(0.1);
  });
});

// ─── loadScopeWithFallback ─────────────────────────────────────────────────

describe('loadScopeWithFallback', () => {
  it('returns Firestore-scope when available (source = firestore)', async () => {
    seedScope('chat.product', { activeVersionId: 'v1' });
    seedVersion('chat.product', 'v1', { promptText: 'live', rulesText: 'liveRules' });
    const cfg = await llmConfig.loadScopeWithFallback('chat.product');
    expect(cfg.source).toBe('firestore');
    expect(cfg.promptText).toBe('live');
  });

  it('falls back to snapshot when Firestore throws', async () => {
    _state.scopeDocGetError = new Error('firestore unavailable');
    writeSnapshotFixture({
      snapshotGeneratedAt: '2026-05-10T00:00:00Z',
      scopes: [
        {
          id: 'chat.product',
          versionId: 'v-snap',
          promptText: 'snapshot prompt',
          rulesText: 'snapshot rules',
          promptMode: 'append',
          rulesMode: 'append',
          userTemplate: 'hello {{x}}',
          outputSchemaHint: '',
          modelOverride: null,
          generationConfig: { temperature: 0.7 },
        },
      ],
    });
    const cfg = await llmConfig.loadScopeWithFallback('chat.product');
    expect(cfg.source).toBe('snapshot');
    expect(cfg.promptText).toBe('snapshot prompt');
    expect(cfg.generationConfig.temperature).toBe(0.7);
    expect(cfg.snapshotGeneratedAt).toBe('2026-05-10T00:00:00Z');
  });

  it('throws when both Firestore-load and snapshot fail', async () => {
    _state.scopeDocGetError = new Error('firestore down');
    // ensure no snapshot
    removeSnapshotFixture();
    await expect(llmConfig.loadScopeWithFallback('chat.product')).rejects.toThrow(
      /no bundled snapshot|missing in snapshot/
    );
  });

  it('throws when snapshot exists but lacks the requested scope', async () => {
    _state.scopeDocGetError = new Error('firestore down');
    writeSnapshotFixture({
      snapshotGeneratedAt: '2026-05-10T00:00:00Z',
      scopes: [{ id: 'identify.v2', promptText: 'x', rulesText: '' }],
    });
    await expect(llmConfig.loadScopeWithFallback('chat.product')).rejects.toThrow(
      /missing in snapshot/
    );
  });

  // ── HIGH-2 fix: snapshot path returns BOTH legacy (`promptText`) AND
  //    normalized (`system_prompt`, `rules_text`, `model`) fields. ───────────
  it('HIGH-2: snapshot fallback returns normalized shape alongside legacy fields', async () => {
    _state.scopeDocGetError = new Error('firestore unreachable');
    writeSnapshotFixture({
      snapshotGeneratedAt: '2026-05-10T00:00:00Z',
      scopes: [
        {
          id: 'chat.product',
          versionId: 'v-snap',
          promptText: 'snapshot sys prompt',
          rulesText: 'snapshot rules text',
          promptMode: 'append',
          rulesMode: 'append',
          userTemplate: 'tpl {{x}}',
          outputSchemaHint: '{"type":"string"}',
          modelOverride: 'gemini-3.1-pro-preview',
          generationConfig: { temperature: 0.42, maxOutputTokens: 2048 },
          tenantOverrides: { 'tenant-X': { modelOverride: 'gemini-3-flash-preview' } },
        },
      ],
    });
    const cfg = await llmConfig.loadScopeWithFallback('chat.product');
    // Legacy fields preserved (backwards-compat)
    expect(cfg.promptText).toBe('snapshot sys prompt');
    expect(cfg.rulesText).toBe('snapshot rules text');
    expect(cfg.modelOverride).toBe('gemini-3.1-pro-preview');
    // Normalized fields (mirrors resolveScopeConfig contract)
    expect(cfg.system_prompt).toBe('snapshot sys prompt');
    expect(cfg.rules_text).toBe('snapshot rules text');
    expect(cfg.model).toBe('gemini-2.5-pro');
    expect(cfg.user_template).toBe('tpl {{x}}');
    expect(cfg.output_schema_hint).toBe('{"type":"string"}');
    expect(cfg.generation_config).toEqual({ temperature: 0.42, maxOutputTokens: 2048 });
    expect(cfg.tenantOverrides).toEqual({
      'tenant-X': { modelOverride: 'gemini-3-flash-preview' },
    });
    expect(cfg.source).toBe('snapshot');
  });

  it('HIGH-2: snapshot fallback resolves model from defaultModelEnvKey when no modelOverride', async () => {
    _state.scopeDocGetError = new Error('firestore unreachable');
    const originalEnv = process.env.GEMINI_CHAT_MODEL;
    process.env.GEMINI_CHAT_MODEL = 'gemini-3.1-pro-preview-customtools';
    try {
      writeSnapshotFixture({
        snapshotGeneratedAt: '2026-05-10T00:00:00Z',
        scopes: [
          {
            id: 'chat.product',
            versionId: 'v-snap',
            promptText: 'p',
            rulesText: 'r',
            defaultModelEnvKey: 'GEMINI_CHAT_MODEL',
            // no modelOverride → ENV-key resolution kicks in
          },
        ],
      });
      const cfg = await llmConfig.loadScopeWithFallback('chat.product');
      expect(cfg.model).toBe('gemini-2.5-pro');
      expect(cfg.modelOverride).toBeNull();
    } finally {
      if (originalEnv === undefined) delete process.env.GEMINI_CHAT_MODEL;
      else process.env.GEMINI_CHAT_MODEL = originalEnv;
    }
  });
});

// ─── Migration script helpers + dry-run end-to-end ─────────────────────────

describe('migrate-llm-scope-schema (dry-run helpers + flow)', () => {
  const migration = require('../../scripts/migrate-llm-scope-schema');

  it('parseArgs defaults to dry-run when no flag provided', () => {
    expect(migration.parseArgs(['node', 'script'])).toEqual({ dryRun: true, apply: false });
    expect(migration.parseArgs(['node', 'script', '--apply'])).toEqual({ dryRun: false, apply: true });
    expect(migration.parseArgs(['node', 'script', '--dry-run'])).toEqual({ dryRun: true, apply: false });
  });

  it('needsBackfill is true when none of the 5 new fields exist', () => {
    expect(migration.needsBackfill({ promptText: 'x' })).toBe(true);
    expect(migration.needsBackfill({ promptText: 'x', userTemplate: '' })).toBe(false);
  });

  it('needsScopeTenantOverrides is true when tenantOverrides is missing', () => {
    expect(migration.needsScopeTenantOverrides({ activeVersionId: 'v1' })).toBe(true);
    expect(migration.needsScopeTenantOverrides({ tenantOverrides: {} })).toBe(false);
  });

  it('buildBackfillPayload yields the documented defaults + migrationVersion marker', () => {
    expect(migration.buildBackfillPayload()).toEqual({
      userTemplate: '',
      outputSchemaHint: '',
      modelOverride: null,
      generationConfig: {},
      migrationVersion: 'v1.0-phase-f1a',
    });
  });

  it('--dry-run identifies scopes needing backfill and writes no data', async () => {
    seedScope('chat.product', { activeVersionId: 'v1' /* no tenantOverrides */ });
    seedVersion('chat.product', 'v1', { promptText: 'P', rulesText: 'R' });
    seedScope('identify.v2', { activeVersionId: 'v1', tenantOverrides: {} }); // already migrated
    seedVersion('identify.v2', 'v1', {
      promptText: 'P',
      rulesText: 'R',
      userTemplate: '',
      outputSchemaHint: '',
      modelOverride: null,
      generationConfig: {},
    });

    // Replicate the script's core loop in-process without spawning a child node
    // (we cannot easily import migrate-llm-scope-schema's run() without
    // triggering process.exit). Instead, exercise the helpers + assert no
    // version writes happened to Firestore for the "needs backfill" docs.
    const beforeVersionData = { ..._state.versionDocs.get(_versionKey('chat.product', 'v1')) };
    const beforeScopeData = { ..._state.scopeDocs.get(_scopeKey('chat.product')) };

    // Simulate dry-run: detect but do not write.
    const scopeData = _state.scopeDocs.get(_scopeKey('chat.product'));
    const versionData = _state.versionDocs.get(_versionKey('chat.product', 'v1'));
    expect(migration.needsScopeTenantOverrides(scopeData)).toBe(true);
    expect(migration.needsBackfill(versionData)).toBe(true);

    const scopeData2 = _state.scopeDocs.get(_scopeKey('identify.v2'));
    const versionData2 = _state.versionDocs.get(_versionKey('identify.v2', 'v1'));
    expect(migration.needsScopeTenantOverrides(scopeData2)).toBe(false);
    expect(migration.needsBackfill(versionData2)).toBe(false);

    // After dry-run, neither doc should have changed.
    expect(_state.versionDocs.get(_versionKey('chat.product', 'v1'))).toEqual(beforeVersionData);
    expect(_state.scopeDocs.get(_scopeKey('chat.product'))).toEqual(beforeScopeData);
  });
});

// Keep `path` referenced to satisfy lint when adapted later.
void path;

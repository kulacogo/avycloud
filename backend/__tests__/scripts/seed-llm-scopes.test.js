'use strict';

// Vitest CJS — globals enabled (describe/it/expect/vi).
//
// Tests for scripts/seed-llm-scopes.js. Pure function tests + in-memory
// firestore stub (require.cache pattern, no real GCP).

const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── Stub @google-cloud/firestore so require chain in firestore.js doesn't
//     touch real GCP SDK.
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

// ─── In-memory firestore stub.
const _state = {
  scopeDocs: new Map(),       // 'llmScopes/{id}' -> data
  versionDocs: new Map(),     // 'llmScopes/{id}/versions/{vid}' -> data
  scopeReadError: null,       // truthy -> scope.get() throws
  versionWriteError: null,    // truthy -> version.set() throws
  scopeWriteError: null,      // truthy -> scope.set() throws
  versionAutoId: 0,
};

function _scopeKey(id) { return `llmScopes/${id}`; }
function _versionKey(sid, vid) { return `llmScopes/${sid}/versions/${vid}`; }

function _nextVersionId(scopeId) {
  _state.versionAutoId++;
  return `v${_state.versionAutoId}-${scopeId.replace(/\W+/g, '_')}`;
}

function _buildVersionCollection(scopeId) {
  return {
    doc: (vid) => {
      const useVid = vid || _nextVersionId(scopeId);
      return {
        id: useVid,
        get: async () => {
          const data = _state.versionDocs.get(_versionKey(scopeId, useVid));
          if (!data) return { exists: false, id: useVid, data: () => null };
          return { exists: true, id: useVid, data: () => data };
        },
        set: async (payload) => {
          if (_state.versionWriteError) throw _state.versionWriteError;
          const key = _versionKey(scopeId, useVid);
          const existing = _state.versionDocs.get(key) || {};
          _state.versionDocs.set(key, { ...existing, ...payload });
        },
      };
    },
  };
}

const firestoreMock = {
  collection: (name) => {
    if (name !== 'llmScopes') {
      return {
        doc: () => ({
          get: async () => ({ exists: false, data: () => null }),
          set: async () => {},
        }),
      };
    }
    return {
      doc: (sid) => ({
        get: async () => {
          if (_state.scopeReadError) throw _state.scopeReadError;
          const data = _state.scopeDocs.get(_scopeKey(sid));
          if (!data) return { exists: false, id: sid, data: () => null };
          return { exists: true, id: sid, data: () => data };
        },
        set: async (payload, _opts) => {
          if (_state.scopeWriteError) throw _state.scopeWriteError;
          const key = _scopeKey(sid);
          const existing = _state.scopeDocs.get(key) || {};
          _state.scopeDocs.set(key, { ...existing, ...payload });
        },
        collection: () => _buildVersionCollection(sid),
      }),
    };
  },
};

// Patch lib/firestore so the seed script's require('../lib/firestore') picks
// up our stub.
const firestoreModulePath = require.resolve('../../lib/firestore');
try { require(firestoreModulePath); } catch (_) {}
require.cache[firestoreModulePath] = {
  id: firestoreModulePath,
  filename: firestoreModulePath,
  loaded: true,
  exports: { firestore: firestoreMock, FieldValue: { serverTimestamp: () => 'TS' } },
};

// Load module under test AFTER patches.
delete require.cache[require.resolve('../../scripts/seed-llm-scopes')];
const seed = require('../../scripts/seed-llm-scopes');

// ─── Helpers ───────────────────────────────────────────────────────────────

function resetState() {
  _state.scopeDocs.clear();
  _state.versionDocs.clear();
  _state.scopeReadError = null;
  _state.versionWriteError = null;
  _state.scopeWriteError = null;
  _state.versionAutoId = 0;
}

let tmpDir = null;

function makeTmpDir() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-llm-scopes-'));
  return tmpDir;
}

function rmTmpDir() {
  if (tmpDir) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    tmpDir = null;
  }
}

function writeScopeFile(dir, filename, payload) {
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(payload, null, 2), 'utf8');
}

function makeValidScopePayload(scopeId, overrides = {}) {
  return {
    scopeId,
    name: `Test ${scopeId}`,
    purpose: 'test purpose',
    defaultModelEnvKey: 'TEST_MODEL_ENV',
    version: {
      promptMode: 'replace',
      rulesMode: 'append',
      note: 'test note',
      promptText: 'system prompt content',
      rulesText: 'rules content',
      userTemplate: '{{x}}',
      outputSchemaHint: '{"type":"object"}',
      modelOverride: null,
      generationConfig: { temperature: 0.5, maxOutputTokens: 1024 },
    },
    tenantOverrides: {},
    ...overrides,
  };
}

beforeEach(() => {
  resetState();
  makeTmpDir();
});

afterEach(() => {
  rmTmpDir();
});

// ─── Pure helper tests ─────────────────────────────────────────────────────

describe('seed-llm-scopes — pure helpers', () => {
  it('parseArgs defaults to dry-run when no flag provided', () => {
    expect(seed.parseArgs(['node', 'script']).dryRun).toBe(true);
    expect(seed.parseArgs(['node', 'script']).apply).toBe(false);
    expect(seed.parseArgs(['node', 'script', '--apply']).apply).toBe(true);
    expect(seed.parseArgs(['node', 'script', '--dry-run']).dryRun).toBe(true);
  });

  it('parseArgs supports --dir override', () => {
    const args = seed.parseArgs(['node', 'script', '--dir', '/tmp/foo']);
    expect(args.dir).toBe(path.resolve('/tmp/foo'));
  });

  it('validateScopePayload rejects missing scopeId / version', () => {
    expect(seed.validateScopePayload(null)).toMatch(/payload/);
    expect(seed.validateScopePayload({})).toMatch(/scopeId\/id/);
    expect(seed.validateScopePayload({ scopeId: 'x' })).toMatch(/name/);
    expect(
      seed.validateScopePayload({ scopeId: 'x', name: 'n', purpose: 'p' })
    ).toMatch(/promptText|version/);
    // Nested F.2.B-style
    expect(
      seed.validateScopePayload({
        scopeId: 'x',
        name: 'n',
        purpose: 'p',
        version: { promptText: 'a', rulesText: 'b' },
      })
    ).toBe(null);
    // Flat F.2.A-style with `id`
    expect(
      seed.validateScopePayload({
        id: 'y',
        name: 'n',
        purpose: 'p',
        version: 'v1.0',
        promptText: 'a',
        rulesText: 'b',
      })
    ).toBe(null);
  });

  it('extractScopeId accepts both scopeId and id keys', () => {
    expect(seed.extractScopeId({ scopeId: 'a.b' })).toBe('a.b');
    expect(seed.extractScopeId({ id: 'c.d' })).toBe('c.d');
    // scopeId takes precedence when both present.
    expect(seed.extractScopeId({ scopeId: 'a.b', id: 'c.d' })).toBe('a.b');
    expect(seed.extractScopeId({})).toBe('');
    expect(seed.extractScopeId(null)).toBe('');
  });

  it('extractVersionSource flattens or descends depending on F.2 shape', () => {
    // Nested (F.2.B style)
    const nested = seed.extractVersionSource({
      version: { promptText: 'P', rulesText: 'R', promptMode: 'replace' },
    });
    expect(nested.promptText).toBe('P');
    expect(nested.promptMode).toBe('replace');
    // Flat (F.2.A style with version=string)
    const flat = seed.extractVersionSource({
      version: 'v1.0-phase-f2',
      promptText: 'Pf',
      rulesText: 'Rf',
      promptMode: 'append',
    });
    expect(flat.promptText).toBe('Pf');
    expect(flat.note).toBe('v1.0-phase-f2');
  });

  it('buildVersionPayload normalizes modes + null fields', () => {
    const v = seed.buildVersionPayload({
      promptText: 'P',
      rulesText: 'R',
      promptMode: 'weird',
      rulesMode: 'replace',
      note: 'x'.repeat(800),
      userTemplate: 't',
      outputSchemaHint: '',
      modelOverride: 'gemini-3-flash',
      generationConfig: { temperature: 0.3 },
    });
    expect(v.promptMode).toBe('append'); // unknown defaults to append
    expect(v.rulesMode).toBe('replace');
    expect(v.note.length).toBeLessThanOrEqual(500);
    expect(v.modelOverride).toBe('gemini-3-flash');
    expect(v.generationConfig).toEqual({ temperature: 0.3 });
  });

  it('versionContentMatches detects identical content', () => {
    const fileVer = seed.buildVersionPayload({
      promptText: 'P',
      rulesText: 'R',
      promptMode: 'append',
      rulesMode: 'append',
      generationConfig: { temperature: 0.5 },
    });
    const existing = {
      promptText: 'P',
      rulesText: 'R',
      promptMode: 'append',
      rulesMode: 'append',
      userTemplate: '',
      outputSchemaHint: '',
      modelOverride: null,
      generationConfig: { temperature: 0.5 },
    };
    expect(seed.versionContentMatches(fileVer, existing)).toBe(true);

    const differs = { ...existing, promptText: 'P2' };
    expect(seed.versionContentMatches(fileVer, differs)).toBe(false);

    const differsGenCfg = { ...existing, generationConfig: { temperature: 0.6 } };
    expect(seed.versionContentMatches(fileVer, differsGenCfg)).toBe(false);
  });

  it('readScopeFiles parses every .json file and surfaces parse errors', () => {
    writeScopeFile(tmpDir, 'good.json', makeValidScopePayload('test.good'));
    fs.writeFileSync(path.join(tmpDir, 'bad.json'), '{ this is not json', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'ignore.txt'), 'not json', 'utf8');

    const files = seed.readScopeFiles(tmpDir);
    expect(files.length).toBe(2);
    const good = files.find((f) => f.file === 'good.json');
    const bad = files.find((f) => f.file === 'bad.json');
    expect(good.payload.scopeId).toBe('test.good');
    expect(bad.parseError).toMatch(/JSON|Unexpected|Expected/i);
  });
});

// ─── End-to-end processScopeFile flow tests ────────────────────────────────

describe('seed-llm-scopes — processScopeFile (dry-run)', () => {
  const FieldValue = { serverTimestamp: () => 'TS' };

  it('dry-run: identifies missing scope, writes nothing', async () => {
    const payload = makeValidScopePayload('test.alpha');
    const summary = freshSummary();
    await seed.processScopeFile(
      firestoreMock,
      FieldValue,
      { file: 'alpha.json', payload },
      { apply: false, summary }
    );
    expect(summary.scopes_processed).toBe(1);
    expect(summary.scopes_created).toBe(1);
    expect(summary.versions_created).toBe(1);
    expect(summary.no_op).toBe(0);
    expect(summary.errors).toBe(0);
    // No actual write happened.
    expect(_state.scopeDocs.size).toBe(0);
    expect(_state.versionDocs.size).toBe(0);
    expect(summary.details[0].action).toBe('would_create_scope_and_version');
    expect(summary.details[0].applied).toBe(false);
  });
});

describe('seed-llm-scopes — processScopeFile (apply)', () => {
  const FieldValue = { serverTimestamp: () => 'TS' };

  it('apply: creates new scope + first active version when scope is missing', async () => {
    const payload = makeValidScopePayload('test.beta');
    const summary = freshSummary();
    await seed.processScopeFile(
      firestoreMock,
      FieldValue,
      { file: 'beta.json', payload },
      { apply: true, summary }
    );
    expect(summary.scopes_created).toBe(1);
    expect(summary.versions_created).toBe(1);
    expect(summary.errors).toBe(0);
    expect(_state.scopeDocs.size).toBe(1);
    expect(_state.versionDocs.size).toBe(1);
    const scope = _state.scopeDocs.get(_scopeKey('test.beta'));
    expect(scope.activeVersionId).toBeTruthy();
    expect(scope.name).toBe('Test test.beta');
    expect(scope.tenantOverrides).toEqual({});
    const versionKey = Array.from(_state.versionDocs.keys())[0];
    const versionData = _state.versionDocs.get(versionKey);
    expect(versionData.promptText).toBe('system prompt content');
    expect(versionData.seededByScript).toBe('seed-llm-scopes');
    expect(versionData.sourceFile).toBe('beta.json');
  });

  it('apply: skips existing identical scope (no_op)', async () => {
    // Seed scope+active version with identical content first.
    const scopeId = 'test.gamma';
    _state.scopeDocs.set(_scopeKey(scopeId), {
      scopeId,
      name: 'Test test.gamma',
      activeVersionId: 'v-existing',
    });
    _state.versionDocs.set(_versionKey(scopeId, 'v-existing'), {
      promptText: 'system prompt content',
      rulesText: 'rules content',
      promptMode: 'replace',
      rulesMode: 'append',
      userTemplate: '{{x}}',
      outputSchemaHint: '{"type":"object"}',
      modelOverride: null,
      generationConfig: { temperature: 0.5, maxOutputTokens: 1024 },
    });

    const payload = makeValidScopePayload(scopeId);
    const summary = freshSummary();
    await seed.processScopeFile(
      firestoreMock,
      FieldValue,
      { file: 'gamma.json', payload },
      { apply: true, summary }
    );
    expect(summary.no_op).toBe(1);
    expect(summary.scopes_created).toBe(0);
    expect(summary.versions_created).toBe(0);
    expect(summary.errors).toBe(0);
    // No new version doc was created.
    expect(_state.versionDocs.size).toBe(1);
    expect(summary.details[0].action).toBe('no_op_identical');
  });

  it('apply: creates new (inactive) version when scope diverges', async () => {
    const scopeId = 'test.delta';
    _state.scopeDocs.set(_scopeKey(scopeId), {
      scopeId,
      name: 'Test test.delta',
      activeVersionId: 'v-old',
    });
    _state.versionDocs.set(_versionKey(scopeId, 'v-old'), {
      promptText: 'OLD prompt',
      rulesText: 'old rules',
      promptMode: 'append',
      rulesMode: 'append',
      userTemplate: '',
      outputSchemaHint: '',
      modelOverride: null,
      generationConfig: {},
    });

    const payload = makeValidScopePayload(scopeId);
    const summary = freshSummary();
    await seed.processScopeFile(
      firestoreMock,
      FieldValue,
      { file: 'delta.json', payload },
      { apply: true, summary }
    );

    expect(summary.versions_created).toBe(1);
    expect(summary.no_op).toBe(0);
    expect(summary.errors).toBe(0);
    expect(_state.versionDocs.size).toBe(2);
    // Active version NOT auto-changed — still v-old.
    const scope = _state.scopeDocs.get(_scopeKey(scopeId));
    expect(scope.activeVersionId).toBe('v-old');
    expect(summary.details[0].action).toBe('created_new_version_pending_activation');
  });

  it('apply: idempotent on second run (no new version)', async () => {
    const payload = makeValidScopePayload('test.epsilon');
    const summary1 = freshSummary();
    await seed.processScopeFile(
      firestoreMock,
      FieldValue,
      { file: 'eps.json', payload },
      { apply: true, summary: summary1 }
    );
    expect(summary1.scopes_created).toBe(1);
    expect(summary1.versions_created).toBe(1);

    const summary2 = freshSummary();
    await seed.processScopeFile(
      firestoreMock,
      FieldValue,
      { file: 'eps.json', payload },
      { apply: true, summary: summary2 }
    );
    // Second run sees identical content → no_op.
    expect(summary2.no_op).toBe(1);
    expect(summary2.scopes_created).toBe(0);
    expect(summary2.versions_created).toBe(0);
    expect(summary2.errors).toBe(0);
    expect(_state.versionDocs.size).toBe(1);
  });

  it('apply: handles partial Firestore read failure gracefully', async () => {
    _state.scopeReadError = new Error('firestore unavailable');
    const payload = makeValidScopePayload('test.zeta');
    const summary = freshSummary();
    await seed.processScopeFile(
      firestoreMock,
      FieldValue,
      { file: 'zeta.json', payload },
      { apply: true, summary }
    );
    expect(summary.errors).toBe(1);
    expect(summary.scopes_created).toBe(0);
    expect(summary.versions_created).toBe(0);
    expect(summary.details[0].action).toBe('firestore_read_error');
    expect(summary.details[0].error).toMatch(/unavailable/);
  });

  it('apply: handles validation error gracefully', async () => {
    const payload = { scopeId: '', name: 'broken' }; // missing version
    const summary = freshSummary();
    await seed.processScopeFile(
      firestoreMock,
      FieldValue,
      { file: 'broken.json', payload },
      { apply: true, summary }
    );
    expect(summary.errors).toBe(1);
    expect(summary.details[0].action).toBe('validation_error');
  });

  it('STUB-MODE (no firestore): reports would-be actions, no crash', async () => {
    const payload = makeValidScopePayload('test.stub');
    const summary = freshSummary();
    await seed.processScopeFile(
      null, // no firestore
      FieldValue,
      { file: 'stub.json', payload },
      { apply: false, summary }
    );
    expect(summary.errors).toBe(0);
    expect(summary.scopes_created).toBe(1);
    expect(summary.versions_created).toBe(1);
    expect(summary.details[0].action).toBe('stub_would_create_scope_and_version');
  });
});

// ─── Real fixture files: ensure shipped JSON files validate cleanly ────────

describe('seed-llm-scopes — bundled JSON fixtures', () => {
  const realDir = path.resolve(__dirname, '..', '..', 'lib', 'llm-prompts', 'scopes');
  it('parses + validates all bundled JSON scope-files (F.2.A + F.2.B mix)', () => {
    const files = seed.readScopeFiles(realDir);
    // F.2.A delivers 8 identify-worker scopes, F.2.B adds 4 (critic + 3 chat/quality).
    expect(files.length).toBeGreaterThanOrEqual(4);
    for (const f of files) {
      expect(f.parseError, `${f.file} parseError`).toBeFalsy();
      const validationError = seed.validateScopePayload(f.payload);
      expect(validationError, `${f.file} validation: ${validationError || ''}`).toBe(null);
    }
    // The 4 scopes from F.2.B MUST be present.
    const ids = files.map((f) => seed.extractScopeId(f.payload)).sort();
    expect(ids).toContain('identify.critic');
    expect(ids).toContain('chat.product');
    expect(ids).toContain('chat.update_datasheet');
    expect(ids).toContain('quality.gate');
  });
});

// ─── Helpers ───────────────────────────────────────────────────────────────

function freshSummary() {
  return {
    startedAt: new Date().toISOString(),
    finishedAt: null,
    applied: false,
    mode: 'test',
    dir: tmpDir,
    scopes_processed: 0,
    scopes_created: 0,
    versions_created: 0,
    no_op: 0,
    errors: 0,
    stubMode: false,
    details: [],
  };
}

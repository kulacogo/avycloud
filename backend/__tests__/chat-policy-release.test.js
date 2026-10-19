import { describe, it, expect } from 'vitest';
const { applyRelease, digest, scopeConfiguration } = require('../scripts/lib/chat-policy-release');

function fixture() {
  const scope = { activeVersionId: 'old', name: 'Chat', tenantOverrides: { tenantA: { modelOverride: 'preserved' } } };
  const parent = { promptText: 'admin prompt', rulesText: 'admin rules', promptMode: 'replace', modelOverride: 'unchanged', generationConfig: { temperature: 0.8 }, futureField: { preserved: true } };
  const docs = new Map([['llmScopes/chat.product', scope], ['llmScopes/chat.product/versions/old', parent]]);
  const ref = (path) => ({ path, collection: (name) => ({ doc: (id) => ref(`${path}/${name}/${id}`) }) });
  const writes = [];
  const firestore = {
    collection: (name) => ({ doc: (id) => ref(`${name}/${id}`) }),
    runTransaction: async (callback) => {
      const pending = [];
      const result = await callback({
        get: async (reference) => ({ exists: docs.has(reference.path), data: () => docs.get(reference.path) }),
        create: (reference, data) => pending.push(['create', reference.path, data]),
        update: (reference, data) => pending.push(['update', reference.path, data]),
      });
      for (const [action, path, data] of pending) {
        if (action === 'create' && docs.has(path)) throw new Error('exists');
        docs.set(path, action === 'update' ? { ...docs.get(path), ...data } : data);
      }
      writes.push(...pending);
      return result;
    },
  };
  const plan = { scopeId: 'chat.product', versionId: 'new', parentVersionId: 'old', releaseSha: 'a'.repeat(40), requestPolicyVersion: 'chat-request-2026-10-11-v1', scopeHash: digest(scope), scopeConfigurationHash: digest(scopeConfiguration(scope)), parentHash: digest(parent), sourceFiles: { 'backend/lib/chat-request.js': 'b'.repeat(64) } };
  const run = (action) => applyRelease({ firestore, plan, action, timestamp: 'test-time', actorUid: 'test-operator' });
  return { scope, parent, docs, writes, plan, run };
}

describe('controlled compiled chat-policy release', () => {
  it('registers an immutable inactive child preserving all known and future configuration', async () => {
    const f = fixture();
    await f.run('register');
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0][0]).toBe('create');
    expect(f.docs.get('llmScopes/chat.product').activeVersionId).toBe('old');
    expect(f.docs.get('llmScopes/chat.product/versions/new')).toMatchObject(f.parent);
    expect(f.docs.get('llmScopes/chat.product/versions/old')).toEqual(f.parent);
    await expect(f.run('register')).rejects.toThrow('already exists');
  });
  it('activates and rolls back via compare-and-set while preserving scope overrides', async () => {
    const f = fixture();
    await f.run('register'); await f.run('activate');
    expect(f.docs.get('llmScopes/chat.product').activeVersionId).toBe('new');
    expect(f.docs.get('llmScopes/chat.product').tenantOverrides).toEqual(f.scope.tenantOverrides);
    await f.run('rollback');
    expect(f.docs.get('llmScopes/chat.product').activeVersionId).toBe('old');
  });
  it.each(['scope', 'parent'])('rejects stale registration after a concurrent %s change', async (kind) => {
    const f = fixture();
    if (kind === 'scope') f.scope.activeVersionId = 'someone-else';
    else f.parent.promptText = 'changed admin prompt';
    await expect(f.run('register')).rejects.toThrow('changed');
    expect(f.writes).toHaveLength(0);
  });
  it.each(['activate', 'rollback'])('never overrides a newer active version on %s', async (action) => {
    const f = fixture(); await f.run('register');
    if (action === 'rollback') await f.run('activate');
    f.docs.get('llmScopes/chat.product').activeVersionId = 'other-release';
    const count = f.writes.length;
    await expect(f.run(action)).rejects.toThrow('Active version changed');
    expect(f.writes).toHaveLength(count);
  });
  it('rejects configuration drift after registration and leaves it untouched', async () => {
    const f = fixture(); await f.run('register');
    f.scope.tenantOverrides.tenantA.modelOverride = 'new-choice';
    await expect(f.run('activate')).rejects.toThrow('Scope configuration changed');
    expect(f.writes).toHaveLength(1);
  });
  it.each(['compiledPolicyRelease', 'generationConfig'])('rejects a modified child %s', async (field) => {
    const f = fixture(); await f.run('register');
    f.docs.get('llmScopes/chat.product/versions/new')[field] = { altered: true };
    await expect(f.run('activate')).rejects.toThrow(/does not match|configuration changed/);
    expect(f.writes).toHaveLength(1);
  });
  it('rejects a draft without a final commit before starting a transaction', async () => {
    const f = fixture(); f.plan.releaseSha = null;
    await expect(f.run('register')).rejects.toThrow('release SHA');
    expect(f.writes).toHaveLength(0);
  });
  it('hashes reordered keys consistently and includes timestamp nanoseconds', () => {
    expect(digest({ b: 2, a: 1 })).toBe(digest({ a: 1, b: 2 }));
    const time = (nanoseconds) => ({ seconds: 10, nanoseconds, toMillis: () => 10000 });
    expect(digest(time(1))).not.toBe(digest(time(2)));
  });
});

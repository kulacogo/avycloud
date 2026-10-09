const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { erstelleApi } = require('../lib/api');

test('restarts using a private refresh session without storing a password', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'avycloud-session-test-'));
  const sessionFile = path.join(directory, 'session.json');
  fs.writeFileSync(sessionFile, JSON.stringify({ refreshToken: 'test-refresh' }), { mode: 0o600 });
  const calls = [];
  try {
    const api = erstelleApi({ basisUrl: 'https://example.test', firebaseApiKey: 'public-test-key', sessionFile,
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return { ok: true, json: async () => url.includes('securetoken')
          ? { id_token: 'test-id-token', refresh_token: 'rotated-test-token', expires_in: '3600' }
          : { ok: true } };
      } });
    await api.melde({ agentId: 'station', drucker: { parcel: 'DHL' } });
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /securetoken/);
    assert.equal(JSON.parse(calls[1].options.body).protocolVersion, 2);
    assert.deepEqual(JSON.parse(fs.readFileSync(sessionFile, 'utf8')), { refreshToken: 'rotated-test-token' });
    assert.equal(fs.statSync(sessionFile).mode & 0o777, 0o600);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test('never claims production work from a legacy backend during a staggered rollout', async () => {
  const calls = [];
  const api = erstelleApi({ basisUrl: 'https://example.test', firebaseApiKey: 'public', email: 'station@example.test', passwort: 'test',
    fetchImpl: async (url) => {
      calls.push(url);
      return { ok: true, json: async () => url.includes('signInWithPassword') ? { idToken: 'test', expiresIn: 3600 } : { ok: true, data: { online: true } } };
    } });
  await assert.rejects(api.holeAuftrag({ agentId: 'station' }), /Protokoll 2/);
  assert.equal(calls.some((url) => url.endsWith('/agent/claim')), false);
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { configure, verifyStation } = require('../windows-run');

test('Windows config selects a private persistent session and limits environment configuration', () => {
  const env = {};
  configure({ backend: 'https://example.test', apiKey: 'public', parcel: 'Paket', letter: 'Brief',
    NODE_OPTIONS: '--require malicious', password: 'never' }, '/station', env);
  assert.equal(env.PRINTER_PARCEL, 'Paket');
  assert.equal(env.AGENT_SESSION_FILE, path.join('/station', 'session.json'));
  assert.equal(env.AGENT_DATA_DIR, '/station');
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.AGENT_PASSWORT, undefined);
});

test('station verification requires BOTH printer formats and a successful test handoff per role', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'avycloud-win-verify-'));
  const config = { parcel: 'Paket', letter: 'Brief' };
  const papers = [
    { name: 'Paket', papers: [{ kind: 257, widthMm: 103, heightMm: 164 }] },
    { name: 'Brief', papers: [{ kind: 258, widthMm: 62, heightMm: 100 }] },
  ];
  const printed = [];
  const deps = { inventory: async () => papers, readFixture: async (role) => Buffer.from(role),
    print: async (args) => { printed.push(args); return 'sumatra:test:receipt'; } };
  try {
    await verifyStation(config, directory, deps);
    assert.equal(printed.length, 2);
    assert.equal(printed[0].widthMm, 103);
    assert.equal(printed[1].widthMm, 62);
    assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'verification.json'))).ok, true);
    await assert.rejects(verifyStation(config, directory, { ...deps, print: async () => { throw new Error('driver failure'); } }), /driver/);
    const result = JSON.parse(await fs.readFile(path.join(directory, 'verification.json')));
    assert.equal(result.ok, false);
    assert.equal(result.error, 'driver failure');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

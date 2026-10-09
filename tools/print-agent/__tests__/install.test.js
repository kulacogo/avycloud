const { test } = require('node:test');
const assert = require('node:assert/strict');
const { launchPlan } = require('../install');
test('installation is independent of the checkout and never puts the password into launchd', () => {
  const plan = launchPlan({ directory: '/Users/test/Library/Application Support/AvyCloud Print Agent',
    node: '/opt/node', backend: 'https://example.test', apiKey: 'public', parcel: 'DHL & DPD', letter: 'DP', password: 'must-not-be-stored' });
  assert.ok(plan.ProgramArguments[1].endsWith('/current/index.js'));
  assert.equal(plan.EnvironmentVariables.AGENT_PASSWORT, undefined);
  assert.equal(plan.EnvironmentVariables.PRINTER_PARCEL, 'DHL & DPD');
  assert.ok(plan.EnvironmentVariables.AGENT_SESSION_FILE.endsWith('/session.json'));
});

'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

function launchPlan({ directory, node, backend, apiKey, parcel, letter }) {
  return {
    Label: 'de.trendocean.print-agent',
    ProgramArguments: [node, path.join(directory, 'current', 'index.js')],
    EnvironmentVariables: {
      AVYCLOUD_URL: backend, FIREBASE_API_KEY: apiKey,
      AGENT_SESSION_FILE: path.join(directory, 'session.json'),
      PRINTER_PARCEL: parcel, PRINTER_LETTER: letter,
    },
    RunAtLoad: true, KeepAlive: true, ThrottleInterval: 15,
    StandardOutPath: path.join(directory, 'agent.log'), StandardErrorPath: path.join(directory, 'agent.err'),
  };
}

async function install() {
  const backend = process.env.AVYCLOUD_URL;
  const apiKey = process.env.FIREBASE_API_KEY;
  const password = process.env.AGENT_PASSWORT;
  delete process.env.AGENT_PASSWORT;
  const authResponse = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: process.env.AGENT_EMAIL, password, returnSecureToken: true }),
    signal: AbortSignal.timeout(30000),
  });
  const auth = await authResponse.json();
  if (!authResponse.ok || !auth.refreshToken) throw new Error('Anmeldung fehlgeschlagen. E-Mail und Passwort prüfen.');
  const permissionResponse = await fetch(`${backend}/api/me/permissions`, {
    headers: { Authorization: `Bearer ${auth.idToken}` }, signal: AbortSignal.timeout(30000),
  });
  const permissions = (await permissionResponse.json())?.data?.permissions || {};
  const can = (action) => permissions['*']?.['*'] === true || permissions.orders?.['*'] === true || permissions.orders?.[action] === true;
  if (!permissionResponse.ok || !can('read') || !can('ship')) throw new Error('Das Konto benötigt orders:read und orders:ship. Es wurden keine Rechte geändert.');
  const directory = path.join(os.homedir(), 'Library', 'Application Support', 'AvyCloud Print Agent');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  const sessionFile = path.join(directory, 'session.json');
  await fs.writeFile(sessionFile, JSON.stringify({ refreshToken: auth.refreshToken }), { mode: 0o600 });
  await fs.chmod(sessionFile, 0o600);
  const current = path.join(directory, 'current');
  await fs.mkdir(current, { recursive: true });
  for (const name of ['index.js', 'package.json', 'lib']) {
    await fs.cp(path.join(__dirname, name), path.join(current, name), { recursive: true });
  }
  const launchDirectory = path.join(os.homedir(), 'Library', 'LaunchAgents');
  await fs.mkdir(launchDirectory, { recursive: true });
  const plist = path.join(launchDirectory, 'de.trendocean.print-agent.plist');
  const plan = launchPlan({ directory, node: process.execPath, backend, apiKey,
    parcel: process.env.PRINTER_PARCEL, letter: process.env.PRINTER_LETTER });
  // plistlib escapes names and paths correctly, including ampersands. No
  // credentials are interpolated into shell commands, XML, or log output.
  const xml = execFileSync('python3', ['-c', 'import sys,json,plistlib; sys.stdout.buffer.write(plistlib.dumps(json.load(sys.stdin)))'], { input: JSON.stringify(plan) });
  await fs.writeFile(plist, xml, { mode: 0o600 });
  await fs.chmod(plist, 0o600);
  const domain = `gui/${process.getuid()}`;
  try { execFileSync('launchctl', ['bootout', `${domain}/de.trendocean.print-agent`], { stdio: 'ignore' }); } catch { /* first install */ }
  execFileSync('launchctl', ['bootstrap', domain, plist]);
  const agentId = `print-agent-${os.hostname()}`;
  for (let attempt = 0; attempt < 15; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const response = await fetch(`${backend}/api/print/status`, { headers: { Authorization: `Bearer ${auth.idToken}` }, signal: AbortSignal.timeout(10000) });
    const result = await response.json();
    if (result?.data?.protocolVersion === 2 && result?.data?.agents?.some((agent) => agent.agentId === agentId && agent.online)) {
      console.log(`Druckstation verbunden. Protokoll: ${path.join(directory, 'agent.log')}`);
      return;
    }
  }
  throw new Error(`Noch kein Heartbeat dieser Station. Protokoll prüfen: ${path.join(directory, 'agent.err')}`);
}
if (require.main === module) install().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { launchPlan };

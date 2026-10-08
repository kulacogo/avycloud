'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const util = require('node:util');
const { dataDirectory } = require('./lib/platform');
const { inventory, validatePrinters, printWindows } = require('./lib/windows');

function configure(config, directory, env = process.env) {
  Object.assign(env, {
    AVYCLOUD_URL: config.backend, FIREBASE_API_KEY: config.apiKey,
    PRINTER_PARCEL: config.parcel, PRINTER_LETTER: config.letter,
    AGENT_SESSION_FILE: path.join(directory, 'session.json'), AGENT_DATA_DIR: directory,
    SUMATRA_PDF_PATH: path.join(directory, 'runtime', 'SumatraPDF.exe'),
  });
}

async function verifyStation(config, directory, { inventory: readInventory = inventory,
  print = printWindows, readFixture = (role) => fsp.readFile(path.join(__dirname, 'fixtures', `${role}.pdf`)) } = {}) {
  const resultFile = path.join(directory, 'verification.json');
  const saveResult = async (value) => {
    await fsp.writeFile(`${resultFile}.tmp`, JSON.stringify(value), { mode: 0o600 });
    await fsp.rename(`${resultFile}.tmp`, resultFile);
  };
  try {
    const all = await readInventory();
    const formats = validatePrinters(config, all);
    const receipts = {};
    for (const [role, [widthMm, heightMm]] of Object.entries({ parcel: [103, 164], letter: [62, 100] })) {
      receipts[role] = await print({ buffer: await readFixture(role), druckerName: config[role],
        widthMm, heightMm, copies: 1, jobId: `installation-test-${role}-${Date.now()}` });
    }
    await saveResult({ ok: true, at: new Date().toISOString(), formats, receipts });
  } catch (error) {
    await saveResult({ ok: false, at: new Date().toISOString(), error: error.message });
    throw error;
  }
}

async function main() {
  if (process.platform !== 'win32') throw new Error('Dieser Starter ist nur fuer Windows.');
  const directory = dataDirectory();
  const config = JSON.parse(fs.readFileSync(path.join(directory, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
  configure(config, directory);
  // Task Scheduler does not retain stdout. Keep bounded local logs, including
  // startup errors, without putting session tokens into the task definition.
  const log = path.join(directory, 'agent.log');
  const append = (...args) => {
    if (fs.existsSync(log) && fs.statSync(log).size > 5 * 1024 * 1024) {
      if (fs.existsSync(`${log}.previous`)) fs.unlinkSync(`${log}.previous`);
      fs.renameSync(log, `${log}.previous`);
    }
    fs.appendFileSync(log, `${new Date().toISOString()} ${util.format(...args)}\n`);
  };
  console.log = append; console.error = append;
  if (process.argv.includes('--verify')) return verifyStation(config, directory);
  return require('./index').hauptschleife();
}
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { configure, verifyStation };

'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

async function durableWrite(file, value, exclusive = false) {
  const handle = await fs.open(file, exclusive ? 'wx' : 'w', 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
  finally { await handle.close(); }
}

// The journal survives process restarts. A local print with a lost HTTP result
// is acknowledged again, never printed again. An interrupted CUPS call needs
// an explicit human reprint (a NEW job), since physical exactly-once cannot be
// inferred from a network timeout.
async function deliverOnce({ directory, jobId, api, print, recovering = false }) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stem = path.join(directory, createHash('sha256').update(jobId).digest('hex'));
  const receipt = await fs.readFile(`${stem}.sent`, 'utf8').then(JSON.parse).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (receipt) return api.result({ ok: true, spoolId: receipt.spoolId });
  try {
    await durableWrite(`${stem}.sending`, { jobId }, true);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return api.result({ ok: false, error: 'Ausgabe unklar. Drucker prüfen; bei Bedarf ausdrücklich erneut drucken.' });
  }
  if (recovering) return api.result({ ok: false, error: 'Unterbrochene Druckübergabe. Drucker prüfen.' });
  await api.begin();
  let spoolId;
  try {
    spoolId = await print();
    if (!spoolId) throw new Error('CUPS hat keine Auftragskennung geliefert.');
    await durableWrite(`${stem}.sent`, { jobId, spoolId });
  } catch (error) {
    return api.result({ ok: false, error: error.message });
  }
  // Outside the print catch: failure here must never turn success into retry.
  return api.result({ ok: true, spoolId });
}
module.exports = { deliverOnce };

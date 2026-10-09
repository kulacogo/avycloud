'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { dataDirectory } = require('./platform');
const cups = require('./drucker');
const execute = promisify(execFile);

async function inventory({ run = execute } = {}) {
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(__dirname, 'windows-printers.ps1')], { encoding: 'utf8', windowsHide: true, shell: false, timeout: 30000 });
  const parsed = JSON.parse(String(stdout).replace(/^\uFEFF/, '').trim());
  return Array.isArray(parsed) ? parsed : [parsed];
}

function selectPaper(printer, widthMm, heightMm) {
  if (![widthMm, heightMm].every((v) => Number.isFinite(v) && v > 0)) throw new Error('Ungueltige Etikettenmasse.');
  const matching = (printer?.papers || []).filter((paper) =>
    Number.isInteger(paper.kind) && paper.kind > 0 &&
    Math.abs(paper.widthMm - widthMm) <= 0.6 && Math.abs(paper.heightMm - heightMm) <= 0.6);
  // Brother exposes fixed, continuous, custom and name-badge forms with the
  // same current dimensions. Prefer the explicitly named fixed size, while
  // still requiring the driver's measured dimensions above to match.
  const fixed = matching.filter((paper) => {
    const size = String(paper.name || '').trim().match(/^(\d+(?:[.,]\d+)?)\s*mm\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*mm(?:\s*\([^)]*\))?$/i);
    return size && Number(size[1].replace(',', '.')) === widthMm && Number(size[2].replace(',', '.')) === heightMm;
  });
  const kinds = [...new Set((fixed.length ? fixed : matching).map((paper) => paper.kind))];
  if (!kinds.length) throw new Error(`Rollenformat ${widthMm}x${heightMm} mm fehlt im Treiber von ${printer?.name || 'Drucker'}.`);
  if (kinds.length > 1) throw new Error(`Rollenformat fuer ${printer.name} ist nicht eindeutig. Doppelte Treiberformate pruefen.`);
  return kinds[0];
}

function validatePrinters(printers, all) {
  if (printers.parcel && printers.parcel === printers.letter) throw new Error('Zwei verschiedene Etikettendrucker erforderlich.');
  const result = {};
  for (const [role, [w, h]] of Object.entries(cups.ROLLEN_MASS)) {
    const printer = all.find((item) => item.name === printers[role]);
    if (!printer) throw new Error(`Drucker fuer ${role} nicht gefunden: ${printers[role] || '(nicht eingerichtet)'}`);
    result[role] = selectPaper(printer, w, h);
  }
  return result;
}

async function printWindows({ buffer, druckerName, widthMm, heightMm, copies = 1, jobId,
  fitToPage = true, directory = path.join(dataDirectory(), 'temporary'),
  sumatraPath = process.env.SUMATRA_PDF_PATH, inventory: readInventory = inventory, run = execute }) {
  if (!sumatraPath) throw new Error('SUMATRA_PDF_PATH fehlt. Windows-Setup ausfuehren.');
  if (!Number.isInteger(copies) || copies < 1 || copies > 10) throw new Error('Ungueltige Kopienanzahl.');
  if (!Buffer.isBuffer(buffer) || !buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('Kein PDF-Dokument.');
  const printer = (await readInventory()).find((item) => item.name === druckerName);
  if (!printer) throw new Error(`Drucker nicht gefunden: ${druckerName}`);
  // Read the actual driver again for every print: configuration can change
  // while the service is running. Never silently fall back to A4/default.
  const kind = selectPaper(printer, Number(widthMm), Number(heightMm));
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = await fs.mkdtemp(path.join(directory, 'label-'));
  const file = path.join(temporary, 'label.pdf');
  try {
    await fs.writeFile(file, buffer, { mode: 0o600 });
    await run(sumatraPath, ['-silent', '-print-to', druckerName, '-print-settings',
      `${fitToPage ? 'fit' : 'noscale'},simplex,${copies}x,paperkind=${kind}`, file],
    { windowsHide: true, shell: false, timeout: 120000, encoding: 'utf8' });
    // Sumatra's successful exit is an APPLICATION handoff receipt. This is
    // deliberately not represented as a Windows spool job ID or paper proof.
    return `sumatra:${jobId}:${randomUUID()}`;
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

async function sammleDrucker() {
  return (await inventory()).map((printer) => ({ ...printer,
    medien: (printer.papers || []).map((paper) => `${Math.round(paper.widthMm)}x${Math.round(paper.heightMm)}mm`) }));
}
module.exports = { ...cups, inventory, selectPaper, validatePrinters, printWindows,
  druckeBuffer: printWindows, sammleDrucker,
  listeDrucker: async () => (await inventory()).map((p) => p.name),
  listeMedien: async (name) => (await sammleDrucker()).find((p) => p.name === name)?.medien || [],
};

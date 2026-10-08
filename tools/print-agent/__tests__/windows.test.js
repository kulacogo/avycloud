const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { selectPaper, printWindows, validatePrinters, inventory } = require('../lib/windows');
const { dataDirectory } = require('../lib/platform');

const parcel = { name: 'Brother Paket & Lager', papers: [{ kind: 257, widthMm: 103.1, heightMm: 164.1 }] };
const letter = { name: 'Brief', papers: [{ kind: 258, widthMm: 62, heightMm: 100 }] };
test('Windows inventory preserves Unicode driver names and never constructs shell code from names', async () => {
  const printers = await inventory({ run: async (file, args, options) => {
    assert.equal(file, 'powershell.exe');
    assert.equal(args.includes('-File'), true);
    assert.equal(options.shell, false);
    return { stdout: '\uFEFF' + JSON.stringify([{ ...parcel, name: 'Büro & Versand' }]) };
  } });
  assert.equal(printers[0].name, 'Büro & Versand');
  assert.equal(printers[0].papers[0].kind, 257);
});
test('Windows uses a driver paper format with matching dimensions, never a guessed/default printer', () => {
  assert.equal(selectPaper(parcel, 103, 164), 257);
  assert.throws(() => selectPaper(parcel, 62, 100), /Rollenformat/);
  assert.throws(() => selectPaper({ ...parcel, papers: [...parcel.papers, { kind: 259, widthMm: 103, heightMm: 164 }] }, 103, 164), /eindeutig/);
  assert.throws(() => selectPaper(parcel, NaN, 164), /Etiketten/);
  assert.throws(() => validatePrinters({ parcel: parcel.name, letter: parcel.name }, [parcel, letter]), /verschiedene/);
  assert.throws(() => validatePrinters({ parcel: 'missing', letter: letter.name }, [parcel, letter]), /nicht gefunden/);
  assert.deepEqual(validatePrinters({ parcel: parcel.name, letter: letter.name }, [parcel, letter]), { parcel: 257, letter: 258 });
});
test('Windows runtime state survives checkout changes and uses ProgramData', () => {
  assert.equal(dataDirectory('win32', { ProgramData: 'C:\\ProgramData' }), 'C:\\ProgramData\\AvyCloud Print Agent');
  assert.ok(dataDirectory('darwin', {}, '/Users/me').endsWith('/Library/Application Support/AvyCloud Print Agent'));
});
test('silent print passes literal printer arguments, records an application receipt, and removes private PDF', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'avycloud-win-print-'));
  let document;
  try {
    const receipt = await printWindows({ buffer: Buffer.from('%PDF-test'), druckerName: parcel.name,
      widthMm: 103, heightMm: 164, copies: 1, jobId: 'job-1', directory,
      sumatraPath: 'C:\\tools\\SumatraPDF.exe', inventory: async () => [parcel],
      run: async (executable, args, options) => {
        assert.equal(executable, 'C:\\tools\\SumatraPDF.exe');
        assert.ok(args.includes(parcel.name));
        assert.ok(args.includes('fit,simplex,1x,paperkind=257'));
        assert.equal(args.includes('-print-to-default'), false);
        assert.equal(options.shell, false);
        document = args.at(-1);
        assert.equal((await fs.readFile(document)).toString(), '%PDF-test');
      },
    });
    assert.match(receipt, /^sumatra:job-1:/);
    await assert.rejects(fs.access(document));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
test('print errors/timeouts never become success receipts, and wrong media never starts Sumatra', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'avycloud-win-print-'));
  let starts = 0;
  const args = { buffer: Buffer.from('%PDF-test'), druckerName: parcel.name, widthMm: 103, heightMm: 164,
    copies: 1, jobId: 'job-2', directory, sumatraPath: 'C:\\SumatraPDF.exe', inventory: async () => [parcel],
    run: async () => { starts++; throw new Error('timeout'); } };
  try {
    await assert.rejects(printWindows(args), /timeout/);
    assert.deepEqual(await fs.readdir(directory), []);
    await assert.rejects(printWindows({ ...args, widthMm: 62, heightMm: 100 }), /Rollenformat/);
    assert.equal(starts, 1);
    await assert.rejects(printWindows({ ...args, copies: 0 }), /Kopien/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

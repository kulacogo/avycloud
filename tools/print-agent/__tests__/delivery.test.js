const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { deliverOnce } = require('../lib/delivery');

test('lost server acknowledgement never prints a second copy', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'avycloud-print-test-'));
  let prints = 0;
  let acknowledgements = 0;
  const api = { begin: async () => {}, result: async () => { if (++acknowledgements === 1) throw new Error('network'); } };
  const args = { directory, jobId: 'job-1', api, print: async () => { prints++; return 'DHL-123'; } };
  try {
    await assert.rejects(deliverOnce(args), /network/);
    await deliverOnce(args);
    assert.equal(prints, 1);
    assert.equal(acknowledgements, 2);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
test('a crash in dispatch stays uncertain instead of silently printing again', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'avycloud-print-test-'));
  let prints = 0;
  const reports = [];
  const api = { begin: async () => {}, result: async (result) => reports.push(result) };
  const args = { directory, jobId: 'job-1', api, print: async () => { prints++; throw new Error('CUPS disconnected'); } };
  try {
    await deliverOnce(args);
    await deliverOnce(args);
    assert.equal(prints, 1);
    assert.equal(reports.at(-1).ok, false);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

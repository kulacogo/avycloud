'use strict';

/**
 * Tests for scripts/export-legacy-invoices.js
 *
 * ARCHIVE-BEFORE-WIPE safety net for the TrendOcean-GmbH cutover: exports every
 * legacy invoice (Firestore doc JSON + its GCS PDF) to a retention location and
 * verifies completeness BEFORE any reset runs. GoBD/§147: losing an invoice PDF
 * is irrecoverable, so the verification logic (`summarizeExport`) is load-bearing
 * and is tested here directly.
 *
 * Vitest CJS — globals enabled (describe/it/expect). No require('vitest').
 * Pure functions + runExport(deps) are require-able without touching real
 * Firestore/GCS (heavy requires are deferred to the CLI entry).
 */

const os = require('os');
const fsReal = require('fs');
const pathReal = require('path');

const {
  parseGcsUrl,
  planInvoiceExport,
  summarizeExport,
  runExport,
  parseArgs,
  decollidePlans,
  writeFileDurable,
} = require('../../scripts/export-legacy-invoices');

describe('planInvoiceExport path-safety', () => {
  it('sanitizes path-unsafe characters in the archive base name', () => {
    const plan = planInvoiceExport({ invoiceNumber: 'RE/2026/1', pdfUrl: null }, 'doc-1');
    expect(plan.archiveJsonName).toBe('RE_2026_1.json');
  });
});

describe('decollidePlans (prevents duplicate-invoiceNumber overwrite = data loss)', () => {
  it('appends the invoice id when two invoices share an archive name', () => {
    const plans = [
      planInvoiceExport({ invoiceNumber: 'RE-1', pdfUrl: 'gs://b/x/a.pdf' }, 'doc-a'),
      planInvoiceExport({ invoiceNumber: 'RE-1', pdfUrl: 'gs://b/x/b.pdf' }, 'doc-b'),
    ];
    const { plans: fixed, collisions } = decollidePlans(plans);
    expect(collisions).toContain('RE-1');
    const jsonNames = fixed.map((p) => p.archiveJsonName);
    expect(new Set(jsonNames).size).toBe(2);
    expect(jsonNames.every((n) => n.includes('doc-a') || n.includes('doc-b'))).toBe(true);
  });

  it('leaves unique names unchanged with no collisions', () => {
    const plans = [
      planInvoiceExport({ invoiceNumber: 'RE-1', pdfUrl: null }, 'doc-a'),
      planInvoiceExport({ invoiceNumber: 'RE-2', pdfUrl: null }, 'doc-b'),
    ];
    const { plans: fixed, collisions } = decollidePlans(plans);
    expect(collisions).toEqual([]);
    expect(fixed.map((p) => p.archiveJsonName)).toEqual(['RE-1.json', 'RE-2.json']);
  });
});

describe('writeFileDurable (fsync + read-back for the §147 archive)', () => {
  it('writes, fsyncs and the bytes are readable back', () => {
    const dir = fsReal.mkdtempSync(pathReal.join(os.tmpdir(), 'exp-durable-'));
    const f = pathReal.join(dir, 'x.txt');
    writeFileDurable(fsReal, f, 'hello-archive');
    expect(fsReal.readFileSync(f, 'utf8')).toBe('hello-archive');
  });
});

describe('parseArgs', () => {
  it('defaults to dry-run, tenant default, no bucket/out', () => {
    expect(parseArgs([])).toEqual({ apply: false, tenant: 'default', out: null, bucket: null });
  });

  it('parses --apply, --tenant, --bucket and --out', () => {
    const a = parseArgs(['--apply', '--tenant', 'trendocean', '--bucket', 'my-archive', '--out', '/tmp/x']);
    expect(a.apply).toBe(true);
    expect(a.tenant).toBe('trendocean');
    expect(a.bucket).toBe('my-archive');
    expect(a.out).toBe('/tmp/x');
  });
});

describe('parseGcsUrl', () => {
  it('parses a gs:// url into bucket and object path', () => {
    expect(parseGcsUrl('gs://prodsandjobs/default/invoices/RE-2026-0001.pdf'))
      .toEqual({ bucket: 'prodsandjobs', path: 'default/invoices/RE-2026-0001.pdf' });
  });

  it('returns null for a non-gs url', () => {
    expect(parseGcsUrl('https://example.com/x.pdf')).toBeNull();
  });

  it('returns null for empty/missing input', () => {
    expect(parseGcsUrl('')).toBeNull();
    expect(parseGcsUrl(null)).toBeNull();
    expect(parseGcsUrl(undefined)).toBeNull();
  });
});

describe('planInvoiceExport', () => {
  it('plans json + pdf archive names from the invoice number and parses the pdf source', () => {
    const plan = planInvoiceExport(
      { invoiceNumber: 'RE-2026-0001', pdfUrl: 'gs://prodsandjobs/default/invoices/RE-2026-0001.pdf' },
      'doc-abc'
    );
    expect(plan.invoiceId).toBe('doc-abc');
    expect(plan.invoiceNumber).toBe('RE-2026-0001');
    expect(plan.hasPdf).toBe(true);
    expect(plan.pdfSource).toEqual({ bucket: 'prodsandjobs', path: 'default/invoices/RE-2026-0001.pdf' });
    expect(plan.archiveJsonName).toBe('RE-2026-0001.json');
    expect(plan.archivePdfName).toBe('RE-2026-0001.pdf');
  });

  it('falls back to the doc id for the archive name when invoiceNumber is missing', () => {
    const plan = planInvoiceExport({ pdfUrl: null }, 'doc-abc');
    expect(plan.archiveJsonName).toBe('doc-abc.json');
    expect(plan.hasPdf).toBe(false);
    expect(plan.pdfSource).toBeNull();
  });

  it('flags an invoice with an empty pdfUrl as hasPdf=false instead of silently dropping it', () => {
    const plan = planInvoiceExport({ invoiceNumber: 'RE-2026-0002', pdfUrl: '' }, 'doc-2');
    expect(plan.hasPdf).toBe(false);
  });
});

describe('summarizeExport', () => {
  it('is ok when every doc json is written and every existing pdf was downloaded', () => {
    const plans = [
      { invoiceId: 'a', invoiceNumber: 'RE-1', hasPdf: true, archivePdfName: 'RE-1.pdf', archiveJsonName: 'RE-1.json' },
      { invoiceId: 'b', invoiceNumber: 'RE-2', hasPdf: false, archiveJsonName: 'RE-2.json' },
    ];
    const summary = summarizeExport({
      firestoreCount: 2,
      plans,
      writtenJsonNames: ['RE-1.json', 'RE-2.json'],
      downloadedPdfNames: ['RE-1.pdf'],
    });
    expect(summary.ok).toBe(true);
    expect(summary.docCountMatches).toBe(true);
    expect(summary.missingPdf).toEqual([]);
    // an invoice that genuinely never had a PDF is surfaced as a warning, not a failure
    expect(summary.noPdfUrl).toEqual(['RE-2']);
  });

  it('is NOT ok when a doc json is missing (count mismatch = potential silent data loss)', () => {
    const plans = [
      { invoiceId: 'a', invoiceNumber: 'RE-1', hasPdf: true, archivePdfName: 'RE-1.pdf', archiveJsonName: 'RE-1.json' },
      { invoiceId: 'b', invoiceNumber: 'RE-2', hasPdf: true, archivePdfName: 'RE-2.pdf', archiveJsonName: 'RE-2.json' },
    ];
    const summary = summarizeExport({
      firestoreCount: 2,
      plans,
      writtenJsonNames: ['RE-1.json'], // RE-2 json missing
      downloadedPdfNames: ['RE-1.pdf', 'RE-2.pdf'],
    });
    expect(summary.ok).toBe(false);
    expect(summary.docCountMatches).toBe(false);
  });

  it('is NOT ok when an existing pdf failed to download (irrecoverable tax record would be lost)', () => {
    const plans = [
      { invoiceId: 'a', invoiceNumber: 'RE-1', hasPdf: true, archivePdfName: 'RE-1.pdf', archiveJsonName: 'RE-1.json' },
    ];
    const summary = summarizeExport({
      firestoreCount: 1,
      plans,
      writtenJsonNames: ['RE-1.json'],
      downloadedPdfNames: [], // pdf that should exist wasn't archived
    });
    expect(summary.ok).toBe(false);
    expect(summary.missingPdf).toEqual(['RE-1']);
  });
});

describe('runExport (orchestration with injected fakes)', () => {
  function makeFirestore(invoices) {
    return {
      collection() {
        return {
          where() {
            return {
              async get() {
                return {
                  size: invoices.length,
                  docs: invoices.map((inv) => ({ id: inv.id, data: () => inv.data })),
                };
              },
            };
          },
        };
      },
    };
  }

  function makeStorage({ failPaths = [] } = {}) {
    return {
      bucket() {
        return {
          file(path) {
            return {
              async download() {
                if (failPaths.includes(path)) throw new Error('gcs 404');
                return [Buffer.from(`PDF for ${path}`)];
              },
            };
          },
        };
      },
    };
  }

  function makeArchiveWriter() {
    const jsons = [];
    const pdfs = [];
    const manifests = [];
    return {
      jsons,
      pdfs,
      manifests,
      async writeJson(name, obj) { jsons.push({ name, obj }); },
      async writePdf(name, buffer) { pdfs.push({ name, size: buffer.length }); },
      async writeManifest(obj) { manifests.push(obj); },
    };
  }

  it('apply: writes every doc json + every existing pdf + a manifest and reports ok', async () => {
    const firestore = makeFirestore([
      { id: 'a', data: { invoiceNumber: 'RE-1', tenantId: 'default', pdfUrl: 'gs://b/default/invoices/RE-1.pdf' } },
      { id: 'b', data: { invoiceNumber: 'RE-2', tenantId: 'default', pdfUrl: '' } }, // genuinely no pdf
    ]);
    const archive = makeArchiveWriter();

    const result = await runExport({
      firestore, storage: makeStorage(), archive,
      tenantId: 'default', apply: true, exportedAtIso: '2026-07-01T00:00:00.000Z',
    });

    expect(result.summary.ok).toBe(true);
    expect(archive.jsons.map((j) => j.name).sort()).toEqual(['RE-1.json', 'RE-2.json']);
    expect(archive.pdfs.map((p) => p.name)).toEqual(['RE-1.pdf']); // only the one with a pdf
    expect(result.summary.noPdfUrl).toEqual(['RE-2']);
    expect(archive.manifests.length).toBe(1);
    expect(archive.manifests[0].count).toBe(2);
  });

  it('apply: a failed pdf download makes the export NOT ok, records the error, but still archives the json', async () => {
    const firestore = makeFirestore([
      { id: 'a', data: { invoiceNumber: 'RE-1', tenantId: 'default', pdfUrl: 'gs://b/default/invoices/RE-1.pdf' } },
    ]);
    const archive = makeArchiveWriter();

    const result = await runExport({
      firestore, storage: makeStorage({ failPaths: ['default/invoices/RE-1.pdf'] }), archive,
      tenantId: 'default', apply: true,
    });

    expect(result.summary.ok).toBe(false);
    expect(result.summary.missingPdf).toEqual(['RE-1']);
    expect(result.errors.length).toBe(1);
    expect(archive.jsons.map((j) => j.name)).toEqual(['RE-1.json']); // json survives the pdf failure
  });

  it('dry-run: performs NO writes at all but previews the plan', async () => {
    const firestore = makeFirestore([
      { id: 'a', data: { invoiceNumber: 'RE-1', tenantId: 'default', pdfUrl: 'gs://b/default/invoices/RE-1.pdf' } },
    ]);
    const archive = makeArchiveWriter();

    const result = await runExport({
      firestore, storage: makeStorage(), archive,
      tenantId: 'default', apply: false,
    });

    expect(archive.jsons).toEqual([]);
    expect(archive.pdfs).toEqual([]);
    expect(archive.manifests).toEqual([]);
    expect(result.apply).toBe(false);
    expect(result.plans.length).toBe(1);
    expect(result.summary.firestoreCount).toBe(1);
  });

  it('apply: two invoices sharing a number are BOTH archived (de-collided), never overwritten', async () => {
    const firestore = makeFirestore([
      { id: 'a', data: { invoiceNumber: 'RE-1', tenantId: 'default', pdfUrl: 'gs://b/x/a.pdf' } },
      { id: 'b', data: { invoiceNumber: 'RE-1', tenantId: 'default', pdfUrl: 'gs://b/x/b.pdf' } },
    ]);
    const archive = makeArchiveWriter();

    const result = await runExport({
      firestore, storage: makeStorage(), archive, tenantId: 'default', apply: true,
    });

    expect(archive.jsons.length).toBe(2); // both docs written, not overwritten
    expect(new Set(archive.jsons.map((j) => j.name)).size).toBe(2);
    expect(result.summary.collisions).toContain('RE-1');
    expect(result.summary.ok).toBe(true);
  });
});

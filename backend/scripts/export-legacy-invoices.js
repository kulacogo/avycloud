'use strict';

/**
 * export-legacy-invoices.js — ARCHIVE-BEFORE-WIPE safety net for the
 * TrendOcean Einzelunternehmen → TrendOcean GmbH cutover.
 *
 * Exports every legacy invoice of a tenant (the Firestore doc JSON + its GCS
 * PDF) into a retention location and VERIFIES completeness. Must be run — and
 * verified ok — BEFORE the books-reset wipes the `invoices` collection.
 *
 * GoBD/§147: an invoice PDF is the sole record of the old entity's tax identity
 * (the Firestore doc does NOT store firmenname/ustIdNr). Losing one is
 * irrecoverable, so `summarizeExport` fails loudly on any gap.
 *
 * DRY-RUN by default. Reads only; writes to the archive only with --apply.
 *
 * Pure functions + runExport(deps) are require-able in tests without touching
 * real Firestore/GCS — heavy requires are deferred to the CLI entry below.
 */

/**
 * Parse a `gs://bucket/path/to/object` URL into its bucket + object path.
 * Returns null for anything that is not a well-formed gs:// URL with a path.
 */
function parseGcsUrl(url) {
  if (!url || typeof url !== 'string') return null;
  if (!url.startsWith('gs://')) return null;
  const rest = url.slice('gs://'.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null; // need a non-empty bucket AND a path
  const bucket = rest.slice(0, slash);
  const path = rest.slice(slash + 1);
  if (!bucket || !path) return null;
  return { bucket, path };
}

/**
 * Make an invoice number safe as a local/GCS file name. SevDesk numbers are
 * free-form; a '/' would otherwise become directory levels (silent misplacement).
 */
function sanitizeBaseName(name) {
  const cleaned = String(name).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '');
  return cleaned || 'invoice';
}

/**
 * Decide where a single invoice's JSON + PDF go in the archive, and surface
 * whether it even has a PDF (an invoice with no pdfUrl must NOT be silently
 * dropped — its JSON is still archived and the gap is reported).
 */
function planInvoiceExport(invoiceData, invoiceId) {
  const invoiceNumber = invoiceData?.invoiceNumber || null;
  const pdfUrl = invoiceData?.pdfUrl || null;
  const pdfSource = parseGcsUrl(pdfUrl);
  const hasPdf = pdfSource !== null;
  const baseName = sanitizeBaseName(invoiceNumber || invoiceId);
  return {
    invoiceId,
    invoiceNumber,
    pdfUrl,
    pdfSource,
    hasPdf,
    archiveJsonName: `${baseName}.json`,
    archivePdfName: hasPdf ? `${baseName}.pdf` : null,
  };
}

/**
 * Two invoices can share an invoiceNumber (documented prod reality: duplicate
 * drafts incident). Same archive name ⇒ the second write would OVERWRITE the
 * first ⇒ silent loss. De-collide by suffixing the doc id so BOTH survive, and
 * report which numbers collided.
 */
function decollidePlans(plans) {
  const counts = new Map();
  for (const p of plans) counts.set(p.archiveJsonName, (counts.get(p.archiveJsonName) || 0) + 1);
  const colliding = new Set([...counts.entries()].filter(([, n]) => n > 1).map(([name]) => name));
  const collisions = [];
  const fixed = plans.map((p) => {
    if (!colliding.has(p.archiveJsonName)) return p;
    const label = p.invoiceNumber || p.invoiceId;
    if (!collisions.includes(label)) collisions.push(label);
    const safeBase = sanitizeBaseName(`${label}__${p.invoiceId}`);
    return { ...p, archiveJsonName: `${safeBase}.json`, archivePdfName: p.hasPdf ? `${safeBase}.pdf` : null };
  });
  return { plans: fixed, collisions };
}

/**
 * Durable local write: fsync + read-back size check. A §147 archive must be on
 * disk, not just in the page cache, before the reset deletes the source.
 */
function writeFileDurable(fs, filePath, data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
  const fd = fs.openSync(filePath, 'w');
  try {
    fs.writeSync(fd, buf);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const written = fs.statSync(filePath).size;
  if (written !== buf.length) {
    throw new Error(`durable write size mismatch for ${filePath}: wrote ${written}, expected ${buf.length}`);
  }
}

/**
 * Verify an export is complete enough to safely wipe the source.
 * ok ⇔ every Firestore doc's JSON was written AND every PDF that exists was
 * archived. Invoices that never had a PDF are surfaced (noPdfUrl) as a warning,
 * not a failure — there is nothing to lose for those.
 */
function summarizeExport({ firestoreCount, plans, writtenJsonNames, downloadedPdfNames }) {
  const writtenSet = new Set(writtenJsonNames || []);
  const downloadedSet = new Set(downloadedPdfNames || []);
  const label = (p) => p.invoiceNumber || p.invoiceId;

  const missingJson = plans.filter((p) => !writtenSet.has(p.archiveJsonName)).map(label);
  const missingPdf = plans
    .filter((p) => p.hasPdf && !downloadedSet.has(p.archivePdfName))
    .map(label);
  const noPdfUrl = plans.filter((p) => !p.hasPdf).map(label);

  const exportedJsonCount = writtenSet.size;
  const docCountMatches = exportedJsonCount === firestoreCount && missingJson.length === 0;
  const ok = docCountMatches && missingPdf.length === 0;

  return {
    ok,
    docCountMatches,
    firestoreCount,
    exportedJsonCount,
    missingJson,
    missingPdf,
    noPdfUrl,
  };
}

/**
 * Orchestrate the export. All I/O is injected (firestore, storage, archive) so
 * it is fully testable and side-effect-free in dry-run.
 *
 * deps:
 *   firestore       — Firestore-like: collection().where('tenantId','==',t).get()
 *   storage         — GCS-like: bucket(b).file(p).download() → [Buffer]
 *   archive         — { writeJson(name,obj), writePdf(name,buf), writeManifest(obj) }
 *   tenantId        — default 'default'
 *   apply           — false ⇒ DRY-RUN (no writes, plan preview only)
 *   exportedAtIso   — injected timestamp for the manifest (deterministic in tests)
 *   collectionName  — default 'invoices'
 *   log             — optional logger
 */
async function runExport(deps) {
  const {
    firestore,
    storage,
    archive,
    tenantId = 'default',
    apply = false,
    exportedAtIso,
    collectionName = 'invoices',
    log = () => {},
  } = deps;

  const snap = await firestore.collection(collectionName).where('tenantId', '==', tenantId).get();
  const docs = snap.docs || [];
  const firestoreCount = typeof snap.size === 'number' ? snap.size : docs.length;

  const rawPlans = docs.map((d) => planInvoiceExport(d.data(), d.id));
  const { plans, collisions } = decollidePlans(rawPlans);

  const writtenJsonNames = [];
  const downloadedPdfNames = [];
  const errors = [];

  if (apply) {
    for (let i = 0; i < docs.length; i++) {
      const d = docs[i];
      const plan = plans[i];
      const label = plan.invoiceNumber || plan.invoiceId;
      // 1) Archive the doc JSON first — it must survive even if the PDF fails.
      try {
        await archive.writeJson(plan.archiveJsonName, { id: d.id, ...d.data() });
        writtenJsonNames.push(plan.archiveJsonName);
      } catch (err) {
        errors.push({ invoice: label, stage: 'json', message: err.message });
      }
      // 2) Archive the PDF if one exists.
      if (plan.hasPdf) {
        try {
          const [buffer] = await storage.bucket(plan.pdfSource.bucket).file(plan.pdfSource.path).download();
          await archive.writePdf(plan.archivePdfName, buffer);
          downloadedPdfNames.push(plan.archivePdfName);
        } catch (err) {
          errors.push({ invoice: label, stage: 'pdf', message: err.message });
        }
      }
      log(`  ${apply ? 'archived' : 'would archive'} ${label}`);
    }
  } else {
    // DRY-RUN: no I/O. Preview what a complete export would contain.
    for (const plan of plans) {
      writtenJsonNames.push(plan.archiveJsonName);
      if (plan.hasPdf) downloadedPdfNames.push(plan.archivePdfName);
    }
  }

  const summary = summarizeExport({ firestoreCount, plans, writtenJsonNames, downloadedPdfNames });
  summary.collisions = collisions;

  const manifest = {
    tenantId,
    exportedAt: exportedAtIso || null,
    apply,
    count: firestoreCount,
    ok: summary.ok,
    missingJson: summary.missingJson,
    missingPdf: summary.missingPdf,
    noPdfUrl: summary.noPdfUrl,
    collisions,
    errors,
    invoices: plans.map((p) => ({
      invoiceId: p.invoiceId,
      invoiceNumber: p.invoiceNumber,
      pdfUrl: p.pdfUrl,
      hasPdf: p.hasPdf,
      archiveJsonName: p.archiveJsonName,
      archivePdfName: p.archivePdfName,
    })),
  };

  if (apply) {
    try {
      await archive.writeManifest(manifest);
    } catch (err) {
      errors.push({ invoice: null, stage: 'manifest', message: err.message });
    }
  }

  return { apply, plans, writtenJsonNames, downloadedPdfNames, summary, manifest, errors };
}

/** Parse CLI args. DRY-RUN is the default; --apply is required to write. */
function parseArgs(argv) {
  const val = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
  };
  return {
    apply: argv.includes('--apply'),
    tenant: val('--tenant') || 'default',
    out: val('--out'),
    bucket: val('--bucket'),
  };
}

module.exports = {
  parseGcsUrl,
  sanitizeBaseName,
  planInvoiceExport,
  decollidePlans,
  writeFileDurable,
  summarizeExport,
  runExport,
  parseArgs,
};

// ─── CLI entry (thin glue over the tested core) ────────────────────────────
if (require.main === module) {
  const fs = require('fs');
  const path = require('path');

  // Local-FS archive writer (default). Operator then copies the folder to cold
  // storage. Transparent + easy to verify by hand.
  function makeLocalArchiveWriter(dir) {
    fs.mkdirSync(dir, { recursive: true });
    return {
      async writeJson(name, obj) { writeFileDurable(fs, path.join(dir, name), JSON.stringify(obj, null, 2)); },
      async writePdf(name, buffer) { writeFileDurable(fs, path.join(dir, name), buffer); },
      async writeManifest(obj) { writeFileDurable(fs, path.join(dir, '_manifest.json'), JSON.stringify(obj, null, 2)); },
    };
  }

  // GCS archive writer (when --bucket given). Writes under legacy-invoice-archive/<tenant>/.
  function makeGcsArchiveWriter(storage, bucketName, prefix) {
    const bucket = storage.bucket(bucketName);
    return {
      async writeJson(name, obj) {
        await bucket.file(`${prefix}/${name}`).save(Buffer.from(JSON.stringify(obj, null, 2)), { contentType: 'application/json', resumable: false });
      },
      async writePdf(name, buffer) {
        await bucket.file(`${prefix}/${name}`).save(buffer, { contentType: 'application/pdf', resumable: false });
      },
      async writeManifest(obj) {
        await bucket.file(`${prefix}/_manifest.json`).save(Buffer.from(JSON.stringify(obj, null, 2)), { contentType: 'application/json', resumable: false });
      },
    };
  }

  (async () => {
    const args = parseArgs(process.argv.slice(2));
    const { firestore } = require('../lib/firestore');
    const { Storage } = require('@google-cloud/storage');
    const storage = new Storage();

    const prefix = `legacy-invoice-archive/${args.tenant}`;
    const localDir = args.out || path.join(process.cwd(), 'legacy-invoice-archive', args.tenant);
    const archive = args.bucket
      ? makeGcsArchiveWriter(storage, args.bucket, prefix)
      : makeLocalArchiveWriter(localDir);
    const dest = args.bucket ? `gs://${args.bucket}/${prefix}` : localDir;

    console.log(`[export-legacy-invoices] tenant=${args.tenant} mode=${args.apply ? 'APPLY' : 'DRY-RUN'} dest=${dest}`);

    const result = await runExport({
      firestore, storage, archive,
      tenantId: args.tenant,
      apply: args.apply,
      exportedAtIso: new Date().toISOString(),
      log: (m) => process.stdout.write(`${m}\n`),
    });

    const s = result.summary;
    console.log(`\n  Rechnungen in Firestore : ${s.firestoreCount}`);
    console.log(`  JSON ${args.apply ? 'archiviert     ' : 'geplant        '}   : ${s.exportedJsonCount}`);
    console.log(`  PDF-Downloads fehlgeschl.: ${s.missingPdf.length}${s.missingPdf.length ? ' → ' + s.missingPdf.join(', ') : ''}`);
    console.log(`  Rechnungen ohne PDF      : ${s.noPdfUrl.length}${s.noPdfUrl.length ? ' → ' + s.noPdfUrl.join(', ') : ''}`);
    if (result.errors.length) {
      console.log(`  Fehler: ${result.errors.length}`);
      result.errors.slice(0, 20).forEach((e) => console.log(`    - [${e.stage}] ${e.invoice}: ${e.message}`));
    }

    if (!args.apply) {
      console.log(`\nDRY-RUN — nichts geschrieben. Mit --apply ausführen (liest nur Firestore/GCS, schreibt ins Archiv).`);
      process.exit(0);
    }
    if (s.ok) {
      console.log(`\n✅ Export vollständig verifiziert (ok). Der Bücher-Reset darf erst NACH diesem ok laufen.`);
      process.exit(0);
    }
    console.log(`\n❌ Export NICHT vollständig — Reset NICHT ausführen. Erst die Lücken oben klären.`);
    process.exit(1);
  })().catch((err) => {
    console.error(`[export-legacy-invoices] FATAL: ${err.message}`, err);
    process.exit(1);
  });
}

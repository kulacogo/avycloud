#!/usr/bin/env node
/**
 * audit-firestore-cruft.js — Read-only Firestore collection audit.
 *
 * Connects to Firestore via default credentials, lists root collections, and
 * for each:
 *   - docCount via `.count()` aggregation (sample of 200 if count fails)
 *   - 3 sample docs with their key fields
 *   - cross-checks whether the collection name is referenced in
 *     backend/**\/*.js via `.collection('name')` or `db.collection('name')`
 *   - classifies as POTENTIALLY_DEAD if never referenced
 *
 * Targeted orphan counts:
 *   - identificationJobs / improveJobs: completed & completedAt < now-30d
 *   - stock_operation_failures: status == 'abandoned'
 *   - products_v2: ghost candidates (title startsWith 'SKU-' OR UUID-like
 *     OR equals barcode)
 *
 * Output:
 *   - Markdown table to stdout (default) OR JSON (with --json)
 *   - Markdown report to docs/kb/_audit-runs/audit-firestore-cruft-YYYY-MM-DD.md
 *
 * READ-ONLY. Never mutates Firestore.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SCRIPT_NAME = 'audit-firestore-cruft';
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BACKEND_DIR = path.join(REPO_ROOT, 'backend');
const AUDIT_RUNS_DIR = path.join(REPO_ROOT, 'docs', 'kb', '_audit-runs');
const MAX_ROWS_PER_CATEGORY = 200;
const SAMPLE_DOCS = 3;
const COUNT_SAMPLE_FALLBACK = 200;

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '__snapshots__',
]);

function parseArgs(argv) {
  return { json: argv.includes('--json') };
}

function escapePipe(s) {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function truncate(rows) {
  if (rows.length <= MAX_ROWS_PER_CATEGORY) return { rows, overflow: 0 };
  return { rows: rows.slice(0, MAX_ROWS_PER_CATEGORY), overflow: rows.length - MAX_ROWS_PER_CATEGORY };
}

function walkCode(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_e) {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkCode(full, out);
    } else if (entry.isFile() && /\.(js|cjs|mjs|ts)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function collectReferencedCollections() {
  const referenced = new Set();
  const files = walkCode(BACKEND_DIR);
  const re = /\.collection\(\s*['"`]([A-Za-z0-9_\-]+)['"`]/g;
  for (const f of files) {
    let src;
    try {
      src = fs.readFileSync(f, 'utf8');
    } catch (_e) {
      continue;
    }
    let m;
    while ((m = re.exec(src)) !== null) {
      referenced.add(m[1]);
    }
  }
  return referenced;
}

function writeRunReport(markdown) {
  try {
    if (!fs.existsSync(AUDIT_RUNS_DIR)) {
      fs.mkdirSync(AUDIT_RUNS_DIR, { recursive: true });
    }
    const stamp = new Date().toISOString().slice(0, 10);
    const dest = path.join(AUDIT_RUNS_DIR, `${SCRIPT_NAME}-${stamp}.md`);
    fs.writeFileSync(dest, markdown, 'utf8');
    return dest;
  } catch (err) {
    return `ERR:${err.message}`;
  }
}

async function countDocs(colRef) {
  try {
    const snap = await colRef.count().get();
    return { count: snap.data().count, source: 'count-aggregation' };
  } catch (_e) {
    try {
      const sampleSnap = await colRef.limit(COUNT_SAMPLE_FALLBACK).get();
      return {
        count: sampleSnap.size,
        source: sampleSnap.size === COUNT_SAMPLE_FALLBACK ? `>=${COUNT_SAMPLE_FALLBACK} (sample)` : 'sample',
      };
    } catch (err) {
      return { count: -1, source: `error: ${err.message}` };
    }
  }
}

async function fetchSamples(colRef) {
  try {
    const snap = await colRef.limit(SAMPLE_DOCS).get();
    return snap.docs.map((d) => {
      const data = d.data() || {};
      const keys = Object.keys(data).slice(0, 6);
      return { id: d.id, keys };
    });
  } catch (err) {
    return [{ id: 'ERR', keys: [err.message.slice(0, 80)] }];
  }
}

async function countOrphans(firestore, name) {
  const result = { orphanCount: 0, note: '' };
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

  try {
    if (name === 'identificationJobs' || name === 'improveJobs') {
      const colRef = firestore.collection(name);
      try {
        const snap = await colRef
          .where('status', '==', 'completed')
          .where('completedAt', '<', new Date(thirtyDaysAgo))
          .count()
          .get();
        result.orphanCount = snap.data().count;
        result.note = 'completed + completedAt < now-30d';
      } catch (e1) {
        try {
          const snap = await colRef
            .where('status', '==', 'completed')
            .where('completedAt', '<', thirtyDaysAgo)
            .count()
            .get();
          result.orphanCount = snap.data().count;
          result.note = 'completed + completedAt(ms) < now-30d';
        } catch (e2) {
          result.note = `orphan-count failed: ${e2.message.slice(0, 60)}`;
        }
      }
    } else if (name === 'stock_operation_failures') {
      const snap = await firestore
        .collection(name)
        .where('status', '==', 'abandoned')
        .count()
        .get();
      result.orphanCount = snap.data().count;
      result.note = 'status == abandoned';
    } else if (name === 'products_v2') {
      const colRef = firestore.collection(name);
      const sampleSize = 500;
      const snap = await colRef.limit(sampleSize).get();
      let ghosts = 0;
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      for (const doc of snap.docs) {
        const data = doc.data() || {};
        const title = String(data.title || '').trim();
        const barcode = String(data.barcode || data.ean || data.gtin || '').trim();
        if (!title) continue;
        if (title.startsWith('SKU-')) ghosts++;
        else if (uuidRe.test(title)) ghosts++;
        else if (barcode && title === barcode) ghosts++;
      }
      result.orphanCount = ghosts;
      result.note = `ghost-like in first ${snap.size} docs (title=SKU-* / UUID / ==barcode)`;
    }
  } catch (err) {
    result.note = `orphan-count error: ${err.message.slice(0, 80)}`;
  }
  return result;
}

function classify(name, docCount, referencedInCode, orphanCount) {
  if (!referencedInCode && docCount > 0) {
    return { classification: 'POTENTIALLY_DEAD', action: 'Investigate: collection not referenced in backend code' };
  }
  if (docCount === 0) {
    return { classification: 'EMPTY', action: 'Consider removing if not seeded by future code' };
  }
  if (orphanCount > 0) {
    return { classification: 'HAS_ORPHANS', action: `Clean up ${orphanCount} orphan docs` };
  }
  return { classification: 'ACTIVE', action: 'No action' };
}

function renderMarkdown(rows, meta, samplesByName, errors) {
  const out = [
    `# Firestore Cruft Audit — ${meta.generated_at.slice(0, 10)}`,
    '',
    `Project: \`${meta.project_id || 'unknown'}\``,
    `Total root collections: ${meta.total_collections}`,
    `Errors: ${meta.errors_count}`,
    '',
    '## Collections',
    '',
    '| Collection | DocCount | ReferencedInCode | OrphanCount | Classification | OperatorActionNeeded |',
    '|------------|----------|------------------|-------------|----------------|----------------------|',
  ];

  const { rows: shown, overflow } = truncate(rows);
  for (const r of shown) {
    out.push(
      `| ${escapePipe(r.collection)} | ${escapePipe(r.docCount)} | ${escapePipe(r.referencedInCode ? 'yes' : 'no')} | ${escapePipe(r.orphanCount)} | ${escapePipe(r.classification)} | ${escapePipe(r.action)} |`,
    );
  }
  if (overflow > 0) {
    out.push(`| ... | | | | | ${overflow} more (truncated) |`);
  }
  out.push('');

  out.push('## Sample Docs');
  out.push('');
  for (const [col, samples] of Object.entries(samplesByName)) {
    out.push(`### \`${col}\``);
    out.push('');
    if (samples.length === 0) {
      out.push('_no samples_');
      out.push('');
      continue;
    }
    out.push('| Doc ID | Key Fields |');
    out.push('|--------|------------|');
    for (const s of samples) {
      out.push(`| ${escapePipe(s.id)} | ${escapePipe(s.keys.join(', '))} |`);
    }
    out.push('');
  }

  if (errors.length > 0) {
    out.push('## Errors');
    out.push('');
    for (const e of errors.slice(0, 50)) {
      out.push(`- ${e}`);
    }
    if (errors.length > 50) {
      out.push(`- ... ${errors.length - 50} more (truncated)`);
    }
  }
  return out.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const errors = [];
  let firestore = null;
  let projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || null;

  try {
    const admin = require('firebase-admin');
    if (!admin.apps.length) admin.initializeApp();
    firestore = admin.firestore();
    if (!projectId) {
      try {
        projectId = admin.app().options?.projectId || firestore._settings?.projectId || null;
      } catch (_e) {
        // ignore
      }
    }
  } catch (err) {
    const meta = {
      script: SCRIPT_NAME,
      generated_at: new Date().toISOString(),
      project_id: projectId,
      total_collections: 0,
      errors_count: 1,
      report_file: null,
    };
    const markdown = `# Firestore Cruft Audit — ${meta.generated_at.slice(0, 10)}\n\n` +
      `_FIRESTORE_NOT_AVAILABLE_: ${err.message}\n`;
    meta.report_file = writeRunReport(markdown);
    if (args.json) {
      process.stdout.write(JSON.stringify({ meta, findings: [], errors: [err.message] }, null, 2) + '\n');
    } else {
      process.stdout.write(markdown);
      process.stdout.write(`\n_Report written to_ \`${meta.report_file}\`\n`);
    }
    process.exit(0);
    return;
  }

  const referenced = collectReferencedCollections();
  const rows = [];
  const samplesByName = {};

  let collections = [];
  try {
    collections = await firestore.listCollections();
  } catch (err) {
    errors.push(`listCollections: ${err.message}`);
  }

  for (const colRef of collections) {
    const name = colRef.id;
    try {
      const { count, source } = await countDocs(colRef);
      const samples = await fetchSamples(colRef);
      samplesByName[name] = samples;
      const { orphanCount, note } = await countOrphans(firestore, name);
      const referencedInCode = referenced.has(name);
      const { classification, action } = classify(name, count, referencedInCode, orphanCount);
      rows.push({
        collection: name,
        docCount: count < 0 ? source : `${count} (${source})`,
        referencedInCode,
        orphanCount: note ? `${orphanCount} — ${note}` : String(orphanCount),
        classification,
        action,
      });
    } catch (err) {
      errors.push(`${name}: ${err.message}`);
      rows.push({
        collection: name,
        docCount: 'ERR',
        referencedInCode: referenced.has(name),
        orphanCount: '?',
        classification: 'ERROR',
        action: err.message.slice(0, 80),
      });
    }
  }

  rows.sort((a, b) => a.collection.localeCompare(b.collection));

  const meta = {
    script: SCRIPT_NAME,
    generated_at: new Date().toISOString(),
    project_id: projectId,
    total_collections: rows.length,
    errors_count: errors.length,
  };

  const markdown = renderMarkdown(rows, meta, samplesByName, errors);
  const written = writeRunReport(markdown);
  meta.report_file = written;

  if (args.json) {
    process.stdout.write(JSON.stringify({ meta, findings: rows, samples: samplesByName, errors: errors.slice(0, 50) }, null, 2) + '\n');
  } else {
    process.stdout.write(markdown);
    process.stdout.write(`\n_Report written to_ \`${written}\`\n`);
  }
  process.exit(0);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`[${SCRIPT_NAME}] fatal: ${err.message}\n`);
    process.exit(0);
  });
}

module.exports = { collectReferencedCollections, classify };

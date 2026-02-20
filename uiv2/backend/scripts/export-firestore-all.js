/* eslint-disable no-console */
/**
 * Export all Firestore collections to CSV files.
 * Usage:
 *   node backend/scripts/export-firestore-all.js
 *
 * Outputs: exports/firestore/<collection>.csv
 */

const fs = require('fs');
const path = require('path');
const { Firestore } = require('@google-cloud/firestore');

const firestore = new Firestore({
  projectId: process.env.GOOGLE_CLOUD_PROJECT || 'avycloud',
});

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

async function exportCollection(colRef, outDir) {
  const name = colRef.id;
  const snap = await colRef.get();
  const rows = [];
  snap.forEach((doc) => {
    rows.push({
      id: doc.id,
      ...doc.data(),
    });
  });
  if (!rows.length) {
    const outPath = path.join(outDir, `${name}.csv`);
    fs.writeFileSync(outPath, 'id\n');
    console.log(`Exported ${name}: 0 docs -> ${outPath}`);
    return;
  }
  const headers = Array.from(
    new Set(
      rows.flatMap((r) => Object.keys(r))
    )
  );
  const lines = [];
  lines.push(headers.join(','));
  rows.forEach((row) => {
    const line = headers.map((h) => csvEscape(row[h] !== undefined ? row[h] : '')).join(',');
    lines.push(line);
  });
  const outPath = path.join(outDir, `${name}.csv`);
  fs.writeFileSync(outPath, lines.join('\n'));
  console.log(`Exported ${name}: ${rows.length} docs -> ${outPath}`);
}

async function main() {
  const outDir = path.join(process.cwd(), 'exports', 'firestore');
  ensureDir(outDir);

  const collections = await firestore.listCollections();
  console.log('Collections:', collections.map((c) => c.id).join(', '));

  for (const col of collections) {
    await exportCollection(col, outDir);
  }
}

main().catch((err) => {
  console.error('Export failed:', err);
  process.exit(1);
});



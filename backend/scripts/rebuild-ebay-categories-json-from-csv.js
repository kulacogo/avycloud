/* eslint-disable no-console */
/**
 * Rebuild `backend/ebay-data/categories.json` with FULL breadcrumbs (category paths)
 * from the official eBay DE category CSV.
 *
 * Source: `ebay/DE_New_Structure_(May2023).csv`
 * Target: `backend/ebay-data/categories.json`
 *
 * Why:
 * - The app uses `categories.json` to set `identification.category`.
 * - We want a consistent *full* eBay category path (e.g. "Auto & Motorrad: Teile > ... > Anlasser"),
 *   not just the leaf name.
 *
 * Usage:
 *   node backend/scripts/rebuild-ebay-categories-json-from-csv.js
 */

const fs = require('fs');
const path = require('path');

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function rebuildFromCsv(csvPath) {
  const lines = fs.readFileSync(csvPath, 'utf8').split(/\r?\n/);
  // CSV header is on line 3 (1-indexed). Rows start at line 4.
  const startIdx = 3; // 0-indexed

  const currentLevels = ['', '', '', '', '', '']; // L1..L6 carry-forward
  const categories = {};

  for (let idx = startIdx; idx < lines.length; idx += 1) {
    const line = lines[idx];
    if (!line) continue;

    const cols = parseCsvLine(line);
    if (!cols || cols.length < 7) continue;

    const levels = cols.slice(0, 6).map((v) => (v == null ? '' : String(v)).trim());
    const rawId = (cols[6] == null ? '' : String(cols[6])).trim();
    if (!rawId) continue;

    // Carry-forward hierarchical levels:
    for (let i = 0; i < 6; i += 1) {
      const v = levels[i];
      if (v) {
        currentLevels[i] = v;
        for (let j = i + 1; j < 6; j += 1) currentLevels[j] = '';
      }
    }

    const breadcrumbParts = currentLevels.filter(Boolean);
    const breadcrumb = breadcrumbParts.join(' > ');
    const name = breadcrumbParts[breadcrumbParts.length - 1] || rawId;
    const idNum = Number(rawId);

    categories[rawId] = {
      id: Number.isFinite(idNum) ? idNum : rawId,
      name,
      breadcrumb,
    };
  }

  return categories;
}

function main() {
  const repoRoot = path.join(__dirname, '..', '..');
  const csvPath = path.join(repoRoot, 'ebay', 'DE_New_Structure_(May2023).csv');
  const outPath = path.join(__dirname, '..', 'ebay-data', 'categories.json');

  if (!fs.existsSync(csvPath)) {
    console.error('eBay CSV not found:', csvPath);
    process.exit(1);
  }

  const categories = rebuildFromCsv(csvPath);
  const count = Object.keys(categories).length;
  if (!count) {
    console.error('No categories parsed from CSV. Aborting.');
    process.exit(1);
  }

  // Write atomically
  const tmpPath = `${outPath}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(categories, null, 2)}\n`);
  fs.renameSync(tmpPath, outPath);

  console.log('Rebuilt categories.json with full breadcrumbs:', { outPath, count });
}

main();



/* eslint-disable no-console */
/**
 * Extract a compact motorcycle ePID dataset from `DE_Motorradliste_2025_06.xlsx`.
 *
 * Input columns (sheet `DE_MML_2025_06`, as provided):
 * - ePID
 * - DEM_Make
 * - DEM_Model
 * - DEM_CCM
 * - DEM_Submodel
 * - Year
 * - DEM_StreetName
 * - Vehicle Type (e.g. DE_MOTORCYCLES)
 *
 * Output (JSONL) to `exports/DE_Motorradliste_2025_06.compact.jsonl`:
 * { epid:number, make:string, model:string, ccm:number, year:number, submodel:string, street:string }
 *
 * Usage:
 *   node backend/scripts/extract-moto-epid-jsonl.js
 *   MOTO_XLSX_PATH=/path/to/DE_Motorradliste_2025_06.xlsx node backend/scripts/extract-moto-epid-jsonl.js
 */

const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function toInt(v) {
  const n = Number(String(v || '').replace(/[^\d]/g, ''));
  return Number.isFinite(n) ? n : NaN;
}

function normalizeModelToken(model) {
  return safeString(model).toUpperCase().replace(/[^A-Z0-9]+/g, '');
}

function main() {
  const inPath =
    safeString(process.env.MOTO_XLSX_PATH) ||
    path.join(process.cwd(), 'DE_Motorradliste_2025_06.xlsx'); // run from repo root
  const outPath = path.join(process.cwd(), 'exports', 'DE_Motorradliste_2025_06.compact.jsonl');
  const sheetName = safeString(process.env.MOTO_SHEET) || 'DE_MML_2025_06';

  if (!fs.existsSync(inPath)) {
    console.error('Input XLSX not found:', inPath);
    process.exit(1);
  }

  const wb = xlsx.readFile(inPath);
  const available = wb.SheetNames || [];
  const pick = available.includes(sheetName) ? sheetName : available[0];
  if (!pick) {
    console.error('No sheets found in:', inPath);
    process.exit(1);
  }

  const sh = wb.Sheets[pick];
  const rows = xlsx.utils.sheet_to_json(sh, { defval: '', raw: true });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  let written = 0;
  let skipped = 0;
  const out = fs.createWriteStream(outPath, { encoding: 'utf8' });

  for (const row of rows) {
    const epid = toInt(row.ePID || row.epid);
    const make = safeString(row.DEM_Make || row.make);
    const modelRaw = safeString(row.DEM_Model || row.model);
    const model = normalizeModelToken(modelRaw);
    const ccm = toInt(row.DEM_CCM || row.ccm);
    const year = toInt(row.Year || row.year);
    const submodel = safeString(row.DEM_Submodel || row.submodel);
    const street = safeString(row.DEM_StreetName || row.street || row.streetname);

    if (!Number.isFinite(epid) || epid <= 0) {
      skipped += 1;
      continue;
    }
    if (!make || !model || !Number.isFinite(ccm) || ccm <= 0 || !Number.isFinite(year) || year < 1900) {
      skipped += 1;
      continue;
    }

    const rec = {
      epid,
      make,
      model,
      ccm,
      year,
      submodel: submodel || '',
      street: street || '',
    };
    out.write(`${JSON.stringify(rec)}\n`);
    written += 1;
  }

  out.end();
  console.log(JSON.stringify({ inPath, sheet: pick, rows: rows.length, written, skipped, outPath }, null, 2));
}

main();


/* eslint-disable no-console */
/**
 * D.0b-Migration 2026-05-10: Migrated to getAllProductsForTenant().
 * See /Users/oguz/.claude/plans/sieht-ziemlich-komplex-unstrukturiert-woolly-tulip.md (Phase D.0)
 * D.0b-Migration: Default to avycloud. Override via TENANT_ID env var.
 */
/**
 * Export products missing required GPSR fields (for manual/ops follow-up).
 *
 * Usage:
 *   TENANT_ID=avycloud GOOGLE_CLOUD_PROJECT=avycloud node backend/scripts/gpsr-export-missing-required-report.js
 */

const fs = require('fs');
const path = require('path');
const { getAllProductsForTenant } = require('../lib/firestore');

// D.0b-Hardening 2026-05-11: read script — default avycloud OK, but log effective tenant prominently
const TENANT_ID = process.env.TENANT_ID || 'avycloud';
console.log('[INFO] Running with TENANT_ID=%s (read-only; override via TENANT_ID env var)', TENANT_ID);
const { isGpsrPlaceholderLike, scoreGpsr } = require('../lib/gpsr-manufacturer-registry');

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(
    d.getSeconds()
  )}`;
}
function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const REQUIRED_FIELDS = [
  'entity_country',
  'manufacturer_name',
  'manufacturer_address',
  'manufacturer_city',
  'manufacturer_postalcode',
  'email',
];

function pickManufacturerName(p) {
  return (
    safeString(p?.details?.gpsr?.manufacturer_name) ||
    safeString(p?.identification?.brand) ||
    safeString(p?.details?.brand) ||
    ''
  );
}

async function main() {
  const outDir = path.resolve('backend/exports/gpsr-coverage');
  ensureDir(outDir);

  const all = await getAllProductsForTenant(TENANT_ID);
  const products = Array.isArray(all) ? all.filter((p) => p?.id) : [];

  const rows = [];
  for (const p of products) {
    const gpsr = p?.details?.gpsr && typeof p.details.gpsr === 'object' ? p.details.gpsr : {};
    const missing = REQUIRED_FIELDS.filter((f) => {
      const v = safeString(gpsr[f]);
      return !v || isGpsrPlaceholderLike(v);
    });
    if (!missing.length) continue;
    rows.push({
      productId: String(p.id),
      sku: safeString(p?.identification?.sku),
      manufacturer: pickManufacturerName(p),
      missingFields: missing.join('|'),
      gpsrScore: String(scoreGpsr(gpsr)),
    });
  }

  const header = ['productId', 'sku', 'manufacturer', 'missingFields', 'gpsrScore'];
  const csv =
    header.join(',') +
    '\n' +
    rows
      .sort((a, b) => a.manufacturer.localeCompare(b.manufacturer) || a.productId.localeCompare(b.productId))
      .map((r) => header.map((h) => csvEscape(r[h])).join(','))
      .join('\n') +
    '\n';

  const outCsv = path.join(outDir, `gpsr-missing-required-${nowStamp()}.csv`);
  fs.writeFileSync(outCsv, csv, 'utf8');

  console.log(JSON.stringify({ done: true, totalProducts: products.length, missing: rows.length, outCsv }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


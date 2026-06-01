#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Backfill GPSR for in-stock products:
 * 1) Demix EU-rep contacts from manufacturer fields
 * 2) Apply default EU rep (eVatmaster) for non-EU manufacturers
 * 3) Fill missing manufacturer fields from registry where available
 *
 * Usage:
 *   TENANT_ID=default GOOGLE_CLOUD_PROJECT=avycloud node backend/scripts/gpsr-backfill-eu-rep-instock.js --dry-run
 *   TENANT_ID=default GOOGLE_CLOUD_PROJECT=avycloud node backend/scripts/gpsr-backfill-eu-rep-instock.js --apply
 */

const { getAllProductsForTenant, getProduct, saveProduct } = require('../lib/firestore');
const {
  getManufacturerGpsrByName,
  mergePreferMoreComplete,
  normalizeGpsrObject,
  scoreGpsr,
  isGpsrPlaceholderLike,
} = require('../lib/gpsr-manufacturer-registry');
const {
  demixManufacturerEuRepContacts,
  isNonEuManufacturer,
  hasEuRepFields,
  normalizeEuRepFields,
  productStock,
} = require('../lib/gpsr-eu-rep');

const TENANT_ID = process.env.TENANT_ID || 'default';
const dryRun = !process.argv.includes('--apply');

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function pickManufacturerName(p) {
  const gpsr = p?.details?.gpsr || {};
  return (
    safeString(gpsr.manufacturer_name) ||
    safeString(p?.identification?.brand) ||
    safeString(p?.details?.brand) ||
    ''
  );
}

function gpsrSnapshot(gpsr) {
  return JSON.stringify({
    m: normalizeGpsrObject(gpsr),
    eu: normalizeEuRepFields(gpsr),
  });
}

function missingManufacturerRequired(gpsr) {
  const req = ['manufacturer_name', 'manufacturer_address', 'manufacturer_city', 'manufacturer_postalcode', 'entity_country', 'email'];
  return req.filter((f) => {
    const v = safeString(gpsr?.[f]);
    return !v || isGpsrPlaceholderLike(v);
  });
}

async function enrichFromRegistry(gpsr, manufacturerName) {
  if (!manufacturerName) return gpsr;
  const reg = await getManufacturerGpsrByName(manufacturerName).catch(() => null);
  const regGpsr = reg?.gpsr && typeof reg.gpsr === 'object' ? reg.gpsr : null;
  if (!regGpsr || !Object.keys(regGpsr).length) return gpsr;
  return mergePreferMoreComplete(gpsr, regGpsr);
}

async function main() {
  console.log('[gpsr-backfill-eu-rep-instock] tenant=%s dryRun=%s', TENANT_ID, dryRun);

  const all = await getAllProductsForTenant(TENANT_ID);
  const targets = (Array.isArray(all) ? all : []).filter((p) => p?.id && productStock(p) >= 1);

  const stats = {
    totalInStock: targets.length,
    updated: 0,
    demixed: 0,
    euRepAdded: 0,
    registryFilled: 0,
    skippedOk: 0,
    errors: 0,
  };

  for (const p of targets) {
    try {
      let gpsr = p?.details?.gpsr && typeof p.details.gpsr === 'object' ? { ...p.details.gpsr } : {};
      const before = gpsrSnapshot(gpsr);
      const beforeHasEuRep = hasEuRepFields(gpsr);

      gpsr = demixManufacturerEuRepContacts(gpsr);
      if (!beforeHasEuRep && hasEuRepFields(gpsr)) stats.euRepAdded += 1;
      if (isNonEuManufacturer(gpsr)) stats.demixed += 1;

      const manufacturer = pickManufacturerName({ ...p, details: { ...p.details, gpsr } });
      const missBefore = missingManufacturerRequired(gpsr).length;
      if (missBefore > 0 && manufacturer) {
        gpsr = await enrichFromRegistry(gpsr, manufacturer);
        if (missingManufacturerRequired(gpsr).length < missBefore) stats.registryFilled += 1;
      }

      const after = gpsrSnapshot(gpsr);
      if (before === after) {
        stats.skippedOk += 1;
        continue;
      }

      if (dryRun) {
        console.log('[dry-run] would update %s (%s) nonEu=%s euRep=%s',
          safeString(p?.identification?.sku) || p.id,
          manufacturer || '?',
          isNonEuManufacturer(gpsr),
          hasEuRepFields(gpsr));
        stats.updated += 1;
        continue;
      }

      const fresh = await getProduct(p.id).catch(() => p);
      const next = {
        ...fresh,
        details: {
          ...(fresh.details || {}),
          gpsr,
        },
      };
      await saveProduct(next, { saveSource: 'gpsr-backfill-eu-rep-instock' });
      stats.updated += 1;
      console.log('[apply] updated %s', safeString(p?.identification?.sku) || p.id);
    } catch (err) {
      stats.errors += 1;
      console.error('[error] product=%s %s', p?.id, err?.message || err);
    }
  }

  console.log(JSON.stringify({ done: true, dryRun, stats }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

'use strict';

// Usage: USE_PRODUCTS_V2=true GOOGLE_CLOUD_PROJECT=avycloud node
// backend/scripts/unassign-warehouse-zone.js --zone X --tenant default
// --operation zone-x-20260922 --backup /absolute/private/backup.json [--apply]
// Dry-run is default. Apply always saves a fresh backup before its transaction.
const fs = require('node:fs');
const path = require('node:path');
const { buildUnassignmentPlan, applyUnassignmentPlan, inZone, versionOf } = require('../lib/warehouse-zone-unassign');

function parseArgs(argv) {
  const result = { apply: false };
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    if (name === '--apply') result.apply = true;
    else if (['--zone', '--tenant', '--operation', '--backup'].includes(name)) result[name.slice(2)] = argv[++i];
    else throw new Error(`Unknown argument ${name}`);
  }
  if (result.zone !== 'X' || result.tenant !== 'default' || !result.operation || !path.isAbsolute(result.backup || '')) {
    throw new Error('This operator command requires --zone X --tenant default --operation ID --backup /absolute/path');
  }
  return result;
}

const asRow = snap => ({ id: snap.id, data: snap.data(), version: versionOf(snap) });

async function collect(db, { zone, tenant, operation }) {
  // Historical default BIN ownership is verified by the plan builder.
  const binSnap = await db.collection('warehouseBins').where('zone', '==', zone).get();
  const bins = new Map(binSnap.docs.map(doc => [doc.id, asRow(doc)]));
  for (const bin of bins.values()) {
    for (const child of bin.data.childBinCodes || []) {
      if (!bins.has(child)) {
        const snap = await db.collection('warehouseBins').doc(child).get();
        if (!snap.exists) throw new Error(`Missing referenced child ${child}`);
        bins.set(child, asRow(snap));
      }
    }
  }
  const productProjection = await db.collection('products_v2').where('tenantId', '==', tenant)
    .select('storage', 'storageBins', 'identification.sku', 'ops.identity_aliases').get();
  const ids = new Set();
  productProjection.docs.forEach(snap => {
    const product = snap.data();
    if (inZone(product.storage, zone) || (product.storageBins || []).some(location => inZone(location, zone))) ids.add(snap.id);
  });
  for (const bin of bins.values()) for (const entry of bin.data.products || []) {
    if (!entry.productId) throw new Error(`Missing productId in ${bin.id}`);
    ids.add(entry.productId);
  }
  const products = [];
  const missing = [];
  for (const id of ids) {
    const [current, legacy] = await db.getAll(db.collection('products_v2').doc(id), db.collection('products').doc(id));
    if (legacy.exists) throw new Error(`Legacy product also exists: ${id}; requires an explicit dual-collection plan`);
    if (current.exists) products.push(asRow(current));
    else missing.push(id);
  }
  // Never detach an apparent orphan if it is actually a known SKU/identity alias.
  for (const bin of bins.values()) for (const entry of bin.data.products || []) {
    if (!missing.includes(entry.productId)) continue;
    const alternative = productProjection.docs.find(snap => {
      const product = snap.data();
      return (entry.sku && product.identification?.sku === entry.sku)
        || (product.ops?.identity_aliases || []).includes(entry.productId);
    });
    if (alternative) throw new Error(`Orphan ${entry.productId} resolves to ${alternative.id}; reconcile identity first`);
  }
  return buildUnassignmentPlan({ tenantId: tenant, zone, operationId: operation, now: new Date().toISOString(), bins: [...bins.values()], products });
}

async function verify(db, plan) {
  const after = await collect(db, { zone: plan.zone, tenant: plan.tenantId, operation: `${plan.operationId}-verify` });
  if (after.summary.units !== 0 || after.products.length || after.orphans.length) throw new Error('Zone still has product assignments after relocation');
  const results = [];
  for (const item of plan.products) {
    const snap = await db.collection('products_v2').doc(item.id).get();
    const product = snap.data();
    if (!snap.exists || product.inventory?.quantity !== item.inventoryBefore) throw new Error(`Inventory changed for ${item.id}; inspect concurrent movements before repair`);
    if (JSON.stringify(product.storageBins) !== JSON.stringify(item.patch.storageBins)) throw new Error(`Storage changed for ${item.id}; inspect concurrent movements`);
    if (product.ops?.relocation?.unassignedQuantity !== item.patch['ops.relocation'].unassignedQuantity) throw new Error(`Relocation quantity changed for ${item.id}`);
    results.push({ productId: item.id, inventoryQuantity: product.inventory.quantity, unassignedQuantity: product.ops.relocation.unassignedQuantity });
  }
  return { zoneUnits: after.summary.units, productAssignments: after.products.length, checkedProducts: results.length,
    inventoryTotal: results.reduce((sum, item) => sum + item.inventoryQuantity, 0),
    unassignedTotal: results.reduce((sum, item) => sum + item.unassignedQuantity, 0) };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (process.env.USE_PRODUCTS_V2 !== 'true' || process.env.GOOGLE_CLOUD_PROJECT !== 'avycloud') throw new Error('Explicit production project and USE_PRODUCTS_V2=true required');
  if (args.apply && process.env.STOCK_LOCK_BACKEND !== 'firestore') throw new Error('STOCK_LOCK_BACKEND=firestore required for apply');
  const { firestore: db } = require('../lib/firestore');
  const { saveProductV2 } = require('../lib/product-store');
  const { withStockLock } = require('../lib/stock-lock');
  const plan = await collect(db, args);
  fs.mkdirSync(path.dirname(args.backup), { recursive: true, mode: 0o700 });
  // Never overwrite a pre-mutation backup, including on retry.
  fs.writeFileSync(args.backup, JSON.stringify(plan, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ mode: args.apply ? 'apply' : 'dry-run', backup: args.backup, operationId: plan.operationId, ...plan.summary }));
  if (!args.apply) return;
  const keys = [...new Set(plan.products.map(p => p.sku))].sort();
  const started = Date.now();
  async function locked(index) {
    if (index < keys.length) return withStockLock(keys[index], () => locked(index + 1), 120000);
    if (Date.now() - started > 60000) throw new Error('Lock acquisition took too long; retry with a fresh backup');
    return applyUnassignmentPlan(plan, { db, saveProductV2 });
  }
  const applied = await withStockLock(`zone-relocation:${plan.tenantId}:${plan.zone}`, () => locked(0), 120000);
  const verified = await verify(db, plan);
  fs.writeFileSync(`${args.backup}.result.json`, JSON.stringify({ applied, verified, checkedAt: new Date().toISOString() }, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ applied, verified }));
}

if (require.main === module) main().then(() => process.exit(0)).catch(error => { console.error(error.stack || error); process.exit(1); });
module.exports = { parseArgs, collect, verify };

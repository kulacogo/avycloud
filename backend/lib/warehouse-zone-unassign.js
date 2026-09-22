'use strict';

// Operator-only neutral relocation. No inventory/marketplace mutation and no route.
function quantity(value, label) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid quantity: ${label}`);
  }
  return value;
}

function inZone(value, zone) {
  return value?.zone === zone || new RegExp(`^${zone}(?:EG|UG|GA)\\d`).test(String(value?.code || value?.binCode || ''));
}

function versionOf(snap) {
  const stamp = snap.updateTime;
  return stamp ? `${stamp.seconds}:${stamp.nanoseconds}` : null;
}

function buildUnassignmentPlan({ tenantId, zone, operationId, now, bins, products }) {
  if (!tenantId || !['X', 'XS', 'XQ', 'S', 'M', 'L', 'XL'].includes(zone) || !/^[a-zA-Z0-9_-]{1,100}$/.test(operationId || '')) {
    throw new Error('Explicit tenant, valid zone and operationId required');
  }
  const allocations = new Map();
  const knownProducts = new Map(products.map(p => [p.id, p]));
  const orphans = [];
  let units = 0;
  for (const bin of bins) {
    if ((bin.data.tenantId || 'default') !== tenantId) throw new Error(`Wrong BIN tenant: ${bin.id}`);
    if (bin.data.zone && bin.data.zone !== zone) throw new Error(`Wrong BIN zone: ${bin.id}`);
    if (!inZone({ ...bin.data, code: bin.id }, zone)) throw new Error(`Unverifiable BIN zone: ${bin.id}`);
    if (!Array.isArray(bin.data.products)) throw new Error(`Unverifiable BIN products: ${bin.id}`);
    let count = 0;
    for (const entry of bin.data.products) {
      const qty = quantity(entry.quantity, bin.id);
      if (typeof entry.productId !== 'string' || !entry.productId || entry.productId.includes('/')) throw new Error(`Invalid product reference: ${bin.id}`);
      count += qty;
      if (!knownProducts.has(entry.productId)) {
        orphans.push({ productId: entry.productId, sourceBin: bin.id, entry });
      } else {
        const map = allocations.get(entry.productId) || new Map();
        map.set(bin.id, (map.get(bin.id) || 0) + qty);
        allocations.set(entry.productId, map);
      }
    }
    if (bin.data.productCount !== undefined && quantity(bin.data.productCount, `${bin.id}.productCount`) !== count) throw new Error(`BIN quantity mismatch: ${bin.id}`);
    units += count;
  }
  const plannedProducts = [];
  let inventoryBefore = 0;
  for (const product of products) {
    const data = product.data;
    const locations = data.storageBins || [];
    if (!Array.isArray(locations)) throw new Error(`Invalid storageBins: ${product.id}`);
    const affected = locations.filter(location => inZone(location, zone));
    const primaryAffected = inZone(data.storage, zone);
    if (!affected.length && !primaryAffected && !allocations.has(product.id)) continue;
    if (data.tenantId !== tenantId) throw new Error(`Wrong product tenant: ${product.id}`);
    const expected = allocations.get(product.id) || new Map();
    const fromProduct = new Map();
    for (const location of affected) {
      if (location.zone && location.zone !== zone) throw new Error(`Conflicting storage zone: ${product.id}`);
      const code = location.code || location.binCode;
      fromProduct.set(code, (fromProduct.get(code) || 0) + quantity(location.quantity, `${product.id}/${code}`));
    }
    for (const code of new Set([...expected.keys(), ...fromProduct.keys()])) {
      if ((expected.get(code) || 0) !== (fromProduct.get(code) || 0)) throw new Error(`Allocation mismatch: ${product.id}/${code}`);
    }
    const movedQuantity = [...expected.values()].reduce((sum, qty) => sum + qty, 0);
    if (!movedQuantity && primaryAffected && Number(data.storage?.quantity || 0) > 0) throw new Error(`Primary allocation mismatch: ${product.id}`);
    const retained = locations.filter(location => !inZone(location, zone));
    const retainedQuantity = retained.reduce((sum, location) => sum + quantity(location.quantity, product.id), 0);
    const oldUnassigned = quantity(data.ops?.relocation?.unassignedQuantity ?? 0, `${product.id}.relocation`);
    const inventory = quantity(data.inventory?.quantity, `${product.id}.inventory`);
    if (movedQuantity + retainedQuantity + oldUnassigned > inventory) throw new Error(`Insufficient inventory: ${product.id}`);
    let storage = data.storage || null;
    if (primaryAffected) {
      const best = [...retained].sort((a, b) => b.quantity - a.quantity)[0];
      storage = best ? {
        binCode: best.code, zone: best.zone || null, etage: best.etage || null,
        gang: best.gang ?? null, regal: best.regal ?? null, ebene: best.ebene || null,
        quantity: best.quantity, assigned_at: best.firstStoredAt || now,
      } : null;
    }
    const patch = {
      storage, storageBins: retained,
      'ops.relocation': {
        ...(data.ops?.relocation || {}), unassignedQuantity: oldUnassigned + movedQuantity,
        operationId, updatedAt: now, reason: 'zone_unassign',
      },
    };
    plannedProducts.push({ ...product, patch, movedQuantity, inventoryBefore: inventory, sku: data.identification?.sku || data.details?.identifiers?.sku || product.id });
    inventoryBefore += inventory;
  }
  const orphanUnits = orphans.reduce((sum, item) => sum + item.entry.quantity, 0);
  if (plannedProducts.reduce((sum, product) => sum + product.movedQuantity, 0) + orphanUnits !== units) throw new Error('Relocation totals mismatch');
  if (bins.length + plannedProducts.length * 2 + 1 > 450) throw new Error('Too many documents for a single safe transaction');
  return {
    tenantId, zone, operationId, now, bins: [...bins], products: plannedProducts, orphans,
    summary: { units, productCount: plannedProducts.length, orphanUnits, binCount: bins.length, inventoryBefore },
  };
}

async function applyUnassignmentPlan(plan, { db, saveProductV2, versionOf: getVersion = versionOf }) {
  const operationRef = db.collection('warehouseRelocations').doc(`${plan.tenantId}_${plan.operationId}`);
  return db.runTransaction(async tx => {
    const operation = await tx.get(operationRef);
    if (operation.exists) {
      const previous = operation.data();
      if (previous.tenantId !== plan.tenantId || previous.zone !== plan.zone || previous.status !== 'completed') throw new Error('Conflicting relocation operation');
      return { ...previous.summary, alreadyApplied: true };
    }
    // Historical BIN documents lack tenantId. Reuse the existing zone slice and
    // fail closed per document; a tenant filter would hide occupied legacy BINs.
    const zoneSnap = await tx.get(db.collection('warehouseBins').where('zone', '==', plan.zone));
    const expectedBinIds = new Set(plan.bins.map(bin => bin.id));
    if (zoneSnap.docs.some(doc => !expectedBinIds.has(doc.id))) throw new Error('BIN set changed since backup');
    const binSnapshots = await Promise.all(plan.bins.map(bin => tx.get(db.collection('warehouseBins').doc(bin.id))));
    const productSnapshots = await Promise.all(plan.products.map(product => tx.get(db.collection('products_v2').doc(product.id))));
    const orphanIds = [...new Set(plan.orphans.map(orphan => orphan.productId))];
    const missingSnapshots = await Promise.all(orphanIds.flatMap(id => ['products_v2', 'products'].map(collection => tx.get(db.collection(collection).doc(id)))));
    if (missingSnapshots.some(snap => snap.exists)) throw new Error('Orphan product now exists; rebuild the backup');
    for (const [rows, snapshots] of [[plan.bins, binSnapshots], [plan.products, productSnapshots]]) {
      rows.forEach((row, i) => {
        if (!snapshots[i].exists || getVersion(snapshots[i]) !== row.version) throw new Error(`Document changed since backup: ${row.id}`);
      });
    }
    // No reads after this point. All products, BINs and the recovery manifest
    // commit together, or none of them do. Inventory is never a patch key.
    for (let i = 0; i < plan.products.length; i++) {
      const product = plan.products[i];
      await saveProductV2({ id: product.id }, {
        tenantId: plan.tenantId, transaction: tx, productSnapshot: productSnapshots[i], warehousePatch: product.patch,
      });
      tx.create(db.collection('warehouseEvents').doc(`${plan.tenantId}_${plan.operationId}_${product.id}`), {
        tenantId: plan.tenantId, type: 'relocation_unassign', productId: product.id, sku: product.sku,
        delta: 0, quantity: product.movedQuantity, operationId: plan.operationId,
        createdAt: new Date(plan.now), meta: { reason: 'zone_unassign', sourceZone: plan.zone, destination: 'unassigned' },
      });
    }
    for (const snap of binSnapshots) tx.update(snap.ref, { products: [], productCount: 0, lastUpdatedAt: plan.now });
    tx.create(operationRef, {
      tenantId: plan.tenantId, zone: plan.zone, operationId: plan.operationId, status: 'completed',
      createdAt: new Date(plan.now), summary: plan.summary, orphanEntries: plan.orphans,
      products: plan.products.map(p => ({ productId: p.id, quantity: p.movedQuantity, inventoryBefore: p.inventoryBefore })),
      binCodes: plan.bins.map(bin => bin.id),
    });
    return { ...plan.summary, alreadyApplied: false };
  });
}

module.exports = { buildUnassignmentPlan, applyUnassignmentPlan, inZone, versionOf };

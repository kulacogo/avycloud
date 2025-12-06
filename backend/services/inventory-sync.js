const { callBaseLinker } = require('../lib/baselinker');
const { upsertInventories } = require('../lib/firestore');

function normalizeInventoryEntry(entry = {}) {
  const rawId = entry.inventory_id ?? entry.id ?? entry.name;
  const inventoryId = rawId ? String(rawId).trim() : null;
  if (!inventoryId) {
    return null;
  }

  const name = entry.name || inventoryId;
  let vendorCode = null;
  let fiscalYear = null;
  let sequence = null;
  const match = name.trim().match(/^([A-Z]{2,6})-(\d{2})-(\d{2,})/i);
  if (match) {
    vendorCode = match[1].toUpperCase();
    const year = Number(`20${match[2]}`);
    fiscalYear = Number.isFinite(year) ? year : null;
    const seq = Number(match[3]);
    sequence = Number.isFinite(seq) ? seq : null;
  }

  return {
    inventoryId,
    name,
    description: entry.description || '',
    type: entry.type || entry.inventory_type || null,
    defaultWarehouse: entry.default_warehouse != null ? String(entry.default_warehouse) : null,
    defaultPriceGroup:
      entry.default_price_group != null ? String(entry.default_price_group) : null,
    isActive: entry.is_active !== false,
    isExternal: Boolean(entry.external_storage || entry.is_external),
    vendorCode,
    fiscalYear,
    sequence,
    baselinker: {
      raw: entry,
    },
  };
}

async function fetchInventoriesFromBaseLinker() {
  const response = await callBaseLinker('getInventories');
  if (!response || !Array.isArray(response.inventories)) {
    return [];
  }
  return response.inventories;
}

async function syncInventoriesFromBaseLinker() {
  const apiInventories = await fetchInventoriesFromBaseLinker();
  const normalized = apiInventories
    .map(normalizeInventoryEntry)
    .filter((entry) => entry && entry.inventoryId);
  await upsertInventories(normalized);
  return {
    fetched: normalized.length,
    timestamp: new Date().toISOString(),
  };
}

module.exports = {
  syncInventoriesFromBaseLinker,
};


const fs = require('fs');
const path = require('path');

const VEHICLE_FITMENT_CATEGORIES_PATH = path.join(
  __dirname,
  '..',
  'ebay-data',
  'vehicle-fitment-categories.json'
);

let cache = null;

function loadJsonSafe(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    console.warn(`[vehicle-fitment] Failed to load ${filePath}:`, error.message);
    return null;
  }
}

function hydrate() {
  const data = loadJsonSafe(VEHICLE_FITMENT_CATEGORIES_PATH);
  const autoList = Array.isArray(data?.auto_possible_category_ids)
    ? data.auto_possible_category_ids.map((x) => String(x).trim()).filter(Boolean)
    : [];
  const motoList = Array.isArray(data?.motorcycle_possible_category_ids)
    ? data.motorcycle_possible_category_ids.map((x) => String(x).trim()).filter(Boolean)
    : [];

  cache = {
    meta: {
      generated_from: data?.generated_from || null,
      generated_at: data?.generated_at || null,
    },
    auto: new Set(autoList),
    moto: new Set(motoList),
  };
}

hydrate();

function normalizeCategoryId(categoryId) {
  if (categoryId == null) return '';
  const raw = String(categoryId).trim();
  if (!raw) return '';
  // eBay category IDs are numeric strings; keep only digits when possible.
  const digits = raw.match(/^\d+$/) ? raw : raw.replace(/\D+/g, '');
  return digits || raw;
}

/**
 * @returns {'auto'|'moto'|null}
 */
function getVehicleFitmentMode(categoryId) {
  if (!cache) hydrate();
  const id = normalizeCategoryId(categoryId);
  if (!id) return null;
  if (cache?.auto?.has(id)) return 'auto';
  if (cache?.moto?.has(id)) return 'moto';
  return null;
}

function categoryAllowsVehicleFitmentList(categoryId) {
  return Boolean(getVehicleFitmentMode(categoryId));
}

module.exports = {
  getVehicleFitmentMode,
  categoryAllowsVehicleFitmentList,
};


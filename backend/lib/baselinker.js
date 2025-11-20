// ======================================================================
// BASELINKER UNIVERSAL ENGINE (C-Version)
// Clean JS (CommonJS), 100% API compliant, Universal Product Mapper
// ======================================================================

const fetch = require("node-fetch");
const { getSecrets } = require("./secrets");

// ======================================================================
// Rate-limiter (BaseLinker = 100 RPM / 5 concurrent)
// ======================================================================
let active = 0;
const MAX = 5;
const queue = [];

async function slot() {
  while (active >= MAX) {
    await new Promise(res => queue.push(res));
  }
  active++;
}

function release() {
  active--;
  const next = queue.shift();
  if (next) next();
}

// ======================================================================
// BaseLinker API call
// ======================================================================
async function bl(method, parameters = {}) {
  const { baseApiToken } = await getSecrets();

  await slot();
  try {
    const res = await fetch("https://api.baselinker.com/connector.php", {
      method: "POST",
      headers: {
        "X-BLToken": baseApiToken,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        method,
        parameters: JSON.stringify(parameters)
      })
    });

    const data = await res.json();

    if (data.status === "ERROR") {
      throw new Error(`${data.error_code}: ${data.error_message}`);
    }

    return data;
  } finally {
    release();
  }
}

// ======================================================================
// Auto-detect Inventory Metadata (Warehouse ID + Price Group)
// ======================================================================
let cachedInventoryMeta = null;

async function getInventoryMeta() {
  if (cachedInventoryMeta) return cachedInventoryMeta;

  const data = await bl("getInventories");
  const inv = data.inventories?.[0];

  cachedInventoryMeta = {
    warehouse: inv?.default_warehouse,
    priceGroup: inv?.default_price_group
  };

  return cachedInventoryMeta;
}

// ======================================================================
// Manufacturer auto-create + cache
// ======================================================================
const manCache = new Map();

async function getOrCreateManufacturer(name, inventoryId) {
  if (!name) return null;

  const key = `${inventoryId}:${name.toLowerCase()}`;
  if (manCache.has(key)) return manCache.get(key);

  // Search existing
  const res = await bl("getInventoryManufacturers", { inventory_id: inventoryId });

  const found = res.manufacturers?.find(
    m => m.name?.toLowerCase() === name.toLowerCase()
  );

  if (found) {
    manCache.set(key, found.manufacturer_id);
    return found.manufacturer_id;
  }

  // Create new manufacturer
  const created = await bl("addInventoryManufacturer", {
    inventory_id: inventoryId,
    name
  });

  const id = created.manufacturer_id;
  manCache.set(key, id);
  return id;
}

// ======================================================================
// UNIVERSAL PRODUCT MAPPER (A-VERSION)
// Mapping offiziell BaseLinker-konform
// ======================================================================
function mapProductUniversal(product, meta, manufacturerId) {
  // ----------- NAME / TITLE -----------
  const name =
    product.identification?.name ||
    product.title ||
    product.details?.short_description ||
    product.details?.identifiers?.sku ||
    product.details?.identifiers?.ean ||
    product.id ||
    "Unnamed Product";

  // ----------- SKU -----------
  const sku =
    product.details?.identifiers?.sku ||
    product.details?.identifiers?.mpn ||
    product.details?.identifiers?.ean ||
    product.details?.identifiers?.gtin ||
    product.id;

  // ----------- EAN -----------
  const ean =
    product.details?.identifiers?.ean ||
    product.details?.identifiers?.gtin ||
    (Array.isArray(product.identification?.barcodes)
      ? product.identification.barcodes[0]
      : "");

  // ----------- PRICE -----------
  const price =
    product.details?.pricing?.lowest_price?.amount ||
    product.details?.pricing?.price ||
    0;

  // ----------- STOCK -----------
  const qty =
    product.inventory?.quantity ||
    product.storage?.quantity ||
    product.details?.attributes?.stock ||
    0;

  // ----------- FEATURES (clean map) -----------
  const features = {};

  function pushFeature(obj) {
    if (!obj) return;
    for (const [k, v] of Object.entries(obj)) {
      if (!v) continue;
      features[String(k).trim()] = String(v).trim();
    }
  }

  pushFeature(product.details?.attributes);
  pushFeature(product.details?.rawSpecs);
  pushFeature(product.details?.specifications);

  if (Array.isArray(product.details?.key_features)) {
    product.details.key_features.forEach((f, i) => {
      if (!f) return;
      features[`Feature_${i + 1}`] = String(f);
    });
  }

  // ----------- IMAGES -----------
  const imgs = {};
  const urls = (product.details?.images || [])
    .map(i => i.url_or_base64)
    .filter(u => typeof u === "string" && u.startsWith("http"))
    .slice(0, 16);

  urls.forEach((url, i) => {
    imgs[String(i)] = `url:${url}`;
  });

  // ----------- BIN / LOCATION -----------
  const bin = product.storage?.binCode ? String(product.storage.binCode) : null;

  // ------------------ FINAL PAYLOAD ------------------
  return {
    is_bundle: false,
    sku,
    ean,
    asin: "",
    ean_additional: [],
    tags: [],
    tax_rate: 19,

    manufacturer_id: manufacturerId || undefined,
    category_id: 0,

    text_fields: {
      name,
      description: product.details?.short_description || name,
      features: Object.keys(features).length > 0 ? features : undefined
    },

    stock: {
      [meta.warehouse]: qty
    },

    prices: {
      [meta.priceGroup]: price
    },

    locations: bin ? { [meta.warehouse]: bin } : undefined,

    images: Object.keys(imgs).length > 0 ? imgs : undefined,

    links: {},
    average_cost: 0,
    average_landed_cost: 0,
    suppliers: []
  };
}

// ======================================================================
// FIND EXISTING PRODUCT (by SKU)
// ======================================================================
async function findProductBySku(sku, inventoryId) {
  const res = await bl("getInventoryProductsList", {
    inventory_id: inventoryId,
    filter_sku: sku
  });

  const list = Array.isArray(res.products) ? res.products : [];
  return list.length > 0 ? list[0] : null;
}

// ======================================================================
// SYNC PRODUCT (Universal)
// ======================================================================
async function syncProduct(product) {
  const { baseInventoryId } = await getSecrets();

  // Auto-detect warehouse + price group
  const meta = await getInventoryMeta();

  // Auto-create manufacturer
  const manufacturerId = await getOrCreateManufacturer(
    product.identification?.brand,
    baseInventoryId
  );

  // Map to BaseLinker format
  const mapped = mapProductUniversal(product, meta, manufacturerId);

  // Check if product exists
  const existing = await findProductBySku(mapped.sku, baseInventoryId);

  if (existing) {
    // ----- UPDATE -----
    return await bl("updateInventoryProducts", {
      inventory_id: baseInventoryId,
      products: [
        {
          product_id: existing.product_id,
          ...mapped
        }
      ]
    });
  }

  // ----- ADD NEW -----
  return await bl("addInventoryProduct", {
    inventory_id: baseInventoryId,
    ...mapped
  });
}

// ======================================================================
// EXPORT
// ======================================================================
module.exports = {
  syncProduct
};
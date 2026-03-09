/**
 * Import/Export Service — CSV/XLSX Export and CSV Import for products.
 *
 * Export: Fetches products from Firestore, builds CSV rows.
 * Import: Accepts parsed CSV rows, validates, and saves via saveProductV2().
 */

const { getAllProductsV2, saveProductV2 } = require('../lib/product-store');

// ─── Column definitions ───────────────────────────────────────

const PRODUCT_EXPORT_COLUMNS = [
  { key: 'id', label: 'ID' },
  { key: 'name', label: 'Name' },
  { key: 'brand', label: 'Marke' },
  { key: 'category', label: 'Kategorie' },
  { key: 'sku', label: 'SKU' },
  { key: 'ean', label: 'EAN' },
  { key: 'condition', label: 'Zustand' },
  { key: 'sellPrice', label: 'Verkaufspreis' },
  { key: 'buyPrice', label: 'Einkaufspreis' },
  { key: 'description', label: 'Beschreibung' },
  { key: 'quantity', label: 'Bestand' },
  { key: 'binCode', label: 'Lagerplatz' },
  { key: 'ebayStatus', label: 'eBay Status' },
  { key: 'kauflandStatus', label: 'Kaufland Status' },
];

// ─── Export ────────────────────────────────────────────────────

function flattenProduct(product) {
  const id = product.identification || {};
  const det = product.details || {};
  const pricing = det.pricing || {};
  const bins = Array.isArray(product.storageBins) ? product.storageBins : [];
  const totalQty = bins.reduce((sum, b) => sum + (Number(b?.quantity) || 0), 0)
    || product.inventory?.availableQuantity
    || 0;
  const binCode = bins.length > 0 ? bins[0]?.code : (product.storage?.binCode || '');
  const listing = product.ops?.listingStatus || {};

  return {
    id: product.id || '',
    name: id.name || '',
    brand: id.brand || '',
    category: id.category || '',
    sku: id.sku || '',
    ean: (id.barcodes?.[0]) || (det.identifiers?.ean?.[0]) || '',
    condition: det.attributes?.condition || '',
    sellPrice: pricing.sellPrice ?? '',
    buyPrice: pricing.buyPrice ?? '',
    description: (det.short_description || '').replace(/[\n\r]+/g, ' ').slice(0, 500),
    quantity: totalQty,
    binCode: binCode || '',
    ebayStatus: listing.ebay || '',
    kauflandStatus: listing.kaufland || '',
  };
}

function escapeCsvField(value) {
  const str = String(value ?? '');
  if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes(';')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Export products to CSV string.
 * @param {Object} options
 * @param {string[]} [options.columns] - Column keys to include (default: all)
 * @param {string} [options.delimiter] - CSV delimiter (default: ';')
 * @returns {Promise<{ csv: string, count: number }>}
 */
async function exportProductsCsv({ columns, delimiter = ';' } = {}) {
  const products = await getAllProductsV2();
  const cols = columns
    ? PRODUCT_EXPORT_COLUMNS.filter((c) => columns.includes(c.key))
    : PRODUCT_EXPORT_COLUMNS;

  const headerRow = cols.map((c) => escapeCsvField(c.label)).join(delimiter);
  const dataRows = products.map((product) => {
    const flat = flattenProduct(product);
    return cols.map((c) => escapeCsvField(flat[c.key])).join(delimiter);
  });

  const csv = [headerRow, ...dataRows].join('\n');
  return { csv, count: products.length };
}

// ─── Import ────────────────────────────────────────────────────

/**
 * @typedef {Object} ColumnMapping
 * @property {string} csvColumn - Column header in CSV
 * @property {string} field - Target field: 'name', 'brand', 'sku', 'ean', etc.
 */

/**
 * Parse CSV text into rows of objects using header mapping.
 * @param {string} csvText
 * @param {string} [delimiter=';']
 * @returns {{ headers: string[], rows: Record<string, string>[] }}
 */
function parseCsv(csvText, delimiter = ';') {
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) return { headers: [], rows: [] };

  // Simple CSV parser (handles quoted fields)
  const parseLine = (line) => {
    const fields = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') {
          current += '"';
          i++;
        } else if (ch === '"') {
          inQuotes = false;
        } else {
          current += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === delimiter) {
          fields.push(current.trim());
          current = '';
        } else {
          current += ch;
        }
      }
    }
    fields.push(current.trim());
    return fields;
  };

  const headers = parseLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = parseLine(lines[i]);
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = fields[idx] || '';
    });
    rows.push(row);
  }
  return { headers, rows };
}

/**
 * Validate and preview import rows (dry-run).
 * @param {Record<string, string>[]} rows - Parsed CSV rows
 * @param {ColumnMapping[]} mapping - Column mapping
 * @returns {{ valid: Object[], errors: { row: number, message: string }[] }}
 */
function validateImportRows(rows, mapping) {
  const valid = [];
  const errors = [];
  const fieldMap = new Map(mapping.map((m) => [m.csvColumn, m.field]));

  rows.forEach((row, idx) => {
    const mapped = {};
    for (const [csvCol, field] of fieldMap) {
      mapped[field] = row[csvCol] || '';
    }

    // Name is required
    if (!mapped.name?.trim()) {
      errors.push({ row: idx + 2, message: 'Name fehlt' });
      return;
    }

    valid.push({
      rowNumber: idx + 2,
      identification: {
        method: 'csv_import',
        name: mapped.name.trim(),
        brand: mapped.brand?.trim() || '',
        category: mapped.category?.trim() || '',
        confidence: 0.5,
        sku: mapped.sku?.trim() || undefined,
        barcodes: mapped.ean?.trim() ? [mapped.ean.trim()] : [],
      },
      details: {
        short_description: mapped.description?.trim() || '',
        key_features: [],
        attributes: {
          ...(mapped.condition ? { condition: mapped.condition.trim() } : {}),
        },
        identifiers: {
          ean: mapped.ean?.trim() ? [mapped.ean.trim()] : [],
        },
        images: [],
        pricing: {
          lowest_price: { lowest: null, source: null },
          price_confidence: 0,
          ...(mapped.sellPrice ? { sellPrice: parseFloat(mapped.sellPrice) || undefined } : {}),
          ...(mapped.buyPrice ? { buyPrice: parseFloat(mapped.buyPrice) || undefined } : {}),
        },
      },
      ops: {
        sync_status: 'draft',
        revision: 0,
      },
      ...(mapped.quantity || mapped.binCode ? {
        storageBins: mapped.binCode ? [{
          code: mapped.binCode.trim(),
          quantity: parseInt(mapped.quantity, 10) || 1,
        }] : [],
      } : {}),
    });
  });

  return { valid, errors };
}

/**
 * Import products from validated rows.
 * @param {Object[]} validRows - Products from validateImportRows()
 * @param {string} tenantId
 * @returns {Promise<{ imported: number, failed: number, errors: { row: number, message: string }[] }>}
 */
async function importProducts(validRows, tenantId = 'default') {
  let imported = 0;
  let failed = 0;
  const errors = [];

  for (const row of validRows) {
    try {
      await saveProductV2({
        ...row,
        tenantId,
      }, { mode: 'system' });
      imported++;
    } catch (err) {
      failed++;
      errors.push({ row: row.rowNumber || 0, message: err.message });
    }
  }

  return { imported, failed, errors };
}

module.exports = {
  PRODUCT_EXPORT_COLUMNS,
  exportProductsCsv,
  parseCsv,
  validateImportRows,
  importProducts,
  flattenProduct,
};

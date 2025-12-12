const fs = require('fs');
const path = require('path');
const csvParse = require('csv-parse/sync');

// Load and parse CSV once per process
function loadCsv(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  return csvParse.parse(content, {
    columns: true,
    skip_empty_lines: true,
    delimiter: ',',
    bom: true, // ignore UTF-8 BOM
    relax_quotes: true, // tolerate stray quotes
  });
}

// Build lookup by full path (lowercased, trimmed)
function buildPathIndex(rows, pathColumn) {
  const index = new Map();
  rows.forEach((row) => {
    const rawPath = row[pathColumn];
    const id = row.id || row.category_id || row.CategoryId || row.categoryId;
    if (!rawPath || !id) return;
    const normalized = rawPath.toString().trim().toLowerCase();
    if (normalized) {
      index.set(normalized, id);
    }
  });
  return index;
}

// Build lookup by name (last segment), fallback if needed
function buildNameIndex(rows, pathColumn) {
  const index = new Map();
  rows.forEach((row) => {
    const rawPath = row[pathColumn];
    const id = row.id || row.category_id || row.CategoryId || row.categoryId;
    if (!rawPath || !id) return;
    const segments = rawPath.toString().split('>').map((s) => s.trim()).filter(Boolean);
    const last = segments[segments.length - 1] || '';
    const normalized = last.toLowerCase();
    if (normalized) {
      if (!index.has(normalized)) {
        index.set(normalized, id);
      }
    }
  });
  return index;
}

class MarketplaceLookup {
  constructor({ ebayCsvPath, ebayPathColumn = 'category_path', kauflandCsvPath, kauflandPathColumn = 'category_path' }) {
    this.ebayCsvPath = ebayCsvPath;
    this.kauflandCsvPath = kauflandCsvPath;
    this.ebayPathColumn = ebayPathColumn;
    this.kauflandPathColumn = kauflandPathColumn;
    this.ebayLoaded = false;
    this.kauflandLoaded = false;
  }

  ensureEbay() {
    if (this.ebayLoaded) return;
    if (!fs.existsSync(this.ebayCsvPath)) {
      throw new Error(`[marketplace-lookup] eBay CSV not found at ${this.ebayCsvPath}`);
    }
    const rows = loadCsv(this.ebayCsvPath);
    this.ebayPathIndex = buildPathIndex(rows, this.ebayPathColumn);
    this.ebayNameIndex = buildNameIndex(rows, this.ebayPathColumn);
    this.ebayLoaded = true;
  }

  ensureKaufland() {
    if (this.kauflandLoaded) return;
    if (!fs.existsSync(this.kauflandCsvPath)) {
      throw new Error(`[marketplace-lookup] Kaufland CSV not found at ${this.kauflandCsvPath}`);
    }
    const rows = loadCsv(this.kauflandCsvPath);
    this.kauflandPathIndex = buildPathIndex(rows, this.kauflandPathColumn);
    this.kauflandNameIndex = buildNameIndex(rows, this.kauflandPathColumn);
    this.kauflandLoaded = true;
  }

  lookupEbay(categoryPathOrName) {
    this.ensureEbay();
    if (!categoryPathOrName) return null;
    const normalized = categoryPathOrName.toString().trim().toLowerCase();
    return this.ebayPathIndex.get(normalized) || this.ebayNameIndex.get(normalized) || null;
  }

  lookupKaufland(categoryPathOrName) {
    this.ensureKaufland();
    if (!categoryPathOrName) return null;
    const normalized = categoryPathOrName.toString().trim().toLowerCase();
    return this.kauflandPathIndex.get(normalized) || this.kauflandNameIndex.get(normalized) || null;
  }
}

module.exports = {
  MarketplaceLookup,
};

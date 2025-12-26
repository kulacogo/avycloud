const fs = require('fs');
const path = require('path');
const csvParse = require('csv-parse/sync');
// Canonical eBay taxonomy (id -> { id, name, breadcrumb })
// NOTE: The legacy file in `backend/data/ebay-categories.json` only contains leaf names and is too ambiguous.
const EBAY_JSON = path.join(__dirname, '..', 'ebay-data', 'categories.json');
const KAUFLAND_JSON = path.join(__dirname, '..', 'data', 'kaufland-categories.json');

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

// Build lookup by name (last segment).
// IMPORTANT: Many marketplaces reuse the same leaf name for multiple paths (e.g. "Sonstige", "Elektronik & Computer").
// To avoid wrong matches, we only keep names that are UNIQUE across the taxonomy.
function buildUniqueNameIndex(rows, pathColumn) {
  const counts = new Map(); // name -> { id, count }
  rows.forEach((row) => {
    const rawPath = row[pathColumn];
    const id = row.id || row.category_id || row.CategoryId || row.categoryId;
    if (!rawPath || !id) return;
    const segments = rawPath
      .toString()
      .split('>')
      .map((s) => s.trim())
      .filter(Boolean);
    const last = segments[segments.length - 1] || '';
    const normalized = last.toLowerCase();
    if (!normalized) return;
    const prev = counts.get(normalized);
    if (!prev) {
      counts.set(normalized, { id, count: 1 });
    } else {
      prev.count += 1;
    }
  });
  const index = new Map();
  counts.forEach((meta, name) => {
    if (meta.count === 1) {
      index.set(name, meta.id);
    }
  });
  return index;
}

function buildIdSet(rows) {
  const set = new Set();
  rows.forEach((row) => {
    const id =
      row.id ||
      row.category_id ||
      row.id_category ||
      row.CategoryId ||
      row.categoryId ||
      row.Kategorienummer ||
      row.kategorienummer;
    if (id !== undefined && id !== null) {
      const trimmed = id.toString().trim();
      if (trimmed) set.add(trimmed);
    }
  });
  return set;
}

function buildPathFromColumns(row, columns = []) {
  if (!columns || !columns.length) return '';
  return columns
    .map((col) => {
      const value = row[col];
      if (value === undefined || value === null) return '';
      return value.toString().trim();
    })
    .filter(Boolean)
    .join(' > ');
}

class MarketplaceLookup {
  constructor({
    ebayCsvPath,
    ebayPathColumn = 'category_path',
    kauflandCsvPath,
    kauflandPathColumn = 'category_path',
  }) {
    this.ebayCsvPath = ebayCsvPath;
    this.kauflandCsvPath = kauflandCsvPath;
    this.ebayPathColumn = ebayPathColumn;
    this.kauflandPathColumn = kauflandPathColumn;
    this.ebayLoaded = false;
    this.kauflandLoaded = false;
    this.ebayIdSet = new Set();
    this.kauflandIdSet = new Set();
  }

  ensureEbay() {
    if (this.ebayLoaded) return;
    let rows = [];
    if (fs.existsSync(EBAY_JSON)) {
      const json = JSON.parse(fs.readFileSync(EBAY_JSON, 'utf8'));
      // `backend/ebay-data/categories.json` is an object keyed by category id.
      rows = Object.values(json || {}).map((entry) => ({
        category_id: entry?.id ?? entry?.categoryId ?? null,
        [this.ebayPathColumn]: entry?.breadcrumb || entry?.path || entry?.name || '',
      }));
    } else {
      if (!fs.existsSync(this.ebayCsvPath)) {
        const error = new Error(`[marketplace-lookup] eBay CSV not found at ${this.ebayCsvPath}`);
        error.code = 'EbayCategoryCsvMissing';
        error.filePath = this.ebayCsvPath;
        throw error;
      }
      const rawRows = loadCsv(this.ebayCsvPath);
      rows = rawRows.map((row) => {
        const next = { ...row };
        // eBay CSV uses "Kategorienummer" as ID
        const idCandidate =
          row.Kategorienummer ||
          row.kategorienummer ||
          row.category_id ||
          row.id ||
          row.CategoryId ||
          row.categoryId;
        if (idCandidate) {
          next.category_id = idCandidate.toString().trim();
        }
        if (!next[this.ebayPathColumn]) {
          next[this.ebayPathColumn] = buildPathFromColumns(row, ['L1', 'L2', 'L3', 'L4', 'L5', 'L6']);
        }
        return next;
      });
    }
    this.ebayPathIndex = buildPathIndex(rows, this.ebayPathColumn);
    this.ebayNameIndex = buildUniqueNameIndex(rows, this.ebayPathColumn);
    this.ebayIdSet = buildIdSet(rows);
    this.ebayLoaded = true;
  }

  ensureKaufland() {
    if (this.kauflandLoaded) return;
    let rows = [];
    if (fs.existsSync(KAUFLAND_JSON)) {
      const json = JSON.parse(fs.readFileSync(KAUFLAND_JSON, 'utf8'));
      rows = json.map(({ id, path: p }) => ({
        category_id: id,
        [this.kauflandPathColumn]: p,
      }));
    } else {
      if (!fs.existsSync(this.kauflandCsvPath)) {
        const error = new Error(`[marketplace-lookup] Kaufland CSV not found at ${this.kauflandCsvPath}`);
        error.code = 'KauflandCategoryCsvMissing';
        error.filePath = this.kauflandCsvPath;
        throw error;
      }
      const rawRows = loadCsv(this.kauflandCsvPath);
      rows = rawRows.map((row) => {
        const next = { ...row };
        const idCandidate =
          row.id_category ||
          row.category_id ||
          row.id ||
          row.CategoryId ||
          row.categoryId;
        if (idCandidate) {
          next.category_id = idCandidate.toString().trim();
        }
        if (!next[this.kauflandPathColumn]) {
          next[this.kauflandPathColumn] = buildPathFromColumns(row, [
            'DE_level_1_title_category',
            'DE_level_2_title_category',
            'DE_level_3_title_category',
            'DE_level_4_title_category',
            'DE_level_5_title_category',
            'DE_level_6_title_category',
            'DE_level_7_title_category',
            'DE_level_8_title_category',
            'DE_level_9_title_category',
          ]);
        }
        return next;
      });
    }
    this.kauflandPathIndex = buildPathIndex(rows, this.kauflandPathColumn);
    this.kauflandNameIndex = buildUniqueNameIndex(rows, this.kauflandPathColumn);
    this.kauflandIdSet = buildIdSet(rows);
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

  isValidEbayId(id) {
    this.ensureEbay();
    if (id === undefined || id === null) return false;
    return this.ebayIdSet.has(id.toString().trim());
  }

  isValidKauflandId(id) {
    this.ensureKaufland();
    if (id === undefined || id === null) return false;
    return this.kauflandIdSet.has(id.toString().trim());
  }
}

module.exports = {
  MarketplaceLookup,
};

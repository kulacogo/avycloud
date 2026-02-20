/**
 * Legt alle eBay-Kategorien aus der CSV im BaseLinker-Inventory an (nur Namen/Pfade, keine IDs).
 *
 * Usage:
 *   BASELINKER_INVENTORY_ID=78659 node backend/scripts/add-ebay-categories-to-inventory.js
 */
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { callBaseLinker } = require('../lib/baselinker');

const INVENTORY_ID = process.env.BASELINKER_INVENTORY_ID || '78659';
const CSV_PATH = path.join(__dirname, '..', 'ebay', 'DE_New_Structure_(May2023).csv');
const CATEGORY_COL = 'category_path';
const EXISTING_JSON = path.join(__dirname, 'output', `inventory-${INVENTORY_ID}-categories.json`);

// Cache: key = full path, value = category_id
const inventoryCategoryCache = new Map();
// Name-only map: key = name, value = first category_id with this name (for parent lookup fallback)
const nameToId = new Map();

function loadExistingFromJson() {
  if (!fs.existsSync(EXISTING_JSON)) return;
  try {
    const raw = fs.readFileSync(EXISTING_JSON, 'utf8');
    const arr = JSON.parse(raw);
    arr.forEach((c) => {
      if (c?.name && c?.category_id) {
        // We don't know full path from export, but we keep name map for fallback
        if (!nameToId.has(c.name)) nameToId.set(c.name, c.category_id);
      }
    });
    console.log(`Lokale Kategorien aus JSON: nameToId=${nameToId.size}`);
  } catch (e) {
    console.warn('Konnte lokale Kategorien nicht laden:', e.message);
  }
}

async function ensureInventoryCategoriesLoaded() {
  if (inventoryCategoryCache.size > 0 && nameToId.size > 0) return;
  try {
    const resp = await callBaseLinker('getInventoryCategories', {
      inventory_id: Number(INVENTORY_ID),
    });
    const cats = resp?.categories || [];
    cats.forEach((c) => {
      if (c?.name && c?.category_id) {
        if (!nameToId.has(c.name)) nameToId.set(c.name, c.category_id);
      }
    });
    console.log(`Cache geladen (remote): nameToId=${nameToId.size}`);
  } catch (e) {
    console.warn('Konnte bestehende Kategorien nicht laden:', e.message);
  }
}

function normalizePathSegments(pathStr) {
  return (pathStr || '')
    .split('>')
    .map((p) => p.trim())
    .filter(Boolean);
}

async function ensureInventoryCategory(pathStr) {
  if (!pathStr) return null;
  const segments = normalizePathSegments(pathStr);
  let parentId = 0;
  let currentPath = '';

  for (const seg of segments) {
    currentPath = currentPath ? `${currentPath} > ${seg}` : seg;
    if (inventoryCategoryCache.has(currentPath)) {
      parentId = inventoryCategoryCache.get(currentPath);
      continue;
    }
    // Fallback: wenn gleicher Name existiert, nutze diesen als Parent (unvollständig, aber besser als 0)
    if (nameToId.has(currentPath)) {
      parentId = nameToId.get(currentPath);
      inventoryCategoryCache.set(currentPath, parentId);
      continue;
    }
    const resp = await callBaseLinker('addInventoryCategory', {
      inventory_id: Number(INVENTORY_ID),
      name: seg,
      parent_id: parentId,
    });
    if (resp?.status !== 'SUCCESS' || !resp?.category_id) {
      console.warn(`Fehler beim Anlegen von "${currentPath}":`, resp);
      return null;
    }
    parentId = resp.category_id;
    inventoryCategoryCache.set(currentPath, parentId);
    if (!nameToId.has(currentPath)) nameToId.set(currentPath, parentId);
    console.log(`Angelegt: ${currentPath} -> ${parentId}`);
  }
  return parentId || null;
}

async function main() {
  console.log(`Inventory: ${INVENTORY_ID}`);
  if (!fs.existsSync(CSV_PATH)) {
    throw new Error(`CSV nicht gefunden: ${CSV_PATH}`);
  }
  loadExistingFromJson();
  await ensureInventoryCategoriesLoaded();

  let csvRaw = fs.readFileSync(CSV_PATH, 'utf8');
  // Remove BOM if present
  if (csvRaw.charCodeAt(0) === 0xfeff) {
    csvRaw = csvRaw.slice(1);
  }
  // Grobe Delimiter-Erkennung
  const delimiter = (csvRaw.match(/;/g) || []).length > (csvRaw.match(/,/g) || []).length ? ';' : ',';
  const records = parse(csvRaw, {
    columns: true,
    skip_empty_lines: true,
    relax_quotes: true,
    relax_column_count: true,
    bom: true,
    delimiter,
  });
  const paths = new Set();
  records.forEach((row) => {
    const p = row[CATEGORY_COL];
    if (p) paths.add(p.trim());
  });
  console.log(`CSV-Pfade: ${paths.size}`);

  for (const p of paths) {
    await ensureInventoryCategory(p);
  }
  console.log('Fertig.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

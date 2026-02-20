/**
 * Liest alle Kategorien eines BaseLinker-Inventars und speichert sie als JSON.
 *
 * Usage:
 *   BASELINKER_INVENTORY_ID=78659 node backend/scripts/export-inventory-categories.js
 */
const fs = require('fs');
const path = require('path');
const { callBaseLinker } = require('../lib/baselinker');

const INVENTORY_ID = process.env.BASELINKER_INVENTORY_ID || '78659';
const OUT_DIR = path.join(__dirname, 'output');
const OUT_FILE = path.join(OUT_DIR, `inventory-${INVENTORY_ID}-categories.json`);

async function main() {
  const resp = await callBaseLinker('getInventoryCategories', {
    inventory_id: Number(INVENTORY_ID),
  });
  const categories = resp?.categories || [];
  if (!fs.existsSync(OUT_DIR)) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
  }
  fs.writeFileSync(OUT_FILE, JSON.stringify(categories, null, 2), 'utf8');
  console.log(`Gespeichert: ${categories.length} Kategorien -> ${OUT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

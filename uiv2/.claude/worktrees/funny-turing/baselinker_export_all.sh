#!/bin/bash

# =========================
# BASELINKER API KEY
# =========================
BL_API_KEY="5015033-5060300-B3TLSK6K8F4RJXOIXSS7D6Z4KEHU2UYCFMSJAS5XG9BAZDO4UAK52TWDO99ZPLW7"

# =========================
# BASIS
# =========================
URL="https://api.baselinker.com/connector.php"

call() {
  curl -s -X POST "$URL" \
    -H "Content-Type: application/json" \
    -H "X-BLToken: $BL_API_KEY" \
    -d "$1"
}

# =========================
# CHECK
# =========================
if [[ -z "$BL_API_KEY" || "$BL_API_KEY" == "015033-5060300-B3TLSK6K8F4RJXOIXSS7D6Z4KEHU2UYCFMSJAS5XG9BAZDO4UAK52TWDO99ZPLW7" ]]; then
  echo "❌ API Key fehlt!"
  exit 1
fi

mkdir -p baselinker_export
cd baselinker_export || exit 1

# inventory_id ist fest auf "78659" gesetzt
INVENTORY_ID="78659"
echo "➡️ Verwendete inventory_id: $INVENTORY_ID"

echo "▶ Produktliste (IDs)"
call "{\"method\":\"getInventoryProductsList\",\"parameters\":{\"inventory_id\":$INVENTORY_ID}}" > 01_inventory_products_list.json

echo "▶ Produktdaten (vollständig)"
call "{\"method\":\"getInventoryProductsData\",\"parameters\":{\"inventory_id\":$INVENTORY_ID}}" > 02_inventory_products_data.json

echo "▶ Varianten"
call "{\"method\":\"getInventoryProductsVariants\",\"parameters\":{\"inventory_id\":$INVENTORY_ID}}" > 03_inventory_variants.json

echo "▶ Extra / Custom Felder"
call "{\"method\":\"getInventoryExtraFields\",\"parameters\":{\"inventory_id\":$INVENTORY_ID}}" > 04_inventory_extra_fields.json

echo "▶ BaseLinker Kategorien"
call '{"method":"getCategories"}' > 05_baselinker_categories.json

echo "▶ Lagerbestände"
call "{\"method\":\"getInventoryProductsStock\",\"parameters\":{\"inventory_id\":$INVENTORY_ID}}" > 06_inventory_stock.json

echo "▶ Preise"
call "{\"method\":\"getInventoryProductsPrices\",\"parameters\":{\"inventory_id\":$INVENTORY_ID}}" > 07_inventory_prices.json

echo
echo "✅ FERTIG – Export abgeschlossen"
ls -lh
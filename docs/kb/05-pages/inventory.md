---
title: Inventory (Bestand)
for: [user, dev, admin]
lastReviewed: 2026-05-18
---

## Zweck

Bestandsübersicht über alle Produkte mit Cross-Reference auf eBay-/Kaufland-Listings. Filterbar nach SKU, Marke, BIN-Zuordnung, Verfügbarkeit. Stellt die Daten-Grundlage für Reorder-Entscheidungen und Marketplace-Sync-Audits dar.

## Komponente(n)

- [components/InventoryView.tsx](../../../components/InventoryView.tsx) — Single-File-View, lädt initial alle Produkte über `fetchProducts` und matched gegen eBay-/Kaufland-SKU-Indizes.
- [components/InventoryDrilldownPanel.tsx](../../../components/InventoryDrilldownPanel.tsx) — Detail-Panel pro Produkt (falls vom Code geöffnet; im View über Selektion).

## API-Calls

- `fetchProducts()` — Vollabzug aller Produkte (`/api/products`).
- `fetchEbaySkuIndex()` — `/api/ebay/sku-index`, mapping SKU → eBay-ListingKey.
- `fetchKauflandSkuIndex()` — `/api/kaufland/sku-index`, mapping SKU → Kaufland-UnitId.

Pro-Endpunkt-Doku: `docs/kb/09-api/products.md`, `docs/kb/09-api/ebay.md`, `docs/kb/09-api/kaufland.md` (TBD).

## Datenquellen

- Lokaler `useState`-Cache pro View; **keine** React-Query-Integration für die Hauptliste (Stand 2026-05-18).
- `InventoryContext` ([context/InventoryContext.tsx](../../../context/InventoryContext.tsx)) — globaler Provider für aktuell-ausgewählte Inventory-Items, geteilt mit `AdminTable` und `ProductSheet`.
- Split-Logik `isInventoryItem` / `isProductBacklogItem` aus [utils/inventorySplit.ts](../../../utils/inventorySplit.ts) — entscheidet ob ein Produkt im Inventory- oder Backlog-Bucket erscheint.

## Wichtige Edge-Cases

- **Empty-State**: keine Produkte → leeres Listen-Fragment, kein dedicated Empty-State-Component im View.
- **Loading**: `Spinner` aus [components/Spinner.tsx](../../../components/Spinner.tsx) während Initial-Fetch.
- **Error**: Fehler in einer der drei API-Calls werden geloggt, aber führen nicht zu globalem Banner. Cross-Reference fällt teilweise aus (eBay-/Kaufland-Spalten leer).
- **Performance**: bei großen Tenants (>10k Produkte) ist ein Single-Shot-`fetchProducts()`-Load der Bottleneck; keine Server-Side-Pagination im View.
- **Mobile**: kein dezidierter Mobile-View; auf Mobile rendert die Tabelle horizontal scrollbar.

## Bekannte Issues

- [TASKS.md](../../../TASKS.md) — **BUG-082** ~1084 Ghost-Produkte in `products_v2` (P0, offen). Solange offen, kann die Inventory-Liste „Geister" enthalten, die in keiner anderen Collection existieren.
- **BUG-081** (✅) Reads waren historisch auf `products` statt `products_v2`; inzwischen gefixt — falls neue Inkonsistenzen auftauchen, ist die Collection-Wahl im API-Layer zu prüfen.

---
title: Schema — products_v2
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# Schema — `products_v2`

> Kanonisches Produkt-Schema. **Schreibpfad ausschliesslich** ueber `saveProductV2()` ([backend/lib/product-store.js](../../../../backend/lib/product-store.js)) — siehe CLAUDE.md §7. Normalisierung via `normalizeProduct()` ([backend/lib/product-canonical.js](../../../../backend/lib/product-canonical.js)). Initialer Doc-Aufbau aus Pipeline-V2-Records via `buildProductFromV2Record()` ([backend/lib/v2-product-builder.js](../../../../backend/lib/v2-product-builder.js)).

## DocID-Strategie

DocID wird von `pickProductId()` ([v2-product-builder.js:48](../../../../backend/lib/v2-product-builder.js)) gewaehlt, in Reihenfolge:
1. `ean` (digits-only, Slash → `_`)
2. `gtin`
3. `upc`
4. `sku`
5. Fallback: explizite ID oder `crypto.randomUUID()`

Nach Erstanlage **bleibt die DocID stabil** — Re-Normalisierung darf sie nie aendern (`product-canonical.js:95-100` Kommentar zu BUG-085). Eine "kanonisch bessere" ID wird nur als Metadatum unter `ops._canonicalId` notiert.

## Top-Level-Felder

| Feld | Typ | Pflicht | Quelle | Beschreibung |
|------|-----|---------|--------|--------------|
| `id` | string | ja | `pickProductId()` | Spiegel der DocID. |
| `tenantId` | string | partial — Backfill | `saveProduct()` setzt, ueber Code verstreut | Multi-Tenant-Scope. CLAUDE.md §8. Default-Compat: `getAllProductsV2ForTenant('default')` matcht auch Docs ohne Feld. |
| `locale` | string | ja | builder | Default `de-DE`. |
| `identification` | object | ja | builder + Identify-Pipelines | Identifikations-Stammdaten (siehe unten). |
| `details` | object | ja | builder + Identify + UI | Beschreibung, Attribute, Kategorie, Preis, Bilder (siehe unten). |
| `inventory` | object | ja | `saveProductV2`, `warehouse.refreshProductInventory()` | `{quantity, inventoryId, inventoryName}`. Source-of-truth fuer Stock. |
| `storage` | object \| null | optional | `warehouse.refreshProductInventory()` | Primaer-Bin (groesste Quantitaet). |
| `storageBins` | array | optional | `warehouse.refreshProductInventory()` | Alle Bins in denen Stock liegt. |
| `ops` | object | ja | viele | Operational-Metadaten (siehe unten). |
| `notes` | object | optional | normalize defaultet zu `{}` | Frei-Form Notizen, **TBD** — Felder im Code verifizieren. |
| `identifyCheckedAtIso` | string (ISO) | optional | Identify-V2-Sweep | Composite-Index in `firestore.indexes.json`. |
| `identifyV3CheckedAtIso` | string (ISO) | optional | Identify-V3-Sweep | Composite-Index in `firestore.indexes.json`. |

## `identification`

| Feld | Typ | Quelle | Beschreibung |
|------|-----|--------|--------------|
| `name` | string | builder, Identify | Produktname. Wird **niemals** durch Normalize auf null gesetzt (`product-canonical.js:69-71`, BUG-091). |
| `brand` | string \| null | builder, Identify | Marke. Placeholder (`unknown`, `unbekannt`, `-`) werden zu `null` normalisiert. |
| `category` | string \| null | builder, Identify | Breadcrumb oder Single-Level-Kategorie. Placeholder → `null`. |
| `method` | string | builder | `'image'` / `'barcode'` / `'unknown'` (Default nach normalize). |
| `barcodes[]` | string[] | builder | Liste der erkannten Barcodes (GTIN/EAN/UPC). Max 10. |
| `confidence` | number | builder | 0..1. `computeConfidence()` ([v2-product-builder.js:189](../../../../backend/lib/v2-product-builder.js)). |
| `sku` | string \| undefined | `normalizeSkuCandidate()` + `saveProduct()` | Strenge Form: `SKU-XXXXXXXXXX` (10 Ziffern, Zero-pad). `ensureSkuUniqueOrThrow()` haelt eine Eintrag in `sku_index`. Immutable: kein Overwrite (`firestore.js:1836-1840`). |

## `details`

### Allgemeines

| Feld | Typ | Quelle | Beschreibung |
|------|-----|--------|--------------|
| `categoryId` | string \| undefined | `normalizeProduct()` konsolidiert aus diversen Legacy-Feldern | eBay-Kategorie-ID. Quelle der Wahrheit fuer eBay-Publish. |
| `categorySource` | string | UI (`ProductSheet.tsx`), Identify | `'manual'` / `'auto:catalog'` / `'auto:suggestions'` / `'auto:local'` / `'auto:gemini'`. Bei `'manual'` blockt `enforceEbayAspects()` Auto-Overrides (CLAUDE.md §Category-Source-Protection). |
| `short_description` | string | builder, Identify-V3 Stage 3 | Marketplace-Description. |
| `key_features[]` | string[] | builder, Identify | Max 7 Bullet-Points. |
| `weight` | number | Identify Stage 2 (Weight-Web-Lookup) | Gewicht in kg. Fallback-Chain in `product-store.getProductWeightBySku()`. |

### `details.identifiers`

| Feld | Typ | Quelle | Beschreibung |
|------|-----|--------|--------------|
| `ean` | string \| undefined | builder | 8 oder 13 Ziffern (validiert via `lib/gtin.isValidGtin`). |
| `gtin` | string \| undefined | builder | 14 Ziffern. |
| `upc` | string \| undefined | builder | 12 Ziffern. |
| `sku` | string \| undefined | identisch mit `identification.sku` — dual gehalten | Strict-Format. |
| `barcode` | string \| undefined | builder | Erstes Manual-Barcode oder erster gueltiger Code. |

### `details.attributes` (Objekt, NICHT Array)

`normalizeProduct()` konvertiert Array → Object (`product-canonical.js:14-22`). Schluessel = Attribute-Name (z. B. `'Marke'`, `'Modell'`, `'Farbe'`, `'Gewicht'`), Wert = String.

- Marketplace-Keys (`ebay.*`, `ebay_*`, `kaufland.*`, `kaufland_*`) werden in `details.marketplace` verschoben — **nie** in `attributes` belassen (`product-canonical.js:43-57`).
- Weight-Aliases (`weight`, `Gewicht(kg)`, `Bruttogewicht`, `Artikelgewicht`) werden zu `'Gewicht'` konsolidiert.

### `details.marketplace`

Container fuer marketplace-spezifische Schluessel die in Attributes landen wuerden (z. B. `ebay.condition_id`, `kaufland.delivery_time`). **TBD** — vollstaendige Schluesselliste im Code verifizieren.

### `details.images[]`

Array von Image-Objekten:

| Feld | Typ | Beschreibung |
|------|-----|--------------|
| `source` | string | `'upload'`, `'identify'`, `'gemini'`, `'external'` (Stage-1-Pipeline). |
| `variant` | string | `'front'`, `'detail'`, `'angle'`, `'other'`. |
| `url_or_base64` | string | Public URL (GCS) oder Inline-Base64. |
| `notes` | string | Frei-Form. |

### `details.pricing`

| Feld | Typ | Beschreibung |
|------|-----|--------------|
| `lowest_price.amount` | number | Niedrigster Preis aus Sources (Cents oder Float — **TBD** im Code verifizieren). |
| `lowest_price.currency` | string | `'EUR'`. |
| `lowest_price.sources[]` | array | Marketplace-Quellen + Preise. **TBD** — Sub-Schema im Code verifizieren. |
| `price_confidence` | number | 0..1. |

## `inventory`

| Feld | Typ | Pflicht | Beschreibung |
|------|-----|---------|--------------|
| `quantity` | number | ja | Physische Gesamtmenge ueber alle Bins. **NUR** ueber `saveProductV2()` oder `warehouse.refreshProductInventory()` mutieren (CLAUDE.md §10). |
| `inventoryId` | string \| null | optional | Verknuepfung zu `warehouse_inventories`. |
| `inventoryName` | string \| null | optional | Cached Name. |

## `storage`

`storage` ist Snapshot des **Primaer-Bins** (groesste Quantitaet). `null` wenn kein Stock vorhanden.

| Feld | Typ |
|------|-----|
| `binCode` | string |
| `zone`, `etage`, `gang`, `regal`, `ebene` | string/number |
| `quantity` | number |
| `assigned_at` | string (ISO) |

## `storageBins[]`

Liste aller Bins mit Stock-Anteil. Aufgebaut von `warehouse.refreshProductInventory()`.

| Feld | Typ |
|------|-----|
| `code` | string (Bin-Code) |
| `quantity` | number |
| `zone`, `etage`, `gang`, `regal`, `ebene` | string/number |
| `firstStoredAt` | string (ISO) \| null |
| `lastUpdatedAt` | string (ISO) \| null |

## `ops`

Operational-Metadaten. Wird von vielen Stellen geschrieben.

### Allgemein (von Normalize/Save gesetzt)

| Feld | Typ | Quelle | Beschreibung |
|------|-----|--------|--------------|
| `_normalized` | bool | `normalizeProduct()` | true wenn durch Canonical gelaufen. |
| `_normalizedAt` | string (ISO) | `normalizeProduct()` | Zeitstempel. |
| `_schemaVersion` | number | `normalizeProduct()` | Aktuell `2`. |
| `_canonicalId` | string \| undefined | `normalizeProduct()` | Bessere Barcode-ID falls eine gefunden wurde — **NICHT** als DocID setzen. |
| `_validationErrors` | string[] | `saveProductV2()` bei Validation-Failure | Diagnose. |
| `sync_status` | string | builder Default `'pending'` | Lifecycle-State. |
| `revision` | number | builder Default `0`, `saveProduct()` inkrementiert | Konflikt-Detection. **TBD** — Increment-Pfad im Code verifizieren. |
| `pending_intake_quantity` | number | builder Default `0`, `lib/firestore.adjustPendingIntakeQuantity` | Erwartete Wareneingaenge. |
| `last_saved_source` | string | `saveProduct()` aus `options.source` | `'ui'` / `'identify'` / `'rulebook'` / `'sync'` etc. Wichtig fuer User-Edit-Protection (`firestore.js:1872-1888`). |
| `last_saved_iso` | string (ISO) | `saveProduct()` | Zeitpunkt der letzten Speicherung. UI-Saves <10 Min schuetzen vor automatisierten Overwrites. |

### Marketplace-Bindings

| Feld | Typ | Quelle | Beschreibung |
|------|-----|--------|--------------|
| `ops.ebay.itemId` | string \| null | `stock-sync-dispatcher.resolveEbayItemIdFromLiveListing()`, Publish-Pfade | Verknuepfung mit eBay-Item. `null` + `itemIdCleared` wenn Listing beendet. |
| `ops.ebay.itemIdSource` | string | dito | z. B. `'ebayListingsLive'`. |
| `ops.ebay.itemIdResolvedAt` | string (ISO) | dito | Zeitpunkt. |
| `ops.ebay.itemIdCleared` | string (ISO) \| undefined | `clearStaleItemId()` ([stock-sync-dispatcher.js:201](../../../../backend/services/stock-sync-dispatcher.js)) | Wenn Listing als ended erkannt. |
| `ops.ebay.itemIdClearReason` | string | dito | z. B. `'listing_ended'`. |
| `ops.listingStatus` | string | Publish-Pfade | **TBD** — Werte im Code verifizieren. |

### Auto-Categorize

| Feld | Typ | Beschreibung |
|------|-----|--------------|
| `ops.last_categorized_at` | string (ISO) | Recategorize-Bulk-Action. |
| `ops.last_categorized_source` | string | z. B. `'recategorize_v2'`. |

## `tenantId`

String. Aktuell partial — viele Docs haben kein Feld (Default-Tenant-Backfill steht aus). Multi-Tenant-Reads via `getAllProductsV2ForTenant()` handeln den Default-Fall: Docs ohne Feld werden als Tenant `'default'` behandelt ([product-store.js:160-171](../../../../backend/lib/product-store.js)).

## Validierung

`validateCanonical()` ([product-canonical.js:146-194](../../../../backend/lib/product-canonical.js)) prueft:

- `details.attributes` ist Object, nicht Array.
- Keine Legacy-Felder `details.ebayCategoryId` / `details.ebay_category_id`.
- Keine Marketplace-Keys in `attributes`.
- DocID ist Barcode-basiert wenn ein Barcode verfuegbar war (Warnung bei UUID/`prod-*`-IDs mit verfuegbarem Barcode).
- Keine Placeholder (`unknown`, `unbekannt`, `n/a`, …) in `identification.name|brand|category`.

Validation-Failures landen in `ops._validationErrors`, blocken aber **nicht** den Write — `saveProductV2()` logt + persistiert.

## Schreib-Side-Effects (CLAUDE.md §10)

Jede `saveProductV2()`-Mutation:
1. Liest Pre-State (`inventory.quantity`).
2. Ruft Original-`saveProduct()` (SKU-Allokation, Title-Policy, Identity-Aliases, GPSR-Merge etc.).
3. Bei `USE_PRODUCTS_V2=true` + `PRODUCTS_COLLECTION !== 'products_v2'`: Dual-Write der normalisierten Kopie.
4. Liest Post-State, ruft bei Qty-Diff `notifyStockChange()` → emit `stock:changed` + append `inventory_ledger` (siehe [schemas/stock-events.md](stock-events.md)).

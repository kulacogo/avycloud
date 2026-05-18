---
title: Product Sheet (Produkt-Detailseite)
for: [user, dev, admin]
lastReviewed: 2026-05-18
---

## Zweck

Detail-Ansicht eines einzelnen Produkts mit allen Datenfeldern (Identity, Category, Attributes, Pricing, Images, GPSR, eBay/Kaufland-Mapping, Validation, Readiness). Single-Source-Editing-UI: jede manuelle Änderung läuft über `saveProduct` → `saveProductV2` ([CLAUDE.md §7](../../../CLAUDE.md)). Bietet Re-Identify-Trigger (`improve`), Image-Generierung (Gemini), eBay-Kategorie-Picker, Chat-Assistant-Einbettung, Validation-Panel, Stock-In/Out direkt am Produkt.

## Komponente(n)

- [components/ProductSheet.tsx](../../../components/ProductSheet.tsx) — Haupt-Container, Tabs-Layout (`Tabs` / `TabPanel` aus `components/ui/Tabs.tsx`).
- [components/ImageGallery.tsx](../../../components/ImageGallery.tsx) — Bilderverwaltung.
- [components/AttributeTable.tsx](../../../components/AttributeTable.tsx) — eBay-Required-/Recommended-/Optional-Aspects.
- [components/PricingInfo.tsx](../../../components/PricingInfo.tsx) — Preis-Anzeige + Sweet-Spot-Vorschlag.
- [components/CompetitorPrices.tsx](../../../components/CompetitorPrices.tsx) + [CompetitorPriceChart.tsx](../../../components/CompetitorPriceChart.tsx) — Wettbewerber-Preise (SerpAPI/Bright Data).
- [components/GeminiChat.tsx](../../../components/GeminiChat.tsx) — Chat-Assistant embedded als `AssistantChat`. Siehe [chat.md](chat.md).
- [components/ValidationPanel.tsx](../../../components/ValidationPanel.tsx) — Quality-Gate-Validation-Anzeige.
- [components/IdentifyV4Badge.tsx](../../../components/IdentifyV4Badge.tsx) — Pipeline-Provenance-Badge (V3/V4 + Pipeline-Telemetrie).

## API-Calls

- `saveProduct(product)` — Master-Save, leitet serverseitig auf `saveProductV2` weiter.
- `fetchProductById(productId)` — Refresh nach Save oder Re-Identify.
- `stockInProduct(payload)` / `stockOutProduct(payload)` — Stock-Mutationen aus dem Sheet.
- `fetchProductBins(productId)` — Welche BINs hält das Produkt aktuell.
- `setProductInventoryId(productId, inventoryId)` — Inventory-Item-Verknüpfung.
- `generateProductImages(productId, options)` — Gemini-Image-Generation.
- `createQualityJobs(productId, jobs)` + `pollQualityJob(jobId)` — Image-Quality-Pipeline (async).
- `fetchEbayCategories(query)` — Live-Suche im eBay-Taxonomy-Cache.
- `openSkuLabelWindow(sku)` / `printSkuLabel(sku)` — SKU-Label-Druck.
- `openInventoryLabelWindow(inventoryId)` — Inventory-Label-Druck.

Über `AssistantChat` (siehe chat.md):
- `startChatStream(payload)` — SSE-Chat-Pipeline V3 (default).
- `getChatSession(productId)` / `clearChatSession(productId)` — Session-Persistenz.

Pro-Endpunkt-Doku: `docs/kb/09-api/products.md`, `docs/kb/09-api/ebay.md`, `docs/kb/09-api/chat.md` (TBD).

## Datenquellen

- `product`-Prop wird vom Parent (App.tsx) übergeben.
- `useInventoryContext()` ([context/InventoryContext.tsx](../../../context/InventoryContext.tsx)) — Inventory-Items für Mapping.
- `useAuth()` ([context/AuthContext.tsx](../../../context/AuthContext.tsx)) — User-Rollen für RBAC-Sichtbarkeit von Aktionen.
- I18n via `useI18n()`.
- DOM-Sanitization über `DOMPurify` für HTML-Felder (z. B. Description).
- GTIN-Helpers `normalizeBarcode`, `summarizeBarcodes`, `isValidGtin`, `getGtinLabel` aus [utils/gtin.ts](../../../utils/gtin.ts).
- Category-Helpers `getProductDisplayCategory`, `getProductEbayCategoryId`, `getProductEbayCategoryPath`, `deriveInitials` aus [utils/product.ts](../../../utils/product.ts).

## Wichtige Edge-Cases

- **Empty-State**: kein Produkt geladen → Spinner; bei `fetchProductById`-Error → Banner und Retry.
- **Loading**: Top-Level-Spinner während Initial-Load; Inline-Skeletons in einzelnen Tabs (Pricing, Images, Aspects).
- **Error**: Inline-Banner pro Save-/Re-Identify-Error.
- **Manual Category-Source**: bei `details.categorySource === 'manual'` blockt `enforceEbayAspects` automatische Overrides (siehe CLAUDE.md Category-Source-Protection).
- **Stock-In/Out**: läuft NIE direkt auf `inventory.quantity` — geht über `lib/warehouse.js` Backend (CLAUDE.md §13).
- **Image-Generation**: asynchron via `createQualityJobs` + `pollQualityJob`-Polling — UI muss Polling-Timeout (default ~60s) handhaben.
- **Validation**: `ValidationPanel` zeigt Quality-Gate-Result (`QUALITY_GATE_ENABLED`-Flag).
- **Tab-Persistenz**: aktiver Tab wird nicht persistiert; bei jedem Mount default-Tab.
- **Mobile**: ProductSheet hat eigenes responsives Layout; auf sehr schmalen Screens vertikal gestapelt.

## Bekannte Issues

- [TASKS.md](../../../TASKS.md) — **BUG-083** ProductSheet zeigt „keinem BIN zugeordnet" obwohl Tabelle + Warehouse BIN zeigen (✅ gefixt).
- **BUG-084** Dual-Write liest aus falscher Collection — manuelle Änderungen werden überschrieben (✅ gefixt).
- **BUG-085** Dual-Write erzeugt Duplikate durch `_pickCanonicalId` (P0, Code-Fix A+B+C implementiert, Deploy ausstehend).
- **BUG-087** Chat findet keine Web-Bilder über predefined Prompt (P1, offen) — Symptom im ProductSheet AssistantChat.
- **BUG-094** Chat-Kategorien werden nach Sekunden wieder überschrieben + veraltete eBay-Kategorien (P1, offen).
- **CLAUDE.md §7** — alle Schreibpfade über `saveProductV2()`. Nie `tx.update(productRef, ...)` direkt im UI-Pfad anstoßen.

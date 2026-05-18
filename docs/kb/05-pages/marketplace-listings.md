---
title: Marketplace Listings (eBay / Kaufland)
for: [user, dev, admin]
lastReviewed: 2026-05-18
---

## Zweck

Marktplatz-Listings-Übersicht für eBay und Kaufland in einer Komponente, gesteuert über die Prop `marketplace: "ebay" | "kaufland"`. Erlaubt: Sync der Live-Listings, Bulk-Publish (Produkte ohne Listing), Bulk-Updates (Preis/Bestand), Listing-Reparatur (eBay), Force-Stock-Resync, Status-Übergänge (live, paused, deactivated, blocked, in_review, …).

## Komponente(n)

- [components/MarketplaceListingsView.tsx](../../../components/MarketplaceListingsView.tsx) — Single-View für beide Marktplätze.

## API-Calls

eBay:
- `useEbayListings()` ([hooks/useListings.ts](../../../hooks/useListings.ts)) — React-Query-Wrapper für eBay-Listings.
- `syncEbayLiveListings(payload)` — voller Sync von eBay (Live-State pull).
- `fetchEbayStatus()` — Connection-Status (`/api/ebay/status`).
- `bulkUpdateEbayListings(updates)` — Bulk-Preis/Mengen-Update.
- `endEbayListing(listingId)` — Listing manuell beenden.
- `publishToEbay(productId, overrides)`, `bulkPublishToEbay(productIds, overrides)` — Erstpublish.
- `repairEbayListings(listingIds)` — Auto-Fix-Pipeline (siehe CLAUDE.md eBay Auto-Fix).
- `forceResyncStockBatch(listingIds)` — Stock-Drain-Worker manuell triggern (`/api/admin/stock/force-resync-batch`).

Kaufland:
- `useKauflandListings()` ([hooks/useListings.ts](../../../hooks/useListings.ts)).
- `syncKauflandListings()` — voller Listings-Sync.
- `publishToKaufland(productId, overrides)`, `bulkPublishToKaufland(productIds, overrides)`.
- `bulkUpdateKauflandUnits(updates)` — Bulk-Update der Kaufland-Units (Preis/Bestand).
- `bulkSetKauflandUnitStatus(unitIds, status)` — Status-Setzen.

Allgemein:
- `fetchProducts()` — für Mapping Listing ↔ Produkt.
- `fetchIntegrationConfig(integration)` — Settings-Snapshot.

Pro-Endpunkt-Doku: `docs/kb/09-api/ebay.md`, `docs/kb/09-api/kaufland.md` (TBD).

## Datenquellen

- React-Query via `useEbayListings()` und `useKauflandListings()` (`hooks/useListings.ts`).
- `useQueryClient` für `invalidateQueries` nach Bulk-Aktionen.
- Quantity-Helpers `getProductAvailableQuantity`, `getProductReservedQuantity` aus [utils/product.ts](../../../utils/product.ts).

## Wichtige Edge-Cases

- **Empty-State**: keine Listings → CTA für Sync oder Initial-Publish.
- **Loading**: `activeQuery.isLoading` aus React-Query; Refetch-Button (`activeQuery.refetch()`) sichtbar.
- **Error**: `activeQuery.error` als Banner.
- **Status-Vielfalt** (Kaufland insb.): `live | indexing | active | paused | deactivated | blocked | in_review | inactive`. Backend mapped Marketplace-spezifische Stati auf diese Union.
- **Bulk-Selection**: `selectedIds: Set<string>` mit Lock-State während Bulk-Aktionen.
- **Force-Resync**: nur Admin-User; triggert backend Stock-Failure-Drain-Worker.
- **Auto-Fix-Strategien** (eBay-Publish-Fehler, siehe CLAUDE.md): Kategorie-Mismatch, fehlende Aspects, Image-Konflikt (EPS), Aspect-Cap > 45 → 4 Strategien, max 2 Retries.
- **Mobile**: kein dezidierter Mobile-View.

## Bekannte Issues

- [TASKS.md](../../../TASKS.md) — **BUG-070** Marketplace Listing-Tabellen: falsche Daten + inkonsistente UI (P1, offen).
- **BUG-095** Kaufland Listings: keine Aktionen + falsche Status (✅ gefixt, Bulk-Aktionen Aktualisieren/Aktivieren/Deaktivieren implementiert).
- **BUG-068** 170 Stock-Sync Fehler (✅ teilweise gefixt: Price-Path-Fix + stale unitId clearing + Kaufland endpoint fixes).
- **CLAUDE.md §10** Oversell-Verbot: Stock-Mutationen über `saveProductV2()` + `emitSyncEvent('stock:changed', …)`. `forceResyncStockBatch` ist der **legitime** Recovery-Pfad bei `stock_operation_failures`.

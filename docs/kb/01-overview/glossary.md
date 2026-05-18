---
title: Glossar
for: [user, dev, agent, admin, manager]
lastReviewed: 2026-05-18
---

# Glossar

> Begriffe, die in der KB, in Code-Kommentaren und im UI durchgängig auftauchen. Englische Code-Bezeichner stehen in `code`-Schreibweise.

## Identifikatoren und Produkt-Daten

| Begriff | Bedeutung |
|---------|-----------|
| **SKU** | *Stock Keeping Unit* — interner Artikel-Identifier, vergeben beim Erfassen (z. B. `SKU-9871561937`). Primärschlüssel im Lager. |
| **EAN / GTIN** | *European Article Number* / *Global Trade Item Number* — internationaler Strichcode (12–14 Ziffern). EAN ist der frühere europäische Name, GTIN der heutige weltweite Begriff. Beide werden synonym verwendet und sind die Pflicht-Identifier für eBay-Listings ([CLAUDE.md](../../../CLAUDE.md) §Confidence-Thresholds: `gtin/ean/upc=0.95`). |
| **BIN** | *Bin* — physischer Lagerplatz mit Code (Bsp. `XGA0201C`). Verwaltet in [backend/lib/warehouse.js](../../../backend/lib/warehouse.js), Subcollection `products` pro BIN-Dokument. |
| **Aspect** | Marktplatz-spezifische Produkteigenschaft (z. B. `Marke`, `Farbe`, `EAN`). eBay unterscheidet zwischen *Required*-, *Recommended*- und *Optional*-Aspects. |
| **Required-Aspect** | Aspect, ohne den eBay ein Listing in einer Kategorie ablehnt. Wird von Stage 3 des Identify-V3 zwingend gefüllt (Flag `STAGE3_ASPECT_ENFORCEMENT`). |
| **EPS** | *eBay Product Suggestions* / eBay Product Catalog — eBays globaler Katalog. AvyCloud sucht via GTIN nach passenden Katalog-Einträgen, kann Bilder daraus erben (siehe `skipEbayCatalogLookup` in [CLAUDE.md](../../../CLAUDE.md) §eBay Auto-Fix). |
| **GPSR** | *General Product Safety Regulation* — EU-Pflicht seit 2024, jedes verkaufte Produkt muss verantwortlichen Hersteller / Importeur mit Adresse + Kontakt nennen. Felder: `manufacturer_name`, `manufacturer_address`, `manufacturer_phone`, `email`, `entity_country`. Quelle: [CLAUDE.md](../../../CLAUDE.md) §`IDENTIFY_V3_GPSR_CONSENSUS`. |

## Multi-Tenant und Auth

| Begriff | Bedeutung |
|---------|-----------|
| **Tenant** | Eine Mandanten-Trennung im Datenmodell. Jede neue Query MUSS `tenantId` mitführen (Punkt 8 der Nicht-Verhandelbaren in [CLAUDE.md](../../../CLAUDE.md)). |
| **`tenantId`** | String-Feld auf jedem Dokument. Default-Wert für Legacy-Daten und Single-Tenant-Setups: `'default'`. |
| **Default-Tenant** | Fallback wenn keine Tenant-Information geliefert wird. Siehe [02-architecture/adr/0006-tenant-default-policy.md](../02-architecture/adr/0006-tenant-default-policy.md). |

## OMS und Lager

| Begriff | Bedeutung |
|---------|-----------|
| **OMS** | *Order Management System* — die Order-Lifecycle-Schicht in AvyCloud. |
| **`omsStatus`** | Felder-Name auf `orders/{id}` der den Lifecycle-Status hält (z. B. `new`, `confirmed`, `picked`, `packed`, `shipped`, `cancelled`). Direkt-Writes verboten (Punkt 11 in [CLAUDE.md](../../../CLAUDE.md)). |
| **`transitionOrder()`** | Zentrale Funktion in [backend/services/order-state-machine.js](../../../backend/services/order-state-machine.js). Einziger zugelassener Pfad zum Setzen von `omsStatus`. Triggert Side-Effects (Stock, Invoice, Tracking). |
| **Pick / Pack / Ship** | Operative Schritte des Warenausgangs. `pick` = aus dem BIN nehmen, `pack` = packen, `ship` = Label kleben + an Carrier übergeben. |
| **Reservation** | Ein Eintrag in `stock_reservations`, der bei `order:created` angelegt wird. Hält Stock-Verfügbarkeit ohne `inventory.quantity` zu mutieren. Cleanup-Cron `expireStaleReservations` läuft alle 5 min ([backend/index.js](../../../backend/index.js) Z. 454ff). |
| **`stockDecrementedAt` / `stockDecrementedBy`** | Idempotency-Marker auf `orders/{id}`. Wird von `claimOrderStockDecrementInTx()` ([backend/lib/order-stock-claim.js](../../../backend/lib/order-stock-claim.js)) gesetzt. Werte für `stockDecrementedBy`: `'pick'` (Pfad A) oder `'ship'` (Pfad B). Verhindert Doppel-Decrement — siehe [docs/architecture/stock-single-source-of-truth.md](../../architecture/stock-single-source-of-truth.md). |
| **Ledger** | `inventory_ledger` Collection — append-only Audit-Log jeder Stock-Mutation. Wird von `notifyStockChange()` gefüllt. Wenn Mutation stattfand aber Ledger leer ist → Bug. |

## Marktplatz und Listings

| Begriff | Bedeutung |
|---------|-----------|
| **`marketplaceKey`** | String der den Marktplatz identifiziert (`'ebay'`, `'kaufland'`). Bestimmt Sync-Adapter. |
| **`unitId`** | Kaufland-spezifischer Listing-Identifier pro SKU + Storefront. Stale-`unitId`-Clearing siehe TASKS.md FIX-8. |
| **Outbox** | *Geplantes* Persistence-Pattern für ausgehende Sync-Events. Heute läuft das Eventing in-process (`backend/services/sync-event-bus.js`); eine Firestore-Outbox-Collection ist im Hardening-Plan vorgesehen. Siehe [02-architecture/eventing.md](../02-architecture/eventing.md). |
| **Drain-Worker** | [backend/services/stock-failure-drain.js](../../../backend/services/stock-failure-drain.js) — Cron alle 2 min, holt fehlgeschlagene Marketplace-Stock-Syncs aus `stock_operation_failures` und retried sie. Pflicht-Kette für Punkt 10 in [CLAUDE.md](../../../CLAUDE.md). |

## Daten

| Begriff | Bedeutung |
|---------|-----------|
| **Saved-Product-V2** | Output von `saveProductV2()` in [backend/lib/product-store.js](../../../backend/lib/product-store.js). Einziger zulässiger Schreibpfad in `products_v2` (Punkt 7 in [CLAUDE.md](../../../CLAUDE.md)). |
| **`products_v2`** | Aktive Produkt-Collection seit MIG-001 (Lesepfad-Migration, vgl. [02-architecture/adr/0001-products-v2.md](../02-architecture/adr/0001-products-v2.md)). Flag: `USE_PRODUCTS_V2=true` ([backend/cloudbuild.yaml](../../../backend/cloudbuild.yaml)). |

---
title: Data-Layer
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# Data-Layer

> Detail-Schemas pro Collection: [10-data/firestore-collections.md](../10-data/firestore-collections.md). Diese Seite gibt nur den Überblick + Index-Strategie.

## Datenbank: Firestore (Native Mode)

- Projekt: `avycloud` (Annahme — verifiziert über [firebase.json](../../../firebase.json) Hosting-Site).
- Native-Mode Firestore-Instanz (das Backend nutzt `@google-cloud/firestore ^7.11.0`).
- Region: nicht explizit deklariert in den geprüften Files; Cloud-Run läuft in `europe-west3`. Firestore-Region selbst → **muss verifiziert werden** (i. d. R. `eur3` multi-region).

## Aktive Collection-Map (high level)

| Collection | Inhalt | Hauptschreiber |
|------------|--------|----------------|
| `products_v2` | Produkt-Stammdaten (aktive Collection seit MIG-001) | `saveProductV2()` in [backend/lib/product-store.js](../../../backend/lib/product-store.js) |
| `products` | Legacy-Collection, dual-write während Migration | `saveProductV2()` Dual-Write-Guard |
| `orders` | Bestellungen + `omsStatus` + `stockDecrementedAt`-Marker | [backend/services/order-state-machine.js](../../../backend/services/order-state-machine.js) |
| `order_events`, `return_events` | Event-Log pro Order/Return | State-Machine + Returns-Engine |
| `shipments` | SendCloud-Parcels + Status | [backend/services/shipping-engine.js](../../../backend/services/shipping-engine.js) |
| `invoices` | SevDesk-synchronisierte Rechnungen | [backend/services/invoice-engine.js](../../../backend/services/invoice-engine.js) |
| `returns` | Marktplatz-Returns | [backend/services/returns-engine.js](../../../backend/services/returns-engine.js) |
| `warehouse_movements` | Bin-Bewegungs-Log | [backend/lib/warehouse.js](../../../backend/lib/warehouse.js) |
| `warehouseEvents` | Detail-Events Stock-In/-Out, Order-Decrement | warehouse.js |
| `inventory_ledger` | Append-only Audit aller Stock-Mutationen | `notifyStockChange()` |
| `stock_reservations` | Reservierungen pro Order × SKU | [backend/services/stock-reservation.js](../../../backend/services/stock-reservation.js) |
| `stock_operation_failures` | Fehlgeschlagene Marketplace-Stock-Syncs | [backend/services/stock-failure-drain.js](../../../backend/services/stock-failure-drain.js) (Drain) |
| `stock_sync_log` | Log Stock-Sync pro Produkt | stock-sync-dispatcher |
| `users`, `roles`, `groups` | RBAC | [backend/lib/rbac.js](../../../backend/lib/rbac.js) |
| `auditLogs` | Audit-Log (User-/Rollen-Aktionen) | `writeAuditLog()` in rbac.js |
| `api_keys` | Service-Keys pro Tenant | settings-Router |
| `llm_call_telemetry` | LLM-Call-Sampling | [docs/standards/llm-quality-parity.md](../../standards/llm-quality-parity.md) |
| `external_api_calls` | SerpAPI / BrightData / Gemini Call-Counts | [backend/lib/external-api-tracker.js](../../../backend/lib/external-api-tracker.js) |

> Vollständige Schemas + Feld-Liste pro Collection: [10-data/firestore-collections.md](../10-data/firestore-collections.md) *(Annahme — Folge-Dokument; existiert noch nicht 1-zu-1; muss verifiziert werden über `ls docs/kb/10-data/`)*.

## Feature-Flag `USE_PRODUCTS_V2`

Aus [backend/lib/firestore.js](../../../backend/lib/firestore.js) Z. 98ff:

- `USE_PRODUCTS_V2=true` (immer aktiv in Production via [backend/cloudbuild.yaml](../../../backend/cloudbuild.yaml) `--update-env-vars USE_PRODUCTS_V2=true`) → `PRODUCTS_COLLECTION = 'products_v2'`.
- Default ohne ENV: weiterhin `products_v2` (Wert wird mit `trim().toLowerCase()` ausgewertet — leere Strings fallen NICHT auf `products`, sondern auf den Default in der Code-Logik; **muss verifiziert werden**, ob Default-`true` oder Default-`false`).
- Migration-Hintergrund: [adr/0001-products-v2.md](adr/0001-products-v2.md).

## Index-Strategie (verifiziert in [firestore.indexes.json](../../../firestore.indexes.json))

Insgesamt **22 Composite-Indexes**. Grobe Kategorien:

| Pattern | Indexes |
|---------|---------|
| `tenantId ASC + createdAt DESC` | `returns`, `shipments`, `invoices`, `api_keys`, `stock_sync_log` |
| `tenantId ASC + status ASC + createdAt DESC` | `returns`, `shipments`, `invoices` |
| `tenantId ASC + <timestamp> DESC|ASC` | `products_v2` (`identifyCheckedAtIso`, `identifyV3CheckedAtIso` — beide Richtungen) |
| `orderId ASC + createdAt DESC` | `shipments` |
| `orderId ASC + timestamp DESC` | `order_events` |
| `returnId ASC + timestamp ASC` | `return_events` |
| `omsStatus ASC + updatedAt ASC` | `orders` |
| `tenantId ASC + createdAt ASC` | `stock_operation_failures` (Drain-Worker liest ältesten zuerst) |
| `productId ASC + createdAt DESC` | `stock_sync_log` |
| `tenantId ASC + type ASC + createdAt ASC` | `warehouse_movements` |
| `status ASC + expiresAt ASC` | `stock_reservations` (Cleanup-Cron) |
| `tenantId ASC + scope ASC + timestamp DESC` | `llm_call_telemetry` |

> **Operative Konsequenz:** Jede neue Query, die nach `tenantId + irgendwas` filtert, braucht ggf. einen neuen Composite-Index. Index-Build dauert je nach Datenvolumen Minuten bis Stunden — bei Schema-Erweiterungen früh anlegen.

## Schreibpfad-Disziplin

| Mutation | Einzig zulässige Funktion | Hinweis |
|----------|--------------------------|---------|
| Produkt schreiben | `saveProductV2()` ([backend/lib/product-store.js](../../../backend/lib/product-store.js)) | Punkt 7 [CLAUDE.md](../../../CLAUDE.md). Macht u. a. Dual-Write Guard und Canonical-ID-Logik. |
| `inventory.quantity` ändern | nur über [backend/lib/warehouse.js](../../../backend/lib/warehouse.js) / [backend/lib/product-store.js](../../../backend/lib/product-store.js) | Punkt 10 + 13 [CLAUDE.md](../../../CLAUDE.md). Bekannter Verstoß: `routes/marketplace.js:966` (Gap C in [TASKS.md](../../../TASKS.md)). |
| `omsStatus` ändern | nur über `transitionOrder()` in [backend/services/order-state-machine.js](../../../backend/services/order-state-machine.js) | Punkt 11. |
| `stockDecrementedAt` setzen | nur über `claimOrderStockDecrementInTx()` ([backend/lib/order-stock-claim.js](../../../backend/lib/order-stock-claim.js)) | Pfad-A / Pfad-B Mutex. |

## Backup und Recovery

Aus den geprüften Quellen *nicht* dokumentiert. **Annahme:** Cloud-Firestore-Tag-PITR ist aktiv (GCP-Standard) — **muss verifiziert werden** über GCP Console.

## Verweise

- Stock-Architektur im Detail: [docs/architecture/stock-single-source-of-truth.md](../../architecture/stock-single-source-of-truth.md).
- Eventing-Bus: [eventing.md](eventing.md).
- ADR Migration: [adr/0001-products-v2.md](adr/0001-products-v2.md).

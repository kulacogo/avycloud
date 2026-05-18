---
title: Firestore Indexes
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# Firestore Indexes

> Quelle: [firestore.indexes.json](../../../firestore.indexes.json) im Repo-Root (Stand 2026-05-18, 23 Composite-Indexes). Wird via `firebase deploy --only firestore:indexes` aus dem Repo deployed.

## Vorhandene Composite-Indexes

Single-Field-Indexes werden von Firestore automatisch fuer alle skalaren Felder angelegt — die Datei listet nur Composite-Indexes auf, die mehrere Felder kombinieren.

### Returns

| # | Collection | Felder | Genutzt von |
|---|------------|--------|-------------|
| 1 | `returns` | `tenantId ASC, createdAt DESC` | `routes/orders.js`, UI Returns-Liste |
| 2 | `returns` | `tenantId ASC, status ASC, createdAt DESC` | UI Returns-Filter (z. B. Status = `eingegangen`) |
| 3 | `return_events` | `returnId ASC, timestamp ASC` | `routes/orders.js` Return-Timeline |

### Shipments

| # | Collection | Felder | Genutzt von |
|---|------------|--------|-------------|
| 4 | `shipments` | `tenantId ASC, createdAt DESC` | `routes/orders.js:780,1862,1376`, UI Shipments-Liste |
| 5 | `shipments` | `tenantId ASC, status ASC, createdAt DESC` | UI Shipments-Filter (`status='in_zustellung'` etc.) |
| 6 | `shipments` | `orderId ASC, createdAt DESC` | Order-Detail-Page (neueste Shipments fuer eine Order) |

### Invoices

| # | Collection | Felder | Genutzt von |
|---|------------|--------|-------------|
| 7 | `invoices` | `tenantId ASC, createdAt DESC` | `routes/invoices.js:18`, UI Invoices-Liste |
| 8 | `invoices` | `tenantId ASC, status ASC, createdAt DESC` | UI Filter (`status='offen'`, `bezahlt`, `storniert`) |

### Orders

| # | Collection | Felder | Genutzt von |
|---|------------|--------|-------------|
| 9 | `orders` | `omsStatus ASC, updatedAt ASC` | Cron-Worker (delivered-Polling, stale-State-Sweeps) ohne Tenant-Filter |
| 10 | `order_events` | `orderId ASC, timestamp DESC` | `services/order-state-machine.getOrderTimeline()` |

### Auth

| # | Collection | Felder | Genutzt von |
|---|------------|--------|-------------|
| 11 | `api_keys` | `tenantId ASC, createdAt DESC` | `routes/settings.js:121`, API-Keys-UI |

### Stock-Sync + Reservations

| # | Collection | Felder | Genutzt von |
|---|------------|--------|-------------|
| 12 | `stock_sync_log` | `tenantId ASC, createdAt DESC` | UI Stock-History, `routes/orders.js:846` |
| 13 | `stock_sync_log` | `productId ASC, createdAt DESC` | Product-Detail Stock-History |
| 14 | `stock_reservations` | `tenantId ASC, status ASC` | `services/stock-reservation.listReservations()`, `routes/orders.js:852` |
| 15 | `stock_reservations` | `status ASC, expiresAt ASC` | `services/stock-reservation.expireStaleReservations()` |
| 16 | `stock_operation_failures` | `tenantId ASC, createdAt ASC` | `services/stock-failure-drain.loadPendingFailureDocs()` (Drain-Worker) |

### Warehouse

| # | Collection | Felder | Genutzt von |
|---|------------|--------|-------------|
| 17 | `warehouse_movements` | `tenantId ASC, type ASC, createdAt ASC` | Reporting / Audit |

### LLM-Telemetry

| # | Collection | Felder | Genutzt von |
|---|------------|--------|-------------|
| 18 | `llm_call_telemetry` | `tenantId ASC, scope ASC, timestamp DESC` | Per-Scope-Dashboards (Charta-Telemetrie) |

### Products V2 — Identify-Re-Check Sweeps

| # | Collection | Felder | Genutzt von |
|---|------------|--------|-------------|
| 19 | `products_v2` | `tenantId ASC, identifyCheckedAtIso DESC` | V2-Identify-Sweep "wann zuletzt geprueft" |
| 20 | `products_v2` | `tenantId ASC, identifyV3CheckedAtIso DESC` | V3-Identify-Sweep |
| 21 | `products_v2` | `tenantId ASC, identifyCheckedAtIso ASC` | Re-Check-Worker (aelteste zuerst) |
| 22 | `products_v2` | `tenantId ASC, identifyV3CheckedAtIso ASC` | V3-Re-Check-Worker |

> Zaehlung: 22 Composite-Indexes im JSON (Index 16 ist `warehouse_movements`, die Versionierung im JSON enthaelt zusaetzlich `(stock_reservations, status, expiresAt)` und die V3-Pendants — siehe Quelldatei fuer aktuellen Stand).

## Field-Overrides

Aktuell **leer** (`"fieldOverrides": []`). Es gibt keine deaktivierten/single-field-indexes-overrides — alle Default-Indexes sind aktiv.

## Bekannte fehlende Composite-Indexes (Hardening-Plan)

Die folgenden Indexes wuerden hot-Path-Queries beschleunigen oder Fallbacks vermeiden. **Quelle**: Code-Kommentare + In-Code-Fallback-Branches (Stand 2026-05-18).

| Collection | Felder | Warum noetig | Belege im Code |
|------------|--------|--------------|----------------|
| `stock_operation_failures` | `tenantId ASC, status ASC, createdAt ASC` | `loadPendingFailureDocs()` versucht primaer einen `tenantId+status+createdAt`-Filter und faellt explizit auf `tenantId+createdAt` zurueck wenn "index missing or failed precondition". Drain-Latenz steigt ohne diesen Index. | [services/stock-failure-drain.js:24-44](../../../backend/services/stock-failure-drain.js) — "Backward-compatible fallback for environments where the composite index was not created yet." |
| `orders` | `tenantId ASC, omsStatus ASC, updatedAt ASC` | Multi-Tenant-Variante des bestehenden globalen `(omsStatus, updatedAt)`-Index. Aktuell fan-out Sweep ueber alle Tenants; mit Tenant-Filter sinkt Latenz pro Worker-Iteration. | [services/shipping-engine.pollDeliveryStatus():1490](../../../backend/services/shipping-engine.js) — `where('omsStatus', '==', 'shipped').where('tenantId', '==', tenantId)` braucht den Index, sobald `tenantId !== 'default'` Mandanten in Production aktiv werden (Plan D.0c). |
| `orders` | `tenantId ASC, status ASC, createdAt DESC` | `listOrdersByStatus()` sortiert aktuell client-side `rows.sort()` — Kommentar: "Best-effort stable ordering without requiring a composite index." Bei Scale problematisch. | [lib/firestore.js:3300-3312](../../../backend/lib/firestore.js) |
| `orders` | `marketplaceOrderId ASC, marketplaceKey ASC` (oder `tenantId+marketplaceOrderId`) | Intake-Dedupe in `order-intake-*.js` scannt aktuell breit. Tenant-Scoping einer Lookup-Query auf `marketplaceOrderId` muesste indiziert sein. | Siehe Hardening-Plan & TASKS.md Gap C (Kaufland-Reconcile route). |
| `chatSessions` | `userId ASC, updatedAt DESC` | Listing aller Sessions eines Users (aktuell DocID-keyed, kein Listing-Pfad ohne Full-Scan). | [lib/chat-sessions.js](../../../backend/lib/chat-sessions.js) — kein Listing-Helper, aber UI-Feature fuer "alte Konversation wiederaufnehmen" steht im Backlog. |
| `inventory_ledger` | `tenantId ASC, productId ASC, createdAt DESC` | Audit-Tooling `scripts/deepdive-sku.js` faellt aktuell auf Per-Product-Full-Scan zurueck. Bei wachsendem Ledger-Volumen Pflicht. | [scripts/deepdive-sku.js:100](../../../backend/scripts/deepdive-sku.js) |
| `warehouseEvents` | `tenantId ASC, productId ASC, createdAt DESC` | Analog `inventory_ledger`. Wird in Repair-/Audit-Scripts genutzt. | [scripts/repair-double-decrement.js](../../../backend/scripts/repair-double-decrement.js) (CLAUDE.md §13) |
| `external_api_calls` | `tenantId ASC, service ASC, timestamp DESC` | `getExternalApiStats()` filtert per Service ohne Composite — wird seltener gerufen, aber Cost-Dashboard waechst. | [lib/external-api-tracker.getExternalApiStats():85](../../../backend/lib/external-api-tracker.js) |
| `stock_sync_failures` | `tenantId ASC, createdAt DESC` | Reporting-Pendant zu `stock_operation_failures` — wird derzeit nur geschrieben, aber UI/Dashboard-Konsumenten brauchen Sort+Filter. | [services/stock-sync-dispatcher.persistSyncFailureForDrain():38](../../../backend/services/stock-sync-dispatcher.js) |
| `kaufland_publish_runs` | `tenantId ASC, startedAt DESC` | `routes/marketplace.js:1459` macht `orderBy('startedAt', 'desc').limit(limit)` ohne Tenant-Filter — Multi-Tenant-Bereitschaft fehlt. | [routes/marketplace.js:1459](../../../backend/routes/marketplace.js) |

## Hinzufuegen eines Index

```bash
# 1) firestore.indexes.json editieren
# 2) Lokal validieren
firebase deploy --only firestore:indexes --project avycloud --dry-run
# 3) Deploy
firebase deploy --only firestore:indexes --project avycloud
# 4) Status pruefen (Build dauert min/h je nach Collection-Groesse)
firebase firestore:indexes --project avycloud
```

**Wichtig:** Index-Builds koennen Stunden dauern. Bis ein neuer Composite-Index `READY` ist, faellt die zugehoerige Query mit `FAILED_PRECONDITION`. Defensive Code-Pfade sollten einen Fallback haben (siehe `stock-failure-drain.loadPendingFailureDocs`).

## Anti-Patterns / Hinweise

- **Nie** Composite-Index ohne `tenantId` (CLAUDE.md §8). Ausnahme: globale Worker-Sweeps (`orders (omsStatus, updatedAt)` ist ein bewusster Trade-off).
- **Single-Field-DESC-Indexes** auf hochfrequente Timestamps (`createdAt`) sind automatisch — explizit deklarieren nur fuer Composites.
- **Array-Felder** koennen NICHT mit `array-contains` UND `orderBy` auf einem anderen Feld kombiniert werden. Workaround: explizite Composite-Index-Deklaration mit `arrayConfig: 'CONTAINS'` (aktuell ungenutzt im Repo).
- **DocID-Queries** (`where(FieldPath.documentId(), …)`) brauchen keine Composite-Indexes. Default-only.

---
title: Data Layer — AvyCloud Firestore
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# Data Layer

AvyCloud nutzt **Cloud Firestore** (Native Mode, Projekt `avycloud`, primär `europe-west3`) als einzige Primaer-Datenbank. Es gibt **keine relationale Datenbank**, kein Redis, keinen Message-Broker — alle persistente State liegt in Firestore. Marketplace-Caches (eBay, Kaufland, SendCloud) sind Firestore-Subset-Mirrors die ueber Sync-Jobs aktualisiert werden.

## Was darin steht

| Datei | Inhalt |
|-------|--------|
| [firestore-collections.md](firestore-collections.md) | Vollstaendiges Inventar aller Collections (Writers, Readers, Tenant-Scoping, TTL) |
| [indexes.md](indexes.md) | Erklaerung von [firestore.indexes.json](../../../firestore.indexes.json) + bekannte fehlende Composite-Indexes |
| [schemas/product-v2.md](schemas/product-v2.md) | Felder der `products_v2`-Dokumente (Identification, Details, Inventory, Ops) |
| [schemas/order.md](schemas/order.md) | Felder der `orders`-Dokumente (OMS-State, Items, Customer, Stock-Claim-Marker) |
| [schemas/shipment.md](schemas/shipment.md) | Felder der `shipments`-Dokumente (SendCloud-Parcel-Mirror) |
| [schemas/return.md](schemas/return.md) | Felder der `returns`-Dokumente (eBay + Kaufland Returns) |
| [schemas/invoice.md](schemas/invoice.md) | Felder der `invoices`-Dokumente (SevDesk-Mirror + Korrekturen) |
| [schemas/stock-events.md](schemas/stock-events.md) | Felder von `inventory_ledger` + `warehouseEvents` (Stock-Telemetrie) |
| [schemas/llm-telemetry.md](schemas/llm-telemetry.md) | Felder von `llm_call_telemetry` (Per-Call-Costs + Quality) |

## Quick Map — Wer schreibt was

```
                  ┌─────────────────────────────────────────────────┐
                  │            saveProductV2() — ZENTRAL            │
                  │      [lib/product-store.js]                      │
                  │  • dual-write products_v2 + products (legacy)    │
                  │  • emit stock:changed + append inventory_ledger  │
                  └─────────────────────────────────────────────────┘
                                       │
        ┌──────────────────────────────┼──────────────────────────────┐
        ▼                              ▼                              ▼
  products_v2                  orders                         warehouseBins
  (product master)             (OMS-State)                    (physical stock)
        │                              │                              │
        │                              ▼                              ▼
        │                       order_events                    warehouseEvents
        │                       (state transitions)             (stock_in/out)
        │                              │                              │
        ▼                              ▼                              ▼
  inventory_ledger ◄────── stock_operation_failures ──────── stock_reservations
  (append-only stock log)  (sync retry queue)               (soft-lock pre-pick)
```

## Schluesselregeln (aus CLAUDE.md)

- **Punkt 7** — Alle Produkt-Schreibpfade gehen ueber `saveProductV2()` ([backend/lib/product-store.js](../../../backend/lib/product-store.js)).
- **Punkt 8** — Alle neuen Queries und Collections **MUSS** `tenantId` haben.
- **Punkt 10** — Jede `products_v2.inventory.quantity`-Mutation **MUSS** `notifyStockChange()` emittieren (siehe [schemas/stock-events.md](schemas/stock-events.md)).
- **Punkt 11** — `orders.omsStatus` **NUR** ueber `transitionOrder()` ([backend/services/order-state-machine.js](../../../backend/services/order-state-machine.js)) aendern. Direct-Write verboten.
- **Punkt 13** — Stock Single Writer Invariant: `(stockDecrementedAt + stockDecrementedBy + stockDecrementedSkus)`-Marker auf `orders`-Doc verhindert Doppel-Decrement zwischen Pick-Pfad und Ship-Pfad.
- Additive only: keine bestehenden Firestore-Felder umbenennen oder loeschen. Neue Felder OK, alte muessen lesbar bleiben.

## Tenant-Scoping — Status (Stand 2026-05-18)

| Status | Bedeutung | Beispiele |
|--------|-----------|-----------|
| **TS** | tenantId Pflichtfeld, alle Queries `where('tenantId', '==', …)` | `orders`, `shipments`, `invoices`, `returns`, `api_keys`, `stock_sync_log`, `stock_reservations`, `stock_operation_failures`, `llm_call_telemetry` |
| **partial** | tenantId optional / wird ergaenzt | `products_v2` (Backfill laeuft, Default-Tenant-Compat-Branch in [getAllProductsV2ForTenant](../../../backend/lib/product-store.js)) |
| **none** | aktuell kein tenantId — alle Mandanten teilen sich die Doku | `warehouseBins`, `warehouseEvents`, `sku_index` |
| **N/A** | Singleton/Config, Tenant-agnostisch | `config/runtimeFlags`, `gpsrManufacturers`, `categoryProfiles`, `llmScopes` |

Inventur siehe [firestore-collections.md](firestore-collections.md).

## Lese-/Schreib-Hotspots

- `products_v2` — primaerer Product-Master, ~50 K Docs, hot Read-Path fuer alle UIs.
- `orders` — wachsende Append-Collection, Read von Dashboards (Letzte 7 Tage), Listing-Sync-Jobs.
- `warehouseEvents` + `inventory_ledger` — append-only, Read nur fuer Debug/Audit (`scripts/deepdive-sku.js`).
- `llm_call_telemetry` — append-only, Sample-Rate-gated (`LLM_TELEMETRY_SAMPLE`, default 0.1, Auto-Downgrade nach 24 h ueber 0.5).

## Backup

> **WICHTIG:** Firestore hat **keinen** automatischen "Default-Schedule". Backups und PITR
> müssen explizit aktiviert sein. Stand **verifiziert 2026-06-10** (GCP-Console-State,
> nicht im Repo/IaC versioniert — daher hier dokumentiert):

- **Scheduled Backups:** aktiv. Täglicher Schedule auf DB `(default)`
  (`backupSchedules/8844a720-1252-4937-bf01-fed0d79254e4`, angelegt 2025-12-15),
  **Retention 30 Tage** (2592000s).
  Prüfen: `gcloud firestore backups schedules list --database='(default)'`
- **Point-in-Time Recovery (PITR):** aktiv (`POINT_IN_TIME_RECOVERY_ENABLED`, 7-Tage-Fenster).
  Prüfen: `gcloud firestore databases describe --database='(default)' --format='value(pointInTimeRecoveryEnablement)'`
- **Kein App-seitiger Backup-Job** (kein Cron, kein IaC). Die Konfiguration lebt nur in der
  GCP-Console → bei Projekt-/DB-Neuanlage **manuell wieder einrichten**.
- **Restore:** `gcloud firestore backups list` → `gcloud firestore databases restore`
  (aus Backup) bzw. PITR via `--source-database` + `--snapshot-time`. Siehe
  [docs/kb/04-deployment/rollback.md](../04-deployment/rollback.md).

⚠️ Backup ist **Recovery, nicht Prävention**: ein Restore verliert alle Writes seit dem
letzten Snapshot. Destruktive Pfade trotzdem absichern (RBAC auf Delete-Endpoints,
Dry-Run-Guards in `backend/scripts/`).

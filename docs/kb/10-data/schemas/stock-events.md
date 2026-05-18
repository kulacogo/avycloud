---
title: Schema — inventory_ledger + warehouseEvents
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# Schema — Stock-Events (`inventory_ledger` + `warehouseEvents`)

> Quelle: [lib/stock-change-events.js](../../../../backend/lib/stock-change-events.js) (Ledger), [lib/warehouse.js](../../../../backend/lib/warehouse.js) (Warehouse-Events).
>
> **CLAUDE.md §10 (Oversell-Verbot) + §13 (Single-Writer-Invariant).** Diese beiden Collections sind das **Audit-Backbone** fuer alle Stock-Mutationen.

## Zwei Collections, zwei Ebenen

| Collection | Ebene | Was wird geloggt | Wann |
|------------|-------|------------------|------|
| `inventory_ledger` | **Produkt-Quantitaets-Diff** | `before`/`after`/`delta` von `products_v2.inventory.quantity` | Jede Mutation der Produkt-Quantitaet |
| `warehouseEvents` | **Physische Bin-Bewegung** | Bin × Produkt-Delta plus `quantityAfter` im Bin | Jeder `bookStockIn`/`bookStockOut` |

Beide werden append-only geschrieben; Reads erfolgen nur ueber Debug-/Audit-Pfade (`scripts/deepdive-sku.js`, Repair-Tools).

## `inventory_ledger`

### Writer

`lib/stock-change-events.notifyStockChange()` ([:74](../../../../backend/lib/stock-change-events.js)). Aufgerufen von:
- `saveProductV2()` ([lib/product-store.js:94](../../../../backend/lib/product-store.js)) bei Qty-Diff zwischen Pre- und Post-State.
- `warehouse.refreshProductInventory()` ([lib/warehouse.js:147](../../../../backend/lib/warehouse.js)) bei Qty-Diff.
- `warehouse.bookStockOut()` ([lib/warehouse.js:1152](../../../../backend/lib/warehouse.js)) am Ende der Tx (`reason: 'pick-stock-out:${orderId}'` oder `'manual-stock-out'`).

Gated by `INVENTORY_LEDGER_ENABLED !== 'false'` (default an).

### Felder

| Feld | Typ | Pflicht | Beschreibung |
|------|-----|---------|--------------|
| `tenantId` | string | ja | Default `'default'` wenn nicht setzbar. |
| `productId` | string | ja | Firestore-DocID des Produkts. |
| `sku` | string \| null | optional | Snapshot. |
| `before` | number | ja | Quantitaet **vor** der Mutation. |
| `after` | number | ja | Quantitaet **nach** der Mutation. |
| `delta` | number | ja | `after − before`. Negativ bei Stock-Out, positiv bei Stock-In/Restock. |
| `reason` | string | ja | Eine von: `'saveProductV2'` (Default), `'warehouse-refresh'`, `'pick-stock-out:<orderId>'`, `'manual-stock-out'`, `'stockChangeReason'` aus Options. |
| `source` | string | ja | Funktion die die Mutation getriggert hat: `'saveProductV2'`, `'warehouse.refreshProductInventory'`, `'warehouse.bookStockOut'`, … |
| `actor` | `{ uid, email }` \| null | optional | User der den UI-Save ausgeloest hat (von `saveProductV2` weitergereicht). |
| `createdAt` | string (ISO) | ja | Append-Zeit. |

### DocID

Auto-generierte Firestore-DocID via `.add()`. Kein deterministischer Schluessel — append-only.

### Fehlerbehandlung

`notifyStockChange()` darf **nie** den Caller-Pfad brechen — bei Firestore-Outage wird nur `console.warn` geloggt, kein Throw.

### Lese-Patterns

- `scripts/deepdive-sku.js:100` — `where('productId', '==', sku).orderBy('createdAt', 'desc').limit(...)` (fehlender Composite-Index, siehe [indexes.md](../indexes.md)).
- Aktuell **keine** UI direkt auf der Collection.

## `warehouseEvents`

### Writer

`lib/warehouse.writeWarehouseEventTx()` ([lib/warehouse.js:27-33](../../../../backend/lib/warehouse.js)) — wird inline in derselben Firestore-Tx geschrieben wie `bookStockIn`/`bookStockOut`.

### Felder (am Beispiel `bookStockOut` ([lib/warehouse.js:1093-1102](../../../../backend/lib/warehouse.js)))

| Feld | Typ | Beschreibung |
|------|-----|--------------|
| `type` | string | `'stock_in'` / `'stock_out'` (TBD — weitere Typen wie `'transfer'`/`'adjustment'` im Code verifizieren). |
| `binCode` | string | Bin-Code des betroffenen Bins (z. B. `M-EG-3-2-A`). |
| `productId` | string | DocID des Produkts. |
| `sku` | string \| null | SKU-Snapshot. |
| `delta` | number | Mengen-Aenderung im Bin. Negativ bei `stock_out`, positiv bei `stock_in`. |
| `quantityAfter` | number | Restmenge im Bin nach der Mutation. |
| `binProductCountAfter` | number | Anzahl unterschiedlicher Produkte im Bin nach der Mutation. |
| `meta` | object \| null | Caller-spezifischer Kontext. Bei Pick-Bewegungen MUSS `meta.orderId` gesetzt sein (CLAUDE.md §13 — triggert `claimOrderStockDecrementInTx()`). |
| `createdAt` | Timestamp | `Timestamp.now()` (Firestore-Server-Time). |

### Felder bei `stock_in` ([lib/warehouse.js](../../../../backend/lib/warehouse.js))

Analog `stock_out`, aber:
- `type: 'stock_in'`
- positive `delta`
- `meta` enthaelt typischerweise `{ source: 'intake' | 'restock_return' | …, inventoryId, intakeId, … }` — **TBD** vollstaendige Liste im Code verifizieren.

### Lese-Patterns

- `scripts/repair-double-decrement.js` (CLAUDE.md §13) — sucht Doppelpaare `(stock_out flow=pick) × (order_decrement)`.
- `scripts/deepdive-sku.js:169` — Per-Produkt-Audit.

### DocID

Auto-generierte Firestore-DocID via `warehouseEventsCollection.doc()`. Append-only.

## Querverbindung zwischen den Logs

Eine UI-Save-Sequenz die Stock aendert wird **beide** Logs schreiben:

```
1) UI → saveProductV2()
2) saveProduct() (Original) → setzt products_v2.inventory.quantity
3) saveProductV2() Post-Read → notifyStockChange()
4) inventory_ledger.add({ before, after, delta, reason: 'saveProductV2', source: 'saveProductV2' })
```

Eine Pick-Bewegung schreibt:

```
1) Route → bookStockOut({ binCode, sku, qty, meta: { orderId } })
2) Tx:
   - warehouseEvents.add({ type: 'stock_out', delta: -qty, meta: { orderId } })
   - claimOrderStockDecrementInTx() → orders/{orderId}.stockDecrementedAt = ...
   - products_v2/{id}.inventory.quantity := new value
3) refreshProductInventory() (post-Tx)
4) notifyStockChange() → inventory_ledger.add({ reason: 'pick-stock-out:<orderId>' })
```

Beide Eintraege sind via `productId`+`sku`+nahe `createdAt`-Timestamps korrelierbar.

## Tenant-Scoping

- `inventory_ledger.tenantId` wird IMMER geschrieben (Default `'default'`), aktuell aber **nicht** im Composite-Index. Multi-Tenant-Read braucht Index (siehe [indexes.md](../indexes.md) "Bekannte fehlende Composite-Indexes").
- `warehouseEvents` schreibt aktuell **kein** `tenantId`-Feld. Multi-Tenant-Tagging steht aus.

## Feature-Flags

| ENV | Default | Wirkung |
|-----|---------|---------|
| `INVENTORY_LEDGER_ENABLED` | true (default; `=false` deaktiviert) | Schaltet `inventory_ledger`-Append-Writes ab. |
| `STOCK_CHANGED_EMIT_ENABLED` | true (default; `=false` deaktiviert) | Schaltet `stock:changed`-Event-Bus-Emit ab. |

Beide sind **nur Telemetrie-Off-Switches** — die Stock-Mutation selbst laeuft trotzdem.

## TTL

Keine. Beide Collections wachsen append-only. Operative Bereinigung manuell (es gibt aktuell keine Auto-Expiry).

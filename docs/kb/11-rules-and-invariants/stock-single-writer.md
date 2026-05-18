---
title: Stock Single Writer Invariant
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# Stock Single Writer Invariant

> Auszug aus [CLAUDE.md](../../../CLAUDE.md) Punkte 10, 12, 13 — Lang-Doku mit Sequence-Diagrammen lebt in [docs/architecture/stock-single-source-of-truth.md](../../architecture/stock-single-source-of-truth.md).

## TL;DR

Für jede physische Einheit `(sku × order)` darf `products_v2.inventory.quantity` während des Order-Lifecycle **GENAU EINMAL** dekrementiert werden. Idempotency-Marker: `orders/{orderId}.stockDecrementedAt`.

## Zwei zulässige Pfade — mutually exclusive

### Pfad A — Pick-with-Order

- **Trigger**: Mitarbeiter pickt physisch beim Pack-Tisch und bestätigt im UI mit Order-ID.
- **Code**: [backend/lib/warehouse.js](../../../backend/lib/warehouse.js) `bookStockOut({ sku, qty, meta: { orderId, flow: 'pick' } })`.
- **Tx-Inhalt** (atomic):
  1. `products[sku].quantity -= qty` im Bin-Doc, optional Bin-Eintrag entfernen wenn 0.
  2. `products_v2/{id}.inventory.quantity` auf neue Bin-Sum.
  3. `claimOrderStockDecrementInTx({ tx, orderRef, by: 'pick', skus })` ([backend/lib/order-stock-claim.js](../../../backend/lib/order-stock-claim.js)) → setzt `stockDecrementedAt`, `stockDecrementedBy='pick'`, `stockDecrementedSkus=[...]`.
- **Nach Commit**: `notifyStockChange()` → `inventory_ledger` + Marketplace-Sync via `sync-event-bus`.

### Pfad B — Ship-Decrement

- **Trigger**: State-Machine `transitionOrder('shipped')` ([backend/services/order-state-machine.js](../../../backend/services/order-state-machine.js)).
- **Sequenz**:
  1. Atomic-Tx-Claim: existiert `stockDecrementedAt`?
     - Ja (z. B. Pfad A) → `alreadyDecremented = true` → Phase A skip, nur Phase B (Marketplace-Resync).
     - Nein → `claimOrderStockDecrementInTx({ by: 'ship' })`, dann Phase A.
  2. Phase A: `decrementProductByIdOrSku(sku, qty)` → FIFO über `storageBins[]` + `inventory.quantity`.
  3. Nach Commit: `notifyStockChange()` → Ledger + Phase B (`syncStockWithRetry`).

## Mutations-Domänen (Abgrenzung)

| # | Domäne | Trigger | Mutiert `inventory.quantity`? |
|---|--------|---------|-------------------------------|
| 1 | WMS / Operativ | UI-Aktion (Stow, Pick, Bin-Move, manuelle Korrektur) | Nur wenn keine Order-Referenz. Mit Order-Referenz → Pfad A. |
| 2 | Order-Lifecycle | State-Machine `transitionOrder('shipped'\|'cancelled')` | Ja, via Pfad B (siehe oben). |
| 3 | Marketplace-Reconciliation | Manueller Drift-Fix / Sync-Reconcile | **Niemals direkt** — muss über Pfad A oder B routen. |

## Verbotene Pfade

| # | Pfad | File:Line | Warum verboten |
|---|------|-----------|----------------|
| F1 | Direkter `inventory.quantity`-Write außerhalb [backend/lib/warehouse.js](../../../backend/lib/warehouse.js) / [backend/lib/product-store.js](../../../backend/lib/product-store.js) | `backend/routes/marketplace.js:966` (Gap C in [TASKS.md](../../../TASKS.md)) | Umgeht Marker, Lock, Telemetrie. |
| F2 | `bookStockOut` mit `meta.orderId` ohne Claim | (durch Code-Fix verhindert) | Doppel-Decrement durch State-Machine garantiert. |
| F3 | `decrementProductByIdOrSku` aufrufen ohne State-Machine-Claim | (nur via `_onOrderShipped`) | Idempotency wird umgangen. |
| F4 | Stock-Mutation ohne `notifyStockChange()` | u. a. `returns-engine.js restockItem` (Gap D) | `inventory_ledger` bleibt blind. |
| F5 | Manuelle Korrektur via `set({ merge: true })` aus Scripts ohne `--allowWarehouseFields`-Guard | siehe `lib/firestore.js:2387` | Kein Audit-Trail. |

## Telemetrie-Garantien

| Mutation | `warehouseEvents` | `inventory_ledger` |
|----------|-------------------|-------------------|
| `bookStockIn` | `{type:'stock_in'}` | `{reason:'stock-in'}` |
| `bookStockOut` (manuell) | `{type:'stock_out'}` | `{reason:'manual-stock-out'}` |
| `bookStockOut` (Pfad A) | `{type:'stock_out', meta.orderId}` + `orders.stockDecrementedAt` | `{reason:'pick-stock-out:<orderId>'}` |
| `decrementProductByIdOrSku` (Pfad B) | `{type:'order_decrement'}` | `{reason:'ship-decrement:<orderId>'}` |
| `assignProductToBin` / `removeProductFromBin` / `transferStock` | `{type:'bin_*'}` | `{reason:'bin-*'}` — **Gap A offen**. |

Wenn `inventory_ledger` bei einer Mutation leer bleibt: **Bug-Indikator**.

## Tests die diese Invarianten schützen

- `backend/__tests__/stock-pick-then-ship-no-double-decrement.test.js` — Pfad A → Pfad B Idempotenz.
- `backend/__tests__/stock-shipped-idempotency.test.js` — Pfad B Doppel-Aufruf-Idempotenz.
- `backend/__tests__/stock-failure-drain.test.js` — Drain-Worker.
- `backend/__tests__/stock-change-events.test.js` — `notifyStockChange`.
- `backend/__tests__/oversell-invariant.test.js` — statischer Code-Guard.

## Reparatur

```bash
# Read-only Audit
node backend/scripts/repair-double-decrement.js

# Apply (Operator-Freigabe + Bin-Verifikation Pflicht)
node backend/scripts/repair-double-decrement.js \
  --apply --confirm REPAIR_2026_04_29 --skus SKU-0000108900,SKU-0000041030
```

Quelle: [backend/scripts/repair-double-decrement.js](../../../backend/scripts/repair-double-decrement.js).

## Bekannte Folge-Gaps (separate Tickets)

| Gap | Beschreibung | Quelle |
|-----|--------------|--------|
| **A** | `refreshProductInventory` Diff-Check im Hot-Path strukturell broken → `inventory_ledger` bleibt leer ausser bei Drift. | [TASKS.md](../../../TASKS.md) |
| **C** | `backend/routes/marketplace.js:966` schreibt `inventory.quantity` direkt via `batch.update()` (Kaufland-Reconcile). | [TASKS.md](../../../TASKS.md) |
| **D** | `backend/services/returns-engine.js restockItem` mutiert `inventory.quantity` nicht und ruft nicht `bookStockIn`. | [TASKS.md](../../../TASKS.md) |
| **E** | `backend/lib/stock-lock.js` ist 100 % in-memory trotz Punkt 12. | [TASKS.md](../../../TASKS.md) |
| **F** | `_onOrderCancelled` nicht symmetrisch zu `_onOrderShipped` (kein Re-Increment + Failure-Persistierung). | [TASKS.md](../../../TASKS.md) |

## Querverweise

- ADR: [02-architecture/adr/0002-stock-single-writer.md](../02-architecture/adr/0002-stock-single-writer.md).
- Architektur-Detail: [docs/architecture/stock-single-source-of-truth.md](../../architecture/stock-single-source-of-truth.md).
- Eventing: [02-architecture/eventing.md](../02-architecture/eventing.md).

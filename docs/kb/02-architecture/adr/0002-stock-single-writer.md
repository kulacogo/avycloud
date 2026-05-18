---
title: ADR-0002 — Stock Single Writer Invariant
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# ADR-0002 — Stock Single Writer Invariant

## Status

**Accepted** seit 2026-04-29 nach Incident SKU-0000108900 + SKU-0000041030. Codified in [CLAUDE.md](../../../../CLAUDE.md) Punkt 13.

## Kontext

Es existierten zwei orthogonale Decrement-Pfade ohne gemeinsamen Idempotency-Mechanismus:

| Pfad | Trigger | Mutation |
|------|---------|----------|
| A — **Pick-with-Order** | Mitarbeiter klickt im Pick-UI „Stock-Out" mit Order-Bezug | `bookStockOut(meta.orderId, …)` → `inventory.quantity -= qty` |
| B — **Ship-Decrement** | State-Machine `transitionOrder('shipped')` | `decrementProductByIdOrSku(sku, qty)` → `inventory.quantity -= qty` |

Beide Pfade wurden in derselben Order-Sequenz ausgelöst → **doppelter Decrement**. Konsequenz im Incident: `inventory.quantity = 2 → 1 → 0`, Sync pusht `available = 0` an eBay, Listing wird beendet, physisch ist aber noch 1 Stück da.

## Entscheidung

1. **Genau ein Decrement pro `(sku × order)`** während des Order-Lifecycle.
2. **Idempotency-Marker auf `orders/{orderId}`**:
   ```
   stockDecrementedAt: ISO_STRING
   stockDecrementedBy: 'pick' | 'ship'
   stockDecrementedSkus: string[]
   ```
3. **Zentrale Claim-Funktion** [backend/lib/order-stock-claim.js](../../../../backend/lib/order-stock-claim.js) `claimOrderStockDecrementInTx({ tx, orderRef, by, skus })`. Setzt den Marker in **derselben** Firestore-Tx wie die Bin-Mutation.
4. **Pfad A** (`lib/warehouse.js bookStockOut` mit `meta.orderId`) ruft `claimOrderStockDecrementInTx({ by: 'pick' })`.
5. **Pfad B** (`services/order-state-machine.js _onOrderShipped`) prüft Marker per Atomic-Tx-Claim; wenn `stockDecrementedAt` schon gesetzt → `alreadyDecremented = true` → Phase A (Bin-Mutation) skip, nur Phase B (Marketplace-Resync).
6. **`notifyStockChange()` Pflicht** nach jeder Mutation → Append in `inventory_ledger`.

## Konsequenzen

| Positiv | Negativ |
|---------|---------|
| Doppel-Decrement strukturell unmöglich (Tx-atomar). | Pfad-A-Pfad-B-Reihenfolge ist nicht mehr egal — Reviewer-Aufgabe bei jedem neuen Stock-Writer. |
| Telemetrie (Ledger) ist Single-Source-of-Truth für Stock-Bewegung. | Bei Tx-Konflikt (Race zwischen Pick und Ship) gewinnt der Erste — der Zweite läuft No-Op. Operations-Verständnis nötig. |
| Wiederherstellbar (Repair-Script). | Bestehende Verstöße müssen separat behoben werden (Gap-Liste). |

## Verbotene Pfade

| # | Pfad | Warum |
|---|------|-------|
| F1 | `tx.update(productRef, { 'inventory.quantity': X })` außerhalb [backend/lib/warehouse.js](../../../../backend/lib/warehouse.js) / [backend/lib/product-store.js](../../../../backend/lib/product-store.js) | Umgeht Marker + Telemetrie. Bekannter Sünder: `backend/routes/marketplace.js:966` (Gap C in [TASKS.md](../../../../TASKS.md)). |
| F2 | `bookStockOut(meta.orderId)` ohne `claimOrderStockDecrementInTx()` | Doppel-Decrement durch State-Machine garantiert. |
| F3 | Stock-Mutation ohne `notifyStockChange()` | `inventory_ledger` bleibt leer → blinde Telemetrie. |

## Repair- und Test-Pfad

- **Read-only Audit**: `node backend/scripts/repair-double-decrement.js` ([backend/scripts/repair-double-decrement.js](../../../../backend/scripts/repair-double-decrement.js)).
- **Apply**: gleicher Aufruf mit `--apply --confirm REPAIR_2026_04_29 --skus <list>`.
- **Regression-Test**: [backend/__tests__/stock-pick-then-ship-no-double-decrement.test.js](../../../../backend/__tests__/stock-pick-then-ship-no-double-decrement.test.js).
- **Idempotenz-Test Pfad B**: `backend/__tests__/stock-shipped-idempotency.test.js`.
- **Statischer Code-Guard**: `backend/__tests__/oversell-invariant.test.js`.

## Quelle und Detail-Doku

Lange Sequenz-Diagramme + Telemetrie-Garantien: [docs/architecture/stock-single-source-of-truth.md](../../../architecture/stock-single-source-of-truth.md).

## Bekannte Folge-Gaps

Aus [TASKS.md](../../../../TASKS.md) (gleichnamiger Block):

- **Gap A** `refreshProductInventory`-Diff-Check post-Tx broken (Ledger bleibt im Hot-Path leer).
- **Gap C** `routes/marketplace.js:966` Direct-Write (Kaufland-Reconcile).
- **Gap D** `returns-engine.js restockItem` mutiert `inventory.quantity` nicht.
- **Gap E** `lib/stock-lock.js` ist 100 % in-memory trotz Punkt 12.
- **Gap F** `_onOrderCancelled` ist nicht symmetrisch zu `_onOrderShipped` (kein Re-Increment).

## Querverweise

- Rule-Doc: [../../11-rules-and-invariants/stock-single-writer.md](../../11-rules-and-invariants/stock-single-writer.md).
- CLAUDE-Punkte 10–13: [CLAUDE.md](../../../../CLAUDE.md).

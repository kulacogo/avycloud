---
title: Schema — returns
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# Schema — `returns`

> Quelle: [services/returns-engine.js](../../../../backend/services/returns-engine.js). Mirror der Marketplace-Returns (eBay Sell-Fulfillment-API + Kaufland `/returns`) mit interner Workflow-Engine und Refund-/Restock-Steuerung.

## DocID-Strategie

**Deterministisch** zur Race-Sicherheit:
- eBay: `ebay__${marketplaceReturnId}` (= `order.orderId` aus Fulfillment-API).
- Kaufland: `kaufland__${marketplaceReturnId}` (= `kr.id_return`).

Verhindert Duplikate bei parallelem Sync.

## Identitaet + Marketplace-Verknuepfung

| Feld | Typ | Pflicht | Beschreibung |
|------|-----|---------|--------------|
| `tenantId` | string | ja | CLAUDE.md §8. |
| `marketplace` | `'ebay'` \| `'kaufland'` | ja | Marketplace-Quelle. |
| `marketplaceReturnId` | string | ja | Original-Return-ID vom Marketplace. |
| `marketplaceOrderId` | string \| null | optional | Verknuepfung zur Original-Order auf dem Marketplace. |
| `orderId` | string \| null | optional | Firestore-DocID des `orders`-Docs (auf-aufgeloest via `marketplaceOrderId`-Lookup). |
| `orderAmount` | number \| undefined | optional | Aus `orders.totalAmount`, dient als Defaulting fuer Full-Refunds. |
| `orderUnitId` | string \| null | Kaufland-only | `id_order_unit` aus Kaufland-API. |
| `returnUnitId` | string \| null | Kaufland-only | `id_return_unit`. |

## Customer

| Feld | Typ | Beschreibung |
|------|-----|--------------|
| `customer.name` | string \| null | Echter Name aus Shipping-Address (NICHT eBay-Username — siehe `syncEbayReturns()`-Fix-Path Z. 425-428). |
| `customer.email` | string \| null | `validateEmail()`-geprueft. |

## Product

| Feld | Typ | Beschreibung |
|------|-----|--------------|
| `product.name` | string \| null | Artikel-Bezeichnung. |
| `product.sku` | string \| null | SKU fuer Restock-Lookup. |
| `product.quantity` | number | Default `1`. |
| `product.ean` | string \| null | Kaufland-only (aus `ouProduct.eans[0]`). |
| `product.price` | number \| null | Kaufland-only (aus `orderUnitDetail.price / 100`). |

## Reason

| Feld | Typ | Beschreibung |
|------|-----|--------------|
| `reason` | enum string | Eine von: `defekt`, `falsche_lieferung`, `nicht_wie_beschrieben`, `zu_spaet`, `meinungsaenderung`, `doppelbestellung`, `sonstiges` (Liste: `RETURN_REASONS` in [returns-engine.js:44-52](../../../../backend/services/returns-engine.js)). |
| `reasonRaw` | string | Original-Marketplace-Code (z. B. `ARRIVED_DAMAGED`, `wrong_product_delivered`). Aus `EBAY_REASON_MAP` / `KAUFLAND_REASON_MAP` zu `reason` gemappt. Unbekannte → `'sonstiges'` mit Warn-Log. |
| `reasonText` | string \| null | Frei-Form Erklaerung vom Kaeufer (`cancelReason` bei eBay, `firstUnit.note` oder `kr.reason_comment` bei Kaufland). |

## Refund

| Feld | Typ | Beschreibung |
|------|-----|--------------|
| `refundAmount` | number | Brutto-Refund-Betrag. |
| `refundType` | `'full'` \| `'partial'` \| `'none'` | Wird beim `processReturn()`-Workflow gesetzt. |
| `currency` | string | `'EUR'`. |

## Workflow-Status (interne State-Machine)

| Feld | Typ | Beschreibung |
|------|-----|--------------|
| `status` | string | Eine von: `eingegangen`, `in_pruefung`, `erstattet`, `teilweise_erstattet`, `abgelehnt`, `abgeschlossen`. Liste: `RETURN_STATUSES` ([returns-engine.js:24-31](../../../../backend/services/returns-engine.js)). |
| `marketplaceStatus` | string \| null | Status vom Marketplace (`'CANCELED'` / `'REFUNDED'` bei eBay; Kaufland-Stati direkt). |
| `itemCondition` | `'a_ware'` \| `'b_ware'` \| `'c_ware'` \| undefined | Warenpruefungs-Ergebnis (manuell gesetzt). Treibt Restock-Entscheidung. |
| `restock` | bool \| undefined | true bei `a_ware`/`b_ware`, false bei `c_ware`. Auto-gesetzt von `transitionReturn()`. |
| `trackingCode` | string \| null | Kaufland-only. |
| `trackingProvider` | string \| null | Kaufland-only. |

### Erlaubte Transitionen

```
eingegangen        → in_pruefung | erstattet | abgelehnt
in_pruefung        → erstattet | teilweise_erstattet | abgelehnt
erstattet          → abgeschlossen
teilweise_erstattet→ abgeschlossen
abgelehnt          → abgeschlossen | in_pruefung   (Re-Open)
abgeschlossen      → []  (Terminal)
```

Quelle: `VALID_TRANSITIONS` ([returns-engine.js:33-40](../../../../backend/services/returns-engine.js)).

## Timestamps

| Feld | Typ | Beschreibung |
|------|-----|--------------|
| `createdAt` | string (ISO) | Original-Marketplace-Created-Date oder Now. |
| `syncedAt` | string (ISO) | Letzter Sync-Tick. |
| `updatedAt` | string (ISO) | Letzter Workflow-Write. |

## Composite-Indexes

- `(tenantId, createdAt desc)` — UI Returns-Liste.
- `(tenantId, status, createdAt desc)` — Status-Filter.

## Sub-Events: `return_events`

Jeder `transitionReturn()`-Call schreibt einen Event-Doc:

```
{
  returnId: string,
  fromStatus: string,
  toStatus: string,
  actor: { uid, email },
  note: string,
  itemCondition: string | null,
  refundAmount: number | null,
  timestamp: ISO-String,
}
```

Composite-Index `(returnId, timestamp asc)` fuer chronologische Timeline.

## Side-Effects

1. **Restock** (`processReturn()` → `restockItem()` ([returns-engine.js:284](../../../../backend/services/returns-engine.js))): schreibt `warehouse_movements`-Doc mit `type: 'restock_return'`. Inventory-Rebuild ist Aufgabe nachgelagerter Logik. **TBD** — verifizieren ob `notifyStockChange()` getriggert wird.
2. **Korrektur-Invoice** (`processReturn()` mit `refundType !== 'none'`): triggert `setImmediate(createCorrectionInvoice({ type: 'gutschrift' | 'storno' }))` → schreibt neuen Doc in `invoices` (gleiche Collection, `type`-Feld unterscheidet) und markiert Original-Invoice als `correctionId`+`status: 'storniert' | 'teilkorrigiert'`.
3. **Marketplace-Refund** (`issueMarketplaceRefund()`): Push-API-Call zum Marketplace (eBay Post-Order / Kaufland), Ergebnis wird in `marketplaceStatus` zurueckgespiegelt.

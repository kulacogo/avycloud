---
title: Schema — orders
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# Schema — `orders`

> Quelle: [services/order-intake-ebay.js](../../../../backend/services/order-intake-ebay.js), [services/order-intake-kaufland.js](../../../../backend/services/order-intake-kaufland.js), [services/order-state-machine.js](../../../../backend/services/order-state-machine.js), [lib/firestore.js](../../../../backend/lib/firestore.js).
>
> **State-Engine:** `orders.omsStatus` darf **ausschliesslich** ueber `transitionOrder()` ([order-state-machine.js:105](../../../../backend/services/order-state-machine.js)) aktualisiert werden — CLAUDE.md §11.
>
> **Stock-Single-Writer-Invariant (§13):** Die Felder `stockDecrementedAt`/`stockDecrementedBy`/`stockDecrementedSkus` markieren ob der Stock-Decrement bereits durch Pick-Pfad (`bookStockOut(meta.orderId)`) oder Ship-Pfad (`_onOrderShipped`) erfolgte. Pflicht-Marker fuer Doppel-Decrement-Schutz.

## DocID-Strategie

`marketplaceKey = ${order.source}__${order.marketplaceOrderId}` (z. B. `ebay__01-12345-67890`, `kaufland__MXB5KD5`). Wird in [order-intake-ebay.js:354+528](../../../../backend/services/order-intake-ebay.js) als idempotenter DocID benutzt. Race-sicher: parallele Intakes treffen denselben Doc.

## Identitaet + Marketplace-Verknuepfung

| Feld | Typ | Pflicht | Beschreibung |
|------|-----|---------|--------------|
| `tenantId` | string | ja | CLAUDE.md §8. |
| `orderId` | string | ja | AvyCloud-internes Auftragsnummer-Format (z. B. `AVY-2026-00012`). Generiert via `services/number-sequence.getNextNumber({type:'order'})`. |
| `marketplaceKey` | string | ja | DocID-Spiegel (`source__marketplaceOrderId`). |
| `marketplaceOrderId` | string \| null | ja (sobald moeglich) | Original-ID vom Marketplace (eBay OrderID, Kaufland id_order). |
| `externalOrderId` | string \| null | optional | Synonym zu `marketplaceOrderId`, redundant fuer Compat. |
| `source` | string | ja | `'ebay'` / `'kaufland'` / `'baselinker'` (legacy, BaseLinker ist TABU — keine Neu-Writes). |
| `marketplace` | string | ja | Spiegel von `source` (UI-Kompat). |
| `number` | string \| undefined | legacy | Alter Auftragsnummer-Feld vor `orderId`. **TBD** — pruefen welche Stelle noch schreibt. |

## OMS-State

| Feld | Typ | Pflicht | Beschreibung |
|------|-----|---------|--------------|
| `omsStatus` | string | ja | Einer von: `pending`, `confirmed`, `picking`, `picked`, `packing`, `packed`, `shipped`, `delivered`, `completed`, `cancelled`, `returned`, `on_hold`. Vollstaendige State-Map: [order-state-machine.js:26-39](../../../../backend/services/order-state-machine.js). |
| `omsStatusLabel` | string | ja | German label (`'Neu'`, `'Kommissionierung'`, …). |
| `status` | string | ja | **Legacy-Spiegel** von `omsStatus`. Wird auch von Intake-Services parallel gesetzt. Lesepfade nutzen Fallback `order.omsStatus || order.status || 'pending'`. |
| `statusLabel` | string | optional | Legacy-Spiegel von `omsStatusLabel`. |
| `statusId` | string \| undefined | legacy | Alter BaseLinker-Status-ID. Fallback fuer `getOrderSummary()` ([firestore.js:3352](../../../../backend/lib/firestore.js)). |
| `ebayStatus` / `kauflandStatus` | string \| undefined | optional | Original-Status vom Marketplace. **TBD** — vollstaendige Werte im Code verifizieren. |

### Timestamps (von `transitionOrder()` gesetzt)

| Feld | Wird gesetzt bei | Beschreibung |
|------|------------------|--------------|
| `createdAt` | Intake | ISO oder Marketplace-Created-Date. |
| `paidAt` | Intake | Aus Marketplace. |
| `pickedAt` | Transition → `picking` ODER `picked` (siehe `tsMap` in `transitionOrder` Z. 147) | Letzter Pick-Zeitpunkt. |
| `packedAt` | Transition → `packed` | |
| `shippedAt` | Transition → `shipped` | |
| `deliveredAt` | Transition → `delivered`, auch von `pollDeliveryStatus()` und Shipment-Sync gesetzt | |
| `completedAt` | Transition → `completed` | |
| `cancelledAt` | Transition → `cancelled` | |
| `updatedAt` | jeder Write | ISO-String. |

Caller koennen pro Transition individuelle Timestamps mitgeben (`timestamps` Param), oder explizit `null` setzen um Auto-Set zu unterdruecken.

## Customer

`order.customer` (Objekt):

| Feld | Typ | Quelle |
|------|-----|--------|
| `name` | string | Marketplace-Buyer-Name / Shipping-FullName / Fallback `'Unbekannt'`. |
| `street` | string \| null | Strasse + Hausnummer (zusammen). |
| `city` | string \| null | |
| `zip` | string \| null | |
| `country` | string \| null | ISO-Country-Code (z. B. `'DE'`). |
| `phone` | string \| null | sanitized. |
| `email` | string \| null | `validateEmail()`-geprueft. |
| `firstName` / `lastName` | optional | manchmal separat (Fallback in `shipping-engine.js:1267`). |

## Items

`order.items[]` — Array von Item-Objekten:

| Feld | Typ | Beschreibung |
|------|-----|--------------|
| `id` | string | `${orderId}-${idx+1}` (vom Intake gesetzt). |
| `sku` | string \| null | Stock-Schluessel. Pflicht fuer Stock-Decrement-Pfade. |
| `name` | string | Item-Bezeichnung. |
| `quantity` | number | Stueckzahl. |
| `priceBrutto` | number | Brutto pro Stueck. |
| `priceNetto` | number \| undefined | Netto pro Stueck. **TBD** — Konsistenz im Code verifizieren. |
| `weight` | number | kg, aus `enrichOrderItemsWithWeight()`. |
| `order_unit_id` / `id_order_unit` | string \| undefined | Kaufland-spezifisch (fuer Returns-Linkage). |
| `ean` | string \| undefined | Optional. |
| `condition` | string \| undefined | Marketplace-Condition-Code. |

## Pricing + Payment

| Feld | Typ | Beschreibung |
|------|-----|--------------|
| `totalAmount` | number | Brutto-Summe (inkl. Versand). |
| `currency` | string | `'EUR'`. |
| `vatRate` | number | Default `0.19`. Wird von `invoice-engine` gelesen. Manuell ueberschreibbar via UI ([routes/orders.js:1553](../../../../backend/routes/orders.js)). |
| `paymentStatus` | string \| null | Marketplace-Wert (z. B. `'Complete'`, `'Pending'`). |
| `paymentMethod` | string \| null | z. B. `'PayPal'`. |
| `shippingService` | string \| null | Vom Marketplace. |
| `shippingCost` | number | Versandkosten Brutto. |
| `buyerNote` | string \| null | Kommentar des Kaeufers. |

## Shipping / Tracking

| Feld | Typ | Beschreibung |
|------|-----|--------------|
| `trackingNumber` | string \| null | Vom SendCloud-Sync oder Marketplace gesetzt. Wird in `shipments`-Doc gespiegelt. |
| `trackingUrl` | string \| null | Vollstaendige Carrier-URL. |
| `carrier` | string \| null | `'DHL'`, `'DPD'`, … |
| `shipmentId` | string \| undefined | Verknuepfung zu `shipments`-Doc-ID. Gesetzt von `syncSendCloud()` ([shipping-engine.js:1310](../../../../backend/services/shipping-engine.js)). |
| `weight` | number | Gesamt-Order-Gewicht aus Items-Enrichment. |

## Invoice-Verknuepfung

| Feld | Typ | Beschreibung |
|------|-----|--------------|
| `invoiceId` | string \| undefined | Firestore-DocID des verknuepften Invoice. Verhindert Doppel-Generierung. |
| `invoiceNumber` | string \| undefined | Spiegel von `invoices.invoiceNumber` (SevDesk-Nummer). |
| `sevdeskInvoiceId` | string \| undefined | Von `importFromSevDesk()` gesetzt wenn Match gefunden. |
| `pdfUrl` | string \| undefined | `gs://...`-Pfad. |

## Stock-Decrement-Marker (CLAUDE.md §13)

| Feld | Typ | Wird gesetzt von | Beschreibung |
|------|-----|------------------|--------------|
| `stockDecrementedAt` | string (ISO) \| undefined | `bookStockOut(meta.orderId)` via `claimOrderStockDecrementInTx()` ODER `_onOrderShipped` Phase A | Marker dass Decrement passiert ist. |
| `stockDecrementedBy` | `'pick'` \| `'ship'` | dito | Welcher Pfad gewonnen hat. |
| `stockDecrementedSkus` | string[] | dito | Liste der dekrementierten SKUs. |

Werden bei Total-Failure aller Decrements zurueckgesetzt ([order-state-machine.js:299-313](../../../../backend/services/order-state-machine.js)).

## Raw

| Feld | Typ | Beschreibung |
|------|-----|--------------|
| `raw` | object | Original-Payload vom Marketplace (eBay XML/JSON, Kaufland JSON). Fuer Debug + Re-Mapping ohne Neu-Pull. |

## Legacy-Felder (nicht entfernen — additive only)

| Feld | Herkunft | Status |
|------|----------|--------|
| `baselinkerId` | BaseLinker-Sync (TABU, CLAUDE.md §9) | Nur Lesen. Dedup-Filter in `listOrders()` ([firestore.js:3288-3297](../../../../backend/lib/firestore.js)). |
| `source: 'baselinker'` | dito | dito. |

## Sub-Events

Jeder Status-Wechsel schreibt parallel einen Event-Doc in `order_events` mit dem Schema:

```
{
  orderId, tenantId,
  event: 'status_change',
  fromStatus, toStatus,
  fromStatusLabel, toStatusLabel,
  actor: { uid, email } | null,
  note: string | null,
  timestamp: serverTimestamp(),
}
```

Lese-Pfad: `services/order-state-machine.getOrderTimeline()` mit Composite-Index `(orderId, timestamp desc)`.

Ergaenzend werden ad-hoc Events von anderen Services geschrieben (z. B. `services/shipping-engine.js:1559` schreibt `event: 'delivered'`-Doc bei SendCloud-Delivery-Confirm). **TBD** — vollstaendige Liste der Event-Typen.

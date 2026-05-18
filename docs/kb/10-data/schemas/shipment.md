---
title: Schema — shipments
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# Schema — `shipments`

> Quelle: [services/shipping-engine.js](../../../../backend/services/shipping-engine.js). Mirror der SendCloud-Parcels mit AvyCloud-Verknuepfung (Order, Tenant, Status). Append-/Update-Doku — Lifecycle synchronisiert ueber `refreshShipmentFromSendCloud()` und `pollDeliveryStatus()`.

## DocID-Strategie

Auto-generierte Firestore-DocID via `.add()`. Verknuepfung erfolgt ueber `orderId`-Feld + Composite-Index `(orderId, createdAt desc)`. Es gibt **keinen** deterministischen DocID-Schluessel — Idempotenz wird vor `.add()` per Query gesichert (`existingSnap.empty`-Check).

## Felder (vom Create-Pfad `createParcel()` ([shipping-engine.js:449-468](../../../../backend/services/shipping-engine.js)))

### Identitaet + Verknuepfung

| Feld | Typ | Pflicht | Beschreibung |
|------|-----|---------|--------------|
| `tenantId` | string | ja | CLAUDE.md §8. |
| `orderId` | string | ja | Firestore-DocID des `orders`-Docs (`marketplaceKey`-Format). |
| `orderNumber` | string \| null | optional | Marketplace-Order-Nummer oder `order.orderId`. |
| `marketplaceOrderId` | string \| null | optional | Original-Marketplace-ID. |
| `marketplace` | string \| null | optional | `'ebay'` / `'kaufland'` / aus `order.source`. |

### SendCloud-Spiegel

| Feld | Typ | Pflicht | Beschreibung |
|------|-----|---------|--------------|
| `sendcloudParcelId` | number \| null | ja | Primaer-Schluessel beim Carrier. |
| `trackingNumber` | string \| null | wird async befuellt | Carrier-Trackingnummer. Initial-POST kann leer sein, populiert nach `pollForLabel()` ([shipping-engine.js:431](../../../../backend/services/shipping-engine.js)). |
| `trackingUrl` | string \| null | wird async befuellt | Full-Carrier-Tracking-URL. |
| `labelUrl` | string \| null | wird async befuellt | Label-Download (PDF oder PNG). |
| `carrier` | string \| null | async | Carrier-Code (`'dhl'`, `'dpd'`, …). In `syncSendCloud()` als Uppercase + ohne `_DE`-Suffix. |
| `carrierName` | string \| null | async | Spiegel oder Original-Carrier-String. |
| `shippingMethodId` | number \| null | ja | SendCloud-Method-ID (Mapping zu `shipping_methods`-Cache). |
| `weight` | number \| null | optional | Gesamt-Parcel-Gewicht in kg. |
| `cost` | number \| undefined | optional | Aus `parcel.price` oder CSV-Fallback (`lookupCsvPrice()`). |

### Status

| Feld | Typ | Beschreibung |
|------|-----|--------------|
| `status` | string | Internes Mapping: `'ausstehend'`, `'in_zustellung'`, `'zugestellt'`, `'problem'`, `'storniert'`. Mapping in `mapSendCloudStatus()` ([shipping-engine.js:36-50](../../../../backend/services/shipping-engine.js)). |
| `statusId` | number \| null | SendCloud-Numeric-Status-ID. Vollstaendige Liste: [SendCloud Docs](https://support.sendcloud.sc/hc/en-us/articles/360024967612). |
| `statusRaw` | string \| null | Original `parcel.status.message`. |

### Timestamps

| Feld | Typ | Beschreibung |
|------|-----|--------------|
| `createdAt` | string (ISO) | Initial-Create. |
| `updatedAt` | string (ISO) | Letzte Aenderung. |
| `shippedAt` | string (ISO) | `parcel.date_created` oder Now. |
| `deliveredAt` | string (ISO) \| null | Gesetzt von `pollDeliveryStatus()` wenn Carrier-Status in `DELIVERED_STATUS_IDS = [11, 12, 62]` faellt. |

### Customer (nur via `syncSendCloud()`-Pfad gesetzt — siehe [shipping-engine.js:1278](../../../../backend/services/shipping-engine.js))

| Feld | Typ | Beschreibung |
|------|-----|--------------|
| `customer` | string \| null | Customer-Name (Fallback-Chain via `order.customer.name`, `parcel.name`, `parcel.address.name`, `parcel.address.company_name`). |

### Source

| Feld | Typ | Beschreibung |
|------|-----|--------------|
| `source` | string \| undefined | `'sendcloud_sync'` wenn von `syncSendCloud()` (auto-discovery) erzeugt. Initial-`createParcel()`-Writes setzen das Feld nicht. |

## Idempotenz

- `createParcel()` — generiert immer einen neuen Doc; ein zweiter Aufruf fuer denselben Order erzeugt einen zweiten Shipment-Doc. Deduplizierung muss der Caller (Routes) sicherstellen.
- `syncSendCloud()` — prueft `existingParcelIds` vor `.add()` ([shipping-engine.js:1128+](../../../../backend/services/shipping-engine.js)).
- `refreshShipmentFromSendCloud()` — operiert UPDATE-only, kein Doc-Create. Re-Binding bei `sendcloudParcelId`-Aenderung passiert via `update()` auf dem bestehenden Shipment-Doc.

## Side-Effects bei Status-Wechseln

- **`status === 'zugestellt'`** (von `pollDeliveryStatus()`): triggert `transitionOrder({ toStatus: 'delivered', force: true })` plus schreibt `order_events`-Doc mit `event: 'delivered'`.
- **`syncSendCloud()` mit Tracking-Number**: triggert Auto-Transition `→ shipped` wenn der Order noch nicht in terminal-State ist ([shipping-engine.js:1317-1328](../../../../backend/services/shipping-engine.js)).

## Composite-Indexes

- `(tenantId, createdAt desc)` — UI Shipments-Liste.
- `(tenantId, status, createdAt desc)` — Status-Filter.
- `(orderId, createdAt desc)` — Order-Detail-Page (neueste Shipments pro Order).

## Nicht-versioniert / nicht persistiert

Original `parcel`-Objekt vom SendCloud-API wird **nicht** komplett im Shipment-Doc gespeichert — nur die Felder oben werden extrahiert. Re-Pull bei Bedarf via `refreshShipmentFromSendCloud()`.

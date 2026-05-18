---
title: Shipping Engine
for: [dev, agent, admin, manager]
lastReviewed: 2026-05-18
---

# Shipping Engine

## Was es macht

Erzeugt Versandlabels über die SendCloud API v2, verwaltet Parcels in `shipments`, mappt Carrier-Codes für eBay/Kaufland-Tracking-Push, und entscheidet anhand von gewichts-basierten Carrier-Rules automatisch über die Versandmethode.

## Wie es funktioniert

```mermaid
flowchart TD
  ORD[Order packed] --> SHIP[POST /api/orders/:orderId/ship]
  SHIP --> RULE[shipping-engine.matchCarrierRule]
  RULE --> SC[SendCloud createParcel]
  SC --> SHM[(shipments) doc]
  SHM --> ORDU[orders:omsStatus=shipped via transitionOrder]
  ORDU --> EVT[order:status_changed]
  EVT --> MTP[marketplace-tracking.pushTrackingToMarketplace]
  MTP --> EBAY[eBay CompleteSale]
  MTP --> KFL[Kaufland Update Carrier+Tracking]
  SHIP -.poll.-> RFRSH[refresh-shipment]
  RFRSH --> SC2[SendCloud GetParcel]
  SC2 --> SHU[shipments.status mapping]
```

### Carrier-Rule-Matching (`backend/services/shipping-engine.js`)

Default-Carrier-Rules (Fallback wenn keine in Firestore konfiguriert):

| min kg | max kg | shippingMethodId | Carrier | Label |
|---|---|---|---|---|
| 0.5 | 1.99 | 2830 | DHL | DHL Kleinpaket 0–1 kg |
| 2 | 4.99 | 111 | DPD | DPD Classic 0–5 kg |
| 5 | 9.99 | 112 | DPD | DPD Classic 5–10 kg |
| 10 | 31.5 | 113 | DPD | DPD Classic 10–20 kg |

Konfigurierbare Rules werden in der `shipping_rules` Firestore-Collection abgelegt (siehe `backend/__tests__/shipping-rule-matching.test.js`).

### SendCloud-Integration (`backend/lib/sendcloud.js`)

- Auth: HTTP Basic via `SENDCLOUD_PUBLIC_KEY` + `SENDCLOUD_SECRET_KEY` (Secrets Manager).
- Base URL: `https://panel.sendcloud.sc/api/v2`.
- `createParcel`, `getParcel`, `cancelParcel`.
- `lookupCsvPrice` für CSV-basierte Preis-Tabelle.
- Status-Mapping (`mapSendCloudStatus`): SendCloud-Numeric-Status-IDs → interne `'zugestellt' | 'in_zustellung' | 'ausstehend' | 'problem' | 'storniert'`.

### Marketplace-Tracking-Push (`backend/services/marketplace-tracking.js`)

Carrier-Code-Mapping für jeden Marketplace:
- **eBay**: `EBAY_CARRIER_MAP` (DHL, DPD, Hermes, GLS, UPS, DHL Express). Push via Trading-API `CompleteSale`.
- **Kaufland**: `KAUFLAND_CARRIER_MAP` — strikte Schreibweise (Title Case, Spaces). Quelle: <https://sellerapi.kaufland.com/?page=order-files#carrier-codes>.

Failure-Handling: `collectError(...)` (siehe `error-dashboard.md`) wird im catch aufgerufen, kein Throw.

### Background-Jobs

- `tracking-catchup` (cron in `backend/index.js`): pollt offene Shipments für Status-Updates.
- `delivery-poll` (cron): markiert delivered Shipments und triggert OMS-Übergang `shipped → delivered`.
- `sendcloud-sync` (cron): Reconcile mit SendCloud bei Drift.
- Multi-Tenant-Fan-Out via `BACKGROUND_JOB_TENANTS`.

## Code-Pfade

**Backend:**
- `backend/services/shipping-engine.js` — SendCloud-Wrapper, Carrier-Rule-Matching, Status-Mapping
- `backend/services/marketplace-tracking.js` — Tracking-Push zu eBay/Kaufland
- `backend/lib/sendcloud.js` — SendCloud-API-Client + CSV-Preis-Lookup
- `backend/services/label-printer.js` — Label-PDF-Generierung
- `backend/services/order-state-machine.js` — `_onOrderShipped` Trigger
- Tests:
  - `backend/__tests__/address-labels.test.js`
  - `backend/__tests__/shipping-refresh.test.js`
  - `backend/__tests__/shipping-rule-matching.test.js`

**Frontend:**
- `components/orders/ShippingView.tsx` — Versand-Tab in OrderDetail
- `components/orders/ShippingDecisionDialog.tsx` — Carrier-/Methode-Auswahl
- `components/OrderDetail.tsx` — Versand-Trigger

### Datenmodell

| Collection | Zweck |
|---|---|
| `shipments` | SendCloud-Parcel-Status, `tracking_number`, `carrier`, `label_url` |
| `shipping_rules` | Konfigurierbare Carrier-Rules (Override Defaults) |
| `orders.shipping` | Per-Order Shipping-Block (`carrier`, `tracking_number`, `label_url`) |

## Feature-Flags

| Flag | Default | Wirkung |
|---|---|---|
| `SENDCLOUD_PUBLIC_KEY` | – (Secret) | API-Auth |
| `SENDCLOUD_SECRET_KEY` | – (Secret) | API-Auth |
| `BACKGROUND_JOB_TENANTS` | `''` | Multi-Tenant Cron-Fan-Out |

## API-Endpoints

Verweis auf `docs/kb/09-api/` (TBD). Auswahl aus `backend/routes/orders.js`:

- `GET  /api/shipments` — Liste
- `POST /api/shipments` — Manuell anlegen
- `GET  /api/shipping-methods` — SendCloud-Methoden-Liste
- `POST /api/shipping-methods/sync` — Refresh aus SendCloud
- `GET  /api/orders/:orderId/shipping-preview` — Preview (Methode + Preis)
- `POST /api/orders/:orderId/ship` — Label erzeugen + Order shipped
- `POST /api/orders/:orderId/refresh-shipment` — Tracking-Refresh
- `POST /api/orders/:orderId/cancel-label` — Label-Storno
- `POST /api/orders/:orderId/tracking` — Manuelles Tracking
- `POST /api/orders/sync-sendcloud` — SendCloud-Reconcile
- `POST /api/orders/bulk-ship` — Sammel-Versand
- `POST /api/orders/address-labels` — Adress-Etiketten
- `GET  /api/shipping/methods` — Methoden-Stamm
- `GET  /api/orders/:orderId/label` — Label-PDF Download

Auth: `orders.read|write`.

## UI-Pages

Verweis auf `docs/kb/05-pages/` (TBD).

- OrderDetail → Versand-Tab + `ShippingDecisionDialog`
- `OperationsView` → Bulk-Ship-Workflow

## Spec

TBD — keine Stand-alone-Spec.

## Bekannte Issues

TBD — laufende Bugs siehe `TASKS.md`.

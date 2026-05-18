---
title: "Integration: Kaufland"
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# Kaufland

> Marketplace-Integration via **Kaufland Seller API v2** (`https://sellerapi.kaufland.com/v2`).
> Registry-Eintrag: [backend/lib/integration-registry.js](../../../backend/lib/integration-registry.js) (`kaufland`, authType `api_key`).

## Was integriert ist

- **Units** (Kaufland-Bezeichnung für Listings/Offers): Create / Patch / Status (ONHOLD/AVAILABLE) / List / Get
- **Product-Data** (Katalog-Attribute pro EAN, inkl. GPSR `product_safety_contact`)
- **Catalog-Lookup** (`GET /products/ean/{ean}`)
- **Shipping-Groups** + **Warehouses** (`/shipping-groups`, `/warehouses`)
- **Reports / Bookings** (asynchroner CSV-Export der Payout-Transaktionen)
- **Listings-Sync** mit Drift-Detection (Kaufland > Warehouse → outbound Stock-Push) — [backend/services/kaufland-listings-sync.js](../../../backend/services/kaufland-listings-sync.js)
- **Tracking-Push** mit Carrier-Code-Mapping — [backend/services/marketplace-tracking.js](../../../backend/services/marketplace-tracking.js)
- **Order-Intake** über Webhook + `order:updated`-Event ([backend/services/order-intake-kaufland.js](../../../backend/services/order-intake-kaufland.js))

## Auth + Credentials

### HMAC-SHA256 Request-Signatur

Implementiert in [backend/lib/kaufland-api.js](../../../backend/lib/kaufland-api.js) (`signRequest()`).

Pro Request werden 3 Header gesetzt:

| Header | Wert |
|--------|------|
| `Shop-Client-Key` | `KAUFLAND_CLIENT_KEY` |
| `Shop-Timestamp` | Unix-Sekunden (`Math.floor(Date.now()/1000)`) |
| `Shop-Signature` | `HMAC-SHA256(secret, METHOD + "\n" + ABSOLUTE_URL + "\n" + RAW_BODY + "\n" + TIMESTAMP)` (hex) |

Zusätzlich:

- `User-Agent` → `KAUFLAND_USER_AGENT` (default `Inhouse_development`)
- `Accept: application/json`
- `Content-Type: application/json` nur bei nicht-leerem Body

### Secret-Manager-Mapping

Beide Secrets sind Pflicht. Pro Tenant kann das `credentialToSecretMap` in der Registry-Konfiguration auf tenant-spezifische Secrets gemappt werden.

| Zweck | Secret |
|-------|--------|
| Client Key | `KAUFLAND_CLIENT_KEY` |
| Secret Key | `KAUFLAND_SECRET_KEY` |
| Webhook-Verifikation | `KAUFLAND_WEBHOOK_SECRET` (siehe [webhook-signing.md](webhook-signing.md)) |

UI-Onboarding über die Settings-Page: `clientKey` (min. 10 Zeichen) + `secretKey` (min. 10 Zeichen).

## Hauptendpoints (call sites im Code)

Alle gehen durch `kauflandRequest(method, path, { query, body })` in [backend/lib/kaufland-api.js](../../../backend/lib/kaufland-api.js).

| Pfad | Methode | Funktion | Verwendung |
|------|---------|----------|------------|
| `/units` | GET | `listUnits({storefront,limit,maxPages})` | Listings-Cache + Drift-Sync |
| `/units?id_offer=&ean=` | GET | `findUnit({storefront,idOffer,ean})` | Lookup vor Patch |
| `/units/{id_unit}` | GET | `getUnit(unitId, {embedded})` | Detail-Read |
| `/units` | POST | `createUnit(product, {storefront})` | Listing anlegen (mit `putProductData` Pre-Step) |
| `/units/{id_unit}` | PATCH | `updateUnit(unitId, product)` | Preis-/Bestand-/Note-Update |
| `/units/{id_unit}` | PATCH | `setUnitStatus(unitId, status)` | Delist (`status: 'ONHOLD'` + `amount: 0`) |
| `/products/ean/{ean}` | GET | `getProductByEan(ean)` | Catalog-Lookup → `id_product` |
| `/product-data/status/{ean}` | GET | `getProductDataStatus(ean)` | Validierungs-Status |
| `/product-data/{ean}` | GET | `getProductData(ean)` | Aktuelle Attribute |
| `/product-data` | PUT | `putProductData({ean,attributes})` | Authoritative Attribute-Submission (immer beim Create-Flow) |
| `/product-data` | PATCH | `patchProductData({ean,attributes})` | Repair-Flow |
| `/shipping-groups` | GET | `listShippingGroups({storefront})` | Settings-UI |
| `/warehouses` | GET | `listWarehouses()` | Settings-UI |
| `/reports/bookings-new` (Fallback `/reports/bookings`) | POST | `getBookings({from,to,storefront})` | Payout-Auszug, async CSV |
| `/reports/{id_report}` | GET | `getBookings()` Poll | Status `done|failed|error` |

Retries auf `429` + `5xx` mit exponentiellem Backoff (`backoffDelay(attempt)`: 500 ms × 2^n, cap 8 s, +0–250 ms Jitter), max. `KAUFLAND_API_MAX_RETRIES` (default `4`). Timeout `KAUFLAND_API_TIMEOUT_MS` default `25000` ms.

## Webhooks

### Eingehend: `POST /api/webhooks/kaufland`

- Route in [backend/routes/webhooks.js](../../../backend/routes/webhooks.js).
- **HMAC-Signatur-Header:** `X-Kaufland-Signature` (Fallback `X-Signature`).
- **Verifikation (aktuell):**
  ```js
  const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
  const expected = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) reject;
  ```
- **Status:** **vermutlich gebrochen** — `JSON.stringify(req.body)` re-serialisiert das Body **nach** dem `express.json()`-Parser. Whitespace + Key-Order weichen vom Original-Stream ab, dadurch ist der HMAC fast garantiert ungleich. Konsequenz heute: entweder Webhooks fail-closed (`200 + error` zurück) oder das Secret ist gar nicht gesetzt → fail-open. Details in [webhook-signing.md](webhook-signing.md).
- Akzeptierte Events:
  - Orders: `new_order`, `order_unit_status_changed`, `order_cancelled`, `order_shipped` → `emitSyncEvent('order:updated', …)`
  - Returns: `return_created`, `return_updated`, `return_accepted`, `return_rejected` → `emitSyncEvent('return:created', …)`
  - Unbekannte Events → Fallback `order:updated` mit `entityId='kaufland-unknown'`.

### Outgoing-Push

- **Tracking** → `pushTrackingToKaufland()` in [backend/services/marketplace-tracking.js](../../../backend/services/marketplace-tracking.js); Carrier-Map `KAUFLAND_CARRIER_MAP` mit Catch-all `'Other'`.

## Status-Mapping

Unit-Status:

| Code | Bedeutung |
|------|-----------|
| `AVAILABLE` | Aktiv, verkaufbar |
| `ONHOLD` | Pausiert (wird gesetzt sobald `amount <= 0`) |

`pickUnitData()` mappt unsere `inventory.availableQuantity → patchData.status`:

- `amount > 0` → `AVAILABLE`
- `amount === 0` → `ONHOLD`

Condition-Mapping (Kaufland-Codes → API-Strings) in `CONDITION_CODE_MAP`:

| Code | API-Wert |
|------|----------|
| 100 | `NEW` |
| 110 | `REFURBISHED___AS_NEW` |
| 120 | `REFURBISHED___VERY_GOOD` |
| 130 | `REFURBISHED___GOOD` |
| 140 | `REFURBISHED___ACCEPTABLE` |
| 200 | `USED___AS_NEW` |
| 300 | `USED___VERY_GOOD` |
| 400 | `USED___GOOD` |
| 500 | `USED___ACCEPTABLE` |

VAT-Indicators (Whitelist `VAT_INDICATORS`): `standard_rate`, `reduced_rate_1`, `reduced_rate_2`, `super_reduced_rate`, `zero_rate`.

## Rate-Limits + Quotas

- Kaufland publiziert keine harten Rate-Limits öffentlich. Unsere Defensiv-Strategie:
  - Exponentielles Retry auf `429`/`5xx` (max. 4 Versuche)
  - Sequentielle Paginierung mit `limit: 100` (Cap), `maxPages: 300`
  - Reports asynchron mit Polling (`pollIntervalMs: 5000`, `pollTimeoutMs: 180000`)
- Product-Data-Indexing braucht **bis zu 24 h** bis `product.is_valid: true` umspringt (TTL für `kauflandUnitsLive.product_valid`-Cache: `VALIDITY_TTL_MS = 24h`).

## Bekannte Schwächen

- **partial-units Fallstrick.** `pickUnitData()` rechnet `amount` aus `inventory.availableQuantity ?? inventory.quantity ?? Σ(storageBins.quantity) ?? storage.quantity ?? 0`. Wenn `availableQuantity` von `stock-sync-dispatcher.computeAvailableQuantity()` noch nicht (re-)berechnet wurde (z. B. nach Stock-Lock-Race), kann der Fallback auf `inventory.quantity` einen **größeren** Wert pushen als aktuell wirklich verfügbar ist → Oversell. Mitigation: stock-sync-dispatcher MUSS `availableQuantity` pre-berechnen, Pfad ist Pflicht (siehe CLAUDE.md Punkt 10).
- **Webhook-HMAC vermutlich gebrochen.** Siehe oben + [webhook-signing.md](webhook-signing.md). Bis Fix: jede POST-Anfrage triggert (in best-case) einen Sync-Cascade, aber Spoofing ist trivial.
- **`putProductData` blockiert nicht bei Catalog-Konflikt.** `createUnit()` submitted IMMER unsere Attribute (auch wenn Catalog bereits Daten hat) — bewusst, weil Catalog-Daten oft sparse sind. Nebeneffekt: Kaufland-Reviewer kann Conflict-State markieren. Mehrstündige Verzögerungen sind erwartet.
- **Reports-Endpoint-Drift.** `getBookings()` versucht erst `/reports/bookings-new`, fällt auf `/reports/bookings` zurück. Kaufland hat in der Vergangenheit ohne Vorwarnung umbenannt; Antwort enthält `endpointUsed` zum Operator-Tracking.
- **CSV-Schema instabil.** Bookings-CSV ist nicht offiziell schema'd; Parser sniffed Delimiter (`;` vs `,`) und matched mehrere Header-Aliase pro Feld. Bei Header-Änderungen liefert `getBookings()` `amount_cents: null` ohne Fehler.
- **Kaufland-Reconcile (Gap C, TASKS.md)** schreibt aktuell direkt in `products_v2.inventory.quantity` (`routes/marketplace.js:966`), siehe CLAUDE.md Punkt 13 Verbot a). Bekannte Schuld bis Refactor.
- **`KAUFLAND_WEBHOOK_SECRET` muss separat gesetzt werden** — fehlt es, ist die Verifikation fail-open. Kein Default in Secret-Manager.
- **Multi-Storefront ist Per-Call-Parameter, kein Tenant-Setting.** Storefront-IDs (`de|cz|sk|pl|at|fr|it`) müssen pro Call mitgegeben werden; Tenant-globaler Default ist `'de'`.

## Owner / Docs

- **Code-Owner:** Backend-Team.
- **Externe Doku:**
  - API-Übersicht: [sellerapi.kaufland.com](https://sellerapi.kaufland.com/)
  - Carrier-Codes (Tracking-Push): [sellerapi.kaufland.com Order-Files §carrier-codes](https://sellerapi.kaufland.com/?page=order-files#carrier-codes)
- **Verwandte KB-Seiten:**
  - [webhook-signing.md](webhook-signing.md) — HMAC-Status
  - [services/kaufland-listings-sync.js](../../../backend/services/kaufland-listings-sync.js) — Drift-Detection

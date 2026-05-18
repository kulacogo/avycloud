---
title: "Integration: eBay"
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# eBay

> Multi-API-Integration: **Trading API (XML)** für Listings/Add/Revise/End, **REST Sell-APIs** (Inventory, Fulfillment, Finances, Account) für Bestellungen/Auszahlungen, **Browse API** + **Catalog API** für Katalog-Lookups, **Taxonomy API** für Kategorien/Aspects.
> Registry-Eintrag: [backend/lib/integration-registry.js](../../../backend/lib/integration-registry.js) (`ebay`, authType `oauth2`).

## Was integriert ist

- **Listings-Lifecycle** (Add / Verify / Revise / End / GetMyeBaySelling / GetItem) — Trading API
- **Inventory v1** (Offer-Lookup pro SKU) — REST
- **Fulfillment** (Orders + Returns + Shipping-Fulfillment) — REST
- **Finances** (Payouts, Transactions) — REST
- **Account** (Business Policies: Shipping / Return / Payment) — REST + Trading
- **Browse API** + **Catalog API** (GTIN → ePID, ASPECT_REFINEMENTS) — REST, für Identify-V3/V4
- **Taxonomy API** (Category-Suggestions, Required-Aspects) — REST
- **Sold-Listings-Signal** (Pricing-Worker) — Browse + SerpAPI-Fallback (`engine='ebay'` mit `LH_Sold=1`)
- **Auto-Fix** (Category-Mismatch, Aspect-PBSE, Image-Conflict, Aspect-Cap >45) — [backend/services/ebay-auto-fix.js](../../../backend/services/ebay-auto-fix.js)
- **GPSR** (`<Regulatory>` + `<Manufacturer>` + `<ResponsiblePersons>`) — Trading-XML, EU-Pflicht seit Juli 2024

## Auth + Credentials

### OAuth 2.0 (REST-APIs)

- Implementiert in [backend/lib/ebay-oauth.js](../../../backend/lib/ebay-oauth.js).
- Token-Endpoint: `https://api.ebay.com/identity/v1/oauth2/token` (Prod) / `https://api.sandbox.ebay.com/...` (Sandbox).
- Credentials werden aus Env oder Secret-Manager geladen:
  - `EBAY_CLIENT_ID` (alt. `EBAY_APP_ID`)
  - `EBAY_CLIENT_SECRET` (alt. `EBAY_CERT_ID`)
  - `EBAY_RU_NAME` (RuName / redirect_uri-Wert; alt. `EBAY_REDIRECT_URI`, `EBAY_REDIRECT_URI_NAME`)
- Scopes default (siehe `getEbayScopes()`):
  - `sell.inventory.readonly`
  - `sell.fulfillment`
  - `sell.finances`
  - `sell.account.readonly`
  - `commerce.identity.readonly`
- Override via `EBAY_SCOPES` (Space- oder Komma-getrennt).
- OAuth-State-Tokens werden in Firestore `oauthStates` zwischengespeichert; aktuelle Access/Refresh-Tokens in `integrations/ebay` (Doc-ID `EBAY_INTEGRATION_DOC_ID`).
- Sandbox vs Prod via `EBAY_ENV=sandbox|production` (default `production`).

### Trading API (XML, eBayAuthToken)

- Implementiert in [backend/lib/ebay-trading-api.js](../../../backend/lib/ebay-trading-api.js).
- Endpoint: `https://api.ebay.com/ws/api.dll` (Prod) / `https://api.sandbox.ebay.com/ws/api.dll`.
- Header-Pflichtfelder:
  - `X-EBAY-API-APP-NAME` → `EBAY_TRADING_APP_ID` (Fallback `EBAY_APP_ID`, `EBAY_CLIENT_ID`)
  - `X-EBAY-API-DEV-NAME` → `EBAY_TRADING_DEV_ID` (Fallback `EBAY_DEV_ID`)
  - `X-EBAY-API-CERT-NAME` → `EBAY_TRADING_CERT_ID` (Fallback `EBAY_CERT_ID`, `EBAY_CLIENT_SECRET`)
  - `X-EBAY-API-SITEID` → `EBAY_TRADING_SITE_ID` (default `77` = Deutschland)
  - `X-EBAY-API-COMPATIBILITY-LEVEL` → `EBAY_TRADING_COMPATIBILITY_LEVEL` (default `1209`)
- `eBayAuthToken`-Body-Tag: bevorzugt der frische OAuth-Access-Token aus Firestore (siehe `callTradingApi()`), Fallback ist der statische `EBAY_TRADING_USER_TOKEN` aus Secret-Manager.

### Secret-Manager-Mapping

Resolution-Reihenfolge in `resolveCredential()`: 1) `process.env[NAME]` direkt, 2) `getSecretValue(NAME)`.

| Zweck | ENV-Var / Secret |
|-------|------------------|
| OAuth Client-ID | `EBAY_CLIENT_ID` |
| OAuth Client-Secret | `EBAY_CLIENT_SECRET` |
| OAuth Redirect (RuName) | `EBAY_RU_NAME` |
| Trading App-ID | `EBAY_TRADING_APP_ID` |
| Trading Dev-ID | `EBAY_TRADING_DEV_ID` |
| Trading Cert-ID | `EBAY_TRADING_CERT_ID` |
| Trading User-Token | `EBAY_TRADING_USER_TOKEN` |
| Webhook-Verification-Token (GDPR) | `EBAY_WEBHOOK_VERIFICATION_TOKEN` |
| Webhook-Endpoint-URL | `EBAY_WEBHOOK_ENDPOINT` |

## Hauptendpoints (call sites im Code)

### Trading API ([backend/lib/ebay-trading-api.js](../../../backend/lib/ebay-trading-api.js))

| Call | Funktion | Verwendung |
|------|----------|------------|
| `GetMyeBaySelling` | `getMyeBaySellingActive()` | Listings-Sync, Paginierung 1–200 pro Page |
| `GetItem` | `getItemDetails(itemId)` | Listing-Detail inkl. ItemSpecifics, PictureDetails |
| `ReviseFixedPriceItem` / `ReviseItem` | `reviseFixedPriceItem(patch)` / `reviseItem(patch)` | Preis-/Bestands-/Aspects-Update |
| `AddFixedPriceItem` | `addFixedPriceItem(item)` | Neuanlage mit 3-stage Retry (Category-Mismatch → drop `<PrimaryCategory>`, PBSE → Aspect-Strip) |
| `VerifyAddFixedPriceItem` | `verifyAddFixedPriceItem(item)` | Dry-Run vor Add |
| `EndItem` / `EndFixedPriceItem` | `endItem()` / `endFixedPriceItem()` | Delist mit `EndingReason` (`NotAvailable` default) |
| `GetSellerProfiles` | `getSellerProfiles()` | Shipping/Return/Payment-Profile, 4 h Cache |
| `GetCategoryInfo` / `GetCategorySpecifics` | `getCategoryInfo()` / `getCategorySpecifics()` | Kategorie-Validation + Required-Aspects, 24 h Cache |

### REST Sell-APIs ([backend/lib/ebay-api.js](../../../backend/lib/ebay-api.js))

| Endpoint | Funktion |
|----------|----------|
| `GET /sell/inventory/v1/offer?sku=...` | `getOffersBySku(sku)` |
| Beliebige REST-GETs | `ebayGetJson(path, { query })` — wrappt `getValidEbayAccessToken` + Rate-Limiter |

### Catalog + Browse ([backend/lib/ebay-catalog.js](../../../backend/lib/ebay-catalog.js), [backend/lib/ebay-browse-title-insights.js](../../../backend/lib/ebay-browse-title-insights.js))

| Endpoint | Zweck |
|----------|-------|
| `GET /commerce/catalog/v1_beta/product_summary/search?gtin=...` | GTIN → ePID (beta, Region-limited; benötigt `commerce.catalog.readonly`) |
| `GET /buy/browse/v1/item_summary/search?gtin=...&fieldgroups=ASPECT_REFINEMENTS` | Fallback wenn Catalog API leer |
| `GET /buy/browse/v1/item/get_item_by_legacy_id` | Title-Insights für Identify |

### Sold-Listings ([backend/lib/ebay-sold-listings.js](../../../backend/lib/ebay-sold-listings.js))

- Strategien: Browse mit `filter=itemEndDate:[..now]` → SerpAPI `engine='ebay'` mit `LH_Sold=1&LH_Complete=1` → aktive Listings als Lower-Weight-Fallback.
- `searchSoldListings({ gtin?, query?, categoryId?, limit?, marketplaceId? })` → fail-safe (`null` statt throw).

### Taxonomy

- [backend/lib/ebay-taxonomy.js](../../../backend/lib/ebay-taxonomy.js) (lokaler Cache aus JSON) + [backend/lib/ebay-taxonomy-remote.js](../../../backend/lib/ebay-taxonomy-remote.js) (Live-Lookups).

## Webhooks

### Eingehend: `POST /api/webhooks/ebay`

- Route in [backend/routes/webhooks.js](../../../backend/routes/webhooks.js).
- **Keine Signatur-Verifikation** (Hardening-Plan Finding, siehe [webhook-signing.md](webhook-signing.md)).
- Akzeptiert eBay Platform Notifications (REST + Trading):
  - Order-Topics: `MARKETPLACE_ORDER_CREATED`, `ORDER_CREATED`, `FIXED_PRICE_TRANSACTION`, `CHECKOUT_COMPLETE`, `ORDER_STATUS_CHANGE`, …
  - Return-Topics: `RETURN_CREATED`, `RETURN_CLOSED`, `RETURN_ESCALATED`, `ITEM_RETURNED`.
- Sonderfall **GDPR Account Deletion** (`metadata.topic === 'MARKETPLACE_ACCOUNT_DELETION'`) wird mit `200 OK` quittiert (Pflicht-Endpoint).
- Challenge-Handshake: bei `?challenge_code=...` wird `sha256(challenge_code + EBAY_WEBHOOK_VERIFICATION_TOKEN + EBAY_WEBHOOK_ENDPOINT)` zurückgegeben.
- Reagiert via `emitSyncEvent('order:updated' | 'return:created', …)`.

### Outgoing-Push

- Tracking-Push nach Versand: `CompleteSale` in [backend/services/marketplace-tracking.js](../../../backend/services/marketplace-tracking.js) (siehe `pushTrackingToEbay`).
- Carrier-Mapping: `EBAY_CARRIER_MAP` (DHL / DPD / Hermes / GLS / UPS / DHL Express).

## Rate-Limits + Quotas

Globaler Token-Bucket + Sliding-Window in [backend/lib/ebay-rate-limiter.js](../../../backend/lib/ebay-rate-limiter.js):

| Limit | Default | ENV-Override |
|-------|---------|--------------|
| Pro Sekunde | 4 Calls | `EBAY_MAX_CALLS_PER_SECOND` |
| Pro Stunde | 4500 Calls | `EBAY_MAX_CALLS_PER_HOUR` |
| Pro Tag | 4500 Calls | `EBAY_MAX_CALLS_PER_DAY` |

Zusätzlich (`callTradingApi`):

- API-Level-Retry: bei `21917062` (`exceeded usage limit`) max. 3 Versuche mit exponentiellem Backoff (2s/4s/8s). Konfigurierbar via `EBAY_RATE_LIMIT_MAX_RETRIES`.
- HTTP-Level-Retry: bei „exceeded usage limit"-Bodies in 4xx/5xx-Responses.

Timeouts:

- Trading: `EBAY_TRADING_TIMEOUT_MS` default 25 000 ms
- REST: `EBAY_API_TIMEOUT_MS` default 25 000 ms

eBays formelle pro-App-Limits (Inventory + Fulfillment ~5 000/Tag, Trading-API kontingentbasiert über Compatibility-Level + Token) sind in unserer Konfiguration konservativer abgebildet, da sich Bursts aus Auto-Fix-Retries + Bulk-Recategorize aufsummieren.

## Bekannte Schwächen

- **Webhook ohne Signatur-Verifikation.** Endpoint akzeptiert beliebige POST-Bodies und triggert `emitSyncEvent`. DoS-/Spoof-Risiko. Hardening-Plan Eintrag, siehe [webhook-signing.md](webhook-signing.md).
- **Statischer User-Token als Fallback** (`EBAY_TRADING_USER_TOKEN` aus Secret-Manager) — wenn der OAuth-Refresh in Firestore stale ist oder gelöscht wurde, bleibt der statische Token aktiv, kann aber individuell ablaufen ohne dass der Health-Check `fetchTradingStatus()` das meldet.
- **Catalog API ist beta + DACH-spotty.** Browse-API-Fallback in `ebay-catalog.js` ist Pflichtpfad, kein Nice-to-have.
- **Auto-Fix-Loop bei PBSE/Identifier-Strip.** Stripping von EAN/Brand/MPN aus ItemSpecifics ist explizit blockiert (`PROTECTED_IDENTIFIER_TOKENS` in [backend/lib/ebay-trading-api.js](../../../backend/lib/ebay-trading-api.js)), weil sonst „EAN fehlt"-Loop entsteht.
- **GDPR-Endpoint hat keine Verifikation.** `MARKETPLACE_ACCOUNT_DELETION`-Notifications werden blind mit `200 OK` quittiert; kein Tenant-Mapping, kein Audit.
- **Sold-Listings nur über SerpAPI.** eBays öffentliche `Browse` API hat keinen formalen `SOLD`-Filter; Terapeak-Zugang ist nicht angeschlossen. Pricing-Signal ist daher SerpAPI-abhängig.
- **`EBAY_WEBHOOK_VERIFICATION_TOKEN` + `EBAY_WEBHOOK_ENDPOINT` werden aus `process.env` gelesen, nicht aus Secret-Manager** — kein Reload ohne Restart.
- **Compatibility-Level hardcoded** auf `1209`. eBay deprecated alte Levels still und leise; Override-Flag `EBAY_TRADING_COMPATIBILITY_LEVEL` existiert, aber kein automatisches Refresh.

## Owner / Docs

- **Code-Owner:** Backend-Team.
- **Externe Doku:**
  - OAuth + REST: [developer.ebay.com](https://developer.ebay.com/api-docs/static/oauth-tokens.html)
  - Trading API: [developer.ebay.com Trading reference](https://developer.ebay.com/devzone/xml/docs/reference/ebay/index.html)
  - Catalog API (beta): [developer.ebay.com Catalog](https://developer.ebay.com/api-docs/commerce/catalog/overview.html)
  - Browse API: [developer.ebay.com Browse](https://developer.ebay.com/api-docs/buy/browse/overview.html)
- **Webhook-Plattform:** [developer.ebay.com Notifications](https://developer.ebay.com/api-docs/commerce/notification/overview.html)
- **Verwandte KB-Seiten:**
  - [webhook-signing.md](webhook-signing.md) — Verifikations-Status
  - [serpapi.md](serpapi.md) — Sold-Listings-Fallback

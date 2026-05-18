---
title: API — Integrations
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# API — Integrations

Mount: `app.use('/api', integrationsRouter)` ([backend/index.js#L248](../../../backend/index.js#L248)). Globale `requireAuth` greift.

Quelle: [backend/routes/integrations.js](../../../backend/routes/integrations.js). Store: [backend/services/integration-store.js](../../../backend/services/integration-store.js). Registry: [backend/lib/integration-registry.js](../../../backend/lib/integration-registry.js).

Tenant-Source: `req.user?.tenantId || 'default'`.

Provider-IDs: `ebay`, `kaufland`, `sendcloud`, `sevdesk`, `dhl`. Status-Quellen pro Provider:

| Provider | Connected wenn ... |
|---|---|
| `ebay` | OAuth-Token in `integrations/ebay` (Firestore) ODER `integration-store` Status `active` |
| `kaufland` | Self-Service in `integrations_config` ODER Secret Manager `KAUFLAND_CLIENT_KEY` |
| `sendcloud` | Self-Service ODER Secret Manager `SENDCLOUD_PUBLIC_KEY` |
| `sevdesk` | Self-Service ODER Secret Manager `SEVDESK_API_TOKEN` |
| `dhl` | sendcloud connected (via `dependsOn`) |

---

### `GET /api/integrations/status`

- **Auth**: requireAuth
- **Tenant Source**: JWT
- **Request**: `(empty)`
- **Response**:
  ```json
  {
    "ok": true,
    "data": [
      {
        "id": "ebay",
        "name": "eBay",
        "description": "...",
        "category": "marketplaces",
        "authType": "oauth2",
        "status": "connected" | "not_connected",
        "connectedAt": "...",
        "details": { "env": "production", "scopes": [...], "accessTokenExpiresAt": "..." }
      },
      { "id": "kaufland", ..., "authType": "api_key" },
      { "id": "sendcloud", ... },
      { "id": "sevdesk", ... },
      { "id": "dhl", "dependsOn": "sendcloud", "authType": "none" }
    ]
  }
  ```
- **Side-Effects**: kombiniert Firestore (`integrations`-Doc für eBay, `integrations_config` für Self-Service) und Secret Manager.
- **Idempotency**: read.
- **Failure Modes**: `500 { code: 'INTERNAL' }`.
- **Source**: [backend/routes/integrations.js#L18-L106](../../../backend/routes/integrations.js#L18-L106)

---

### `GET /api/integrations/providers`

- **Auth**: requireAuth
- **Tenant Source**: none
- **Request**: `(empty)`
- **Response**: `{ "ok": true, "data": [{ "id": "...", "name": "...", "authType": "oauth2|api_key|none", "fields": [...], "features": [...], "helpUrl": "...", ... }] }`
- **Side-Effects**: liefert die statische Provider-Registry.
- **Idempotency**: read.
- **Failure Modes**: `500`.
- **Source**: [backend/routes/integrations.js#L112-L132](../../../backend/routes/integrations.js#L112-L132)

---

### `POST /api/integrations/:type/connect`

- **Auth**: `requirePermission('integrations', 'write')`
- **Tenant Source**: JWT
- **Request**:
  ```json
  { "credentials": { "<provider-spezifische Felder>": "..." } }
  ```
- **Response**: `{ "ok": true, "data": { "status": "active", "testMessage": "..." } }`
- **Side-Effects**:
  - `validateCredentialFields(type, credentials)` aus Registry.
  - `testConnection({ type, credentials })` ruft Provider-API (z.B. Kaufland-Auth, SendCloud-Whoami).
  - Erfolgreich → `saveIntegration({ tenantId, type, authType, credentials, actor })` (verschlüsselte Speicherung in `integrations_config/{tenantId}__{type}` — TBD - verify in code).
- **Idempotency**: idempotent — überschreibt bestehende Credentials.
- **Failure Modes**:
  - `400 { code: 'UNKNOWN_PROVIDER' }` für unbekannte ID.
  - `400 { code: 'USE_OAUTH' }` für eBay (→ `GET /api/ebay/oauth/start`).
  - `400 { code: 'NOT_CONFIGURABLE' }` für DHL (depends-on).
  - `400 { code: 'VALIDATION' }` wenn Pflichtfelder fehlen.
  - `400 { code: 'CONNECTION_FAILED' }` wenn Provider-API-Test scheitert.
- **Source**: [backend/routes/integrations.js#L139-L196](../../../backend/routes/integrations.js#L139-L196)

---

### `POST /api/integrations/:type/test`

- **Auth**: `requirePermission('integrations', 'read')`
- **Tenant Source**: JWT
- **Request**: `{ "credentials": {...} }` (optional — sonst aus Store geladen)
- **Response**: `{ "ok": true, "data": { "ok": true | false, "message": "..." } }`
- **Side-Effects**: führt Test-Call gegen Provider-API.
- **Idempotency**: read-ähnlich.
- **Failure Modes**:
  - `400 { code: 'UNKNOWN_PROVIDER' }`.
  - `400 { code: 'NO_CREDENTIALS' }` wenn keine Credentials angegeben/gespeichert.
- **Source**: [backend/routes/integrations.js#L202-L231](../../../backend/routes/integrations.js#L202-L231)

---

### `PUT /api/integrations/:type/settings`

- **Auth**: `requirePermission('integrations', 'write')`
- **Tenant Source**: JWT
- **Request**: `{ "settings": { /* provider-specific */ } }`
- **Response**: `{ "ok": true, "data": { ...result } }`
- **Side-Effects**: `updateSettings({ tenantId, type, settings })` mergt in das Integration-Doc.
- **Idempotency**: idempotent.
- **Failure Modes**:
  - `400 { code: 'VALIDATION' }` wenn `settings` kein Objekt.
  - `404 { code: 'NOT_FOUND' }` wenn Integration noch nicht verbunden.
- **Source**: [backend/routes/integrations.js#L237-L257](../../../backend/routes/integrations.js#L237-L257)

---

### `DELETE /api/integrations/:type`

- **Auth**: `requirePermission('integrations', 'write')`
- **Tenant Source**: JWT
- **Request**: `(empty)`
- **Response**: `{ "ok": true, "data": { ...deletionResult } }`
- **Side-Effects**:
  - `integrationStore.deleteIntegration({ tenantId, type })` wischt `integrations_config`.
  - Spezialfall `ebay`: zusätzlich `integrations/ebay`-Doc löschen (Token-Storage).
- **Idempotency**: idempotent.
- **Failure Modes**: `400 { code: 'UNKNOWN_PROVIDER' }`, `500`.
- **Source**: [backend/routes/integrations.js#L263-L287](../../../backend/routes/integrations.js#L263-L287)

---

### `GET /api/integrations/:type`

- **Auth**: `requirePermission('integrations', 'read')`
- **Tenant Source**: JWT
- **Request**: `(empty)`
- **Response**: `{ "ok": true, "data": { "id": "...", "name": "...", "status": "...", "settings": {...}, "fields": [...], "features": [...], "lastSync": "...", "lastError": null, "connectedBy": "..." } }`. Keine entschlüsselten Credentials.
- **Side-Effects**: read.
- **Idempotency**: read.
- **Failure Modes**: `400 { code: 'UNKNOWN_PROVIDER' }`.
- **Source**: [backend/routes/integrations.js#L293-L330](../../../backend/routes/integrations.js#L293-L330)

---

## Settings (Sync + Defaults)

Diese Endpoints cachen externe API-Daten (z.B. eBay Business Policies, Kaufland Warehouses) für die UI. Auto-Sync, wenn cached > `SYNC_TTL_MS` (24 h) alt.

Collection: `integration_settings/{tenantId}__{type}`.

### `GET /api/integrations/:type/config`

- **Auth**: `requirePermission('integrations', 'read')`
- **Tenant Source**: JWT
- **Request**: `(empty)`
- **Response**: `{ "ok": true, "data": { "tenantId": "...", "integration": "...", "cachedData": {...}, "lastSyncedAt": "...", "defaults": {...} } }`
- **Side-Effects**:
  - Read aus `integration_settings/{docId}`.
  - Wenn stale oder fehlt: `syncFromApi(type)` (eBay: Fulfillment/Return/Payment Policies via REST Account API; Kaufland: shipping groups + warehouses; SendCloud: sender addresses + shipping methods; SevDesk: tax rates + check accounts).
  - Bei Sync-Failure mit vorhandenen alten Daten: liefert stale Data + `syncError: "<msg>"`.
- **Idempotency**: read (Sync-Side-Effect ist idempotent).
- **Failure Modes**: `500` wenn kein Cache UND Sync fehlschlägt.
- **Source**: [backend/routes/integrations.js#L426-L471](../../../backend/routes/integrations.js#L426-L471)

#### eBay-Specifics

Verwendet `EBAY_MARKETPLACE_ID` ENV (default `EBAY_DE`). Bei HTTP 403 (fehlender `sell.account.readonly` Scope) liefert die Funktion ein leeres Array statt zu crashen — UI zeigt dann „keine Policies vorhanden". User muss eBay-OAuth re-authorisieren.

---

### `POST /api/integrations/:type/sync`

- **Auth**: `requirePermission('integrations', 'write')`
- **Tenant Source**: JWT
- **Request**: `(empty)`
- **Response**: `{ "ok": true, "data": { "tenantId": "...", "integration": "...", "cachedData": {...}, "lastSyncedAt": "..." } }`
- **Side-Effects**: forced `syncFromApi(type)` + write nach `integration_settings`.
- **Idempotency**: idempotent.
- **Failure Modes**: `500` bei API-Failure.
- **Source**: [backend/routes/integrations.js#L477-L500](../../../backend/routes/integrations.js#L477-L500)

---

### `PUT /api/integrations/:type/defaults`

- **Auth**: `requirePermission('integrations', 'write')`
- **Tenant Source**: JWT
- **Request**:
  ```json
  { "defaults": { "shippingGroupId": 144080, "warehouseId": 70462, "paymentPolicyId": "...", ... } }
  ```
- **Response**: `{ "ok": true, "data": { ...gespeicherte Doc-Felder } }`
- **Side-Effects**: merge in `integration_settings/{docId}.defaults`.
- **Idempotency**: idempotent.
- **Failure Modes**: `400 { code: 'VALIDATION' }` wenn `defaults` kein Objekt.
- **Source**: [backend/routes/integrations.js#L506-L532](../../../backend/routes/integrations.js#L506-L532)

Diese Defaults werden u.a. von `mergeKauflandOverrides` (für Kaufland-Publish) und `mergeEbayOverrides` (für eBay-Publish) verwendet — siehe [marketplace.md](marketplace.md).

---

## eBay-OAuth-Flow (in marketplaceRouter)

Tatsächlich liegen die OAuth-Endpoints im `marketplaceRouter` (`GET /api/ebay/oauth/start`, `GET /api/ebay/oauth/callback`). Hier nur als Querverweis:

- `GET /api/ebay/oauth/start` → liefert Consent-URL. Auth: `requirePermission('products', 'write')`.
- `GET /api/ebay/oauth/callback` → public (eBay-Redirect ohne Authorization), tauscht Code gegen Token, schreibt `integrations/ebay`.

Details siehe [marketplace.md](marketplace.md).

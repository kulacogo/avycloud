---
title: API — Settings
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# API — Settings

Mount: `app.use('/api', settingsRouter)` ([backend/index.js#L249](../../../backend/index.js#L249)). Globale `requireAuth` greift. **Keine** `requirePermission`-Checks im Router.

Quelle: [backend/routes/settings.js](../../../backend/routes/settings.js).

Tenant-Source: `req.user?.tenantId || 'default'`.

---

## Company-Settings

### `GET /api/settings/company`

- **Auth**: requireAuth
- **Tenant Source**: JWT
- **Request**: `(empty)`
- **Response**: `{ "ok": true, "data": { "firmenname": "...", "rechtsform": "...", "ustIdNr": "...", "iban": "...", "logoUrl": "...", ... } }` (oder `{}` wenn noch nichts gespeichert)
- **Side-Effects**: read `company_settings/{tenantId}`.
- **Idempotency**: read.
- **Failure Modes**: `500 { code: 'INTERNAL' }`.
- **Source**: [backend/routes/settings.js#L16-L26](../../../backend/routes/settings.js#L16-L26)

---

### `PUT /api/settings/company`

- **Auth**: requireAuth
- **Tenant Source**: JWT
- **Request** (Felder optional, nur erlaubte werden geschrieben):
  ```json
  {
    "firmenname": "TrendOcean GmbH",
    "rechtsform": "GmbH",
    "ustIdNr": "DE...",
    "steuernummer": "...",
    "strasse": "...", "plz": "...", "ort": "...", "land": "DE",
    "email": "...", "telefon": "...", "website": "...",
    "iban": "...", "bic": "...", "bank": "...", "inhaber": "...", "logoUrl": "..."
  }
  ```
  Whitelist hard-coded ([backend/routes/settings.js#L35-L40](../../../backend/routes/settings.js#L35-L40)) — alle anderen Felder werden ignoriert.
- **Response**: `{ "ok": true, "data": { ...gespeicherte Felder, "tenantId": "default", "updatedAt": "...", "updatedBy": "<uid>" } }`
- **Side-Effects**: merge auf `company_settings/{tenantId}`.
- **Idempotency**: idempotent.
- **Failure Modes**: `500`.
- **Source**: [backend/routes/settings.js#L32-L57](../../../backend/routes/settings.js#L32-L57)

---

## Profile-Settings

### `GET /api/settings/profile`

- **Auth**: requireAuth (zusätzlich expliziter `401`-Check wenn `req.user.uid` fehlt)
- **Tenant Source**: JWT
- **Request**: `(empty)`
- **Response**: `{ "ok": true, "data": { "email": "...", "displayName": "...", "tenantId": "default", "vorname": "...", "nachname": "...", "notifications": {...}, "theme": "...", "printing": {...} } }`
- **Side-Effects**: read `user_profiles/{uid}`, angereichert mit `req.user.email/name`.
- **Idempotency**: read.
- **Failure Modes**: `401`, `500`.
- **Source**: [backend/routes/settings.js#L65-L83](../../../backend/routes/settings.js#L65-L83)

---

### `PUT /api/settings/profile`

- **Auth**: requireAuth (+ expliziter 401-Check)
- **Tenant Source**: JWT
- **Request** (Whitelist `vorname`, `nachname`, `notifications`, `theme`, `printing`):
  ```json
  {
    "vorname": "...",
    "nachname": "...",
    "notifications": { "email": true, "push": false },
    "theme": "dark" | "light",
    "printing": { "labelFormat": "a6", ... }
  }
  ```
- **Response**: `{ "ok": true, "data": { ...gespeicherte Felder, "tenantId": "default", "updatedAt": "..." } }`
- **Side-Effects**: merge auf `user_profiles/{uid}`.
- **Idempotency**: idempotent.
- **Failure Modes**: `401`, `500`.
- **Source**: [backend/routes/settings.js#L89-L112](../../../backend/routes/settings.js#L89-L112)

---

## API Keys

### `GET /api/settings/api-keys`

- **Auth**: requireAuth
- **Tenant Source**: JWT
- **Request**: `(empty)`
- **Response**: `{ "ok": true, "data": [{ "id": "...", "tenantId": "default", "name": "...", "key": "avyc_...", "createdAt": "...", "lastAccess": null }] }`
- **Side-Effects**: read `api_keys where tenantId == default`. Erfordert composite index auf `(tenantId, createdAt DESC)`.
- **Idempotency**: read.
- **Failure Modes**: `500`.
- **Source**: [backend/routes/settings.js#L118-L131](../../../backend/routes/settings.js#L118-L131)

⚠️ Note: `key` wird im Klartext zurückgegeben. Es gibt aktuell keinen Code-Pfad der die generierten API-Keys irgendwo zur Authentifizierung gegen das Backend prüft — der Endpoint speichert sie nur (TBD - verify in code, ob ein eigener API-Key-Auth-Layer existiert).

### `POST /api/settings/api-keys`

- **Auth**: requireAuth
- **Tenant Source**: JWT
- **Request**: `{ "name": "Friendly Name" }`
- **Response**: `{ "ok": true, "data": { "id": "...", "key": "avyc_<hex48>", "name": "...", ... } }`
- **Side-Effects**: `api_keys.add(...)`. `key` = `avyc_${crypto.randomBytes(24).toString('hex')}` (48-char hex).
- **Idempotency**: none — jeder Call erzeugt einen neuen Key.
- **Failure Modes**: `500`.
- **Source**: [backend/routes/settings.js#L133-L152](../../../backend/routes/settings.js#L133-L152)

### `DELETE /api/settings/api-keys/:id`

- **Auth**: requireAuth
- **Tenant Source**: implizit über Key-Doc (TBD - verify in code, ob Cross-Tenant-Delete geblockt wird)
- **Request**: `(empty)`
- **Response**: `{ "ok": true }`
- **Side-Effects**: Firestore-Delete.
- **Idempotency**: idempotent.
- **Failure Modes**: `500`.
- **Source**: [backend/routes/settings.js#L154-L162](../../../backend/routes/settings.js#L154-L162)

---

## Webhooks (Outbound, kundeneigene Webhooks)

Nicht zu verwechseln mit den eingehenden Marketplace-Webhooks aus [webhooks.md](webhooks.md). Diese hier sind kundeneigene Outbound-Notifications.

### `GET /api/settings/webhooks`

- **Auth**: requireAuth
- **Tenant Source**: JWT
- **Request**: `(empty)`
- **Response**: `{ "ok": true, "data": [{ "id": "...", "url": "...", "events": [...], "active": true, "secret": "..." }] }`
- **Side-Effects**: read `webhooks where tenantId == default` (kein orderBy → kein Composite-Index nötig).
- **Idempotency**: read.
- **Failure Modes**: `500`.
- **Source**: [backend/routes/settings.js#L166-L178](../../../backend/routes/settings.js#L166-L178)

### `POST /api/settings/webhooks`

- **Auth**: requireAuth
- **Tenant Source**: JWT
- **Request**: `{ "url": "https://...", "events": ["order.created"], "active": true }`
- **Response**: `{ "ok": true, "data": { "id": "...", "url": "...", "secret": "<hex64>", ... } }`
- **Side-Effects**: Firestore-Write. `secret = crypto.randomBytes(32).toString('hex')` — vermutlich für HMAC-Signierung des Outbound-Payloads (TBD - verify in code, welcher Service tatsächlich postet).
- **Idempotency**: none.
- **Failure Modes**: `400` ohne `url`. `500`.
- **Source**: [backend/routes/settings.js#L180-L201](../../../backend/routes/settings.js#L180-L201)

### `DELETE /api/settings/webhooks/:id`

- **Auth**: requireAuth
- **Tenant Source**: implizit (TBD - verify in code)
- **Request**: `(empty)`
- **Response**: `{ "ok": true }`
- **Side-Effects**: Firestore-Delete.
- **Idempotency**: idempotent.
- **Failure Modes**: `500`.
- **Source**: [backend/routes/settings.js#L203-L211](../../../backend/routes/settings.js#L203-L211)

> Vergleich mit `/api/v1/webhooks` aus [products.md](products.md) — die liegen im `productsRouter` und nutzen den Service `services/webhooks.js`, NICHT diese `webhooks`-Collection. Doppel-Implementation; TBD - verify in code welcher Pfad live ist.

---

## Billing-Usage

### `GET /api/settings/billing/usage`

- **Auth**: requireAuth
- **Tenant Source**: JWT
- **Request**: `(empty)`
- **Response**:
  ```json
  {
    "ok": true,
    "data": {
      "tenantId": "default",
      "products": { "current": 1234, "max": 5000 },
      "orders":   { "current": 56,   "max": 2000 },
      "integrations": { "current": 5, "max": 10 }
    }
  }
  ```
- **Side-Effects**: Firestore `.count()`-Aggregations auf `products_v2` (alle, global — kein Tenant-Filter) und `orders where createdAt >= startOfMonth`. `integrations.current` ist **hardcoded auf 5** — keine echte Zählung.
- **Idempotency**: read.
- **Failure Modes**: `500`.
- **Source**: [backend/routes/settings.js#L215-L246](../../../backend/routes/settings.js#L215-L246)

⚠️ Bekannte Limitierungen:
- Products-Count ignoriert `tenantId`.
- Integrations-Count ist Konstante.
- Order-Count nutzt `createdAt`-String-Vergleich — funktioniert nur weil ISO-Strings lexikografisch sortierbar sind.

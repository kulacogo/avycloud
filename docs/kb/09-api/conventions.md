---
title: API — Conventions
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# API — Konventionen & Cross-Cutting Concerns

Quelle: [backend/index.js](../../../backend/index.js).

## URL-Prefix

Alle Anwendungs-Routen leben unter **`/api`**. Health-Endpoints (`GET /`, `GET /health`, `GET /ready`) sind die einzigen Routen ohne Prefix und ohne Auth.

Stale-Frontends mit `/app/api/*` werden serverseitig auf `/api/*` umgeschrieben ([backend/index.js#L189-L205](../../../backend/index.js#L189-L205)). Das Backend setzt dann den Response-Header `X-Avycloud-App-Api-Normalized: 1`.

## Auth-Modell

Default-Deny ([backend/index.js#L232-L239](../../../backend/index.js#L232-L239)): jede Anfrage unter `/api/*` durchläuft `requireAuth` (siehe [backend/lib/auth.js](../../../backend/lib/auth.js)). Die Allowlist umfasst nur:

| Route | Grund |
|---|---|
| `OPTIONS *` | CORS-Preflight |
| `GET /api/image-proxy` | `<img src>` kann keine Header senden |
| `GET /api/ebay/oauth/callback` | eBay-Redirect ohne Authorization |
| `POST /api/auth/*` | Public-Auth-Endpoints (z.B. Password-Reset) |
| `POST /api/webhooks/*` | M2M-Webhooks von SendCloud / Kaufland / eBay |

`requireAuth` extrahiert `Bearer <jwt>` aus dem `Authorization`-Header (oder aus `?token=...` für SSE — wird in `/api`-Middleware in den Header kopiert, [backend/index.js#L209-L214](../../../backend/index.js#L209-L214)) und ruft Firebase Admin `verifyIdToken(idToken, true)` auf. Konstanten:

- E-Mail-Domain muss `AUTH_ALLOWED_EMAIL_DOMAIN` matchen (default `trendocean.de`).
- Bootstrap-Admin (`AUTH_BOOTSTRAP_ADMIN_EMAIL`, default `admin@trendocean.de`) darf ohne `email_verified` durch.
- Nach erfolgreichem Verify liegt `req.user = { uid, email, isAdmin, emailVerified, claims }`.

### `requirePermission(module, action)`

Siehe [backend/lib/rbac.js#L354-L402](../../../backend/lib/rbac.js#L354-L402). Logik:

1. `isAdmin === true` (Bootstrap-Admin) ⇒ alles erlaubt.
2. Sonst Lookup `users/{uid}` ⇒ `roles[]` (direct) + `groupIds[]` (indirect via `groups/{gid}.roleIds`).
3. Merge der Rollen-Permissions (OR), dann anwenden der per-User-`overrides` (allow/deny). Deny gewinnt.
4. Wildcard-Regeln: `permissions['*']['*'] === true` ⇒ all-access; `permissions[module]['*'] === true` ⇒ alle Actions im Modul.

Default-Rollen werden beim Startup via `ensureDefaultRoles()` ([backend/lib/rbac.js#L20-L75](../../../backend/lib/rbac.js#L20-L75)) angelegt: `admin`, `manager`, `operation`, `catalog`.

Permission-Module die in den Routes referenziert werden: `admin`, `dashboard`, `products`, `categories`, `warehouse`, `inventories`, `orders`, `identify`, `jobs`, `ai`, `integrations`. Actions u.a. `read`, `write`, `delete`, `pick`, `pack`, `chat`, `improve`, `run`, `users.read`, `users.write`, `groups.read`, `groups.write`, `roles.read`, `roles.write`, `llm.read`, `llm.write`, `rules.read`, `rules.write`, `jobs.read`, `jobs.run`, `webhooks.read`, `webhooks.write`, `products.write`.

### Failure-Shape

```json
{ "ok": false, "error": { "code": 401, "message": "Missing Authorization bearer token" } }
```

Für RBAC-Verweigerung: `403` mit `message: "Forbidden: missing permission <module>.<action>"`.

## Standard-Antwort-Shape

Erfolg:

```json
{ "ok": true, "data": <payload> }
```

Variationen, die im Code vorkommen:

- Einige Endpoints schreiben das Hauptobjekt direkt als Top-Level-Feld (`{ ok: true, products: [...] }`, `{ ok: true, inventories: [...] }`, `{ ok: true, movements: [...] }`). Siehe individuelle Endpoint-Dokus.
- Paginierte Listen tragen oft `meta: { total, limit, offset, hasMore }` (z.B. `GET /api/orders`).
- Cursor-basierte Listen tragen `nextCursor` + `hasMore` (z.B. `GET /api/jobs`).

Fehler:

```json
{
  "ok": false,
  "error": {
    "code": "INTERNAL" | "VALIDATION" | "NOT_FOUND" | "FORBIDDEN" | 400 | 404 | 500 | ...,
    "message": "Lesbarer Klartext",
    "details": "optional, oft error.message"
  }
}
```

Der `code`-Slot ist **uneinheitlich**: manche Routen schreiben numerische Status (`400`, `404`, `500`), andere String-Enums (`VALIDATION`, `INTERNAL`, `NOT_FOUND`, `BAD_REQUEST`, `RATE_LIMITED`, marketplace-spezifische wie `KAUFLAND_EAN_INVALID`). Frontend muss beides tolerieren.

## CORS

Allow-List ([backend/index.js#L101-L118](../../../backend/index.js#L101-L118)):

- `https://avycloud.web.app`
- `https://avycloud.firebaseapp.com`
- `http://localhost:5173` / `http://127.0.0.1:5173`
- `http://localhost:3000` / `http://127.0.0.1:3000`

Verbotene Origins ⇒ `403 { ok: false, error: { code: 403, message: "Origin not allowed by CORS policy." } }`.

## Request-Body-Limit

`express.json({ limit: REQUEST_BODY_LIMIT })` und `express.urlencoded({ extended: true, limit: REQUEST_BODY_LIMIT })`. Default: **`50mb`** ([backend/index.js#L37-L40](../../../backend/index.js#L37-L40)).

Override via `API_REQUEST_BODY_LIMIT` oder `REQUEST_BODY_LIMIT`. Die hohe Grenze ist nötig für Identify-Pipelines (Multipart Image Uploads gehen über `multer`-Memory-Storage mit eigenen Limits — typischerweise 10 MB pro Bild, max. 30 Dateien).

## Rate Limiting

Quelle: [backend/lib/rate-limit.js](../../../backend/lib/rate-limit.js).

| Limiter | Window | Max | Scope |
|---|---|---|---|
| `generalLimiter` | 60 s | 120 req | global auf alle Routen, key = `req.user?.uid || req.ip` |
| `identifyLimiter` | 15 min | 30 req | nur Identify- und Chat-Endpoints, key = `req.user?.uid || req.ip` |

Über-Limit ⇒ `429 { ok: false, error: { code: "RATE_LIMITED", message: "Too many requests..." } }`. Headers folgen `standardHeaders: true` (RFC-konform).

## Tenant-ID-Propagation

`req.user.tenantId` wird im aktuellen Code-Stand **nicht** durch `requireAuth` gesetzt — der JWT-Decode in [backend/lib/auth.js](../../../backend/lib/auth.js) übernimmt nur `uid`, `email`, `isAdmin`. Das bedeutet alle Routen fallen auf `'default'` zurück:

```js
const tenantId = req.user?.tenantId || 'default';
```

Was bedeutet das praktisch?

- **Single-Tenant-Default**: alle Production-Reads/Writes verwenden `tenantId === 'default'`.
- Multi-Tenant-Aktivierung ist im Code vorbereitet (z.B. `getAllProductsForTenant`, `runForEachBackgroundJobTenant`, `BACKGROUND_JOB_TENANTS`-ENV), aber das Frontend / der Auth-Layer setzen den Wert noch nicht in den User-Claims.
- Einige Routen erlauben `tenantId` im Body zu überschreiben (z.B. Admin Bulk-Jobs, Stock force-resync, batch-optimize), dann gewinnt der Body.
- **TBD - verify in code**: ob Tenant-Mismatch im Auth-Layer geprüft wird. Aktuell prüfen nur einzelne Routen (z.B. `POST /api/admin/stock/force-resync` → 403 bei Mismatch).

## Idempotency

Es gibt **kein zentrales Idempotency-Key-System**. Stattdessen:

- Webhooks: alle drei (SendCloud, Kaufland, eBay) antworten konsequent mit `200 OK` — auch bei Fehlern — damit Marketplaces nicht retryen. Idempotenz wird durch Lookup auf `sendcloudParcelId`/`order_id` erreicht (siehe [webhooks.md](webhooks.md)).
- Order-State-Machine: `transitionOrder()` ist idempotent für „bereits in Zielzustand"-Fälle (es ist legitim, denselben Übergang zweimal zu pushen). Stock-Decrement-Marker `orders/{id}.stockDecrementedAt` schützt vor Doppel-Decrement (siehe CLAUDE.md Punkt 13).
- Bulk-Jobs (`/api/admin/bulk/run`, `/api/v1/rules/:id/execute`, `/api/admin/rulebook/apply`): Antwort `202` + `jobId`. Polling via `GET /api/admin/bulk/jobs/:id`. Mehrfaches Enqueueing erzeugt neue Jobs — nicht idempotent.
- Inventory-Save/Save-Product: Identity-Aliases (`buildIdentityAliasSet`) führen zu Merge statt Duplikaten — semantisch idempotent für gleiche Identität (EAN/SKU/GTIN).

Falls ein Caller echte HTTP-Idempotenz braucht, muss er das selbst über Polling (Job-IDs) abbilden.

## Mount-Reihenfolge (gilt für Route-Konflikte)

Aus [backend/index.js#L227-L254](../../../backend/index.js#L227-L254):

1. `app.use('/api/auth', authRouter)` — public
2. `app.use('/api', webhooksRouter)` — public (vor Auth-Middleware)
3. **Default-Deny `requireAuth`** für alles unter `/api`
4. `app.use('/api/warehouse', warehouseRouter)`
5. `app.use('/api/admin', adminRouter)`
6. `app.use('/api', ordersRouter)`
7. `app.use('/api', identifyRouter)`
8. `app.use('/api', productsRouter)`
9. `app.use('/api', marketplaceRouter)` — Endpoints liegen direkt unter `/api/...` (kein `/marketplace`-Prefix)
10. `app.use('/api', integrationsRouter)`
11. `app.use('/api', settingsRouter)`
12. `app.use('/api', returnsRouter)`
13. `app.use('/api', invoicesRouter)`
14. `app.use('/api/v1/rules', rulesRouter)`
15. `app.use('/api/sessions', sessionsRouter)`
16. `app.use('/api', sseRouter)`

Da viele Router auf `/api` gemounted sind, gewinnt der erste Treffer in dieser Reihenfolge. Beispiel: `/api/inventories` ist sowohl in `productsRouter` (limit/search basiert) als auch in `warehouseRouter` (zonen-basiert) definiert — siehe individuelle Dokus.

## SSE (Server-Sent Events)

Endpoints die `text/event-stream` liefern:

| Route | Mount | Zweck |
|---|---|---|
| `GET /api/events` | sseRouter | globaler Bus für Order/Stock/Listing-Events |
| `GET /api/products/stream` | productsRouter | Realtime Firestore `onSnapshot` für `products_v2` |
| `GET /api/jobs/:id/stream` | identifyRouter | Job-Status-Updates |
| `POST /api/chat?stream=true` | identifyRouter | Chat-Token-Streaming |

EventSource kann keine Authorization-Header senden — daher kopiert die `/api`-Middleware automatisch `?token=<jwt>` in den Authorization-Header ([backend/index.js#L209-L214](../../../backend/index.js#L209-L214)).

## Side-Effects

Viele Schreib-Endpoints emittieren `sync-event-bus`-Events, die von Background-Runnern aufgegriffen werden. Standard-Events:

- `order:created`, `order:updated`, `order:status_changed`
- `return:created`, `return:status_changed`
- `shipment:created`, `shipment:updated`
- `stock:changed`
- `listings:sync_completed`

Diese Events fließen via SSE-Endpoint zum Frontend zur React-Query-Invalidation (siehe [sse.md](sse.md)).

## Stock-Mutationen — Hard Rules

Aus CLAUDE.md Punkt 10–13:

- Jede `products_v2.inventory.quantity`-Mutation läuft über `saveProductV2()` oder `lib/warehouse.js` und emittiert `stock:changed`.
- `bookStockOut` mit `meta.orderId` muss `claimOrderStockDecrementInTx()` im selben Firestore-Tx aufrufen (Single-Writer-Invariant).
- `omsStatus`-Übergänge ausschließlich via `transitionOrder()` aus [services/order-state-machine.js](../../../backend/services/order-state-machine.js).

Die Routes setzen das vor — Direct-Writes auf `omsStatus` oder `inventory.quantity` sind in neuem Code verboten.

## Quellen-Index

- [backend/index.js](../../../backend/index.js) — Mount-Order, Middleware-Stack, Body-Limit, Background-Jobs
- [backend/lib/auth.js](../../../backend/lib/auth.js) — JWT-Verifikation, Domain-Allow-List
- [backend/lib/rbac.js](../../../backend/lib/rbac.js) — Rollen, Permissions, Overrides, Default-Rollen
- [backend/lib/rate-limit.js](../../../backend/lib/rate-limit.js) — Limiter-Konfiguration
- [services/sync-event-bus.js](../../../backend/services/sync-event-bus.js) — Event-Namen (TBD - verify in code)
- [services/order-state-machine.js](../../../backend/services/order-state-machine.js) — `transitionOrder` Vertrag

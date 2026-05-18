---
title: API — Webhooks
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# API — Webhooks

Mount: `app.use('/api', webhooksRouter)` ([backend/index.js#L230](../../../backend/index.js#L230)). **Vor** der globalen `requireAuth`-Middleware → diese Endpoints sind public M2M-Endpoints.

Quelle: [backend/routes/webhooks.js](../../../backend/routes/webhooks.js).

## ⚠️ Signature-Verifikation — bekannte Lücken

Diese Aussagen entsprechen dem aktuellen Code in [backend/routes/webhooks.js](../../../backend/routes/webhooks.js). Sie spiegeln **bekannte Hardening-Gaps** wider, die in operativen Plänen / dem Hardening-Plan dokumentiert sind. NICHT als „secure" annehmen:

### SendCloud — schwach (Basic-Auth-Heuristik)

Wenn `SENDCLOUD_SECRET_KEY` aus Secret Manager auflösbar ist, prüft der Code:

1. `Authorization: Basic <base64(public:secret)>` ⇒ Base64-decoden, dann `decoded.includes(webhookSecret)`.
2. Oder `?secret=<value>` in der Query, Vergleich via `===`.

**Schwächen**:
- Bei fehlendem Secret (Secret Manager nicht erreichbar, default-leer) wird `verified` **gar nicht geprüft** — der Webhook wird angenommen.
- `String.includes` statt `crypto.timingSafeEqual` → potenziell timing-anfällig.
- Query-String-Secret loggt potenziell in Cloud-Run-Access-Logs.

### Kaufland — HMAC vorhanden, aber bypassed wenn Secret fehlt

`KAUFLAND_WEBHOOK_SECRET` aus Secret Manager. Wenn vorhanden:

- Erwartet Header `x-kaufland-signature` oder `x-signature`.
- HMAC-SHA256 über `rawBody` (gebildet aus `req.body` per `JSON.stringify` falls schon geparst — **das Re-Stringify kann zur Signatur-Mismatch führen, weil Kaufland die Original-Bytes signiert hat**).
- `crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))` (ok).

**Schwächen**:
- Bei `webhookSecret == null` (Secret nicht verfügbar) wird die Prüfung übersprungen ⇒ jeder unsignierte Call wird verarbeitet.
- Express hat `req.body` bereits geparst und `body-parser` verwirft die Original-Bytes → `JSON.stringify(req.body)` rekonstruiert NICHT zwangsläufig das exakte Original (Key-Order, Whitespace) → echte HMAC-Validation funktioniert nur, wenn Kaufland mit identischem Stringify signiert.

### eBay — Signatur-Verifikation **fehlt komplett**

Im aktuellen Handler ([backend/routes/webhooks.js#L293-L349](../../../backend/routes/webhooks.js#L293-L349)) gibt es **keinerlei HMAC- oder Token-Verifikation** für eingehende Notifications. Nur der Challenge-Code (GET-Verifikation) wird über `EBAY_WEBHOOK_VERIFICATION_TOKEN` korrekt geantwortet — aber das Token wird bei POST-Events **nicht** geprüft.

**Risiko**: jeder kann ohne Auth `POST /api/webhooks/ebay` mit beliebigem `metadata.topic` aufrufen und damit Sync-Events emittieren (DoS / Order-Sync-Forced-Trigger).

### Konsequenz

- **Niemand soll diese Webhooks als „authentifiziert" annehmen**, solange das Hardening offen ist.
- Sync-Events die diese Webhooks emittieren sind **best-effort** — die echte Datenquelle ist immer der Marketplace-API-Pull aus den Background-Runnern.
- Hardening-Plan: TBD - verify in code (siehe `docs/runbooks/` und `TASKS.md` für Status).

---

## Endpoints

### `POST /api/webhooks/sendcloud`

- **Auth**: none (vor `requireAuth`); optionaler Basic-Auth/Query-Secret-Check (siehe oben)
- **Tenant Source**: `shipData.tenantId || 'default'` (aus `shipments`-Doc nachgeladen)
- **Request**: SendCloud Parcel-Status-Payload, vereinfacht:
  ```json
  {
    "parcel_id": 12345,
    "status": { "id": 11, "message": "Delivered" },
    "tracking_number": "JJD000...",
    "parcel": { "tracking_url": "https://..." }
  }
  ```
- **Response**: **immer `200`** (verhindert SendCloud-Retries — auch bei Fehlern). Body z.B. `{ ok: true }`, `{ ok: false, error: "unauthorized" }`, `{ ok: true, skipped: "no parcel_id" }`, `{ ok: true, skipped: "unknown parcel" }`.
- **Side-Effects**:
  - Lookup `shipments where sendcloudParcelId == parcel_id LIMIT 1`.
  - Update Shipment-Doc: `status`, `statusId`, `trackingNumber`, `trackingUrl`, `updatedAt`.
  - Wenn Status auf `shipped` oder `delivered` mappt:
    - `transitionOrder()` aus [services/order-state-machine.js](../../../backend/services/order-state-machine.js) (force=true, actor `sendcloud-webhook`). Triggert Stock-Decrement.
    - Fallback `processShippedOrder()` falls Transition bei `shipped` fehlschlägt.
    - Tracking-Backfill auf Order-Doc.
  - Sonst Direct-Update auf `orders/{id}.omsStatus` + Event in `order_events`-Collection.
  - Emit `shipment:updated` Sync-Event.
- **Idempotency**: idempotent. Multi-Delivery aus SendCloud führt zu erneuten Transitions, aber `transitionOrder` ist robust gegen „bereits in Zielzustand".
- **Failure Modes**: alle Fehler werden gefangen und mit `200` quittiert.
- **Source**: [backend/routes/webhooks.js#L58-L222](../../../backend/routes/webhooks.js#L58-L222)

#### Status-Mapping

| SendCloud `status.id` | OMS Status |
|---|---|
| 1 | `null` (announced) |
| 3–8 | `shipped` |
| 11, 12, 62 | `delivered` |
| 15, 32, 33 | `returned` |
| 2000, 80, 1002, 1337 | `null` (cancelled / exception / nicht versandfertig) |

---

### `POST /api/webhooks/kaufland`

- **Auth**: none (vor `requireAuth`); HMAC-SHA256 wenn `KAUFLAND_WEBHOOK_SECRET` gesetzt — siehe Hardening-Warnung oben.
- **Tenant Source**: hardcoded `'default'` ([backend/routes/webhooks.js#L258](../../../backend/routes/webhooks.js#L258))
- **Request**:
  ```json
  {
    "event_name": "new_order" | "order_unit_status_changed" | "order_cancelled" | "return_created" | "...",
    "data": { "id_order": "...", "id_return": "..." }
  }
  ```
- **Response**: immer `200`. `{ ok: true }` oder `{ ok: false, error: "invalid signature" }`.
- **Side-Effects**: emit `order:updated` oder `return:created` Sync-Event (siehe Mapping unten). Background-Runner pullt dann die echten Daten via Marketplace-API.
- **Idempotency**: idempotent — Re-Notifications triggern nur erneuten Sync.
- **Failure Modes**: alle Fehler werden gefangen und mit `200` quittiert. Bei Signature-Mismatch: `200 { ok: false, error: 'invalid signature' }`.
- **Source**: [backend/routes/webhooks.js#L230-L285](../../../backend/routes/webhooks.js#L230-L285)

#### Event-Mapping

| Kaufland `event_name` Substring | Emittiertes Bus-Event |
|---|---|
| `new_order`, `order_unit_status_changed`, `order_cancelled`, `order_shipped` | `order:updated` |
| `return_created`, `return_updated`, `return_accepted`, `return_rejected` | `return:created` |
| (sonst) | `order:updated` mit `entityId: "kaufland-unknown"` |

---

### `POST /api/webhooks/ebay`

- **Auth**: none (vor `requireAuth`); **keine Signature-Verifikation** im POST-Pfad — siehe Hardening-Warnung oben.
- **Tenant Source**: hardcoded `'default'`
- **Request**:
  ```json
  { "metadata": { "topic": "MARKETPLACE_ORDER_CREATED" | "..." }, "resource": { "orderId": "..." } }
  ```
  Oder XML-Notifications mit `NotificationEventName` (TBD - verify in code, der Express-`json`-Parser kann das nicht parsen — XML-Events landen dann mit leerem `body`).
- **Response**:
  - GET-Challenge (Verifikation): `200 { challengeResponse: <sha256(challenge_code + verification_token + endpoint)> }`. Quelle: [backend/routes/webhooks.js#L334-L342](../../../backend/routes/webhooks.js#L334-L342). Verwendet ENV `EBAY_WEBHOOK_VERIFICATION_TOKEN` und `EBAY_WEBHOOK_ENDPOINT`.
  - POST-Notifications: immer `200 { ok: true }` oder `200 { ok: false, error: <msg> }`.
- **Side-Effects**:
  - `MARKETPLACE_ACCOUNT_DELETION`-Topic → kein Side-Effect, nur `200 OK` (GDPR-Pflicht).
  - Order-Topics emittieren `order:updated`, Return-Topics `return:created`.
- **Idempotency**: ja (Re-Notifications triggern nur Sync-Polls).
- **Failure Modes**: alle Fehler werden mit `200` beantwortet.
- **Source**: [backend/routes/webhooks.js#L293-L349](../../../backend/routes/webhooks.js#L293-L349)

#### Notification-Type-Mapping

| eBay `metadata.topic` enthält | Bus-Event |
|---|---|
| `MARKETPLACE_ORDER_CREATED`, `MARKETPLACE_ORDER_COMPLETED`, `ORDER_CREATED`, `FIXED_PRICE_TRANSACTION`, `CHECKOUT_COMPLETE`, `ORDER_STATUS_CHANGE` | `order:updated` |
| `RETURN_CREATED`, `RETURN_CLOSED`, `RETURN_ESCALATED`, `ITEM_RETURNED` | `return:created` |
| `MARKETPLACE_ACCOUNT_DELETION` | (none — GDPR-Ack) |

---

## Empfehlung für Caller

- SendCloud / Kaufland / eBay sollten so konfiguriert sein, dass sie **Original-Bytes** zur HMAC-Validation liefern (raw body capture). Aktuell verbraucht `express.json()` die Bytes vor Erreichen des Routers → echte HMAC-Validation müsste ein eigener `raw`-Body-Parser-Middleware-Branch sein.
- Webhook-URLs in den Marketplace-Settings unbedingt mit langem `?secret=<random>`-Token (für SendCloud) und/oder einer harten Allow-List auf eBay/Kaufland-IP-Bereiche im Cloud Run / Load Balancer absichern, bis die Code-Hardening-Aktion durch ist.
- Solange das nicht gefixt ist, **darf kein Sicherheits-Audit diese Endpoints als „authenticated" listen**.

---
title: "Integration: Webhook Signing & Verification — Status"
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# Webhook Signing & Verification

> Quelle für die Verifikations-Logik: [backend/routes/webhooks.js](../../../backend/routes/webhooks.js).
> Diese Seite ist **bewusst explizit** über aktuelle Schwächen — sie ist Teil des Hardening-Plan-Findings „Webhook-Verifikation lückenhaft / fail-open / vermutlich gebrochen".

## TL;DR — aktueller Stand

| Provider | Signatur / Auth | Verifikation im Code | Status | Risiko |
|----------|-----------------|----------------------|--------|--------|
| **eBay** | Challenge-Hash (nur GDPR-Endpoint) | **keine** Signatur-Verifikation für Notifications | **OFFEN** | Spoofing trivial, jeder POST triggert `emitSyncEvent` |
| **Kaufland** | HMAC-SHA256 in `X-Kaufland-Signature` | Code vorhanden, aber **vermutlich gebrochen** (HMAC über re-serialized body) | **DEFEKT (vermutet)** | Entweder fail-closed (gut, aber keine echten Updates) oder fail-open (Secret fehlt) |
| **SendCloud** | Basic-Auth oder Query-Secret | Code vorhanden, aber **fail-open ohne Secret** | **TEILWEISE** | Wenn `SENDCLOUD_SECRET_KEY` fehlt: jeder POST akzeptiert |

Quelle pro Provider: jeweils der `router.post('/webhooks/<provider>')`-Handler in [backend/routes/webhooks.js](../../../backend/routes/webhooks.js).

## Pro Provider

### eBay — `POST /api/webhooks/ebay`

**Was wird signiert (laut eBay-Doku):**

- Marketplace Account Deletion (GDPR-Endpoint): Challenge-Code-Echo mit `sha256(challenge_code + verificationToken + endpoint)`.
- Platform Notifications (REST / Trading): eBay sendet `X-EBAY-SIGNATURE` (JWS) — Verifikation gegen den Public-Key, der über `GET /commerce/notification/v1/public_key/{public_key_id}` geholt wird (siehe [eBay Notification API Public Keys](https://developer.ebay.com/api-docs/commerce/notification/resources/public_key/methods/getPublicKey)).

**Was im Code passiert:**

```js
router.post('/webhooks/ebay', async (req, res) => {
  // Challenge-Handshake bei ?challenge_code=...
  if (req.query.challenge_code) {
    const hash = crypto.createHash('sha256')
      .update(req.query.challenge_code + verificationToken + endpoint)
      .digest('hex');
    return res.status(200).json({ challengeResponse: hash });
  }
  // ELSE: einfach den Body parsen und emitSyncEvent
});
```

- **KEINE** JWS-Verifikation gegen den eBay-Public-Key.
- **KEINE** `X-EBAY-SIGNATURE`-Prüfung.
- Topic-Mapping läuft auf string-Inclusion (`notificationType.includes('MARKETPLACE_ORDER_CREATED')`).
- `EBAY_WEBHOOK_VERIFICATION_TOKEN` und `EBAY_WEBHOOK_ENDPOINT` werden nur für den Challenge-Hash genutzt, nicht für Body-Verifikation.

**Konkretes Risiko:**

- Spoofing: jeder, der den Endpoint kennt, kann beliebige Order-/Return-Updates triggern.
- Side-Effects: `emitSyncEvent('order:updated' | 'return:created')` löst Sync-Cascades aus, die Marketplace-Calls verursachen (= echte API-Calls + ggf. State-Änderungen).
- DoS: kein Rate-Limit am Endpoint.

**Hardening-Plan-Eintrag:** JWS-Verifikation gegen Public-Key implementieren (eBays neuere Notification-Plattform sendet das per Default; Trading-API-Notifications haben kein JWS und brauchen eigene Signatur-Header — historisch fragiler).

### Kaufland — `POST /api/webhooks/kaufland`

**Was wird signiert (laut Kaufland-Doku):**

- HMAC-SHA256 über den **raw request body** mit `KAUFLAND_WEBHOOK_SECRET`. Sent als `X-Kaufland-Signature`-Header (Hex).

**Was im Code passiert:**

```js
const webhookSecret = await getSecretValue('KAUFLAND_WEBHOOK_SECRET').catch(() => null);
if (webhookSecret) {
  const signature = req.headers['x-kaufland-signature'] || req.headers['x-signature'] || '';
  const rawBody = typeof req.body === 'string'
    ? req.body
    : JSON.stringify(req.body || {});            // ← Re-Serialization
  const expected = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
  if (!signature || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return res.status(200).json({ ok: false, error: 'invalid signature' });
  }
}
```

**Problem:**

- `express.json()` läuft VOR diesem Handler. `req.body` ist ein deserialisiertes Objekt.
- `JSON.stringify(req.body || {})` reproduziert **NICHT** byte-identisch den Original-Stream (Whitespace, Key-Order, Number-Precision).
- HMAC ist deterministisch über Bytes — Re-Serialization erzeugt fast garantiert einen anderen Hash.
- **Konsequenz:** wenn das Secret gesetzt ist, scheitern ECHTE Kaufland-Webhooks. Wenn das Secret nicht gesetzt ist (`webhookSecret === null`), wird der ganze Verifikations-Block **übersprungen** — fail-open.
- `timingSafeEqual` wirft, wenn die Buffer-Längen unterschiedlich sind — fängt das nicht ab. Bei `signature === ''` (kein Header) wirft das `RangeError`. Der Outer-`try` fängt das ab und antwortet `200 + error` — Webhook wird nicht verarbeitet, aber auch nicht 4xx zurück.

**Korrekte Implementierung (Hardening-Plan):**

- Express `raw-body`-Middleware NUR für diesen Endpoint: `app.use('/api/webhooks/kaufland', express.raw({ type: 'application/json' }))`, dann HMAC über das `Buffer` rechnen UND danach `JSON.parse(body)` für den Handler.
- Mismatch / fehlende Signatur → `401`, nicht `200`.
- Secret-Pflicht: ohne Secret → log warn + reject.

### SendCloud — `POST /api/webhooks/sendcloud`

**Was wird signiert (laut SendCloud-Doku):**

- SendCloud bietet historisch **keine HMAC-Signatur**. Verifikation läuft über **Basic-Auth-Header** (`public_key:secret_key`) oder optional über einen Query-Param-Secret.

**Was im Code passiert:**

```js
const webhookSecret = await getSecretValue('SENDCLOUD_SECRET_KEY').catch(() => null);
if (webhookSecret) {
  const authHeader = req.headers.authorization || '';
  const querySecret = req.query?.secret || '';
  let verified = false;
  if (authHeader.startsWith('Basic ')) {
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf-8');
    verified = decoded.includes(webhookSecret);      // ← contains, not equal
  }
  if (!verified && querySecret === webhookSecret) verified = true;
  if (!verified) return res.status(200).json({ ok: false, error: 'unauthorized' });
}
```

**Probleme:**

1. **Fail-open ohne Secret.** `getSecretValue(...).catch(() => null)` → `webhookSecret === null` überspringt den ganzen Block. Wenn das Secret im Manager fehlt: jeder POST akzeptiert.
2. **`decoded.includes(webhookSecret)` statt `decoded === public:secret`.** Theoretisches Match auf jede Substring-Inclusion. Praktisch wahrscheinlich nicht ausnutzbar (Basic-Auth-Format ist eng), aber Codestil ist fail-loose.
3. **Query-Secret-Match** macht den Secret-Wert in Log-Files auftauchen — Query-Strings landen in Cloud-Logging und ggf. in Proxy-Access-Logs.

**Konkretes Risiko:**

- Spoofing: ein böser POST kann eine Order auf `shipped` / `delivered` setzen (mit `force: true` durch die State-Machine!) — Stock-Decrement wird ausgelöst (CLAUDE.md Punkt 13!).
- Operator-Konsequenz: Oversell-Risiko, wenn jemand systematisch Shipment-Webhooks für offene Orders spooft.

**Hardening-Plan-Eintrag:**

- Secret-Pflicht: ohne Secret → `401`, nicht fail-open.
- `decoded === '${publicKey}:${secretKey}'` (strict equal) oder nur HMAC.
- Query-Secret-Match entfernen (Log-Leakage).
- Idempotenz-Keys checken (parcel_id + status_id Combo).

## Übergreifende Hardening-Empfehlungen

1. **Raw-Body bewahren** für alle HMAC-Endpoints — separater Express-Mount pro Provider.
2. **Fail-closed by default:** Ohne Secret → `503` oder `401` mit Operator-Alert, nie stillschweigend akzeptieren.
3. **`emitSyncEvent` ist Side-Effect-trigger.** Solange Verifikation nicht zuverlässig ist, sollte der Sync-Cascade **rate-limited** sein (z. B. max 1 Trigger pro Order pro Minute).
4. **`force: true` in `transitionOrder` aus dem Webhook-Pfad nur dann erlauben, wenn Signatur verifiziert ist.** Aktuell wird das pauschal gemacht.
5. **Audit-Log:** jeder verworfene Webhook in eine Firestore-Collection (`webhookRejects`), damit Operator nicht erst nach Datenchaos merkt, dass Verifikation scheitert.
6. **Idempotenz:** Event-ID-Tracking pro Provider (eBay `notificationId`, Kaufland event-ID, SendCloud `parcel_id+status_id+timestamp`-Combo).

## Aktueller Status pro Provider — Zusammenfassung

| Provider | Action Item | Owner | Priorität |
|----------|-------------|-------|-----------|
| eBay | JWS-Verifikation via Public-Key implementieren | Backend | hoch |
| Kaufland | Raw-Body-Capture + HMAC-Bug-Fix | Backend | hoch |
| SendCloud | Strict-Equal Basic-Auth + Secret-Pflicht | Backend | hoch |

## Verweise

- Hardening-Plan-Tracker / aktive Tasks: siehe `TASKS.md` im Repo-Root.
- Side-Effects (`emitSyncEvent`-Topics + Listener): [backend/services/sync-event-bus.js](../../../backend/services/sync-event-bus.js) (Topic-Liste) und die Listener-Suite in [backend/services/](../../../backend/services/).
- State-Machine + `transitionOrder`: [backend/services/order-state-machine.js](../../../backend/services/order-state-machine.js).
- Verwandte KB-Seiten:
  - [ebay.md](ebay.md)
  - [kaufland.md](kaufland.md)
  - [sendcloud.md](sendcloud.md)

## Owner

Backend-Team. Diese Seite wird beim nächsten Webhook-Hardening-PR aktualisiert. Stand 2026-05-18: **alle drei Provider sind in mindestens einem Aspekt ungehärtet** — keine Annahmen treffen.

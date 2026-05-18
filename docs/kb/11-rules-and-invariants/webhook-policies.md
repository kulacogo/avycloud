---
title: Webhook-Policies
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# Webhook-Policies

> Webhooks sind in [backend/index.js](../../../backend/index.js) Z. 230 *vor* `requireAuth` gemountet — sie sind Machine-to-Machine und müssen pro Handler signiert validiert werden.

## Mount-Position

```js
// backend/index.js
app.use('/api', webhooksRouter);          // public (vor requireAuth)
app.use('/api', (req, res, next) => { ... requireAuth(req, res, next); });
```

Public-Allowliste innerhalb `/api`:

- `/api/auth/*` (Auth-Router)
- `/api/<webhook-pfade>` (Webhooks-Router)
- `/api/image-proxy` (img-src kann keine Header setzen)
- `/api/ebay/oauth/callback` (eBay-Redirect ohne Auth-Header)

Quelle: [backend/index.js](../../../backend/index.js) Z. 227–239.

## Erwartete Signatur-Verifikation pro Provider

| Provider | Signatur | Verifikations-Header / Mechanismus | Status |
|----------|----------|-----------------------------------|--------|
| **eBay** Notifications | HMAC-SHA1 (Marketplace Account Deletion) bzw. `ebay-signature` Header (für Verifizierungs-Endpoints) | `X-EBAY-SIGNATURE`, `X-EBAY-PROVIDER-PROD-CONFIG-ID` | **Muss verifiziert werden** im Code (`backend/routes/webhooks.js`). |
| **Kaufland** | HMAC der Payload mit `KAUFLAND_SECRET_KEY` | `Authorization` / Custom-Header *(genaue Form muss verifiziert werden)* | **Muss verifiziert werden**. |
| **SendCloud** | Optional HMAC mit Secret aus Integration-Setup | `Sendcloud-Signature` | **Muss verifiziert werden**. |

> **Hardening-Gap**: Aus den geprüften Quellen ist nicht eindeutig erkennbar, dass jeder Webhook-Handler heute eine Signatur prüft. Das ist als bekannter Drift-Posten dokumentiert (Roadmap-Plan, extern). Code-Review-Schritt für jeden neuen Webhook: prüfe Signatur, sonst PR ablehnen.

## SendCloud Always-200-Policy

SendCloud retried Webhooks aggressiv und blacklisted Endpoints die ≥ 5xx zurückgeben. Daher:

| Antwort | Wann |
|---------|------|
| `200 OK` | Immer — auch bei Validierungsfehlern, dedupe-Skips, unbekannten Status-IDs. |
| `4xx`/`5xx` | NIE bei normalen Verarbeitungsfehlern. Nur bei tatsächlichen Auth-/Signatur-Fehlern. |
| Logging | Fehler werden geloggt, aber nie an SendCloud signalisiert. |

Konkrete Implementation: [backend/routes/webhooks.js](../../../backend/routes/webhooks.js) §SendCloud-Handler — **muss verifiziert werden**.

## Idempotenz-Pflicht

Webhooks **müssen** idempotent verarbeitet werden (gleiches Event darf doppelt eintreffen):

| Pattern | Verwendung |
|---------|-----------|
| Event-ID Dedup-Cache (`webhook_events` Collection) | Empfohlen für alle Webhooks; **muss verifiziert werden** ob heute eingesetzt. |
| State-Machine `transitionOrder()` | Idempotent per Design (siehe [oms-transitions.md](oms-transitions.md)). |
| `stockDecrementedAt`-Marker | Verhindert Doppel-Decrement bei retries. |

## Beispiel-Anti-Patterns

```js
// FEHLER: direktes orderRef.update vom Webhook
await firestore.collection('orders').doc(orderId).update({
  omsStatus: 'shipped',  // verletzt Punkt 11
  trackingId,
});

// RICHTIG: durch State-Machine routen
await transitionOrder({
  tenantId,
  orderId,
  toStatus: 'shipped',
  source: 'sendcloud-webhook',
  meta: { trackingId, carrierName },
});
```

## Verweise

- Webhook-Router: [backend/routes/webhooks.js](../../../backend/routes/webhooks.js).
- Mount-Order-Detail: [02-architecture/backend.md](../02-architecture/backend.md).
- OMS-Regel: [oms-transitions.md](oms-transitions.md).
- Hardening-Plan: Roadmap-Doc `/Users/oguz/.claude/plans/avycloud-roadmap-nachhaltig.md` *(extern, muss verifiziert werden)*.

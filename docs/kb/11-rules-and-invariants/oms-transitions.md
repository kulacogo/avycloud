---
title: OMS-Transitions
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# OMS-Transitions

> Punkt 11 [CLAUDE.md](../../../CLAUDE.md): `omsStatus` darf nur über `transitionOrder()` geschrieben werden.

## Regel

| Erlaubt | Verboten |
|---------|----------|
| `transitionOrder(orderId, toStatus, { ... })` in [backend/services/order-state-machine.js](../../../backend/services/order-state-machine.js). | `orderRef.update({ omsStatus: ... })` an jeder anderen Stelle. |
| `transitionOrder` aus Webhook-, Intake- oder Background-Workers aufrufen. | Direkte Firestore-Mutation auf `omsStatus`-Feld. |

`transitionOrder()` ist idempotent — Re-Aufruf zum gleichen Ziel-Status ist No-Op. Pflicht-Side-Effects (Stock-Decrement, Marketplace-Push, Reservation-Release, Invoice-Trigger, `order:status_changed`-Event) sind im Handler-Map zentral.

## Code-Anker

- State-Machine: [backend/services/order-state-machine.js](../../../backend/services/order-state-machine.js).
- Stock-Claim aus Pfad B: [backend/lib/order-stock-claim.js](../../../backend/lib/order-stock-claim.js).
- Event-Bus Reaktionen auf `order:status_changed`: [backend/services/sync-event-bus.js](../../../backend/services/sync-event-bus.js) Z. 87ff.

## Bekannte Bypass-Stellen (technische Schuld)

| Stelle | Verstoß | Status |
|--------|---------|--------|
| `pollDeliveryStatus` in [backend/services/shipping-engine.js](../../../backend/services/shipping-engine.js) | Setzt Delivery-Status teilweise direkt auf `orders/{id}`, statt `transitionOrder('delivered')` zu nutzen. | **Offen** — Refactor pending. |
| `services/order-intake-kaufland.js` + `services/order-intake-ebay.js` | Frühere Versionen schrieben `order.omsStatus` direkt via `orderRef.update()`. Pflicht: Initiale Anlage ebenfalls via `transitionOrder()` (oder explizite Helper-Funktion). | Pflicht-Pattern in [CLAUDE.md](../../../CLAUDE.md) Punkt 11 — **muss bei jedem Intake verifiziert werden**. |
| Webhook-Handler die nur Lifecycle-Felder setzen (z. B. SendCloud-Status-Update auf `omsStatus`) | Wenn Status-Map indirekt `omsStatus` setzt → muss durch State-Machine geroutet werden. | Quelle: [backend/routes/webhooks.js](../../../backend/routes/webhooks.js) — **muss verifiziert werden** pro Handler. |

## Wie `transitionOrder()` benutzt wird

```js
const { transitionOrder } = require('../services/order-state-machine');

await transitionOrder({
  tenantId,
  orderId,
  toStatus: 'shipped',
  source: 'sendcloud-webhook',
  meta: { trackingId, carrierName },
});
```

Handler-Map (Auszug — **muss verifiziert werden** mit aktueller Implementation):

| Ziel-Status | Side-Effects |
|-------------|--------------|
| `confirmed` | Reservation persist |
| `picked` | (optional Status-Marker) |
| `packed` | (optional Status-Marker) |
| `shipped` | `_onOrderShipped` → Stock-Decrement (Pfad B, wenn nicht Pfad A) + Marketplace-Tracking-Push + Invoice-Trigger |
| `cancelled` | `_onOrderCancelled` → Reservation-Release + Marketplace-Cancel-Push. **Gap F**: kein Re-Increment / Persistence-Failure. |
| `delivered` | (Soll: Liefer-Bestätigung loggen, evtl. Returns-Window starten) |

## Sync-Event-Bus

Bei jeder Transition feuert `transitionOrder` das `order:status_changed` Event. Reaktionen in [backend/services/sync-event-bus.js](../../../backend/services/sync-event-bus.js):

- Safety-Net Stock-Sync für alle Order-Items.
- Bei `cancelled`: Reservation-Release + Marketplace-Cancel-Push.
- Bei `shipped`: Tracking-Push-Check.
- Debounced Marketplace-Order-Sync.

## Test-Anker

- `backend/__tests__/order-state-machine.test.js` *(Annahme — muss verifiziert werden in `backend/__tests__/`)*.
- Stock-Idempotency-Tests siehe [stock-single-writer.md](stock-single-writer.md) §Tests.

## Querverweise

- ADR: [02-architecture/adr/0003-oms-state-machine.md](../02-architecture/adr/0003-oms-state-machine.md).
- Stock-Pfade: [stock-single-writer.md](stock-single-writer.md).
- Eventing: [02-architecture/eventing.md](../02-architecture/eventing.md).

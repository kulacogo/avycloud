---
title: ADR-0003 — OMS State-Machine als alleiniger Status-Writer
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# ADR-0003 — OMS State-Machine als alleiniger Status-Writer

## Status

**Accepted**. Verbindlich in [CLAUDE.md](../../../../CLAUDE.md) Punkt 11.

## Kontext

Der `omsStatus`-Übergang einer Order zieht eine ganze Reihe von Side-Effects nach sich:

- Stock-Decrement (Pfad B, siehe [adr/0002-stock-single-writer.md](0002-stock-single-writer.md)).
- Marketplace-Tracking-Push (für `shipped`).
- Marketplace-Cancel-Push (für `cancelled`).
- Reservation-Release.
- Invoice-Generierung (`shipped`).
- Event `order:status_changed` für den `sync-event-bus`.

Wenn `orderRef.update({ omsStatus: 'shipped' })` direkt aus einem Webhook- oder Intake-Service ohne diese Side-Effects ausgeführt wird, entstehen exakt die Inkonsistenzen, die historisch zu Oversell und Operations-Chaos geführt haben.

## Entscheidung

1. **Einziger Writer** für `omsStatus` ist `transitionOrder()` in [backend/services/order-state-machine.js](../../../../backend/services/order-state-machine.js).
2. **Side-Effects** sind in einem Handler-Map (`_onOrderShipped`, `_onOrderCancelled`, …) zentralisiert.
3. **Idempotent**: Re-Aufruf einer Transition zum gleichen Ziel-Status ist No-Op. Stock-Decrement nutzt zusätzlich den `stockDecrementedAt`-Marker (siehe ADR-0002).
4. **Verboten**: jegliches `orderRef.update({ omsStatus: ... })` außerhalb dieses Service. CI-Lint plus Code-Review als Schutz.

## Konsequenzen

| Positiv | Negativ |
|---------|---------|
| Konsistente Side-Effect-Kette pro Status-Übergang. | Jeder neue Intake muss explizit `transitionOrder()` aufrufen — keine impliziten Schreiber mehr. |
| Idempotent + retryable. | Bypass-Stellen sind technische Schuld → siehe unten. |

## Bekannte Bypass-Stellen (technische Schuld)

| Stelle | Verstoß | Plan |
|--------|---------|------|
| `pollDeliveryStatus` in [backend/services/shipping-engine.js](../../../../backend/services/shipping-engine.js) | Setzt Liefer-Status teilweise direkt (Status-Mapping zu `delivered`). Sollte über `transitionOrder('delivered')` laufen. | Refactor offen. |
| `order-intake-kaufland.js` + `order-intake-ebay.js` (historisch) | Frühere Versionen schrieben `order.omsStatus` direkt via `orderRef.update()`. Heute SOLLEN sie über `transitionOrder()` initialisieren — siehe expliziter Hinweis in [CLAUDE.md](../../../../CLAUDE.md) Punkt 11. **Muss verifiziert werden** für jeden neuen Intake. |
| Webhook-Handler die nur Lifecycle-Felder setzen | Bei Status-Änderung im Webhook → entweder vollen `transitionOrder()` aufrufen oder explizit als „Side-Effect-Suppression"-Pfad markieren. |
| `services/returns-engine.js` | Returns haben eigenen `status`-Feld auf `returns`-Doc; das ist **nicht** `omsStatus`. Schreibt korrekt eigenständig — kein Verstoß. |

> **Hinweis:** Eine vollständige statische Audit-Liste aller `orderRef.update`-Aufrufe ist Aufgabe des Hardening-Plans. Bis dahin gilt: Reviewer schaut explizit nach `omsStatus`-Schreibern in Diff-Stellen.

## Code-Anker

- State-Machine: [backend/services/order-state-machine.js](../../../../backend/services/order-state-machine.js).
- Stock-Claim: [backend/lib/order-stock-claim.js](../../../../backend/lib/order-stock-claim.js).
- Sync-Bus-Reaktion: [backend/services/sync-event-bus.js](../../../../backend/services/sync-event-bus.js) §`order:status_changed`.

## Querverweise

- ADR-0002 (Stock Single Writer): [0002-stock-single-writer.md](0002-stock-single-writer.md).
- Rule: [../../11-rules-and-invariants/oms-transitions.md](../../11-rules-and-invariants/oms-transitions.md).
- Eventing: [../eventing.md](../eventing.md).

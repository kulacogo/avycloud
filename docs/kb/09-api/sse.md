---
title: API — SSE (Server-Sent Events)
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# API — SSE

Mount: `app.use('/api', sseRouter)` ([backend/index.js#L254](../../../backend/index.js#L254)).

Quelle: [backend/routes/sse.js](../../../backend/routes/sse.js).

Zweck: Push-Channel an das Frontend zur React-Query-Cache-Invalidation. Eine einzige langlebige Connection pro Browser-Tab.

EventSource kann keine Custom-Header senden — der Backend-Auth-Layer akzeptiert daher `?token=<jwt>` und kopiert ihn in die `Authorization`-Header ([backend/index.js#L209-L214](../../../backend/index.js#L209-L214)).

---

### `GET /api/events`

- **Auth**: `requirePermission('dashboard', 'read')`
- **Tenant Source**: JWT (request setzt aktuell keinen Tenant-Filter — globale Events werden allen Verbindungen geliefert)
- **Request**: `(empty)`
- **Response**: `(stream)` — `Content-Type: text/event-stream`. Erstes Event:
  ```
  event: connected
  data: {"ts": 1716039000000}
  ```
- **Side-Effects**:
  - Registriert sich auf `sync-event-bus`-Events ([backend/services/sync-event-bus.js](../../../backend/services/sync-event-bus.js)).
  - Heartbeat `: heartbeat <ts>` alle 30 s (verhindert Proxy/LB-Timeout).
  - Cleanup auf `req.close` (Listener werden vom Bus entfernt).
- **Idempotency**: jede Connection ist unabhängig; Mehrfach-Subscription ist erlaubt aber teuer.
- **Failure Modes**:
  - `403` wenn dashboard.read fehlt.
  - Stille Disconnects → Frontend muss reconnecten.
- **Source**: [backend/routes/sse.js#L39-L116](../../../backend/routes/sse.js#L39-L116)

#### Event-Mapping (Bus-Event → SSE-Event)

| Bus-Event | SSE-Event |
|---|---|
| `order:created` | `orders:synced` |
| `order:status_changed` | `orders:status-changed` |
| `order:updated` | `orders:synced` |
| `return:created` | `orders:synced` |
| `return:status_changed` | `orders:synced` |
| `shipment:created` | `orders:synced` |
| `shipment:updated` | `orders:synced` |
| `stock:changed` | `listings:synced` |
| `listings:sync_completed` (vom listing-sync-runner) | `listings:synced` |

#### Payload

```json
{
  "entityId": "...",
  "source": "...",
  "newStatus": "<optional, nur bei status_changed>",
  "ts": 1716039000000
}
```

#### Debouncing

Pro Event-Type max. ein Push alle 2000 ms (`SSE_DEBOUNCE_MS`). Schnelle Burst-Updates werden dropped, das nächste Heartbeat oder Folge-Event holt die Aktualität.

---

## Verwandte SSE-Endpoints

Diese liegen in anderen Router-Files und sind hier zur Übersicht aufgelistet:

| Endpoint | Router | Zweck |
|---|---|---|
| `GET /api/products/stream` | productsRouter | Firestore-`onSnapshot` über `products_v2` (oder `products` falls `USE_PRODUCTS_V2!=true`). Skippt initialen Snapshot. |
| `GET /api/jobs/:id/stream` | identifyRouter | Job-Status-Updates aus `identificationJobs/{id}` |
| `POST /api/chat?stream=true` | identifyRouter | Token-Streaming für Gemini Chat-Antworten |

Details siehe [products.md](products.md), [identify.md](identify.md).

---

## Client-Cleanup

Der Router hält eine globale `clients`-Set, die für Graceful-Shutdown verwendet werden könnte (aktuell nicht exportiert in Shutdown-Logik — TBD - verify in code, ob index.js `clients` für SIGTERM-Cleanup nutzt).

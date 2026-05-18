---
title: API — Sessions
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# API — Sessions

Mount: `app.use('/api/sessions', sessionsRouter)` ([backend/index.js#L253](../../../backend/index.js#L253)). Eigene `requireAuth`-Anwendung im Router selbst (`router.use(requireAuth)`), zusätzlich greift die globale Auth-Middleware aus index.js.

Quelle: [backend/routes/sessions.js](../../../backend/routes/sessions.js). Service: [backend/services/user-sessions.js](../../../backend/services/user-sessions.js).

Zweck: Login-Session-Tracking für Audit-Trail und „Active Sessions"-Übersicht (siehe `GET /api/admin/sessions/active`). Nicht zu verwechseln mit Firebase Auth Sessions oder Chat-Sessions.

---

### `POST /api/sessions`

- **Auth**: `requireAuth`
- **Tenant Source**: hardcoded `'default'` (siehe [backend/routes/sessions.js#L29](../../../backend/routes/sessions.js#L29))
- **Request**:
  ```json
  { "clientInfo": { "browser": "Chrome", "os": "macOS" } }
  ```
- **Response**:
  ```json
  { "ok": true, "sessionId": "<string>" }
  ```
- **Side-Effects**:
  - `createSession()` schreibt vermutlich nach `user_sessions` (TBD - verify in code, Collection-Name in `services/user-sessions.js`).
  - Erfasst `ip` (X-Forwarded-For-aware), `userAgent`, `authProvider` (aus `req.user.claims.firebase.sign_in_provider`).
- **Idempotency**: none — jeder Call erzeugt eine neue Session-ID.
- **Failure Modes**:
  - `500 { ok: false, error: { code: "INTERNAL", message: ... } }`.
- **Source**: [backend/routes/sessions.js#L19-L41](../../../backend/routes/sessions.js#L19-L41)

---

### `POST /api/sessions/:id/heartbeat`

- **Auth**: `requireAuth`
- **Tenant Source**: hardcoded `'default'`
- **Request**: `(empty)`
- **Response**: `{ "ok": true }`
- **Side-Effects**: aktualisiert `lastSeenAt` o.ä. des Session-Docs (TBD - verify in code).
- **Idempotency**: idempotent (mehrfache Heartbeats haben denselben Effekt).
- **Failure Modes**: `500` bei Firestore-Outage.
- **Source**: [backend/routes/sessions.js#L44-L55](../../../backend/routes/sessions.js#L44-L55)

Vom Frontend typischerweise alle 30–60s während aktiver Nutzung.

---

### `POST /api/sessions/:id/end`

- **Auth**: `requireAuth`
- **Tenant Source**: hardcoded `'default'`
- **Request**: `(empty)`
- **Response**: `{ "ok": true }`
- **Side-Effects**: markiert Session-Doc als beendet (`endedAt: <ts>`).
- **Idempotency**: idempotent (mehrfaches Beenden setzt nur den Zeitstempel).
- **Failure Modes**: `500` bei Firestore-Outage.
- **Source**: [backend/routes/sessions.js#L58-L70](../../../backend/routes/sessions.js#L58-L70)

Wird vom Frontend beim Logout aufgerufen.

---

## Verwandte Endpoints

- Admin-Sicht: [admin.md](admin.md#sessions) — `GET /api/admin/sessions`, `GET /api/admin/sessions/active`.

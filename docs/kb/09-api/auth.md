---
title: API — Auth
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# API — Auth

Mount: `app.use('/api/auth', authRouter)` ([backend/index.js#L227](../../../backend/index.js#L227)). Diese Routen sind **public** — sie liegen vor der globalen `requireAuth`-Middleware ([backend/index.js#L232-L239](../../../backend/index.js#L232-L239)).

Quelle: [backend/routes/auth.js](../../../backend/routes/auth.js).

Hinweis: das ist NICHT der Sign-In-Pfad. Login läuft Frontend-seitig direkt gegen Firebase Auth; das Backend prüft nur via `requireAuth` den ID-Token ([backend/lib/auth.js](../../../backend/lib/auth.js)).

---

### `POST /api/auth/password-reset`

- **Auth**: none (public, vor `requireAuth`)
- **Tenant Source**: none
- **Request**:
  ```json
  { "email": "user@trendocean.de" }
  ```
- **Response**: immer `{ "ok": true }` (Anti-Enumeration; existierende und nicht existierende E-Mails sehen identisch aus).
- **Side-Effects**:
  - Delegiert an `requestPasswordReset({ email, ip })` aus [backend/services/public-auth.js](../../../backend/services/public-auth.js).
  - Versendet Firebase-Auth-Reset-Mail an `email` falls Account existiert (TBD - verify in code: konkrete Service-Logik in `services/public-auth.js`).
  - Schreibt vermutlich Rate-Limit-Doc nach `password_reset_attempts` o.ä. (TBD - verify in code).
- **Idempotency**: none (mehrfache Calls erzeugen mehrere Reset-Mails bis Rate-Limit greift).
- **Failure Modes**:
  - `429` durch `generalLimiter` bei zu vielen Calls pro IP (60 s Window, 120 req).
  - `500 { ok: false, error: { code: 500, message: "Password reset failed" } }` bei Firebase-Outage.
- **Source**: [backend/routes/auth.js#L11-L22](../../../backend/routes/auth.js#L11-L22)

---

## Nicht-Endpoint-Funktionen

Sign-In, Token-Refresh und E-Mail-Verifizierung sind **Frontend-Verantwortung** und gehen direkt an Firebase Auth (kein AvyCloud-Backend-Endpoint).

Der Backend-Counterpart ist die `requireAuth`-Middleware in [backend/lib/auth.js](../../../backend/lib/auth.js) — siehe [conventions.md](conventions.md#auth-modell) für Details.

Für die User-Session-Verwaltung (Login-Heartbeat, Audit, Active-Sessions) siehe [sessions.md](sessions.md).

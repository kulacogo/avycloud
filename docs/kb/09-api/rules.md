---
title: API — Rules (Automation Rule Engine)
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# API — Rules

Mount: `app.use('/api/v1/rules', rulesRouter)` ([backend/index.js#L252](../../../backend/index.js#L252)). Globale `requireAuth` greift. **Keine** zusätzlichen `requirePermission`-Checks im Router (verify in code: ist das Absicht?).

Quelle: [backend/routes/rules.js](../../../backend/routes/rules.js). Engine: [backend/services/rule-engine.js](../../../backend/services/rule-engine.js). Runner: [backend/services/rule-runner.js](../../../backend/services/rule-runner.js).

Tenant-Source: `req.user?.tenantId || 'default'`.

Collections (aus engine):
- `RULES_COLLECTION` (TBD - verify in code: vermutlich `automation_rules`)
- `JOBS_COLLECTION` (TBD - verify in code: vermutlich `automation_rule_jobs`)

---

### `GET /api/v1/rules`

- **Auth**: requireAuth
- **Tenant Source**: JWT
- **Request**: Query `?active=true` (optional)
- **Response**: `{ "ok": true, "data": [{ "id": "...", "name": "...", "active": true, "conditions": [...], "actions": [...], "stats": {...} }] }`
- **Side-Effects**: read-only. Sortiert client-side nach `createdAt DESC` (Single-Field-Query um Composite-Index zu vermeiden).
- **Idempotency**: read.
- **Failure Modes**: `500 { code: 'INTERNAL' }`.
- **Source**: [backend/routes/rules.js#L46-L65](../../../backend/routes/rules.js#L46-L65)

---

### `GET /api/v1/rules/jobs/:jobId`

⚠️ Diese Route muss VOR `GET /:ruleId` definiert sein, damit Express den `jobs/`-Prefix nicht als `ruleId="jobs"` matched.

- **Auth**: requireAuth
- **Tenant Source**: none (Job-IDs sind global eindeutig — TBD - verify in code, ob Cross-Tenant-Lookup geblockt wird)
- **Request**: `(empty)`
- **Response**: `{ "ok": true, "data": { "id": "...", "ruleId": "...", "status": "pending|running|done|failed", "mode": "dry_run|apply", "matched": ..., "applied": ... } }`
- **Side-Effects**: read.
- **Idempotency**: read.
- **Failure Modes**: `404 { code: 'NOT_FOUND' }`, `500`.
- **Source**: [backend/routes/rules.js#L69-L80](../../../backend/routes/rules.js#L69-L80)

---

### `GET /api/v1/rules/:ruleId`

- **Auth**: requireAuth
- **Tenant Source**: none direct, Filter geschieht implicit über Rule-Doc (TBD - verify in code)
- **Request**: `(empty)`
- **Response**: `{ "ok": true, "data": { "id": "...", ...ruleFields } }`
- **Side-Effects**: read.
- **Idempotency**: read.
- **Failure Modes**: `404`, `500`.
- **Source**: [backend/routes/rules.js#L82-L93](../../../backend/routes/rules.js#L82-L93)

---

### `POST /api/v1/rules`

- **Auth**: requireAuth
- **Tenant Source**: JWT
- **Request**:
  ```json
  {
    "name": "Increase price 5%",
    "description": "optional",
    "active": true,
    "conditions": [{"field": "...", "op": "...", "value": "..."}],
    "actions": [{"type": "set_field", "field": "...", "value": "..."}],
    "channel": "ebay" | null
  }
  ```
- **Response** (`201`): `{ "ok": true, "data": { "id": "...", ...doc } }`
- **Side-Effects**:
  - Schreibt nach `RULES_COLLECTION` mit `createdBy: req.user.email`, `stats: { totalRuns: 0, ... }`.
  - Audit-Log `action: 'rule.created'`.
- **Idempotency**: none.
- **Failure Modes**:
  - `400 { code: 'VALIDATION_ERROR' }` ohne `name` oder leere `conditions`/`actions`.
  - `500 { code: 'INTERNAL' }`.
- **Source**: [backend/routes/rules.js#L97-L127](../../../backend/routes/rules.js#L97-L127)

---

### `PUT /api/v1/rules/:ruleId`

- **Auth**: requireAuth
- **Tenant Source**: implicit via Rule-Doc (TBD - verify in code; aktuell **keine Tenant-Authorization-Prüfung** beim Update)
- **Request**: Patch-Objekt mit beliebigen aus `name`, `description`, `conditions`, `actions`, `channel`, `active`. Auch nicht-Patch-fähige Felder werden geignort.
- **Response**: `{ "ok": true, "data": { "id": "...", ...updatedDoc } }`
- **Side-Effects**: merge auf Doc + Audit-Log `rule.updated`.
- **Idempotency**: idempotent.
- **Failure Modes**: `404`, `500`.
- **Source**: [backend/routes/rules.js#L131-L156](../../../backend/routes/rules.js#L131-L156)

---

### `DELETE /api/v1/rules/:ruleId`

- **Auth**: requireAuth
- **Tenant Source**: implicit via Rule-Doc (TBD - verify in code)
- **Request**: `(empty)`
- **Response**: `{ "ok": true }`
- **Side-Effects**: Firestore-Delete + Audit-Log `rule.deleted`.
- **Idempotency**: idempotent (404 wenn schon weg).
- **Failure Modes**: `404`, `500`.
- **Source**: [backend/routes/rules.js#L160-L174](../../../backend/routes/rules.js#L160-L174)

---

### `PATCH /api/v1/rules/:ruleId/toggle`

- **Auth**: requireAuth
- **Tenant Source**: implicit via Rule-Doc
- **Request**: `(empty)`
- **Response**: `{ "ok": true, "data": { "id": "...", "active": <neuer Wert> } }`
- **Side-Effects**: flippt `active`-Flag. Kein Audit-Log (TBD - verify in code, evtl. fehlt das absichtlich).
- **Idempotency**: NICHT idempotent — zweimaliges Aufrufen flippt zurück. Caller muss aktuellen Zustand kennen.
- **Failure Modes**: `404`, `500`.
- **Source**: [backend/routes/rules.js#L178-L192](../../../backend/routes/rules.js#L178-L192)

---

### `POST /api/v1/rules/:ruleId/execute`

- **Auth**: requireAuth
- **Tenant Source**: JWT
- **Request**:
  ```json
  { "mode": "dry_run" | "apply", "limit": 1000 }
  ```
- **Response** (`202`): `{ "ok": true, "data": { "jobId": "...", "status": "pending" } }`
- **Side-Effects**:
  - `executeRule(ruleId, mode, limit)` legt Job-Doc an.
  - `enqueueAutomationJob(jobId)` → Background-Runner verarbeitet asynchron.
  - Audit-Log `rule.executed`.
- **Idempotency**: nicht idempotent — jeder Aufruf erzeugt einen neuen Job.
- **Failure Modes**:
  - `404 { code: 'NOT_FOUND' }` wenn Rule fehlt.
  - `500`.
- **Source**: [backend/routes/rules.js#L196-L213](../../../backend/routes/rules.js#L196-L213)

Status-Polling über `GET /api/v1/rules/jobs/:jobId`.

---

### `GET /api/v1/rules/:ruleId/preview`

- **Auth**: requireAuth
- **Tenant Source**: JWT
- **Request**: Query `?limit=20` (cap 100)
- **Response**:
  ```json
  {
    "ok": true,
    "data": {
      "matchCount": 42,
      "sample": [
        {
          "productId": "...",
          "productName": "...",
          "changes": [{ "field": "...", "before": "...", "after": "..." }]
        }
      ]
    }
  }
  ```
- **Side-Effects**: read-only. Simulation via `applyActions()` auf deep-cloned Product-Objekt.
- **Idempotency**: read.
- **Failure Modes**: `404 { code: 'NOT_FOUND' }`, `500`.
- **Source**: [backend/routes/rules.js#L220-L252](../../../backend/routes/rules.js#L220-L252)

---

## Background-Runner

`startRulebookRunner` ([backend/index.js#L9](../../../backend/index.js#L9), [backend/services/rulebook-runner.js](../../../backend/services/rulebook-runner.js)) verarbeitet die Job-Queue. Achtung: das ist NICHT identisch mit dem hier dokumentierten `rule-engine.js`/`rule-runner.js` — die `rulebookRunner`-Variante gehört zum Admin-Rulebook (siehe [admin.md](admin.md#rulebook)).

TBD - verify in code: das Naming ist verwirrend (`rule-engine.js` vs `rulebook-admin.js`). Konkrete Job-Loop-Funktion in `services/rule-runner.js` muss inspiziert werden.

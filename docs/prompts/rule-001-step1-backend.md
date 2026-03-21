# RULE-001 — Step 1: Backend (Steps 1–3)

> Core Engine + Job Runner + REST API. Kein Frontend in diesem Schritt.

## Prompt für Claude Code:

```
Lies CLAUDE.md, TASKS.md und docs/features/RULE-001-rule-engine/spec.md (komplett!).

Erstelle Branch `feat/rule-001-backend` und implementiere Steps 1–3 der Spec:

## Step 1: services/rule-engine.js — Core Logic

Erstelle backend/services/rule-engine.js mit:

1. `evaluateCondition(product, condition)` — 10 Operators:
   - String: equals, not_equals, contains, not_contains, starts_with, ends_with
   - Numeric: greater_than, less_than
   - Existence: is_empty, is_not_empty
   - Case-insensitive für String-Vergleiche

2. `evaluateConditions(product, conditions)` — AND-Logik (alle müssen matchen)

3. `applyAction(product, action)` — 5 Action-Types:
   - set_field: Feld auf exakten Wert setzen
   - adjust_price: Preis anpassen (percent oder absolute Mode)
   - prepend_text: Text voranstellen
   - append_text: Text anhängen
   - replace_text: Suchen & Ersetzen (params.search, params.replace)

4. `applyActions(product, actions)` — Sequentiell, gibt changes[] zurück

5. `getNestedField(obj, path)` + `setNestedField(obj, path, value)` — Dot-Notation Support für z.B. "details.pricing.sellPrice"

6. `getMatchingProducts(tenantId, conditions, limit)` — Query products_v2, filter mit evaluateConditions()

7. `executeRule(ruleId, mode, limit)` — Erstellt automationJob, returned jobId. mode = "execute" oder "dry_run"

Style: CommonJS, async/await, strukturiertes Error-Handling. Siehe Spec Section 6.2 für Code-Beispiele.

## Step 2: services/rule-runner.js — Job Runner

Erstelle backend/services/rule-runner.js nach dem EXAKTEN Pattern von services/rulebook-runner.js:

1. p-queue mit Concurrency aus RULE_JOB_CONCURRENCY ENV (default: 1)
2. `processAutomationJob(jobId)`:
   - Job claimen (Firestore Transaction — verhindert Doppelverarbeitung)
   - Rule laden aus automationRules
   - Products abfragen mit tenantId
   - evaluateConditions() für jedes Produkt
   - dry_run: Changes sammeln OHNE zu schreiben
   - execute: applyActions() + saveProductV2() für jeden Match
   - Job-Dokument updaten: progress, result, status
   - Rule stats updaten: lastRunAt, lastRunProducts, lastRunApplied, totalRuns++
3. `enqueueAutomationJob(jobId)` — Fügt Job in p-queue ein
4. `resumePendingAutomationJobs()` — Pending/Processing Jobs bei Startup laden
5. Sweep-Interval: RULE_JOB_SWEEP_MS (default: 45000)
6. Max Attempts: RULE_JOB_MAX_ATTEMPTS (default: 2)

WICHTIG: Nutze saveProductV2() aus lib/product-store.js für alle Schreibvorgänge!
WICHTIG: Chunked Processing (200 pro Batch) für große Kataloge.

## Step 3: routes/rules.js — REST API

Erstelle backend/routes/rules.js mit 8 Endpoints (siehe Spec Section 4 für exakte Contracts):

1. GET    /api/v1/rules                  — List rules (optional ?active=true Filter)
2. GET    /api/v1/rules/:ruleId          — Get single rule
3. POST   /api/v1/rules                  — Create rule (Validation: name, min 1 condition, min 1 action)
4. PUT    /api/v1/rules/:ruleId          — Update rule
5. DELETE /api/v1/rules/:ruleId          — Delete rule
6. PATCH  /api/v1/rules/:ruleId/toggle   — Toggle active/inactive
7. POST   /api/v1/rules/:ruleId/execute  — Execute rule (body: { mode, limit? }) → 202 mit jobId
8. GET    /api/v1/rules/jobs/:jobId      — Get job status + progress
9. GET    /api/v1/rules/:ruleId/preview  — Quick preview (matching products ohne apply)

Auth: requireAuth Middleware. Alle Queries mit tenantId.
Mount in server.js: app.use('/api/v1/rules', requireAuth, rulesRouter)

Response-Format: { ok: true/false, data: ..., error: { code, message } }

## Tests

Schreibe Tests in backend/__tests__/rule-engine.test.js:
- Alle 10 Condition-Operators (je 1 true + 1 false Case)
- Alle 5 Action-Types
- AND-Logik (alle match vs. einer nicht)
- getNestedField/setNestedField mit tiefen Pfaden
- Edge Cases: null field, empty string, missing path, Array-Felder

cd backend && npm test — alle Tests müssen grün sein.
npm run build — muss fehlerfrei bauen.

Commit: `feat(rule-001): backend — rule engine core, job runner, REST API`
```

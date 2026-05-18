# 12 · Runbooks — Index

> Operational runbooks for AvyCloud. Single source of truth for **what to do when something breaks** or **how to safely flip a flag**.

The canonical runbooks live in [`docs/runbooks/`](../../runbooks/) at the repository root. This index mirrors them into the Knowledge Base so coding agents and on-call operators land here from `docs/kb/00-INDEX.md`.

## Active Runbooks

| Runbook | Scope | Source |
|---------|-------|--------|
| [Alerts catalog](../../runbooks/alerts.md) | All production alerts (Slack, PagerDuty, Cloud Monitoring) and their first-response steps. | `docs/runbooks/alerts.md` |
| [Identify-V4 promotion](../../runbooks/identify-v4-promotion.md) | Pre-flight + canary procedure for flipping `IDENTIFY_V4=true` in production. Required reading before bumping the flag. | `docs/runbooks/identify-v4-promotion.md` |
| [GPSR consensus rollout](../../runbooks/gpsr-consensus-rollout.md) | Staged rollout (`false → shadow → true`) of `IDENTIFY_V3_GPSR_CONSENSUS`. Includes diff thresholds and rollback triggers. | `docs/runbooks/gpsr-consensus-rollout.md` |
| [D0c throw-flip](../../runbooks/d0c-throw-flip.md) | Promoting Plan-D.0c (background-job multi-tenant fan-out) from logging-only to throwing on misconfiguration. | `docs/runbooks/d0c-throw-flip.md` |

## Templates

| Template | Use when… |
|----------|-----------|
| [Incident template](./incident-template.md) | A production incident has fired (alert, customer report, internal escalation). Copy this file into `docs/runbooks/incidents/<YYYY-MM-DD>-<short-slug>.md` and fill it in as the incident unfolds. |

## Reading order for new on-call operators

1. [`AGENTS.md`](../../../AGENTS.md) — repo entry point.
2. [`CLAUDE.md`](../../../CLAUDE.md) — non-negotiable invariants (esp. **Stock Single Writer**, **`omsStatus`**, **Oversell-Verbot**).
3. [`docs/runbooks/alerts.md`](../../runbooks/alerts.md) — every alert that can page you.
4. This index — when an alert fires, pick the matching runbook.
5. [`incident-template.md`](./incident-template.md) — start a new incident doc the moment a Sev1/Sev2 is declared.

## Authoring guidelines

- **Where to put new runbooks.** Always commit them in `docs/runbooks/` (root). Add a row to the table above so KB readers can find them.
- **Front-matter is optional**, but include a 1-line `Trigger:` and `Owner:` near the top of every runbook so on-call can decide in < 10 seconds whether it applies.
- **Idempotent steps.** Each step should be safe to re-run (e.g. `kubectl apply` instead of `kubectl create`, Firestore upserts instead of inserts).
- **Rollback first.** Every runbook ends with a "Rollback / undo" section. If you can't write a rollback step, the runbook is not done.
- **Link to canonical code paths** (`lib/...`, `services/...`) rather than copy-pasting code — runbooks must not drift from source.

## Related KB sections

- [`docs/kb/11-rules-and-invariants/`](../11-rules-and-invariants/) — invariants you must never violate while operating.
- [`docs/kb/04-deployment/rollback.md`](../04-deployment/rollback.md) — generic rollback path for Cloud Run + Firebase Hosting.
- [`docs/kb/07-llm/`](../07-llm/) — LLM-specific knobs and budgets (Identify-V3/V4, Chat-V3).

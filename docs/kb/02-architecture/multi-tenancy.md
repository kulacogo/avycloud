---
title: Multi-Tenancy
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# Multi-Tenancy

> Geprüfte Quellen: [CLAUDE.md](../../../CLAUDE.md), [backend/index.js](../../../backend/index.js), [backend/lib/background-job-tenants.js](../../../backend/lib/background-job-tenants.js), Grep-Audit über `tenantId.*default` in [backend/lib/](../../../backend/lib/).

## Status (in einem Satz)

Multi-Tenancy ist im Datenmodell additiv vorbereitet (`tenantId`-Feld), aber **nicht** durchgängig im Backend-Code propagiert. Der heute praktisch genutzte Tenant ist `'default'` (Legacy) plus `'trendocean'` (Produktion).

## Daten-Modell

Jede tenant-bewusste Collection trägt ein `tenantId`-Feld (String). Punkt 8 der [CLAUDE.md](../../../CLAUDE.md) Nicht-Verhandelbaren:

> Alle neuen Queries und Collections mit `tenantId`.

Composite-Indexes mit `tenantId` ASC + `<sort field>` existieren u. a. für `returns`, `shipments`, `invoices`, `api_keys`, `stock_sync_log`, `stock_operation_failures`, `warehouse_movements`, `products_v2`, `llm_call_telemetry` — siehe [firestore.indexes.json](../../../firestore.indexes.json).

## Tenant-Auflösung im Request

Das Auth-Subsystem ([backend/lib/auth.js](../../../backend/lib/auth.js)) liefert heute `req.user.{uid, email, isAdmin, emailVerified, claims}`. Eine explizite `tenantId`-Auflösung aus Custom Claims findet im geprüften Code-Pfad **nicht** statt — Punkt offen:

| Geprüfter Code | Beobachtung |
|----------------|-------------|
| `backend/lib/auth.js` | Liefert `claims` durchgereicht, aber keine `req.tenantId`-Ableitung. |
| `backend/lib/rbac.js` | RBAC-Resolve ohne Tenant-Filter. |
| Diverse Services | Verwenden hartcodiertes `tenantId = 'default'` als Fallback (siehe unten). |

> **Annahme / muss verifiziert werden:** Pro-Tenant-Routing soll perspektivisch über Firebase Custom Claims (`auth.setCustomUserClaims({ tenantId })`) erfolgen, mit Bridge in `requireAuth`. Der konkrete Mechanismus ist in den heute gelesenen Quellen nicht implementiert.

## Default-Tenant-Policy

Mehrere Module fallen aktuell auf `tenantId = 'default'` zurück (Auszug aus dem Grep-Audit):

| Datei | Fallback-Verhalten |
|-------|--------------------|
| [backend/lib/llm-telemetry.js](../../../backend/lib/llm-telemetry.js) Z. 321 | `tenantId = 'default'` wenn nicht übergeben. |
| [backend/lib/error-collector.js](../../../backend/lib/error-collector.js) Z. 68 | dito. |
| [backend/lib/stock-change-events.js](../../../backend/lib/stock-change-events.js) Z. 32 | dito. |
| [backend/lib/external-api-tracker.js](../../../backend/lib/external-api-tracker.js) Z. 32 | dito. |
| [backend/lib/identify-metrics.js](../../../backend/lib/identify-metrics.js) Z. 20 | dito. |
| [backend/lib/warehouse.js](../../../backend/lib/warehouse.js) Z. 149/694/1154 | dito. |
| [backend/lib/integration-defaults.js](../../../backend/lib/integration-defaults.js) Z. 15/31 | dito. |
| [backend/lib/firestore.js](../../../backend/lib/firestore.js) Z. 2664 | `tenantId: existing || 'default'` beim Product-Write. |
| [backend/lib/firestore.js](../../../backend/lib/firestore.js) Z. 2855ff | Legacy-Compat: bei Query mit `tenantId='default'` werden Docs ohne `tenantId` ODER mit `tenantId='default'` zurückgegeben. |

ADR mit Lang-Begründung: [adr/0006-tenant-default-policy.md](adr/0006-tenant-default-policy.md).

## Background-Jobs Multi-Tenant Fan-Out

[backend/lib/background-job-tenants.js](../../../backend/lib/background-job-tenants.js):

```js
function getBackgroundJobTenants() {
  const raw = String(process.env.BACKGROUND_JOB_TENANTS || '').trim();
  if (!raw) return ['default'];
  const tenants = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return tenants.length > 0 ? tenants : ['default'];
}
```

Verwendung in [backend/index.js](../../../backend/index.js) Z. 290 (`runForAllTenants`): jeder der sechs Safety-Net-Cron-Jobs (`returns-sync`, `sendcloud-sync`, `tracking-catchup`, `delivery-poll`, `invoice-sync`, `refund-push`) plus `kaufland-listings-sync` läuft pro Tenant. Errors pro Tenant werden gefangen + geloggt — eine kaputte Tenant-Iteration unterbricht die übrigen nicht.

**Aktivierungs-Beispiel:**
```
BACKGROUND_JOB_TENANTS=trendocean,avycloud
```

Default leer → Single-Tenant `'default'`. Aktivierungs-Runbook: [docs/runbooks/multi-tenant-activation.md](../../runbooks/multi-tenant-activation.md) *(Annahme — referenziert in [backend/index.js](../../../backend/index.js) Z. 276; Datei-Existenz **muss verifiziert werden**)*.

## Stock-Failure-Drain — separater Fan-Out

[backend/index.js](../../../backend/index.js) Z. 511:

```js
const STOCK_DRAIN_TENANTS = (process.env.STOCK_FAILURE_DRAIN_TENANTS || 'trendocean')
  .split(',').map((t) => t.trim()).filter(Boolean);
```

Default: `'trendocean'` (NICHT `'default'`). Historisch entstanden mit dem Oversell-Incident SKU-9871561937 (siehe [TASKS.md](../../../TASKS.md)).

## Bekannte Hardcode-Stellen / Drift

| Stelle | Drift | Hardening-Plan |
|--------|-------|----------------|
| Fast alle `lib/*`-Module mit `tenantId = 'default'`-Fallback | Single-Tenant-Implicit-Assumption | Operator soll explizit Tenant durchreichen; Ziel: kein Default-Fallback mehr. |
| `STOCK_FAILURE_DRAIN_TENANTS` Default `'trendocean'` ≠ `BACKGROUND_JOB_TENANTS` Default `''/'default'` | Inkonsistente Defaults | Harmonisierung über Tenant-Registry. |
| `AUTH_ALLOWED_EMAIL_DOMAIN` Default `trendocean.de` ([backend/lib/auth.js](../../../backend/lib/auth.js)) | Single-Org-Default | Pro-Tenant-Domain-Whitelist. |
| Scripts-Pfad `TENANT_ID=avycloud` (Default für CLI) ([CLAUDE.md](../../../CLAUDE.md) §LLM-Quality-Parity) | Inkonsistenz zwischen Backend-Default und Scripts-Default | Operator muss `--tenant` explizit setzen. |

> Vollständige Drift-Inventur und Migration-Schritte: ADR [adr/0006-tenant-default-policy.md](adr/0006-tenant-default-policy.md) und der referenzierte Hardening-Plan unter `/Users/oguz/.claude/plans/avycloud-roadmap-nachhaltig.md` *(externer Plan, nicht im Repo; muss verifiziert werden)*.

## Verweise

- ENV-Vars: [04-deployment/env-vars.md](../04-deployment/env-vars.md).
- Cron-Architektur: [backend.md](backend.md) §Safety-Net Cron-Loops.
- Tenant-Propagation-Regeln: [11-rules-and-invariants/tenant-propagation.md](../11-rules-and-invariants/tenant-propagation.md).

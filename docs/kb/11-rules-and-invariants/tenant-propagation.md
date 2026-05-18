---
title: Tenant-Propagation
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# Tenant-Propagation

> Punkt 8 [CLAUDE.md](../../../CLAUDE.md): *Alle neuen Queries und Collections mit `tenantId`.*

## Regel

Jede neue:

1. **Firestore-Query** filtert nach `tenantId`.
2. **Firestore-Mutation** schreibt `tenantId` ins Dokument.
3. **Cron-Job / Background-Worker** wird pro Tenant ausgeführt (siehe `runForEachBackgroundJobTenant()` in [backend/lib/background-job-tenants.js](../../../backend/lib/background-job-tenants.js)).
4. **Webhook-Handler** ordnet eingehende Events explizit einem Tenant zu.
5. **Composite-Index** beginnt mit `tenantId ASC`.

## Beispiele (gut)

```js
// Query
const snap = await firestore
  .collection('returns')
  .where('tenantId', '==', tenantId)
  .where('status', '==', 'erstattet')
  .orderBy('createdAt', 'desc')
  .limit(50)
  .get();

// Write
await orderRef.set({
  ...orderData,
  tenantId,
  createdAt: FieldValue.serverTimestamp(),
}, { merge: true });

// Cron mit Fan-Out
await runForEachBackgroundJobTenant('my-cron', async (tenantId) => {
  await doWork({ tenantId });
});
```

## Beispiele (schlecht)

```js
// FEHLER: ohne tenantId — vermischt Tenants
const snap = await firestore.collection('returns').get();

// FEHLER: tenantId implizit 'default' im neuen Code
async function newFunc({ tenantId = 'default' } = {}) { ... }
```

## Bekannte Drift-Stellen

Aus Grep-Audit `tenantId.*default` in [backend/lib/](../../../backend/lib/):

| Datei | Drift | Plan |
|-------|-------|------|
| [backend/lib/llm-telemetry.js](../../../backend/lib/llm-telemetry.js) Z. 321 | `tenantId = 'default'`-Fallback | Caller MUSS Tenant durchreichen; Mid-Term Default entfernen. |
| [backend/lib/error-collector.js](../../../backend/lib/error-collector.js) Z. 68 | dito | dito |
| [backend/lib/stock-change-events.js](../../../backend/lib/stock-change-events.js) Z. 32 | dito | dito |
| [backend/lib/external-api-tracker.js](../../../backend/lib/external-api-tracker.js) Z. 32 | dito | dito |
| [backend/lib/identify-metrics.js](../../../backend/lib/identify-metrics.js) Z. 20 | dito | dito |
| [backend/lib/warehouse.js](../../../backend/lib/warehouse.js) Z. 149 / 694 / 1154 | `tenantId: data.tenantId || 'default'` | Acceptable für Legacy-Data; neuer Code soll Tenant required machen. |
| [backend/lib/integration-defaults.js](../../../backend/lib/integration-defaults.js) Z. 15 / 31 | dito | dito |
| [backend/lib/firestore.js](../../../backend/lib/firestore.js) Z. 2664 | `tenantId: productWithEbay.tenantId \|\| existingData?.tenantId \|\| 'default'` | Acceptable; durch ADR-0006 abgedeckt. |
| [backend/lib/firestore.js](../../../backend/lib/firestore.js) Z. 2855ff | Legacy-Compat: bei `tenantId='default'`-Query werden Docs ohne `tenantId` mitgezogen. | Beibehalten bis Backfill aller Legacy-Daten. |

ADR mit Migration-Plan: [02-architecture/adr/0006-tenant-default-policy.md](../02-architecture/adr/0006-tenant-default-policy.md). Roadmap-Detail im Hardening-Plan `/Users/oguz/.claude/plans/avycloud-roadmap-nachhaltig.md` *(extern; muss verifiziert werden)*.

## Cron-Fan-Out

[backend/lib/background-job-tenants.js](../../../backend/lib/background-job-tenants.js) liefert `getBackgroundJobTenants()` + `runForEachBackgroundJobTenant()`. ENV `BACKGROUND_JOB_TENANTS=tenantA,tenantB` aktiviert Multi-Tenant-Fan-Out. Default leer → Single-Tenant `'default'`. Detail: [02-architecture/multi-tenancy.md](../02-architecture/multi-tenancy.md).

> Sonderfall: `STOCK_FAILURE_DRAIN_TENANTS` hat eigenen Default `'trendocean'` ([backend/index.js](../../../backend/index.js) Z. 511) — historisches Erbe aus Incident SKU-9871561937. Beim Hinzufügen weiterer Tenants beide ENVs pflegen.

## Auth-Bridge (Soll-Zustand)

> **Annahme / heute nicht implementiert** — muss verifiziert werden:
> Tenant-Resolution soll perspektivisch aus Firebase Custom Claims kommen (`auth.setCustomUserClaims({ tenantId: '…' })`), die `requireAuth` in `req.tenantId` projiziert. Router lesen `req.tenantId` statt einen Default-String zu verwenden.

Heute liefert [backend/lib/auth.js](../../../backend/lib/auth.js) nur `req.user.{uid, email, isAdmin, emailVerified, claims}`. Tenant-Routing ist Caller-Verantwortung.

## Composite-Indexes

[firestore.indexes.json](../../../firestore.indexes.json) — alle tenant-bewussten Indexes beginnen mit `tenantId ASC`:

- `returns`, `shipments`, `invoices`, `api_keys`, `stock_sync_log`
- `products_v2` (Identify-Checked-At-Indizes)
- `stock_operation_failures`, `warehouse_movements`, `llm_call_telemetry`
- `stock_reservations` (Status-basiert, ohne Tenant-Prefix — separater Cleanup-Pfad)

## Verweise

- ADR: [02-architecture/adr/0006-tenant-default-policy.md](../02-architecture/adr/0006-tenant-default-policy.md).
- Multi-Tenancy: [02-architecture/multi-tenancy.md](../02-architecture/multi-tenancy.md).
- Auth: [02-architecture/auth-and-rbac.md](../02-architecture/auth-and-rbac.md).

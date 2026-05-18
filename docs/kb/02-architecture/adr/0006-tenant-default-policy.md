---
title: ADR-0006 — Default-Tenant-Policy für Background-Sync
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# ADR-0006 — Default-Tenant-Policy für Background-Sync

## Status

**Accepted (Übergangslösung)**. Multi-Tenant-Hardening ist im Roadmap-Plan vorgesehen, aber heute *nicht* abgeschlossen.

## Kontext

AvyCloud hat ein Tenant-Modell im Datenmodell (`tenantId`-Feld auf allen tenant-bewussten Collections, Punkt 8 [CLAUDE.md](../../../../CLAUDE.md)), aber die Code-Pfade fallen historisch auf `tenantId = 'default'` zurück, wenn keine Tenant-Info übergeben wird.

Quellen (Grep-Audit):

| Datei | Drift |
|-------|-------|
| [backend/lib/llm-telemetry.js](../../../../backend/lib/llm-telemetry.js) Z. 321 | `tenantId = 'default'` |
| [backend/lib/error-collector.js](../../../../backend/lib/error-collector.js) Z. 68 | `tenantId = 'default'` |
| [backend/lib/stock-change-events.js](../../../../backend/lib/stock-change-events.js) Z. 32 | `tenantId = 'default'` |
| [backend/lib/external-api-tracker.js](../../../../backend/lib/external-api-tracker.js) Z. 32 | `tenantId = 'default'` |
| [backend/lib/identify-metrics.js](../../../../backend/lib/identify-metrics.js) Z. 20 | `tenantId = 'default'` |
| [backend/lib/warehouse.js](../../../../backend/lib/warehouse.js) Z. 149 / 694 / 1154 | `tenantId: data.tenantId || 'default'` |
| [backend/lib/integration-defaults.js](../../../../backend/lib/integration-defaults.js) Z. 15 / 31 | `tenantId = 'default'` |
| [backend/lib/firestore.js](../../../../backend/lib/firestore.js) Z. 2664 | `tenantId: productWithEbay.tenantId || existingData?.tenantId || 'default'` |
| [backend/lib/firestore.js](../../../../backend/lib/firestore.js) Z. 2855ff | Legacy-Compat: bei `tenantId='default'`-Query werden Docs ohne `tenantId` mitgeführt. |

Zwei Tenant-Steuer-ENV-Vars existieren parallel mit **unterschiedlichen Defaults**:

| ENV | Default | Wirkung |
|-----|---------|---------|
| `BACKGROUND_JOB_TENANTS` ([backend/lib/background-job-tenants.js](../../../../backend/lib/background-job-tenants.js)) | leer → `['default']` | Sechs Safety-Net-Crons + Kaufland-Listings-Sync. |
| `STOCK_FAILURE_DRAIN_TENANTS` ([backend/index.js](../../../../backend/index.js) Z. 511) | `'trendocean'` | Stock-Failure-Drain. |

## Entscheidung

1. **Übergangs-Default `'default'`** für alle Module bleibt vorerst zulässig (verhindert Behavior-Change in bestehenden Deployments).
2. **`STOCK_FAILURE_DRAIN_TENANTS='trendocean'` bleibt** als Sonder-Default — entstand aus dem Oversell-Incident SKU-9871561937 (Production-Tenant Name).
3. **Neue Module**: kein impliziter `'default'`-Fallback mehr. Caller MUSS Tenant durchreichen; bei fehlendem Tenant `throw new Error('tenantId required')`.
4. **Migration-Pfad** (im Roadmap-Plan):
   a. Tenant-Custom-Claims via Firebase Auth einführen (`auth.setCustomUserClaims({ tenantId })`).
   b. `requireAuth` befüllt `req.tenantId`.
   c. Bestehende `lib/*`-Module schrittweise von `tenantId = 'default'` auf required-arg umstellen.
   d. `BACKGROUND_JOB_TENANTS` mit `STOCK_FAILURE_DRAIN_TENANTS` harmonisieren (gemeinsame Tenant-Registry-Collection).

## Konsequenzen

| Positiv | Negativ |
|---------|---------|
| Bestehende Deployments brechen nicht. | Single-Tenant-Implicit-Assumption bleibt im Code sichtbar. |
| Inkrementelle Migration möglich. | Operator-Aufmerksamkeit nötig: ENV-Set bei Tenant-Onboarding leicht zu vergessen. |
| Multi-Tenant-Fan-Out für Crons ist heute schon nutzbar. | Drift zwischen `BACKGROUND_JOB_TENANTS` und `STOCK_FAILURE_DRAIN_TENANTS` ist Fußangel. |

## Code-Anker

- Helper: [backend/lib/background-job-tenants.js](../../../../backend/lib/background-job-tenants.js).
- Cron-Mounts: [backend/index.js](../../../../backend/index.js) Z. 278–530.
- Legacy-Compat-Query: [backend/lib/firestore.js](../../../../backend/lib/firestore.js) Z. 2855–2862.

## Querverweise

- Multi-Tenant-Architektur: [../multi-tenancy.md](../multi-tenancy.md).
- Tenant-Propagation-Regel: [../../11-rules-and-invariants/tenant-propagation.md](../../11-rules-and-invariants/tenant-propagation.md).
- Hardening-Plan (extern, nicht im Repo): `/Users/oguz/.claude/plans/avycloud-roadmap-nachhaltig.md` — **muss verifiziert werden**.

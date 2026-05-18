---
title: Debugging
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# Debugging

> Tipps für Produktiv- und Lokal-Debugging.

## Cloud-Run-Logs

```bash
# Tail aller Logs
gcloud logging tail "resource.type=cloud_run_revision AND resource.labels.service_name=product-hub-backend" \
  --format="value(textPayload)" \
  --project=avycloud

# Letzte 50 Logs aus den letzten 10 Minuten
gcloud logging read \
  "resource.type=cloud_run_revision AND resource.labels.service_name=product-hub-backend AND timestamp>=\"$(date -u -v-10M +%Y-%m-%dT%H:%M:%SZ)\"" \
  --limit=50 --format="value(textPayload)" --project=avycloud

# Nur Errors
gcloud logging read \
  "resource.type=cloud_run_revision AND severity>=ERROR" \
  --limit=50 --project=avycloud
```

Strukturierte Log-Präfixe aus [backend/index.js](../../../backend/index.js) (alle Cron-Loops):

| Präfix | Quelle |
|--------|--------|
| `[order-sync]` | `backgroundSyncOrders` |
| `[returns-sync]` | safety-net cron |
| `[sendcloud-sync]` | safety-net cron |
| `[tracking-catchup]` | safety-net cron |
| `[delivery-poll]` | safety-net cron |
| `[invoice-sync]` | safety-net cron |
| `[refund-push]` | safety-net cron |
| `[kaufland-listings-sync]` | safety-net cron |
| `[reservation-cleanup]` | safety-net cron |
| `[stock-reconciliation]` | activity + full-scan |
| `[stock-failure-drain]` | Drain-Worker |
| `[restock-alert]` | Cron |
| `[sync-bus]` | [backend/services/sync-event-bus.js](../../../backend/services/sync-event-bus.js) |
| `[STARTUP-WARN]` | Identify-V4-Promotion-Gate |

## Frontend-Errors

- Browser DevTools → Console.
- `ErrorBoundary.tsx` fängt React-Render-Errors.
- `ErrorDashboard.tsx` zeigt aggregierte Backend-Errors aus `errorCollector`.

## Häufige Fehler-Muster

### „Tenant-Mismatch" / leere Listen / fehlende Records

| Symptom | Ursache | Fix |
|---------|---------|-----|
| Inventar leer, obwohl Produkte existieren | Query nutzt `tenantId='abc'`, Produkte tragen `tenantId='default'` (Legacy). | [backend/lib/firestore.js](../../../backend/lib/firestore.js) Z. 2855ff: bei `'default'` werden Docs ohne `tenantId` mitgezogen. Wenn anderer Tenant: explizit `tenantId` setzen oder Daten-Backfill. |
| Cron-Job schreibt nur für einen Tenant | `BACKGROUND_JOB_TENANTS` nicht gesetzt → Default `['default']`. | ENV setzen. |
| Stock-Drain läuft nicht für Tenant X | `STOCK_FAILURE_DRAIN_TENANTS` Default ist `'trendocean'`, nicht `'default'`. | ENV explizit setzen. |

Detail: [02-architecture/multi-tenancy.md](../02-architecture/multi-tenancy.md).

### Stock-Lock-Konflikt

| Symptom | Ursache | Fix |
|---------|---------|-----|
| `STOCK_LOCK_TIMEOUT` Errors in Logs | `lib/stock-lock.js` ist in-memory (Gap E in [TASKS.md](../../../TASKS.md)). Bei ≥2 Cloud-Run-Instanzen sehen Instanzen den Lock nicht. | Aktuell: `--min-instances 1, --max-instances 1` halten (Standard). Mittelfristig: Firestore-Lock-Backend implementieren. |
| Race zwischen Pick und Ship | Stock Single Writer ([adr/0002](../02-architecture/adr/0002-stock-single-writer.md)) → `claimOrderStockDecrementInTx` ist Tx-atomar; der zweite Versuch wird zum No-Op. | Erwartet, kein Bug. Logs zeigen `alreadyDecremented = true`. |

### Identify-Timeout

| Symptom | Ursache | Fix |
|---------|---------|-----|
| 504 von `/api/identify` nach ~6 min | `IDENTIFY_TOTAL_TIMEOUT_MS=360000` erreicht. | Bilder-Anzahl reduzieren, Pipeline-Choice prüfen (`?pipeline=v3` statt V4-Canary), ENV erhöhen wenn Cloud-Run `--timeout 600` matched. |
| V4 schlägt fehl, V3-Fallback wird nicht erreicht | Pre-Flip-Gate-Miss oder Worker-Exception. | Logs filtern: `[identify-v4]`. Operator setzt `IDENTIFY_V4_CRITIC_HINTS_VERIFIED=true` nach Lesen des [Promotion-Runbooks](../../runbooks/identify-v4-promotion.md). |
| Gemini Grounding 503/504 Outage | Bekannter Provider-Outage. | Emergency-Bypass `STAGE1_SKIP_FOCUSED_GROUNDING=true` (oder im Doppel-Outage `STAGE1_SKIP_V2_FALLBACK=true`). |

### Marketplace-Sync-Fehler

| Symptom | Ursache | Fix |
|---------|---------|-----|
| Stock-Mutation taucht nicht auf eBay/Kaufland auf | `emitSyncEvent('stock:changed', ...)` fehlte → siehe Punkt 10 [CLAUDE.md](../../../CLAUDE.md). | Code-Pfad prüfen; `stock_operation_failures`-Collection prüfen; Drain-Worker-Logs lesen. |
| `stock_operation_failures` füllt sich | Marketplace-API-Outage oder ungültige Credentials. | Drain-Worker retried automatisch alle 2 min. Bei `abandoned > 0` → manueller Eingriff. |
| Listing wird vorzeitig auf eBay beendet | Doppel-Decrement (Pfad A + Pfad B). | Repair-Script `node backend/scripts/repair-double-decrement.js`. |

## Lokal reproduzieren

1. **Dev-Server an Production-Firestore**: siehe [getting-started.md](getting-started.md) §Cloud-Verbindung. Achtung: lokale Mutationen gehen live.
2. **Firebase-Emulator** *(Annahme — heute nicht zwingend gesetupt; muss verifiziert werden)*: alternative isolierte Test-Umgebung.
3. **Mit Sample-Daten**: Tests in `backend/__tests__/` enthalten beispielhafte Inputs für die Pipelines.

Beispiel Identify-Smoke (V4):

```bash
cd backend
node scripts/smoke-identify-v4.js
```

## SSE-Streams debuggen

EventSource verbindet sich nicht? Token-Bridge in [backend/index.js](../../../backend/index.js) Z. 209ff erwartet `?token=<jwt>` — fehlt der Query-Param, kommt 401. Frontend-Hook: `hooks/useSSE.ts`.

Browser-Test:
```js
const es = new EventSource(`/api/identify/stream/JOBID?token=${jwt}`);
es.onmessage = (e) => console.log(e.data);
```

## Performance-Profiling

- `/api/health/identify` liefert Aggregat-Statistiken über `external_api_calls` (siehe [backend/lib/external-api-tracker.js](../../../backend/lib/external-api-tracker.js)).
- LLM-Latenz: `llm_call_telemetry`-Collection sampelt mit Rate `LLM_TELEMETRY_SAMPLE` (Default `0.1`). Query via Firestore Console oder Admin-LLM-Parity-UI.

## Verweise

- Pre-/Post-Flight-Checks: [AGENTS.md](../../../AGENTS.md).
- Feature-Flags: [feature-flags.md](feature-flags.md).
- Incident-Runbooks: [docs/runbooks/](../../runbooks/).

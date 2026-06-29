# Runbook — Web/Worker Split

**Seit:** 2026-06-29
**Grund:** Schwere Hintergrund-Jobs (eBay/Kaufland-Sync, Preisvergleiche, Bestands-Abgleich)
liefen auf denselben Cloud-Run-Instanzen wie die User-Requests. Bei `containerConcurrency=1`
blockierte jede offene SSE-Verbindung (`/api/events`, 601 s) eine ganze Instanz, sodass schwere
`POST /api/v2/identify`-Requests keinen freien Slot bekamen → Browser „Failed to fetch (HTTP 503)",
alle Produkte in „Produkt erfassen" scheiterten. Siehe Incident 2026-06-29.

## Architektur

Dasselbe Backend-Image (`backend/Dockerfile`) läuft als **zwei Cloud-Run-Services**:

| Service | Rolle | Wichtige Settings |
|---|---|---|
| `product-hub-backend` | **web** — nur HTTP-Requests | `RUN_BACKGROUND_JOBS=false`, concurrency=8, min=1/max=80, ingress=all |
| `product-hub-worker` | **worker** — ALLE Background-Jobs | `RUN_BACKGROUND_JOBS=true`, `--no-cpu-throttling`, min=1/max=1, concurrency=1, ingress=internal |

Das Frontend zeigt nur auf `product-hub-backend`. Der Worker hat keinen öffentlichen Traffic.

## Der Schalter

`backend/lib/process-role.js`:
```js
shouldRunBackgroundJobs(env) // → env.RUN_BACKGROUND_JOBS !== 'false'  (default TRUE)
```
Verdrahtet in `backend/index.js`:
- Der **Runner-Block** (`startJobRunner` … `startCompetitorRefreshRunner`) steht in `if (RUN_BACKGROUND_JOBS) { … }`.
- Der **Cron-Block** im `server.listen`-Callback wird per früherem `return` übersprungen, wenn das Flag aus ist.

**Default ist TRUE** → jede Umgebung ohne das Flag (lokal, alte Deployments) fährt wie bisher
alles in einem Prozess. Der Split ist damit inert, bis der web-Service explizit auf `=false` steht.

### Neue Background-Jobs hinzufügen
Neue Cron-/Runner-Jobs IMMER in den `if (RUN_BACKGROUND_JOBS)`-Block (Runner) bzw. nach dem
`if (!RUN_BACKGROUND_JOBS) return;` (Cron) setzen — dann laufen sie automatisch nur auf dem Worker.
Niemals Background-Arbeit außerhalb des Gates starten (sonst läuft sie wieder auf dem web-Service).

## Deploy / Sustainability

Die main→Deploy-Pipeline ist Cloud Run **managed source-deploy** (kein `cloudbuild.yaml`):
- Trigger `rmgpgab-product-hub-backend-…` → baut Dockerfile → `gcloud run services update product-hub-backend`.
- Trigger `deploy-product-hub-worker-on-main` (id 3c00c077, region global) → baut dasselbe Dockerfile
  → `gcloud run services update product-hub-worker`.

`services update --image` **bewahrt** die übrigen Settings (env inkl. `RUN_BACKGROUND_JOBS`, Secrets,
Scaling). Beide Services bleiben so bei jedem main-Push automatisch code-synchron.

Der Worker-Service wurde einmalig via `gcloud run services replace` mit allen Secrets aus der
exportierten web-Spec erstellt.

## Verifikation
```bash
# web läuft request-only?
gcloud logging read 'resource.labels.service_name="product-hub-backend" AND textPayload=~"request-only mode"' --freshness=10m --project=avycloud
# worker fährt die Crons?
gcloud logging read 'resource.labels.service_name="product-hub-worker" AND textPayload=~"safety-net enabled"' --freshness=10m --project=avycloud
```

## Rollback
1. Schnell: `gcloud run services update product-hub-backend --region europe-west3 --update-env-vars RUN_BACKGROUND_JOBS=true`
   → der web-Service fährt wieder ALLE Jobs (Worker läuft dann doppelt → Worker pausieren/löschen).
2. Vollständig: Worker-Service + Trigger `deploy-product-hub-worker-on-main` löschen.

`containerConcurrency=8` ist davon unabhängig (Cloud Run bewahrt es über Deploys; Rollback `--concurrency 1`).

## Bekannte Einschränkung
`bus.emit('listings:sync_completed')` (in `listing-sync-runner.js`) ist prozess-intern. Da der
SSE-Consumer (`/api/events`) auf dem web-Service lebt, überquert dieses eine UI-Auto-Refresh-Signal
die Prozessgrenze nicht mehr (rein kosmetisch — Cache-Invalidierung; manuelles Neuladen zeigt den
Stand). Bei Bedarf über ein durables Signal (Firestore-Listener) neu verdrahten.

---
title: Backend-Deploy
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# Backend-Deploy

> Geprüfte Quellen: [backend/cloudbuild.yaml](../../../backend/cloudbuild.yaml), [backend/Dockerfile](../../../backend/Dockerfile), [backend/package.json](../../../backend/package.json), [backend/index.js](../../../backend/index.js).

## Trigger

Push auf `main` → Cloud Build Trigger *(Annahme: Cloud-Build-Trigger auf den `avycloud`-GCP-Project Repo-Push; muss verifiziert werden über GCP Console)*.

## Cloud-Build-Schritte (verifiziert in [backend/cloudbuild.yaml](../../../backend/cloudbuild.yaml))

| # | Step | Zweck |
|---|------|-------|
| 1 | `node --check index.js` | Syntax-Smoke (Duplikat-Declarations, Syntax-Errors). |
| 2 | `npm ci --omit=dev` im `backend/` | Production-Deps installieren. |
| 3 | `node backend/scripts/extract-moto-epid-jsonl.js` mit `NODE_PATH=/workspace/backend/node_modules` | Motorcycle ePID Compact-Dataset generieren in `/exports`, damit das Runtime-Image die Daten mitbringt. |
| 4 | `node --check lib/title-policy.js` | Syntax-Smoke. |
| 5 | `node --check services/product-chat.js` | Syntax-Smoke (frequently touched). |
| 6 | `docker build -f Dockerfile -t gcr.io/$PROJECT_ID/product-hub-backend:$_TAG -t :latest` | Image bauen. |
| 7 | `docker push :$_TAG` + `docker push :latest` | Zwei Tags pushen. |
| 8 | `gcloud run deploy product-hub-backend ...` (siehe unten) | Cloud-Run-Deploy. |

## Cloud-Run-Deploy-Parameter

```
gcloud run deploy product-hub-backend \
  --image gcr.io/$PROJECT_ID/product-hub-backend:$_TAG \
  --memory 3Gi \
  --cpu 2 \
  --min-instances 1 \
  --region europe-west3 \
  --platform managed \
  --allow-unauthenticated \
  --timeout 600 \
  --update-env-vars USE_PRODUCTS_V2=true
```

| Parameter | Wert |
|-----------|------|
| Region | `europe-west3` (Frankfurt) |
| Memory | 3 GiB |
| CPU | 2 |
| Min Instances | 1 (cold-start vermeiden) |
| Max Instances | nicht gesetzt → GCP-Default *(muss verifiziert werden)* |
| Timeout | 600 s (10 min) |
| Public | `--allow-unauthenticated` (Auth auf App-Layer in [backend/lib/auth.js](../../../backend/lib/auth.js)) |
| Pinned ENV | `USE_PRODUCTS_V2=true` |

## Image-Strategie

| Tag | Lebenszyklus |
|-----|--------------|
| `latest` | Wird bei jedem erfolgreichen Build überschrieben. |
| `$_TAG` | Default `latest` (siehe `substitutions._TAG`); für historische Builds kann ein Operator den Trigger mit explizitem `_TAG=v2026-05-18` starten. |

## Build-Kontext

[backend/Dockerfile](../../../backend/Dockerfile) baut aus dem `backend/`-Unterverzeichnis (`COPY package*.json ./`, `RUN npm ci --only=production`, `COPY . .`). Base-Image: `node:20-slim`. Port: `8080`. CMD: `npm start` → `node --max-old-space-size=3584 index.js`.

## Memory-Tuning

Cloud-Run-Limit 3 GiB. V8-Old-Space-Size `--max-old-space-size=3584` (= 3 584 MiB) lässt ~512 MiB Headroom für native Modules + Off-Heap-Allokationen (Sharp, Stream-JSON). Quelle: [backend/package.json](../../../backend/package.json) `start`-Script.

## Pre-Flip-Gate (Identify-V4)

Beim Container-Start prüft [backend/index.js](../../../backend/index.js) Z. 48ff:

- Wenn `IDENTIFY_V4=true` UND `IDENTIFY_V4_CRITIC_HINTS_VERIFIED!=true` → STARTUP-WARN im Log + best-effort Slack-Alert (`SLACK_ALERTS_URL`).
- **NIE Throw / Exit** — Cloud-Run-Service MUSS starten.

Operator-Pflicht: [docs/runbooks/identify-v4-promotion.md](../../runbooks/identify-v4-promotion.md) lesen, `IDENTIFY_V4_CRITIC_HINTS_VERIFIED=true` setzen, dann `IDENTIFY_V4=true` flippen.

## Initialisierung beim Boot

Aus [backend/index.js](../../../backend/index.js):

| Aufruf | Zweck |
|--------|-------|
| `startJobRunner()`, `startImproveRunner()`, `startQualityRunner()`, `startRulebookRunner()` | Job-Worker für Identify / Improve / Quality / Rulebook. |
| `startAdminBulkRunner()`, `startPricingRunner()`, `startListingSyncRunner()`, `startCompetitorRefreshRunner()` | Optionale Runner — fail-soft. |
| `ensureDefaultRoles()`, `ensureBootstrapAdmin()`, `ensureDefaultLlmScopes()`, `ensureDefaultLlmScopeVersions()` | Default-Daten seeden. |
| Safety-Net-Crons | Siehe [02-architecture/backend.md](../02-architecture/backend.md). |

## ENV-Vars

Konkrete Production-Values + Secret-Manager-Referenzen: [env-vars.md](env-vars.md).

## Rollback

Siehe [rollback.md](rollback.md) §Backend (Cloud-Run-Traffic-Allocation).

## Verweise

- Cloud-Build: [backend/cloudbuild.yaml](../../../backend/cloudbuild.yaml).
- Dockerfile: [backend/Dockerfile](../../../backend/Dockerfile).
- CI/CD-Pipeline-Überblick (Front + Back): [cicd-pipeline.md](cicd-pipeline.md).

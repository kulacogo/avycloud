---
title: Production-ENV-Katalog
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# Production-ENV-Katalog

> Diese Seite listet die ENV-Vars, die in **Production** gesetzt sein müssen oder per Default greifen. Vollständige Flag-Beschreibungen mit Wirkungen: [03-development/feature-flags.md](../03-development/feature-flags.md).

## Wo ENV-Vars in Production gesetzt werden

| Quelle | Was darin lebt |
|--------|----------------|
| [backend/cloudbuild.yaml](../../../backend/cloudbuild.yaml) `--update-env-vars` | Per Deploy gepinnte Werte (`USE_PRODUCTS_V2=true`). |
| Cloud Run Service-Konfiguration (manuell via GCP Console / `gcloud run services update`) | Stable ENV-Vars und Feature-Flags (Identify-, Chat-, Tenant-, Cron-Tunings). |
| **Secret Manager** (per `--set-secrets`) | Geheime Credentials für Marketplaces, Gemini, SendCloud, SevDesk. |
| [.github/workflows/firebase-hosting.yml](../../../.github/workflows/firebase-hosting.yml) | Frontend-Build-Variablen (`VITE_*`). |

## In `cloudbuild.yaml` gepinnte ENV-Vars

Aus [backend/cloudbuild.yaml](../../../backend/cloudbuild.yaml) Z. 83–85:

```yaml
'--update-env-vars',
'USE_PRODUCTS_V2=true',
```

Diese Werte werden bei **jedem** Deploy neu gesetzt — überschreiben ältere manuelle Cloud-Run-Settings für diese Variable.

## Backend-ENV in Production (Stable Set)

Pflicht — ohne diese läuft das Backend nicht sauber:

| Variable | Quelle | Hinweis |
|----------|--------|---------|
| `PORT` | Cloud Run setzt automatisch (8080) | — |
| `USE_PRODUCTS_V2` | cloudbuild.yaml (`true`) | Punkt 7 [CLAUDE.md](../../../CLAUDE.md). |
| `AUTH_ALLOWED_EMAIL_DOMAIN` | Cloud Run ENV oder Default `trendocean.de` | Heute Single-Tenant-Default. |
| `AUTH_BOOTSTRAP_ADMIN_EMAIL` | Cloud Run ENV oder Default `admin@trendocean.de` | — |
| `GOOGLE_APPLICATION_CREDENTIALS` | Auf Cloud Run nicht nötig (Metadata-Server) | Lokal nötig für `gcloud auth application-default login`. |

Empfohlen für Production-Beobachtung:

| Variable | Default | Empfehlung |
|----------|---------|-----------|
| `BACKGROUND_JOB_TENANTS` | leer → `['default']` | Setzen sobald Multi-Tenant aktiv ist (z. B. `trendocean,avycloud`). |
| `STOCK_FAILURE_DRAIN_TENANTS` | `'trendocean'` | Pro-Tenant-Liste explizit pflegen. |
| `LLM_TELEMETRY_SAMPLE` | `0.1` | Nicht > 0.5 setzen ohne 24-h-Plan, sonst Auto-Downgrade. |
| `EXTERNAL_API_TRACKER_SAMPLE_RATE` | `1.0` | Nach 2 Wochen Baseline auf `0.1` drosseln. |
| `SLACK_ALERTS_URL` | unset | Setzen damit Startup-WARN bei `IDENTIFY_V4`-Promotion-Gate-Miss alertiert. |

Feature-Flag-Defaults und Wirkungen: [03-development/feature-flags.md](../03-development/feature-flags.md).

## Geheime ENV-Vars (Secret Manager)

Aus [backend/lib/integration-registry.js](../../../backend/lib/integration-registry.js) — Field `secretKeys` pro Provider:

| Provider | Secrets | Zweck |
|----------|---------|-------|
| **eBay** | `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, `EBAY_RU_NAME` | OAuth 2.0 mit RuName (`avycloud-...`). |
| **Kaufland** | `KAUFLAND_CLIENT_KEY`, `KAUFLAND_SECRET_KEY` | Seller-API (HMAC-signed). |
| **SendCloud** | `SENDCLOUD_PUBLIC_KEY`, `SENDCLOUD_SECRET_KEY` | Basic-Auth für REST. |
| **SevDesk** | `SEVDESK_API_TOKEN` | API-Token (Hex). |

Weitere Secrets vermutet — **müssen verifiziert werden** über GCP Console „Secret Manager":

| Vermutet | Zweck |
|----------|-------|
| `GEMINI_API_KEY` oder ADC | Gemini-Calls |
| `SERPAPI_KEY` | SerpAPI für Chat-Legacy / Web-Search Tools |
| `BRIGHTDATA_*` | BrightData Web-Unlocker für Chat-Legacy |
| `FIREBASE_*` (private Service-Account) | Firebase-Admin |
| `SLACK_ALERTS_URL` | Optional Alert-Webhook |

Heutige Empfehlung: alle Secrets im **Secret Manager** ablegen und in Cloud Run via `--set-secrets KEY=secretName:latest` injizieren. Niemals als Plain-ENV im Deploy-Skript.

## Frontend-ENV (Vite-Build)

Aus [.github/workflows/firebase-hosting.yml](../../../.github/workflows/firebase-hosting.yml):

| Variable | Pflicht | Quelle | Validierung |
|----------|---------|--------|-------------|
| `VITE_FIREBASE_API_KEY` | ✅ | GitHub Variable/Secret | Required-Check fail-fast. |
| `VITE_FIREBASE_AUTH_DOMAIN` | ✅ | GitHub Variable/Secret | dito. |
| `VITE_FIREBASE_PROJECT_ID` | ✅ | GitHub Variable/Secret | dito. |
| `VITE_FIREBASE_APP_ID` | ✅ | GitHub Variable/Secret | dito. |
| `VITE_FIREBASE_STORAGE_BUCKET` | empfohlen | GitHub Variable/Secret | — |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | empfohlen | GitHub Variable/Secret | — |
| `VITE_BACKEND_URL` | optional | GitHub Variable/Secret | Origin-only (kein Path/Query/Hash). |
| `VITE_BACKEND_FALLBACK_URLS` | optional | GitHub Variable/Secret | Komma-separierte Origins; origin-only. |
| `VITE_AUTH_PERSISTENCE` | optional | GitHub Variable/Secret | `'session' \| 'local' \| 'none'`. Code-Default `'session'`. |

GitHub-Action-Secret zusätzlich:

- `FIREBASE_SERVICE_ACCOUNT` — JSON für Hosting-Deploy.
- `GITHUB_TOKEN` — automatisch von GitHub Actions bereitgestellt.

## ENV-Var-Diff zwischen Code-Default und Production

Diese ENV-Vars haben unterschiedliche „Defaults" je nach Pfad — Operator-Aufmerksamkeit nötig:

| ENV | Code-Default | Production-Empfehlung | Wo dokumentiert |
|-----|--------------|------------------------|------------------|
| `BACKGROUND_JOB_TENANTS` | `['default']` | `trendocean` (Single-Tenant-Production) bzw. komma-separierte Liste | [adr/0006-tenant-default-policy.md](../02-architecture/adr/0006-tenant-default-policy.md) |
| `STOCK_FAILURE_DRAIN_TENANTS` | `'trendocean'` | gleich | [backend/index.js](../../../backend/index.js) Z. 511 |
| `IDENTIFY_V4` | `false` | `false` (dark-deployed; nur via Canary aktiv) | [adr/0004-identify-v3-v4-cascade.md](../02-architecture/adr/0004-identify-v3-v4-cascade.md) |
| `IDENTIFY_V4_CRITIC_HINTS_VERIFIED` | `false` | Pflicht `true` *bevor* `IDENTIFY_V4=true` geflippt wird | [docs/runbooks/identify-v4-promotion.md](../../runbooks/identify-v4-promotion.md) |
| `USE_PRODUCTS_V2` | per Code-Logik | `true` (cloudbuild gepinnt) | [adr/0001-products-v2.md](../02-architecture/adr/0001-products-v2.md) |

## Runtime-Override (Firestore-Doc)

Aus [docs/standards/llm-quality-parity.md](../../standards/llm-quality-parity.md) §Cost-Discipline: `system/llm-telemetry-state`-Doc kann `LLM_TELEMETRY_SAMPLE` runtime-überschreiben — ENV gewinnt bei Konflikt, Auto-Downgrade nach 24 h.

## Verweise

- Feature-Flag-Katalog: [03-development/feature-flags.md](../03-development/feature-flags.md).
- Cloud-Build: [backend/cloudbuild.yaml](../../../backend/cloudbuild.yaml).
- Frontend-Workflow: [.github/workflows/firebase-hosting.yml](../../../.github/workflows/firebase-hosting.yml).
- Auth: [02-architecture/auth-and-rbac.md](../02-architecture/auth-and-rbac.md).

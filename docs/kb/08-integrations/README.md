---
title: Integration-Registry-Overview
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# Integrations — Registry-Overview

> Quelle der Wahrheit: [backend/lib/integration-registry.js](../../../backend/lib/integration-registry.js).
> Diese Tabelle ist die Kurzübersicht. Pro Provider gibt es eine eigene Detail-Seite mit Auth, Endpoints, Webhooks, Rate-Limits und bekannten Schwächen.

## Konfigurierbare Provider (UI + Backend)

| Provider | Category | AuthType | Secrets (Secret-Manager) | Doku | Status |
|----------|----------|----------|--------------------------|------|--------|
| **eBay** | marketplaces | oauth2 | `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, `EBAY_RU_NAME` (+ Trading: `EBAY_TRADING_APP_ID`, `EBAY_TRADING_DEV_ID`, `EBAY_TRADING_CERT_ID`, `EBAY_TRADING_USER_TOKEN`) | [ebay.md](ebay.md) | Produktiv |
| **Kaufland** | marketplaces | api_key | `KAUFLAND_CLIENT_KEY`, `KAUFLAND_SECRET_KEY` (Webhook: `KAUFLAND_WEBHOOK_SECRET`) | [kaufland.md](kaufland.md) | Produktiv |
| **SendCloud** | shipping | api_key | `SENDCLOUD_PUBLIC_KEY`, `SENDCLOUD_SECRET_KEY` | [sendcloud.md](sendcloud.md) | Produktiv |
| **SevDesk** | finance | api_key | `SEVDESK_API_TOKEN` | [sevdesk-invoicing.md](sevdesk-invoicing.md) | Produktiv (kein eigenes Push-Modul; inline in [services/invoice-engine.js](../../../backend/services/invoice-engine.js)) |
| **DHL** | shipping | none (depends_on `sendcloud`) | — | siehe [sendcloud.md](sendcloud.md) | Über SendCloud |

## Implizite / nicht in der Registry exponierte Provider

Diese Dienste sind im Code genutzt, aber nicht über das Settings-UI konfigurierbar.

| Provider | Wofür | Auth | Secret-Manager | Doku |
|----------|-------|------|----------------|------|
| **Firebase** (Auth + Firestore + Hosting) | Plattform-Backbone | Application Default Credentials (Cloud Run Service-Account) | — (ADC) | [firebase.md](firebase.md) |
| **Google Gemini** | KI-Identify, Chat, Vision | API-Key | `GEMINI_API_KEY` / `GOOGLE_GENAI_API_KEY` | [gemini.md](gemini.md) |
| **SerpAPI** | Preisrecherche, eBay-Sold-Listings, Amazon-Routing | API-Key | `SERPAPI_KEY` | [serpapi.md](serpapi.md) |
| **Bright Data** (Web-Unlocker) | HTML/Image-Fallback für blockierte Quellen, Image-Proxy | Bearer-Token | `BRIGHTDATA_API_TOKEN` | [brightdata.md](brightdata.md) |
| **Google Secret Manager** | Credential-Storage für alle Provider | Service-Account (ADC) | — | siehe [firebase.md](firebase.md) §Secret Manager |

## Webhook-Endpoints (eingehend)

Alle drei Endpoints sind **public** (kein `requireAuth`), Verifikation pro Provider unterschiedlich. Details und aktueller Hardening-Status: [webhook-signing.md](webhook-signing.md).

| Pfad | Provider | Signatur-Verifikation | Status |
|------|----------|----------------------|--------|
| `POST /api/webhooks/sendcloud` | SendCloud | Basic-Auth-Decode + Query-Param-Match gegen `SENDCLOUD_SECRET_KEY` | **fail-open** wenn Secret fehlt |
| `POST /api/webhooks/kaufland` | Kaufland | HMAC-SHA256 (`X-Kaufland-Signature`) gegen `KAUFLAND_WEBHOOK_SECRET` | **vermutlich gebrochen** (HMAC über `JSON.stringify(req.body)` ≠ raw body) |
| `POST /api/webhooks/ebay` | eBay | — | **keine Verifikation**, nur Challenge-Hash-Response |

## Kategorien (aus Registry)

- `marketplaces` — eBay, Kaufland
- `shipping` — SendCloud, DHL (via SendCloud)
- `finance` — SevDesk
- `other` — (derzeit leer in Registry)

## Tabu

- **retired middleware ist verboten** (CLAUDE.md Punkt 9). Keine neuen Imports, Referenzen oder ENV-Vars.

## Owner

Engineering-Team. Jede Integration hat in der jeweiligen Detail-Seite einen Owner-Hinweis.

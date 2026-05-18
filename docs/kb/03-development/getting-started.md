---
title: Getting Started — Dev-Setup
for: [dev, agent]
lastReviewed: 2026-05-18
---

# Getting Started — Dev-Setup

> Geprüfte Quellen: [package.json](../../../package.json), [backend/package.json](../../../backend/package.json), [vite.config.ts](../../../vite.config.ts), [.env.example](../../../.env.example), [backend/index.js](../../../backend/index.js), [.github/workflows/firebase-hosting.yml](../../../.github/workflows/firebase-hosting.yml).

## Voraussetzungen

| Tool | Version | Hinweis |
|------|---------|---------|
| Node.js | `>= 20` | Backend benötigt `>=18.0.0` ([backend/package.json](../../../backend/package.json)), Frontend nutzt `20` im CI ([.github/workflows/firebase-hosting.yml](../../../.github/workflows/firebase-hosting.yml)). |
| npm | aktuell | Wird mit Node ausgeliefert. |
| Firebase-Project | `avycloud` | Für Auth + Firestore + Hosting. |
| GCP-Project | `avycloud` | Für Cloud Run + Secret Manager + Storage. |
| Git | aktuell | — |
| (Optional) `firebase-tools@14` | für lokales Hosting-Deploy ([.github/workflows/firebase-hosting.yml](../../../.github/workflows/firebase-hosting.yml) pinnt v14 wegen `minimatch`-Bug). |

## Klon + Install

```bash
git clone <repo-url> avycloud
cd avycloud

# Frontend-Dependencies
npm install

# Backend-Dependencies
cd backend
npm install
cd ..
```

## ENV-Setup

### Frontend (Vite, `.env.local` im Repo-Root)

Pflicht-Variablen (aus [.env.example](../../../.env.example)):

```
VITE_FIREBASE_API_KEY=your-api-key-here
VITE_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your-project-id
VITE_FIREBASE_STORAGE_BUCKET=your-project.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=000000000000
VITE_FIREBASE_APP_ID=your-app-id
```

Optional (für Backend-Override im Build):

```
VITE_BACKEND_URL=https://product-hub-backend-XXXX-ew.a.run.app
VITE_BACKEND_FALLBACK_URLS=https://...,https://...
VITE_AUTH_PERSISTENCE=local|session|none
```

> **Hinweis**: `VITE_BACKEND_URL` MUSS origin-only sein (kein Path, kein Query, kein Hash) — der CI-Job validiert das ([.github/workflows/firebase-hosting.yml](../../../.github/workflows/firebase-hosting.yml) Z. 49ff).

### Backend (`.env` im Repo-Root oder `backend/.env`)

Eine vollständige `.env.example` für das Backend existiert in den geprüften Quellen **nicht** — **muss verifiziert werden**. Minimal-Set für lokales Starten:

| Variable | Zweck | Default |
|----------|-------|---------|
| `PORT` | HTTP-Port | `8080` |
| `USE_PRODUCTS_V2` | aktive Produkt-Collection | `true` (Production-fix) |
| `AUTH_ALLOWED_EMAIL_DOMAIN` | E-Mail-Domain-Whitelist | `trendocean.de` |
| `AUTH_BOOTSTRAP_ADMIN_EMAIL` | Bootstrap-Admin | `admin@trendocean.de` |
| `GOOGLE_APPLICATION_CREDENTIALS` | Pfad zu Service-Account-JSON (für lokales Firestore + Gemini) | — |
| `GEMINI_API_KEY` | Gemini-API-Key (wenn ohne ADC) | — |

Erweiterter Katalog: [feature-flags.md](feature-flags.md) und [04-deployment/env-vars.md](../04-deployment/env-vars.md).

## Start

```bash
# Frontend (Port 3000, vite.config.ts)
npm run dev

# Backend (Port 8080, oder PORT-ENV)
cd backend
npm start
```

Das Backend lädt sofort:
- Default-Rollen (`ensureDefaultRoles`),
- Bootstrap-Admin (`ensureBootstrapAdmin`),
- LLM-Scopes (`ensureDefaultLlmScopes`).

Außerdem starten alle Runner + Safety-Net-Crons (siehe [02-architecture/backend.md](../02-architecture/backend.md)).

## Tests

```bash
cd backend
npm test              # Vitest run (single-pass)
npm run test:watch    # Vitest watch-mode
```

Setup-Details: [testing.md](testing.md).

## Build prüfen (Frontend)

```bash
npm run build         # vite build → dist/
```

Test ohne CDN-Cache: `npm run preview` (siehe [package.json](../../../package.json) Scripts).

## Cloud-Verbindung (lokal)

Für lokales Backend gegen Production-Firestore:

```bash
gcloud auth application-default login
export GOOGLE_APPLICATION_CREDENTIALS=$(gcloud info --format='value(config.paths.global_config_dir)')/application_default_credentials.json
cd backend && npm start
```

> Achtung: lokal mit Production-Firestore arbeiten = lokale Mutations gehen live. Lieber gegen Firebase Emulator oder einen Dev-Tenant ausführen.

## Wichtige Verweise

- Code-Stil: [code-style.md](code-style.md).
- Tests: [testing.md](testing.md).
- Commit-Workflow: [commit-workflow.md](commit-workflow.md).
- Feature-Flags: [feature-flags.md](feature-flags.md).
- Debugging: [debugging.md](debugging.md).
- Pre-/Post-Flight: [AGENTS.md](../../../AGENTS.md).

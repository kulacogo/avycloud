---
title: Frontend-Deploy
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# Frontend-Deploy

> Geprüfte Quellen: [.github/workflows/firebase-hosting.yml](../../../.github/workflows/firebase-hosting.yml), [firebase.json](../../../firebase.json), [package.json](../../../package.json).

## Trigger

Push auf `main` → GitHub Action `Deploy Frontend to Firebase Hosting` ([.github/workflows/firebase-hosting.yml](../../../.github/workflows/firebase-hosting.yml)).

## Job-Steps (Reihenfolge)

1. **Checkout** Repository (`actions/checkout@v4`).
2. **Setup Node** 20 (`actions/setup-node@v4`).
3. **Install Dependencies** `npm ci`.
4. **Verify required frontend env vars** — Shell-Loop prüft Pflicht-Variablen:
   - `VITE_FIREBASE_API_KEY`
   - `VITE_FIREBASE_AUTH_DOMAIN`
   - `VITE_FIREBASE_PROJECT_ID`
   - `VITE_FIREBASE_APP_ID`

   Fehlt eine, schlägt der Job mit `::error::Missing required build env var: …` fehl.
5. **Validate backend URL env format** — Node-Script prüft `VITE_BACKEND_URL` und `VITE_BACKEND_FALLBACK_URLS` auf:
   - gültige absolute URL,
   - origin-only (kein Path, kein Query, kein Hash). Fehler bricht den Job.
6. **Build frontend** `npm run build` → `vite build` → `dist/` Artefakt.
7. **Install firebase-tools (pinned)** — `npm install -g firebase-tools@14` (pinned wegen `minimatch@5.1.9`-Bug in `firebase-tools@15.7.0`).
8. **Deploy to Firebase Hosting** — `FirebaseExtended/action-hosting-deploy@v0`:
   - `channelId: live`
   - `projectId: avycloud`
   - Service-Account via Secret `FIREBASE_SERVICE_ACCOUNT`.
   - Token via `GITHUB_TOKEN` (für PR-Channel-Comments).

## Pflicht-Secrets (GitHub Actions)

| Variable | Quelle | Pflicht |
|----------|--------|---------|
| `VITE_FIREBASE_API_KEY` | GitHub Variable (preferred) ODER Secret | ✅ |
| `VITE_FIREBASE_AUTH_DOMAIN` | Variable/Secret | ✅ |
| `VITE_FIREBASE_PROJECT_ID` | Variable/Secret | ✅ |
| `VITE_FIREBASE_APP_ID` | Variable/Secret | ✅ |
| `VITE_FIREBASE_STORAGE_BUCKET` | Variable/Secret | empfohlen |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | Variable/Secret | empfohlen |
| `VITE_BACKEND_URL` | Variable/Secret | optional (origin-only) |
| `VITE_BACKEND_FALLBACK_URLS` | Variable/Secret | optional |
| `VITE_AUTH_PERSISTENCE` | Variable/Secret | optional |
| `FIREBASE_SERVICE_ACCOUNT` | Secret | ✅ — Service-Account-JSON für Hosting-Deploy |

Bevorzugt **GitHub Actions Variables** statt Secrets für nicht-geheime Werte (Firebase Public Config), damit sie im UI sichtbar bleiben.

## Firebase Hosting Konfiguration

[firebase.json](../../../firebase.json):

| Eigenschaft | Wert |
|-------------|------|
| Hosting-Site | `avycloud` |
| Public-Folder | `dist` |
| Ignore | `firebase.json`, `**/.*`, `**/node_modules/**`, `backend/**`, `README.md`, `metadata.json` |
| SPA-Rewrite | `**` → `/index.html` |
| Firestore-Indexes-Quelle | `firestore.indexes.json` |

### Caching-Header

| Pfad | Header |
|------|--------|
| `/service-worker.js` | `Cache-Control: no-cache, no-store, must-revalidate` |
| `/index.html` | `Cache-Control: no-cache, no-store, must-revalidate` |
| `**/*.{js,jsx,ts,tsx}` | `Content-Type: text/javascript; charset=utf-8` |
| `**/*.{jpg,jpeg,gif,png,webp,avif}` | `Cache-Control: public, max-age=7200` |

> SPA-Shells (`index.html` + Service-Worker) NIE cachen → keine stale Builds nach Deploy.
> JS/TS-Endpoints expliziter Content-Type → Workaround für Firebase-Hosting-MIME-Inkonsistenzen.

## Hosting-Targets

Single-Site: `avycloud`. Aktuell keine PR-Preview-Channels konfiguriert *(Annahme — die Action akzeptiert sie, wird aber heute nur für `channelId: live` genutzt)*.

## Rollback

Siehe [rollback.md](rollback.md) §Frontend.

## Verweise

- Vite-Config: [vite.config.ts](../../../vite.config.ts).
- TS-Config: [tsconfig.json](../../../tsconfig.json).
- Workflow: [.github/workflows/firebase-hosting.yml](../../../.github/workflows/firebase-hosting.yml).

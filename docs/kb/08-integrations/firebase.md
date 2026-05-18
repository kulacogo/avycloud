---
title: "Integration: Firebase (Auth + Firestore + Hosting)"
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# Firebase

> Plattform-Backbone: **Firebase Authentication** (JWT-Verifikation für Backend-Requests), **Firestore** (primäre OLTP-DB), **Firebase Hosting** (Frontend-Auslieferung).
> Nicht in der `integration-registry.js` — Firebase ist Infrastruktur, kein Settings-konfigurierbarer Provider.

## Was integriert ist

- **Authentication:** Frontend logged sich via Firebase Auth ein (Google Sign-In / Email-Link), Backend verifiziert das ID-Token aus dem `Authorization: Bearer …`-Header. Implementiert in [backend/lib/auth.js](../../../backend/lib/auth.js).
- **Authorization Gate:** E-Mail-Domain-Whitelist + Bootstrap-Admin-Override. Siehe §Email-Domain-Gate.
- **Firestore:** alle Collections (`products_v2`, `orders`, `shipments`, `integrations`, `oauthStates`, `inventory_ledger`, …). Application Default Credentials via Cloud-Run-Service-Account.
- **Firebase Hosting:** Frontend (React 18 + Vite) deployed via GitHub Actions auf `firebase deploy --only hosting` (siehe `.github/workflows/firebase-hosting.yml`).
- **RBAC:** [backend/lib/rbac.js](../../../backend/lib/rbac.js) erweitert die Auth um Permission-Modell (per-Route `requirePermission`).

## Auth + Credentials

### Backend-Auth (JWT-Verifikation)

- Modul: [backend/lib/auth.js](../../../backend/lib/auth.js) + [backend/lib/firebaseAdmin.js](../../../backend/lib/firebaseAdmin.js).
- Workflow:
  1. Frontend sendet `Authorization: Bearer <ID_TOKEN>` (firebase-auth JS-SDK signiert das).
  2. `extractBearerToken(req)` regex-matched `Bearer …`.
  3. `getAdminAuth().verifyIdToken(idToken, true)` validiert Signatur + `checkRevoked: true`.
  4. Decoded-Claims werden gegen Email-Domain-Gate + Bootstrap-Admin geprüft.
  5. Bei Erfolg: `req.user = { uid, email, isAdmin, emailVerified, claims }`.
- **Allowlist für public Endpoints** in [backend/index.js](../../../backend/index.js): `OPTIONS` (CORS-Preflight), `/api/image-proxy` (kein Header möglich aus `<img src>`), `/api/ebay/oauth/callback` (eBay-Redirect).

### Firebase-Admin-Init

- [backend/lib/firebaseAdmin.js](../../../backend/lib/firebaseAdmin.js) nutzt **Application Default Credentials**:
  ```js
  admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: getProjectId() });
  ```
- `projectId` resolved aus `GOOGLE_CLOUD_PROJECT || GCLOUD_PROJECT || FIREBASE_PROJECT_ID || 'avycloud'`.
- Auf Cloud Run kommt das Token automatisch über den Service-Account (Cloud-Run-Identity); lokal über `gcloud auth application-default login`.

### Frontend-Auth

- Frontend nutzt das standard Firebase JS-SDK (`firebase/auth`), Provider-Config lebt im Frontend-Code (kein Backend-Geheimnis).
- Sign-In-Methoden ergeben sich aus Firebase-Console-Setup (nicht im Repo dokumentiert).

## Email-Domain-Gate

Implementiert in [backend/lib/auth.js](../../../backend/lib/auth.js):

```js
const DEFAULT_ALLOWED_DOMAIN = 'trendocean.de';
const DEFAULT_BOOTSTRAP_ADMIN_EMAIL = 'admin@trendocean.de';
```

- **Allowed Domain:** `process.env.AUTH_ALLOWED_EMAIL_DOMAIN` overridet (default `trendocean.de`). Geprüft via `email.endsWith('@${domain}')`.
- **Bootstrap Admin:** `process.env.AUTH_BOOTSTRAP_ADMIN_EMAIL` overridet (default `admin@trendocean.de`).
- Logik:
  - Email-Domain nicht in Allowlist → `403 Forbidden: email domain not allowed`.
  - Email verified `=== false` UND nicht Bootstrap-Admin → `403 Forbidden: email not verified`.
  - Bootstrap-Admin: `isAdmin: true` flag im `req.user`, darf ohne Email-Verification rein.
- Multi-Tenant-Hinweis: Bootstrap-Admin ist **single user, single email** — kein Tenant-Multiplexing am Auth-Layer. Tenant-Resolution passiert in `lib/rbac.js` + Settings.

## Hauptendpoints (call sites im Code)

### Auth-Middleware

| Funktion | Datei | Verwendung |
|----------|-------|------------|
| `verifyRequestUser(req)` | [backend/lib/auth.js](../../../backend/lib/auth.js) | Direkte JWT-Verifikation (z. B. Webhook-Skip) |
| `requireAuth(req, res, next)` | [backend/lib/auth.js](../../../backend/lib/auth.js) | Express-Middleware |
| `isAllowedEmail(email)` | [backend/lib/auth.js](../../../backend/lib/auth.js) | Settings-Page Email-Check |
| `isBootstrapAdmin(email)` | [backend/lib/auth.js](../../../backend/lib/auth.js) | Admin-Routes |
| `getAdminAuth()` | [backend/lib/firebaseAdmin.js](../../../backend/lib/firebaseAdmin.js) | Token-Verify + User-Management |

### Firestore-Client

- Modul-Singleton in [backend/lib/firestore.js](../../../backend/lib/firestore.js) (`firestore` Instance + Collection-Konstanten).
- Verwendung in jeder Domain (products, orders, shipments, …).
- Schreibpfade für Produkte MÜSSEN über [backend/lib/product-store.js](../../../backend/lib/product-store.js) `saveProductV2()` laufen (CLAUDE.md Punkt 7).

## Webhooks

- **Firebase selbst hat keine eingehenden Webhooks** in dieser Integration. Auth-Events könnten via Cloud-Functions konsumiert werden — sind aktuell nicht angeschlossen.

## Rate-Limits + Quotas

### Firestore

- Stock-Mutationen laufen durch `withStockLock()` mit Backend `STOCK_LOCK_BACKEND=firestore` (CLAUDE.md Punkt 12) — Firestore-Transaktion ist der globale Lock.
- Composite-Indexes sind in `firestore.indexes.json` versioniert. **Nicht löschen** (Protected Zone) — Re-Build kostet Stunden.
- Read/Write-Quotas richten sich nach GCP-Default (50 K Schreibvorgänge/s pro Datenbank, kein praktischer Engpass für 50–5000 SKUs).

### Authentication

- Token-Refresh: Standard Firebase 1 h, Refresh-Token läuft 30 d.
- `verifyIdToken(idToken, true)` mit `checkRevoked: true` macht pro Request einen Lookup auf Firestore `_id_token_revocations` — minimaler Overhead, aber non-zero.

### Hosting

- Static-Assets über Firebase CDN. Keine Backend-Quota-Auswirkung.

## Bekannte Schwächen

- **Single-Domain-Allowlist.** `AUTH_ALLOWED_EMAIL_DOMAIN` akzeptiert nur **eine** Domain. Multi-Tenant mit unterschiedlichen Email-Domänen erfordert pro Tenant-Domain ein eigenes Cloud-Run-Deployment oder einen ENV-Override.
- **Bootstrap-Admin ist nicht skalierbar.** Genau eine Email-Adresse darf an der Email-Verification vorbei. Wenn diese Person das Konto verliert, ist das System ohne Out-of-band-Eingriff zu (Firebase-Console → Custom-Claim setzen).
- **`checkRevoked: true`** auf jeden Request: bei hoher Last (>1 K req/s) kann das spürbar werden. Aktuell kein Problem (50–5000 SKUs).
- **`req.user` ist nicht tenant-aware out-of-the-box.** Tenant-Mapping passiert separat in `lib/rbac.js`/Settings. Wenn jemand `requireAuth` ohne `requirePermission` nutzt, gibt es keine Tenant-Isolation am Edge.
- **Application-Default-Credentials lokal:** Wer ohne `gcloud auth application-default login` startet, sieht beim ersten Firestore-Call einen kryptischen ADC-Fehler. Kein expliziter Health-Check.
- **`/api/image-proxy` ist public** (Auth-Allowlist) — siehe [brightdata.md](brightdata.md) für SSRF-Hinweise.
- **`firestore.indexes.json` kann durch CLI-Deploy still gelöscht werden**, wenn jemand `firebase deploy --only firestore` ohne aktuellen lokalen Stand triggert. Operator-Konvention: nur über `firebase.json`-Pipeline.

## Owner / Docs

- **Code-Owner:** Backend-Team (Auth, Firestore-Schemas), Frontend-Team (Hosting + Auth-Client).
- **Externe Doku:**
  - Admin SDK: [firebase.google.com/docs/admin/setup](https://firebase.google.com/docs/admin/setup)
  - ID-Token-Verify: [firebase.google.com/docs/auth/admin/verify-id-tokens](https://firebase.google.com/docs/auth/admin/verify-id-tokens)
  - Firestore: [firebase.google.com/docs/firestore](https://firebase.google.com/docs/firestore)
  - Hosting: [firebase.google.com/docs/hosting](https://firebase.google.com/docs/hosting)
- **Secret-Manager Setup:** Cloud-Run-Service-Account benötigt `roles/secretmanager.secretAccessor` (für Provider-Secrets) und `roles/datastore.user` (Firestore) — siehe [04-deployment](../04-deployment/) (TBD-Sektion).
- **Verwandte KB-Seiten:**
  - [11-rules-and-invariants/](../11-rules-and-invariants/) — Stock-Lock + Write-Pfade
  - [02-architecture/](../02-architecture/) — Tenant-Modell

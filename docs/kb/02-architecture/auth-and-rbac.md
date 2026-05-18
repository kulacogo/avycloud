---
title: Auth + RBAC
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# Authentication + Authorization

> Geprüfte Quellen: [backend/lib/auth.js](../../../backend/lib/auth.js), [backend/lib/rbac.js](../../../backend/lib/rbac.js), [backend/index.js](../../../backend/index.js).

## Authentifizierung: Firebase Authentication

| Schritt | Wo | Detail |
|---------|----|--------|
| Sign-In | Frontend `firebase ^10.14.1` | E-Mail/Passwort, MFA optional. |
| Token-Issue | Firebase Auth | JWT (`idToken`), TTL 1 h, auto-refresh durch SDK. |
| Token-Transport | Header `Authorization: Bearer <jwt>` | SSE-Spezialfall: `?token=<jwt>` im Query → Backend kopiert in Header ([backend/index.js](../../../backend/index.js) Z. 209ff). |
| Verifikation | [backend/lib/auth.js](../../../backend/lib/auth.js) `verifyRequestUser()` | `auth.verifyIdToken(idToken, true)` (Check-Revoked = true). |

## E-Mail-Domain-Guard

[backend/lib/auth.js](../../../backend/lib/auth.js):

| ENV-Var | Default | Wirkung |
|---------|---------|---------|
| `AUTH_ALLOWED_EMAIL_DOMAIN` | `trendocean.de` | Nur E-Mails dieser Domain sind zugelassen. Andere → `403 Forbidden`. |
| `AUTH_BOOTSTRAP_ADMIN_EMAIL` | `admin@trendocean.de` | Diese Adresse darf sich auch ohne `email_verified` einloggen und ist standardmäßig `isAdmin = true`. |

Verifikations-Sequenz:
1. Bearer-Token extrahieren → fehlt → `401`.
2. `verifyIdToken(idToken, true)`.
3. `email` Pflicht, Domain-Match Pflicht → sonst `403`.
4. Wenn Nicht-Bootstrap-Admin: `email_verified` Pflicht → sonst `403`.
5. Erfolg: `req.user = { uid, email, isAdmin, emailVerified, claims }`.

## Default-Deny im Express-Mount

[backend/index.js](../../../backend/index.js) Z. 234ff:

```js
app.use('/api', (req, res, next) => {
  if (req.method === 'OPTIONS') return next();
  if (req.path === '/image-proxy') return next();
  if (req.path === '/ebay/oauth/callback') return next(); // eBay redirect — no auth header
  return requireAuth(req, res, next);
});
```

Außerdem (vor Default-Deny) als Public gemountet:

- `/api/auth` (Sign-In-Helfer)
- `/api` Webhooks (Machine-to-Machine, signaturbasiert validiert)

## Autorisierung: RBAC

[backend/lib/rbac.js](../../../backend/lib/rbac.js).

### Collections

| Collection | Zweck |
|------------|-------|
| `users` | Profile, `roles[]`, `groupIds[]`, `overrides.{allow,deny}`, `disabled` |
| `roles` | `permissions: { module: { action: true } }` — gemerged via OR |
| `groups` | Bundle von Rollen → `roleIds[]` |
| `auditLogs` | Append-only, jeder RBAC-Write erzeugt einen Eintrag (`role.update`, `user.roles.update`, …). |

### Default-Rollen (seedet bei jedem Start via `ensureDefaultRoles()`)

| Role | Permissions (Auszug) |
|------|----------------------|
| `admin` | `'*': { '*': true }` — **wildcard, allow-all** (siehe Schwachstelle unten). |
| `manager` | `dashboard.read`, `products.read`. |
| `operation` | `dashboard.read`, `products.read`, `inventories.read`, `warehouse.{read,write}`, `orders.{read,pick,pack}`, `identify.run`, `jobs.read`. |
| `catalog` | `dashboard.read`, `products.{read,write,delete}`, `categories.{read,write}`, `identify.run`, `jobs.read`, `ai.{chat,improve}`. |

### Permission-Auflösung

`resolvePermissionsForUser(uid)`:
1. Lädt User-Profil (`disabled = true` → `403`).
2. Sammelt `directRoles` (aus `users.roles[]`) + `groupRoleIds` (aus referenzierten `groups.roleIds[]`).
3. Lädt alle eindeutigen Rollen, merged Permissions per **OR** in ein flaches Objekt `{ module: { action: true } }`.
4. `isAllowedWithOverrides` prüft: `overrides.deny` (gewinnt) → `overrides.allow` → Role-Permission.

### Middleware-Nutzung

```js
const { requirePermission } = require('../lib/rbac');
router.post('/products/:id', requireAuth, requirePermission('products', 'write'), handler);
```

## Bekannte Schwachstellen

Verweise auf [11-rules-and-invariants/auth-rules.md](../11-rules-and-invariants/auth-rules.md) für die volle Liste. Kurzfassung:

| Issue | Beschreibung | Quelle |
|-------|-------------|--------|
| **`isAdmin` Wildcard-Bypass** | `requirePermission()` returned sofort `next()` wenn `req.user.isAdmin === true` ([backend/lib/rbac.js](../../../backend/lib/rbac.js) Z. 358). Bootstrap-Admin (`AUTH_BOOTSTRAP_ADMIN_EMAIL`) bekommt automatisch `isAdmin = true` ohne Rollen-Check. | [backend/lib/auth.js](../../../backend/lib/auth.js) + [backend/lib/rbac.js](../../../backend/lib/rbac.js) |
| **`admin`-Rolle Wildcard `'*':'*'`** | Default-Rolle `admin` erlaubt jede Aktion auf jedem Modul. Migration zu fine-grained Admin-Sub-Rollen pendant. | [backend/lib/rbac.js](../../../backend/lib/rbac.js) `defaultRoles()` |
| **Hardcoded Default-Domain `trendocean.de`** | Wenn `AUTH_ALLOWED_EMAIL_DOMAIN` nicht gesetzt ist, lässt das Backend ausschließlich `@trendocean.de`-User durch. Multi-Tenant-Hardening: Pro-Tenant-Domain-Liste. | [backend/lib/auth.js](../../../backend/lib/auth.js) Z. 3 |
| **Webhook-Signatur teilweise fehlend** | Public-mounted Webhook-Handler validieren Signatur nicht durchgängig. | [11-rules-and-invariants/webhook-policies.md](../11-rules-and-invariants/webhook-policies.md) |

## Verweise

- Detailregeln + Aktions-Items: [11-rules-and-invariants/auth-rules.md](../11-rules-and-invariants/auth-rules.md).
- Multi-Tenant-Modell: [multi-tenancy.md](multi-tenancy.md).
- Protected-Zones-Liste: [13-personas/for-coding-agents.md](../13-personas/for-coding-agents.md).

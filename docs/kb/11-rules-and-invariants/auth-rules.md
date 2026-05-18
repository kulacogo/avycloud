---
title: Auth-Rules
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# Auth-Rules

> Punkt 6 [CLAUDE.md](../../../CLAUDE.md): Keine Änderung an [backend/lib/auth.js](../../../backend/lib/auth.js) / [backend/lib/rbac.js](../../../backend/lib/rbac.js) ohne explizite Anweisung.

## Standard-Pattern für neue Routen

```js
const { requireAuth } = require('../lib/auth');
const { requirePermission } = require('../lib/rbac');

router.post(
  '/products/:id',
  requireAuth,                              // automatisch via app.use('/api', requireAuth) gesetzt
  requirePermission('products', 'write'),   // Modul + Action
  handler,
);
```

`requireAuth` ist bereits durch das Default-Deny in [backend/index.js](../../../backend/index.js) Z. 234ff auf jeden `/api`-Pfad gelegt (außer Allowliste). Pflicht-Add-on für jede schreibende oder schützenswerte Route: `requirePermission(module, action)`.

## Verfügbare Module + Default-Aktionen (aus Default-Rollen)

Aus [backend/lib/rbac.js](../../../backend/lib/rbac.js) `defaultRoles()`:

| Modul | Mögliche Aktionen | Default-Zuordnung |
|-------|-------------------|-------------------|
| `dashboard` | `read` | manager, operation, catalog |
| `products` | `read`, `write`, `delete` | manager (read), operation (read), catalog (alle) |
| `categories` | `read`, `write` | catalog |
| `inventories` | `read` | operation |
| `warehouse` | `read`, `write` | operation |
| `orders` | `read`, `pick`, `pack` | operation |
| `identify` | `run` | operation, catalog |
| `jobs` | `read` | operation, catalog |
| `ai` | `chat`, `improve` | catalog |
| `*` (Wildcard) | `*` | admin |

Neue Module / Aktionen einfach im Code verwenden + Default-Rolle in `defaultRoles()` pflegen. **Hinweis:** Eine Änderung von `defaultRoles()` braucht Operator-Freigabe wegen Punkt 6.

## Bekannte Schwachstellen

### S1 — `isAdmin`-Wildcard-Bypass

[backend/lib/rbac.js](../../../backend/lib/rbac.js) Z. 358:

```js
function requirePermission(moduleName, action) {
  return (req, res, next) => {
    if (req.method === 'OPTIONS') return next();
    if (req.user?.isAdmin) return next();   // ← Wildcard-Bypass
    resolvePermissionsForUser(req.user?.uid).then(...);
  };
}
```

Quelle für `isAdmin`-Flag: [backend/lib/auth.js](../../../backend/lib/auth.js) `verifyRequestUser()` setzt `isAdmin = isBootstrapAdmin(email)`. Das heißt jede E-Mail, die mit `AUTH_BOOTSTRAP_ADMIN_EMAIL` matcht, umgeht jeden Permission-Check.

**Mitigation:**
- `AUTH_BOOTSTRAP_ADMIN_EMAIL` als eng kontrollierte Operator-Adresse halten.
- Bootstrap-Admin nur für initiales Setup; nach Onboarding regulärer User mit `admin`-Rolle (die ebenfalls `'*':'*'` hat, aber via Roles-Audit-Log nachverfolgbar ist).

### S2 — `admin`-Rolle mit `'*':'*'`-Wildcard

Default-`admin`-Rolle:
```js
admin: {
  name: 'Admin',
  permissions: { '*': { '*': true } },
}
```

Jeder Admin kann alles. Für Audit-Trennung: feinere Sub-Rollen wären besser. Plan: separate `admin.system`, `admin.users`, `admin.bulk` Rollen.

### S3 — Hardcoded Default-Domain `trendocean.de`

[backend/lib/auth.js](../../../backend/lib/auth.js) Z. 3:

```js
const DEFAULT_ALLOWED_DOMAIN = 'trendocean.de';
```

Wenn `AUTH_ALLOWED_EMAIL_DOMAIN` ENV nicht gesetzt ist, lässt das Backend ausschließlich `@trendocean.de`-User durch. Multi-Tenant-Hardening: Pro-Tenant-Domain-Whitelist (Mapping in `tenants`-Collection).

### S4 — `email_verified`-Check Bypass für Bootstrap-Admin

```js
const admin = isBootstrapAdmin(email);
const emailVerified = Boolean(decoded.email_verified);
if (!admin && !emailVerified) {
  const err = new Error('Forbidden: email not verified');
  err.statusCode = 403;
  throw err;
}
```

Bootstrap-Admin darf sich auch ohne verifizierte Email einloggen — operativ pragmatisch, sicherheitstechnisch ein Stützpunkt. Bei Account-Übernahme der Bootstrap-Adresse hat Angreifer direkt Vollzugriff.

### S5 — SSE-Token im Query-String

[backend/index.js](../../../backend/index.js) Z. 209ff: EventSource kann keine Custom-Header → Token wird via `?token=<jwt>` übermittelt. Risiko:

- Token in Browser-History.
- Token in Server-Logs (default-Logger schreibt Path + Query).

**Mitigation:**
- Token-Length absichtlich kurz halten (Firebase-Defaults sind 1 h).
- Request-Logger sollte `token`-Query strippen — **muss verifiziert werden** in [backend/lib/request-logger.js](../../../backend/lib/request-logger.js).
- Frontend rotiert Token regelmäßig (Firebase SDK auto-refresh).

## Audit-Log

Jede RBAC-Mutation wird in `auditLogs` geschrieben ([backend/lib/rbac.js](../../../backend/lib/rbac.js) `writeAuditLog()`). Pflichtfelder:
- `actorUid`
- `action` (`role.update`, `user.roles.update`, `user.groups.update`, `user.overrides.update`, `group.create`, `group.update`, `group.delete`)
- `targetUid`
- `diff` (Patch-Objekt)
- `at` (`FieldValue.serverTimestamp()`)

Operator-Sicht: [AuditLogView.tsx](../../../components/AuditLogView.tsx) und `05-pages/audit-log.md` *(Annahme — Page-Doku noch nicht in dieser Charge erstellt)*.

## Empfehlungen

| Wenn du… | Tu folgendes |
|----------|---------------|
| eine neue mutierende Route baust | `requirePermission(module, action)` einbauen + Default-Rolle aktualisieren wenn nötig. |
| eine RBAC-Funktion änderst | STOP — Protected Zone, Operator-Anweisung Pflicht. |
| Cron-Job ohne User-Kontext baust | Tenant manuell setzen; kein `req.user` verfügbar. |
| Webhook ohne Auth-Header empfängst | Signatur prüfen — siehe [webhook-policies.md](webhook-policies.md). |
| Bootstrap-Admin-Adresse änderst | ENV `AUTH_BOOTSTRAP_ADMIN_EMAIL` + Re-Deploy; alte Adresse vorher rotieren. |

## Verweise

- Auth + RBAC-Architektur: [02-architecture/auth-and-rbac.md](../02-architecture/auth-and-rbac.md).
- Webhook-Policies: [webhook-policies.md](webhook-policies.md).
- Code: [backend/lib/auth.js](../../../backend/lib/auth.js), [backend/lib/rbac.js](../../../backend/lib/rbac.js).

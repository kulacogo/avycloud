---
title: AvyCloud für Admins/Operator
for: [admin]
lastReviewed: 2026-05-18
---

# AvyCloud für Admins/Operator

## Was du als Admin tun kannst

- **Bulk-Aktionen**: massen-recategorize, massen-improve, etc. Siehe [09-api/admin.md](../09-api/admin.md).
- **User- und Rollen-Management**: `users`, `roles`, `groups` Collections. RBAC-Modell in [02-architecture/auth-and-rbac.md](../02-architecture/auth-and-rbac.md).
- **Audit-Log einsehen**: [05-pages/audit-log.md](../05-pages/audit-log.md).
- **Integrations konfigurieren**: eBay/Kaufland/SendCloud Credentials in Settings. Siehe [05-pages/settings.md](../05-pages/settings.md).
- **Incident-Response**: [12-runbooks/](../12-runbooks/).

## ENV-Vars und Feature-Flags

Siehe [04-deployment/env-vars.md](../04-deployment/env-vars.md) und [03-development/feature-flags.md](../03-development/feature-flags.md).

## Wartungs-Skripte

Alle unter [backend/scripts/](../../../backend/scripts/). Kritische Skripte:
- `audit-ghost-products.js` — Geister-Produkte in `products_v2` finden
- `dedupe-products-v2.js` — Duplikate bereinigen
- `repair-double-decrement.js` — Stock-Double-Decrement reparieren
- `recategorize-v2.js` — Bulk-Kategorie-Korrektur

**Alle Skripte: `--dry-run` zuerst, `--apply` nur nach Sichtung.**

## Cleanup + Inventar

[17-cleanup-report.md](../17-cleanup-report.md) hält fest was im System zu viel ist und Operator-Freigabe braucht.

## Multi-Tenant

`BACKGROUND_JOB_TENANTS=trendocean,avycloud` schaltet Multi-Tenant-Crons. Siehe [02-architecture/multi-tenancy.md](../02-architecture/multi-tenancy.md).

## Cloud Run Console

- **Service**: `product-intelligence-backend` in `europe-west3`
- **Logs**: GCP Cloud Logging
- **Metrics**: GCP Cloud Monitoring + `/api/health/identify` Endpoint

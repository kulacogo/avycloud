---
title: Auth + RBAC
for: [dev, agent, admin]
lastReviewed: 2026-09-19
---

# Authentifizierung und Zugriffsprofile

Implementierungsstand dieses Branches; Rolloutstatus und verbindliche Reihenfolge: [Zugriffsprofile](../../features/access-profiles/spec.md). Noch kein Produktions-Rollout durch die Analyse/Implementierung.

Firebase Authentication verifiziert Bearer-Tokens mit Revocation-Check, erlaubter E-Mail-Domain und E-Mail-Bestätigung. Die Bootstrap-Inhaberadresse ist die bestehende Ausnahme bei E-Mail-Bestätigung. `AUTH_ALLOWED_EMAIL_DOMAIN` und `AUTH_BOOTSTRAP_ADMIN_EMAIL` bleiben unverändert. Default-deny unter `/api`, bestehende öffentliche Ausnahmen und Webhook-Authentifizierung bleiben bestehen.

`auth.js` prüft zusätzlich `users.disabled`, bevor irgendein authentifizierter Endpunkt ausgeführt wird. Das Profil wird innerhalb der Anfrage wiederverwendet.

Die Autorisierung erfolgt über genau ein `users.accessRole`: `admin`, `manager`, `employee`, `partner`, `viewer`, `developer`. [access-profiles.js](../../../backend/lib/access-profiles.js) definiert die feste Matrix. Die Auswahl allein verleiht kein Adminrecht: nur die verifizierte Inhaber-E-Mail erhält dieses Profil. Alte `roles`, `groupIds`, `overrides` sowie gespeicherte Rollenmatrizen werden nicht mehr für die Entscheidung herangezogen. Unbekanntes/nicht migriertes Profil und Tenant-Konflikt werden nicht freigeschaltet.

[rbac.js](../../../backend/lib/rbac.js) stellt `requirePermission(module, action)` bereit. `req.rbac.permissions` enthält die tatsächlich wirksame Matrix. Gesperrte Konten haben keinen Admin-Bypass. Finanzfelder werden in Antworten für Konten ohne `admin.reports.read` reduziert; Finanzschreibfelder benötigen `admin.reports.write`.

Das Frontend erhält seine Rechte ausschließlich aus `/api/me/permissions`. [viewPermissions.ts](../../../utils/viewPermissions.ts) ist die gemeinsame Quelle für Menüs und direkte Aufrufe. Das Frontend ersetzt keine serverseitige Prüfung.

Zuordnung und Audit werden gemeinsam gespeichert. Die Gruppen-/Override-/Rollenmatrix-Schreib-APIs bleiben unter bestehenden Routen erhalten, weisen Änderungen aber mit 409 und Verweis auf Zugriffsprofile zurück. Keine Firestore-Felder oder historischen Dokumente werden gelöscht.

Siehe [Auth-Regeln](../11-rules-and-invariants/auth-rules.md), [API-Vertrag](../09-api/admin.md) und [Umstellung/Tests](../../features/access-profiles/spec.md).

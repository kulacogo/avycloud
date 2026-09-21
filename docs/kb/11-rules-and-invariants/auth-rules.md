---
title: Auth-Rules
for: [dev, agent, admin]
lastReviewed: 2026-09-21
---

# Auth-Regeln

`backend/lib/auth.js` und `backend/lib/rbac.js` bleiben Protected Zone gemäß CLAUDE.md. Die ausdrückliche Anweisung vom 19.09.2026 zur grundlegenden Rollenbereinigung autorisiert die hier dokumentierten Änderungen. Am 21.09.2026 wurden editierbare Rollenrechte, Manager-Rechnungserstellung und deren Produktionsauslieferung ausdrücklich beauftragt.

1. Genau ein kanonisches Profil aus `backend/lib/access-profiles.js` pro Konto; keine Rechteaddition aus alten Rollen, Gruppen oder Overrides.
2. Nur die verifizierte Bootstrap-Inhaberidentität ist Admin. Weder Frontend-E-Mailvergleiche noch gespeicherte Wildcards verleihen Vollzugriff.
3. Deaktivierte Konten bereits in Auth ablehnen. Fehlende Profile/Permissions niemals als Vollzugriff behandeln. Rechte-Abruffehler als Fehler zurückgeben, damit der Client sichtbar wiederholen kann.
4. Jede operative Fähigkeit muss den gesamten zugehörigen Ablauf abdecken. Packen umfasst Gewicht speichern, Versenden umfasst Versandlabel und Druckauftrag. Dafür keine Unternehmens- oder Finanzrechte vergeben.
5. Sensible Aktionen einzeln prüfen: Rechnungserstellung/korrektur/export → `invoices.write`; Geld erstatten (auch Bulk) → `returns.refund`; Kostenmodell ändern → `admin.reports.write`; Lagerstruktur → `warehouse.configure`. Bei gemischten Payloads gilt das strengere Recht.
6. Neue schützenswerte Routen verwenden `requirePermission`. JSON-Finanzprojektion nicht durch `send`/SSE/CSV umgehen; den jeweiligen Ausgabepfad ausdrücklich prüfen.
7. Menüs UND direkte Views verwenden `utils/viewPermissions.ts`, unbekannte Views bleiben gesperrt. Backend-Sperren zusätzlich testen; Menüs ausblenden reicht nicht.
8. Pro Mitarbeiter eine persönliche Identität; keine gemeinsam genutzten Scannerkonten. Akteure unverändert bis zu Audit, OMS und Leistungsdaten weiterreichen.
9. Profiländerung und Audit zusammen speichern. Inhaberkonto nicht herabstufen oder löschen. Alte Dokumente nur als Rückkehrmöglichkeit aufbewahren, nicht erneut auswerten.
10. Vor Auslieferung muss die additive Zuordnung vorbereitet sein. Exakte Reihenfolge, Trockenlauf, Accountliste, Rollback und Testgrenzen: [Zugriffsprofile](../../features/access-profiles/spec.md).

Weitere bestehende Auth-Grenzen (Domain, SSE-Token-Transport, öffentliche Webhook-Ausnahmen) wurden nicht grundsätzlich umgebaut. Keine Aussage über eine vollständige Sicherheitsprüfung des Gesamtsystems.

11. Rollen-Policies ausschließlich über `access-role-policies.js`: tenantgebunden, allowlistvalidiert, Revision und Audit atomar. Admin unveränderlich, keine Wildcards oder Delegation von Konten-/Rechteverwaltung. Fehlende Policies nutzen Defaults, ungültige Policies verweigern Zugriff; kein langlebiger Permission-Cache.

# Codex — Projektgedächtnis: Rollenbereinigung

Stand 19.09.2026. Pflichtlektüre aus AGENTS.md/CLAUDE.md bleibt maßgeblich. Änderungen wirken bei Auslieferung direkt auf das Unternehmen; dieser Stand ist **lokal, nicht committed und nicht produktiv**.

Dieser isolierte Worktree basiert auf main `4aa3b0ca` (PR #8, UI-Release 19.09.). Branch `codex/roles-permissions-20260919`. Keine Änderungen aus dem älteren, stark veränderten Hauptcheckout oder parallelen Foto-Branches übernehmen.

Die ausführliche ursprüngliche Projektanalyse und Claude-Historie liegt lokal unter `/Users/oguz/Dev/avycloud/CODEX_MEMORY.md`. Für diese Umsetzung ist [Rollen und Rechte: Spezifikation, Prüfungen und Auslieferungsreihenfolge](docs/features/access-profiles/spec.md) der vollständige Übergabestand.

## Verbindliche Nutzerentscheidungen

- Oguz/admin@ ist alleiniger Administrator.
- Efe und Yasemin: Manager. Hüseyin und Semih: Mitarbeiter. Diese Konten müssen alle täglichen Abläufe ohne Admin erledigen können, insbesondere Gewicht im Packmodul, Versandlabel und Druck.
- Fatih und Selahattin: Partner, nur Lesen; bestehender Finanz-Leseumfang bleibt erhalten.
- Scanner Support nicht mehr verwenden: Mitarbeiter arbeiten persönlich, damit die Leistung zugeordnet wird.
- Ops Dev wird einem Entwickler gegeben: breite operative/technische Leserechte, kein Zugriff auf Finanzen/Personal/Zugänge, keine Änderungen.

## Umsetzung und Wiederaufnahme

Kanonische Policy: `backend/lib/access-profiles.js`, sechs Profile mit neuer additiver `users.accessRole`. Alte Rollenarrays/Gruppen/Overrides werden nicht mehr ausgewertet oder dargestellt; historische Dokumente bleiben für kontrollierten Rollback erhalten. Auth-/RBAC-Arbeit ist durch den aktuellen Nutzerauftrag autorisiert. Kein erneutes Nachfragen allein wegen dieser Protected Zone.

Gewicht-only verlangt `orders.pack`; Versand und Druck `orders.ship`; gemischte Auftragskorrektur `orders.edit`; Konfiguration separat. Sensible Finanz-/Verwaltungsaktionen gesperrt und per echter RBAC/HTTP geprüft. Personenidentität wird bis zu Pack-/OMS-Events weitergegeben.

**Vor Auslieferung**: Migrations-Trockenlauf erneut prüfen, dann im freigegebenen Rollout die Profilfelder atomar vorbereiten, **danach** deployenden Merge/Push durchführen. Sonst fehlen Nicht-Inhabern die neuen Profile. `backend/scripts/migrate-access-profiles.js` ist standardmäßig read-only, mit identitätsgeprüfter Liste und atomarem Backup. Bislang wurde nur dieser Trockenlauf gegen Produktion ausgeführt.

Scanner-/Waage-/Druck-Hardware und tatsächlich eingesetzte Druck-/Foto-Agent-Identität beim Rollout gesondert prüfen. Kein reales Label oder physischer Druck wurde im lokalen Test ausgelöst. Commit, Merge und kontrollierte Produktivauslieferung wurden am 19.09.2026 durch die Antwort „ok los“ ausdrücklich freigegeben. Rollout läuft; Abschlussnachweise werden nachgetragen.

Verifizierter Endstand: 5.213 Backend-Tests (448 Dateien), 461 Frontend-Tests, TypeScript und Build grün. Browserprüfung mit vier lokalen Testprofilen ohne JavaScript-Laufzeitfehler; mobile Packansicht sichtbar. Produktivkonten weiterhin unverändert.

Rollout-Vorprüfung 19.09.2026: origin/main unverändert `4aa3b0ca`; Web `01802-rhb`, Worker `00257-cpb`, jeweils 100 %. Frischer Migrations-Trockenlauf bestätigt dieselben neun Konten. Keine registrierten Druck-/Foto-Agenten für Tenant default und keine entsprechende lokale LaunchAgent-Konfiguration gefunden; reale Büro-Hardware bleibt vor Ort zu prüfen.

**Rollout angehalten vor Produktionsschreibzugriff:** Zusätzliches aktives Konto Mahmoud Ali (heute angelegt, Alt-Adminrollen, kein tenantId). Betreiber nach Zielprofil gefragt; Antwort noch offen. Migration zusätzlich gegen vollständige Firebase-Identitätsliste prüfen. Erster Commit `9690fefd`, PR #9, CI vollständig grün; Migrationshärtung in Arbeit.

Migrationshärtung geprüft: 5.214 Backendtests/448 Dateien grün (Node 20); frischer Produktions-Trockenlauf bricht beim noch nicht zugeordneten Mahmoud-Profil wie vorgesehen vor jedem Schreibzugriff ab.

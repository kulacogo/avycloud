# Codex — AvyCloud Projektgedächtnis

Stand 20.09.2026. Pflichtlektüre aus AGENTS.md/CLAUDE.md bleibt maßgeblich. Die ausführliche Projektanalyse, Architektur und Claude-Historie liegt unter `/Users/oguz/Dev/avycloud/CODEX_MEMORY.md`; diese Datei hält den aktuellen isolierten Arbeitsstand fest. Produktionsänderungen haben direkten Einfluss auf den Betrieb von TrendOcean.

## Rollenbereinigung: produktiv abgeschlossen

PR [#9](https://github.com/kulacogo/avycloud/pull/9), Main `1fe401cd3339d045c40caf9b44fc4553eba985d7`. Freigegeben durch „ok los“ und ausdrückliche Fortsetzung am 20.09.; die vorherige Mahmoud-Rückfrage ist erledigt. Web `product-hub-backend-01803-9k2`, Worker `product-hub-worker-00258-zps`, Hosting `b015fc975fab2d48` waren beim Abschluss ready/100 %. Detaillierter lokaler Nachweis: `/Users/oguz/Dev/avycloud/CODEX_RELEASE_ROLES_20260920.md`. Vor weiteren Eingriffen veränderliche Werte frisch prüfen.

- Oguz/admin@ alleiniger Admin; Efe/Yasemin Manager; Hüseyin/Semih Mitarbeiter; Fatih/Selahattin Partner (operative und Finanz-Leserechte).
- Ops Dev: Entwickler, operative/technische Leserechte ohne Finanzen, Personal oder Zugänge. Scanner Support gesperrt; Mitarbeiter nutzen persönliche Konten.
- Mahmoud vorläufig Nur Lesen. **Der Inhaber stellt dessen endgültige Rolle selbst ein.** Nicht eigenständig hochstufen und nicht erneut nachfragen.
- Versionierte Policy `backend/lib/access-profiles.js`, additives `users.accessRole`. Historische Rollen/Gruppen/Overrides bleiben gespeichert, werden aber nicht ausgewertet/angezeigt.
- Gewicht-only `orders.pack`, Versand/Druck `orders.ship`, sonstige Auftragskorrektur `orders.edit`. Normale Arbeit benötigt kein Adminprofil.
- Migration `default_access_profiles_v1` am 20.09.2026 00:56:41 MESZ atomar für zehn Profile plus Backup angewandt. **Nicht erneut migrieren.**
- Vorbestehender Druckagent-Ausfall ist separate Hardware-/Diensteinrichtung, nicht durch Rollen/UI zu lösen. Keine physische Hardwareprüfung behaupten.

## Aktueller Nachtrag: interaktive Teamoberfläche

Auftrag: Mitarbeiter, Leistung, Rollen & Rechte wirken zu statisch; Ansicht und Bedienung verbessern. Isolierter Worktree `/Users/oguz/Dev/avycloud-team-ui`, Branch `codex/team-workspace-20260920`, Basis `1fe401cd`. Keine fremden Änderungen aus dem Hauptcheckout oder Foto-Branches übernehmen.

Mitarbeiterkarten mit Suche/Filtern und Dialogen; Leistungskennzahlen mit Balken, sortierbarer Tabelle und Kontodetails; Rollenvergleich mit Differenzen-/Aufgabensuche und verknüpften Konten. Filter bleiben beim Registerwechsel erhalten. Bestehende APIs und serverseitige Policy unverändert. Keine neuen Dependencies, Migrationen oder produktiven Kontozuordnungen. Der bestehende Rollen-Rollout ist freigegeben; dieser UI-Nachtrag wird im gleichen autorisierten Bereich kontrolliert ausgeliefert.

Details/Abnahme: [Teamoberfläche](docs/features/team-workspace/spec.md). UI-Regeln: [Admin-KB](docs/kb/05-pages/admin.md).

Leistungs-API liefert Zeitraum-Summen, keine Tagesreihe/Arbeitszeit/Qualität. Produkte, Buchungen und Vorgänge nicht zu einem Produktivitätswert addieren. Historische gemeinsame Konten bleiben bei ihren Ereignissen. Quellenabruf begrenzt und teilweise fail-open im bestehenden Backend; 0 ist kein Nachweis für Untätigkeit. Kennzahlen erklären diese Grenze.

Prüfungen laufen abschließend. Lokale Vorschau `http://127.0.0.1:3002/.local-preview/index.html` mit Testadaptern, ohne Produktionszugriffe; `.local-preview/` und Node-Module-Symlinks niemals committen. Alle eigentlichen Komponenten liegen im normalen Produktionspfad.

## Abschlussprüfung vor PR

467 Frontendtests, TypeScript und Produktions-Build grün. 5.214 Backendtests / 448 Dateien unter Node 20.19.5 im vollständigen Wiederholungslauf grün. Im ersten Gesamtlauf brach ausschließlich ein unveränderter lokaler `/health`-Supertest mit `socket hang up` ab; ohne Codeänderung im vollständigen zweiten Lauf bestanden. Kein Produktiv-Health-Fehler.

Vor Auslieferung frisch bestätigt: Main unverändert `1fe401cd`; Web `01803-9k2`, Worker `00258-zps`, jeweils ready/100 %; Hosting `sites/avycloud/versions/b015fc975fab2d48`, Release `1789858770424000`. Rückweg dieses Nachtrags ist ausschließlich UI-Revert/Hosting-Rollback, keine Profil-Rückmigration.

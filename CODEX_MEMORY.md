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

## Teamoberfläche: produktiv abgeschlossen

PR [#10](https://github.com/kulacogo/avycloud/pull/10), Main `eb4b850cca484557b8f35fd0ea1a59f884ede65c`. Web `01804-xjr`, Worker `00259-xx7`, Hosting `e5accd956232d706` nach Abschluss ready/100 %. Benutzer hat zusätzlich „los rüber auf prod wenns fertig ist“ angewiesen. Nachweis im Hauptcheckout `CODEX_RELEASE_TEAM_UI_20260920.md`. Rollen, Mitarbeiterkarten und Profilvergleich bleiben maßgeblich; die damalige Ansicht einzelner Leistungskennzahlen wird vom folgenden Auftrag ersetzt.

## Aktueller Auftrag: Gesamtbeitrag statt Packzahlen

20.09.2026: Der Betreiber fordert eine plausible Bewertung neben Namen; einzelne Vorgangszahlen erst nach Auswahl. Isolierter Worktree `/Users/oguz/Dev/avycloud-team-performance`, Branch `codex/team-performance-assessment-20260920`, Basis `eb4b850c`. Fremde Änderungen im Hauptcheckout nicht übernehmen.

Umgesetzt: Beitragspunkte aus allen fünf Tätigkeiten, Teamanteil, nachvollziehbare Detailrechnung; Team-KPI sind keine Filter mehr. Startmodell Erfassen5/Pflege2/Einlagern2/Pick1/Pack3. Gewichtung ist offengelegte, bisher nicht vom Betreiber bestätigte Startannahme; keine gemessene Zeit, Qualität, Anwesenheit oder Zielerfüllung. Persönliche Punkte sind keine objektive Personal-Leistungsnote. Browser-Sitzungszeiten sind keine Arbeitszeiten und werden nicht dafür benutzt.

Gleicher Nutzer/gleiches Produkt/Zeitraum: Erfassung und Pflege erhalten nur Erfassungspunkte; Rohzahlen bleiben erhalten. Spätere echte Pflege desselben Produkts kann dadurch ebenfalls ohne zusätzliche Punkte bleiben. Historische/deaktivierte Konten ohne persönliche Bewertung; keine rückwirkende Umdeutung gemeinsamer Scanneraktionen. Kein Ereignis bedeutet keine negative Leistungsnote. Kontozuordnungen stellt weiterhin der Inhaber selbst ein.

Backend ergänzt ausschließlich lesende Abdeckungsmetadaten und Überschneidungszahlen auf bestehender Route. Querygrenzen unverändert. Bei Abruffehler, ungesicherter Abdeckung, altem Server oder fehlendem Kontoverzeichnis keine Gesamtpunkte/Rangfolge. Untagged Legacy-Events nur Tenant default. Keine Auth-, Stock-, OMS-, Infrastruktur- oder Kontomutation.

Lokal: 474 Frontendtests, 5.223 Backendtests/449 Dateien unter Node20, TypeScript, Build grün. Browser mit lokalen Beispieldaten, Responsive/Hell/Dunkel und Fehlerzustand geprüft. `.local-preview/` und Node-Symlinks nicht committen. Doku/Abnahme: [Teamoberfläche](docs/features/team-workspace/spec.md), [Admin](docs/kb/05-pages/admin.md), [API](docs/kb/09-api/admin.md). Produktion vor Auslieferung erneut prüfen und Abschluss nachtragen.

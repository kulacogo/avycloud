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

## PR #11 ausgeliefert, Bewertung fachlich vom Betreiber verworfen

Main `7be8d302eb61a457a67064cd8aa291bc2336ba24`, Web01805-zbc/Worker00260-j47/Hosting4d3131fee2a8e8a9 technisch erfolgreich ausgeliefert. **Die Gewichte 5/2/2/1/3 und der pauschale Pflegeabzug sind fachlich falsch und gelten nicht weiter.** Technische Releaseprüfung war keine fachliche Bestätigung. Nachweis im Hauptcheckout `CODEX_RELEASE_TEAM_PERFORMANCE_20260920.md`.

## Aktuelle Korrektur: Arbeitsaufwand nachvollziehen

Betreiber konkret am 20.09.: Anreicherung/Prüfung/Korrektur bis Bereit dauert am längsten; dann Erfassen mit Fotos; dann Packen mit Karton und Wiegen; zuletzt schnellster Pick. Nicht erneut nach Richtzeiten fragen. Abgebildet als Aufwandsstufen Pflege4/Erfassen3/Pack2/Pick1, einfache Einlagerung vorläufig Basis1 (eigene Einordnung, keine Betreiber-Zeitangabe). Diese Stufen sind keine gemessenen Zeitverhältnisse oder Qualitätsgrade. Der verworfene Vorschlag einer Richtzeitkonfiguration wird nach der konkreten Betreiberanweisung nicht gebaut.

Isolierter Worktree `/Users/oguz/Dev/avycloud-team-effort`, Branch `codex/team-effort-calibration-20260920`, Basis `7be8d302`. Quelle: `ProductSheet.handleToggleEdit` speichert beim Öffnen automatisch; `handleReadinessChange` markiert Bereit. Audit-Diff erfasste ops.readiness bislang nicht. Deshalb einfache Save-Zahl weder Datenarbeit noch Abschlussnachweis.

Korrektur: bestehendes Audit erfasst readiness-Diff. Leistungsabruf ergänzt productCareEdited/productReady und Beitragsschema2. Pflege zählt bei dokumentierter Datenblattänderung oder Statuswechsel zu Bereit einmal je Produkt/Konto/Fenster, zusätzlich zur Erfassung; keine Klick-/Mehrfachsavepunkte. Alte Rohwerte/Overlap-Metadaten bleiben kompatibel erhalten. Vergangene Prüfungen ohne Datenänderung bleiben unbelegt; keine rückwirkende Attribution über heutige Produktzustände/Initialen. Keine Konten, Auth, Bestände, OMS oder Speichermutation verändert.

Lokal grün: Backend5230/450 Dateien, Frontend476, TypeScript/Build. Neue Tests und Browserprüfung decken tatsächliche Arbeitsfälle ab. Auslieferung/Abschluss noch offen, veränderliche Produktionswerte vor Merge prüfen. Testadapter/Node-Symlinks nie committen. Inhaber stellt Kontenprofile weiterhin selbst ein.

# Codex — AvyCloud Projektgedächtnis

Stand 20.09.2026. Pflichtlektüre aus AGENTS.md/CLAUDE.md bleibt maßgeblich. Die ausführliche Projektanalyse, Architektur und Claude-Historie liegt unter `/Users/oguz/Dev/avycloud/CODEX_MEMORY.md`; diese Datei hält den aktuellen isolierten Arbeitsstand fest. Produktionsänderungen haben direkten Einfluss auf den Betrieb von TrendOcean.


## 21.09.2026 — editierbare Rollenrechte und Manager-Rechnungen

Auftrag: Yasemin als Manager muss Rechnungen erstellen können; der Inhaber bestimmt Rechte pro Rolle selbst, sofort umsetzen und produktiv ausliefern. Autorisiert Auth/RBAC-Änderungen, Commit/Merge und Deployment. Vorherige Entscheidung für unveränderliche Rollen ist damit ersetzt; keine Rückfrage nötig.

- Manager-Defaults jetzt `invoices.read/write`. Finanzberichte, Unternehmensdaten und Erstattungen weiterhin getrennte, standardmäßig gesperrte Rechte.
- Kompakte Rollenansicht mit einzelnen Checkboxen, Suche, Speichern/Verwerfen. Backend erlaubt nur den definierten Katalog und prüft Arbeits-/Leseabhängigkeiten; UI schaltet Voraussetzungen mit. Admin sowie Konten-/Rechteverwaltung bleiben unveränderlich beim verifizierten Inhaber.
- Neue tenantgebundene Collection `accessRolePolicies`, ein Dokument je Tenant/Rolle; vollständige Matrix, Revision, Schema, Akteur. Speicherung + Audit atomar; 409 bei veraltetem Stand. Keine Wiederbelebung historischer Rollen/Overrides/Gruppen. Fehlende Policy → Defaults, fehlerhafte Policy → kein Zugriff; Entzug wirksam bei nächster Anfrage, kein übergreifender Rechtecache.
- Rechnungsroute prüft Tenant vor MwSt.-Speicherung. Keine automatische Rechnungsausstellung, keine echten Rechnungen beim Test erzeugt, keine Nutzerzuordnung verändert.
- Basis `21042628` (PR18). Vor Auslieferung Web `01812-hkt`, Worker `00267-24n`. Branch `codex/role-permission-editor-20260921`, isoliert in `/Users/oguz/Dev/avycloud-role-editor`.
- Prüfung: 5361 Backendtests/458 Dateien, 493 Frontendtests, TypeScript + Produktionsbuild grün. UI mit lokalen Beispieldaten: Rechte ändern/speichern, Bestätigung und Hell/Dunkel geprüft. Produktivstand wird im Hauptcheckout nachgeführt.
- Rollback vor diesen Code ignoriert Custom-Policies und reaktiviert damalige Defaults: individuell entzogene Rechte vorher berücksichtigen.


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

Lokal grün: Backend5230/450 Dateien, Frontend476, TypeScript/Build. Neue Tests und Browserprüfung decken tatsächliche Arbeitsfälle ab. Historischer Prüfstand vor PR12; PR12/Main f3529112 wurde danach produktiv ausgeliefert. Die Inhaltsklassifikation war noch zu breit, siehe aktuelle Korrektur unten. Testadapter/Node-Symlinks nie committen. Inhaber stellt Kontenprofile weiterhin selbst ein.

## Kundensupport — bestätigte Zuordnung und Umsetzung 20.09.2026

Aktuell maßgeblich: Inhaber bestätigt EIN Firmenkonto je Marktplatz und AUSSCHLIESSLICH Yasemin für Kommunikation. Damit ist die vorherige Zuordnungsfrage erledigt. Keine weiteren Fragen nach Einzelkonten, kein neues Inbox-Projekt. Arbeitsablauf bleibt Kaufland-Tickets/eBay-Nachrichten. Keine Rollen-/Kontenänderungen; Inhaber stellt Profile selbst ein.

Supportnachtrag im isolierten Worktree `/Users/oguz/Dev/avycloud-team-support`, Branch `codex/team-support-performance-20260920`, Basis PR12/Main f3529112. Kaufland echte Händlerantworten verfügbar; eBay benötigt commerce.message, aktueller Token liefert403. Identity apiz/v1 live200. Neuer lesender separater Supportabruf, je Anliegen/Fenster einmal, explizite alleinige Zuständigkeit über support_assignments/default. Vorläufig Support3Punkte je Anliegen als offengelegte Aufwandsannahme, nicht gemessene Zeit. Keine Kundeninhalte an UI, keine Nachrichtenaktionen. Fehlende Quellen => Untergrenze ohne Ranking; Details erst nach Personenauswahl. OAuth-Erweiterung bewahrt vorhandene Grants und Refresh. Einrichtung und Quellen siehe docs/features/team-workspace/spec.md. Deployment autorisiert durch vorhandenes „los rüber auf prod wenns fertig ist“; PR13/Main4b6e0c26 produktiv abgeschlossen; Web01807-q46, Worker00262-vmk, Hosting08a3386270bd3095 beim Abschluss bereit.

Prüfstand vor Auslieferung: 5.253 Backendtests/452 Dateien, 479 Frontendtests, TypeScript und Produktions-Build grün. Ein einmaliger Timeout im unveränderten Inventurtest war isoliert und im anschließenden Gesamtlauf grün; kein Inventurcode geändert. Browser: Desktop dunkel,390px hell/dunkel, Auswahl/Details, vollständige/fehlende/fehlerhafte Supportquelle, keine horizontale Überbreite. Lokaler Testadapter hatte zunächst fehlende hasPermission-Testfunktion, korrigiert; echte AuthContext-API unverändert.

Am 20.09.2026 08:53:04 UTC support_assignments/default nach erfolgreichem Dry-run einmalig mit create angelegt: bestätigte Zuständigkeit von Yasemin Kulacoglu. Keine users-/Rollenmutation. Neuer Service danach gegen echte Quellen lesend geprüft: letzte7Tage Kaufland13Anliegen/20Händlerantworten (39Punkte), eBayconnection_required, complete=false. Bekannte eBay-Identität über offizielle apiz/v1-Route liveHTTP200. Git/Deployment noch offen.

## Datenpflegezuordnung — aktuelle Korrektur 20.09.2026

Betreiberbefund bestätigt: Efe/Hüseyin überwiegend Erfassung/Logistik, Yasemin hauptsächlich Aufbereitung. Bisherige Regel wertete bereits condition=new, null→leere Kennnummern und automatische GPSR-Registry-Hydration als Pflege. Fehler der bisherigen Implementierung; nicht mit Mitarbeiterrollen zurechtbiegen.

Branch codex/team-care-attribution-20260920, Basis PR13/Main4b6e0c26. Inhaltliche Vorher/Nachher-Klassifikation, audit-only Kontext capture/datasheet/ownership/pricing, additive productContentEdited und Beitragsschema3. Union aus Inhaltsarbeit/Freigabe dedupliziert, beide Nachweise separat sichtbar. Keine vollständige Prüfung allein aus Inhaltsänderung behaupten. Historische Bereit-Abschlüsse vor Audit-Erweiterung20.09. bleiben unbekannt. Keine Audit-/Produktdatenmutation, kein Backfill, keine Rollen-, Gewichtungs-, Logistik-, Support-, Auth- oder Infrastrukturänderung.

Lesender Replay letzte7Tage: Efe61→1, Hüseyin61→1, Yasemin166→148 belegte Inhaltsänderungen. Benutzernamen/UIDs sind keine Klassifikationsregel. Rohdaten bleiben privat außerhalb Git. Backend5265/453Dateien grün; einmaliger socket-hang-up im unveränderten Versandlabeltest sowohl isoliert als im Gesamtwiederholungslauf grün. Frontend479, TypeScript/Build grün; Browser Desktop/390px und gemischter Rollout geprüft; Releaseabnahme noch ausstehend. Standing Deploymentauftrag „los rüber auf prod wenns fertig ist“ gilt. Ausführlicher Nachweis im Hauptcheckout CODEX_RELEASE_TEAM_CARE_20260920.md.

## Aktuell: kompakte Leistungsoberfläche — 20.09.2026

Betreiber lehnt die überladene UI mit Erklärungen/Rechtfertigungen ausdrücklich ab und verlangt zügige Umsetzung+Produktion ohne wiederholte Prüfrunden. Normalansicht auf Kennzahlen/Bedienelemente reduzieren; Methodik nur auf Abruf. Branchcodex/team-compact-ui-20260920, BasisPR14/Main30d0a896. Kleiner Supportstatus statt großem Doppelblock, Tabelle statt aufgeblähter Detailkarte, keine leere Seitenspalte. Berechnung, Gewichtung, Attribution, Rechte und Backend unverändert. Tests für unveränderte Beiträge und fehlende Quellen ergänzt. Bereits vorhandene Deploymentfreigabe erneut bestätigt. Releaseabschluss im Hauptcheckout CODEX_RELEASE_TEAM_COMPACT_20260920.md.

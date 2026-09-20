# Interaktive Teamverwaltung — 20.09.2026

Status: ursprüngliche Teamoberfläche mit PR #10/Main `eb4b850c` produktiv. Nachtrag Gesamtbeitrag lokal geprüft, Auslieferung vorbereitet. Basis `1fe401cd` (Rollenbereinigung PR #9), isolierter Branch `codex/team-workspace-20260920` in `/Users/oguz/Dev/avycloud-team-ui`.

## Auftrag und Grenzen

Der Betreiber empfindet Mitarbeiter, Leistung und Rollen & Rechte als mau und statisch. Die vorhandenen Funktionen sollen klarer und interaktiv nutzbar werden. Die bestehende Auslieferungsfreigabe für diese Rollenarbeit bleibt maßgeblich. Kontozuordnungen stellt der Inhaber selbst ein; dieser UI-Nachtrag ändert keine Produktivkonten, Autorisierung, API-Routen, Bestände, OMS oder Infrastruktur.

## Ergebnis

1. Zusammenhängende Register mit Tastaturnavigation und erhaltenen Filtern.
2. Mitarbeiterkarten, Suche, Status-/Profilfilter, fokussierte Einladung/Bearbeitung mit genau einem Profil, sichtbar angekündigter Profilwechsel, bestätigtes Löschen. Administratorprofil weiterhin nur für den Inhaber und nicht neu auswählbar.
3. Gesamtbeitrag je Person aus allen fünf Tätigkeiten; Einzelzahlen und Berechnung nach Auswahl. Sortierung nach Beitrag/Name, Datumsbereich mit expliziter Anwendung, Aktivitätsfilter. Auf schmalen Bildschirmen erscheinen ausgewählte Details direkt im Sichtfeld.
4. Profilvergleich mit serverseitigen Werten, nur Unterschiede, Aufgabensuche, Kategorien und Verbindung zu zugeordneten Konten. Kein bearbeitbarer Schein-Schalter für serverseitig feste Rechte.
5. Gemeinsames Kontoverzeichnis via React Query. Keine wiederkehrenden Leistungsabfragen; Backend-Abfrage nur bei aktiver Ansicht, Zeitraumwechsel oder Aktualisieren. Fehler, Leerzustand und Laden getrennt.

## Messung und Datenqualität

Betreiberkorrektur vom 20.09.2026: Anreicherung mit Recherche/Gegenprüfung/Korrektur bis „Bereit“ dauert am längsten; danach Erfassen mit Fotos; danach Packen mit Karton und Wiegen; am schnellsten Pick. Umsetzung als ordinale Aufwandsstufen Pflege4/Erfassen3/Pack2/Pick1. Einfache Einlagerungsbuchungen vorläufig ebenfalls Basis1 (Implementierungsannahme, nicht ausdrücklich vom Betreiber zeitlich eingeordnet). Keine gemessenen Zeitverhältnisse, Anwesenheit oder Qualitätsgrade.

API-Rohzahlen bleiben erhalten. Bewertete Produktpflege basiert jetzt auf `productCareEdited`: eindeutige Produkte je Konto mit dokumentierter Änderung in Datenblattfeldern oder Statuswechsel zu Bereit. Erfassung ist separate Arbeit und zieht keine Pflegepunkte mehr ab. Bearbeiten-Öffnen, leere Saves, unklare historische Logs und technische Metadaten zählen nicht als Datenpflege. Bereit-Abschlüsse sind eine Teilmenge der Pflege und werden nicht doppelt gewertet. Das bestehende Audit-Diff erfasst künftig `ops.readiness`, nicht Bearbeiter-/Zeitstempel. Historische Prüfungen ohne Änderung sind damit weiterhin nicht rekonstruierbar. Keine aktuellen Produktzustände/Initialen rückwirkend als personenbezogenen Abschluss umdeuten.

Team-KPI und Pflege-Detailwert zeigen belegte Pflege; ursprüngliche Speicherzahlen bleiben im Detailtext. API-Version `contributionDataVersion:2` verhindert Fehlwertung während gemischtem Rollout. Datenabdeckung/Quellenfehler, fehlendes Kontoverzeichnis und historische/deaktivierte Konten bleiben wie vorher abgesichert. Suchfilter verändern den Team-Nenner nicht. Kein Ereignis bedeutet keine negative Leistungsnote; nur unklare Speicherungen werden ausdrücklich so bezeichnet.

## Prüfung

- 6 neue Tests: Suche/Filter einschließlich türkischer Namen; Zuordnung historischer Ereignisse ohne Verlust/Umdeutung; stabile, unverändernde Sortierung und defensive Zahlen; echte Produktionspolicy für Packgewicht/Finanzen; vollständige zusammengesetzte Rechte; tatsächliche Profildifferenzen.
- Gesamte Frontend-Suite, TypeScript und Produktions-Build geprüft; endgültige Resultate im Projektgedächtnis/Release-Nachweis.
- Browser mit ausschließlich lokalen Beispieldaten und gesperrten externen Verbindungen: Profil- und Namensänderung, Suche, Filter, Verbindungen, sortierbare Tabelle, Zeitraum-Presets, eigener Zeitraum, Nullwerte, Profilvergleich, Finanzgrenzen und drei API-Fehlerzustände. Kein produktiver Schreibzugriff für die UI-Prüfung.
- Desktop und 390 px mobil; Hell/Dunkel; mobile Dialoge, Escape und fokussierte Leistungsdetails; kein horizontaler Seitenüberlauf. Temporäre Browsergröße wieder zurückgesetzt.
- Lokale Vorschau `.local-preview/` enthält ausschließlich Testadapter und wird nicht ausgeliefert. Build verwendet unveränderte echte APIs.

## Auslieferung / Rückweg

Nur geprüfte Komponenten, Tests und Dokumentation in den UI-PR aufnehmen. Der Hauptcheckout enthält andere Änderungen und bleibt unangetastet. Keine Migration nötig. Deployment über normalen PR/Main-Prozess. Bei Rücknahme dieses UI-Nachtrags bleibt die bereits ausgelieferte Rollenpolicy PR #9 erhalten; niemals die ursprüngliche Rollenmigration zurücksetzen.

## Historie und Korrektur der Aufwandsbewertung

PR #11/Main `7be8d302` führte einen Gesamtbeitrag ein. Der Betreiber hat dessen Gewichtung ausdrücklich als unplausibel zurückgewiesen: Das Modell bevorzugte Erfassen gegenüber aufwendiger Datenpflege. Ebenso fachlich falsch war der Abzug von Pflege bei zuvor erfassten Produkten. Diese Annahmen gelten nicht weiter. Der Betreiber verlangt Ableitung aus den tatsächlichen Arbeitsschritten und hat die Reihenfolge konkretisiert; keine weiteren Durchschnittszeit-Fragen nötig.

Korrektur im isolierten Branch `codex/team-effort-calibration-20260920`, Basis `7be8d302`. Keine Zeitkonfiguration oder neue Verwaltungsroute nötig: Die konkretisierte Reihenfolge ist die Grundlage der oben offengelegten Aufwandsstufen. Keine Auth-, Konten-, Produkt-/Lager-/OMS-Schreiblogik oder Infrastruktur geändert. Einziger zusätzlicher Auditinhalt: readiness-Diff im bestehenden Log. Kein historischer Backfill.

Abnahme: 5.230 Backendtests/450 Dateien, 476 Frontendtests, TypeScript und Produktions-Build grün. Neue Geschäftsfalltests sichern Reihenfolge, Pflege trotz Erfassung, kein Klick-/Save-Gaming, Bereitschaft ohne Datenkorrektur, kein Doppelzählen, keine technischen/System-Ereignisse und API-Version/Originalzählungen. Browserprüfung mit ausschließlich lokalen Beispieldaten; Releaseabschluss im Projektgedächtnis nachtragen.

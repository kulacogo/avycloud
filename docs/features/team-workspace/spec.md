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

Die API liefert Zeitraum-Summen, keine Tagesreihe, Anwesenheit oder Qualitätsmessung. Erfasst/Produktpflege: eindeutige Produkte pro Konto. Eingelagert: Buchungen; Pick/Pack: Vorgänge. Die Rohzahlen werden über offengelegte Gewichte in Beitragspunkte übersetzt: Erfassen 5, Pflege 2, Einlagern 2, Pick 1, Pack 3. Das ist eine unkalibrierte Startannahme, keine gemessene Produktivität oder Qualitätsnote. Erfassen und Pflege desselben Produkts/Kontos im Fenster werden nicht doppelt bepunktet; das kann auch spätere echte Pflege desselben Produkts im Zeitraum ausschließen und wird in den Details erklärt. Konten ohne Ereignis erhalten eine Nullzeile; historische oder deaktivierte Konten mit Ereignissen bleiben erhalten. Historische/deaktivierte Konten werden nicht bewertet. Teamanteil bezieht sich auf alle bewertbaren Konten und bleibt beim Filtern stabil. Additive API-Metadaten melden Fehler und Abfragekappung; bei unsicherer Abdeckung oder fehlendem Kontoverzeichnis keine Gesamtbewertung. Fehlende Quellen erscheinen als Strich, vorhandene Details bleiben lesbar.

## Prüfung

- 6 neue Tests: Suche/Filter einschließlich türkischer Namen; Zuordnung historischer Ereignisse ohne Verlust/Umdeutung; stabile, unverändernde Sortierung und defensive Zahlen; echte Produktionspolicy für Packgewicht/Finanzen; vollständige zusammengesetzte Rechte; tatsächliche Profildifferenzen.
- Gesamte Frontend-Suite, TypeScript und Produktions-Build geprüft; endgültige Resultate im Projektgedächtnis/Release-Nachweis.
- Browser mit ausschließlich lokalen Beispieldaten und gesperrten externen Verbindungen: Profil- und Namensänderung, Suche, Filter, Verbindungen, sortierbare Tabelle, Zeitraum-Presets, eigener Zeitraum, Nullwerte, Profilvergleich, Finanzgrenzen und drei API-Fehlerzustände. Kein produktiver Schreibzugriff für die UI-Prüfung.
- Desktop und 390 px mobil; Hell/Dunkel; mobile Dialoge, Escape und fokussierte Leistungsdetails; kein horizontaler Seitenüberlauf. Temporäre Browsergröße wieder zurückgesetzt.
- Lokale Vorschau `.local-preview/` enthält ausschließlich Testadapter und wird nicht ausgeliefert. Build verwendet unveränderte echte APIs.

## Auslieferung / Rückweg

Nur geprüfte Komponenten, Tests und Dokumentation in den UI-PR aufnehmen. Der Hauptcheckout enthält andere Änderungen und bleibt unangetastet. Keine Migration nötig. Deployment über normalen PR/Main-Prozess. Bei Rücknahme dieses UI-Nachtrags bleibt die bereits ausgelieferte Rollenpolicy PR #9 erhalten; niemals die ursprüngliche Rollenmigration zurücksetzen.

## Nachtrag Gesamtbeitrag (20.09.2026)

Auslöser: Der Betreiber erwartet neben Namen eine plausible Gesamtbewertung statt der jeweils ausgewählten Packzahl. Die erste Umsetzung hatte Verpacken als aktive Kennzahl vorbelegt. Neues Modell wie oben; Kontozuordnungen unverändert. Der Betreiber hat die Gewichtungsfrage noch nicht beantwortet; keine Bestätigung behaupten. Gewichtung ist ausdrücklich als offengelegte Startannahme erkennbar und kann später an tatsächliche Richtzeiten angepasst werden.

Isolierter Branch `codex/team-performance-assessment-20260920`, Basis `eb4b850c`. 7 zusätzliche Frontendtests und 9 zusätzliche Backendtests prüfen alle Tätigkeiten, Überschneidung, Filter-Nenner, fehlende Daten, Kontostatus sowie tatsächliche Abruf-/Tenantfehler. Vollständig 474 Frontend- und 5.223 Backendtests/449 Dateien grün; TypeScript und Build grün. Browserprüfung mit Beispieldaten: Auswahl, Rechenweg, unveränderter Anteil bei Suche, Sortierung, historische Konten, 390px/Hell/Dunkel und Datenlücken. Keine Kontoänderung für diesen Nachtrag; keine Migration. Rückweg nur diesen Nachtrag revertieren, Profile und vorige UI bleiben erhalten.

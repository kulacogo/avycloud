# Interaktive Teamverwaltung — 20.09.2026

Status: implementiert, lokal geprüft; Auslieferung wird vorbereitet. Basis `1fe401cd` (Rollenbereinigung PR #9), isolierter Branch `codex/team-workspace-20260920` in `/Users/oguz/Dev/avycloud-team-ui`.

## Auftrag und Grenzen

Der Betreiber empfindet Mitarbeiter, Leistung und Rollen & Rechte als mau und statisch. Die vorhandenen Funktionen sollen klarer und interaktiv nutzbar werden. Die bestehende Auslieferungsfreigabe für diese Rollenarbeit bleibt maßgeblich. Kontozuordnungen stellt der Inhaber selbst ein; dieser UI-Nachtrag ändert keine Produktivkonten, Autorisierung, API-Routen, Bestände, OMS oder Infrastruktur.

## Ergebnis

1. Zusammenhängende Register mit Tastaturnavigation und erhaltenen Filtern.
2. Mitarbeiterkarten, Suche, Status-/Profilfilter, fokussierte Einladung/Bearbeitung mit genau einem Profil, sichtbar angekündigter Profilwechsel, bestätigtes Löschen. Administratorprofil weiterhin nur für den Inhaber und nicht neu auswählbar.
3. Kennzahlen mit eigenen Einheiten, wählbare Balken, sortierbare Tabelle, Datumsbereich mit expliziter Anwendung, Kontodetails, Aktivitätsfilter. Auf schmalen Bildschirmen erscheinen ausgewählte Details direkt im Sichtfeld.
4. Profilvergleich mit serverseitigen Werten, nur Unterschiede, Aufgabensuche, Kategorien und Verbindung zu zugeordneten Konten. Kein bearbeitbarer Schein-Schalter für serverseitig feste Rechte.
5. Gemeinsames Kontoverzeichnis via React Query. Keine wiederkehrenden Leistungsabfragen; Backend-Abfrage nur bei aktiver Ansicht, Zeitraumwechsel oder Aktualisieren. Fehler, Leerzustand und Laden getrennt.

## Messung und Datenqualität

Die API liefert Zeitraum-Summen, keine Tagesreihe, Anwesenheit oder Qualitätsmessung. Erfasst/Produktpflege: eindeutige Produkte pro Konto. Eingelagert: Buchungen; Pick/Pack: Vorgänge. Keine Summe unterschiedlicher Einheiten. Konten ohne Ereignis erhalten eine Nullzeile; historische oder deaktivierte Konten mit Ereignissen bleiben erhalten. Quellen sind durch die bestehende Backend-Abfragelogik begrenzt und können dort teilweise ohne explizites Fehlersignal ausfallen. Die Oberfläche erklärt diese Grenze.

## Prüfung

- 6 neue Tests: Suche/Filter einschließlich türkischer Namen; Zuordnung historischer Ereignisse ohne Verlust/Umdeutung; stabile, unverändernde Sortierung und defensive Zahlen; echte Produktionspolicy für Packgewicht/Finanzen; vollständige zusammengesetzte Rechte; tatsächliche Profildifferenzen.
- Gesamte Frontend-Suite, TypeScript und Produktions-Build geprüft; endgültige Resultate im Projektgedächtnis/Release-Nachweis.
- Browser mit ausschließlich lokalen Beispieldaten und gesperrten externen Verbindungen: Profil- und Namensänderung, Suche, Filter, Verbindungen, sortierbare Tabelle, Zeitraum-Presets, eigener Zeitraum, Nullwerte, Profilvergleich, Finanzgrenzen und drei API-Fehlerzustände. Kein produktiver Schreibzugriff für die UI-Prüfung.
- Desktop und 390 px mobil; Hell/Dunkel; mobile Dialoge, Escape und fokussierte Leistungsdetails; kein horizontaler Seitenüberlauf. Temporäre Browsergröße wieder zurückgesetzt.
- Lokale Vorschau `.local-preview/` enthält ausschließlich Testadapter und wird nicht ausgeliefert. Build verwendet unveränderte echte APIs.

## Auslieferung / Rückweg

Nur geprüfte Komponenten, Tests und Dokumentation in den UI-PR aufnehmen. Der Hauptcheckout enthält andere Änderungen und bleibt unangetastet. Keine Migration nötig. Deployment über normalen PR/Main-Prozess. Bei Rücknahme dieses UI-Nachtrags bleibt die bereits ausgelieferte Rollenpolicy PR #9 erhalten; niemals die ursprüngliche Rollenmigration zurücksetzen.

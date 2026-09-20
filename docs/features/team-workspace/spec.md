# Interaktive Teamverwaltung — 20.09.2026

Status: Rollen/Teamoberfläche sowie Aufwands- und Supportnachträge bis PR #13/Main `4b6e0c26` produktiv. Aktuell: Korrektur falscher Datenpflegezuordnung im isolierten Branch `codex/team-care-attribution-20260920`, Basis dieses Main-Stands. Auslieferungsnachweis im Projektgedächtnis.

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

API-Rohzahlen bleiben erhalten. Bewertete Produktpflege basiert jetzt auf `productCareEdited`: eindeutige Produkte je Konto mit belegter inhaltlicher Vorher/Nachher-Änderung oder Statuswechsel zu Bereit. Erfassung ist separate Arbeit und zieht keine Pflegepunkte mehr ab. Bearbeiten-Öffnen, leere Saves, unklare historische Logs und technische Metadaten zählen nicht als Datenpflege. Bereit-Abschlüsse sind eine Teilmenge der Pflege und werden nicht doppelt gewertet. Das bestehende Audit-Diff erfasst künftig `ops.readiness`, nicht Bearbeiter-/Zeitstempel. Historische Prüfungen ohne Änderung sind damit weiterhin nicht rekonstruierbar. Keine aktuellen Produktzustände/Initialen rückwirkend als personenbezogenen Abschluss umdeuten.

Team-KPI und Pflege-Detailwert zeigen belegte Pflege; ursprüngliche Speicherzahlen bleiben im Detailtext. API-Version `contributionDataVersion:3` verhindert Fehlwertung während gemischtem Rollout. Datenabdeckung/Quellenfehler, fehlendes Kontoverzeichnis und historische/deaktivierte Konten bleiben wie vorher abgesichert. Suchfilter verändern den Team-Nenner nicht. Kein Ereignis bedeutet keine negative Leistungsnote; nur unklare Speicherungen werden ausdrücklich so bezeichnet.

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

## Kundensupport — Nachtrag 20.09.2026

Der Inhaber bestätigt: ein Firmenkonto je Marktplatz, ausschließlich Yasemin übernimmt die Kommunikation. Diese ausdrückliche Alleinzuständigkeit ist die Zuordnungsgrundlage für beide Kanäle. Keine erneute Rückfrage nach individuellen Marktplatzkonten; keine neue Inbox und keine Änderung des Arbeitsablaufs.

`GET /api/admin/support-performance` ergänzt die Leistungsansicht unabhängig vom bisherigen Produkt-/Lagerabruf. Kaufland: echte Händlerantworten über `/tickets/messages`. eBay: Message API mit tatsächlichem Absender und Antwortzeit; bestehender Token besitzt noch keinen `commerce.message`-Scope. Im Adminbereich kann die vorhandene eBay-Verbindung um Nachrichten erweitert werden. Vorhandene Angebots-/Bestell-/Finanz-Scopes bleiben erhalten; Refresh verwendet weiterhin nur tatsächlich gespeicherte Grants. Händlerzustimmung bleibt ein erforderlicher Einrichtungsschritt. Vor Freigabe sind eBay-Daten ausdrücklich fehlend, keine Nullarbeit.

Zählregel: ein Anliegen mit mindestens einer Händlerantwort im ausgewählten UTC-Zeitfenster zählt einmal je Kanal/Fenster; mehrere Antworten geben keine Mehrfachpunkte. Ein Anliegen in unterschiedlichen Zeitfenstern kann jeweils bearbeitet worden sein, daher Fensterwerte nicht addieren. Anliegen sind keine abgeschlossenen Tickets. Kunden-/Systemnachrichten zählen nicht. Support erhält vorläufig Aufwandsstufe3 für Lesen, Prüfen und Beantworten — eine offengelegte Implementierungsannahme, keine gemessene Bearbeitungszeit oder vom Betreiber festgelegte Zahlenrelation.

Supporteinzelzahlen erscheinen erst nach Mitarbeiterauswahl; die Übersicht zeigt Quellenabdeckung und Gesamtpunkte. Bei fehlenden/abgeschnittenen Daten: bekannte Punkte als Untergrenze, alphabetische Reihenfolge, keine Teamanteile/Rangfolge. Kein Support-Fehler blockiert die vorhandene Leistungsquelle. Historische/deaktivierte Konten bleiben ohne Bewertung.

Konfiguration `support_assignments/{tenantId}` enthält tenantId, responsibleUid, exclusive, channels, confirmation, confirmedAt. Skript `backend/scripts/configure-support-assignment.js` prüft aktiven Tenantbenutzer, arbeitet standardmäßig trocken, erstellt nur mit `--apply`, überschreibt keine abweichende Konfiguration. Rollen/Rechte bleiben unverändert. Aktuelle gemeinsame Integrationen werden ausschließlich für Tenant default verwendet. Exakte Dokumentabfrage benötigt keinen neuen Index.

Datensparsam: Nachrichten nur während des lesenden Abrufs im Speicher; zur Oberfläche ausschließlich Fall-/Antwortzahlen, Abdeckung und zuständige UID. Kein Kundentext, keine Kundenkennungen, keine Markierung als gelesen, keine Antworten, kein Hintergrundjob. Cache maximal60Sekunden/30Fenster, Kaufland maximal20Seiten à30, eBay maximal45Abrufe à50 plus Identität; Zeitbudget25Sekunden vor neuem Abruf, einzelne Requests5/7Sekunden. Abbruch, unbekannte Datenformate und überlappende Seiten führen zu Teilabdeckung.

Primärquellen: [Kaufland OpenAPI](https://sellerapi.kaufland.com/swagger.json), [eBay Message OpenAPI](https://developer.ebay.com/api-docs/master/commerce/message/openapi/3/commerce_message_v1_oas3.json), [eBay Identity OpenAPI](https://developer.ebay.com/api-docs/master/commerce/identity/openapi/3/commerce_identity_v1_oas3.json). Identity unter apiz.ebay.com/commerce/identity/v1/user/ live lesend mit HTTP200 und vorhandenem username geprüft.

## Datenaufbereitung: falsche Erfassungszuordnung korrigiert — 20.09.2026

Betreiber meldet zu Recht, dass die Anzeige Erfassen bei Efe/Hüseyin wie aufwendige Aufbereitung durch Yasemin wertet. Ursache war die zu breite Regel „irgendein identification/details-Feld geändert“. Erfassung ergänzt condition=new, null→leere Kennnummern und beim Lesen automatisch hydratisierte GPSR-Registry-Daten; das ist keine belegte persönliche Datenrecherche.

`product-care-evidence` klassifiziert tatsächliche Audit-Vorher/Nachher-Werte. Titel/Beschreibung/Marke/Kategorie/MPN, fachliche Merkmale und manuelle GPSR-Inhalte zählen; Schlüsselreihenfolge, Leerraum/leere Defaults, Registry-Metadaten/-Hydration und reine Foto-, Barcode-, Preis-, Gewichts-/Lageränderungen nicht. Unlesbare oder fehlende Belege erhalten keine Pflegepunkte. Keine Namens-/Rollen-Sonderregeln.

Bestehendes `/api/save` nimmt optional den Auditkontext `activity=capture|datasheet|ownership|pricing` entgegen. Erfassung, Bearbeitungsübernahme und Preisarbeit erhalten darüber keine Pflegepunkte; unbekannte/alte Clients nutzen die konservative Inhaltsprüfung. Kontext verändert weder Produktbody noch Speicherung/Autorisierung, ist keine Sicherheitsgrenze und kommt nicht in das Produkt. Nutzer/Tenant stammen weiter aus Auth.

`productCareEdited` ist die deduplizierte Vereinigung aus Inhaltsänderung und Freigabe; neues additives `productContentEdited` zählt nur Inhaltsänderungen, `productReady` nur explizite Übergänge zu ready. Die UI bezeichnet die Arbeit als „Datenaufbereitung“ und trennt beide Nachweise. Inhaltlich geändert bedeutet weder umfassend kontrolliert noch freigegeben. Historische Freigaben vor Beginn der Statusprotokollierung am 20.09.2026 bleiben unbekannt; keine Rückrechnung über heutige Initialen/Statuswerte. Version3 verhindert Fehlbewertung alter Serverantworten beim gemischten Rollout.

Lesender Replay des geprüften Siebentagefensters: Efe 61→1, Hüseyin 61→1, Yasemin166→148 Produkte mit belegter Inhaltsänderung. Dies sind Auditbelege, keine Qualitäts- oder vollständigen Freigabezahlen. Keine Produktionsdatenkorrektur/Migration, Gewichte und Logistik-/Supportzählung unverändert. Regressionen decken reale Default-/Registry-Ursachen, späteren echten Editor, Übergänge, Dedup und audit-only Kontext der tatsächlichen Save-Route ab.

## Kompakte Leistungsansicht — 20.09.2026

Betreiber verlangt ausdrücklich weniger Text und Platzverbrauch. Normalansicht: Zeitraum, schmale Supportstatusanzeige, kompakte Teamkennzahlen und Personenbeiträge. Kein großer Support-Einführungsblock oder wiederholte Gewichtungserklärung. Ausgewählte Person: Name, Punkte/Anteil, Tätigkeitstabelle mit Anzahl/Punkten und schlanke Supportzeilen. Inhalts-/Freigabenachweise hinter „Datenaufbereitung · Details“, Methodik hinter „Berechnung“. Ohne Auswahl nutzt die Liste die volle Breite. Fehlende/unvollständige Daten bleiben kurz sichtbar; Zahlen, Gewichtung, Attribution und Backend unverändert. Desktop/Mobil, Hell/Dunkel prüfen; Releaseabschluss im Projektgedächtnis.

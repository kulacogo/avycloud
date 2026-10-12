# Pick-Routen über mehrere Aufträge — 12.10.2026

## Status

Lokal implementiert auf Main-Basis `18249df79ed560ce2a7f04a50aa148c3de7692ee`, Branch `codex/pick-route-repair-20261012`. Der Betreiber hat am 12.10.2026 auf die konkrete Frage nach Commit und Deployment mit „auf prod bitte“ freigegeben. Veröffentlichung über einen eigenen Pull Request mit grüner CI; Produktionsprüfung folgt nach dem Merge. Fremde Desktop-UX-Arbeit im anderen Worktree bleibt unberührt.

## Befund und Betreiberablauf

Mitarbeiter sammeln mehrere Aufträge pro Rundgang und packen erst nach dem Picken. Wagenkapazität, Fächer und feste Auftragspakete sind keine Voraussetzung für die Korrektur.

Die exklusive Zuweisung aus PR32 sortierte neue Aufträge ausschließlich nach `createdAt`. Die Handheld-Route sortiert dagegen nur Positionen des bereits zugewiesenen Auftrags. Damit verschwand die gemeinsame Routenfolge zwischen Aufträgen. Frisch geprüfter Main enthält diesen Pfad; produktive Webrevision am Prüfbeginn `product-hub-backend-01837-xdv`.

Lesende Produktionsauswertung heute: In einer Gruppe mit **51 vollständig gepickten Ein-BIN-Aufträgen gab es 31 Zonenwechsel**, in einer zweiten Gruppe mit 6 solchen Aufträgen 3. Replay derselben bekannten Pick-BINs mit neuer Auftragsreihenfolge: **2 bzw. 2 Zonenwechsel**. Das Replay nimmt die Aufträge als verfügbaren Vorrat und ihre historisch verwendeten BINs an. Es misst keine realen Meter/Minuten und bildet keine parallelen Mitarbeiterbewegungen oder spätere Warenumzüge nach. Keine Bestandsbuchung, Auftragszuweisung oder Statusänderung in Produktion zur Messung.

## Änderung

- Neue Auftragsfolge über die vorhandene BIN-Hierarchie: zuletzt bestätigter Bereich, gleicher Gang, bestehende Richtung von hinten nach vorne, danach weitere Bereiche. Arbeit hinter dem Mitarbeiter kommt beim Umlauf, statt ihn vorzeitig zurückzuschicken.
- Auftragseingang entscheidet nur noch bei gleichem Lagerplatz. Keine Unterbrechung des Rundgangs an Datumsgrenzen, keine feste Auftragszahl und kein Wechsel in Packen.
- `pickWork.lastBinCode` wird additiv in derselben Transaktion wie eine echte Pick-Buchung gespeichert. Wiederholte Quittungen verändern den Ausgangspunkt nicht. Alte Ein-BIN-Picks liefern einen eindeutigen Ausgangspunkt; bei mehreren historischen BINs wird die Reihenfolge nicht aus ungeordneten Map-Schlüsseln geraten.
- Positive Produkt-BIN-Mengen werden tenantgebunden und mit kleiner Feldprojektion gelesen. Explizite Produkt-ID, SKU und EAN-only-Fallback; doppeldeutige SKU ergibt keinen geratenen Platz. Bekannte aktuelle API-Nutzung besteht hauptsächlich aus SKU-only-Aufträgen. Lesender echter Lookup: 2 freie Kandidaten, 2 aufgelöst, 151 ms (ein Messpunkt, keine Latenzgarantie).
- Diese Ortsprojektion dient nur der Reihenfolge. Der vorhandene Bestandspfad prüft und bucht weiterhin authoritativ im BIN. Keine neue Reservierung oder zweiter Bestandsschreiber.
- Laufende/pausierte Arbeit wird immer fortgesetzt. Auswahl eines bestimmten Auftrags bleibt möglich. Ortslesefehler erzeugt vor einer neuen Zuweisung `503 PICK_ROUTE_UNAVAILABLE`; die eigene bestehende Arbeit benötigt diesen Lookup nicht.
- Eigentümer, Scanner-Token, Idempotenz, Restmengen und Pick-/Ship-Single-Writer bleiben erhalten. Zwei Mitarbeiter können nie denselben freien Auftrag erhalten; die Entscheidung wird in der Firestore-Transaktion erneut geprüft.

## Grenzen

Ganze Aufträge bleiben zusammen; Artikel verschiedener Mehrpositionen-Aufträge werden nicht vermischt. Grundlage ist die vorhandene BIN-Reihenfolge, kein vermessener Lagergraph und keine mathematische Garantie kürzester Laufwege. Neu eintreffende Aufträge und andere Picker verändern die verbleibende Arbeit. Nicht zugeordnete/unbekannte Lagerplätze werden nach bekannten Orten zur Klärung vorgelegt. Eine laufende oder problematische Zuweisung wird nicht zugunsten einer schöneren Route aufgegeben.

## Prüfung

- Basis vor Änderung: 6.065 Backendtests / 529 Dateien grün, Frontend-Build grün.
- Drei neue Service-Regressionen zuerst rot: falscher Routenstart, zweiter Mitarbeiter im falschen Bereich, fehlender bestätigter Ausgangspunkt. Danach grün. Zusätzlich zunächst rote Fälle für Vorwärtsfortsetzung bei neu eingetroffener Arbeit und definierten Ortslesefehler.
- Gezielte Tests: route-aware HTTP-Zuweisung für zwei Mitarbeiter; parallele Tx-Konflikte; Resume/Pause/Scannerübernahme; Produktprojektion/Tenantgrenze; unbekannte/mehrdeutige/leere BINs; Teilpick; idempotente Quittung; tatsächliches atomisches Speichern des Ausgangspunkts; Pick vor Ship ohne Doppel-Decrement.
- Frischer finaler Gesamtlauf: **6.084 Tests / 531 Dateien bestanden, 0 fehlgeschlagen, 0 übersprungen**, 12.10.2026, Start 12:07:07 MESZ, 38,85 s. `GOOGLE_CLOUD_PROJECT=avycloud-local-test GCLOUD_PROJECT=avycloud-local-test FIRESTORE_EMULATOR_HOST=127.0.0.1:1 GOOGLE_APPLICATION_CREDENTIALS=/dev/null npm test -- --maxWorkers=4`. Log `/tmp/avycloud-pick-route-final-backend.log`. Helpbundle mit 149 Artikeln / 0 Fehlern aus den vorhandenen Main-KB-Quellen aktualisiert (holt auch bislang nicht synchronisierte Main-Dokumentation nach); `git diff --check` sauber. Frontend unverändert, Basis-Build grün. Kein echter Pick zu Testzwecken.

## Auslieferung / Rückweg

Backendänderung bei unveränderten API-Eingaben/-Antwortformen; bestehende Scanner brauchen keinen neuen Bedienablauf. Commit und Release sind durch die Antwort auf die konkrete Auslieferungsfrage freigegeben. Laufende Zuordnungen bleiben erhalten und greifen beim nächsten regulären „Nächster Auftrag“ auf die neue Reihenfolge zu.

Ein gezielter Rückbau der Routenentscheidung auf Main-Basis18249 ist möglich; additive `lastBinCode`-Felder können stehen bleiben. Nicht auf eine Version vor PR32 zurückrollen: Sie kennt die zentralen Pickquittungen und Eigentümersperren nicht. Keine laufenden Zuordnungen oder Bestände zur Einführung löschen/umschreiben.

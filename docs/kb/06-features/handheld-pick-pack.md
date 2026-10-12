---
title: Handheld — exklusives Picken, Packen und Druckstation
for: [dev, agent, admin]
lastReviewed: 2026-10-12
---

# Handheld Pick / Pack

Implementierung: `MobileOperationsView`, `HandheldHome`, `services/pick-work.js`, `lib/print-delivery.js`, `tools/print-agent`. Rolloutstatus und Belege: [Releaseprüfung](../../reviews/handheld-team-print-20261007/README.md).

## Arbeitsablauf

Die Handheld-Startseite zeigt versendete Aufträge heute, den eigenen fortsetzbaren Auftrag und Pick-/Pack-Einstiege. Die Operationsauswahl nutzt vier Karten. Aktives Picken/Packen erhält den gesamten verfügbaren Bildschirm; Hauptaktion unten, BIN und SKU ohne Zeilenumbruch, Stückzahl groß. Mengen- und Gewichtseingabe sind eigene Ansichten. Die Artikelübersicht darf bei vielen Positionen scrollen; die Arbeitsaktion bleibt sichtbar.

Picken beginnt mit einer serverseitigen Pickrunde. Zwei Mitarbeiter erhalten unterschiedliche Aufträge; ein Auftrag hat immer nur einen Eigentümer. Innerhalb der Runde kann die nächste Position zu einem anderen Auftrag gehören. Ein anderes Gerät desselben Kontos erfordert ausdrücklich „Auf diesem Scanner fortsetzen“; dabei werden die bisherigen Buchungstoken aller gehaltenen Aufträge ungültig. Es gibt keine automatische Freigabe nach Zeitablauf.

„Runde beenden“ ist während der Runde unten erreichbar. Nach Bestätigung werden alle gehaltenen Restaufträge atomar freigegeben; gebuchte Mengen, Quittungen und Bestandsabbuchungen bleiben erhalten. Bereits gepickte Ware am Packplatz ablegen, damit der nächste Mitarbeiter nur die Restmengen ergänzt. „Problem“ überspringt einen Auftrag für diese Runde; der Rundenabschluss gibt auch ihn frei. Bestätigte neue Aufträge werden beim nächsten BIN-Schritt berücksichtigt. Die drei am 12.10. gemeldeten alten Zuweisungen wurden laut Betreiber bereits abgearbeitet und werden nicht manuell zurückgesetzt.

BIN und SKU scannen, angezeigte Menge prüfen und „N Stück gepickt“ drücken. Ein wiederholter SKU-Scan bucht nichts. Teilmengen sind möglich; Fortschritt und aktuelle BIN-Bestände kommen nach der Buchung vom Server. Die Desktop-Pickansicht verwendet dieselbe Zuweisung und denselben Fortschritt.

### Durchgehender Rundgang über mehrere Aufträge

Betreiberablauf: Mitarbeiter sammeln mehrere Aufträge und beenden erst das Picken, bevor sie packen. Nach jeder erfolgreichen BIN-Buchung entscheidet der Server über die nächste offene Position über Auftragsgrenzen hinweg. Eine entfernte zweite Position desselben Auftrags erzwingt damit keinen Umweg vor einem benachbarten BIN eines anderen Auftrags. Ganze Aufträge bleiben jeweils exklusiv; die Runde beansprucht neue Aufträge erst bei Auswahl ihres nächsten Stopps, nicht den gesamten Vorrat im Voraus. Keine feste Wagenkapazität oder Pack-Zwischenstopps.

Die Planung bevorzugt ab dem zuletzt gebuchten BIN denselben Bereich (Zone/Etage), darin denselben Gang und dann die kleinere Gang-/Regaldifferenz. Bei Produkten in mehreren BINs kann ein näherer positiver BIN vor einem weiter entfernten BIN mit höherem Bestand liegen. Ohne Ausgangspunkt und bei Wechseln zwischen Bereichen gilt die hinterlegte Lagerreihenfolge. Pausierte Problemaufträge werden innerhalb derselben Runde ausgelassen. Unbekannte Lagerplätze bleiben als zu klärende Arbeit erhalten.

Quellen: [Rundenservice](../../../backend/services/pick-round.js), [Routenentscheidung](../../../backend/services/pick-route.js), [tenantgebundene Lagerplatzprojektion](../../../backend/services/pick-route-locations.js). Die Projektion ist nur Planung; tatsächlicher Bestand und Berechtigung werden in der bestehenden Stock-out-Transaktion geprüft. Kein zusätzlicher Bestandsschreiber. Die BIN-Hierarchie enthält keine vermessenen Ganglängen, Durchgänge oder Hindernisse: diese Näherungsregel ist keine Garantie für den geometrisch kürzesten Fußweg.

Desktop und alte Scanner verwenden weiter die kompatiblen `pick-work`-Endpunkte. Sie können ausdrücklich freigegebene Teilaufträge mit unverändertem Fortschritt übernehmen. Die neue auftragsübergreifende BIN-Reihenfolge und der Rundenbutton werden in der mobilen Ansicht verwendet.

Validierung und Veröffentlichungsstand: [Pickrunde 12.10.2026](../../reviews/pick-round-20261012/README.md); historischer Vorgänger: [PR36](../../reviews/pick-route-repair-20261012/README.md).

Beim Packen müssen alle Positionen des ausgewählten Auftrags gescannt und die Stückzahlen bestätigt werden. Danach Gewicht und Versandart wählen. „Label drucken“ erstellt die Sendung über den bestehenden Versandweg und reiht das vorhandene Label in die Druckwarteschlange ein. Der Scanner braucht keinen Android-Druckdialog. Erst „Label angebracht · fertig“ beendet die sichtbare Druckaufgabe. Das ist eine menschliche Bestätigung; CUPS-Annahme allein beweist kein physisch gedrucktes oder angebrachtes Etikett.

## Daten und Invarianten

- Additives `orders.pickWork`: `version`, `ownerUid`, `ownerName`, `sessionId`, `token`, `status`, `updatedAt`, `lines` (`itemId`, `itemKey` als Produkt/SKU-Fingerprint, `required`, `picked`), `receipts`, optional `lastBinCode`, `roundId`, `releasedAt`, `releasedBy`, `releaseHistory`. Status zusätzlich `released`; Quittungen neuer Buchungen enthalten `ownerUid`. Der letzte bestätigte BIN wird atomar mit der Pick-Buchung gespeichert; ein doppelter Request setzt ihn nicht zurück. Bei alten Aufträgen wird er nur aus einer einzigen eindeutigen BIN-Quittung abgeleitet, niemals aus der Reihenfolge einer Firestore-Map geraten.
- Neue Collection `pick_assignments`, Dokument-ID SHA-256 aus Tenant und UID; Felder `tenantId`, `ownerUid`, `orderId`, `updatedAt`; für Runden zusätzlich `roundId`, `roundStatus`, `sessionId`, `orderIds`, `lastBinCode`, `startedAt`, `endedAt`, `endResult`. `orderId` bleibt der aktuelle Zeiger; `orderIds` hält auch zwischenzeitlich gesperrte Aufträge bis zum Rundenabschluss. Alle neuen Queries sind tenantgebunden.
- Zuweisung in Firestore-Transaktion. Buchungsprüfung, Fortschritt, bestehender Stock-Claim, BIN- und Lagerbuchschreibvorgang laufen in derselben bestehenden Stock-out-Transaktion. Keine neue parallele Bestandswahrheit.
- Authentifizierter Actor kommt ausschließlich vom Server. Buchungen prüfen Tenant, Mitarbeiter, Token, Position, Produkt, ganze positive Menge und Restmenge. `requestId` wird pro Buchungsabsicht stabil gehalten; gleicher Schlüssel mit anderem Inhalt wird abgelehnt.
- Unvollständige verwaltete Picks dürfen nicht `picked`, `packing`, `packed` oder `shipped` werden. Prüfung auch vor dem externen Labelkauf. Nachträglich veränderte Positionen blockieren Abschluss. Teilpicks können nicht pauschal storniert werden, weil die bestehende Gesamt-Rückbuchung sonst zu viel Bestand erzeugen könnte.
- Freigegebene Teilpicks werden nur bei intakten zentralen Positionen/Mengen und einem fehlenden oder von `pick` stammenden Stock-Marker neu vergeben. Alte Picks mit `stockDecrementedAt` ohne zentrale Mengen werden nicht automatisch vergeben. Vor Rollout lesen und gegebenenfalls einzeln klären.
- Stock-Single-Writer, `saveProductV2`, bestehende Stock-Events und OMS-Übergänge bleiben verbindlich. Keine Auth-/RBAC-/Deploy-Konfiguration geändert.

## Druckvertrag

Initialer Job: SHA-256 aus Tenant und Shipment-ID. Wiederholung desselben Requests liefert denselben Job, auch von mehreren Geräten. Ein ausdrücklicher Nachdruck verwendet eine neue `reprintId` für dieselbe Sendung und kauft kein neues Porto.

Protokoll 2: `queued → claimed → dispatching → done`. Claim bindet Tenant, UID, Agent und zufälliges Token. Alte Agenten dürfen keine Jobs abholen. `dispatching` wird nicht an andere Stationen vergeben. Der Agent schreibt vor CUPS eine dauerhafte lokale Sendedatei und nach Annahme eine fsync-gesicherte Quittung. Verlorene HTTP-Erfolgsmeldungen werden nur erneut bestätigt. Unterbrochene Übergaben ohne sichere Quittung werden `uncertain`, ohne automatischen Nachdruck. Ein noch laufender oder nur zeitlich abgebrochener Job erlaubt im Handheld keinen neuen Nachdruckjob.

Nach einem Browser-Neuladen bleibt die offene Labelaufgabe pro Benutzer in sessionStorage erhalten. Bei verlorener Versandantwort wird die vorhandene Sendung gesucht; es wird nicht blind erneut frankiert. Wenn keine Sendung entstanden ist, muss der Auftrag geprüft werden. Der Fehler wird nicht als „fertig“ quittiert.

Eine echte Druckstation im Drucker-LAN mit angemeldetem Konto (`orders:read`, `orders:ship`) ist Voraussetzung für den neuen Packablauf. Die lokale Vorschau verwendet ausschließlich Testdaten und simuliert die Druckantwort; sie ist kein Nachweis physischer Druckfunktion.

Betreiberziel seit 08.10.2026: **Windows 192.168.178.61**, seit 09.10. über Tailscale **100.83.3.111** (`09410-DRIVE`) erreichbar. Windows-Adapter mit echten Treiberformaten und festem Druckernamen, SumatraPDF 3.6.1 ohne Dialog; Aufgabenplanung unter LocalService startet beim Booten. Dauerhaftes Journal und Refresh-Sitzung im zugriffsbeschränkten ProgramData-Verzeichnis. Windows-Erfolg ist eine Anwendungsquittung nach Sumatra-Druckübergabe; das API-Feld `spoolId` enthält dort ausdrücklich `sumatra:…`, keinen behaupteten Windows-Job-Identifier. Einrichtung prüft beide Rollen mit Testetiketten unter dem tatsächlichen Dienstkonto. Details und Einschränkungen im [Installer-Runbook](../../../tools/print-agent/README.md#windows--zielrechner-19216817861).

## Verweise

[Pick-API](../09-api/orders.md#exklusive-pick-arbeit) · [Druck-API](../09-api/print.md) · [Druckstation einrichten](../../../tools/print-agent/README.md) · [Handheld-Home](../05-pages/handheld-home.md).

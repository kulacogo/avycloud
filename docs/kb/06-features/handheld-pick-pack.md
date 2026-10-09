---
title: Handheld — exklusives Picken, Packen und Druckstation
for: [dev, agent, admin]
lastReviewed: 2026-10-09
---

# Handheld Pick / Pack

Implementierung: `MobileOperationsView`, `HandheldHome`, `services/pick-work.js`, `lib/print-delivery.js`, `tools/print-agent`. Rolloutstatus und Belege: [Releaseprüfung](../../reviews/handheld-team-print-20261007/README.md).

## Arbeitsablauf

Die Handheld-Startseite zeigt versendete Aufträge heute, den eigenen fortsetzbaren Auftrag und Pick-/Pack-Einstiege. Die Operationsauswahl nutzt vier Karten. Aktives Picken/Packen erhält den gesamten verfügbaren Bildschirm; Hauptaktion unten, BIN und SKU ohne Zeilenumbruch, Stückzahl groß. Mengen- und Gewichtseingabe sind eigene Ansichten. Die Artikelübersicht darf bei vielen Positionen scrollen; die Arbeitsaktion bleibt sichtbar.

Picken beginnt mit einer serverseitigen Zuweisung eines ganzen Auftrags. Zwei Mitarbeiter erhalten unterschiedliche Aufträge. Derselbe Mitarbeiter setzt seinen Auftrag fort. Ein anderes Gerät desselben Kontos erfordert ausdrücklich „Auf diesem Scanner fortsetzen“; dabei wird das bisherige Buchungstoken ungültig. Pause behält den Auftrag und seine physisch gepickte Ware beim Mitarbeiter. Es gibt bewusst keine automatische Freigabe nach Zeitablauf. Ein Mitarbeiterwechsel mit Teilware benötigt organisatorische Klärung; eine automatische Übergabe an andere Konten ist nicht implementiert.

BIN und SKU scannen, angezeigte Menge prüfen und „N Stück gepickt“ drücken. Ein wiederholter SKU-Scan bucht nichts. Teilmengen sind möglich; Fortschritt und aktuelle BIN-Bestände kommen nach der Buchung vom Server. Die Desktop-Pickansicht verwendet dieselbe Zuweisung und denselben Fortschritt.

Beim Packen müssen alle Positionen des ausgewählten Auftrags gescannt und die Stückzahlen bestätigt werden. Danach Gewicht und Versandart wählen. „Label drucken“ erstellt die Sendung über den bestehenden Versandweg und reiht das vorhandene Label in die Druckwarteschlange ein. Der Scanner braucht keinen Android-Druckdialog. Erst „Label angebracht · fertig“ beendet die sichtbare Druckaufgabe. Das ist eine menschliche Bestätigung; CUPS-Annahme allein beweist kein physisch gedrucktes oder angebrachtes Etikett.

## Daten und Invarianten

- Additives `orders.pickWork`: `version`, `ownerUid`, `ownerName`, `sessionId`, `token`, `status`, `updatedAt`, `lines` (`itemId`, `itemKey` als Produkt/SKU-Fingerprint, `required`, `picked`), `receipts`.
- Neue Collection `pick_assignments`, Dokument-ID SHA-256 aus Tenant und UID; Felder `tenantId`, `ownerUid`, `orderId`, `updatedAt`. Alle neuen Queries sind tenantgebunden.
- Zuweisung in Firestore-Transaktion. Buchungsprüfung, Fortschritt, bestehender Stock-Claim, BIN- und Lagerbuchschreibvorgang laufen in derselben bestehenden Stock-out-Transaktion. Keine neue parallele Bestandswahrheit.
- Authentifizierter Actor kommt ausschließlich vom Server. Buchungen prüfen Tenant, Mitarbeiter, Token, Position, Produkt, ganze positive Menge und Restmenge. `requestId` wird pro Buchungsabsicht stabil gehalten; gleicher Schlüssel mit anderem Inhalt wird abgelehnt.
- Unvollständige verwaltete Picks dürfen nicht `picked`, `packing`, `packed` oder `shipped` werden. Prüfung auch vor dem externen Labelkauf. Nachträglich veränderte Positionen blockieren Abschluss. Teilpicks können nicht pauschal storniert werden, weil die bestehende Gesamt-Rückbuchung sonst zu viel Bestand erzeugen könnte.
- Alte Picks mit `stockDecrementedAt` ohne zentrale Mengen werden nicht automatisch vergeben. Vor Rollout lesen und gegebenenfalls einzeln klären.
- Stock-Single-Writer, `saveProductV2`, bestehende Stock-Events und OMS-Übergänge bleiben verbindlich. Keine Auth-/RBAC-/Deploy-Konfiguration geändert.

## Druckvertrag

Initialer Job: SHA-256 aus Tenant und Shipment-ID. Wiederholung desselben Requests liefert denselben Job, auch von mehreren Geräten. Ein ausdrücklicher Nachdruck verwendet eine neue `reprintId` für dieselbe Sendung und kauft kein neues Porto.

Protokoll 2: `queued → claimed → dispatching → done`. Claim bindet Tenant, UID, Agent und zufälliges Token. Alte Agenten dürfen keine Jobs abholen. `dispatching` wird nicht an andere Stationen vergeben. Der Agent schreibt vor CUPS eine dauerhafte lokale Sendedatei und nach Annahme eine fsync-gesicherte Quittung. Verlorene HTTP-Erfolgsmeldungen werden nur erneut bestätigt. Unterbrochene Übergaben ohne sichere Quittung werden `uncertain`, ohne automatischen Nachdruck. Ein noch laufender oder nur zeitlich abgebrochener Job erlaubt im Handheld keinen neuen Nachdruckjob.

Nach einem Browser-Neuladen bleibt die offene Labelaufgabe pro Benutzer in sessionStorage erhalten. Bei verlorener Versandantwort wird die vorhandene Sendung gesucht; es wird nicht blind erneut frankiert. Wenn keine Sendung entstanden ist, muss der Auftrag geprüft werden. Der Fehler wird nicht als „fertig“ quittiert.

Eine echte Druckstation im Drucker-LAN mit angemeldetem Konto (`orders:read`, `orders:ship`) ist Voraussetzung für den neuen Packablauf. Die lokale Vorschau verwendet ausschließlich Testdaten und simuliert die Druckantwort; sie ist kein Nachweis physischer Druckfunktion.

Betreiberziel seit 08.10.2026: **Windows 192.168.178.61**, seit 09.10. über Tailscale **100.83.3.111** (`09410-DRIVE`) erreichbar. Windows-Adapter mit echten Treiberformaten und festem Druckernamen, SumatraPDF 3.6.1 ohne Dialog; Aufgabenplanung unter LocalService startet beim Booten. Dauerhaftes Journal und Refresh-Sitzung im zugriffsbeschränkten ProgramData-Verzeichnis. Windows-Erfolg ist eine Anwendungsquittung nach Sumatra-Druckübergabe; das API-Feld `spoolId` enthält dort ausdrücklich `sumatra:…`, keinen behaupteten Windows-Job-Identifier. Einrichtung prüft beide Rollen mit Testetiketten unter dem tatsächlichen Dienstkonto. Details und Einschränkungen im [Installer-Runbook](../../../tools/print-agent/README.md#windows--zielrechner-19216817861).

## Verweise

[Pick-API](../09-api/orders.md#exklusive-pick-arbeit) · [Druck-API](../09-api/print.md) · [Druckstation einrichten](../../../tools/print-agent/README.md) · [Handheld-Home](../05-pages/handheld-home.md).

# Pickrunde: nahe BINs und expliziter Abschluss — 12.10.2026

## Problem und Änderung

Eine pausierte/unvollständige Zuordnung blieb bisher beim Mitarbeiter; neue Scanner konnten diese Restpicks nicht erhalten. Der Betreiber bestätigt die drei gemeldeten Incident-Aufträge als inzwischen erledigt. Keine manuelle Reparatur dieser Produktionsdaten.

Die mobile Runde entscheidet jetzt **nach jedem gebuchten BIN über Auftragsgrenzen hinweg**. Beispiel: Auftrag A hat einen nahen und einen entfernten Artikel; nach dem ersten Artikel wird zuerst der benachbarte BIN von Auftrag B angeboten. Neue Aufträge werden erst bei Auswahl atomar beansprucht, nicht alle auf einmal. Aufträge haben weiterhin genau einen aktuellen Eigentümer.

**Runde beenden** ist unten erreichbar. Nach Bestätigung werden alle gehaltenen Restaufträge freigegeben, einschließlich Problem-Pausen und inzwischen auf `on_hold` gesetzter Aufträge. Bereits gebuchte Mengen, Quittungen und Bestandsmarker bleiben erhalten. Neue Eigentümer buchen nur Restmengen. Tokenrotation schützt vor verspäteten Buchungen alter Scanner. Gepickte Ware muss am Packplatz abgelegt werden, bevor ein anderer Mitarbeiter die Restmengen ergänzt.

Keine gemessenen Ganglängen/Querwege vorhanden: Nähe wird aus Zone, Etage, Gang und Regal bestimmt. Dies ist eine Lagerhierarchie-Heuristik, kein Nachweis mathematisch kürzester Fußwege. Keine Wagenkapazität, festen Auftragspakete oder Pack-Zwischenstopps.

## Validierung

- Neue Service-/API-Regressionen: auftragsübergreifende Nähe, parallele Mitarbeiter, Teilmengenübergabe, alte Token, widersprüchliche Mengen, idempotenter Abschluss, Scannerübernahme aller gehaltenen Aufträge, alte Pausen, Problem überspringen, verspätete Requests, Tenantgrenze, Buchung/Abschluss-Rennen, OMS-Abschluss nach verlorener Antwort, Legacy-Client mit Teilmenge.
- On-hold-Verlust der Rundenzuordnung zunächst rot reproduziert, Index-/Tokenbehandlung korrigiert, anschließend grün.
- Stock-out-Test verwendet den echten bestehenden Buchungspfad mit isoliertem Speicher: Alice bucht 1 von 2, Bob übernimmt Rest, alter Token scheitert, Bob bucht genau 1, Retry ohne zweite Abbuchung. Bestand 5 → 3.
- Frontend: **595 bestanden, 2 bestehende Windows-PowerShell-Skips**; Typprüfung und Produktionsbuild grün.
- Browser: **5 Szenarien bestanden**, reale React-Komponente mit isolierter lokaler Fixture; externe Requests blockiert. 320×568, 360×640, 393×852 ohne Seitenüberlauf, erreichbare ≥44px-Aktion, Dialogfokus/Abbruch, Ende mit Teilmenge, Fehler erhält aktive Arbeit, Server-BIN gewinnt gegen lokale Standardreihenfolge. Screenshots visuell geprüft; keine Hardware-/physische Laufwegprüfung behauptet.
- Erster finaler Backend-Gesamtlauf: 6105 bestanden/1 fehlgeschlagen (`access-workflows`: einmal 404 statt erwarteter 403). Betroffene unveränderte Datei einzeln 25/25 grün. Unveränderter vollständiger Wiederholungslauf: **6106/6106 Tests in 532 Dateien grün** (43,89 s). Ursache des einmaligen Fehlers nicht abschließend belegt, keine Auth-/Berechtigungsänderung oder Lockerung der Assertion. PR-CI bleibt weiterer Release-Gate.

Browserdaten: [browser-results.json](browser-results.json), [320px Arbeitsansicht](pick-320.png), [320px Abschluss](end-320.png), [360px](pick-360.png), [393px](pick-393.png).

## Release und Rückweg

Basis Main `60f11b7e` (PR36), Branch `codex/pick-assignment-recovery-20261012`. Vorher Web `01838-rr4`, Worker `00293-cqf`. Neue Endpunkte zuerst auf dem Backend ausliefern und Ready prüfen, danach Scanner-JS via regulärer Hosting-Pipeline. Bestehende Auth-/Infra-Konfiguration unverändert; keine ENV oder Indizes. Helpbundle 149 Artikel/0 Fehler.

Frontend kann mit diesem Backend auf die vorherige Oberfläche zurückgesetzt werden; alte Claims verstehen freigegebene Teilmengen. **Nach Nutzung des neuen Rundenabschlusses kein blindes Backend-Rollback auf PR36:** dort fehlt diese Wiederaufnahme. Bei einem Defekt gezielt vorwärts korrigieren oder ein Rückfallimage mit erhaltener Teilmengen-/Release-Kompatibilität verwenden. Keine `pickWork`- oder Bestandsdaten zurücksetzen.

Noch keine Aussage zur Veröffentlichung in diesem Vorabbericht. Revisions-, Pipeline- und Health-Belege werden nach Rollout im Projektgedächtnis und lokalen Releasebeleg ergänzt.

# Wiederaktivierung ausschließlich manuell — 27.09.2026

## Auftrag und verbindliche Regel

Bestandsrückkehr darf auf eBay und Kaufland kein inaktives, pausiertes, beendetes oder ausverkauftes Angebot automatisch aktivieren. Manuelles Listen bleibt nach Live-Status-, Duplikat- und tatsächlicher BIN-/Reservierungsprüfung möglich. Nullbestand beendet/pausiert weiterhin; keine Ausnahme für Ware ohne Lagerplatz.

## Bestätigte Ursachen und Änderungen

- eBay: Stock-Dispatcher und Ended-with-stock-Cron relisteten anhand `ops.ebay.zeroStockEnd`, einschließlich Länderangebote. Automatischen Relist-Code entfernt; kompatibler Cron-Einstieg ohne Wirkung, alter Repair-Helper mit ausdrücklicher Sperre. Marker bleiben Audit.
- Kaufland: `updateUnit()` setzte bei positiver Menge automatisch AVAILABLE. Jetzt Live-Status prüfen, inaktive/ausverkaufte Units überspringen, bei aktiven Units positive Menge ohne Aktivierungsstatus ändern. Preisupdates unverändert ohne Menge/Status. Manuelle Publish-Routen geben Aktivierungsabsicht ausdrücklich weiter.
- Kaufland POST /units kann vorhandene SKU wiederverwenden/ändern. Deshalb SKU vor Create lesen; manuelles Publish aktualisiert die vorhandene Unit, automatischer Pending-Publish-Retry darf sie nicht reaktivieren. SKU-Lookup nicht mit möglicherweise geänderter EAN verengen.
- eBay-Publish: alle relevanten Links, beide Produkt-Pointer und vollständig paginierte SKU-Mirror-Kandidaten berücksichtigen. Stales `active:false` ersetzt keine Live-Prüfung; unbekannte Antworten/Auth-/API-Fehler beweisen keine Beendigung. Bestätigten Status und Flag gemeinsam korrigieren.
- Oberfläche/API: Ende/Pause und explizites inaktiv gewinnen gegen stale Aktiv-Signale. Kaufland AVAILABLE mit Menge 0 gilt als inaktiv. Manuelle Auswahl nicht durch stale `ops.listingStatus` sperren; EAN aus `details.identifiers.ean` berücksichtigen. Manuelle Statusaktion speichert tatsächlich übertragene Menge sofort im Mirror.

## Abnahme vor Release

Tests zuerst: automatische Wiederaktivierungen und inkonsistente Status reproduziert (rot), anschließend korrigiert. Nach Integration von main `43a0df50` (Navigation, PR27): **5.671 Backendtests/491 Dateien, 537 Frontendtests, TypeScript und Produktionsbuild grün**. Auch Bestandsverlust während des Kaufland-Status-GET ist abgesichert: vor PATCH erneut BIN-/Reservierungsprüfung. Endgültige CI und Produktionsnachweise werden nach Rollout ergänzt.

Read-only Marktaufnahme ca. 21:29 MESZ: 2.059 aktive eBay-Angebote; Kaufland DE 557 AVAILABLE mit positiver Menge, 527 ONHOLD/0; andere sechs Storefronts leer. Bestandsabgleich 19:31 UTC: 0 Nullbestand, 0 Übermengen, 0 unbekannte SKUs; 762 aktive SKUs gegen echte BIN-Inhalte geprüft, 0 Abweichungen. Keine Angebote zu Testzwecken publiziert oder reaktiviert. Private Nachweise: `/Users/oguz/Dev/avycloud-local-backups/manual-reactivation-20260927/`.

## Release-Stand

Noch nicht ausgerollt; finalen Commit, PR, Web-/Worker-Revisionen und Health-Checks nach Ausführung ergänzen. Kein Rückrollen auf eine ältere Revision, die automatische Wiederaktivierung wieder einschalten würde.

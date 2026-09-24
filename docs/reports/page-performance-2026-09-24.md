# Seiten-Ladezeit — 24.09.2026

Auftrag: eBay, Kaufland, Produktdaten und Finanzen/Dashboard beschleunigen und produktiv ausrollen. Isolierter Branch `codex/page-performance-20260924`, Basis `616f4798`; bestehende lokale Arbeiten im Hauptordner nicht übernommen.

## Befunde

Cloud-Run-Stichprobe (1.200 letzte GET-Logs ab 24.09. 00:00 UTC, vor Änderung): Produkte 383 Requests, Mittel 8,94 s/P95 15,05 s; Kaufland 29 Requests, Mittel 9,56 s; Finanzen 6 Requests, Mittel 29,46 s; eBay 2 Requests, 23,23 und 49,51 s. Kein repräsentativer Lasttest; Netzwerk und externe Quellen beeinflussen Messungen.

Der globale Ladezustand blendete Seiten nach deren erstem Mount bis zum Produktabruf aus. Marktplatzseiten starteten beide Markt-Queries und eine weitere vollständige Produktabfrage. eBay-Joins über rund 9.905 Listings liefen in seriellen 500er-Batches und übertrugen vollständige Produktdokumente. Finanzen lud große, fachlich unbenutzte Felder und startete weitere unabhängige Quellen erst danach.

## Änderung und Grenzen

- Datenunabhängige Seiten bleiben beim Produktabruf eingeblendet. Dashboard-Abschnitte erscheinen einzeln. Ausstehende Lagerwerte zeigen `—`.
- Nur der geöffnete Marktplatz ist aktiv. Produkt-Fallback aus dem gemeinsamen App-Bestand; bestehende explizite Publish-Dialog-Aktualisierung bleibt.
- Explizite Projektionen für Tabellen, Marketplace-Joins und Finanzbericht. Keine Kürzung der Produkt-/Listinganzahl, kein neuer Cache mit veralteten Beständen. Bestandswriter, OMS, Auth und Infrastruktur unverändert.
- eBay-Join-Batches mit begrenzter Parallelität. Legacy-Fallback nur bei fehlendem V2-BIN-Feld; leere V2-BIN-Arrays bleiben autoritativ (Zone-X-Umzug).
- Finanzberechnung unverändert; unabhängige Quellen parallel, bestehende Fehlerkennzeichnung erhalten.

Read-only Messung am vollständigen Produktbestand (2.385 Dokumente): volle Docs 50.817.241 Bytes; Tabelle 23.998.213 (−52,8 %), Kaufland-Produkte 6.910.106 (−86,4 %), Finanz-Produkte 807.377 (−98,4 %). Dies sind unkomprimierte Datenmengen aus Firestore, keine Browser-Transferwerte. Lokale Abfragezeiten 26,1 / 12,3 / 3,7 / 0,8 s, keine Cloud-Run-SLA.

## Validierung vor Rollout

- Ausgangsbasis: 5.484 Backendtests/464 Dateien, 494 Frontendtests, Typecheck/Build grün.
- Danach: 5.496 Backendtests/468 Dateien, 497 Frontendtests, Typecheck/Produktionsbuild grün.
- Neue Regressionen für begrenzte Batch-Parallelität, Vollständigkeit/Fehlerverhalten, projizierte tenantbezogene Reads, API-Pagination, eBay-/Kaufland-Zeilen, Finanzresultate und parallele Quellen, unabhängiges Seiten-/Abschnittsladen.
- Read-only Paritätsprüfung über alle 2.385 produktiven Produktdokumente: **29 Filterdefinitionen / 1.555 Vergleichsfälle einschließlich dynamischer Optionen und Mengen-/Kategorie-Helfer identisch**. Gegenüberstellung aus demselben Snapshot; keine Daten geschrieben.
- Alt-Clients nutzen weiter `view=list`; neuer Client mit altem Backend erhält im Rollout-Fenster den bestehenden vollständigen Response. Keine inkompatible Umstellung.

Rollout-Nachweis und tatsächliche Produktionszeiten werden nach Veröffentlichung im lokalen Projektgedächtnis ergänzt.

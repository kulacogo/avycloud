# KI-Kosten und Erfassungsqualität — 19.10.2026

## Auftrag und Abgrenzung

Betreiber autorisiert Entwicklung, Tests und Produktionsauslieferung. Ziel: mindestens 30 % weniger Gesamtkosten, ohne Qualitätsverlust oder längere Wartezeiten. Keine lokale Vorführung gewünscht. Ausgangsbranch `codex/ai-cost-quality-20261019`, Basis `d86619b95190a90f9850b16cfd14824df1840c08`. Fremde, uncommittete Arbeiten im ursprünglichen Checkout bleiben unangetastet.

## Änderungen

- Chat: aus Text/Schnellaktion abgeleiteter Arbeitsumfang gilt vor Modellarbeit, bei Toolausführung, in allen Fallbacks, bei Nachprüfungen und bei Ausgabe. „Nur Titel“ löst keine Preis-/GPSR-/Bildnachbearbeitung aus. Nach brauchbarer V3-Titelkarte entfällt die zusätzliche Antwort-Modellrunde. Die API liefert ausschließlich Titeltext und passende Karte; bewusst umfassende Aufträge bleiben möglich.
- Gemeinsames Budget über Retries/Fallbacks: fokussiert 8 Modell-/16 Toolstarts und 180 Sekunden; vollständig 16/40/300 Sekunden. Diese Grenzen verhindern neue Starts; sie brechen bereits laufende Provideranfragen nicht ab. Providerinterne Grounding-Unterabfragen werden erst nachträglich gezählt. Keine zugesicherte Euroobergrenze.
- Erfassung: eine partielle Korrekturrunde übernimmt nur ihre gelieferten Abschnitte in den bisherigen besten Entwurf. Bereits recherchierte Beschreibung, Merkmale und Quellen verschwinden nicht mehr, wenn das Modell nur einen neuen Titel sendet. Explizit gelieferte Abschnitte werden weiterhin vollständig ersetzt; keine Vermischung verschiedener GPSR-Hersteller.
- Produktlisten: Auftragsmengen und Lagerplatz-Zusammenfassungen nutzen tenantgebundene, aktive Firestore-Snapshots. Änderungen/Löschungen kommen als Deltas; konkurrierende Requests teilen den Start. Fehler, Prozesspausen, Inaktivität und Kapazitätsgrenzen schließen Listener. Bei Fehler frischer Read. Keine Änderung an Stock-/OMS-Schreibpfaden, Detailreads, Auth oder Infrastrukturkonfiguration.

## Bewusst ausgeschlossener Versuch

Volle Produktlistener sind NICHT enthalten: lesender Test mit 3.071 Produkten/62,5 MB brachte 56,5 Sekunden beim ersten Lesen und 54,4 Sekunden beim Wiederholen nach Ablauf. Das wäre ein Rückschritt. Die bisherige Produktprojektion bleibt bestehen. Aufträge (2.060/3,8 MB) und Lagerplätze (323/0,6 MB) lieferten dagegen nach 1.603 bzw. 490 ms initial einen identischen Snapshot in unter 1 ms beim Wiederholen. Das sind isolierte SDK-Messungen, keine Endnutzer-Seitenladezeiten. Browser erhält weiterhin die bestehende API-Antwort; kein behauptetes Browser-Deltaprotokoll.

## Abnahme

Baseline: 6.106 Backendtests und Frontendbuild grün. Neue Regressionen zuerst rot: Feldbegrenzung/Fallbackbudget, partielle Erfassungsreparatur, zusätzliche Titel-Modellrunde und auftragsfremder Antworttext. Tests prüfen außerdem Tenanttrennung, Löschungsweitergabe, Listenerfehler, Prozesspause, Inaktivität, Begrenzung und unveränderte Release-Konfiguration. Final: 6.162 Backendtests/537 Dateien, 610 Frontendtests (2 bestehende Skips), TypeScript und Build grün. Echter Gemini-Smoke: 23.134 ms, zwei Modellstarts, Katalogsuche plus Titelkarte, null native Grounding-Abfragen, ausschließlich Titelvorschlag. Dies ist ein Einzeltest, kein belastbarer Mittelwert oder Vorher/Nachher-Vergleich. Finale Nachweise und Produktionsreceipts liegen unter `/Users/oguz/Dev/avycloud-local-backups/ai-cost-quality-20261019/`.

Keine produktiven Produkte, Aufträge, Bestände oder Listings werden zum Test verändert. Modell-Smoke verwendet einen synthetischen Kopfhörer-Datensatz und erzeugt lediglich einen Vorschlag.

## Versions- und Rollbackvertrag

Chat-Policy `chat-request-2026-10-11-v1` stammt aus dem bislang unveröffentlichten UX-36-Paket; nur relevante Teile übernommen. Neue unveränderliche `chat.product`-Version kopiert die aktuelle Elternversion vollständig und ergänzt Quellhashes/Release-SHA. Registrierung und Aktivierung vergleichen bestehende Konfiguration und aktiven Vorgänger; bei Drift Abbruch. Kein Modell-/Temperaturwechsel. Erfassungsfix ist Caller-Code ohne Promptänderung.

Vorherige Produktionsrevisionen: Web `product-hub-backend-01840-tjm`, Worker `product-hub-worker-00295-sx4`. Vor jeder Umschaltung erneut prüfen. Rückweg: Traffic auf diese Revisionen, Hosting auf gesicherte Vorgängerversion und Chat-Scope per Vergleich zurück auf Elternversion. Nur Scope-Rollback allein entfernt die kompilierte Policy NICHT. Anzeige-Cache separat über `DISPLAY_SNAPSHOT_CACHE=off` abschaltbar.

## Noch nicht nachgewiesen

Kostenbasis GCP-Projekt avycloud, 01.–18.10.2026: 862,86 EUR, davon Grounding 321,33 EUR und Firestore-Reads 134,24 EUR. 30 % entsprechen 258,86 EUR für denselben Zeitraum/vergleichbare Nutzung. KEINE 30-%-Erfolgsaussage aus Unit-Tests ableiten. Nach Release Tageskosten und Kosten je vergleichbarem Vorgang samt Wartezeiten und Nachbearbeitungsrate vergleichen; Abrechnungsverzug berücksichtigen.

Lesende Stichprobe von 308 seit 12.10. angelegten Produkten mit Erfassungsdiagnostik enthält weiterhin Titel-/Hersteller- und Vollständigkeitsprobleme. Der reparierte Entwurfsverlust ist belegt, aber nicht die alleinige Ursache aller Qualitätsprobleme. Garantiert vollständige Datenblätter, vollständiger Produkt-Delta-Cache und tatsächlich erreichte 30 % bleiben offene Abnahmen.

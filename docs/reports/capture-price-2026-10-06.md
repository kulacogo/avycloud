---
title: Initialer Verkaufspreis — Audit und Korrektur 06.10.2026
lastReviewed: 2026-10-06
---

# Befund und Auftrag

Betreiber verlangt vollständige Datenblätter einschließlich Preis ohne Chat-Nachlauf sowie Produktionsauslieferung nach Tests. Diese Freigabe gilt einschließlich Commit/PR/Merge; keine erneute Freigabefrage.

Seit PR25 (Web bereit 27.09.2026 18:45:12 UTC) bis Audit 06.10.2026 08:49:19 UTC: 179 neue Datenblätter im Tenant default, davon 40 mit initialem **Marktpreis**, 139 ohne. 96 der 139 haben heute einen nachträglich ergänzten Marktpreis. Native Firestore-Erstellzeiten und ursprüngliche Qualitätssnapshots bestätigen die Kohorte.

**Korrektur:** 40/179 meint `lowest_price`/`snapshot.price_ok`, nicht `sellPrice`. V3 setzte den Verkaufspreis bislang überhaupt nicht; Chat bzw. dessen Übernahme taten das. Der alte Snapshot erfasst den initialen Verkaufspreis nicht, daher keine exakte historische Verkaufspreisquote daraus ableiten. Der aktive Capture-Wizard hatte zudem kein Preisfeld; StepPricing war nicht eingebunden.

Weitere Ursachen: `site:.de` schloss deutsche IKEA/H&M-Shops auf .com aus, kurze Such-/Seitenbudgets, HTTP 403/429, unerkannte ProductGroup-Varianten und Preisspezifikationen. Proben zeigten gefährliche Fehlzuordnungen: BLK008-Decke versus 998-Euro-Anzug, 4 Rollen versus 8-Rollen-Bundle. Solche Treffer werden ausgeschlossen.

# Korrektur

Neue V3-Produkte erhalten recherchierten Marktpreis plus editierbaren `sellPrice`/`suggestedPrice` vor der ersten Speicherung. Review und Summary zeigen den Verkaufspreis, manuelle Ergänzung geht ohne Chat. Ungültige bzw. geleerte vorhandene Preise werden nicht still übergangen.

Getrennte Kennungs-/Modellsuche, deutsche .com-Angebote, strukturierte Product/Offer-Varianten, Herstellerbindung für MPN, Packungsgröße, EUR, deutsche Shopregion, Neuware/Festpreis und Verfügbarkeit. Gemini entdeckt URLs; der konkrete Preis muss dem passenden Angebot entnommen werden. Suchindex-Angebote bei Infrastrukturfehlern bleiben ausdrücklich `verified:false`, `evidence_type:search_index`, Confidence0,65. 404/410 und widersprechende erreichbare Seiten bleiben ausgeschlossen.

Nach erfolgloser früher Suche höchstens ein weiterer Versuch mit fertigem Datenblatt: max.45 Sekunden innerhalb von 300 Sekunden V3-Budget. Geänderte Packungsgröße verwirft einen frühen Preis. Diagnose additiv: `initial_sell_price` und Rechercheversion3 mit Such-/Seitenzahlen, HTTP-Fehlern, Quelle und Laufzeit. Keine nachträglichen Capture-Preiswrites.

Der Speicherfehlertest deckte außerdem einen vorhandenen Scope-Fehler von `metricErrorMessage` auf. Die Korrektur stellt sicher, dass HTTP500 tatsächlich zurückgegeben wird.

# Abnahme und Grenzen

Basis `origin/main`43f30bb6 mit BIN-Bestandsabsicherung und ausschließlich manueller Wiederaktivierung. Keine Prompt-/Schema-/Modell-/GenerationConfig-Änderung: Caller-Bugfix braucht nach LLM-Charta §3 keine neue Scope-Version. Inhaltsvertrag bleibt2.

Lokal: 5.715 Backendtests/495 Dateien, 547 Frontendtests, TypeScript und Produktionsbuild grün. Danach zusätzlicher echter Browse-Adaptertest plus relevante Evidenztests grün (61 Tests). Vier Browsertests mit echten Review-/Summary-Komponenten, lokal ersetzter letzter Speicher-API, prüfen Übernahme, Ergänzung, Fehlereingaben und Mobile. Routentest prüft Save + Readback und Speicherfehler mit lokalem Speicherdoppelgänger. Finaler Stand wird im PR-CI nochmals geprüft.

Vier lesende Stage-1→4-Proben mit Originalfotos und echten Recherche-APIs:

| Produkt | Ergebnis | Beleg / Dauer |
|---|---|---|
| IKEA SÄFFEROT 805.657.16 | Markt-/Verkaufspreis 19,99 € | IKEA-DE Produktangebot; 38,6s |
| H&M HOME 1310016001 | weiterhin ohne Preis | keine passende belastbare EUR-Quelle; 68,5s |
| Global Truss Truss Twister120796 | Markt-/Verkaufspreis 183,90 € | strukturierter Suchindex, Händlerzugriff blockiert; 56,5s |
| KRINNER Ultra Grip+ XXL94455 | Markt-/Verkaufspreis 114,99 € | OBI-DE, identische GTIN4011972944557; zweiter Versuch; 67,1s |

Die erste IKEA/H&M-Probe hatte lokal keine nutzbare Vision-Quota-Zuordnung; Bild-Gemini und übergebene Barcodes liefen. Die folgenden zwei verwendeten GOOGLE_CLOUD_QUOTA_PROJECT=avycloud. Keine Probe speicherte ein Produkt in Produktion. Kein schreibender Produktions-End-to-End-Test und keine repräsentative Erfolgsquote. Frühere breite Proben an 24 heutigen Produktständen zeigten weiterhin große Lücken und falsche Treffer; sie begründeten die zusätzlichen Identitäts-/Packungsregeln und sind kein Erfolgsnachweis oder historisch exakter Replay.

Offen: H&M und weitere Händler-/Identitätslücken; bestehender Scope identify.v2-agentic fehlt (Rückfall auf Code-Defaults); eBay Catalog liefert in Proben403. Tokens/Berechtigungen unverändert. Preisvorschlag ist Marktvergleich ohne automatische Zustands-/Margenanpassung. Keine Garantie für Vollständigkeit, Profitabilität oder100-%-Abdeckung.

Rohdaten privat: /Users/oguz/Dev/avycloud-local-backups/capture-quality/20261006/. Firestore-Schreibmethoden und Storage-Import vor App-Imports gesperrt; keine Testprodukte oder Bestands-/OMS-/Listingmutation. Produktive Erfassungsroute niemals mit vorhandener EAN als Smoke-Test aufrufen: Duplicate-Reuse verändert Wareneingangsmengen. Produktionsrevisionen und erste natürliche Erfassungen im Projektgedächtnis nachführen. Dieser Bericht beschreibt zunächst den geprüften Stand vor Auslieferung.

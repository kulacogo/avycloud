# Kartonbasierte Bildrecherche — Release 20.09.2026

Anforderung: Möbel nicht aufbauen müssen. KI-Galerie soll aus Karton-/Etikettendaten das exakte Modell und die Variante recherchieren und bestätigte Webbilder als Vorlage verwenden. Fortsetzung des ausdrücklich autorisierten Bildfeatures mit Produktionsauslieferung.

Isolierter Arbeitsbaum: `/Users/oguz/Dev/avycloud-packaging-research`, Branch `codex/packaging-image-research-20260920`, Basis `1767f453` (PR16). Fremde Änderungen im Hauptprojekt bleiben unberührt.

## Inhalt

Automatischer Verpackungszweig vor der Galerieplanung: Identifikation mit Konflikterkennung → drei Suchanfragen über zwei Suchindizes → maximal acht Produktseiten → maximal acht Bildprüfungen → höchstens vier bestätigte Modellreferenzen. Exakte GTIN/Modellkennung plus bekannte Varianten und Lieferumfang sind Pflicht. Belegzitate gegen wirklich gelesene Seiten; Zahlenabweichungen zusätzlich deterministisch gesperrt. Keine Generierung aus einem Karton/ungeprüften Webbild nach fehlgeschlagener Recherche. Auch nach erfolgreicher Recherche werden ausschließlich tatsächlich belegte Fotoansichten als Studiofoto aufbereitet; keine frei erfundenen Perspektiven oder Anwendungsszenen in diesem Zweig.

Produktgalerien werden aus strukturierten Product-Daten und zugeordneten Galerieelementen gelesen; Downloads mit öffentlichem DNS auch am tatsächlichen Socket, Redirect-Prüfung, Größen-/Zeitlimit. Bekannte eigene Produktfotos starten keine Recherche. Gezieltes `Studio-Foto` bleibt die Bearbeitung des ausgewählten Fotos; der Galerie-/Variantenknopf nutzt die Recherche automatisch.

Quellenstatus im bestehenden Ergebnisbericht, aufklappbare Quellen und additive Herkunft an generierten Bildern; Modellbild ist kein Foto des tatsächlichen Artikelzustands. `PACKAGING_IMAGE_RESEARCH=off` ist der gezielte Rückweg. Keine neue Route, Dependency, Auth-/Lager-/OMS-/Infrastrukturänderung, keine Migration und keine automatische Änderung bestehender Produktbilder.

## Abnahme

- Backend-Baseline:5.322 Tests/456 Dateien unter Node20 grün.
- Finaler Stand: 5.350 Backendtests/458 Dateien unter Node20 vollständig grün, einschließlich Maximalmenge und Beschränkung auf belegte Ansichten.
- Frontend:489 Tests, TypeScript und Produktionsbuild grün.
- Negative Regressionen: falsche Variante/Modell/GTIN, andere Maße trotz positivem Modellurteil, erfundene Zitate, nicht mitgelieferte Teile, fehlende Identität, Providerfehler, Zeitlimit, private Redirects, Credentials/Ports, HTML statt Bild; kein bezahlter Render nach Recherchefehler. Originalpfad weiter getestet.
- Realer End-to-End-Test mit Westmann Castra B SKU-6027324616, ausschließlich zwei Original-Kartonfotos: EAN4262519771956/WMHFR-25B16/Anthrazit/95×50×160cm erkannt; vier Webseiten gelesen, eine passende Händlerreferenz bestätigt. Finaler Lauf: eine belegte Studioansicht in 71,2 s, 0,134 USD geschätzte Bildausgabekosten (Recherche/Vision zusätzlich), visuell geprüft. Ein vorheriger Versuch mit freien Perspektiven hatte zusätzliche Füße erfunden. Deshalb beschränkt der finale Recherchepfad die Ausgabe auf gefundene Fotoansichten; die Wiederholung bestätigt diese Sperre auch bei aktivierter Szenenoption.
- WERKHAUS und Vertbaudet: keine bestätigten Bilder im begrenzten Suchlauf, korrekt keine Ersatzartikel erzeugt. WERKHAUS-Herstellerseite separat gelesen: abweichende Höhe und nicht enthaltene WERKBOX-Module. Suchabdeckung, blockierte Seiten, nur PDF-Kataloge und fehlende Belege bleiben Grenzen; keine universelle Erfolgs-/Produkttreuegarantie.
- Modell-/Suchdienste real; Datenbasis lokaler GCP-Snapshot vom18.09. Telemetrie/Speicherung im Test ersetzt, ausschließlich private lokale Bilder/Berichte. Keine Produktionsprodukte, Bestände oder Angebote verändert.

Private Belege: `~/Library/Application Support/AvyCloud Local/photo-quality/packaging-westmann-gallery-report.json`, `westmann-packaging-research-report.json`, finales Bild `packaging-westmann-final-studio_front.png` (alte weitere Varianten gehören zum verworfenen Versuch). Nicht Teil des Commits. Prüfprotokolle im isolierten Arbeitsbaum unter `.local-quality/`.

## Produktionsstand / Rückweg

Vor Rollout erneut gelesen: Main1767f453, Web`product-hub-backend-01810-2b7`, Worker`product-hub-worker-00265-g8d`, Ready/100%. Vorheriges Hosting aus PR16:`0e73ad3fbea50374`. Endgültige PR-/Commit-/Build-/Revisionsergebnisse nach erfolgreicher Auslieferung hier bzw. im Hauptprojektgedächtnis ergänzen. Beide Cloud-Run-Dienste und Hosting separat abnehmen; nur Web-Rollback genügt nicht.

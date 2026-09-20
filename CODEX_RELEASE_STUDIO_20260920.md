# Studio-Fotografie — 20.09.2026

## Auftrag und Umfang

Betreiber verlangt die tatsächliche Umsetzung und Produktionsauslieferung ohne weitere Vergleichsseite/Freigaberunde. Die frühere Beschränkung „KI nur lokal“ ist damit aufgehoben. Basis ist Main150c7cca (PR15), isolierter Branch `codex/studio-photography-release-20260920`. Fremde Arbeitsstände bleiben unangetastet.

Studio-Foto und reguläre Galerie verwenden echte fotografische Ausleuchtung anstelle flacher Originalpixel-Composites. Fertige Studiofotos werden nicht erneut maskiert; Schatten, Licht und Form bleiben erhalten. Dieselbe verpflichtende Qualitätsprüfung umfasst nun auch Licht, Bodenkontakt und Komposition. Produktfarbe, Beschriftung, Material, Zustand und belegte Bauteile bleiben zwingend. Abgenommene Teile/Detailausschnitte sind keine Gesamtansichten. WEB-Referenzen sind erlaubt, transparente Bilder werden auf Weiß vorbereitet; fehlgeschlagene Downloads werden verständlich gemeldet. Bestehende Originalpixel-Batchfunktion bleibt erhalten.

Mit ausgeliefert werden die bislang lokal zurückgehaltenen KI-Korrekturen: dunkle Materialfarbe, Kostenreservierung vor parallelen Aufrufen, streng bestätigte Produkttreue, Grounding des Originalpixel-Verfahrens und ausdrückliche Hinweise zur Bildprüfung. Keine Änderung an Auth, Routen, Bestand, OMS, Produkt-Schreibpfaden oder Infrastruktur. Keine Datenmigration.

## Nachweise vor Freigabe

- 5.322 Backendtests in456Dateien, 488 Frontendtests, TypeScript und Produktionsbuild grün; Node20 Backend wie CI.
- Regressionen für Schatten-/Bildranderhalt ohne zweite Maske, fotografischen Standard, verpflichtende Gestaltungsprüfung, unabhängige Farbabweisung, unveränderten Nur-Pixeltreu-Vertrag sowie Bestandteil-/Detailreferenzen.
- Echter isolierter Gemini-Lauf FEIDASH SKU-9490497658: bessere Studiofront/Seite, Licht und Bodenkontakt sichtbar. Nicht bestätigte Details verworfen. Erster Entwicklungsdurchlauf lieferte2Studio+1Szene bei0,872USD geschätzten Bildkosten. Nach Sichtprüfung wurde die Klassifikation des Deckelausschnitts weiter korrigiert; abschließender Lauf wird separat protokolliert.
- Echter SAKK-Studioaufruf mit finalem Fotografieverfahren: ein akzeptiertes2K-Bild, schwarzes Material und Schriftzug erhalten, weicher sichtbarer Schatten,0,134USD geschätzte Bildkosten,29s. Dateien ausschließlich privat lokal; keine Produktivprodukte verändert.
- Modellprüfung ist keine Garantie perfekter Detailtreue. Unbelegte Ergebnisse werden ausgelassen; Sichtkontrolle vor Veröffentlichung bleibt nötig. Kostenschätzungen enthalten nicht sämtliche Eingabe-/Visiontokens.

## Rückweg

Eng begrenzter Funktionsrückweg: `STUDIO_PHOTOGRAPHIC=off` stellt die bisherige Composite-Reihenfolge wieder her; neue strenge Identitätsprüfung bleibt. Vollständiger Revisionsrückweg vor diesem Release: Web `product-hub-backend-01809-7gj`, Worker `product-hub-worker-00264-dfn`, beide vorab Ready/100% geprüft. Frontendversion vor Deploy separat sichern. Keine Produktdaten zurücksetzen, keine Bestands-/Sync-Schalter ändern.

## Produktionsstatus

Auslieferung und abschließende Runtime-Abnahme werden nach Merge nachgetragen. Diese vorbereitete Datei allein behauptet kein abgeschlossenes Deployment.

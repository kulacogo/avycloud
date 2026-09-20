# Hotfix: vorhandenes Webfoto statt blockierender erneuter Recherche

Betreiberauftrag: Nimara-Beispiel aus Screenshot sofort reparieren und ausliefern. Isolierter Worktree `/Users/oguz/Dev/avycloud-web-reference-fix`, Branch `codex/existing-web-image-fix-20260920`, Basis Main `f491b2e3`. Vorhandene Codeänderungen im Hauptcheckout bleiben unberührt; Projektgedächtnis wird nach Auslieferung ergänzt.

## Ursache und Korrektur

SKU-5590256737 / Produkt94878812-fbb4-4336-8e85-7bfb33c1731d / Nimara Carlo76601. Produktionslogs belegen sechs abgebrochene Galerieläufe ohne Bildaufruf. Echte Modellanalyse der zwei Originalfotos und des manuell hinterlegten nimarahome.de-Fotos: Webbild vollständig/verwendbar/Front/0,98, gleicherArtikel=true. Der Verpackungs-Trigger ignorierte dieses Bild und machte Generierung von einer weiteren Websuche abhängig.

Zehn Zeilen Servicekorrektur: verwendbares vollständiges Webbild des laut Bildanalyse gleichen Artikels verhindert unnötige Recherche. Vorhandene Fotos gehen wieder an die reguläre Galerie. Karton/Folie/alte KI-Ergebnisse weiterhin keine Vorlage; Ergebnisprüfung unverändert. Nicht behaupten, dass damit jede beliebige Produktgalerie garantiert Bilder liefert oder freie neue Perspektiven fehlerfrei sind.

## Prüfung

Baseline: 5.350 Backendtests / 458 Dateien grün. Vier Regressionen reproduzierten den alten Fehler (rot), anschließend 84 gezielte Tests grün. Final: 5.354 Backendtests / 458 Dateien grün, Produktionsbuild erfolgreich, `git diff --check` sauber. Echter Nimara-Galerielauf: vier Studioansichten und eine Anwendungsszene in 89,8 Sekunden; sechs Bildmodellaufrufe, 0,771 USD geschätzte Bildausgabekosten (Analyse/Prüfung zusätzlich). Alle fünf Ausgaben visuell geprüft: weißer Bouclé, schwarze Beine, Studiohintergrund mit Bodenschatten. Front und Hero sind ähnlich; keine Garantie unterschiedlicher oder fehlerfreier abgeleiteter Perspektiven. Zweite Szene fiel unter die Kostenbegrenzung, fehlendes Detailfoto wurde nicht ersetzt. Externe Modellaufrufe real, Bilder nur in privater lokaler Ablage; Produktdaten aus lesendem Live-Snapshot. Keine UI-Bearbeitungsaktion und keine produktive Produktspeicherung zum Test.

## Rückweg

Vorheriger Mainf491b2e3, Web01811-4d5, Worker00266-8tm, Hosting4fecc00e39175281. Vor Rollout aktuelle Revisionen erneut prüfen. Keine ENV-Änderung nötig.

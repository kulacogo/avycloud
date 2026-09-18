---
title: Produktbilder — Studio und Varianten
for: [agent, dev, admin]
lastReviewed: 2026-09-18
---

# Produktbilder: Studio und Varianten

Betreiberanforderung vom 18.09.2026: professionelle Belichtung, Weißabgleich, informationshaltige Schatten und plausible Reflexionen verbessern; tatsächlichen Artikel einschließlich Schäden, Vergilbung, Verpackung, Material, Farbe, Text und Zubehör erhalten. Fehlende Bildinformation niemals als erfundene Details ersetzen.

## Umsetzung

- Gemeinsame fotografische Regeln: `backend/lib/product-photo-policy.js`. Belichtung und Weißabgleich dürfen verbessert werden, die wahrgenommene Produktfarbe und alle tatsächlichen Merkmale bleiben erhalten.
- Studio und vorhandene Galerieansichten verwenden primär Originalpixel mit einer erzeugten Silhouette. Die pauschale Gamma-Aufhellung ist in diesen Aufrufern ausgeschaltet; sie hatte schwarzen Stoff grau/blau erscheinen lassen. Generativ bereits beleuchtete Bilder erhalten ebenfalls keine zweite Gamma-Kurve.
- Eine tatsächlich fotografierte Ansicht verwendet genau ihr eigenes Quellfoto. Weitere Referenzen dürfen keine Haken, Etiketten oder Gurte aus anderen Ansichten hineinmischen. Abgeleitete Perspektiven und Szenen verwenden weiterhin geeignete Referenzen und bleiben als generiert gekennzeichnet.
- Die Kompaktheitswache des Freistellers bleibt für bisherige Aufrufer unverändert. Nur wenn ausschließlich diese Wache anschlägt (z. B. U-förmiger Kamerasattel) UND eine verpflichtende Prüfung des fertigen Bildes erfolgreich ist, wird die Form akzeptiert. Alle übrigen Geometriewachen bleiben bestehen.
- `backend/lib/image-result-check.js` prüft das fertige Bild einschließlich Farbe, Zustand, Material, Text, Teile und Studiohintergrund. In den Studio-/Galeriepfaden wird nur ein vollständiges positives Urteil akzeptiert. Fehlende/unsichere Prüfung und erkannte Abweichungen führen zum Verwerfen, bevor ein Bild hochgeladen wird.
- Zusätzlich misst ein enger deterministischer Schutz die Helligkeitsverteilung dunkler Studioartikel. Eine deutliche Aufhellung sowohl des dunklen Quartils als auch des Medians gegenüber allen Referenzen wird abgelehnt. Das ist keine universelle Farbprüfung: helle/mehrfarbige Referenzen und Anwendungsszenen sind ausdrücklich nicht abgedeckt. Die Modellprüfung und die Sichtkontrolle bleiben notwendig.
- Eine gescheiterte Freistellung gibt niemals das rohe Renderbild als Erfolg zurück. Studio liefert bei vollständig fehlgeschlagener Prüfung `STUDIO_QUALITY_REJECTED`; Galerie meldet ausgelassene Varianten im bestehenden Ergebnisbericht. Originale bleiben unverändert. Die Zielzahl darf nicht durch fehlerhafte Bilder aufgefüllt werden.
- Varianten priorisieren standardmäßig das Qualitätsmodell aus `lib/gemini-image-models.js`, mit dem schnellen Modell als geprüftem Rückfall. Explizite ENV-Pins bleiben erhalten. Masken nutzen weiterhin die günstigere bestehende Kette.
- Studio und Galerie reservieren die geschätzten Kosten VOR jedem Bildaufruf, einschließlich Timeouts und paralleler Versuche. Der bestehende Deckel bleibt erhalten; Vision- und Eingabetokens sind darin nicht vollständig enthalten.
- Studio-Ausgabe wird nach Bearbeitung ohne Beschnitt auf eine weiße quadratische Leinwand mit mindestens 1600 px gesetzt. Hochskalieren erzeugt keine zusätzlichen echten Details. Keine neue Route oder Datenmigration.

## Betrieb und Grenzen

Bestehende Schalter: `STUDIO_COMPOSITE`, `GALLERY_UNIFORM_CANVAS`, `GENERATED_IMAGE_IDENTITY_CHECK` (jeweils nur `off` deaktiviert), `IMAGE_COST_CAP_USD` (Default 0.9, `0` unbegrenzt), `GENERATED_IMAGE_IDENTITY_MIN_CONFIDENCE` (Default 0.6). Kein Produktionsschalter wurde geändert. Wird die Identitätsprüfung deaktiviert, liefern die strikten Studio-/Galeriepfade keine ungeprüften Bilder aus.

Ein positives Modellurteil ist kein Beweis perfekter Produkttreue. Beim SAKK-Vergleich akzeptierte der Prüfer sichtbar fehlerhafte Bilder trotz verschärftem Prompt; deshalb wurden die konkreten Ursachen im Freisteller und in der Tonwertkurve behoben und ein zusätzlicher messbarer Farbschutz ergänzt. Neu abgeleitete Ansichten und Anwendungsszenen benötigen weiterhin eine Sichtkontrolle vor Übernahme ins Angebot.

## Technischer Realbildtest — 18.09.2026

Mit einer isolierten Kopie echter Daten und dem bestehenden Gemini-Dienst verifiziert: Studio HTTP 200 mit Originalpixel-Composite, Varianten HTTP 200 mit vier Bildern; fehlende Makroaufnahme explizit ausgelassen. Ergebnisdateien waren nach Neustart abrufbar. Das belegt den technischen Ablauf, keine umfassende Qualitätsabnahme aller Produktkategorien. Es wurden keine Produktionsprodukte verändert.

## SAKK-Regression — 18.09.2026

Auslöser: Originalhintergrund blieb sichtbar; schwarzes Textil wurde grau/blau; Referenzansichten wurden vermischt. Das Produkt wird in einem isolierten lokalen Test mit seinen drei Originalfotos geprüft; Ergebnisse werden ausschließlich privat lokal gespeichert.

Messbare Negativkontrollen: Die beanstandete graue und blaue Variante sowie eine zu helle neue Draufsicht werden vom deterministischen Dunkelfarbenschutz abgelehnt. Die korrigierten Front-, Rück- und Heroansichten passieren. Gemessene Materialmediane im Kontrollpaar: Original 34–35, fehlerhafte Bilder 53–63, korrigierte Bilder 33–36 (RGB-Mittelwert nach Ausschluss heller Hintergrundpixel; keine Aussage über allgemeine Farbmetrik).

Ein höheres Thinking-Budget der Vision-Prüfung verbesserte diese Negativkontrollen nicht und wurde deshalb nicht übernommen. Das Qualitätsmodell lieferte im Vergleichslauf drei Studioansichten und eine Szene; zwei fehlerhafte Ausgaben wurden abgelehnt. Vollständige Abnahme aller Produktkategorien ist daraus nicht ableitbar.


Abschließender Wiederholungslauf: Studio-Einzelfunktion erzeugt ein Originalpixel-Composite; Galerie liefert sechs Bilder für geschätzte 0,807 USD Bildkosten. Die Originalansichten sind visuell korrigiert. Frei erzeugte Szenen zeigen weiterhin teilweise warme Farbe/abweichende Details trotz positivem Modellurteil. Daher **keine fachliche Freigabe des gesamten Bildfeatures**, kein Main-Merge. Der Betreiber wurde nach gewünschtem Umgang mit unbelegten Perspektiven/Szenen gefragt. Lokale Backendprüfung: 5.221 Tests in 445 Dateien bestanden. Produktbilder wurden nicht gespeichert oder ersetzt.

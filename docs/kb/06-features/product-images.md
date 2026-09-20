---
title: Produktbilder — Studio und Varianten
for: [agent, dev, admin]
lastReviewed: 2026-09-20
---

# Produktbilder: Studio und Varianten

Betreiberanforderung vom 18.09.2026: professionelle Belichtung, Weißabgleich, informationshaltige Schatten und plausible Reflexionen verbessern; tatsächlichen Artikel einschließlich Schäden, Vergilbung, Verpackung, Material, Farbe, Text und Zubehör erhalten. Fehlende Bildinformation niemals als erfundene Details ersetzen.

## Umsetzung

- Gemeinsame fotografische Regeln: `backend/lib/product-photo-policy.js`. Belichtung und Weißabgleich dürfen verbessert werden, die wahrgenommene Produktfarbe und alle tatsächlichen Merkmale bleiben erhalten.
- Interaktives Studio und reguläre Galerieansichten werden fotografisch neu beleuchtet (`studio-photography.js`): gerichtetes weiches Hauptlicht, kontrolliertes Fülllicht, materialabhängige Reflexionen, sichtbarer weicher Bodenschatten, passende Größe und Ausrichtung. Das fertige Foto wird **nicht erneut freigestellt**; quadratisches Padding erhält Schatten und Produkt vollständig. Detailaufnahmen und explizites `nurPixeltreu` behalten den Originalpixel-Vertrag.
- Eine tatsächlich fotografierte Ansicht verwendet genau ihr eigenes Quellfoto. Weitere Referenzen dürfen keine Haken, Etiketten oder Gurte aus anderen Ansichten hineinmischen. Abgeleitete Perspektiven und Szenen verwenden weiterhin geeignete Referenzen und bleiben als generiert gekennzeichnet.
- Die Kompaktheitswache des Freistellers bleibt für bisherige Aufrufer unverändert. Nur wenn ausschließlich diese Wache anschlägt (z. B. U-förmiger Kamerasattel) UND eine verpflichtende Prüfung des fertigen Bildes erfolgreich ist, wird die Form akzeptiert. Alle übrigen Geometriewachen bleiben bestehen.
- `backend/lib/image-result-check.js` prüft das fertige Bild einschließlich Farbe, Zustand, Material, Text, Teile und Studiohintergrund. In den Studio-/Galeriepfaden wird nur ein vollständiges positives Urteil akzeptiert. Fehlende/unsichere Prüfung und erkannte Abweichungen führen zum Verwerfen, bevor ein Bild hochgeladen wird.
- Zusätzlich misst ein enger deterministischer Schutz die Helligkeitsverteilung dunkler Studioartikel. Eine deutliche Aufhellung sowohl des dunklen Quartils als auch des Medians gegenüber allen Referenzen wird abgelehnt. Das ist keine universelle Farbprüfung: helle/mehrfarbige Referenzen und Anwendungsszenen sind ausdrücklich nicht abgedeckt. Die Modellprüfung und die Sichtkontrolle bleiben notwendig.
- Eine gescheiterte Freistellung gibt niemals das rohe Renderbild als Erfolg zurück. Studio liefert bei vollständig fehlgeschlagener Prüfung `STUDIO_QUALITY_REJECTED`; Galerie meldet ausgelassene Varianten im bestehenden Ergebnisbericht. Originale bleiben unverändert. Die Zielzahl darf nicht durch fehlerhafte Bilder aufgefüllt werden.
- Varianten priorisieren standardmäßig das Qualitätsmodell aus `lib/gemini-image-models.js`, mit dem schnellen Modell als geprüftem Rückfall. Explizite ENV-Pins bleiben erhalten. Masken nutzen weiterhin die günstigere bestehende Kette.
- Studio und Galerie reservieren die geschätzten Kosten VOR jedem Bildaufruf, einschließlich Timeouts und paralleler Versuche. Der bestehende Deckel bleibt erhalten; Vision- und Eingabetokens sind darin nicht vollständig enthalten.
- Studio-Ausgabe wird nach Bearbeitung ohne Beschnitt auf eine weiße quadratische Leinwand mit mindestens 1600 px gesetzt. Hochskalieren erzeugt keine zusätzlichen echten Details. Keine neue Route oder Datenmigration.

## Betrieb und Grenzen

Fotografischer Standard: `STUDIO_PHOTOGRAPHIC` (nur `off` stellt den vorherigen Composite-Ablauf wieder her; Identitätsprüfung bleibt streng). Weitere Schalter: `STUDIO_COMPOSITE`, `GALLERY_UNIFORM_CANVAS`, `GENERATED_IMAGE_IDENTITY_CHECK` (jeweils nur `off` deaktiviert), `IMAGE_COST_CAP_USD` (Default 0.9, `0` unbegrenzt), `GENERATED_IMAGE_IDENTITY_MIN_CONFIDENCE` (Default 0.6). Kein Produktionsschalter wurde geändert. Wird die Identitätsprüfung deaktiviert, liefern die strikten Studio-/Galeriepfade keine ungeprüften Bilder aus.

Ein positives Modellurteil ist kein Beweis perfekter Produkttreue. Beim SAKK-Vergleich akzeptierte der Prüfer sichtbar fehlerhafte Bilder trotz verschärftem Prompt; deshalb wurden die konkreten Ursachen im Freisteller und in der Tonwertkurve behoben und ein zusätzlicher messbarer Farbschutz ergänzt. Neu abgeleitete Ansichten und Anwendungsszenen benötigen weiterhin eine Sichtkontrolle vor Übernahme ins Angebot.

## Technischer Realbildtest — 18.09.2026

Mit einer isolierten Kopie echter Daten und dem bestehenden Gemini-Dienst verifiziert: Studio HTTP 200 mit Originalpixel-Composite, Varianten HTTP 200 mit vier Bildern; fehlende Makroaufnahme explizit ausgelassen. Ergebnisdateien waren nach Neustart abrufbar. Das belegt den technischen Ablauf, keine umfassende Qualitätsabnahme aller Produktkategorien. Es wurden keine Produktionsprodukte verändert.

## SAKK-Regression — 18.09.2026

Auslöser: Originalhintergrund blieb sichtbar; schwarzes Textil wurde grau/blau; Referenzansichten wurden vermischt. Das Produkt wird in einem isolierten lokalen Test mit seinen drei Originalfotos geprüft; Ergebnisse werden ausschließlich privat lokal gespeichert.

Messbare Negativkontrollen: Die beanstandete graue und blaue Variante sowie eine zu helle neue Draufsicht werden vom deterministischen Dunkelfarbenschutz abgelehnt. Die korrigierten Front-, Rück- und Heroansichten passieren. Gemessene Materialmediane im Kontrollpaar: Original 34–35, fehlerhafte Bilder 53–63, korrigierte Bilder 33–36 (RGB-Mittelwert nach Ausschluss heller Hintergrundpixel; keine Aussage über allgemeine Farbmetrik).

Ein höheres Thinking-Budget der Vision-Prüfung verbesserte diese Negativkontrollen nicht und wurde deshalb nicht übernommen. Das Qualitätsmodell lieferte im Vergleichslauf drei Studioansichten und eine Szene; zwei fehlerhafte Ausgaben wurden abgelehnt. Vollständige Abnahme aller Produktkategorien ist daraus nicht ableitbar.


Abschließender Wiederholungslauf: Studio-Einzelfunktion erzeugt ein Originalpixel-Composite; Galerie liefert sechs Bilder für geschätzte 0,807 USD Bildkosten. Die Originalansichten sind visuell korrigiert. Frei erzeugte Szenen zeigen weiterhin teilweise warme Farbe/abweichende Details trotz positivem Modellurteil. Daher **keine fachliche Freigabe des gesamten Bildfeatures**, kein Main-Merge. Der Betreiber wurde nach gewünschtem Umgang mit unbelegten Perspektiven/Szenen gefragt. Lokale Backendprüfung: 5.221 Tests in 445 Dateien bestanden. Produktbilder wurden nicht gespeichert oder ersetzt.


## Bodenschatten und Ausrichtung — 19.09.2026, nur lokal

Betreiber meldete schwebende/schiefe Produkte trotz sauberem Hintergrund. Zwei konkrete Ursachen in `backend/lib/packshot-composite.js`:

- Der alte Schatten stauchte die untersten 4 % auf 5 % der Produkthöhe, verdeckte davon 55 % und beschnitt den Weichzeichner. Bei einem flachen Koffer verschwand fast der gesamte sichtbare Schatten.
- Die Rotation am kleinsten Rechteck um den Gesamtumriss verdrehte einen korrekt stehenden Korpus wegen seines aufgeklappten Deckels. Am echten VOKSUN-Foto gemessen: zusätzliche 3,08°.

Neue Ausrichtung über eine robuste, mindestens 60 % der Produktbreite belegte Unterkante; Griff/Füße dürfen diese unterbrechen. Zwei abweichende Bodenkanten gelten als Perspektive, unklare/runde Standflächen bleiben unverändert. Keine Vierteldrehung oder erfundene neue Ansicht. Bereits generativ komponierte Studioansichten werden beim Vereinheitlichen der Leinwand ausdrücklich nicht erneut gedreht.

Neuer Bodenschatten aus der unteren Produktkontur: enger Kontakt plus breiter, weicher Auslauf, getrennte Weichzeichnung und transparenter Puffer. Stärke weiter über `STUDIO_SHADOW_OPACITY`, keine neue ENV. Produktpixel werden für den Schatten nicht geändert. Weißer Studiohintergrund und vorhandener neutraler Galerieverlauf bleiben erhalten.

Echte lokale Abnahmeproben: VOKSUN geschlossene Front und aufgeklappte Ansicht als Originalpixel-Composites, je 0,034 USD geschätzte Bildausgabe. Zusätzlich SAKK: fehlerhafte U-Maske durch Qualitätsprüfung verworfen, generativer Rückfall lieferte ein freigestelltes schwarzes Produkt mit Schatten (0,168 USD). Galerie am VOKSUN: 3 Studioansichten + 2 Szenen, Detailaufnahme wegen falsch entfernter Gehäuseteile verworfen; 0,673 USD, 78 s. Diese Schätzwerte enthalten keine vollständigen Eingabe-/Visionkosten. Originale und Produktspeicherung werden durch diese Generierungstests nicht verändert.

Regressionen in `backend/__tests__/packshot-grounding.test.js`: Deckel/Griff, gekippte Unterkante, perspektivische/runde Produkte, keine zweite Rotation generierter Ansichten, sichtbarer Schatten bei breiten/hohen Produkten, unveränderte Materialfarbe und saubere Außenränder. 5.229 Backendtests, 460 Frontendtests, TypeScript und Build grün. Freie Perspektiven und Szenen bleiben generativ und sind kein Beweis buchstabengetreuer Details. **Keine Produktionsfreigabe für KI.**

Abschließender UI-Test nach lokalem Neustart: VOKSUN Original 8 → Studio-Foto → neues Bild 9, insgesamt 14 Bilder. Lokaler Storage-Abruf und sichtbarer Bodenschatten bestätigt; Testbild im lokalen Produkt gespeichert.

## Webbilder als Referenz — 19.09.2026, nur lokal

WEB-Bilder (`source: web_search`) sind in der Referenzauswahl zulässig. Maßgeblich ist die sichtbare Produktansicht; eine Verpackungsaufnahme bleibt auch aus dem Web keine Vorlage für den ausgepackten Artikel. Transparente PNGs werden vor der JPEG-Vorbereitung in Studio und Galerie auf Weiß gesetzt, damit schwarze Produkte nicht auf künstlich schwarzem Hintergrund verschwinden.

Beim gemeldeten Ninja AF500EU / SKU-8149239450 waren alle fünf WEB-Bilder im Browser sichtbar, aber im lokalen Backend nicht ladbar: Die private Snapshot-Allowlist enthielt nur Google/eBay/Otto. Der lokale Proxy lieferte für die fünf anderen Bild-URLs 404; die Analyse erhielt nur drei hochgeladene Kartonfotos. `.local-gcp/image-access.mjs` im Prüfbaum ergänzt jetzt exakt die Bild-URLs aus den Snapshot-Produktgalerien. HTTPS-GET, keine Weiterleitungen, keine Credentials und keine privaten Netzwerkziele; Produktionsisolation bleibt bestehen. Alle acht Ninja-Referenzen nach dem Fix per HTTP 200 geprüft.

Galerieergebnisse führen fehlgeschlagene Referenzdownloads ausdrücklich als `referenz_laden_fehlgeschlagen` mit Bildnummer auf. Bei unvollständigen Referenzen darf ein negatives Urteil über die erfolgreich geladenen Bilder nicht als Urteil über die gesamte Galerie erscheinen (`vorlagen_nicht_vollstaendig_geladen`). Additive Diagnosefelder: `evidence.candidateCount` und `evidence.failedReferenceCount`. Die Oberfläche empfiehlt passende Webbilder oder eigene Produktfotos und trennt Zugriffsfehler von ungeeigneten Motiven; sie verlangt nicht mehr pauschal Auspacken.

Regressionen: Karton + verwendbares WEB-Produktfoto, Web-Downloadfehler ohne falsche Motivaussage/URL-Leak, transparente PNGs in beiden Pipelines, verständliche Statusmeldungen. Keine Route, Produktions-ENV oder Produktdatenstruktur geändert; keine Produktionsauslieferung.

Praxistest nach kontrolliertem Neustart im tatsächlichen Datenblatt: Kartonfoto 1 als Auswahl beibehalten, Galerieknopf betätigt. **8 Referenzen genutzt**, Vorderansicht erkannt, 6 Varianten geplant. Damit ist die Web-Zugriffskorrektur belegt. **0 Ausgaben**, weil die Qualitätssicherung Maskierungsartefakte, falsche Bedienelemente/Beschriftungen und schließlich den Kostendeckel meldete; 11 Bildaufrufe, 0,808 USD geschätzte Bildkosten. Separater Studio-Test mit WEB-Bild 8: Maske schnitt oberen Geräteteil ab; beide Retuschemodelle verfälschten Beschriftungen, `STUDIO_QUALITY_REJECTED`. Keine neuen Produktbilder gespeichert. Das ist ausdrücklich **keine erfolgreiche Bildqualitätsabnahme**. Nächster Qualitätsansatz: Silhouetten-/Referenzzuordnung und vorhandene transparente Originale erhalten, bevor ein fehlerhafter Composite auf vollständiges Neuzeichnen zurückfällt; Prüfungen nicht lockern.

Abschließende technische Prüfung: 5.233 Backendtests/446 Dateien, 462 Frontendtests, TypeScript und Produktionsbuild grün; zwei zusätzliche private lokale Proxytests grün. Tests belegen den Codepfad, nicht die generative Bildqualität.

## Fotografische Studioausgabe — 20.09.2026

Aktueller Betreiberauftrag: umsetzen und auf Produktion ausliefern, keine weitere Vergleichsseite oder Freigaberunde. Diese Anweisung ersetzt die frühere lokale Beschränkung des KI-Features.

Ursache der unästhetischen Ausgabe: Originalpixel-Composites erhielten die flache Aufnahmebeleuchtung; der Renderprompt verbot Bodenschatten, anschließend entfernte eine zweite Maske die fotografische Umgebung erneut. Der neue Standard rendert ein fertiges Studiofoto und erhält dessen Licht und Schatten. Die bestehende Qualitätsprüfung bewertet im selben Aufruf zusätzlich `studioLighting`, `grounded` und `compositionGood`; fehlende oder negative Befunde verwerfen das Bild. Farbe, Material, Beschriftung, Zustand und belegte Details bleiben unabhängig davon zwingend.

Die Referenzanalyse unterscheidet kompletten Artikel, abgenommenen Bestandteil, Detail und Verpackung. Deckel/Inneneinsatz werden als Detail behandelt und dürfen keine Vorlage für die Gesamtansicht oder Szene sein. Verwendbare WEB-Fotos sind weiter zulässig. Generierte Bilder erhalten additive Kennung `studioPipeline: photographic-v1`. Kostenreservierung und Obergrenze bleiben aktiv; der Standard benötigt keine zusätzliche Leinwandmaske. Keine Änderung an Routen, Auth, Bestand, OMS oder Produkt-Schreibpfaden.

## Automatische Kartonrecherche — 20.09.2026

Betreiberanforderung: Möbel müssen nicht für Produktfotos aufgebaut werden. Der Galerieknopf zur KI-Bildergenerierung recherchiert automatisch, wenn die eigenen Fotos nur Verpackung/Etiketten und keine brauchbare Gesamtansicht zeigen und auch keine verwendbare passende WEB-Gesamtansicht vorhanden ist. Eine geladene WEB-Aufnahme hat Vorrang vor einer erneuten Suche, wenn die Bildklassifikation denselben Artikel, vollständiges Produkt, ausreichende Qualität und eine unverpackte Studioansicht bestätigt. Unsichere, abweichende, angeschnittene oder reine Detail-/Anwendungsbilder lösen weiterhin Recherche aus. `Studio-Foto` bleibt die Bearbeitung des gezielt ausgewählten Fotos; die automatische Recherche gehört zur Galerie-/Variantenfunktion.

[packaging-image-research.js](../../../backend/services/packaging-image-research.js) liest Marke, Artikelnummer/Modell, EAN/GTIN und bekannte Variante aus Kartonbildern und vorhandenen Produktdaten. Widersprüche stoppen den Lauf. Drei gezielte Suchanfragen über Google und Bing (bestehende SerpAPI), maximal acht echte Produktseiten, daraus maximal acht hochauflösende Bildkandidaten; höchstens vier bestätigte Referenzen gehen in die Galerie. Herstellerähnliche Domains werden bevorzugt, müssen aber dieselben Identitätsprüfungen bestehen. Suchergebnis-Snippets alleine reichen nie.

Strukturierte Product-Daten binden Bilder an den Artikel; bei fehlenden strukturierten Daten werden nur auf der gelesenen Seite nachgewiesene Bilder verwendet. Der Modellprüfer muss Modell, Variante, vollständigen Artikel, Lieferumfang, Nutzbarkeit und Widerspruchsfreiheit bestätigen. Modell-/GTIN- und Varianten-Zitate müssen wirklich im gelesenen Text stehen. Zahlen zu Maßen/Konfiguration werden zusätzlich deterministisch abgeglichen. Fremde Modellnummern, andere strukturierte GTINs, nur ähnliche Serien und nicht mitgelieferte Erweiterungsmodule dürfen nicht still als passend gelten. Es gibt weiterhin keine Garantie fehlerfreier KI-Urteile.

Die bestätigten Bildpixel werden direkt wiederverwendet; kein zweiter ungeschützter Download der recherchierten Quelle. Kartonfotos dienen der Identifikation und werden nicht als Vorlage eines aufgebauten Möbels an den Renderer geschickt. Erneute Ansichtsklassifikation und bestehende Ergebnisprüfung bleiben Pflicht. In diesem Recherchepfad werden nur tatsächlich belegte Fotoansichten als Studiofoto aufbereitet; unbelegte Perspektiven und Anwendungsszenen bleiben aus (`recherche_missing_views`). Fehlschlag lässt KEINEN Rückfall auf einen Karton oder ein ungeprüftes WEB-Bild zu. Originalbilder und Produktdaten werden nicht automatisch überschrieben.

`evidence.research` liefert Status, Quellen und Zähler. Erzeugte Bilder führen additiv `referenceProvenance.kind=verified_catalogue` und Quellenbelege. Die Oberfläche zeigt kompakt aufklappbare Quellen und unterscheidet Modellabbildung vom nicht fotografierten Zustand des tatsächlichen Artikels. Fehlende Identität, Datenwiderspruch, keine bestätigte Variante, Dienstfehler und Zeitlimit haben eigene Meldungen; keine pauschale Aufforderung zum Aufbau.

Sicherheit und Betrieb: [research-download.js](../../../backend/lib/research-download.js) prüft öffentliche DNS-Ziele auch bei der eigentlichen Verbindung und jeder Weiterleitung; keine Credentials/interne Ziele, maximal 2 MB HTML/12 MB Bilder, begrenzte Ladezeit. Der Rechercheabschnitt hat maximal 90 s innerhalb des bisherigen Gesamtbudgets und lässt mindestens 60 s für Bilderzeugung frei. Keine unbegrenzten Wiederholungen. Bildkostenlimit bleibt; Such-/Visionkosten sind zusätzlich und werden in der Oberfläche entsprechend getrennt. Rollback: `PACKAGING_IMAGE_RESEARCH=off` (sonst standardmäßig aktiv). Keine Produktions-ENV wurde für die Aktivierung geändert.

Neue Vision-Calls verwenden `identify.image`-Scope-Konfiguration mit Mandant, zentralen Modell-/Config-Fallback, strikte eigene [Zod-Schemas](../../../backend/lib/llm-schemas/packaging-research-schema.js) sowie inhaltsfreie LLM-Telemetrie. Fachprompts/schema-spezifische Prüfungen liegen versionskontrolliert im Service, ohne Änderung einer globalen Scope-Promptversion. Kein neuer Firestore-Schreibpfad, keine Route, Dependency oder Auth-/Bestandsänderung.

Echter lokaler End-to-End-Test: Westmann Castra B, SKU-6027324616, zwei Original-Kartonfotos, Identifikation `WMHFR-25B16`/EAN4262519771956/Anthrazit/95×50×160 cm; vier Produktseiten geprüft, bestätigte Händlerreferenz anhand GTIN und Variante. Final eine belegte Studioansicht in 71,2 s, geschätzte Bildausgabekosten 0,134 USD (Recherche/Vision zusätzlich). Tests nutzten echte Gemini-/Suchdienste, aber private lokale Bildablage und keine produktiven Produktwrites. Quelle und finales Bild visuell geprüft. Eine im Vorversuch frei erzeugte Seite hatte zusätzliche Füße erfunden; die finale Beschränkung auf belegte Ansichten verhindert diesen Planungsweg. Der Test beweist die gesamte Funktionskette für diesen Artikel, keine universelle Möbelabdeckung. WERKHAUS und Vertbaudet lieferten in den begrenzten Suchläufen keine bestätigten Bilder; keine Ersatzmöbel erzeugt. Gesperrte Seiten, fehlende Modellbelege, nur PDF-Kataloge und unzureichende Fotos können weiterhin ein Ergebnis verhindern.

## Vorhandene Webvorlage hat Vorrang — 20.09.2026, Hotfix

Nimara Carlo 76601 / SKU-5590256737: zwei Karton-/verpackte Teilefotos plus ein manuell ergänztes Herstellerfoto. Die echte Analyse erkannte das WEB-Bild korrekt als vollständige, verwendbare Frontansicht (0,98) und alle Fotos als denselben Artikel. Der Recherche-Trigger ignorierte diesen Befund und ersetzte vorhandene Referenzen durch einen erfolglosen Suchlauf: null Renderaufrufe, obwohl eine passende Vorlage vorlag.

`needsPackagingResearch()` lässt eine bestätigte vollständige WEB-Vorlage (`web` und `web_search`) jetzt direkt in den bestehenden Galeriepfad. Kein neuer Suchtreffer ist dafür nötig. Karton-/Folienbilder werden weiterhin nicht als Renderreferenz verwendet, frühere KI-Ausgaben sind weiterhin ausgeschlossen und die Ergebnisprüfung bleibt aktiv. Abweichender Artikel, fehlende Gesamtansicht, Bauteil/Detail, Verpackung, Lifestyle, Anschnitt, geringe Sicherheit oder fehlende positive Artikelzuordnung behalten die Recherche. Nur neu recherchierte Vorlagen tragen recherchierte Quellenherkunft; vorhandene Webbilder werden nicht fälschlich als neu recherchiert gekennzeichnet. Die Beschränkung des automatischen Recherchepfads auf belegte Ansichten bleibt unverändert.

Vier neue Regressionen zuerst rot, danach grün; prüfen sowohl den Trigger als auch tatsächliche Bilderzeugung bei ausgefallenem Suchdienst und Ausschluss von Karton/alten KI-Ausgaben. Keine neue Route, ENV, Dependency, Produkt-Schreiblogik oder Infrastrukturänderung.

Finale Prüfung des Hotfix: 5.354 Backendtests / 458 Dateien und Produktionsbuild grün. Echter Nimara-Lauf erzeugte vier Studioansichten plus eine Anwendungsszene in 89,8 s; alle fünf lokal gespeicherten Ausgaben visuell geprüft, keine produktiven Produktwrites. Geschätzte Bildausgabekosten 0,771 USD, Analyse/Prüfung zusätzlich. Dies belegt den zuvor blockierten Fall, keine universelle Erfolgs- oder Perspektivtreuegarantie.

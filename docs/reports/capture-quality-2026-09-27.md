# Erfassungsqualität — Befund und lokale Korrektur, 27.09.2026

## Freigegebene Auslieferung (Ergänzung 27.09.2026 abends)

Der Betreiber hat die Auslieferung nach Tests ausdrücklich bestätigt. Basis auf Main `0c801ab6` samt aktuellem Oversell-Fix aktualisiert. **5.639 Backendtests / 487 Dateien, 527 Frontendtests, TypeScript und Produktionsbuild grün.** Voriger Produktionsstand Web `01820-lnj`, Worker `00275-gf2`. Scope-Version `identify.v2/capture-v2-20260927` unveränderlich und zunächst inaktiv vorbereitet; [Prompt-Manifest](../releases/capture-quality-v2-prompt-manifest.json) enthält Vorgängerversion und Quell-Hashes. Aktivierung erfolgt nach dem zugehörigen Image-Rollout. Der Abschlussnachweis liegt im Projektgedächtnis bzw. `/Users/oguz/Dev/avycloud/CODEX_RELEASE_CAPTURE_QUALITY_20260927.md`. Die folgenden Nicht-Deployment-/Freigabehinweise sind der historische Untersuchungsstand.

## Stand und Auftrag

Der Betreiber meldet unvollständige neue Produktdatenblätter und fehlende Preise, die unnötige Chat-Nacharbeit verursachen. Untersucht wurden reale Erfassungen, Produktionslogs und der tatsächlich aktive V3-Code. Die Korrektur liegt uncommitted im Worktree `/Users/oguz/Dev/avycloud-capture-quality-20260927`, Branch `codex/capture-datasheet-quality-20260927`.

Ausgangsbasis war Main `c2abecab31b56149b7123019b43c6823989a6ace`. Während der Arbeit erschien die separat freigegebene Bildwerkstatt. Der Worktree wurde ohne eigenen Commit auf `810a0d76948271747086f97df0b72c06401f3c5d` vorgezogen; beide Änderungen werden gemeinsam getestet. **Diese Erfassungskorrektur ist nicht deployed.** Keine automatische Reparatur vorhandener Datenblätter.

Anfangs direkt geprüft: Web `product-hub-backend-01817-8xv`, Worker `product-hub-worker-00272-dz6`, jeweils Ready/100 %. `IDENTIFY_V3=true`, V4 aus, Agentic Stage 3 default-on. Die zentrale Modellauflösung verwendet Gemini 3.7 Flash trotz älterem ENV-Pin. Keine Modell-/Flag-Änderung vorgenommen. Der später im Projektgedächtnis dokumentierte Bildwerkstatt-Release hat Web `01818-gdb` / Worker `00273-xf8`; vor einer Auslieferung erneut direkt prüfen.

## Vergleich echter Datenblätter

Lesender Firestore-Snapshot: 2.383 Produkte des Tenants `default`; davon 91 mit Erfassung seit 20.09.2026, ausgewählt nach `ops.identified_by.at`. Aktueller Bearbeitungsstatus und ursprünglicher Qualitätssnapshot sind getrennte Messpunkte. „Bereit“ ist ein Bearbeitungsstatus, kein Beweis für die ursprüngliche Erfassungsqualität.

| Aktueller Status | Produkte | Bei Erfassung ohne Preis | Heute mit Marktpreis | Heute mit Verkaufspreis |
|---|---:|---:|---:|---:|
| Bereit | 40 | 36 | 36 | 40 |
| Ausstehend | 28 | 28 | 1 | nicht ausgewertet |
| In Bearbeitung | 23 | 22 | 18 | 16 |
| Gesamt | 91 | **86** | 55 | — |

86/91 ursprüngliche `identify_v2_quality_v1.snapshot.price_ok` waren falsch, darunter alle 28 aktuell ausstehenden Produkte. 27 davon besitzen weiterhin keinen Marktpreis. Die später vorhandenen Preise in bearbeiteten Datensätzen dürfen deshalb nicht der ursprünglichen Erfassung zugerechnet werden.

Alle 91 V3-Snapshots hatten `aspect_coverage.total = 0`. Aktuell: Median 24 Attribute und sechs Highlights bei „Bereit“, gegenüber 19,5 Attributen und 3,5 Highlights bei „Ausstehend“. Die Beschreibungen sind nicht pauschal kürzer: Median ungefähr 160,5 bzw. 175 Wörter. Textlänge allein misst keine fachliche Richtigkeit.

## Bestätigte Ursachen und Korrekturen

1. **Falscher Taxonomie-Vertrag.** Stage 2 las `catalog.required`, geliefert wird `requiredAspects`. Alte Tests hatten denselben falschen Mock. Korrigiert und zusätzlich gegen einen tatsächlichen lokalen Kategorienkatalog getestet; empfohlene Merkmale werden ebenfalls an die Generierung übergeben.
2. **Preisresultate verloren bzw. verspätet.** Stage 2 gab nach 15 Sekunden auf. Der allgemeine Lookup wartete auf mehrere Quellen samt verschachtelten Rückfallwegen; die Route versuchte danach erneut eine breite Recherche und konnte später das ganze Produkt speichern. Jetzt gibt es einen begrenzten Erfassungslauf parallel zur Textgenerierung, dessen Ergebnis vor Bewertung und Produktsave übernommen wird. Kein zweiter Nachlauf für vollständig abgearbeitete V3-Recherche.
3. **Widersprüchliche Highlight-Vorgaben.** Prompt und tatsächliche kategoriebasierte Längenprüfung passten nicht zusammen; zudem fehlte der Kategoriebezug im Stage-3-Sanitizer. Beide Generierungswege verwenden jetzt denselben, aus der vorhandenen Prüfung abgeleiteten Vertrag. Keine Abschwächung der Prüfung.
4. **Unvollständige GPSR-Übernahme.** Das Schema und die Assembly transportierten überwiegend fünf flache Herstellerfelder; andere kanonische Felder gingen verloren. Vollständiges additives Schema und Merge, bestehender Registry-Vorrang erhalten. Das ist keine Garantie für korrekte unbekannte Herstellerangaben; unbelegte Daten bleiben weg.
5. **Abgeschnittene Referenz-URLs.** HTTP(S)-Attributwerte wurden an mehreren Stellen auf 60/200 Zeichen gekürzt. Referenzen bleiben jetzt bis zur finalen Save-Normalisierung vollständig; gewöhnliche Textgrenzen bleiben bestehen.
6. **Erfundene Preis-URLs.** Reale Modellproben lieferten 404-Slugs und fremde Varianten. Tatsächliche Suchtreffer, deterministische Produktangebote und zusätzliche Identitätsprüfung verhindern deren ungeprüfte Übernahme.

Details zu Budget, Quellenpriorität und Ausschlüssen: [Identify-Pipeline](../kb/06-features/identify-pipeline.md) und [Pricing Engine](../kb/06-features/pricing-engine.md#preis-bei-v3-erfassung).

## Proben mit echten Produktfotos und Händlerseiten

| Produkt | Ursprünglicher Befund | Ergebnis der begrenzten lokalen Probe |
|---|---|---|
| Träumeland Carefor Midi, SKU 7716906376 | Kein Marktpreis, drei Highlights | Fünf gültige Highlights und strukturiertes GPSR; verifizierter Marktpreis **46,99 €**, Gesamtprobe ca. 35,4 s |
| Steinel L 605 S Anthrazit, SKU 2463456183 | Kein Marktpreis | Fünf gültige Highlights und strukturiertes GPSR; finale Preisprobe **102,32 €** in **2,94 s**, ohne Gemini-Preisaufruf |

Preisbelege zum Messzeitpunkt: [Träumeland bei Baby & Family](https://www.babyandfamily.de/traeumeland-kissen-carefor-midi-0-6-monate), EAN 9120064852375 / MPN T040321; [Steinel bei Lightkontor](https://www.lightkontor.de/STEINEL_No_065287_Sensor-Aussenleuchte_L_605_S_anthrazit.html), EAN 4007841065287 / MPN 065287. Preise sind Momentaufnahmen und keine eigenen Verkaufspreise.

Beide Content-Proben verwendeten je zwei existierende Uploadfotos und die tatsächliche Agentic-Generierung. Identität/Kategorie wurden aus der vorhandenen Erfassung rekonstruiert; **keine erneute vollständige Stage-1-Erkennung und kein HTTP-Upload-/Save-End-to-End-Test**. Die erste Steinel-Preisprobe blieb korrekt leer, weil Modellquellen ungültig waren. Erst der deterministische Händlerpfad lieferte den belastbaren Preis. Das ist im Nachweis erhalten, nicht als durchgehend erfolgreicher erster Versuch dargestellt. Die spätere Steinel-Probe betraf nur den Preis; eine Gesamtzeit für diesen endgültigen kombinierten Ablauf wurde nicht gemessen.

Diese Stichprobe beweist konkrete Verbesserungen, keine hundertprozentige Preisabdeckung oder vollumfängliche fachliche Richtigkeit aller generierten Attribute/GPSR-Felder. Textgenerierung bleibt ein überprüfungsbedürftiger Modelloutput. Marktpreise ändern sich; unbekannte/gesperrte Angebote können weiterhin leer bleiben. Keine erfundenen Ersatzpreise.

## Prüfung und Betriebsgrenzen

- Regressionstests decken verspätete Preise, hängende/fehlerhafte Quellen, Budgetende, keine Mutation nach Rückgabe, Preisübernahme vor Bewertung, Quellen-/Identitätsprüfung, echten Taxonomie-Vertrag, vollständiges GPSR, URL-Erhalt und Vermeidung zusätzlicher KI-Preisaufrufe ab.
- Tests vor Abgleich mit Bildwerkstatt: **5.563 Backendtests / 477 Dateien** grün. Endgültiger integrierter Stand auf Main `810a0d76`: **5.596 Backendtests / 481 Dateien, 527 Frontendtests und Produktionsbuild grün**. `git diff --check` ohne Befund. Kein eigener Frontend-Code geändert.
- Keine neuen Dependencies, ENV-Flags, Collections oder HTTP-Routen. Keine Auth-/Docker-/Cloud-Build-/Firebase-Konfigurationsänderungen. Produktwrites bleiben beim vorhandenen `saveProductV2()`-Pfad; Stock, OMS und Marktplatzmutation unverändert.
- Keine automatische Änderung von `sellPrice` oder Status „Bereit“. Keine Altprodukt-Massenkorrektur. Direktabrufe können Such-/Unlocker-Kosten erzeugen; die Proben nutzen auch kostenpflichtige bestehende Modellaufrufe. Keine belastbare Gesamtkostenprognose aus zwei Fällen ableiten.
- Code-Vertrag und Diagnose sind mit `capture_contract_version: 2` versioniert. Bestehende Firestore-LLM-Konfiguration wurde nicht verändert. **Vor Freigabe einer Auslieferung muss die Prompt-/Schemaänderung zusätzlich nach `docs/standards/llm-quality-parity.md` als neue Scope-Version dokumentiert und abgestimmt aktiviert werden; die Codezahl ersetzt diesen Schritt nicht.** Die bestehende Preis-LLM-Hilfe besitzt außerdem noch ihre bisherigen Konfigurations-Hardcodes; keine vollständige Scope-Migration in diesem Bugfix behaupten.

## Produktionszugriffe und Nebenbefund

Kein Produkt wurde durch diese Untersuchung gespeichert. Die Live-Proben blockieren Firestore-Schreibmethoden; versuchte Telemetrie-`create`s wurden abgefangen. Geheimnisse wurden nur im Prozessspeicher verwendet und nicht in Nachweise geschrieben.

Bei der ersten Content-Probe löste das bestehende `backend/lib/storage.js` bereits beim Import eine erneute IAM-Policy-Speicherung aus. GCP-Audit: **27.09.2026 02:08:34.300145897 UTC**, `storage.setIamPermissions`, Bucket `prodsandjobs`, **`serviceData.policyDelta: {}`** — keine Berechtigungsänderung. Der Vorfall wurde dem Betreiber mitgeteilt. Für alle weiteren Proben wurde das Storage-Modul **vor jedem Anwendungsimport** durch einen sperrenden Stub ersetzt. Diesen Import nicht als nebenwirkungsfreien Read behandeln. Der Initialisierungsmechanismus selbst ist nicht Gegenstand dieses Fixes.

Private Rohbelege liegen außerhalb Git unter `/Users/oguz/Dev/avycloud-local-backups/capture-quality/20260927/`: Snapshot, ausgewählte Proben, IAM-Audit und Testlogs. Produkt-/Mitarbeiter-Rohdaten gehören nicht ins Repository.

## Vor einem späteren Release

Aktuellen Main-/Produktionsstand erneut prüfen, Scope-Versionierung abschließen, dann expliziten Commit-/Merge-/Deploymentauftrag beachten. Neue reale Erfassung erst nach autorisierter Auslieferung auf Antwort **und gespeichertes** Datenblatt prüfen: Marktpreis mit korrekter Quelle, Kategoriepflichtmerkmale, Highlights, GPSR und Dokument-URLs. Diagnose `capture_contract_version`, Preisfundquote, Latenz und tatsächlichen Chat-Nacharbeitsbedarf beobachten. Bei Problemen zum unmittelbar vorigen vollständigen Release zurück; keine Datenmigration nötig. Frühere Deploy-Freigaben für die Bildwerkstatt gelten nicht automatisch für diesen Auftrag.

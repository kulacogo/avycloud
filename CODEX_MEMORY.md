## 08.10.2026 — Druckstation ist Windows 192.168.178.61; Zugriff bleibt offen

- Betreiber präzisiert dauerhaften Zielrechner: **Windows 192.168.178.61**, nicht der Mac. Bestehender Auftrag zur vollständigen Umsetzung und Produktion gilt; keine erneute allgemeine Deployfreigabe verlangen.
- Netzwerk lesend: SMB/445 offen, vorhandene Anmeldung fehlt (server rejected authentication). SSH/22, RDP/3389, WinRM/5985/5986 nicht erreichbar. Keine passende Fernwartungs-App im Mac-Appinventar. Nach Fernzugang oder lokalem Setup-Start und AvyCloud-Kontowahl gefragt; keine Passwörter im Chat anfordern. Noch keine Installation am Windows-Ziel und kein physischer Ausdruck abgenommen.
- PR32 / Worktree `/Users/oguz/.codex/worktrees/handheld-team-print-20261006/avycloud` um echten Windows-Adapter ergänzt: Treiberformate über System.Drawing/PowerShell, SumatraPDF 3.6.1 still mit festem Drucker + explizitem RawKind, Node22.23.3; Hersteller-Downloads und SHA256 fixiert. Kein Standarddruckerfallback. Windows-Erfolgsbeleg ist `sumatra:…`-Anwendungsquittung, keine erfundene Windows-Spool-ID. Bestehendes dauerhaftes Journal verhindert erneuten automatischen Druck nach verlorener HTTP-Quittung.
- `Einrichten.cmd` als Administrator startet Setup. Geplante Aufgabe läuft als LocalService bei Systemstart (keine Windows-Anmeldung nötig); ProgramData-Verzeichnis per ACL nur LocalService/SYSTEM/Admin. Zwei TEST-PDFs werden unter diesem Dienstkonto ausgegeben, anschließend muss der Bediener korrekte Rollen/QR-Scan bestätigen. Firebase-Passwort nur lokal eingeben, gespeichert wird ausschließlich Refresh-Sitzung. Keine Auth/RBAC/Firewalländerung.
- Main bis `04f35572` (eBay-Tagesbudget inkl. zentraler Testisolation, Mitarbeiter-Erfassungsfilter) integriert; fremde Änderungen im Hauptcheckout unberührt. Endstand lokal **5915 Backendtests/516 Dateien, 575 Frontend-/Agenttests, TypeScript/Build grün**, Agent darin31Tests. PowerShell-Syntax geprüft, beide Test-PDFs gerendert und Maße getestet. **Windows-Ausführung ist unbestätigt**, Mac-Tests ersetzen sie nicht.
- Lesend16:49MESZ: keine Druckagenten, keine offenen Druckjobs,6offeneconfirmed/picking-Aufträge,0verwaltete/alteTeilpicks. Web01831-nf8/Worker00286-pqj Ready/100%. **PR32 nicht deployed**, weil der neue Packabschluss ohne Station blockieren würde. Nach Zugang/Setup: echte Station/Medien prüfen, CI/Main/Produktionsdaten erneut lesen, Release kontrolliert mergen, Hosting+Web+Worker und zwei frische Heartbeats prüfen. Keine echten Labels/Bestände zu Testzwecken buchen.
- Runbook: `tools/print-agent/README.md`, Releasebeleg: `docs/reviews/handheld-team-print-20261007/README.md`. Frühere macOS-Zielannahmen sind ersetzt.

## 07.10.2026 — Handheld / Team-Pick / Druckstation: geprüft, Produktion wartet auf Station

- Betreiberauftrag „neue übersichtliche UI … funktionierende Labeldruckfunktion … Multi-Mitarbeiter-Pick … auf prod“ autorisiert diesen Release einschließlich Commit/PR/Merge/Deploy. Nicht erneut allgemeine Deployfreigabe verlangen. **Noch nicht deployed**, weil eine physisch funktionierende Druckstation fehlt.
- Isolierter Worktree `/Users/oguz/.codex/worktrees/handheld-team-print-20261006/avycloud`, Branch `codex/handheld-team-print-20261006`, Basis `0e89b058555d950442f54f2d4ab948601f2fd3ba`. Hauptcheckout `feat/los-kennzahlen` mit fremden Änderungen nicht übernehmen/resetten/stashen.
- Tatsächliche React-UI ersetzt redundante Pick-/Pack-Karten durch ganze Arbeitsansichten, große Stückzahl, einzeilige BIN/SKU, Aktionen unten und getrennte Mengen-/Gewichtsansicht. Mobile Home für Lagerrollen kompakt; keine Desktop-Dashboardänderung. Browserprüfung mit lokalen Fixtures 320×568, 360×640 hell/dunkel sowie Desktop-Zuweisung 1024×800.
- `orders.pickWork` + neue tenantgebundene `pick_assignments`: Firestore-transaktionale Zuweisung eines ganzen Auftrags pro UID. Zwei Mitarbeiter erhalten verschiedene Aufträge; zweites Gerät desselben Kontos braucht explizite Übernahme und neues Token. Pause gibt Teilware nicht frei. Buchungsquittungen/Restmengenprüfung atomar im bestehenden Stock-out-Schreibpfad. Abschluss/Versand von Teilpicks und geänderten Positionen blockiert; Versandprüfung vor Labelkauf. Desktop nutzt denselben Fortschritt, serverfrische BIN-Hints verhindern doppelte lokale Subtraktion.
- Druck Protokoll 2: gleicher initialer Job pro Tenant/Shipment, tokengebundene Station, dauerhafte lokale CUPS-Quittung. Verlorene Antwort wird erneut bestätigt, nicht erneut gedruckt. Unterbrochene Übergabe → uncertain; expliziter Nachdruck derselben Sendung erst nach terminalem Jobstatus. `done` belegt CUPS-Annahme, nicht physischen Papierauswurf. Handheld fordert „Label angebracht · fertig“.
- Agentinstaller kopiert eine vom Checkout unabhängige Laufzeit nach Application Support, speichert nur erneuerbare Sitzung (600/700), kein Passwort in plist. Gegen altes Backend kein Claim; wartet auf Protokoll 2. Rootdrucker vorhanden: `DHL_DPD_Label` (103x164mm), `DP_Label` (62x100mm). **Zielrechner und Kontowahl sind beim User angefragt, noch unbeantwortet; kein Passwort im Chat verlangen.** Noch keine Station installiert und kein physischer Ausdruck abgenommen. Nach Login Hardware/Medien prüfen, erst danach kontrollierter Rollout und anschließende neue Heartbeats/Queue-Abnahme.
- Lokal: 5.758 Backendtests/502 Dateien, 556 Frontend-/Agenttests, TypeScript und Build grün; Backend mit fiktivem GCP-Projekt, deaktiviertem Credentialpfad und nicht erreichbarem lokalem Emulatorziel. Keine Produktionstests mit Stock/Order/Portowrites.
- Lesender Produktionsstand vor Release: Web `product-hub-backend-01828-2bh`, Worker `product-hub-worker-00283-frq`, Ready/100 %. 20 offene bestätigte/pickende Orders; 0 alte Teilpicks, 0 ungültige Positionen, 0 verwaltete Picks, 0 offene Druckjobs, 0 Druckstationen. Neue Queries mit vorhandenen Indizes geprüft. Werte vor tatsächlichem Cutover erneut prüfen, `gcloud` immer mit `--project=avycloud`.
- [Vertrag und Grenzen](docs/kb/06-features/handheld-pick-pack.md), [Tests, Screenshots, Rollout/Rückweg](docs/reviews/handheld-team-print-20261007/README.md). Andere Mitarbeiter können Teilware nicht automatisch übernehmen; „Problem“ pausiert ohne Bestandskorrektur. Kein blindes Backend-Rollback unter aktive verwaltete Teilpicks; alte Clients kennen deren Quittungen nicht. PDAs beim Versionswechsel neu laden.

## 06.10.2026 — PR30 produktiv; deutscher Händlerverweis als Nachtrag

- PR30/Main dc010626 produktiv: Web01827-w22 und Worker00282-qn4 seit11:49MESZ Ready/Healthy/100 %, Hosting887f034b62a671b3. CI final5.716Backendtests/496Dateien;547Frontendtests,TypeScript/Build und4Browserprüfungen grün. Betreiberauftrag Tests→Produktion gilt weiterhin, keine neue Freigabe verlangen.
- Marktpreis wird initial auch Verkaufspreisvorschlag, aktiver Review-/Summary-Fluss zeigt ihn. Echte Nachmessung14:28MESZ:3/10 neue-Recherche-Datenblätter mit initialem Verkaufspreis; sieben ohne, zwei weitere alte Requests liefen beim Rollout noch aus. **Gesamtproblem weiterhin offen.** Frühere40/179 waren Marktpreise, kein Nachweis initialer Verkaufspreise.
- Folgebranch codex/capture-german-offers-20261006 im selben managed Worktree: gefundene ausländische Händlerseite darf ihrem expliziten deutschen Produktverweis folgen, maximal ein Sprung, gleiche Händleridentität und Preisprüfung. Stagecaptain PPS-47XL real44,90€ in3,05s ohne Gemini. Fünf Regressionen rot→grün; vollständige Suite5.721Tests. Dieser Nachtrag noch nicht deployed.
- [Nachweise und Grenzen](docs/reports/capture-price-2026-10-06.md); vollständiges aktuelles Projektgedächtnis im Hauptcheckout /Users/oguz/Dev/avycloud/CODEX_MEMORY.md. Keine Prompt-/Schemaänderung, keine neue Scope-Version. Keine Altprodukte verändert. Produktive Identify-Route nicht als schreibenden Test mit vorhandener EAN verwenden (pending intake).
- Bekannte separate Fehler: image-proxy502 und forecast/alerts500. Zwei neue Datenblätter beschreiben geschlossene Versandkartons ohne sichtbaren Inhalt; Paket2von4 eines Spielhauses ist kein belegtes Komplettset. Offene Identitäts-/Lieferumfangsprobleme nicht mit Fantasiepreisen verdecken.

## 27.09.2026 — Neue Betreiberregel: keine automatische Wiederaktivierung

Positiver Lagerbestand ist KEINE Erlaubnis zum erneuten Listen. Stock-Sync/Cron/Drain dürfen auf eBay und Kaufland kein pausiertes, inaktives, beendetes oder ausverkauftes Angebot wieder aktivieren. Manuelle Aktivierung bleibt nach tatsächlicher BIN-/Reservierungs- und Live-Statusprüfung möglich. Diese Anweisung ersetzt die frühere Relist-Selbstheilung aus CLAUDE.md Regel 15. [Arbeits-/Release-Nachweis](CODEX_MANUAL_REACTIVATION_20260927.md). Deployment folgt nach finaler CI; nicht vorzeitig als produktiv melden.

---
title: Erfassungsqualität — Arbeitsstand für Codex
lastReviewed: 2026-09-27
---

## 27.09.2026 — linke Navigation konsolidiert (Release freigegeben)

**Aktuelle Betreiberfreigabe:** „raus damit auf prod“ autorisiert Commit, PR/Merge und Deployment dieses Navigationsauftrags. Die folgenden früheren Hinweise „kein Commit/Deployment“ beschreiben den vorherigen Prüfstand.

- Auftrag: Übersicht verbessern, bekannte Linknamen erhalten, Gruppenpräferenzen pro Konto merken. Isolierter Worktree `/Users/oguz/Dev/avycloud-navigation-20260927`, Branch `codex/navigation-consolidation-20260927`, Basis `origin/main` **cd8a9b2e** (PR26). Hauptcheckout und andere laufende Arbeiten nicht für die Implementierung verwendet.
- Alle 26 bisherigen Linknamen/Hashes erhalten. Inventar → Lager; Shop-Gesundheit → Marktplätze; Integrationen → Einstellungen. Duplikate/Regeln sowie die jeweiligen Auftrags-/Lager-Einstellungen unter „Weitere Funktionen“. Kein Ziel ersatzlos entfernt, keine behauptete Nutzungsmessung.
- Erststart öffnet nur den aktuellen Bereich (bei Dashboard Aufträge); danach alle Gruppen, Untergruppen und Leistenbreite je Firebase-UID/tenantId in Browser-localStorage gespeichert. Initiale Standardzustände werden ebenfalls materialisiert; Kontowechsel remountet die State-Grenze. Alte kontoübergreifende Schlüssel nicht migrieren. Keine Cloud-/Gerätesynchronisierung.
- Rechte weiter ausschließlich `canAccessView`, jetzt je Link statt zusätzlicher grober Gruppen-Gates. Inventar bleibt mit Produkt-Leserecht sichtbar; Persönliche Daten nutzt sein bestehendes allgemeines Zugriffsrecht. Keine Auth-/Backend-/Routing-/Bestandsänderung.
- Nachweise: **537 Frontendtests, 6 lokale Browsertests, TypeScript und Produktionsbuild grün**. Unverändertes Backend: isolierte Baseline **5.659 Tests / 489 Dateien grün** (`GOOGLE_CLOUD_PROJECT=avycloud-local-test`, `GCLOUD_PROJECT=avycloud-local-test`, `FIRESTORE_EMULATOR_HOST=127.0.0.1:1`, `GOOGLE_APPLICATION_CREDENTIALS=/dev/null`). Hell/Dunkel visuell geprüft, 1024×600 mit gescrolltem Menü und erreichbarem Footer getestet.
- Quellen: Worktree `components/Sidebar.tsx`, `utils/sidebarNavigation.ts`, `utils/sidebarNavigation.test.ts`, `tools/navigation/sidebar.browser-test.mjs`, `docs/kb/05-pages/navigation.md`. Bestehende Rechte-/Titeltests an ausgelagerte Struktur angepasst, nicht abgeschaltet.
- **Kein Commit, Merge, Push oder Deployment für diesen Auftrag.** Frühere Releasefreigaben anderer Aufgaben gelten nicht dafür. Bei Fortsetzung Worktree verwenden, aktuellen Main auf parallele Änderungen prüfen; temporäre node_modules-Symlinks wurden nach Prüfung entfernt. Umfang und Vorschau: `/Users/oguz/Dev/avycloud/CODEX_NAVIGATION_20260927.md`.

## Produktionsauftrag vom 27.09.2026, 20:30 MESZ

Der Betreiber hat ausdrücklich klargestellt: Die Lösung soll nach den Tests auf Produktion. **Commit, PR/Merge und Deployment sind für diese Korrektur autorisiert; nicht erneut fragen.** Frühere Hinweise auf fehlende Freigabe weiter unten beschreiben nur den vorigen Stand.

- Aktuellen Oversell-Fix PR24 übernommen: Release-Basis `0c801ab6`, vorher produktiv Web `01820-lnj` / Worker `00275-gf2`. Nicht auf ältere Releases zurückrollen.
- Neue integrierte Abnahme: **5.639 Backendtests / 487 Dateien, 527 Frontendtests, TypeScript und Produktionsbuild grün**.
- Scope `identify.v2`, neue unveränderliche Version `capture-v2-20260927`, Vorgänger `NTRx6DzmgKcGcBtnIwl0`; exakte Prompt-/Schema-Quellen über [Release-Manifest](docs/releases/capture-quality-v2-prompt-manifest.json) festgehalten. Neue Version zunächst inaktiv vorbereitet; Aktivierung nach erfolgreichem Image-Rollout. Alte Felder, Modelle und Tenant-Konfiguration bleiben erhalten. Direkte SDK-Transaktion mit Vergleich des aktiven Vorgängers: bestehender `createScopeVersion()`-Helper aktiviert entgegen der Charta sofort und verliert zusätzliche Versionsfelder, deshalb nicht dafür verwenden.
- Zusätzlich echte Stage 1→4 mit Originalfotos und realen APIs lokal ausgeführt, Produkt-/Cache-Writes gesperrt, Uploads auf bereits vorhandene Quellbilder abgebildet. Ergebnis im privaten Nachweis. Produktions-Erfassungsroute besitzt keinen Dry-run; Duplicate-Reuse verändert Wareneingangsmenge. Niemals vorhandene Produkt-EAN zu Testzwecken erneut gegen die produktive Erfassungsroute senden.
- Release-/Revisionsnachweise werden nach Abschluss in `/Users/oguz/Dev/avycloud/CODEX_RELEASE_CAPTURE_QUALITY_20260927.md` und dem umfassenden Projektgedächtnis nachgeführt.

# Erfassung: Produktdatenblatt und Preis

Dieser Worktree gehört zum Auftrag, mangelhafte neue Datenblätter und fehlende Preise zu beheben. **Lokal implementiert und geprüft, kein eigener Commit, Push oder Deployment.** Das umfassende Projektgedächtnis liegt in `/Users/oguz/Dev/avycloud/CODEX_MEMORY.md`. Pflichtlektüre `AGENTS.md`, KB-Index, Agenten-Persona, `CLAUDE.md` und `TASKS.md` bleibt bindend.

- Worktree `/Users/oguz/Dev/avycloud-capture-quality-20260927`, Branch `codex/capture-datasheet-quality-20260927`, aktuelle Basis Main `810a0d76948271747086f97df0b72c06401f3c5d`. Ausgangsbasis `c2abecab`; den separat veröffentlichten Bildwerkstatt-Release konfliktfrei per Fast-forward übernommen. Fremde Änderungen im Hauptcheckout nicht übernommen.
- **[Vollständiger Befund, Proben und Release-Grenzen](docs/reports/capture-quality-2026-09-27.md)**. Reale Stichprobe seit 20.09.: 91 Erfassungen, davon 86 ursprünglich ohne Preis; alle 28 aktuell ausstehenden Produkte ohne Preis bei Erfassung. Alle 91 hatten fälschlich null Kategoriepflichtmerkmale im V3-Score.
- Taxonomie-Vertrag `requiredAspects` statt nicht existierendem `required`; reale Katalog-Fixture sichert das ab. `recommendedAspects` ebenfalls an Stage 3.
- Preisrecherche einmal pro V3-Erfassung, 45-Sekunden-Budget, parallel zur Textgenerierung; `_pendingPricing` vor Assembly/Bewertung/Save abwarten. Route überspringt erneute breite Recherche, wenn `meta.stages.stage2.pricingComplete`. Niemals einen späten alten Produktsnapshot als Preisnachlauf speichern.
- `capture-price.js` / `capture-web-price.js`: schneller Browse-/Händlerpfad, höchstens eine gemeinsame Suche und ein Gemini-Recherche-Rückfallweg. Direkte Händlerpreise ausschließlich aus passend identifiziertem JSON-LD-Product/Offer. Keine Versandpreise/fremden Produkte, kein unbelegter Fantasiepreis. Modellquellen zusätzlich laden und prüfen. Bestehende Refresh-/Chat-Preislogik bleibt Standard außerhalb `capture: true`.
- `capture-content-contract.js` v2: beide Textgeneratoren bekommen dieselben kategoriegerechten Highlight-Anzahl/-Längen, GPSR-Felder aus kanonischem `chat-datasheet-contract`, Variantenbindung und belegbare Empfehlungen. Vollständiger GPSR-Merge mit bisherigem Registry-Vorrang. URL-Attribute bis zum finalen Save ungekürzt; sonstige Text-/Attributregeln unverändert.
- Additive Diagnose in `ops.data_quality.identify_v3`: `capture_contract_version: 2`, `price_research.{completed,found,source}`, `content_generation.{agentic,fallback}`. Kein automatisches `sellPrice`, kein Status „Bereit“, keine Bestands-/OMS-/Listing-Mutation, kein Altprodukt-Backfill.
- Reale Proben: Träumeland Carefor Midi 46,99 € mit passender EAN/MPN und fünf gültigen Highlights; Steinel L 605 S final 102,32 € aus Lightkontor-Produktangebot in 2,94 s ohne Gemini-Preisaufruf. Content mit echten Fotos, aber Stage-1-Identität rekonstruiert; kein vollständiger Upload-/Save-End-to-End-Test. Keine Garantie vollständiger Preisabdeckung oder aller generierten Fakten.
- **Endabnahme: 5.596 Backendtests / 481 Dateien, 527 Frontendtests, Produktionsbuild und Diff-Prüfung grün.** Baseline vor eigenen Änderungen: 5.531 Backendtests. Letzter kompletter Lauf nach Integration von Main `810a0d76`. Test-/Probenbelege privat unter `/Users/oguz/Dev/avycloud-local-backups/capture-quality/20260927/`.
- Kein Produkt bei Proben gespeichert. Firestore-Schreibmethoden gesperrt; Telemetrieversuche abgefangen. **Storage-Import-Fußangel:** erste Probe speicherte bestehende Bucket-IAM-Policy erneut, Audit 27.09. 02:08:34 UTC mit leerem `policyDelta`, keine Berechtigungsänderung. Danach `lib/storage` vor allen App-Imports gesperrt. Probe-Script im privaten Archiv nicht unbedacht ohne diese Sperre ausführen.
- Neue Code-Prompt-/Schemaänderung ist noch nicht als Firestore-Scope-Version aktiviert. Vor späterem Release zusätzlich die verbindliche Scope-Versionierung nach `docs/standards/llm-quality-parity.md` abschließen; Code-Vertragsnummer ist kein Ersatz. Keine vollständige Migration der älteren Preis-LLM-Konfiguration behaupten. Aktuelle Produktion vor jedem Eingriff erneut prüfen.
- Installationen wurden nicht verändert. Für lokale Prüfungen waren die unveränderten vorhandenen `node_modules` temporär verlinkt; diese beiden Verweise werden nach der Prüfung wieder entfernt. Beim Fortsetzen Dependencies anhand der unveränderten Lockfiles bereitstellen.

Nur bei explizitem Commit-/Merge-Auftrag committen. Push auf Main löst Produktion aus. Frühere Freigaben anderer Features gelten nicht automatisch für diese Korrektur.

---

## Vorheriger versionierter Arbeitsstand (unverändert erhalten)

# Codex — AvyCloud Projektgedächtnis

Stand 20.09.2026. Pflichtlektüre aus AGENTS.md/CLAUDE.md bleibt maßgeblich. Die ausführliche Projektanalyse, Architektur und Claude-Historie liegt unter `/Users/oguz/Dev/avycloud/CODEX_MEMORY.md`; diese Datei hält den aktuellen isolierten Arbeitsstand fest. Produktionsänderungen haben direkten Einfluss auf den Betrieb von TrendOcean.


## 22.09.2026 — Zone X ohne neue BIN-Zuordnung räumen

- Nutzer hat nach Rückfrage ausdrücklich „keine bin zuordnung! zone X leeren!“ bestätigt. Produktionsauftrag gilt fort. Neues Paket auf Main `d2795461` in Branch `codex/zone-x-unassign-20260922`; die vorherige Zonenlöschung/Übersicht ist bereits produktiv (PR20).
- Neue geprüfte Räumung: `scripts/unassign-warehouse-zone.js`, dry-run default, explizit X/default, private Sicherung mit exklusivem Dateinamen, Firestore-SKU-Locks, Versionsprüfung und eine Transaktion für BINs, Produktpatches via `saveProductV2`, Delta-null-Ereignisse und tenantgebundenen `warehouseRelocations`-Beleg. Keine `inventory.quantity`-Änderung durch die Räumung, andere Zonen bleiben erhalten.
- `ops.relocation.unassignedQuantity` hält bereits gezählten Bestand ohne BIN. Reguläres Stow konsumiert ihn neutral, echte Retouren bleiben Zugänge. Versand und Reconciliation berücksichtigen den Marker. Refresh-CAS sowie finaler transaktionaler Fullsave-Guard verhindern Wiederherstellung alter Lagerdaten und Verlust des Markers. Keine neuen Routen, keine Auth-/Infra-Änderung.
- Frischer Dry-run vor Release: 46 X-BINs, 127 Einheiten, 100 vorhandene Produkte mit 126 X-Einheiten, Inventory-Summe 129 einschließlich zwei bestehenden L-Einheiten und einer vorher unlokalisierten Einheit. Eine verwaiste BIN-Einheit wird vollständig im Operationsbeleg gesichert, nicht als Produkt erfunden oder still verworfen. Private Sicherung außerhalb Git unter `/Users/oguz/Dev/avycloud-local-backups/zone-x/`.
- TDD: fehlender Umzugspfad, doppelte Stow-Zählung und verlorener Marker zunächst rot reproduziert; final 5484 Backendtests/464 Dateien grün. Unabhängige Review ohne verbleibenden Blocker. **Produktionsdatenaktion erfolgt erst nach erfolgreichem Deployment des Umzugspfads.** Exakten Release-/Räumungsnachweis anschließend im Hauptcheckout nachführen.
- Rückweg: nicht auf Code ohne Relocation-Unterstützung zurückrollen, solange unassignedQuantity positiv ist; aktuelle Bewegungen berücksichtigen, keine blinde Snapshot-Wiederherstellung.

## 22.09.2026 — Produktionsauslieferung ausdrücklich freigegeben

- Nutzer: „bitte schnell! und direkt auf prod!“ zu fehlender Zonenlöschung und anschließender Räumung X/EG. Dies autorisiert jetzt die erforderlichen Commit-/Merge-/Deploy-Schritte für Zonenlöschung und Übersicht; ältere Hinweise „keine Freigabe“ unten beschreiben den vorherigen Stand.
- Main vor Release unverändert `2e128bfe`, Web `01813-stb`, Worker `00268-9b7`, beide ready/100 %. Isolierter Branch unverändert. Unabhängige abschließende Read-only-Review ohne Releaseblocker, `git diff --check` sauber.
- Die getrennte produktive Datenaktion X/EG ist noch in Vorbereitung: Zielort und genaue Etagenabgrenzung wurden asynchron erfragt. Bestände dürfen bei physischem Umzug nicht über normale Auslagerung reduziert werden. Keine Bestandsänderung oder Räumung durch diesen Code-Release.
- Ergebnis/Revisionen und Räumungsnachweis werden nach Ausführung im Hauptcheckout dokumentiert.

## 21.09.2026 — Ergänzung: falsche Zonenübersicht korrigiert (lokal fertig, nicht deployed)

- Folgeauftrag: S/EG hat sechs Gänge und viele BINs, die Übersicht zeigte jedoch einen BIN und „Gänge 5“. Ursache bestätigt: `createWarehouseLayout()` speichert im Zonendokument nur den zuletzt generierten Ausschnitt; `listWarehouseZones()` verwendete dessen `binCount/gangs/regale/ebenen` für die gesamte Zone. „Gänge 5“ bezeichnete zusätzlich unklar die Gangnummer 5, nicht fünf Gänge.
- `listWarehouseZones()` aggregiert jetzt die ohnehin gelesenen tatsächlichen BINs: Gang-/Regalnummern und Ebenen sortiert/eindeutig, BIN-Gesamtzahl, additiv `rootBinCount`, `containerCount`, `shelfCount` (unterschiedliche Gang/Regal-Paare). Stückzahl aus `products[].quantity`, nur ohne Array Rückfall auf `productCount`. Keine zusätzlichen Firestore-Abfragen, Migrationen oder Bestandswrites. Der bestehende Layout-Erzeugungspfad wurde nicht verändert.
- UI: z. B. „120 BINs · 2.720 Stück“, darunter „84 Lagerplätze · 36 Behälter“, „Gänge (6): 1, 2, 3, 4, 5, 6 · Regale (12): Nr. 1, 2 · Ebenen: A, B, C, D, E, F, G“. Neue optionale Felder in `WarehouseLayout` halten ältere API-Antworten kompatibel. Zusammenfassung aktualisiert nach Behälteränderungen/Auslagerung; BIN-Auswahl bleibt dabei erhalten.
- **Produktionsdaten nur gelesen**, keine Mutation. Neue echte `listWarehouseZones()`-Implementierung zusätzlich in einem Prozess mit ausschließlich lesendem Firestore-Adapter ausgeführt. Momentaufnahme 21.09.2026 14:23 MESZ (`/tmp/avycloud-zone-summary-live.json`): S/EG 6 Gänge, 12 Regale, 120 BINs = 84 Lagerplätze + 36 Behälter, 2720 Stück; L/EG 4 Gänge, 20 Regale, 100 BINs, 663 Stück; XS/GA 1 Gang, 2 Regale, 4 BINs, 8 Stück; X/EG 1 Gang, 1 Regal, 7 BINs = 6 Lagerplätze + 1 Behälter, 93 Stück; XQ/GA und X/GA leer. Veränderliche Werte, keine festen Sollzahlen. X/EG war beim früheren Lesen noch 83 Stück — Betrieb läuft weiter.
- Prüfung: acht neue Backend-Regressionen (vor Fix sieben rot), insgesamt **5399 Backendtests/460 Dateien**, **494 Frontendtests**, **8 Browserprüfungen**, TypeScript und Build final grün. Ein erster Gesamtlauf hatte einmal 404 statt 200 im unveränderten Inventurtest `warehouse-inventory-complete-booking.test.js` (Fehler/Wiederholung-Fall, Zeile 437); gezielte Wiederholung und kompletter Folgelauf grün. Ursache dieser Instabilität nicht geklärt, keinen fremden Test abgeschwächt.
- Logs `/tmp/avycloud-zone-summary-{backend,backend-recheck,frontend,tsc,build,browser,recheck}.log`; Kartenansicht Hell/Dunkel `/tmp/avycloud-zone-summary-{dark,light}.png` visuell geprüft. `backend/__tests__/warehouse-zone-summary.test.js` und bestehende Browserdatei erweitert. Doku/Projektgedächtnis nachgeführt.
- Gleicher Branch/Worktree wie Zonenlöschung. **Noch kein Commit/Merge/Deployment und keine neue Freigabe dafür.** Testabhängigkeiten wurden vorübergehend aus dem Hauptcheckout verlinkt; Links nach Prüfung entfernt, bei Wiederaufnahme Dependencies erneut bereitstellen.

## 21.09.2026 — ungenutzte Lagerzonen löschen (lokal fertig, nicht deployed)

- Auftrag: Zonen wie XQ/GA mit 0 BINs müssen aus der Lagerverwaltung entfernt werden können. Ursache: UI/Backend boten nur Gang/Regal/Ebene; `recomputeWarehouseZoneLayout()` ließ den leeren Zoneneintrag bestehen.
- Branch `codex/warehouse-zone-delete-20260921`, Worktree `/Users/oguz/Dev/avycloud-warehouse-zones`, Basis Main `2e128bfe`. Hauptcheckout mit fremden Änderungen bleibt erhalten. Dieser Auftrag enthält **keine Commit-/Merge-/Deploy-Freigabe**; frühere Freigaben in dieser Datei gehören zu anderen Aufgaben.
- Neu: „Zone löschen“ → Vorprüfung → Bestätigung mit Zone/Etage und BIN-Anzahl. Danach Zonenliste/aktuelle Auswahl/BIN-Details/Druckauswahl aufräumen. Null-BIN-Zonen und Zonen mit ausschließlich leeren BINs/Behältern sind unterstützt; andere Etagen bleiben erhalten.
- `DELETE /api/warehouse/layouts/:zone/:etage`, Recht `warehouse.configure`, standardmäßig dryRun, Löschung nur `confirm=1`. Neue Funktion `deleteWarehouseZone()` in `backend/lib/warehouse.js`: komplette Bestandsprüfung und Zone-/BIN-Löschung plus `zone_delete`-Audit in einer Firestore-Transaktion. Positive/unprüfbare Mengen und fremde/widersprüchliche Zuordnungen verhindern die gesamte Aktion. Keine Produkt-, Bestands-, OMS- oder Marktplatzmutation.
- Legacy-Besonderheit: Lagerlayout- und BIN-Erstellung speichern bisher kein `tenantId`. Bestehende Slice-Query wird wiederverwendet, jeder gelesene Datensatz vor Änderung geprüft; fehlendes `tenantId` gilt nur für `default`. Ein Filter allein würde belegte Alt-BINs übersehen. Kein globaler Tenant-Umbau in diesem Fix.
- Verifikation: Ausgangsstand 5361 Backendtests + Build grün; neue Regression zunächst rot. Final 5391 Backendtests/459 Dateien, 494 Frontendtests, TypeScript und Build grün. Sechs Browserprüfungen mit echter View/API-Client und lokalen Fixtures (keine Produktion) grün; Hell/Dunkel visuell geprüft. Backend deckt Stock zwischen Vorprüfung/Bestätigung sowie simulierten Transaktionsretry und Commitfehler ab; kein echter Firestore-Last-/Parallelitätstest.
- Browserprüfung: `node --test tools/warehouse/zone-delete.browser-test.mjs`; benötigt Playwright Chromium. Screenshots `/tmp/avycloud-zones-{dark,light}.png` und `/tmp/avycloud-zones-dialog-{dark,light}.png`. Vollsuite-Logs `/tmp/avycloud-zones-{backend,frontend,tsc,build,browser}.log`. Doku unter `docs/kb/05-pages/warehouse.md`, `06-features/warehouse-bins.md`, `09-api/warehouse.md` ergänzt.
- Vor Veröffentlichung: diff/Branch und aktuellen Main prüfen, nur diese Änderungen committen; Produktiv-Auslieferung erst nach ausdrücklicher Freigabe. Keine echte Lagerzone zu Testzwecken gelöscht.

## 21.09.2026 — editierbare Rollenrechte und Manager-Rechnungen

Auftrag: Yasemin als Manager muss Rechnungen erstellen können; der Inhaber bestimmt Rechte pro Rolle selbst, sofort umsetzen und produktiv ausliefern. Autorisiert Auth/RBAC-Änderungen, Commit/Merge und Deployment. Vorherige Entscheidung für unveränderliche Rollen ist damit ersetzt; keine Rückfrage nötig.

- Manager-Defaults jetzt `invoices.read/write`. Finanzberichte, Unternehmensdaten und Erstattungen weiterhin getrennte, standardmäßig gesperrte Rechte.
- Kompakte Rollenansicht mit einzelnen Checkboxen, Suche, Speichern/Verwerfen. Backend erlaubt nur den definierten Katalog und prüft Arbeits-/Leseabhängigkeiten; UI schaltet Voraussetzungen mit. Admin sowie Konten-/Rechteverwaltung bleiben unveränderlich beim verifizierten Inhaber.
- Neue tenantgebundene Collection `accessRolePolicies`, ein Dokument je Tenant/Rolle; vollständige Matrix, Revision, Schema, Akteur. Speicherung + Audit atomar; 409 bei veraltetem Stand. Keine Wiederbelebung historischer Rollen/Overrides/Gruppen. Fehlende Policy → Defaults, fehlerhafte Policy → kein Zugriff; Entzug wirksam bei nächster Anfrage, kein übergreifender Rechtecache.
- Rechnungsroute prüft Tenant vor MwSt.-Speicherung. Keine automatische Rechnungsausstellung, keine echten Rechnungen beim Test erzeugt, keine Nutzerzuordnung verändert.
- Basis `21042628` (PR18). Vor Auslieferung Web `01812-hkt`, Worker `00267-24n`. Branch `codex/role-permission-editor-20260921`, isoliert in `/Users/oguz/Dev/avycloud-role-editor`.
- Prüfung: 5361 Backendtests/458 Dateien, 494 Frontendtests, TypeScript + Produktionsbuild grün. UI mit lokalen Beispieldaten: Rechte ändern/speichern, Bestätigung und Hell/Dunkel geprüft. Produktivstand wird im Hauptcheckout nachgeführt.
- Rollback vor diesen Code ignoriert Custom-Policies und reaktiviert damalige Defaults: individuell entzogene Rechte vorher berücksichtigen.


## Rollenbereinigung: produktiv abgeschlossen

PR [#9](https://github.com/kulacogo/avycloud/pull/9), Main `1fe401cd3339d045c40caf9b44fc4553eba985d7`. Freigegeben durch „ok los“ und ausdrückliche Fortsetzung am 20.09.; die vorherige Mahmoud-Rückfrage ist erledigt. Web `product-hub-backend-01803-9k2`, Worker `product-hub-worker-00258-zps`, Hosting `b015fc975fab2d48` waren beim Abschluss ready/100 %. Detaillierter lokaler Nachweis: `/Users/oguz/Dev/avycloud/CODEX_RELEASE_ROLES_20260920.md`. Vor weiteren Eingriffen veränderliche Werte frisch prüfen.

- Oguz/admin@ alleiniger Admin; Efe/Yasemin Manager; Hüseyin/Semih Mitarbeiter; Fatih/Selahattin Partner (operative und Finanz-Leserechte).
- Ops Dev: Entwickler, operative/technische Leserechte ohne Finanzen, Personal oder Zugänge. Scanner Support gesperrt; Mitarbeiter nutzen persönliche Konten.
- Mahmoud vorläufig Nur Lesen. **Der Inhaber stellt dessen endgültige Rolle selbst ein.** Nicht eigenständig hochstufen und nicht erneut nachfragen.
- Versionierte Policy `backend/lib/access-profiles.js`, additives `users.accessRole`. Historische Rollen/Gruppen/Overrides bleiben gespeichert, werden aber nicht ausgewertet/angezeigt.
- Gewicht-only `orders.pack`, Versand/Druck `orders.ship`, sonstige Auftragskorrektur `orders.edit`. Normale Arbeit benötigt kein Adminprofil.
- Migration `default_access_profiles_v1` am 20.09.2026 00:56:41 MESZ atomar für zehn Profile plus Backup angewandt. **Nicht erneut migrieren.**
- Vorbestehender Druckagent-Ausfall ist separate Hardware-/Diensteinrichtung, nicht durch Rollen/UI zu lösen. Keine physische Hardwareprüfung behaupten.

## Teamoberfläche: produktiv abgeschlossen

PR [#10](https://github.com/kulacogo/avycloud/pull/10), Main `eb4b850cca484557b8f35fd0ea1a59f884ede65c`. Web `01804-xjr`, Worker `00259-xx7`, Hosting `e5accd956232d706` nach Abschluss ready/100 %. Benutzer hat zusätzlich „los rüber auf prod wenns fertig ist“ angewiesen. Nachweis im Hauptcheckout `CODEX_RELEASE_TEAM_UI_20260920.md`. Rollen, Mitarbeiterkarten und Profilvergleich bleiben maßgeblich; die damalige Ansicht einzelner Leistungskennzahlen wird vom folgenden Auftrag ersetzt.

## PR #11 ausgeliefert, Bewertung fachlich vom Betreiber verworfen

Main `7be8d302eb61a457a67064cd8aa291bc2336ba24`, Web01805-zbc/Worker00260-j47/Hosting4d3131fee2a8e8a9 technisch erfolgreich ausgeliefert. **Die Gewichte 5/2/2/1/3 und der pauschale Pflegeabzug sind fachlich falsch und gelten nicht weiter.** Technische Releaseprüfung war keine fachliche Bestätigung. Nachweis im Hauptcheckout `CODEX_RELEASE_TEAM_PERFORMANCE_20260920.md`.

## Aktuelle Korrektur: Arbeitsaufwand nachvollziehen

Betreiber konkret am 20.09.: Anreicherung/Prüfung/Korrektur bis Bereit dauert am längsten; dann Erfassen mit Fotos; dann Packen mit Karton und Wiegen; zuletzt schnellster Pick. Nicht erneut nach Richtzeiten fragen. Abgebildet als Aufwandsstufen Pflege4/Erfassen3/Pack2/Pick1, einfache Einlagerung vorläufig Basis1 (eigene Einordnung, keine Betreiber-Zeitangabe). Diese Stufen sind keine gemessenen Zeitverhältnisse oder Qualitätsgrade. Der verworfene Vorschlag einer Richtzeitkonfiguration wird nach der konkreten Betreiberanweisung nicht gebaut.

Isolierter Worktree `/Users/oguz/Dev/avycloud-team-effort`, Branch `codex/team-effort-calibration-20260920`, Basis `7be8d302`. Quelle: `ProductSheet.handleToggleEdit` speichert beim Öffnen automatisch; `handleReadinessChange` markiert Bereit. Audit-Diff erfasste ops.readiness bislang nicht. Deshalb einfache Save-Zahl weder Datenarbeit noch Abschlussnachweis.

Korrektur: bestehendes Audit erfasst readiness-Diff. Leistungsabruf ergänzt productCareEdited/productReady und Beitragsschema2. Pflege zählt bei dokumentierter Datenblattänderung oder Statuswechsel zu Bereit einmal je Produkt/Konto/Fenster, zusätzlich zur Erfassung; keine Klick-/Mehrfachsavepunkte. Alte Rohwerte/Overlap-Metadaten bleiben kompatibel erhalten. Vergangene Prüfungen ohne Datenänderung bleiben unbelegt; keine rückwirkende Attribution über heutige Produktzustände/Initialen. Keine Konten, Auth, Bestände, OMS oder Speichermutation verändert.

Lokal grün: Backend5230/450 Dateien, Frontend476, TypeScript/Build. Neue Tests und Browserprüfung decken tatsächliche Arbeitsfälle ab. Historischer Prüfstand vor PR12; PR12/Main f3529112 wurde danach produktiv ausgeliefert. Die Inhaltsklassifikation war noch zu breit, siehe aktuelle Korrektur unten. Testadapter/Node-Symlinks nie committen. Inhaber stellt Kontenprofile weiterhin selbst ein.

## Kundensupport — bestätigte Zuordnung und Umsetzung 20.09.2026

Aktuell maßgeblich: Inhaber bestätigt EIN Firmenkonto je Marktplatz und AUSSCHLIESSLICH Yasemin für Kommunikation. Damit ist die vorherige Zuordnungsfrage erledigt. Keine weiteren Fragen nach Einzelkonten, kein neues Inbox-Projekt. Arbeitsablauf bleibt Kaufland-Tickets/eBay-Nachrichten. Keine Rollen-/Kontenänderungen; Inhaber stellt Profile selbst ein.

Supportnachtrag im isolierten Worktree `/Users/oguz/Dev/avycloud-team-support`, Branch `codex/team-support-performance-20260920`, Basis PR12/Main f3529112. Kaufland echte Händlerantworten verfügbar; eBay benötigt commerce.message, aktueller Token liefert403. Identity apiz/v1 live200. Neuer lesender separater Supportabruf, je Anliegen/Fenster einmal, explizite alleinige Zuständigkeit über support_assignments/default. Vorläufig Support3Punkte je Anliegen als offengelegte Aufwandsannahme, nicht gemessene Zeit. Keine Kundeninhalte an UI, keine Nachrichtenaktionen. Fehlende Quellen => Untergrenze ohne Ranking; Details erst nach Personenauswahl. OAuth-Erweiterung bewahrt vorhandene Grants und Refresh. Einrichtung und Quellen siehe docs/features/team-workspace/spec.md. Deployment autorisiert durch vorhandenes „los rüber auf prod wenns fertig ist“; PR13/Main4b6e0c26 produktiv abgeschlossen; Web01807-q46, Worker00262-vmk, Hosting08a3386270bd3095 beim Abschluss bereit.

Prüfstand vor Auslieferung: 5.253 Backendtests/452 Dateien, 479 Frontendtests, TypeScript und Produktions-Build grün. Ein einmaliger Timeout im unveränderten Inventurtest war isoliert und im anschließenden Gesamtlauf grün; kein Inventurcode geändert. Browser: Desktop dunkel,390px hell/dunkel, Auswahl/Details, vollständige/fehlende/fehlerhafte Supportquelle, keine horizontale Überbreite. Lokaler Testadapter hatte zunächst fehlende hasPermission-Testfunktion, korrigiert; echte AuthContext-API unverändert.

Am 20.09.2026 08:53:04 UTC support_assignments/default nach erfolgreichem Dry-run einmalig mit create angelegt: bestätigte Zuständigkeit von Yasemin Kulacoglu. Keine users-/Rollenmutation. Neuer Service danach gegen echte Quellen lesend geprüft: letzte7Tage Kaufland13Anliegen/20Händlerantworten (39Punkte), eBayconnection_required, complete=false. Bekannte eBay-Identität über offizielle apiz/v1-Route liveHTTP200. Git/Deployment noch offen.

## Datenpflegezuordnung — aktuelle Korrektur 20.09.2026

Betreiberbefund bestätigt: Efe/Hüseyin überwiegend Erfassung/Logistik, Yasemin hauptsächlich Aufbereitung. Bisherige Regel wertete bereits condition=new, null→leere Kennnummern und automatische GPSR-Registry-Hydration als Pflege. Fehler der bisherigen Implementierung; nicht mit Mitarbeiterrollen zurechtbiegen.

Branch codex/team-care-attribution-20260920, Basis PR13/Main4b6e0c26. Inhaltliche Vorher/Nachher-Klassifikation, audit-only Kontext capture/datasheet/ownership/pricing, additive productContentEdited und Beitragsschema3. Union aus Inhaltsarbeit/Freigabe dedupliziert, beide Nachweise separat sichtbar. Keine vollständige Prüfung allein aus Inhaltsänderung behaupten. Historische Bereit-Abschlüsse vor Audit-Erweiterung20.09. bleiben unbekannt. Keine Audit-/Produktdatenmutation, kein Backfill, keine Rollen-, Gewichtungs-, Logistik-, Support-, Auth- oder Infrastrukturänderung.

Lesender Replay letzte7Tage: Efe61→1, Hüseyin61→1, Yasemin166→148 belegte Inhaltsänderungen. Benutzernamen/UIDs sind keine Klassifikationsregel. Rohdaten bleiben privat außerhalb Git. Backend5265/453Dateien grün; einmaliger socket-hang-up im unveränderten Versandlabeltest sowohl isoliert als im Gesamtwiederholungslauf grün. Frontend479, TypeScript/Build grün; Browser Desktop/390px und gemischter Rollout geprüft; Releaseabnahme noch ausstehend. Standing Deploymentauftrag „los rüber auf prod wenns fertig ist“ gilt. Ausführlicher Nachweis im Hauptcheckout CODEX_RELEASE_TEAM_CARE_20260920.md.

## Aktuell: kompakte Leistungsoberfläche — 20.09.2026

Betreiber lehnt die überladene UI mit Erklärungen/Rechtfertigungen ausdrücklich ab und verlangt zügige Umsetzung+Produktion ohne wiederholte Prüfrunden. Normalansicht auf Kennzahlen/Bedienelemente reduzieren; Methodik nur auf Abruf. Branchcodex/team-compact-ui-20260920, BasisPR14/Main30d0a896. Kleiner Supportstatus statt großem Doppelblock, Tabelle statt aufgeblähter Detailkarte, keine leere Seitenspalte. Berechnung, Gewichtung, Attribution, Rechte und Backend unverändert. Tests für unveränderte Beiträge und fehlende Quellen ergänzt. Bereits vorhandene Deploymentfreigabe erneut bestätigt. Releaseabschluss im Hauptcheckout CODEX_RELEASE_TEAM_COMPACT_20260920.md.

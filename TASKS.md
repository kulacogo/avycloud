# TASKS.md — AvyCloud Aktive Tasks

> Letzte Aktualisierung: 2026-03-26
> Nur aktive Items. Erledigte Tasks → `git log`. Bug-Historie → `docs/archive/`.

## Zu verifizieren (deployed, Browser-Check nötig)

- [ ] FIX-2: Inventar → Bestandswert KPI > €0
- [ ] FIX-3: Versand → keine englischen Status-Strings
- [ ] FIX-4: Retouren → Produktname statt SKU
- [ ] FIX-5: Bestellungen/Retouren → eBay-Badge gleiche Farbe
- [ ] FIX-6: Bestellungen → alle Orders zeigen "eBay" oder "Kaufland" Badge
- [ ] FIX-7: Versand → "Sync" klicken → Kundenname-Spalte füllt sich
- [ ] FIX-8: Dashboard → Sync-Fehler = 0
- [ ] FIX-9: Theme Toggle → data-theme ändert sich in DevTools
- [ ] FIX-10: Dashboard-Zahl = Seiten-Zahl für Retouren
- [ ] FIX-11: `node backend/scripts/backfill-weights.js --write` ausführen
- [ ] FIX-12: SSE-Streams funktionieren ohne Token in URL

## Aktive Bugs (P0/P1)

- [x] **BUG-079** Multi-Identify liefert nur letztes Produkt — sequentiell statt parallel, Focus-Logik + JobStatusPopup Summary
- [x] **BUG-080** LLM-Pipeline Qualität — 8 Fixes: QualityGate ON, Retry, Schema, Improve-Tracking, Evidence-Hierarchie, Gewicht, Preis
- [x] **BUG-081** products Collection noch als Primary Read — alle Reads auf products_v2, warehouse dual-write
- [x] **BUG-078** BIN-Löschung blockiert obwohl Bestand = 0 — nonEmpty-Filter gefixt (products.some statt products.length)
- [ ] **BUG-082** ~1084 Ghost-Produkte in products_v2 (P0)
  - Typ 1: UUID als Titel/ID (z.B. 0060cdec-9193-411b-af64-4754ca0226bd)
  - Typ 2: EAN/Barcode als Titel (z.B. 00442039661193)
  - Typ 3: Nur SKU, keine Daten (z.B. SKU-0698797502)
  - Typ 4: "Unbekanntes Produkt" ohne Inhalte
  - Root Cause: pickProductId() nutzt EAN als docId, UUID-Fallback, Quality Gate war off
  - Audit-Script: `node backend/scripts/audit-ghost-products.js` (dry-run), `--apply` zum Löschen
  - Safety: Produkte mit Bestellungen/Listings werden NICHT gelöscht
  - Prevention: Validation in saveProductV2() nötig nach Cleanup
- [x] **BUG-083** ProductSheet zeigt "keinem BIN zugeordnet" obwohl Tabelle + Warehouse BIN zeigen (P0)
  - Root Cause: `listBinsForProduct()` matchte nur Input-Parameter, nicht alle Produkt-Identifier
  - Fix: Lädt jetzt Produkt-Dokument und baut vollständiges keySet (docId + SKU + EAN + Barcodes)
  - ✅ Fix in `backend/lib/warehouse.js`, alle 263 Tests grün
- [x] **BUG-084** Dual-Write liest aus falscher Collection — manuelle Änderungen werden überschrieben (P0)
  - Root Cause: `saveProductV2()` Dual-Write las aus `COLLECTION` ('products') statt `PRODUCTS_COLLECTION` ('products_v2')
  - Fix: Zeile 48-49 in `product-store.js` nutzt jetzt `PRODUCTS_COLLECTION` aus `firestore.js`
  - ✅ Fix in `backend/lib/product-store.js`, alle 285 Tests grün
  - ⚠️ Deploy nötig (Cloud Run)
- [ ] **BUG-085** Dual-Write erzeugt Duplikate durch `_pickCanonicalId` (P0)
  - Symptom: Gleicher Artikel 2x in Inventar-Tabelle (identische SKU, EAN, Preis, BIN)
  - Root Cause: `saveProduct()` schreibt unter Original-ID, Dual-Write normalisiert → `_pickCanonicalId()` ändert ID zu EAN → zweites Dokument
  - ✅ Fix A: Dual-Write Guard in `product-store.js` (Skip wenn `PRODUCTS_COLLECTION === V2_COLLECTION`)
  - ✅ Fix B: Cleanup-Script `backend/scripts/dedupe-products-v2.js` (dry-run default, `--apply`)
  - ✅ Fix C: `_pickCanonicalId` in `product-canonical.js` → speichert nur als `ops._canonicalId`
  - ✅ Alle 300 Tests grün
  - ⚠️ **Deploy nötig (Cloud Run)** — dann `node backend/scripts/dedupe-products-v2.js --apply` ausführen
  - ⚠️ Nebeneffekt: "KI Verbessern" wirft "Produkt wurde nicht gefunden" + "Anker Anker" Doppel-Brand → löst sich nach Deploy + Cleanup
- [ ] **BUG-090** Gruppierung fällt auf Fallback bei vielen verschiedenen Produkten (P0)
  - Symptom: 22 verschiedene Bilder → KI erkennt "1 Produkt", alle in eine Gruppe
  - Root Cause: Gemini gibt leere Response bei >10 Bildern (Token-Limit), Prompt sagt "Im Zweifel alles in EINE Gruppe", stiller Fallback
  - Fixes: Bild-Kompression, Prompt umschreiben (separate statt zusammenfassen), Structured Output, Error-Logging
  - Prompt: `docs/prompts/bug-090-grouping-fallback-22-images.md`
- [ ] **BUG-091** Multi-Identify hängt bei vielen Produkten — kein Timeout, kein Progress (P0)
  - Symptom: 9 Produkte → Step 3 bleibt bei "Produkt 1 von 9" hängen, kein Fortschritt
  - Root Cause: `identifyProductV2()` hat kein Timeout, Pipeline dauert 90-160s/Produkt, 9×sequentiell = 18 Min
  - Fixes: Frontend Timeout (180s), Phase-Progress im Multi-Modus, Cloud Run Timeout 600s, Parallelisierung (3 concurrent)
  - Prompt: `docs/prompts/bug-091-multi-identify-hangs-no-timeout.md`
- [ ] **PERF-001** Identify+Improve Pipeline Overhaul — Google Search Grounding (P0)
  - **Ansatz:** 1 Gemini-Call mit Google Search Grounding + Structured Output + Bilder statt 10 sequenzieller Steps
  - Gemini sucht SELBST im Web (Preise, Specs, GPSR, Bilder) — kein separater BrightData/SerpAPI-Overhead
  - `identifyProductWithGrounding()` in `gemini3-client.js` — nutzt `@google/genai` SDK (v1.44)
  - `identify.js`: Grounding Primary, Legacy Fallback (`IDENTIFY_GROUNDING=true/false`)
  - `improve.js`: Gleiche Grounding-Pipeline, Legacy Fallback
  - ✅ Implementiert, 316 Tests grün, Syntax OK
  - ⚠️ **Deploy nötig + Live-Test mit echten Produkten**
  - Ziel: 30-50s statt 125-270s, Qualität wie Cowork-Demo
  - Prompt: `docs/prompts/perf-001-identify-pipeline-overhaul.md`
- [ ] **BUG-086** Improve-Pipeline extrem langsam (~90–160s) (P1)
  - 5 Bottlenecks: Bild-Download sequentiell, Barcode Web-Confirm redundant, Web Evidence 2× geprefetcht, Datasheet Review 2–3×, kein Streaming
  - Optimierungsplan: Parallel-Downloads, Evidence-Dedup, Review 1×, Steps parallelisieren, SSE → Ziel: ~25–45s
  - Prompt: keiner nötig, Analyse ist in Chat-Session dokumentiert
- [ ] **BUG-087** Chat findet keine Web-Bilder über predefined Prompt (P1)
  - Tool-Einschränkungen in Chat/Improve/Identify müssen analysiert + gelockert werden
  - Ziel: LLMs sollen frei suchen können (Web Unlocker, beliebige Search Engines, nicht nur Marktplätze)
  - 4 Einschränkungen: `sites`-Param gestripped, Amazon/eBay Engine-Remap, Bildersuche nur über Regex, kein agentic Loop in Identify/Improve
- [ ] **BUG-088** Identify/Improve fügen keine Produktbilder aus dem Web hinzu (P1)
  - Aktuell: Nur hochgeladene Bilder werden gespeichert, kein Web-Image-Search in der Pipeline
  - Ziel: 3 hochwertige Produktbild-URLs aus dem Web automatisch hinzufügen (Google Images / Hersteller-Seiten)
  - Ansatz: Nach Identify/Improve einen Image-Search-Step (SerpAPI `google_images` + BrightData Unlocker Probe) einbauen
- [ ] **BUG-089** Price Engine liefert falsche Preise — Vergleichslinks zeigen andere Produkte (P1)
  - Symptom: Preisvergleich-URLs führen zu komplett anderen Produkten als im Datenblatt
  - Root Cause: Suchquery zu generisch (nur Kategorie/Marke), kein Abgleich ob das Suchergebnis tatsächlich dasselbe Produkt ist
  - Ziel: Produkt-Matching vor Preisübernahme (EAN/GTIN-Match, Titel-Similarity, Brand-Match)
  - Betroffene Dateien: `backend/lib/price-enrichment.js`, `backend/services/enrichment.js` (`ensurePriceCoverage`)
- [ ] **BUG-092** Versand: Duplikat-Einträge + falscher "Problem"-Status bei versendeten Paketen (P1)
  - Symptom: Bestellung 17-14373-89235 hat 2 Einträge in Versand-Tabelle — 1× mit Tracking (Ausstehend), 1× ohne Tracking (Problem)
  - SendCloud zeigt nur 1 Paket: "Paket unterwegs", Tracking 01596811364368, DPD Classic
  - Root Cause 1: `syncSendCloudParcels()` hat keine DB-Level Idempotenz — nur In-Memory `existingParcelIds`, Race bei concurrent Syncs
  - Root Cause 2: Webhook + Sync-Race — Webhook updated Status, parallel Sync erstellt neues Dokument
  - Root Cause 3: Status-Mapping fehlt für "unterwegs" Status-IDs (z.B. 3,4,5 → `in_zustellung`)
  - Betroffene Dateien: `backend/services/shipping-engine.js` (syncSendCloudParcels, mapSendCloudStatus), `backend/routes/webhooks.js`
  - Frontend-Workaround existiert bereits: `ShippingView.tsx` dedupliziert per `sendcloudParcelId` (aber DB bleibt verschmutzt)
  - Prompt: `docs/prompts/bug-092-shipping-duplicate-problem-status.md`
- [ ] **BUG-093** Evidence-Source-Links in Preisdaten führen nie zum Produkt (P1)
  - Symptom: Alle "Evidence sources" im Produktdatenblatt (Stammdaten → Preis & Lager) zeigen URLs die nicht zum Produkt führen
  - Beispiel: BILSTEIN B4 19-264431 → Amazon-Link gibt 500, kfzteile24-Link leitet auf Homepage, teilehaber-Link gibt 403
  - Problem gilt für ALLE Produkte — Links sind unvalidiert und veraltet/falsch
  - Root Cause: `price-enrichment.js` / `enrichment.js` speichert URLs ohne zu prüfen ob sie tatsächlich das Produkt zeigen
  - Ziel: Links vor Speicherung validieren (HTTP-Status + Produkt-Matching via EAN/MPN/Titel), tote Links nicht anzeigen
  - Betroffene Dateien: `backend/lib/price-enrichment.js`, `backend/services/enrichment.js`, Frontend: `components/ProductSheet.tsx`
- [ ] **BUG-094** Chat-Kategorien werden nach Sekunden wieder überschrieben + veraltete eBay-Kategorien (P1)
  - Symptom 1: KI-Assistent schlägt korrekte Kategorie vor, wird ins Datenblatt übernommen, springt nach wenigen Sekunden zurück zur alten (falschen) Kategorie
  - Root Cause 1: Vermutlich Race Condition — Chat speichert Kategorie, aber ein paralleler Sync/Auto-Save überschreibt mit alten Daten
  - Symptom 2: LLM-Features schlagen veraltete/falsche eBay-Kategorien vor weil keine aktuelle Kategorie-Datenbank existiert
  - Root Cause 2: Kein lokaler eBay-Kategorie-Cache — LLM rät Kategorien aus Training-Daten
  - Lösung: eBay-Kategorien alle 30 Tage via `GetCategories` API abrufen und in Firestore cachen (`ebay_categories` Collection). LLM bekommt aktuelle Kategorien als Kontext bei Identify/Improve/Chat. Sicherstellt dass nur gültige, aktuelle Kategorien vorgeschlagen werden.
  - Betroffene Dateien: `backend/lib/ebay-api.js` (neuer GetCategories Call), `backend/services/product-chat.js`, `backend/lib/gemini3-client.js`, neues Script: `backend/scripts/sync-ebay-categories.js`
- [ ] **BUG-068** 170 Stock-Sync Fehler — Oversell-Risiko (abhängig von eBay Token Fix)
- [ ] **BUG-069** Dashboard Chart endet bei ~12.03 (createdAt-Datumslogik)
- [ ] **B5** Invoice Email-Versand fehlt
- [ ] **B6** Gutschriften/Stornorechnungen fehlen
- [ ] **BUG-070** Marketplace Listing-Tabellen: falsche Daten + inkonsistente UI (P1)
  - eBay: Lager-Spalte zeigt "—" für die meisten Artikel obwohl Bestand vorhanden
  - eBay: Verkaufte/inaktive Artikel zeigen Lagerbestand (z.B. Engelbert Strauss: 3, aber Inaktiv)
  - Kaufland: Aktive Angebote mit Marktplatz=0 und Lager=0 (Hermès, Wera, KNIPEx etc.)
  - Kaufland: Preis-Spalte zeigt "—" für viele aktive Artikel
  - Kaufland: Kategorie-Spalte durchgehend leer
  - Inkonsistente Spalten zwischen eBay/Kaufland (Item-ID vs Unit-ID, unterschiedliche Layouts)
  - "Letztes Update" fehlt bei eBay komplett, bei Kaufland teilweise
  - BEWEIS: BEAUTEX SKU-3210037840 → Inventar zeigt Menge=1, Lagerplatz=XGA0201C, EK=13,99€ — eBay Listing zeigt Lager="—", Kategorie="—"
  - Lager/Kategorie/Lagerplatz aus products_v2 werden NICHT ins eBay Listing übertragen
- [ ] **BUG-071** Bestellungen: Pipeline-Zahlen inkonsistent mit Tab-Zahlen (P1)
  - Pipeline zeigt: 22 Neu + 6 Bestätigt + 341 Versendet = 369
  - Tabs zeigen: Alle 490, Neu 28, Versendet 411, Sonstige 51
  - Weder Pipeline noch Tabs summieren sich korrekt
- [x] **BUG-072** Versand-Tabelle: Geisterdaten + BaseLinker-Referenz (P0!)
  - ✅ BaseLinker-Badge gefiltert (bereits vorher)
  - ✅ Zustellquote gefixt (bereits vorher)
  - ✅ Versandkosten 0€: CSV-Fallback via lookupCsvPrice in shipping-engine.js
  - ✅ Ghost-Einträge: baselinker-source Einträge komplett aus Tabelle gefiltert
  - ⚠️ Offen: Kaufland-Eintrag M9YQ4P5 ohne Kundenname (Datenqualität, nicht filtrierbar)
- [ ] **BUG-073** Rechnungen: Fehler beim Klick auf grünen Haken (P1)
  - "Als bezahlt markieren" wirft Fehler
  - Muss untersucht werden: API-Fehler oder Frontend-Bug
- [x] **BUG-074** Rechnungs-PDF Design — TrendOcean-Branding (P1)
  - ✅ Logo-Support (optional, aus company_settings.logoUrl)
  - ✅ Rechtsform unter Firmenname
  - ✅ MwSt-Spalte in Items-Tabelle
  - ✅ 4-Spalten-Footer (Adresse | Kontakt | Steuer | Bank)
  - ✅ Settings-Route: inhaber + logoUrl als erlaubte Felder
  - ⚠️ Offen: QR-Code (würde neue Dependency erfordern)
- [ ] **BUG-075** ~~Regeln-Seite FAILED_PRECONDITION~~ ✅ gefixt
- [ ] **BUG-076** ~~Pricing Vorschläge leer~~ ✅ gefixt (Empty State verbessert)
- [x] **BUG-077** Mobile UI: Kommissionieren + Operationen (P2)
  - ✅ BIN-Scanner Label + Safe Area (bereits vorher gefixt)
  - ✅ Pack-Zähler: nutzt jetzt readyToPackOrders (Orders) statt packList (Products)
  - ✅ Rote BIN: korrektes Verhalten (Error-State bei unbekanntem Scan, kein Bug)

## OMS Audit — Sprint-Block 10

> Details: `oms-audit-report.html` im Root

**Critical (P0):** ✅ erledigt
- ~~B001~~ ~~B002~~ ~~B003~~ ~~B004~~ ~~B005~~ ~~B006~~ ~~B007~~ ~~B008~~ ~~B009~~ — alle gefixt

**High (P1):** ✅ alle erledigt (B010-B021)

**Security (P1):** ✅ alle erledigt (S001-S004, S003 durch B012 abgedeckt)

**Medium/Low (P2):** ✅ alle erledigt (B022-B047, 5 Batches)
- Batch 1: Frontend UX (B028, B029, B032, B036)
- Batch 2: Error Handling (B030, B031, B035)
- Batch 3: Backend Robustness (B023, B024, B026, B033, B037, B038, B039)
- Batch 4: Frontend Quality (B027, B034, B042-B045, B047)
- Batch 5: Remaining (B022, B025, B040, B041, B046)

## Feature Backlog

| ID | Feature | Prio | Status |
|----|---------|------|--------|
| BULK-001 | Bulk Editing MVP | P0 | ✅ done + merged |
| ERR-001 | Error Dashboard | P0 | ✅ done + merged |
| PRICE-001 | Pricing Engine UI | P0 | ✅ done + merged |
| AI-001 | AI Listing Pipeline | P1 | ✅ done + merged |
| VAL-001 | Pre-Listing Validation | P1 | ✅ done + merged |
| RULE-001 | Rule Engine | P1 | ✅ done + merged |
| PERF-002 | eBay API Rate-Limiting & Call-Optimierung | P0 | **Claude Code Prompt ready** (`docs/prompts/perf-002-ebay-api-rate-limiting.md`) |
| WH-001 | Warehouse Zone P + Erweiterte Ranges | P1 | **Claude Code Prompt ready** |
| VAR-001 | Variant Model | P1 | Spec vorhanden, nicht implementiert |
| IMG-001 | Image Enhancement | P2 | Spec vorhanden, nicht implementiert |
| DASH-001 | Analytics Dashboard | P2 | Spec vorhanden, nicht implementiert |
| MP-001 | Amazon Integration | P2 | Spec vorhanden, nicht implementiert |
| MP-002 | Otto Integration | P2 | Spec vorhanden, nicht implementiert |
| UX-001 | Onboarding Wizard | P2 | Spec vorhanden, nicht implementiert |
| PAL-001 | Palette-Pflicht bei Identify | P1 | ✅ done (Frontend + Backend Validierung) |
| WT-001 | Gewichtsschätzung aus Titel | P1 | ✅ done (extractWeightFromTitle + Plausibilitätscheck) |
| MIG-001 | Products-V2 Lesepfad-Migration | P0 | ✅ done (alle Reads auf products_v2, warehouse dual-write) |
| LLM-001 | LLM Pipeline Quality Fix | P0 | ✅ done (8 Fixes: QualityGate, Retry, Schema, Improve-Tracking, Evidence-Hierarchie, Gewicht, Preis) |
| ERF-001 | Erfassen-Modul UI Overhaul | P0 | ✅ done (PaletteSelector, Auto-Separation, 2-Spalten-Layout, D&D, Multi-Produkt) |
| MPD-001 | Multi-Produkt aus Single Image | P1 | ✅ done (Gemini Detection, Hint-Injection, StepGrouping Single-Image-Modus, 15 Tests) |
| ADDR-001 | Empfänger-Adresslabel 62×29mm aus Bestellliste | P1 | **Claude Code Prompt ready** (`docs/prompts/feat-address-labels-62x29.md`) |
| WH-002 | Child-BINs / Container | P1 | **Claude Code Prompt ready** (`docs/prompts/feat-warehouse-child-bins.md`) |

## Ausstehende Deploys

- [ ] **Backend (Cloud Run):** BUG-083, BUG-084, BUG-085 (Fix A+C), BUG-090 (Gruppierung Structured Output), Upload-Limits, Cloud Run Timeout 600s
- [ ] **Nach Backend-Deploy:** `node backend/scripts/dedupe-products-v2.js` (dry-run) → prüfen → `--apply`
- [ ] **Frontend (Firebase Hosting):** PaletteSelector Fix, StepUpload Limits, MPD-001, BUG-091 (Multi-Identify Concurrency + Progress)

## Prompt-Queue für Claude Code

| Prio | Prompt | Datei |
|------|--------|-------|
| ~~P0~~ | ~~BUG-085 Dual-Write Duplikate (Fix A+B+C)~~ | ✅ implementiert, Deploy+Cleanup nötig |
| ~~P0~~ | ~~BUG-090 Gruppierung Fallback bei vielen Bildern~~ | ✅ implementiert (Structured Output, Kompression, Batching), Deploy nötig |
| ~~P0~~ | ~~BUG-091 Multi-Identify hängt (kein Timeout/Progress)~~ | ✅ implementiert (Concurrency 3, Phase-Progress, Timeout 600s), Deploy nötig |
| **P0** | **PERF-002 eBay API Rate-Limiting & Call-Optimierung** | `docs/prompts/perf-002-ebay-api-rate-limiting.md` |
| **P0** | **PERF-001 Identify Pipeline Overhaul (Sub-60s)** | `docs/prompts/perf-001-identify-pipeline-overhaul.md` |
| **P1** | **BUG-092 Versand Duplikate + falscher Problem-Status** | `docs/prompts/bug-092-shipping-duplicate-problem-status.md` |
| P0 | LLM Pipeline + Preise | `docs/prompts/fix-llm-pipeline-quality.md` |
| P0 | 292 unsichtbare Produkte (V2 Migration) | `docs/prompts/feat-complete-products-v2-migration.md` |
| P0 | Multi-Identify nur letztes Produkt | `docs/prompts/bug-079-multi-identify-only-last-product-saved.md` |
| P1 | ADDR-001 Empfänger-Adresslabel 62×29mm | `docs/prompts/feat-address-labels-62x29.md` |
| P1 | Erfassen-Modul UI Overhaul | `docs/prompts/feat-erfassen-modul-ui-overhaul.md` |
| P1 | Child-BINs / Container | `docs/prompts/feat-warehouse-child-bins.md` |

## Waiting On

- **Amazon SP-API Registrierung** — 2-4 Wochen, jetzt starten (P1)
- **Otto API Credentials** — OPC Portal beantragen (P2)
- **Etsy App Registrierung** — Developer Account + Review (P2)

## Backlog (Someday)

GDPR, API-Docs (OpenAPI), E2E-Tests (Playwright), Mobile App, Multi-Tenancy, Stripe Billing

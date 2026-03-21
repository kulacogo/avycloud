# TASKS.md — AvyCloud Aktive Tasks

> Letzte Aktualisierung: 2026-03-21
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

- [x] **BUG-078** BIN-Löschung blockiert obwohl Bestand = 0 — nonEmpty-Filter gefixt (products.some statt products.length)
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
- [ ] **BUG-072** Versand-Tabelle: Geisterdaten + BaseLinker-Referenz (P0!)
  - Einträge ohne Tracking-Nr UND ohne Kundenname (26-14354-93495, 09-14380-64268)
  - Eintrag 33797691 zeigt "baselinker" Badge — BaseLinker ist TABU, muss entfernt werden
  - Kaufland-Eintrag M9YQ4P5 ohne Kundenname
  - Alle Versandkosten 0,00 EUR — vermutlich SevDesk-Mapping-Problem
  - Zustellquote nur 1.1% — Berechnung wahrscheinlich falsch
- [ ] **BUG-073** Rechnungen: Fehler beim Klick auf grünen Haken (P1)
  - "Als bezahlt markieren" wirft Fehler
  - Muss untersucht werden: API-Fehler oder Frontend-Bug
- [ ] **BUG-074** Rechnungs-PDF Design stimmt nicht mit SevDesk überein (P1)
  - AvyCloud PDF: minimalistisch, kein Logo, kein Firmenfooter, falsche Struktur
  - SevDesk/Korrekt: TrendOcean Logo, QR-Code, Absenderzeile, 4-Spalten-Footer
  - Referenz-Design: RE-1574.pdf (SevDesk-Format)
- [ ] **BUG-075** ~~Regeln-Seite FAILED_PRECONDITION~~ ✅ gefixt
- [ ] **BUG-076** ~~Pricing Vorschläge leer~~ ✅ gefixt (Empty State verbessert)
- [ ] **BUG-077** Mobile UI: Kommissionieren + Operationen (P2)
  - BIN-Scanner Label "Scannen BIN" bricht um (Feld zu schmal, "BI" / "N" auf 2 Zeilen)
  - BIN XGA0402C rot hinterlegt — unklar ob Fehler-State oder nur visuell
  - "Packen: 408" — vermutlich zählt historische/erledigte Aufträge mit
  - Bottom-Navigation: Safe Area nicht beachtet (iPhone), überlappt mit System-Bereich

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
| WH-001 | Warehouse Zone P + Erweiterte Ranges | P1 | **Claude Code Prompt ready** |
| VAR-001 | Variant Model | P1 | Spec vorhanden, nicht implementiert |
| IMG-001 | Image Enhancement | P2 | Spec vorhanden, nicht implementiert |
| DASH-001 | Analytics Dashboard | P2 | Spec vorhanden, nicht implementiert |
| MP-001 | Amazon Integration | P2 | Spec vorhanden, nicht implementiert |
| MP-002 | Otto Integration | P2 | Spec vorhanden, nicht implementiert |
| UX-001 | Onboarding Wizard | P2 | Spec vorhanden, nicht implementiert |

## Waiting On

- **Amazon SP-API Registrierung** — 2-4 Wochen, jetzt starten (P1)
- **Otto API Credentials** — OPC Portal beantragen (P2)
- **Etsy App Registrierung** — Developer Account + Review (P2)

## Backlog (Someday)

GDPR, API-Docs (OpenAPI), E2E-Tests (Playwright), Mobile App, Multi-Tenancy, Stripe Billing

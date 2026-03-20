# TASKS.md — AvyCloud Aktive Tasks

> Letzte Aktualisierung: 2026-03-20
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

- [ ] **BUG-068** 170 Stock-Sync Fehler — Oversell-Risiko (abhängig von eBay Token Fix)
- [ ] **BUG-069** Dashboard Chart endet bei ~12.03 (createdAt-Datumslogik)
- [ ] **B5** Invoice Email-Versand fehlt
- [ ] **B6** Gutschriften/Stornorechnungen fehlen

## OMS Audit — Sprint-Block 10 (51 Findings)

> Details: `oms-audit-report.html` im Root

**Critical (P0):** FIX-B001 bis B009 (8 offen, 1 erledigt)
**High (P1):** FIX-B010 bis B021 (12 offen)
**Security (P1):** FIX-S001 bis S004 (4 offen, S001 ≈ FIX-12)
**Medium/Low (P2):** FIX-B022 bis B047 (26 offen)

## Feature Backlog

| ID | Feature | Prio | Spec |
|----|---------|------|------|
| BULK-001 | Bulk Editing MVP | P0 ✅ done | `docs/features/BULK-001-bulk-editing/spec.md` |
| ERR-001 | Error Dashboard | P0 ✅ done | `docs/features/ERR-001-error-dashboard/spec.md` |
| PRICE-001 | Pricing Engine UI | P0 ✅ done | `docs/features/PRICE-001-pricing-engine-ui/spec.md` |
| AI-001 | AI Listing Pipeline | P1 | `docs/features/AI-001-ai-listing-pipeline/spec.md` |
| VAL-001 | Pre-Listing Validation | P1 | `docs/features/VAL-001-pre-listing-validation/spec.md` |
| RULE-001 | Rule Engine | P1 | `docs/features/RULE-001-rule-engine/spec.md` |
| VAR-001 | Variant Model | P1 | `docs/features/VAR-001-variant-model/spec.md` |
| IMG-001 | Image Enhancement | P2 | `docs/features/IMG-001-image-enhancement/spec.md` |
| DASH-001 | Analytics Dashboard | P2 | `docs/features/DASH-001-analytics-dashboard/spec.md` |
| MP-001 | Amazon Integration | P2 | `docs/features/MP-001-amazon-integration/spec.md` |
| MP-002 | Otto Integration | P2 | `docs/features/MP-002-otto-integration/spec.md` |
| UX-001 | Onboarding Wizard | P2 | `docs/features/UX-001-onboarding-wizard/spec.md` |

## Waiting On

- **Amazon SP-API Registrierung** — 2-4 Wochen, jetzt starten (P1)
- **Otto API Credentials** — OPC Portal beantragen (P2)
- **Etsy App Registrierung** — Developer Account + Review (P2)

## Backlog (Someday)

GDPR, API-Docs (OpenAPI), E2E-Tests (Playwright), Mobile App, Multi-Tenancy, Stripe Billing

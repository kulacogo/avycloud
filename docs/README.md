# AvyCloud Documentation Index

> **Source of Truth für Tasks/Sprints:** [`TASKS.md`](../TASKS.md)
> **Projekt-Regeln & Architektur:** [`CLAUDE.md`](../CLAUDE.md)

---

## Governance

| Dokument | Zweck |
|----------|-------|
| [AGENT_RULES.md](AGENT_RULES.md) | **Pflichtlektüre für alle Agents.** Change-Klassifikation (L0-L3), Protected Zones, Behavioral Commandments, Pre/Post-Flight Checklists |

---

## Feature Specs

Alle Features folgen dem [Template](templates/feature-spec-template.md). Status: Draft → Ready → In Progress → Complete.

### P0 — Sofort

| ID | Feature | Effort | Change Level | Spec |
|----|---------|--------|--------------|------|
| BULK-001 | Bulk Editing MVP | M | L2 | [spec](features/BULK-001-bulk-editing/spec.md) |
| PRICE-001 | Pricing Engine UI | S | L1 | [spec](features/PRICE-001-pricing-engine-ui/spec.md) |
| ERR-001 | Error Dashboard | S | L1 | [spec](features/ERR-001-error-dashboard/spec.md) |

### P1 — Nächster Sprint

| ID | Feature | Effort | Change Level | Spec |
|----|---------|--------|--------------|------|
| AI-001 | AI Listing Pipeline | L | L2 | [spec](features/AI-001-ai-listing-pipeline/spec.md) |
| VAL-001 | Pre-Listing Validation | M | L1 | [spec](features/VAL-001-pre-listing-validation/spec.md) |
| IMG-001 | Image Enhancement | M | L0 | [spec](features/IMG-001-image-enhancement/spec.md) |
| RULE-001 | Visual Rule Engine | XL | L2 | [spec](features/RULE-001-rule-engine/spec.md) |
| VAR-001 | Variant Model (Parent-Child) | L | L3 | [spec](features/VAR-001-variant-model/spec.md) |
| DASH-001 | Analytics Dashboard | L | L1 | [spec](features/DASH-001-analytics-dashboard/spec.md) |
| MP-001 | Amazon.de Integration | XL | L3 | [spec](features/MP-001-amazon-integration/spec.md) |

### P2 — Geplant

| ID | Feature | Effort | Change Level | Spec |
|----|---------|--------|--------------|------|
| MP-002 | OTTO Market Integration | L | L3 | [spec](features/MP-002-otto-integration/spec.md) |
| UX-001 | Onboarding Wizard | M | L1 | [spec](features/UX-001-onboarding-wizard/spec.md) |

---

## Competitive Analysis

| Dokument | Inhalt |
|----------|--------|
| [SWOT Analysis](competitive-analysis/swot.md) | Scored SWOT mit Impact×Urgency Priority Matrix |
| [Market Overview](competitive-analysis/market-overview.md) | 18 Plattformen in 3 Tiers |
| [DACH Incumbents](competitive-analysis/sources/dach-incumbents.md) | PlentyONE, JTL-Wawi, Billbee |
| [German Connectors](competitive-analysis/sources/german-connectors.md) | magnalister, Channable |
| [International](competitive-analysis/sources/international.md) | Rithum, Linnworks, SellerCloud, Sellbrite |
| [AI-First Tools](competitive-analysis/sources/ai-first-tools.md) | Vendoo, Nifty AI, Zentail, CedCommerce |

---

## Product Strategy

| Dokument | Inhalt |
|----------|--------|
| [Positioning](product-strategy/positioning.md) | DACH-native, KI-first, Zielgruppe 50-5000 SKUs |
| [Roadmap](product-strategy/roadmap.md) | 4-Phasen-Plan: Foundation → Intelligence → Scale → Growth |

---

## Guidelines

| Dokument | Inhalt |
|----------|--------|
| [UX Rules](guidelines/ux-rules.md) | WCAG 2.2, WAI-ARIA, NN/g Best Practices, AvyCloud-Konventionen |
| [eBay DE Listing Requirements](guidelines/ebay-de-listing-requirements.md) | Titel, Kategorie, Artikelmerkmale, Bilder, Preis — mit eBay-Quellen |
| [LLM Rulebook](guidelines/llm-rulebook/LLM_RULEBOOK.md) | Titel/Highlights/Attribute-Regeln für KI-Output (+CSVs) |

---

## Guides (Operational)

| Dokument | Inhalt |
|----------|--------|
| [eBay Direct Sync Runbook](guides/ebay-direct-sync-runbook.md) | API-Endpunkte, Gap-Lifecycle, CLI-Scripts, Guardrails |

---

## Implementation Plans

| Dokument | Inhalt | Status |
|----------|--------|--------|
| [KW14 Pack & Ship Dashboard](plans/2026-03-14-kw14-pack-ship-dashboard.md) | Auto-Print, Activity Feed, Label-Format-Prefs | Aktiv |
| [Archive](plans/archive/) | Ältere Plans (Feb 2026): eBay Update Listings, Frontend V2, eBay Listing Audit | Archiviert |

---

## Templates

| Dokument | Zweck |
|----------|-------|
| [Feature Spec Template](templates/feature-spec-template.md) | Master-Template für alle Feature-Specs (339 Zeilen, 7 Sektionen) |

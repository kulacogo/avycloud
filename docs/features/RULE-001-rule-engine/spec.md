# RULE-001: Visual Rule Engine

## Meta

| Field | Value |
|-------|-------|
| **Feature ID** | RULE-001 |
| **Title** | Visual Rule Engine |
| **Priority** | P1 |
| **Status** | Draft |
| **Change Level** | L2 |
| **Effort** | XL |
| **Source** | marktanalyse + competitive-analysis |
| **Dependencies** | Benefits from BULK-001 infrastructure |
| **Protected Zones** | May need new route in `backend/routes/` |
| **TASKS.md Module** | M-AUTO (Automatisierung) |

---

## Problem Statement

AvyCloud has no automated data transformation or feed optimization. Channable's visual rule engine is the industry gold standard — "If this, then that" logic that transforms product data per channel. Rithum has algorithmic repricing. Zentail has SMART Types for auto-categorization. AvyCloud has none of these automation capabilities. Rated **HOCH** priority in the Marktanalyse.

---

## User Story

As a seller, I want to define rules that automatically transform my product data for each marketplace, so that listings are optimized without manual work on every product.

---

## Requirements

| ID | Priority | Requirement |
|----|----------|-------------|
| FR-1 | MUST | Support visual if/then rule builder (drag-and-drop or form-based) |
| FR-2 | MUST | Support per-channel rules (different rules for eBay vs. Kaufland) |
| FR-3 | MUST | Support shared rules across all channels |
| FR-4 | MUST | Support rule types: price adjustment, title optimization, category mapping, stock threshold |
| FR-5 | SHOULD | Provide template library for common scenarios |
| FR-6 | SHOULD | Show rule execution audit trail |
| FR-7 | MAY | Support A/B testing of rules |

---

## Competitive Benchmarks

| Competitor | Capability | Gap vs. AvyCloud |
|------------|-----------|------------------|
| **Channable** | Visual rule engine, 15K+ customers, gold standard in feed optimization | AvyCloud has no rules at all |
| **Zentail** | SMART Types for ML-based auto-categorization | AvyCloud has no auto-categorization |
| **Rithum** | Algorithmic repricing rules | AvyCloud pricing engine has no triggers |
| **magnalister** | Template-based attribute mapping per marketplace | AvyCloud has manual mapping only |

---

## Architecture

To be defined during brainstorming session.

## UI Design

To be defined during brainstorming session.

## Technical Design

To be defined during brainstorming session.

## Testing Strategy

To be defined during brainstorming session.

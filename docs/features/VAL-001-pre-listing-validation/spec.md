# VAL-001: Pre-Listing Validation

## Meta

| Field | Value |
|-------|-------|
| **Feature ID** | VAL-001 |
| **Title** | Pre-Listing Validation |
| **Priority** | P1 |
| **Status** | Draft |
| **Change Level** | L1 |
| **Effort** | M |
| **Source** | marktanalyse (S4.5) |
| **Dependencies** | None, but enhances AI-001 (AI Listing Pipeline) |
| **Protected Zones** | None (new service) |
| **TASKS.md Module** | M5 (Marktplatz-Views) — pre-publish quality gate |

---

## Problem Statement

AvyCloud has LLM-Rulebook and Schema validation, but only for LLM output. There is no pre-listing validation against marketplace-specific requirements. Channable and Rithum validate product data against marketplace schemas before submission and show errors with correction suggestions. Without this, sellers discover listing errors only after failed submissions.

---

## User Story

As a seller, I want AvyCloud to check my product data against each marketplace's requirements before I try to publish, so that I can fix issues proactively instead of dealing with failed listings.

---

## Requirements

| ID | Priority | Requirement |
|----|----------|-------------|
| FR-1 | MUST | Validate product data against eBay listing requirements (required item specifics, category rules, image requirements) |
| FR-2 | MUST | Validate against Kaufland listing requirements (mandatory attributes, category mapping) |
| FR-3 | MUST | Show validation results with specific error messages and correction suggestions |
| FR-4 | MUST | Distinguish between errors (blocking) and warnings (non-blocking) |
| FR-5 | SHOULD | Provide auto-fix suggestions for common issues (missing EAN, wrong category, incomplete title) |
| FR-6 | SHOULD | Integrate with AI-001 pipeline (validate before publish step) |
| FR-7 | MAY | Support batch validation for multiple products at once |

---

## Competitive Benchmarks

| Competitor | Capability | Gap vs. AvyCloud |
|------------|-----------|------------------|
| **Channable** | Quality Checks per channel, automatic error flagging, rule-based corrections | AvyCloud has no channel-specific validation |
| **Rithum** | Pre-submission validation against Amazon/eBay schemas, error dashboard with drilldown | AvyCloud validates LLM output only, not listing data |
| **Linnworks** | Listing error export for bulk fix, attribute validation per channel | AvyCloud has no bulk error handling |

---

## Architecture

To be defined during brainstorming session.

## UI Design

To be defined during brainstorming session.

## Technical Design

To be defined during brainstorming session.

## Testing Strategy

To be defined during brainstorming session.

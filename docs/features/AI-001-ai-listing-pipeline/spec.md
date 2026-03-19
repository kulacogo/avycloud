# AI-001: AI Listing Pipeline

## Meta

| Field | Value |
|-------|-------|
| **Feature ID** | AI-001 |
| **Title** | AI Listing Pipeline |
| **Priority** | P1 |
| **Status** | Draft |
| **Change Level** | L2 |
| **Effort** | L |
| **Source** | competitive-analysis |
| **Dependencies** | Benefits from VAL-001 (validation) and IMG-001 (image enhancement) |
| **Protected Zones** | backend/services/enrichment.js, backend/lib/gemini*.js (Yellow Zone) |
| **TASKS.md Module** | M13 (Erfassen / KI-Stepper-Flow) |

---

## Problem Statement

AvyCloud has powerful AI capabilities (Gemini product recognition, enrichment, quality scoring, chat) but they exist as separate, disconnected features. No competitor in the DACH market offers a unified flow: photo -> identify product -> enrich data -> optimize per channel -> validate -> publish. AI-first tools like Nifty AI offer 30-second photo-to-listing, but only for US reseller platforms. This is AvyCloud's opportunity to build the killer feature that no one else has.

---

## User Story

As a seller, I want to take a photo of a product and have AvyCloud automatically identify it, fill in all product data, optimize the listing for each marketplace, and publish it -- all in one streamlined flow.

---

## Requirements

| ID | Priority | Requirement |
|----|----------|-------------|
| FR-1 | MUST | Support photo upload as the starting point |
| FR-2 | MUST | Auto-identify product via Gemini (EAN, MPN, brand, specs) |
| FR-3 | MUST | Auto-enrich with web data (competitors, market prices, descriptions) |
| FR-4 | MUST | Generate marketplace-optimized titles and descriptions per channel |
| FR-5 | MUST | Auto-map to marketplace categories (eBay category, Kaufland category) |
| FR-6 | SHOULD | Suggest pricing based on competitor analysis |
| FR-7 | SHOULD | Validate listing against marketplace requirements before publish |
| FR-8 | SHOULD | Support barcode/EAN scanning as alternative entry point |
| FR-9 | MAY | Support batch processing (multiple photos -> multiple listings) |

---

## Competitive Benchmarks

| Competitor | Capability | Gap vs. AvyCloud |
|------------|-----------|------------------|
| **Nifty AI** | 30-second photo-to-listing | US platforms only, shallow identification |
| **Underpriced AI** | Photo recognition + real sold-price valuation | eBay only |
| **Zentail SMART Types** | ML-based category mapping that self-updates | Category mapping only, no full pipeline |
| **CedCommerce UniCon** | Agentic AI operations via natural language | No photo-to-listing flow |
| **3Dsellers** | Bulk AI optimization of existing eBay listings | Optimization only, no identification |

---

## Architecture

To be defined during brainstorming session.

## UI Design

To be defined during brainstorming session.

## Technical Design

To be defined during brainstorming session.

## Testing Strategy

To be defined during brainstorming session.

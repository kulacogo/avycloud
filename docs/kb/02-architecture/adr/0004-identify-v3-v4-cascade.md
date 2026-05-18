---
title: ADR-0004 — Identify V3 + V4 Cascade
for: [dev, agent, admin, manager]
lastReviewed: 2026-05-18
---

# ADR-0004 — Identify V3 + V4 Pipeline-Cascade

## Status

**Accepted** — V4 dark-deployed seit 2026-04-23, V3 bleibt als Fallback. Quelle: [CLAUDE.md](../../../../CLAUDE.md) §Feature-Flags.

## Kontext

Die KI-gestützte Produktanlage ist die operativ wichtigste Pipeline der Plattform. Historische Probleme:

- **V2-Identify**: Single-Shot Gemini-Call mit Grounding, unzuverlässige Qualität bei mehrstufigen Recherchen (Brand × Modell × Kategorie × Required-Aspects × Preis × GPSR).
- **V3** (Stage-Pipeline) hat die Qualität dramatisch verbessert (Audit 2026-04-21: 98 % „prod-ready"), aber sequenzielle Stages waren langsam und brachten kein Refinement-Loop.

Ziel V4: Worker-Swarm + Refinement-Loop + Critic als Quality-Gate.

## Entscheidung

### Pipeline V4 (Default `IDENTIFY_V4=false`, dark-deployed)

[backend/services/identify-v4.js](../../../../backend/services/identify-v4.js):

1. **Wave 1** (parallel): `identity` + `category` Worker.
2. **Wave 2** (parallel): `attributes`, `seo`, `pricing`, `image`, `gpsr` Worker.
3. **Refinement-Loop**: max 5 Iterationen (ENV `IDENTIFY_V4_MAX_ITERATIONS=5`) auf low-confidence Worker. Wave-1-Lock auf `identity` + `category` wird respektiert.
4. **Critic** (Flash-Model) bewertet Cassini-Pillars + flaggt `refinement_needed_workers`.
5. **Autosave** via `saveProductV2()` wenn `ebay_ready_score ≥ 0.6` (ENV `IDENTIFY_V4_AUTOSAVE=true`).

Worker-Shape einheitlich: `{ok, domain, resolved, confidence, sources, retriesRequested, meta}`.

Kritische Libraries:
- [backend/lib/sweet-spot-pricer.js](../../../../backend/lib/sweet-spot-pricer.js)
- [backend/lib/seo-title-builder.js](../../../../backend/lib/seo-title-builder.js)
- [backend/lib/seo-description-builder.js](../../../../backend/lib/seo-description-builder.js)
- [backend/lib/aspect-cap-enforcer.js](../../../../backend/lib/aspect-cap-enforcer.js)
- [backend/lib/image-enhance.js](../../../../backend/lib/image-enhance.js)
- [backend/lib/ebay-sold-listings.js](../../../../backend/lib/ebay-sold-listings.js)
- [backend/lib/ebay-catalog.js](../../../../backend/lib/ebay-catalog.js)

### Pipeline V3 (Default `IDENTIFY_V3=true`, Production-aktiv)

[backend/services/identify-v3.js](../../../../backend/services/identify-v3.js):

| Stage | Datei | Aufgabe |
|-------|-------|---------|
| Stage 1 | [backend/lib/identify-v3-stage1.js](../../../../backend/lib/identify-v3-stage1.js) | OCR + Image-Quality-Gate + Focused-Grounding + V2-Fallback. |
| Stage 2 | (Web-Lookups) | Weight via [backend/lib/weight-web-lookup.js](../../../../backend/lib/weight-web-lookup.js), GPSR via [backend/lib/gpsr-web-fallback.js](../../../../backend/lib/gpsr-web-fallback.js). |
| Stage 3 | [backend/lib/identify-v3-stage3.js](../../../../backend/lib/identify-v3-stage3.js) + agentic Variante [backend/lib/identify-v3-stage3-agentic.js](../../../../backend/lib/identify-v3-stage3-agentic.js) | Strukturierte Content-Generation (Titel/Beschreibung/Aspects). Required-Aspect-Enforcement + Backfill mit „Unbekannt". |

### Cascade-Logik

- `IDENTIFY_V4=true` (Master-Flag) ODER Canary (`IDENTIFY_V4_CANARY_RATE` / `IDENTIFY_V4_CANARY_TENANTS`) → V4 läuft.
- **V4-Error** → automatischer Fallback auf V3.
- V3 ist immer der „letzte stehende" Pfad.

### Sub-Flags

Vollständiger Katalog in [03-development/feature-flags.md](../../03-development/feature-flags.md). Auszug:
- `IDENTIFY_V4_AUTOSAVE=true`
- `IDENTIFY_V4_MAX_ITERATIONS=5`
- `IDENTIFY_V4_TIMEOUT_MS=180000`
- `IDENTIFY_V4_IMAGE_ENHANCE=true`
- `IDENTIFY_V4_IMAGE_ANGLE_CLASSIFY=true`
- `IDENTIFY_V4_PRICING_SOLD=true`
- `IDENTIFY_V4_CRITIC_FLASH=true`
- `IDENTIFY_V4_CRITIC_HINTS=true`
- `IDENTIFY_V4_CRITIC_HINTS_VERIFIED=false` (Promotion-Acknowledge — Startup-WARN bei `IDENTIFY_V4=true` ohne `=true`).
- Stage-3-Sub-Flags: `STAGE3_ASPECT_ENFORCEMENT`, `STAGE3_ASPECT_REPAIR`, `STAGE3_AGENTIC`, `STAGE3_AGENTIC_*`.

### Promotion-Pre-Flip-Gate

[backend/index.js](../../../../backend/index.js) Z. 48ff: Startup-WARN wenn `IDENTIFY_V4=true` und `IDENTIFY_V4_CRITIC_HINTS_VERIFIED!=true`. Operator muss [docs/runbooks/identify-v4-promotion.md](../../../runbooks/identify-v4-promotion.md) bestätigen.

## Konsequenzen

| Positiv | Negativ |
|---------|---------|
| Höhere Qualität durch Refinement + Critic. | Mehr Gemini-Calls → höhere Kosten (`LLM_TELEMETRY_SAMPLE` zur Beobachtung, Cost-Guard). |
| Drei-Tier-Fallback (V4 → V3 → V2 in Stage-1) → graceful degradation. | Mehrere parallele Pipelines erhöhen die Maintenance-Last. |
| Sub-Flag-Steuerung erlaubt schnelle Reverts ohne Deploy. | Operator muss Pipeline-Health (`/api/health/identify`) aktiv beobachten. |

## Code-Anker

- V4-Orchestrator: [backend/services/identify-v4.js](../../../../backend/services/identify-v4.js).
- V3-Orchestrator: [backend/services/identify-v3.js](../../../../backend/services/identify-v3.js).
- Smoke-Test: `node backend/scripts/smoke-identify-v4.js`.
- Promotion-Runbook: [docs/runbooks/identify-v4-promotion.md](../../../runbooks/identify-v4-promotion.md).
- LLM-Quality-Charta: [docs/standards/llm-quality-parity.md](../../../standards/llm-quality-parity.md).

## Querverweise

- Feature-Flag-Katalog: [../../03-development/feature-flags.md](../../03-development/feature-flags.md).
- LLM-Caller-Inventur: [docs/standards/llm-callers-inventory.md](../../../standards/llm-callers-inventory.md).

---
title: AvyCloud für Manager/Stakeholder
for: [manager]
lastReviewed: 2026-05-18
---

# AvyCloud für Manager/Stakeholder

## Was AvyCloud ist

Eine Multi-Channel-E-Commerce-Plattform für KMU im DACH-Raum (50–5000 SKUs). Sie automatisiert KI-gestützte Produktanlage, Listings auf eBay/Kaufland, Lager, Order-Lifecycle, Versand und Rechnungen.

Detail: [01-overview/what-is-avycloud.md](../01-overview/what-is-avycloud.md).

## Tech-Stack (für Architektur-Entscheidungen)

- Frontend: React 18 + TypeScript → Firebase Hosting
- Backend: Node.js 20 + Express → Cloud Run (`europe-west3`)
- DB: Firestore
- KI: Google Gemini API

## Roadmap und Strategie

- [docs/product-strategy/roadmap.md](../../product-strategy/roadmap.md) — 4-Phasen-Plan
- [docs/product-strategy/positioning.md](../../product-strategy/positioning.md) — DACH-native, KI-first
- [docs/competitive-analysis/](../../competitive-analysis/) — Wettbewerber

## Status

- **Aktive Tasks und Bugs**: [TASKS.md](../../../TASKS.md)
- **Was implementiert ist vs nicht**: [15-gap-analysis.md](../15-gap-analysis.md)
- **Was im System aufgeräumt werden muss**: [17-cleanup-report.md](../17-cleanup-report.md)

## Aktive Marktplatz-Integrationen

| Marketplace | Status | Doku |
|-------------|--------|------|
| eBay | live | [08-integrations/ebay.md](../08-integrations/ebay.md) |
| Kaufland | live | [08-integrations/kaufland.md](../08-integrations/kaufland.md) |
| Amazon | geplant | [docs/features/MP-001-amazon-integration/spec.md](../../features/MP-001-amazon-integration/spec.md) |
| OTTO | geplant | [docs/features/MP-002-otto-integration/spec.md](../../features/MP-002-otto-integration/spec.md) |

## Versand + Buchhaltung

- SendCloud (Labels + Tracking): [08-integrations/sendcloud.md](../08-integrations/sendcloud.md)
- SevDesk (Rechnungen): [08-integrations/sevdesk-invoicing.md](../08-integrations/sevdesk-invoicing.md)

## Kosten und Metriken

- LLM-Kosten: [07-llm/cost-and-budgets.md](../07-llm/cost-and-budgets.md)
- LLM-Parity-Dashboard: `/api/admin/llm-parity` (sobald Telemetry wired ist)
- External-API-Calls: `/api/health/identify` Endpoint

## Wer entscheidet was

- **Produkt-Entscheidungen**: Founder / Product Owner
- **Architektur-Entscheidungen**: dokumentiert als ADR unter [02-architecture/adr/](../02-architecture/adr/)
- **Operative Entscheidungen**: Engineering + Operator

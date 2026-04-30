# Identify Pipeline — Stand 2026-04-30

> Mit diesem Deploy sind ALLE neuen Pfade default-ON. Kein ENV-Setup, kein Schritt-für-Schritt-Rollout. Eine Push, ein Deploy, alles aktiv.

## Was ist beim nächsten Deploy aktiv?

Production-Defaults nach diesem Commit:

| Feature | Status | Was passiert |
|---|---|---|
| **Stage 3 Generation Config** (thinking high, urlContext, Temp 0.4–0.7, 8k Tokens) | ON | Identify-V3 nutzt Chat-V3-grade Settings für alle Gemini-Calls |
| **OCR + alle Bilder + EAN-DB + GPSR-Fallback in Stage 3** | ON | Stage 3 sieht das gesamte Stage-1+2-Wissen, nicht nur Identity-Block |
| **Aspect-Repair-Schwelle 10 %** (vorher 30 %) | ON | Aspekt-Reparatur greift bei kleineren Lücken |
| **Brand-Heuristik gehärtet** (kein "First word of title" mehr) | ON | "Hochwertige Powerbank" wird nicht mehr zur Brand "Hochwertige" |
| **GPSR-Tier-3** (Web-Fallback statt verworfen) | ON | Nicht-Registry-Brands bekommen GPSR aus Web-Recherche |
| **`categorySource` korrekt propagiert** | ON | `enforceEbayAspects` schützt Manual-Overrides |
| **Category-Resolver-V2 in Stage 2** (4-Stufen-Kaskade) | ON | eBay-Catalog-Lookup vor lokalem Match |
| **Cross-Reference Stage 4b** (calibrated SOURCE_WEIGHTS, multi-source Konsens) | ON | Per-Field-Confidence + Konflikt-Detection unter `ops.data_quality.identify_v3.cross_reference` |
| **Agentic Stage 3** (`chat.create + 9 atomic-tools + urlContext`, 5 Iterations) | ON | Stage 3 läuft als Agent. 3-Tier-Defense: Agentic → Single-Shot → V2-Record |
| **V4 Worker-Swarm** (8 Worker + Refinement-Loop + Critic) | ON | Wird als erstes versucht. Bei Fehler oder ok:false → V3-Fallback automatisch |
| **CHAT_V3 Pipeline** (Multi-Turn-Session mit allen Tools) | ON | Chat nutzt jetzt V3 als Default. Fallback bei Fehler: V2 → legacy |

Alle Pfade haben **automatische Fallbacks** — ein Fehler im neuen Pfad bricht keinen einzigen Request, der nimmt einfach den alten Weg.

## SerpAPI Resilience (von Phase 0, schon live seit Stunde X)

| Feature | Status |
|---|---|
| Empty-Result-Handling (`hasn't returned any results` ist kein Throw mehr) | ON |
| LRU + Negative-Cache (6h positiv / 1h negativ) | ON |
| Token-Bucket Rate-Limiter (5/sec, 20 concurrent) | ON |
| Circuit-Breaker (5 errors → 60s open) | ON |
| Log-Throttling (1 Log / 60s pro Cache-Key) | ON |
| `fetchSerpApi`-Alias (schließt latenten V4-Bug) | ON |

## V4-Bug-Fixes (Phase B)

| Bug | Status |
|---|---|
| Bild-URLs nicht propagiert (publish-blocker) | ✅ FIXED |
| `aiClient` nie injiziert (Worker degradiert) | ✅ FIXED |
| `worker:${domain}` nicht in `SOURCE_WEIGHTS` (Confidence dauerhaft 0.4) | ✅ FIXED |
| Brand/Name-Inkonsistenz in `assembleProductV4` | ✅ FIXED |
| Canary-Routing (`IDENTIFY_V4_CANARY_RATE` + `_TENANTS`) | ✅ NEU |

## Notfall-Opt-Outs

Falls ein Pfad in Production unerwartet zickt — kein Deploy nötig, nur Cloud-Run-ENV setzen + Service neustarten:

```bash
# Agentische Stage 3 abschalten (fällt auf Single-Shot zurück)
STAGE3_AGENTIC=false

# V4 abschalten (fällt auf V3 zurück)
IDENTIFY_V4=false

# Chat-V3 abschalten (fällt auf V2 zurück)
CHAT_V3=false

# Cross-Reference Stage 4b abschalten (rein observability, nichts kritisches)
STAGE4_CROSS_REFERENCE=false

# Category-Resolver-V2 abschalten (fällt auf lokalen findEbayCategory zurück)
STAGE2_USE_CATEGORY_V2=false

# Phase-1 Generation-Config (Notfall: alle Identify-Calls auf alte Werte zurück)
IDENTIFY_THINKING_LEVEL=off
IDENTIFY_URL_CONTEXT=false
IDENTIFY_TEMP_RECOGNITION=0.05
IDENTIFY_TEMP_GROUNDING=0.1
IDENTIFY_TEMP_CONTENT=0.15
```

## Wo Logs anzeigen, was läuft

```sh
# V4 läuft / fällt zurück auf V3
gcloud logging read 'resource.type="cloud_run_revision" AND
  resource.labels.service_name="product-hub-backend" AND
  textPayload=~"V4 returned ok:false|V4 threw|identify-v4"' --freshness=1h

# Agentischer Stage 3 (oder Fallback)
gcloud logging read 'resource.type="cloud_run_revision" AND
  resource.labels.service_name="product-hub-backend" AND
  textPayload=~"agentic"' --freshness=1h

# Cross-Reference Konflikte
gcloud logging read 'resource.type="cloud_run_revision" AND
  resource.labels.service_name="product-hub-backend" AND
  textPayload=~"Cross-Reference-Konflikt"' --freshness=24h

# Category-V2 (Hits / Failures)
gcloud logging read 'resource.type="cloud_run_revision" AND
  resource.labels.service_name="product-hub-backend" AND
  textPayload=~"category-resolver-v2"' --freshness=1h
```

In jedem Identify-Response steht jetzt zusätzlich:

- `meta.pipeline` — `'v4'` | `'v3'` | `'grounding'` | `'legacy'` (welcher Pfad lief)
- `meta.v4_route` — `'flag'` | `'tenant_canary'` | `'rate_canary'` (warum V4 lief)
- `product.ops.data_quality.identify_v3.cross_reference.aggregate.score` — Konsens-Konfidenz
- `result._meta.agenticUsed` — `true` falls agentic Stage 3 lief
- `result._meta.agenticTrace.iterations` — wie viele Tool-Iterationen
- `meta.totalDurationMs` — End-to-End-Latenz

## Wenn V4 manchmal zurückfällt — kein Drama

Das ist das Design. V4 hat 4 frisch gefixte Bugs aber ist seit nur 1 Woche dark-deployed; Edge-Cases werden sich in den ersten Stunden Production-Traffic zeigen. Jeder solche Fall fällt sauber auf V3 zurück und liefert ein gültiges Datenblatt.

Wenn die V4-Fallback-Rate über 50 % hängt: ENV `IDENTIFY_V4=false` setzen, Service neustarten, Bug-Report öffnen.

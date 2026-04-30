# Identify Pipeline Rollout — 2026-04-30

> Dieser Plan begleitet die Phase-B-Verbesserungen am Identify-Modul (Bilder rein → eBay-ready Datenblatt raus). Er beschreibt die schrittweise Aktivierung neuer Pfade in Production gemäß CLAUDE.md (additiv, ENV-flag-bar, Production darf NIEMALS negativ beeinflusst werden).

## Was ist neu (Phase B, deploy-bereit)

Alle Änderungen sind **additiv** — Production-Verhalten ändert sich nicht, solange die alten ENV-Werte beibehalten werden. Die neuen Pfade werden über ENV-Flags **schrittweise** aktiviert.

### Backend-Code-Änderungen (zusammen mit diesem Doc)

| Datei | Zweck |
|---|---|
| `backend/lib/identify-v3-stage2.js` | Category-Resolver-V2 (4-Stufen-Kaskade) als zusätzlicher Resolver in Stage 2 |
| `backend/lib/identify-v3-stage3.js` | Routing zu agentischer Stage 3 hinter Flag (Drei-Tier-Defense) |
| `backend/lib/identify-v3-stage3-agentic.js` | Neu — agentische Variante mit `chat.create + googleSearch + urlContext + 9 atomic-tools + write_product_datasheet` |
| `backend/lib/identify-v3-evidence.js` | Neu — Evidence-Builder + Cross-Reference Stage 4b (additiv) |
| `backend/services/identify-v3.js` | `categorySource`-Propagation, Cross-Reference-Block, Brand-Heuristik gehärtet, GPSR-Tier-3 |
| `backend/services/identify-v4.js` | 4 V4-Bug-Fixes (uploadedImages, source-mapping, brand-name-Konsistenz) |
| `backend/routes/identify.js` | V4 Canary-Routing + `aiClient`-Injection in V4 |

### Was die Code-Änderungen bewirken (selbst bei unveränderten ENVs)

Defaults `ON` werden in Phase B aktiv (klein, low-risk, getestet):

- `STAGE2_USE_CATEGORY_V2=true` (default) — eBay-Catalog/Suggestions-Resolver wird in Stage 2 aktiv. Falls Resolver throw oder confidence < 0.85, fällt Stage 2 nahtlos auf den lokalen Match zurück. **Empfohlen sofort an in Production.**
- `STAGE4_CROSS_REFERENCE=true` (default) — Cross-Reference Stage 4b läuft additiv neben dem alten Stage-4-Scoring. Output landet in einem **neuen** Subkey `ops.data_quality.identify_v3.cross_reference`. **Existing Stage-4-Felder werden nicht angefasst.** Konflikte werden als `notes.warnings` gesetzt aber nicht in den Resolved-Werten überschrieben (Phase 1 — observe, not overwrite).

Defaults `OFF` (opt-in via ENV):

- `STAGE3_AGENTIC=false` (default) — agentische Stage 3 mit allen Tools.
- `IDENTIFY_V4=false` (default) — V4 Worker-Swarm.

## Drei-Phasen-Rollout

### Phase B0 — Sofort deploy-bar (heute, mit aktuellem `main`)

1. **Backend pushen.** Cloud Build läuft, V3 bekommt Phase-A-Verbesserungen + Phase-B-Defaults (Cat-V2 + Cross-Ref-Stage-4b).
2. **30 Min Cloud-Logs beobachten** auf:
   - `[stage2] category-resolver-v2 failed` — sollte selten (<1 % aller Runs) auftauchen
   - `Cross-Reference-Konflikt:` in `notes.warnings` — Telemetry: zählt als Datenpunkt für die später aktivierte Konflikt-Auflösung
   - `[stage3] Missing required aspects post-gen` — sollte deutlich kürzere Listen zeigen als vor 2026-04-29
3. **Quality-Stichprobe**: 10 Identify-Runs durchklicken in der UI und bewerten:
   - GPSR häufiger befüllt? ✅ Tier-3-Web-Fallback aktiv
   - Brand "Hochwertige" / "Original" / "Sale"? ❌ Brand-Heuristik gehärtet
   - Item-Specifics-Coverage höher? ✅ Stage 3 sieht jetzt OCR + alle Bilder

### Phase B1 — Agentische Stage 3 (Tag 1-3)

**Voraussetzung**: Phase B0 stabil seit ≥ 24 h.

```bash
# 1. Canary auf 10 % der Identify-Runs (deterministisch sample-basiert)
STAGE3_AGENTIC_SAMPLE=0.1
```

**Was passiert**: 10 % der Stage-3-Calls laufen über `generateProductContentAgentic` statt single-shot. Bei jedem Failure wird automatisch auf single-shot-Generation zurückgefallen (Logik in `identify-v3-stage3.js`).

**Monitoring**:
- `result._meta.agenticUsed === true` — Counter für agentische Pfade
- `result._meta.agenticTrace.iterations` — durchschnittliche Anzahl Iterationen, sollte 1-3 sein
- `result._meta.agenticTrace.sawWriteCall` — sollte ≈ 100 % sein
- `result._meta.agenticTrace.durationMs` — P90 sollte < 60 s sein
- `[stage3] agentic path failed, falling back to single-shot` — sollte < 5 % sein

**Erfolgskriterium für Promotion**:
- Failure-Rate < 5 %
- Median-Latency < 45 s
- Item-Specifics-Coverage ≥ Single-Shot
- Brand/Category-Quality ≥ Single-Shot

**Promotion**:
```bash
# Alle Identify-Runs agentisch
STAGE3_AGENTIC=true
unset STAGE3_AGENTIC_SAMPLE
```

**Rollback** (jederzeit, kein Code-Deploy nötig):
```bash
unset STAGE3_AGENTIC
unset STAGE3_AGENTIC_SAMPLE
```

### Phase B2 — V4 Canary (Tag 5-10)

**Voraussetzung**: Phase B1 produktiv seit ≥ 48 h, agentische Stage 3 misst keine Regression.

Die V4-Bug-Fixes sind bereits eingebaut:
1. ✅ `uploadedImages` werden in den Image-Worker-Context propagiert (Bug 1)
2. ✅ `aiClient` wird vom Route-Handler injiziert (Bug 2)
3. ✅ Worker-Source-Mapping nutzt `SOURCE_WEIGHTS`-Keys (Bug 3)
4. ✅ Brand/Name-Konsistenz in `assembleProductV4` gefixt (Bug 6)

**Step 1 — Tenant-Whitelist Canary**:
```bash
IDENTIFY_V4_CANARY_TENANTS=tenant-internal-test
IDENTIFY_V4_AUTOSAVE=false      # Erstmal NUR berechnen, nicht speichern
IDENTIFY_V4_TIMEOUT_MS=240000   # 240s statt 180s, Image-Enhance hat höheren Cost
```

Manueller Vergleich V3 vs. V4 für 5-10 echte Test-Produkte. Audit-Query auf `details.images[].url_or_base64`: keine `inline://`-URLs mehr (Bug 1 verifiziert).

**Step 2 — Rate-Canary 10 %**:
```bash
IDENTIFY_V4_CANARY_RATE=0.1
IDENTIFY_V4_AUTOSAVE=true
unset IDENTIFY_V4_CANARY_TENANTS
```

24-48 h Monitoring auf:
- `meta.timedOut === true` — Counter, Schwellwert < 5 %
- `meta.workerReports.image.resolved.images[].url_or_base64` — keine `inline://`-Werte
- `console.warn('[identify] V4 returned ok:false, falling back to V3:')` — Counter, < 10 %
- `meta.confidence.aggregate.score` — P50 muss > 0.6 sein
- Save-Quote (autosave triggert) — vergleichbar mit V3

**Step 3 — Vollständiger Rollout**:
```bash
IDENTIFY_V4=true
unset IDENTIFY_V4_CANARY_RATE
```

**Rollback** (jederzeit):
```bash
unset IDENTIFY_V4
unset IDENTIFY_V4_CANARY_RATE
unset IDENTIFY_V4_CANARY_TENANTS
```

### Phase B3 — CHAT_V3 (Tag 12+)

**Voraussetzung**: Phase B2 stabil. Chat-V3-Code ist bereits production-ready (`backend/services/product-chat-v3.js`), nur das Routing in `routes/chat.js` aktiviert ihn nicht.

**Step 1 — Staging-Aktivierung**:
```bash
CHAT_V3=true
```

In Staging gegen 5-10 Test-Produkte verschiedene Chat-Operationen durchführen:
- "Zeig mir mehr Details" (Research-Intent)
- "Schreibe einen besseren Titel" (Write-Intent)
- "Welche Konkurrenz gibt es?" (Compare-Intent)

**Step 2 — Production-Canary** (laut TASKS.md):
- 10 % Traffic via einen vorgelagerten Routing-Layer (im aktuellen Code: noch NICHT implementiert — nur Master-Flag).
- Empfehlung für Phase B3: zuerst Canary-Mechanismus in `routes/chat.js` einbauen analog zu V4.

**Erfolgskriterium**:
- `[chat-v2] WARNING: Long response text but NO datasheet changes` (siehe Cloud-Run-Log) sollte verschwinden
- Datasheet-Update-Rate (Chat ändert tatsächlich Daten) ≥ V2

## Komplette ENV-Variable-Referenz

### Phase 1 (immer aktiv nach Deploy, in vorherigem Chat implementiert)

| ENV | Default | Wirkung |
|---|---|---|
| `IDENTIFY_THINKING_LEVEL` | `high` | Gemini 3 thinking level für alle 3 Identify-Calls |
| `IDENTIFY_URL_CONTEXT` | `true` | Aktiviert urlContext-Tool |
| `IDENTIFY_TEMP_RECOGNITION` | `0.4` | Stage 1 (Recognition) Temperature |
| `IDENTIFY_TEMP_GROUNDING` | `0.6` | Outer-Grounding Temperature |
| `IDENTIFY_TEMP_CONTENT` | `0.7` | Stage 3 (Content-Gen) Temperature |
| `IDENTIFY_MAX_TOKENS_RECOG` | `4096` | Stage 1 Token-Budget |
| `IDENTIFY_MAX_TOKENS_GROUND` | `8192` | Outer-Grounding Token-Budget |
| `IDENTIFY_MAX_TOKENS_CONTENT` | `8192` | Stage 3 Token-Budget |
| `STAGE3_MAX_IMAGES` | `4` | Bilder im Stage-3-Prompt |
| `STAGE3_ASPECT_REPAIR_THRESHOLD` | `0.1` | Aspect-Repair-Trigger-Schwelle |
| `STAGE3_CONTENT_TIMEOUT_MS` | `60000` | Stage 3 Hard-Timeout |

### Phase B0 (heute aktivierbar, defaults sind sicher)

| ENV | Default | Wirkung |
|---|---|---|
| `STAGE2_USE_CATEGORY_V2` | `true` | 4-Stufen-Kaskade-Resolver in Stage 2 |
| `STAGE2_CATEGORY_V2_TIMEOUT_MS` | `8000` | V2-Resolver-Hard-Timeout |
| `STAGE4_CROSS_REFERENCE` | `true` | Cross-Reference Stage 4b additiv |

### Phase B1 (Agentische Stage 3, opt-in)

| ENV | Default | Wirkung |
|---|---|---|
| `STAGE3_AGENTIC` | `false` | Agentischer Pfad an/aus |
| `STAGE3_AGENTIC_SAMPLE` | – | 0.0–1.0, Anteil agentic in Canary-Modus |
| `STAGE3_AGENTIC_TIMEOUT_MS` | `90000` | Wall-Clock-Total-Timeout |
| `STAGE3_AGENTIC_MAX_ITERATIONS` | `5` | Loop-Limit |
| `STAGE3_AGENTIC_SOFT_RESEARCH_LIMIT` | `3` | Force-Finalize nach N Research-Turns |
| `STAGE3_AGENTIC_TEMPERATURE` | `1.0` | (`DEFAULT_CHAT_TEMPERATURE`) |
| `STAGE3_AGENTIC_MAX_TOKENS` | `12000` | Token-Budget |
| `STAGE3_AGENTIC_MAX_IMAGES` | `4` | Bilder pro Run |

### Phase B2 (V4 Worker-Swarm, opt-in)

| ENV | Default | Wirkung |
|---|---|---|
| `IDENTIFY_V4` | `false` | Master-Flag |
| `IDENTIFY_V4_CANARY_RATE` | `0` | 0.0–1.0 für Sample-Canary |
| `IDENTIFY_V4_CANARY_TENANTS` | – | Tenant-Whitelist (CSV) |
| `IDENTIFY_V4_AUTOSAVE` | `true` | Autosave bei score ≥ 0.6 |
| `IDENTIFY_V4_TIMEOUT_MS` | `180000` | Pipeline-Total-Timeout (auf `240000` erhöhen wenn Image-Enhance an) |
| `IDENTIFY_V4_IMAGE_ENHANCE` | `true` | BG-Removal + Upscaling |
| `IDENTIFY_V4_IMAGE_ANGLE_CLASSIFY` | `true` | Angle-Detection |
| `IDENTIFY_V4_PRICING_SOLD` | `true` | eBay SOLD-Listings |
| `IDENTIFY_V4_CRITIC_FLASH` | `true` | Flash-LLM für Critic |

### Phase B3 (CHAT_V3, opt-in)

| ENV | Default | Wirkung |
|---|---|---|
| `CHAT_V3` | `false` | Aktiviert Chat-V3-Routing |
| `CHAT_V2_ENHANCED` | `true` | Gemini-3-Härtungen für V2 (bleibt aktiv als Fallback) |
| `CHAT_LEGACY_ENHANCED` | `true` | Legacy-Pipeline-Härtungen (bleibt aktiv als Fallback) |

## Risiko-Matrix

| Szenario | Risk | Mitigation |
|---|---|---|
| `STAGE2_USE_CATEGORY_V2=true` mit kaputter eBay-Catalog-API | LOW | 8s-Timeout + Fallback auf local |
| `STAGE4_CROSS_REFERENCE=true` mit fehlerhaften Evidence-Rows | LOW | try/catch um den ganzen Block, additiv (kein Resolved-Override) |
| `STAGE3_AGENTIC=true` Loop hängt | LOW | 90s-Wall-Clock + Fallback auf single-shot |
| `STAGE3_AGENTIC_SAMPLE=0.1` Canary degradiert | LOW | Pro Call entscheidet sich agentic/single, Fallback automatisch |
| `IDENTIFY_V4=true` mit `aiClient=null` | LOW (resolved) | aiClient wird jetzt injiziert (Bug 2 fix) |
| `IDENTIFY_V4=true` Upload-only Flow | LOW (resolved) | uploadedImages werden propagiert (Bug 1 fix) |
| `CHAT_V3=true` Tool-Loop ohne Write-Call | LOW | Forced-Finalize via `mode: 'ANY'` schon eingebaut |

## Telemetrie-Empfehlungen (Cloud-Run-Logging)

**Heute schon nutzbar** (textPayload-Suchen):

```sh
# V2-Resolver Erfolg/Fehler
gcloud logging read 'resource.type="cloud_run_revision" AND
  resource.labels.service_name="product-hub-backend" AND
  textPayload=~"category-resolver-v2"' --freshness=1h

# Cross-Reference Konflikte
gcloud logging read 'resource.type="cloud_run_revision" AND
  resource.labels.service_name="product-hub-backend" AND
  textPayload=~"Cross-Reference-Konflikt"' --freshness=24h

# Agentische Stage 3 (nach Aktivierung)
gcloud logging read 'resource.type="cloud_run_revision" AND
  resource.labels.service_name="product-hub-backend" AND
  textPayload=~"agentic"' --freshness=1h

# V4-Fallbacks
gcloud logging read 'resource.type="cloud_run_revision" AND
  resource.labels.service_name="product-hub-backend" AND
  textPayload=~"V4 returned ok:false|V4 threw"' --freshness=1h
```

**Empfohlen** (separater PR): Strukturierte Audit-Stream-Events für:
- Per-Pipeline-Latenz (Stage 1 / 2 / 3 / Total)
- `meta.confidence.aggregate.score` Histogram
- Save-Quote
- Fallback-Rate

## TL;DR — Was tust du als Operator?

1. **Heute**: Backend deployen, dann 30 Min Cloud-Run-Logs prüfen. Defaults `STAGE2_USE_CATEGORY_V2=true` und `STAGE4_CROSS_REFERENCE=true` sind aktiv und sicher.
2. **+1 Tag**: 10-Produkt-UI-Stichprobe — Brand/Category/GPSR/Aspect-Quality bewerten. Wenn ok → weiter.
3. **+1-3 Tage**: `STAGE3_AGENTIC_SAMPLE=0.1` setzen, 24 h beobachten. Wenn Failure-Rate < 5 % und Latenz P90 < 60s → `STAGE3_AGENTIC=true` und Sample entfernen.
4. **+5-10 Tage**: V4 mit `IDENTIFY_V4_CANARY_TENANTS=test-tenant` und `IDENTIFY_V4_AUTOSAVE=false` validieren. Dann `IDENTIFY_V4_CANARY_RATE=0.1`. Dann `IDENTIFY_V4=true`.
5. **+12 Tage**: `CHAT_V3=true` in Staging, dann Production.

**Goldene Regel**: Bei jedem Schritt ist Rollback eine ENV-Änderung weit. Kein Code-Deploy für Rollback nötig.

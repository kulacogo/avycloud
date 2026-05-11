# Runbook: Identify-V4 Promotion (Pre-Flip-Gate)

**Plan:** [/Users/oguz/.claude/plans/sieht-ziemlich-komplex-unstrukturiert-woolly-tulip.md](/Users/oguz/.claude/plans/sieht-ziemlich-komplex-unstrukturiert-woolly-tulip.md) — Phase E.

**Zweck:** Manual-Checklist die VOR jedem Production-Flip von `IDENTIFY_V4=true` durchlaufen werden muss. Phase-E-Soft-Warn-Mechanismus ersetzt das ursprünglich geplante Startup-Throw (Red-Zone-Schutz).

---

## Pre-Flip-Gate-Checklist

### Hard-Gates (alle Bedingungen MÜSSEN erfüllt sein)

- [ ] **Phase-E-Code-Pfad in HEAD verifiziert**
  - Befehl: `git log --oneline | grep -i "phase.e\|critic.hint.merge"` zeigt den Phase-E-Merge-Commit.
  - Code-Check: `grep -n "refinement_needed_workers" backend/services/identify-v4.js` zeigt die Konsumenten-Stelle.
  - Test-Check: `cd backend && npm test -- "merges critic.refinement_needed_workers"` ist grün.

- [ ] **Cassini-Mean ≥ TBD-Threshold**
  - Threshold-Bestimmung: nach D.5-Backfill historische Median+Quartile via `node backend/scripts/cassini-stats.js` (TBD).
  - Empirischer Default ohne Backfill-Daten: 0.65 (defensive).
  - Messung: Audit-API `/api/admin/identify-runs?confidence_min=0` Mean über letzte 7d.

- [ ] **Critic-Hint-Acknowledge-Rate ≥ 30 %**
  - Definition: % der V4-Runs in denen `critic.refinement_needed_workers`-Output zu mind. einem Refinement-Re-Run führte.
  - Messung: Audit-API + neue Telemetrie-Sub-Endpoint `/api/admin/identify-runs/critic-hints?dateFrom=...`.
  - Alert A6 in `alerts.md` deckt 0%-Fall ab.

- [ ] **Autosave-Rate-Drift < 5pp vs V3**
  - V3-Autosave-Rate (Baseline): aus `ops.data_quality.identify_v3` der letzten 30d.
  - V4-Autosave-Rate (Canary): aus `ops.data_quality.identify_v4.autosaved` der letzten 7d Canary-Run.
  - Drift = |V4_rate - V3_rate| muss < 0.05 sein.

- [ ] **Stress-Test-Suite grün**
  - `cd backend && node scripts/smoke-identify-v4.js` läuft ohne Fehler.
  - Manuelle Identify-Runs in Staging mit 10+ Test-Produkten (versch. Kategorien) zeigen plausible Outputs.

### Soft-Gates (Warnings, nicht-blockierend)

- [ ] **eBay-Auto-Fix-Trigger-Rate < V3**
  - Wenn V4 mehr Auto-Fix-Trigger als V3 produziert → Quality-Regression-Indikator.

- [ ] **Schema-Validation-Rate (F.3) zeigt 0 % Violations für V4-Outputs**
  - Über letzte 7d Cloud-Logging.

- [ ] **Cost-Vergleich V3 vs V4 (LLM-API-Kosten)**
  - V4 nutzt mehr Worker → höhere Kosten erwartet, aber max. +30 %.
  - Messung: F.4 Telemetrie `cost_usd_estimate` pro `pipeline`.

---

## Promotion-Reihenfolge (Multi-Tenant-Rollout)

1. **Tag 0 — Staging:** `IDENTIFY_V4=true` in Staging-Cloud-Run-Service. 24h Smoke-Test.
2. **Tag 1 — TrendOcean (kleineres Volumen, breitere Kategorien):**
   - `IDENTIFY_V4_CANARY_TENANTS=trendocean` in Production.
   - Hard-Gates erneut prüfen mit nur TrendOcean-Daten der letzten 24h.
   - Bei Soft-Gate-Failure: Eskalation an Oguz, Promotion pausieren.
3. **Tag 7 — AvyCloud-Tenant:** Wenn TrendOcean stabil über 7d:
   - `IDENTIFY_V4_CANARY_TENANTS=trendocean,avycloud`.
   - Nach 7d weiteren stabilen Run: `IDENTIFY_V4=true` global, `IDENTIFY_V4_CANARY_*` ENV-Vars entfernen.

## Rollback-Procedure

**Single-Command-Rollback:**
```bash
# In Cloud Run Service-Edit:
gcloud run services update product-hub-backend \
  --update-env-vars=IDENTIFY_V4=false \
  --region=europe-west3
```

V3-Pipeline übernimmt sofort. V4-Output-Felder in `ops.data_quality.identify_v4` bleiben erhalten (read-only nach Rollback).

## Eskalations-Pfad

| Zustand | Aktion |
|---|---|
| Hard-Gate failed | Promotion blockiert. Owner (Oguz) muss Root-Cause untersuchen, Plan-Phase neu evaluieren. |
| Soft-Gate failed | Promotion mit Vorbehalt möglich. Slack-Alert + 24h-Beobachtung. |
| Production-Crash post-Flip | Rollback (siehe oben). PagerDuty Alert A6. Post-Mortem innerhalb 48h. |
| Soft-Warn beim Startup zeigt Critic-Hint-Verified-Mismatch | `IDENTIFY_V4_CRITIC_HINTS_VERIFIED=true` ENV-Var setzen (manueller Acknowledgment durch Owner). Nicht ignorieren. |

## Stakeholder-Communication

| Wann | An wen | Was |
|---|---|---|
| Tag -7 vor TrendOcean-Flip | TrendOcean-Kontakt | Heads-up: Identify-Pipeline-Update, mögliche Quality-Drift in ersten 24h, Eskalations-Email |
| Tag 0 (Staging-Flip) | Oguz | Smoke-Test-Plan für Staging |
| Tag +1 nach TrendOcean-Flip | Oguz | Cassini-Mean + Acknowledge-Rate Status-Report |
| Tag +7 (AvyCloud-Flip) | TrendOcean + Sales-Team | Post-Flip-Status, Audit-Page-Link |

## Code-Anker

- **Pre-Flip-Soft-Warn:** [`backend/index.js`](/Users/oguz/Dev/avycloud/backend/index.js) — Startup-Hook nach allen Runners, prüft `IDENTIFY_V4=true` UND `IDENTIFY_V4_CRITIC_HINTS_VERIFIED!=true` und schreibt Cloud-Logging-Error + Slack-Alert (A6).
- **Critic-Hint-Konsumption:** [`backend/services/identify-v4.js`](/Users/oguz/Dev/avycloud/backend/services/identify-v4.js) `findLowConfidenceWorkers()` Z.396–419 — merged Set aus Confidence-basierten + Critic-suggested Workers.
- **Telemetrie:** [`backend/lib/llm-telemetry.js`](/Users/oguz/Dev/avycloud/backend/lib/llm-telemetry.js) — Phase-E-Code-Pfad-Ausführung loggen für A6-Alert.

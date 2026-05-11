# Runbook: GPSR-Consensus Rollout (`IDENTIFY_V3_GPSR_CONSENSUS`)

**Plan:** [/Users/oguz/.claude/plans/sieht-ziemlich-komplex-unstrukturiert-woolly-tulip.md](/Users/oguz/.claude/plans/sieht-ziemlich-komplex-unstrukturiert-woolly-tulip.md) — Task D.3.

**Zweck:** Behavior-sicheres Rollout der Migration von der linearen `pickFrom()`-GPSR-Merge-Logik in `backend/services/identify-v3.js` auf den `resolveConsensus()`-Algorithmus aus `backend/lib/cross-reference.js`.

GPSR-Daten sind regulatorisch relevant (EU 2023/988 Produktsicherheitsverordnung). Eine fehlende oder falsche Hersteller-Identifikation kann Plattform-Listings sperren und Bußgelder auslösen. Daher: **kein Big-Bang-Cut-Over, sondern strikter Stage-by-Stage-Rollout.**

---

## Drei Modi

| Modus    | Verhalten                                                   | Risiko       |
| -------- | ----------------------------------------------------------- | ------------ |
| `false`  | Legacy `pickFrom()` — Registry > Stage-3 LLM > Web. Default | 0 (Baseline) |
| `shadow` | Beide Pfade laufen; Diff wird geloggt; **alter** Pfad gewinnt | 0 (Observe)  |
| `true`   | Neuer `resolveConsensus()` Pfad gewinnt                     | mittel       |

Confidence-Gewichte für den Consensus-Pfad (aus `lib/confidence-scoring.js#SOURCE_WEIGHTS`):
- `registry` = 0.85
- `gemini_inference` = 0.55
- `manufacturer_website` = 0.90

Effective-Support pro Kandidat = `sum(confidence) × unique-source-count`. Bei `runner-up.support >= 0.7 × winner.support` → Konflikt-Flag (nicht-blockierend).

---

## Rollout-Plan

### Phase 0 — Bake-In (T0)

- Default ist `IDENTIFY_V3_GPSR_CONSENSUS=false`. Migration ist deployed, aber inaktiv.
- Verifizieren: Tests in `backend/__tests__/services/identify-v3-gpsr-consensus.test.js` grün, `identify-v3-assemble.test.js` grün, Default-Pfad unverändert.

### Phase 1 — Shadow-Mode (T0 → T+7d)

- Setze `IDENTIFY_V3_GPSR_CONSENSUS=shadow` in Cloud-Run-ENV (Production).
- Logs filtern auf `[GPSR-Consensus-Shadow] Diff detected`.
- Mind. **7 Tage** Beobachtung. Mindestvolumen: 500 Identify-V3-Runs.

**Akzeptanzkriterien für Promotion zu Phase 2:**

- **Diff-Quote-Threshold**: < 15 % der GPSR-Field-Picks weichen ab.
  - Berechnung: `diff_field_count / total_field_count` über alle 5 GPSR-Felder × Run-Anzahl.
  - **Bei > 15 % → Promotion blockiert.** Root-Cause-Analyse der Top-Diff-Cluster (z. B. „Web > Stage-3, weil Stage-3-Inferenz halluziniert"), dann manuell Re-Bewertung der Source-Gewichte.
- **Auto-Rollback-Trigger**: Wenn > **5 %** der Diffs einen Konflikt mit `registry` zeigen (`conflict: true` UND `oldResult` kommt aus registry, `newResult` nicht), wird Phase 1 verlängert und nicht promoted. In Cloud-Run: ENV zurück auf `false`.
- **Keine Latenz-Regression**: P95 des `_pickGpsrField`-Aufrufs nicht messbar (< 1 ms/Feld).

### Phase 2 — Active für 10 % Tenants (T+7d → T+14d)

- Setze `IDENTIFY_V3_GPSR_CONSENSUS=true` **nur für 10 % der Tenants** über Feature-Flag-Routing in `routes/identify.js` (Tenant-Hash-Modulo, siehe Pattern bei `IDENTIFY_V4_CANARY_TENANTS`).
- Falls keine Tenant-Whitelist verfügbar: per Tenant-ID-Hash `tenantId.charCodeAt(0) % 10 === 0` → `true`, sonst `false`.
- Manuell Stichproben der GPSR-Felder in den Canary-Tenants: 10 Identify-Runs händisch prüfen (sind Hersteller-Daten plausibel?).

**Akzeptanzkriterien für Promotion zu Phase 3:**

- Keine eBay-Publish-Errors mit GPSR-Bezug (`ERROR_VALIDATION` mit Hersteller-Feldern).
- Kein Anstieg an Quality-Gate-Failures im Identify-V3-`overall_score`.
- Manuelle Review: ≤ 1 false-positive pro 100 Canary-Runs.

### Phase 3 — Active für 100 % (T+14d → T+21d)

- `IDENTIFY_V3_GPSR_CONSENSUS=true` für alle Tenants.
- Monitoring weitere 7 Tage; bei Regression → ENV-Cut-Back auf `false`.

### Phase 4 — Cleanup (T+30d)

- Wenn 14 Tage `true` ohne Regression → ENV entfernen, alte `pickFrom`-Pfad-Logik aus `_pickGpsrField` entfernen (oder als Dead-Code-Test belassen, kein Hard-Delete).
- Doku-Update CLAUDE.md: Flag als „retired" markieren.

---

## Auto-Rollback-Mechanik

**Trigger** (manuell zu prüfen, nicht automatisiert in dieser Version):

- Identifizierte Hersteller-Daten weichen in > 5 % der `shadow`-Diffs **gegen die Registry** ab (Registry ist authoritativ in DE/EU).
- eBay-Publish-Quote sinkt um > 3 pp gegen die Baseline-Woche vor Phase 2.

**Aktion:**

1. `gcloud run services update product-hub-backend --region europe-west3 --update-env-vars IDENTIFY_V3_GPSR_CONSENSUS=false`.
2. Slack-Alert in `#avycloud-alerts` mit dem Diff-Cluster.
3. Issue in `TASKS.md` öffnen mit Root-Cause-Analyse.

---

## Verifizierung im Code

- Migration-Helper: `backend/services/identify-v3.js#_pickGpsrField`.
- Cross-Reference-Algorithmus: `backend/lib/cross-reference.js#resolveConsensus`.
- Source-Gewichte: `backend/lib/confidence-scoring.js#SOURCE_WEIGHTS`.
- Tests: `backend/__tests__/services/identify-v3-gpsr-consensus.test.js` (10 Cases).
- Default-Regression-Schutz: `backend/__tests__/services/identify-v3-assemble.test.js` (GPSR-Section).

---

## Offene Punkte

- Diff-Telemetrie: aktuell nur in den Logs. Für Phase 1 wäre ein dedizierter Firestore-Collection-Eintrag (`gpsr_consensus_diffs`) für Aggregations-Queries besser. **Folge-Task** falls Phase 1 längere Beobachtungsdauer braucht.
- Pro-Field-Override: ggf. wollen wir `email` und `entity_country` schneller promoten als `manufacturer_name` (höheres Risiko). Aktuell sind alle 5 Felder hinter demselben Flag.

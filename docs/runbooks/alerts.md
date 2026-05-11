# Alert-Definitions & Receivers (Phase G)

**Plan:** [/Users/oguz/.claude/plans/sieht-ziemlich-komplex-unstrukturiert-woolly-tulip.md](/Users/oguz/.claude/plans/sieht-ziemlich-komplex-unstrukturiert-woolly-tulip.md) — Phase G (Observability + Alerts).

**Stand:** 2026-05-10 — Sprint 1 Setup-Phase. Alerts werden in Phase G aktiviert (Sprint 2+).

---

## Alert-Empfänger-Strategie

| Severity | Receiver | Reaction-SLA | Kommunikations-Channel |
|---|---|---|---|
| **CRITICAL** (Production-Outage-Risk) | Oguz (PagerDuty) | <15 min | PagerDuty-Service + Slack #incidents |
| **HIGH** (Quality-Regression) | Oguz (Slack) | <1 h | Slack #avycloud-alerts |
| **MEDIUM** (Drift-Erkennung) | Oguz (Email-Digest) | <24 h | Daily-Digest-Email |
| **INFO** (Telemetrie-Anomalien) | Cloud-Logging-Dashboard | best-effort | Dashboard-Review wöchentlich |

PagerDuty-Service-Key: TBD (vor Phase G zu erzeugen).
Slack-Webhook-URL: TBD (vor Phase G zu konfigurieren).
Email-Distro: kulacoglu.oguzhan@gmail.com (initial Solo, später erweitern).

---

## Alert-Definitionen

### A1 — CI-Snapshot-Test-Failure (CRITICAL, CI-Hard-Gate)
- **Trigger:** Snapshot-Test in `__tests__/lib/identify-v3-stage4-snapshot.test.js` (oder vergleichbar) failed in CI.
- **Cloud-Build-Step-Hook:** Build-Pipeline bricht ab mit Exit-Code != 0.
- **Aktion:** Merge blockiert. Owner muss Snapshot-Drift untersuchen — Plan A.1 Rollback-Procedure.
- **Receiver:** Code-Reviewer (PR-Status-Check) + Author (Email-Notification GitHub).

### A2 — Schema-Validation-Rate >1 % (HIGH, F.3 Stufe-2-Gate)
- **Trigger:** Cloud-Logging-Metrik `schema_invalid_rate{scope=*}` > 0.01 über 1h-Sliding-Window.
- **Quelle:** Log-Based-Metric aus `lib/llm-telemetry.js logLlmCall()`-Output.
- **Aktion:** Review der Schema-Violations + Schema-Iteration vor F.3-Stufe-2-Strict-Flip.
- **Receiver:** Slack #avycloud-alerts.

### A3 — Cassini-Mean-Drop >5pp innerhalb 1h (HIGH, Quality-Regression)
- **Trigger:** Mean `cassini.overall` über alle V4-Runs der letzten 1h sinkt um >5 Prozentpunkte vs. vorheriger 1h.
- **Quelle:** Audit-API `/api/admin/llm-parity` (Phase D.1) + Log-Based-Metric.
- **Aktion:** Sofortige Untersuchung — Drift-Source identifizieren (welche Pipeline? welcher Worker? welcher Scope?).
- **Receiver:** Slack #avycloud-alerts.

### A4 — Audit-API p95-Latenz >500ms (MEDIUM, Performance-Regression)
- **Trigger:** Cloud-Run-Metric `request_latencies{service="product-hub-backend",path="/api/admin/identify-runs"}` p95 > 500ms über 5min.
- **Aktion:** Index-Build-Status prüfen. Composite-Index aktiv? Doc-Count plausibel?
- **Receiver:** Slack #avycloud-alerts.

### A5 — Firestore-Cost-Spike Telemetrie (HIGH, Cost-Runaway-Schutz)
- **Trigger:** Cloud-Billing-Alert für Firestore-Writes >$30/Monat.
- **Quelle:** Cloud-Billing-Budget-Alert auf Project `avycloud`.
- **Aktion:**
  1. `LLM_TELEMETRY_SAMPLE`-ENV prüfen (sollte 0.1 sein, wenn höher → Auto-Downgrade prüfen).
  2. F.4-Sample-Rate-State-Doc `system/llm-telemetry-state` checken.
  3. Bulk-Action-Telemetrie-Hot-Spot? Doc-ID-Sharding aktiv?
- **Receiver:** PagerDuty (Cost-Runaway = Production-Risk).

### A6 — V4-Run ohne Critic-Hint-Merge (HIGH, Phase-E-Pre-Flip-Gate)
- **Trigger:** `IDENTIFY_V4=true` Production-Runs zeigen 0 % Critic-Hint-Acknowledge-Rate (Phase-E-Code-Pfad nicht ausgeführt).
- **Bedeutung:** Promotion zu V4 ohne Phase-E-Merge passiert.
- **Aktion:** Sofort `IDENTIFY_V4=false` setzen, Phase-E-Code-Pfad in HEAD verifizieren.
- **Receiver:** PagerDuty.

### A7 — Deprecation-Marker-Hit (LOW, B.2-Beobachtungs-Window)
- **Trigger:** Cloud-Logging-Filter `[DEPRECATED] enrichment_backup.js loaded` Match.
- **Aktion:** Stack-Trace untersuchen → unbekannter Caller? Falls ja: B.2-Phase neu evaluieren, NICHT `git rm`.
- **Receiver:** Email-Digest (35d Beobachtungs-Window).

### A8 — Multi-Tenant-Daten-Leak (CRITICAL, D.0-Schutz)
- **Trigger:** Test/Staging zeigt `getAllProducts()`-Caller ohne tenantId-Filter (post D.0c).
- **Quelle:** Pre-D.0c-Audit-Skript + Production-Smoke-Test.
- **Aktion:** Sofort Rollback D.0c (`git revert pre-d0c-revert-point`). Multi-Tenant-Caller-Audit fortsetzen.
- **Receiver:** PagerDuty.

---

## Pre-Deploy-Checkliste-Items (CI-enforced)

Pro Phase MUSS vor Production-Deploy:
- ☑ Definition-of-Done erfüllt (siehe Plan-Sektion „Definition-of-Done pro Phase").
- ☑ Snapshot-Tests grün (falls phasen-relevant).
- ☑ Pre-Deploy-Tag gesetzt (z.B. `pre-phase-A-deploy`, `pre-phase-F2-deploy`).
- ☑ Owner-Sign-off (PR-Approval + Slack-Confirmation).
- ☑ Stakeholder-Communication versendet (siehe Plan-Sektion „Stakeholder-Communication-Plan").
- ☑ Rollback-Procedure dokumentiert + getestet.

CI-Skript `backend/scripts/verify-pre-deploy-tag.sh` (TBD in G-Phase): prüft ob `pre-phase-X-deploy`-Tag <24h alt existiert, sonst fail.

---

## Aktivierungs-Reihenfolge der Alerts

| Alert | Aktivierung in Sprint | Abhängigkeit |
|---|---|---|
| A1 | Sprint 1 (sofort) | CI-Pipeline existiert |
| A7 | Sprint 1 (mit B.2-Deploy) | Cloud-Logging-Filter |
| A8 | Sprint 7 (mit D.0a-Deploy) | Pre-D.0c-Audit-Skript |
| A2 | Sprint 5 (mit F.3-Deploy) | F.4a Logger aktiv |
| A3 | Sprint 8 (mit D.1-Deploy) | Audit-API + Cassini-Backfill |
| A4 | Sprint 8 (mit D.1-Deploy) | Audit-API |
| A5 | Sprint 4 (mit F.4a-Deploy) | Firestore-Telemetrie-Collection |
| A6 | Sprint 9 (mit Phase-E-Deploy) | Phase-E-Code-Pfad |

---

## TODO vor Phase-G-Komplett

- [ ] PagerDuty-Account erstellen (oder existierenden nutzen) + Service-Key generieren.
- [ ] Slack-Channel `#avycloud-alerts` einrichten + Incoming-Webhook konfigurieren.
- [ ] Email-Distro für Daily-Digest definieren.
- [ ] Cloud-Logging Log-Based-Metrics erstellen für `schema_invalid_rate`, `cassini_overall_mean`, `critic_hint_acknowledge_rate`.
- [ ] Cloud-Billing-Budget-Alert auf `avycloud`-Projekt mit Schwelle $30/Monat Firestore-Writes.
- [ ] CI-Pipeline-Step `verify-pre-deploy-tag.sh` schreiben.
- [ ] Runbook pro CRITICAL-Alert mit Investigation-Schritten ausarbeiten.

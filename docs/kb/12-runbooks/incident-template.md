# Incident Report — `<YYYY-MM-DD>-<short-slug>`

> Copy this file to `docs/runbooks/incidents/<YYYY-MM-DD>-<short-slug>.md` at the start of any Sev1/Sev2 incident. Fill in sections live as the incident unfolds — do **not** wait until afterwards. The post-mortem section is completed after resolution.

---

## Metadata

| Field | Value |
|-------|-------|
| Incident ID | `<YYYY-MM-DD>-<slug>` |
| Severity | Sev1 / Sev2 / Sev3 |
| Status | open / mitigated / resolved |
| Started (UTC) | `<YYYY-MM-DD HH:MM>` |
| Detected (UTC) | `<YYYY-MM-DD HH:MM>` |
| Mitigated (UTC) | `<YYYY-MM-DD HH:MM>` |
| Resolved (UTC) | `<YYYY-MM-DD HH:MM>` |
| Incident commander | `<name>` |
| Scribe | `<name>` |
| Related runbook(s) | `<links to docs/runbooks/*.md>` |
| Related commits / PRs | `<links>` |

---

## Trigger

What fired the incident and where it surfaced. Be specific: alert name, channel, customer report, dashboard, log query.

- **Source:** _(e.g. Cloud Monitoring alert `oversell-rate-1h > 0.5%`, customer email, Slack `#oncall`, Sentry issue ID)_
- **First signal at:** _(timestamp, screenshot or log link)_
- **Initial hypothesis:** _(one sentence)_

---

## Initial Impact

User-visible and business-visible blast radius at the moment of detection. Include numbers, not adjectives.

- **Affected tenants:** _(`default`, `trendocean`, … or "all")_
- **Affected surfaces:** _(API endpoints, UI views, marketplace integrations)_
- **Affected entities:** _(orders / products / SKUs — counts and example IDs)_
- **Customer-facing symptoms:** _(e.g. "Kaufland listings show wrong stock", "checkout returns 500")_
- **Data integrity risk:** yes / no — _(can we lose or double-write data?)_
- **Revenue / SLA impact:** _(rough estimate or "unknown — pending")_

---

## Containment Steps

What we did **immediately** to stop the bleeding, in order. Each entry: timestamp, actor, action, result.

| Time (UTC) | Actor | Action | Result |
|------------|-------|--------|--------|
| `HH:MM` | `<name>` | _e.g. Flipped `IDENTIFY_V4=false`_ | _e.g. Error rate dropped from 12% → 0.3% within 90s_ |
| `HH:MM` | `<name>` | _e.g. Paused Sendcloud webhook consumer_ | _Backlog stops growing_ |

Notes:
- Prefer reversible mitigations (flag flip, traffic cap, queue pause) over irreversible ones (data backfill, manual Firestore writes).
- Every irreversible action requires a second pair of eyes — record who approved.

---

## Investigation

Timeline of evidence-gathering and the hypotheses we tested. Append as we go; do **not** retroactively rewrite.

```
HH:MM  <actor> — observed: <signal>
HH:MM  <actor> — hypothesis: <theory>
HH:MM  <actor> — checked: <log query / metric / Firestore doc> → <result>
HH:MM  <actor> — ruled out: <theory> because <evidence>
HH:MM  <actor> — confirmed: <theory> via <evidence>
```

Useful queries / dashboards used (link them so the next on-call can re-run):

- _(Cloud Logging query)_
- _(Firestore doc paths inspected)_
- _(Metric explorer link)_

---

## Root Cause

The actual underlying cause, not just the proximate trigger. Use the "five whys" if helpful.

- **Trigger:** _(what change/event made the failure visible)_
- **Latent cause:** _(what was already broken or fragile)_
- **Why it wasn't caught earlier:** _(missing test, missing alert, missing review, etc.)_
- **Invariant violated (if any):** _(reference `CLAUDE.md` item number, e.g. "Invariant 13 — Stock Single Writer")_

---

## Repair Steps

Concrete actions taken (or to be taken) to fully restore the system **and** repair any corrupted data.

| # | Action | Owner | Status | Notes / link |
|---|--------|-------|--------|--------------|
| 1 | _e.g. Roll forward fix `<PR link>`_ | `<name>` | done / pending | |
| 2 | _e.g. Run `backend/scripts/repair-double-decrement.js --apply` on affected SKUs_ | `<name>` | done / pending | dry-run output attached |
| 3 | _e.g. Reconcile Kaufland stock for affected listings_ | `<name>` | done / pending | |
| 4 | _e.g. Re-enable feature flag `<FLAG>` at canary 5%_ | `<name>` | pending | |

Verification:

- _(How we confirmed the system is healthy: metric back to baseline for X minutes, no new ledger gaps, etc.)_

---

## Post-Mortem

Filled in **after** the incident is fully resolved. Blameless tone. Focus on systems, not people.

### What went well

- _(detections that fired correctly, runbooks that worked, fast handoff, etc.)_

### What went poorly

- _(missing alerts, slow detection, unclear ownership, missing runbook, etc.)_

### Action items

Each action item must be tracked in `TASKS.md` or as a GitHub issue. Reference the ID here.

| # | Action item | Owner | Due | Tracker |
|---|-------------|-------|-----|---------|
| 1 | _e.g. Add alert on `inventory_ledger` write-rate drop > 50%_ | `<name>` | `<YYYY-MM-DD>` | `TASKS.md` § / issue # |
| 2 | _e.g. Add regression test for double-decrement edge case_ | `<name>` | `<YYYY-MM-DD>` | |
| 3 | _e.g. Add KB page documenting `<failure mode>`_ | `<name>` | `<YYYY-MM-DD>` | |

### Lessons / invariants to update

- _(Should `CLAUDE.md` get a new non-negotiable? Should a runbook be added or merged?)_

---

## Owners

| Role | Person | Backup |
|------|--------|--------|
| Incident commander | `<name>` | `<name>` |
| Tech lead (code path) | `<name>` | `<name>` |
| Comms / customer-facing | `<name>` | `<name>` |
| Post-mortem author | `<name>` | `<name>` |

---

_Template version: 1.0 — last updated 2026-05-18. Update by editing [`docs/kb/12-runbooks/incident-template.md`](./incident-template.md)._

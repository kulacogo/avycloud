---
title: Cleanup Report — Was im System ZU VIEL ist
for: [dev, agent, admin, manager]
lastReviewed: 2026-05-18
---

# Cleanup Report

> **Letzter Audit-Lauf:** 2026-05-18 ([siehe Rohdaten](_audit-runs/))
> **Skripte:** `audit-repo-cruft.js`, `audit-firestore-cruft.js`, `audit-gcs-cruft.js`, `audit-cloud-run.js`, `audit-deps.js`, `audit-flags-extended.js`
> **Regel:** Kein Auto-Delete in Firestore, GCS, Cloud Run, oder bei Risiko ≥ MEDIUM. Operator-Sign-off via Eintrag in [TASKS.md](../../TASKS.md) Sektion "Cleanup Operator Decisions".

## Executive Summary

AvyCloud trägt sichtbare technische Schulden in 6 Dimensionen:

| Bereich | Finding-Count | Top-Empfehlung |
|---------|---------------|----------------|
| **Repo** | 3592 Findings | 24 BaseLinker-Skripte archivieren, 2 `enrichment_backup.js` löschen, 634 Binary-Docs in `docs/archive/` |
| **Firestore** | 19 von 55 POTENTIALLY_DEAD | Top-Liste: `stock_sync_failures` 51.380 Docs (kein Code-Ref!), `qualityJobs` 10.930, `inventorySyncLogs` 16.557 |
| **GCS** | 8 Buckets, 7 STALE-Prefixes | `avycloud-genai-images/jobs`, `avycloud-product-images/jobs`, `products-and-jobs/products`, alle 4 `trendocean/*`-Prefixes |
| **Cloud Run** | 1 Service, 50 Revisions | `product-hub-backend` dormant seit 2025-11-09, alte Revisionen prunen |
| **Dependencies** | 3 problematisch | `framer-motion` DEAD; `node-fetch` und `p-limit` ERROR (imported aber nicht declared) |
| **ENV-Vars / KB** | 85 Coverage-Gaps | 53 ENV-Vars nicht in Feature-Flags-Doku, 15 Features ohne KB-Eintrag, 12/15 API-Routen ohne KB-Doku |

**Geschätzte Wirkung wenn umgesetzt**: -50% Repo-Größe, -200k Firestore-Docs eingespart, -3 GB GCS-Storage entlastet, klarere Architektur für neue Devs/Agents.

---

## Sektion 1: Repo Inventory

### 1.1 Backup-Legacy (HIGH-Priority, sicher löschbar)

| Pfad | Größe | Aktion | Begründung |
|------|-------|--------|------------|
| `backend/services/enrichment_backup.js` | 43.4 KB | DELETE | Bekannt dead (`backend/__tests__/services/dead-code.test.js` verifiziert) |
| `archive/uiv2/backend/services/enrichment_backup.js` | 42.9 KB | DELETE | Archiv-Kopie, ebenso obsolet |

**Operator-Entscheidung nötig**: nein — Backup-Files mit verifiziertem Dead-Status sind sicher.

### 1.2 BaseLinker-Skripte (CLAUDE.md Regel #9)

24 Skripte unter `backend/scripts/` referenzieren BaseLinker:

```
add-ebay-categories-to-inventory.js     backfill-baselinker-orders.js
backfill-kaufland-marketplace-id.js     check-bl-order-fields.js
check-current-dupes.js                  check-dupes-and-counts.js
check-kaufland-dupes.js                 check-orders-now.js
check-todays-dupes2.js                  delete-remaining-bl-ebay.js
export-inventory-categories.js          find-all-bl-ebay-dupes.js
find-bl-dupes.js                        find-order-dupes.js
fix-bl-storniert-orders.js              fix-source-field.js
generate-ebay-map.js                    inspect-bl-order.js
inspect-kl-order.js                     inspect-kl-raw.js
inspect-new-dup.js                      investigate-issues.js
purge-all-bl-orders.js                  remove-bl-ebay-duplicates.js
```

**Aktion**: ARCHIVE nach `backend/scripts/archive/baselinker/` mit `README.md` "do not run, historic only".
**Operator-Entscheidung nötig**: ja — könnte für Ad-hoc-Daten-Surgery noch gebraucht werden.

### 1.3 Binary-Docs im Repo (634 Findings)

Top-Treffer:
- Root: `AvyCloud_Analyse_Marktbewertung*.docx/.pdf`, `AvyCloud_Roadmap.pptx`, `AvyCloud_KnowledgeBase.html`, `AvyCloud_Produktdaten_QuickGuide.pdf`
- Root: `BL__Products__default_CSV_*.csv`, `04_baselinker_categories.xlsx`, `2022_September_Kategorien_*.xlsx`
- `docs/`: `ebay_orders.xls` (389 KB) + `.txt` (484 KB) — sind Snapshots, keine Doku
- `archive/uiv2/`: ~500 historische Files (bereits archiviert, OK)

**Aktion**: Im Root-Verzeichnis Files nach `docs/archive/2026-Q2/repo-root-binaries/` verschieben. `docs/ebay_orders.*` nach `docs/archive/2026-Q2/`.
**Operator-Entscheidung nötig**: ja — könnte als Backup/Reference benötigt werden.

### 1.4 .DS_Store-Files

Mehrere im Repo (bereits in `.gitignore` Zeile 21, aber historisch committed). 

**Aktion**: `git rm --cached **/.DS_Store` (entfernt nur aus Index, lokal bleiben).
**Operator-Entscheidung nötig**: nein — sicher.

### 1.5 Pläne und Prompts (38 Dateien in `docs/prompts/`)

Cross-check mit TASKS.md zeigt: viele bereits umgesetzt. Empfohlene Frontmatter-Erweiterung:
```yaml
---
status: done | pending | archived
relatedCommit: <sha>
---
```

**Aktion**: Skript erstellen das `docs/prompts/*.md` annotiert. Ältere `done`-Prompts in `docs/archive/prompts-2026-Q1/` schieben.
**Operator-Entscheidung nötig**: ja, weil massenhaft Files berührt werden.

---

## Sektion 2: Firestore Inventory

### 2.1 POTENTIALLY_DEAD (19 von 55 Collections)

Diese Collections werden im Backend-Code nicht (mehr) referenziert:

| Collection | Doc-Count | Vermutete Ursache |
|------------|-----------|-------------------|
| `stock_sync_failures` | 51.380 | Möglich umbenannt zu `stock_operation_failures` — alte Collection wuchs weiter |
| `inventorySyncLogs` | 16.557 | Legacy aus Pre-V2-Era |
| `qualityJobs` | 10.930 | Quality-Runner schreibt evtl. unter anderem Namen |
| `userSessions` | 1.251 | Session-Tracking-Collection unklar |
| `ebayPublishLog` | 962 | Publish-Audit, evtl. ersetzt durch `kaufland_publish_runs`-Pattern |
| `external_api_calls` | 927 | Wird laut Code geschrieben (`external-api-tracker.js`) — Audit hat False-Negative wegen Match-Pattern. **Verifizieren!** |
| `baselinker_sku_index` | 1.634 | BaseLinker-Legacy (CLAUDE #9) |
| `audit_log` | 2.026 | Naming-Variant von `auditLogs`? |
| `auditLogs` | 43 | Mini-Variant |
| `adminBulkJobs` | 98 | Bulk-Action-Runner schreibt evtl. unter anderem Namen |
| `baselinkerSyncJobs` | 230 | BaseLinker-Legacy |
| `ebayListingReports` | 120 | Reports-Pipeline |
| `integration_settings` | 3 | Settings-Doppelpfad zu `company_settings`? |
| `inventories` | 9 | Legacy |
| `metaCounters` | 1 | Klein, evtl. Counter-Initial |
| `number_sequences` | 3 | Order-Number-Sequence |
| `oauthStates` | 10 | OAuth-PKCE-Flow Reste |
| `roles` | 4 | RBAC-Roles — RBAC nutzt das, Audit-False-Negative wahrscheinlich |
| `rulebookApplyJobs` | 14 | Rule-Apply-Pipeline |
| `rulebookConfigs` | 1 | RuleBook-Config |
| `shipping_methods` | 146 | Shipping-Engine — Audit-False-Negative wahrscheinlich |
| `stock_locks` | 1 | Stock-Lock — Audit-False-Negative wahrscheinlich (Code nutzt!) |
| `users` | 7 | Auth-Users — RBAC nutzt das, Audit-False-Negative |

**Hinweis**: einige sind False-Negatives weil das Audit-Skript exakte `.collection('name')` String-Matches sucht. `users`, `roles`, `stock_locks`, `external_api_calls`, `shipping_methods` werden definitiv verwendet (siehe Coding-Pattern). Manual-Review nötig.

### 2.2 Echte Toten-Kandidaten (high confidence)

| Collection | Doc-Count | Empfehlung |
|------------|-----------|------------|
| `baselinker_sku_index` | 1.634 | EXPORT → DELETE (BaseLinker-Legacy) |
| `baselinkerSyncJobs` | 230 | EXPORT → DELETE |
| `inventorySyncLogs` | 16.557 | EXPORT → DELETE (Legacy V1) |
| `stock_sync_failures` | 51.380 | EXPORT → ARCHIVE (verifizieren ob `stock_operation_failures` Nachfolger; massive Storage-Ersparnis) |
| `qualityJobs` | 10.930 | Verifizieren + TTL-Policy |

**Operator-Aktion**: pro Collection separater PR mit Export + Delete-Script.

### 2.3 Indexing-Lücken (entdeckt während Audit)

- `identificationJobs` und `improveJobs`: FAILED_PRECONDITION beim Orphan-Count → Composite-Index fehlt für `(status, completedAt)`.
- `stock_operation_failures`: Audit zeigt 10 Docs (alle `abandoned`); Index für `(tenantId, status, createdAt)` fehlt (siehe Hardening-Plan).

### 2.4 TTL-Kandidaten (Append-Only)

Brauchen Firestore-TTL-Policy via Console (Operator):

| Collection | Doc-Count | TTL-Empfehlung |
|------------|-----------|----------------|
| `stock_sync_log` | 183.149 | 30 Tage |
| `stock_reconciliation_log` | 4.699 | 90 Tage |
| `warehouseEvents` | 2.792 | 90 Tage |
| `order_events` | 1.997 | 365 Tage (audit) |
| `inventory_ledger` | 260 | 365 Tage (audit) |
| `external_api_calls` | 927 | 30 Tage |
| `chatSessions` | 500 | 60 Tage |
| `identificationJobs` (completed) | 177 | 30 Tage |
| `improveJobs` (completed) | 4.026 | 30 Tage |

---

## Sektion 3: GCS Inventory

### 3.1 STALE-Prefixes (alle Objekte > 90 Tage alt)

| Bucket / Prefix | Objects | Size MB | Aktion |
|-----------------|---------|---------|--------|
| `avycloud-genai-images/jobs` | 200 (Sample) | 412 | Lifecycle-Policy: nach 90d in Coldline, nach 180d delete |
| `avycloud-product-images/jobs` | 200 (Sample) | 367 | Lifecycle-Policy gleich |
| `products-and-jobs/products` | 80 | 153 | Verifizieren ob Bucket noch genutzt; falls nein: ARCHIVE |
| `trendocean/jobs` | 82 | 207 | Lifecycle-Policy: 90d → delete |
| `trendocean/product_images` | 52 | 124 | Verifizieren ob aktiv genutzt |
| `trendocean/products` | 53 | 83 | Verifizieren |
| `trendocean/fsexport` | 6 | 2 | Wahrscheinlich Firestore-Export, ARCHIVE |

### 3.2 ACTIVE aber lasten

| Bucket / Prefix | Aktive Objekte | Notiz |
|-----------------|-----------------|-------|
| `avycloud_cloudbuild/source` | 91 > 90d | Cloud-Build-Source-Snapshots — Lifecycle 30d empfohlen |
| `run-sources-avycloud-europe-west3/services` | 85 > 90d | Cloud-Run-Source-Snapshots — Lifecycle 30d empfohlen |

**Operator-Aktion**: GCS-Lifecycle-Rules per Bucket setzen.

---

## Sektion 4: Cloud Run Inventory

### 4.1 Service-Status

| Service | Region | Status | Revisions | OldestWithTraffic |
|---------|--------|--------|-----------|-------------------|
| `product-hub-backend` | europe-west3 | **dormant** | 50 | `product-hub-backend-01449-2dg` (2026-05-18) |

**Anomalie**: Status "dormant" + LastDeploy 2025-11-09 widerspricht der OldestWithTraffic-Revision von 2026-05-18. Audit-Skript könnte LastDeploy-Erkennung falsch interpretieren. **Verifizieren** ob Service tatsächlich aktiv oder ob Traffic auf eine andere Service-URL geht.

### 4.2 Revisions-Prune

50 Revisionen für einen Service ist viel. Standard: behalte aktive + letzte 5 für Rollback.

**Operator-Aktion**:
```bash
gcloud run revisions list --service=product-hub-backend --region=europe-west3 --format=json | \
  jq '.[] | select(.status.conditions[].status=="False") | .metadata.name' | \
  head -40 | xargs -I{} gcloud run revisions delete {} --region=europe-west3 --quiet
```

---

## Sektion 5: Dead/Unused Dependencies

| Package | Section | Problem |
|---------|---------|---------|
| `framer-motion` | root/deps | **DEAD** — kein `import` im Frontend-Code |
| `node-fetch` | undeclared | **ERROR** — imported (`require('node-fetch')`) aber nicht in `package.json` deklariert |
| `p-limit` | undeclared | **ERROR** — imported aber nicht deklariert |

### 5.1 framer-motion entfernen

```bash
cd /Users/oguz/Dev/avycloud && npm uninstall framer-motion
```

**Spart**: ~40 KB Bundle.

### 5.2 node-fetch + p-limit hinzufügen

```bash
cd /Users/oguz/Dev/avycloud/backend && npm install node-fetch@2 p-limit
```

Hinweis: `node-fetch@2` für CommonJS-Kompatibilität. Node 20 hat zwar globales `fetch`, aber wenn der Code es explizit imported, gehört es in `package.json`.

**Operator-Aktion**: separater PR, beide Schritte testen.

---

## Sektion 6: ENV-Vars + KB-Coverage

### 6.1 ENV-Vars in CLAUDE aber nicht in Feature-Flags-Doku (53 Stück)

Alle dokumentiert in CLAUDE.md, aber nicht in [docs/kb/03-development/feature-flags.md](03-development/feature-flags.md). Siehe `_audit-runs/audit-kb-coverage-2026-05-18.md` Sektion `env-flag`.

**Aktion**: Subagent "Foundation-Docs" hat den Katalog auf 39 Einträge erweitert; weitere 14 müssen ergänzt werden. Siehe Drift-Workflow.

### 6.2 KB-Coverage-Gaps

| Kategorie | Missing | Wo dokumentieren |
|-----------|---------|------------------|
| ENV-Flags | 53 | `docs/kb/03-development/feature-flags.md` |
| Features | 15 | `docs/kb/06-features/<id>.md` |
| API-Routen | 12/15 | `docs/kb/09-api/<name>.md` (3 schon dokumentiert) |
| Integrationen | 5/7 | `docs/kb/08-integrations/<name>.md` |
| Pages | 0 | Alle Views in `docs/kb/05-pages/README.md` erwähnt |

Hinweis: API + Features + Integrations + Pages wurden in dieser Session bereits parallel geschrieben — der Coverage-Check zeigt Stand vor dieser Session. **Re-Run nach Commit** zeigt das verbesserte Bild.

---

## Wave 7 — Bereits ausgeführte sichere Aktionen (Stand 2026-05-18)

✅ KB-Skeleton angelegt (17 Sektionen, 13 Persona-Dateien)
✅ AGENTS.md im Repo-Root als Coding-Agent-Pflichtlektüre
✅ CLAUDE.md Session-Start additiv erweitert (Punkt 1+2 verweisen auf AGENTS + KB)
✅ Help-Drawer Backend-Route mountiert (additive, hinter requireAuth)
✅ Help-Drawer Frontend-Component live (additive via Portal in index.tsx)
✅ CI-Drift-Protection-Workflow `.github/workflows/kb-drift-and-tests.yml` angelegt
✅ 7 Audit-Skripte ausgeführt, Reports unter `docs/kb/_audit-runs/`

## Wave 8 — Offene Operator-Entscheidungen

Siehe **[TASKS.md → Cleanup Operator Decisions](../../TASKS.md)**.

Jeder offene Punkt braucht:
1. Operator-Approval (Engineering-Lead oder Founder)
2. Eigener PR mit `--dry-run` Sichtung
3. Anschließende `--apply`-Ausführung
4. Update dieses Reports + TASKS.md

---

## Drift-Protection

Dieser Report wird **alle 90 Tage** durch Re-Run der Audit-Skripte aktualisiert:

```bash
cd /Users/oguz/Dev/avycloud
node backend/scripts/audit-repo-cruft.js
node backend/scripts/audit-firestore-cruft.js
node backend/scripts/audit-gcs-cruft.js
node backend/scripts/audit-cloud-run.js
node backend/scripts/audit-deps.js
node backend/scripts/audit-kb-coverage.js
node backend/scripts/audit-flags-extended.js
```

Outputs landen in `docs/kb/_audit-runs/<script>-YYYY-MM-DD.md`. Quarterly-Reminder via CI-Workflow (Job `kb-coverage`) ergänzen.

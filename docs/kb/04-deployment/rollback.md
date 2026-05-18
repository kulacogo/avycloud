---
title: Rollback
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# Rollback

> Schnelle Wege, ein fehlerhaftes Deployment rückgängig zu machen.

## Frontend (Firebase Hosting)

### Variante A — Firebase Console (empfohlen, schnellste)

1. Öffne die [Firebase Hosting Console](https://console.firebase.google.com/project/avycloud/hosting) für das Projekt `avycloud`.
2. Site `avycloud` → Tab „Releases".
3. Wähle das vorherige Release.
4. Klicke „Rollback".
5. Verifikation: `https://avycloud.web.app/` lädt das ältere Build (Hard-Reload + Service-Worker leeren).

> **Caching-Verhalten**: `index.html` und `service-worker.js` sind via [firebase.json](../../../firebase.json) explizit `no-cache, no-store, must-revalidate`. Nach Rollback sollte der nächste Page-Load die alte Version ziehen. Bei sturem Browser: DevTools → Application → „Clear storage" + Unregister Service-Worker.

### Variante B — CLI

```bash
firebase hosting:clone <site>:<version> <site>:live --project=avycloud
```

Siehe [Firebase Hosting Rollback-Doku](https://firebase.google.com/docs/hosting/manage-hosting-resources) *(externe Quelle, muss verifiziert werden für genaue Flag-Syntax)*.

## Backend (Cloud Run)

Cloud Run versioniert jedes Deploy als **Revision**. Rollback = Traffic-Allocation auf eine ältere Revision.

### Variante A — Cloud-Console (empfohlen)

1. GCP Console → Cloud Run → Service `product-hub-backend` in Region `europe-west3`.
2. Tab „Revisions".
3. Wähle die letzte gesunde Revision.
4. „Manage Traffic" → 100 % auf gewählte Revision.
5. Verifikation: `/health` und `/ready` antworten 200 + Logs zeigen `Server listening on port 8080` mit erwartetem Build-Tag.

### Variante B — `gcloud` CLI

```bash
# Letzte 5 Revisions listen
gcloud run revisions list \
  --service=product-hub-backend \
  --region=europe-west3 \
  --project=avycloud \
  --limit=5

# Traffic 100% auf eine bestimmte Revision
gcloud run services update-traffic product-hub-backend \
  --region=europe-west3 \
  --project=avycloud \
  --to-revisions=product-hub-backend-00042-abc=100
```

### Variante C — Gradient-Rollback / Canary-Back

```bash
gcloud run services update-traffic product-hub-backend \
  --region=europe-west3 \
  --to-revisions=NEW_REV=10,OLD_REV=90
```

Nutzen wenn die Schäden noch unklar sind: 10 % bleibt auf neuer Revision für Diagnose, 90 % auf alter zur Risiko-Minimierung.

### Cleanup nach Rollback

- **Ursache analysieren** und Hotfix-Branch öffnen.
- **Tag annotieren** in Git (`git tag -a rollback/2026-05-18 -m "rollback wegen X"`) für Audit-Spur.
- **Operator + Reviewer** informieren (`stock!:` Subject-Prefix bei Stock-Architektur-Bug, siehe [docs/architecture/stock-single-source-of-truth.md](../../architecture/stock-single-source-of-truth.md) §Kontakt).

## Datenbank-Rollback

Firestore ist **schemafrei und additive-only** (Punkt 2 [CLAUDE.md](../../../CLAUDE.md)). Es gibt keinen klassischen DB-Rollback. Wege:

| Szenario | Vorgehen |
|----------|----------|
| Versehentliche Bulk-Mutation | Stop des Bulk-Runners; betroffene Dokumente aus Backup wiederherstellen oder per Script kompensieren. |
| Daten-Korruption (z. B. Geister-Produkte) | Audit-Script nutzen (`backend/scripts/audit-ghost-products.js`), Bestätigung, dann `--apply`. |
| Stock-Double-Decrement | `node backend/scripts/repair-double-decrement.js` (read-only audit + opt-in `--apply --confirm REPAIR_<DATE> --skus <list>`). Siehe [adr/0002-stock-single-writer.md](../02-architecture/adr/0002-stock-single-writer.md). |
| Firestore Point-in-Time-Recovery | **Annahme** — GCP-Standard ist aktiv (7 d Window). **Muss verifiziert werden** in der GCP Console. |

## ENV-Var-Rollback (Cloud Run)

ENV-Wechsel laufen außerhalb des Image-Deploys. Rollback einer ENV-Änderung:

```bash
gcloud run services update product-hub-backend \
  --region=europe-west3 \
  --update-env-vars=KEY=ALT_VALUE
# oder Variable komplett entfernen:
gcloud run services update product-hub-backend \
  --region=europe-west3 \
  --remove-env-vars=KEY
```

Beachte: `USE_PRODUCTS_V2=true` ist in [backend/cloudbuild.yaml](../../../backend/cloudbuild.yaml) verdrahtet und wird bei jedem Deploy neu gesetzt — kann nicht durch ENV-Rollback dauerhaft entfernt werden ohne Code-Change.

## Notfall-Checkliste

- [ ] Logs aufzeichnen vor Rollback (Beweise für Post-Mortem).
- [ ] Frontend ODER Backend rollbacken — selten beides gleichzeitig nötig.
- [ ] Verifizieren: `/health`, `/ready`, eine bekannte API-Sequenz (z. B. Identify-Smoke).
- [ ] Operator informieren.
- [ ] Post-Mortem-Ticket in [TASKS.md](../../../TASKS.md) anlegen oder als Incident-Run dokumentieren.

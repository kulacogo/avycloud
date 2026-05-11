# Runbook: D.0c `getAllProducts()` Throw-Flip

**Plan:** [/Users/oguz/.claude/plans/sieht-ziemlich-komplex-unstrukturiert-woolly-tulip.md](/Users/oguz/.claude/plans/sieht-ziemlich-komplex-unstrukturiert-woolly-tulip.md) — Phase D.0c.

**Zweck:** `backend/lib/firestore.js#getAllProducts()` final von Deprecation-Wrapper auf Throw umstellen. Sprint 7 hat alle 9 Production-Caller und 43 Scripts migriert; das pre-D.0c-Gate (`backend/scripts/audit-getAllProducts-callers.js`) ist seit 2026-05-10 grün (Exit 0, 0 Production + 0 Script Callers).

**Owner / Sign-off:** Backend-Tech-Lead (für die GoldeneRegel "Production darf NIEMALS negativ beeinflusst werden.")

---

## Status

- **Schritt 1 (DONE, 2026-05-10):** `getAllProducts()` ist Deprecation-Wrapper mit `console.warn('[DEPRECATED] getAllProducts() called without tenantId ...')`. Implementation BLEIBT funktional fuer Beobachtung. Commit: D.0c-Schritt-1.
- **Schritt 2 (PENDING, frühestens 2026-05-17):** Throw-Flip. Code-Patch liegt fertig in `backend/lib/firestore.js.d0c-throw.patch`.

---

## Pre-Conditions (alle MÜSSEN erfüllt sein)

- [ ] **>=7d Wartezeit seit Schritt-1-Deploy** (frühester Flip-Termin: 2026-05-17).
- [ ] **0 `[DEPRECATED] getAllProducts()`-Hits in Cloud-Logging** über die letzten 7d.
  - Abfrage (Log-Explorer, project=`avycloud`, service=`product-hub-backend`):
    ```
    resource.type="cloud_run_revision"
    resource.labels.service_name="product-hub-backend"
    textPayload:"[DEPRECATED] getAllProducts()"
    ```
  - Time-Range: 7d. Erwartet: 0 results.
  - Bei >0 Hits: Caller anhand des mitgeloggten Stacks identifizieren, migrieren auf `getAllProductsForTenant(tenantId)`, neuen 7d-Zähler starten.
- [ ] **Audit-Script grün:** `node backend/scripts/audit-getAllProducts-callers.js` → Exit 0, `production_caller_count == 0`, `script_caller_count == 0`.
- [ ] **Baseline-Tests grün:** `cd backend && npm test` mit allen Files grün (Baseline: 116 Files, 1647 Tests vor D.0c).
- [ ] **Frontend-Build grün:** `npx vite build` ohne Errors.
- [ ] **Pre-Deploy-Tag gesetzt:** `git tag pre-d0c-revert-point <commit-vor-Throw-Flip>` damit Rollback einen festen Anker hat.

---

## Throw-Flip-Commit (Schritt 2)

1. Pre-Deploy-Tag setzen:
   ```bash
   cd /Users/oguz/Dev/avycloud
   git tag pre-d0c-revert-point HEAD
   git push origin pre-d0c-revert-point
   ```

2. Patch anwenden:
   ```bash
   cd /Users/oguz/Dev/avycloud
   git apply backend/lib/firestore.js.d0c-throw.patch
   ```

   Ziel-Body von `getAllProducts()` nach Patch:
   ```js
   async function getAllProducts(options = {}) {
     throw new Error(
       'getAllProducts() removed (Phase D.0c). Use getAllProductsForTenant(tenantId).'
     );
   }
   ```

3. Test umstellen — neue Datei `backend/__tests__/lib/firestore-getallproducts-throw.test.js`
   (oder das bestehende `firestore-getallproducts-deprecation.test.js` ersetzen)
   mit:
   ```js
   describe('getAllProducts() — Phase D.0c Throw-Flip', () => {
     it('rejects with removal-Error', async () => {
       await expect(getAllProducts()).rejects.toThrow(
         /removed \(Phase D\.0c\)\. Use getAllProductsForTenant/
       );
     });
   });
   ```
   Der Backward-Compat-Test aus Schritt 1 entfaellt.

4. Suite gruen ziehen, deployen, Cloud-Logging-Watch:
   ```bash
   cd /Users/oguz/Dev/avycloud/backend && npm test
   npm run build
   gcloud run deploy product-hub-backend --source . --region europe-west3
   ```

5. **Post-Deploy Watch (60 min):** Cloud-Logging nach
   `getAllProducts() removed (Phase D.0c)` filtern. Erwartet: **0 Errors**.
   Falls >0 → sofort Rollback (siehe unten).

---

## Rollback-Procedure

Bei jedem unerwarteten Error-Spike, 5xx-Anstieg oder Stacktrace mit
`getAllProducts() removed (Phase D.0c)` in Production:

1. Stop the bleeding — letzten gruenen Revision-Tag deployen:
   ```bash
   gcloud run services update-traffic product-hub-backend \
     --region europe-west3 \
     --to-tags pre-d0c=100
   ```
   (Setzt voraus, dass der Pre-Deploy-Commit als `pre-d0c-revert-point` getaggt
   wurde und der Cloud-Run-Revision `pre-d0c-revert-point` zugewiesen ist.)

2. Alternativ: lokaler Git-Revert + Re-Deploy
   ```bash
   git checkout pre-d0c-revert-point -- backend/lib/firestore.js
   git commit -m "revert: D.0c throw-flip — restore deprecation wrapper"
   git push origin main
   ```
   GitHub-Actions / Cloud Build deployen automatisch zurueck.

3. Root-Cause klaeren:
   - Welcher Caller blieb in den 7d Watch-Logs unsichtbar? (z.B. Cron-Job der
     monatlich laeuft, Cloud-Function ohne Logging, externer Webhook).
   - Caller migrieren auf `getAllProductsForTenant(tenantId)`.
   - 7d-Watch neu starten.

---

## Sign-off

- [ ] **Backend-Tech-Lead:** Pre-Conditions verifiziert, Patch reviewed.
- [ ] **On-Call Rotation:** ueber Flip-Termin informiert (Pager-Standby).
- [ ] **Owner-Tenant (TrendOcean):** ueber Throw-Flip-Schedule informiert (defensive).

---

## Anhang — Verifikations-Snippets

**Audit-Script-Exit 0 verifizieren:**
```bash
cd /Users/oguz/Dev/avycloud/backend && node scripts/audit-getAllProducts-callers.js > /dev/null && echo "GREEN" || echo "RED"
```

**Schritt-1-Deprecation-Test grün:**
```bash
cd /Users/oguz/Dev/avycloud/backend && npm test -- firestore-getallproducts-deprecation
```

**Full Backend-Suite:**
```bash
cd /Users/oguz/Dev/avycloud/backend && npm test
```

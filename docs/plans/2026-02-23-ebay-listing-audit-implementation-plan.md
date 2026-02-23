# eBay Listing Audit + Fast Listed Indicator Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the `/ebay` module with a holistic eBay listing audit (findings + improvement suggestions + “apply to eBay”) and make the Products-grid “listed + link” indicator dynamically fresh via a fast Light‑Sync.

**Architecture:** Split eBay operations into (1) **Light‑Sync** (Trading `GetMyeBaySelling` only) to keep `ebayListingsLive` fresh for indicators, and (2) **On‑Demand Audit** per listing (Trading `GetItem` + taxonomy requirements + Browse competitor insights) persisted as `ebayListingAudits/{itemId}` with actionable suggestions that can be applied via Trading revise calls.

**Tech Stack:** Node.js/Express backend, Firestore, React/TypeScript frontend (frontend-v2), eBay Trading API, eBay Browse API

---

### Task 1: Backend — Add audit storage + shared helpers

**Files:**
- Create: `backend/lib/ebay-listing-audit.js`
- Modify: `backend/lib/ebay-direct.js` (to export new helpers if needed)

**Step 1: Create Firestore constants + helper utilities**

- In `backend/lib/ebay-listing-audit.js`, implement:
  - `EBAY_AUDITS_COLLECTION = 'ebayListingAudits'`
  - `safeString`, `safeLower`, `asArray`, `toNumber` (reuse patterns from `ebay-direct.js`)
  - `nowIso()` helper

**Step 2: Define normalized output shapes**

- Implement:
  - `buildAuditDoc({ itemId, listing, evidence, findings, suggestions, status, actor, runId })`
  - Ensure payload is JSON-serializable (no Timestamp objects unless explicitly desired)

**Step 3: Manual verification**

- Run: `node -e "require('./backend/lib/ebay-listing-audit') && console.log('ok')"`
- Expected: prints `ok`

---

### Task 2: Backend — Implement Light‑Sync (fast “listed?” refresh)

**Files:**
- Modify: `backend/lib/ebay-direct.js`
- Modify: `backend/index.js`

**Step 1: Add fast ingest function (no GetItem)**

- In `backend/lib/ebay-direct.js`, add:
  - `async function fetchLiveListingsSummaryFromEbay({ maxPages, entriesPerPage, timeoutMs } = {})`
    - Uses Trading API `getMyeBaySellingActive` pages only
    - Returns `{ listings: activeItems, summary }`

**Step 2: Add new sync function**

- Add:
  - `async function syncLiveListingsLight({ runId, actor, maxPages, entriesPerPage, timeoutMs } = {})`
    - Calls `fetchLiveListingsSummaryFromEbay`
    - Upserts into `ebayListingsLive` using `upsertLiveListings` with merge semantics
      - IMPORTANT: do not overwrite existing detail fields with `null`
    - Runs `deactivateListingsMissingFromActiveSet` only when ingest is complete
    - Stores run summary in `ebayListingReports` (optional) or a lightweight ops doc

**Step 3: Add server-side cooldown/lock**

- Implement simple lock doc in Firestore (e.g. `ops/ebayLightSync`):
  - If `running=true` → return `{ skipped:true, reason:'running' }`
  - If last completed < 60s → return `{ skipped:true, reason:'cooldown' }`

**Step 4: Expose endpoint**

- In `backend/index.js` add:
  - `POST /api/ebay/listings/light-sync` (permission: `products:write`)
  - Body: `{ maxPages?, entriesPerPage?, timeoutMs?, runId? }`
  - Response: `{ ok:true, data:{ skipped?, summary } }`

**Step 5: Manual verification**

- Run backend locally, then:
  - `curl -X POST http://localhost:8080/api/ebay/listings/light-sync -H 'Content-Type: application/json' -d '{}'`
- Expected: `ok:true` (or clear error about missing trading config)

---

### Task 3: Backend — Extend listing detail mapping for audit inputs (pictures + shipping snapshot)

**Files:**
- Modify: `backend/lib/ebay-trading-api.js`

**Step 1: Add safe extraction helpers**

- Add helper functions to extract:
  - `pictureUrls: string[]` from `Item.PictureDetails.PictureURL`
  - `shippingSummary` subset from `Item.ShippingDetails` (avoid storing the entire complex node initially)
  - `returnSummary` subset from `Item.ReturnPolicy` when present

**Step 2: Extend `mapListingDetail`**

- Add `pictureUrls`, `shippingDetails`, `returnPolicy` (subset) to the returned object.

**Step 3: Manual verification**

- Run: `node -e "const { getItemDetails } = require('./backend/lib/ebay-trading-api'); console.log('loaded', typeof getItemDetails)"`
- Expected: prints `loaded function`

---

### Task 4: Backend — Implement on-demand Audit compute + persist

**Files:**
- Modify: `backend/lib/ebay-listing-audit.js`
- Modify: `backend/index.js`
- Modify (optional): `backend/lib/ebay-direct.js` (reuse `getListingDetail` fetch/persist patterns)

**Step 1: Compute competitor title insights**

- Reuse `backend/lib/ebay-browse-title-insights.js`:
  - `fetchCategoryTitleInsights({ categoryId, query })`
- In audit compute:
  - Use `listing.primaryCategoryId`
  - Use `query`: start with `listing.title` trimmed to <= 100 chars (safe default)

**Step 2: Compute required aspects**

- Reuse `backend/lib/ebay-taxonomy.js`:
  - `getCategoryAspectCatalog(categoryId)` and/or `getRequiredAspects(categoryId)`
- Compare to `listing.itemSpecifics` keys:
  - Findings: `missing_required_aspects[]`, `missing_recommended_aspects[]`

**Step 3: Title quality checks**

- Deterministic checks:
  - Length (preferred 70–80, hard max 80)
  - Keyword coverage vs `topTokens` from Browse insights
  - Missing brand/mpn tokens if present in specifics
- Output:
  - Findings + Suggestions (patchable `title` when safe)

**Step 4: Picture checks**

- Deterministic checks:
  - `pictureUrls.length < 5` warn
  - Optionally: for first 1–2 URLs fetch image headers / dimensions later

**Step 5: Persist audit doc**

- Save to `ebayListingAudits/{itemId}` with:
  - `status: fresh | failed`
  - `updatedAtIso`
  - `listingSnapshot`
  - `findings[]` and `suggestions[]`

**Step 6: Expose endpoints**

- In `backend/index.js` add:
  - `POST /api/ebay/listings/:itemId/audit` (permission: `products:read` or `write` depending on evidence)
  - `GET /api/ebay/listings/:itemId/audit`

**Step 7: Manual verification**

- `curl` audit for a known itemId (from `/api/ebay/listings`):
  - `POST /api/ebay/listings/<itemId>/audit`
  - `GET /api/ebay/listings/<itemId>/audit`
- Expected: JSON with findings/suggestions

---

### Task 5: Backend — Apply suggestions (“Übernehmen → eBay aktualisieren”)

**Files:**
- Modify: `backend/lib/ebay-listing-audit.js`
- Modify: `backend/index.js`

**Step 1: Define patch schema**

- Support initial safe patch fields:
  - `title` (<=80)
  - `description` (string)
  - `itemSpecifics` (map string → string|string[])
- Reject/ignore in v1:
  - shipping changes, price changes, picture changes (until fully supported)

**Step 2: Implement Trading revise**

- Use `backend/lib/ebay-trading-api.js`:
  - Decide call: `ReviseFixedPriceItem` for fixed-price listings, else `ReviseItem`
  - Use existing helpers `reviseFixedPriceItem` / `reviseItem`

**Step 3: Handle known restrictions**

- If Trading revise fails with an error indicating “Inventory model listing cannot be revised”:
  - Return `ok:false` with actionable message:
    - “Dieses Listing wurde via Inventory API/MIP erstellt; Trading-Revise ist nicht erlaubt.”
  - (Inventory API write path is optional follow-up, requires `sell.inventory` scope.)

**Step 4: Expose endpoint**

- In `backend/index.js` add:
  - `POST /api/ebay/listings/:itemId/apply`
  - Body: `{ suggestionIds?: string[], patch?: object }`

**Step 5: Post-apply refresh**

- Mark audit doc as `stale` or write an audit event.
- Optionally trigger Light‑Sync (best-effort) or return `shouldRefresh: true`.

---

### Task 6: Frontend API client — new eBay endpoints

**Files:**
- Modify: `frontend-v2/api/client.ts`

**Step 1: Add functions**

- `runEbayListingsLightSync(payload?)` → `POST /api/ebay/listings/light-sync`
- `runEbayListingAudit(itemId)` → `POST /api/ebay/listings/:itemId/audit`
- `fetchEbayListingAudit(itemId)` → `GET /api/ebay/listings/:itemId/audit`
- `applyEbayListingSuggestions(itemId, payload)` → `POST /api/ebay/listings/:itemId/apply`

**Step 2: Manual verification**

- Build frontend and ensure TypeScript compiles.

---

### Task 7: Products Grid — make eBay indicator dynamic (no more dependency on slow full sync)

**Files:**
- Modify: `frontend-v2/components/views/AdminTable.tsx`

**Step 1: Add Light‑Sync refresh loop**

- On mount:
  - Load `fetchEbaySkuIndex()` (existing)
  - Trigger `runEbayListingsLightSync()` in background
  - On success, reload `fetchEbaySkuIndex()`

- Repeat every 2 minutes:
  - Only when `document.visibilityState === 'visible'`

**Step 2: UX**

- Add a subtle “refreshing…” state (no blocking UI).

---

### Task 8: eBay Page — replace comparison UI with holistic audit UI + apply

**Files:**
- Modify: `frontend-v2/components/views/EbayListingsView.tsx`
- Modify (optional): `frontend-v2/types.ts` (only if strict typing needed)

**Step 1: Add “Audit” panel**

- When a listing is selected:
  - Show last audit timestamp + status (fresh/stale)
  - Button: “Audit aktualisieren” → calls `runEbayListingAudit(itemId)` then reloads audit

**Step 2: Render findings + suggestions**

- Show grouped sections:
  - Titel
  - Parameter/Aspekte
  - Bilder
  - Beschreibung
  - Preis/Versand (v1: mostly informational)
- For each suggestion:
  - “Übernehmen” button → `applyEbayListingSuggestions(itemId, { suggestionIds:[id] })`

**Step 3: Remove AvyCloud↔eBay comparison view**

- Remove or hide `buildSpecificsComparisonRows` output and any “avyValue vs listingValue” UI.

---

### Task 9: Verification checklist

**Step 1: Smoke test Products-grid indicator**

- Open Products page, watch eBay column:
  - should update within ~seconds after load
  - should keep updating every 2 minutes (visible tab)

**Step 2: Smoke test eBay audit**

- Open `/ebay`, pick a listing:
  - audit runs, produces suggestions
  - apply a safe suggestion (title/specs/description) updates listing via Trading revise

---

## Execution options

Plan complete and saved to `docs/plans/2026-02-23-ebay-listing-audit-implementation-plan.md`.

Two execution options:

1. **Subagent-Driven (this session)** — dispatch subagent per task, review between tasks.
2. **Parallel Session (separate)** — execute with checkpoints in a new session.


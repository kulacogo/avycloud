# Los-Struktur Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline).
> Spec: `docs/superpowers/specs/2026-07-31-los-struktur-design.md` — dort stehen
> Datenmodell, Formate und Rollout. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Paletten-Funktion vollständig durch Los-Struktur (L-/NL-Codes) ersetzen,
inkl. QR-Labels, Erfassen-Pflicht, Migration aller Produkte auf NL-0626.

**Architecture:** Neue Firestore-Collection `warehouse_lots` + reine Code-Lib
`backend/lib/warehouse-lots.js`; Routes in `routes/warehouse.js`; Identify-Gate in
`routes/identify.js` von `paletteCode`/`warehouseBins` auf `lotCode`/`warehouse_lots`
umgestellt; Frontend-Tab `LotStructureTab` + `LotSelector` im Erfassen; zwei
dry-run-first-Scripts für Cleanup und Initialbuchung.

**Tech Stack:** Node/Express CJS, Firestore, Vitest (require.cache-Patching),
React 18 + TS, bestehender Label-Printer (qrcode + pdfkit).

## Global Constraints

- Kein `inventory.quantity`-Write, keine Stock-Pfade anfassen (CLAUDE.md 10/13/15).
- `warehouse_lots`-Queries mit `tenantId` (Regel 8). Firestore additiv (Regel 2).
- Los-Format exakt: `L-MMYYNN` (NN 01–99 zweistellig, 100–200 dreistellig), `NL-MMYY`.
- Label-Format identisch zu BIN-Labels (62×29 mm, QR = roher Code).
- Backend 2 Spaces/Single Quotes CJS; Frontend 2 Spaces/Double Quotes TS.
- Tests nie löschen; Route-Order: `/lots/labels*` vor `/lots/:code`.

---

### Task 1: Los-Code-Lib (TDD)
**Files:** Create `backend/lib/warehouse-lots.js`, Test `backend/__tests__/warehouse-lots.test.js`
**Produces:** `buildLotCode({type,month,year,number})`, `parseLotCode(code)`,
`isValidLotCode(code)`, `parseLotNumberSelection(input)` (→ number[]),
`createLots({type,month,year,numbers,tenantId,createdBy})` → `{created,skipped}`,
`listLots({tenantId})` → Array mit `productCount`, `getLotByCode`, `updateLot`, `deleteLot`, `lotExists`.
- [ ] Failing Tests: Owner-Beispiele (`L-072612`, `NL-0726`), Padding 01–09,
      dreistellig 100/200, Monat 00/13 invalid, Nummer 0/201 invalid, Roundtrip,
      Range-Parser `"1-38"`/`"12"`, NL ohne Nummer.
- [ ] Implementierung, Tests grün, Commit.

### Task 2: Lots-Endpoints + Labels
**Files:** Modify `backend/routes/warehouse.js`
- [ ] GET/POST `/lots`, PATCH/DELETE `/lots/:code`, GET `/lots/labels`(+`.pdf`)
      vor `/lots/:code`; Wiederverwendung `buildBinLabelsHtml/Pdf`; Commit.

### Task 3: Identify-Gate + Services + stock-in
**Files:** Modify `backend/routes/identify.js`, `services/identify-v3.js`,
`services/identify-v4.js`, `routes/warehouse.js` (stock-in), Tests
`identify-v4-route.test.js`, `identify-v3.test.js`, `identify-v3-assemble.test.js`,
`integration/identify-v3-migration.test.js`
- [ ] `lotCode` (Fallback `paletteCode`-Wert), LOT_REQUIRED/LOT_NOT_FOUND gegen
      `warehouse_lots`; 5 Schreibpfade → `ops.sourceLot/At`; meta.lotCode;
      v3/v4 assembleProduct; stock-in `meta.lotCode`; Tests angepasst; Commit.

### Task 4: Zone P Backend raus
**Files:** Modify `backend/lib/warehouse.js`
- [ ] `ZONES` ohne 'P', `createPaletteBins` + Branch gelöscht; Commit.

### Task 5: Frontend Los-Struktur-Tab
**Files:** Create `components/warehouse/LotStructureTab.tsx`; Modify
`components/WarehouseView.tsx`, `api/client.ts`, `types.ts`
- [ ] `WarehouseLot`-Typ; API-Wrapper fetch/create/update/delete + Label-Windows;
      Tab an Position 2; Formular (Monat/Jahr vorbelegt), Liste, EK-Inline-Edit,
      Druck, Löschen; Commit.

### Task 6: Erfassen auf Los
**Files:** Create `components/capture/LotSelector.tsx`; Delete `PaletteSelector.tsx`;
Modify `CaptureView.tsx`, `StepUpload.tsx`, `StepAnalysis.tsx`,
`hooks/useIdentification.ts`, `App.tsx`, `api/client.ts` (identifyProductV2),
`components/MobileOperationsView.tsx`, `components/OperationsView.tsx`,
`components/ProductSheet.tsx`, `components/warehouse/WarehouseSettingsView.tsx`,
`types.ts`, `i18n.tsx`
- [ ] Durchgehend `lotCode`; Mobile ohne `inputMode="none"`; Stow-meta `lotCode`
      (mobil + Desktop); ProductSheet-Los-Badge; tote Keys raus; Commit.

### Task 7: Zone P Frontend raus
**Files:** Modify `components/WarehouseView.tsx`, `types.ts`
- [ ] ZONE_OPTIONS/Formular/Kachel/isPalette raus; Commit (mit Task 5/6 kombinierbar).

### Task 8: Scripts
**Files:** Create `backend/scripts/cleanup-palette-bins.js`,
`backend/scripts/assign-initial-lot.js`
- [ ] Beide dry-run-first (`--apply`), Details siehe Spec; Commit.

### Task 9: Docs/KB
**Files:** Modify `docs/kb/09-api/identify.md`, `docs/kb/09-api/warehouse.md`,
`docs/kb/05-pages/capture.md`, `docs/kb/00-quickstart/produkt-erfassen.md`,
`CLAUDE.md` (Kurzeintrag Los-Struktur), help-bundle regenerieren falls Script existiert.
- [ ] Commit.

### Task 10: Verifikation + Review + Deploy
- [ ] `cd backend && npm test` grün; Frontend `npm run build` grün.
- [ ] Adversarialer Review-Workflow über den Diff; Findings fixen.
- [ ] Merge auf `main`, Push (Cloud Build + GH Actions deployen).

### Task 11: Produktions-Migration
- [ ] `cleanup-palette-bins.js` dry-run → apply (nur leere Bins).
- [ ] `assign-initial-lot.js` dry-run (Zahlen prüfen: ~1.678 Produkte) → apply.
- [ ] Verifikation: Los NL-0626 productCount == Produktanzahl; keine
      `ops.sourcePalette`-Werte mehr; Bericht an Owner.

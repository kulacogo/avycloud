# Los-Struktur (L-/NL-Lose) statt Paletten — Design

**Datum:** 2026-07-31 · **Owner-Abnahme:** mündlich („genau. leg los!") · **Branch:** `feat/los-struktur`

## Ziel

Die Paletten-Funktion (Zone „P", Bin-Codes `P{ETAGE}{NNN}` wie `PEG001`) wird vollständig
entfernt und durch **Lose** ersetzt. Ein Los ist die Einkaufs-Zugehörigkeit einer Ware:

- **`L-MMYYNN`** — Auktions-Los. `L-` + Monat (2-stellig) + Jahr (2-stellig) + Los-Nummer
  (01–200; 1–99 zweistellig mit führender Null, 100–200 dreistellig).
  Beispiele: `L-072612`, `L-072620`, `L-0726100`.
- **`NL-MMYY`** — Non-Los (nicht über Auktion erworben). Genau eins pro Monat.
  Beispiele: `NL-0626`, `NL-0726`.

Zweck: Beim Wareneingang wird der Rollwagen/Gitterwagen sofort mit dem L-Label beklebt.
Über `ops.sourceLot` am Produkt sind später Artikelliste und Einkaufspreis je Los ermittelbar.
Der EK-Betrag (brutto) wird am Los-Dokument gepflegt.

Nach dem Rollout werden ALLE bestehenden Produkte initial auf **`NL-0626`** gebucht
(initialer Einkauf Mischware, **EK 14.000 € brutto**). Es dürfen keine Reste des
Paletten-Formats übrig bleiben — weder in der UI noch im Erfassen-Modul noch in den
Produktdaten (`ops.sourcePalette` wird geleert).

## Nicht im Scope / Tabu

- Das COGS-Kostenmodell („Palettenpreis brutto", `palletCostBrutto`/`unitsPerPallet`,
  `lib/cost-model.js`, AdminFinancials) ist ein EIGENES Feature und bleibt unangetastet.
- Marktplatz-Taxonomie-Daten mit „Paletten"-Kategorienamen (backend/ebay-data, backend/kaufland).
- Historische `warehouseEvents` (behalten `meta.paletteCode` als Altdaten).
- Firestore-Altfelder werden nicht schema-gelöscht — `ops.sourcePalette` wird per Migration
  auf `null` gesetzt (explizite Owner-Anweisung „keine Reste"), das Feld selbst bleibt.

## Datenmodell

Neue Collection **`warehouse_lots`** (Doc-ID = Los-Code):

```js
{
  code: 'L-072612',
  tenantId: 'default',
  type: 'L' | 'NL',
  month: 7,            // 1-12
  year: 2026,          // volles Jahr
  number: 12 | null,   // nur bei L (1-200)
  ekBrutto: 14000 | null,  // EUR brutto, am Los gepflegt
  note: 'Initialer Einkauf Mischware' | null,
  createdAt: Timestamp,
  createdBy: { uid, email } | null,
}
```

Produkte erhalten (additiv): `ops.sourceLot` (string) + `ops.sourceLotAt` (ISO).
`productCount` je Los wird NICHT gespeichert, sondern per Firestore-`count()`-Aggregation
über `products_v2 where tenantId=='default' AND ops.sourceLot==code` ermittelt
(Equality-only → Index-Merging, kein Composite-Index nötig).

## Backend

- **Neu `backend/lib/warehouse-lots.js`:** `buildLotCode`, `parseLotCode`, `isValidLotCode`,
  `parseLotNumberSelection` (1–200, Einzelwert oder „Start-Ende"), `createLots` (skip existing,
  Rückgabe `{created, skipped}`), `listLots` (mit productCount), `getLotByCode`, `updateLot`
  (ekBrutto/note), `deleteLot` (wirft bei productCount > 0 — fail-closed).
- **Routes in `backend/routes/warehouse.js`** (gleiches Permission-Schema `warehouse read/write`):
  `GET /api/warehouse/lots`, `POST /api/warehouse/lots` (Body `{type, month, year, numbers}`),
  `PATCH /api/warehouse/lots/:code`, `DELETE /api/warehouse/lots/:code`,
  `GET /api/warehouse/lots/labels` (HTML) + `GET /api/warehouse/lots/labels.pdf` — Label-Routen
  VOR `/lots/:code` registriert (Route-Shadowing). Label-Rendering über die bestehenden
  `buildBinLabelsHtml`/`buildBinLabelsPdf` (62×29 mm, QR = roher Code).
- **Identify-Gate (`backend/routes/identify.js`):** liest `lotCode` (Fallback: Wert aus
  Altfeld `paletteCode` alter Bundles), normalisiert `trim().toUpperCase()`.
  Fehler: `LOT_REQUIRED` („Los-Zuordnung ist Pflicht für neue Ware.") bzw. `LOT_NOT_FOUND`
  (mit Hinweis „ggf. App neu laden"). Existenz-Check gegen `warehouse_lots`.
  Schreibt `ops.sourceLot`/`ops.sourceLotAt` auf allen 5 Pfaden (4× Duplikat-Reuse, 1× Neu).
  Der Wall-Clock-Anker (IDENTIFY_TOTAL_TIMEOUT_MS) bleibt NACH der Los-Validierung.
- **identify-v3/v4:** Option `lotCode`; `assembleProduct` schreibt `ops.sourceLot`/`sourceLotAt`
  (die Felder `sourcePalette`/`sourcePaletteAt` entfallen im neu assemblierten Produkt).
- **stock-in (`POST /api/warehouse/stock-in`):** akzeptiert `lotCode` top-level → `meta.lotCode`
  (ersetzt `paletteCode`-Durchreichung).
- **Zone P raus:** `ZONES` ohne `'P'`, `createPaletteBins` + P-Branch in
  `createWarehouseLayout` gelöscht.

## Frontend

- **Neuer Tab „Los-Struktur"** in der Lagerverwaltung (`components/WarehouseView.tsx`,
  TAB_CONFIG an 2. Stelle) → neue Komponente `components/warehouse/LotStructureTab.tsx`:
  Los anlegen (Typ L/NL, Monat+Jahr automatisch mit aktuellem Datum vorbelegt, bei L
  Nummern-Eingabe „12" oder „1-38"), Liste aller Lose mit Produktanzahl + EK brutto
  (inline editierbar), Auswahl + „Los-Labels drucken" (gleicher authed-Popup-Flow wie
  BIN-Labels), Löschen nur bei 0 Produkten.
- **Zone P raus:** ZONE_OPTIONS ohne 'P', Paletten-Formular-Branch, Button-Label,
  isPalette-Zonenkachel-Sonderfall, Hinweistext — alles entfernt. `types.ts`:
  `WarehouseZoneCode` ohne 'P', `WarehouseLayout.isPalette` entfernt.
- **Erfassen Desktop:** `PaletteSelector.tsx` gelöscht → neu `LotSelector.tsx`
  (Autocomplete gegen `fetchWarehouseLots()`, Label „Los (Pflicht)"). `CaptureView`/
  `StepUpload`/`StepAnalysis`/`useIdentification`/`App.tsx`/`api/client.ts identifyProductV2`:
  Parameter durchgehend `lotCode`, FormData-Feld `lotCode`.
- **Erfassen Mobile (`MobileOperationsView.tsx`):** Pflicht-Feld „Los (Pflicht)"
  (`identifyLotCode`), Placeholder `L-072601`; dabei `inputMode="none"` entfernt
  (Android-IME-Falle, Incident 2026-07-25). Stow-Pfad sendet `meta.lotCode` aus
  `ops.sourceLot`; Desktop-Stow (`OperationsView.tsx`) zieht gleich (Parität).
- **ProductSheet:** Lagerplatz-Sektion zeigt „Los: <Code> (seit <Datum>)" aus
  `ops.sourceLot`; Palette-Badge entfernt.
- **Aufräumen:** `WarehouseSettingsView` DEFAULT_ZONE_TYPES ohne 'palette'-Eintrag,
  toter i18n-Key `input.inventory.scanHint` (de/en/tr) entfernt.

## Scripts (dry-run-first, beide read-only per Default)

1. **`backend/scripts/cleanup-palette-bins.js`** — listet alle `warehouseBins` mit
   `zone=='P'` inkl. productCount/Behälter; `--apply` löscht NUR leere Paletten-Bins
   plus die Zonen-Docs `P_GA`/`P_UG`/`P_EG`. Nicht-leere Bins blocken (fail-closed).
2. **`backend/scripts/assign-initial-lot.js`** — legt `NL-0626` an (ekBrutto 14000,
   note „Initialer Einkauf Mischware"), setzt auf ALLEN products_v2-Docs
   `ops.sourceLot='NL-0626'` + `ops.sourceLotAt` und leert `ops.sourcePalette`/
   `ops.sourcePaletteAt` (null). Bewusst DIREKTER Firestore-Update statt
   `saveProductV2()`: reiner ops-Marker ohne Inventar-/Inhalts-Felder — exakt das
   Muster der Identify-Reuse-Pfade. Ein Massen-Lauf durch `saveProductV2` würde
   Titel-/Aspect-Policies auf 1.678 Produkte anwenden (Massen-Mutations-Risiko,
   vgl. Veredler-Vorfall). Kein `emitSyncEvent` nötig (kein Bestands-Feld).

## Rollout-Reihenfolge

1. Merge auf `main` → Backend (Cloud Build web+worker) + Frontend (GH Actions) starten zusammen.
   **Bekanntes Skew-Fenster:** Das Frontend ist typischerweise Minuten vor dem Backend live;
   in dieser Zeit antwortet das alte Backend auf `lotCode`-Requests mit `PALETTE_REQUIRED`.
   Selbstheilend nach Backend-Deploy; der LotSelector zeigt Ladefehler mit „Erneut laden".
   Rollout deshalb in ruhiger Zeit fahren und Backend-`/health` vor dem ersten Erfassen prüfen.
2. `cleanup-palette-bins.js` dry-run → apply (PEG-Bins sind laut UI leer: 10 Bins, 0 Produkte).
3. `assign-initial-lot.js` dry-run → apply.
4. Offene alte Browser-Tabs müssen einmal neu laden (alte Bundles senden `paletteCode`,
   der gegen `warehouse_lots` nicht validiert → klare Fehlermeldung mit Reload-Hinweis).

## Fehlerbehandlung & Invarianten

- Kein Flag: Owner hat explizit den Ersatz angeordnet; Alt-Verhalten wäre mit gelöschten
  PEG-Bins ohnehin funktionslos.
- Stock-Pfade (`bookStockIn`/`bookStockOut`, Oversell-Invarianten CLAUDE.md 13/15)
  werden NICHT berührt — Lose sind reine Zuordnungs-Metadaten, kein Bestand.
- Los-Löschung und Bin-Löschung sind fail-closed (Server prüft Zuordnung/Inhalt).
- `warehouse_lots`-Queries mit `tenantId`-Filter (Regel 8); products-Count nutzt
  Equality-Merging (tenantId + ops.sourceLot), kein Composite-Index.

## Tests

- Neu `backend/__tests__/warehouse-lots.test.js`: Code-Format (Beispiele des Owners),
  Padding, 100–200 dreistellig, Monatsgrenzen, Nummern-Range-Parser, Parse-Roundtrip.
- Angepasst: `identify-v4-route.test.js` (Gate gegen `warehouse_lots`, Feld `lotCode`),
  `identify-v3.test.js`, `identify-v3-assemble.test.js`, `identify-v3-migration.test.js`
  (ops-Shape mit `sourceLot`).

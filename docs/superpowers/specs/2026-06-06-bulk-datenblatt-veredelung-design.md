# Design-Spec: Bulk-Datenblatt-Veredelung + Engine-Parität

> Datum: 2026-06-06
> Status: Entwurf zur Freigabe
> Pilot-Scope: 33 Markisen (Marken HOMEDEMO + BelleMax)
> Goldene Regel: Production darf NIEMALS negativ beeinflusst werden. Additive, flag-gesteuert, in-place.

---

## 1. Problem & Belege

Das „Erfassen" reichert bei No-Name-Marken die Datenblätter unzureichend an. Manuelles Nachbessern ist zur Regel geworden. Aus den echten Daten der 33 Markisen (22 HOMEDEMO, 11 BelleMax):

- **0 von 33** sind „ready" (alle Qualitäts-Score < 0,6; eBay-ready beginnt bei 0,6).
- **0 von 33** haben einen echten Verkaufspreis (`sellPrice`); ~13 haben gar keinen Preis.
- **12 sind aktuell live auf eBay** — mit kaputtem Datenblatt (kein echter Preis, dünn). 3 inaktiv, 18 nicht gelistet, 0 auf Kaufland.
- Titel teils nur ~45 Zeichen, Pflicht-Aspekte (z. B. „Produktart") fehlen, 3 Beschreibungen nur ~260 Zeichen.

### Ursache (Code)
1. **Einzelschuss-Engine:** Erfassen macht **einen** Gemini-Grounding-Versuch. Bei unbekannten Marken findet Google nichts → kein Preis, dünner Inhalt (`backend/routes/identify.js`).
2. **Preis-Pfad nur Legacy:** Der Preis-Nachschlag (`enrichPriceParallel`) läuft nur im alten Legacy-Pfad, **nicht** im aktuellen Grounding/V3/V4-Pfad. Der Preis bekommt nie eine zweite Chance.
3. **„Improve" reicht nachweislich nicht:** Viele Markisen tragen `ops.last_saved_source = job-improve` und sind **trotzdem** ohne Preis bei Score 0,49. `improveExistingProduct()` (`backend/services/improve.js`) nutzt dieselbe Einzelschuss-Technik. → Naives Bulk-Improve löst das Problem NICHT.
4. **Paritäts-Lücke:** Der Chat (`backend/services/product-chat-v3.js`) ist agentisch (bis 10 Runden, atomic-tools: eBay-Katalog, Amazon, Hersteller-Seite, GTIN). Erfassen/Improve sind Einzelschuss. Deshalb gelingt es im Chat, aber nicht beim Erfassen.

### Gute Ausgangslage
Die Regeln für ein gutes Datenblatt sind im Code maschinell prüfbar:
- `evaluateEbayReady()` — `backend/lib/datasheet-quality.js:68` (binäres eBay-ready + Issues)
- `scoreProductCassini()` — `backend/lib/cassini-scorer.js:916` (Score 0..1, 5 Säulen)

Darauf bauen wir eine messbare „Definition of Done".

---

## 2. Ziele / Nicht-Ziele

### Ziele
- Eine **verlässliche Bulk-Lösung**, die die 33 Markisen-Datenblätter auf Standard hebt — ohne Bestand zu gefährden.
- Manuelles Nachbessern auf ein **Minimum** senken: Job liefert eine **präzise Restliste** (welche SKU, welches Feld fehlt) statt Blindflug.
- **Engine-Parität:** Erfassen/Improve werden agentisch wie der Chat, damit künftige No-Name-Produkte nicht erneut scheitern.
- Vorbereitung einer **leistungsgetriggerten Re-Optimierung** für Low-Performer (Phase 3).

### Nicht-Ziele
- **Kein automatischer Hintergrund-Lauf** (kein täglicher Cron/Drip). Der Veredler läuft **ausschließlich manuell auf Knopfdruck** — du startest jeden Lauf.
- Kein Auto-Push zu eBay/Kaufland (Listen + Angebote-Aktualisieren bleiben **manuell**).
- Keine eBay/Kaufland-Aufrufe/Beobachter-Anbindung (nicht nötig — siehe §8).
- Keine Änderung an Bestand, SKU, Lager, Auth, Routen-Verträgen.

---

## 3. Sicherheits-Vertrag (HART, nicht verhandelbar)

Der Veredler/Bulk-Job **darf NIEMALS**:

1. ein Produkt **neu erzeugen** (der `identify`-Pfad mit neuer UUID wird nicht benutzt).
2. **SKU** ändern (`identification.sku`).
3. **Bestand/Menge** anfassen (`inventory.quantity`, `inventory.*`).
4. **Lager/Einlagerungen** anfassen (`storage`, `storageBins`, Lagerplatz).
5. **Identität** anfassen (`ops.identity_key`, `ops.base_product_id`).
6. **Marktplätze automatisch updaten** (keine `publishProduct`/`createUnit`/`reviseFixedPriceItem`-Aufrufe).

Erlaubt: **nur Inhaltsfelder** des bestehenden Produkts, in-place über die vorhandene ID, geschrieben via `saveProductV2(..., { source: 'content-enrich', skipStockEvent: true })`.

**Strukturelle Garantie (verifiziert):** `saveProductV2` ist datenblatt-only. Der einzige automatische Marktplatz-Sync ist die Bestandsmenge und feuert nur bei Änderung von `inventory.quantity` — was dieser Job nie tut. Inhalt/Preis erreichen ein Live-Angebot ausschließlich über die manuellen Publish-Routen.

---

## 4. Definition of Done (Abnahme-Gate)

Ein Datenblatt gilt als **fertig**, wenn:
- `evaluateEbayReady()` keine `error`-Issues meldet, UND
- `scoreProductCassini().overall >= 0.6`.

Feld-Kriterien (aus dem Code abgeleitet):
- **Titel** (`identification.name`): 65–80 Zeichen, Marke + Produktart in den ersten Wörtern, keine verbotenen Zeichen.
- **Beschreibung** (`details.short_description`): ≥ 260 Zeichen, strukturiert.
- **Preis** (`details.pricing` → echter `sellPrice` aus Sweet-Spot, plus `lowest_price` mit Quellen-URL): vorhanden, ≥ 1 €, plausibel.
- **Pflicht-Aspekte** (`details.attributes`): alle eBay-required gefüllt, kein „Unbekannt", ≤ 45.
- **GPSR** (`details.gpsr`): Verantwortlicher gemäß bestehender Logik.
- **Gewicht** (`ops.weight_grams` / `details.weight`): vorhanden (für Versand).
- **Kategorie** (`details.categoryId`): Breadcrumb, plausibel.

Ergebnis-Buckets pro Lauf: **fertig (≥0,6, keine Fehler)** / **verbessert, aber noch nicht fertig** / **braucht Mensch** (mit Feldliste).

---

## 5. Architektur

Drei additive Komponenten + zwei klar getrennte Mechanismen.

### 5.1 Komponente A — Agentischer Inhalts-Veredler (das Herzstück)
**Neu:** `backend/services/content-enricher.js` → `enrichProductContent(product, opts)`

- Nimmt ein **bestehendes** Produkt (per ID/Objekt), arbeitet auf einer tiefen Kopie der **Inhaltsfelder**.
- Wiederverwendung vorhandener Bausteine (kein Neubau):
  - atomic-tools: `search_ebay_catalog`, `search_amazon_product`, `search_manufacturer_site`, `lookup_gtin`, `verify_brand`, `fetch_url_content` (`backend/services/atomic-tools.js`)
  - `computeSweetSpotPrice()` (`backend/lib/sweet-spot-pricer.js`) → **echter `sellPrice`** aus gefundenen Vergleichen
  - `buildEbayTitle()` (`backend/lib/seo-title-builder.js`), `buildEbayDescription()` (`backend/lib/seo-description-builder.js`)
  - `enforceAspectCap()` (`backend/lib/aspect-cap-enforcer.js`)
- **Begrenzte Schleife (Bring-up):** misst nach jeder Runde mit `evaluateEbayReady`/`scoreProductCassini`, ruft gezielt Tools für **die noch schwachen Felder**, stoppt bei Standard **oder** nach `MAX_ITER` (Default 3–5). Kein Dauerlauf.
- **Gap-aware:** Felder, die den Standard schon erfüllen, bleiben (auch manuelle). Nur fehlende/zu schwache Felder werden gehoben.
- **Rückgabe:** `{ changed: {feld: {alt, neu}}, scoreBefore, scoreAfter, ready, remainingIssues[] }`. Schreibt **nicht** selbst — der Aufrufer entscheidet (Dry-Run vs. Apply).

### 5.2 Komponente B — Bulk-Aktion
**Neu:** Aktion `reenrich_content` in `backend/services/admin-bulk-actions.js`, registriert in `runBulkAction()` (Switch ~Z. 2113), erreichbar über die bestehende, erprobte Maschinerie `POST /api/admin/bulk/run` (`backend/routes/admin.js:826`).

> **Betriebsart: ausschließlich manuell.** Du löst jeden Lauf selbst aus. Kein Cron, kein automatischer Drip.

- Erbt: **Dry-Run als Default** (`apply:false`), GCS-Report, p-queue, per-Tenant, `productIds`/Filter.
- Ziel-Auswahl: Marke ∈ {HOMEDEMO, BelleMax} (Pilot) oder `productIds`.
- Pro Produkt: laden → `enrichProductContent` → Score vorher/nachher → Report. Bei `apply:true`: in-place via `saveProductV2(source:'content-enrich', skipStockEvent:true)` **und** Auto-Improve-Marker setzen (§5.3).
- **Eligibility-Gate** vor jeder Veränderung (Freeze-Regel, §6).
- Report (GCS): pro SKU `scoreBefore/After`, `changed`-Felder, Bucket, Restliste. Plus Summen.

### 5.3 Komponente C — Auto-Improve-Indikator (Transparenz)
**Neues Feld** (additiv) am Produkt:

```
ops.autoImprove = {
  lastAppliedAt: ISO,
  appliedChanges: ["title","description","price","attributes",...],
  scoreBefore: number, scoreAfter: number,
  reviewStatus: "pending_review" | "approved" | "rejected",
  reviewedBy: string|null, reviewedAt: ISO|null,
  source: "bulk:reenrich_content"
}
```

- **AdminTable:** kleiner Badge in/neben der Readiness-Spalte (`components/AdminTable.tsx` ~Z. 878, Muster `ReadinessBadge` Z. 64–77): „Auto-verbessert".
- **ProductSheet:** Banner oben (nach dem Identifikations-Block, vor den Tabs): „Auto-verbessert — bitte prüfen", mit Liste der geänderten Felder + Buttons **Übernehmen / Verwerfen** (setzt `reviewStatus`, speichert via `saveProductV2`).
- Solange `reviewStatus = pending_review`, signalisiert der Indikator: hier wurde automatisch geändert, Live-Angebot ggf. veraltet → **du** entscheidest über manuelles Re-Publish.

### 5.4 Zwei Mechanismen (getrennt)
- **Bring-up** (Komponente A, score-getrieben): nur bei Produkten **unter Standard**. Begrenzte Schleife bis ≥0,6. → der Pilot.
- **Re-Optimierung** (Phase 3, **leistungs**-getrieben, score-agnostisch): einziger Grund, ein **gelistetes** Angebot erneut anzufassen. Darf auch ein gut aussehendes Datenblatt ändern (Preis, Attribut-Wording, Kategorie), weil 0 Verkäufe = etwas stimmt nicht. Nie bei gut laufenden Angeboten. **Auch dieser Lauf wird manuell ausgelöst** (eigene Bulk-Aktion für Low-Performer) — kein Cron.

---

## 6. Eligibility / Freeze-Regel

| Zustand | Bring-up | Re-Optimierung |
|---|---|---|
| Nicht gelistet **oder** unter Standard (<0,6) | ✅ | — |
| Gelistet **und** ready (≥0,6) **und** läuft gut | ❌ **eingefroren** | ❌ |
| Gelistet **und** Low-Performer | (i. d. R. schon ready) | ✅ (opt-in) |

- „Gelistet?" aus `ops.listingStatus.ebay/kaufland` (vom `listing-sync-runner`, ≤15 min frisch).
- „Ready?" aus `scoreProductCassini`/`evaluateEbayReady`.
- Im Pilot: 0/33 ready → Freeze blockiert nichts. Schützt v. a. den späteren Rollout.

---

## 7. Feldumfang

**Anfassbar (Inhalt):** `identification.name` (Titel), `details.short_description`/`description`, `details.key_features`, `details.pricing` (`sellPrice` + `lowest_price`), `details.attributes`, `details.gpsr`, `details.weight`, `ops.weight_grams`, `marketplace.ebay/kaufland` Titel/Beschreibung (nur im Datenblatt, kein Push).

**TABU (nie):** `identification.sku`, `inventory.*`, `storage`, `storageBins`, Lagerplatz, `ops.identity_key`, `ops.base_product_id`, alles Bestands-/Lager-bezogene. Kein Anlegen neuer Produkte. Kein Marktplatz-Publish.

---

## 8. Low-Performer-Erkennung (Phase 3)

Ohne neue Marktplatz-Anbindung, nur aus vorhandenen Daten:
- **Verkäufe pro SKU** aus eigenen Bestellungen (`backend/services/inventory-forecast.js` rechnet das bereits aus `orders` → `items[].sku/quantity`).
- **Listing-Alter** aus `ebayListingsLive.startTime` (`backend/lib/ebay-direct.js`).
- Regel (Vorschlag): gelistet ≥ N Tage (z. B. 30) **und** 0 (oder ≤ Schwelle) Verkäufe → Low-Performer-Kandidat.
- eBay-Aufrufe/Beobachter: bewusst **nicht** nötig (Kaufland bietet es ohnehin nicht).

---

## 9. Feature-Flags (additiv, default sicher)

- `CONTENT_ENRICH_ENABLED=false` (default) — schaltet Komponente A frei.
- `CONTENT_ENRICH_MAX_ITER=4` — Schleifen-Obergrenze (Bring-up).
- `CONTENT_ENRICH_TIMEOUT_MS=120000` — Gesamt-Timeout pro Produkt.
- `IDENTIFY_CONTENT_ENRICH_FALLBACK=false` (default) — Phase 2: Erfassen ruft den Veredler als Auffang, wenn Grounding dünn bleibt.
- `IMPROVE_USE_CONTENT_ENRICH=false` (default) — Phase 2: Improve nutzt den Veredler statt Einzelschuss.
- `REOPTIMIZE_LOWPERF_ENABLED=false` (default) — Phase 3: schaltet die **manuell ausgelöste** Low-Performer-Bulk-Aktion frei (kein Cron).

Rollback = Flag auf `false`. Bestehendes Verhalten bleibt unberührt.

---

## 10. Fehlerbehandlung & Idempotenz

- Jede Tool-/LLM-Stufe in try/catch; ein Fehler degradiert das einzelne Feld, bricht nicht den Lauf (analog bestehender Pipelines).
- Idempotent: erneuter Lauf auf einem schon-fertigen Produkt ändert nichts (Gap-aware + Score-Check).
- Dry-Run schreibt nie; Apply schreibt atomar pro Produkt; Per-Produkt-Fehler landen im Report, nicht im Crash.
- Strukturierte Logs + GCS-Report.

---

## 11. Tests (Vitest, require.cache-Patching)

- Unit: `enrichProductContent` füllt fehlenden Preis (Mock-Comps) → `sellPrice` gesetzt; kurzer Titel → ≥65 Zeichen; fehlende Pflicht-Aspekte → gefüllt; **Bestand/SKU/Lager bleiben identisch** (Schlüssel-Test des Sicherheits-Vertrags).
- Unit: Gap-aware — bereits gutes Feld wird nicht überschrieben.
- Unit: Eligibility/Freeze — gelistet+ready → kein Change.
- Unit: Bulk-Aktion Dry-Run schreibt nichts; Report-Form korrekt.
- Regression: kein `publish`/`createUnit`/`reviseFixedPriceItem` wird aufgerufen (Spy-Assertion).
- Bestehende Baseline grün: `cd backend && npm test` + `npm run build`.

---

## 12. Rollout / Phasen

- **Phase 0:** Komponente A (`content-enricher.js`) + Tests. Kein Verhaltens-Change (Flag aus).
- **Phase 1 (Pilot, liefert sofort Wert):** Bulk-Aktion `reenrich_content` + Auto-Improve-Indikator (Feld + UI). Dry-Run auf die 33 Markisen → Review → `apply` → manuelles Re-Publish der 12 Live-Angebote durch dich.
- **Phase 2 (Parität):** Veredler in Erfassen + Improve einhängen (Flags).
- **Phase 3 (Re-Optimierung):** Low-Performer-Erkennung + **manuell ausgelöste** Re-Optimierungs-Bulk-Aktion (kein Cron).

Jede Phase einzeln ausroll- und abschaltbar.

---

## 13. Annahmen / Offene Punkte

- `MAX_ITER` und `N Tage`/Verkaufs-Schwelle sind Startwerte, im Pilot kalibrierbar.
- Spec-Ablage folgt dem brainstorming-Default (`docs/superpowers/specs/`); bei Wunsch verschiebbar nach `docs/features/<ID>/spec.md`.
- Re-Publish der verbesserten Live-Angebote bleibt manuell (bestehende Publish-Buttons).

---

## 14. Zentrale Code-Referenzen

- Bulk-Maschinerie: `backend/routes/admin.js:826`, `backend/services/admin-bulk-actions.js` (Switch ~2113), `backend/services/admin-bulk-runner.js`
- Speichern (datenblatt-only, Bestand geschützt): `backend/lib/product-store.js`
- Qualitäts-Gate: `backend/lib/datasheet-quality.js:68`, `backend/lib/cassini-scorer.js:916`
- Bausteine: `backend/lib/sweet-spot-pricer.js`, `backend/lib/seo-title-builder.js`, `backend/lib/seo-description-builder.js`, `backend/lib/aspect-cap-enforcer.js`, `backend/services/atomic-tools.js`
- Einzelschuss-Engine (zu härten): `backend/routes/identify.js`, `backend/services/improve.js`
- Verkaufs-Velocity: `backend/services/inventory-forecast.js`
- Listing-Status (read-only): `backend/services/listing-sync-runner.js`, `backend/lib/ebay-direct.js`
- UI: `components/AdminTable.tsx` (~878, Badge 64–77), `components/ProductSheet.tsx` (~1026)

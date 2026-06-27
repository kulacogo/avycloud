# AvyCloud Fundamente — lebende Dokumentation (Claude-Strang)

> **Eine Datei, fortlaufend gepflegt.** Keine Streudateien mehr.
> **Teil 1** ist für dich: einfache Sprache, keine Technik.
> **Teil 2** ist der technische Detailgrad für die Umsetzung.
> Beides lebt hier und wird hier aktualisiert — unten ein Änderungslog.
>
> **Stand:** 2026-06-17 · **Strang:** Claude. Parallel laufen andere Stränge:
> „Reliability Core" / Marketplace-Sync (`specs/2026-06-17-marketplace-sync-foundation.md` —
> der andere Strang hat seine Dokumente ebenfalls in eine Datei konsolidiert) und die Landingpage.
> **Am Ende werden alle Stränge verglichen und zusammengeführt.**
> Ich fasse die Dokumente der anderen Stränge **nicht** an.

---
---

# TEIL 1 — Einfach erklärt (für dich)

## Was AvyCloud sein muss
Ein Abo-Produkt für mehrere Firmen, das jeden Tag verlässlich läuft, ohne dass jemand eingreift:
1. **Bestand stimmt** — was angezeigt wird, liegt so im Regal. Immer.
2. **Kein Überverkauf** — verkauft heißt sofort überall reduziert.
3. **Foto → fertiges Listing** funktioniert — ohne dass Produkte verloren gehen oder „Produkt" heißen.
4. **Aufträge laufen sauber** vom Eingang bis Versand/Retoure, mit korrektem Bestand.
5. **Eine konsistente, schöne Oberfläche** — gleiche Begriffe, gleiche Zustände, überall.

## Was heute kaputt ist (in einfachen Worten)
- **Bestand wird geraten, nicht geführt.** Das System rechnet den Bestand jedes Mal neu, indem es errät, welcher Regaleintrag zu welchem Produkt gehört. Stimmt das Raten nicht, ist Ware „weg".
- **Identify legt Doppel-Datenblätter an**, nennt Produkte manchmal nur „Produkt", und **verliert** beim Mehrfach-Erkennen Produkte (5 erkannt → 4 übrig).
- **„Alles optimieren" macht nicht alles** — nur einen festen Teil.
- **Storno/Retoure bucht den Bestand nicht zurück** — er bleibt auf 0.
- **Oberfläche und Status sind uneinheitlich**; die Mandanten-Trennung ist nicht erzwungen.

## Die Fundamente (was gebaut wird)
1. **Bestand als Lagerbuch** — jede Bewegung wird gebucht (wie ein Kontoauszug). Der Bestand ist die Summe der Buchungen. Nichts überschreibt ihn je. → „Ware verschwindet" wird baulich unmöglich.
2. **Aufträge** — jede Auftragsaktion erzeugt genau eine Lagerbuchung; Storno/Retoure bucht automatisch zurück.
3. **Identify + Datenblatt** — die Erkenner *erkennen* nur; ein einziges „Tor" prüft Dubletten, Qualität und Platzhalter und speichert. Nichts geht mehr still verloren; „Alles optimieren" deckt wirklich alles ab.
4. **Oberfläche + Mehr-Mandanten** — ein Status überall, ein Design-System, garantierte Trennung der Kundendaten, ein Überblick „brennt irgendwo etwas?".

## Wie mein Strang zum „Reliability Core"-Strang passt
Der andere Strang („Reliability Core") ist **stark beim Maschinenraum**: Marktplatz-Sync, Bestand-Wahrheit, Aufträge, Listings, Fehler-Wiederholung, Überblickszahlen. Damit es **kein doppelter, widersprüchlicher Plan** wird, gilt:
- **Beim Bestand und bei den Aufträgen** übernehme ich **dessen Begriffe und Modell** — kein Konkurrenz-Modell. Ich liefere dort den **Bauplan fürs Bestand-Lagerbuch**, den der andere Strang zwar beschrieben, aber auf „später" geschoben hat. Ich fülle also eine echte Lücke, statt etwas zu doppeln.
- **Identify + Datenblatt** ist **mein eigener Beitrag** — dieses Fundament fehlt beim anderen Strang ganz.
- **Oberfläche/Mehr-Mandanten** überschneidet sich mit deren späteren Fundamenten 2+3; ich liefere den fachlichen Detailteil dazu.

So passt am Ende alles zusammen, statt sich zu widersprechen.

## Status / Änderungslog
- **2026-06-17:** Konsolidierung in diese eine Datei. Bestands-/Auftrags-Teil an das Reliability-Core-Modell angeglichen (Lagerbuch = `warehouseEvents`, nicht ein zweites `stock_movements`). Identify- und UX-Fundament als eigenständiger Beitrag aufgenommen. Frühere Einzeldateien (Overview + 4 Specs + separater Plan) ersetzt durch dieses Dokument. Keine Production-Änderung — reine Planung.

---
---

# TEIL 2 — Technisch (granular)

## 0. Prinzipien + feste Begriffe

**Prinzipien (für alle Fundamente):** (1) eine Wahrheit pro Sache, alles andere ist markierte Ableitung · (2) Werte werden **gebucht, nicht geraten** · (3) ein einziger Schreiber pro kritischer Größe · (4) **idempotent** (jede Aktion wirkt höchstens einmal) · (5) feste Verknüpfungen über **unveränderliche IDs**, nie über SKU/EAN-Text · (6) Fehler sichtbar, nie still „repariert" durch Datenverlust · (7) `tenantId` in jeder Sammlung/Query/Job · (8) **Production heilig** (kein Bruch, kein Datenverlust, kein Downtime; Strangler-Migration, shadow-first, hinter Flag, dann promoten, dann Alt-Pflaster entfernen).

**Feste Begriffe — an Reliability Core angelehnt (ein Vokabular):**
- **Lagerbuch = `warehouseEvents`** (bestehend, append-only). `onHand = Σ warehouseEvents.delta`. `inventory.quantity` wird zur **abgeglichenen Projektion** (Anzeige/Cache), keine Wahrheit.
- **`lib/stock-core.js`** = der **einzige** Bestands-Schreiber/-Leser (kapselt `warehouse.js` + `stock-reservation.js`).
- **Mengen:** `onHand` (physisch) · `allocated` (offene Reservierungen, Key `(productId, orderId)`) · `availableToSell = max(0, onHand − allocated)` — **an einer Stelle berechnet** (`computeAvailableToSell`), von Sync/UI/Reconcile konsumiert. **An Marktplätze geht `availableToSell`.**
- **`sync_tasks`** = durable Queue (Reliability Core §4.2) — einziger Retry-Pfad, kein `setTimeout`.
- **Auftrags-Schreiber:** `transitionOrder()` (einzig). Jeder bestandswirksame Übergang erzeugt **eine** `warehouseEvents`-Buchung über `stock-core`.
- **Identify-Tor:** `lib/datasheet-gate.js commitDatasheet()` — Pipelines erkennen nur; das Tor macht Dedup/Identität/Qualität/Persistenz einmal für alle.
- **Feld-Register:** `lib/datasheet-fields.js` — die eine Liste aller Datenblatt-Domänen; „Alles optimieren" + Qualitäts-Gate lesen daraus.
- **Datenblatt-Status:** bestehendes 3-Zustands-Modell `utils/readiness.ts` (`ready`/`in_progress`/`pending` = „Bereit"/„In Bearbeitung"/„Ausstehend"); **Publish** ist davon getrennt, je Marktplatz.
- **Frontend:** nur Design-Tokens, Dark Mode default. Tests: Vitest + `require.cache`-Patching.

---

## A. Fundament 1 — Bestand (Lagerbuch)

> Liefert die **Umsetzung** des in Reliability Core §4.3 beschriebenen, aber dort auf „follow-on" verschobenen `stock-core`-Ledgers — angeglichen an dessen Modell, ergänzt um harte Sicherheits-Invarianten.

### A.1 Heutiges Problem (mit Code-Stellen)
- `refreshProductInventory()` (`backend/lib/warehouse.js:36-141`) leitet `inventory.quantity` + `storageBins` per Text-Matching (`buildProductKeySet`/`binEntryMatchesKeySet`, `warehouse.js:1259-1312`) aus `warehouseBins` ab und **überschreibt bedingungslos** (`:137-141`). Drift/Leer-Read → positiver Bestand wird still 0.
- Reconciliation `checkBinDrift()` (`services/stock-reconciliation.js:12-27`) vergleicht zwei **Ableitungen aus derselben Quelle** → blind für falsch genullten Bestand.
- `_onOrderCancelled` (`services/order-state-machine.js:372-417`) bucht **nie zurück** (nur `releaseReservation`); für „returned" gibt es keinen Pfad.
- Mehrere Funktionen schreiben `inventory.quantity` direkt → „Single Writer" ist dokumentiert, nicht gebaut.

### A.2 Zielbild
**`onHand = Σ warehouseEvents.delta`.** Bestand ändert sich nur durch Anhängen einer Buchung über `stock-core`. `inventory.quantity`/`storageBins` werden Projektionen, die **nur** durch Anwenden einer Buchung fortgeschrieben werden — der Pfad „aus dem Lager neu ableiten und überschreiben" existiert nicht mehr.

### A.3 Datenmodell
- **`warehouseEvents`** (Wahrheit, bestehend, append-only): `{ tenantId, productId (stabile Doc-ID), delta, type (receive|putaway|move|pick|ship|return_restock|adjust|reverse), fromLocation?, toLocation?, reason, sourceRef:{kind,id}, actor, createdAt, idempotencyKey, reversesEventId? }`.
- **`products_v2.inventory`** (Projektion, gecacht): `onHand`, `reserved`, `availableToSell`, `quantity` (Alias = `onHand`, additiv, kein Feld-Rename → CLAUDE.md Punkt 2), `locations[]`, `_lastEventId`, `_projectionAt`.
- **`stock_reservations`** (bestehend): speist `allocated`/`reserved`, Key künftig `(productId, orderId)` statt SKU (Reliability Core §4.4) — additiv.
- **`warehouseBins`**: behält **nur** die Layout-Rolle (Code/Zone/Etage/…); verliert die Rolle als Bestands-Wahrheit.

### A.4 Der eine Schreiber `stock-core.applyMovement(movement)`
Eine Firestore-Transaktion unter `withStockLock`: (1) validieren (productId existiert, type ∈ Enum, delta numerisch, idempotencyKey gesetzt); (2) **Idempotenz** über deterministische Event-Doc-ID = `sha1(tenantId|idempotencyKey)` — zweiter Aufruf = No-op (ersetzt den `stockDecrementedAt`-Marker-Hack); (3) Event anhängen; (4) Projektionen fortschreiben (`onHand += delta`, `availableToSell = max(0, onHand − allocated)`, Standort-Level, nie negativ); (5) nach Commit best-effort `notifyStockChange` + `stock:changed` → enqueue `sync_tasks` (nie-blockierend). **Idempotenz-Keys:** `receive:{receiptId}:{pid}`, `pick:{orderId}:{pid}`, `ship:{orderId}:{pid}`, `reverse:{reversesEventId}`, `return:{returnId}:{pid}`, `adjust:{countId}:{pid}:{loc}` …

### A.5 Invarianten (meine Ergänzung über Reliability Core hinaus)
1. **Kein stilles Nullen** — Bestand ändert sich nur durch eine Buchung; ein Leer-Read/Drift/Re-Identify erzeugt keine Buchung → Projektion unverändert.
2. **`onHand = Σ warehouseEvents.delta`** je `(tenant, productId)` — Abweichung wird **gemeldet**, nie still gefixt.
3. **Genau einmal** — `pick`/`ship` mutual exclusive pro `(orderId, productId)`; Storno bucht genau einmal zurück (`reverse:{eventId}`).
4. **Feste Verknüpfung** über stabile `productId` — SKU-Änderung kann keinen Bestand verlieren.
5. **`availableToSell`/Standort-Level nie negativ**; an Marktplätze geht `availableToSell`.
6. **Symmetrie** — zu jeder Abbuchung existiert ein idempotenter Gegenweg (`reverse`/`return_restock`).
7. **Append-only** — Korrektur nur per `adjust`/`reverse`, nie Überschreiben.

### A.6 Selbstprüfung (ersetzt `checkBinDrift`)
`reconcileLedger({tenantId})`: `Σ warehouseEvents.delta` gegen `inventory.onHand` und gegen Σ Standort-Level. Abweichung → **melden** (`stock_reconciliation_log` + Alert) und **nur durch Nach-Buchen** einer `adjust`-Buchung heilen. Marktplatz-Drift (`lib/marketplace-drift.js`, real-state) bleibt dem Reliability-Core-Strang überlassen; ich vergleiche lokal gegen `availableToSell`.

---

## B. Fundament 2 — Aufträge/OMS

### B.1 Problem
`transitionOrder` feuert Bestandsfolgen nur bei `shipped`/`cancelled`; `cancelled` gibt nur die Reservierung frei (keine Gegenbuchung), `returned` hat keinen Pfad → Bestand bleibt auf 0 (`order-state-machine.js:186-417`). Intake schreibt teils Felder direkt am Order-Doc.

### B.2 Zielbild
`transitionOrder` ist der einzige Auftrags-Schreiber; **jeder bestandswirksame Übergang ruft `stock-core.applyMovement`** (nie `decrementProductByIdOrSku`/`bookStockOut` direkt). Tabelle Übergang → Bewegung:

| Übergang | Bewegung | Idempotenz-Key |
|---|---|---|
| picked (Pick-with-order) | `pick` (−) | `pick:{orderId}:{pid}` |
| shipped (ohne vorherigen Pick) | `ship` (−) | `ship:{orderId}:{pid}` |
| shipped (nach Pick) | `ship` (delta 0, dokumentierend) | `ship:{orderId}:{pid}` |
| cancelled (nach Abbuchung) | `reverse` (+) | `reverse:{eventId}` |
| returned (verkaufsfähig) | `return_restock` (+) | `return:{returnId}:{pid}` |

`reconcileReservationsForOrder(orderId)` bei jedem terminalen Übergang (Reliability Core §4.4). Intake nur über `transitionOrder({force:true})` + ein `enrichOrderFields()`-Helfer; Lint/Test: kein `omsStatus`-Direktschreiben außerhalb `order-state-machine.js`.

### B.3 Invarianten/Tests
Storno-nach-Pick bucht genau einmal zurück; Retoure-B-Ware verliert keinen Bestand still (explizit als „nicht eingelagert" markiert, nicht verschwunden); `pick`+`ship` = ein Decrement; bestehende Tests (`stock-pick-then-ship-no-double-decrement`, `stock-shipped-idempotency`) bleiben grün.

---

## C. Fundament 3 — Identify + Datenblatt-Lebenszyklus  *(eigenständiger Beitrag — fehlt im Reliability-Core-Strang)*

### C.1 Probleme (mit Code-Stellen)
- **4 Pipelines** (V4 `routes/identify.js:322-401`, V3 `:474-540`, Grounding, Legacy) implementieren Dedup/Speichern/Qualität je selbst. V4 setzt `product` und **überspringt** die Post-V3-Dubletten-Prüfung → Doppel-Datenblatt → verlorener Bestand.
- **Platzhalter-Titel** („Produkt"/„Unbekanntes Produkt", `identify-v3.js:240-241`, `identify-v4.js:524-526`) werden als fertig gespeichert; die Route blockt nicht (`routes/identify.js` Save), der Batch-Pfad schon → inkonsistent. `isGenericTitle` (`v2-product-builder.js:28-34`) existiert, ist aber nicht ans Speicher-Tor angeschlossen.
- **Multi-Produkt 5→4:** Erkennung zählt eher zu wenig (`image-grouping.js` Prompt), fehlgeschlagene Gruppen werden still weggelassen (`StepAnalysis.tsx:301-352`), Duplikate kollabieren über geteilte ID.
- **„Alles optimieren"** fest auf 4 Domänen verdrahtet, an 3 Stellen dupliziert (`GeminiChat.tsx:307`, `batch-optimize.js`, V3 ignoriert scope).

### C.2 Zielbild — erkennen → ein Tor
- **Pipelines erkennen nur** → liefern einen Erkennungs-Entwurf. **`commitDatasheet()`** macht für alle: Dubletten-Prüfung über **stabile Identifier** (schließt die V4-Lücke baulich → ein Produkt = ein Datenblatt), Identität, **Qualitäts-Gate inkl. Platzhalter-Block** (ein Detektor `isPlaceholderTitle`), Persistenz via `saveProductV2`. Kein Pipeline-Pfad umgeht das Tor.
- **Lebenszyklus** auf dem 3-Zustands-Modell: Platzhalter-Titel/fehlende Pflichtfelder ⇒ nie `ready`, nie publish. Publish getrennt je Marktplatz.
- **Erkannte-Anzahl-Invariante:** die erkannte Stückzahl N wird Ende-zu-Ende mitgeführt; nichts wird still weggelassen — die Review zeigt N Einträge mit Status (erstellt / fehlgeschlagen+retry / als Duplikat zusammengeführt) und „N erkannt, M erstellt".
- **Feld-Register `datasheet-fields.js`:** „Alles optimieren" iteriert das Register in **allen** Pipelines (scope an V3 durchreichen, Tool-Schema um Bilder/Gewicht/SEO erweitern); Qualitäts-Gate liest dasselbe Register; die 3 duplizierten Subset-Definitionen entfallen.

### C.3 Migration/Tests
Register + Detektor zuerst → Tor parallel → Shadow-Diff → Pipelines schrittweise umhängen (Legacy→Grounding→V3→V4 + job-runner) → N-UX + scope → Alt-Pfade entfernen. Tests: Dedup (kein Duplikat bei vorhandenem Identifier), Platzhalter blockiert/markiert, N-Invariante (5 erkannt → 5 sichtbar), „Alles optimieren" deckt das ganze Register.

---

## D. Fundament 4 — UI/UX + SaaS  *(Detail zu deren späteren Fundamenten 2+3)*

- **Ein Status-Muster überall** auf Design-Tokens: Datenblatt-Status (bestehend `readiness.ts`), Bestand (`onHand`/`reserved`/`availableToSell`), Auftrag, Publish — eine Quelle je Zustand, gleiche Begriffe/Farben in Tabelle/Sheet/Inventar/Marktplätze. Bestehende `components/ui/`-Bausteine nutzen statt ad-hoc-Badges.
- **Mandanten-Isolation erzwungen:** ein Daten-Layer (`lib/tenant-db.js`), der `tenantId` nicht optional macht; Firestore-Security-Rules (heute fehlen `firestore.rules`); Cross-Tenant-Tests.
- **Beobachtbarkeit:** `external_api_calls` + `llm_call_telemetry` + Bestand-/Oversell-Anomalien + Sync-SLO (vom Reliability-Core-Strang) in **eine** mandantengetrennte Operator-Sicht.
- **Onboarding:** `provisionTenant` (Tenant-Doc, Defaults, Integrationen eBay/Kaufland/SendCloud/SevDesk).

---

## E. Umsetzungsplan — Bestand-Lagerbuch (`stock-core`), zuerst

> Konkretisiert Fundament A. TDD (Test zuerst, Vitest + `require.cache`-Patching), häufige Commits, Strangler-Migration. Flags: `STOCK_LEDGER` (Wahrheit umschalten), `STOCK_LEDGER_SHADOW` (Doppellauf+Vergleich). Baut auf dem in Reliability-Core Slice-1 entstehenden Fundament (Klassifizierer/Backoff/`sync_tasks`) auf — **kein** zweiter Sync-Pfad.

**Phase 0 — `stock-core` dunkel bauen.** `lib/stock-core.js`: reine Helfer `movementDocId`, `validateMovement`, `projectInventory(onHand,allocated)`, `applyDeltaToLevel` (TDD, rein) → dann `applyMovement` (Tx: warehouseEvents anhängen + Projektion, idempotent, nie negativ) gegen Mock-Firestore (Muster wie `__tests__/warehouse-zeroing-guard.test.js`). Flag aus.

**Phase 1 — Eröffnungsbuchungen.** Skript (read-only default, `--apply`): heutigen Bestand aus `warehouseBins[].products[]` als je eine `adjust`-Eröffnung (`idempotencyKey=adjust:opening:{pid}:{loc}`) buchen. Danach `Σ warehouseEvents == heutiger Bestand`. Idempotent.

**Phase 2 — Shadow.** Bei jeder Bestandsmutation zusätzlich `applyMovement` (`STOCK_LEDGER_SHADOW=true`); Vergleichsjob loggt Diffs `Σ Ledger` vs. altes `inventory.quantity`. Ziel: 0 Diffs über vollen Zyklus (Eingang→Pick→Versand→Storno→Retoure).

**Phase 3 — Umschalten.** `STOCK_LEDGER=true`: `applyMovement` alleiniger Schreiber; `refreshProductInventory`-Überschreiben → No-op; Alt-Aufrufer (`bookStockIn/Out`, `decrement…`) als Shims auf `applyMovement` (gleiche Signatur). `_onOrderCancelled` bekommt `reverse`, Retoure `return_restock`.

**Phase 4 — Alt-Code entfernen.** Überschreiben-Block, String-Matching als Bestandsquelle, `checkBinDrift` (→ `reconcileLedger`), `stockDecrementedAt`-Marker (durch Idempotenz ersetzt). `warehouseBins` nur noch Layout. `inventory.quantity` bleibt Alias.

**Phase 5 — UI.** `GET /api/inventory/:productId/movements`; Inventar-Ansicht: `onHand`/`reserved`/`availableToSell` + Standorte + vollständige Bewegungs-Historie (deutsche Labels, Vorzeichen-Farben, Beleg-/Wer-Verlinkung); `text-warning`-Hinweis bei Reconcile-Abweichung (kein stiller Fehlwert).

**Akzeptanz:** Tests T1 Re-Identify ändert nie Bestand · T2 Leer-Read nullt nicht · T3 Storno genau einmal zurück · T4 paralleler Doppel-Pick nur einmal · T5 pick+ship = ein Decrement · T6 `onHand=Σ Ledger` · T7 `availableToSell` nie negativ, geht an Markt · T8 kein Negativbestand · T9 SKU-Änderung verliert nichts · T10 Reconcile heilt nur durch Nach-Buchen · T11 Retoure idempotent. Shadow 0 Diffs; Production verifiziert; Alt-Code raus; UI konsistent.

---

## F. Abgrenzung & offene Punkte (für den End-Vergleich)
1. **Bestand-Ledger:** Ich nutze bewusst **`warehouseEvents`** (Reliability-Core-Modell), **nicht** ein zweites `stock_movements`. Meine Beiträge sind die harten **Invarianten** (kein stilles Nullen, feste ID, Symmetrie, Ledger-Selbstprüfung) und der **Umsetzungsplan**, den der andere Strang offen ließ. → beim Merge: meinen Plan als deren `stock-core`-Follow-on übernehmen.
2. **Aufträge:** vollständig kompatibel zu deren Order-Event-Spine; ich detailliere nur die Bestandsfolgen.
3. **Identify-Fundament:** eigenständig, kein Konflikt — sollte als eigenes Fundament in deren Roadmap aufgenommen werden.
4. **UI/UX + Mandanten:** deckt sich mit deren Fundamenten 2+3; beim Merge zusammenlegen.
5. **`isSuspiciousInventoryZeroing`/Pflaster:** entfällt — die Ledger-Invariante A.5(1) ersetzt es; nichts davon ist in Production.

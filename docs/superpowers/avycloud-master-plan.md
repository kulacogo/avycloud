# AvyCloud — Master-Plan (Merge der drei Stränge) · Lebendes Dokument

> **Eine einzige fortlaufende Quelle.** Ersetzt nichts mit Gewalt, sondern führt die drei Pläne zusammen:
> - **Plan 1** „Foundations/Claude" (`avycloud-foundations-claude.md`) — Ledger + OMS + Identify + UX.
> - **Plan 2** „Cursor Master-Doku" (`.cursor/plans/prio1_stabilisierungsplan_*.plan.md`) — Programm + Launch-Gates.
> - **Plan 3** „Marketplace-Sync / Reliability Core" (`specs/2026-06-17-marketplace-sync-foundation.md`) — durabler, nicht-destruktiver Sync.
>
> *Hinweis (2026-06-17): Die drei Quellpläne und die drei Kritik-Dateien sind nach dem Merge archiviert unter `docs/archive/2026-06-17-foundations-merge/` (Plan 2 bleibt in Cursors `.cursor/plans/`). Herkunft & Entscheidungen bewahren Teil I/J + die Git-Historie. Lebende Dokumente sind nur noch dieser Master-Plan + `avycloud-execution-guide.md`.*
>
> **Merge-Prinzip:** Plan 3 ist die beste *gebaute* Schicht (verifiziert, Brandfix `c339184` live) und sitzt **auf** Plan 1s Ledger (der die einzige Bestands-Wahrheit liefert); Plan 2s verbindliche **Go/No-Go-Gates** sind die Abnahme-Ebene. Plan 2s Fehler (`stock_movements` statt `warehouseEvents`) ist korrigiert. **Neu ergänzt:** das **Fulfillment-&-Finance-Fundament (F5)** und die Cross-Cutting-Ebene, die in allen drei Plänen fehlten — damit der End-to-End-Flow **lückenlos** ist und **nichts von AvyCloud vergessen** wird.
>
> **Stand:** 2026-06-17 · **Production heilig:** kein Breaking Change, kein Datenverlust, kein Downtime. Alles additiv, Strangler, shadow-first, hinter Flag, dann promoten, dann Alt-Pflaster entfernen. Reine Planung — keine Production-Änderung durch dieses Dokument.

---
---

# TEIL A — Management-Sicht (ohne Technik)

## Was AvyCloud beim Public-Launch garantieren muss
1. **Bestand stimmt immer** mit der physischen Realität — was angezeigt wird, liegt im Regal.
2. **Kein Überverkauf** — verkauft heißt sofort überall reduziert.
3. **Foto → fertiges Listing** funktioniert, ohne dass Produkte verloren gehen oder „Produkt" heißen.
4. **Aufträge laufen sauber** vom Eingang bis Versand, Rechnung, Retoure & Erstattung — mit korrektem Bestand.
5. **Eine konsistente, vertrauenswürdige Oberfläche** — gleiche Begriffe, gleiche Zustände, überall.
6. **Mehrere Kunden (Mandanten) sind technisch sauber getrennt.**

## Was ab sofort nicht mehr passiert
Keine Pflaster-Lösungen · keine stillen Fehler · keine parallelen Wahrheiten für denselben Zustand · keine neuen Features, solange Kernstabilität nicht grün ist.

## Der End-to-End-Versprechen (eine Kette, kein Stückwerk)
**Foto → Erkennen → Datenblatt → Optimieren → Veröffentlichen (eBay/Kaufland) → Bestands-Sync → Auftrags-Eingang → Kommissionieren/Versand (SendCloud) → Rechnung (SevDesk) → Tracking/Zustellung → Retoure/Erstattung → Abgleich.** Jeder dieser Schritte hat in diesem Plan ein Fundament oder einen ausdrücklichen „bleibt stabil"-Status. Kein Schritt fällt durchs Raster (siehe **Teil G — Vollständigkeits-Matrix**).

## Public Go/No-Go (verbindlich, aus Plan 2 — erweitert)
- **Oversell-Drift:** 0 offen.
- **Sync-Backlog:** unter Grenzwert (Anzahl + Alter der ältesten Aufgabe).
- **Sync-Erfolgsrate:** ≥ 99 % über 24 h.
- **Identify-Verlust:** 0 stille Verluste (N erkannt = N sichtbar).
- **Placeholder-Datenblätter:** 0 als „Bereit".
- **Tenant-Isolation:** 0 Cross-Tenant-Zugriffe.
- **Fulfillment/Finance (neu):** 0 versandte Aufträge ohne Tracking-Push; 0 versandte Aufträge ohne Rechnung; jede Erstattung erzeugt genau eine Korrektur-Gutschrift.

## Wo wir gerade stehen
- ✅ **Brandfix live** (`c339184`): ein gescheitertes Mengen-Update beendet kein eBay-Angebot mehr → Drain. Das Sterben gesunder Listings ist gestoppt.
- ✅ **Drei Pläne analysiert + gemerged** (dieses Dokument).
- ⏳ **Offen (externe Freigabe):** ~55 Angebote brauchen eine Best-Offer-Korrektur (Auto-Ablehnung < Sofortkaufpreis), bevor sie wieder änderbar sind; 32 davon tot-mit-Bestand → Neulistung danach.

---
---

# TEIL B — End-to-End-Architektur (technisch)

## B.0 Der vollständige Fluss (mit Verantwortlichkeit je Fundament)

```
  [F3] Foto → Identify (V4/V3/Grounding/Legacy) → commitDatasheet()-Tor → Datenblatt
        │  (Dedup, Platzhalter-Block, N-Invariante, Qualitäts-Gate)
        ▼
  [F3b] „Alles optimieren" über zentrales Feld-Register (UI/Batch/Chat einheitlich)
        ▼
  [F4]  Publish-Gate je Marktplatz  ──►  [F0] eBay/Kaufland Listing-Sync
        ▼                                        ▲  desired vs. observed, durable Queue,
  [F1]  Bestand = Σ warehouseEvents              │  Klassifizierer (nie destruktiv),
        (stock-core = einziger Schreiber)  ──────┘  Real-State-Reconciliation
        │   liefert `availableToSell` ───────────►  (F0 rechnet KEINEN Bestand)
        ▼
  [F2]  Auftrags-Eingang (eBay/Kaufland) → transitionOrder() (einziger Schreiber)
        pick/ship/reverse/return_restock → je 1 warehouseEvents-Buchung über F1
        ▼
  [F5]  Versand (SendCloud) → Label → Tracking-Push → Zustell-Polling
        → Rechnung (SevDesk) → Retoure (returns-engine) → Erstattung→Korrektur-Gutschrift
        ▼
  Sicherheitsnetze (F0/F1/F5): durable-first (Queue = Rückgrat, Bus beschleunigt) + 6 Safety-Net-Cron-Jobs +
  stock-failure-drain (2 min) + stock-reconciliation (30 min/täglich) — alle tenant-fan-out
```

## B.1 Festes Vokabular — eine Wahrheit pro Sache (verbindlich für alle Fundamente)
- **Bestands-Wahrheit = `warehouseEvents`** (bestehend, append-only). `onHand = Σ warehouseEvents.delta`. `products_v2.inventory.quantity` wird **abgeglichene Projektion** (Anzeige/Cache), nie Wahrheit.
- **`lib/stock-core.js` (NEU)** = der **einzige** Bestands-Schreiber/-Leser (kapselt `warehouse.js` + `stock-reservation.js`).
- **Mengen:** `onHand` (physisch) · `allocated`/`reserved` (offene Reservierungen, Key `(productId, orderId)`) · `availableToSell = max(0, onHand − allocated)` — **an einer Stelle** (`computeAvailableToSell`) berechnet; **an Marktplätze geht `availableToSell`.**
- **Auftrags-Schreiber:** `transitionOrder()` (einzig). Jeder bestandswirksame Übergang erzeugt **genau eine** `warehouseEvents`-Buchung über `stock-core`.
- **Datenblatt-Tor:** `lib/datasheet-gate.js commitDatasheet()` (NEU) — Pipelines erkennen nur; das Tor macht Dedup/Identität/Qualität/Persistenz einmal für alle.
- **Feld-Register:** `lib/datasheet-fields.js` (NEU) — die eine Liste aller Datenblatt-Domänen; „Alles optimieren" + Qualitäts-Gate lesen daraus.
- **Durable Sync-Queue:** heute `stock_operation_failures` (+ `stock-failure-drain.js`); Zielname `sync_tasks`. **Entscheidung:** Slice 1 arbeitet auf dem **bestehenden** `stock_operation_failures` (kein neuer Collection-Name nötig); `sync_tasks` ist nur konzeptioneller Oberbegriff, **keine zweite Queue bauen**.
- **Auslöse-Architektur — durable-first (nach Review korrigiert):** Der In-Process-Bus `services/sync-event-bus.js` (`emitSyncEvent`) ist **schnell, aber nicht dauerhaft** — Events gehen bei Instanz-Neustart/Recycling verloren (auf Cloud Run concurrency=1 real). Deshalb: **die durable Warteschlange ist das Rückgrat, der Bus nur Beschleuniger.** Jede bestandswirksame Mutation schreibt **zuerst** ein dauerhaftes Work-Item, **dann** emittet sie auf den Bus. Cron bleibt zusätzliches Netz. (Pub/Sub ist laut F8 bereits aktiv und kann das Rückgrat tragen.) Ereignisse: `stock:changed`, `order:created/updated/status_changed`, `return:created/status_changed`, `shipment:created/updated`.
- **Datenblatt-Status:** bestehendes 3-Zustands-Modell `utils/readiness.ts` (`ready`/`in_progress`/`pending`). **Publish** ist davon getrennt, je Marktplatz.
- **Marktplatz-Zustand:** je Listing `desired` (gewollt) vs. `observed` (echt). Aktionen = `diff(desired, observed)`, nie Fehler-String.
- **Frontend:** nur Design-Tokens (`bg-accent`, nie `bg-blue-500`), Dark Mode default. Tests: Vitest + `require.cache`-Patching (kein `vi.mock` für CJS).

> **⚠ Wahrheits-Fragmentierung (von allen drei Plänen übersehen, hier korrigiert):** Bestandsbewegungen liegen heute in **drei** Collections — `warehouseEvents` (physische Bewegungen, `warehouse.js`), `warehouse_movements` (Retouren/Reconcile, `returns-engine.js` + `stock-reconciliation.js`) und `inventory_ledger` (Telemetrie der Qty-Änderung, `stock-change-events.js`). **F1 macht `warehouseEvents` zur einzigen Wahrheit, `warehouse_movements` wird in `warehouseEvents` überführt (Typ `return_restock`/`adjust`), `inventory_ledger` bleibt reine Telemetrie.** Plan 2s `stock_movements` existiert nicht (0 Treffer) und wird **nicht** angelegt.

---

## B.2 Fundamente

> **Aktiv ist NUR F0–F2 (Track 1, siehe Teil K).** F3–F8 sind die **vollständige Referenz-Karte** (damit nichts vergessen wird), Status **Backlog/später — nicht jetzt umsetzen**. Ausnahme: zwei triviale F8-Config-Tasks (`delete-protection` AN, 1–2 Alert-Policies) sind in WP0 vorgezogen. So bleibt der Plan vollständig, ohne Scope-Druck.

### F0 — Marketplace-Sync / Reliability Core *(Quelle: Plan 3 — der Gewinner; höchste Code-Treue, Brandfix live)*
**Ziel:** Entscheidungen aus **echten** Zuständen, nicht aus Error-Strings. Kein gescheitertes Update beendet je ein Listing.

**Kernmodell**
- `desired` vs. `observed` je Listing; Aktionen = `diff`, nie Fehler-String.
- **Eine durable Pipeline:** Soll-Änderung → `emitSyncEvent('stock:changed')` → durables Work-Item (`stock_operation_failures`, idempotent) → idempotenter Worker → Ergebnis (`stock_sync_log`) → Reconciliation als Netz. **Keine In-Process-`setTimeout`-Retries** (sterben auf Cloud Run).
- **Fehlerklasse** `classifyMarketplaceError(channel,message) ∈ {rate_limited, ended, not_found, listing_config, transient}` — **keine** Klasse ist destruktiv (zementiert `c339184`).
- **Reconciliation gegen echten Marktplatz-Zustand** (`lib/marketplace-drift.js`, existiert — heute nur reaktiv in `stock-reconciliation.js:159` genutzt, **noch nicht** als 5-min-Hot-Loop) statt gegen „zuletzt gepushten" Wert (`stock-reconciliation.js:47`, heute oversell-blind).

**Code-Anker:** `services/stock-sync-dispatcher.js` (Fail-safe-end `:272`, `setTimeout(…,30000)` `:603`, `isRateLimited` `:42`, `isEndedListing` `:218`), `services/stock-failure-drain.js` (heute ohne `nextRetryAt`/`isDue`), `lib/ebay-trading-api.js` (Quota-Breaker), `services/kaufland-listings-sync.js`, `lib/marketplace-drift.js`, `routes/admin.js` (`system-health` `:1566`).

**Slice 1 (in sich abgeschlossen, additiv, kein Flag) — siehe Teil E.** Folge-Slices: Real-State-Reconciliation (Hot-Loop), `marketplaceListings.externalId`-Konsolidierung + `planReconcileAction`-Lifecycle, Flag-Fold.

**F0.X — Best-Offer/Preis-Push als Mutation (Ursache des 16.06.-Vorfalls — code-verifiziert, NEU aus Review):** Der Preis-Push **ist** eine Marktplatz-Mutation und gehört zu F0, nicht zu „Pricing stabil". Der Repricer senkt den eBay-Sofortkaufpreis (`syncPriceToAllChannels` `stock-sync-dispatcher.js:518`, Auto-Push bei Save `routes/products.js:1973`, sweet-spot `content-enricher.js`), **ohne** die Best-Offer-Auto-Ablehnungsschwelle anzupassen — und `BestOfferDetails` kommt **repo-weit 0×** vor (`buildReviseItemRequestXml` `:704` sendet kein Best-Offer-Feld). Liegt Auto-Ablehnung ≥ Sofortkaufpreis, scheitert **jede** Revise → das Listing hängt un-synchronisierbar im Backlog (neue Form desselben Schadens). **Zwei Bausteine:** (a) **präventiv** — Preis-Push darf den Sofortkaufpreis nie unter die bekannte Auto-Ablehnung senken (oder passt sie im selben Call an); (b) **reparativ** — `BestOfferDetails` in `marketplaceListings.observed` lesen und als `diff` behandeln, sodass „Auto-Ablehnung ≥ BIN" **vor** dem Push erkannt wird. Ersetzt den heutigen externen Park-Status der ~55 Angebote (Teil H) durch einen **gebauten** Pfad.

**Konsumiert:** `availableToSell` aus **F1**. **Ausgelöst von:** **F1**/**F2**. **Zeigt sich über:** **F4** (`StatusPill`/`system-health`).

### F1 — Inventar-Fundament: Lagerbuch als Wahrheit *(Quelle: Plan 1 — bestes Engineering, füllt die Lücke, die F0 braucht)*
**Ziel:** Bestand wird **gebucht, nicht geraten**. `onHand = Σ warehouseEvents.delta`.

**Kernmodell**
- **`stock-core.applyMovement(movement)`** (NEU) = einziger Schreiber. Eine Firestore-Tx unter `withStockLock`: validieren → Idempotenz über deterministische Event-Doc-ID `sha1(tenantId|idempotencyKey)` → Event anhängen → Projektion fortschreiben (`onHand += delta`, `availableToSell = max(0, onHand−allocated)`, nie negativ) → nach Commit best-effort `notifyStockChange` + `stock:changed` → enqueue (F0).
- **Projektionen:** `products_v2.inventory` (`onHand`, `reserved`, `availableToSell`, `quantity` = Alias auf `onHand`, **additiv, kein Rename** → CLAUDE.md Punkt 2). `warehouseBins` behält **nur** die Layout-Rolle.
- **Idempotenz-Keys:** `receive:{receiptId}:{pid}`, `pick:{orderId}:{pid}`, `ship:{orderId}:{pid}`, `reverse:{reversesEventId}`, `return:{returnId}:{pid}`, `adjust:{countId}:{pid}:{loc}`.

**Harte Invarianten:** kein stilles Nullen · `onHand=Σ Ledger` (Abweichung **gemeldet**, nie still gefixt) · `pick`/`ship` mutual exclusive je `(orderId,pid)` · feste Verknüpfung über stabile `productId` (nie SKU-Text) · `availableToSell` nie negativ · Symmetrie (zu jeder Abbuchung ein idempotenter Gegenweg) · append-only (Korrektur nur per `adjust`/`reverse`).

**Code-Anker:** `lib/warehouse.js` (`refreshProductInventory:36` überschreibt bedingungslos `:136`; `buildProductKeySet`/`binEntryMatchesKeySet` Text-Matching), `services/stock-reconciliation.js` (`checkBinDrift:12` → `reconcileLedger`), `lib/stock-change-events.js`, `lib/stock-reservation.js`. Ersetzt den `stockDecrementedAt`-Marker-Hack durch echte Idempotenz (CLAUDE.md Punkt 13).

**F1.X — Ist-Bestand korrigieren VOR Eröffnung (NEU aus Review, der eigentliche PRIO-1):** Die Eröffnungsbuchungen (Teil C) stammen aus `warehouseBins[].products[]` — **genau der Quelle, die der ursprüngliche Bug fälschlich nullt** (Text-Matching-Overwrite). Wer den korrupten Stand 1:1 als Eröffnung bucht, zementiert die heute falsch auf 0 stehenden Artikel. **Pflicht-Vorstufe:** read-only Audit (physischer Ist-Bestand vs. `warehouseBins` vs. letzte gesunde Projektion) → bestätigte Korrektur als explizite `adjust`-Buchung **mit** deterministischem Key (`adjust:opening:{pid}:{loc}`) → erst dann gilt `Σ Ledger` als Wahrheit. **`warehouse_movements`→`warehouseEvents`-Migration:** jede migrierte Altbewegung braucht denselben deterministischen Idempotenz-Key (`migrate:wm:{docId}`), sonst Doppelzählung von Retouren/Reconcile-Bewegungen.

### F2 — OMS-Fundament: symmetrische Auftragslogik *(Quelle: Plan 1)*
**Ziel:** Jeder bestandswirksame Order-Übergang ist eindeutig, idempotent und reversibel.

| Übergang | Bewegung | Idempotenz-Key |
|---|---|---|
| picked (Pick-with-order) | `pick` (−) | `pick:{orderId}:{pid}` |
| shipped (ohne vorherigen Pick) | `ship` (−) | `ship:{orderId}:{pid}` |
| shipped (nach Pick) | `ship` (delta 0, dokumentierend) | `ship:{orderId}:{pid}` |
| cancelled (nach Abbuchung) | `reverse` (+) | `reverse:{eventId}` |
| returned (verkaufsfähig) | `return_restock` (+) | `return:{returnId}:{pid}` |

- **Einziger Schreiber `transitionOrder()`**; jeder Übergang ruft `stock-core.applyMovement` (nie `decrementProductByIdOrSku`/`bookStockOut` direkt). `returned` bekommt verbindlichen Pfad; nicht einlagerbare Retoure ist **sichtbar markiert, nie still verloren**.
- **Intake** (`order-intake-ebay.js`/`order-intake-kaufland.js`) nur über `transitionOrder({force:true})` — kein `omsStatus`-Direktschreiben (CLAUDE.md Punkt 11). `reconcileReservationsForOrder(orderId)` bei jedem terminalen Übergang.

**Code-Anker:** `services/order-state-machine.js` (`_onOrderCancelled:372` bucht heute **nie** zurück; kein `returned`-Pfad), `order-source-router.js`, `order-sync.js`, `pick-hints.js`, `number-sequence.js` (AVY-Auftragsnummern).

### F3 — Identify + Datenblatt-Lebenszyklus *(Quelle: Plan 1 — eigenständig, fehlte in Plan 3)*
**Ziel:** Ein Produkt = ein Datenblatt, kein stiller Verlust, kein falsches „ready".

**Kernmodell**
- **Pipelines erkennen nur** (V4 `routes/identify.js:322`, V3 `:474`, Grounding `:707`, Legacy) → liefern Erkennungs-Entwurf. **`commitDatasheet()`** macht für alle: Dedup über **stabile Identifier** (schließt die V4-Lücke baulich — V4 setzt heute `product` `:376` und **überspringt** die Post-V3-Dubletten-Prüfung `:496`), Qualitäts-Gate inkl. **Platzhalter-Block** (`isPlaceholderTitle`, vereint `isGenericTitle` `v2-product-builder.js:28` + `'Unbekanntes Produkt'` `identify-v3.js:241`/`identify-v4.js:526`), Persistenz via `saveProductV2`.
- **N-Invariante:** erkannte Stückzahl N wird Ende-zu-Ende mitgeführt; Review zeigt N Einträge mit Status (erstellt / fehlgeschlagen+retry / als Duplikat zusammengeführt). Behebt „5 erkannt → 4 übrig" (`image-grouping.js`, `StepAnalysis.tsx:301`).
- **Lebenszyklus** auf 3-Zustands-Modell: Platzhalter/fehlende Pflichtfelder ⇒ nie `ready`, nie publish.

**Code-Anker:** `lib/datasheet-gate.js` (NEU), `lib/datasheet-fields.js` (NEU), `routes/identify.js`, `services/job-runner.js`, `services/identify-v3.js`/`identify-v4.js`/`identify-grounding.js`/`generative-identify.js`, `lib/identify-v3-stage1/2/3*.js`, `components/capture/StepAnalysis.tsx`, `CaptureView`.

### F3b — „Alles optimieren" vollständig *(Quelle: Plan 1 + Plan 2)*
**Ziel:** Ein Register steuert Vollständigkeit in UI, Batch und Chat-Pipelines — keine hardcodierten 4-Felder-Scopes.
- `datasheet-fields.js` iteriert in **allen** Pipelines (scope an V3/V2/Legacy durchreichen, Tool-Schema um Bilder/Gewicht/SEO erweitern); Qualitäts-Gate liest dasselbe Register; die 3 duplizierten Subsets (`GeminiChat.tsx:307`, `batch-optimize.js`, V3) entfallen.

**Code-Anker:** `components/GeminiChat.tsx`, `services/batch-optimize.js`, `product-chat-v3.js`/`v2.js`/`product-chat.js`, `improve.js`/`improve-runner.js`, `content-enricher.js`, `enrichment-v2.js`.

### F4 — UI/UX + SaaS-Querfundament *(Quelle: Plan 1 + Plan 2)*
**Ziel:** Ein konsistentes Produktgefühl + technische Tenant-Sicherheit.
- **Ein Status-Muster** (`StatusPill` über zentrale Mappings) für Datenblatt/Bestand/Auftrag/Publish — eine Quelle je Zustand, gleiche Begriffe/Farben in Tabelle/Sheet/Inventar/Marktplätze. Bestehende `components/ui/`-Bausteine statt ad-hoc-Badges. Nur Design-Tokens.
- **Tenant-Isolation technisch erzwungen:** `lib/tenant-db.js` (NEU) macht `tenantId` nicht optional; **`firestore.rules` (fehlt heute!)** als zweite Sicherheitslinie; Cross-Tenant-Tests. Bestehend: `attach-user-context.js`, `tenant-authorization.js`, `background-job-tenants.js`.
- **Operator-Cockpit je Mandant** aus bestehenden Quellen: `external_api_calls` + `llm_call_telemetry` + Bestand/Oversell-Anomalien + Sync-SLO (F0) in **eine** mandantengetrennte Sicht (`error-dashboard.js`, `llm-parity-dashboard.js`, `identify-runs-dashboard.js`, `IdentifyHealthTile`).
- **Idempotentes Tenant-Provisioning** (`provisionTenant`: Tenant-Doc, Defaults, Integrationen eBay/Kaufland/SendCloud/SevDesk) + begleiteter Onboarding-Flow (`IntegrationWizard`/`IntegrationsHub`).

**Code-Anker:** `components/ui`, `utils/readiness.ts`, `lib/tenant-db.js` (NEU), `routes/admin.js`, `firebase.json`, `firestore.rules` (NEU).

### F5 — Fulfillment-&-Finance-Spine *(NEU — fehlte in ALLEN drei Plänen; schließt den End-to-End-Flow)*
**Ziel:** Alles **nach** dem Versand-Auslöser ist genauso idempotent, event-getrieben und beobachtbar wie der Bestand — sonst ist das „sauber bis Versand/Retoure/Erstattung"-Versprechen nicht erfüllbar.

**Kernmodell**
- **Versand:** `shipping-engine.js` (SendCloud, `lib/sendcloud.js`) — Parcel anlegen, `label-printer.js`, `shipment:created/updated`-Events; Safety-Net `sendcloud-sync` (6 h) **+** Webhooks primär.
- **Tracking:** `marketplace-tracking.js` — Tracking-Push an eBay/Kaufland; `tracking-catchup` retried fehlgeschlagene Pushes (verhindert Marktplatz-Warnungen). **Invariante: kein versandter Auftrag ohne erfolgreichen Tracking-Push** (sonst durable Retry, nie still).
- **Zustellung:** `delivery-poll` (2 h) prüft Zustellstatus.
- **Rechnung:** `invoice-engine.js` (SevDesk, `lib/sevdesk.js`) — `invoice-sync` (Start + 24 h): SevDesk-Import + `bulkGenerateForShippedOrders`. **Invariante: jeder versandte Auftrag bekommt genau eine Rechnung** (idempotent, kein Duplikat — vgl. `audit-invoice-duplicates.js`).
- **Erstattung:** `refund-sync.js` (6 h) — Marktplatz-Refund → genau eine Teil-Gutschrift (SR) in SevDesk, Lookback-begrenzt.
- **Retoure:** `returns-engine.js` → F2 `return_restock` (verkaufsfähig) bzw. sichtbar „nicht eingelagert". `syncAllReturns` (6 h) + Webhooks.

**Übergreifend:** alle Cron-Jobs laufen über `runForEachBackgroundJobTenant` (Multi-Tenant-Fan-out, `BACKGROUND_JOB_TENANTS`); Sicherheitsnetz, **nicht** Primärpfad (Primär = durable Queue; `emitSyncEvent` beschleunigt nur — siehe B.1). Diese Spine speist die SLO-Sicht in F4.

**F5.X — Finanz-Reconciliation + Webhook-Sicherheit (NEU aus Review):** „genau 1 Rechnung je Versand" ist nur *operativ*; ergänzt wird die **buchhalterische** Invariante: Summe der erzeugten Belege ↔ Marktplatz-Payout (`ebay-finances.js`/Kaufland) ↔ Bank (SevDesk); Drift wird **gemeldet, nie still** (vgl. Rechnungs-Duplikat-Incident 31.05., `audit-invoice-duplicates.js`). Offene Steuerberater-Altlasten (fehlende/0-€-Stornos) als einmaliger Backfill, kein Pflaster. **Webhook-Härtung** (F5 nennt Webhooks als Primärpfad): Signatur-Verifikation + Replay-/Idempotenz-Schutz für SendCloud/eBay/Kaufland-Webhooks verbindlich (`routes/webhooks.js`).

**Code-Anker:** `services/shipping-engine.js`, `marketplace-tracking.js`, `invoice-engine.js`, `refund-sync.js`, `returns-engine.js`, `label-printer.js`, `lib/sendcloud.js`, `lib/sevdesk.js`, `lib/ebay-finances.js`, `routes/invoices.js`/`returns.js`/`orders.js`/`webhooks.js`, `backend/index.js` (Cron-Registrierung `:347–588`). Collections: `shipments`, `invoices`, `returns`, `return_events`.

---

### F6 — Billing, Subscription & Tenant-Lifecycle *(NEU aus Kritik — die „aus App wird öffentliches Abo"-Schicht)*
**Ziel:** AvyCloud als bezahltes Multi-Tenant-Abo betreibbar machen. **Code-verifiziert fehlend:** kein Stripe/Subscription/Billing (0 Treffer).
- **Abrechnung AvyCloud→Mandant:** Tarife/Pläne, Zahlungsanbieter (z. B. Stripe), Testphase, nutzungsabhängige Posten, Mahnwesen. **Gate:** kein Mandant ohne gültigen Abo-Status aktiv; Zahlungsausfall → definierter Lifecycle (Warnung → Read-only → Sperre), **nie stiller Datenverlust**. *(Abgrenzung: F5 = Finanzen Händler↔dessen Kunden via SevDesk; F6 = AvyCloud↔Mandant — zwei verschiedene Dinge.)*
- **Tenant-Lifecycle + DSGVO:** anlegen/sperren/löschen + Aufbewahrungsfristen; **vollständiger** Data-Subject-Export + Löschung. **Teil-vorhanden (Review überzeichnet „komplett verloren"):** eBay-GDPR-Deletion-Endpoint (`routes/webhooks.js:384`) + `safeDeleteTenantScoped` (`routes/settings.js:19`, mit Regression-Test) existieren bereits → darauf aufbauen, nicht neu erfinden. Lücke = der *umfassende* Export + Lifecycle-Orchestrierung.
- **Pro-Mandant-Budgets/Limits** für teure Pfade (Gemini-Identify/Chat/Optimieren, SerpAPI/BrightData): Drosselung, Fair-Use, Abuse-Schutz, Alarm bei Budget-Überschreitung. Heute wird nur *getrackt* (`external_api_calls`), nicht *erzwungen*. Durchsetzung in F0/F3, Tarif-Grenzen in F6.

**Konsumiert:** Tenant-Modell aus **F4**. **Code-Anker:** `provisionTenant` (F4), `integration-store.js`, neue Billing-Lib; `tenants`-Collection.

---

### F7 — Account, IAM, Settings & Audit *(NEU — die SaaS-Verwaltungsfläche, vorher fälschlich „stabil" geparkt)*
**Ziel:** Account-/Admin-Fläche als vollwertige Multi-Tenant-Produktfläche behandeln (nicht nur „Auth stabil").
**Bestand (code-verifiziert, existiert bereits):** RBAC mit `roles`-Collection (4 Rollen admin/manager/operation/catalog + Permission-Matrix, `requirePermission()`), `company_settings` je Tenant, Settings-Surface (`/settings/company|profile|api-keys|webhooks|billing/usage`), `audit_log` + `logAudit()`, `safeDeleteTenantScoped` + eBay-GDPR-Endpoint (`webhooks.js:384`).
**Lücken:** keine **User-Einladung/-Lifecycle** über Tenants (Onboarding/SSO); 4 Rollen hart kodiert ohne Governance-UI; `audit_log` nicht als **unveränderlicher, compliance-fähiger Trail** spezifiziert (Aufbewahrung/Export); **API-Key-Lifecycle** (Rotation/Scope) offen; `/settings/billing/usage` existiert → an **F6** koppeln (relativiert „Billing fehlt komplett").
**Code-Anker:** `lib/rbac.js`, `routes/settings.js`/`sessions.js`/`auth.js`, `services/audit-log.js`, `services/user-sessions.js`; Collections `roles`, `company_settings`, `audit_log`, `api_keys`, `user_profiles`.

### F8 — Plattform & GCP-Infrastruktur *(NEU — Live-Audit 2026-06-17, read-only, Projekt `avycloud`/`europe-west3`)*
**Ziel:** „zuverlässig für fremde Kunden, jeden Tag" als **Kapazitäts-, Betriebs- und Daten-Residenz**-Aussage absichern. Messwerte statt Annahmen.

| Bereich | **Gemessener Ist-Zustand** | Risiko / Aktion |
|---|---|---|
| **Cloud Run** `product-hub-backend` | **concurrency = 1**, timeout **600s**, scaling **1–20**, 2 CPU/4 Gi, ingress ALL, 48 ENV | ⚠ concurrency=1 + 600s-SSE ⇒ 20 Langverbindungen sättigen den ganzen Pool (Incident 2026-06-12 **bestätigt, nicht mehr Annahme**). → SSE entkoppeln **oder** concurrency>1 mit Locking; `min-instances>1` erwägen |
| **Firestore** `(default)` | native, `europe-west3`, PESSIMISTIC, **PITR EIN**, **1 Backup-Schedule (30 d)**, **delete-protection AUS** | DR **teilweise vorhanden** (korrigiert die „kein Backup"-Kritik). ⚠ delete-protection **einschalten**; Restore in Staging **testen** (RPO/RTO) |
| **Cloud Storage** (8 Buckets) | `avycloud-genai-images` + `avycloud_cloudbuild` in **US**; **keine Lifecycle-Regeln**; UBLA **aus** bei 3 (`genai-images`,`product-images`,`trendocean`); mutmaßl. Dublette `prodsandjobs`↔`products-and-jobs`; per-Tenant `trendocean` | ⚠ **EU-Daten-Residenz** (DSGVO): genAI-Bilder in US → nach EU; Lifecycle/Retention setzen; UBLA an; Dublette klären |
| **IAM** | Owner = 1 User (du); **Default-Compute-SA mit `roles/editor`** (= Cloud-Run-Runtime); ein SA mit `organizationAdmin`; 4 SAs | ⚠ **Least-Privilege**: dedizierte Runtime-SA statt Default-Compute/Editor |
| **Secret Manager** | 20 Secrets, **alle global** (eBay/Kaufland/SendCloud/SevDesk/Gemini/GenAI/**OpenAI**/BrightData/SerpAPI) | per-Tenant-Marktplatz-Creds liegen verschlüsselt in Firestore (`integration-store` AES-GCM, **bestätigt**). ⚠ Rotation/Scope-Policy; Plaintext-Fallback in Prod verbieten; `OPENAI_API_KEY` nicht in CLAUDE.md dokumentiert |
| **Monitoring** | **0 Alert-Policies** | ⚠ **kein Infra-Alerting** → Alert-Policies (Cloud Run 5xx/Latenz/Saturation, Firestore, Quota) + Eskalation, speist **D.4** |
| **APIs** | `pubsub` EIN, `cloudtasks` AUS, `firebaserules` EIN (aber keine `firestore.rules` deployed), `aiplatform`+`generativelanguage` EIN | `pubsub` kann durable Queue/Fan-out backen (relevant für B.1/F0); `firestore.rules`-Lücke **infra-seitig bestätigt** |

**Abgrenzung:** F8 ist Infra/Betrieb, ändert **keine** App-Logik; alle Maßnahmen additiv/Config (z. B. delete-protection an, Alert-Policies, UBLA) — Production-Regel unberührt.

---

## B.3 Cross-Cutting-Ebene (gilt für alle Fundamente — damit nichts vergessen wird)

| Bereich | Behandlung im Master-Plan | Code-Anker |
|---|---|---|
| **Auth / RBAC** | **Stabil — nicht angefasst** (CLAUDE.md Punkt 6). Nur als Guard genutzt; Tenant-Layer (F4) baut darauf auf. | `lib/auth.js`, `lib/rbac.js`, `routes/auth.js`, `public-auth.js`, `user-sessions.js` |
| **Multi-Tenant-Fan-out** | Querschnitt von F0/F1/F5; jede Query/Job tenant-scoped (CLAUDE.md Punkt 8). | `background-job-tenants.js`, `tenant-authorization.js`, `STOCK_FAILURE_DRAIN_TENANTS` |
| **Observability / SLO** | In F4 konsolidiert (Operator-Cockpit); F0 liefert Sync-SLO. | `external-api-tracker.js`, `audit-log.js`, `error-dashboard.js`, `llm-parity-dashboard.js` |
| **Pricing** | **Stabil + F3b-konform** (Preis ist eine optimierbare Domäne im Register). | `pricing-engine.js`, `pricing-runner.js`, `competitor-refresh-runner.js`, `sweet-spot-pricer.js` |
| **Rules-Engine** | **Stabil** — kein Konflikt; respektiert Single-Writer-Invarianten. | `rule-engine.js`, `rule-runner.js`, `rulebook-runner.js`, `RuleDashboard` |
| **Kategorie / GPSR / Quality-Gate** | **Stabil**, Teil von F3s Qualitäts-Tor (Platzhalter + Pflichtfelder lesen Register). | `category-resolver.js`, `quality-gate.js`/`quality-runner.js`, `gpsr-web-fallback.js`, `ebay-category-governance.js` |
| **eBay Auto-Fix** | **Stabil**, läuft hinter F0s Publish; darf nie destruktiv enden. | `ebay-auto-fix.js`, `listing-validator.js` |
| **Chat / Gemini-Infra** | **Stabil**; F3b vereinheitlicht nur den Scope-Vertrag. | `product-chat-v3/v2.js`, `atomic-tools.js`, `prompt-cache.js`, `gemini-config.js` |
| **Admin / Bulk-Ops** | **Stabil**; `recategorize_v2` DryRun-first behält Safety-Guards. | `admin-bulk-actions.js`, `admin-bulk-runner.js`, `bulk-update.js` |
| **Import/Export** | **Stabil**. | `import-export.js` |
| **CI/CD + Deployment** | **Nicht angefasst** ohne Anweisung (CLAUDE.md Punkt 5); Launch-Gates (Teil D) werden hier verankert. | `.github/workflows/{firebase-hosting,deploy-firestore-indexes,kb-drift-and-tests}.yml`, `Dockerfile`, `firebase.json`, `cloudbuild.yaml` (Cloud Run) |
| **Laufzeit & Kapazität** (NEU) | Eigene Dimension — siehe **B.4**. | `routes/sse.js`, Cloud Run, `index.js:347–588` |
| **Backups / Disaster-Recovery** (NEU) | Eigener Punkt — siehe **B.4**; Launch-Gate. | Firestore-Export/PITR (Infra, nicht im Repo) |
| **Security-Breite** (NEU, verfeinert) | Credential-Härtung + Abuse-Limits — siehe **B.4**. | `integration-store.js`, `lib/rate-limit.js` |
| **Landingpage** | **Eigener Strang** (außerhalb dieses Repos) — Versprechen müssen mit F0/F1 nachweisbar übereinstimmen. | — |

## B.4 Laufzeit, Kapazität & Resilienz *(NEU aus Review — alle drei Kritiken nannten Teile davon)*
- **Runtime/Kapazität (Review #2 — durch Live-Audit BESTÄTIGT, siehe F8):** **SSE `/api/events` (`routes/sse.js`) pinnt je Verbindung eine Instanz**, und Cloud Run läuft tatsächlich mit **`concurrency = 1`, timeout 600s, max 20 Instanzen** (gemessen) → 20 Langverbindungen sättigen den ganzen Pool (Incident 2026-06-12). Mein **F0-Real-State-Hot-Loop (5 min) + Per-Listing-Reads × Tenant-Fan-out** vervielfacht zusätzlich das API-Volumen. **Maßnahmen:** SSE entkoppeln **oder** concurrency > 1 mit korrektem Locking; **globales API-Call-Budget je Kanal × Mandant** (Token-Bucket) als Geschwister zum Quota-Breaker.
- **Job-Skalierung (Kritik B1, valide — Lösung als Option):** `runForEachBackgroundJobTenant` ist ein Fan-out-Loop in **einer** Instanz. Bei 50 Mandanten × 6 Jobs ein Skalierungsrisiko. **Problem akzeptiert; Lösung offen:** echte Job-Queue (Cloud Tasks/Pub-Sub) ist ein *Kandidat*, nicht zwingend — Entscheidung an die Lastziele aus D.3 koppeln (Phase 3, nicht Track 1). *(Kein Big-Bang; das durable-first-Modell aus B.1 bleibt — Queue als Rückgrat, Bus beschleunigt.)*
- **Backups/DR (A5/Review #4 — durch Live-Audit TEILWEISE KORRIGIERT, siehe F8):** Firestore-**PITR ist EIN** + **1 Backup-Schedule (30 d Retention)** existiert — „kein Backup" war falsch. **Echte Restlücken:** **delete-protection AUS**, **Restore nie getestet**, **0 Monitoring-Alert-Policies**. **Maßnahmen:** delete-protection an; geübter Restore in Staging (RPO/RTO); Infra-Alerting. Launch-Gate (Teil D).
- **Security-Breite (A3/Review #5 — überzeichnet, hier korrigiert):** Credential-Verschlüsselung **existiert bereits** (AES-256-GCM via `INTEGRATION_ENCRYPTION_KEY`/Secret Manager, `integration-store.js`) — Kritik „fehlt/halb" ist falsch. **Echte Restlücken:** (a) **Plaintext-Fallback wenn Key fehlt** → in Prod **Key erzwingen**; (b) Rotation/Widerruf je Mandant. Rate-Limiting ist **bereits gehärtet** (Incident 2026-05-25 gefixt: `lib/rate-limit.js` + `trust proxy` + Regression-Test) — Review #5 ist hier veraltet; valide Restlücke = **per-Mandant** Abuse-/Rate-Limits (→ F6).

---
---

# TEIL C — Reihenfolge (korrigiert, mit Abhängigkeiten)

> Plan 2s 8-Wochen-Sequenz, korrigiert um die **echte Abhängigkeit**: F0s Oversell-Schließung braucht F1s `availableToSell`. Deshalb **F1 vor** F0-Real-State. F0-Slice 1 (Recovery) ist unabhängig und teilweise **schon live**.

1. **Schon erledigt:** F0-Brandfix (`c339184`), Quota-Breaker (`ea052c5`), Retry-Cap + Defer-to-Drain (`c818018`).
2. **Stabilitäts-Freeze** kritischer Pfade + SLO-Tracking aktiv (Backlog, Erfolg, Oversell-Drift) — F0 Slice 1 Task 7.
3. **F0 Slice 1** „durable, non-destructive Sync-Recovery" (Teil E) — additiv, kein Flag. Höchster Sofort-Hebel.
4. **F1 Ledger** dunkel bauen → Eröffnungsbuchungen → **Shadow** (0 Diffs über vollen Zyklus) → umschalten (`STOCK_LEDGER`) → Alt-Code raus.
5. **F2 OMS** symmetrisch (`cancelled→reverse`, `returned→return_restock`), Intake über `transitionOrder({force:true})`.
6. **F0 Real-State-Reconciliation** (Folge-Slice) — `marketplace-drift.js` an 5-min-Hot-Loop; **jetzt** möglich, weil F1 `availableToSell` liefert. Schließt Oversell-Blindheit.
7. **F3 Identify** `commitDatasheet()` (Route + job-runner) + N-Invariante; **F3b** Register über alle Pipelines.
8. **F5 Fulfillment/Finance** härten: Tracking-Push-/Rechnungs-/Erstattungs-Invarianten + Cron-Tenant-Fan-out verifizieren.
9. **F4 UX/Tenant:** Status-System in Kernviews, `tenant-db`-Migration kritischer Routen, `firestore.rules` + Cross-Tenant-Tests, Operator-Cockpit, Provisioning.
10. **Launch:** Canary-Go/No-Go nach Teil D.

**Flags je Cutover:** `STOCK_LEDGER` / `STOCK_LEDGER_SHADOW` (F1), F0-Slice-1 ohne Flag (additiv), spätere F0-Slices shadow-first. Jede Phase reversibel.

**Rollback & Abnahme je Cutover (NEU aus allen drei Kritiken — „reversibel" war behauptet, nicht ausführbar):**
- **15-/30-Min-Rollback-Ablauf** pro Phase: welcher Flag zurück, in welcher Reihenfolge, erwartetes Verhalten, **Stop-Kriterien** („ab hier sofort zurück"), und Projektions-Reparatur per `adjust`-Buchung (kein Überschreiben). Beispiel F1: `STOCK_LEDGER=false` → `applyMovement` wird Shadow → `reconcileLedger` bestätigt `onHand=Σ Ledger` → 3 Grün-Checks (Bestand/Order/Sync-SLO) vor „stabil".
- **Formales Migrations-Sign-off:** Vorher/Nachher-Protokoll je Migration + Pflicht-Stichprobe über kritische Fälle (Bestand, Aufträge, Retoure, Identify) — „sieht gut aus" reicht für Public-SaaS nicht.
- **`default`→echter-Mandant Daten-Umzug (C2):** expliziter Schritt vor F4-Tenant-Erzwingung (heutige `tenantId='default'`-Daten in echtes Mandanten-Modell migrieren, idempotent).

---
---

# TEIL D — Harte Invarianten + Launch Go/No-Go (verbindlich)

## D.1 Invarianten (dürfen nie brechen — aus CLAUDE.md + Plan 2)
Ein kritischer Zustand hat genau **eine** Wahrheit · Bestandsschreiben nur über **einen** Schreiber (`stock-core`) · Order-Status nur über `transitionOrder()` · Datenblatt-Speichern nur über `commitDatasheet()` · Idempotenz für alle kritischen Bewegungen/Transitions · keine Stock-Mutation ohne `notifyStockChange()` + Sync-Versuch < 60 s (CLAUDE.md Punkt 10) · STOCK SINGLE WRITER (pick **xor** ship, CLAUDE.md Punkt 13) · Fehler sichtbar (keine stillen Verluste) · jede Query/Mutation tenant-sicher · **keine** Sync-Fehlerklasse ist destruktiv · **kein versandter Auftrag ohne Tracking-Push + Rechnung**.

## D.2 Launch-Abnahme (verbindlich, in CI/CD + Rollout verankert)
- 0 offene Oversell-Drift im Stabilitätsfenster.
- Sync-Backlog < Grenzwert (Anzahl + Alter) · Sync-Erfolgsrate ≥ 99 % / 24 h.
- 0 stille Identify-Verluste · 0 Placeholder-Produkte als `ready` · > 99 % „Alles optimieren"-Vollständigkeit.
- 0 Cross-Tenant-Lesbarkeit/Mutierbarkeit (Rules-Emulator + Tests grün).
- F5: 0 versandte Aufträge ohne Tracking/Rechnung; jede Erstattung → genau 1 Korrektur-Gutschrift.
- **F6 (neu):** kein aktiver Mandant ohne gültigen Abo-Status; Budget-Überschreitung alarmiert + drosselt.
- **DR (neu):** Restore in Staging nachgewiesen (RPO/RTO erreicht).

## D.3 Gates gemessen statt behauptet (NEU aus Review B3 + Kritik)
- **Realität: kein Staging (nur 1 GCP-Projekt, F8).** Validierung in Track 1 läuft als **read-only Prod-Shadow mit Diff-Report**. Lasttests **nur** gegen Sandbox-APIs / isolierte Test-Tenant-Daten, **niemals** gegen den Live-Pool (concurrency=1/max20 → selbstverschuldeter Incident). Ein minimales zweites Projekt als Staging ist optionale Vorarbeit, kein Muss für Track 1.
- **Verdrahtung:** je Gate ist benannt, **welcher CI/CD-Check welchen Deploy blockt** — sonst ist die Liste ein Wunschzettel. (CI/CD-Workflows nur erweitern, nicht referenzierte Vars anfassen — CLAUDE.md Punkt 4/5.)
- **E2E statt Unit-Beweis (Launch-Gate, nicht Track 1):** „0 Überverkäufe beweisbar" braucht einen **End-to-End-Durchlauf der ganzen Kette** + Last gegen SLOs **in Sandbox/Test-Tenant**, inkl. eBay/Kaufland-**Sandbox-Contract-Tests** und **Bulk-Publish-Fall** (~1000 Produkte). In Track 1 ersetzt der Prod-Shadow + Baseline-Vergleich den vollen E2E-Lauf.
- **Konkrete Lastziele:** Zielwerte für gleichzeitige Mandanten + Spitzenlast als verbindliche **Launch**-Bedingung — gehört zu Phase 3, nicht zu Track 1.

## D.4 Betrieb / Day-2 *(für Solo-Betrieb entschlackt)*
Kein Fehlerbudget-/On-Call-Vokabular für eine Person. Stattdessen **ein** einseitiges **Notfall-Blatt in Klartext** (im Execution-Guide): „Wenn nachts X bricht → diese Flags auf `false` → diese 3 Checks → wenn nicht grün, Cloud-Run-Revision zurückrollen → TrendOcean kurz informieren." Das volle On-Call-/Eskalations-Modell wird erst zum Public-Launch (mehrere Kunden) relevant.

## D.5 Ownership *(für Solo-Betrieb entschlackt)*
Aktuell sind **Owner, Stellvertreter und Go/No-Go dieselbe Person** — eine Ownership-Tabelle wäre Theater. Entscheidungen trifft der Owner; Abnahme je Arbeitspaket über die Owner-Checkliste im Execution-Guide. Die Tabelle wird erst relevant, wenn ein Team dazukommt.

---
---

# TEIL E — F0 Slice 1: „Durable, non-destructive Sync-Recovery" (TDD, ausführungsbereit)

> Aus Plan 3 übernommen — bereits **gegen den aktuellen Code verifiziert** (Zeilennummern stimmen). Vitest + `require.cache`-Patching. Alles additiv, kein Flag, keine Route geändert. Jeder Task: RED → GREEN → `npm test` → Commit.

| Task | Datei | Inhalt |
|---|---|---|
| 1 | `lib/marketplace-error-classifier.js` (NEU) | `classifyMarketplaceError` — 5 Klassen, **Invariante: keine `end`/`delete`**. Best-Offer-Incident → `listing_config`. |
| 2 | `lib/retry-backoff.js` (NEU) | reines `computeNextRetryAt` — 60/120/240 s, Cap 30 min, `rate_limited ≥ quotaUntil`. |
| 3 | `lib/ebay-quota-breaker.js` (NEU) | Firestore-shared Breaker (`system/ebay_quota_breaker`), 10 s In-Process-Cache, cross-instance. |
| 4 | `services/stock-sync-dispatcher.js` (MOD) | `setTimeout(…,30000)`-Block (`:603`) **entfernen** → synchron `persistSyncFailureForDrain` (durable). |
| 5 | `services/stock-failure-drain.js` (MOD) | `isDue(doc,now)` + `nextRetryAt`/`classification` stempeln; nur fällige Docs; Backoff bei Fehlschlag. Legacy-Docs ohne Feld → fällig. |
| 6 | `lib/ebay-trading-api.js` (MOD) | In-Process-Quota an shared Breaker delegieren (synchroner In-Call-Guard bleibt). |
| 7 | `routes/admin.js` (MOD) | `computeSyncSlo({pending,now})` → `sync`-Sektion in `system-health` (`ok`/`warn ≥25 ∨ >30 min`/`critical ≥100 ∨ >60 min`). |

**Folge-Slices (keine neuen Dateien):** (1) Real-State-Reconciliation an Hot-Loop, (2) `marketplaceListings.externalId` + `planReconcileAction`, (3) Flag-Fold `lib/sync-cadence.js`.

> **Test-/Abnahmeprogramm je Fundament:**
> **F0:** `classifyMarketplaceError`-Matrix (keine destruktive Klasse), durable Retry ohne `setTimeout`, Real-State-Drift-Enqueue.
> **F1:** `Σ warehouseEvents == onHand`, kein stilles Nullen, `availableToSell ≥ 0`, Standort nie negativ, T1–T11 aus Plan 1 (Re-Identify ändert nie Bestand · Leer-Read nullt nicht · Storno genau 1× zurück · paralleler Doppel-Pick 1× · pick+ship = 1 Decrement · SKU-Änderung verliert nichts · Reconcile heilt nur durch Nach-Buchen · Retoure idempotent).
> **F2:** `pick xor ship`, `cancelled→reverse`, `returned→return_restock|visible-not-restocked`; bestehende `stock-pick-then-ship-no-double-decrement` + `stock-shipped-idempotency` bleiben grün.
> **F3:** V4-Dedup-Lücke geschlossen, Placeholder nie `ready`, N-Invariante (N Outcomes), Route/Job-Parity.
> **F3b:** Scope-Gleichheit UI/Batch/V3/V2/Legacy gegen Register.
> **F4:** ein Status-Mapping, keine Raw-Farben im Kern, Cross-Tenant deny, Rules deny.
> **F5:** kein versandter Auftrag ohne Tracking-Push (durable retry), genau 1 Rechnung je Versand (kein Duplikat), genau 1 Korrektur-Gutschrift je Refund, Cron-Tenant-Fan-out deckt dieselben Tenants wie der Drain.

---
---

# TEIL F — Anti-Wildwuchs / Konsolidierung (Komplexität sinkt, nicht steigt)

- **Stock-Collections 3 → 1 Wahrheit:** `warehouseEvents` = Wahrheit; `warehouse_movements` migrieren (additiv, als `return_restock`/`adjust`); `inventory_ledger` = Telemetrie; `warehouseBins` = nur Layout. `stock_movements` (Plan 2) wird **nicht** angelegt.
- **Sync-Pflaster 8 → 1 Modell:** Fail-safe-end **retired** · `isRateLimited`/`isEndedListing`-Strings → ein Klassifizierer · `clearStaleItemId`/`pickActiveListing`/fragmentierte itemId-Felder → `marketplaceListings.externalId` · 20/60 %-Deaktivierungs-Guard → Ingest-Vollständigkeits-Gate · In-Process-`setTimeout` → durable Queue · In-Memory-Quota-Breaker → Firestore-shared · totes `stock_sync_failures` → gelöscht.
- **Flags ~30 → ~10:** Kill-Switches + echte Config behalten; ~15 Timing-`_MS`/Cache-Flags in eine Cadence-Tabelle (`sync-cadence.js`) falten; `RECONCILIATION_TENANTS` löschen. **CI/CD-referenzierte Vars unangetastet** (CLAUDE.md Punkt 4).
- **`stockDecrementedAt`-Marker-Hack → echte Idempotenz** (F1).
- **`isSuspiciousInventoryZeroing`/Zeroing-Pflaster → entfällt** (Ledger-Invariante ersetzt es).
- **Legacy `products`-Collection** bleibt read-only (Decisions.md); alle Schreibpfade über `saveProductV2()`.

---
---

# TEIL G — Vollständigkeits-Matrix (jedes Subsystem hat ein Zuhause)

> Beweis, dass **nichts von AvyCloud vergessen** wurde. Jeder reale Service-/Collection-Bereich → Fundament oder Status.

| Subsystem / Datei(en) | Fundament / Status |
|---|---|
| Identify V4/V3/Grounding/Legacy, `job-runner`, `generative-identify`, `image-grouping`, `scanner`, capture-UI | **F3** |
| `deduplication.js`, `product-validator.js`, `listing-validator.js` | **F3** (ins Tor) |
| Enrichment/Content (`enrichment-v2`, `content-enricher`, `chat-enricher`, `marketplace-enrichment`, `kaufland-attribute-enricher`) | **F3b** (Register) |
| „Alles optimieren": `batch-optimize`, `improve(-runner)`, `GeminiChat`, chat-v3/v2/legacy | **F3b** |
| Bestand: `warehouse`, `stock-reservation`, `stock-change-events`, `inventory-forecast`, `restock-alert`, `WarehouseView`/`InventoryView` | **F1** |
| `stock-reconciliation`, `stock-failure-drain`, `repair-double-decrement` | **F1** (Reconcile) + **F0** (Drain) |
| OMS: `order-state-machine`, `order-intake-ebay/kaufland`, `order-source-router`, `order-sync`, `pick-hints`, `number-sequence`, Orders-UI | **F2** |
| Marketplace-Sync: `stock-sync-dispatcher`, `listing-sync-runner`, `listing-pipeline`, `kaufland-listings-sync`, `marketplace-drift`, `ebay-trading-api`, `ebay-rate-limiter`, `MarketplaceListingsView` | **F0** |
| Publish/Listing: `ebay-listings`, `ebay-direct`, `ebay-catalog`, `ebay-auto-fix`, `listing-validator`, `kaufland-publish-audit` | **F0** (Publish) + Cross-Cutting (Auto-Fix) |
| Versand/Tracking/Zustellung: `shipping-engine`, `sendcloud`, `label-printer`, `marketplace-tracking`, delivery-poll | **F5** |
| Rechnung/Erstattung: `invoice-engine`, `sevdesk`, `ebay-finances`, `refund-sync`, `invoices`-Route | **F5** |
| Retouren: `returns-engine`, `returns`-Route, `return_events` | **F5** + **F2** (`return_restock`) |
| 6 Safety-Net-Cron-Jobs (order/returns/refund/sendcloud/tracking/delivery) + invoice-sync + reconciliation | **F5**/**F0**/**F1** (event-getrieben primär, Cron als Netz) |
| Pricing (`pricing-engine/-runner`, `competitor-refresh`, `sweet-spot-pricer`, Pricing-UI) | **Cross-Cutting (stabil)** + F3b-Scope |
| Rules (`rule-engine/-runner`, `rulebook-runner`, `RuleDashboard`) | **Cross-Cutting (stabil)** |
| Kategorie/GPSR/Quality (`category-resolver`, `quality-gate/-runner`, `ebay-category-governance`) | **Cross-Cutting** (in F3-Qualitätstor) |
| Auth/RBAC/Sessions/Roles (`auth`, `rbac`, `roles`, `public-auth`, `user-sessions`, `tenant-authorization`) | **F7 (NEU)** — Auth-Mechanik stabil, Verwaltungsfläche wird Produkt |
| Audit/Activity-Log (`audit-log`, `audit_log`, `logAudit`) | **F7 (NEU)** — compliance-fähiger Trail |
| GCP-Infra: Cloud Run / Firestore-DR / Storage-Buckets / IAM-SA / Secret Manager / Monitoring | **F8 (NEU, Live-Audit)** |
| Multi-Tenant (`background-job-tenants`, `attach-user-context`, `tenants`-Collection) | **F4** + Querschnitt |
| Observability (`external-api-tracker`, `audit-log`, `error-dashboard`, `llm-parity-dashboard`, `identify-runs-dashboard`) | **F4** (Operator-Cockpit) |
| Admin/Bulk (`admin-bulk-actions/-runner`, `bulk-update`, `recategorize_v2`) | **Cross-Cutting (stabil)** |
| Import/Export (`import-export`) | **Cross-Cutting (stabil)** |
| Gemini-Infra (`atomic-tools`, `prompt-cache`, `gemini-config`, `prompt-engine`, `model-select`) | **Cross-Cutting (stabil)**, F3/F3b-Konsument |
| Event-Bus (`sync-event-bus`, `emitSyncEvent`) | **Beschleuniger** (durable Queue = Rückgrat, Cron = Netz) — siehe B.1 |
| Webhooks (`webhooks` service+route, `sse`) | **F5**/**F0** (event-getriebener Primärpfad) |
| AI-Bildgenerierung (`image-generation`), `content-enrich-runner` | **F3b** (Bild/Content als optimierbare Domänen) |
| Integrations-Store/Onboarding (`integration-store`, `IntegrationsHub`, `IntegrationWizard`) | **F4** (Provisioning) |
| Kaufland-Client/Repair (`kaufland-api`, `kaufland-product-data-repair`, `kaufland-taxonomy`) | **F0** (Publish/Sync) |
| Admin-API (`admin-api`, `routes/admin`, `help`/`settings`-Routen) | **Cross-Cutting (stabil)** + F4-Cockpit |
| Frontend-Kernviews (Dashboard, Operations, ProductSheet, IntegrationsHub, Mobile-*) | **F4** (Status-System + Tokens) |
| CI/CD + Deployment (`.github/workflows`, `Dockerfile`, `firebase.json`, Cloud Run/Build) | **Cross-Cutting** — Launch-Gates (Teil D), sonst unangetastet |
| Abo/Billing AvyCloud→Mandant (Stripe o. ä., `tenants`) | **F6 (NEU)** |
| Tenant-Lifecycle + DSGVO-Export/Löschung (`safeDeleteTenantScoped`, `webhooks.js:384` GDPR) | **F6 (NEU)** — Primitive existieren |
| Pro-Mandant-Budgets/Limits (Gemini/SerpAPI/BrightData) | **F6** + Durchsetzung F0/F3 |
| Laufzeit/Kapazität (SSE `routes/sse.js`, Cloud-Run-Concurrency, API-Budget) | **Cross-Cutting B.4 (NEU)** |
| Backups / Disaster-Recovery (Firestore-Export/PITR/Restore) | **Cross-Cutting B.4 (NEU)** + Launch-Gate |
| Credential-Härtung (`integration-store` AES-GCM) + per-Tenant-Abuse-Limits | **B.4 / F6 (NEU)** — Krypto existiert, Restlücken |
| Landingpage | **Eigener Strang** (außerhalb Repo) |

---
---

# TEIL H — Bewusst NICHT angefasst + offene externe Blocker

**Stabil, ohne Anweisung nicht ändern** (CLAUDE.md): `lib/auth.js`/`lib/rbac.js` · bestehende Routen · Firestore-Feld-Renames/-Löschungen (additive only) · Dependencies · CI/CD-referenzierte ENV-Vars · `Dockerfile`/`firebase.json`/`cloudbuild.yaml` · Retired Middleware (TABU). Legacy `products` read-only.

**Offene externe Blocker (brauchen Freigabe, kein Code-Pflaster):**
- ~55 Angebote bis zur Best-Offer-Korrektur (Auto-Ablehnung < Sofortkaufpreis) nicht änderbar; 32 davon tot-mit-Bestand → Neulistung danach. **Benötigt:** Runbook + Owner + Reihenfolge (heute nur als „auf deine Freigabe" markiert).

**Bekannte Schuld (aus CLAUDE.md, in F0/F1 aufzulösen):** `routes/marketplace.js:966` (Kaufland-Reconcile) schreibt `inventory.quantity` direkt außerhalb `warehouse.js`/`product-store.js` (Gap C) → muss über `stock-core`.

---
---

# TEIL I — Status, Provenienz & Änderungslog

**Merge-Provenienz (was kam woher):**
- **F0** ← Plan 3 (komplett, inkl. verifizierter Slice-1-TDD + Brandfix-Historie).
- **F1/F2/F3/F3b** ← Plan 1 (Ledger-Invarianten, Tor, N-Invariante, Register) — `warehouseEvents`-Modell.
- **F4** ← Plan 1 (Detail) + Plan 2 (Tenant-Erzwingung, Provisioning, Cockpit).
- **F5 + Cross-Cutting + Vollständigkeits-Matrix** ← **neu in diesem Merge** (Lücke aller drei Pläne).
- **Launch-Gates / Reihenfolge / Governance** ← Plan 2 (korrigiert: F1 vor F0-Real-State; `stock_movements`→`warehouseEvents`; dangling Quell-Links entfernt).

**Änderungslog:**
- 2026-06-17: Drei Stränge analysiert (Code-Claims verifiziert), zu diesem Master-Plan gemerged. F5 (Fulfillment/Finance) + Cross-Cutting-Ebene + Vollständigkeits-Matrix ergänzt. Wahrheits-Fragmentierung (3 Stock-Collections) dokumentiert.
- 2026-06-17 (2): Drei Kritik-Dateien evaluiert (Claims code-verifiziert). Integriert: F6 (Billing/Lifecycle/DSGVO/Budgets), F0.X (Best-Offer-Ursache), F1.X (Ist-Bestand-Korrektur), F5.X (Finanz-Reconcile + Webhook-Sicherheit), B.4 (Laufzeit/Kapazität/DR/Security), Teil C (Rollback/Sign-off/`default`-Umzug), Teil D.3–D.5 (E2E/Last-Gate, Day-2, Ownership). Überzeichnete Kritiken korrigiert (siehe Teil J). Reine Planung, keine Production-Änderung.
- 2026-06-17 (3): **Live read-only GCP-Audit** (Projekt `avycloud`/`europe-west3`). Account-Layer als **F7** (IAM/RBAC/Settings/Audit existiert, war fälschlich „stabil"), GCP-Infra als **F8** mit Messwerten. Bestätigt: **concurrency=1** (Kapazitäts-Risiko real). Korrigiert: Firestore-**PITR EIN + 30d-Backup** (DR-Kritik teilweise falsch), Creds in **Secret Manager**. Neufunde: US-Buckets/DSGVO-Residenz, Default-Compute-SA mit Editor, delete-protection AUS, **0 Alert-Policies**. Audit ohne jede Mutation.
- 2026-06-17 (4): **Außen-Review (2 unabhängige Reviewer) eingearbeitet.** Track 1 auf Auslieferungs-Blöcke (WP0+WP1 zuerst, dann WP3) zugeschnitten; WP0 Baseline + delete-protection; WP1 Kill-Switch-Flag; WP3 Restore-Anker + messbarer Shadow; WP4 force-Negativliste; WP5 Kapazitäts-Vorbehalt; WP2 DoD getrennt. Auslöse-Architektur auf **durable-first** korrigiert (alle Stellen angeglichen). Governance (D.4/D.5) für Solo-Betrieb entschlackt; F3–F8 als Backlog markiert; Staging-Realität (Prod-Shadow) ehrlich gemacht; tote Referenz „B.D" gefixt. Neuer **Execution-Guide** (`avycloud-execution-guide.md`) für die sichere Agenten-Übergabe. Reine Planung/Doku, kein Code.

---
---

# TEIL J — Kritik-Evaluation (was übernommen, was zurückgewiesen)

> Drei Begleitdokumente kritisierten diesen Plan: `avycloud-master-plan-kritik-claude.md`, `avycloud-master-plan-review.md`, `avycloud-master-plan-kritik.md` — alle drei seit 2026-06-17 archiviert unter `docs/archive/2026-06-17-foundations-merge/`. Jeder Punkt wurde **gegen den Code geprüft**. „Nicht alles wird zu Recht kritisiert."

| # | Kritikpunkt | Verdikt | Beleg / wohin integriert |
|---|---|---|---|
| Best-Offer-Ursache | Repricer senkt BIN ohne Auto-Ablehnung anzupassen; `BestOfferDetails` fehlt | ✅ **Valide (code-bestätigt)** | 0 Treffer repo-weit; `:518`/`:704`/`products.js:1973` → **F0.X** |
| Billing/Abo fehlt | kein AvyCloud→Mandant-Billing | ✅ **Valide (code-bestätigt)** | 0 Stripe/Subscription → **F6** |
| Ist-Bestand korrigieren | Eröffnung aus korruptem `warehouseBins` | ✅ **Valide** | `warehouse.js` Overwrite → **F1.X** |
| Laufzeit/Kapazität (SSE, Fan-out, API-Budget) | nicht abgedeckt; F0-Hot-Loop verschärft | ✅ **Valide — LIVE bestätigt** | concurrency=1/600s/max20 gemessen → **F8 + B.4** |
| Backups / DR | „keine Firestore-Backup/PITR-Strategie" | ⚠️ **Teilweise korrigiert** | PITR EIN + 30d-Backup (F8); Restlücke = delete-protection AUS + Restore ungetestet + 0 Alerts → **F8** |
| Rollback-Runbooks / Migrations-Sign-off | „reversibel" behauptet, nicht ausführbar | ✅ **Valide** | → **Teil C** |
| E2E/Last-Beweis + Gate-Verdrahtung | Gates nur Unit-Invarianten | ✅ **Valide** | → **Teil D.3** |
| Day-2/Incident-Runbook + Ownership | Erkennung ohne Reaktion | ✅ **Valide** | → **Teil D.4/D.5** |
| Finanz-Reconcile vs. Payout/Bank | nur operatives „1 Rechnung" | ✅ **Valide (teilweise)** | → **F5.X** |
| Pro-Mandant-Budgets | Tracking ohne Enforcement | ✅ **Valide** | → **F6** |
| Webhook-Signatur/Replay | Primärpfad ungehärtet | ✅ **Valide** | → **F5.X** |
| DSGVO „komplett verloren" | — | ⚠️ **Überzeichnet** | GDPR-Endpoint + `safeDeleteTenantScoped` existieren → Restlücke in **F6** |
| Credential-Sicherheit „fehlt/halb" | — | ⚠️ **Überzeichnet** | AES-256-GCM (`integration-store.js`) **+ 20 Secrets in Secret Manager** (F8); Restlücke = Plaintext-Fallback + Rotation + per-Tenant-Scope → **B.4/F8** |
| Rate-Limiting „nicht stabil" | — | ❌ **Veraltet** | Incident 2026-05-25 bereits gefixt (`lib/rate-limit.js` + Regression-Test); nur per-Mandant-Abuse offen → **F6** |
| „Job-Queue (Cloud Tasks) ist Pflicht" | — | ⚠️ **Problem valide, Lösung über-präskriptiv** | als Option in **B.4**, Entscheidung an Lastzahlen |
| Steuerberater-Altlasten (Rechnung 12, Storno 47…) | — | ❓ **Nicht verifizierbar** | als Backfill-Kandidat in **F5.X**, kein Plan-Kern |
| i18n/a11y, `default`→Tenant-Umzug, `warehouse_movements`-Idempotenz | klein | ✅ **Valide (klein)** | **Teil C** / **F1.X** |
| Account-Layer (IAM/RBAC/Settings/Audit) als „stabil" geparkt | deine Rückfrage | ✅ **Valide** | → **F7 (NEU)** |
| 🔵 US-Buckets (genAI/cloudbuild) — DSGVO-Residenz, keine Lifecycle, UBLA aus | Live-Audit-Neufund | 🔵 **Neu (nicht in Kritiken)** | → **F8** |
| 🔵 Default-Compute-SA mit `roles/editor` (Cloud-Run-Runtime über-privilegiert) | Live-Audit-Neufund | 🔵 **Neu** | → **F8** |
| 🔵 Firestore delete-protection AUS + Restore ungetestet | Live-Audit-Neufund | 🔵 **Neu** | → **F8** |
| 🔵 0 Monitoring-Alert-Policies (kein Infra-Alerting) | Live-Audit-Neufund | 🔵 **Neu** | → **F8 + D.4** |

**Nächster Schritt:** Umsetzung startet mit **Track 1 (Teil K.1)** — Hand-off an Claude Code im IDE. Dieses Dokument bleibt **Planung**; Code-Edits + Deployment macht Claude Code.

---
---

# TEIL K — Umsetzungs-Tracks (Reihenfolge nach Entscheidung 2026-06-17)

Die Fundamente werden in **drei Tracks** geliefert. Entscheidung: **Track 1 zuerst.** Tracks 2 und 3 stehen danach (hier bewusst noch nicht ausdetailliert).

| Track | Klartext | Fundamente |
|---|---|---|
| **1 — Brände löschen** | Bestand/Bin verschwinden nicht mehr · Angebote enden nicht von selbst · Fehler heilen sich · du *siehst* sie | F0 + F1 + F2 (+ Frühwarnung aus F8) |
| **2 — Versprechen einlösen** | Foto → fertiges Datenblatt ohne Chat-Nacharbeit | F3 + F3b |
| **3 — Mehrkundenfähig** | Raus aus „default" · zweiten Kunden sauber anlegen | F4 + F6 + F7 (+ F8-Härtung) |

> **Hand-off-Regel:** Dieses Dokument ist **Planung**. Code-Edits + Deployment macht **Claude Code im IDE**, Arbeitspaket für Arbeitspaket, nach den Nicht-verhandelbar-Regeln in `CLAUDE.md` (additiv · kein Feld-Rename · Single-Writer · Flags + Shadow-first · Tests zuerst mit Vitest + `require.cache` · keine Route ohne Anweisung · **Production unberührt**). Jedes Paket: TDD → häufige Commits → definierter Rollback-Pfad → Akzeptanz grün, dann nächstes.

## K.1 — Track 1: Brände löschen *(JETZT — hand-off-ready)*

**Ziel in einem Satz:** Die zwei täglichen Brände (Ware/Bin verschwindet · Angebote enden von selbst) werden *baulich unmöglich*, Fehler heilen sich selbst, und alles ist sichtbar — statt per Zufall entdeckt.

**Auslieferung in Blöcken (nach Außen-Review — klein anfangen, früh Vertrauen):**
- **Block 1 = WP0 + WP1** — Sichtbarkeit + Sync-Recovery. Kein Bestands-Cutover, kein Risiko-Schritt. **Bewusst hier stoppen**, bis es **1 Woche stabil in Produktion** läuft. Der schnelle, vertrauensbildende Win.
- **Block 2 = WP3 (+ WP2)** — der Bestands-Umbau. Erst nach stabilem Block 1. Höchstes Risiko → eigener Sicherheits-Ablauf (siehe WP3).
- **Block 3 = WP4 + WP5** — Auftrags-Symmetrie + echter Abgleich. WP5 erst, wenn die Kapazitäts-Bremse steht (siehe Hinweis WP5).
- **Ausführung:** strikt nach [`avycloud-execution-guide.md`](avycloud-execution-guide.md) — Hand-off-Steckbrief + Owner-Abnahme-Checkliste je WP, ein Branch pro WP, Tests zuerst, Commit nur auf dein OK.

**WP0 — Frühwarnung an + Baseline (sehen, bevor es brennt).**
- *Für dich:* Ein Dashboard-Signal + Alarm, der anschlägt, wenn etwas hängt — statt es zufällig zu merken. Und: **die heutigen Zahlen einfrieren**, damit „besser" später beweisbar ist.
- *Technisch:* Sync-SLO-Sektion in `system-health` (= Teil E, Task 7). Plus erste Cloud-Monitoring-Alert-Policies (heute **0**, F8): Cloud Run 5xx/Latenz/Instanz-Sättigung + Alarm auf Sync-Backlog/Oversell-Drift. **Plus zwei triviale F8-Config-Tasks vorgezogen:** Firestore-`delete-protection` **AN**, 1–2 Alert-Policies scharf. *(Monitoring + delete-protection = GCP-Config, kein App-Code.)*
- *Baseline (mind. 3–7 Tage VOR WP1):* heutige Sync-Erfolgsrate · Backlog · Oversell-Drift · Bestand-Nullungs-Rate · **und** „Stunden/Woche Handarbeit" (grobe Strichliste) einfrieren. Alle späteren Ziele werden gegen diese Baseline gelesen.
- *Abhängigkeit:* keine · *Rollback:* rein additiv (nur Anzeige/Alarm/Config).
- *Fertig wenn:* Backlog + Erfolgsrate + Oversell-Drift sichtbar · Test-Alarm feuert · Baseline-Werte dokumentiert.

**WP1 — Angebote sterben nie mehr von selbst (F0 Slice 1).**
- *Für dich:* Scheitert ein Update an eBay/Kaufland, wird es **nachgeholt** — nie das Angebot beendet.
- *Technisch:* Teil E, Tasks 1–7 (Fehler-Klassifizierer ohne destruktive Klasse · reines Backoff · Firestore-shared Quota-Breaker · In-Process-`setTimeout`-Retry raus → durable Drain · Backoff-Drain). Basis: Brandfix `c339184`.
- *Kill-Switch (NEU, wichtig):* Die geänderte Verhaltensweise im heißesten Modul (`stock-sync-dispatcher.js`, ~30 Aufrufer) läuft hinter einem Flag (z. B. `SYNC_DURABLE_DRAIN`, default **aus** → Shadow → **an**). „Additiv" gilt für die neuen Dateien — die *Verhaltensänderung* braucht trotzdem einen Sofort-Rückschalter, gerade weil das exakt das Modul des 66-Angebote-Vorfalls ist.
- *Abhängigkeit:* keine · *Rollback:* Flag zurück (Sekunden), kein Redeploy nötig.
- *Fertig wenn:* gescheitertes Update beendet nie ein Listing; Fehlversuche landen in der Queue und überleben einen Neustart; Flag-Umschaltung getestet.

**WP2 — Preis-Push lähmt keine Angebote (F0.X Best-Offer).**
- *Für dich:* Der Repricer kann ein Angebot nicht mehr in einen Zustand bringen, in dem keine Änderung mehr durchgeht.
- *Technisch:* Best-Offer-Auto-Ablehnungsschwelle aus eBay **lesen** (neuer Lesepfad; `BestOfferDetails` kommt heute 0× vor → eigener baubarer Schritt) und in `observed` aufnehmen; Preis-Push senkt den Sofortkaufpreis nie darunter (oder passt sie im selben Call an).
- *DoD getrennt (NEU):* **(intern, messbar)** Prävention gebaut → neue „Auto-Ablehnung ≥ Sofortkauf"-Fälle sind baulich unmöglich. **(extern, separat)** die ~55 bestehenden Alt-Fälle sind ein Freigabe-/Owner-Thema aus Teil H — **nicht** als Code-Abschlusskriterium führen.
- *Abhängigkeit:* nach WP1 · *Fertig wenn:* neue Fälle baulich verhindert + vor dem Push erkannt (die Alt-55 laufen separat über Teil H).

**WP3 — Bestand wird gebucht, nicht geraten (F1).**
- *Für dich:* Bestand kann nicht mehr „aus Versehen" auf 0 fallen; jede Bewegung ist eine Buchung wie ein Kontoauszug.
- *Technisch:* `stock-core` (einziger Schreiber) dunkel bauen → **F1.X Ist-Bestand-Audit + Korrektur ZUERST** (echten Bestand prüfen/korrigieren, bevor er zur Eröffnung wird) → Shadow → Umschalten (`STOCK_LEDGER`) → Überschreib-Pfad entfernen. `warehouseBins` nur noch Layout.
- *Shadow messbar (NEU):* mind. **7 Tage UND ≥ 1 vollständiger Order-Lebenszyklus** (Eingang→Pick→Versand→Storno→Retoure); Tor ist ein **automatischer `reconcileLedger`-Report** mit harter Schwelle (0 unerklärte Diffs; jede erklärte dokumentiert) — nicht „sieht gut aus". Abnahme über die Owner-Checkliste im Execution-Guide.
- *Sicherheits-Anker VOR dem Cutover (NEU, Pflicht):* (a) `delete-protection` ist AN (aus WP0); (b) frischer Firestore-Export + notierter PITR-Zeitstempel als Rücksprung-Anker; (c) Restore **einmal in einem Test geübt**, bevor umgeschaltet wird; (d) **Abbruch-Kriterium**: „> Schwelle unerklärte Diffs → Stopp, Flag zurück, Restore auf Zeitstempel T".
- *Abhängigkeit:* nach stabilem Block 1 · *Rollback:* Flag zurück → Shadow; Reparatur per `adjust`-Buchung; im Notfall Restore auf PITR-Anker.
- *Fertig wenn:* Re-Identify/Leer-Read ändern nie den Bestand; `onHand = Σ Buchungen`; „Ware/Bin verschwindet" ist baulich unmöglich.

**WP4 — Storno/Retoure bucht sauber zurück (F2).**
- *Für dich:* Storniert/retourniert → Bestand kommt korrekt zurück, nichts bleibt auf 0, nichts wird doppelt abgezogen.
- *Technisch:* `cancelled→reverse` · `returned→return_restock` · Intake nur über `transitionOrder({force:true})` · ein Decrement (pick xor ship). Nicht-einlagerbare Retoure sichtbar markiert.
- *Sicherung (NEU):* `force:true` umgeht die Transition-Whitelist — deshalb eine kleine **Negativ-Liste verbotener Zielzustände auch bei `force`** (z. B. kein doppeltes `shipped→shipped`, kein Rückwärts `completed→picking`) + Test, dass Intake keinen bestandswirksamen Doppel-/Rückwärts-Übergang erzeugt.
- *Abhängigkeit:* nach WP3 · *Fertig wenn:* Storno bucht genau einmal zurück; Retoure lagert ein oder ist sichtbar „nicht eingelagert"; kein verbotener Übergang trotz `force`.

**WP5 — Echter Marktplatz-Abgleich (F0 Real-State).**
- *Für dich:* Das System vergleicht regelmäßig mit dem *echten* Stand bei eBay/Kaufland — nicht mit dem zuletzt Gesendeten.
- *Technisch:* `marketplace-drift.js` an einen Häufig-Abgleich hängen; gegen echten Marktplatz-Zustand reconcilen. Braucht F1s `availableToSell`.
- *Kapazitäts-Vorbehalt (NEU, wichtig):* Dieser Häufig-Abgleich erhöht API-Calls + Reads auf einem System, das bei concurrency=1/max20 schon sättigt (siehe B.4/F8). **Voraussetzung vor WP5:** entweder die SSE-/Concurrency-Entkopplung **oder** das per-Kanal/Tenant-API-Budget (Token-Bucket) ist live. Sonst macht WP5 die Kapazität schlimmer, bevor F8 sie fixt → WP5 bis dahin zurückstellen.
- *Abhängigkeit:* nach WP3 **und** Kapazitäts-Bremse · *Fertig wenn:* Oversell-Drift wird erkannt + geheilt; „Lager und Marktplatz driften auseinander" hört auf; kein Kapazitäts-Einbruch.

**Track 1 erledigt, wenn (Definition of Done):**
- *Klartext:* Produkte/Bins verschwinden nicht mehr · Angebote sterben nicht von selbst · Sync-Hänger heilen sich · du siehst alles auf einem Dashboard.
- *Messbar:* 0 offene Oversell-Drift · Sync-Erfolg ≥ 99 %/24 h · Backlog unter Grenzwert · 0 stille Bestand-Nullungen · die ~55 hängenden Angebote recovered.

**Was Track 1 bewusst NICHT anfasst** (Fokus halten): Identify-Content-Qualität (Track 2) · „default"→echter Mandant + Onboarding (Track 3) · Billing · breitere Infra/UX. Erst nach grünem Track 1.

## K.2 — Track 2: Versprechen einlösen *(danach)*
Foto → fertiges Datenblatt ohne Chat-Nacharbeit. Fundamente **F3 + F3b**: ein Speicher-Tor mit Qualitäts-/Platzhalter-Check · die stärkere Erkennungs-Maschine scharf schalten + tunen · „Alles optimieren" über das ganze Feld-Register. *(Noch nicht in Arbeitspakete zerlegt — kommt nach grünem Track 1; braucht zusätzlich eine kleine KI-Qualitäts-Messung, da Content-Qualität Feintuning ist, kein Schalter.)*

## K.3 — Track 3: Mehrkundenfähig *(zuletzt, vor Public-Launch)*
Raus aus „default": TrendOcean einen echten Mandanten-Namen geben (additive Migration), dann zweiten Kunden sauber anlegbar machen. Fundamente **F4 + F6 + F7**, abgesichert durch **F8**-Härtung (least-privilege · EU-Residenz · delete-protection · Alerts). *(Detaillierung nach Track 1/2.)*

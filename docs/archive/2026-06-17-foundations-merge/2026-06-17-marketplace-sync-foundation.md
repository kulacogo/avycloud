# Fundament 5 — Marktplatz-Sync (Reliability Core) · Lebendes Dokument

> **Status:** Entwurf zur Abstimmung · zuletzt 2026-06-17
> **Nordstern:** [`2026-06-17-avycloud-foundations-overview.md`](2026-06-17-avycloud-foundations-overview.md) — diese Spec hält die festen Begriffe ein und widerspricht ihnen nicht.
> **Geschwister-Fundamente:** [Inventar](2026-06-17-inventory-foundation-design.md) · [Aufträge](2026-06-17-order-foundation-design.md) · [Identify](2026-06-17-identify-foundation-design.md) · [UI/UX+SaaS](2026-06-17-ux-saas-foundation-design.md)
> **Production-Regel ist heilig:** kein Breaking Change, kein Datenverlust, kein Downtime. Aufbau neben dem Bestehenden, Strangler, kein Big-Bang.
>
> **Dies ist EIN fortlaufendes Dokument** — keine verstreuten Dateien. Vier Teile:
> **A** in einfacher Sprache (für Entscheider) · **B** technische Spec · **C** Umsetzungsplan (TDD) · **D** Status & Änderungslog.

---

## Warum dieses Fundament existiert

Die vier Geschwister-Fundamente klammern die **Marktplatz-Sync-Mechanik bewusst aus** (Inventar §10, Aufträge §10, Identify §12, UI/UX §10: „bleibt wie ist"). Genau diese Mechanik hat aber am 16.06.2026 **66 gesunde eBay-Angebote getötet**. Sie ist der patchigste Teil von AvyCloud (≈30 ENV-Flags, ~8 Pflaster, blinder Abgleich, In-Process-Retries die auf Cloud Run sterben). Dieses Fundament schließt die Lücke — als sauberer Baustein, der die Ergebnisse der anderen *konsumiert*, nicht dupliziert.

**Wie es einrastet:**
- nimmt die **verfügbare Menge** (`available`) aus **Fundament 1** (Lagerbuch) — rechnet selbst keinen Bestand,
- wird von **Fundament 2** (`transitionOrder`) und Bestandsänderungen **ausgelöst**,
- veröffentlicht nur, was **Fundament 3** als `ready` markiert,
- zeigt seinen Zustand über **Fundament 4** (`StatusPill`/`system-health`), erfindet keine eigene Badge-Tabelle.

---

# Teil A — In einfacher Sprache

*(Kein Technik-Jargon. Für die Entscheidung, nicht für die Umsetzung.)*

### Was dieser Baustein tut
Er hält deine Angebote auf eBay und Kaufland **korrekt und in Einklang mit dem Lager**: richtige Menge, richtiger Preis, nichts wird versehentlich beendet, nichts wird doppelt verkauft. Wenn ein Update an den Marktplatz mal nicht durchgeht, wird es **sauber nachgeholt** — statt dass irgendwas kaputtgeht.

### Was kaputt war (der Vorfall vom 16.06.)
Beim Einlagern eines Artikels (Menge stieg von 1 auf 2) wollte das System die neue Menge an eBay melden. Dieses Melden schlug fehl — nicht wegen des Lagers, sondern wegen einer **falschen Preis-Einstellung im eBay-Angebot** (Preisvorschlags-Untergrenze über dem Verkaufspreis). Das alte System hatte eine grobe „Notbremse": *Wenn das Melden scheitert, beende das Angebot.* Diese Notbremse hat das gesunde Angebot **gelöscht** — und es als „Erfolg" verbucht, sodass niemand es gemerkt hat. Das ist in 30 Tagen **66 Mal** passiert.

### Was wir bauen (in drei Sätzen)
1. **Das System kennt den echten Zustand auf dem Marktplatz**, bevor es etwas ändert — statt blind zu pushen und bei Fehlern zu raten.
2. **Fehler beim Melden beenden nie ein Angebot.** Sie werden in eine Warteschlange gelegt und automatisch wiederholt (mit wachsendem Abstand), bis es klappt — auch wenn zwischendurch ein Server neu startet.
3. **Ein einziges Gesundheits-Signal** zeigt auf einen Blick: „Ist alles synchron, oder hängt etwas?" — drei Zahlen, keine Badge-Flut.

### Warum das tragfähig ist (für mehrere Kunden im Abo)
- Es macht das öffentliche Landingpage-Versprechen wahr und nachprüfbar: *zuverlässig, 0 Überverkäufe, kanalübergreifend exakt.*
- Es **reduziert** Komplexität statt sie zu erhöhen: ~30 Schalter → ~10, ~8 Notlösungen → 1 klares Modell.
- Es ist additiv und reversibel: das Bestehende läuft weiter, bis das Neue 1:1 bewiesen ist.

### Wo wir gerade stehen
- ✅ **Sofort-Brandfix ist live** (auf `main` deployed): Ein gescheitertes Melden beendet kein Angebot mehr. Das Sterben ist gestoppt.
- ✅ **Spec + Umsetzungsplan stehen** (dieses Dokument, Teil B & C).
- ⏳ **Offen:** die ~55 noch betroffenen Angebote brauchen eine Best-Offer-Korrektur, bevor sie wieder änderbar sind (Marktplatz-Aktion — auf deine Freigabe). Umsetzung von „Slice 1" wartet auf dein Startsignal bzw. die Vergleichsrunde mit den anderen Plänen.

---

# Teil B — Technische Spec

## B.1 Das Problem (code-belegt)
AvyCloud kennt den **echten** Listing-Zustand nie; es pusht blind und entscheidet bei Fehlern per String-Matching (`'beendet'`, `'exceeded usage limit'`, `'Not Found'`) mit destruktiver Default-Aktion. Retries leben in per-Instanz-`setTimeout`s, die mit der Cloud-Run-Instanz sterben. Der Abgleich (`stock-reconciliation.js:47`) vergleicht gegen den **zuletzt gepushten** Wert, nie gegen die Marktplatz-Realität → strukturell oversell-blind. Der Real-State-Reader existiert bereits (`lib/marketplace-drift.js`), ist aber **nicht** an einen Cron gehängt.

## B.2 Prinzipien (aus dem Nordstern, hier angewandt)
1. **Autoritativer Zustand statt Raten:** jedes Listing hat `desired` (gewollt) und `observed` (echt am Marktplatz). Aktionen = `diff(desired, observed)`, nie Fehler-String.
2. **Eine durable Pipeline:** Soll-Änderung → durables Work-Item → idempotenter Worker → Ergebnis protokolliert → Reconciliation als Netz. **Keine In-Process-`setTimeout`-Retries.**
3. **Entscheidung aus Zustand:** ein gescheitertes Update **re-beobachtet und entscheidet neu** — beendet nie blind (zementiert den Brandfix `c339184`).
4. **Fehler sichtbar, nie still:** jedes scheiternde Sync landet in der durable Queue + Alert (Nordstern-Prinzip 6).
5. **Genau einmal / idempotent · Mandanten-getrennt · feste IDs** (Nordstern 3/4/5/7).

## B.3 Zielarchitektur
```
 Soll-Änderung (Bestand/Preis/Auftrag)
   → emitSyncEvent('stock:changed')                (bleibt der Auslöser)
   → durables Work-Item (sync_tasks, idempotent auf dedupeKey)
   → idempotenter Sync-Worker  ── Fehler(retryable) ─► backoff in sync_tasks
   → Ergebnis (stock_sync_log) + SLO-Signal
   ▲
   └─ Reconciliation gegen ECHTEN Marktplatz-Zustand (marketplace-drift.js, 5-min hot / täglich cold)
```
Listing-Identität (heute über `ops.ebay.*`/`marketplace.ebay.*`/`ebayListingsLive` verstreut) wird auf **eine** kanonische Stelle `marketplaceListings.externalId` konsolidiert (Spätere Slice; siehe C-Folgeslices).

## B.4 Feste Begriffe dieses Fundaments
- **`available`** (aus Fundament 1) ist der einzige Mengenwert, der an Marktplätze geht. Dieses Fundament rechnet **keinen** Bestand.
- **`sync_tasks`** = die durable Sync-Warteschlange (ersetzt In-Process-Retry + `stock_operation_failures`-Sonderfall + das tote `stock_sync_failures`).
- **Fehlerklasse** (`classifyMarketplaceError`) ∈ `rate_limited | ended | not_found | listing_config | transient`. **Keine** Klasse ist destruktiv.
- **`reconcile`-Zustand** je Listing ∈ `converged | drifted | blocked | pending`.

## B.5 Entscheidungs-Funktionen (rein, testbar)
- `classifyMarketplaceError(channel, message) → {retryable, kind}` — die *eine* Stelle für Fehler-Semantik.
- `computeNextRetryAt({attempts, kind, now, quotaUntil}) → ts` — exponentielles Backoff, quota-aligned.
- `planReconcileAction({desired, observed, lifecycle}) → none|publish|revise|end|onhold|defer|block` — Lifecycle aus **Zustand** (spätere Slice; Slice 1 deckt den Failure-Pfad ab).

## B.6 Beobachtbarkeit (Fundament-4-konform, keine Badges)
`GET /api/admin/system-health` bekommt eine `sync`-Sektion mit drei Signalen: **Backlog** (offene `sync_tasks` + Alter der ältesten), **Erfolgsrate** (24 h), **Überverkauf-Drift** (offene `marketplace_drift` mit `marketplace > ours`). Angezeigt über `StatCard`/`StatusPill` (Fundament 4).

## B.7 Was retired/konsolidiert wird (Anti-Müll-Bilanz)
Fail-safe-end **retired** · `isRateLimited`/`isEndedListing`-Strings → **ein** Klassifizierer · `clearStaleItemId`/`pickActiveListing`/fragmentierte itemId-Felder → `marketplaceListings.externalId` · 20/60 %-Deaktivierungs-Guard → Ingest-Vollständigkeits-Gate · In-Process-`setTimeout`-Retries → durable Queue · In-Memory-Quota-Breaker → Firestore-shared · totes `stock_sync_failures` → gelöscht. **Flags:** ~30 → ~10 (Kill-Switches + echte Config behalten; ~15 Timing-`_MS`/Cache-Flags in eine Cadence-Tabelle falten; `RECONCILIATION_TENANTS` löschen). CI/CD-referenzierte Vars bleiben unangetastet.

## B.8 Sichere Migration (Strangler)
P0 beobachten (shadow `observed` + `desired`-Projektor + Zähler) → P1 shadow-decide (`planReconcileAction` mitlaufen, Historie replayen → beweist, dass kein Plan ein lebendes Listing beendet hätte) → P2 durable Queue (setTimeout raus) → P3 Real-State-Read + Reconciliation (shadow, dann scharf) → P4 emit-on-transition + Reservierungs-Konvergenz → P5 doc-id-Dedup + tenant-Resolver vereinheitlichen → P6 Pflaster/Flags retiren. Jede Phase additiv, reversibel.

## B.9 Was dieses Fundament NICHT tut (Abgrenzung zu den Geschwistern)
Kein Bestands-Schreiben (Fundament 1 `applyStockMovement`) · keine Auftrags-Zustände (Fundament 2 `transitionOrder`) · kein Datenblatt-Speichern/Publish-Gate (Fundament 3 `commitDatasheet`) · keine Design-System-/Tenant-Isolation-Mechanik (Fundament 4, wird nur *genutzt*).

---

# Teil C — Umsetzungsplan (TDD)

> **Für agentic worker:** Pflicht-Sub-Skill `superpowers:subagent-driven-development` oder `superpowers:executing-plans`. Schritte als `- [ ]`. Tests: Vitest + `require.cache`-Patching (kein `vi.mock` für CJS, `.claude/rules/backend.md`). Alles additiv, kein Flag, keine Route geändert.

**Slice 1 = „Durable, non-destructive Sync-Recovery"** — der laut Spec höchste Hebel, in sich abgeschlossen.

### Dateien
| Datei | Rolle | Status |
|---|---|---|
| `backend/lib/marketplace-error-classifier.js` | Eine Stelle für Fehler-Semantik; keine Klasse destruktiv. | NEU |
| `backend/lib/retry-backoff.js` | Reines Backoff `computeNextRetryAt`. | NEU |
| `backend/lib/ebay-quota-breaker.js` | Firestore-shared Quota-Breaker. | NEU |
| `backend/services/stock-sync-dispatcher.js` | `setTimeout`-Retry raus → sofort durable persistieren; `classification`+`nextRetryAt` stempeln. | MODIFY |
| `backend/services/stock-failure-drain.js` | nur fällige Docs (`nextRetryAt<=now`); Backoff bei Fehlschlag. | MODIFY |
| `backend/lib/ebay-trading-api.js` | Quota-Breaker an shared Modul delegieren. | MODIFY |
| `backend/routes/admin.js` | `sync`-SLO-Sektion in system-health. | MODIFY |

### Task 1 — Fehler-Klassifizierer (keine Klasse ist destruktiv)
- [ ] **RED** `backend/__tests__/marketplace-error-classifier.test.js`: rate_limited/ended/not_found/listing_config(Best-Offer-Incident)/transient + **Invariante**: keine Klasse `end`/`delete`.
- [ ] **Run → fail** (`Cannot find module`).
- [ ] **GREEN** `backend/lib/marketplace-error-classifier.js`:
```js
'use strict';
const RATE_LIMITED=['exceeded usage limit','check your call usage'];
const ENDED=['beendet','ended','1047'];
const NOT_FOUND=['not found','404','not_found'];
const LISTING_CONFIG=['automatische ablehnung','automatische annahme','preisvorschlag','sofort-kaufen','sofortige bezahlung','auflösung der bereitgestellten bilder'];
const KINDS=['rate_limited','ended','not_found','listing_config','transient'];
const any=(l,a)=>a.some(s=>l.includes(s));
function classifyMarketplaceError(channel,message){
  const l=String(message||'').toLowerCase();
  if(any(l,RATE_LIMITED))return{retryable:true,kind:'rate_limited'};
  if(any(l,ENDED))return{retryable:false,kind:'ended'};
  if(any(l,NOT_FOUND))return{retryable:false,kind:'not_found'};
  if(any(l,LISTING_CONFIG))return{retryable:true,kind:'listing_config'};
  return{retryable:true,kind:'transient'};
}
module.exports={classifyMarketplaceError,KINDS};
```
- [ ] **Run → pass.** Commit `feat(sync): single marketplace error classifier (no destructive kind)`.

### Task 2 — Reines Backoff (quota-aligned)
- [ ] **RED** `retry-backoff.test.js`: 60s/120s/240s, Cap 30min, rate_limited ≥ quotaUntil.
- [ ] **GREEN** `backend/lib/retry-backoff.js`:
```js
'use strict';
const BASE_MS=60_000, CAP_MS=30*60_000;
function computeNextRetryAt({attempts,kind,now,quotaUntil=0}){
  const backoff=Math.min(BASE_MS*Math.pow(2,Math.max(0,attempts)),CAP_MS);
  const earliest=now+backoff;
  return (kind==='rate_limited'&&quotaUntil>earliest)?quotaUntil:earliest;
}
module.exports={computeNextRetryAt,BASE_MS,CAP_MS};
```
- [ ] **Run → pass.** Commit `feat(sync): pure quota-aware retry backoff`.

### Task 3 — Firestore-shared Quota-Breaker
- [ ] **RED** `ebay-quota-breaker-shared.test.js`: Instanz A öffnet → Instanz B (frischer Cache) blockt; `getQuotaCooldownUntil` liefert Ende.
- [ ] **GREEN** `backend/lib/ebay-quota-breaker.js`: Doc `system/ebay_quota_breaker {until,openedAt}`, 10s In-Process-Cache, fail-open auf letzten Wert. Exporte `openEbayQuotaBreaker({now,cooldownMs})`, `getQuotaCooldownUntil({now,useCache})`, `ebayQuotaCooldownActive({now,useCache})`.
- [ ] **Run → pass.** Commit `feat(ebay): Firestore-backed shared quota breaker (cross-instance)`.

### Task 4 — In-Process-`setTimeout`-Retry entfernen (Drain ist einziger Retry)
- [ ] **RED** `stock-sync-no-setTimeout-retry.test.js`: ein retryable Failure erzeugt **synchron** ein `stock_operation_failures`-Doc (ohne Timer vorzuspulen) und plant **kein** 30000ms-`setTimeout`.
- [ ] **Run → fail** (heute liegt der Drain-Write im `setTimeout`).
- [ ] **GREEN** in `syncStockWithRetry`: `allRateLimited`-Shortcut + gesamten `setTimeout(…,30000)`-Block entfernen; stattdessen:
```js
const isDrainRetry=String(reason||'').startsWith('drain:');
if(!skipPersistentFailureQueue && !isDrainRetry){
  await persistSyncFailureForDrain({tenantId,product,reason,failedChannels}).catch(()=>{});
}
return first;
```
- [ ] **Run** neuer Test + `stock-sync-retry-failure-queue.test.js` (der `advanceTimersByTimeAsync(30000)` wird No-op; Assertion „1 op-failure add" bleibt wahr). Dann `npm test`.
- [ ] Commit `fix(sync): durable-only retry — remove in-process setTimeout (Cloud Run loses nothing)`.

### Task 5 — Backoff-bewusster Drain
- [ ] **RED** `stock-failure-drain-backoff.test.js`: `isDue({nextRetryAt:future},now)===false`; legacy-Doc ohne Feld → `true`.
- [ ] **GREEN** in `stock-failure-drain.js`: `isDue(doc,now)` exportieren; Pending-Liste nach `isDue(d,Date.now())` filtern (kein neuer Index — In-Code-Filter); bei Fehlschlag `nextRetryAt=computeNextRetryAt({attempts,kind:doc.classification||'transient',now,quotaUntil:await getQuotaCooldownUntil({now})})` setzen. In `persistSyncFailureForDrain` (Dispatcher) `classification` (via `classifyMarketplaceError`) + `nextRetryAt:0` stempeln.
- [ ] **Run → pass** + `stock-failure-drain.test.js` grün (legacy-safe). Commit `feat(sync): backoff-aware drain (nextRetryAt) + quota alignment`.

### Task 6 — `ebay-trading-api` an shared Breaker delegieren
- [ ] **RED** (Append): `ebay-trading-api` liest den shared Breaker.
- [ ] **GREEN**: In-Process-`let _quotaExhaustedUntil` durch Delegation ersetzen (In-Process-Cache bleibt für synchronen In-Call-Guard `quotaCooldownActiveSync()`), `openEbayQuotaBreaker()` schreibt best-effort ins shared Doc; `ebayQuotaCooldownActive()` async exportieren.
- [ ] **Run → pass** + `ebay-rate-limiter.test.js`. Commit `refactor(ebay): delegate quota breaker to shared module`.

### Task 7 — `sync`-SLO in system-health
- [ ] **RED** `api/system-health-sync-slo.test.js`: `computeSyncSlo({pending,now})` → `ok`/`warn`(≥25 oder >30min)/`critical`(≥100 oder >60min).
- [ ] **GREEN** in `routes/admin.js`: reine `computeSyncSlo` + Aufruf im Handler mit `stock_operation_failures where status=='pending'` (tenant-scoped, limit 500) → JSON-Feld `sync`. Export im Stil der Datei.
- [ ] **Run → pass** + `npm test`. Commit `feat(obs): sync SLO (backlog + oldest age) in system-health`.

### Folge-Slices (eigene Abschnitte hier, später ergänzt — KEINE neuen Dateien)
1. **Real-State-Reconciliation** — `lib/marketplace-drift.js` an 5-min-Hot-Loop hängen (Spec §6); schließt Oversell-Blindheit.
2. **Desired/observed Listing-Ledger** — `marketplaceListings` + `planReconcileAction` + On-Demand-Pre-Flight-Read; Identitäts-Konsolidierung.
3. **Flag-Fold** — `lib/sync-cadence.js`; ~15 Timing-Flags retiren.

> Stock-Ledger, Order-Outbox, Reservierungs-Lifecycle gehören zu **Fundament 1/2** (Geschwister) — hier nur konsumiert, nicht dupliziert.

---

# Teil D — Status & Änderungslog (fortlaufend)

| Datum | Was | Beleg |
|---|---|---|
| 2026-06-16 | **Brandfix deployed:** gescheitertes Mengen-Update beendet kein Angebot mehr → Drain. | Commit `c339184` auf `main`, Cloud Build OK |
| 2026-06-17 | Spec + Plan erstellt. | (frühere 3 Einzeldateien) |
| 2026-06-17 | **Konsolidiert:** 3 verstreute Dateien (Roadmap, Reliability-Core-Spec, Slice-1-Plan) → **dieses eine lebende Dokument**. Als Fundament 5 an die Nordstern-Struktur angedockt; konsumiert Fundament 1 `available`, ausgelöst von Fundament 2, angezeigt über Fundament 4. | dieses Dokument |

**Offene Punkte (nach außen wirkend — brauchen Freigabe):**
- ~55 Angebote sind bis zur Best-Offer-Korrektur (Auto-Ablehnung < Sofortkaufpreis) nicht änderbar; 32 davon tot-mit-Bestand → Neulistung danach. **Kein Repair-Skript als Pflaster** — Teil einer bewussten Recovery.

**Nächster Schritt:** Slice 1 umsetzen (auf Startsignal) oder in die Vergleichs-/Zusammenführungsrunde mit den Geschwister-Plänen geben.

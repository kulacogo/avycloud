# Kritik / Lücken-Review zu `avycloud-master-plan.md`

> **Zweck:** Unabhängige Bewertung des Master-Plans — was fehlt, bevor AvyCloud public geht.
> **Reviewer:** Claude (Marketplace-Sync/F0-Strang). **Stand:** 2026-06-17.
> **Bezug:** [`avycloud-master-plan.md`](avycloud-master-plan.md). **Dieses Dokument ändert nichts** — am Master-Plan nicht und an Production nicht. Reine Bewertung.
> **Befund in einem Satz:** Der Master-Plan ist im **Kern-Datenmodell** exzellent; die Lücken liegen an den **Rändern** — Ursache des Gründungs-Vorfalls, Laufzeit/Kapazität, Geld, Disaster-Recovery, Security-Breite.

---

## In einfacher Sprache (für die Entscheidung)

Der Master-Plan beschreibt sehr gut, **wie die Daten korrekt bleiben** (Bestand, Aufträge, Datenblätter, Sync). Aber fünf Dinge, die für ein **öffentliches Produkt mit zahlenden Firmen** wichtig sind, fehlen oder sind nur geparkt:

1. **Der eigentliche Grund für den 66-Angebote-Vorfall ist nicht repariert** — nur das Symptom. Er kann in neuer Form wiederkommen.
2. **Die Technik-Last (Server-Kapazität)** kommt nicht vor — obwohl genau die schon mal die ganze App lahmgelegt hat.
3. **Buchhalterische Korrektheit** (stimmen Rechnungen/Erstattungen mit den echten Auszahlungen?) fehlt.
4. **Kein Notfall-Plan**, falls eine Datenumstellung schiefgeht (Backup/Zurückrollen).
5. **Sicherheit** ist nur „Kunden sauber trennen" — für public braucht es mehr.

Keine dieser Lücken ist im Herzstück — sie sind am Rand. Aber am Rand bricht man sich beim Launch das Genick.

---

## Die Lücken im Detail (priorisiert)

### 1 — Die *Ursache* des Gründungs-Vorfalls hat kein Fundament  ⚠️ kritisch

**Was fehlt:** Der Master-Plan stoppt das **Symptom** (F0: kein gescheitertes Update beendet je ein Listing; `listing_config`-Fehler werden klassifiziert + deferred). Aber **niemand besitzt die Ursache:** Der Repricer senkt den eBay-Sofortkaufpreis (650 → 455 €), **ohne** die Best-Offer-Auto-Ablehnungsschwelle anzupassen. Liegt die Auto-Ablehnung dann ≥ Sofortkaufpreis, scheitert **jede** Änderung am Angebot. Unser Code **liest/schreibt `BestOfferDetails` nirgends**.

**Warum es zählt:** Der Vorfall **kann wiederkehren** — nur anders: vorher „Angebot getötet", jetzt „Angebot hängt dauerhaft un-synchronisierbar fest" und wandert in den Backlog. Der Master-Plan parkt die ~55 betroffenen Angebote als **externen Blocker „auf Freigabe"** (Teil H) und markiert **Pricing als „stabil"** (Teil B.3) — obwohl der Preis-Push genau der **Auslöser** ist.

**Belege (Code):** `syncPriceToAllChannels` (`stock-sync-dispatcher.js:503`) pusht nur `startPrice`; Repricer `content-enricher.js:152` (`sweet-spot`), Auto-Push bei jedem Save `routes/products.js:1960`; `buildReviseItemRequestXml` (`ebay-trading-api.js:704`) sendet **kein** Best-Offer-Feld; repo-weit 0 Treffer für `BestOfferDetails`.

**Wo es hingehört / wie schließen:** In **F0** (Preis-Push **ist** eine Marktplatz-Mutation). Zwei Bausteine: (a) **Präventiv** — der Preis-Push darf den Sofortkaufpreis nie unter die bekannte Auto-Ablehnung senken (oder passt sie im selben Call an); (b) **Reparativ** — `BestOfferDetails` lesen (in `marketplaceListings.observed` aufnehmen) und als `diff` behandeln, damit „Auto-Ablehnung ≥ BIN" **vor** dem Push erkannt wird statt als Fehler danach.

### 2 — Laufzeit / Kapazität fehlt komplett  ⚠️ hoch

**Was fehlt:** Der Plan dreht sich zu 100 % um **Daten-Korrektheit**, zu 0 % um die **Laufzeit**. Der Ausfall vom 12.06. („integrations massively broken") kam aber von der Laufzeit: **`containerConcurrency=1` + SSE `/api/events` pinnt je Verbindung eine Instanz für 600 s** → der 20er-Pool saturiert → kollaterale 504s. Zusätzlich: beim **Multi-Tenant-Fan-out** vervielfacht sich das eBay/Kaufland-**API-Call-Volumen** (6 Cron-Jobs × Tenants × 5-min-Hot-Loop × Per-Listing-Reads) — und der Dead-Listing-Loop zeigte, dass 14 Produkte schon 637 verschwendete Calls/Tag erzeugen können.

**Warum es zählt:** „Zuverlässig für fremde Kunden, jeden Tag" ist eine **Kapazitäts**-Aussage, nicht nur eine Daten-Aussage. Der Master-Plan deckt sie nicht ab; „CI/CD nicht angefasst" (Teil B.3) schließt diese Dimension implizit aus.

**Belege:** Memory-Incident 2026-06-12 (concurrency=1 + SSE-Pinning); F0-Reconciliation-Hot-Loop (5 min) + Per-Listing-GetItem; `runForEachBackgroundJobTenant`-Fan-out (`index.js:347–588`).

**Wo es hingehört / wie schließen:** Neuer **Cross-Cutting-Punkt „Laufzeit & Kapazität"**: Cloud-Run-Concurrency/SSE-Strategie (z. B. SSE entkoppeln oder Concurrency > 1 mit korrektem Locking), und ein **globales API-Call-Budget je Kanal × Mandant** (Token-Bucket) als Geschwister zum Quota-Breaker.

### 3 — Finanz-Korrektheit für ein echtes Unternehmen  ⚠️ hoch

**Was fehlt:** F5 garantiert „genau 1 Rechnung je Versand" und „1 Korrektur-Gutschrift je Erstattung" — **operativ**. Es fehlt die **buchhalterische Wahrheit:** Abgleich von Rechnungen/Erstattungen gegen die **echten Marktplatz-Auszahlungen + Bank** (SevDesk). Und die aus dem Rechnungs-Duplikat-Vorfall (31.05.) **noch offenen** Steuerberater-Punkte (fehlende Rechnung Nr. 12, Storno 47 = 0 €, 55 Refund-Stornos) tauchen nirgends als „zu schließen" auf.

**Warum es zählt:** Für „public mit zahlenden Firmen" ist Finanz-Konsistenz Pflicht (Steuer/Audit). „1 Rechnung je Versand" verhindert Duplikate, garantiert aber keine *richtigen* Beträge/Stornos.

**Belege:** `invoice-engine.js`, `audit-invoice-duplicates.js`, `ebay-finances.js` (Payout-Modell aus Memory); offene Steuerberater-Punkte im Invoice-Incident.

**Wo es hingehört / wie schließen:** In **F5** eine **Finanz-Reconciliation-Invariante** ergänzen: Summe der erzeugten Belege ↔ Marktplatz-Payout ↔ Bank, Drift gemeldet (nicht still); plus ein Aufräum-/Backfill-Schritt für die offenen Storno-/Gutschrift-Altlasten.

### 4 — Migrations-Rollback & Disaster Recovery  ⚠️ mittel-hoch

**Was fehlt:** Die Strangler-Migration hat saubere **Vorwärts**-Gates („0 Shadow-Diffs → umschalten"). Aber **kein Rollback-Runbook**, falls nach `STOCK_LEDGER=true` in Production doch Diffs auftauchen. Und generell **keine Backup-/Point-in-Time-Recovery-Strategie** für Firestore.

**Warum es zählt:** Eine Bestands-*Wahrheits*-Migration auf Live-Daten zahlender Kunden ohne definiertes Zurückrollen und ohne Backups ist ein vermeidbares Existenzrisiko.

**Belege:** Master-Plan Teil C (nur Vorwärts-Cutover); kein DR-Abschnitt im gesamten Plan.

**Wo es hingehört / wie schließen:** Pro Cutover-Schritt (Teil C) ein **Rollback-Pfad** (Flag zurück + Projektions-Reparatur per `adjust`), plus ein Cross-Cutting-Punkt **„Backups/DR"** (Firestore-Export-Schedule, PITR, getesteter Restore).

### 5 — Sicherheit ist auf Tenant-Isolation verengt  ⚠️ mittel

**Was fehlt:** F4 deckt Mandanten-Trennung + `firestore.rules` ab (gut). „Public" braucht mehr: **per-Mandant-Marktplatz-Credentials** (Speicherung/Verschlüsselung/Rotation), **Abuse-/Rate-Limiting**, **DSGVO-Löschung/-Export**. Auth ist „stabil, nicht anfassen" (Teil B.3) — aber Public-Onboarding (Einladungen/SSO) und das Rate-Limiting berühren Auth fast zwangsläufig.

**Warum es zählt:** Der IPv6-429-Vorfall (25.05.) legte über fehlerhaftes Rate-Limiting die **ganze** App lahm — Rate-Limiting ist also nicht „stabil zum Ignorieren". Credentials-Handling und GDPR sind für B2B-SaaS harte Anforderungen.

**Belege:** Memory-Incident 2026-05-25 (express-rate-limit + `trust proxy`); `lib/auth.js`/`lib/rbac.js`; `firebase.json` ohne `firestore.rules` (auch in F4 als Lücke notiert); per-Tenant-Secrets nur am Rande in der UX/SaaS-Spec.

**Wo es hingehört / wie schließen:** **F4** um „Security-Breite" erweitern: Secrets-Modell (per Tenant, verschlüsselt, Rotation), gehärtetes Rate-Limiting (mit `trust proxy`), DSGVO-Export/-Delete-Pfad.

---

## Kleinere Lücken (erwähnenswert, nicht kritisch)

- **Launch-Gates sind definiert, aber nicht *erzwungen*.** Teil D sagt „in CI/CD verankert" — aber nicht *welcher* Check welchen Deploy blockt. Ohne Verdrahtung sind die Gates ein Wunschzettel.
- **Kein Staging-/E2E-Sandbox-Konzept** (eBay/Kaufland-Sandbox-Contract-Tests) — nur Unit/Integration. Vor Launch riskant.
- **Webhook-Sicherheit/Idempotenz** (F5 nennt Webhooks als Primärpfad) — Signatur-Verifikation + Replay-Schutz nicht spezifiziert.
- **Bulk-Publish bei Onboarding** — wenn eine Firma mit 1000 Produkten startet: Rate-Limits/Fehlerbehandlung des Massen-Publish (teilweise F0/F3, aber nicht als Skalierungsfall benannt).

---

## Was stark ist (fairerweise)

- **Vollständigkeits-Matrix (Teil G):** echter Beweis, dass kein Subsystem vergessen wurde — vorbildlich.
- **F5-Fund:** Fulfillment/Finance war in allen drei Quell-Plänen weg; der Master-Plan hat die Lücke selbst entdeckt.
- **Korrigierte Reihenfolge:** F1 (Ledger) vor F0-Real-State, weil F0 `availableToSell` aus F1 braucht — richtig erkannt.
- **„Eine Wahrheit pro Sache" + `warehouseEvents`-Korrektur** (statt des nicht-existenten `stock_movements`): saubere Datendisziplin.

---

## Empfehlung

Wenn nur **eines** geschlossen wird: **Lücke 1.** Sie ist die Ursache des Vorfalls, der diese ganze Initiative ausgelöst hat, und sie ist aktuell nur „extern, auf Freigabe" geparkt statt **gebaut** — d. h. das System kann denselben Schaden in neuer Form erneut erzeugen.

Reihenfolge-Vorschlag zum Einarbeiten in den Master-Plan (durch dessen Autor, nicht durch dieses Dokument): **1 → 2 → 4 → 3 → 5**, weil 1 + 2 unmittelbare Wiederholungs-/Ausfallrisiken sind, 4 das Migrationsrisiko absichert, und 3 + 5 vor dem öffentlichen Launch (zahlende Firmen) stehen müssen.

---

### Änderungslog
- 2026-06-17: Review erstellt. Keine Änderung an `avycloud-master-plan.md` oder Production.

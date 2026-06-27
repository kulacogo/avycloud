# Kritik zu `avycloud-master-plan.md` (Claude-Strang)

> **Was das ist:** Mein kritischer Review des Master-Plans — was meiner Meinung nach **fehlt**.
> **Was das NICHT ist:** keine Änderung am Master-Plan. Der bleibt unangetastet. Dies ist ein
> paralleles Begleitdokument zum Reinmergen oder Verwerfen — du entscheidest.
> **Stand:** 2026-06-17 · Bezieht sich auf `avycloud-master-plan.md` (Fundamente F0–F5, Teil A–I).
> **Hinweis:** Andere Stränge haben eigene Kritik-/Review-Dateien (`avycloud-master-plan-kritik.md`,
> `avycloud-master-plan-review.md`) — die fasse ich nicht an. Dies hier ist mein Strang.

---

## Kurzfassung (für dich, ohne Technik)

Der Master-Plan ist als **Maschinenraum stark**: Bestand, Sync, Aufträge, Identify, Versand/Finanzen
sind sauber durchdacht. Die Lücken liegen fast alle auf **zwei Ebenen, die er nicht abdeckt:**

1. **„Aus einer App ein öffentliches Abo-Produkt machen."** Abrechnung der Mandanten, DSGVO,
   Zugangsdaten-Sicherheit, Kostenkontrolle, Backups — das, was nötig ist, sobald **fremde, zahlende
   Kunden** drauf sind.
2. **„Betrieb & Wiederherstellung."** Skalierung auf viele Mandanten, der **heute schon kaputte
   Bestand**, ein echter End-to-End-Beweis statt nur Unit-Tests, und ein Notfall-Drehbuch.

Mit anderen Worten: Der Plan baut das Auto gut. Er sagt aber (noch) nicht, **wie man Tickets verkauft,
das Auto versichert, tankt und repariert, wenn es liegen bleibt.**

---

## A — Launch-blockierend (fehlt; ohne das kein öffentliches Abo)

### A1. Abrechnung von AvyCloud selbst — fehlt komplett
- **Was fehlt:** Wie zahlen die Mandanten *AvyCloud*? Tarife/Pläne, Zahlungsanbieter (z. B. Stripe),
  Testphase, nutzungsabhängige Abrechnung, Mahnwesen, Sperren/Downgrade bei Nichtzahlung.
- **Warum wichtig:** Das ist das „Abo-Modell" selbst. F5 deckt nur die Finanzen *der Händler gegenüber
  deren Kunden* ab (SevDesk-Rechnungen), **nicht** AvyCloud→Mandant.
- **Wo es hingehört:** neues Fundament (Vorschlag **F6 — Billing & Subscription**) oder in F4.
- **Abnahme-Gate-Vorschlag:** kein Mandant ohne gültigen Abo-Status aktiv; Zahlungsausfall → definierter
  Lifecycle (Warnung → Read-only → Sperre), nie stiller Datenverlust.

### A2. DSGVO ist beim Merge verloren gegangen
- **Was fehlt:** Daten-**Export** und **Löschung** pro Mandant + Tenant-Lifecycle (sperren/löschen,
  Aufbewahrungsfristen).
- **Beleg:** Die ursprüngliche Reliability-Roadmap hatte das unter „Mandantenfähigkeit" ausdrücklich
  („DSGVO-Export/-Löschung", „Tenant-Lifecycle: anlegen/sperren/löschen"). Im Master-Plan ist **F4**
  auf Isolation + Provisioning + Cockpit eingedampft — **diese Punkte sind rausgefallen** (Regression
  gegenüber der gemergten Quelle).
- **Warum wichtig:** Für ein öffentliches EU-Produkt rechtlich nicht optional.
- **Wo es hingehört:** F4 erweitern (Tenant-Lifecycle + DSGVO) oder in F6.

### A3. Sicherheit der Mandanten-Zugangsdaten ist nur halb spezifiziert
- **Was fehlt:** **Wie** werden die OAuth-Tokens/Secrets jedes Mandanten (eBay, Kaufland, SendCloud,
  SevDesk) gelagert? Verschlüsselung at-rest, Rotation, Widerruf, getrennte Secret-Scopes je Mandant,
  Umgang mit ablaufenden/zurückgezogenen Tokens.
- **Beleg:** F4 nennt „Integrationen … beim Provisioning" und `IntegrationWizard`, aber nicht das
  Sicherheits-/Geheimnis-Modell.
- **Warum wichtig:** Du hältst fremde Marktplatz-Konten. Ein Leck = fremde Shops kompromittiert.
- **Wo es hingehört:** F4 (Tenant-Sicherheit) oder Cross-Cutting + neues Sicherheits-Kapitel.

### A4. Keine Kosten-/Limit-Kontrolle pro Mandant
- **Was fehlt:** Pro-Mandant-Budgets/Quoten für die **teuren** Pfade (Gemini-Identify/Chat/Optimieren,
  SerpAPI/BrightData). Drosselung, Fair-Use, Abuse-Schutz, Alarm bei Budget-Überschreitung.
- **Beleg:** Der Plan *trackt* Calls (Observability, `external_api_calls`), **erzwingt** aber keine
  Grenzen.
- **Warum wichtig:** Bei N zahlenden Mandanten frisst ein Power-User oder ein Fehler-Loop die Marge.
  Unit-Economics eines KI-Produkts hängen daran.
- **Wo es hingehört:** Cross-Cutting + F6 (Tarif-Limits) + F0/F3 (Durchsetzung).

### A5. Backups / Disaster-Recovery — kommen nicht vor
- **Was fehlt:** Firestore-Backups, Point-in-Time-Recovery, dokumentierte + geübte Restore-Prozedur,
  RPO/RTO-Ziele.
- **Warum wichtig:** Fremde Bestands-, Auftrags- und Finanzdaten ohne Backup = existenzbedrohend beim
  ersten Datenunfall (fehlerhafte Migration, versehentliches Löschen, Korruption).
- **Wo es hingehört:** Cross-Cutting + Launch-Gate („Restore in Staging nachgewiesen").

---

## B — Architektur- & Betriebslücken

### B1. Hintergrund-Jobs skalieren so nicht auf viele Mandanten
- **Was fehlt:** Die 6 Cron-Jobs laufen per `runForEachBackgroundJobTenant` (Schleife in einer
  Instanz). Das ist genau die Falle aus dem letzten Incident (`concurrency=1`, eine Instanz erstickt
  unter Last). Bei 50 Mandanten × 6 Jobs brauchst du eine **echte Job-Queue mit horizontal
  skalierenden Workern** (Cloud Tasks/Pub-Sub o. ä.), nicht einen Fan-out-Loop.
- **Warum wichtig:** Skalierungs- und Stabilitätsrisiko, das mit jedem neuen Mandanten wächst.
- **Wo es hingehört:** F0/F5 (Queue-Architektur) + Cross-Cutting (Cloud-Run-Concurrency/SSE-Problem
  aus dem Incident explizit adressieren).

### B2. Der HEUTE kaputte Bestand wird nicht korrigiert — dein eigentliches Feuer
- **Was fehlt:** F1 baut das Lagerbuch sauber **vorwärts**, aber die **Eröffnungsbuchungen kommen aus
  `warehouseBins`** — und die sind nach dem BIN-Verlust-Vorfall teils falsch. Ohne einen expliziten
  Schritt „physischen Ist-Bestand abgleichen/korrigieren, bevor er zur Eröffnung wird" bleiben die
  heute fälschlich auf 0 stehenden Artikel **auch nachher falsch**.
- **Warum wichtig:** Das ist der ursprüngliche PRIO-1. Der Plan setzt korrekten Ist-Bestand
  stillschweigend voraus, statt ihn herzustellen.
- **Wo es hingehört:** F1, Migrations-Phase „Eröffnungsbuchungen" — davor/dabei ein
  Reconciliation-/Korrektur-Schritt (read-only Audit → bestätigte Korrektur als `adjust`-Buchung).

### B3. Die Launch-Gates sind behauptet, nicht gemessen
- **Was fehlt:** „0 Überverkäufe beweisbar" stützt sich nur auf **Unit-Invarianten**. Es fehlt ein
  **End-to-End-Test der ganzen Kette** (Foto → … → Abgleich) und ein **Last-/Staging-Durchlauf**.
- **Warum wichtig:** „Beweisbar" ist ohne echten Durchlauf unter Last ein Wort, keine Messung.
- **Wo es hingehört:** Teil D (Launch-Abnahme) + eigenes Test-/Staging-Kapitel; Gate: „E2E-Smoke grün +
  Lasttest gegen SLOs bestanden".

### B4. Kein Betriebs-Drehbuch (Incident-Response)
- **Was fehlt:** Was passiert, **wenn um 3 Uhr eine SLO bricht**? Wer wird alarmiert, welche Schritte,
  welches Fehlerbudget, welche Eskalation. Es gibt 3 SLO-Zahlen + Slack-Alerts, aber kein Runbook.
- **Warum wichtig:** Ein zahlendes Produkt braucht definierte Reaktion, nicht nur Erkennung.
- **Wo es hingehört:** Teil D/F4 (Operator-Cockpit) + Runbook-Anhang.

---

## C — Kleinere Punkte (sollte rein, nicht launch-blockierend)

- **C1. Mehrsprachigkeit (DE/EN) + Barrierefreiheit** als Teil der „state of the art UX". Die
  Landingpage gibt's EN/DE; ein i18n-/a11y-Konzept fürs Produkt-UI fehlt in F4.
- **C2. Migration der bestehenden `default`-Daten** ins echte Mandanten-Modell ist nur angedeutet
  (F4 „tenant-db-Migration kritischer Routen") — der Daten-Umzug `default` → echter Mandant fehlt als
  Schritt.
- **C3. `warehouse_movements` → `warehouseEvents`-Migration:** Idempotenz/keine Doppelzählung im Detail
  offen (Risiko: Retouren/Reconcile-Bewegungen doppelt gebucht). Braucht deterministische
  Idempotenz-Keys auch für die migrierten Altbewegungen.

---

## D — Was ausdrücklich gut abgedeckt ist (Fairness)

Damit die Kritik einordbar ist — das ist **stark** und sollte so bleiben:
- F0 Sync (desired/observed, Klassifizierer nie destruktiv, durable Queue, Real-State-Reconcile).
- F1 Lagerbuch + harte Invarianten (kein stilles Nullen, Symmetrie, Idempotenz).
- F2 symmetrische OMS-Logik (`cancelled→reverse`, `returned→return_restock`).
- F3/F3b ein Tor + Feld-Register (Dedup, Platzhalter-Block, N-Invariante).
- F5 Fulfillment/Finance + die **Vollständigkeits-Matrix** (Teil G) — die genau gegen „etwas
  vergessen" gebaut ist.
- Die diszipliniert korrekte Reihenfolge (F1 vor F0-Real-State) und die Anti-Wildwuchs-Konsolidierung
  (Teil F).

Die Lücken sind also **nicht** im Maschinenraum, sondern an der Produkt-/Betriebs-Hülle drumherum.

---

## E — Vorschlag zur Einordnung (falls reingemergt wird)

| Lücke | Schwere | Vorschlag: wohin im Master-Plan |
|---|---|---|
| A1 Abo/Billing | Launch-Blocker | **Neu: F6 — Billing & Subscription** |
| A2 DSGVO/Tenant-Lifecycle | Launch-Blocker (EU) | F4 erweitern (oder F6) |
| A3 Credential-Sicherheit | Launch-Blocker | F4 (Tenant-Sicherheit) |
| A4 Kosten/Limits pro Mandant | Launch-Blocker (Marge) | Cross-Cutting + F6 + Durchsetzung F0/F3 |
| A5 Backups/DR | Launch-Blocker | Cross-Cutting + Teil D Gate |
| B1 Job-Skalierung | Hoch | F0/F5 Queue + Cross-Cutting |
| B2 Ist-Bestand korrigieren | Hoch (PRIO-1) | F1 Migrations-Phase |
| B3 E2E/Last-Beweis | Hoch | Teil D + Test-Kapitel |
| B4 Incident-Runbook | Mittel | Teil D / F4 |
| C1–C3 | Niedrig–Mittel | F4 / F1 |

---

> **Hinweis:** Reine Planungs-/Review-Notiz. Keine Production-Änderung. `avycloud-master-plan.md`
> wurde **nicht** verändert.

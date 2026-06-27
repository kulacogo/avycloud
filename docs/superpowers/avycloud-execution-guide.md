# AvyCloud — Execution-Guide für den Coding-Agenten (Track 1)

> **Zweck:** Die *ausführungsspezifische* Schicht, damit ein KI-Coding-Agent (Claude Code o. ä.) den Master-Plan **fehlerarm und sicher** gegen ein **Live-System mit echtem Kunden** umsetzt — und damit ein **Nicht-Entwickler** zuverlässig abnehmen kann, dass „fertig" wirklich fertig ist.
> **Diese Datei ersetzt nichts.** Sie sitzt auf `AGENTS.md` (Einstieg + 13 Nicht-Verhandelbare + Pre/Post-Flight) und `CLAUDE.md` (harte Invarianten) auf. Bei Konflikt gewinnt CLAUDE.md.
> **Bezug:** [`avycloud-master-plan.md`](avycloud-master-plan.md) Teil K (Track 1, WP0–WP5).
> **Stand:** 2026-06-17 · reine Anweisung, kein Code.

---

## 0. Pflicht-Lesereihenfolge des Agenten (vor JEDEM Arbeitspaket)
1. `AGENTS.md` → `CLAUDE.md` → die im Paket genannten Stellen.
2. Diese Datei (Abschnitte 1–4).
3. Den konkreten WP-Abschnitt im Master-Plan Teil K.1.
> Wenn eine dieser Dateien nicht gelesen wurde: **nicht anfangen.**

---

## 1. Grundlegende Infos (Kontext in Kurzform — das musst du wissen)
- **Ein Produkt, EIN Kunde:** TrendOcean ist der **einzige** Kunde und liegt heute auf `tenantId = "default"`. Es gibt keinen zweiten Mandanten. Jede Änderung trifft sofort einen echten, zahlenden Betrieb.
- **Production ist heilig:** kein Breaking Change, kein Datenverlust, kein Downtime (CLAUDE.md, goldene Regel).
- **Infra-Fakten (Live-Audit 2026-06-17, Projekt `avycloud`/`europe-west3`):** Cloud Run `product-hub-backend` läuft mit **concurrency = 1**, Timeout 600 s, max 20 Instanzen → das System **sättigt bei ~20 Langverbindungen**. Firestore: **PITR EIN**, 30-Tage-Backup, **delete-protection war AUS** (in WP0 einschalten). **0 Monitoring-Alerts** (in WP0 erste schärfen). **Nur EIN Projekt** → **kein Staging** → Validierung = read-only Prod-Shadow.
- **Aktiver Umfang:** **nur F0–F2 = Track 1**. F3–F8 sind dokumentierte Referenz, **nicht jetzt umsetzen**.
- **Auslieferungs-Blöcke:** Block 1 = WP0 + WP1 (kein Cutover) → 1 Woche stabil → erst dann Block 2 = WP3 (+WP2) → dann Block 3 = WP4 + WP5.

---

## 2. Verhaltensanweisung für den Agenten (die Ausführungs-Regeln)
Zusätzlich zu den 13 Nicht-Verhandelbaren aus `AGENTS.md`/`CLAUDE.md`:

1. **Ein Branch / ein PR pro Arbeitspaket. Niemals direkt auf `main`.** Niemals zwei WPs in einem Branch mischen.
2. **Tests zuerst (TDD).** Schreibe den Test, lass ihn **rot** laufen, **zeig dem Owner das ROT**, dann erst grün machen. Kein Test darf still übersprungen werden (`it.skip`, `.only`, auskommentiert = verboten).
3. **Im Scope bleiben.** Nur die im WP genannten Dateien. Keine „while I'm here"-Fixes, keine Formatierungs-Sweeps, keine Umbenennungen.
4. **Red-Zone-Dateien = STOPP + fragen** (aus `.claude/rules/production-safety.md`): `Dockerfile`, `cloudbuild.yaml`, `firebase.json`, `.firebaserc`, `.github/workflows/*`, `backend/lib/auth.js`, `backend/lib/rbac.js`, `backend/index.js` (require-Pfade), `.env*`.
5. **Durable-first:** Jede bestandswirksame Mutation schreibt **zuerst** ein dauerhaftes Work-Item, **dann** `emitSyncEvent(...)`. Der In-Process-Bus ist nur Beschleuniger, nie die einzige Spur (siehe Master-Plan B.1).
6. **Kein destruktiver Marktplatz-Pfad:** Keine Fehlerbehandlung darf je ein Listing beenden/löschen. Fehler → klassifizieren → Queue → Retry. (Brandfix `c339184` ist Gesetz.)
7. **Code-Anker verifizieren, nicht glauben:** Zeilennummern im Plan sind ein Stand von 2026-06-17. Vor dem Editieren prüfen, ob die Stelle noch stimmt. Wenn nicht → melden, nicht raten.
8. **Flags statt Mut:** Verhaltensänderungen an heißen Pfaden (v. a. `stock-sync-dispatcher.js`) hinter ein ENV-Flag (default aus → Shadow → an). Jede neue ENV-Var in `docs/kb/03-development/feature-flags.md` dokumentieren.
9. **Commit nur auf ausdrückliches „commit"/„merge" des Owners.** Nie selbst mergen, nie force-pushen.
10. **Bei Unsicherheit: STOPP und sag es offen.** „Hier fehlt mir X, ich kann das nicht sicher umsetzen." Keine stillen Annahmen.

---

## 3. Hand-off-Steckbrief pro Arbeitspaket (Vorlage)
> Der Owner gibt dem Agenten **pro WP** diesen Rahmen. Ein WP = ein Branch = ein PR.

```
ARBEITSPAKET: <WPx — Titel aus Master-Plan Teil K.1>
ZIEL (1 Satz): <…>
ERLAUBTE DATEIEN: <Liste; alles andere ist tabu>
VERBOTEN: Red-Zone-Dateien (siehe Guide §2.4); Feld-Rename/-Löschung; Route-Änderung
VORGEHEN:
  1. Lies AGENTS.md + CLAUDE.md + den WP-Abschnitt.
  2. Schreib den/die Test(s) ZUERST, zeig mir ROT.
  3. Implementiere minimal bis grün. Zeig mir den Test-Output.
  4. Zeig mir `git diff --stat` und `git diff`.
  5. Warte auf mein „commit".
FLAG/ROLLBACK: <ENV-Flag-Name + wie man zurückschaltet>
FERTIG WENN: <DoD aus dem WP, messbar>
```

---

## 4. Owner-Abnahme-Checkliste (Klartext — für Nicht-Entwickler)
> Bevor du „commit" sagst, geh diese Punkte mit dem Agenten durch. Du brauchst dafür **keine** Programmierkenntnisse — du lässt dir Dinge **zeigen**.

1. **„Zeig mir `git diff --stat`."** → Stehen dort **nur** die Dateien aus dem Steckbrief? Taucht eine Red-Zone-Datei auf (`auth.js`, `rbac.js`, `firebase.json`, `Dockerfile`, `cloudbuild.yaml`, `.github/...`)? → **Wenn ja: Stopp, nicht mergen, nachfragen.**
2. **„Lass den neuen Test einzeln laufen und zeig mir die Ausgabe."** → Steht da grün/`passed`? Wurde **nichts** übersprungen (`skipped`, `todo`, `.only`)? Lauf zur Sicherheit `cd backend && npm test` komplett — alles grün?
3. **„Zeig mir, dass es vorher ROT war."** → Gab es den Test, *bevor* der Code geändert wurde, und ist er ohne den neuen Code fehlgeschlagen? (Sonst testet er nichts.)
4. **Verhalten sichtbar prüfen:** Den im WP genannten Dashboard-/Sichtbarkeits-Check klicken (z. B. „system-health zeigt die `sync`-Sektion", „Alarm feuert testweise"). Stimmt das, was du siehst, mit „Fertig wenn" überein?
5. **Flag da?** Gibt es den Rückschalter (ENV-Flag), und weißt du, **wie** du ihn zurückstellst? (Lass es dir in einem Satz erklären.)
6. **Erst dann:** „commit". Danach **eine Woche beobachten**, bevor das nächste riskante WP startet.

> Faustregel: Wenn der Agent etwas **nicht zeigen** kann oder die Erklärung dich nicht überzeugt → **nicht mergen.** Lieber fragen.

---

## 5. Migrations-Sicherheit (gilt für WP3 — der einzige echte Cutover)
**Vor** dem Umschalten von `STOCK_LEDGER`:
1. `delete-protection` der Firestore-DB ist **AN** (aus WP0).
2. Frischer Export gemacht **und** den **PITR-Zeitstempel notiert** (das ist dein Rücksprung-Punkt).
3. Den Restore **einmal testweise geübt** (auf eine Test-DB), damit du weißt, dass er funktioniert — *bevor* du ihn brauchst.
4. **Abbruch-Kriterium schriftlich:** „Mehr als <Schwelle> unerklärte Abweichungen im Shadow-Report → Stopp, Flag zurück, im Notfall Restore auf Zeitstempel T."
5. Shadow lief **mind. 7 Tage und ≥ 1 vollständigen Auftrags-Zyklus** mit grünem `reconcileLedger`-Report (0 unerklärte Diffs).

---

## 6. Notfall-Blatt (eine Seite — was tun, wenn es brennt)
> Auch nachts/allein befolgbar. Kein On-Call-Apparat nötig.

1. **Ruhig bleiben, nichts „schnell fixen".**
2. **Verdächtige Flags auf `false`** (Rückschalter aus dem jeweiligen WP, z. B. `SYNC_DURABLE_DRAIN`, `STOCK_LEDGER`).
3. **3 Checks:** `system-health` (sync-Sektion grün?) · Bestand eines bekannten Top-SKUs stimmt? · letzte 3 Aufträge korrekt?
4. **Wenn weiter kaputt:** Cloud-Run-Revision auf die letzte gute zurückrollen — Anleitung in [`docs/kb/04-deployment/rollback.md`](../kb/04-deployment/rollback.md).
5. **Wenn Daten betroffen:** Restore auf den notierten PITR-Zeitstempel (siehe §5).
6. **TrendOcean kurz informieren**, falls sichtbar betroffen.
7. **Bus-Faktor:** Zugangsdaten/Recovery-Codes (GCP, Firebase, eBay/Kaufland) an einem **zweiten sicheren Ort** hinterlegt halten — du bist aktuell alleiniger Owner.

---

## 7. Kunden-Choreografie (TrendOcean) — bei WP3 und WP5
- **Ruhiges Zeitfenster** wählen (niedrigste Order-Last).
- **Kurze Vorwarnung** an TrendOcean („heute Abend kurzes Wartungsfenster, Bestände werden umgestellt").
- **Nach dem Cutover gezielt Stichproben** an echten Bestseller-SKUs: Bestand stimmt? Letzte 3 Aufträge korrekt verbucht? eBay/Kaufland-Sync grün?
- **Bei Auffälligkeit sofort** Flag zurück (§6). „Technisch reversibel" ist erst dann „der Kunde merkt nichts".

---

## 8. Erfolgsmaß, das wirklich zählt
Track 1 ist **nicht** „erfolgreich, weil ein Dashboard grün ist", sondern wenn die **Handarbeit sinkt**: Vergleiche die in WP0 eingefrorene Baseline („Stunden/Woche manuelles Eingreifen", „Anzahl Bestands-/Listing-Korrekturen pro Woche") mit dem Wert 2–4 Wochen nach Block 1. Fällt diese Zahl real, hat Track 1 sein Versprechen gehalten.

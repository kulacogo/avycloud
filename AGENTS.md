# AGENTS.md — AvyCloud Coding-Agent Entry Point

> **PFLICHTLEKTÜRE für jeden Coding-Agent (Claude, Cursor, GPT, etc.) bei Session-Start.**
> Diese Datei ist der oberste Einstieg. Sie ersetzt nichts — sie verweist auf das, was du lesen MUSST, bevor du eine einzige Datei änderst.

## Reading Order (bindend, in dieser Reihenfolge)

1. **Diese Datei.**
2. [docs/kb/00-INDEX.md](docs/kb/00-INDEX.md) — Master-Index der Knowledge Base.
3. [docs/kb/13-personas/for-coding-agents.md](docs/kb/13-personas/for-coding-agents.md) — Was du als Agent wissen musst, bevor du arbeitest.
4. [CLAUDE.md](CLAUDE.md) — Projekt-Regeln, harte Invarianten, Feature-Flags. **Single Source of Truth für „nicht verhandelbar".**
5. [TASKS.md](TASKS.md) — Aktive Tasks und Bugs. **Quelle für was gerade läuft.**
6. Bei Feature-Arbeit: `docs/kb/06-features/<feature>.md` und ggf. `docs/features/<ID>/spec.md`.
7. **Bei Reliability-/Sync-/Bestand-Arbeit (aktueller Fokus „Track 1"):** [docs/superpowers/avycloud-master-plan.md](docs/superpowers/avycloud-master-plan.md) (Teil K) **und** [docs/superpowers/avycloud-execution-guide.md](docs/superpowers/avycloud-execution-guide.md) — **Pflicht** für Übergabe- und Abnahme-Logik (ein Branch/PR pro Arbeitspaket, Tests zuerst, Commit nur auf OK).

## Die 13 Nicht-Verhandelbaren (Kurzform — Volltext in [CLAUDE.md](CLAUDE.md))

1. Keine bestehende Route ändern ohne explizite Anweisung.
2. Keine Firestore-Felder umbenennen oder löschen — **additive only**.
3. Keine Dependencies entfernen.
4. Keine ENV-Vars umbenennen die in CI/CD referenziert werden.
5. Keine Änderung an `Dockerfile`, `firebase.json`, `cloudbuild.yaml` ohne Anweisung.
6. Keine Änderung an Auth (`backend/lib/auth.js`, `backend/lib/rbac.js`) ohne Anweisung.
7. Alle Produkt-Schreibpfade über `saveProductV2()` ([backend/lib/product-store.js](backend/lib/product-store.js)).
8. Alle neuen Queries und Collections mit `tenantId`.
9. **Retired Middleware ist TABU** — keine alten Middleware-Integrationen reaktivieren, importieren oder per ENV konfigurieren.
10. **Oversell-Verbot**: keine `products_v2.inventory.quantity`-Mutation ohne `saveProductV2()` UND `emitSyncEvent('stock:changed', …)`.
11. **Kein `omsStatus`-Direct-Write** — Order-State-Übergänge AUSSCHLIESSLICH über `transitionOrder()`.
12. **Kein In-Memory-Stock-Lock** in Produktion — `withStockLock()` mit Firestore-Backend ist Pflicht.
13. **Stock Single Writer Invariant** — jede physische Einheit darf während des Order-Lifecycle GENAU EINMAL dekrementiert werden. Volltext in [CLAUDE.md](CLAUDE.md) Punkt 13.
14. **Kein destruktiver Marktplatz-Fehlerpfad** — keine Fehlerbehandlung im Sync darf ein Listing beenden/löschen; Fehler → klassifizieren → durable Queue → Retry. Zementiert Brandfix `c339184`. Volltext in [CLAUDE.md](CLAUDE.md) Punkt 14.

## Pre-Flight Checklist (vor jedem Tool-Call der etwas ändert)

- [ ] Habe ich `CLAUDE.md` und die referenzierten KB-Seiten dieser Session gelesen?
- [ ] Berühre ich eine Datei in einer **Protected Zone** (Auth, Dockerfile, cloudbuild.yaml, firebase.json)? Wenn ja → STOP, frage.
- [ ] Mutiere ich Stock, OMS-Status oder ein Webhook-Handler? Wenn ja → Lese [docs/kb/11-rules-and-invariants/README.md](docs/kb/11-rules-and-invariants/README.md).
- [ ] Schreibe ich neuen Code? Dann auch neuer Test in `backend/__tests__/` oder Frontend-Test.
- [ ] Erstelle ich eine neue Route oder einen neuen View? Dann auch passende KB-Doku in `docs/kb/09-api/` bzw. `docs/kb/05-pages/`.

## Post-Flight Checklist (vor Commit)

- [ ] `cd backend && npm test` grün?
- [ ] `npm run build` grün (für Frontend-Änderungen)?
- [ ] Kein direktes `tx.update(productRef, { 'inventory.quantity': X })` hinzugefügt?
- [ ] Kein direktes `orderRef.update({ omsStatus: ... })` hinzugefügt?
- [ ] Jede neue ENV-Var ist in [docs/kb/03-development/feature-flags.md](docs/kb/03-development/feature-flags.md) dokumentiert?
- [ ] Conventional Commit Message (`feat:`, `fix:`, `refactor:`, etc.)?

## Wer committed, wer merged

- **Coding-Agents** committen NUR wenn der User explizit `commit` oder `merge` sagt.
- **Force-Push auf `main`** ist verboten.
- **Cloud Build** triggert automatisch bei Push auf `main` → Cloud Run Deploy.
- **Firebase Hosting** deployt via GitHub Actions bei Push auf `main`.
- Rollback-Pfad: siehe [docs/kb/04-deployment/rollback.md](docs/kb/04-deployment/rollback.md).

## Wenn du unsicher bist

**Lieber fragen als raten.** Die Goldene Regel aus CLAUDE.md: *Production darf NIEMALS negativ beeinflusst werden.* Kein Breaking Change. Kein Datenverlust. Kein Downtime.

Wenn die Information fehlt, sage es offen: "Hier fehlen mir konkrete Infos zu X, ich kann das nicht sicher implementieren." Triff KEINE stillen Annahmen.

---

**Du hast jetzt diese Datei gelesen. Weiter zu [docs/kb/00-INDEX.md](docs/kb/00-INDEX.md).**

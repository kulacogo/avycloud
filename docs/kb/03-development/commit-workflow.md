---
title: Commit-Workflow
for: [dev, agent, admin]
lastReviewed: 2026-05-18
---

# Commit-Workflow

> Quelle der Wahrheit: [CLAUDE.md](../../../CLAUDE.md) und [AGENTS.md](../../../AGENTS.md).

## Conventional Commits

| Prefix | Wann |
|--------|------|
| `feat:` | Neues Feature, neuer Endpunkt, neuer Worker. |
| `fix:` | Bugfix in bestehendem Verhalten. |
| `refactor:` | Code-Umbau ohne Verhaltensänderung. |
| `chore:` | Build, Dependencies, Tooling. |
| `docs:` | Reine Dokumentations-Änderungen (z. B. KB-Updates). |
| `test:` | Tests hinzufügen oder umstrukturieren. |
| `stock!:` | Sonder-Prefix für Stock-Architektur-Änderungen — Reviewer + Operator MUSS informiert werden (siehe [docs/architecture/stock-single-source-of-truth.md](../../architecture/stock-single-source-of-truth.md) §Kontakt). |

Beispiele:

```
feat: add Stage3 Aspect-Repair backfill for required-only
fix: avoid double-decrement when bookStockOut runs before shipped
refactor: extract gpsr-consensus into lib/cross-reference
chore: bump @google/genai to 1.46.0
docs: document Identify V4 promotion gate in CLAUDE.md
test: cover stock-failure-drain abandoned-after-N-retries path
stock!: enforce single-writer claim in pick-with-order tx
```

## Branch-Strategie

| Branch | Zweck | Merge-Strategie |
|--------|-------|-----------------|
| `main` | Production. Trigger für Frontend- und Backend-Deploys. | Squash oder Merge-Commit, **nie** Force-Push. |
| `feat/<name>`, `fix/<name>`, `refactor/<name>` | Feature-Arbeit. | PR gegen `main`. |
| Sonst | Nach Bedarf. | — |

## Wer mergen darf

| Rolle | Darf committen | Darf PR öffnen | Darf auf `main` mergen |
|-------|----------------|----------------|------------------------|
| **User / Operator** | Ja | Ja | Ja |
| **Developer** | Ja | Ja | Ja (nach Review) |
| **Coding-Agent** | **Nur wenn User explizit `commit` oder `merge` sagt** | Ja | **NIE** (auch nicht bei explizitem Request — Force-Push auf main verboten) |

Quelle: [AGENTS.md](../../../AGENTS.md) §„Wer committed, wer merged":

> Coding-Agents committen NUR wenn der User explizit `commit` oder `merge` sagt. Force-Push auf `main` ist verboten.

## Standard-Workflow

```bash
# 1. Branch
git checkout -b feat/my-thing main

# 2. Code + Test schreiben

# 3. Backend-Tests
cd backend && npm test

# 4. Frontend-Build (bei FE-Änderungen)
cd .. && npm run build

# 5. Commit
git add .
git commit -m "feat: add my-thing"

# 6. Push + PR
git push -u origin HEAD
gh pr create --title "feat: add my-thing" --body "..."
```

## Pre-Flight-Checklist (vor jedem Code-Change)

Aus [AGENTS.md](../../../AGENTS.md):

- [ ] [CLAUDE.md](../../../CLAUDE.md) + relevante KB-Seiten dieser Session gelesen?
- [ ] Berühre ich eine **Protected Zone** (Auth, Dockerfile, cloudbuild.yaml, firebase.json)? Wenn ja → STOP, fragen.
- [ ] Mutiere ich Stock, OMS-Status oder einen Webhook-Handler? Wenn ja → [11-rules-and-invariants/README.md](../11-rules-and-invariants/README.md) lesen.
- [ ] Neuer Code → neuer Test in `backend/__tests__/`?
- [ ] Neue Route / View → KB-Eintrag in `09-api/` bzw. `05-pages/`?

## Post-Flight-Checklist (vor Commit)

- [ ] `cd backend && npm test` grün.
- [ ] `npm run build` grün (bei FE-Änderungen).
- [ ] Kein direktes `tx.update(productRef, { 'inventory.quantity': X })` hinzugefügt.
- [ ] Kein direktes `orderRef.update({ omsStatus: ... })` hinzugefügt.
- [ ] Neue ENV-Var in [feature-flags.md](feature-flags.md) dokumentiert.
- [ ] Conventional-Commit-Message verfasst.

## Verbotenes

- Force-Push auf `main`.
- `git rebase -i` auf veröffentlichten Branches.
- Direct-Writes auf Protected Zones ohne Anweisung: `backend/lib/auth.js`, `backend/lib/rbac.js`, `backend/Dockerfile`, `firebase.json`, `backend/cloudbuild.yaml`, `.github/workflows/firebase-hosting.yml`, `firestore.indexes.json`.
- BaseLinker-Referenzen (Punkt 9 [CLAUDE.md](../../../CLAUDE.md)).
- Skips von Pre-Commit-Hooks (`--no-verify`, `--no-gpg-sign`) ohne explizite User-Anweisung.

## Verweise

- AGENTS-Manifest: [AGENTS.md](../../../AGENTS.md).
- Code-Stil: [code-style.md](code-style.md).
- Test-Workflow: [testing.md](testing.md).
- Rules: [11-rules-and-invariants/README.md](../11-rules-and-invariants/README.md).

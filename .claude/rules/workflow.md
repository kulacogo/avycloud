---
paths:
  - "backend/**"
  - "components/**"
  - "hooks/**"
  - "api/**"
---

# Agent Workflow

## Vor dem Coden
- Feature-Spec lesen wenn vorhanden (`docs/features/<ID>/spec.md`)
- Alle Dateien lesen die geändert werden sollen
- `cd backend && npm test` + `npm run build` — grüne Baseline sicherstellen
- Red/Yellow Zone Dateien → nur mit expliziter Anweisung ändern (siehe production-safety.md)

## Während dem Coden
- Feature-Branch nutzen, nie direkt auf main
- Eine Änderung pro Commit (Conventional Commits)
- Nach jeder signifikanten Änderung Tests laufen lassen
- Im Scope der Aufgabe bleiben — keine "while I'm here" Fixes

## Nach dem Coden
- Alle Tests grün? Frontend baut? Neue Funktion hat Test?
- Keine hardcodierten Secrets? tenantId in allen Queries?

## Wann STOPPEN und fragen
- Red Zone Datei muss geändert werden
- Unsicher ob Änderung sicher ist
- 3+ fehlgeschlagene Versuche
- Scope wächst über Aufgabe hinaus
- Fix erzeugt neues Problem woanders

## Verboten
- Tests löschen oder deaktivieren
- Force-Push
- BaseLinker referenzieren
- Secrets hardcoden
- vi.mock() für CJS Module (require.cache-Patching nutzen)

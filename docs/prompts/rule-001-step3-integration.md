# RULE-001 — Step 3: Integration + QA (Steps 12–14)

> Routing, Audit Log, End-to-End Verifizierung. Letzter Schritt vor Merge.

## Prompt für Claude Code:

```
Lies CLAUDE.md und docs/features/RULE-001-rule-engine/spec.md (Section 6.1 Steps 12-14).

Arbeite auf Branch `feat/rule-001-frontend` und schließe die Integration ab:

## Step 12: Routing + Navigation (falls nicht in Step 2 erledigt)

Prüfe ob folgendes bereits implementiert ist, falls nicht → nachziehen:
- App.tsx: Route /rules → RuleDashboard
- Sidebar.tsx: "Regeln" Nav-Item mit passendem Icon
- Navigation von Sidebar zu /rules funktioniert

## Step 13: Audit Log Integration

Wenn rule CRUD oder execute Aktionen passieren, logge sie im bestehenden Audit-Log System:
- rule.created → wenn eine neue Regel erstellt wird
- rule.updated → wenn eine Regel geändert wird
- rule.deleted → wenn eine Regel gelöscht wird
- rule.executed → wenn eine Regel ausgeführt wird (mit mode + result summary)

Finde das bestehende Audit-Log Pattern (wahrscheinlich in einer Middleware oder einem Helper). Nutze das gleiche Pattern.
WICHTIG: Audit-Log Einträge brauchen tenantId.

## Step 14: Full QA

Führe folgende Checks durch:

1. `cd backend && npm test` — alle Tests grün
2. `npm run build` — Frontend baut fehlerfrei
3. Prüfe dass alle neuen Dateien korrekt importiert sind:
   - rule-engine.js wird von rule-runner.js importiert
   - rule-runner.js wird von server.js gestartet (oder bei Bedarf lazy loaded)
   - routes/rules.js ist in server.js gemounted
   - Alle Frontend-Komponenten sind korrekt importiert in RuleDashboard
4. Prüfe dass KEINE der "Nicht verhandelbar" Regeln verletzt wurde:
   - Keine bestehenden Routes geändert
   - Keine Firestore-Felder umbenannt
   - Keine Dependencies entfernt
   - Alle neuen Collections haben tenantId
   - saveProductV2() für alle Produkt-Schreibvorgänge
   - Kein BaseLinker
5. Prüfe Design-Tokens: grep nach bg-blue, bg-red, bg-green etc. in neuen Dateien → sollte 0 sein

Falls Probleme gefunden: fixen.

Final Commit: `feat(rule-001): integration — audit logging, routing, QA complete`

Dann: Merge alle RULE-001 Commits nach main und push.
```

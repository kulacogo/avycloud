# RULE-001 — Step 2: Frontend (Steps 4–11)

> UI-Komponenten. Setzt den Backend aus Step 1 voraus.

## Prompt für Claude Code:

```
Lies CLAUDE.md, TASKS.md und docs/features/RULE-001-rule-engine/spec.md (komplett, besonders Section 5: UI/UX).

Arbeite auf Branch `feat/rule-001-frontend` (basiert auf feat/rule-001-backend) und implementiere Steps 4–11:

## Step 4: api/client.ts — Rule API Functions

Füge diese Funktionen hinzu:
- listRules(active?: boolean): GET /api/v1/rules
- getRule(ruleId): GET /api/v1/rules/:ruleId
- createRule(data): POST /api/v1/rules
- updateRule(ruleId, data): PUT /api/v1/rules/:ruleId
- deleteRule(ruleId): DELETE /api/v1/rules/:ruleId
- toggleRule(ruleId): PATCH /api/v1/rules/:ruleId/toggle
- executeRule(ruleId, mode, limit?): POST /api/v1/rules/:ruleId/execute
- getJobStatus(jobId): GET /api/v1/rules/jobs/:jobId
- previewRule(ruleId, limit?): GET /api/v1/rules/:ruleId/preview

Folge dem bestehenden Pattern in api/client.ts.

## Step 5: hooks/useRules.ts

Custom Hook mit:
- rules state (loading, error, data)
- CRUD Methoden (create, update, delete, toggle)
- executeRule(ruleId, mode) → startet Job, pollt Status alle 2s bis done/failed
- previewRule(ruleId) → returns matching products

## Step 6: ConditionRow.tsx + ActionRow.tsx

components/rules/ConditionRow.tsx:
- Props: condition, onChange, onRemove
- 3 Dropdowns: Field (aus Spec Section 5.4) → Operator (gefiltert nach Feldtyp) → Value Input
- [×] Remove Button
- Design: bg-app-elevated rounded-lg p-3, flex layout

components/rules/ActionRow.tsx:
- Props: action, onChange, onRemove
- Type Dropdown (5 Types aus Spec Section 5.5) → Field → Value/Params
- adjust_price: zusätzliches Dropdown für mode (percent/absolute)
- replace_text: zwei Inputs (search, replace)
- [×] Remove Button

WICHTIG: Nur Design-Tokens verwenden (bg-app-surface, bg-app-elevated, text-primary, etc.). KEIN raw Tailwind wie bg-blue-500. Sieh dir styles/main.css für verfügbare Tokens an.

## Step 7: RuleForm.tsx

components/rules/RuleForm.tsx:
- Props: rule? (für Edit), onSave, onCancel
- Felder: Name (required), Description (optional), Channel (Alle/eBay/Kaufland)
- Conditions: Dynamic list mit [+ Bedingung hinzufügen], min 1 required
- Actions: Dynamic list mit [+ Aktion hinzufügen], min 1 required
- Live Preview Badge: "{N} Produkte treffen zu" (debounced /preview Call, 500ms delay)
- Footer: [Vorschau] [Speichern] [Abbrechen]
- Validation: Name required, min 1 Condition, min 1 Action

## Step 8: RulePreview.tsx

components/rules/RulePreview.tsx:
- Props: changes[] (from dry-run result)
- Table: Produkt | Feld | Alter Wert → Neuer Wert
- Summary: "{matched} Produkte, {changes} Änderungen"
- Empty: "Keine Änderungen — Regel hat keine Auswirkungen"

## Step 9: RuleTemplates.tsx

components/rules/RuleTemplates.tsx:
- Props: onSelect(template)
- Grid mit 6 Template-Cards (aus Spec Section 5.6):
  1. Preisrundung auf .99
  2. eBay Titel-Prefix
  3. Niedrigbestand markieren
  4. Fehlende Beschreibung
  5. Zustand standardisieren
  6. Mindestpreis-Guard
- Jede Card: Icon + Name + Description
- Click → onSelect mit vorgefüllten conditions + actions
- Design: bg-app-surface border border-app-border rounded-lg

## Step 10: RuleList.tsx

components/rules/RuleList.tsx:
- Table mit Spalten: Name | Bedingungen (count) | Aktionen (count) | Aktiv (toggle) | Letzter Lauf | Betroffen | Actions
- Actions: [▶ Ausführen] [✏ Bearbeiten] [🗑 Löschen]
- Active Toggle → toggleRule()
- Delete → Confirmation Modal → deleteRule()
- Ausführen → Modal mit Dry-Run Option

## Step 11: RuleDashboard.tsx + Routing

components/RuleDashboard.tsx:
- KPI Bar: Aktive Regeln | Letzter Lauf | Produkte betroffen | Regeln gesamt
- RuleList darunter
- Buttons: [+ Neue Regel] → RuleForm Modal, [Vorlagen] → RuleTemplates Modal
- States aus Spec Section 5.8 (empty, loading, etc.)

App.tsx: Route /rules → RuleDashboard
Sidebar.tsx: "Regeln" Nav-Item (zwischen existierenden Items einordnen)

npm run build — Frontend muss fehlerfrei bauen.
Commit: `feat(rule-001): frontend — rule dashboard, form, templates, preview`
```

# P2 Bugs — Batch 1: Frontend UX (B028, B029, B032, B036)

> Grundlegende UX-Fixes die alle OMS-Tabellen betreffen. Kein Backend nötig.

## Prompt für Claude Code:

```
Lies CLAUDE.md und TASKS.md. Dann fixe diese 4 Frontend-UX-Bugs in einem Feature-Branch `fix/p2-frontend-ux`:

## B-028: Empty States in OMS-Tabellen
Dateien: OrdersView.tsx, ShippingView.tsx, ReturnsView.tsx, InvoicesView.tsx
Problem: Leere Tabellen zeigen nichts — kein Hinweis, keine "Keine Ergebnisse" Meldung.
Fix: Wenn entries.length === 0 && !loading → zeige einen Empty State:
- Mit Filter aktiv: "Keine Ergebnisse für diesen Filter." + Button "Filter zurücksetzen"
- Ohne Filter: "Noch keine [Bestellungen/Sendungen/Retouren/Rechnungen] vorhanden."
Pattern: Sieh dir AuditLogView.tsx an — dort existiert bereits ein korrekter Empty State.

## B-029: Loading-Spinner bei Async-Operationen
Dateien: OrdersView.tsx, ShippingView.tsx, ReturnsView.tsx, InvoicesView.tsx
Problem: Bulk-Aktionen (Statuswechsel, Label erstellen, als bezahlt markieren) zeigen keinen Spinner. Buttons bleiben klickbar → Doppelklick = doppelter API-Call.
Fix:
1. Füge `const [actionLoading, setActionLoading] = useState(false)` hinzu
2. Setze actionLoading=true vor dem API-Call, false im finally-Block
3. Übergib `loading={actionLoading}` und `disabled={actionLoading}` an die Action-Buttons
4. Die Button-Komponente hat bereits ein `loading` Prop — nutze es.

## B-032: Pagination bei Filter-Wechsel zurücksetzen
Datei: OrdersView.tsx
Problem: User ist auf Seite 3, wechselt Filter → currentPage bleibt 3, Ergebnisse stimmen nicht.
Fix: In jedem Filter-Handler (Status, Suche, Datum) → setCurrentPage(1) aufrufen.
Prüfe auch ShippingView, ReturnsView, InvoicesView ob das gleiche Problem besteht.

## B-036: KPI-Cards NaN/Infinity bei leerem Datensatz
Dateien: OrdersView.tsx, InvoicesView.tsx
Problem: avgProcessingTime und andere KPIs dividieren durch orders.length. Bei 0 → NaN/Infinity.
Fix: Vor jeder Division prüfen: `orders.length > 0 ? (sum / orders.length) : 0`
Auch Prozent-Berechnungen absichern.

Danach: npm run build (Frontend muss fehlerfrei bauen). Commit mit `fix: P2 frontend UX — empty states, loading spinners, pagination reset, KPI guards`
```

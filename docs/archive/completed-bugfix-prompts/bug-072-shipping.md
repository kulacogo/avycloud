# BUG-072: Versand-Tabelle — Geisterdaten + BaseLinker + Versandkosten

> P0 Bug wegen BaseLinker-Referenz. Betrifft ShippingView.tsx + Backend.

## Prompt für Claude Code:

```
Lies CLAUDE.md und TASKS.md.

Arbeite auf Branch `fix/bug-072-shipping`.

## KONTEXT
BaseLinker wurde März 2026 komplett entfernt (48 Dateien gelöscht, 40+ bereinigt).
GOLDENE REGEL: BaseLinker ist TABU — keine neuen Referenzen, Imports oder ENV-Vars.

WICHTIG: Es existiert BEREITS eine Versandkosten-Infrastruktur!
- backend/lib/sendcloud.js hat `lookupCsvPrice(method_id, weightKg)` (Zeile ~67-90)
- backend/lib/firestore.js hat `parseWeightKg()` (Zeile ~235-259) und `normalizeWeightKgNumber()` (Zeile ~261-271)
- details.weight in products_v2 speichert Gewicht in kg
- backend/services/quality-gate.js warnt bei fehlendem Gewicht
- backend/scripts/backfill-weights.js existiert (FIX-11, noch nie ausgeführt!)
- backend/scripts/bucket-weights.js rundet auf Versand-Buckets: [1, 3, 6, 9, 12, 15] kg

Das Problem: Die meisten Produkte haben noch KEIN details.weight weil FIX-11 nie ausgeführt wurde.

## Teil 1: BaseLinker-Badge entfernen (P0 — HÖCHSTE PRIORITÄT)

1. Suche im GESAMTEN Frontend: grep -ri "baselinker" components/ — ALLE Referenzen entfernen
2. Suche im Backend: grep -ri "baselinker" backend/ — ALLE Referenzen entfernen
3. In ShippingView.tsx: Finde wo das Marketplace-Badge gerendert wird
4. Wenn order.source === "baselinker" → zeige "Legacy" Badge in grau statt "baselinker"
5. Alte BaseLinker-Orders in Firestore haben noch source: "baselinker" — Frontend muss damit umgehen

## Teil 2: Geistereinträge ohne Tracking/Kundenname

Einträge wie 26-14354-93495, 09-14380-64268, M9YQ4P5 haben kein Tracking und/oder keinen Kundennamen.
1. Prüfe ob diese Sendungen Status "Problem" haben → dann ist kein Tracking korrekt
2. Für fehlende Kundennamen: prüfe ob die verknüpfte Order einen Kundennamen hat
3. Zeige "—" statt leere Zelle für fehlende Daten (Konsistenz)

## Teil 3: Versandkosten — bestehende Infrastruktur nutzen

NICHT neu bauen! Nutze die existierende `lookupCsvPrice()` in backend/lib/sendcloud.js.

1. Prüfe wie sendcloud.js aktuell die CSVs lädt (Pfad: wahrscheinlich /data/ oder Root)
   - Die CSVs liegen im Projekt-Root: sendcloud_upload_DHL.csv und sendcloud_upload_DPD.csv
   - Falls sendcloud.js einen anderen Pfad erwartet: passe den Pfad an oder kopiere die CSVs
2. Im Shipping-Endpoint: Für jede Sendung Kosten berechnen:
   - Carrier aus der Sendung ermitteln (DHL oder DPD)
   - Gewicht aus dem verknüpften Produkt: details.weight aus products_v2
   - `lookupCsvPrice(method_id, weightKg)` aufrufen
   - Standard method_ids: DHL Paket = 89, DPD Classic = 111 (0-5kg), 112 (5-10kg), 113 (10-20kg), 114 (20-31.5kg)
3. Falls kein Gewicht am Produkt vorhanden: zeige "—" statt 0,00€
4. Falls kein Produkt-Match: zeige "—"

## Teil 4: Zustellquote falsch (1.1% statt ~80%)

1. Finde die KPI-Berechnung für "Zustellquote" in ShippingView.tsx
2. Erwarteter Wert: 149 Zugestellt / 185 Gesamt = ~80.5%
3. Mögliche Fehler:
   a) Teilt durch falsche Gesamtzahl (z.B. durch alle Orders statt nur Sendungen)
   b) Multipliziert nicht mit 100 (0.805 statt 80.5%)
   c) Teilt das Ergebnis nochmal durch 100

## Teil 5: Ø Versandkosten KPI

Nach dem Fix von Teil 3 sollte sich dieser KPI automatisch korrigieren.
Prüfe dass die Durchschnittsberechnung korrekt ist (Division durch Anzahl Sendungen MIT Kosten, nicht durch alle).

## Teil 6: FIX-11 backfill-weights.js vorbereiten

Das Backfill-Script existiert bereits: backend/scripts/backfill-weights.js
1. Prüfe ob das Script lauffähig ist (keine Syntax-Fehler, Dependencies vorhanden)
2. Führe einen --dry-run aus: `node backend/scripts/backfill-weights.js --dry-run --limit=10`
3. Wenn es funktioniert: Logge das Ergebnis (wie viele Produkte bekämen ein Gewicht)
4. NICHT --write ausführen ohne Rückmeldung! Nur dry-run.

HINWEIS: Auch ohne backfill-weights.js müssen die Versandkosten für Produkte MIT Gewicht schon korrekt angezeigt werden. Das Backfill erhöht nur die Abdeckung.

cd backend && npm test + npm run build.
Commit: fix(bug-072): remove baselinker refs, wire sendcloud pricing lookup, fix delivery rate KPI
```

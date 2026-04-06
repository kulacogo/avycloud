# Dashboard Redesign — Zahlen-Fixes + UX

## Ziel
Korrekte Zahlen + schlichteres, smarteres Layout mit klarer Hierarchie: Finanzen prominent, Operations kompakt.

## Bug-Fixes (Backend + Frontend)

### BUG-1: Retouren zeigt All-Time statt Window
- **Problem**: `Dashboard.tsx:888` zeigt `ord.returnsTotal` (All-Time) in der Kennzahlen-Sektion, unabhängig vom gewählten Preset.
  `Dashboard.tsx:745` zeigt ebenfalls All-Time im Jahresüberblick.
- **Fix Frontend**: Kennzahlen-Karte → `returns.window.count`. Jahresüberblick → YTD-Count (`returns_month` oder eigener YTD-Wert).
- **Fix Backend**: `returns_ytd` Feld zum Metrics-Endpoint hinzufügen (Retouren seit 1. Jan.).

### BUG-2: Chart-Revenue inkonsistent mit Karten-Revenue
- **Problem**: Karten-Umsatz zieht Refunds ab (`orders.js:164-168`), Chart-Buckets (`volume_7d.days[].revenue`) nicht.
- **Fix**: Im Backend `getDashboardMetrics()` die Refund-Beträge aus den Chart-Buckets abziehen, oder im Frontend die Chart-Daten mit den Returns-Werten korrigieren.
- **Gewählt**: Frontend-Korrektur — Chart zeigt denselben Umsatz-Wert wie die Karte. Einfacher, kein Backend-Change nötig für die Chart-Buckets.

### BUG-3: Potenzielle Doppelzählung Retouren
- **Problem**: Backend zählt Retouren aus `orders` Collection (Status-String "retour"/"return") UND aus `returns` Collection. Overlap möglich.
- **Fix**: Retouren-Count und -Value ausschließlich aus `returns` Collection. Order-Status-basierte Zählung in `getDashboardMetrics()` wird nicht mehr für die Dashboard-KPIs verwendet.

## UX-Redesign

### Sektion 1: Hero-KPIs (3 Karten)
```
| Kontostand (SevDesk) | Umsatz YTD (Brutto) | Versand YTD (Brutto) |
```
- Kontostand: wie bisher, violet/rot
- Umsatz YTD: grün, Sub = dezentes Delta vs. Vorjahres-YTD wenn verfügbar
- Versand YTD: amber, Sub = "X Sendungen · DHL Y · DPD Z"
- **Retouren-Hero-Karte entfällt** (kein Hero-Material, nur unten im Zeitraum)

### Sektion 2: Kennzahlen · {Preset} (3 Karten + Chart)
```
| Umsatz (Window)     | Versand (Window)    | Retouren (Window)   |
|                     Chart (220px Höhe)                          |
```
- Umsatz: Sub = "X Aufträge", optional ↑/↓% vs. Vorperiode
- Versand: Sub = "X Sendungen"
- **Retouren: Window-Count** (NICHT All-Time) + Window-Value als Sub
- Chart: Höhe 160px → 220px. Revenue-Linie korrigiert (minus Refunds).

### Sektion 3: Auftragsfluss (kompakt)
- Statt 5 große Button-Karten → **horizontale Inline-Leiste**
- Pro Status: farbiger Dot + Label + Zahl, inline nebeneinander
- Progress-Bar bleibt oben
- Klickbar wie bisher

### Sektion 4: Bestand & Sync (eine kompakte Leiste)
Statt 8 Karten (4 Bestand + 4 Sync) → **eine Zeile mit Inline-Stats**:
```
Bestand: 42 Produkte · 156 verfügbar · 12 reserviert | eBay ✓ 38/42 | Kaufland ✓ 40/42 | Wert: €4.200
```
- Sync-Status als Badge (✓ grün / ✗ rot mit Fehleranzahl)
- Bei Fehlern: expandierbares Detail darunter
- Bestandswert am Ende

### Sektion 5: Nachbestellungs-Warnungen (unverändert)
Nur sichtbar wenn Alerts existieren.

### Sektion 6: Aktivitäts-Feed (unverändert)
Bleibt am Ende.

## Delta-Berechnung (vs. Vorperiode)
- Methode: Backend liefert bereits `window_non_cancelled_total` für den Zeitraum. Für den Vergleichszeitraum brauchen wir einen zweiten Call oder einen neuen Backend-Parameter.
- **Gewählt**: Kein zweiter API-Call. Delta nur für YTD vs. Vorjahr (Daten bereits vorhanden via `all_non_cancelled_total` Historie). Für Window-Deltas: spätere Iteration.
- Fallback: Kein Delta anzeigen wenn keine Vergleichsdaten.

## Nicht im Scope
- Sparklines in Karten
- Gewinn/Rohertrag-KPI
- Mobile Dashboard (`DashboardMobile.tsx`) — separates Ticket
- Backend-Performance (Full Collection Scan) — separates Ticket

## Dateien betroffen
- `components/Dashboard.tsx` — Hauptänderungen (Layout, Karten, Pipeline, Retouren-Fix)
- `backend/routes/orders.js` — `returns_ytd` Feld hinzufügen, Doppelzählung fixen
- `types.ts` — ggf. Interface-Erweiterung für `returns_ytd`

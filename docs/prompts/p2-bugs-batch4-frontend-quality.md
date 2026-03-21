# P2 Bugs — Batch 4: Frontend Quality (B027, B034, B042, B043, B044, B045, B047)

> Kleinere Frontend-Fixes: Zeitzonen, Accessibility, Semantik.

## Prompt für Claude Code:

```
Lies CLAUDE.md und TASKS.md. Dann fixe diese 7 Frontend-Quality-Bugs in Branch `fix/p2-frontend-quality`:

## B-027: Überfällig-Berechnung nutzt Client-Zeit
Datei: InvoicesView.tsx
Problem: isDueSoon() vergleicht Fälligkeitsdatum mit new Date() (Client-Zeit). Falsche Uhrzeit → falsche Markierung.
Fix: Ist akzeptabel für diesen Use-Case (±1h Abweichung irrelevant bei Tages-Granularität). Füge einen Kommentar hinzu der das erklärt. KEIN Backend-Call nötig nur dafür.
ALTERNATIV: Falls ein serverTimestamp bereits in den Daten ist → nutze den als Referenz.

## B-034: Return Timeline Zeitzonen
Problem: Return-Events zeigen UTC-Timestamps. Backend speichert UTC, Frontend rendert als lokale Zeit ohne Offset.
Fix: Nutze `toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' })` und `toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin' })` für alle Timestamp-Anzeigen in der Return-Timeline.

## B-042: ARIA-Labels auf Status-Badges
Dateien: OrdersView.tsx, ShippingView.tsx, ReturnsView.tsx, InvoicesView.tsx
Problem: Farbige Status-Badges haben kein aria-label. Screenreader können Status nicht lesen.
Fix: Füge `aria-label={statusLabel}` zu allen Status-Badge Elementen hinzu. Der Label-Text sollte der bereits angezeigte deutsche Text sein.

## B-043: Tracking-Links Sicherheit
Datei: ShippingView.tsx
Problem: Tracking-URLs werden mit target="_blank" geöffnet aber ohne rel="noopener noreferrer".
Fix: Füge `rel="noopener noreferrer"` zu allen <a target="_blank"> Links hinzu.
Prüfe auch andere Dateien auf das gleiche Problem.

## B-044: Tabellen-Header Semantik
Datei: InvoicesView.tsx
Problem: div statt th für Tabellen-Header. Screenreader können Spalten nicht zuordnen.
Fix: Ersetze die Header-divs durch semantische <th> Elemente (oder stelle sicher dass role="columnheader" gesetzt ist). Styling beibehalten.

## B-045: Focus-Trap in Modals
Problem: Modals haben keine Focus-Trap. User kann mit Tab aus dem Modal heraus navigieren.
Fix: Prüfe ob es bereits eine Modal/Dialog Komponente gibt. Falls ja: füge focus-trap Logik hinzu (onKeyDown für Tab, focusable elements am Anfang/Ende wrappen). Falls nein: nutze eine einfache Lösung mit useEffect + focusTrap.
HINWEIS: Kein neues Package installieren. Einfache manuelle Implementierung reicht.

## B-047: Carrier-Badge GLS → GL
Problem: getCarrierInitial() schneidet auf 2 Zeichen. GLS wird zu "GL".
Fix: Ändere die Funktion: wenn carrier.length <= 3 → zeige den vollen String. Nur bei längeren Namen auf 2 kürzen.
Finde die Funktion (wahrscheinlich in ShippingView.tsx oder einem Helper).

Danach: npm run build. Commit: `fix: P2 frontend quality — timezone, a11y, semantics, security, carrier badge`
```

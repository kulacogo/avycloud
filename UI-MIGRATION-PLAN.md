# AvyCloud UI Migration Plan — Soft Slate Theme

> **Goldene Regel:** Die App in Production darf NIEMALS negativ beeinflusst werden.

---

## Überblick

Migration der gesamten AvyCloud UI vom aktuellen Sky-Blue/Slate Theme zum **Soft Slate** Design.

### Farbwechsel

| Token | Aktuell | Neu (Soft Slate) |
|-------|---------|-------------------|
| --page-bg | #0f172a | #1a1d23 |
| --surface-primary | #1e293b | #21242b |
| --surface-secondary | #1f2937 | #15171c |
| --text-color | #e2e8f0 | #ebeef5 |
| --text-muted | #94a3b8 | #7a8090 |
| --border-color | #1f2a37 | #2a2d35 |
| Accent (sky-600) | #0284c7 | #7c75ff |
| Accent hover (sky-500) | #0ea5e9 | #8b85ff |
| Accent text (sky-400) | #38bdf8 | #9d98ff |
| Accent subtle (sky-300) | #7dd3fc | #b8b4ff |
| Accent shadow (sky-900) | #0c4a6e | #2d2a66 |

---

## Phase 1: CSS Variables & Tailwind Config (ZERO RISK)

### Schritt 1.1 — CSS Variables aktualisieren
**Datei:** `styles/main.css`

Nur die `:root` (dark) Werte ändern:
```css
:root {
  --page-bg: #1a1d23;
  --surface-primary: #21242b;
  --surface-secondary: #15171c;
  --text-color: #ebeef5;
  --text-muted: #7a8090;
  --border-color: #2a2d35;
}
```

Light Mode bleibt unverändert.

**Risiko:** Minimal — betrifft nur Elemente die CSS vars nutzen (body bg, light-mode overrides, theme toggle button).

### Schritt 1.2 — Tailwind Custom Colors definieren
**Datei:** `tailwind.config.cjs`

```js
theme: {
  extend: {
    colors: {
      accent: {
        50:  '#f0efff',
        100: '#dddcff',
        200: '#b8b4ff',
        300: '#9d98ff',
        400: '#8b85ff',
        500: '#7c75ff',
        600: '#7c75ff',  // primary
        700: '#5f58cc',
        800: '#4a4499',
        900: '#2d2a66',
        950: '#1a1833',
      },
      surface: {
        page: '#1a1d23',
        primary: '#21242b',
        secondary: '#15171c',
        elevated: '#282c35',
      }
    }
  }
}
```

**Risiko:** Null — addiert nur neue Utility-Klassen, bestehende funktionieren weiter.

---

## Phase 2: Accent-Farben migrieren (~153 Stellen)

### Strategie: Schrittweiser Ersatz per Datei

Jede `sky-*` Nutzung wird durch `accent-*` ersetzt. Da Tailwind die neuen `accent-*` Klassen sofort kennt (Phase 1), kann jede Datei einzeln migriert werden.

### Mapping-Tabelle

| Aktuell | Neu |
|---------|-----|
| bg-sky-600 | bg-accent-500 |
| bg-sky-600/20 | bg-accent-500/20 |
| bg-sky-600/30 | bg-accent-500/30 |
| bg-sky-500 | bg-accent-400 |
| bg-sky-500/10 | bg-accent-400/10 |
| bg-sky-500/20 | bg-accent-400/20 |
| bg-sky-700 | bg-accent-700 |
| bg-sky-900/20 | bg-accent-900/20 |
| bg-sky-900/30 | bg-accent-900/30 |
| hover:bg-sky-500 | hover:bg-accent-400 |
| hover:bg-sky-600 | hover:bg-accent-600 |
| hover:bg-sky-700 | hover:bg-accent-700 |
| text-sky-400 | text-accent-300 |
| text-sky-300 | text-accent-200 |
| text-sky-200 | text-accent-200 |
| text-sky-100 | text-accent-100 |
| border-sky-500 | border-accent-400 |
| border-sky-500/20 | border-accent-400/20 |
| ring-sky-500 | ring-accent-400 |
| shadow-sky-900/40 | shadow-accent-900/40 |
| accent-sky-500 | accent-accent-400 |

### Reihenfolge (nach Priorität)

1. **Header.tsx** — Navigation active state, theme toggle (höchste Sichtbarkeit)
2. **App.tsx** — Spinner, loading states, error handling
3. **Spinner.tsx** — Global loading indicator
4. **MobileTabBar.tsx** — Mobile navigation
5. **LoginScreen.tsx** — Login button
6. **AdminTable.tsx** — Produktliste (größte Tabelle)
7. **ProductSheet.tsx** — Produktdetailseite
8. **DashboardDesktop.tsx / DashboardMobile.tsx** — KPI cards
9. Alle restlichen Komponenten (alphabetisch)

### Schritt 2.1 — Header.tsx
```
Active nav:  bg-sky-600 text-white shadow-md shadow-sky-900/40
→            bg-accent-500 text-white shadow-md shadow-accent-900/40

Inactive:    bg-slate-800/60 → bg-surface-primary/60 (optional, Phase 3)
```

### Schritt 2.2 — Batch-Migration
Für jede Komponentendatei:
1. Alle `sky-` Vorkommen durch `accent-` ersetzen (per Mapping)
2. Speichern
3. `npm run build` — sicherstellen dass kein TypeScript-Fehler

---

## Phase 3: Background-Farben migrieren (optional, niedrigere Priorität)

Die bestehenden `bg-slate-900`, `bg-slate-800` etc. werden teilweise durch CSS variables überschrieben (Light Mode), teilweise direkt als Tailwind-Klassen verwendet.

### Optionen:
**A) CSS Variables erweitern** (empfohlen):
Statt alle `bg-slate-900` zu ersetzen, mehr CSS-Overrides in main.css hinzufügen:
```css
:root {
  /* Zusätzlich zu bestehenden */
  --surface-elevated: #282c35;
  --surface-hover: #2a2d35;
}
```
Und in den Light-Mode-Overrides:
```css
.bg-slate-900 { background-color: var(--surface-primary) !important; }
.bg-slate-800 { background-color: var(--surface-elevated) !important; }
```
→ Das ist bereits teilweise implementiert im Light-Mode-Block (Zeilen 67-114)!

**B) Klassen direkt ersetzen** — mehr Arbeit, aber sauberer langfristig.

### Empfehlung: Option A
Die Light-Mode-Override-Technik wird bereits eingesetzt. Wir erweitern sie für den Dark Mode, indem wir die `:root` Variablen anpassen und die Override-Regeln auch für Dark Mode wirksam machen.

---

## Phase 4: Feinschliff

1. **Scrollbar-Farben** anpassen (main.css Zeilen 41-57)
2. **Focus-Ring** Farbe von sky auf accent
3. **Selection-Color** falls definiert
4. **Favicon/Logo** — aktuell SVG im Header, Farbe ggf. anpassen

---

## Teststrategie

### Vor jeder Phase:
```bash
# Backend-Tests (dürfen nicht brechen)
cd backend && npm test

# Frontend Build (TypeScript + Vite)
npm run build
```

### Nach Phase 1 (CSS Variables):
- [ ] App im Browser öffnen, Dark Mode: Hintergrund ist #1a1d23 statt #0f172a
- [ ] Light Mode toggle funktioniert weiterhin
- [ ] Keine sichtbaren Farbprobleme in der Konsole

### Nach Phase 2 (Accent-Migration):
- [ ] Header: Active Nav-Button ist lila (#7c75ff) statt blau
- [ ] Mobile Tab Bar: Active Tab ist lila
- [ ] Login-Button ist lila
- [ ] Alle Focus-States (Tab-Navigation) nutzen lila Ring
- [ ] Spinner sind lila
- [ ] AdminTable: Alle Buttons, Links, Badges nutzen lila Accent
- [ ] ProductSheet: Pricing, Actions, Chat-Input nutzen lila
- [ ] Dashboard: KPI-Karten, Charts nutzen neue Farben

### Automatisiert:
```bash
# Suche nach verbleibenden sky-* Referenzen
grep -rn "sky-" components/ --include="*.tsx" --include="*.ts" | grep -v node_modules
# Sollte 0 Ergebnisse liefern nach vollständiger Migration
```

### Visuell (Screenshots):
Playwright-Screenshots der Hauptseiten vor und nach Migration:
1. Dashboard (Desktop)
2. Dashboard (Mobile)
3. AdminTable (Produktliste)
4. ProductSheet (mit Chat)
5. Operations Hub (Mobile)
6. Login Screen

---

## Zeitschätzung

| Phase | Aufwand | Risiko |
|-------|---------|--------|
| Phase 1: CSS Vars + Tailwind Config | 5 min | Null |
| Phase 2: Accent-Migration (153 Stellen) | 30-45 min | Niedrig |
| Phase 3: Background-Farben | 15 min | Niedrig |
| Phase 4: Feinschliff | 10 min | Null |
| Testing + Verification | 15 min | — |
| **Gesamt** | **~90 min** | **Niedrig** |

---

## Rollback-Plan

Falls etwas schiefgeht:
1. `git stash` oder `git checkout .` — alle Änderungen zurücksetzen
2. Kein Backend-Code wird berührt → kein Deployment-Risiko
3. Kein Firestore-Schema wird berührt → kein Datenverlust
4. Nur Frontend-Styling-Dateien betroffen

---

## Wichtige Anmerkungen

- **Backend wird NICHT berührt** — rein Frontend-Änderung
- **Keine Route-Änderungen** — Routing bleibt identisch
- **Keine Funktionalität-Änderung** — nur Farben/Styling
- **Additiver Tailwind-Config** — keine bestehenden Klassen entfernt
- **Light Mode bleibt** — nur Dark-Mode-Farben werden angepasst

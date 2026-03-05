# AvyCloud UI Redesign — Implementierungsplan

## Ausgangslage

- 195+ React-Komponenten, hardcoded Tailwind `slate-*` Klassen
- Theme-Switching via `main.css` mit ~30 `!important`-Overrides (fragil)
- Kein Design-System (kein shadcn, kein Radix)
- Mobile-Views existieren bereits (DashboardMobile, MobileOperationsView, MobileTabBar)
- Zieldesign: **Soft Slate Theme** (Mockup: `ui-mockup.html`)

---

## Phase 1: Design-Token-Foundation (1–2 Tage)

**Ziel:** Alle Farben von hardcoded Tailwind-Klassen auf CSS-Variablen umstellen.

### 1.1 `styles/main.css` — Design Tokens einführen

Aktuelle CSS-Variablen (`--page-bg`, `--surface-primary` etc.) durch vollständiges Token-System ersetzen:

```css
:root {
  /* Soft Slate Dark */
  --bg-page: #1a1d23;
  --bg-surface: #21242b;
  --bg-surface-raised: #282c34;
  --bg-surface-hover: #2e323b;
  --bg-sidebar: #15171c;
  --bg-sidebar-active: rgba(124, 117, 255, 0.10);
  --bg-input: #1e2128;
  --border-default: #2a2d35;
  --border-subtle: #24272e;
  --text-primary: #ebeef5;
  --text-secondary: #8a8f9e;
  --text-tertiary: #7a8090;
  --accent-primary: #7c75ff;
  --accent-success: #34d399;
  --accent-warning: #fbbf24;
  --accent-danger: #f87171;
}
```

### 1.2 `tailwind.config.cjs` — Token-Referenzen

```js
theme: {
  extend: {
    colors: {
      page: 'var(--bg-page)',
      surface: 'var(--bg-surface)',
      'surface-raised': 'var(--bg-surface-raised)',
      'surface-hover': 'var(--bg-surface-hover)',
      'text-primary': 'var(--text-primary)',
      'text-secondary': 'var(--text-secondary)',
      accent: 'var(--accent-primary)',
      success: 'var(--accent-success)',
      warning: 'var(--accent-warning)',
      danger: 'var(--accent-danger)',
    },
    borderColor: {
      DEFAULT: 'var(--border-default)',
      subtle: 'var(--border-subtle)',
    },
  },
}
```

### 1.3 Alle `!important`-Overrides aus `main.css` entfernen

Die 30+ `[data-theme='light'] .bg-slate-*` Selektoren werden überflüssig, da Komponenten jetzt CSS-Variablen nutzen.

---

## Phase 2: Layout-Redesign (2–3 Tage)

**Ziel:** Von Top-Navigation + Content zu Sidebar-Layout wechseln.

### 2.1 Neue Layout-Komponente: `AppShell.tsx`

```
┌─────────────────────────────────────────────┐
│  Sidebar (240px)  │     Main Content        │
│                   │  ┌───────────────────┐  │
│  Logo             │  │  TopBar (52px)    │  │
│  Nav Items        │  ├───────────────────┤  │
│  ...              │  │  Content (scroll) │  │
│  User Card        │  │                   │  │
│                   │  │                   │  │
└───────────────────┴──┴───────────────────┘  │
```

- `AppShell.tsx` — Wrapper mit Sidebar + Main
- `Sidebar.tsx` — Collapsible, mit Nav-Sections aus Mockup
- `TopBar.tsx` — Breadcrumbs, Suche (⌘K), Theme-Toggle, Notifications
- Ersetzt aktuelles `Header.tsx` (Top-Navigation)

### 2.2 Mobile Layout (< 768px)

```
┌─────────────────────┐
│  TopBar (compact)   │
├─────────────────────┤
│                     │
│  Content (scroll)   │
│                     │
│                     │
├─────────────────────┤
│  BottomTabBar       │
└─────────────────────┘
```

- Sidebar wird zum **Drawer** (off-canvas, swipe-fähig)
- `MobileTabBar.tsx` bleibt, wird auf neue Nav-Struktur angepasst
- Hamburger-Icon im TopBar öffnet Sidebar-Drawer

### 2.3 Responsive Breakpoints

| Breakpoint | Layout |
|---|---|
| < 768px | Mobile: BottomTab + Drawer-Sidebar |
| 768px–1024px | Tablet: Collapsed Sidebar (64px Icons) + Content |
| > 1024px | Desktop: Full Sidebar (240px) + Content |

---

## Phase 3: Komponenten-Migration (3–5 Tage)

**Ziel:** Zentrale Komponenten auf neue Design-Tokens umstellen.

### Migrationsstrategie: Inkrementell, View für View

**Reihenfolge (nach Sichtbarkeit/Impact):**

1. **Dashboard.tsx / DashboardMobile.tsx** — KPI-Cards, Charts, Activity Feed
2. **AdminTable.tsx + admin-table/** — Produkt-Tabelle (häufigste View)
3. **ProductSheet.tsx** — Produkt-Detail (meistgenutzte Interaktion)
4. **EbayListingsView.tsx** — Marktplatz-View
5. **WarehouseView.tsx** — Lager-View
6. **GeminiChat.tsx + chat/** — Chat-Interface
7. **OperationsView.tsx / MobileOperationsView.tsx** — Lager-Workflow
8. **Admin-Views (admin/)** — Admin-Panel (niedrigere Prio)
9. **LoginScreen.tsx** — Login (kleiner Scope)

### Pro Komponente:

```
1. `bg-slate-900` → `bg-page` (Tailwind Custom)
2. `bg-slate-800` → `bg-surface`
3. `text-white` → `text-text-primary`
4. `text-slate-400` → `text-text-secondary`
5. `border-slate-700` → `border` (nutzt --border-default)
6. Hardcoded hex-Werte (#1e293b etc.) → var(--bg-surface)
```

### Neue UI-Primitives (optional, aber empfohlen):

| Komponente | Zweck |
|---|---|
| `Badge.tsx` | Status-Badges (Aktiv, Draft, Fehler) |
| `KpiCard.tsx` | Dashboard KPI-Karten |
| `DataTable.tsx` | Generische Tabelle mit Sortierung/Filter |
| `CommandPalette.tsx` | ⌘K Suche/Navigation |

---

## Phase 4: Typography & Font (0.5 Tage)

### Font-Wechsel

- Aktuell: System-UI Stack (`ui-sans-serif, system-ui`)
- Neu: **Inter** (Variable Font)

```html
<!-- index.html -->
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
```

```js
// tailwind.config.cjs
fontFamily: {
  sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
}
```

---

## Phase 5: Mobile-spezifische Optimierungen (1–2 Tage)

### 5.1 Bestehende Mobile-Komponenten aktualisieren

- `DashboardMobile.tsx` — Neue KPI-Cards, Farben
- `MobileOperationsView.tsx` — Neue Farben, bestehendes UX beibehalten (funktioniert gut)
- `MobileTabBar.tsx` — Neue Icons, Akzentfarbe
- `MobileSearchView.tsx` — Neue Suchfeld-Styles

### 5.2 Touch-Optimierungen

- Mindest-Tap-Target: 44×44px (Apple HIG)
- Swipe-Gesten für Sidebar-Drawer
- Pull-to-refresh auf Dashboard
- Bottom-Sheet statt Modals auf Mobile

### 5.3 PWA-Verbesserungen (optional)

- `manifest.json` mit Soft Slate Farben
- Theme-Color Meta-Tag: `#1a1d23`
- Splash Screen anpassen

---

## Phase 6: Qualitätssicherung (1 Tag)

- [ ] WCAG AA Kontrast-Check auf allen Views (Dark + Light)
- [ ] Cross-Browser-Test (Chrome, Firefox, Safari)
- [ ] Mobile-Test (iOS Safari, Android Chrome)
- [ ] Performance-Check (Lighthouse, kein Layout Shift)
- [ ] Bestehende Vitest-Tests müssen weiterhin bestehen
- [ ] `npm run build` ohne Fehler

---

## Zeitplan (geschätzt)

| Phase | Aufwand | Beschreibung |
|---|---|---|
| Phase 1 | 1–2 Tage | Design Tokens + Tailwind Config |
| Phase 2 | 2–3 Tage | Sidebar-Layout (AppShell, Sidebar, TopBar) |
| Phase 3 | 3–5 Tage | Komponenten-Migration (9 Views) |
| Phase 4 | 0.5 Tage | Inter Font |
| Phase 5 | 1–2 Tage | Mobile-Optimierungen |
| Phase 6 | 1 Tag | QA & Testing |
| **Gesamt** | **~9–14 Tage** | |

---

## Risiken & Regeln

- **GOLDENE REGEL:** Kein Breaking Change in Production
- Migration kann inkrementell deployed werden (neue Variablen + alte Klassen koexistieren)
- `!important`-Overrides erst entfernen wenn ALLE Komponenten migriert sind
- Bestehende Routen-Struktur (Hash-based) bleibt unverändert
- Mobile-Views (Operations) haben Priorität für Warehouse-Nutzer

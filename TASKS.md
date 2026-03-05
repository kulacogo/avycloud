# Tasks

> **ZIEL: AvyCloud marktreif machen.** Enterprise-Grade Multi-Channel E-Commerce Hub.
> Benchmark: ChannelEngine, Channable, Linnworks, Plentymarkets, Billbee.
> AvyCloud-Vorteil: KI-gestützte Produkterkennung + Enrichment (kein Wettbewerber hat das).

> **⛔ KEINE PLACEHOLDER-VIEWS. NIEMALS.**
> Jedes Modul muss ECHTE, FUNKTIONALE Views implementieren — mit echten Daten, echten API-Calls, echten Interaktionen.
> Ein `PlaceholderView` oder `ComingSoon`-Component ist VERBOTEN. Wenn ein Modul noch nicht implementiert werden kann
> (z.B. fehlende API-Route), dann die View mit realistischem UI bauen und API-Calls als TODO markieren — aber das UI
> muss VOLLSTÄNDIG sein: Tabelle, Filter, KPI-Cards, Buttons, Modals, alles. KEIN leerer Screen mit "Demnächst verfügbar".
> **Bestehende PlaceholderViews müssen beim Implementieren des jeweiligen Moduls ERSETZT werden durch echte Implementierungen.**

---

## Active

### Sofort-Bugfixes (vor allem anderen)

- [x] **BUG-001: Umlaut/Unicode-Encoding in BulkActions** ~~since 2026-03-05~~ (2026-03-05)
  - Fix: Alle `\u00xx` Unicode-Escapes durch echte UTF-8-Zeichen ersetzt in BulkActions.tsx, AdminTableFilters.tsx, AdminTableHeader.tsx, AdminTableRow.tsx

- [x] **BUG-002: Doppelter Dark/Light-Mode Toggle** ~~since 2026-03-05~~ (2026-03-05)
  - Fix: Settings-Button in Topbar.tsx hatte Sonnen-SVG statt Zahnrad → durch echtes Gear-Icon ersetzt

- [x] **BUG-003: Sprach-Selector entfernen** ~~since 2026-03-05~~ (2026-03-05)
  - Fix: Language-Selector aus Topbar.tsx entfernt. Default-Locale in i18n.tsx auf `de` geändert. i18n-Infrastruktur (EN/TR Keys) bleibt erhalten

- [x] **BUG-004: ProductSheet wechselt Kontext (Inventory → Products)** ~~since 2026-03-05~~ (2026-03-05)
  - Fix: ProductSheet als Overlay (slide-in Panel) gerendert statt als eigene Route. `handleSelectProduct()` setzt nur `currentProduct`, kein `setView('sheet')`. Hash bleibt auf aktueller View. Close-Button + Backdrop-Click zum Schließen

- [x] **BUG-005: eBay/Kaufland Sync im Bulk-Dropdown conditional** ~~since 2026-03-05~~ (2026-03-05)
  - Fix: eBay Update und Kaufland Update Buttons in BulkActions.tsx immer sichtbar, nicht mehr conditional hinter `hasSelectedEbayListings`/`hasSelectedKauflandListings`

---

### Modul 1: UI/UX Design-System Foundation

- [x] **M1: Komponentenbibliothek (`components/ui/`)** ~~since 2026-03-05~~ (2026-03-05)
  - ✅ 17 Base-Components erstellt: Button, Input, Select, Badge, Card, Modal, Tabs, Tooltip, EmptyState, Skeleton, Alert, Dropdown, Breadcrumb, ProgressBar, Avatar, Stepper + cn() Utility
  - ✅ Index-Export: `components/ui/index.ts` — Barrel-Export aller Komponenten + Types
  - ✅ Tailwind-Animationen: slide-in-right, modal-in, indeterminate
  - ✅ Alle Komponenten nutzen Design Tokens (CSS-Variablen), Tailwind-Klassen, TypeScript Props
  - **Offen (Phase 2): Migration bestehender Komponenten auf ui/* Base-Components**
    - [ ] Alle `<button>` Tags → `<Button>` Component
    - [ ] Alle `<input>` Tags → `<Input>` Component
    - [ ] Alle `<select>` Tags → `<Select>` Component
    - [ ] Alle inline Status-Badges → `<Badge>` Component
    - [ ] Alle Modal/Dialog-Elemente → `<Modal>` Component
    - [ ] Alle Tab-Navigationen → `<Tabs>` Component
  - **Offen: Typography-Scale durchsetzen (h1-h4, body, caption, label)**
  - **Note:** `ui/Table.tsx` bewusst ausgelassen — AdminTable ist zu komplex für generische Table-Component, bleibt eigenständig

---

### Modul 2: Navigation & Layout

- [x] **M2: Sidebar, Topbar & Routing komplett überarbeiten** ~~since 2026-03-05~~ (2026-03-05)
  - ✅ Sidebar komplett neu: Collapsible Sections (AUFTRÄGE, PRODUKTE, LAGER, MARKTPLÄTZE, EINSTELLUNGEN), 240px/64px Collapse-Mode, localStorage-Persistenz, Accent-Left-Border Active-Indicator, Permission-basierte Sichtbarkeit
  - ✅ Topbar bereinigt: Breadcrumbs für verschachtelte Views, Ctrl+K Shortcut für Suche, Notification-Bell Placeholder, Settings-Gear entfernt (jetzt via Sidebar)
  - ✅ Routing komplett neu: 15+ neue Routes (#/orders/returns, #/orders/shipping, #/marketplace/ebay, #/settings/*, etc.), parseHash mit verschachtelten Pfaden, viewToHashPath aktualisiert, Legacy-Route-Redirects (#/ebay → #/marketplace/ebay)
  - ✅ ⚠️ Placeholder-Views für M3-M10 existieren → MÜSSEN beim Implementieren des jeweiligen Moduls durch echte Views ERSETZT werden
  - ✅ View-Type-Union erweitert auf 30 Views, ALLOWED_VIEWS aktualisiert, VIEW_MIGRATIONS für Legacy-Kompatibilität
  - **Offen (für spätere Module): EbayListingsView.tsx löschen (wenn MarketplaceListingsView.tsx in M5 fertig), Mobile-Navigation anpassen**
  - **Sidebar — FINALE Navigationsstruktur (bestätigt 2026-03-05):**
    ```
    Dashboard                          (Icon: LayoutDashboard)
    ──────────────────────────────
    AUFTRÄGE
      ├── Bestellungen                 (Icon: ClipboardList)
      ├── Retouren                     (Icon: RotateCcw)
      ├── Versand & Labels             (Icon: Truck)
      ├── Rechnungen                   (Icon: FileText)
      └── Einstellungen                (Icon: SlidersHorizontal)
           ├── Automatisierung
           ├── Status-Konfiguration
           ├── Nummernkreise
           └── Dokumenten-Templates
    ──────────────────────────────
    PRODUKTE
      ├── Produktdaten                 (Icon: Package)
      ├── Inventar                     (Icon: Warehouse)
      └── Erfassen                     (Icon: ScanLine)
    ──────────────────────────────
    LAGER
      ├── Verwaltung                   (Icon: MapPin)
      └── Einstellungen                (Icon: SlidersHorizontal)
    ──────────────────────────────
    MARKTPLÄTZE (dynamisch — NUR verbundene)
      ├── eBay                         (Icon: ShoppingBag oder eBay-Logo)
      ├── Kaufland                     (Icon: Store oder Kaufland-Logo)
      └── (weitere erscheinen automatisch wenn Integration verbunden)
    ──────────────────────────────
    Integrationen                      (Icon: Plug)
    ──────────────────────────────
    EINSTELLUNGEN (ganz unten, über User-Footer)
      ├── Unternehmensdaten            (Icon: Building2)
      ├── Persönliche Daten            (Icon: User)
      ├── Mitarbeiter & Rollen         (Icon: Users)
      ├── API                          (Icon: Code)
      └── Plan & Abrechnung            (Icon: CreditCard)
    ```
  - **Navigations-Regeln:**
    - [ ] **MARKTPLÄTZE-Gruppe ist dynamisch:** Nur verbundene Marktplätze anzeigen. Keine Marktplatz-Links wenn keine Integration aktiv. Reihenfolge: Alphabetisch oder nach Umsatz
    - [ ] **⚠️ "eBay (Gap Analysis)" View KOMPLETT ENTFERNEN** — `EbayListingsView.tsx` löschen, Route `#/ebay` entfernen. Gap-Infos werden in die jeweilige Marktplatz-Listing-View integriert
    - [ ] **Aufträge > Versand & Labels** ist hochgezogen (nicht versteckt) — tägliche Nutzung für Label-Druck, Tracking
    - [ ] **Aufträge > Rechnungen** ist hochgezogen — tägliche Nutzung, nicht unter Sub-Sub-Einstellungen verstecken
    - [ ] **Aufträge > Einstellungen** enthält NUR Konfiguration: Automatisierungs-Regeln, Status-Workflows, Nummernkreise (Rechnungs-/Auftrags-Nummern), Dokumenten-Templates (Rechnung/Lieferschein-Layout)
    - [ ] **Stow/Pick/Pack sind NUR in der Mobile-UI** verfügbar (unter "Operationen" in MobileTabBar/MobileOperationsView). Desktop-Sidebar hat KEINE Operationen/Stow/Pick/Pack Links — dort läuft alles über die Auftrags-Tabelle
    - [ ] **Erfassen (KI-Identify)** bleibt unter PRODUKTE — konzeptionell "neues Produkt in Katalog aufnehmen"
    - [ ] **Expandable Sections:** AUFTRÄGE, PRODUKTE, LAGER, MARKTPLÄTZE sind collapsible (Chevron-Icon, State in localStorage persistiert)
  - **Sidebar — UI/UX Spezifikation:**
    - [ ] Breite: 240px (expanded), 64px (collapsed, Icon-Only Mode)
    - [ ] Collapse-Toggle: Chevron-Button oben rechts in der Sidebar-Header-Leiste
    - [ ] Aktiver Nav-Punkt: Accent-Left-Border (3px, --accent) + leichter Background (--accent mit 8% opacity) + Font-Weight 500
    - [ ] Gruppen-Labels (AUFTRÄGE, PRODUKTE, etc.): 11px, Uppercase, Letter-Spacing 0.05em, --text-muted, 24px Margin-Top, 8px Margin-Bottom. Klickbar zum Auf-/Zuklappen (Chevron-Icon rechts)
    - [ ] Nav-Items: 14px, 400 weight, 40px Höhe, 12px Padding-Left (16px bei Sub-Items), Lucide-Icons (18px, 1.5 Stroke-Width, --text-muted, Active: --accent)
    - [ ] Sub-Items (unter Aufträge > Einstellungen): 13px, 32px Höhe, 32px Padding-Left, kein Icon
    - [ ] Hover: Background --surface, Transition 150ms ease
    - [ ] Sidebar-Footer: User-Avatar (32px) + Name + Role-Badge (Admin/User) + Logout-Icon. Fixed am unteren Rand, Border-Top 1px --border, 12px Padding
    - [ ] Scroll: Wenn Nav-Items Viewport überschreiten → Scroll innerhalb Sidebar (overflow-y: auto), Footer bleibt fixed (position: sticky)
    - [ ] Responsive: Sidebar verschwindet unter 768px → Mobile-Navigation übernimmt
  - **Topbar — Bereinigung:**
    - [ ] Links: Page-Title (h2, 18px, 600 weight) oder Breadcrumb (`ui/Breadcrumb` — z.B. "Aufträge > Bestellungen > #ORD-2024-001")
    - [ ] Mitte: Such-Input (max-width 480px, `ui/Input` mit Search-Icon Prefix, Placeholder "Suche... (Ctrl+K)", Cmd+K/Ctrl+K Shortcut öffnet fokussiert). Globale Suche: Produkte, Aufträge, Kunden durchsuchbar
    - [ ] Rechts: NUR Theme-Toggle (1x, Sun/Moon Icon) + Notification-Bell (mit Badge-Counter für ungelesene) + User-Avatar (32px, Klick → Dropdown: Persönliche Daten, Einstellungen, Logout)
    - [ ] Kein Sprach-Selector. Keine doppelten Elemente. Keine unnötigen Icons
    - [ ] Höhe: 56px, Background: --bg, Border-Bottom: 1px --border, Padding: 0 24px
  - **Routing — Neue Route-Struktur:**
    - [ ] `#/dashboard` — Dashboard
    - [ ] `#/orders` — Bestellungen (Default für AUFTRÄGE-Gruppe)
    - [ ] `#/orders/returns` — Retouren
    - [ ] `#/orders/shipping` — Versand & Labels
    - [ ] `#/orders/invoices` — Rechnungen
    - [ ] `#/orders/settings` — Auftrags-Einstellungen (Automatisierung, Status, Nummernkreise, Templates)
    - [ ] `#/products` — Produktdaten (Default für PRODUKTE-Gruppe)
    - [ ] `#/products/inventory` — Inventar/Bestand
    - [ ] `#/products/identify` — Erfassen (KI-Identify)
    - [ ] `#/warehouse` — Lagerverwaltung
    - [ ] `#/warehouse/settings` — Lager-Einstellungen
    - [ ] `#/marketplace/ebay` — eBay Listings (dynamisch)
    - [ ] `#/marketplace/kaufland` — Kaufland Listings (dynamisch)
    - [ ] `#/marketplace/:slug` — Generisch für zukünftige Marktplätze
    - [ ] `#/integrations` — Integrations-Hub
    - [ ] `#/settings` — Einstellungen (Unternehmensdaten)
    - [ ] `#/settings/profile` — Persönliche Daten
    - [ ] `#/settings/team` — Mitarbeiter & Rollen
    - [ ] `#/settings/api` — API-Verwaltung
    - [ ] `#/settings/billing` — Plan & Abrechnung
    - [ ] **ENTFERNEN:** Route `#/ebay` (alte Gap Analysis), Route `#/sheet`, Route `#/search` (in Topbar-Suche integriert)
  - **Mobile Navigation (< 768px):**
    - [ ] Bottom-TabBar: 3 Items — Dashboard (Icon: LayoutDashboard), Suche (Icon: Search), Operationen (Icon: PackageCheck)
    - [ ] Operationen-Page: 4 Cards — Erfassen, Einlagern (Stow), Kommissionieren (Pick), Verpacken (Pack)
    - [ ] Hamburger-Menu (oben links) für Zugang zu allen anderen Bereichen (Aufträge, Produkte, etc.)
    - [ ] Stow/Pick/Pack sind AUSSCHLIESSLICH hier verfügbar — NICHT in der Desktop-Sidebar
  - **Dateien:** `components/Sidebar.tsx` (komplett neu), `components/Topbar.tsx` (bereinigen), `App.tsx` (Routing komplett neu), `components/MobileTabBar.tsx` (beibehalten), `components/MobileOperationsView.tsx` (beibehalten), `i18n.tsx` (neue Nav-Labels auf Deutsch)

---

### Modul 3: Produkte (Katalog)

- [ ] **M3: Produkte-View Enterprise-tauglich** since 2026-03-05 (⚡ Teilweise implementiert)
  - ✅ ProductsPageHeader-Component: Titel + Counter + "Produkt anlegen" (Primary) / Import / Export (Secondary) Buttons
  - ✅ AdminTable bereits production-grade: 18 Spaltentypen, 4 Presets, Spalten-Konfiguration, Sortierung, Pagination (50/100/200), Filter (12+ Filter), Bulk-Actions
  - ✅ BulkActions immer sichtbar (BUG-005 fix), ProductSheet als Overlay (BUG-004 fix)
  - **Offen:**
  - **Page-Header:**
    - [ ] Titel "Produkte" (h1) + Counter "{gefiltert} von {gesamt} Produkte"
    - [ ] Action-Buttons rechts: "Produkt anlegen" (Primary), "Import" (Secondary), "Export" (Secondary)
  - **Kategorien-Management (in Produktdaten integriert, KEIN eigener Nav-Punkt):**
    - [ ] Kategorie als Filter-Dimension in der Produkte-Tabelle (Dropdown-Filter)
    - [ ] Kategorie-Spalte in Tabelle: Badge mit Kategorie-Name, klickbar → filtert auf diese Kategorie
    - [ ] Kategorie-Verwaltung: Settings-Modal oder Section in `#/settings` → Kategorie-Baum (Hierarchisch: Elektronik > Smartphones > Apple), Erstellen/Bearbeiten/Löschen, Drag-Reorder
    - [ ] Kategorie-Zuordnung: Im ProductSheet (Attribute-Tab) + Bulk-Aktion "Kategorie zuweisen"
    - [ ] Marketplace-Kategorie-Mapping: Pro Marktplatz eine Zuordnung (AvyCloud-Kategorie → eBay-Kategorie-ID, Kaufland-Kategorie) — konfigurierbar im Integrations-Hub (M9)
  - **Filter-System komplett neu:**
    - [ ] Filter-Bar unterhalb Header: Horizontale Chip-Leiste mit aktiven Filtern
    - [ ] Jeder Chip: Label + Wert + X-Close (z.B. "Marke: Apple ✕", "Status: Aktiv ✕")
    - [ ] "Filter hinzufügen" Button → Dropdown mit allen Filteroptionen:
      - Marke, Kategorie, Status (Aktiv/Inaktiv/Entwurf), Zustand (Neu/Gebraucht), Marketplace (eBay ✓/✕, Kaufland ✓/✕), Preisbereich, EAN (vorhanden/fehlend), Bilder (vorhanden/fehlend), Qualitätsscore-Bereich, Lagerort/Bin, Erstellt (Datumsbereich), Letzte Änderung (Datumsbereich)
    - [ ] "Alle Filter zurücksetzen" Link (nur sichtbar wenn Filter aktiv)
    - [ ] Saved Filter Presets: Dropdown "Gespeicherte Filter" (z.B. "Ohne EAN", "eBay-ready", "Niedrig-Bestand", "Neue Produkte 7 Tage")
    - [ ] User kann eigene Filter-Presets speichern (Name + Filterkombination → localStorage oder Firestore)
  - **Tabelle (AdminTable mit `ui/Table`):**
    - [ ] Standard-Spalten: Checkbox, Thumbnail (40x40), Name (truncated, max 2 Zeilen), SKU, EAN, Marke, Kategorie (Badge), Preis (VK), Bestand (Menge + Bin), Qualität (Score-Badge), Marketplace-Status (eBay ✓/✕ + Kaufland ✓/✕ Icons), Aktionen (3-Dot Menu)
    - [ ] Spalten-Konfiguration: Zahnrad-Icon → Dropdown-Checklist aller verfügbaren Spalten, User wählt welche sichtbar
    - [ ] Sortierung: Klick auf Spalten-Header, 3-State (Asc → Desc → None), visueller Pfeil-Indikator
    - [ ] Sticky Header bei Scroll
    - [ ] Row-Hover: Subtle --elevated Background
    - [ ] Row-Click: Öffnet ProductSheet (Overlay, KEIN Route-Wechsel)
    - [ ] Pagination: "25 / 50 / 100 pro Seite", Prev/Next, "Zeige 1-25 von 342"
    - [ ] Empty-State: `ui/EmptyState` — "Keine Produkte gefunden. Passe deine Filter an oder erfasse ein neues Produkt."
    - [ ] Loading: Skeleton-Rows (5 Zeilen) statt Spinner
  - **Bulk-Actions (bei Selektion):**
    - [ ] Sticky-Bar am unteren Rand: "{n} ausgewählt" + Action-Buttons
    - [ ] Primär-Buttons (immer sichtbar): "Verbessern" (KI), "Löschen", "Exportieren"
    - [ ] Sekundär-Buttons: "Preis aktualisieren", "Kategorie zuweisen", "eBay listen", "Kaufland listen"
    - [ ] ALLE Buttons immer sichtbar (nicht in verschachteltem "Mehr"-Dropdown verstecken)
    - [ ] Destruktive Aktionen: Bestätigungs-Modal ("Möchtest du {n} Produkte wirklich löschen?")
  - **ProductSheet (Detail-Panel) KOMPLETT NEU:**
    - [ ] Slide-in von rechts, 520px Breite, --surface Background, 1px --border links
    - [ ] Header: Close-Button (X) links, Thumbnail (48px), Produktname (h3, truncated), SKU (caption), Status-Badge
    - [ ] Tab-Bar (`ui/Tabs`): Übersicht | Bilder | Preise | Attribute | Marktplätze | Aktivität
    - [ ] **Übersicht-Tab:**
      - [ ] Hero-Image (200px, klickbar → Lightbox)
      - [ ] Produkt-Info-Grid: Name (editierbar), Brand, SKU, EAN (mit Valid/Invalid Badge), Kategorie (Badge + Link), Zustand, Beschreibung (Textarea)
      - [ ] Status-Section: Qualitätsscore (Fortschrittsbalken + Prozent), Marketplace-Status (eBay ✓/✕, Kaufland ✓/✕ mit letztem Sync-Datum)
      - [ ] Quick-Actions-Row: "Verbessern" (Primary), "Quality Check" (Secondary), "Label drucken" (Ghost)
    - [ ] **Bilder-Tab:**
      - [ ] Gallery-Grid (3 Spalten), Drag-Reorder
      - [ ] Upload-Zone (Drag & Drop oder Click)
      - [ ] Pro Bild: Löschen, als Hauptbild setzen, KI-Hintergrund entfernen
      - [ ] Bildoptimierung: Auto-Crop, Weißabgleich (existierende Backend-Funktionen)
    - [ ] **Preise-Tab:**
      - [ ] KI-Preisvorschlag: Vorgeschlagener Preis + Konfidenz-Badge (Hoch/Mittel/Niedrig) + "Übernehmen" Button
      - [ ] Manuell: EK-Feld, VK-Feld, Marge (automatisch berechnet, angezeigt als Prozent + Betrag)
      - [ ] Marketplace-Preise: Pro Marktplatz (eBay VK, Kaufland VK) — editierbar, Sync-Button
      - [ ] Competitor-Vergleich: Mini-Tabelle (Top 5 Konkurrenten: Quelle, Preis, Zustand, Datum)
    - [ ] **Attribute-Tab:**
      - [ ] Key-Value Grid (2 Spalten): Marke, Modell, Farbe, Speicher, Zustand, Gewicht, Maße, etc.
      - [ ] Edit-in-Place: Click auf Wert → Input, Enter speichert, Escape cancelt
      - [ ] "Attribut hinzufügen" Button am Ende
      - [ ] KI-Vorschläge: Badge "KI" neben automatisch erkannten Attributen
    - [ ] **Marktplätze-Tab (NEU — ersetzt alten eBay-Tab):**
      - [ ] Pro verbundenem Marktplatz eine Card:
        - Marktplatz-Name + Logo
        - Status: "Aktiv", "Inaktiv", "Nicht gelistet", "Fehler"
        - Listing-URL (klickbar)
        - Letzter Sync + Sync-Button
        - Marketplace-spezifische Felder (eBay: Item-ID, Kategorie; Kaufland: Offer-ID, etc.)
        - "Auf {Marktplatz} listen" Button (wenn nicht gelistet)
        - Readiness-Check: Fehlende Pflichtfelder als Gap-Liste
    - [ ] **Aktivität-Tab (NEU):**
      - [ ] Timeline: Chronologische Liste aller Änderungen (Erstellt, Bearbeitet, Gelistet, Preis geändert, Verbessert, etc.)
      - [ ] Pro Eintrag: Timestamp, User/System, Beschreibung, Vorher→Nachher bei Wertänderungen
    - [ ] KI-Chat (GeminiChat): Minimiert am unteren Rand des Sheets. Click → Expand. Quick-Prompt-Buttons: "Beschreibung verbessern", "Titel optimieren", "Fehlende Attribute ergänzen"
  - **Dateien:** `components/admin-table/AdminTable.tsx`, `components/admin-table/AdminTableHeader.tsx`, `components/admin-table/AdminTableRow.tsx`, `components/admin-table/AdminTableFilters.tsx`, `components/admin-table/BulkActions.tsx`, `components/ProductSheet.tsx`, `components/GeminiChat.tsx`

---

### Modul 4: Bestand (Inventar)

- [ ] **M4: Bestand-View — Lager-fokussiert, OHNE Marketplace-Listing-Features** since 2026-03-05
  - ✅ Route `#/products/inventory` aktiv, ⚠️ Placeholder-View vorhanden → MUSS durch echte Implementierung ERSETZT werden, ProductsPageHeader mit "Inventar"-Modus
  - **Konzept:** Bestand = physischer Lagerbestand. KEIN Listing-Management hier. Nur Indikatoren welche Marktplätze aktiv sind (als Badges). Listings werden in den jeweiligen Marktplatz-Views verwaltet.
  - **Page-Header:**
    - [ ] Titel "Bestand" + Counter "{n} Artikel im Lager"
    - [ ] KPI-Cards (4er Row): Gesamtartikel, Gesamteinheiten, Bestandswert (Σ EK), Niedrig-Bestand Alerts
    - [ ] Action-Buttons: "Einlagern" (Primary, → Stow-Flow), "Export" (Secondary)
  - **Filter-System:**
    - [ ] Filter-Chips: Lagerzone, Bin, Bestandsmenge (Range), Zustand (Neu/Gebraucht/Defekt), Letzte Bewegung (Datumsbereich), Marketplace-Status (Auf eBay ✓/✕, Auf Kaufland ✓/✕)
    - [ ] Quick-Filters: "Niedrig-Bestand" (< Reorder-Point), "Kein Lagerplatz", "Seit 30 Tagen unbewegt"
  - **Tabelle:**
    - [ ] Spalten: Checkbox, Thumbnail, Produktname, SKU, Bin (Lagerplatz-Badge), Menge, Zustand, EK, Bestandswert (Menge × EK), Letzte Bewegung (Datum), Marketplace-Indikatoren (kleine Icons: eBay ✓, Kaufland ✓ — NUR als Anzeige, nicht klickbar), Aktionen
    - [ ] Aktionen pro Row: "Umlagern" (Bin ändern), "Menge anpassen", "Details" (→ ProductSheet Overlay)
    - [ ] Row-Click → ProductSheet (Overlay, Kontext bleibt "Bestand")
  - **Bulk-Actions:**
    - [ ] "Umlagern" (Bin-Zuweisung für mehrere), "Inventur" (Mengen prüfen), "Export"
    - [ ] KEINE Marketplace-Aktionen hier — die gehören in die Marktplatz-Views
  - **Dateien:** `components/InventoryView.tsx` (komplett überarbeiten oder neu erstellen)

---

### Modul 5: Marktplatz-Listings (pro Marktplatz)

- [ ] **M5: Dynamische Marktplatz-Views** since 2026-03-05
  - ✅ Routes `#/marketplace/ebay` + `#/marketplace/kaufland` aktiv, Sidebar dynamische MARKTPLÄTZE-Gruppe, Legacy `#/ebay` Redirect
  - ✅ marketplace-ebay rendert bestehende EbayListingsView, marketplace-kaufland hat Placeholder
  - **Konzept:** Pro verbundenem Marktplatz ein eigener Nav-Link und eine eigene View. Wenn eBay verbunden → "eBay" in Sidebar unter MARKTPLÄTZE. Wenn Kaufland verbunden → "Kaufland" erscheint. Nicht verbundene Marktplätze erscheinen NICHT in der Sidebar (nur im Integrations-Hub).
  - **eBay Listings View (`#/marketplace/ebay`):**
    - [ ] Page-Header: "eBay Listings" + eBay-Logo + Connection-Status (Grüner Dot + "Verbunden")
    - [ ] KPI-Cards: Aktive Listings, Entwürfe, Fehler/Gaps, Umsatz 30 Tage, Ø Verkaufspreis
    - [ ] Tab-Bar: Alle Listings | Aktiv | Inaktiv | Entwürfe | Fehler
    - [ ] Tabelle: Thumbnail, Titel, eBay-Item-ID (Link zum Listing), Preis, Menge, Status (Aktiv/Inaktiv/Fehler Badge), Kategorie, Watchers, Verkäufe 30d, Letzter Sync, Aktionen
    - [ ] Aktionen: "Bearbeiten", "Deaktivieren", "Preis ändern", "Sync erzwingen"
    - [ ] Bulk: "Preis aktualisieren", "Deaktivieren", "Sync alle"
    - [ ] "Neues Listing erstellen" Button → Produkt aus Katalog wählen → Listing-Felder ausfüllen → Publish
    - [ ] Gap-Analyse INTEGRIERT: Bei Listings mit Fehlern → Expandable Row mit Gap-Details (fehlende Felder, Kategorie-Fehler, etc.)
    - [ ] Sync-Status-Banner oben: "Letzter Sync: vor 5min | Nächster Sync: in 10min | {n} Fehler"
  - **Kaufland Listings View (`#/marketplace/kaufland`):**
    - [ ] Gleiche Struktur wie eBay, aber Kaufland-spezifische Felder (Offer-ID, Kaufland-Kategorie, etc.)
    - [ ] KPIs, Filter, Tabelle, Bulk-Actions analog zu eBay
  - **Generisches Marketplace-View-Pattern:**
    - [ ] `components/MarketplaceListingsView.tsx` — Generische Component die per Props den Marktplatz erhält
    - [ ] Marktplatz-spezifische Konfiguration: Welche Spalten, welche Aktionen, welche API-Calls
    - [ ] Neue Marktplätze (Amazon, Otto, Zalando) können durch Config hinzugefügt werden ohne neue View-Component
  - **Alte eBay Gap Analysis View ENTFERNEN:**
    - [ ] `EbayListingsView.tsx` → Replace mit neuem `MarketplaceListingsView.tsx`
    - [ ] Route `#/ebay` → Redirect zu `#/marketplace/ebay` oder entfernen
    - [ ] Sidebar-Link "eBay" aktualisieren
  - **Dateien:** `components/MarketplaceListingsView.tsx` (neu), `components/EbayListingsView.tsx` (ersetzen), `App.tsx` (Routes), `Sidebar.tsx`

---

### Modul 6: Aufträge (Order Management)

- [ ] **M6: Multi-Channel Order Management** since 2026-03-05
  - ✅ Routes für alle Sub-Views aktiv: `#/orders`, `#/orders/returns`, `#/orders/shipping`, `#/orders/invoices`, `#/orders/settings`
  - ✅ Bestehende OrdersView unter `#/orders`, Placeholder-Views für Returns/Shipping/Invoices/Settings
  - **Konzept:** Zentrale Auftragsansicht über ALLE Marktplätze. Jeder Auftrag hat eine Fulfillment-Pipeline: Neu → Bestätigt → Kommissioniert → Verpackt → Versendet → Zugestellt.
  - **Page-Header:**
    - [ ] Titel "Aufträge" + Counter "{offen} offen, {heute} heute"
    - [ ] KPI-Cards: Offene Aufträge, Heute eingegangen, Heute versendet, Ø Bearbeitungszeit, Umsatz heute
    - [ ] Sync-Button: "Aufträge synchronisieren" (alle Marktplätze)
  - **Pipeline-Visualisierung (NEU):**
    - [ ] Horizontale Pipeline-Bar: Neu (n) → Bestätigt (n) → Kommissionierung (n) → Verpackung (n) → Versendet (n)
    - [ ] Klick auf Stage → Filtert Tabelle auf diesen Status
    - [ ] Farbcodierung: Neu=Info, Bestätigt=Warning, Komm.=Accent, Verpackt=Success, Versendet=Muted
  - **Filter:**
    - [ ] Status, Marktplatz (eBay/Kaufland/Amazon/...), Datumsbereich, Kunde, Zahlungsstatus (Bezahlt/Offen/Erstattet)
  - **Tabelle:**
    - [ ] Spalten: Auftrag-ID (Marketplace-Ref), Datum, Kunde (Name, abgekürzt), Artikel (Produktname × Menge, mehrere Zeilen bei Multi-Item), Gesamt (Betrag + Währung), Quelle (Marketplace-Badge: eBay blau, Kaufland orange, etc.), Zahlungsstatus, Fulfillment-Status (Badge), Aktionen
    - [ ] Row-Expand: Klick → Auftragsdetails (alle Positionen, Versandadresse, Notizen)
    - [ ] Aktionen: "Kommissionieren starten", "Versandlabel drucken", "Details", "Stornieren"
  - **Auftragsdetail-Panel (Slide-in oder Seite):**
    - [ ] Kundendaten: Name, Adresse, E-Mail, Telefon
    - [ ] Positionen: Produktbild, Name, SKU, Menge, Einzelpreis, Gesamtpreis
    - [ ] Zahlungsinfo: Methode, Status, Transaktions-ID
    - [ ] Versandinfo: Carrier, Tracking-Nummer (klickbar), Status, Versandkosten
    - [ ] Timeline: Auftragshistorie (Bestellt → Bezahlt → Kommissioniert → Verpackt → Versendet → Zugestellt)
    - [ ] Aktionen: "Rechnung generieren", "Lieferschein drucken", "Versandlabel drucken", "Nachricht an Kunden"
  - **Rechnungen-View (`#/orders/invoices`) — NEU:**
    - [ ] Tab-Bar: Alle | Entwürfe | Gesendet | Bezahlt | Überfällig | Storniert
    - [ ] Tabelle: Rechnungs-Nr., Datum, Kunde, Auftrag-ID, Betrag (Netto/Brutto), Status (Badge), Fälligkeitsdatum, Aktionen
    - [ ] Aktionen: "PDF generieren", "Per E-Mail senden", "Als bezahlt markieren", "Stornieren"
    - [ ] Bulk: "Alle offenen drucken", "Mahnlauf starten"
    - [ ] Auto-Generierung: Rechnung automatisch erstellen wenn Auftrag Status = "Versendet" (konfigurierbar in Einstellungen)
    - [ ] PDF-Template: Firmenlogo, Adresse, USt-IdNr., Bankverbindung, Positionen, MwSt-Ausweis
    - [ ] Lieferschein-Generierung analog (gleicher Flow, anderes Template — ohne Preise)
    - [ ] Integration: SevDesk/lexoffice-Export wenn Buchhaltungs-Integration aktiv
  - **Auftrags-Einstellungen (`#/orders/settings`) — NEU:**
    - [ ] **Automatisierung:** Rule-Engine für automatische Status-Übergänge
      - "Wenn Zahlung eingegangen → Status 'Bestätigt'"
      - "Wenn alle Items gepickt → Status 'Kommissioniert'"
      - "Wenn Versandlabel erstellt → Status 'Versendet'"
      - "Wenn Tracking 'Zugestellt' → Status 'Abgeschlossen'"
    - [ ] **Status-Konfiguration:** Benutzerdefinierte Status-Namen und Reihenfolge, Farben pro Status
    - [ ] **Nummernkreise:** Rechnungs-Nummernkreis (Prefix, Start, Format z.B. "RE-2026-{0001}"), Auftrags-Nummernkreis, Lieferschein-Nummernkreis
    - [ ] **Dokumenten-Templates:** WYSIWYG-Editor oder Template-Upload für Rechnung, Lieferschein, Auftragsbestätigung. Platzhalter: {firmenname}, {kundenname}, {positionen}, {gesamt}, {datum}, etc.
    - [ ] **E-Mail-Templates:** Auftragsbestätigung, Versandbenachrichtigung, Rechnungsversand — Text editierbar, Platzhalter
  - **Backend:**
    - [ ] Existiert: `routes/orders.js`, `lib/firestore.js::listOrders()`
    - [ ] Erweitern: Fulfillment-Status-Updates (PATCH `/api/orders/:id/status`), Multi-Channel-Aggregation
    - [ ] NEU: `routes/invoices.js` — CRUD für Rechnungen, PDF-Generierung (pdfkit oder puppeteer)
    - [ ] NEU: `services/invoice-generator.js` — Template-Rendering, Nummernkreis-Logik, PDF-Export
    - [ ] NEU: `services/order-automation.js` — Rule-Engine für automatische Status-Übergänge
    - [ ] Firestore Collections: `invoices` — {invoiceId, orderId, number, customer, items, total, tax, status, pdfUrl, ...}
    - [ ] Webhook: Bei Status-Änderung → Marketplace-API (eBay: Mark as Shipped, Kaufland: Confirm Shipment)
  - **Dateien:** `components/OrdersView.tsx` (überarbeiten), `components/OrderDetail.tsx` (neu), `components/InvoicesView.tsx` (neu), `components/OrderSettingsView.tsx` (neu), `backend/routes/orders.js`, `backend/routes/invoices.js` (neu), `backend/services/invoice-generator.js` (neu), `backend/services/order-automation.js` (neu)

---

### Modul 7: Versand (Courier Integration)

- [ ] **M7: Multi-Carrier Versand-Management** since 2026-03-05
  - ✅ Route `#/orders/shipping` aktiv mit Placeholder-View
  - **Konzept:** Zentrale Versandverwaltung. Mehrere Carrier (DHL, DPD, GLS, Hermes, UPS, Deutsche Post), Label-Druck, Tracking, automatische Carrier-Wahl basierend auf Regeln.
  - **Versand-View (`#/shipping`):**
    - [ ] KPI-Cards: Heute versendet, Pakete in Zustellung, Zustellquote, Ø Versandkosten
    - [ ] Tab-Bar: Ausstehend (zu versenden) | In Zustellung | Zugestellt | Probleme
    - [ ] Tabelle: Auftrag-ID, Kunde, Carrier (Logo-Badge), Tracking-Nummer (klickbar → Tracking-URL), Status, Versanddatum, Zustelldatum (geschätzt), Versandkosten
    - [ ] "Label drucken" — Einzel oder Bulk (Multi-Label-PDF)
    - [ ] Carrier-Auswahl: Bei Einzelversand → Dropdown mit konfigurierten Carriern + geschätzten Kosten
  - **Versand-Regeln (Automatisierung):**
    - [ ] Rule-Engine: "Wenn Gewicht < 1kg UND Inland → Deutsche Post Warenpost"
    - [ ] "Wenn Gewicht > 5kg → DHL Paket"
    - [ ] "Wenn Expressversand → DPD Express"
    - [ ] Default-Carrier konfigurierbar
  - **Tracking-Integration:**
    - [ ] Tracking-Status automatisch von Carrier-API abrufen (Polling oder Webhook)
    - [ ] Status-Updates an Marktplatz-API weiterleiten (eBay: Upload Tracking, Kaufland: Confirm Shipment)
    - [ ] Kunde erhält Tracking-Info automatisch
  - **Backend:**
    - [ ] Existiert: `lib/sendcloud.js` (nur SendCloud, hardcoded)
    - [ ] Erweitern: Multi-Carrier-Abstraction-Layer
    - [ ] `services/shipping.js` — `createShipment()`, `getLabel()`, `getTracking()`, `listCarriers()`
    - [ ] Carrier-Adapter: `lib/carrier-dhl.js`, `lib/carrier-dpd.js`, `lib/carrier-gls.js`, etc.
    - [ ] Carrier-Config aus Firestore (nicht ENV) — via Integrations-Management
  - **Dateien:** `components/ShippingView.tsx` (neu), `components/ShippingRules.tsx` (neu), `backend/services/shipping.js` (neu), `backend/lib/carrier-*.js` (neu)

---

### Modul 8: Retouren (Returns Management)

- [ ] **M8: Retouren-Management** since 2026-03-05
  - ✅ Route `#/orders/returns` aktiv mit Placeholder-View
  - **Konzept:** Return-Requests entgegennehmen, Grund kategorisieren, Rückerstattung auslösen, Ware prüfen, wieder einlagern oder entsorgen.
  - **Retouren-View (`#/returns`):**
    - [ ] KPI-Cards: Offene Retouren, Retourenquote (%), Erstattungen diese Woche, Ø Bearbeitungszeit
    - [ ] Tab-Bar: Neu eingegangen | In Prüfung | Erstattet | Abgeschlossen | Abgelehnt
    - [ ] Tabelle: Retoure-ID, Auftrag-ID, Kunde, Produkt(e), Retourengrund (Badge), Eingang-Datum, Status, Erstattungsbetrag, Aktionen
  - **Retouren-Gründe (kategorisiert):**
    - [ ] "Defekt/Beschädigt", "Falsche Lieferung", "Nicht wie beschrieben", "Zu spät geliefert", "Meinungsänderung", "Doppelbestellung", "Sonstiges"
    - [ ] Pro Marktplatz: Marketplace-spezifische Gründe mappen (eBay Return Reasons → interne Kategorien)
  - **Retouren-Workflow:**
    - [ ] Schritt 1: Retoure eingeht (automatisch via Marketplace-API oder manuell)
    - [ ] Schritt 2: Ware prüfen — Zustand bewerten (A-Ware → Wiederverkauf, B-Ware → Reduziert, C-Ware → Entsorgung)
    - [ ] Schritt 3: Erstattung — Voll, Teilweise, oder Ablehnung (mit Begründung)
    - [ ] Schritt 4: Wiedereinlagerung — Wenn A/B-Ware: Zurück ins Inventar mit neuem Zustand
    - [ ] Schritt 5: Abschluss — Marketplace-API-Update (Refund Issued, Return Closed)
  - **Backend:**
    - [ ] `backend/routes/returns.js` (neu) — CRUD für Retouren
    - [ ] `backend/services/returns.js` (neu) — processReturn(), issueRefund(), restockItem()
    - [ ] Firestore Collection: `returns` — {returnId, orderId, items, reason, status, refundAmount, condition, ...}
    - [ ] Marketplace-Integration: eBay GetReturnRequests, Kaufland Returns-API
  - **Dateien:** `components/ReturnsView.tsx` (neu), `components/ReturnDetail.tsx` (neu), `backend/routes/returns.js` (neu), `backend/services/returns.js` (neu)

---

### Modul 9: Integrationen

- [ ] **M9: Integrations-Hub — User kann selbst Marktplätze & Services verbinden** since 2026-03-05
  - ✅ Route `#/integrations` aktiv mit Placeholder-View, Sidebar-Link vorhanden
  - ⚠️ **KRITISCHSTER GAP:** Ohne Self-Service-Integrationen ist AvyCloud nicht als Produkt nutzbar. Aktuell alles hardcoded via ENV-Variablen.
  - **Integrations-Hub View (`#/integrations`):**
    - [ ] Page-Header: "Integrationen" + "Verbundene Services: {n}"
    - [ ] Tab-Bar: Marktplätze | Versand | Buchhaltung | Sonstiges
    - [ ] **Marktplätze-Tab:**
      - [ ] Grid von Integration-Cards (3 pro Reihe, responsive 2 auf Tablet, 1 auf Mobile):
        - eBay (Logo, "Verbunden ✓" oder "Nicht verbunden", Letzter Sync, "Konfigurieren" / "Verbinden" Button)
        - Kaufland (analog)
        - Amazon (Coming Soon Badge)
        - Otto Market (Coming Soon Badge)
        - Zalando (Coming Soon Badge)
        - Kleinanzeigen (Coming Soon Badge)
        - Hood.de (Coming Soon Badge)
        - Avocadostore (Coming Soon Badge)
        - Etsy DE (Coming Soon Badge)
      - [ ] Card-Design:
        - Verbunden: Grüner Border-Top (2px --success), Service-Logo (40px), Name, Status "Verbunden" (grüner Dot), Letzter Sync Timestamp, Buttons: "Konfigurieren" (Primary) + "Trennen" (Ghost Danger)
        - Nicht verbunden: Default Border, Service-Logo (40px, leicht muted), Name, Status "Nicht verbunden" (grauer Dot), Button: "Verbinden" (Primary)
        - Coming Soon: Grauer Border, Logo (muted, 40% opacity), Name, "Demnächst verfügbar" Badge, Button: "Benachrichtigen" (Ghost) → E-Mail-Interesse speichern
    - [ ] **Versanddienstleister-Tab:**
      - [ ] DHL (Geschäftskundenportal API), DPD, GLS, Hermes, UPS, Deutsche Post (Warenpost), SendCloud (Aggregator)
      - [ ] Pro Carrier: Logo, Name, Beschreibung ("Pakete bis 31.5kg, DE + International"), Status, API-Key-Felder
      - [ ] Gleiche Card-Struktur wie Marktplätze (Verbunden/Nicht verbunden)
    - [ ] **Finanzen & Steuern-Tab:**
      - [ ] SevDesk (Buchhaltung + Rechnungen)
      - [ ] lexoffice (Buchhaltung)
      - [ ] DATEV (Steuerberater-Export)
      - [ ] Xero (International)
      - [ ] invoiceFetcher / GetMyInvoices (Belegerfassung)
      - [ ] Stripe (Payment Processing — für eigenen Webshop)
    - [ ] **Shops-Tab (NEU):**
      - [ ] Shopify (API, Produkt-Sync, Order-Import)
      - [ ] WooCommerce (REST API, bidirektionaler Sync)
      - [ ] Wix (eCommerce API)
      - [ ] Shopware (REST API)
      - [ ] PrestaShop
      - [ ] Alle Coming Soon außer die bereits integrierten
    - [ ] **Andere-Tab (NEU):**
      - [ ] BaseLinker (Middleware, bereits integriert)
      - [ ] Make.com / Zapier (Webhook-basierte Automation)
      - [ ] Slack (Benachrichtigungen: Neuer Auftrag, Niedrig-Bestand, Sync-Fehler)
      - [ ] Zendesk (Kunden-Support-Tickets aus Aufträgen erstellen)
      - [ ] Stripe (Payment Gateway)
      - [ ] Google Sheets (Export/Import)
      - [ ] Webhook (Generisch — eigene Endpoints konfigurieren)
  - **Integration-Wizard (pro Integration):**
    - [ ] Step 1: Marktplatz/Service Übersicht (Was kann diese Integration? Feature-Liste)
    - [ ] Step 2: Authentifizierung (OAuth-Flow mit Redirect ODER API-Key/Secret-Eingabe — je nach Service)
    - [ ] Step 3: Sync-Konfiguration (Was syncen: Produkte ✓, Aufträge ✓, Preise ✓. Wie oft: Echtzeit / 15min / 30min / 1h / Manuell)
    - [ ] Step 4: Test-Verbindung (API-Call, Ergebnis anzeigen: "Verbindung erfolgreich! 342 Produkte gefunden." oder Fehler)
    - [ ] Step 5: Aktivieren — Integration ist live
  - **Integration-Settings (pro verbundener Integration):**
    - [ ] Connection-Status: Verbunden seit {Datum}, Letzter Sync {Datum/Uhrzeit}, Nächster Sync {Datum/Uhrzeit}
    - [ ] Sync-Einstellungen: Intervall ändern, was wird gesynct, Richtung (bidirektional/nur Import/nur Export)
    - [ ] Kategorie-Mapping: AvyCloud-Kategorie → Marktplatz-Kategorie (Tabelle mit Dropdown-Mapping)
    - [ ] Preis-Regeln pro Marktplatz: Aufschlag/Abzug (%, €), Mindestpreis, Rundung
    - [ ] Fehler-Log: Letzte Sync-Fehler mit Timestamp, Error-Message, betroffenes Produkt
    - [ ] "Trennen" Button (Disconnect) mit Bestätigung
  - **Backend:**
    - [ ] `backend/routes/integrations.js` (neu) — CRUD für Integrationen
    - [ ] `backend/services/integration-store.js` (neu) — Credentials verschlüsselt in Firestore speichern/lesen
    - [ ] Firestore Collection: `integrations` — {id, type: "ebay"|"kaufland"|..., credentials: {encrypted}, settings: {syncInterval, syncProducts, syncOrders, ...}, status: "active"|"error"|"disconnected", lastSync, lastError}
    - [ ] Credential-Verschlüsselung: AES-256-GCM mit Key aus Google Secret Manager (nicht im Code)
    - [ ] Migration: Bestehende ENV-Variablen → Firestore, ENV als Fallback
    - [ ] Alle bestehenden API-Clients refactorn: `lib/ebay-oauth.js`, `lib/kaufland-api.js`, `lib/baselinker-*.js`, `lib/sendcloud.js`, `lib/sevdesk.js` → Credentials aus integration-store lesen statt process.env
  - **Dateien:** `components/IntegrationsHub.tsx` (neu), `components/IntegrationWizard.tsx` (neu), `components/IntegrationSettings.tsx` (neu), `backend/routes/integrations.js` (neu), `backend/services/integration-store.js` (neu)

---

### Modul 10: Analytics & Reporting

- [ ] **M10: Dashboard & Reporting Enterprise-Grade** since 2026-03-05
  - ✅ Bestehendes Dashboard funktional (Revenue KPIs, Orders, Shipping-Kosten)
  - **Dashboard überarbeiten:**
    - [ ] Revenue-KPIs: Umsatz heute, Umsatz Monat, Umsatz YTD — mit Trend-Pfeil (↑ +12% vs. Vormonat)
    - [ ] Order-KPIs: Aufträge heute, Offene Aufträge, Ø Bestellwert, Retourenquote
    - [ ] Inventory-KPIs: Artikel im Bestand, Gesamtwert, Niedrig-Bestand Alerts, Out-of-Stock
    - [ ] Umsatz-Chart: Dual-Axis (Umsatz + Auftragsanzahl) mit Zeitraum-Selector (7T/30T/90T/YTD/Custom)
    - [ ] Umsatz nach Marktplatz: Stacked Bar-Chart oder Pie-Chart (eBay vs. Kaufland vs. Direkt)
    - [ ] Aktivitäts-Feed: Letzte Aktionen (Produkt erstellt, Auftrag eingegangen, Listing gesynct, etc.) — Live-Updates
    - [ ] Marktplatz-Übersicht: Mini-Cards pro verbundenem Marktplatz (Status, Aktive Listings, Umsatz 30d)
  - **Reporting-Seite (NEU, unter Einstellungen oder eigener Nav-Punkt):**
    - [ ] Vordefinierte Reports:
      - "Umsatzreport" (Zeitraum, pro Marktplatz, pro Kategorie)
      - "Bestandsreport" (Aktueller Bestand, Wert, Bewegungen)
      - "Margenreport" (EK vs. VK vs. Gebühren vs. Versand = Nettomarge)
      - "Bestseller/Slowmover" (Top 20 Verkäufe, Bottom 20 ohne Verkäufe seit X Tagen)
      - "Retourenreport" (Quoten pro Marktplatz, Top-Retourengründe)
    - [ ] Export: CSV, Excel (.xlsx), PDF
    - [ ] Zeitraum wählbar, Marktplatz filterbar
  - **Backend:**
    - [ ] `backend/routes/reports.js` (neu) — GET `/api/reports/:type?from=&to=&marketplace=`
    - [ ] `backend/services/analytics.js` (neu) — Aggregation-Queries auf Firestore (oder BigQuery-Export für Performance)
  - **Dateien:** `components/DashboardView.tsx` (überarbeiten), `components/ReportsView.tsx` (neu), `backend/routes/reports.js` (neu), `backend/services/analytics.js` (neu)

---

### Modul 12: Lagerverwaltung (Warehouse)

- [ ] **M12: Lagerverwaltung — Zonen, Bins, Einstellungen** since 2026-03-05
  - Routes `#/warehouse` + `#/warehouse/settings` aktiv (⚠️ aktuell Placeholder → MUSS ersetzt werden)
  - **Konzept:** Verwaltung der physischen Lagerstruktur. Zonen, Regale, Bins definieren. Lagerplatz-Zuordnung, Umlagern, Inventur. NICHT das gleiche wie "Bestand" (M4) — M4 zeigt Artikel+Mengen, M12 verwaltet WO die Artikel liegen.
  - **Lagerverwaltung-View (`#/warehouse`):**
    - [ ] Page-Header: "Lagerverwaltung" + Counter "{n} Lagerorte"
    - [ ] KPI-Cards: Gesamte Bins, Belegte Bins (%), Freie Bins, Lagerbewegungen heute
    - [ ] Tab-Bar: Zonen | Bins | Inventur | Bewegungen
    - [ ] **Zonen-Tab:**
      - [ ] Grid von Zone-Cards: Zone-Name (z.B. "Regal A", "Hochregal 1", "Kleinteile"), Anzahl Bins, Belegung (%), Erstellt-Datum
      - [ ] "Zone anlegen" Button → Modal: Name, Beschreibung, Typ (Regal/Palette/Kleinteile/Kühlung)
      - [ ] Klick auf Zone → Zeigt Bins innerhalb dieser Zone
    - [ ] **Bins-Tab:**
      - [ ] Tabelle: Bin-Code (z.B. "A-01-03"), Zone, Typ (Standard/Palette/Kleinteile), Status (Frei/Belegt/Gesperrt), Inhalt (Produktname + Menge oder "Leer"), Kapazität (%), Letzte Bewegung
      - [ ] Filter: Zone, Status (Frei/Belegt/Gesperrt), Typ
      - [ ] "Bin anlegen" Button → Modal: Code (Auto-Generierung oder manuell), Zone (Dropdown), Typ, Max-Kapazität
      - [ ] Aktionen pro Bin: "Inhalt anzeigen", "Sperren/Freigeben", "Umbenennen", "Löschen" (nur wenn leer)
    - [ ] **Inventur-Tab:**
      - [ ] Inventur starten: Zone oder Bin-Bereich wählen → Inventur-Auftrag erstellen
      - [ ] Inventur-Liste: Bin-Code, Soll-Bestand (System), Ist-Bestand (gezählt), Differenz, Status (Offen/Geprüft/Abgeschlossen)
      - [ ] Ist-Bestand Eingabe: Inline-Edit in Tabelle oder per Barcode-Scanner (Mobile)
      - [ ] Abschluss: Differenzen bestätigen → Bestand automatisch korrigiert
      - [ ] Inventur-Protokoll als PDF exportieren
    - [ ] **Bewegungen-Tab:**
      - [ ] Timeline/Tabelle: Zeitstempel, Typ (Einlagerung/Auslagerung/Umlagerung/Korrektur), Produkt, Menge, Von-Bin, Nach-Bin, User
      - [ ] Filter: Typ, Zeitraum, Produkt, Zone
      - [ ] Export als CSV
  - **Lager-Einstellungen (`#/warehouse/settings`):**
    - [ ] **Bin-Logik:** Auto-Zuweisung aktivieren (ja/nein), Vergabe-Strategie (FIFO, nächste freie, gleicher Artikel zusammen)
    - [ ] **Zonen-Typen:** Custom Zonen-Typen definieren (Name, Icon, Standard-Kapazität)
    - [ ] **Barcode-Einstellungen:** Barcode-Format für Bins (Code128, QR), Prefix, Label-Druck-Template
    - [ ] **Reorder-Thresholds:** Default-Mindestbestand pro Zone oder Global, Alarm-Schwelle (z.B. < 5 Einheiten)
    - [ ] **Inventur-Einstellungen:** Pflicht-Inventur-Intervall (Monatlich/Quartalsweise/Jährlich), Inventur-Reminder
  - **Backend:**
    - [ ] `backend/routes/warehouse.js` (neu) — CRUD für Zonen, Bins, Inventur, Bewegungen
    - [ ] `backend/services/warehouse.js` (neu) — createZone(), createBin(), moveToBin(), startInventory(), completeInventory()
    - [ ] Firestore Collections:
      - `warehouse_zones` — {id, name, type, description, binCount, ...}
      - `warehouse_bins` — {id, code, zoneId, type, status, maxCapacity, currentItems: [{productId, quantity}], ...}
      - `warehouse_movements` — {id, type, productId, quantity, fromBin, toBin, userId, timestamp}
      - `warehouse_inventories` — {id, status, zone, bins: [{binId, expected, counted, diff}], startedAt, completedAt}
    - [ ] Existiert teilweise: `lib/warehouse.js` mit bin-Logik — erweitern, nicht ersetzen
  - **Dateien:** `components/WarehouseView.tsx` (neu), `components/warehouse/ZonesTab.tsx`, `components/warehouse/BinsTab.tsx`, `components/warehouse/InventoryTab.tsx`, `components/warehouse/MovementsTab.tsx`, `components/WarehouseSettings.tsx` (neu), `backend/routes/warehouse.js` (neu), `backend/services/warehouse.js` (neu)

---

### Modul 13: Erfassen (KI-Identify Flow)

- [ ] **M13: Erfassen — KI-gestützte Produkterkennung als geführter Flow** since 2026-03-05
  - Route `#/products/identify` aktiv (⚠️ aktuell Placeholder → MUSS ersetzt werden)
  - ✅ Backend komplett vorhanden: `services/enrichment.js`, `services/improve.js`, `lib/gemini-structured.js`, `lib/image-search.js`, `services/job-runner.js`
  - **Konzept:** AvyClouds USP. Benutzer fotografiert/uploaded ein Produkt → KI erkennt automatisch: Was ist es? Marke? Modell? EAN? Preis? Der User bestätigt/korrigiert → Produkt wird im Katalog angelegt. Dies ist der Haupt-Workflow für Eingangsware.
  - **Erfassen-View (`#/products/identify`) — Stepper-Flow:**
    - [ ] **`ui/Stepper`-Component:** 5 Schritte, horizontal, aktiver Schritt hervorgehoben
    - [ ] **Schritt 1: Bild hochladen**
      - [ ] Drag & Drop Zone (zentral, groß, mind. 300px Höhe)
      - [ ] "Datei wählen" Button als Alternative
      - [ ] Kamera-Button (Mobile: öffnet Kamera direkt)
      - [ ] Mehrere Bilder möglich (Thumbnails unterhalb)
      - [ ] Akzeptierte Formate: JPG, PNG, WEBP, max 20MB
      - [ ] Upload-Progress-Bar
      - [ ] "Weiter" Button (Primary, nur aktiv wenn mind. 1 Bild)
    - [ ] **Schritt 2: KI-Erkennung (automatisch)**
      - [ ] Progress-Screen: "Produkt wird analysiert..."
      - [ ] Animierter Fortschritt: Bild-Analyse → Barcode-Scan → Web-Recherche → Preisermittlung → Zusammenfassung
      - [ ] Jeder Sub-Schritt mit Status-Icon (Spinner → Checkmark → Error)
      - [ ] SSE-Stream vom Backend (`useJobStream` Hook) für Live-Progress
      - [ ] Backend-Pipeline: Vision-API → Barcode-Detection → Web-Search → Title Insights → LLM-Synthese → Pricing
      - [ ] Dauer: 15-45 Sekunden typisch
      - [ ] Bei Fehler: Retry-Button + Fallback auf manuelle Eingabe
    - [ ] **Schritt 3: Ergebnisse prüfen & korrigieren**
      - [ ] Erkanntes Hero-Image links (200px)
      - [ ] Rechts: Formular mit vorausgefüllten KI-Ergebnissen:
        - Produktname (editierbar, Input)
        - Marke (editierbar, Input mit Autocomplete aus bestehendem Katalog)
        - Modell (editierbar)
        - EAN/UPC (editierbar, Validierung: 13-stellig, Prüfziffer)
        - Kategorie (Dropdown, vorausgewählt)
        - Zustand (Dropdown: Neu / Gebraucht - Sehr gut / Gebraucht - Gut / Gebraucht - Akzeptabel / Defekt)
        - Beschreibung (Textarea, KI-generiert, editierbar)
      - [ ] KI-Konfidenz pro Feld: Badge "Sicher" (grün, >80%) / "Unsicher" (gelb, 50-80%) / "Geschätzt" (rot, <50%)
      - [ ] Felder mit niedriger Konfidenz: Orange Umrandung, User soll prüfen
      - [ ] "Titel verbessern" Button (KI-Re-Generate mit editiertem Input)
    - [ ] **Schritt 4: Preis & Lager**
      - [ ] KI-Preisvorschlag: Angezeigter Preis + Quelle (eBay Sold, Amazon, etc.) + Konfidenz
      - [ ] Manueller VK-Override (Input)
      - [ ] EK-Eingabe (Input, Pflichtfeld falls bekannt)
      - [ ] Marge (automatisch berechnet: VK - EK, angezeigt als € + %)
      - [ ] Bestand: Menge (Input, Default: 1), Zustand (Dropdown), Lagerplatz/Bin (Dropdown aus existierenden Bins)
      - [ ] Marketplace-Quick-Select: "Direkt auf eBay listen" (Checkbox), "Direkt auf Kaufland listen" (Checkbox)
    - [ ] **Schritt 5: Zusammenfassung & Speichern**
      - [ ] Kompakte Übersicht aller eingegebenen Daten (Read-only)
      - [ ] Hero-Image + Thumbnails
      - [ ] Alle Attribute in 2-Spalten-Grid
      - [ ] Preis + Marge + Lagerplatz
      - [ ] Marktplatz-Optionen
      - [ ] "Speichern" Button (Primary) → `POST /api/v1/products` via `saveProductV2()`
      - [ ] "Speichern & Nächstes erfassen" Button (Secondary) → Speichert + Reset auf Schritt 1
      - [ ] Erfolgs-Toast: "Produkt '{Name}' erfolgreich angelegt!" mit Link zum ProductSheet
  - **Schnell-Erfassung (Alternative zum Stepper):**
    - [ ] Toggle oben: "Geführt" (Stepper, Default) / "Schnell" (Single-Page)
    - [ ] Schnell-Modus: Bild-Upload + Mini-Formular auf einer Seite, KI läuft im Hintergrund, Felder füllen sich live
    - [ ] Für erfahrene User die viele Produkte hintereinander erfassen
  - **Mobile-Optimierung:**
    - [ ] Camera-First: Upload-Zone ist auf Mobile ein großer Kamera-Button
    - [ ] Swipe-Navigation zwischen Stepper-Schritten
    - [ ] Barcode-Scanner-Button (Mobile Kamera → Barcode erkennen → EAN ausfüllen)
  - **Backend (existiert, Verbindung herstellen):**
    - [ ] `POST /api/v1/identify` → startet Job → SSE-Stream über `GET /api/v1/identify/:jobId/stream`
    - [ ] Pipeline in `services/enrichment.js`: `runFullIdentification()` → Vision + Barcode + Web + Pricing
    - [ ] `services/improve.js`: `improveProduct()` für Titel/Beschreibung-Optimierung
    - [ ] `saveProductV2()` am Ende des Flows
    - [ ] Existierende Hooks: `useJobStream.ts` für SSE-Progress
  - **Dateien:** `components/IdentifyView.tsx` (komplett neu als Stepper-Flow), `components/identify/StepUpload.tsx`, `components/identify/StepAnalysis.tsx`, `components/identify/StepReview.tsx`, `components/identify/StepPricing.tsx`, `components/identify/StepSummary.tsx`

---

### Modul Bonus: Automatisierung & Bulk-Operationen

- [ ] **M-AUTO: Workflow-Automatisierung & Bulk-Import/Export** since 2026-03-05
  - ✅ Pricing Engine existiert backend-only (`services/pricing-engine.js`), AdminTable hat bereits Bulk-Actions (Sync, Improve, Delete, Label, eBay/Kaufland)
  - **Bulk-Import/Export:**
    - [ ] Import: CSV/Excel Upload → Produkte, Preise oder Bestände aktualisieren
    - [ ] Template-Download: Leere Excel-Vorlage mit korrekten Spalten
    - [ ] Import-Preview: Vorschau der Änderungen vor Ausführung (Zeile für Zeile, Fehler markiert)
    - [ ] Export: Produkte, Bestand, Aufträge als CSV/Excel mit konfigurierbaren Spalten
  - **Repricing-Engine (existiert Backend-only, braucht UI):**
    - [ ] Repricing-Dashboard: Aktive Regeln, letzte Preisänderungen, Savings
    - [ ] Regel-Editor: "Wenn Wettbewerber-Preis < mein Preis → unterbiete um X€/X%"
    - [ ] Mindestmarge-Schutz: Nie unter EK + definierte Marge verkaufen
    - [ ] Pro Marktplatz: Separate Pricing-Regeln
    - [ ] Schedule: Repricing alle X Stunden oder manuell
  - **Workflow-Builder (Phase 2 — nach Launch):**
    - [ ] Visueller Editor (If-Then Regeln, kein Code): Trigger → Bedingung → Aktion
    - [ ] Beispiele: "Wenn Bestand < 5 → eBay-Listing pausieren", "Wenn neues Produkt erfasst → Auto-Improve starten"
    - [ ] Dies ist ein Phase-2-Feature nach dem initialen Launch
  - **Dateien:** `components/BulkImportView.tsx` (neu), `components/RepricingDashboard.tsx` (neu), `backend/routes/bulk.js` (erweitern), `backend/services/pricing-engine.js` (existiert, UI anbinden)

---

### Modul 11: Einstellungen (Settings)

- [ ] **M11: Einstellungen-Bereich komplett neu** since 2026-03-05
  - ✅ Routes `#/settings`, `#/settings/profile`, `#/settings/team`, `#/settings/api`, `#/settings/billing` aktiv
  - ✅ Sidebar EINSTELLUNGEN-Gruppe mit allen Sub-Items, ⚠️ Placeholder-Views vorhanden → MÜSSEN durch echte Implementierungen ERSETZT werden
  - ✅ `#/settings/team` rendert bestehendes AdminPanel (User/Role-Management)
  - **Konzept:** Zentraler Bereich für Unternehmens-, User- und System-Konfiguration. Ersetzt den bisherigen "Admin"-Bereich mit einer klareren Struktur.
  - **Unternehmensdaten (`#/settings`):**
    - [ ] Firmenname, Rechtsform, USt-IdNr., Steuernummer
    - [ ] Adresse (Straße, PLZ, Ort, Land)
    - [ ] Logo-Upload (für Rechnungen, Lieferscheine, E-Mails)
    - [ ] Bankverbindung (IBAN, BIC, Bank — für Rechnungs-Templates)
    - [ ] Kontakt-E-Mail, Telefon, Website
    - [ ] Impressum-Daten (für Marketplace-Listings)
  - **Persönliche Daten (`#/settings/profile`):**
    - [ ] Name, E-Mail, Telefon
    - [ ] Passwort ändern
    - [ ] Profilbild/Avatar
    - [ ] Benachrichtigungs-Präferenzen (E-Mail bei: Neuer Auftrag, Niedrig-Bestand, Sync-Fehler, Retoure)
    - [ ] Theme-Präferenz (Dark/Light/System)
  - **Mitarbeiter & Rollen (`#/settings/team`):**
    - [ ] Mitarbeiter-Liste: Name, E-Mail, Rolle, Status (Aktiv/Deaktiviert), Letzter Login
    - [ ] "Mitarbeiter einladen" Button → E-Mail-Einladung
    - [ ] Rollen-Management: Admin, Manager, Lagermitarbeiter, Viewer (oder Custom)
    - [ ] Berechtigungen pro Rolle: Welche Module sichtbar (Aufträge ✓, Produkte ✓, Einstellungen ✕), welche Aktionen erlaubt (Lesen/Schreiben/Löschen)
    - [ ] Existiert teilweise: `AdminRoleManagement.tsx`, `AdminUserManagement.tsx` — in neues UI migrieren
  - **API-Verwaltung (`#/settings/api`):**
    - [ ] API-Keys generieren / widerrufen
    - [ ] Webhook-Konfiguration: Endpoints, Events (order.created, product.updated, etc.), Secret
    - [ ] API-Usage-Stats: Requests/Tag, Rate-Limit-Status
    - [ ] API-Dokumentation Link (→ Swagger/OpenAPI, wenn verfügbar)
  - **Plan & Abrechnung (`#/settings/billing`):**
    - [ ] Aktueller Plan: Name, Preis, Features, Limits
    - [ ] Usage-Anzeige: Produkte (342 / 1.000), Aufträge/Monat (89 / 500), Integrationen (2 / 5), API-Calls
    - [ ] Plan upgraden / downgraden
    - [ ] Zahlungsmethode verwalten (Stripe-Integration → "Waiting On")
    - [ ] Rechnungshistorie: Datum, Betrag, PDF-Download
    - [ ] ⚠️ Stripe-Integration ist in "Waiting On" — UI kann vorbereitet werden mit Placeholder-Daten
  - **Backend:**
    - [ ] Existiert teilweise: `routes/admin.js`, `lib/rbac.js`
    - [ ] NEU: `routes/settings.js` — Unternehmens-, Profil-, Team-CRUD
    - [ ] NEU: Firestore Collection `company_settings` — {companyName, address, logo, taxId, bankDetails, ...}
    - [ ] Erweiterung `routes/auth.js` — Profil-Update, Passwort-Change
  - **Dateien:** `components/SettingsView.tsx` (neu, Tab-basiert), `components/settings/CompanySettings.tsx`, `components/settings/ProfileSettings.tsx`, `components/settings/TeamSettings.tsx`, `components/settings/ApiSettings.tsx`, `components/settings/BillingSettings.tsx`, `backend/routes/settings.js` (neu)

---

### Bestehende Tasks (beibehalten)

- [ ] **P0: Identify-Modul stärken — API-Nutzung koordinieren**
  - ✅ Preisanreicherung Doppel-Gate aufgetrennt (2026-03-03)
  - ✅ eBay Title Insights: Keyword-Fallback (2026-03-03)
  - ✅ Dedizierte `image-search.js` (2026-03-04)
  - ✅ `enrichment.js::runSmartImageRecovery()` nutzt `image-search.js` (2026-03-04)
  - **Offen:** Orchestrierte Enrichment-Pipeline: Vision → Barcode → Web-Recherche → Title Insights → LLM-Synthese
  - **Dateien:** `enrichment.js`, `image-search.js`

- [ ] **P1: Monitoring & Error-Tracking** — Wenn ein Runner hängt merkt das niemand
  - Sentry, Uptime-Monitoring, Job-Health-Dashboard, Alerts

- [x] **P1: UI/UX — Accessibility (WCAG 2.1 AA)** ~~In Arbeit~~ (2026-03-05)
  - ✅ AdminTable, GeminiChat, ProductSheet, EbayListingsView, MobileOperationsView (2026-03-04)
  - ✅ Keyboard-Navigation, Sidebar Arrow-Keys (2026-03-05)
  - ✅ MobileTabBar: `role="tablist"` + `role="tab"` + `aria-selected` Pattern (2026-03-05)

---

## Waiting On

- [ ] **Multi-Tenancy (P3)** — Blocker für SaaS. Nur mit expliziter Anweisung. since 2026-03-01
- [ ] **Stripe Billing (P3)** — Blocker für SaaS. Nur mit expliziter Anweisung. since 2026-03-01

## Someday

- [ ] GDPR-Compliance — Data Export, Deletion, Privacy Policy, DPA-Template
- [ ] API-Dokumentation (OpenAPI/Swagger)
- [ ] Zapier/Make.com Integration
- [ ] E2E-Tests mit Playwright
- [ ] Token-in-Query-Parameter fixen — JWT als URL-Param leakt in Logs
- [ ] Request Body Limit 50MB → 10MB
- [ ] CI-Integration für Tests
- [ ] Mobile App (React Native)
- [ ] White-Label-Option
- [ ] KI-Bildoptimierung ausbauen

## Done

- [x] ~~P1: UI/UX — AdminTable aufteilen~~ (2026-03-05) — AdminTableHeader, AdminTableRow, BulkActions, AdminTableFilters extrahiert
- [x] ~~P0: Listing-Status Frontend-Badge~~ (2026-03-04)
- [x] ~~P1: Chat Intent-Detection per LLM~~ (2026-03-04)
- [x] ~~P2: Formular-Validierung~~ (2026-03-04)
- [x] ~~P2: Polling durch SSE ersetzen~~ (2026-03-04)
- [x] ~~P0: Image-Generator Background Removal~~ (2026-03-04)
- [x] ~~P1: Job-Timeout + Dead-Letter-Queue~~ (2026-03-04)
- [x] ~~P1: Code-Splitting~~ (2026-03-04)
- [x] ~~P1: Chat-Qualität verbessern~~ (2026-03-04)
- [x] ~~P2: Error Boundary~~ (2026-03-04)
- [x] ~~P2: State Management~~ (2026-03-04)
- [x] ~~P0: Listing-Status Realtime-Sync~~ (2026-03-04)
- [x] ~~P0: Schreibpfade auf saveProductV2()~~ (2026-03)
- [x] ~~P0: Pricing Engine produktionsreif~~ (2026-03)
- [x] ~~P0: eBay/Kaufland Update synct Preis~~ (2026-03)
- [x] ~~P0: Marketplace Listing-Status automatisch~~ (2026-03)
- [x] ~~P0: Konkurrenzpreise-System~~ (2026-03)
- [x] ~~P0: LLM Titel-Generierung~~ (2026-03)
- [x] ~~P1: Integration-Tests~~ (2026-03)
- [x] ~~P1: CLAUDE.md aktualisieren~~ (2026-03)
- [x] ~~P0-001: Security Headers (Helmet.js)~~ (2026-02)
- [x] ~~P0-002: Rate-Limiting~~ (2026-02)
- [x] ~~P0-003: .env.local aus Git-Historie~~ (2026-02)
- [x] ~~P0-004: Firestore Normalisierung~~ (2026-02)
- [x] ~~P1-001: Structured Logging (Pino)~~ (2026-02)
- [x] ~~P1-002: Health-Check & Graceful Shutdown~~ (2026-02)
- [x] ~~P1-003: Vitest Infrastruktur~~ (2026-02)
- [x] ~~P1-004: Error Response Standardisierung~~ (2026-02)
- [x] ~~P1-005: Express Router Splitting~~ (2026-02)
- [x] ~~P1-006: API Versioning~~ (2026-02)
- [x] ~~P2-001: SSE für Job-Status~~ (2026-02)
- [x] ~~P2-002: Pricing Engine~~ (2026-02)
- [x] ~~P2-003: Inventory Forecasting~~ (2026-02)
- [x] ~~P2-004: Webhook-System~~ (2026-02)
- [x] ~~P2-005: Produkt-Deduplizierung~~ (2026-02)
- [x] ~~P3-001: Competitor Intelligence~~ (2026-02)

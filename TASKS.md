# Tasks

> **ZIEL: AvyCloud marktreif machen.** Enterprise-Grade Multi-Channel E-Commerce Hub.
> Benchmark: ChannelEngine, Channable, Linnworks, Plentymarkets, Billbee.
> AvyCloud-Vorteil: KI-gestützte Produkterkennung + Enrichment (kein Wettbewerber hat das).

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

- [ ] **M2: Sidebar, Topbar & Routing komplett überarbeiten** since 2026-03-05
  - **Sidebar — Neue Struktur:**
    - **ÜBERSICHT**
      - [ ] Dashboard (Icon: LayoutDashboard)
    - **KATALOG**
      - [ ] Produkte (Icon: Package) — Produktstammdaten, Enrichment, KI
      - [ ] Bestand (Icon: Warehouse) — Lagerbestand, Bins, Mengen, NUR Marketplace-Indikatoren (Badges)
      - [ ] Kategorien (Icon: FolderTree)
    - **MARKTPLÄTZE** (dynamisch — nur verbundene Marktplätze anzeigen)
      - [ ] eBay (Icon: ShoppingBag) — NUR wenn eBay-Integration aktiv. Listing-Management, Sync, Performance
      - [ ] Kaufland (Icon: Store) — NUR wenn Kaufland-Integration aktiv
      - [ ] (Amazon, Otto, Zalando — erscheinen automatisch wenn Integration verbunden)
      - [ ] ⚠️ **"eBay (Gap Analysis)" Link ENTFERNEN** — wird nicht mehr benötigt, Gap-Infos in die jeweilige Listing-View integrieren
    - **AUFTRÄGE**
      - [ ] Aufträge (Icon: ClipboardList) — Multi-Channel Order Management
      - [ ] Retouren (Icon: RotateCcw) — Return Management
      - [ ] Versand (Icon: Truck) — Carrier-Management, Labels, Tracking
    - **LAGER**
      - [ ] Lager (Icon: MapPin) — Zonen, Bins, Auslastung
      - [ ] Erfassen (Icon: ScanLine) — KI-Produkterkennung
      - [ ] Operationen (Icon: PackageCheck) — Einlagern, Kommissionieren, Verpacken
    - **SYSTEM**
      - [ ] Integrationen (Icon: Plug) — Marketplace-/Shipping-/Accounting-Verbindungen
      - [ ] Einstellungen (Icon: Settings) — Admin, User, Rollen, Regeln
  - **Sidebar — UI/UX Details:**
    - [ ] Breite: 240px (expanded), 64px (collapsed, Icon-Only)
    - [ ] Collapse-Toggle: Button oben (Hamburger oder Chevron)
    - [ ] Aktiver Nav-Punkt: Accent-Left-Border (3px) + leichter Background (--accent mit 10% opacity)
    - [ ] Gruppen-Labels: 11px, Uppercase, Letter-Spacing 0.05em, --text-muted, 24px Margin-Top
    - [ ] Nav-Items: 14px, 400 weight, 40px Höhe, 12px Padding-Left, Lucide-Icons (20px, 1.5 Stroke)
    - [ ] Hover: Background --surface, Transition 150ms
    - [ ] Footer: User-Avatar (32px) + Name + Logout-Button, fixed am unteren Rand
    - [ ] Scroll: Wenn Nav-Items Viewport überschreiten → Scroll innerhalb Sidebar, Footer bleibt fixed
  - **Topbar — Bereinigung:**
    - [ ] Links: Page-Title (h2) oder Breadcrumb (Dashboard > Produkte > iPhone 13)
    - [ ] Mitte: Such-Input (max-width 480px, `ui/Input` mit Search-Icon, Cmd+K Shortcut)
    - [ ] Rechts: NUR Theme-Toggle (1x!) + Notification-Bell + User-Avatar mit Dropdown (Profil, Einstellungen, Logout)
    - [ ] Kein Sprach-Selector. Keine doppelten Elemente.
    - [ ] Höhe: 56px, Border-Bottom: 1px --border
  - **Routing anpassen:**
    - [ ] Neue Routes: `#/inventory`, `#/orders`, `#/returns`, `#/shipping`, `#/integrations`
    - [ ] Marketplace-Routes dynamisch: `#/marketplace/ebay`, `#/marketplace/kaufland`, etc.
    - [ ] Route `#/ebay` (alte Gap Analysis) → Redirect zu `#/marketplace/ebay` oder entfernen
  - **Dateien:** `components/Sidebar.tsx`, `components/Topbar.tsx`, `App.tsx` (Routing), `i18n.tsx`

---

### Modul 3: Produkte (Katalog)

- [ ] **M3: Produkte-View Enterprise-tauglich** since 2026-03-05
  - **Page-Header:**
    - [ ] Titel "Produkte" (h1) + Counter "{gefiltert} von {gesamt} Produkte"
    - [ ] Action-Buttons rechts: "Produkt anlegen" (Primary), "Import" (Secondary), "Export" (Secondary)
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
  - **Backend:**
    - [ ] Existiert: `routes/orders.js`, `lib/firestore.js::listOrders()`
    - [ ] Erweitern: Fulfillment-Status-Updates (PATCH `/api/orders/:id/status`), Multi-Channel-Aggregation
    - [ ] Webhook: Bei Status-Änderung → Marketplace-API (eBay: Mark as Shipped, Kaufland: Confirm Shipment)
  - **Dateien:** `components/OrdersView.tsx` (überarbeiten), `components/OrderDetail.tsx` (neu), `backend/routes/orders.js`

---

### Modul 7: Versand (Courier Integration)

- [ ] **M7: Multi-Carrier Versand-Management** since 2026-03-05
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
  - ⚠️ **KRITISCHSTER GAP:** Ohne Self-Service-Integrationen ist AvyCloud nicht als Produkt nutzbar. Aktuell alles hardcoded via ENV-Variablen.
  - **Integrations-Hub View (`#/integrations`):**
    - [ ] Page-Header: "Integrationen" + "Verbundene Services: {n}"
    - [ ] Tab-Bar: Marktplätze | Versand | Buchhaltung | Sonstiges
    - [ ] **Marktplätze-Tab:**
      - [ ] Grid von Marketplace-Cards (3 pro Reihe):
        - eBay (Logo, "Verbunden ✓" oder "Nicht verbunden", Letzer Sync, "Konfigurieren" / "Verbinden" Button)
        - Kaufland (analog)
        - Amazon (Coming Soon Badge)
        - Otto (Coming Soon Badge)
        - Zalando (Coming Soon Badge)
        - Kleinanzeigen (Coming Soon Badge)
      - [ ] Verbundene Cards: Grüner Border-Top, Connection-Info, "Konfigurieren" → Settings-Modal
      - [ ] Nicht verbundene Cards: Muted, "Verbinden" Button → Wizard
      - [ ] Coming Soon Cards: Disabled, Muted, "Benachrichtigen" Button (E-Mail-Interesse)
    - [ ] **Versand-Tab:**
      - [ ] DHL, DPD, GLS, Hermes, UPS, Deutsche Post, SendCloud
      - [ ] Gleiche Card-Struktur: Verbunden/Nicht verbunden
    - [ ] **Buchhaltung-Tab:**
      - [ ] SevDesk, lexoffice, DATEV
    - [ ] **Sonstiges-Tab:**
      - [ ] BaseLinker, Zapier, Make.com (Webhook)
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

### Modul Bonus: Automatisierung & Bulk-Operationen

- [ ] **M-AUTO: Workflow-Automatisierung & Bulk-Import/Export** since 2026-03-05
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

- [ ] **P1: UI/UX — Accessibility (WCAG 2.1 AA)** — In Arbeit
  - ✅ AdminTable, GeminiChat, ProductSheet, EbayListingsView, MobileOperationsView (2026-03-04)
  - ✅ Keyboard-Navigation, Sidebar Arrow-Keys (2026-03-05)
  - **Offen:** MobileTabBar tablist-Pattern

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

## UX/UI Regeln für AvyCloud (Best Practices, kurz & umsetzbar)

### Quellen (Guidelines)
- **W3C WCAG 2.2**: Accessibility-Baseline (u. a. Labels/Headings, Error Assistance, Status Messages). Siehe `https://www.w3.org/TR/WCAG22/`
- **W3C WAI-ARIA APG**: zugängliche Interaktions-Patterns (Button, Disclosure/Show-Hide, Tooltip, Dialog). Siehe `https://www.w3.org/WAI/ARIA/apg/`
  - Button Pattern: `https://www.w3.org/WAI/ARIA/apg/patterns/button/`
  - Disclosure Pattern: `https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/`
- **NN/g (Nielsen Norman Group)**: System-Status Feedback + Error Message Guidelines.
  - Indicators/Validations/Notifications: `https://www.nngroup.com/articles/indicators-validations-notifications/`
  - Error-Message Guidelines: `https://www.nngroup.com/articles/error-message-guidelines/`
- **NHS Digital Service Manual (GOV.UK‑nahe Patterns)**: Error Summary + Error Message Patterns (Fokus, “There is a problem”, Links zu Feldern, Input nicht löschen).
  - Error summary: `https://service-manual.nhs.uk/design-system/components/error-summary`
  - Error message: `https://service-manual.nhs.uk/design-system/components/error-message`

### Regeln (für unsere Admin- & Ops-Flows)
- **Sprache & Begriffe (Match system to the real world)**:
  - Keine internen Jargons ohne Erklärung (GPSR, K‑Typ, BIN, Delta Sync).
  - Buttons benutzen aktive, konkrete Verben (“Sync Auswahl”, “Preis aktualisieren”), kein “OK”.
- **Eine primäre Aktion pro Bereich**:
  - Genau ein Primary Button pro Action-Cluster (z. B. im Inventar: “Sync Auswahl”).
  - Alles andere Secondary/Outline; “Danger” nur für irreversible Aktionen.
- **Status/Feedback immer sichtbar** (NN/g):
  - Wähle passend: **Indicator** (passiv, kontextnah) vs **Validation** (User muss etwas fixen) vs **Notification** (System‑Event).
  - Fehler/Status **nah an der Ursache** anzeigen (nicht nur per `alert()`).
- **Fehlertexte sind handlungsfähig** (NN/g + NHS):
  - “Was ist passiert?” + “Wie fixe ich es?” (keine generischen “Failed…” Texte).
  - Input nie “löschen” beim Fehler (NHS verweist u. a. auf WCAG 2.2 Redundant Entry).
- **Progressive Disclosure / Hilfe in-place** (WAI‑ARIA APG Disclosure):
  - Jede komplexe Seite hat eine kurze “Was kann ich hier tun?” Sektion, aufklappbar (`aria-expanded`/`aria-controls`).
  - Hilfe ist **konsistent platziert** (WCAG 2.2 – Consistent Help).
- **A11y für Buttons & Status** (WAI‑ARIA APG + WCAG):
  - Actions sind echte `<button>` (keine Links die wie Buttons aussehen).
  - Status-Messages sind screenreader-kompatibel (WCAG 2.2: Status Messages) → `role="status"` / `role="alert"` je nach Schwere.

### AvyCloud Konventionen (konkret)
- **Notice statt `alert()`**:
  - Für “Sync gestartet/abgeschlossen/fehlgeschlagen”, Preis-Refresh etc. nutzen wir ein In-Page `Notice` (siehe `components/ui/Notice.tsx`).
- **Bulk-Aktionen sind explizit über Scope**:
  - Labels wie “Auswahl (N)” / “Alle Treffer (M)” statt unklarem “Improve All”.
- **Destruktive Aktionen**:
  - Immer Bestätigung + klarer Labeltext (“Löschen”) und räumlich getrennt von Primary.

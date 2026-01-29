## UX/UI Regeln für AvyCloud (Best Practices, kurz & umsetzbar)

### Quellen (Guidelines)
- **Material Design 3 – Text fields**: klare Labels, Supporting Text, Error States. Siehe `https://m3.material.io/components/text-fields/guidelines`
- **W3C WAI ARIA APG**: zugängliche Patterns (Tooltip, Dialog, Disclosure/Show-Hide). Siehe `https://www.w3.org/WAI/ARIA/apg/`
- **NN/g (Nielsen Norman Group)**: Filters, Dashboards, Status-Feedback. Beispiele u. a.:
  - `https://www.nngroup.com/articles/indicators-validations-notifications/`
  - `https://www.nngroup.com/articles/empty-state-interface-design/`

### Regeln (für unsere Admin- & Ops-Flows)
- **Sprache & Begriffe**: keine internen Jargons ohne Erklärung (GPSR, K-Typ, BIN, Delta Sync).
- **Primäre Aktion pro Bereich**: genau ein “Primary” Button; sekundäre Aktionen als “Secondary”.
- **Erklärbarkeit in-place**: jede Seite hat eine kurze “Was passiert hier?”-Sektion (Disclosure).
- **Fehler sichtbar & konkret**: Fehlermeldungen nennen Ursache + nächsten Schritt (kein “failed” ohne Kontext).
- **Formulare**:
  - **Labels** sind eindeutig (kein “Apply”, kein “Run”).
  - **Helper Text** sagt “was passiert”, **Error Text** sagt “wie fixen”.
- **Dashboards**:
  - zeigen **Last Updated** + Datenquelle/Scope (z. B. “qty≥1, require BIN off”).
  - “0” ist nur okay, wenn klar ist ob “keine Daten” vs “keine Treffer”.

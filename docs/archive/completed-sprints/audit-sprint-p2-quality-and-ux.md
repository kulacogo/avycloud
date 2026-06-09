# AUDIT Sprint P2: Code Quality + UX Polish

> Voraussetzung: P0/P1 Sprint (audit-sprint-p0-security-and-types.md) muss zuerst abgearbeitet sein.

## Prompt für Claude Code

```
Lies CLAUDE.md und TASKS.md.
Dann: cd backend && npm test && npm run build — Baseline prüfen.

Dieses Audit verbessert Code-Qualität und UX. Arbeite die Teile nacheinander ab.

---

## TEIL 1 — Console.log Cleanup (Backend)

128+ console.log/console.warn Stellen in Production Code.

Regeln:
- `console.log` → entfernen oder durch strukturiertes Logging ersetzen
- `console.warn` bei erwarteten Situationen (z.B. "Parcel not found") → beibehalten, aber Prefix sicherstellen (z.B. `[sendcloud]`)
- `console.error` in catch-Blöcken → beibehalten (das ist korrekt)
- KEIN neues Logging-Framework einführen — nur aufräumen

Betroffene Dateien:
- `backend/routes/orders.js` (~226, 606, 990)
- `backend/routes/products.js` (~1333, 1357, 1718)
- `backend/routes/webhooks.js` (~100, 163, 209, 259, 264)
- `backend/services/shipping-engine.js` (diverse)
- `backend/services/enrichment.js` (diverse)
- Suche: `grep -rn 'console\.log' backend/routes/ backend/services/ backend/lib/ --include='*.js' | grep -v node_modules | grep -v __tests__`

Ziel: Maximal 30 console.log/warn Stellen übrig (von 128+). console.error in catch-Blöcken darf bleiben.

---

## TEIL 2 — Empty States für kritische Views

Problem: Listen und Tabellen zeigen nichts wenn leer — kein "Keine Daten" Hinweis.

Nutze die bestehende `EmptyState`-Komponente (suche nach Import in bestehenden Komponenten für das Pattern).

Betroffene Komponenten:
1. `components/InventoryView.tsx` — Produkttabelle leer
2. `components/MarketplaceListingsView.tsx` — Listing-Tabelle leer
3. `components/OrdersView.tsx` — Order-Tabelle leer (Tabs sollten "0" zeigen + EmptyState)
4. `components/AuditLogView.tsx` — Log-Tabelle leer

Pro Komponente:
```tsx
{items.length === 0 && !loading && (
  <EmptyState
    icon="inbox"
    title="Keine Einträge"
    description="Es wurden noch keine Daten gefunden."
  />
)}
```

Prüfe welche Props EmptyState akzeptiert und passe an.

---

## TEIL 3 — i18n: Hardcoded Strings in kritischen Views

24 Komponenten nutzen kein i18n. Die wichtigsten zuerst:

1. `components/Dashboard.tsx` — KPI-Labels, Fehler-Texte, Sektions-Überschriften
2. `components/DashboardMobile.tsx` — Status-Labels, Header
3. `components/OrdersView.tsx` — Filter-Labels, Status-Texte
4. `components/InventoryView.tsx` — KPI-Labels, Zone-Namen
5. `components/orders/ReturnsView.tsx` — Tabellen-Header, Status-Texte

Pattern:
- `import { useI18n } from '../i18n';` am Anfang
- `const { t } = useI18n();` im Component
- Hardcoded Strings ersetzen: `"Bestellungen"` → `t('orders.title')` etc.

WICHTIG: Prüfe zuerst ob die i18n Keys bereits in der Translations-Datei definiert sind.
Suche: `find . -name '*.json' -path '*/i18n/*'` oder `grep -r 'translations' src/i18n/`
Wenn Keys fehlen → zur Translations-Datei hinzufügen.

Falls die i18n-Datei zu umfangreich wäre: NUR die 3 wichtigsten Komponenten (Dashboard, OrdersView, InventoryView) migrieren und den Rest als TODO dokumentieren.

---

## TEIL 4 — Frontend Console.log Cleanup

Betroffene Dateien:
- `components/ProductSheet.tsx` ~682: `console.log('Applying Assistant Change:', change)` → ENTFERNEN
- `components/GeminiChat.tsx` ~525, 531, 704: `console.warn()` → beibehalten (Fehler-Logging)
- `components/AdminTable.tsx` ~811, 825, 1659: `console.warn()` → beibehalten
- `components/OrderDetail.tsx` ~678: `console.error()` → beibehalten
- `components/OperationsView.tsx` ~501, 540, 803: `console.error()` → beibehalten

Suche: `grep -rn 'console\.\(log\|warn\)' components/ hooks/ --include='*.tsx' --include='*.ts' | grep -v node_modules`

Nur `console.log` entfernen. `console.warn` und `console.error` in Error-Pfaden beibehalten.

---

## TEIL 5 — Webhook Input-Validierung (Backend)

Datei: `backend/routes/webhooks.js`

Problem: Webhook-Handler extrahieren Felder aus `req.body` ohne Typ-/Null-Validierung.

Fix für SendCloud-Webhook (~Zeile 58–181):
```js
const body = req.body || {};
const parcelId = Number(body.parcel_id || body.parcel?.id || 0);
if (!parcelId) {
  console.warn('[webhook:sendcloud] Missing parcelId in payload');
  return res.status(200).json({ ok: false, error: 'missing parcel_id' });
}
```

Gleiches Pattern für Kaufland (~190–245) und eBay (~253–320) Webhooks.
Jeder Handler sollte die kritischen Felder (orderId, parcelId, etc.) vor der Verarbeitung validieren.

---

## TEIL 6 — Abschluss

1. `cd backend && npm test` — alle grün
2. `grep -c 'console\.log' backend/routes/*.js backend/services/*.js backend/lib/*.js | grep -v ':0$'` — deutlich weniger als vorher
3. TASKS.md aktualisieren
4. Zusammenfassung
```

## Kontext für Mensch

Dieser Prompt ist der zweite Durchgang nach dem P0/P1-Sprint. Er adressiert:
- 128+ console.log → Ziel: <30
- 4 Views ohne Empty States
- 24 Komponenten ohne i18n (Top 3–5 werden migriert)
- Webhook-Input-Validierung
- Frontend console.log Cleanup

### Bewusst NICHT enthalten (P3, separater Sprint):
- Accessibility (362 nicht-semantische Buttons) — großes Refactoring
- Responsive Design Gaps — Design-Entscheidung nötig
- Memory Leak Verification — erfordert Runtime-Testing
- Modal/Dialog Konsistenz — Design-System-Entscheidung
- Unused Imports Cleanup — automatisierbar via ESLint

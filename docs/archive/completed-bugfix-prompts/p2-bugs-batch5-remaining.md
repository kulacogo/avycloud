# P2 Bugs — Batch 5: Remaining (B022, B025, B040, B041, B046)

> i18n-Vorbereitung, Pricing Runner, Carrier-Validierung, CSV-Export.

## Prompt für Claude Code:

```
Lies CLAUDE.md und TASKS.md. Dann fixe diese 5 verbleibenden P2-Bugs in Branch `fix/p2-remaining`:

## B-040: Carrier-Code nicht gegen Enum validiert
Dateien: Wo EBAY_CARRIER_MAP und KAUFLAND_CARRIER_MAP genutzt werden
Problem: carrier wird als Key genutzt ohne zu prüfen ob er existiert. Ungültiger Carrier → undefined → Push schlägt still fehl.
Fix:
1. Vor dem Lookup: if (!CARRIER_MAP[carrier]) { logge Warning, nutze Fallback 'OTHER' oder werfe Error }
2. Füge expliziten Fallback hinzu: `const mapped = CARRIER_MAP[carrier] || 'OTHER'`
Test: Unbekannter Carrier → Fallback 'OTHER' statt undefined.

## B-041: Kaufland API Timeout nicht konfigurierbar
Datei: Wo kauflandRequest() definiert ist (wahrscheinlich lib/kaufland.js oder ähnlich)
Problem: Hardcoded Timeout in fetch().
Fix: Mach Timeout konfigurierbar via ENV: KAUFLAND_API_TIMEOUT_MS (default: 30000).
`const timeout = Number(process.env.KAUFLAND_API_TIMEOUT_MS || 30000)`
Test: Mit ENV=5000 → Timeout ist 5s.

## B-022: i18n-Vorbereitung (nur Extraktion, kein volles i18n)
ACHTUNG: Volles i18n ist zu aufwändig für diesen Batch. Stattdessen NUR:
1. Erstelle eine Datei `lib/oms-labels.ts` (oder .js) die alle OMS-Status-Labels und UI-Strings als Konstanten exportiert
2. Ersetze die hardcoded Strings in OrdersView, ShippingView, ReturnsView, InvoicesView durch Imports aus dieser Datei
3. Das ist KEIN i18n-System — nur String-Zentralisierung für spätere i18n-Integration
Beispiel:
```ts
export const OMS_LABELS = {
  orders: {
    title: 'Bestellungen',
    empty: 'Keine Bestellungen vorhanden.',
    filterReset: 'Filter zurücksetzen',
  },
  shipping: { ... },
  returns: { ... },
  invoices: { ... },
  status: {
    pending: 'Offen',
    confirmed: 'Bestätigt',
    // ... alle Status
  },
};
```

## B-025: Pricing Engine Runner aktivieren (nur Backend)
HINWEIS: B-025 überlappt mit PRICE-001. Hier NUR den Runner Fix:
1. Prüfe ob pricing-runner.js einen Feature-Flag hat (PRICING_RUNNER_ENABLED oder ähnlich)
2. Stelle sicher dass der Runner korrekt startet wenn das Flag true ist
3. Füge einen Health-Check hinzu: GET /api/v1/pricing/runner-status → { enabled: bool, lastRun: string, rulesCount: number }
4. Der Runner soll NICHT automatisch aktiviert werden — nur sicherstellen dass er funktioniert WENN aktiviert
Test: Mit PRICING_RUNNER_ENABLED=true → Runner startet und verarbeitet eine Regel.

## B-046: CSV-Export für OMS-Tabellen
Dateien: OrdersView.tsx (als erstes, andere OMS-Views folgen)
Problem: Kein Export möglich. User muss Daten manuell kopieren.
Fix:
1. Erstelle einen Helper: `lib/csv-export.ts`
   - `exportToCsv(filename: string, headers: string[], rows: any[][])` → generiert CSV, triggert Download
2. Füge einen [CSV Export] Button in OrdersView hinzu (neben den Filter-Buttons)
3. Exportiert die aktuell gefilterten/angezeigten Bestellungen
4. Spalten: Bestellnr, Datum, Kunde, Status, Marketplace, Betrag
5. Wenn das funktioniert: gleichen Button auch in ShippingView, ReturnsView, InvoicesView
KEIN npm Package — einfache manuelle CSV-Generierung reicht.

Danach: cd backend && npm test + npm run build. Commit: `fix: P2 remaining — carrier validation, timeout config, labels, runner check, csv export`
```

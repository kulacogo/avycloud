# MEGA-BUGFIX: Alle offenen P0/P1 Bugs in einem Durchlauf

> 7 Bugs, 1 Branch, 1 Commit-Serie. Keine halben Sachen.

## Prompt für Claude Code:

```
Lies CLAUDE.md und TASKS.md komplett.

Arbeite auf Branch `fix/mega-bugfix-p0-p1`. Du fixst ALLE folgenden Bugs hintereinander. Nach JEDEM Fix: npm run build prüfen. Am Ende: cd backend && npm test.

WICHTIG: BaseLinker ist TABU. Keine neuen Referenzen. addToast Signatur ist (variant: string, message: string) — KEIN Objekt.

---

## BUG-072: Versand-Tabelle (P0!)

### 072-A: BaseLinker-Badge entfernen
grep -ri "baselinker" components/ backend/ — JEDE Referenz entfernen oder neutralisieren.
In ShippingView.tsx: Wenn order.source === "baselinker" → zeige graues "Legacy" Badge statt "baselinker".
Die alten Orders in Firestore behalten source: "baselinker" — Frontend darf das nur NICHT mehr als "baselinker" anzeigen.

### 072-B: Zustellquote falsch (zeigt 1.1% statt ~80%)
Finde die KPI-Berechnung "Zustellquote" in ShippingView.tsx.
149 Zugestellt / 185 Gesamt sollte ~80.5% sein. Prüfe:
- Wird nicht mit 100 multipliziert?
- Wird durch die falsche Gesamtzahl geteilt?
- Wird das Ergebnis nochmal durch 100 geteilt?
Fix die Berechnung.

### 072-C: Versandkosten 0,00 EUR
Es existiert BEREITS: backend/lib/sendcloud.js mit lookupCsvPrice(method_id, weightKg).
CSVs liegen im Root: sendcloud_upload_DHL.csv, sendcloud_upload_DPD.csv.
Standard method_ids: DHL Paket = 89, DPD Classic = 111.

Im Shipping-Endpoint oder in der Response-Normalisierung:
1. Carrier aus Sendung ermitteln (DHL/DPD)
2. Gewicht aus verknüpftem Produkt: details.weight aus products_v2
3. lookupCsvPrice() aufrufen
4. Wenn kein Gewicht vorhanden → "—" statt 0,00€ anzeigen
5. Ø Versandkosten KPI: Durchschnitt NUR über Sendungen MIT berechneten Kosten

### 072-D: Fehlende Daten in Tabelle
Einträge ohne Tracking-Nr oder Kundenname: zeige "—" statt leere Zelle.

Commit: `fix(bug-072): remove baselinker, fix delivery rate, wire shipping costs`

---

## BUG-070: Marketplace Listing-Tabellen (P1)

### 070-A: eBay Lager zeigt "—" obwohl Bestand vorhanden
Datei: backend/lib/ebay-direct.js, Funktion listLiveListings() (Zeile ~1626).
Der Bug:
```js
const whStock = bins.reduce((sum, b) => sum + (Number(b?.quantity) || 0), 0)
  || (typeof prod?.inventory?.availableQuantity === 'number' ? prod.inventory.availableQuantity : null);
```
`bins.reduce()` gibt 0 zurück wenn bins leer ist. `0 || null` = null = "—".
Fix:
```js
const binsTotal = bins.length > 0 ? bins.reduce((sum, b) => sum + (Number(b?.quantity) || 0), 0) : null;
const whStock = binsTotal !== null ? binsTotal : (typeof prod?.inventory?.availableQuantity === 'number' ? prod.inventory.availableQuantity : null);
```

### 070-B: eBay Kategorie + Lagerplatz fehlen
Prüfe ob categoryName und binLocation im eBay-Endpoint an den Response gehängt werden.
Wenn nicht: Ergänze sie aus dem gematchten products_v2 Dokument:
- category: prod?.identification?.category || prod?.details?.categoryId || null
- binLocation: prod?.storage?.binCode || (bins[0]?.code || null)  ← existiert teilweise schon

### 070-C: Kaufland aktive Angebote mit 0/0 Bestand + fehlende Preise
Datei: backend/routes/marketplace.js, Kaufland GET Endpoint (Zeile ~983).
1. Prüfe das SKU/EAN-Matching (Zeile 1002-1020) — wie viele Units werden NICHT gematcht?
2. Für ungematchte Units: Preis aus Kaufland-Daten nehmen (listing_price / 100 oder price / 100)
3. null vs 0 Rendering: Im Frontend muss null = "—" sein und 0 = "0". Prüfe normalizeKauflandRow().

### 070-D: "Letztes Update" fehlt bei eBay
Prüfe ob ebayListingsLive ein Timestamp-Feld hat (lastModifiedDate, endTime, listingModifiedDate o.ä.).
Wenn ja: mappe es auf lastSync in normalizeEbayRow().

Commit: `fix(bug-070): marketplace listings — stock display, category, pricing, timestamps`

---

## BUG-071: Bestellungen Pipeline-Zahlen inkonsistent (P1)

Datei: components/OrdersView.tsx (oder wo die Pipeline + Tabs definiert sind).
Pipeline zeigt: 22 Neu + 6 Bestätigt + 0 + 0 + 0 + 341 Versendet = 369
Tabs zeigen: Alle 490, Neu 28, Versendet 411, Sonstige 51

1. Finde wo die Pipeline-Zahlen berechnet werden — wahrscheinlich aus einem anderen Query als die Tabs
2. Finde wo die Tab-Zahlen berechnet werden
3. Stelle sicher dass BEIDE die gleiche Datenquelle nutzen
4. "Alle" = Summe aller Status-Tabs. "Sonstige" = Alle - (Neu + InBearbeitung + Kommissioniert + Verpackt + Versendet)
5. Pipeline sollte die GLEICHEN Zahlen zeigen wie die Tabs

Commit: `fix(bug-071): order pipeline counts match tab counts`

---

## BUG-073: Rechnungen — Fehler beim Klick auf grünen Haken (P1)

Datei: components/orders/InvoicesView.tsx
1. Finde den onClick-Handler für den grünen Haken (wahrscheinlich "als bezahlt markieren")
2. Prüfe welchen API-Endpoint er aufruft
3. Wrape den Call in try/catch:
   - catch: addToast("error", `Fehler: ${err.message || "Rechnung konnte nicht als bezahlt markiert werden."}`)
   - finally: setLoading(false)
4. WICHTIG: addToast(variant, message) — NICHT addToast({type, title, message})!
5. Prüfe ob der Backend-Endpoint existiert und korrekt funktioniert. Falls 404: implementiere den Endpoint.

Commit: `fix(bug-073): invoice mark-as-paid error handling`

---

## BUG-074: Rechnungs-PDF Design (P1)

Aktuelle AvyCloud-PDF: minimalistisch, kein Branding.
Gewünschtes Design (RE-1574.pdf SevDesk-Format):
- Header: "TrendOcean" Logo/Text oben rechts (groß, bold, mit Spiegelung/Schatten)
- Absenderzeile: "Trendocean • In den Telgen 4 • 44536 Lünen" (klein, über Empfängeradresse)
- Empfängeradresse: links
- Rechnungsdetails: rechts (Rechnungsdatum, Lieferdatum, Kundennummer) + QR-Code
- Tabelle: Pos. | Beschreibung | Menge | Einzelpreis | Gesamtpreis
- Summen: Netto, MwSt 19%, Brutto (rechtsbündig)
- Footer (4 Spalten):
  Col1: Trendocean, In den Telgen 4, 44536 Lünen, Deutschland
  Col2: Tel.: 01632573352, E-Mail: admin@trendocean.de, Web: www.trendocean.de
  Col3: USt.-ID: DE351808960, Steuer-Nr.: 316/5217/4360, Inhaber/-in: Ömer Özsümbül
  Col4: Sparkasse UnnaKamen, IBAN: DE59 4435 0060 1000 9382 64, BIC: WELADED1UNN

Finde wo die PDF generiert wird (wahrscheinlich backend/lib/invoice-pdf.js oder services/invoice-*.js).
Passe das Template an das SevDesk-Design an. Nutze die existierende PDF-Library (wahrscheinlich pdfkit oder puppeteer).

HINWEIS: Die Firmendaten sollen NICHT hardcoded sein wenn möglich — prüfe ob es eine tenant-config oder company-settings Firestore Collection gibt. Falls ja: lade die Daten von dort. Falls nein: hardcode ist OK für jetzt.

Commit: `fix(bug-074): invoice PDF redesign matching SevDesk template`

---

## FINAL CHECK

1. cd backend && npm test — alle Tests grün
2. npm run build — Frontend baut fehlerfrei
3. grep -ri "baselinker" components/ backend/ — muss LEER sein (nur Legacy-Badge Handling erlaubt)
4. Prüfe dass KEINE "Nicht verhandelbar" Regeln verletzt wurden

Push alles auf den Branch. Zusammenfassung der Änderungen am Ende loggen.
```

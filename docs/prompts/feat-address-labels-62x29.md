# FEAT: Empfänger-Adresslabel drucken (62×29mm)

## Kontext
Kleine, leichte Produkte (z.B. 50g) werden als frankierter Kompaktbrief versendet.
Absenderadresse (TrendOcean) ist bereits auf dem Brief vorgedruckt.
Die Empfängeradresse muss als 62×29mm Label gedruckt werden — gleicher Drucker und gleiche Labelgröße wie BIN-Labels.

## Anforderung
- Button in der Bestellliste (OrdersView) für Multi-Select → "Empfänger drucken"
- Button im Bestelldetail (OrderDetail) für Einzel-Druck
- Label-Format: 62mm × 29mm (identisch zu BIN-Labels)
- Adresse IMMER exakt 3 Zeilen, NIE umbrechen innerhalb einer Zeile:
  ```
  Vorname Nachname
  Straße Hausnummer
  PLZ Ort
  ```
- Fett, sans-serif (wie in den Referenzbildern)
- Adaptive Fontgröße basierend auf längster Zeile

## Referenz: Bestehende BIN-Label-Infrastruktur
Alles in `backend/services/label-printer.js`:
- `buildBinLabelsHtml(codes)` — HTML mit `@page { size: 62mm 29mm }`, auto-print via `window.print()`
- `buildBinLabelsPdf(codes)` — PDF via pdfkit
- `getBinFontMetrics(code)` — adaptive Font-Größe
- Konstanten: `BIN_WIDTH_MM=62`, `BIN_HEIGHT_MM=29`, `BIN_PADDING_MM=2.5`

Route in `backend/routes/warehouse.js` Zeile 63-83:
- `handlePrintBinLabels()` → `buildBinLabelsHtml()` → HTML response

## Implementierung

### 1. Backend: `backend/services/label-printer.js`

Neue Funktion `buildAddressLabelsHtml(addresses)`:

```js
/**
 * Empfänger-Adresslabels für Kompaktbriefe (62×29mm).
 * @param {Array<{name: string, street: string, zip: string, city: string}>} addresses
 * @returns {string} Druckbares HTML
 */
function buildAddressLabelsHtml(addresses) { ... }
```

Spezifikation:
- `@page { size: 62mm 29mm; margin: 0; }` (identisch zu BIN-Labels)
- Kein QR-Code — nur Text
- 3 Zeilen pro Label:
  - Zeile 1: `name` (Vorname Nachname)
  - Zeile 2: `street` (Straße Hausnummer)
  - Zeile 3: `zip city` (PLZ Ort, mit Leerzeichen)
- `white-space: nowrap;` auf jeder Zeile (PFLICHT — kein Umbruch)
- `overflow: hidden; text-overflow: ellipsis;` als Fallback bei extrem langen Zeilen
- Font: `font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; font-weight: 700;`
- Adaptive Font-Größe:
  - Nutzbare Breite: 62mm - 2×3mm Padding = 56mm
  - Längste Zeile aller 3 Zeilen bestimmt die Font-Größe pro Label
  - Berechnung: `fontSize = Math.min(7, Math.max(3.2, 56 / longestLineLength * 1.6))` in mm
  - Typisch: 4.5-5.5mm für normale Adressen, 3.5mm für sehr lange
- Vertikale Zentrierung: `display: flex; flex-direction: column; justify-content: center;`
- `page-break-after: always` zwischen Labels
- Auto-Print: `window.print()` auf load, `window.close()` auf afterprint (wie BIN-Labels)

### 2. Backend: `backend/routes/orders.js`

Neuer Endpoint nach dem bestehenden bulk-ship Endpoint (~Zeile 1497):

```js
// POST /api/orders/address-labels — Empfänger-Adresslabels drucken (62×29mm)
router.post('/address-labels', requirePermission('orders', 'read'), async (req, res) => {
  const { orderIds } = req.body;
  // Validierung: orderIds Array, 1-100 Einträge
  // Orders laden (Firestore batch get)
  // Für jede Order: customer.name, customer.street, customer.zip, customer.city extrahieren
  // Validierung: alle 4 Felder müssen vorhanden sein, sonst 400 mit Liste der unvollständigen Orders
  // buildAddressLabelsHtml(addresses) aufrufen
  // Response: text/html
});
```

Adress-Extraktion:
```js
const address = {
  name: order.customer?.name?.trim() || '',
  street: order.customer?.street?.trim() || '',
  zip: String(order.customer?.zip || '').trim(),
  city: order.customer?.city?.trim() || '',
};
```

Fehlerbehandlung:
- Leere orderIds → 400
- Order nicht gefunden → skip mit Warnung (nicht abbrechen)
- Adresse unvollständig (name/street/zip/city leer) → 400 mit `{ incomplete: [{ orderId, missing: ['zip'] }] }`

### 3. Frontend: `api/client.ts`

Neue Funktion:
```typescript
export const printAddressLabels = async (orderIds: string[]): Promise<void> => {
  const response = await fetchApi(`${BACKEND_URL}/api/orders/address-labels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderIds }),
  });
  if (!response.ok) {
    const result = await response.json();
    throw new Error(result?.error?.message || 'Adresslabel-Erstellung fehlgeschlagen');
  }
  const html = await response.text();
  // Öffne in neuem Fenster (wie printAuthedHtmlUrl pattern)
  const printWindow = window.open('', '_blank', 'width=400,height=300');
  if (printWindow) {
    printWindow.document.write(html);
    printWindow.document.close();
  }
};
```

### 4. Frontend: `components/OrdersView.tsx`

In der Bulk-Action-Bar (Zeile ~670, innerhalb `{selectedIds.size > 0 && (...)}` Block):

Neuer Button nach den bestehenden Status-Transition-Buttons:
```tsx
<Button
  variant="secondary"
  size="sm"
  onClick={async () => {
    try {
      await printAddressLabels(Array.from(selectedIds));
    } catch (err: any) {
      setBulkResult(err?.message || 'Fehler beim Drucken');
    }
  }}
  disabled={bulkBusy}
>
  Empfänger drucken
</Button>
```

### 5. Frontend: `components/OrderDetail.tsx`

Im Adress-Bereich der Bestelldetails, neben/unter der Adresse:
```tsx
<Button
  variant="secondary"
  size="sm"
  onClick={() => printAddressLabels([order.id])}
>
  Adresslabel drucken
</Button>
```

## Kein Breaking Change
- Neuer Endpoint `/api/orders/address-labels` — keine bestehende Route betroffen
- Neue Funktion in `label-printer.js` — kein Export geändert
- Neue UI-Buttons — kein bestehendes UI-Element geändert
- Kein Firestore-Schema-Änderung
- Keine neue Dependency

## Tests

In `backend/__tests__/label-printer.test.js` (oder neue Datei wenn nicht vorhanden):

1. `buildAddressLabelsHtml` mit 1 Adresse → HTML enthält alle 3 Zeilen
2. `buildAddressLabelsHtml` mit 5 Adressen → 5 Label-Divs mit `page-break-after`
3. Jede Zeile hat `white-space: nowrap` (kein Umbruch)
4. Adaptive Font: kurze Adresse → fontSize >= 4.5mm, lange Adresse → fontSize >= 3.2mm
5. HTML enthält `window.print()` und `window.close()` Scripts
6. Fehlende Felder → Error
7. ZIP mit führender Null (z.B. "01234") → korrekt dargestellt

Endpoint-Test:
8. POST `/api/orders/address-labels` mit gültigen orderIds → 200 + text/html
9. POST mit leeren orderIds → 400
10. POST mit Order ohne vollständige Adresse → 400 mit `incomplete` Details

## Validierung
1. `cd backend && npm test` — alle Tests grün
2. `npm run build` — kein Fehler
3. Manuelle Prüfung: Bestellliste → 3 Orders auswählen → "Empfänger drucken" → Druckdialog mit 3 Labels
4. Label auf echtem 62×29mm Etikett drucken → Text passt, keine Zeile umbricht

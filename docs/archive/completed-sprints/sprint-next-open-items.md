# Sprint: Offene Bugs + Features — Konsolidierter Prompt

## Prompt für Claude Code

```
Lies CLAUDE.md und TASKS.md.
Dann: cd backend && npm test && npm run build — Baseline prüfen.

Arbeite die folgenden 6 Teile nacheinander ab. Nach jedem Teil: cd backend && npm test — muss grün bleiben.

---

## TEIL 1 — BUG-072 Restarbeiten: Versandkosten 0€ + Ghost-Einträge

### Status: BaseLinker-Badge + Zustellquote bereits gefixt. Offen: Versandkosten + Ghosts.

### 1a) Versandkosten 0,00 EUR bei allen Einträgen

Problem: Alle Sendungen zeigen 0,00 EUR Versandkosten.
- `backend/services/shipping-engine.js` Zeile ~709: `parcelCost = parseFloat(String(parcel.price || '0'))` — SendCloud liefert Kosten im `price`-Feld, aber nur bei Parcels die über die API erstellt wurden.
- Für historische/synchronisierte Parcels fehlt der Preis. Fix:
  1. SendCloud CSV-Preistabellen existieren: `backend/data/sendcloud_upload_DHL.csv` + `sendcloud_upload_DPD.csv`
  2. `backend/lib/sendcloud.js` hat `lookupCsvPrice(methodId, weightKg)` — liefert den Preis aus der CSV
  3. In `syncSendCloudParcels()` (shipping-engine.js Zeile ~700): Wenn `parcelCost === 0`, Fallback auf `lookupCsvPrice(parcel.shipment?.id, parcel.weight)`
  4. Importiere `lookupCsvPrice` aus `../lib/sendcloud`

### 1b) Ghost-Einträge ohne Tracking + ohne Kundenname

Problem: Sendungen wie "26-14354-93495" ohne Tracking-Nr und ohne Kundenname.
- Vermutlich aus alten BaseLinker-Importen (source: 'baselinker')
- In `components/orders/ShippingView.tsx`: Die BaseLinker-Badge wird bereits gefiltert (Zeile ~439). Zusätzlich:
  1. Einträge mit `source === 'baselinker'` ODER `marketplace?.includes('baselinker')` komplett aus der Tabelle filtern (nicht nur Badge)
  2. Alternativ: Einträge ohne trackingNumber UND ohne customer komplett ausblenden (mit Toggle "Unvollständige anzeigen")

---

## TEIL 2 — BUG-074 Restarbeiten: Rechnungs-PDF TrendOcean-Branding

### Status: PDF-Engine existiert (`backend/services/invoice-engine.js`). Offen: TrendOcean-Branding.

Problem: AvyCloud PDF ist minimalistisch, kein Logo, kein QR-Code, kein Firmenfooter. SevDesk-Format ist Referenz.

1. Tenant-Einstellungen laden: `order_settings/{tenantId}` oder `tenant_settings/{tenantId}` in Firestore.
   Prüfe welche Collection die Firmendaten enthält (Name, Adresse, Logo-URL, Bankdaten, Steuernummer, USt-ID).
   Suche in: `backend/routes/settings.js` oder `backend/routes/invoices.js` nach der Collection.

2. PDF-Template erweitern in `invoice-engine.js`:
   - Absenderzeile oben (Firma, Straße, PLZ Ort)
   - Empfängeradresse links
   - Rechnungsdaten rechts (Nummer, Datum, Fällig, Kunden-Nr)
   - Positionen-Tabelle mit Spalten: Pos, Bezeichnung, Menge, Einzelpreis, MwSt, Gesamtpreis
   - MwSt-Zusammenfassung
   - 4-Spalten-Footer: Firma | Geschäftsführer | Bankverbindung | Steuerdaten

3. QR-Code: Wenn technisch einfach (z.B. qrcode npm package), EPC-QR-Code für Banküberweisung generieren. Falls zu aufwändig, überspringen.

4. WICHTIG: Keine neue Dependency ohne `npm install --save` + Prüfung dass es im Dockerfile/Cloud Build funktioniert.

---

## TEIL 3 — BUG-077 Restarbeiten: Mobile Pack-Zähler + rote BIN

### Status: Safe-Area + BIN-Label bereits gefixt. Offen: Pack-Zähler + rote BIN.

### 3a) Pack-Zähler zeigt 408

Problem: "Packen: 408" im Mobile-Menü — zählt vermutlich alle synced Produkte statt offene Pack-Aufträge.
- `components/MobileOperationsView.tsx` Zeile ~94: `packList` filtert `products` mit `sync_status === 'synced'`
- Das ist falsch — Pack-Zähler sollte Aufträge (Orders) zählen die im Status "picked" oder "packed" sind, NICHT Produkte.
- Fix: Pack-Count aus `orders` Array ableiten (Orders mit omsStatus === 'picked' oder 'packing'), nicht aus products.
- Beachte: `orders` wird in MobileOperationsView bereits geladen (Zeile ~106, `fetchOrders`). Nutze `orders.filter(o => ['picked', 'packing'].includes(o.omsStatus || getOrderStatus(o)))`.

### 3b) BIN XGA0402C rot hinterlegt

- Suche in MobileOperationsView nach der Logik die BIN-Codes rot/grün einfärbt.
- Vermutlich zeigt rot = Fehler (z.B. BIN nicht gefunden oder Bestand 0). Prüfe ob die Bedingung korrekt ist.
- Wenn rot = "BIN existiert nicht" oder "Bestand aufgebraucht" → das ist korrektes Verhalten, nur muss es dem User erklärt werden (Tooltip/Text)
- Wenn rot = Bug → fixen.

---

## TEIL 4 — Palette-Pflicht bei Identify (Validierung)

### Status: Backend + Frontend-Threading fertig. paletteCode wird akzeptiert und gespeichert. Offen: Pflicht-Validierung.

Lies: `docs/prompts/feat-palette-pflicht-bei-identify.md` — dort steht der vollständige Kontext.

Kurzfassung:
1. **Frontend**: `components/MobileOperationsView.tsx` Zeile ~995: Label von "Palette (optional)" → "Palette (Pflicht)"
2. **Frontend**: Identify-Button (Zeile ~1095) disabled wenn `identifyPaletteCode` leer
3. **Frontend**: Roter Hinweis wenn keine Palette → "Bitte zuerst Palette scannen"
4. **Backend**: `backend/routes/identify.js` Zeile ~230: Wenn `paletteCode` fehlt → HTTP 400 `PALETTE_REQUIRED`
   - NUR für neue Produkte. Bei Stock-Protection (bestehendes Produkt, Zeile ~250) ist Palette optional.
5. **Backend**: Palette-Existenz prüfen: `paletteCode` muss als BIN in `warehouse_bins_{tenantId}` existieren (Zone P)
6. **Produktseite**: `ops.sourcePalette` + `ops.sourcePaletteAt` unter LAGERPLATZ anzeigen. Suche die Produktdetail-Komponente (vermutlich ProductSheet.tsx oder ProductDetail.tsx) und ergänze: "Palette: PGA001 (seit 21.03.2026)"

---

## TEIL 5 — Gewichtsschätzung verbessern

### Status: Komplett offen. Keine Code-Änderungen bisher.

Lies: `docs/prompts/feat-shipping-weight-estimation-and-carrier-selection.md` — dort steht der vollständige Kontext.

Kurzfassung:
1. **Gemini-Prompt verschärfen** in `backend/services/enrichment.js` Zeile ~1637:
   - Gewichtsangaben im Titel haben PRIORITÄT 1 (z.B. "35kg" → 35000g)
   - Keine pauschale 500g-Schätzung

2. **Plausibilitätscheck**: Neue Hilfsfunktion `extractWeightFromTitle(title)`:
   - Regex für `(\d+[\.,]?\d*)\s*(kg|g|gramm|kilogramm)` im Titel
   - In `applyReviewResult()` (Zeile ~1852): Wenn Titel-Gewicht vs. LLM-Gewicht >50% abweicht → Titel bevorzugen

3. **Tests**:
   - `extractWeightFromTitle('Costway Elektro-Quad 12V 35kg')` → 35
   - `extractWeightFromTitle('Smartphone Hülle 50g')` → 0.05
   - `extractWeightFromTitle('Werkzeugset 3-teilig')` → null

4. **NICHT in diesem Sprint**: Pack-Modul Carrier-Vorschau UI (kommt später)

---

## TEIL 6 — Abschluss

1. `cd backend && npm test` — alle Tests grün
2. `cd backend && npm run build` — Build erfolgreich
3. TASKS.md aktualisieren:
   - BUG-072: Versandkosten + Ghost-Filter als erledigt markieren (oder Restpunkte dokumentieren)
   - BUG-074: Branding als erledigt markieren (oder Restpunkte)
   - BUG-077: Pack-Zähler + rote BIN als erledigt markieren
   - Neue Einträge: FEAT-PALETTE-PFLICHT, FEAT-WEIGHT-ESTIMATION unter Feature Backlog als "done" oder "in progress"
4. Zusammenfassung: Was wurde geändert, welche Dateien, was ist offen
```

## Status-Übersicht (für Mensch)

| Item | Vor diesem Sprint | Nach diesem Sprint |
|------|-------------------|--------------------|
| BUG-070 BIN in Listings | ✅ fertig | ✅ |
| BUG-071 Pipeline-Zahlen | ✅ fertig (omsCounts aus orders) | ✅ |
| BUG-072 Versand | ⚠️ Badge+Quote gefixt | ✅ Kosten + Ghosts gefixt |
| BUG-073 Rechnung bezahlt | ✅ fertig (tenantId backfill) | ✅ |
| BUG-074 Rechnungs-PDF | ⚠️ Engine da, kein Branding | ✅ TrendOcean-Branding |
| BUG-077 Mobile UI | ⚠️ Safe-Area+Label gefixt | ✅ Pack-Zähler + BIN gefixt |
| BUG-078 BIN-Löschung | ✅ fertig | ✅ |
| WH-001 Zone P | ✅ fertig | ✅ |
| Palette-Pflicht | ⚠️ Threading fertig | ✅ Validierung + Anzeige |
| Gewicht + Carrier | ❌ nur Prompt | ✅ Prompt + Plausibilität |

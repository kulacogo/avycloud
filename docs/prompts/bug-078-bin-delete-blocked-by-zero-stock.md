# BUG-078: BIN-Löschung blockiert obwohl Bestand = 0

## Prompt für Claude Code

```
Lies CLAUDE.md und TASKS.md.
Dann: cd backend && npm test && npm run build — Baseline prüfen.

## Bug

BIN-Löschung (Gang löschen / Regal löschen / Ebene löschen) blockiert auch wenn alle zugeordneten Produkte Menge 0 haben.

Fehlermeldung:
"Kann nicht löschen: 1 BIN(s) sind nicht leer (z.B. XQGA0101A:0). Bitte zuerst auslagern/entfernen."

Die Meldung zeigt selbst `:0` — Bestand ist 0, Löschung wird trotzdem blockiert.

## Ursache

`backend/lib/warehouse.js`, Funktion `deleteWarehouseBinsByFilter()` (ab Zeile ~1143).

Der nonEmpty-Filter (Zeile ~1151–1156) prüft:
```js
return count > 0 || products.length > 0;
```

`products.length > 0` blockiert sobald Produkte in der BIN referenziert sind — unabhängig davon ob deren `quantity` > 0 ist.

## Aufgabe

1. Fixe den nonEmpty-Filter: Nur blockieren wenn `productCount > 0` ODER mindestens ein Eintrag im `products`-Array `quantity > 0` hat.
   - `products.length > 0` ersetzen durch `products.some((p) => Number(p.quantity || 0) > 0)`

2. Schreibe min. 2 Tests:
   - BIN mit products-Array wo alle quantity: 0 → Löschung erlaubt
   - BIN mit products-Array wo min. ein quantity > 0 → Löschung blockiert

3. Optional prüfen: Wenn eine BIN mit Menge-0-Referenzen gelöscht wird, müssen die Produkt-Dokumente in der Legacy `products`-Collection bereinigt werden? (storageBins-Feld, siehe `refreshProductInventory()` Zeile ~159)

4. cd backend && npm test — alle Tests müssen grün sein.

5. TASKS.md aktualisieren: BUG-078 als neuen Eintrag unter "Aktive Bugs" hinzufügen (oder als erledigt markieren wenn fix steht).
```

## Kontext für Mensch

- Betroffene Datei: `backend/lib/warehouse.js`, Funktion `deleteWarehouseBinsByFilter`
- Aufruf über: DELETE-Endpoint in `backend/routes/warehouse.js`
- Firestore BIN-Dokument hat `products` Array + `productCount` Feld
- Die `products`-Einträge haben ein `quantity`-Feld
- Screenshot: Zone XQ/GA, BIN XQGA0101A, 2 Produkte mit Menge 0
- Produktseite zeigt "Aktuell keinem BIN zugeordnet" — Produkt weiß nichts von der BIN, aber BIN referenziert noch das Produkt

# FEAT: Warehouse Child-BINs (Behälter innerhalb von Ebenen)

## Kontext

Warehouse-Ebenen (z.B. SEG0101E) können physische Behälter enthalten.
Behälter sind **Child-BINs** — sie werden exakt wie normale BINs behandelt,
haben aber eine Eltern-Beziehung zur übergeordneten Ebene.

**Beispiele:**
- `SEG0101E` hat 2 Behälter: `SEG0101E01`, `SEG0101E02`
- `SEG0102C` hat 3 Behälter: `SEG0102C01`, `SEG0102C02`, `SEG0102C03`

## Regeln

1. Behälter sind **normale BIN-Dokumente** in `warehouseBins` — kein neues Datenmodell
2. BIN-Code-Schema: `{parentBinCode}{NN}` (2-stellig, 01-99)
3. Ein Parent-BIN kann 0-99 Child-BINs haben
4. Einlagern ist **entweder** direkt in Parent **oder** in einen Child — niemals beides gleichzeitig für dasselbe Produkt
5. Wenn ein Parent Children hat, werden beim Abrufen der Parent-BIN-Detail die aggregierten Children-Mengen zusätzlich angezeigt
6. Beim Scan eines Behälter-QR-Codes wird der Behälter wie jede normale BIN behandelt
7. `refreshProductInventory()` und `buildProductKeySet()` / `binEntryMatchesKeySet()` müssen Parent+Children korrekt berücksichtigen
8. **Bestandskonsistenz**: Produkt in Child-BIN → Bestand zählt zum Produkt. Produkt in Parent-BIN → Bestand zählt zum Produkt. Keine Doppelzählung.

## Datenmodell-Erweiterung

### warehouseBins-Dokument — neue optionale Felder (additive only)

```js
{
  // ... bestehende Felder bleiben unverändert ...
  code: 'SEG0101E01',       // BIN-Code (doc ID)
  zone: 'S',
  etage: 'EG',
  gang: 1,
  regal: 1,
  ebene: 'E',

  // NEU: Child-BIN Felder
  parentBinCode: 'SEG0101E',  // null für reguläre BINs/Parents
  isContainer: true,           // true wenn dies ein Behälter ist
  containerIndex: 1,           // 1-99, fortlaufende Nummer
}
```

### Parent-BIN — neues denormalisiertes Feld

```js
{
  code: 'SEG0101E',
  // ... bestehende Felder ...

  // NEU: Schnellzugriff auf Children
  childBinCodes: ['SEG0101E01', 'SEG0101E02'],  // Array, leer wenn keine Children
}
```

## Backend-Änderungen

### Fix 1: `backend/lib/warehouse.js` — Neue Funktionen

#### `createChildBin(parentBinCode, options?)`
1. Parent-BIN laden, prüfen ob existiert
2. Nächste freie Nummer ermitteln (aus `childBinCodes[]` oder Query)
3. Neues BIN-Dokument erstellen mit `parentBinCode`, `isContainer: true`, `containerIndex`
4. `childBinCodes` am Parent aktualisieren
5. QR-Code / Label ist identisch zum normalen BIN-Label (BIN-Code = `SEG0101E01`)

```js
async function createChildBin(parentBinCode, options = {}) {
  // parentBinCode validieren
  // Nächsten freien Index finden
  // Child-BIN-Code generieren: `${parentBinCode}${String(index).padStart(2, '0')}`
  // Firestore-Dokument erstellen
  // Parent.childBinCodes[] aktualisieren
}
```

#### `deleteChildBin(childBinCode)`
1. Prüfen ob BIN ein Child ist (`isContainer === true`)
2. Prüfen ob BIN leer ist (keine Produkte mit quantity > 0)
3. BIN-Dokument löschen
4. `childBinCodes` am Parent aktualisieren

#### `listChildBins(parentBinCode)`
1. Query: `binsCollection.where('parentBinCode', '==', parentBinCode)`
2. Rückgabe: Array von Child-BIN-Objekten (code, productCount, products)

### Fix 2: `backend/lib/warehouse.js` — Bestehende Funktionen anpassen

#### `getBinByCode(code)` erweitern
- Wenn BIN Children hat (`childBinCodes.length > 0`): Children laden und als `children[]` Array anhängen
- Jedes Child enthält: `code`, `containerIndex`, `productCount`, `products[]`
- Neues Feld in Response: `childrenProductCount` (Summe aller Children-Mengen)

#### `bookStockIn()` — Konsistenz-Check
- Wenn targetBin ein Child ist: Einlagerung normal durchführen (Child ist eine vollwertige BIN)
- Wenn targetBin ein Parent mit Children ist: Warnung/Blockierung wenn dasselbe Produkt bereits in einem Child liegt
- Wenn targetBin ein Parent OHNE Children ist: Normal einlagern (wie bisher)

#### `removeProductFromBin()` — Kein Sonderfall nötig
- Funktioniert bereits korrekt dank `buildProductKeySet()` + `binEntryMatchesKeySet()`
- Child-BINs sind normale BINs → Entfernen funktioniert identisch

#### `refreshProductInventory()` — Kein Sonderfall nötig
- Iteriert bereits über ALLE BINs in der Collection
- Child-BINs werden automatisch mitgezählt (sie sind reguläre BIN-Dokumente)
- **Keine Doppelzählung**: Produkt liegt entweder in Parent ODER in Child, nie beides

#### `deleteWarehouseBinsByFilter()` — Anpassen
- Beim Löschen einer Ebene: auch alle Child-BINs dieser Ebene mit löschen
- Prüfung: Alle Children müssen leer sein

### Fix 3: `backend/routes/warehouse.js` — Neue Routes

```
POST   /api/warehouse/bins/:code/containers         → createChildBin
GET    /api/warehouse/bins/:code/containers         → listChildBins
DELETE /api/warehouse/bins/:code/containers/:childCode → deleteChildBin
```

- Permission: `warehouse.write` für Create/Delete, `warehouse.read` für List
- `:code` ist der Parent-BIN-Code
- `:childCode` ist der vollständige Child-BIN-Code

### Fix 4: `backend/services/label-printer.js` — Anpassen

- Label für Child-BINs: Gleicher QR-Code-Inhalt (vollständiger BIN-Code)
- **Visueller Unterschied**: Unter dem BIN-Code klein den Parent anzeigen
  - Normal: `SEG0101E01`
  - Darunter: `↳ SEG0101E` (kleiner Font)
- `renderBinLabelHtml()` prüft ob `parentBinCode` gesetzt ist

## Frontend-Änderungen

### Fix 5: Warehouse BIN-Detail — Child-BINs anzeigen

Im BIN-Detail-View (Screenshot zeigt: Zone XS/GA → BIN Detail → XSGA0103A):
- Unter der Produktliste: neue Section **"Behälter"**
- Liste aller Child-BINs mit: Code, Produktanzahl, "Entfernen"-Button
- Button **"+ Behälter hinzufügen"** → erstellt nächsten freien Child-Index
- Jeder Behälter ist klickbar → zeigt eigene Produkte

### Fix 6: `api/client.ts` — Neue API-Funktionen

```ts
export const createChildBin = async (parentBinCode: string): Promise<WarehouseBin> => { ... }
export const listChildBins = async (parentBinCode: string): Promise<WarehouseBin[]> => { ... }
export const deleteChildBin = async (parentBinCode: string, childCode: string): Promise<void> => { ... }
```

### Fix 7: `types.ts` — TypeScript-Erweiterung

```ts
interface WarehouseBin {
  // ... bestehende Felder ...
  parentBinCode?: string | null;
  isContainer?: boolean;
  containerIndex?: number;
  childBinCodes?: string[];
  children?: WarehouseBin[];           // Nur bei getBinByCode() Response
  childrenProductCount?: number;       // Aggregierte Menge aus allen Children
}
```

## Dateien die geändert werden

| Datei | Änderung |
|---|---|
| `backend/lib/warehouse.js` | `createChildBin()`, `deleteChildBin()`, `listChildBins()`, `getBinByCode()` erweitert |
| `backend/routes/warehouse.js` | 3 neue Routes für Container-CRUD |
| `backend/services/label-printer.js` | Parent-Anzeige auf Child-Labels |
| `api/client.ts` | 3 neue API-Funktionen |
| `types.ts` | `WarehouseBin` Interface erweitert |
| `components/warehouse/` | BIN-Detail-View erweitert (Behälter-Section) |

## Tests

1. `cd backend && npm test` — bestehende Tests müssen grün bleiben
2. Neue Tests in `backend/__tests__/warehouse-containers.test.js`:
   - `createChildBin()`: Erstellt Child mit korrektem Code-Format
   - `createChildBin()`: Findet nächsten freien Index (wenn 01 belegt → 02)
   - `createChildBin()`: Fehler wenn Parent nicht existiert
   - `deleteChildBin()`: Fehler wenn Child nicht leer
   - `deleteChildBin()`: Entfernt Code aus Parent.childBinCodes[]
   - `listChildBins()`: Gibt nur Children des Parents zurück
   - `getBinByCode()`: Parent-Response enthält `children[]` Array

## Nicht ändern

- Keine bestehenden BIN-Codes umbenennen
- Keine bestehende Firestore-Felder entfernen/umbenennen (additive only)
- Keine neuen Collections (Children sind Dokumente in `warehouseBins`)
- Keine Änderung an Auth/RBAC
- Keine neuen Dependencies
- Keine Änderung an `buildProductKeySet()` / `binEntryMatchesKeySet()` (funktioniert bereits für alle BINs)

## Konsistenz-Garantien

1. **Atomare Erstellung**: Child-BIN-Erstellung + Parent-Update in einer Transaction
2. **Atomare Löschung**: Child-BIN-Löschung + Parent-Update in einer Transaction
3. **Kein Orphan**: Wenn Parent gelöscht wird, müssen alle Children leer sein und werden mit gelöscht
4. **Keine Doppelzählung**: `refreshProductInventory()` zählt jede BIN (Parent oder Child) einzeln — Produkt liegt nur in einer
5. **QR-Scan-Konsistenz**: Jede BIN (Parent oder Child) hat eigenen QR-Code → scan führt direkt zur richtigen BIN

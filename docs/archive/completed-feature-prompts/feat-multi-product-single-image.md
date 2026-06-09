# FEAT: Mehrere Produkte aus einem einzelnen Bild erkennen

## Priorität: P1

## Kontext

Das Erfassen-Modul erkennt derzeit nur über Image-Grouping mehrere Produkte —
dafür braucht es aber **mehrere separate Bilder**. Wenn ein User **ein einzelnes Bild**
hochlädt, auf dem z.B. 5 verschiedene Produkte liegen (Tisch, Palette, Regal), wird
nur **ein Produkt** erkannt, weil:

1. Image-Grouping (`/api/v2/group-images`) erkennt zwar theoretisch mehrere Produkte pro Bild
   (Zeile 10-11 im Prompt), ordnet aber **das gleiche Bild mehreren Gruppen zu**, ohne
   die einzelnen Produkte daraus isoliert zu identifizieren.
2. Die Identify-Pipeline (`generateStructuredProductRecord`) gibt **ein einzelnes JSON-Objekt**
   zurück (nicht ein Array), weil `PRODUCT_RECORD_SCHEMA` ein Object-Schema ist.
3. Pro Gruppe wird genau **ein** `/api/v2/identify`-Call gemacht → ein Produkt.

## Gewünschtes Verhalten

1. User lädt 1 Bild hoch mit mehreren sichtbaren Produkten
2. System erkennt automatisch: "Dieses Bild enthält N verschiedene Produkte"
3. Für jedes erkannte Produkt wird ein separater Produktdatensatz erzeugt
4. User kann im StepReview durch alle erkannten Produkte navigieren

## Implementierung: 3 Phasen

### Phase 1: Multi-Product Detection Prompt (Backend)

**Datei:** `backend/services/generative-identify.js`

Neuer Modus `multi_detect` für das Gemini-Prompt:

```js
const MULTI_PRODUCT_DETECTION_SCHEMA = {
  type: 'object',
  properties: {
    product_count: { type: 'number' },
    products: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'number' },
          label: { type: 'string' },
          bounding_description: { type: 'string' },  // z.B. "oben links, roter Karton"
          brand_hint: { type: 'string' },
          category_hint: { type: 'string' },
          barcode_hint: { type: 'string' },
          confidence: { type: 'number' },
        },
      },
    },
  },
};
```

**Neue Funktion:** `detectMultipleProducts({ files, ocrLines, barcodes })`
- Sendet Bild(er) an Gemini mit speziellem Multi-Detection-Prompt
- Prompt fragt: "Wie viele verschiedene Produkte siehst du? Beschreibe Position und Merkmale."
- Gibt Array von Produkt-Hints zurück
- Wenn `product_count === 1` → normaler Single-Identify-Flow (kein Overhead)
- Wenn `product_count > 1` → jeder Hint wird als separater Identify-Call verarbeitet

**Multi-Detection Prompt (Entwurf):**
```
Du bist ein Bildanalyse-Experte für Produktfotos in einem E-Commerce-Warenlager.
Dir werden bis zu 4 Bilder gezeigt.

Aufgabe:
1. Zähle wie viele VERSCHIEDENE Produkte auf den Bildern zu sehen sind.
2. Für jedes Produkt: beschreibe Position, erkennbare Marke, Produkttyp, ggf. Barcode.
3. STRENGE REGELN:
   - Mehrere Exemplare desselben Produkts = 1 Produkt (nicht doppelt zählen)
   - Varianten (Farbe/Größe) des gleichen Modells = 1 Produkt
   - Im Zweifel: WENIGER Produkte zählen, nicht mehr
   - Verpackungsmaterial, Tisch, Hintergrund sind KEINE Produkte
```

### Phase 2: Identify-Pipeline erweitern (Backend)

**Datei:** `backend/routes/identify.js`

Neuer Endpoint oder Erweiterung von `POST /api/v2/identify`:

Option A — Neuer Endpoint `POST /api/v2/identify-multi`:
```js
router.post('/v2/identify-multi', requirePermission('identify', 'run'), upload.array('images'), async (req, res) => {
  // 1. detectMultipleProducts() aufrufen
  // 2. Wenn nur 1 Produkt → normaler identify-Flow (Redirect/Inline)
  // 3. Wenn mehrere Produkte → für jeden Hint einen identify-Call:
  //    - Gleiche Bilder werden mitgesendet
  //    - Hint-Kontext (label, bounding_description, brand_hint) wird dem Prompt vorangestellt
  //    - z.B. "Fokussiere dich auf das Produkt: oben links, roter Karton, vermutlich Nike"
  // 4. Ergebnisse als Array zurückgeben
});
```

Option B — Erweiterung von `POST /api/v2/enrich` (bevorzugt):
- Neuer Query-Parameter `?multi=true`
- Response-Format ändert sich von `{ ok, data: Product }` zu `{ ok, data: Product[] }`
- Abwärtskompatibel: ohne `?multi` bleibt alles beim Alten

**Identify-per-Hint Prompt-Ergänzung:**
```
KONTEXT: Auf dem Bild sind mehrere Produkte sichtbar.
Fokussiere dich NUR auf folgendes Produkt:
- Position: {bounding_description}
- Vermutete Marke: {brand_hint}
- Vermuteter Typ: {category_hint}
Ignoriere alle anderen Produkte auf dem Bild.
```

### Phase 3: Frontend-Integration

**Dateien:**
- `components/capture/StepGrouping.tsx` — Anpassung
- `components/capture/StepAnalysis.tsx` — Multi-Product Handling
- `components/capture/CaptureView.tsx` — Flow-Steuerung
- `api/client.ts` — Neuer API-Call

**Flow-Änderung im CaptureView:**

```
StepUpload (unverändert)
    ↓
StepGrouping (erweitert)
    ├─ Mehrere Bilder → bestehende Image-Grouping-Logik
    └─ 1 Bild → Multi-Product-Detection aufrufen
        ├─ 1 Produkt erkannt → direkt zu StepAnalysis (single)
        └─ N Produkte erkannt → StepGrouping zeigt N "virtuelle Gruppen"
            - Jede Gruppe referenziert das gleiche Bild
            - Label zeigt Produkt-Hint (z.B. "Nike Schachtel, oben links")
            - User kann Gruppen bestätigen/anpassen/löschen
    ↓
StepAnalysis (erweitert)
    - Pro Gruppe: identifyProductV2() mit Hint-Kontext
    - Sequentiell (wie bisher bei Multi-Group)
    ↓
StepReview (unverändert — navigiert bereits über activeProductIndex)
```

**UI in StepGrouping für Single-Image Multi-Product:**
- Bild wird groß angezeigt
- Darunter: Liste der erkannten Produkte mit Confidence-Badge
- Jedes Produkt hat: Label, Beschreibung, Confidence, Checkbox (an/aus)
- Button "Produkt hinzufügen" falls System eines übersehen hat
- Button "Weiter" startet Identify für alle aktiven Produkte

## Regeln

- `PRODUCT_RECORD_SCHEMA` bleibt für Single-Identify unverändert (kein Breaking Change)
- Neues Schema `MULTI_PRODUCT_DETECTION_SCHEMA` nur für die Detection-Phase
- Multi-Detection ist ein **optionaler Vorschaltschritt**, kein Ersatz für Image-Grouping
- Image-Grouping bleibt für den Multi-Bild-Fall bestehen
- Alle Produkte werden über `saveProductV2()` gespeichert
- Gemini-Temperatur für Detection: 0.1 (leicht kreativ für Objekterkennung)
- Gemini-Temperatur für Identify: 0.0 (deterministisch, wie bisher)
- Maximal 10 Produkte pro Bild (Hard-Limit, verhindert Halluzinationen)
- Jeder einzelne Identify-Call nutzt den bestehenden `generateStructuredProductRecord()`
  mit vorangestelltem Hint-Kontext

## Tests

1. **Unit-Test:** `detectMultipleProducts()` mit Mock-Response (1 Produkt, 3 Produkte, 0 Produkte)
2. **Unit-Test:** Hint-Kontext-Injection in den Identify-Prompt
3. **Unit-Test:** Response-Parsing für Multi-Detection-Schema
4. **Integration:** Manueller Test mit Foto von Tisch mit 3 verschiedenen Produkten

## Risiken

- **Gemini-Halluzinationen:** Detection könnte Produkte "erfinden" die nicht da sind
  → Mitigation: Confidence-Threshold (< 0.6 = nicht automatisch aktiviert), User-Bestätigung in StepGrouping
- **Kosten:** Zusätzlicher Gemini-Call pro Upload für Detection
  → Mitigation: Nur wenn explizit aktiviert (`?multi=true`) oder wenn Image-Count = 1
- **Rate-Limiting:** Mehr sequentielle Calls an Gemini
  → Bereits gelöst durch sequentielle Verarbeitung in StepAnalysis (BUG-079 Fix)

## Nicht im Scope

- Bild-Cropping / ROI-Extraction (Bild wird immer komplett gesendet)
- Automatische Bildzuordnung per Bounding Box (nur textuelle Beschreibung)
- Batch-Identify ohne User-Review (User muss immer bestätigen)

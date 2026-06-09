# FEAT: Erfassen-Modul UI Overhaul (Desktop)

> Betrifft: `components/capture/CaptureView.tsx`, `components/capture/StepUpload.tsx`
> Neue Datei(en): ggf. `components/capture/PaletteSelector.tsx`

## Prompt für Claude Code

```
Lies CLAUDE.md und TASKS.md.
Dann: cd backend && npm test && npm run build — Baseline prüfen.

Dieses Feature überarbeitet das Erfassen-Modul (Desktop Web UI) grundlegend.
Betroffene Dateien: components/capture/CaptureView.tsx, components/capture/StepUpload.tsx

---

## TEIL 1 — Palette-Auswahl VOR dem Upload (Pflicht)

Das Capture-Flow braucht vor Step 1 ("Bilder hochladen") eine Pflicht-Auswahl der Quell-Palette.
Ohne Palette darf der User NICHT weiter zur Bild-Erkennung.

### 1a) PaletteSelector Komponente

Erstelle `components/capture/PaletteSelector.tsx`:
- Dropdown/Combobox mit allen vorhandenen Paletten-BINs (Zone P)
- Daten laden via `fetchWarehouseBins('P', '')` aus `api/client.ts` (Zeile 3639)
- Anzeige: BIN-Code (z.B. PGA001) + ggf. Etage
- Alternativ: Text-Input mit Autocomplete (User kann auch scannen/tippen)
- Input uppercase forcen (wie in MobileOperationsView.tsx Zeile 1003)
- Visuelles Feedback: Grüner Border wenn Palette gewählt, Roter Border wenn leer
- Referenz-Pattern: MobileOperationsView.tsx Zeile 993-1008

### 1b) Integration in CaptureView

- Neuer State in CaptureView: `paletteCode: string`
- PaletteSelector wird ÜBER dem Stepper angezeigt (immer sichtbar, nicht als eigener Step)
- Wenn `paletteCode` leer → "Weiter zur Erkennung" Button disabled + Hinweis "Bitte zuerst Palette auswählen"
- `paletteCode` wird durch den gesamten Flow durchgereicht:
  - CaptureView → StepUpload (via onComplete callback)
  - StepAnalysis bekommt `paletteCode` als Prop
  - Am Ende: `ops.sourcePalette` und `ops.sourcePaletteAt` setzen

### 1c) CaptureUploadData erweitern

```typescript
export interface CaptureUploadData {
  groups: UploadGroupPayload[];
  barcodes: string;
  paletteCode: string;  // ← NEU, Pflicht
}
```

StepAnalysis muss `paletteCode` an die identifyProductV2 API weiterreichen.
Prüfe wie useIdentification.ts den paletteCode Parameter bereits akzeptiert (Zeile ~207).

---

## TEIL 2 — Multi-Produkt via Auto-Separation (Next-Level Feature)

### Konzept

User lädt ALLE Bilder von ALLEN Produkten auf einmal hoch (wie jetzt).
Gemini analysiert die Bilder und separiert automatisch nach Produkten.
Danach zeigt ein neuer Zwischen-Schritt die Zuordnung zur Korrektur.

Der Flow wird: Upload → **Auto-Gruppierung** → KI-Erkennung → Review → Preis → Channels → Zusammenfassung

### WICHTIG — Guardrails gegen Halluzination

Gemini darf KEINE Produkte erfinden. Strenge Regeln:
- Nur trennen wenn visuell KLAR unterschiedliche Produkte erkennbar sind
- Im Zweifel: EINE Gruppe (konservativ)
- Ein Bild KANN mehrere Produkte enthalten (z.B. Palette mit 5 Artikeln, Tisch mit Ware)
  → In dem Fall wird das Bild ALLEN relevanten Gruppen zugeordnet (shared image)
- Jede Gruppe muss mindestens 1 Bild-Referenz haben
- Keine Gruppe ohne Bildzuordnung
- Gemini zählt nur was SICHTBAR ist — nie raten, nie "ähnliche Produkte" erfinden

### 2a) Neuer Step: StepGrouping (Zwischen Upload und Analyse)

Erstelle `components/capture/StepGrouping.tsx`:

```typescript
interface ProductGroupProposal {
  id: string;
  label: string;           // "Produkt 1", "Produkt 2", ...
  imageIndices: number[];   // Indices der Bilder (0-basiert) — ein Bild kann in MEHREREN Gruppen sein
  confidence: number;       // 0-1, wie sicher ist Gemini
  reason: string;           // "Unterschiedliche Verpackung erkannt"
  detectedBarcode?: string; // Falls OCR einen Barcode auf dem Bild fand
}

interface StepGroupingProps {
  images: ImagePreview[];        // Alle hochgeladenen Bilder
  proposals: ProductGroupProposal[];  // Gemini-Vorschlag
  onConfirm: (groups: ConfirmedGroup[]) => void;
  onBack: () => void;
}
```

**UI-Layout:**

```
┌────────────────────────────────────────────────────────┐
│  KI hat X Produkte in Y Bildern erkannt                │
│  Prüfe die Zuordnung und korrigiere bei Bedarf.        │
│                                                        │
│  ┌─ Produkt 1 (Confidence: 95%) ─────────────────────┐ │
│  │ [Bild1] [Bild3] [Bild5]    Barcode: 4006381...    │ │
│  │                              [× Gruppe löschen]    │ │
│  └────────────────────────────────────────────────────┘ │
│  ┌─ Produkt 2 (Confidence: 82%) ─────────────────────┐ │
│  │ [Bild2] [Bild4]            Barcode: —              │ │
│  │                              [× Gruppe löschen]    │ │
│  └────────────────────────────────────────────────────┘ │
│                                                        │
│  [+ Neue Gruppe]   [Alle in eine Gruppe]               │
│                                                        │
│  Bilder per Drag & Drop zwischen Gruppen verschieben.  │
│                                                        │
│              [Zurück]  [Zuordnung bestätigen →]         │
└────────────────────────────────────────────────────────┘
```

**Interaktionen:**
- Drag & Drop: Bilder zwischen Gruppen verschieben (HTML5 Drag API)
- "+ Neue Gruppe": Leere Gruppe erstellen, Bilder reinziehen
- "Alle in eine Gruppe": Reset — alle Bilder zurück in eine Gruppe
- "× Gruppe löschen": Bilder werden in die erste Gruppe verschoben
- Jede Gruppe hat optionales Barcode-Input
- "Zuordnung bestätigen" → weiter zu StepAnalysis mit bestätigten Gruppen

### 2b) Backend: Neuer Endpoint für Bild-Gruppierung

WICHTIG: Der Grouping-Endpoint empfängt die Bilder als FormData (File-Upload),
NICHT als URLs. Grund: Zum Zeitpunkt des Groupings sind die Bilder noch nicht
auf Cloud Storage hochgeladen. Das passiert erst im identifyProductV2 Call.

Der Endpoint muss die Bilder temporär in den Speicher laden und als
base64/Buffer an Gemini Vision senden (wie runSerpapiFreePipeline es für
den Identify-Call schon tut).

Neuer Endpoint: `POST /api/v2/group-images`

```javascript
// routes/identify.js

router.post('/api/v2/group-images', requirePermission('identify', 'run'),
  upload.array('images'), async (req, res) => {
  try {
    const files = req.files || [];
    const barcodes = req.body?.barcodes || '';

    if (files.length < 2 && !barcodes.trim()) {
      // Nur 1 Bild ohne Barcodes → kein Grouping nötig, ABER:
      // 1 Bild kann trotzdem mehrere Produkte zeigen. Nur skippen wenn
      // der User es auch bei 1 Bild möchte (Frontend entscheidet).
      // Backend gruppiert immer wenn aufgerufen.
    }

    // Bilder als base64 für Gemini Vision vorbereiten
    const imageBuffers = files.map((f, idx) => ({
      id: idx,
      buffer: f.buffer,
      mimeType: f.mimetype,
      filename: f.originalname,
    }));

    const { buildGroupingPrompt, parseGroupingResponse } = require('../services/image-grouping');
    const prompt = buildGroupingPrompt(files.length);

    // callGemini mit inline images (base64) — wie in enrichment.js
    const { callGeminiVision } = require('../lib/gemini-client');
    const response = await callGeminiVision(prompt, imageBuffers, {
      temperature: 0.1,  // Ultra-konservativ: keine Halluzinationen
    });

    const groups = parseGroupingResponse(response, files.length);

    // Validierung: jedes Image-Index muss in mindestens einer Gruppe sein
    const allIndices = new Set();
    groups.forEach(g => g.image_indices.forEach(i => allIndices.add(i)));
    const orphaned = [];
    for (let i = 0; i < files.length; i++) {
      if (!allIndices.has(i)) orphaned.push(i);
    }
    // Orphaned Images der ersten Gruppe zuordnen
    if (orphaned.length && groups.length) {
      groups[0].image_indices.push(...orphaned);
    }

    res.json({ ok: true, data: { groups, imageCount: files.length } });
  } catch (err) {
    console.error(`[POST /api/v2/group-images] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'GROUPING_FAILED', message: err.message } });
  }
});
```

### 2b-extra) callGeminiVision Helper

Prüfe ob `lib/gemini-client.js` bereits eine Funktion hat die Bilder als
inline base64 an Gemini Vision sendet. Falls nicht, erstelle eine:

```javascript
// lib/gemini-client.js — neue Funktion
async function callGeminiVision(textPrompt, imageBuffers = [], options = {}) {
  // imageBuffers = [{ buffer: Buffer, mimeType: 'image/jpeg' }, ...]
  // Sendet text + images als multimodal request an Gemini
  const parts = [
    { text: textPrompt },
    ...imageBuffers.map(img => ({
      inlineData: {
        mimeType: img.mimeType || 'image/jpeg',
        data: img.buffer.toString('base64'),
      }
    }))
  ];
  // ... Gemini API call mit parts ...
}
```

Prüfe enrichment.js wie es aktuell Images an Gemini sendet und nutze
dasselbe Pattern. KEIN neues Package, kein neuer Gemini-Client.

### 2c) Gemini Grouping Prompt

Erstelle `services/image-grouping.js`:

```javascript
function buildGroupingPrompt(imageCount) {
  return [
    'Du bist ein Bildanalyse-Experte für Produktfotos in einem E-Commerce-Warenlager.',
    '',
    `Dir werden ${imageCount} Bilder gezeigt. Deine Aufgabe:`,
    '1. Erkenne wie viele VERSCHIEDENE Produkte in den Bildern zu sehen sind.',
    '2. Gruppiere die Bilder nach Produkten.',
    '3. WICHTIG: Ein einzelnes Bild kann MEHRERE Produkte zeigen (z.B. Palette, Tisch mit Ware, Regal).',
    '   In dem Fall ordne das Bild ALLEN Gruppen zu, deren Produkt darauf sichtbar ist.',
    '',
    'STRENGE REGELN:',
    '- Zähle NUR Produkte die du auf den Bildern KLAR SIEHST.',
    '- Erfinde KEINE Produkte. Im Zweifel: alles in EINE Gruppe.',
    '- Mehrere Ansichten desselben Produkts (Vorne, Hinten, Seite, Detail) = EINE Gruppe.',
    '- Unterschiedliche Farben/Varianten desselben Modells = EINE Gruppe.',
    '- Nur wenn Marke ODER Produkttyp ODER Form klar unterschiedlich → separate Gruppe.',
    '- Falls ein Bild einen Barcode/EAN zeigt: notiere ihn bei der Gruppe.',
    '- Ein Bild darf in MEHREREN Gruppen vorkommen wenn es mehrere Produkte zeigt.',
    '- Übersichtsfotos (mehrere Produkte auf einem Bild) gehören zu JEDER dort sichtbaren Gruppe.',
    '',
    'Antworte NUR mit JSON:',
    '```json',
    '{',
    '  "product_count": <Zahl>,',
    '  "groups": [',
    '    {',
    '      "label": "Produkt 1",',
    '      "image_indices": [0, 2, 4],',
    '      "confidence": 0.95,',
    '      "reason": "Gleiche Nike Schachtel von drei Seiten",',
    '      "detected_barcode": "4006381333931" oder null',
    '    }',
    '  ]',
    '}',
    '```',
    '',
    'Beispiel: 3 Bilder — Bild 0 zeigt Übersicht (Nike Schuh + Adidas Jacke), Bild 1 zeigt Nike Schuh Detail, Bild 2 zeigt Adidas Jacke Detail:',
    '→ Produkt 1: image_indices [0, 1] (Nike Schuh), Produkt 2: image_indices [0, 2] (Adidas Jacke)',
    '→ Bild 0 ist in BEIDEN Gruppen weil beide Produkte sichtbar sind.',
  ].join('\n');
}
```

### 2d) StepAnalysis → Multi-Produkt fähig machen

AKTUELL (StepAnalysis.tsx:69):
```typescript
const group = uploadData.groups[0];  // ← NUR ERSTES
const result = await identifyProductV2(group?.images || [], ...);
onComplete(result.data!);  // ← EIN Produkt
```

NEU:
```typescript
// uploadData.groups enthält jetzt die bestätigten Gruppen aus StepGrouping.
// Jede Gruppe hat: { id, label, imageIndices, barcodes, files }
// files = die tatsächlichen File-Objekte die zu dieser Gruppe gehören.
//
// WICHTIG: Ein Bild kann in mehreren Gruppen sein (shared image).
// identifyProductV2 bekommt die Files der jeweiligen Gruppe.

const results: Product[] = [];
const errors: { groupLabel: string; error: string }[] = [];

// Sequentiell alle Gruppen identifizieren (NICHT parallel — siehe BUG-079!)
for (let i = 0; i < uploadData.groups.length; i++) {
  const group = uploadData.groups[i];
  setPhaseLabel(`${group.label} (${i + 1}/${uploadData.groups.length})...`);
  setProgress(Math.round(((i + 0.5) / uploadData.groups.length) * 100));

  try {
    const result = await identifyProductV2(
      group.files,                          // File[] für diese Gruppe
      group.barcodes || "",                  // Barcode pro Gruppe
      "de-DE",
      undefined,                            // inventoryId
      uploadData.paletteCode                // Palette durchreichen
    );

    if (result.ok && result.data) {
      results.push(result.data);
    } else {
      errors.push({ groupLabel: group.label, error: result.error?.message || "Unbekannter Fehler" });
    }
  } catch (err: any) {
    errors.push({ groupLabel: group.label, error: err?.message || "Netzwerkfehler" });
  }
}

if (errors.length > 0 && results.length === 0) {
  onError(`Alle ${errors.length} Produkte fehlgeschlagen: ${errors.map(e => e.groupLabel).join(', ')}`);
  return;
}

if (errors.length > 0) {
  // Partial success: zeige Warning-Toast aber gehe weiter
  showToast(`${errors.length} von ${uploadData.groups.length} Produkten fehlgeschlagen`, 'warning');
}

onComplete(results);  // ← ARRAY von Produkten
```

### 2e) CaptureView State: Singular → Plural

```typescript
// VORHER:
const [product, setProduct] = useState<Product | null>(null);

// NACHHER:
const [products, setProducts] = useState<Product[]>([]);
const [activeProductIndex, setActiveProductIndex] = useState(0);
```

### 2f) Stepper erweitern

```typescript
const STEPS: Step[] = [
  { id: "upload", label: "Bilder hochladen" },
  { id: "grouping", label: "Gruppierung" },     // ← NEU
  { id: "analysis", label: "KI-Erkennung" },
  { id: "review", label: "Prüfen & Korrigieren" },
  { id: "pricing", label: "Preis & Lager" },
  { id: "channels", label: "Marktplätze" },
  { id: "summary", label: "Zusammenfassung" },
];
```

### 2g) Review/Pricing/Channels: Multi-Produkt Navigation

Wenn `products.length > 1`:
- Oben im Step: Tab-Leiste "Produkt 1 | Produkt 2 | ..." mit aktuellem Produkt highlighted
- Badge an jedem Tab: ✓ wenn bereits bearbeitet, ● wenn aktuell
- User kann zwischen Produkten wechseln
- "Weiter" erst möglich wenn ALLE Produkte im Step bearbeitet sind

### 2h) Sonderfall: Grouping überspringen

Grouping-Step NUR überspringen wenn BEIDE Bedingungen erfüllt sind:
- Genau 1 Bild hochgeladen UND
- Genau 0 oder 1 Barcode angegeben

ACHTUNG: Auch 1 Bild kann mehrere Produkte zeigen (Palettenfotos, Übersichtsbilder)!
Wenn der User mehrere Barcodes eingibt aber nur 1 Bild → Grouping trotzdem aufrufen,
weil die Barcodes verschiedene Produkte implizieren.

Optional: Checkbox/Toggle im Upload-Step: "Dieses Bild zeigt mehrere Produkte"
→ Forciert Grouping auch bei 1 Bild + 0 Barcodes.

### 2i) Sonderfall: Gemini erkennt nur 1 Produkt

Wenn Gemini `product_count: 1` zurückgibt → Grouping-Step ZEIGEN aber als
"bestätigt" vorausfüllen. Kurzer Hinweis: "KI hat 1 Produkt erkannt — stimmt das?"
User kann mit einem Klick bestätigen ODER manuell weitere Gruppen hinzufügen.
→ Kein Auto-Skip, weil Gemini sich irren kann.

### 2j) Frontend API Client erweitern

In `api/client.ts` — ZWEI neue Funktionen:

```typescript
// 1) Grouping-Endpoint: sendet Bilder als FormData (wie identifyProductV2)
export async function groupImages(
  files: File[],
  barcodes?: string
): Promise<ApiResult<{ groups: ProductGroupProposal[]; imageCount: number }>> {
  const formData = new FormData();
  files.forEach((file) => formData.append('images', file));
  if (barcodes) formData.append('barcodes', barcodes);

  const response = await fetchApi(`${BACKEND_URL}/api/v2/group-images`, {
    method: 'POST',
    body: formData,
  });
  return parseResponse(response);
}
```

WICHTIG: `identifyProductV2` Return-Type anpassen ist NICHT nötig.
Der Capture-Flow ruft identifyProductV2 einmal PRO GRUPPE auf (sequentiell).
Jeder Call gibt EIN Product zurück. Das Frontend sammelt die Ergebnisse in ein Array.

### 2k) parseGroupingResponse — Robuste Validierung

In `services/image-grouping.js`:

```javascript
function parseGroupingResponse(rawResponse, imageCount) {
  // Gemini kann JSON in Markdown-Codeblocks wrappen
  let text = typeof rawResponse === 'string' ? rawResponse : JSON.stringify(rawResponse);
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) text = jsonMatch[1].trim();

  const parsed = JSON.parse(text);
  const groups = Array.isArray(parsed?.groups) ? parsed.groups : [];

  // Validierung
  return groups
    .filter(g => Array.isArray(g.image_indices) && g.image_indices.length > 0)
    .map((g, idx) => ({
      id: `group_${idx}`,
      label: g.label || `Produkt ${idx + 1}`,
      image_indices: g.image_indices.filter(i => typeof i === 'number' && i >= 0 && i < imageCount),
      confidence: typeof g.confidence === 'number' ? Math.min(1, Math.max(0, g.confidence)) : 0.5,
      reason: typeof g.reason === 'string' ? g.reason : '',
      detected_barcode: typeof g.detected_barcode === 'string' ? g.detected_barcode : null,
    }))
    .filter(g => g.image_indices.length > 0);
}

module.exports = { buildGroupingPrompt, parseGroupingResponse };
```

---

## TEIL 3 — Layout & Platznutzung

Die aktuelle UI verschwendet Platz. Konkreter Plan:

### 3a) CaptureView Layout

AKTUELL:
```
max-w-4xl mx-auto p-6  →  Zentriert, ~896px, viel Leerraum links/rechts
```

NEU:
```
max-w-6xl mx-auto p-6  →  Breiter, ~1152px
```

Oder besser: 2-Spalten-Layout wenn Viewport breit genug:
```
┌──────────────────────────────────────────────────────┐
│ Palette: [PGA001 ▼]                                  │
├──────────────────────────────────────────────────────┤
│ Stepper: [1] ─ [2] ─ [3] ─ [4] ─ [5] ─ [6]         │
├──────────────────────────┬───────────────────────────┤
│ Dropzone / Bilder        │ Barcode + Info-Panel      │
│ (Hauptbereich, ~65%)     │ (Sidebar, ~35%)           │
│                          │                           │
│ [Bild] [Bild] [Bild]    │ EAN: ____________         │
│ [Bild] [Bild] [+Mehr]   │                           │
│                          │ Hinweis: Bilder von       │
│                          │ allen Seiten aufnehmen    │
│                          │ für beste Erkennung.      │
├──────────────────────────┴───────────────────────────┤
│                        [Weiter zur Erkennung →]      │
└──────────────────────────────────────────────────────┘
```

### 3b) StepUpload Dropzone kompakter

AKTUELL: `min-h-[300px]` — zu groß, besonders wenn Bilder schon hochgeladen sind.

NEU:
- Ohne Bilder: `min-h-[240px]` — etwas kompakter
- Mit Bildern: `min-h-[120px]` — Dropzone schrumpft, Platz für Thumbnails
- Thumbnails größer: `grid-cols-4 md:grid-cols-6` statt `grid-cols-3 sm:grid-cols-4 md:grid-cols-5`

### 3c) Beschreibungstext umplatzieren

AKTUELL in CaptureView.tsx Zeile 141-143:
```tsx
<p className="text-sm text-txt-muted mt-1">
  Lade Bilder hoch, lasse die KI das Produkt erkennen und prüfe die Ergebnisse.
</p>
```

→ Diesen Text in die SIDEBAR (rechte Spalte) verschieben oder als Tooltip/Info-Icon.
Header nur noch: `<h1>Produkt erfassen</h1>` + Palette-Selector.

### 3d) Responsive Breakpoints

- < 1024px: Einspaltiges Layout (wie jetzt, aber max-w-5xl)
- ≥ 1024px: Zwei-Spalten mit Dropzone links, Barcode/Info rechts

---

## TEIL 4 — Drag & Drop Verbesserungen

### 4a) Drag-Feedback

- Beim Dragover: Pulsierender Border + "Loslassen zum Hochladen" Text
- Beim Drop: Kurze Animation (Thumbnail erscheint mit Scale-In)
- Multi-File Drop: Toast "X Bilder hinzugefügt"

### 4b) Image Reordering

- Thumbnails per Drag & Drop umsortierbar (erstes Bild = Hauptbild)
- Visual: Drag-Handle Icon auf jedem Thumbnail
- Nutze HTML5 Drag API (kein externes Package nötig)

### 4c) Quick-Add Button

- Neben der Dropzone: Kleiner "+ Bilder" Button (nicht nur Click auf die Dropzone)
- Besonders nützlich wenn Dropzone bereits Bilder enthält und kleiner ist

---

## TEIL 5 — Abschluss & Tests

1. `npx tsc --noEmit` — keine neuen TypeScript-Fehler
2. `cd backend && npm test` — bestehende Tests dürfen nicht brechen
3. Neuer Test: `__tests__/services/image-grouping.test.js`
   - Test parseGroupingResponse: valides JSON → Gruppen korrekt geparst
   - Test parseGroupingResponse: JSON in Markdown-Codeblock → extrahiert
   - Test parseGroupingResponse: invalider Index (>= imageCount) → gefiltert
   - Test parseGroupingResponse: leere Gruppen → entfernt
   - Test parseGroupingResponse: orphaned images → erster Gruppe zugeordnet
4. Palette-Flow testen: Ohne Palette → disabled. Mit Palette → weiter möglich.
5. Grouping-Flow testen:
   - 1 Bild, 0 Barcodes → Grouping zeigt 1 Gruppe, User bestätigt
   - 3 Bilder verschiedene Produkte → 3 Gruppen vorgeschlagen
   - 5 Bilder, 2 Produkte → korrekte Gruppierung
   - Drag & Drop zwischen Gruppen → Bilder verschieben sich
   - "Alle in eine Gruppe" → Reset funktioniert
6. TASKS.md aktualisieren
7. Zusammenfassung
```

## Kontext für Mensch

### Was wird verbessert:
- **Palette-Pflicht**: Alle erfassten Produkte bekommen sofort eine Paletten-Zuordnung (Rückverfolgbarkeit Einkauf → Produkt)
- **Auto-Separation**: Alle Bilder hochladen → Gemini erkennt und gruppiert automatisch → User bestätigt/korrigiert → jedes Produkt einzeln identifizieren
- **Platz**: 2-Spalten-Layout, kompaktere Dropzone, Info-Text in Sidebar
- **Drag & Drop**: Besseres Feedback, Image Reordering, Quick-Add Button

### Abhängigkeiten:
- `fetchWarehouseBins('P', '')` muss Zone-P BINs zurückliefern (Backend existiert bereits)
- `identifyProductV2` akzeptiert bereits `paletteCode` (Backend identify.js Zeile 230)
- `useIdentification.ts` threaded `paletteCode` bereits durch (Zeile 207)
- Gemini Vision API muss multiple Images in einem Request akzeptieren (tut es bereits — enrichment.js:690)
- BUG-079 Fix (sequentielles Processing) ist VORAUSSETZUNG für Teil 2

### Priorisierung innerhalb des Prompts:
1. **Palette-Auswahl** — P0, muss sofort rein
2. **Layout & Platz** — P1, schneller Gewinn
3. **Drag & Drop Verbesserungen** — P1
4. **Auto-Separation Multi-Produkt** — P1, aber benötigt BUG-079 Fix zuerst

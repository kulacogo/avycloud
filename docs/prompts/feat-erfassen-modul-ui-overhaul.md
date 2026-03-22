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

## TEIL 2 — Multi-Produkt Support

Aktuell: StepUpload erstellt EINE Gruppe mit allen Bildern → ein Produkt.
Neu: Mehrere Produkt-Gruppen in einer Session.

### 2a) Gruppen-Management in StepUpload

- State: `groups: ProductGroup[]` statt `images: ImagePreview[]`
  ```typescript
  interface ProductGroup {
    id: string;
    label: string;       // "Produkt 1", "Produkt 2", ...
    images: ImagePreview[];
    barcodes: string;     // Barcode pro Gruppe
  }
  ```
- Initial: Eine leere Gruppe "Produkt 1"
- Button "+ Weiteres Produkt" fügt neue Gruppe hinzu
- Jede Gruppe hat:
  - Eigene Dropzone (kleiner als die aktuelle, ~150px Höhe)
  - Eigenes Barcode-Input
  - Image-Thumbnails darunter
  - Delete-Button (Gruppe entfernen, wenn > 1 Gruppe)
- Drag & Drop von Bildern ZWISCHEN Gruppen ermöglichen (analog ProductInput.tsx Zeile 146-385)

### 2b) onComplete anpassen

```typescript
onComplete({
  groups: groups.map(g => ({
    id: g.id,
    label: g.label,
    images: g.images.map(i => i.file),
  })),
  barcodes: groups.map(g => g.barcodes).filter(Boolean).join(','),
  paletteCode,
});
```

### 2c) StepAnalysis Multi-Produkt

- StepAnalysis zeigt Fortschritt pro Gruppe (z.B. "Produkt 1 von 3 wird erkannt...")
- Jede Gruppe wird einzeln an identifyProductV2 geschickt
- Ergebnis: Array von Produkten statt eines Einzelprodukts
- CaptureView State anpassen: `products: Product[]` statt `product: Product`
- Folge-Steps (Review, Pricing, Channels) müssen JEDES Produkt einzeln durchlaufen
  - Entweder: Tabbed Interface ("Produkt 1 | Produkt 2 | Produkt 3")
  - Oder: Sequentiell (ein Produkt nach dem anderen)
  - EMPFEHLUNG: Sequentiell — einfacher, weniger Fehlerquellen

WICHTIG: Falls Multi-Produkt zu komplex für einen Sprint → mindestens die Gruppen-UI in StepUpload vorbereiten und als TODO markieren. Priorität hat Teil 1 (Palette) und Teil 3 (Layout).

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

## TEIL 5 — Abschluss

1. `npx tsc --noEmit` — keine neuen TypeScript-Fehler
2. Visuell prüfen: Layout auf 1280px und 1920px Breite
3. Palette-Flow testen: Ohne Palette → disabled. Mit Palette → weiter möglich.
4. TASKS.md aktualisieren
5. Zusammenfassung
```

## Kontext für Mensch

### Was wird verbessert:
- **Palette-Pflicht**: Alle erfassten Produkte bekommen sofort eine Paletten-Zuordnung (Rückverfolgbarkeit Einkauf → Produkt)
- **Multi-Produkt**: Mehrere Produkte pro Session erfassen (statt nach jedem Produkt von vorn)
- **Platz**: 2-Spalten-Layout, kompaktere Dropzone, Info-Text in Sidebar
- **Drag & Drop**: Besseres Feedback, Image Reordering, Quick-Add Button

### Abhängigkeiten:
- `fetchWarehouseBins('P', '')` muss Zone-P BINs zurückliefern (Backend existiert bereits)
- `identifyProductV2` akzeptiert bereits `paletteCode` (Backend identify.js Zeile 230)
- `useIdentification.ts` threaded `paletteCode` bereits durch (Zeile 207)

### Priorisierung innerhalb des Prompts:
1. **Palette-Auswahl** — P0, muss sofort rein
2. **Layout & Platz** — P1, schneller Gewinn
3. **Drag & Drop Verbesserungen** — P1
4. **Multi-Produkt** — P2, kann auch als Follow-up

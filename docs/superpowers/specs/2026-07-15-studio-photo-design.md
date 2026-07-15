# Studio-Foto — Design (2026-07-15)

## Ziel

Im Produktdatenblatt → Bilder → „Bild verbessern" einen neuen Haupt-Button **„Studio-Foto"**:
Ein Klick macht aus einem beliebigen Produktfoto ein professionelles Studio-Packshot —
korrekte, gleichmäßige Belichtung, heller Studio-Hintergrund (Off-White mit dezentem
Verlauf, NICHT glattes #FFFFFF), weicher natürlicher Kontaktschatten unter dem Produkt.
Das Produkt selbst bleibt pixel-treu (Form, Farben, Labels, Text unverändert).

## Ist-Zustand

- Bestehende Buttons (Hintergrund entfernen / Auto-Korrektur / Drehen / Heller) sind rein
  clientseitig (Canvas + @imgly Browser-ML). Kein Relighting, kein Studio-Look möglich.
- Serverseitig existiert eine funktionierende Gemini-Bildpipeline
  (`services/image-generation.js`, `lib/vertex-ai.js`, Modell `gemini-2.5-flash-image`)
  und ein sharp-Freisteller (`lib/background-removal.js compositeOnGradient`).

## Architektur

### Backend (additiv, kein bestehender Pfad geändert)

1. **`backend/services/image-studio.js`** (neu) — `makeStudioPhoto({ productId, image })`:
   - Bild laden über bewährtes `fetchImageAsDataUrl` (direkter GET, Web Unlocker nur Fallback).
   - sharp-Pre-Pass: EXIF-Rotation, max. 1600 px Kante.
   - **Gemini-Modell-Kette:** `STUDIO_IMAGE_MODEL` (default `gemini-3-pro-image-preview`)
     → `GEMINI_IMAGE_MODEL` (default `gemini-2.5-flash-image`). Ein Studio-Prompt
     (Produkt unverändert, Relight, Off-White-Verlauf, Kontaktschatten, keine Props/Text).
   - **Ergebnis-Validierung:** dekodierbar, Mindestkante ≥ 512 px, Bildrand im Mittel hell
     (Studio-Hintergrund-Check). Ungültig → nächstes Modell → Fallback.
   - **Notfall-Fallback (deterministisch, ohne KI):** `compositeOnGradient` mit neuem
     weichem Schlagschatten (`shadow: true` in `lib/background-removal.js`).
   - Upload nach GCS via `uploadBase64Image(…, productId, 'studio')`, Rückgabe der URL.
2. **`POST /api/images/studio`** (neu in `routes/products.js`, `requirePermission('products','write')`):
   Body `{ productId, image: { url_or_base64 } }` → `{ ok, data: { image, method, model } }`.
3. **`lib/vertex-ai.js`**: `generateProductImages` bekommt optionale Parameter
   `model` und `timeoutMs` (additiv, Default-Verhalten unverändert).

### Frontend

- `components/ImageGallery.tsx`: neuer primärer Accent-Button „Studio-Foto" in der
  „Bild verbessern"-Zeile. Ruft `fetchApi('/api/images/studio')` mit aktivem Bild auf.
- **Ergebnis wird als NEUES Bild direkt hinter dem Original eingefügt** (neue optionale
  Props `productId`, `onAddImage`) — das Original bleibt erhalten (Lehre aus
  Incident „Produktbilder gelöscht" 2026-07-09). Ansicht wechselt auf das neue Bild.
- Bestehende Buttons bleiben unverändert. i18n de/en/tr.

## Fehlerbehandlung

- Jede Stufe best-effort mit klarem Grund im Log; UI bekommt strukturierte Fehlermeldung.
- Kein Pfad wirft ohne dass vorher Gemini-Kette UND sharp-Fallback probiert wurden.
- Timeout pro Gemini-Call (`STUDIO_IMAGE_TIMEOUT_MS`, default 60 s).

## Tests

- `__tests__/image-studio.test.js`: Modell-Kette (1. ok / 1. kaputt → 2. ok / beide kaputt
  → Fallback), Validierung verwirft dunkle Ergebnisse, Upload-Fehler propagiert.
- `__tests__/background-removal-shadow.test.js`: Schatten-Compositing liefert gültiges Bild.
- Route-Test für `POST /api/images/studio` (Auth + Happy Path + 400).

## Nicht im Scope (YAGNI)

- Batch über alle Bilder, Identity-Check per Vision-Modell, Reparatur der stummen
  `image-enhance.js`-Gemini-Integration im Identify-V4 (Nebenbefund, separat).

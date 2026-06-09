# FEAT: Palette-Zuordnung Pflicht bei Identify (neue Ware)

## Prompt für Claude Code

```
Lies CLAUDE.md und TASKS.md.
Dann: cd backend && npm test && npm run build — Baseline prüfen.

## Kontext

Jedes Produkt das durch den Identify-Prozess erkannt wird und noch keine BIN-Zuordnung hat (= neue Ware die eingelagert werden muss), MUSS eine Paletten-Zuordnung (Zone P) bekommen. Damit ist historisch nachvollziehbar aus welchem Einkauf/Wareneingang die Produkte stammen.

### Ist-Zustand

Backend: `backend/routes/identify.js` akzeptiert bereits `paletteCode` (Zeile ~230) und speichert es als `ops.sourcePalette` + `ops.sourcePaletteAt` auf dem Produkt — aber nur wenn der Client es mitschickt. Es ist optional.

Frontend: `components/MobileOperationsView.tsx` hat bereits ein Palette-Scan-Feld (Zeile ~993–1008, State `identifyPaletteCode` Zeile 125). Es steht "Palette (optional)" und wird über `onIdentify(payload, '', identifyPaletteCode || undefined)` durchgereicht.

Durchfädelung: MobileOperationsView → App.tsx `handleIdentification` (Zeile ~578) → `hooks/useIdentification.ts` `enqueueIdentification` → `startJobForGroup` → `identifyProductV2()` in `api/client.ts`. Alles akzeptiert bereits `paletteCode` als optionalen Parameter.

Stow: `handleSubmitStow` (MobileOperationsView Zeile ~699) liest `product.ops.sourcePalette` und schickt es als `meta.paletteCode` beim Stock-In mit.

TypeScript: `types.ts` Interface `Ops` hat bereits `sourcePalette?: string | null` und `sourcePaletteAt?: string | null`.

### Soll-Zustand

1. **Palette wird Pflichtfeld im Identify-Flow (Frontend)**
   - `MobileOperationsView.tsx`: Label von "Palette (optional)" ändern zu "Palette (Pflicht)"
   - Der "Identifizieren" Button (Zeile ~1095) muss disabled sein wenn `identifyPaletteCode` leer ist
   - Visuelles Feedback: Wenn keine Palette gescannt → roter Hinweis "Bitte zuerst Palette scannen"
   - Wenn Palette gescannt → grüner Hinweis (existiert schon: "Palette PGA001 aktiv")

2. **Backend-Validierung (identify.js)**
   - POST `/api/v2/identify` (Zeile ~228): Wenn `paletteCode` fehlt oder leer → HTTP 400 mit `{ ok: false, error: { code: 'PALETTE_REQUIRED', message: 'Paletten-Zuordnung ist Pflicht für neue Ware.' } }`
   - WICHTIG: Nur für neue Produkte erzwingen. Bei bestehenden Produkten (Stock-Protection-Pfad, Zeile ~250) ist Palette nice-to-have aber nicht blockierend — das Produkt existiert ja schon und hat ggf. bereits eine Palette aus dem Ersteingang.

3. **Palette-Validierung: Existenz prüfen**
   - Bevor Identify startet, prüfen ob der gescannte Palette-Code tatsächlich als BIN in Firestore existiert (Collection `warehouse_bins_{tenantId}`, Zone P)
   - Backend: In identify.js, wenn `paletteCode` angegeben, kurzer Firestore-Lookup:
     ```js
     const paletteBin = await binsCollection.doc(paletteCode).get();
     if (!paletteBin.exists) {
       return res.status(400).json({ ok: false, error: { code: 'PALETTE_NOT_FOUND', message: `Palette ${paletteCode} existiert nicht.` } });
     }
     ```
   - Beachte: `binsCollection` muss mit dem richtigen tenantId aufgebaut werden — siehe `backend/lib/warehouse.js` wie die Collection referenziert wird.

4. **Produkt-Ansicht: Palette anzeigen**
   - Auf der Produktdetailseite (rechte Seite im Screenshot) unter "LAGERPLATZ" auch die Palette anzeigen wenn `ops.sourcePalette` gesetzt ist
   - Format: "Palette: PGA001 (seit 21.03.2026)" — aus `ops.sourcePalette` + `ops.sourcePaletteAt`
   - Datei: Suche nach dem LAGERPLATZ-Abschnitt in den Frontend-Komponenten (vermutlich in einer ProductDetail- oder ProductSheet-Komponente)

5. **Tests**
   - Backend-Test: Identify ohne paletteCode → 400 PALETTE_REQUIRED
   - Backend-Test: Identify mit ungültigem paletteCode → 400 PALETTE_NOT_FOUND
   - Backend-Test: Identify mit gültigem paletteCode → Produkt hat ops.sourcePalette gesetzt
   - Backend-Test: Bestehedes Produkt (Stock-Protection) ohne paletteCode → kein Fehler (nice-to-have)

6. `cd backend && npm test` — alle Tests müssen grün sein.

7. TASKS.md aktualisieren.
```

## Kontext für Mensch

- Backend-Seite ist vorbereitet: `identify.js` + `warehouse.js` akzeptieren paletteCode, speichern in ops.sourcePalette
- Frontend-Seite ist vorbereitet: Palette-Scan-Feld existiert, Durchfädelung bis zum API-Call steht
- Fehlend: Pflicht-Validierung (Frontend + Backend), Existenz-Check, Anzeige auf Produktseite
- Palette = Zone P BIN (z.B. PGA001, PGA002) — wird über Lager-Struktur angelegt
- Zweck: Einkaufs-/Wareneingangs-Traceability. "Aus welcher Palette stammt dieser Artikel?"

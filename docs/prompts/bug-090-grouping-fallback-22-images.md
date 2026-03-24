# BUG-090: Gruppierung fällt auf Fallback zurück bei vielen unterschiedlichen Produkten

## Symptom
22 verschiedene Produktbilder hochgeladen (Bücher, Taschen, Werkzeug, Kleidung etc.).
KI erkennt "1 Produkt in 22 Bildern" — alle in eine Gruppe mit "Fallback: alle Bilder in eine Gruppe".

## Root Cause
3 Probleme im Zusammenspiel:

### 1. Gemini gibt leere Response bei vielen Bildern
`callGeminiVision()` in `lib/gemini-client.js` sendet alle 22 Bilder als Base64 inline.
Bei 22 Bildern × ~200KB = ~4.4MB Base64 → Gemini hat Token-Limit-Probleme oder gibt ungültige JSON-Response.
`parseGroupingResponse()` gibt `[]` zurück → Fallback greift still (kein Error-Log).

### 2. Prompt ist kontraproduktiv
`buildGroupingPrompt()` in `services/image-grouping.js` Zeile 15:
```
"Im Zweifel: alles in EINE Gruppe."
```
Das ist genau das Gegenteil vom gewünschten Verhalten wenn viele verschiedene Produkte hochgeladen werden.
Besser: "Im Zweifel: lieber eine Gruppe zu viel als zu wenig. Nur zusammenfassen wenn Produkte KLAR zusammengehören."

### 3. Kein Error-Logging bei leerem Response
Zeile 931-941 in `routes/identify.js`: Wenn Gemini leere/ungültige Response gibt → stiller Fallback.
Kein `console.warn` oder Metric, das den Fehler sichtbar macht.

## Betroffene Dateien

| Datei | Problem |
|-------|---------|
| `backend/services/image-grouping.js` | Prompt-Text zu konservativ |
| `backend/lib/gemini-client.js` | Keine Bild-Kompression, kein Batching, zu niedriges maxOutputTokens |
| `backend/routes/identify.js` (Zeile 910-948) | Stiller Fallback, kein Error-Log |

## Fixes

### Fix 1: Bilder komprimieren + Batching bei >10 Bildern
In `callGeminiVision()` oder im Grouping-Pfad in `routes/identify.js`:
- Alle Bilder mit sharp auf max 800px Breite + JPEG 70% komprimieren (Gruppierung braucht keine hohe Auflösung)
- Bei >15 Bildern: Zweistufig vorgehen:
  1. Erste Runde: Jedes Bild einzeln an Gemini → "Was zeigt dieses Bild?" (Label + Kategorie)
  2. Zweite Runde: Labels clustern (String-Matching / Embedding Similarity)

  ODER einfacher: Bilder in Batches à 8-10 senden, dann Gruppen mergen.

### Fix 2: Prompt umschreiben
Ersetze `buildGroupingPrompt()` — neuer Prompt muss:
- Explizit sagen: "Diese Bilder zeigen WAHRSCHEINLICH verschiedene Produkte"
- Statt "Im Zweifel eine Gruppe" → "Im Zweifel separate Gruppen"
- Stärkere Signale für Trennung: verschiedene Verpackungen, verschiedene Marken, verschiedene Farben → separate Gruppen
- `maxOutputTokens` auf 4096 erhöhen (22 Gruppen brauchen mehr Output)

### Fix 3: Error-Logging bei Fallback
In `routes/identify.js` Zeile 931:
```js
if (!groups.length) {
  console.warn(`[group-images] Gemini returned empty response for ${files.length} images. Raw: ${response?.substring(0, 200)}`);
  // ... Fallback
}
```

### Fix 4 (optional): Structured Output statt Free-Text
Nutze `callGeminiStructured()` (wie bei `detectMultipleProducts`) statt `callGeminiVision()`.
Schema erzwingt gültiges JSON. Aktuell ist Grouping der einzige Pfad der noch unstrukturiertes Text-JSON nutzt.

## Priorität
Ohne diesen Fix ist das gesamte Multi-Produkt-Erfassen bei >10 Bildern kaputt.

## Tests
- Bestehende: `backend/__tests__/image-grouping.test.js` (25 Tests)
- Neue Tests:
  - `parseGroupingResponse` mit 22 Bildern, 15 verschiedene Gruppen → alle korrekt geparsed
  - `buildGroupingPrompt` enthält nicht mehr "alles in EINE Gruppe"
  - Fallback loggt Warning wenn ausgelöst
  - Batch-Test: Gruppierung mit >15 Bildern gibt >1 Gruppe zurück (Integration-Test / Mock)

## Validierung
1. `cd backend && npm test` — alle Tests grün
2. 22 verschiedene Bilder hochladen → Gruppierung zeigt >1 Produkt
3. 5 Bilder vom selben Produkt → werden korrekt in 1 Gruppe zusammengefasst

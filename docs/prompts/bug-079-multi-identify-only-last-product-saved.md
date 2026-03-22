# BUG-079: Multi-Identify liefert nur letztes Produkt

> Schwere: **P0** — Datenverlust (5 von 6 Produkten gehen verloren)
> Betrifft: `hooks/useIdentification.ts`, `App.tsx`

## Symptom

User lädt 6 Produkte mit je eigenen Fotos in den Identify-Prozess. Ergebnis: Nur Produkt 6 wird erstellt/angezeigt. Produkte 1-5 fehlen.

## Prompt für Claude Code

```
Lies CLAUDE.md und TASKS.md.
Dann: cd backend && npm test && npm run build — Baseline prüfen.

BUG-079: Wenn ein User mehrere Produkt-Gruppen gleichzeitig identifizieren lässt
(z.B. 6 Produkte mit je eigenen Fotos), werden nur das letzte Produkt gespeichert/angezeigt.
Produkte 1-5 gehen verloren.

---

## Ursache 1: Parallele API-Calls überlastet Backend/Gemini

Datei: hooks/useIdentification.ts, Zeile 247

```typescript
groupsToProcess.forEach((group) => {
  startJobForGroup(group, barcodes, inventoryId, inventoryName, paletteCode);
});
```

Alle Gruppen werden GLEICHZEITIG gestartet. Jede Gruppe ruft `identifyProductV2` auf
(= POST /api/v2/identify → Gemini Vision API). Bei 6 parallelen Calls:
- Gemini Rate-Limiting → 429 Errors
- Backend-Timeouts (Gemini braucht 5-15s pro Call)
- Jobs 1-5 schlagen fehl, nur der letzte schafft es durch

### Fix: Sequentielle Verarbeitung

`enqueueIdentification` muss die Gruppen SEQUENTIELL abarbeiten:

```typescript
const enqueueIdentification = useCallback(
  async (
    groups: UploadGroupPayload[],
    barcodes: string,
    inventoryId?: string | null,
    inventoryName?: string | null,
    paletteCode?: string | null
  ) => {
    // ... validation bleibt gleich ...

    setError(null);

    // SEQUENTIELL statt parallel!
    for (const group of groupsToProcess) {
      await startJobForGroupAsync(group, barcodes, inventoryId, inventoryName, paletteCode);
    }
  },
  [startJobForGroupAsync, validateGroup]
);
```

Dafür muss `startJobForGroup` ein Promise zurückgeben:

```typescript
const startJobForGroupAsync = useCallback(
  async (group, barcodes, inventoryId, inventoryName, paletteCode) => {
    const localId = createLocalId();
    // ... Job erstellen + addJob() ...

    try {
      // ... identify + price refresh ...
      options?.onJobCompleted?.({ products: [finalProduct] });
      updateJob(localId, { phase: 'complete', ... });
    } catch (err) {
      updateJob(localId, { phase: 'error', ... });
      // NICHT abbrechen — nächstes Produkt trotzdem versuchen!
    }
  },
  [addJob, options?.onJobCompleted, updateJob]
);
```

WICHTIG: Bei Fehler eines Jobs trotzdem mit dem nächsten weitermachen!
Die IIFE-Async-Funktion (Zeile 117-203) muss zu einer awaitable async-Funktion
umgebaut werden die ein Promise zurückgibt.

---

## Ursache 2: Focus überschreibt sich gegenseitig

Datei: App.tsx, Zeile 448-467

```typescript
onJobCompleted: (bundle) => {
  // ...
  setProducts((prev) => {
    const merged = mergeIdentifiedProducts(bundle.products, prev);
    nextFocus = merged.focus;
    return merged.list;
  });
  const focusProduct = nextFocus as Product | null;
  if (focusProduct) {
    setCurrentProduct(focusProduct);  // ← Wird 6x überschrieben
  }
}
```

Jeder Job überschreibt `currentProduct` → User sieht nur das letzte Produkt.

### Fix: Batch-Ergebnis statt Einzel-Fokus

Option A (minimal): Keinen Focus setzen bei Multi-Produkt-Identify.
Stattdessen: Wenn `jobs.length > 1`, nach Abschluss ALLER Jobs eine Zusammenfassung anzeigen.

Option B (besser): `onJobCompleted` sammelt ALLE Ergebnisse und setzt den Fokus erst
wenn ALLE Jobs abgeschlossen sind:

In App.tsx:
```typescript
onJobCompleted: (bundle) => {
  if (!bundle?.products?.length) return;
  setProducts((prev) => {
    const merged = mergeIdentifiedProducts(bundle.products, prev);
    return merged.list;
  });
  // Focus-Logik: Nur setzen wenn es ein Einzel-Job ist
  // Bei Multi-Job: Focus wird nach Abschluss ALLER Jobs gesetzt
}
```

---

## Ursache 3: JobStatusPopup zeigt Fehler nicht prominent genug

Datei: components/JobStatusPopup.tsx

Wenn Jobs 1-5 fehlschlagen, sieht der User die Error-Toasts kurz, kann sie dismissen
und sieht am Ende nur "Produkt 6 ✅ Fertig". Es gibt keinen Gesamtstatus.

### Fix: Zusammenfassung am Ende

Wenn ALLE Jobs fertig sind (egal ob Erfolg oder Fehler), zeige eine Zusammenfassung:

```
Identifikation abgeschlossen
✅ 4 Produkte erfolgreich erkannt
⚠️ 2 Produkte fehlgeschlagen
[Fehlgeschlagene erneut versuchen] [Schließen]
```

Dafür in JobStatusPopup.tsx prüfen ob `jobs.every(j => j.finishedAt)` und dann
Summary-Zeile rendern.

---

## Test-Szenario

1. 3 Produkt-Gruppen mit je 2 Bildern erstellen
2. Identify starten
3. Erwartung: Alle 3 werden SEQUENTIELL verarbeitet
4. JobStatusPopup zeigt Fortschritt: "Produkt 1 von 3 wird erkannt..."
5. Am Ende: "3 von 3 Produkte erkannt"
6. Produktliste enthält alle 3 neuen Produkte

## Dateien

- hooks/useIdentification.ts — Sequentielle Queue statt forEach
- App.tsx (Zeile 447-467) — Focus-Logik für Multi-Job
- components/JobStatusPopup.tsx — Gesamtstatus-Zusammenfassung

## Abschluss

1. `npx tsc --noEmit` — keine neuen TS-Fehler
2. Test mit 1 Produkt: Funktioniert wie bisher
3. Test mit 3+ Produkten: Alle werden gespeichert
4. TASKS.md aktualisieren: BUG-079 als erledigt markieren
```

## Kontext

Die Root-Cause ist die parallele Ausführung in `useIdentification.ts` Zeile 247:
`groupsToProcess.forEach(group => startJobForGroup(...))` — alle Jobs feuern gleichzeitig.
Bei 6 Gemini-API-Calls parallel → Rate-Limiting, Timeouts, nur der letzte überlebt.

Zusätzlich überschreibt `setCurrentProduct()` in App.tsx den Fokus bei jedem Job-Complete.
Selbst wenn alle 6 Jobs erfolgreich wären, sieht der User nur Produkt 6 im ProductSheet.

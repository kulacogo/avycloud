# BUG-091: Multi-Identify hängt bei vielen Produkten — kein Timeout, kein Progress

## Symptom
22 Bilder hochgeladen, manuell in 9 Gruppen aufgeteilt. Step 3 (KI-Erkennung) zeigt
"Produkt 1 von 9 wird erkannt..." und bleibt dort hängen. Kein Fortschritt, kein Fehler.

## Root Cause
3 Probleme zusammen:

### 1. Kein Timeout auf `identifyProductV2()` (Frontend)
`api/client.ts` Zeile 4222: `fetchApi(BACKEND_URL + '/api/v2/identify', ...)` hat keinen
AbortController und kein Timeout. Wenn der Server nicht antwortet → ewiges Warten.

### 2. Pipeline dauert 90-160s pro Produkt (BUG-086)
`runSerpapiFreePipeline()` braucht 90-160 Sekunden pro Identify-Call.
9 Produkte sequentiell = 13-24 Minuten Wartezeit.
In der Multi-Produkt-Phase (`StepAnalysis.tsx` Zeile 100-156) gibt es KEINEN
simulierten Phase-Progress wie im Single-Modus (Zeile 57-99).
Die Progress-Bar bleibt auf 11% (1/9) für 2+ Minuten → Nutzer denkt es hängt.

### 3. Cloud Run Timeout nicht explizit gesetzt
`cloudbuild.yaml` hat kein `--request-timeout` → Default 300s.
Reicht knapp für eine Pipeline-Durchlauf, aber kein Margin bei langsamen Responses.

## Betroffene Dateien

| Datei | Problem |
|-------|---------|
| `api/client.ts` (Zeile 4191-4245) | `identifyProductV2()` ohne Timeout |
| `components/capture/StepAnalysis.tsx` (Zeile 100-156) | Multi-Modus ohne Phase-Progress |
| `backend/cloudbuild.yaml` | Kein --request-timeout |

## Fixes

### Fix 1: Timeout für identifyProductV2 (Frontend)
```typescript
// In api/client.ts: identifyProductV2()
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 180_000); // 3 min timeout
try {
  response = await fetchApi(`${BACKEND_URL}/api/v2/identify`, {
    method: 'POST',
    body: formData,
    signal: controller.signal,
  });
} finally {
  clearTimeout(timeout);
}
```

### Fix 2: Phase-Progress im Multi-Modus (Frontend)
In `StepAnalysis.tsx` Multi-Modus: Timer-basierte Phase-Simulation wie im Single-Modus.
```typescript
// Zeile ~110, vor dem await:
const phaseTimers: NodeJS.Timeout[] = [];
const phases: Phase[] = ["vision", "barcode", "web", "llm", "pricing"];
const delays = [800, 2500, 8000, 20000, 40000];
phases.forEach((p, i) => {
  phaseTimers.push(setTimeout(() => { if (!cancelled) setPhase(p); }, delays[i]));
});

// Nach dem await:
phaseTimers.forEach(clearTimeout);
```

### Fix 3: Cloud Run Timeout auf 600s erhöhen
In `cloudbuild.yaml` bei den deploy-args ergänzen:
```yaml
'--timeout', '600',
```

### Fix 4 (optional, hochprioritär): Parallelisierung
Statt 9 sequentielle Identify-Calls → Promise.allSettled mit max. 3 parallel.
Reduziert 18 Min auf ~6 Min.

```typescript
// In StepAnalysis.tsx
const CONCURRENCY = 3;
const chunks = chunkArray(groups, CONCURRENCY);
for (const chunk of chunks) {
  const results = await Promise.allSettled(
    chunk.map(group => identifyProductV2(group.images, ...))
  );
  // process results
}
```

## Priorität
P0 — ohne Fix ist Multi-Produkt-Erfassen bei >3 Produkten praktisch unbenutzbar.

## Tests
- `identifyProductV2` mit Mock-Timeout → AbortError nach 180s
- StepAnalysis Multi-Modus zeigt Phase-Progress (Unit-Test mit fake timers)
- Cloud Run timeout in cloudbuild.yaml = 600

## Zusammenhang mit anderen Bugs
- **BUG-086** (Improve-Pipeline langsam) — gleiche Pipeline, gleiche Bottlenecks
- **BUG-090** (Gruppierung Fallback) — Nutzer muss manuell gruppieren, was zu vielen Gruppen führt

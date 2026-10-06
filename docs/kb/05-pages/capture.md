---
title: Capture (Produkt-Erfassung / Identify)
for: [user, dev, admin]
lastReviewed: 2026-10-06
---

## Zweck

Produkt-Erfassung über Foto-Upload und Barcode. Aktiver Ablauf: Upload → Gruppierung → Analyse → Ergebnisse prüfen → Zusammenfassung. `/api/v2/identify` speichert neue Datenblätter bereits vor seiner Antwort über `saveProductV2`; `StepSummary` speichert anschließend die geprüften Änderungen. Ein Qualitätswert allein setzt kein Produkt auf „Bereit“ und veröffentlicht kein Angebot.

Seit 06.10.2026 zeigt `StepReview` den initialen Verkaufspreis und erlaubt dessen Korrektur direkt im Erfassungsablauf. Fehlt ein Angebot, kann der Preis dort ergänzt werden; der Chat ist dafür nicht nötig. Ungültige oder geleerte vorhandene Preise blockieren Weiter, anstatt still den alten Wert zu speichern. Ohne gefundenen Preis ist Speichern weiterhin möglich, die Zusammenfassung nennt das ausdrücklich. Bei wiederverwendeten Produkten wird der bisherige Verkaufspreis gezeigt. [Browserprüfung](../../../tools/capture/sale-price.browser-test.mjs).

## Komponente(n)

- [components/capture/CaptureView.tsx](../../../components/capture/CaptureView.tsx) — Wizard-Container, `Stepper`-Navigation.
- [components/capture/StepUpload.tsx](../../../components/capture/StepUpload.tsx) — Upload-Step (Drag&Drop, Kamera).
- [components/capture/StepGrouping.tsx](../../../components/capture/StepGrouping.tsx) — Image-Gruppierung pro Produkt (mit Backend-Hilfe; siehe BUG-090).
- [components/capture/StepAnalysis.tsx](../../../components/capture/StepAnalysis.tsx) — Identify-Lauf inkl. Phase-Progress.
- [components/capture/StepReview.tsx](../../../components/capture/StepReview.tsx) — Pre-Publish-Review der Identify-Ergebnisse.
- [components/capture/StepChannels.tsx](../../../components/capture/StepChannels.tsx) — vorhandene Komponente, aktuell nicht im CaptureView-Schrittfluss eingebunden.
- [components/capture/StepPricing.tsx](../../../components/capture/StepPricing.tsx) — vorhandene Komponente, aktuell nicht eingebunden; Verkaufspreis im aktiven `StepReview`.
- [components/capture/StepSummary.tsx](../../../components/capture/StepSummary.tsx) — Abschluss & Save.
- [components/capture/LotSelector.tsx](../../../components/capture/LotSelector.tsx) — Pflicht: Los-Auswahl (Einkaufs-Zugehörigkeit, `L-MMYYNN`/`NL-MMYY`; Lose werden unter Lager → Los-Struktur angelegt).

## API-Calls

- `StepGrouping` ruft `groupImages`, `StepAnalysis` ruft `identifyProductV2` aus `api/client.ts`.
- `POST /api/v2/group-images` gruppiert Fotos.
- `POST /api/v2/identify` erkennt und speichert ein Datenblatt, mit verpflichtendem Los für neue Ware.
- `StepSummary` verwendet `saveProduct(product, { activity: "capture" })` für geprüfte Änderungen.
- [API-Vertrag](../09-api/identify.md).

## Datenquellen

`components/capture/captureSellPrice.ts` prüft leere, ungültige und manuell korrigierte Preise.

`CaptureView` hält Gruppen und Produktantworten im lokalen React-State. Die Verarbeitung erfolgt gruppenweise mit Fortschrittsanzeige. Ergebnisprüfung aktualisiert den lokalen Produktdatensatz; die Zusammenfassung speichert ihn über den regulären API-Client.

## Wichtige Edge-Cases

- **Foto prüfen und Gruppierung korrigieren:** Klick/Antippen auf ein Foto öffnet die große Originalvorschau, auch bei Fotos ohne Gruppe und bei mehreren Produkten auf einem Foto. Zoom bis 4×, Pfeiltasten/Weiter-Zurück und Escape sind verfügbar. Die aktuelle Gruppenzuordnung steht am Bild. Schließen gibt den Fokus zurück; Gruppen und Eingaben bleiben erhalten, es wird keine neue KI-Gruppierung ausgelöst. Ziehen dient weiterhin dem Umgruppieren. Implementierung: [CaptureImagePreview.tsx](../../../components/capture/CaptureImagePreview.tsx).

- **Sehr viele Bilder**: Gruppierung kann auf Fallback fallen (siehe BUG-090). Workaround: max 30 Bilder pro Batch (UI-seitig nicht hart enforced, Backend-Limit greift).
- **Multi-Identify hängt**: bei vielen Produkten ohne Timeout-Progress (BUG-091 ✅ gefixt: Concurrency 3, Phase-Progress, Cloud-Run-Timeout 600s).
- **Loading**: Step-Progress über Stepper-Komponente; pro Step lokaler Spinner.
- **Error pro Phase**: Fehlt z. B. die Image-Quality-Analyse (`STAGE1_IMAGE_QUALITY_GATE`), läuft die Pipeline trotzdem weiter (nur Metadata fehlt).
- **Speicherung**: Die Erfassungsroute speichert vor der Antwort; „Produkt speichern“ übernimmt anschließend manuelle Korrekturen. Der V4-Service wird von dieser Route mit `autosave: false` aufgerufen, damit nur die gemeinsame Route initial schreibt.
- **V4-Fallback**: bei Pipeline-Error in V4 fällt der Backend automatisch auf V3 zurück; im Frontend nicht sichtbar außer in `IdentifyV4Badge` (siehe ProductSheet).
- **Mobile**: CaptureView ist responsiv; Kamera-Upload auf Mobile bevorzugt; sehr große Step-Anzahl auf kleinen Screens unhandlich.

## Bekannte Issues

- [TASKS.md](../../../TASKS.md) — **BUG-079** Multi-Identify liefert nur letztes Produkt (✅ gefixt durch sequentielle Verarbeitung + JobStatusPopup-Summary).
- **BUG-080** LLM-Pipeline Qualität (✅ 8 Fixes: QualityGate ON, Retry, Schema, Improve-Tracking, Evidence-Hierarchie, Gewicht, Preis).
- **BUG-088** Identify/Improve fügen keine Produktbilder aus dem Web hinzu (P1, offen).
- **BUG-090** Gruppierung fällt auf Fallback bei vielen verschiedenen Produkten (P0; Code-Fix implementiert via Structured Output + Kompression + Batching, Deploy ausstehend).
- **BUG-091** Multi-Identify hängt bei vielen Produkten (P0; Code-Fix implementiert: Concurrency 3, Phase-Progress, Timeout 600s, Deploy ausstehend).

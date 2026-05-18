---
title: Capture (Produkt-Erfassung / Identify)
for: [user, dev, admin]
lastReviewed: 2026-05-18
---

## Zweck

Multi-Step-Wizard zur Produkt-Erfassung über Foto-Upload, Barcode-Scan oder beides. Triggert die `IDENTIFY`-Pipeline (V3 / V4) im Backend, gruppiert hochgeladene Bilder zu Produkten, zeigt das Analyse-Ergebnis, lässt den User pre-publish reviewen und finalisiert via Autosave (`saveProductV2`) bei `ebay_ready_score ≥ 0.6` (sub-flag `IDENTIFY_V4_AUTOSAVE`).

## Komponente(n)

- [components/capture/CaptureView.tsx](../../../components/capture/CaptureView.tsx) — Wizard-Container, `Stepper`-Navigation.
- [components/capture/StepUpload.tsx](../../../components/capture/StepUpload.tsx) — Upload-Step (Drag&Drop, Kamera).
- [components/capture/StepGrouping.tsx](../../../components/capture/StepGrouping.tsx) — Image-Gruppierung pro Produkt (mit Backend-Hilfe; siehe BUG-090).
- [components/capture/StepAnalysis.tsx](../../../components/capture/StepAnalysis.tsx) — Identify-Lauf inkl. Phase-Progress.
- [components/capture/StepReview.tsx](../../../components/capture/StepReview.tsx) — Pre-Publish-Review der Identify-Ergebnisse.
- [components/capture/StepChannels.tsx](../../../components/capture/StepChannels.tsx) — Auswahl Marketplaces (eBay/Kaufland).
- [components/capture/StepPricing.tsx](../../../components/capture/StepPricing.tsx) — Preisvorschlag / Override (`useSweetSpotPricer` server-side).
- [components/capture/StepSummary.tsx](../../../components/capture/StepSummary.tsx) — Abschluss & Save.
- [components/capture/PaletteSelector.tsx](../../../components/capture/PaletteSelector.tsx) — Optional: Paletten-Identifikation (Multi-SKU pro Foto).

## API-Calls

Indirekt über Hooks (kein direkter `fetchApi`-Call im CaptureView.tsx):
- `useIdentification()` (`hooks/useIdentification.ts`) — orchestriert Multi-Step-Upload → `/api/identify` Pipeline. Lieferst `UploadGroupPayload`.
- `useImproveQueue()` (`hooks/useImproveQueue.ts`) — falls Re-Identify aus dem Backlog gestartet wird.

Backend-Endpunkte (indirekt):
- `POST /api/identify` — Master-Pipeline. Master-Timeout `IDENTIFY_TOTAL_TIMEOUT_MS=360000` (siehe CLAUDE.md Feature-Flags).
- `POST /api/identify/grouping` — Stage-1-Vorgruppierung.
- `POST /api/identify/improve` — Re-Identify eines existierenden Produkts.

Pro-Endpunkt-Doku: `docs/kb/09-api/identify.md` (TBD).

## Datenquellen

- `useIdentification` als Single-Source-of-Truth während des Wizard-Flows. Liefert Progress-Phase, Ergebnisse, Errors.
- `useImproveQueue` für Re-Identify-Trigger.
- StepUpload nutzt `File`-Objekte lokal, Upload geht Multipart über `useIdentification.uploadAndIdentify()`.
- I18n via `useI18n()`.

## Wichtige Edge-Cases

- **Sehr viele Bilder**: Gruppierung kann auf Fallback fallen (siehe BUG-090). Workaround: max 30 Bilder pro Batch (UI-seitig nicht hart enforced, Backend-Limit greift).
- **Multi-Identify hängt**: bei vielen Produkten ohne Timeout-Progress (BUG-091 ✅ gefixt: Concurrency 3, Phase-Progress, Cloud-Run-Timeout 600s).
- **Loading**: Step-Progress über Stepper-Komponente; pro Step lokaler Spinner.
- **Error pro Phase**: Fehlt z. B. die Image-Quality-Analyse (`STAGE1_IMAGE_QUALITY_GATE`), läuft die Pipeline trotzdem weiter (nur Metadata fehlt).
- **Autosave-Threshold**: bei `ebay_ready_score < 0.6` wird **nicht** autosaved; User muss in StepReview manuell freigeben (`saveProduct` über ProductSheet-Embed oder direkt aus StepSummary).
- **V4-Fallback**: bei Pipeline-Error in V4 fällt der Backend automatisch auf V3 zurück; im Frontend nicht sichtbar außer in `IdentifyV4Badge` (siehe ProductSheet).
- **Mobile**: CaptureView ist responsiv; Kamera-Upload auf Mobile bevorzugt; sehr große Step-Anzahl auf kleinen Screens unhandlich.

## Bekannte Issues

- [TASKS.md](../../../TASKS.md) — **BUG-079** Multi-Identify liefert nur letztes Produkt (✅ gefixt durch sequentielle Verarbeitung + JobStatusPopup-Summary).
- **BUG-080** LLM-Pipeline Qualität (✅ 8 Fixes: QualityGate ON, Retry, Schema, Improve-Tracking, Evidence-Hierarchie, Gewicht, Preis).
- **BUG-088** Identify/Improve fügen keine Produktbilder aus dem Web hinzu (P1, offen).
- **BUG-090** Gruppierung fällt auf Fallback bei vielen verschiedenen Produkten (P0; Code-Fix implementiert via Structured Output + Kompression + Batching, Deploy ausstehend).
- **BUG-091** Multi-Identify hängt bei vielen Produkten (P0; Code-Fix implementiert: Concurrency 3, Phase-Progress, Timeout 600s, Deploy ausstehend).

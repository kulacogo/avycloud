# IMG-001: Image Enhancement

## Meta

| Field | Value |
|-------|-------|
| **Feature ID** | IMG-001 |
| **Title** | Image Enhancement |
| **Priority** | P1 |
| **Status** | Implemented — Bildwerkstatt, 2026-09-27 |
| **Change Level** | L0 (new service, additive) |
| **Effort** | M |
| **Source** | competitive-analysis |
| **Dependencies** | None, but enhances AI-001 (AI Listing Pipeline) |
| **Protected Zones** | None (entirely new feature) |
| **TASKS.md Module** | Standalone — enhances M13 (Erfassen) pipeline |

---

## Problem Statement

## Aktueller Auftrag und Umsetzung — 27.09.2026

Die historische Skizze unten ist überholt: Studio- und Galerieerzeugung existieren bereits. Der Betreiber verlangt jetzt einen schnellen, hochwertigen Arbeitsplatz für die tatsächlichen Produktfotos, mit Rückgängig, sinnvoller Serienbearbeitung und Produktionsauslieferung.

`components/PhotoEditor.tsx` ersetzt die destruktiven Einzelkorrekturen durch einen lokalen Editor. Original und Bearbeitungsrezept bleiben getrennt. Belichtung/Tiefen/Lichter, Kontrast, Wärme/Farbton, Sättigung/Schärfe, kalibrierte Weißabgleich-Pipette, Drehen/Spiegeln/Geraderücken, Zuschnitt, Format und Rand nutzen denselben Renderer für Vorschau und Export. Die Vorschau ist auf 1000 px begrenzt; nur Übernehmen exportiert bis 4096 px. Kein Hochskalieren des Motivs, kein Neuzeichnen von Produktdetails.

Undo/Redo mit Verlauf und Tastatur, Originalvergleich, Originalwiederherstellung auch nach erneutem Öffnen, Abbruchschutz, mehrere Bildentwürfe und Übertragung von Licht/Format. Ausschnitt und Maske werden nie blind zwischen Fotos kopiert. Änderungen werden atomar gegen Produkt/Bildsnapshot geprüft und zuerst ins Datenblatt übernommen; dessen Speichern bleibt der produktive Schreibschritt.

Freistellung: vorhandenes IMG.LY/IS-Net in eigenem Modulworker, fp16 als schneller Standard, fp32 als optionale Alternative; bestehender ENV-Pin bleibt. Expliziter GPU→CPU-Rückfall, Abbruch, Modellwiederverwendung und Maskencache. Hintergrundwechsel und Regler benötigen keine erneute Inferenz. Ergebnis ist reine Alphamaske, damit vorhandene Originaltransparenz genau einmal angewandt wird. Weiß/Transparent/Studiograu, automatische Produktzentrierung, Radier-/Wiederherstellungspinsel und gezielte Innenflächenrettung.

**Qualitätsgrenze nachgewiesen:** Beide Modellgrößen entfernen beim SAKK-Stofffoto Teile des Aufdrucks. Keine allgemeine Texttreue oder Qualitätsüberlegenheit des größeren Modells behaupten. Explizite Klickrettung stellt nur die vom Bediener ausgewählte eingeschlossene Fläche wieder her; keine automatische Füllung echter Griff-/Gurtöffnungen. Drei Klicks reparierten den konkreten Aufdruck, beide getesteten Gurtöffnungen blieben unverändert. Generative KI-Studio-/Galeriepfade bleiben unverändert erreichbar.

Persistenz/Schutz/Limits: [persistence.md](persistence.md). Keine neue Dependency, API-Route, Produktions-ENV oder Migration. Der Vite-Build nutzt ES-Modulworker wegen dynamischer ONNX-Imports. Tests decken Farben, Alpha, Geometrie, Historie, stale batches, Workerabbruch/-queue/-fallback, Original-/Maskenspeicherung und Fehler vor Produktschreibzugriff ab. Browserprüfung einschließlich StrictMode, Desktop dunkel/Mobil hell, Pipelines für Vorschau→Übernahme→Wiederöffnen→Original und Maskenkorrektur.

### Recherchegrundlage

- [W3C CSS Color 4: sRGB-Konversionen](https://www.w3.org/TR/css-color-4/#color-conversion-code): lineare Belichtung und Rückwandlung.
- [IMG.LY Browser-Paket](https://github.com/imgly/background-removal-js/blob/main/packages/web/README.md): Modellgrößen, Preload/Cache; Verhalten zusätzlich gegen installierte Version 1.7.0 geprüft. Bestehende AGPL-Abhängigkeit, keine neue Lizenzentscheidung.
- [ONNX Runtime: Worker und WebGPU](https://onnxruntime.ai/docs/tutorials/web/env-flags-and-session-options.html): eingebauter Proxy nicht mit WebGPU nutzbar; eigener Worker erhält die bedienbare Oberfläche.
- [OffscreenCanvas](https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas): Verarbeitung im Worker.
- [Pintura: Bildzustand wiederherstellen](https://pqina.nl/pintura/docs/v8/examples/restore-image-state/) und [Photoroom Batch](https://www.photoroom.com/batch): Original plus Bearbeitungszustand und konsistente Serien als Workflow-Vorbilder. Kein zusätzlicher kostenpflichtiger Anbieter eingebaut.

## Historische Entwurfsskizze (kein aktueller Implementierungsstand)

Product images are critical for marketplace success. Every AI-first listing tool (Nifty AI, Underpriced AI, List Perfectly, PhotoRoom) offers background removal and image enhancement. AvyCloud has no image processing capabilities. This is a table-stakes feature for 2026.

---

## User Story

As a seller, I want AvyCloud to automatically enhance my product images (remove background, optimize quality), so that my listings look professional across all marketplaces.

---

## Requirements

| ID | Priority | Requirement |
|----|----------|-------------|
| FR-1 | MUST | Support background removal (white background for marketplaces) |
| FR-2 | MUST | Support image quality optimization (resolution, compression) |
| FR-3 | SHOULD | Support custom background options (white, transparent, lifestyle) |
| FR-4 | SHOULD | Integrate with AI-001 pipeline (enhance images as part of listing flow) |
| FR-5 | SHOULD | Support batch processing (enhance images for multiple products) |
| FR-6 | MAY | Support AI-generated lifestyle backgrounds (product-in-context) |
| FR-7 | MAY | Support image cropping and centering automation |

---

## Build vs. Buy Consideration

| Approach | Pros | Cons |
|----------|------|------|
| **External API** (PhotoRoom, remove.bg, Claid.ai) | Speed-to-market, proven quality, low dev effort | Per-image cost, vendor dependency, less control |
| **Custom with Gemini Vision** | Full control, no per-image cost, deeper integration | Higher dev effort, quality may vary, longer timeline |

Trade-off: speed-to-market (API) vs. control and cost (custom).

---

## Competitive Benchmarks

| Competitor | Capability | Gap vs. AvyCloud |
|------------|-----------|------------------|
| **Nifty AI** | Auto background removal in listing flow | AvyCloud has no image processing |
| **Underpriced AI** | Photo enhancement + auto-crop | AvyCloud has no image processing |
| **List Perfectly** | Bulk image editing, background removal | AvyCloud has no image processing |
| **PhotoRoom** | AI background removal + lifestyle scenes | AvyCloud has no image processing |

---

## Architecture

To be defined during brainstorming session.

## UI Design

To be defined during brainstorming session.

## Technical Design

To be defined during brainstorming session.

## Testing Strategy

To be defined during brainstorming session.

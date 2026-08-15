import React, { useState, useCallback, useRef } from "react";
import { Product } from "../../types";
import { groupsSignature } from "../../utils/captureGroups";
import { UploadGroupPayload } from "../../hooks/useIdentification";
import { Stepper, Step } from "../ui/Stepper";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import LotSelector from "./LotSelector";
import StepUpload from "./StepUpload";
import StepGrouping from "./StepGrouping";
import StepAnalysis from "./StepAnalysis";
import StepReview from "./StepReview";
import StepSummary from "./StepSummary";
import { PageTitle } from "../ui/PageTitle";

const STEPS: Step[] = [
  { id: "upload", label: "Bilder hochladen" },
  { id: "grouping", label: "Gruppierung" },
  { id: "analysis", label: "KI-Erkennung" },
  { id: "review", label: "Prüfen & Korrigieren" },
  { id: "summary", label: "Zusammenfassung" },
];

interface CaptureViewProps {
  onProductCreated?: (product: Product) => void;
}

export interface ImagePreview {
  id: string;
  file: File;
  url: string;
}

export interface ConfirmedGroup {
  id: string;
  label: string;
  images: File[];
  barcodes: string;
  hint?: string | null;
}

export interface CaptureUploadData {
  groups: UploadGroupPayload[];
  barcodes: string;
  lotCode: string;
  allImages?: ImagePreview[];
}

const CaptureView: React.FC<CaptureViewProps> = ({ onProductCreated }) => {
  const [activeStep, setActiveStep] = useState("upload");
  const [completedSteps, setCompletedSteps] = useState<string[]>([]);
  const [lotCode, setLotCode] = useState("");

  // Step data
  const [uploadData, setUploadData] = useState<CaptureUploadData | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [activeProductIndex, setActiveProductIndex] = useState(0);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  // Bleibender Hinweis auf einen möglichen Doppel-Eintrag nach einem
  // Verbindungsabbruch — siehe StepAnalysis onRetryWarning.
  const [retryWarning, setRetryWarning] = useState<string | null>(null);
  // Die bestätigte Gruppierung lebt HIER, nicht nur im Gruppierungs-Schritt:
  // dessen Zustand stirbt beim Schrittwechsel, und beim Zurückkommen lief die
  // KI-Gruppierung erneut (echter Gemini-Call) und überschrieb jede von Hand
  // gezogene Zuordnung.
  const [confirmedGroups, setConfirmedGroups] = useState<ConfirmedGroup[] | null>(null);
  // Signatur der Gruppierung, zu der `products` gehört. Solange sie gleich
  // bleibt, ist ein zweiter Erkennungslauf reiner Schaden: er ersetzt die
  // eingetippten Korrekturen und legt ein Doppel-Produkt im Katalog an.
  const analyzedSignatureRef = useRef<string | null>(null);

  const currentProduct = products[activeProductIndex] || null;

  const completeStep = useCallback((stepId: string) => {
    setCompletedSteps((prev) => (prev.includes(stepId) ? prev : [...prev, stepId]));
  }, []);

  const goTo = useCallback((stepId: string) => {
    setActiveStep(stepId);
  }, []);

  // Upload → Grouping (bzw. direkt zur Erkennung, wenn es nichts zu gruppieren gibt)
  const handleUploadComplete = useCallback(
    (data: CaptureUploadData) => {
      setUploadData({ ...data, lotCode });
      completeStep("upload");
      // Erfassung nur per Barcode: der Gruppierungs-Schritt hat dann nichts zu
      // zeigen und "Zuordnung bestätigen" bleibt dauerhaft ausgegraut — eine
      // Sackgasse, aus der nur "Zurück" führte (das den Barcode wegwarf).
      if (!data.allImages?.length) {
        completeStep("grouping");
        goTo("analysis");
        return;
      }
      goTo("grouping");
    },
    [completeStep, goTo, lotCode]
  );

  // Grouping → Analysis
  const handleGroupingComplete = useCallback(
    (groups: ConfirmedGroup[]) => {
      if (!uploadData) return;
      setConfirmedGroups(groups);
      setUploadData((prev) =>
        prev
          ? {
              ...prev,
              groups: groups.map((g) => ({
                id: g.id,
                label: g.label,
                images: g.images,
                barcodes: g.barcodes || "",
                hint: g.hint ?? null,
              })),
              barcodes: groups.map((g) => g.barcodes).filter(Boolean).join(","),
            }
          : prev
      );
      completeStep("grouping");
      // Unveränderte Gruppierung + vorhandenes Ergebnis = nichts neu zu erkennen.
      // Sonst kostet jeder Weg über diesen Schritt eine weitere Erkennung, wirft
      // die Korrekturen weg und legt ein Doppel-Produkt im Katalog an.
      if (products.length > 0 && analyzedSignatureRef.current === groupsSignature(groups)) {
        goTo("review");
        return;
      }
      goTo("analysis");
    },
    [completeStep, goTo, uploadData, products.length]
  );

  // Analysis → Review (now receives Product[])
  const handleAnalysisComplete = useCallback(
    (identified: Product | Product[]) => {
      const arr = Array.isArray(identified) ? identified : [identified];
      setProducts(arr);
      setActiveProductIndex(0);
      setAnalysisError(null);
      analyzedSignatureRef.current = confirmedGroups ? groupsSignature(confirmedGroups) : null;
      completeStep("analysis");
      goTo("review");
    },
    [completeStep, goTo, confirmedGroups]
  );

  const handleAnalysisError = useCallback((error: string) => {
    setAnalysisError(error);
  }, []);

  const handleRetryWarning = useCallback((info: { attempts: number }) => {
    setRetryWarning(
      `Die Erkennung musste ${info.attempts - 1}× wiederholt werden (Verbindungsabbruch). ` +
        "Der erste Lauf kann auf dem Server durchgelaufen sein und ein zweites Produkt angelegt haben — " +
        "bitte die Produktliste auf einen Doppel-Eintrag prüfen."
    );
  }, []);

  // Review complete for single product — advance to next product or summary
  const handleReviewComplete = useCallback(
    (edited: Product) => {
      setProducts((prev) => prev.map((p, i) => (i === activeProductIndex ? edited : p)));
      if (activeProductIndex < products.length - 1) {
        // More products to review — advance to next tab
        setActiveProductIndex((prev) => prev + 1);
      } else {
        // All products reviewed — go to summary
        completeStep("review");
        goTo("summary");
      }
    },
    [completeStep, goTo, activeProductIndex, products.length]
  );

  // Summary done — called once for all products
  const handleSaved = useCallback(
    (saved: Product | Product[]) => {
      const arr = Array.isArray(saved) ? saved : [saved];
      arr.forEach((p) => onProductCreated?.(p));
      completeStep("summary");
    },
    [completeStep, onProductCreated]
  );

  // Reset flow
  const handleReset = useCallback(() => {
    setActiveStep("upload");
    setCompletedSteps([]);
    // Erst hier die Vorschau-URLs freigeben — NICHT beim Schrittwechsel.
    // Sonst kommt der Upload-Schritt mit kaputten Vorschaubildern zurück.
    uploadData?.allImages?.forEach((img) => {
      try {
        URL.revokeObjectURL(img.url);
      } catch {
        // Freigabe ist Aufräumarbeit — ein Fehler hier geht den Bediener nichts an.
      }
    });
    setUploadData(null);
    setProducts([]);
    setConfirmedGroups(null);
    setRetryWarning(null);
    analyzedSignatureRef.current = null;
    setActiveProductIndex(0);
    setAnalysisError(null);
    setLotCode("");
  }, [uploadData]);

  /**
   * "Zurück" führt IMMER auf einen Schritt mit Bedienoberfläche.
   *
   * Vorher rechnete die Funktion nur mit dem Schritt-Index — aus "Prüfen"
   * landete man damit auf "KI-Erkennung", und das ist ein reiner
   * Fortschrittsbalken ohne Bedienoberfläche: er startete beim Betreten sofort
   * eine neue Erkennung, warf alle Korrekturen weg und legte ein Doppel-Produkt
   * im Katalog an. Die Erkennung wird deshalb übersprungen.
   */
  const handleStepBack = useCallback(() => {
    const BACK_TARGET: Record<string, string> = {
      grouping: "upload",
      analysis: "grouping",
      review: "grouping",
      summary: "review",
    };
    const target = BACK_TARGET[activeStep];
    // Ohne Bilder gab es nie einen Gruppierungs-Schritt — dann zurück zum Upload.
    if (target === "grouping" && !uploadData?.allImages?.length) {
      goTo("upload");
      return;
    }
    if (target) goTo(target);
  }, [activeStep, goTo, uploadData]);

  // Multi-product tab bar
  const ProductTabs = products.length > 1 ? (
    <div className="flex gap-1 mb-4 border-b border-app-border pb-2">
      {products.map((p, i) => (
        <button
          key={p.id || i}
          type="button"
          onClick={() => setActiveProductIndex(i)}
          className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
            i === activeProductIndex
              ? "bg-accent/10 text-accent font-medium"
              : "text-txt-muted hover:text-txt-primary hover:bg-app-elevated"
          }`}
        >
          {p.identification?.name?.slice(0, 30) || `Produkt ${i + 1}`}
        </button>
      ))}
    </div>
  ) : null;

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-6">
      {/* Header + Los */}
      <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-4">
        <PageTitle className="text-xl font-semibold text-txt-primary">Produkt erfassen</PageTitle>
        <div className="w-full lg:w-80">
          <LotSelector value={lotCode} onChange={setLotCode} />
        </div>
      </div>

      {retryWarning && (
        <div className="flex flex-wrap items-start gap-3 rounded-xl border border-warning/30 bg-warning-dim px-4 py-3 text-sm text-warning">
          <span className="flex-1">{retryWarning}</span>
          <button
            type="button"
            onClick={() => setRetryWarning(null)}
            className="shrink-0 text-xs font-semibold underline opacity-80 hover:opacity-100"
          >
            Verstanden
          </button>
        </div>
      )}

      {/* Stepper */}
      <Card padding="sm">
        <Stepper steps={STEPS} activeStep={activeStep} completedSteps={completedSteps} />
      </Card>

      {/* Step content */}
      <div className="min-h-[400px]">
        {activeStep === "upload" && (
          <StepUpload
            onComplete={handleUploadComplete}
            lotCode={lotCode}
            // Der Schritt wird beim Wechsel ausgehängt; ohne diese Startwerte
            // kam er leer zurück und bis zu 30 Fotos waren neu auszuwählen.
            initialImages={uploadData?.allImages}
            initialBarcodes={uploadData?.barcodes}
          />
        )}

        {activeStep === "grouping" && uploadData?.allImages?.length ? (
          <StepGrouping
            images={uploadData.allImages}
            barcodes={uploadData.barcodes}
            onConfirm={handleGroupingComplete}
            onBack={handleStepBack}
            // Bereits bestätigte Gruppen: verhindert einen zweiten Gemini-Aufruf
            // und rettet jede von Hand gezogene Zuordnung.
            initialGroups={confirmedGroups}
          />
        ) : null}

        {activeStep === "analysis" && uploadData && (
          <StepAnalysis
            uploadData={uploadData}
            lotCode={lotCode}
            onComplete={handleAnalysisComplete}
            onError={handleAnalysisError}
            onBack={handleStepBack}
            onRetryWarning={handleRetryWarning}
          />
        )}

        {activeStep === "review" && currentProduct && (
          <>
            {ProductTabs}
            <StepReview
              key={currentProduct.id || activeProductIndex}
              product={currentProduct}
              onComplete={handleReviewComplete}
              onBack={handleStepBack}
              isLastProduct={activeProductIndex >= products.length - 1}
            />
          </>
        )}

        {activeStep === "summary" && products.length > 0 && (
          <StepSummary
            products={products}
            onSave={handleSaved}
            onBack={handleStepBack}
            onReset={handleReset}
          />
        )}

      </div>
    </div>
  );
};

export default CaptureView;

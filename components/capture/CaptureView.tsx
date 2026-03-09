import React, { useState, useCallback } from "react";
import { Product } from "../../types";
import { UploadGroupPayload } from "../../hooks/useIdentification";
import { Stepper, Step } from "../ui/Stepper";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import StepUpload from "./StepUpload";
import StepAnalysis from "./StepAnalysis";
import StepReview from "./StepReview";
import StepPricing from "./StepPricing";
import StepSummary from "./StepSummary";

const STEPS: Step[] = [
  { id: "upload", label: "Bilder hochladen" },
  { id: "analysis", label: "KI-Erkennung" },
  { id: "review", label: "Prüfen & Korrigieren" },
  { id: "pricing", label: "Preis & Lager" },
  { id: "summary", label: "Zusammenfassung" },
];

interface CaptureViewProps {
  onProductCreated?: (product: Product) => void;
}

export interface CaptureUploadData {
  groups: UploadGroupPayload[];
  barcodes: string;
}

const CaptureView: React.FC<CaptureViewProps> = ({ onProductCreated }) => {
  const [activeStep, setActiveStep] = useState("upload");
  const [completedSteps, setCompletedSteps] = useState<string[]>([]);

  // Step data
  const [uploadData, setUploadData] = useState<CaptureUploadData | null>(null);
  const [product, setProduct] = useState<Product | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  const completeStep = useCallback((stepId: string) => {
    setCompletedSteps((prev) => (prev.includes(stepId) ? prev : [...prev, stepId]));
  }, []);

  const goTo = useCallback((stepId: string) => {
    setActiveStep(stepId);
  }, []);

  // Step 1 → 2
  const handleUploadComplete = useCallback(
    (data: CaptureUploadData) => {
      setUploadData(data);
      completeStep("upload");
      goTo("analysis");
    },
    [completeStep, goTo]
  );

  // Step 2 → 3
  const handleAnalysisComplete = useCallback(
    (identified: Product) => {
      setProduct(identified);
      setAnalysisError(null);
      completeStep("analysis");
      goTo("review");
    },
    [completeStep, goTo]
  );

  const handleAnalysisError = useCallback((error: string) => {
    setAnalysisError(error);
  }, []);

  // Step 3 → 4
  const handleReviewComplete = useCallback(
    (edited: Product) => {
      setProduct(edited);
      completeStep("review");
      goTo("pricing");
    },
    [completeStep, goTo]
  );

  // Step 4 → 5
  const handlePricingComplete = useCallback(
    (updated: Product) => {
      setProduct(updated);
      completeStep("pricing");
      goTo("summary");
    },
    [completeStep, goTo]
  );

  // Step 5 done
  const handleSaved = useCallback(
    (saved: Product) => {
      onProductCreated?.(saved);
      completeStep("summary");
    },
    [completeStep, onProductCreated]
  );

  // Reset flow for "Nächstes erfassen"
  const handleReset = useCallback(() => {
    setActiveStep("upload");
    setCompletedSteps([]);
    setUploadData(null);
    setProduct(null);
    setAnalysisError(null);
  }, []);

  // Allow going back to previous steps
  const handleStepBack = useCallback(() => {
    const idx = STEPS.findIndex((s) => s.id === activeStep);
    if (idx > 0) {
      goTo(STEPS[idx - 1].id);
    }
  }, [activeStep, goTo]);

  const currentIndex = STEPS.findIndex((s) => s.id === activeStep);

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-semibold text-txt-primary">Produkt erfassen</h1>
        <p className="text-sm text-txt-muted mt-1">
          Lade Bilder hoch, lasse die KI das Produkt erkennen und prüfe die Ergebnisse.
        </p>
      </div>

      {/* Stepper */}
      <Card padding="sm">
        <Stepper steps={STEPS} activeStep={activeStep} completedSteps={completedSteps} />
      </Card>

      {/* Step content */}
      <div className="min-h-[400px]">
        {activeStep === "upload" && (
          <StepUpload onComplete={handleUploadComplete} />
        )}

        {activeStep === "analysis" && uploadData && (
          <StepAnalysis
            uploadData={uploadData}
            onComplete={handleAnalysisComplete}
            onError={handleAnalysisError}
            onBack={handleStepBack}
          />
        )}

        {activeStep === "review" && product && (
          <StepReview
            product={product}
            onComplete={handleReviewComplete}
            onBack={handleStepBack}
          />
        )}

        {activeStep === "pricing" && product && (
          <StepPricing
            product={product}
            onComplete={handlePricingComplete}
            onBack={handleStepBack}
          />
        )}

        {activeStep === "summary" && product && (
          <StepSummary
            product={product}
            onSave={handleSaved}
            onBack={handleStepBack}
            onReset={handleReset}
          />
        )}

        {/* Error recovery for analysis */}
        {activeStep === "analysis" && analysisError && (
          <div className="mt-4 flex gap-3">
            <Button variant="secondary" onClick={handleStepBack}>Zurück</Button>
            <Button onClick={() => { setAnalysisError(null); goTo("analysis"); }}>
              Erneut versuchen
            </Button>
          </div>
        )}
      </div>
    </div>
  );
};

export default CaptureView;

import React, { useState, useCallback } from "react";
import { Product } from "../../types";
import { UploadGroupPayload } from "../../hooks/useIdentification";
import { Stepper, Step } from "../ui/Stepper";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import PaletteSelector from "./PaletteSelector";
import StepUpload from "./StepUpload";
import StepGrouping from "./StepGrouping";
import StepAnalysis from "./StepAnalysis";
import StepReview from "./StepReview";
import StepPricing from "./StepPricing";
import StepChannels from "./StepChannels";
import StepSummary from "./StepSummary";
import type { ChannelListing } from "../../api/client";

const STEPS: Step[] = [
  { id: "upload", label: "Bilder hochladen" },
  { id: "grouping", label: "Gruppierung" },
  { id: "analysis", label: "KI-Erkennung" },
  { id: "review", label: "Prüfen & Korrigieren" },
  { id: "pricing", label: "Preis & Lager" },
  { id: "channels", label: "Marktplätze" },
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
  paletteCode: string;
  allImages?: ImagePreview[];
}

const CaptureView: React.FC<CaptureViewProps> = ({ onProductCreated }) => {
  const [activeStep, setActiveStep] = useState("upload");
  const [completedSteps, setCompletedSteps] = useState<string[]>([]);
  const [paletteCode, setPaletteCode] = useState("");

  // Step data
  const [uploadData, setUploadData] = useState<CaptureUploadData | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [activeProductIndex, setActiveProductIndex] = useState(0);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [channelListings, setChannelListings] = useState<Record<string, ChannelListing> | null>(null);

  const currentProduct = products[activeProductIndex] || null;

  const completeStep = useCallback((stepId: string) => {
    setCompletedSteps((prev) => (prev.includes(stepId) ? prev : [...prev, stepId]));
  }, []);

  const goTo = useCallback((stepId: string) => {
    setActiveStep(stepId);
  }, []);

  // Upload → Grouping
  const handleUploadComplete = useCallback(
    (data: CaptureUploadData) => {
      setUploadData({ ...data, paletteCode });
      completeStep("upload");
      goTo("grouping");
    },
    [completeStep, goTo, paletteCode]
  );

  // Grouping → Analysis
  const handleGroupingComplete = useCallback(
    (confirmedGroups: ConfirmedGroup[]) => {
      if (!uploadData) return;
      setUploadData((prev) =>
        prev
          ? {
              ...prev,
              groups: confirmedGroups.map((g) => ({
                id: g.id,
                label: g.label,
                images: g.images,
                hint: g.hint ?? null,
              })),
              barcodes: confirmedGroups.map((g) => g.barcodes).filter(Boolean).join(","),
            }
          : prev
      );
      completeStep("grouping");
      goTo("analysis");
    },
    [completeStep, goTo, uploadData]
  );

  // Analysis → Review (now receives Product[])
  const handleAnalysisComplete = useCallback(
    (identified: Product | Product[]) => {
      const arr = Array.isArray(identified) ? identified : [identified];
      setProducts(arr);
      setActiveProductIndex(0);
      setAnalysisError(null);
      completeStep("analysis");
      goTo("review");
    },
    [completeStep, goTo]
  );

  const handleAnalysisError = useCallback((error: string) => {
    setAnalysisError(error);
  }, []);

  // Review → Pricing
  const handleReviewComplete = useCallback(
    (edited: Product) => {
      setProducts((prev) => prev.map((p, i) => (i === activeProductIndex ? edited : p)));
      completeStep("review");
      goTo("pricing");
    },
    [completeStep, goTo, activeProductIndex]
  );

  // Pricing → Channels
  const handlePricingComplete = useCallback(
    (updated: Product) => {
      setProducts((prev) => prev.map((p, i) => (i === activeProductIndex ? updated : p)));
      completeStep("pricing");
      goTo("channels");
    },
    [completeStep, goTo, activeProductIndex]
  );

  // Channels → Summary
  const handleChannelsComplete = useCallback(
    (updated: Product, listings: Record<string, ChannelListing>) => {
      setProducts((prev) => prev.map((p, i) => (i === activeProductIndex ? updated : p)));
      setChannelListings(listings);
      completeStep("channels");
      goTo("summary");
    },
    [completeStep, goTo, activeProductIndex]
  );

  // Summary done
  const handleSaved = useCallback(
    (saved: Product) => {
      onProductCreated?.(saved);
      completeStep("summary");
    },
    [completeStep, onProductCreated]
  );

  // Reset flow
  const handleReset = useCallback(() => {
    setActiveStep("upload");
    setCompletedSteps([]);
    setUploadData(null);
    setProducts([]);
    setActiveProductIndex(0);
    setAnalysisError(null);
    setChannelListings(null);
    setPaletteCode("");
  }, []);

  // Back navigation
  const handleStepBack = useCallback(() => {
    const idx = STEPS.findIndex((s) => s.id === activeStep);
    if (idx > 0) {
      goTo(STEPS[idx - 1].id);
    }
  }, [activeStep, goTo]);

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
      {/* Header + Palette */}
      <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-4">
        <h1 className="text-xl font-semibold text-txt-primary">Produkt erfassen</h1>
        <div className="w-full lg:w-80">
          <PaletteSelector value={paletteCode} onChange={setPaletteCode} />
        </div>
      </div>

      {/* Stepper */}
      <Card padding="sm">
        <Stepper steps={STEPS} activeStep={activeStep} completedSteps={completedSteps} />
      </Card>

      {/* Step content */}
      <div className="min-h-[400px]">
        {activeStep === "upload" && (
          <StepUpload
            onComplete={handleUploadComplete}
            paletteCode={paletteCode}
          />
        )}

        {activeStep === "grouping" && uploadData?.allImages && (
          <StepGrouping
            images={uploadData.allImages}
            barcodes={uploadData.barcodes}
            onConfirm={handleGroupingComplete}
            onBack={handleStepBack}
          />
        )}

        {activeStep === "analysis" && uploadData && (
          <StepAnalysis
            uploadData={uploadData}
            onComplete={handleAnalysisComplete}
            onError={handleAnalysisError}
            onBack={handleStepBack}
          />
        )}

        {activeStep === "review" && currentProduct && (
          <>
            {ProductTabs}
            <StepReview
              product={currentProduct}
              onComplete={handleReviewComplete}
              onBack={handleStepBack}
            />
          </>
        )}

        {activeStep === "pricing" && currentProduct && (
          <>
            {ProductTabs}
            <StepPricing
              product={currentProduct}
              onComplete={handlePricingComplete}
              onBack={handleStepBack}
            />
          </>
        )}

        {activeStep === "channels" && currentProduct && (
          <>
            {ProductTabs}
            <StepChannels
              product={currentProduct}
              onComplete={handleChannelsComplete}
              onBack={handleStepBack}
            />
          </>
        )}

        {activeStep === "summary" && currentProduct && (
          <StepSummary
            product={currentProduct}
            onSave={handleSaved}
            onBack={handleStepBack}
            onReset={handleReset}
          />
        )}

        {/* Error recovery */}
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

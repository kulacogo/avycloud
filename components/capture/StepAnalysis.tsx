import React, { useEffect, useState, useRef } from "react";
import { Product } from "../../types";
import { identifyProductV2 } from "../../api/client";
import { Card } from "../ui/Card";
import { Button } from "../ui/Button";
import { ProgressBar } from "../ui/ProgressBar";
import type { CaptureUploadData } from "./CaptureView";

interface StepAnalysisProps {
  uploadData: CaptureUploadData;
  onComplete: (product: Product) => void;
  onError: (error: string) => void;
  onBack: () => void;
}

type Phase = "upload" | "vision" | "barcode" | "web" | "llm" | "pricing" | "done" | "error";

interface SubStep {
  id: Phase;
  label: string;
}

const SUB_STEPS: SubStep[] = [
  { id: "upload", label: "Bilder werden hochgeladen" },
  { id: "vision", label: "Bildanalyse (Gemini Vision)" },
  { id: "barcode", label: "Barcode-Erkennung" },
  { id: "web", label: "Web-Recherche & Preisvergleich" },
  { id: "llm", label: "KI-Synthese & Datenblatt" },
  { id: "pricing", label: "Preisermittlung" },
];

const PHASE_ORDER: Phase[] = ["upload", "vision", "barcode", "web", "llm", "pricing", "done"];

const StepAnalysis: React.FC<StepAnalysisProps> = ({
  uploadData,
  onComplete,
  onError,
  onBack,
}) => {
  const [phase, setPhase] = useState<Phase>("upload");
  const [error, setError] = useState<string | null>(null);
  const startedRef = useRef(false);

  // Simulated phase progression — the actual call is one request,
  // but we show sub-steps to indicate progress to the user.
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    let cancelled = false;

    const run = async () => {
      // Progress simulation: advance phases on timers while the actual API call runs
      const phaseTimers: NodeJS.Timeout[] = [];
      const advancePhases = () => {
        const delays = [800, 2500, 4000, 7000, 12000]; // cumulative-ish timing
        const phases: Phase[] = ["vision", "barcode", "web", "llm", "pricing"];
        phases.forEach((p, i) => {
          const timer = setTimeout(() => {
            if (!cancelled) setPhase(p);
          }, delays[i]);
          phaseTimers.push(timer);
        });
      };

      advancePhases();

      try {
        const group = uploadData.groups[0];
        const result = await identifyProductV2(
          group?.images || [],
          uploadData.barcodes,
          "de-DE"
        );

        phaseTimers.forEach(clearTimeout);

        if (cancelled) return;

        if (!result.ok || !result.data) {
          const msg = result.error?.message || "Produkterkennung fehlgeschlagen.";
          setPhase("error");
          setError(msg);
          onError(msg);
          return;
        }

        setPhase("done");
        // Short delay so user sees the "done" state
        setTimeout(() => {
          if (!cancelled) onComplete(result.data!);
        }, 600);
      } catch (err: any) {
        phaseTimers.forEach(clearTimeout);
        if (cancelled) return;
        const msg = err?.message || "Ein unerwarteter Fehler ist aufgetreten.";
        setPhase("error");
        setError(msg);
        onError(msg);
      }
    };

    run();
    return () => { cancelled = true; };
  }, [uploadData, onComplete, onError]);

  const currentIndex = PHASE_ORDER.indexOf(phase);
  const progress =
    phase === "done" ? 100
    : phase === "error" ? 0
    : Math.round(((currentIndex + 0.5) / (PHASE_ORDER.length - 1)) * 100);

  return (
    <div className="space-y-6">
      <Card padding="lg">
        <div className="text-center mb-6">
          <h2 className="text-lg font-semibold text-txt-primary">
            {phase === "error" ? "Fehler bei der Erkennung" : phase === "done" ? "Erkennung abgeschlossen" : "Produkt wird analysiert…"}
          </h2>
          <p className="text-sm text-txt-muted mt-1">
            {phase === "error"
              ? error
              : phase === "done"
              ? "Das Produkt wurde erfolgreich identifiziert."
              : "Bitte warte, während die KI das Produkt erkennt."}
          </p>
        </div>

        <ProgressBar
          value={progress}
          variant={phase === "error" ? "danger" : phase === "done" ? "success" : "accent"}
          className="mb-8"
        />

        {/* Sub-steps list */}
        <div className="space-y-3 max-w-md mx-auto">
          {SUB_STEPS.map((step) => {
            const stepIndex = PHASE_ORDER.indexOf(step.id);
            const isComplete = currentIndex > stepIndex || phase === "done";
            const isActive = phase === step.id;
            const isPending = currentIndex < stepIndex && phase !== "done" && phase !== "error";

            return (
              <div key={step.id} className="flex items-center gap-3">
                {/* Icon */}
                <span className="w-6 h-6 flex items-center justify-center shrink-0">
                  {isComplete ? (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="text-success">
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                  ) : isActive ? (
                    <svg className="animate-spin text-accent" width="18" height="18" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                  ) : (
                    <span className="w-2 h-2 rounded-full bg-app-border" />
                  )}
                </span>
                {/* Label */}
                <span
                  className={`text-sm ${
                    isComplete ? "text-txt-primary" : isActive ? "text-accent font-medium" : "text-txt-muted"
                  }`}
                >
                  {step.label}
                </span>
              </div>
            );
          })}
        </div>
      </Card>

      {/* Error actions */}
      {phase === "error" && (
        <div className="flex justify-between">
          <Button variant="secondary" onClick={onBack}>
            Zurück
          </Button>
          <Button
            onClick={() => {
              startedRef.current = false;
              setPhase("upload");
              setError(null);
              // Re-trigger by forcing re-mount — parent handles this
              onError("");
            }}
          >
            Erneut versuchen
          </Button>
        </div>
      )}
    </div>
  );
};

export default StepAnalysis;

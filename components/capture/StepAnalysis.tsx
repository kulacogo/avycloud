import React, { useEffect, useState, useRef } from "react";
import { Product } from "../../types";
import { identifyProductV2 } from "../../api/client";
import { Card } from "../ui/Card";
import { Button } from "../ui/Button";
import { ProgressBar } from "../ui/ProgressBar";
import type { CaptureUploadData } from "./CaptureView";

interface StepAnalysisProps {
  uploadData: CaptureUploadData;
  onComplete: (products: Product | Product[]) => void;
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
  const [phaseLabel, setPhaseLabel] = useState<string | null>(null);
  const [groupProgress, setGroupProgress] = useState({ current: 0, total: 0 });
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    let cancelled = false;

    const run = async () => {
      const groups = uploadData.groups;
      const total = groups.length;
      setGroupProgress({ current: 0, total });

      if (total <= 1) {
        // Single group: original behavior with phase simulation
        const phaseTimers: NodeJS.Timeout[] = [];
        const delays = [800, 2500, 4000, 7000, 12000];
        const phases: Phase[] = ["vision", "barcode", "web", "llm", "pricing"];
        phases.forEach((p, i) => {
          phaseTimers.push(setTimeout(() => { if (!cancelled) setPhase(p); }, delays[i]));
        });

        try {
          const group = groups[0];
          const result = await identifyProductV2(
            group?.images || [],
            uploadData.barcodes,
            "de-DE",
            undefined,
            uploadData.paletteCode || undefined,
            group?.hint || undefined
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
      } else {
        // BUG-091: Multi-group with concurrency limit + phase progress
        const CONCURRENCY = 3;
        const results: Product[] = [];
        const errors: { label: string; error: string }[] = [];
        let completed = 0;

        // Phase progress timer (simulates sub-steps like single-mode)
        const phaseTimers: NodeJS.Timeout[] = [];
        const multiPhases: Phase[] = ["vision", "barcode", "web", "llm", "pricing"];
        const multiDelays = [800, 3000, 10000, 25000, 50000];
        multiPhases.forEach((p, i) => {
          phaseTimers.push(setTimeout(() => { if (!cancelled) setPhase(p); }, multiDelays[i]));
        });

        // Process in concurrent chunks
        for (let batchStart = 0; batchStart < total; batchStart += CONCURRENCY) {
          if (cancelled) { phaseTimers.forEach(clearTimeout); return; }
          const chunk = groups.slice(batchStart, batchStart + CONCURRENCY);
          setGroupProgress({ current: Math.min(batchStart + CONCURRENCY, total), total });
          setPhaseLabel(`Produkte ${batchStart + 1}–${Math.min(batchStart + CONCURRENCY, total)} von ${total}...`);

          const chunkResults = await Promise.allSettled(
            chunk.map((group) =>
              identifyProductV2(
                group.images || [],
                group.label === "Barcode-Identifikation" ? uploadData.barcodes : "",
                "de-DE",
                undefined,
                uploadData.paletteCode || undefined,
                group.hint || undefined
              )
            )
          );

          for (let i = 0; i < chunkResults.length; i++) {
            const settled = chunkResults[i];
            const group = chunk[i];
            completed++;
            if (settled.status === "fulfilled" && settled.value.ok && settled.value.data) {
              results.push(settled.value.data);
            } else {
              const msg = settled.status === "rejected"
                ? settled.reason?.message || "Netzwerkfehler"
                : settled.value.error?.message || "Unbekannter Fehler";
              errors.push({ label: group.label, error: msg });
            }
          }
        }

        phaseTimers.forEach(clearTimeout);
        if (cancelled) return;

        if (results.length === 0) {
          const msg = `Alle ${errors.length} Produkte fehlgeschlagen: ${errors.map((e) => e.label).join(", ")}`;
          setPhase("error");
          setError(msg);
          onError(msg);
          return;
        }

        if (errors.length > 0) {
          setError(`${errors.length} von ${total} Produkten fehlgeschlagen`);
        }

        setPhase("done");
        setTimeout(() => {
          if (!cancelled) onComplete(results);
        }, 600);
      }
    };

    run();
    return () => { cancelled = true; };
  }, [uploadData, onComplete, onError]);

  const currentIndex = PHASE_ORDER.indexOf(phase);
  const isMulti = groupProgress.total > 1;
  const progress = isMulti
    ? phase === "done"
      ? 100
      : phase === "error"
      ? 0
      : Math.round((groupProgress.current / groupProgress.total) * 100)
    : phase === "done"
    ? 100
    : phase === "error"
    ? 0
    : Math.round(((currentIndex + 0.5) / (PHASE_ORDER.length - 1)) * 100);

  return (
    <div className="space-y-6">
      <Card padding="lg">
        <div className="text-center mb-6">
          <h2 className="text-lg font-semibold text-txt-primary">
            {phase === "error"
              ? "Fehler bei der Erkennung"
              : phase === "done"
              ? "Erkennung abgeschlossen"
              : isMulti
              ? `Produkt ${groupProgress.current} von ${groupProgress.total} wird erkannt...`
              : "Produkt wird analysiert\u2026"}
          </h2>
          <p className="text-sm text-txt-muted mt-1">
            {phase === "error"
              ? error
              : phase === "done"
              ? isMulti
                ? `${groupProgress.total} Produkte erfolgreich identifiziert.${error ? ` (${error})` : ""}`
                : "Das Produkt wurde erfolgreich identifiziert."
              : phaseLabel || "Bitte warte, während die KI das Produkt erkennt."}
          </p>
        </div>

        <ProgressBar
          value={progress}
          variant={phase === "error" ? "danger" : phase === "done" ? "success" : "accent"}
          className="mb-8"
        />

        {/* Sub-steps list (only for single-group) */}
        {!isMulti && (
          <div className="space-y-3 max-w-md mx-auto">
            {SUB_STEPS.map((step) => {
              const stepIndex = PHASE_ORDER.indexOf(step.id);
              const isComplete = currentIndex > stepIndex || phase === "done";
              const isActive = phase === step.id;

              return (
                <div key={step.id} className="flex items-center gap-3">
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
        )}
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

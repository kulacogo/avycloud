import React, { useEffect, useState, useRef } from "react";
import { Product } from "../../types";
import { identifyProductV2 } from "../../api/client";
import { Card } from "../ui/Card";
import { Button } from "../ui/Button";
import { ProgressBar } from "../ui/ProgressBar";
import type { CaptureUploadData } from "./CaptureView";
import { compressImagesForUpload } from "../../utils/imageCompress";
import { beginIdentifyRun } from "../../utils/identifyRunFlag";

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
const TRANSIENT_IDENTIFY_CODES = new Set([408, 429, 500, 502, 503, 504]);
const SINGLE_MODE_MAX_ATTEMPTS = 3;
const SINGLE_MODE_BACKOFF_MS = [0, 4_000, 10_000];

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isTransientIdentifyError = (errOrResult: {
  code?: number | string;
  message?: string;
}) => {
  const code = errOrResult?.code;
  if (typeof code === "number" && TRANSIENT_IDENTIFY_CODES.has(code)) return true;
  const msg = String(errOrResult?.message || "").toLowerCase();
  return /timeout|abgebrochen|netzwerk|network|fetch|429|408|5\d\d/.test(msg);
};

const formatIdentifyError = (
  rawMessage: string | null | undefined,
  attemptsTried: number
): string => {
  const base = (rawMessage || "Produkterkennung fehlgeschlagen.").trim();
  const isTimeout = /timeout|abgebrochen/i.test(base);
  if (!isTimeout) return base;
  return [
    base,
    attemptsTried > 1
      ? `Nach ${attemptsTried} Versuchen weiterhin Timeout.`
      : null,
    "Tipp: Versuche es mit weniger Bildern (3-4 reichen meist) oder kleinerer Auflösung.",
  ]
    .filter(Boolean)
    .join(" ");
};

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
  const [retryNonce, setRetryNonce] = useState(0);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    let cancelled = false;
    // Tell App.tsx to pause the 60s products polling while we're busy.
    // Released in the finally block below — also called automatically if
    // the component unmounts mid-run via the useEffect cleanup.
    const releaseIdentifyFlag = beginIdentifyRun();

    const run = async () => {
      const groups = uploadData.groups;
      const total = groups.length;
      setGroupProgress({ current: 0, total });
      setPhaseLabel(null);

      if (total <= 1) {
        // Single group: phase animation + retry-with-backoff on transient errors.
        const phaseTimers: NodeJS.Timeout[] = [];
        const delays = [800, 2500, 4000, 7000, 12000];
        const phases: Phase[] = ["vision", "barcode", "web", "llm", "pricing"];

        const startPhaseAnimation = () => {
          phaseTimers.forEach(clearTimeout);
          phaseTimers.length = 0;
          setPhase("upload");
          phases.forEach((p, i) => {
            phaseTimers.push(
              setTimeout(() => {
                if (!cancelled) setPhase(p);
              }, delays[i])
            );
          });
        };

        const group = groups[0];
        let compressedImages: File[] = group?.images || [];
        try {
          if (compressedImages.length) {
            const { files: compressed, bytesBefore, bytesAfter } =
              await compressImagesForUpload(compressedImages, {
                maxDim: 1600,
                quality: 0.78,
              });
            compressedImages = compressed;
            const mbBefore = (bytesBefore / 1_048_576).toFixed(1);
            const mbAfter = (bytesAfter / 1_048_576).toFixed(1);
            console.log(
              `[StepAnalysis] Compressed ${compressed.length} image(s): ${mbBefore} MB → ${mbAfter} MB`
            );
          }
        } catch (compErr) {
          console.warn(
            "[StepAnalysis] image compression failed, using originals",
            compErr
          );
        }

        let lastMessage: string | null = null;
        let lastCode: number | undefined;
        let attemptsTried = 0;

        for (let attempt = 1; attempt <= SINGLE_MODE_MAX_ATTEMPTS; attempt++) {
          if (cancelled) return;
          attemptsTried = attempt;

          if (attempt > 1) {
            const backoffMs = SINGLE_MODE_BACKOFF_MS[attempt - 1] || 0;
            setPhaseLabel(
              `Versuch ${attempt}/${SINGLE_MODE_MAX_ATTEMPTS} läuft…${
                backoffMs ? ` (warte ${Math.round(backoffMs / 1000)}s)` : ""
              }`
            );
            if (backoffMs) await wait(backoffMs);
            if (cancelled) return;
          }

          startPhaseAnimation();

          try {
            const result = await identifyProductV2(
              compressedImages,
              uploadData.barcodes,
              "de-DE",
              undefined,
              uploadData.paletteCode || undefined,
              group?.hint || undefined
            );

            phaseTimers.forEach(clearTimeout);
            if (cancelled) return;

            if (result.ok && result.data) {
              setPhaseLabel(null);
              setPhase("done");
              setTimeout(() => {
                if (!cancelled) onComplete(result.data!);
              }, 600);
              return;
            }

            // Soft failure (4xx/5xx via API client). Retry only on transient codes.
            lastMessage = result.error?.message || "Produkterkennung fehlgeschlagen.";
            lastCode = typeof result.error?.code === "number" ? result.error.code : undefined;
            const transient = isTransientIdentifyError({
              code: lastCode,
              message: lastMessage,
            });
            if (!transient || attempt >= SINGLE_MODE_MAX_ATTEMPTS) break;
          } catch (err: any) {
            phaseTimers.forEach(clearTimeout);
            if (cancelled) return;
            lastMessage = err?.message || "Ein unerwarteter Fehler ist aufgetreten.";
            const transient = isTransientIdentifyError({ message: lastMessage ?? undefined });
            if (!transient || attempt >= SINGLE_MODE_MAX_ATTEMPTS) break;
          }
        }

        if (cancelled) return;
        const finalMessage = formatIdentifyError(lastMessage, attemptsTried);
        setPhase("error");
        setError(finalMessage);
        onError(finalMessage);
      } else {
        // Multi-group mode:
        // Pass 1 runs with limited concurrency. If ALL groups fail, run one
        // sequential pass to reduce transient overload/rate-limit failures.
        const CONCURRENCY = 2;
        const results: Product[] = [];
        const errors: { label: string; error: string }[] = [];
        let completed = 0;

        // Pre-compress images per group ONCE so we don't redo the canvas work
        // on retries. Falls back to originals if anything throws.
        const compressedByGroup = new WeakMap<
          CaptureUploadData["groups"][number],
          File[]
        >();
        await Promise.all(
          groups.map(async (g) => {
            try {
              const { files } = await compressImagesForUpload(g.images || [], {
                maxDim: 1600,
                quality: 0.78,
              });
              compressedByGroup.set(g, files);
            } catch (err) {
              console.warn("[StepAnalysis] multi-group compression failed for", g.label, err);
              compressedByGroup.set(g, g.images || []);
            }
          })
        );
        if (cancelled) return;

        const identifyGroupWithRetry = async (group: CaptureUploadData["groups"][number]) => {
          const maxAttempts = 2;
          let lastMessage = "Unbekannter Fehler";
          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            if (cancelled) {
              return { ok: false as const, error: "Abgebrochen" };
            }
            try {
              const parts = [group.label, group.barcodes, group.hint].filter(Boolean);
              const combinedHint = parts.length ? parts.join(" — ") : undefined;
              const imagesToSend = compressedByGroup.get(group) || group.images || [];
              const result = await identifyProductV2(
                imagesToSend,
                group.barcodes || "",
                "de-DE",
                undefined,
                uploadData.paletteCode || undefined,
                combinedHint
              );
              if (result.ok && result.data) {
                return { ok: true as const, data: result.data };
              }
              const code = result.error?.code;
              const msg = result.error?.message || "Unbekannter Fehler";
              lastMessage = code ? `${msg} (HTTP ${code})` : msg;
              const retryable = typeof code === "number" && TRANSIENT_IDENTIFY_CODES.has(code);
              if (attempt < maxAttempts && retryable) {
                setPhaseLabel(`Retry für ${group.label} (${attempt + 1}/${maxAttempts}) ...`);
                await wait(900 * attempt);
                continue;
              }
              return { ok: false as const, error: lastMessage };
            } catch (err: any) {
              const raw = err?.message || "Netzwerkfehler";
              lastMessage = String(raw);
              const retryable = /timeout|network|fetch|abgebrochen|429|5\d\d/i.test(lastMessage);
              if (attempt < maxAttempts && retryable) {
                setPhaseLabel(`Retry für ${group.label} (${attempt + 1}/${maxAttempts}) ...`);
                await wait(900 * attempt);
                continue;
              }
              return { ok: false as const, error: lastMessage };
            }
          }
          return { ok: false as const, error: lastMessage };
        };

        // Phase progress timer (simulates sub-steps like single-mode)
        const phaseTimers: NodeJS.Timeout[] = [];
        const multiPhases: Phase[] = ["vision", "barcode", "web", "llm", "pricing"];
        const multiDelays = [800, 3000, 10000, 25000, 50000];
        multiPhases.forEach((p, i) => {
          phaseTimers.push(setTimeout(() => { if (!cancelled) setPhase(p); }, multiDelays[i]));
        });

        const processGroups = async (concurrency: number, targetGroups = groups) => {
          for (let batchStart = 0; batchStart < targetGroups.length; batchStart += concurrency) {
            if (cancelled) return;
            const chunk = targetGroups.slice(batchStart, batchStart + concurrency);
            setPhaseLabel(
              concurrency === 1
                ? `Fallback-Retry: Produkt ${batchStart + 1} von ${targetGroups.length}...`
                : `Produkte ${batchStart + 1}–${Math.min(batchStart + concurrency, targetGroups.length)} von ${targetGroups.length}...`
            );

            const chunkResults = await Promise.allSettled(chunk.map((group) => identifyGroupWithRetry(group)));

            for (let i = 0; i < chunkResults.length; i++) {
              const settled = chunkResults[i];
              const group = chunk[i];
              completed++;
              setGroupProgress({ current: completed, total });
              if (settled.status === "fulfilled" && settled.value.ok && settled.value.data) {
                results.push(settled.value.data);
              } else {
                const msg = settled.status === "rejected"
                  ? settled.reason?.message || "Netzwerkfehler"
                  : settled.value.error || "Unbekannter Fehler";
                errors.push({ label: group.label, error: msg });
              }
            }
          }
        };

        await processGroups(CONCURRENCY);

        // If everything failed in parallel mode, retry once sequentially.
        if (!cancelled && results.length === 0 && errors.length === total) {
          const failedGroups = groups.filter((g) => errors.some((e) => e.label === g.label));
          errors.length = 0;
          completed = 0;
          setGroupProgress({ current: 0, total: failedGroups.length || total });
          await processGroups(1, failedGroups.length ? failedGroups : groups);
        }

        phaseTimers.forEach(clearTimeout);
        if (cancelled) return;

        if (results.length === 0) {
          const grouped = errors.slice(0, 3).map((e) => `${e.label}: ${e.error}`).join(" | ");
          const more = errors.length > 3 ? ` (+${errors.length - 3} weitere)` : "";
          const msg = `Alle ${errors.length} Produkte fehlgeschlagen. ${grouped}${more}`;
          setPhase("error");
          setError(msg);
          onError(msg);
          return;
        }

        if (errors.length > 0) {
          const first = errors[0];
          setError(`${errors.length} von ${total} Produkten fehlgeschlagen (z. B. ${first.label}: ${first.error})`);
        }

        setPhase("done");
        setTimeout(() => {
          if (!cancelled) onComplete(results);
        }, 600);
      }
    };

    run().finally(() => {
      releaseIdentifyFlag();
    });
    return () => {
      cancelled = true;
      // Defensive: if the component unmounts before run() finishes (user
      // navigates away mid-identify), release immediately so polling resumes.
      releaseIdentifyFlag();
    };
  }, [uploadData, onComplete, onError, retryNonce]);

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
              setPhaseLabel(null);
              setGroupProgress({ current: 0, total: uploadData.groups.length });
              onError("");
              setRetryNonce((v) => v + 1);
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

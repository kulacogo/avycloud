import React from "react";
import { cn } from "./cn";

export interface Step {
  id: string;
  label: string;
}

export interface StepperProps {
  steps: Step[];
  activeStep: string;
  completedSteps?: string[];
  direction?: "horizontal" | "vertical";
  className?: string;
}

export const Stepper: React.FC<StepperProps> = ({
  steps,
  activeStep,
  completedSteps = [],
  direction = "horizontal",
  className,
}) => {
  const completedSet = new Set(completedSteps);
  const isHorizontal = direction === "horizontal";

  return (
    <div
      className={cn(
        "flex",
        isHorizontal ? "items-center gap-2" : "flex-col gap-1",
        className
      )}
      role="list"
    >
      {steps.map((step, i) => {
        const isActive = step.id === activeStep;
        const isCompleted = completedSet.has(step.id);
        const isUpcoming = !isActive && !isCompleted;

        return (
          <React.Fragment key={step.id}>
            <div
              className={cn(
                "flex items-center gap-2",
                isHorizontal ? "" : "py-1"
              )}
              role="listitem"
              aria-current={isActive ? "step" : undefined}
            >
              {/* Step indicator */}
              <span
                className={cn(
                  "flex items-center justify-center w-7 h-7 rounded-full text-xs font-bold shrink-0 transition-colors",
                  isCompleted && "bg-accent text-white",
                  isActive && "bg-accent-dim text-accent border-2 border-accent",
                  isUpcoming && "bg-app-elevated text-txt-muted"
                )}
              >
                {isCompleted ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                ) : (
                  i + 1
                )}
              </span>
              {/* Label */}
              <span
                className={cn(
                  "text-sm font-medium whitespace-nowrap",
                  isActive && "text-accent",
                  isCompleted && "text-txt-primary",
                  isUpcoming && "text-txt-muted"
                )}
              >
                {step.label}
              </span>
            </div>
            {/* Connector line */}
            {i < steps.length - 1 && (
              isHorizontal ? (
                <div className={cn("flex-1 h-px min-w-[24px]", isCompleted ? "bg-accent" : "bg-app-border")} aria-hidden="true" />
              ) : (
                <div className={cn("ml-3.5 w-px h-6", isCompleted ? "bg-accent" : "bg-app-border")} aria-hidden="true" />
              )
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
};

Stepper.displayName = "Stepper";
export default Stepper;

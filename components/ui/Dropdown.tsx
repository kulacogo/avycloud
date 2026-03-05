import React, { useState, useRef, useEffect } from "react";
import { cn } from "./cn";

export interface DropdownItem {
  id: string;
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}

export interface DropdownGroup {
  label?: string;
  items: DropdownItem[];
}

export interface DropdownProps {
  trigger: React.ReactNode;
  groups: DropdownGroup[];
  position?: "bottom-start" | "bottom-end";
  className?: string;
}

export const Dropdown: React.FC<DropdownProps> = ({
  trigger,
  groups,
  position = "bottom-end",
  className,
}) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div className={cn("relative inline-flex", className)} ref={ref}>
      <span onClick={() => setOpen(!open)} className="cursor-pointer">
        {trigger}
      </span>
      {open && (
        <div
          className={cn(
            "absolute z-30 mt-2 min-w-[200px] max-w-[320px] rounded-xl border border-app-border bg-app-bg p-1.5 shadow-xl shadow-black/40",
            position === "bottom-end" ? "right-0 top-full" : "left-0 top-full"
          )}
        >
          {groups.map((group, gi) => (
            <React.Fragment key={gi}>
              {gi > 0 && <div className="my-1.5 border-t border-app-border/60" />}
              {group.label && (
                <div className="px-2.5 pt-1 pb-1 text-[10px] uppercase tracking-wider font-semibold text-txt-muted">
                  {group.label}
                </div>
              )}
              {group.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => { item.onClick(); setOpen(false); }}
                  disabled={item.disabled}
                  className={cn(
                    "w-full flex items-center gap-2 px-3 py-2 text-sm rounded-lg transition-colors text-left",
                    item.danger
                      ? "text-danger hover:bg-danger-dim"
                      : "text-txt-primary hover:bg-app-elevated/60",
                    item.disabled && "opacity-40 cursor-not-allowed"
                  )}
                >
                  {item.icon && <span className="w-4 h-4 shrink-0">{item.icon}</span>}
                  {item.label}
                </button>
              ))}
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
};

Dropdown.displayName = "Dropdown";
export default Dropdown;

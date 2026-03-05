import React, { useState, useRef, useEffect, useCallback } from "react";
import { cn } from "./cn";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps {
  options: SelectOption[];
  value?: string | string[];
  onChange: (value: string | string[]) => void;
  placeholder?: string;
  label?: string;
  error?: string;
  disabled?: boolean;
  searchable?: boolean;
  multiple?: boolean;
  clearable?: boolean;
  className?: string;
}

export const Select: React.FC<SelectProps> = ({
  options,
  value,
  onChange,
  placeholder = "Auswählen…",
  label,
  error,
  disabled,
  searchable = false,
  multiple = false,
  clearable = false,
  className,
}) => {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const selectedValues = multiple
    ? (Array.isArray(value) ? value : value ? [value] : [])
    : [];
  const singleValue = !multiple ? (typeof value === "string" ? value : "") : "";

  const filteredOptions = searchable && search
    ? options.filter((o) => o.label.toLowerCase().includes(search.toLowerCase()))
    : options;

  const displayLabel = multiple
    ? selectedValues.length > 0
      ? `${selectedValues.length} ausgewählt`
      : placeholder
    : options.find((o) => o.value === singleValue)?.label || placeholder;

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Focus search on open
  useEffect(() => {
    if (open && searchable) {
      setTimeout(() => searchRef.current?.focus(), 50);
    }
    if (!open) setSearch("");
  }, [open, searchable]);

  const handleSelect = useCallback(
    (optValue: string) => {
      if (multiple) {
        const next = selectedValues.includes(optValue)
          ? selectedValues.filter((v) => v !== optValue)
          : [...selectedValues, optValue];
        onChange(next);
      } else {
        onChange(optValue);
        setOpen(false);
      }
    },
    [multiple, selectedValues, onChange]
  );

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange(multiple ? [] : "");
  };

  const hasValue = multiple ? selectedValues.length > 0 : !!singleValue;

  return (
    <div className={cn("space-y-1.5", className)} ref={containerRef}>
      {label && (
        <label className="block text-xs font-medium uppercase tracking-wide text-txt-muted">{label}</label>
      )}
      <button
        type="button"
        onClick={() => !disabled && setOpen(!open)}
        disabled={disabled}
        className={cn(
          "w-full flex items-center justify-between h-10 px-3 text-sm rounded-xl bg-app-elevated border transition-colors text-left",
          "focus:outline-none focus:ring-1 focus:ring-accent focus:border-accent",
          error ? "border-danger" : open ? "border-accent" : "border-app-border",
          disabled && "opacity-50 cursor-not-allowed",
          hasValue ? "text-txt-primary" : "text-txt-muted"
        )}
      >
        <span className="truncate flex-1">{displayLabel}</span>
        <span className="flex items-center gap-1 ml-2 shrink-0">
          {clearable && hasValue && (
            <span
              onClick={handleClear}
              className="p-0.5 rounded hover:bg-app-border transition-colors cursor-pointer"
              role="button"
              aria-label="Auswahl leeren"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </span>
          )}
          <svg
            width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            className={cn("transition-transform", open && "rotate-180")}
            aria-hidden="true"
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </span>
      </button>

      {open && (
        <div className="absolute z-30 mt-1 w-full min-w-[200px] max-h-60 overflow-y-auto rounded-xl border border-app-border bg-app-bg p-1 shadow-xl shadow-black/40">
          {searchable && (
            <input
              ref={searchRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Suchen…"
              className="w-full px-3 py-2 text-sm bg-app-elevated border-b border-app-border rounded-lg mb-1 text-txt-primary placeholder:text-txt-muted focus:outline-none"
            />
          )}
          {filteredOptions.length === 0 ? (
            <div className="px-3 py-2 text-sm text-txt-muted">Keine Ergebnisse</div>
          ) : (
            filteredOptions.map((opt) => {
              const isSelected = multiple
                ? selectedValues.includes(opt.value)
                : singleValue === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => !opt.disabled && handleSelect(opt.value)}
                  disabled={opt.disabled}
                  className={cn(
                    "w-full flex items-center gap-2 px-3 py-2 text-sm rounded-lg transition-colors text-left",
                    isSelected ? "bg-accent-dim text-accent" : "text-txt-primary hover:bg-app-elevated/60",
                    opt.disabled && "opacity-40 cursor-not-allowed"
                  )}
                >
                  {multiple && (
                    <span className={cn(
                      "w-4 h-4 rounded border flex items-center justify-center shrink-0",
                      isSelected ? "bg-accent border-accent" : "border-app-border bg-app-elevated"
                    )}>
                      {isSelected && (
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M20 6L9 17l-5-5" />
                        </svg>
                      )}
                    </span>
                  )}
                  {opt.label}
                </button>
              );
            })
          )}
        </div>
      )}

      {error && <p className="text-xs text-danger" role="alert">{error}</p>}
    </div>
  );
};

Select.displayName = "Select";
export default Select;

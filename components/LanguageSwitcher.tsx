import React, { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { LOCALE_OPTIONS, localeShortLabel } from "../utils/localeOptions";

interface LanguageSwitcherProps {
  /** Klassen für den Auslöser-Knopf — die Kopfzeile gibt ihren Knopfstil vor. */
  className?: string;
  style?: React.CSSProperties;
}

/**
 * Sprachwähler: Kurzlabel ("EN") als Knopf, Klick öffnet die Liste der
 * Oberflächensprachen. Schmal genug für den 5,6"-Handscanner.
 */
export function LanguageSwitcher({ className, style }: LanguageSwitcherProps) {
  const { t, locale, setLocale } = useI18n();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointer = (e: MouseEvent | TouchEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("touchstart", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("touchstart", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const label = t("lang.label");

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={className}
        style={style}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="text-xs font-semibold tracking-wide">{localeShortLabel(locale)}</span>
      </button>

      {open && (
        <div
          role="menu"
          aria-label={label}
          className="absolute right-0 top-full mt-1 z-50 min-w-[9rem] py-1 bg-app-elevated border border-app-border rounded-md shadow-lg"
        >
          {LOCALE_OPTIONS.map((option) => {
            const active = option.code === locale;
            return (
              <button
                key={option.code}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onClick={() => {
                  setLocale(option.code);
                  setOpen(false);
                }}
                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-app-surface ${
                  active ? "text-accent" : "text-txt-primary"
                }`}
              >
                <span className="w-6 text-xs font-semibold">{option.short}</span>
                <span>{option.nativeName}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

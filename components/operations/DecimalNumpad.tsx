import React from "react";
import { appendDigit, appendSeparator, dropLast, parseWeight } from "../../utils/decimalPad";

type DecimalNumpadProps = {
  /** Angezeigter Text (mit Komma), nicht die Zahl — siehe utils/decimalPad.ts. */
  value: string;
  onChange: (next: string) => void;
  label?: string;
  unit?: string;
  onConfirm?: () => void;
  confirmLabel?: string;
  confirmDisabled?: boolean;
  /** Erster Tastendruck ersetzt den Vorschlag, statt ihn zu verlängern. */
  isSuggestion?: boolean;
  onSuggestionReplaced?: () => void;
  hint?: string;
};

/**
 * Ziffernblock für Dezimalwerte — gebaut für die Gewichtseingabe im Packen.
 *
 * WARUM ÜBERHAUPT: Das Gewichtsfeld war bis 2026-08-24 ein echtes
 * `<input inputMode="decimal" autoFocus>`. Genau dafür öffnet Android seine
 * Bildschirmtastatur, und der Fokus-Wächter des Scan-Fangfeldes hielt ihm den
 * Fokus sogar ausdrücklich frei, DAMIT sie aufgeht. Auf einem 5,6"-Handscanner
 * frisst diese Tastatur die halbe Anzeige — der Bediener muss scrollen, um den
 * Bestätigen-Knopf zu finden.
 *
 * Dieser Block ist `readOnly` + `inputMode="none"`: Android zeichnet dafür
 * keine Tastatur. Damit bleibt der Scanner bedienbar und der Bildschirm frei.
 */
const DecimalNumpad: React.FC<DecimalNumpadProps> = ({
  value,
  onChange,
  label,
  unit = "kg",
  onConfirm,
  confirmLabel = "Bestätigen",
  confirmDisabled,
  isSuggestion = false,
  onSuggestionReplaced,
  hint,
}) => {
  const keyBase =
    "flex items-center justify-center rounded-xl bg-app-surface text-txt-primary border border-app-border font-semibold h-[clamp(2.125rem,5.2dvh,3rem)]";

  // Der erste Tastendruck auf einen Vorschlag ersetzt ihn. Die Meldung nach
  // oben passiert im selben Zug, damit der zweite Tastendruck anhängt.
  const verbrauche = () => {
    if (isSuggestion) onSuggestionReplaced?.();
    return isSuggestion;
  };

  const ziffer = (d: string) => onChange(appendDigit(value, d, verbrauche()));
  const komma = () => onChange(appendSeparator(value, verbrauche()));
  const zurueck = () => {
    if (isSuggestion) {
      onSuggestionReplaced?.();
      onChange("");
      return;
    }
    onChange(dropLast(value));
  };
  const leeren = () => {
    if (isSuggestion) onSuggestionReplaced?.();
    onChange("");
  };

  const gueltig = parseWeight(value) != null;

  return (
    <div className="rounded-xl bg-app-bg/60 border border-app-border p-2 space-y-1.5">
      {label ? (
        <p className="text-[11px] uppercase tracking-widest text-txt-muted">{label}</p>
      ) : null}

      <div className="flex items-center gap-2">
        {/*
          readOnly + inputMode="none" ist hier der ganze Punkt: das Feld zeigt
          nur an. Beides zusammen sind die zwei Merkmale, an denen der
          Fokus-Wächter des Scan-Fangfeldes ein Nicht-Eingabefeld erkennt.
        */}
        <input
          type="text"
          inputMode="none"
          readOnly
          tabIndex={-1}
          value={value}
          placeholder="0,0"
          aria-label={label || "Gewicht"}
          className="flex-1 rounded-xl bg-app-surface text-txt-primary border border-app-border text-2xl font-semibold px-3 h-11 tabular-nums"
        />
        <span className="text-sm font-semibold text-txt-muted w-8 shrink-0">{unit}</span>
        <button
          type="button"
          aria-label="Leeren"
          className="rounded-xl px-3 h-11 bg-app-surface text-txt-primary text-sm font-semibold border border-app-border"
          onClick={leeren}
        >
          C
        </button>
      </div>

      <div className="grid grid-cols-3 gap-1">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((n) => (
          <button key={n} type="button" className={`${keyBase} text-xl`} onClick={() => ziffer(n)}>
            {n}
          </button>
        ))}
        <button type="button" aria-label="Komma" className={`${keyBase} text-xl`} onClick={komma}>
          ,
        </button>
        <button type="button" className={`${keyBase} text-xl`} onClick={() => ziffer("0")}>
          0
        </button>
        <button type="button" aria-label="Letzte Stelle löschen" className={`${keyBase} text-lg`} onClick={zurueck}>
          <span aria-hidden="true">⌫</span>
        </button>
      </div>

      {hint ? <p className="text-[11px] text-txt-muted">{hint}</p> : null}

      {onConfirm ? (
        <button
          type="button"
          onClick={onConfirm}
          disabled={Boolean(confirmDisabled) || !gueltig}
          className="w-full flex items-center justify-center rounded-xl bg-accent text-white font-semibold h-[clamp(2.5rem,5.6dvh,3rem)] disabled:opacity-40"
        >
          {confirmLabel}
        </button>
      ) : null}
    </div>
  );
};

export default DecimalNumpad;

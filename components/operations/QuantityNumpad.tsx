import React from "react";
import { useI18n } from "../../i18n";
import { nextQuantityFromDigit, clampQuantity, isReplacingEntry } from "../../utils/quantityPad";

type QuantityNumpadProps = {
  value: number;
  onChange: (next: number) => void;
  min?: number;
  max?: number;
  readOnlyLabel?: string;
  onConfirm?: () => void;
  confirmLabel?: string;
  confirmDisabled?: boolean;
};

const QuantityNumpad: React.FC<QuantityNumpadProps> = ({
  value,
  onChange,
  min = 0,
  max,
  readOnlyLabel,
  onConfirm,
  confirmLabel,
  confirmDisabled,
}) => {
  const { t } = useI18n();
  const safeValue = Number.isFinite(value) ? value : 0;

  // Responsive key height: shrinks on short viewports so the whole pad +
  // confirm button fit without scrolling, but never below a 40px tap target.
  const keyBase =
    "flex items-center justify-center rounded-xl bg-app-surface text-txt-primary border border-app-border font-semibold h-[clamp(2.5rem,6.2dvh,3.25rem)]";

  /**
   * Merkt sich den zuletzt SELBST gesendeten Wert. Weicht der hereinkommende
   * `value` davon ab, kam er von außen (Reset nach Buchung, Scan, Auswahl einer
   * Kommissionier-Zeile) — dann ersetzt der nächste Tastendruck den Vorschlag,
   * statt sich anzuhängen. Der Zustand gehört bewusst HIERHIN und nicht in die
   * aufrufende Ansicht: sonst müsste jeder der beiden Aufrufer (Einlagern,
   * Kommissionieren) an jeder Reset-Stelle daran denken.
   */
  const lastEmittedRef = React.useRef<number | null>(null);
  // Ob seit der letzten Wertänderung von außen schon getippt wurde. Muss ein
  // Ref sein: meldet der Block denselben Wert zurück, den er schon anzeigt
  // (Vorgabe 1, Tipp auf die 1), zeichnet React NICHT neu — ein beim Zeichnen
  // berechneter Zustand bliebe dann stehen und die nächste Ziffer würde erneut
  // ersetzen statt anzuhängen (aus 15 würde 5).
  const hasTypedRef = React.useRef(false);

  const emit = (next: number) => {
    lastEmittedRef.current = next;
    hasTypedRef.current = true;
    onChange(next);
  };

  const appendDigit = (digit: number) => {
    // Bewusst zur KLICK-Zeit ausgewertet, nicht beim Zeichnen.
    const isFirstEntry = isReplacingEntry({
      lastEmitted: lastEmittedRef.current,
      current: safeValue,
      hasTyped: hasTypedRef.current,
    });
    emit(nextQuantityFromDigit({ current: safeValue, digit, isFirstEntry, min, max }));
  };

  const dropLastDigit = () => {
    const normalized = Math.max(0, Math.floor(safeValue));
    emit(clampQuantity(Math.floor(normalized / 10), min, max));
  };

  const clear = () => {
    emit(clampQuantity(0, min, max));
  };

  return (
    <div className="rounded-xl bg-app-bg/60 border border-app-border p-2.5 space-y-2">
      <p className="text-[11px] uppercase tracking-widest text-txt-muted">
        {readOnlyLabel || t("ops.mobile.qtyScannerOrPad")}
      </p>
      <div className="flex items-center gap-2">
        <input
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          readOnly
          value={Math.max(0, Math.floor(safeValue))}
          className="flex-1 rounded-xl bg-app-surface text-txt-primary border border-app-border text-xl font-semibold px-3 h-11"
        />
        <button
          type="button"
          aria-label={t("common.clear")}
          className="rounded-xl px-3 h-11 bg-app-surface text-txt-primary text-sm font-semibold border border-app-border"
          onClick={clear}
        >
          {t("common.clear")}
        </button>
      </div>
      <div className="grid grid-cols-3 gap-1.5">
        {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
          <button
            key={n}
            type="button"
            className={`${keyBase} text-xl`}
            onClick={() => appendDigit(n)}
          >
            {n}
          </button>
        ))}
        <button
          type="button"
          aria-label="Delete last digit"
          className={`${keyBase} text-lg`}
          onClick={dropLastDigit}
        >
          <span aria-hidden="true">⌫</span>
        </button>
        <button
          type="button"
          className={`${keyBase} text-xl`}
          onClick={() => appendDigit(0)}
        >
          0
        </button>
        <button
          type="button"
          aria-label="Set quantity to zero"
          className={`${keyBase} text-lg`}
          onClick={clear}
        >
          C
        </button>
      </div>
      {onConfirm ? (
        <button
          type="button"
          onClick={onConfirm}
          disabled={Boolean(confirmDisabled)}
          className="w-full flex items-center justify-center rounded-xl bg-success-dim text-success font-semibold h-12 disabled:opacity-40"
        >
          {confirmLabel || t("ops.pick.submit")}
        </button>
      ) : null}
    </div>
  );
};

export default QuantityNumpad;

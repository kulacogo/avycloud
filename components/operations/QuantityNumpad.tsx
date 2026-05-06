import React from "react";
import { useI18n } from "../../i18n";

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

const clamp = (value: number, min: number, max?: number) => {
  const minApplied = Math.max(min, value);
  if (typeof max !== "number" || !Number.isFinite(max)) return minApplied;
  return Math.min(max, minApplied);
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

  const appendDigit = (digit: number) => {
    const normalized = Math.max(0, Math.floor(safeValue));
    const nextRaw = Number(`${normalized}${digit}`);
    const bounded = clamp(Number.isFinite(nextRaw) ? nextRaw : 0, min, max);
    onChange(bounded);
  };

  const dropLastDigit = () => {
    const normalized = Math.max(0, Math.floor(safeValue));
    onChange(clamp(Math.floor(normalized / 10), min, max));
  };

  const clear = () => {
    onChange(clamp(0, min, max));
  };

  return (
    <div className="rounded-xl bg-app-bg/60 border border-app-border p-3 space-y-3">
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
          className="flex-1 rounded-xl bg-app-surface text-txt-primary border border-app-border text-xl font-semibold px-3 py-2"
        />
        <button
          type="button"
          aria-label={t("common.clear")}
          className="rounded-xl px-3 py-2 bg-app-surface text-txt-primary text-sm font-semibold border border-app-border"
          onClick={clear}
        >
          {t("common.clear")}
        </button>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
          <button
            key={n}
            type="button"
            className="rounded-xl bg-app-surface text-txt-primary border border-app-border text-xl font-semibold py-3"
            onClick={() => appendDigit(n)}
          >
            {n}
          </button>
        ))}
        <button
          type="button"
          aria-label="Delete last digit"
          className="rounded-xl bg-app-surface text-txt-primary border border-app-border text-lg font-semibold py-3"
          onClick={dropLastDigit}
        >
          <span aria-hidden="true">⌫</span>
        </button>
        <button
          type="button"
          className="rounded-xl bg-app-surface text-txt-primary border border-app-border text-xl font-semibold py-3"
          onClick={() => appendDigit(0)}
        >
          0
        </button>
        <button
          type="button"
          aria-label="Set quantity to zero"
          className="rounded-xl bg-app-surface text-txt-primary border border-app-border text-lg font-semibold py-3"
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
          className="w-full rounded-xl bg-success-dim text-success font-semibold py-3 disabled:opacity-40"
        >
          {confirmLabel || t("ops.pick.submit")}
        </button>
      ) : null}
    </div>
  );
};

export default QuantityNumpad;

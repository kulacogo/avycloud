import React, { useEffect, useMemo, useRef, useState } from "react";
import type { ShippingPreviewMatch, CuratedShippingProduct } from "../../api/client";
import DecimalNumpad from "../operations/DecimalNumpad";
import { appendDigit, appendSeparator, dropLast, parseWeight, formatWeight } from "../../utils/decimalPad";

/**
 * Shared shipping-decision dialogs used by both the mobile pack module
 * (MobileOperationsView, mode === "operations-pack") and the desktop
 * OrderDetail "Versandlabel erstellen" action.
 *
 * Two pop-ups, both centred on desktop and full-screen on mobile via
 * Tailwind `sm:` breakpoints:
 *
 *   • {@link WeightPromptModal} — when the order has no usable weight.
 *     The user enters kg, we persist it via `updateOrderWeight`, then
 *     re-run `fetchShippingPreview`.
 *
 *   • {@link CarrierPickModal} — when several carrier rules match the
 *     same weight (e.g. 2 kg → DHL Paket 0-2 kg + DPD Classic 0-5 kg).
 *     The user picks one; the parent forwards the chosen
 *     `shippingMethodId` to `shipOrder` / `packAndShip`.
 *
 * Both modals are deliberately stateless w.r.t. the network — the parent
 * decides how to wire actions. This keeps the desktop "create label" and
 * mobile "Verpackt" buttons free to compose the same flow without a
 * pile of effects.
 */

/* ──────────────────────────────────────────────────────────────── */
/*  Shared chrome                                                   */
/* ──────────────────────────────────────────────────────────────── */

const ModalShell: React.FC<{
  title: string;
  subtitle?: string;
  onClose: () => void;
  busy?: boolean;
  children: React.ReactNode;
  footer: React.ReactNode;
}> = ({ title, subtitle, onClose, busy, children, footer }) => {
  const backdropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-[60] bg-black/50 backdrop-blur-sm flex items-end sm:items-center justify-center"
      onClick={(e) => {
        if (e.target === backdropRef.current && !busy) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="w-full sm:max-w-md bg-app-surface border-t sm:border border-app-border sm:rounded-2xl rounded-t-2xl shadow-2xl flex flex-col max-h-[90vh]">
        <div className="flex items-start justify-between gap-3 p-5 border-b border-app-border shrink-0">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-txt-primary">{title}</h2>
            {subtitle ? (
              <p className="text-xs text-txt-muted mt-0.5">{subtitle}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="p-1.5 rounded-lg hover:bg-app-elevated text-txt-muted hover:text-txt-primary transition-colors disabled:opacity-50"
            aria-label="Schließen"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">{children}</div>

        <div className="p-4 border-t border-app-border bg-app-bg/30 rounded-b-2xl">{footer}</div>
      </div>
    </div>
  );
};

/* ──────────────────────────────────────────────────────────────── */
/*  Weight prompt                                                    */
/* ──────────────────────────────────────────────────────────────── */

interface WeightPromptModalProps {
  /** Best-effort initial value (e.g. estimated from items). 0/null = empty input. */
  initialKg?: number | null;
  /** Order number / SKU shown in the subtitle for context. */
  contextLabel?: string | null;
  busy?: boolean;
  errorMessage?: string | null;
  onConfirm: (kg: number) => void;
  onCancel: () => void;
}

export const WeightPromptModal: React.FC<WeightPromptModalProps> = ({
  initialKg,
  contextLabel,
  busy = false,
  errorMessage,
  onConfirm,
  onCancel,
}) => {
  const [value, setValue] = useState<string>(formatWeight(initialKg));
  // Der vorbelegte Schätzwert soll beim ersten Tastendruck ERSETZT werden,
  // nicht verlängert — sonst wird aus dem Vorschlag 2 und der Eingabe 3 die
  // Zahl 23, und das Paket geht mit 23 kg raus.
  const [istVorschlag, setIstVorschlag] = useState<boolean>(Boolean(initialKg && initialKg > 0));

  const parsed = useMemo(() => parseWeight(value), [value]);

  const submit = () => {
    if (parsed != null && !busy) onConfirm(parsed);
  };

  /**
   * Echte Tastenanschläge zusätzlich annehmen.
   *
   * Am Schreibtisch soll man das Gewicht einfach tippen können. Auf dem
   * Handscanner tippt man auf den Ziffernblock. Beides gleichzeitig geht nur
   * ohne fokussiertes Eingabefeld — ein solches Feld ist genau das, wofür
   * Android seine Bildschirmtastatur öffnet (siehe DecimalNumpad).
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (busy) return;
      if (e.key === "Enter") { e.preventDefault(); submit(); return; }
      if (e.key === "Backspace") {
        e.preventDefault();
        if (istVorschlag) { setIstVorschlag(false); setValue(""); return; }
        setValue((v) => dropLast(v));
        return;
      }
      if (e.key === "," || e.key === ".") {
        e.preventDefault();
        setValue((v) => appendSeparator(v, istVorschlag));
        setIstVorschlag(false);
        return;
      }
      if (/^[0-9]$/.test(e.key)) {
        e.preventDefault();
        setValue((v) => appendDigit(v, e.key, istVorschlag));
        setIstVorschlag(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, istVorschlag, parsed]);

  return (
    <ModalShell
      title="Gewicht eingeben"
      subtitle={
        contextLabel
          ? `${contextLabel} — Versandlabel kann ohne Gewicht nicht erstellt werden.`
          : "Versandlabel kann ohne Gewicht nicht erstellt werden."
      }
      onClose={onCancel}
      busy={busy}
      footer={
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-lg bg-app-elevated text-txt-secondary px-4 py-2.5 text-sm font-semibold hover:text-txt-primary transition disabled:opacity-50"
          >
            Abbrechen
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy || parsed == null}
            className="inline-flex items-center gap-2 rounded-lg bg-accent text-white px-4 py-2.5 text-sm font-semibold hover:bg-accent/90 transition disabled:opacity-50"
          >
            {busy && <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
            Bestätigen
          </button>
        </div>
      }
    >
      {/*
        Eigener Ziffernblock statt eines echten Eingabefeldes. Das Feld war die
        Ursache der aufpoppenden Android-Tastatur im Packen: der Fokus-Wächter
        des Scan-Fangfeldes hielt ihm den Fokus ausdrücklich frei, DAMIT sie
        aufgeht. Auf dem 5,6"-Handscanner verdeckt sie den Bestätigen-Knopf.
        Am Schreibtisch tippt man weiterhin einfach — der keydown-Horcher oben
        nimmt echte Tastenanschläge an.
      */}
      <DecimalNumpad
        label="Gewicht"
        unit="kg"
        value={value}
        onChange={setValue}
        isSuggestion={istVorschlag}
        onSuggestionReplaced={() => setIstVorschlag(false)}
        hint="Versandgewicht inkl. Verpackung. Am Rechner kann auch getippt werden."
      />
      {errorMessage ? (
        <div className="mt-3 bg-danger-dim border border-danger/20 rounded-lg px-3 py-2 text-xs text-danger">
          {errorMessage}
        </div>
      ) : null}
    </ModalShell>
  );
};

/* ──────────────────────────────────────────────────────────────── */
/*  Carrier picker                                                   */
/* ──────────────────────────────────────────────────────────────── */

interface CarrierPickModalProps {
  weightKg: number;
  matches: ShippingPreviewMatch[];
  contextLabel?: string | null;
  busy?: boolean;
  errorMessage?: string | null;
  /** Called with the chosen `shippingMethodId`. */
  onConfirm: (match: ShippingPreviewMatch) => void;
  onCancel: () => void;
}

// Carrier-Chips: bewusst pro Carrier eingefärbt (Markenfarben). Das Theme läuft über
// [data-theme='light'] (CSS-Variablen, kein Tailwind-`dark:`-Class-Toggle), daher werden
// die hellen -200-Textstufen (Dark-Default) per Arbitrary-Variant im Light-Theme auf
// AA-sichere -700-Stufen überschrieben.
const carrierBadgeClass = (carrier: string): string => {
  const c = String(carrier || "").toLowerCase();
  if (c === "dhl" || c.startsWith("dhl_")) return "bg-yellow-500/20 text-yellow-200 [[data-theme='light']_&]:text-yellow-700 border-yellow-500/30";
  if (c === "dpd") return "bg-red-500/20 text-red-200 [[data-theme='light']_&]:text-red-700 border-red-500/30";
  if (c === "gls") return "bg-blue-500/20 text-blue-200 [[data-theme='light']_&]:text-blue-700 border-blue-500/30";
  if (c === "dp" || c === "deutsche_post") return "bg-amber-500/20 text-amber-200 [[data-theme='light']_&]:text-amber-700 border-amber-500/30";
  if (c === "ups") return "bg-amber-700/20 text-amber-200 [[data-theme='light']_&]:text-amber-800 border-amber-700/30";
  if (c === "hermes") return "bg-cyan-500/20 text-cyan-200 [[data-theme='light']_&]:text-cyan-700 border-cyan-500/30";
  return "bg-app-elevated text-txt-secondary border-app-border";
};

export const CarrierPickModal: React.FC<CarrierPickModalProps> = ({
  weightKg,
  matches,
  contextLabel,
  busy = false,
  errorMessage,
  onConfirm,
  onCancel,
}) => {
  const [selectedId, setSelectedId] = useState<number | null>(
    matches.length > 0 ? matches[0].shippingMethodId : null
  );
  const selected = matches.find((m) => m.shippingMethodId === selectedId) || null;

  return (
    <ModalShell
      title="Versandmethode wählen"
      subtitle={
        contextLabel
          ? `${contextLabel} — ${weightKg.toLocaleString("de-DE", { maximumFractionDigits: 3 })} kg passt zu mehreren Regeln.`
          : `${weightKg.toLocaleString("de-DE", { maximumFractionDigits: 3 })} kg passt zu mehreren Versandregeln.`
      }
      onClose={onCancel}
      busy={busy}
      footer={
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-lg bg-app-elevated text-txt-secondary px-4 py-2.5 text-sm font-semibold hover:text-txt-primary transition disabled:opacity-50"
          >
            Abbrechen
          </button>
          <button
            type="button"
            onClick={() => selected && onConfirm(selected)}
            disabled={busy || !selected}
            className="inline-flex items-center gap-2 rounded-lg bg-accent text-white px-4 py-2.5 text-sm font-semibold hover:bg-accent/90 transition disabled:opacity-50"
          >
            {busy && <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
            Label erstellen
          </button>
        </div>
      }
    >
      <div className="space-y-2">
        {matches.map((m) => {
          const id = m.shippingMethodId;
          const active = id === selectedId;
          const badge = carrierBadgeClass(m.carrier);
          const range =
            m.maxWeight != null
              ? `${m.minWeight.toLocaleString("de-DE", { maximumFractionDigits: 3 })}–${m.maxWeight.toLocaleString(
                  "de-DE",
                  { maximumFractionDigits: 3 }
                )} kg`
              : `${m.minWeight.toLocaleString("de-DE", { maximumFractionDigits: 3 })}+ kg`;
          return (
            <button
              key={`${id}-${m.id || ""}`}
              type="button"
              onClick={() => setSelectedId(id)}
              disabled={busy}
              className={`w-full text-left rounded-xl border px-4 py-3 transition flex items-start gap-3 ${
                active
                  ? "border-accent bg-accent-dim ring-1 ring-accent/40"
                  : "border-app-border bg-app-bg/40 hover:border-txt-muted"
              } disabled:opacity-50`}
            >
              <span
                className={`mt-0.5 inline-flex items-center justify-center w-5 h-5 rounded-full border ${
                  active ? "border-accent bg-accent" : "border-app-border bg-app-elevated"
                }`}
              >
                {active && <span className="w-2 h-2 rounded-full bg-white" />}
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold text-txt-primary truncate">{m.label}</span>
                  <span className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider border ${badge}`}>
                    {m.carrier}
                  </span>
                </div>
                <p className="text-xs text-txt-muted mt-0.5">
                  {range} <span className="text-txt-muted/70">·</span> ID {id || "—"}
                </p>
              </div>
            </button>
          );
        })}
      </div>

      {errorMessage ? (
        <div className="mt-3 bg-danger-dim border border-danger/20 rounded-lg px-3 py-2 text-xs text-danger">
          {errorMessage}
        </div>
      ) : null}
    </ModalShell>
  );
};

/* ──────────────────────────────────────────────────────────────── */
/*  Curated shipping-option picker (kuratierter Pack-Flow)          */
/* ──────────────────────────────────────────────────────────────── */

interface ShippingOptionModalProps {
  weightKg: number;
  products: CuratedShippingProduct[];
  /** true = Zielland außerhalb Standard-Zonen (Teamlead-Hinweis). */
  warn?: boolean;
  /** true = ab Schwelle (oder Wert unbekannt): nur Versandarten mit Sendungsverfolgung (2026-08-21). */
  trackedOnly?: boolean;
  /** Echte Schwelle in EUR (ENV-konfigurierbar, nicht hartkodiert). */
  trackedOnlyThresholdEur?: number | null;
  /** false = Bestellwert unbekannt — der Grund ist dann „unbekannt", nicht „über Schwelle". */
  orderValueKnown?: boolean;
  country?: string;
  contextLabel?: string | null;
  busy?: boolean;
  errorMessage?: string | null;
  onConfirm: (product: CuratedShippingProduct) => void;
  onCancel: () => void;
}

export const ShippingOptionModal: React.FC<ShippingOptionModalProps> = ({
  weightKg,
  products,
  warn,
  trackedOnly,
  trackedOnlyThresholdEur,
  orderValueKnown,
  country,
  contextLabel,
  busy = false,
  errorMessage,
  onConfirm,
  onCancel,
}) => {
  const [selectedKey, setSelectedKey] = useState<string | null>(products[0]?.key ?? null);
  const selected = products.find((p) => p.key === selectedKey) || null;

  return (
    <ModalShell
      title="Versand wählen"
      subtitle={`${contextLabel ? contextLabel + " — " : ""}${weightKg.toLocaleString("de-DE", {
        maximumFractionDigits: 3,
      })} kg${country ? " · " + country : ""}`}
      onClose={onCancel}
      busy={busy}
      footer={
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-lg bg-app-elevated text-txt-secondary px-4 py-2.5 text-sm font-semibold hover:text-txt-primary transition disabled:opacity-50"
          >
            Abbrechen
          </button>
          <button
            type="button"
            onClick={() => selected && onConfirm(selected)}
            disabled={busy || !selected}
            className="inline-flex items-center gap-2 rounded-lg bg-accent text-white px-4 py-2.5 text-sm font-semibold hover:bg-accent/90 transition disabled:opacity-50"
          >
            {busy && <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
            Label erstellen
          </button>
        </div>
      }
    >
      {warn ? (
        <div className="mb-3 bg-warning-dim border border-warning/30 rounded-lg px-3 py-2 text-xs text-warning">
          Außerhalb der Standard-Zonen — bitte Teamlead fragen, bevor du versendest.
        </div>
      ) : null}
      {trackedOnly ? (
        <div className="mb-3 bg-info-dim border border-info/30 rounded-lg px-3 py-2 text-xs text-info">
          {orderValueKnown === false
            ? "Bestellwert unbekannt — zur Sicherheit nur Versand mit Sendungsverfolgung."
            : `Ab ${(trackedOnlyThresholdEur ?? 10).toLocaleString("de-DE")} € Bestellwert: nur Versand mit Sendungsverfolgung — Maxibrief/Warensendung stehen deshalb nicht zur Auswahl.`}
        </div>
      ) : null}
      <div className="space-y-2">
        {products.length === 0 ? (
          <p className="text-sm text-txt-muted">Keine passende Versandoption für dieses Gewicht/Zielland.</p>
        ) : (
          products.map((p) => {
            const active = p.key === selectedKey;
            return (
              <button
                key={p.key}
                type="button"
                onClick={() => setSelectedKey(p.key)}
                disabled={busy}
                className={`w-full text-left rounded-xl border px-4 py-3 transition flex items-center gap-3 ${
                  active
                    ? "border-accent bg-accent-dim ring-1 ring-accent/40"
                    : "border-app-border bg-app-bg/40 hover:border-txt-muted"
                } disabled:opacity-50`}
              >
                <span
                  className={`inline-flex items-center justify-center w-5 h-5 rounded-full border ${
                    active ? "border-accent bg-accent" : "border-app-border bg-app-elevated"
                  }`}
                >
                  {active && <span className="w-2 h-2 rounded-full bg-white" />}
                </span>
                <div className="flex-1 min-w-0 flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold text-txt-primary truncate">{p.displayName}</span>
                  <span
                    className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider border ${carrierBadgeClass(
                      p.carrier,
                    )}`}
                  >
                    {p.carrier}
                  </span>
                  <span className={`text-[10px] font-semibold ${p.tracking ? "text-success" : "text-txt-muted"}`}>
                    {p.tracking ? "✓ Tracking" : "✗ kein Tracking"}
                  </span>
                </div>
              </button>
            );
          })
        )}
      </div>
      {errorMessage ? (
        <div className="mt-3 bg-danger-dim border border-danger/20 rounded-lg px-3 py-2 text-xs text-danger">
          {errorMessage}
        </div>
      ) : null}
    </ModalShell>
  );
};

/* ──────────────────────────────────────────────────────────────── */
/*  Coordinator hook                                                 */
/* ──────────────────────────────────────────────────────────────── */

/**
 * State machine for a label-creation interaction.
 *   idle → "weight" (if no weight) → "pick" (if >1 match) → execute.
 */
export type ShipDecisionStep = "idle" | "weight" | "pick" | "executing";

export interface ShipDecisionState {
  step: ShipDecisionStep;
  /** Effective weight in kg used for the carrier match. */
  weightKg: number | null;
  /** Multiple matches the user must choose between. */
  matches: ShippingPreviewMatch[];
  /** Surfaced to the active modal. */
  errorMessage: string | null;
}

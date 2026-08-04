// Decides how the invisible scan-capture field in MobileOperationsView is
// rendered. Two modes:
//
//   "contenteditable" — a contenteditable host carrying virtualkeyboardpolicy=
//     "manual" (VirtualKeyboard API). Chromium then decouples focus from the
//     on-screen keyboard: the element keeps its IME InputConnection (NETUM/
//     Honeywell scanner IMEs still commit scans), but focusing it no longer
//     summons the Android soft keyboard. Chromium honors the policy ONLY on
//     contenteditable hosts, not on <input> — hence the element swap.
//
//   "input" — the plain <input inputMode="text"> capture (pre-2026-08 behavior,
//     soft keyboard visible). Kept as the fallback for browsers without the
//     VirtualKeyboard API and as an on-device escape hatch.
//
// Override via ?scanCapture=... or localStorage.setItem('scanCapture', ...):
//   "input" forces the legacy capture (escape hatch if a device's scanner IME
//   refuses to write into contenteditable), "ce"/"contenteditable" forces the
//   new capture even where feature detection says unsupported.

export type ScanCaptureMode = "input" | "contenteditable";

export function resolveScanCaptureMode(
  override: string | null | undefined,
  supportsVirtualKeyboardPolicy: boolean
): ScanCaptureMode {
  const normalized = (override ?? "").trim().toLowerCase();
  if (normalized === "input") return "input";
  if (normalized === "ce" || normalized === "contenteditable") return "contenteditable";
  return supportsVirtualKeyboardPolicy ? "contenteditable" : "input";
}

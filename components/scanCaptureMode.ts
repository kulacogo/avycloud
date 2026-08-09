// Decides how the invisible scan-capture field in MobileOperationsView is
// rendered. Per DEVICE, never fleet-wide: the two Android handhelds in use
// deliver scans differently, so one setting cannot be right for both.
//
//   "input" (DEFAULT) — <input type="text" inputMode="text">, rendered on-screen
//     as a 1px transparent field. The only variant proven to receive scans from
//     the NETUM Q900 scanner IME (Honeywell HS7). Side effect: because it is a
//     regular editable text field holding focus, Android draws the on-screen
//     keyboard. That is unavoidable for this variant — see the note below.
//
//   "none" — the pre-2026-07-25 capture: <input inputMode="none"> parked
//     off-screen. inputMode="none" tells the WebView to attach no input method,
//     so NO keyboard appears — but a scanner IME then has nowhere to commit.
//     Right for scanners that send real key events (HID / keyboard-wedge mode):
//     those still land via the field's own keydown handler. This is the state
//     the MUNBYN handheld ran on before 2026-07-25 without a keyboard problem.
//
//   "contenteditable" — EXPERIMENTAL: contenteditable host with
//     virtualkeyboardpolicy="manual". Field-tested 2026-08-04 on the NETUM: the
//     scanner IME committed NOTHING. Kept only for future on-device probes.
//
// WHY THERE IS NO FLEET-WIDE FIX: Chromium decides keyboard visibility with a
// single predicate — focusedNodeAllowsSoftKeyboard() = (TextInputType != NONE
// && inputMode != NONE). TextInputType NONE means readOnly/disabled. So the web
// side has exactly two levers, and BOTH also tear down the IME session the
// scanner commits through. That is why readOnly, inputMode="none" and
// virtualkeyboardpolicy="manual" are all scan killers. Suppressing the keyboard
// while keeping the channel is only possible device-side (choosing an input
// method that draws nothing) — see the runbook note in the memory file.
//
// Set per device via ?scanCapture=<mode> (persisted to localStorage on first
// visit, so one URL configures a handheld permanently) or directly via
// localStorage.setItem('scanCapture', '<mode>'). Anything unknown → "input".

export type ScanCaptureMode = "input" | "none" | "contenteditable";

export function resolveScanCaptureMode(override: string | null | undefined): ScanCaptureMode {
  const normalized = (override ?? "").trim().toLowerCase();
  if (normalized === "none") return "none";
  if (normalized === "ce" || normalized === "contenteditable") return "contenteditable";
  return "input";
}

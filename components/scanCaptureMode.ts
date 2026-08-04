// Decides how the invisible scan-capture field in MobileOperationsView is
// rendered.
//
//   "input" (DEFAULT) — the plain <input inputMode="text"> capture. The only
//     variant proven to receive scans from the NETUM Q900 / Honeywell "Focus"
//     scanner IME on Android. Side effect: focusing it summons the on-screen
//     keyboard; there is NO known web-side lever against that for this scanner
//     (see below), so keyboard suppression has to happen device-side.
//
//   "contenteditable" — EXPERIMENTAL, opt-in only: a contenteditable host with
//     virtualkeyboardpolicy="manual" (VirtualKeyboard API). In theory this
//     decouples focus from the keyboard while keeping the IME InputConnection.
//     FIELD-TESTED 2026-08-04 on the real NETUM Q900: the scanner IME did NOT
//     commit a single scan into this host — pick/pack/stow went dead. That
//     makes it the THIRD Android-IME killer next to readOnly and
//     inputMode="none". Never make this the default again without an on-device
//     proof; it stays reachable only via override for future experiments.
//
// Override via ?scanCapture=... or localStorage.setItem('scanCapture', ...):
// "ce"/"contenteditable" opts into the experimental capture, "input" (or any
// other value) keeps the default.

export type ScanCaptureMode = "input" | "contenteditable";

export function resolveScanCaptureMode(override: string | null | undefined): ScanCaptureMode {
  const normalized = (override ?? "").trim().toLowerCase();
  if (normalized === "ce" || normalized === "contenteditable") return "contenteditable";
  return "input";
}

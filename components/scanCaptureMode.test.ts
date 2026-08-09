import { test } from "node:test";
import assert from "node:assert";
import { resolveScanCaptureMode } from "./scanCaptureMode.ts";

// Default MUST stay the plain-input capture: it is the only variant proven to
// receive scans from the NETUM scanner IME. Every other mode is opt-in per
// device, so a wrong guess can never take the whole fleet down.
test("defaults to input", () => {
  assert.strictEqual(resolveScanCaptureMode(null), "input");
  assert.strictEqual(resolveScanCaptureMode(undefined), "input");
  assert.strictEqual(resolveScanCaptureMode(""), "input");
});

// "none" restores the pre-2026-07-25 capture (off-screen, inputMode="none"):
// no keyboard, but only usable on scanners that send real key events.
test("override 'none' selects the keyboard-free capture", () => {
  assert.strictEqual(resolveScanCaptureMode("none"), "none");
});

// The contenteditable capture killed all scans on the NETUM — reachable only
// on explicit request, never by detection.
test("override 'ce'/'contenteditable' opts into the experimental capture", () => {
  assert.strictEqual(resolveScanCaptureMode("ce"), "contenteditable");
  assert.strictEqual(resolveScanCaptureMode("contenteditable"), "contenteditable");
});

// A typo on a handheld must never silently produce a mode that eats scans.
test("explicit 'input' and unknown overrides fall back to the safe default", () => {
  assert.strictEqual(resolveScanCaptureMode("input"), "input");
  assert.strictEqual(resolveScanCaptureMode("garbage"), "input");
  assert.strictEqual(resolveScanCaptureMode("nonex"), "input");
});

// Values arrive raw from URL params / localStorage — be lenient about casing
// and stray whitespace so a hand-typed override on the device still works.
test("overrides are case- and whitespace-insensitive", () => {
  assert.strictEqual(resolveScanCaptureMode(" NONE "), "none");
  assert.strictEqual(resolveScanCaptureMode(" CE "), "contenteditable");
  assert.strictEqual(resolveScanCaptureMode(" INPUT "), "input");
});

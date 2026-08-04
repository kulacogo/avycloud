import { test } from "node:test";
import assert from "node:assert";
import { resolveScanCaptureMode } from "./scanCaptureMode.ts";

// Default MUST be the plain-input capture: it is the only variant proven to
// receive scans from the NETUM scanner IME on the real device. The
// contenteditable experiment (2026-08-04) silently swallowed ALL scans there.
test("defaults to input", () => {
  assert.strictEqual(resolveScanCaptureMode(null), "input");
  assert.strictEqual(resolveScanCaptureMode(undefined), "input");
  assert.strictEqual(resolveScanCaptureMode(""), "input");
});

// The experimental contenteditable capture stays reachable, but ONLY via
// explicit opt-in — never by detection.
test("override 'ce'/'contenteditable' opts into the experimental capture", () => {
  assert.strictEqual(resolveScanCaptureMode("ce"), "contenteditable");
  assert.strictEqual(resolveScanCaptureMode("contenteditable"), "contenteditable");
});

test("explicit 'input' and unknown overrides keep the default", () => {
  assert.strictEqual(resolveScanCaptureMode("input"), "input");
  assert.strictEqual(resolveScanCaptureMode("garbage"), "input");
});

// Values arrive raw from URL params / localStorage — be lenient about casing
// and stray whitespace so a hand-typed override on the device still works.
test("overrides are case- and whitespace-insensitive", () => {
  assert.strictEqual(resolveScanCaptureMode(" CE "), "contenteditable");
  assert.strictEqual(resolveScanCaptureMode(" INPUT "), "input");
});
